import 'dotenv/config';
import { createServer } from 'http';
import { readFileSync, existsSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { randomBytes } from 'crypto';
import { allMemories, remember } from './memory.js';
import { chatReply, getLastRecall, extractMemories, correctMemory, runTask } from './agent.js';
import * as pendingNotes from './pending-notes.js';
import { computeVitals } from './vitals.js';
import * as auth from './auth.js';
import * as companion from './companion.js';
import * as connections from './connections.js';
import { getAllDocs, setDoc } from './db.js';
import { sendVerificationCode, sendWaitlistNotification, sendBroadcast } from './mailer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = process.env.PORT || 4173;
const SESSION_COOKIE = 'ari_session';
// The marketing site (neurovance.dev) is a separate static origin from this
// API (app.neurovance.dev) — the waitlist form has to call cross-origin, so
// this is the one endpoint that needs an explicit CORS allowance.
const WAITLIST_CORS_ORIGIN = 'https://neurovance.dev';

async function loadWaitlist() {
  return getAllDocs('waitlist');
}

async function addToWaitlist(email) {
  await setDoc('waitlist', email, { email, joinedAt: new Date().toISOString() });
}

// Mission-control palette: mostly grey/silver so the graph reads as one
// instrument, with telemetry-alert red reserved for genuinely critical memories.
function colorForMemory(importance) {
  if (importance >= 5) return '#e8432c';
  if (importance >= 4) return '#c8c9cf';
  return '#6b6c74';
}

async function buildGraph(userId) {
  const memories = await allMemories(userId);

  const nodes = memories.map((m) => ({
    id: m.id,
    name: m.content,
    val: m.importance || 1,
    color: colorForMemory(m.importance || 1),
    tags: m.tags,
    timestamp: m.timestamp,
  }));

  const links = [];
  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      const shared = memories[i].tags.filter((t) => memories[j].tags.includes(t));
      if (shared.length > 0) {
        links.push({ source: memories[i].id, target: memories[j].id, value: shared.length });
      }
    }
  }

  return { nodes, links, mood: computeVitals(memories).mood };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
    });
  });
}

// The Talk drawer sends its own recent transcript as conversation history so
// follow-ups ("im already logged in") actually connect to what was just
// said — each call was otherwise completely memoryless. Bounded here
// server-side too (not just client-side) so a crafted request can't blow up
// the prompt: last 12 turns, 4000 chars each.
function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
}

function parseCookies(header) {
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

// Returns { user, session } for any valid session.
async function getSessionAndUser(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies[SESSION_COOKIE];
  const session = await auth.getSession(token);
  if (!session) return { session: null, user: null, token: null };
  return { session, user: await auth.findUserById(session.userId), token };
}

function setSessionCookie(res, token, remember = true) {
  const maxAge = remember ? `; Max-Age=${60 * 60 * 24 * 30}` : ''; // omitted = session cookie, gone when the browser closes
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax${maxAge}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.zip': 'application/zip',
};

// ---------- OAuth (Google / GitHub) — standard authorization-code flow,
// hand-rolled with plain fetch calls rather than a library, same spirit as
// the rest of this app's zero-dependency approach to auth.
const OAUTH_STATE_COOKIE = 'oauth_state';

function oauthRedirectUri(provider) {
  return process.env[`${provider.toUpperCase()}_REDIRECT_URI`];
}

function startOAuthRedirect(res, provider, authUrl, params) {
  const state = randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', `${OAUTH_STATE_COOKIE}=${provider}:${state}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax`);
  const query = new URLSearchParams({ ...params, state }).toString();
  res.writeHead(302, { Location: `${authUrl}?${query}` });
  res.end();
}

async function finishOAuthLogin(res, result) {
  if (result.linked) {
    const token = await auth.createSession(result.user.id);
    setSessionCookie(res, token);
    res.writeHead(302, { Location: '/' });
  } else {
    // Brand-new identity — no session yet, just a short-lived pending token
    // the client uses to finish picking a username.
    res.writeHead(302, { Location: `/?oauthPending=${result.pendingToken}` });
  }
  res.end();
}

async function handleOAuthCallback(req, res, provider) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  const cookies = parseCookies(req.headers.cookie || '');
  const [savedProvider, savedState] = (cookies[OAUTH_STATE_COOKIE] || '').split(':');

  if (!code || !returnedState || savedProvider !== provider || savedState !== returnedState) {
    res.writeHead(302, { Location: '/?error=oauth_failed' });
    return res.end();
  }

  try {
    let profile;
    if (provider === 'google') {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: oauthRedirectUri('google'),
          grant_type: 'authorization_code',
        }),
      });
      const tokenData = await tokenRes.json();
      if (!tokenData.access_token) throw new Error('Google did not return an access token.');
      const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const p = await profileRes.json();
      profile = { providerId: p.sub, email: p.email };
    } else if (provider === 'github') {
      const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          code,
          client_id: process.env.GITHUB_CLIENT_ID,
          client_secret: process.env.GITHUB_CLIENT_SECRET,
          redirect_uri: oauthRedirectUri('github'),
        }),
      });
      const tokenData = await tokenRes.json();
      if (!tokenData.access_token) throw new Error('GitHub did not return an access token.');
      const headers = { Authorization: `Bearer ${tokenData.access_token}`, 'User-Agent': 'neurovance' };
      const profileRes = await fetch('https://api.github.com/user', { headers });
      const p = await profileRes.json();
      let email = p.email;
      if (!email) {
        // GitHub only includes email on /user if it's public — fall back to
        // the emails endpoint and take the primary verified one.
        const emailsRes = await fetch('https://api.github.com/user/emails', { headers });
        const emails = await emailsRes.json();
        email = Array.isArray(emails) ? (emails.find((e) => e.primary)?.email || emails[0]?.email) : null;
      }
      profile = { providerId: String(p.id), email };
    } else {
      throw new Error('Unknown provider.');
    }

    const result = await auth.startOAuthSignup({ provider, providerId: profile.providerId, email: profile.email });
    await finishOAuthLogin(res, result);
  } catch (e) {
    console.error(`${provider} OAuth error:`, e);
    res.writeHead(302, { Location: '/?error=oauth_failed' });
    res.end();
  }
}

const server = createServer(async (req, res) => {
  // ---------- Waitlist — public, no auth, called cross-origin from the
  // marketing site, so it needs its own CORS handling ----------

  if (req.url === '/api/waitlist' && req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': WAITLIST_CORS_ORIGIN,
      'Access-Control-Allow-Methods': 'POST',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  if (req.url === '/api/waitlist' && req.method === 'POST') {
    res.setHeader('Access-Control-Allow-Origin', WAITLIST_CORS_ORIGIN);
    try {
      const { email } = await readJsonBody(req);
      const normalized = email?.trim().toLowerCase();
      if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
        return sendJson(res, 400, { error: 'Enter a valid email.' });
      }
      const list = await loadWaitlist();
      if (!list.find((w) => w.email === normalized)) {
        await addToWaitlist(normalized);
        sendWaitlistNotification(normalized).catch((e) => console.error('Waitlist notify failed:', e));
      }
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { error: 'Something went wrong.' });
    }
    return;
  }

  // ---------- Waitlist admin — owner-only, gated by a shared secret header
  // (not the multi-user auth system, since this is a single-owner tool).
  // The admin page itself lives on neurovance.dev (a separate static site,
  // deployed independently from this app server), so these two routes need
  // the same cross-origin allowance as the public waitlist route below. ----------

  if ((req.url === '/api/admin/waitlist' || req.url === '/api/admin/waitlist/broadcast') && req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': WAITLIST_CORS_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST',
      'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
    });
    return res.end();
  }

  if (req.url === '/api/admin/waitlist' && req.method === 'GET') {
    res.setHeader('Access-Control-Allow-Origin', WAITLIST_CORS_ORIGIN);
    if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
      return sendJson(res, 401, { error: 'Unauthorized.' });
    }
    return sendJson(res, 200, { waitlist: await loadWaitlist() });
  }

  if (req.url === '/api/admin/waitlist/broadcast' && req.method === 'POST') {
    res.setHeader('Access-Control-Allow-Origin', WAITLIST_CORS_ORIGIN);
    if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
      return sendJson(res, 401, { error: 'Unauthorized.' });
    }
    try {
      const { subject, bodyHtml, bodyText } = await readJsonBody(req);
      if (!subject?.trim() || !bodyHtml?.trim()) {
        return sendJson(res, 400, { error: 'Subject and body are required.' });
      }
      const list = await loadWaitlist();
      // Fire the response immediately and send in the background — a few
      // hundred emails at one-per-second would otherwise hold the request
      // open for minutes. Sending one at a time (never a shared To/Cc) keeps
      // every recipient's address private from the others, and the delay
      // keeps this well under Gmail's per-day sending limit for a personal
      // account instead of bursting it all at once.
      sendJson(res, 200, { ok: true, queued: list.length });
      (async () => {
        for (const entry of list) {
          try {
            await sendBroadcast(entry.email, subject, bodyHtml, bodyText || '');
          } catch (e) {
            console.error(`Broadcast to ${entry.email} failed:`, e.message);
          }
          await new Promise((r) => setTimeout(r, 1200));
        }
        console.log(`Broadcast complete: ${list.length} recipients.`);
      })();
    } catch (e) {
      sendJson(res, 400, { error: 'Something went wrong.' });
    }
    return;
  }

  // ---------- Signup: email + password -> emailed code -> pick username ----------

  if (req.url === '/api/signup-start' && req.method === 'POST') {
    try {
      const { email, password } = await readJsonBody(req);
      if (!email?.trim() || !password) {
        return sendJson(res, 400, { error: 'Email and password are required.' });
      }
      const code = await auth.startSignup({ email, password });
      await sendVerificationCode(email.trim(), code);
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }

  if (req.url === '/api/signup-verify-code' && req.method === 'POST') {
    try {
      const { email, code } = await readJsonBody(req);
      if (!email?.trim() || !code) {
        return sendJson(res, 400, { error: 'Email and code are required.' });
      }
      const verifiedToken = await auth.verifySignupCode({ email, code });
      sendJson(res, 200, { ok: true, verifiedToken });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }

  if (req.url === '/api/signup-finish' && req.method === 'POST') {
    try {
      const { email, verifiedToken, username, displayName, aiName } = await readJsonBody(req);
      if (!email?.trim() || !verifiedToken || !username?.trim() || !displayName?.trim() || !aiName?.trim()) {
        return sendJson(res, 400, { error: 'Username, your name, and an AI name are all required.' });
      }
      const user = await auth.finishSignup({ email, verifiedToken, username, displayName, aiName });
      const token = await auth.createSession(user.id);
      setSessionCookie(res, token);
      sendJson(res, 200, { ok: true, displayName: user.displayName, aiName: user.aiName });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }

  // ---------- Login: username + password ----------

  if (req.url === '/api/login' && req.method === 'POST') {
    try {
      const { username, password, remember } = await readJsonBody(req);
      const user = username && await auth.findUserByUsername(username);
      if (!user || !user.passwordHash || !auth.verifyPassword(password || '', user.passwordHash)) {
        return sendJson(res, 401, { error: user && !user.passwordHash ? `This account signed up with ${user.oauthProvider} — use that to sign in.` : 'Wrong username or password.' });
      }
      const token = await auth.createSession(user.id);
      setSessionCookie(res, token, remember !== false);
      sendJson(res, 200, { ok: true, displayName: user.displayName, aiName: user.aiName });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }

  // ---------- OAuth: Google + GitHub ----------

  if (req.url === '/api/oauth/google/start') {
    return startOAuthRedirect(res, 'google', 'https://accounts.google.com/o/oauth2/v2/auth', {
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: oauthRedirectUri('google'),
      response_type: 'code',
      scope: 'openid email profile',
      prompt: 'select_account',
    });
  }

  if (req.url.startsWith('/api/oauth/google/callback')) {
    return handleOAuthCallback(req, res, 'google');
  }

  if (req.url === '/api/oauth/github/start') {
    return startOAuthRedirect(res, 'github', 'https://github.com/login/oauth/authorize', {
      client_id: process.env.GITHUB_CLIENT_ID,
      redirect_uri: oauthRedirectUri('github'),
      scope: 'read:user user:email',
    });
  }

  if (req.url.startsWith('/api/oauth/github/callback')) {
    return handleOAuthCallback(req, res, 'github');
  }

  if (req.url === '/api/oauth-finish' && req.method === 'POST') {
    try {
      const { pendingToken, username, displayName, aiName } = await readJsonBody(req);
      if (!pendingToken || !username?.trim() || !displayName?.trim() || !aiName?.trim()) {
        return sendJson(res, 400, { error: 'Username, your name, and an AI name are all required.' });
      }
      const user = await auth.finishOAuthSignup({ pendingToken, username, displayName, aiName });
      const token = await auth.createSession(user.id);
      setSessionCookie(res, token);
      sendJson(res, 200, { ok: true, displayName: user.displayName, aiName: user.aiName });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }

  if (req.url === '/api/logout' && req.method === 'POST') {
    const cookies = parseCookies(req.headers.cookie || '');
    await auth.destroySession(cookies[SESSION_COOKIE]);
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.url === '/api/me') {
    const { user } = await getSessionAndUser(req);
    if (!user) return sendJson(res, 401, { ok: false });
    sendJson(res, 200, { ok: true, displayName: user.displayName, aiName: user.aiName, username: user.username, model: user.model || 'core' });
    return;
  }

  // Everything below requires a valid session.
  if (req.url.startsWith('/api/')) {
    const { user } = await getSessionAndUser(req);
    if (!user) return sendJson(res, 401, { error: 'Not authenticated' });

    if (req.url === '/api/graph') {
      return sendJson(res, 200, await buildGraph(user.id));
    }

    // ---------- Model tier — Neurovance's own custom-branded model names
    // (Pulse / Core), not Anthropic's. Picking one only changes what powers
    // this user's own chat + tasks, never anyone else's. ----------

    if (req.url === '/api/model' && req.method === 'POST') {
      try {
        const { tier } = await readJsonBody(req);
        if (!auth.MODEL_TIERS.includes(tier)) {
          return sendJson(res, 400, { error: `tier must be one of: ${auth.MODEL_TIERS.join(', ')}` });
        }
        await auth.setModelTier(user.id, tier);
        return sendJson(res, 200, { ok: true, model: tier });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    // ---------- Companion — lets this user's agent read from one folder on
    // their own computer, and open Safari links there, via the local
    // companion app they install and pair themselves (see /companion). ----------

    if (req.url === '/api/companion/pair-code' && req.method === 'POST') {
      return sendJson(res, 200, { code: companion.generatePairingCode(user.id) });
    }

    if (req.url === '/api/companion/status') {
      return sendJson(res, 200, await companion.companionStatus(user.id));
    }

    if (req.url === '/api/companion/unpair' && req.method === 'POST') {
      await companion.unpair(user.id);
      return sendJson(res, 200, { ok: true });
    }

    // Polled by the web app while a task is running, to show a live-ish
    // preview of whatever the Companion last saw in the user's own Safari.
    if (req.url === '/api/companion/latest-frame') {
      const frame = companion.getLatestFrame(user.id);
      return sendJson(res, 200, frame ? { ok: true, data: frame.data, url: frame.url, ts: frame.ts } : { ok: true, data: null });
    }

    // ---------- Contestable memory — correcting one memory can mean nearby
    // ones need fixing too, handled with real related-memory context rather
    // than a blind single-row overwrite. ----------

    if (req.url === '/api/correct-memory' && req.method === 'POST') {
      try {
        const { id, correction } = await readJsonBody(req);
        if (!Number.isInteger(id) || !correction?.trim()) {
          return sendJson(res, 400, { error: 'id and correction are required.' });
        }
        const updated = await correctMemory(user.id, id, correction.trim());
        const nodes = updated.map((entry) => ({
          id: entry.id, name: entry.content, val: entry.importance,
          color: colorForMemory(entry.importance), tags: entry.tags, timestamp: entry.timestamp,
        }));
        return sendJson(res, 200, { nodes });
      } catch (e) {
        console.error('Correct-memory error:', e);
        return sendJson(res, 500, { error: 'Correction failed: ' + e.message });
      }
    }

    // ---------- Pending notes — things the Superself noticed on its own
    // (dreaming, curiosity, Companion file changes) and wants to surface. ----------

    if (req.url === '/api/pending-notes') {
      return sendJson(res, 200, { notes: await pendingNotes.unseenNotes(user.id) });
    }

    if (req.url === '/api/pending-notes/dismiss' && req.method === 'POST') {
      try {
        const { id } = await readJsonBody(req);
        if (!Number.isInteger(id)) return sendJson(res, 400, { error: 'id is required.' });
        await pendingNotes.markSeen(user.id, id);
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 400, { error: 'Something went wrong.' });
      }
    }

    // ---------- Connections — private, invite-only introductions between two
    // people's Superselves. No directory to browse; you have to already know
    // the exact username. Only ever exposes topic-tag overlap after BOTH
    // sides accept — never raw memory content, never one side's full tag
    // list, never the other person's memories in any form. ----------

    if (req.url === '/api/connections' && req.method === 'GET') {
      return sendJson(res, 200, { connections: await connections.listConnectionsFor(user.id) });
    }

    if (req.url === '/api/connections/request' && req.method === 'POST') {
      try {
        const { username } = await readJsonBody(req);
        if (!username?.trim()) return sendJson(res, 400, { error: 'A username is required.' });
        const entry = await connections.requestConnection(user.id, username.trim());
        return sendJson(res, 200, { ok: true, id: entry.id });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.url === '/api/connections/respond' && req.method === 'POST') {
      try {
        const { id, accept } = await readJsonBody(req);
        if (!id || typeof accept !== 'boolean') return sendJson(res, 400, { error: 'id and accept are required.' });
        await connections.respondToConnection(user.id, id, accept);
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.url === '/api/connections/overlap' && req.method === 'POST') {
      try {
        const { id } = await readJsonBody(req);
        if (!id) return sendJson(res, 400, { error: 'id is required.' });
        const overlap = await connections.getOverlap(user.id, id);
        return sendJson(res, 200, overlap);
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.url === '/api/last-recall') {
      return sendJson(res, 200, getLastRecall(user.id));
    }

    if (req.url === '/api/extract-memories' && req.method === 'POST') {
      try {
        const { text } = await readJsonBody(req);
        if (typeof text !== 'string' || !text.trim()) {
          return sendJson(res, 400, { error: 'text must be a non-empty string' });
        }
        const entries = await extractMemories(user.id, text.trim());
        const nodes = entries.map((entry) => ({
          id: entry.id,
          name: entry.content,
          val: entry.importance,
          color: colorForMemory(entry.importance),
          tags: entry.tags,
          timestamp: entry.timestamp,
        }));
        return sendJson(res, 200, { nodes });
      } catch (e) {
        console.error('Extract error:', e);
        return sendJson(res, 500, { error: 'Extraction failed: ' + e.message });
      }
    }

    if (req.url === '/api/remember' && req.method === 'POST') {
      try {
        const { content, tags, importance } = await readJsonBody(req);
        if (typeof content !== 'string' || !content.trim()) {
          return sendJson(res, 400, { error: 'content must be a non-empty string' });
        }
        const entry = await remember(
          user.id,
          content.trim(),
          Array.isArray(tags) && tags.length ? tags : ['personal'],
          Number.isInteger(importance) ? importance : 3
        );
        return sendJson(res, 200, {
          node: {
            id: entry.id,
            name: entry.content,
            val: entry.importance,
            color: colorForMemory(entry.importance),
            tags: entry.tags,
            timestamp: entry.timestamp,
          },
        });
      } catch (e) {
        return sendJson(res, 500, { error: 'Save failed: ' + e.message });
      }
    }

    // The autonomous task loop — same engine grow.js runs on a daily cron,
    // now actually reachable by the person it belongs to, not just a
    // background job. Can take a while (multi-turn tool use), so this just
    // awaits it rather than pretending it's instant.
    if (req.url === '/api/task' && req.method === 'POST') {
      try {
        const { task, history } = await readJsonBody(req);
        if (typeof task !== 'string' || !task.trim()) {
          return sendJson(res, 400, { error: 'task must be a non-empty string' });
        }
        const result = await runTask(user.id, user, task.trim(), sanitizeHistory(history));
        return sendJson(res, 200, { result });
      } catch (e) {
        console.error('Task error:', e);
        return sendJson(res, 500, { error: 'Task failed: ' + e.message });
      }
    }

    if (req.url === '/api/chat' && req.method === 'POST') {
      try {
        const { message, history } = await readJsonBody(req);
        if (typeof message !== 'string' || !message.trim()) {
          return sendJson(res, 400, { error: 'message must be a non-empty string' });
        }
        const reply = await chatReply(user.id, user, message.trim(), sanitizeHistory(history));
        return sendJson(res, 200, { reply });
      } catch (e) {
        console.error('Chat error:', e);
        return sendJson(res, 500, { error: 'Chat failed: ' + e.message });
      }
    }

    return sendJson(res, 404, { error: 'Not found' });
  }

  // Strip the query string FIRST, then check for root — req.url includes
  // any query string (e.g. "/?oauthPending=..."), so checking req.url === '/'
  // before stripping missed every root request that had one, falling through
  // to try to serve PUBLIC_DIR itself instead of index.html.
  const rawPath = req.url.split('?')[0];
  const path = rawPath === '/' ? '/index.html' : rawPath;
  const filePath = join(PUBLIC_DIR, path);
  // existsSync() is true for directories too — a request that happens to
  // resolve to a directory path (e.g. /turntable with no filename) would
  // pass this check, then crash the whole process on readFileSync(),
  // since that throws EISDIR uncaught. statSync + isFile() rules that out,
  // and the try/catch is defense in depth against any other read failure.
  try {
    if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(readFileSync(filePath));
  } catch (e) {
    console.error('Static file error:', e);
    res.writeHead(500);
    res.end('Server error');
  }
});

companion.attach(server);
server.listen(PORT, () => console.log(`Brain graph running at http://localhost:${PORT}`));
