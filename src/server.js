import 'dotenv/config';
import { createServer } from 'http';
import { readFileSync, existsSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { randomBytes } from 'crypto';
import { allMemories, remember } from './memory.js';
import { chatReply, getLastRecall, extractMemories, correctMemory, runTask, codeAgentPrompt } from './agent.js';
import * as codeFiles from './codeFiles.js';
import * as codeExecution from './codeExecution.js';
import * as pendingNotes from './pending-notes.js';
import { computeVitals } from './vitals.js';
import * as auth from './auth.js';
import * as companion from './companion.js';
import * as connections from './connections.js';
import * as connectors from './connectors.js';
import * as scheduler from './scheduler.js';
import { getAllDocs, getDoc, setDoc } from './db.js';
  import { sendVerificationCode, sendWaitlistNotification, sendBroadcast, sendFeedbackNotification, sendInviteEmail } from './mailer.js';
import * as billing from './stripe.js';

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

// In-memory, per-process — a restart clears it, which is fine, same
// tradeoff already made for pairing codes and live companion connections.
const loginAttempts = new Map(); // username -> { count, resetAt }
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;

function checkLoginRateLimit(username) {
  const now = Date.now();
  const entry = loginAttempts.get(username);
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(username, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return true;
  }
  if (entry.count >= LOGIN_MAX_ATTEMPTS) return false;
  entry.count += 1;
  return true;
}

function clearLoginRateLimit(username) {
  loginAttempts.delete(username);
}

// Per-IP limiter for the public, pre-auth endpoints that emit emails or
// grindable codes (signup-start, forgot-password, waitlist). The login
// limiter above is per-username (an attacker can cycle scrape every account
// without one IP), but these have no username to key on, so they need an
// IP-level cap instead. Firestore-backed would be ideal but pointless here:
// the limit is about retrying fast, and a per-process Map is exactly what
// that needs without making a live Firestore query on the hottest routes.
const ipLimiters = new Map(); // key(ip:route) -> { count, resetAt }
const IP_LIMIT_MAX = 15; // per 10 minutes per route per IP
const IP_LIMIT_WINDOW_MS = 10 * 60 * 1000;

function realIp(req) {
  return (
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket.remoteAddress
    || 'unknown'
  );
}

function checkIpRateLimit(req, route) {
  const now = Date.now();
  const key = `${realIp(req)}:${route}`;
  const entry = ipLimiters.get(key);
  if (!entry || entry.resetAt < now) {
    ipLimiters.set(key, { count: 1, resetAt: now + IP_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= IP_LIMIT_MAX) return false;
  entry.count += 1;
  return true;
}

const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024; // generous for chat/memory text, nothing legitimate needs more

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > MAX_JSON_BODY_BYTES) {
        rejected = true;
        req.destroy();
        reject(new Error('Request body too large.'));
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (rejected) return;
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
    });
    req.on('error', (e) => { if (!rejected) reject(e); });
  });
}

// Stripe webhook signature verification needs the exact raw bytes of the
// request body — JSON.parse (or re-stringifying a parsed object) can shift
// whitespace/key order just enough to make the signature no longer match.
// Capped like readJsonBody: the endpoint is reached pre-auth (signature
// check), so an attacker who lacks Stripe's secret can still POST an
// arbitrarily large body here — without a cap that's an unauthenticated
// memory-exhaustion DoS. Legitimate Stripe events are small, so an 8MB
// ceiling is far above anything real and truncates only junk.
const MAX_RAW_BODY_BYTES = 8 * 1024 * 1024;
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > MAX_RAW_BODY_BYTES) {
        rejected = true;
        req.destroy();
        reject(new Error('Request body too large.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (e) => { if (!rejected) reject(e); });
  });
}

// The Talk drawer sends its own recent transcript as conversation history so
// follow-ups ("im already logged in") actually connect to what was just
// said — each call was otherwise completely memoryless. Bounded here
// server-side too (not just client-side) so a crafted request can't blow up
// the prompt: last 12 turns, 4000 chars each.
function sanitizeHistory(history, limit = 12) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-limit)
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

// Session cookie carries a login token. SameSite=Lax + HttpOnly are
// always on; the Secure flag (HTTPS-only) is on everywhere except an
// explicitly-declared local dev server, since Secure would make the cookie
// invisible over plaintext http://localhost. Set COOKIE_SECURE=false in
// local .env only if you're developing over non-HTTPS localhost.
const COOKIE_SECURE = process.env.COOKIE_SECURE !== 'false';
const SECURE_ATTR = COOKIE_SECURE ? '; Secure' : '';

function setSessionCookie(res, token, remember = true) {
  const maxAge = remember ? `; Max-Age=${60 * 60 * 24 * 30}` : ''; // omitted = session cookie, gone when the browser closes
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax${SECURE_ATTR}${maxAge}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax${SECURE_ATTR}; Max-Age=0`);
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...SECURITY_HEADERS,
  });
  res.end(JSON.stringify(body));
}

// Baseline headers on every response. CSP is deliberately permissive on
// script-src (this is a single inlined HTML app with no separate JS bundle)
// but hardens the things a static inline app can't handle: framing, MIME
// sniffing, referrer leakage, and cross-origin resource policy.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

// The one shared shape every "you're now logged in" response sends back —
// login, signup, oauth, and /api/me all used to build this by hand, and
// three of the four silently dropped username/email/model/advisorMode/
// hasPassword, which is exactly why Settings showed an empty username field
// right after a fresh login until the next reload quietly fixed it.
function identityPayload(user) {
  return {
    ok: true,
    displayName: user.displayName,
    aiName: user.aiName,
    username: user.username,
    email: user.email,
    hasPassword: !!user.passwordHash,
    model: user.model || 'core',
    plan: user.plan || 'free',
    billingConfigured: billing.isConfigured(),
    advisorMode: user.advisorMode !== false,
    browser: user.browser === 'chrome' ? 'chrome' : 'safari',
    language: auth.LANGUAGES.includes(user.language) ? user.language : 'English',
    permissionMode: user.permissionMode === 'ask' ? 'ask' : 'bypass',
    effortLevel: auth.EFFORT_LEVELS.includes(user.effortLevel) ? user.effortLevel : 'low',
  };
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

function isOAuthConfigured(provider) {
  const prefix = provider.toUpperCase();
  return Boolean(
    process.env[`${prefix}_CLIENT_ID`]
    && process.env[`${prefix}_CLIENT_SECRET`]
    && oauthRedirectUri(provider),
  );
}

// `from` records which page sent the user into the OAuth detour (desktop
// index.html vs mobile.html) so the round trip lands them back where they
// started instead of always dropping a phone user onto the desktop layout.
// Packed into the same state cookie rather than a query param, since Google/
// GitHub echo back only what's in their own `state` value, not arbitrary
// request state.
function startOAuthRedirect(res, provider, authUrl, params, from) {
  const state = randomBytes(16).toString('hex');
  const safeFrom = from === 'mobile' ? 'mobile' : 'desktop';
  res.setHeader('Set-Cookie', `${OAUTH_STATE_COOKIE}=${provider}:${state}:${safeFrom}; HttpOnly; Path=/; Max-Age=600; SameSite=Lax${SECURE_ATTR}`);
  const query = new URLSearchParams({ ...params, state }).toString();
  res.writeHead(302, { Location: `${authUrl}?${query}` });
  res.end();
}

async function finishOAuthLogin(res, result, from) {
  const base = from === 'mobile' ? '/mobile.html' : '/';
  if (result.linked) {
    const token = await auth.createSession(result.user.id);
    setSessionCookie(res, token);
    res.writeHead(302, { Location: base });
  } else {
    // Brand-new identity — no session yet, just a short-lived pending token
    // the client uses to finish picking a username.
    res.writeHead(302, { Location: `${base}?oauthPending=${result.pendingToken}` });
  }
  res.end();
}

async function handleOAuthCallback(req, res, provider) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  const cookies = parseCookies(req.headers.cookie || '');
  const [savedProvider, savedState, savedFrom] = (cookies[OAUTH_STATE_COOKIE] || '').split(':');
  const from = savedFrom === 'mobile' ? 'mobile' : 'desktop';

  if (!code || !returnedState || savedProvider !== provider || savedState !== returnedState) {
    res.writeHead(302, { Location: `${from === 'mobile' ? '/mobile.html' : '/'}?error=oauth_failed` });
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
      // GitHub's /user `email` field is NOT asserted as verified — it's just
      // the account's public email if set. Account-linking by email below must
      // only ever match a GitHub identity to an existing account when GitHub
      // explicitly confirms the address is verified (verified===true on
      // /user/emails). Otherwise a GitHub account registered with an
      // unconfirmed (but primary) address could be pointed at a victim's
      // Neurovance email and silently take over their account via the
      // email-matching link in startOAuthSignup. So: ignore p.email entirely
      // and pull only verified addresses from /user/emails.
      let email = null;
      const emailsRes = await fetch('https://api.github.com/user/emails', { headers });
      const emails = await emailsRes.json();
      if (Array.isArray(emails)) {
        const verifiedEmails = emails.filter((e) => e.verified === true);
        const primary = verifiedEmails.find((e) => e.primary);
        email = primary?.email || verifiedEmails[0]?.email || null;
      }
      profile = { providerId: String(p.id), email };
    } else {
      throw new Error('Unknown provider.');
    }

    const result = await auth.startOAuthSignup({ provider, providerId: profile.providerId, email: profile.email });
    await finishOAuthLogin(res, result, from);
  } catch (e) {
    console.error(`${provider} OAuth error:`, e);
    res.writeHead(302, { Location: `${from === 'mobile' ? '/mobile.html' : '/'}?error=oauth_failed` });
    res.end();
  }
}

// A route that forgets its own try/catch (or throws from somewhere shared,
// like the session lookup above) used to take the whole process down for
// every connected user, not just the one bad request — Node treats an
// unhandled rejection from an async listener as fatal by default. This
// function is unchanged from before; only how it's invoked below changed.
async function handleRequest(req, res) {
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
    if (!checkIpRateLimit(req, 'waitlist')) return sendJson(res, 429, { error: 'Too many attempts from this IP — try again later.' });
    res.setHeader('Access-Control-Allow-Origin', WAITLIST_CORS_ORIGIN);
    try {
      const { email } = await readJsonBody(req);
      const normalized = email?.trim().toLowerCase();
      if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
        return sendJson(res, 400, { error: 'Enter a valid email.' });
      }
      // Waitlist docs are keyed by email, so an existence check is one read —
      // loading the whole list to scan it was billing a read per signup per
      // person already on it.
      if (!(await getDoc('waitlist', normalized))) {
        await addToWaitlist(normalized);
        sendWaitlistNotification(normalized).catch((e) => console.error('Waitlist notify failed:', e));
      }
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { error: 'Something went wrong.' });
    }
    return;
  }

  // ---------- Stripe webhook — public (Stripe itself calls this, not a
  // logged-in browser), authenticated instead by verifying Stripe's own
  // signature on the raw body. Flips plan to 'paid' the moment a checkout
  // actually completes, and back to 'free' the moment a subscription ends —
  // this is the only place plan changes happen once real billing exists;
  // the account is the source of truth, not whatever the client claims. ----------

  if (req.url === '/api/stripe-webhook' && req.method === 'POST') {
    try {
      const rawBody = await readRawBody(req);
      const event = billing.verifyWebhookSignature(rawBody, req.headers['stripe-signature']);

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const userId = session.client_reference_id;
        if (userId) {
          await auth.setPlan(userId, 'paid');
          await auth.setStripeInfo(userId, { customerId: session.customer, subscriptionId: session.subscription });
        }
      }

      if (event.type === 'customer.subscription.deleted') {
        const subscription = event.data.object;
        const userId = subscription.metadata?.userId;
        const user = userId ? await auth.findUserById(userId) : await auth.findUserByStripeSubscriptionId(subscription.id);
        if (user) await auth.setPlan(user.id, 'free');
      }

      sendJson(res, 200, { received: true });
    } catch (e) {
      console.error('Stripe webhook error:', e.message);
      sendJson(res, 400, { error: e.message });
    }
    return;
  }

  // ---------- Waitlist admin — owner-only, gated by a shared secret header
  // (not the multi-user auth system, since this is a single-owner tool).
  // The admin page itself lives on neurovance.dev (a separate static site,
  // deployed independently from this app server), so these two routes need
  // the same cross-origin allowance as the public waitlist route below. ----------

  if (req.url === '/api/admin/waitlist' || req.url === '/api/admin/waitlist/broadcast' || req.url === '/api/admin/waitlist/invite') {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': WAITLIST_CORS_ORIGIN,
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
      });
      return res.end();
    }
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

  // ---------- Waitlist invite: provisions a real account from a waitlist
  // entry, closes the site's waitlist -> account -> download handoff. Owner-
  // only, same shared-secret header as the other admin routes. Emails the
  // one-time password (never stored server-side) so the new user can sign in.
  if (req.url === '/api/admin/waitlist/invite' && req.method === 'POST') {
    res.setHeader('Access-Control-Allow-Origin', WAITLIST_CORS_ORIGIN);
    if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
      return sendJson(res, 401, { error: 'Unauthorized.' });
    }
    try {
      const { email, displayName, aiName } = await readJsonBody(req);
      if (!email?.trim()) {
        return sendJson(res, 400, { error: 'An email address is required.' });
      }
      const { user, temporaryPassword } = await auth.inviteFromWaitlist({ email, displayName, aiName });
      const appOrigin = process.env.APP_ORIGIN || `http://localhost:${PORT}`;
      await sendInviteEmail({
        email: user.email,
        username: user.username,
        temporaryPassword,
        appOrigin,
      });
      return sendJson(res, 200, { ok: true, userId: user.id, username: user.username, email: user.email });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // ---------- Signup: email + password -> emailed code -> pick username ----------

  if (req.url === '/api/signup-start' && req.method === 'POST') {
    try {
      if (!checkIpRateLimit(req, 'signup-start')) return sendJson(res, 429, { error: 'Too many attempts from this IP — try again later.' });
      const { email, password } = await readJsonBody(req);
      if (!email?.trim() || !password) {
        return sendJson(res, 400, { error: 'Email and password are required.' });
      }
      const code = await auth.startSignup({ email, password });
      try {
        await sendVerificationCode(email.trim(), code);
      } catch (mailErr) {
        // Never surface raw SMTP/provider errors to the client — they can
        // contain infrastructure detail that's not this user's business,
        // and isn't actionable for them anyway.
        console.error('Verification email failed to send:', mailErr);
        return sendJson(res, 500, { error: 'Could not send the verification email right now — try again in a moment.' });
      }
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }

  if (req.url === '/api/signup-verify-code' && req.method === 'POST') {
    try {
      if (!checkIpRateLimit(req, 'verify-code')) return sendJson(res, 429, { error: 'Too many attempts from this IP — try again later.' });
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
      const { email, verifiedToken, username, displayName, aiName, referralCode } = await readJsonBody(req);
      if (!email?.trim() || !verifiedToken || !username?.trim() || !displayName?.trim() || !aiName?.trim()) {
        return sendJson(res, 400, { error: 'Username, your name, and an AI name are all required.' });
      }
      const user = await auth.finishSignup({ email, verifiedToken, username, displayName, aiName, referralCode });
      const token = await auth.createSession(user.id);
      setSessionCookie(res, token);
      sendJson(res, 200, identityPayload(user));
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }

  // ---------- Login: username + password ----------
  // A per-username attempt limiter, not per-IP — scrypt already makes each
  // guess expensive, this just stops someone from grinding through a
  // wordlist against one specific account. Resets on a correct login so a
  // real user who mistyped a few times isn't left locked out.

  if (req.url === '/api/login' && req.method === 'POST') {
    try {
      const { username, password, remember } = await readJsonBody(req);
      const normalizedUsername = (username || '').trim().toLowerCase();
      if (!checkLoginRateLimit(normalizedUsername)) {
        return sendJson(res, 429, { error: 'Too many attempts on that account — try again in a few minutes.' });
      }
      const user = username && await auth.findUserByUsername(username);
      if (!user || !user.passwordHash || !auth.verifyPassword(password || '', user.passwordHash)) {
        return sendJson(res, 401, { error: user && !user.passwordHash ? `This account signed up with ${user.oauthProvider} — use that to sign in.` : 'Wrong username or password.' });
      }
      clearLoginRateLimit(normalizedUsername);
      const token = await auth.createSession(user.id);
      setSessionCookie(res, token, remember !== false);
      sendJson(res, 200, identityPayload(user));
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }

  // ---------- Forgot password: emailed code -> reset token -> new password.
  // The "start" response is identical whether or not the email has an
  // account — never reveals which emails are registered. ----------

  if (req.url === '/api/forgot-password' && req.method === 'POST') {
    try {
      if (!checkIpRateLimit(req, 'forgot-password')) return sendJson(res, 429, { error: 'Too many attempts from this IP — try again later.' });
      const { email } = await readJsonBody(req);
      if (!email?.trim()) return sendJson(res, 400, { error: 'Email is required.' });
      const code = await auth.startPasswordReset(email);
      if (code) {
        try {
          await sendVerificationCode(email.trim(), code);
        } catch (mailErr) {
          console.error('Password reset email failed to send:', mailErr);
          // Deliberately still returns ok:true here — this response's whole
          // point is to never reveal whether the email matched an account,
          // and a failed send for an email that WASN'T real is not this
          // user's business either. The real failure is already logged.
        }
      }
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }

  if (req.url === '/api/reset-password-verify' && req.method === 'POST') {
    try {
      if (!checkIpRateLimit(req, 'reset-password-verify')) return sendJson(res, 429, { error: 'Too many attempts from this IP — try again later.' });
      const { email, code } = await readJsonBody(req);
      if (!email?.trim() || !code) return sendJson(res, 400, { error: 'Email and code are required.' });
      const resetToken = await auth.verifyPasswordResetCode({ email, code });
      sendJson(res, 200, { ok: true, resetToken });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }

  if (req.url === '/api/reset-password-finish' && req.method === 'POST') {
    try {
      const { email, resetToken, newPassword } = await readJsonBody(req);
      if (!email?.trim() || !resetToken || !newPassword) {
        return sendJson(res, 400, { error: 'Email, reset token, and a new password are all required.' });
      }
      await auth.finishPasswordReset({ email, resetToken, newPassword });
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }

  // ---------- OAuth: Google + GitHub ----------

  if (req.url.startsWith('/api/oauth/google/start')) {
    const from = new URL(req.url, `http://${req.headers.host}`).searchParams.get('from');
    if (!isOAuthConfigured('google')) {
      res.writeHead(302, { Location: '/?error=google_oauth_unavailable' });
      return res.end();
    }
    return startOAuthRedirect(res, 'google', 'https://accounts.google.com/o/oauth2/v2/auth', {
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: oauthRedirectUri('google'),
      response_type: 'code',
      scope: 'openid email profile',
      prompt: 'select_account',
    }, from);
  }

  if (req.url.startsWith('/api/oauth/google/callback')) {
    return handleOAuthCallback(req, res, 'google');
  }

  if (req.url.startsWith('/api/oauth/github/start')) {
    const from = new URL(req.url, `http://${req.headers.host}`).searchParams.get('from');
    if (!isOAuthConfigured('github')) {
      res.writeHead(302, { Location: '/?error=github_oauth_unavailable' });
      return res.end();
    }
    return startOAuthRedirect(res, 'github', 'https://github.com/login/oauth/authorize', {
      client_id: process.env.GITHUB_CLIENT_ID,
      redirect_uri: oauthRedirectUri('github'),
      scope: 'read:user user:email',
    }, from);
  }

  if (req.url.startsWith('/api/oauth/github/callback')) {
    return handleOAuthCallback(req, res, 'github');
  }

  if (req.url === '/api/oauth-finish' && req.method === 'POST') {
    try {
      const { pendingToken, username, displayName, aiName, referralCode } = await readJsonBody(req);
      if (!pendingToken || !username?.trim() || !displayName?.trim() || !aiName?.trim()) {
        return sendJson(res, 400, { error: 'Username, your name, and an AI name are all required.' });
      }
      const user = await auth.finishOAuthSignup({ pendingToken, username, displayName, aiName, referralCode });
      const token = await auth.createSession(user.id);
      setSessionCookie(res, token);
      sendJson(res, 200, identityPayload(user));
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
    sendJson(res, 200, identityPayload(user));
    return;
  }

  // ---------- Public API — for a user's OWN external apps, authenticated
  // by an API key (Settings → API Keys) instead of a browser session
  // cookie. v1 is chat only for now: text in, a real reply out, same
  // engine and same memory as the web app. Same daily usage cap applies —
  // an API key is not a way around it. ----------

  if (req.url === '/api/v1/chat' && req.method === 'POST') {
    const authHeader = req.headers['authorization'] || '';
    const rawKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    const apiUser = rawKey ? await auth.findUserByApiKey(rawKey) : null;
    if (!apiUser) return sendJson(res, 401, { error: 'Invalid or missing API key. Pass it as: Authorization: Bearer nv_...' });

    try {
      const usage = await auth.checkTokenUsage(apiUser.id);
      if (!usage.allowed) {
        return sendJson(res, 429, { error: `Token budget exceeded (${usage.used}/${usage.budget}) — resets at midnight UTC.` });
      }
      const { message, history } = await readJsonBody(req);
      if (typeof message !== 'string' || !message.trim()) {
        return sendJson(res, 400, { error: 'message must be a non-empty string' });
      }
      const effectiveUser = { ...apiUser };
      if (usage.suggestDownscale) effectiveUser.model = 'pulse';
      const { reply, usage: tokensUsed } = await chatReply(apiUser.id, effectiveUser, message.trim(), sanitizeHistory(history, usage.suggestDownscale ? 6 : 12));
      await auth.incrementTokenUsage(apiUser.id, tokensUsed.input_tokens + tokensUsed.output_tokens);
      return sendJson(res, 200, { reply });
    } catch (e) {
      console.error('API v1 chat error:', e);
      return sendJson(res, 500, { error: 'Something went wrong while replying — try again.' });
    }
  }

  // Everything below requires a valid session.
  if (req.url.startsWith('/api/')) {
    const { user } = await getSessionAndUser(req);
    if (!user) return sendJson(res, 401, { error: 'Not authenticated' });

    // Lost from this file somewhere in the uncommitted changes this session
    // found sitting in the working tree (buildGraph() itself was untouched
    // and still exported correctly — only the route binding it to a URL was
    // gone). Without this the whole desktop app hangs at login forever:
    // startApp()'s fetch('/api/graph') 404s, so its .then() callback (which
    // is what runs the entire initX() chain, Code panel included) never
    // fires. Restored verbatim from the last commit (a43ac7f).
    if (req.url === '/api/graph') {
      return sendJson(res, 200, await buildGraph(user.id));
    }

    if (req.url === '/api/usage' && req.method === 'GET') {
      try {
        // Was `const user = await auth.findUserById(user.id)` — same name as
        // the outer `user` from the session check a few lines up, so the
        // `user.id` on its own right-hand side referenced itself before
        // that const finished initializing (temporal dead zone), throwing
        // on literally every call. Confirmed live: this 500'd on every
        // single page load. Renamed to freshUser — the actual reason to
        // re-fetch is to get today's real tokenUsage rather than whatever
        // was on the session-check's user object, which can be stale.
        const freshUser = await auth.findUserById(user.id);
        const budget = freshUser.tokenBudget || auth.DEFAULT_TOKEN_BUDGET;
        const today = new Date().toISOString().slice(0, 10);
        const usage = freshUser.tokenUsage?.date === today ? freshUser.tokenUsage.used : 0;
        return sendJson(res, 200, { ok: true, used: usage, budget });
      } catch (e) {
        return sendJson(res, 500, { error: 'Could not load your usage.' });
      }
    }

    if (req.url === '/api/token-budget' && req.method === 'POST') {
      try {
        const { budget } = await readJsonBody(req);
        if (!Number.isInteger(budget) || budget < 0) {
          return sendJson(res, 400, { error: 'Budget must be a non-negative integer.' });
        }
        const user = await auth.findUserById(user.id);
        user.tokenBudget = budget;
        await auth.saveUser(user);
        return sendJson(res, 200, { ok: true, budget });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.url === '/api/strict-mode' && req.method === 'POST') {
      try {
        const { enabled } = await readJsonBody(req);
        if (typeof enabled !== 'boolean') {
          return sendJson(res, 400, { error: 'enabled must be true or false.' });
        }
        const user = await auth.findUserById(user.id);
        user.strictModeEnabled = enabled;
        await auth.saveUser(user);
        return sendJson(res, 200, { ok: true, enabled });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.url === '/api/session/clear' && req.method === 'POST') {
      return sendJson(res, 200, { ok: true });
    }

    if (req.url === '/api/ai-settings' && req.method === 'POST') {
      try {
        const { temperature, topP, maxTokens, contextTurns } = await readJsonBody(req);
        const updated = await auth.setAiSettings(user.id, { temperature, topP, maxTokens, contextTurns });
        return sendJson(res, 200, { ok: true, ...updated });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.url === '/api/privacy/train' && req.method === 'POST') {
      try {
        const { enabled } = await readJsonBody(req);
        if (typeof enabled !== 'boolean') return sendJson(res, 400, { error: 'enabled must be a boolean.' });
        await auth.setPrivacyTrain(user.id, enabled);
        return sendJson(res, 200, { ok: true, enabled });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.url === '/api/memories/export' && req.method === 'GET') {
      try {
        const memories = await allMemories(user.id);
        return sendJson(res, 200, { ok: true, memories });
      } catch (e) {
        return sendJson(res, 500, { error: 'Could not export your memories.' });
      }
    }

    if (req.url === '/api/account/delete' && req.method === 'POST') {
      try {
        await auth.deleteUser(user.id);
        clearSessionCookie(res);
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
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

    // ---------- Personality — brutally-honest advisor vs. warm companion.
    // Only ever changes this one user's own tone, never anyone else's. ----------

    if (req.url === '/api/advisor-mode' && req.method === 'POST') {
      try {
        const { advisorMode } = await readJsonBody(req);
        if (typeof advisorMode !== 'boolean') {
          return sendJson(res, 400, { error: 'advisorMode must be true or false.' });
        }
        await auth.setAdvisorMode(user.id, advisorMode);
        return sendJson(res, 200, { ok: true, advisorMode });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    // ---------- Browser preference — which real browser the Companion
    // drives for open/read/click/type actions. Mac only; Windows automation
    // goes through Outlook, not a browser, so this has no effect there. ----------

    if (req.url === '/api/browser-pref' && req.method === 'POST') {
      try {
        const { browser } = await readJsonBody(req);
        if (!auth.BROWSERS.includes(browser)) {
          return sendJson(res, 400, { error: `browser must be one of: ${auth.BROWSERS.join(', ')}` });
        }
        await auth.setBrowserPref(user.id, browser);
        return sendJson(res, 200, { ok: true, browser });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    // ---------- Language — which language the Superself replies in. ----------

    if (req.url === '/api/language' && req.method === 'POST') {
      try {
        const { language } = await readJsonBody(req);
        if (!auth.LANGUAGES.includes(language)) {
          return sendJson(res, 400, { error: `language must be one of: ${auth.LANGUAGES.join(', ')}` });
        }
        await auth.setLanguage(user.id, language);
        return sendJson(res, 200, { ok: true, language });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    // ---------- Permission mode — bypass (act freely, including payments/
    // messages/deletes) or ask (confirm before every single action). ----------

    if (req.url === '/api/permission-mode' && req.method === 'POST') {
      try {
        const { mode } = await readJsonBody(req);
        if (!auth.PERMISSION_MODES.includes(mode)) {
          return sendJson(res, 400, { error: `mode must be one of: ${auth.PERMISSION_MODES.join(', ')}` });
        }
        await auth.setPermissionMode(user.id, mode);
        return sendJson(res, 200, { ok: true, mode });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    // ---------- Effort level — maps to how large an extended-thinking
    // budget the model gets before answering. 'low' sends no thinking
    // param at all, exactly like every conversation already behaved. ----------

    if (req.url === '/api/effort-level' && req.method === 'POST') {
      try {
        const { level } = await readJsonBody(req);
        if (!auth.EFFORT_LEVELS.includes(level)) {
          return sendJson(res, 400, { error: `level must be one of: ${auth.EFFORT_LEVELS.join(', ')}` });
        }
        await auth.setEffortLevel(user.id, level);
        return sendJson(res, 200, { ok: true, level });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    // ---------- Skills — custom instructions a user writes and saves for
    // their own Superself, injected into its system prompt. ----------

    if (req.url === '/api/skills' && req.method === 'GET') {
      try {
        const skills = await auth.listSkills(user.id);
        return sendJson(res, 200, { ok: true, skills });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.url === '/api/skills' && req.method === 'POST') {
      try {
        const { name, instructions } = await readJsonBody(req);
        const skill = await auth.addSkill(user.id, { name, instructions });
        return sendJson(res, 200, { ok: true, skill });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.url === '/api/skills/remove' && req.method === 'POST') {
      try {
        const { id } = await readJsonBody(req);
        await auth.removeSkill(user.id, id);
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    // ---------- Connectors — external MCP servers a user points their
    // Superself at; its tools become the agent's tools mid-conversation. ----------

    if (req.url === '/api/connectors' && req.method === 'GET') {
      try {
        const list = await connectors.listConnectors(user.id);
        return sendJson(res, 200, { ok: true, connectors: list });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.url === '/api/connectors' && req.method === 'POST') {
      try {
        const { name, url, authToken } = await readJsonBody(req);
        const connector = await connectors.addConnector(user.id, { name, url, authToken });
        return sendJson(res, 200, { ok: true, connector });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.url === '/api/connectors/remove' && req.method === 'POST') {
      try {
        const { id } = await readJsonBody(req);
        await connectors.removeConnector(user.id, id);
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    // ---------- API keys — for a user's own external apps, see /api/v1/chat above. ----------

    if (req.url === '/api/keys' && req.method === 'GET') {
      try {
        const keys = await auth.listApiKeys(user.id);
        return sendJson(res, 200, { ok: true, keys });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.url === '/api/keys' && req.method === 'POST') {
      try {
        const { name } = await readJsonBody(req);
        const created = await auth.createApiKey(user.id, name);
        return sendJson(res, 200, { ok: true, ...created });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.url === '/api/keys/remove' && req.method === 'POST') {
      try {
        const { id } = await readJsonBody(req);
        await auth.revokeApiKey(user.id, id);
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    // ---------- Scheduled tasks — a saved prompt that runs itself on a
    // recurring schedule, unattended, and files its output as a memory. ----------

    if (req.url === '/api/scheduled-tasks' && req.method === 'GET') {
      try {
        const tasks = await auth.listScheduledTasks(user.id);
        return sendJson(res, 200, { ok: true, tasks, presets: scheduler.SCHEDULE_PRESETS });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.url === '/api/scheduled-tasks' && req.method === 'POST') {
      try {
        const { name, prompt, schedule, presetId } = await readJsonBody(req);
        const task = await auth.addScheduledTask(user.id, { name, prompt, schedule, presetId });
        return sendJson(res, 200, { ok: true, task });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.url === '/api/scheduled-tasks/remove' && req.method === 'POST') {
      try {
        const { id } = await readJsonBody(req);
        await auth.removeScheduledTask(user.id, id);
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.url === '/api/scheduled-tasks/toggle' && req.method === 'POST') {
      try {
        const { id, active } = await readJsonBody(req);
        const task = await auth.setScheduledTaskActive(user.id, id, active);
        return sendJson(res, 200, { ok: true, task });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.url === '/api/scheduled-tasks/run-now' && req.method === 'POST') {
      try {
        const { id } = await readJsonBody(req);
        const tasks = await scheduler.runScheduledTaskNow(user.id, id);
        return sendJson(res, 200, { ok: true, tasks });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    // ---------- Code editor — a virtual per-user file workspace (no
    // execution, no git, no real filesystem) the codeAgentPrompt tool loop
    // reads and writes, plus manual CRUD for when the user edits directly
    // in the browser instead of prompting the AI. ----------

    if (req.url === '/api/code/files' && req.method === 'GET') {
      try {
        const files = await codeFiles.listCodeFiles(user.id);
        // Listing is metadata-only — full content only over the wire when a
        // specific file is actually opened, not on every workspace refresh.
        const listing = files.map(({ id, name, language, updatedAt }) => ({ id, name, language, updatedAt }));
        return sendJson(res, 200, { ok: true, files: listing });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.url === '/api/code/files' && req.method === 'POST') {
      try {
        const { name } = await readJsonBody(req);
        if (typeof name !== 'string' || !name.trim()) return sendJson(res, 400, { error: 'name must be a non-empty string' });
        const file = await codeFiles.createCodeFile(user.id, { name: name.trim() });
        return sendJson(res, 200, { ok: true, file });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.url === '/api/code/files/get' && req.method === 'POST') {
      try {
        const { id } = await readJsonBody(req);
        const file = await codeFiles.getCodeFile(user.id, id);
        if (!file) return sendJson(res, 404, { error: 'File not found.' });
        return sendJson(res, 200, { ok: true, file });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.url === '/api/code/files/save' && req.method === 'POST') {
      try {
        const { id, content } = await readJsonBody(req);
        const existing = await codeFiles.getCodeFile(user.id, id);
        if (!existing) return sendJson(res, 404, { error: 'File not found.' });
        const { file } = await codeFiles.writeCodeFile(user.id, existing.name, content ?? '');
        return sendJson(res, 200, { ok: true, file });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.url === '/api/code/files/rename' && req.method === 'POST') {
      try {
        const { id, name } = await readJsonBody(req);
        if (typeof name !== 'string' || !name.trim()) return sendJson(res, 400, { error: 'name must be a non-empty string' });
        const file = await codeFiles.renameCodeFile(user.id, id, name.trim());
        return sendJson(res, 200, { ok: true, file });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.url === '/api/code/files/remove' && req.method === 'POST') {
      try {
        const { id } = await readJsonBody(req);
        await codeFiles.deleteCodeFile(user.id, id);
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.url === '/api/code/prompt' && req.method === 'POST') {
      // Streams progress as newline-delimited JSON. The code agent's loop is
      // several full model round trips (think → edit → summarize), and a
      // single blocking response meant the panel showed nothing at all until
      // the very end — which is what made it feel slow. Each step now lands
      // in the panel the moment it happens. Validation/budget errors before
      // the stream opens still come back as ordinary JSON status codes.
      let streaming = false;
      try {
        const usage = await auth.checkTokenUsage(user.id);
        if (!usage.allowed) {
          return sendJson(res, 429, { error: `Token budget exceeded (${usage.used}/${usage.budget}) — resets at midnight UTC.` });
        }
        const { prompt, activeFileName, history } = await readJsonBody(req);
        if (typeof prompt !== 'string' || !prompt.trim()) return sendJson(res, 400, { error: 'prompt must be a non-empty string' });
        const effectiveUser = { ...user };
        if (usage.suggestDownscale) effectiveUser.model = 'pulse';

        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
          ...SECURITY_HEADERS,
        });
        streaming = true;
        const send = (evt) => { if (!res.writableEnded) res.write(JSON.stringify(evt) + '\n'); };

        const { reply, changedFiles, usage: tokensUsed } = await codeAgentPrompt(
          user.id, effectiveUser, prompt.trim(), activeFileName,
          sanitizeHistory(history, usage.suggestDownscale ? 6 : 12), send,
        );
        await auth.incrementTokenUsage(user.id, tokensUsed.input_tokens + tokensUsed.output_tokens);
        send({ type: 'done', reply, changedFiles });
        return res.end();
      } catch (e) {
        console.error('Code prompt error:', e);
        const message = 'Something went wrong while processing your prompt — try again.';
        if (!streaming) return sendJson(res, 500, { error: message });
        try { res.write(JSON.stringify({ type: 'error', error: message }) + '\n'); } catch (_) { /* socket gone */ }
        return res.end();
      }
    }

    // Real process execution — spawns a real interpreter/dev server against
    // the workspace's actual files on disk. codeExecution.isExecutionEnabled()
    // is the hard gate: true only when ENABLE_LOCAL_CODE_EXECUTION=1 is set,
    // which is set in this repo's local .env and NEVER in Render's
    // environment, so every one of these three routes refuses outright on
    // the live deployment — no signed-up stranger can ever get code
    // execution on the shared production server. No token-usage accounting
    // here since no Anthropic API call happens in any of these three routes.

    if (req.url === '/api/code/run' && req.method === 'POST') {
      if (!codeExecution.isExecutionEnabled()) return sendJson(res, 403, { error: 'Code execution is disabled in this environment.' });
      try {
        const result = await codeExecution.startRun(user.id);
        return sendJson(res, 200, { ok: true, ...result });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.url === '/api/code/run/stop' && req.method === 'POST') {
      if (!codeExecution.isExecutionEnabled()) return sendJson(res, 403, { error: 'Code execution is disabled in this environment.' });
      const stopped = codeExecution.stopRun(user.id);
      return sendJson(res, 200, { ok: true, stopped });
    }

    if (req.url === '/api/code/run/status' && req.method === 'GET') {
      if (!codeExecution.isExecutionEnabled()) return sendJson(res, 403, { error: 'Code execution is disabled in this environment.' });
      return sendJson(res, 200, { ok: true, ...codeExecution.getRunStatus(user.id) });
    }

    // ---------- Feedback — straight to Ari's inbox, plus a durable record
    // in Firestore so nothing depends on an email actually landing. ----------

    if (req.url === '/api/feedback' && req.method === 'POST') {
      try {
        const { message } = await readJsonBody(req);
        if (typeof message !== 'string' || !message.trim()) {
          return sendJson(res, 400, { error: 'Say something first.' });
        }
        const trimmed = message.trim().slice(0, 4000);
        const id = randomBytes(8).toString('hex');
        await setDoc('feedback', id, {
          id, userId: user.id, username: user.username, message: trimmed,
          createdAt: new Date().toISOString(),
        });
        sendFeedbackNotification(user, trimmed).catch((e) => console.error('Feedback email failed:', e));
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    // ---------- Referrals — every account's own invite code, and how many
    // people have used it so far. ----------

    if (req.url === '/api/referral' && req.method === 'GET') {
      try {
        const info = await auth.getReferralInfo(user.id);
        return sendJson(res, 200, { ok: true, ...info });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    // ---------- Account settings: username, Superself name, password, email ----------

    if (req.url === '/api/username' && req.method === 'POST') {
      try {
        const { username } = await readJsonBody(req);
        if (!username?.trim()) return sendJson(res, 400, { error: 'Username is required.' });
        const updated = await auth.setUsername(user.id, username);
        return sendJson(res, 200, { ok: true, username: updated.username });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.url === '/api/ai-name' && req.method === 'POST') {
      try {
        const { aiName } = await readJsonBody(req);
        if (!aiName?.trim()) return sendJson(res, 400, { error: 'A name is required.' });
        const updated = await auth.setAiName(user.id, aiName);
        return sendJson(res, 200, { ok: true, aiName: updated.aiName });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.url === '/api/change-password' && req.method === 'POST') {
      try {
        const { currentPassword, newPassword } = await readJsonBody(req);
        if (!newPassword) return sendJson(res, 400, { error: 'A new password is required.' });
        await auth.changePassword(user.id, currentPassword, newPassword);
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.url === '/api/change-email-start' && req.method === 'POST') {
      try {
        const { newEmail, currentPassword } = await readJsonBody(req);
        if (!newEmail?.trim()) return sendJson(res, 400, { error: 'A new email is required.' });
        const { code, newEmail: normalized } = await auth.startEmailChange(user.id, newEmail, currentPassword);
        await sendVerificationCode(normalized, code);
        return sendJson(res, 200, { ok: true });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.url === '/api/change-email-finish' && req.method === 'POST') {
      try {
        const { code } = await readJsonBody(req);
        if (!code) return sendJson(res, 400, { error: 'Code is required.' });
        const updated = await auth.finishEmailChange(user.id, code);
        return sendJson(res, 200, { ok: true, email: updated.email });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    // ---------- Billing — sends the user to Stripe's own hosted pages for
    // both checkout and subscription management; this app never touches a
    // card number. Plan itself only ever actually changes from the webhook
    // above once real money moves, not from these routes directly. ----------

    if (req.url === '/api/checkout' && req.method === 'POST') {
      try {
        if (!billing.isConfigured()) return sendJson(res, 400, { error: 'Payments are not set up yet.' });
        const url = await billing.createCheckoutSession(user);
        return sendJson(res, 200, { ok: true, url });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    if (req.url === '/api/billing-portal' && req.method === 'POST') {
      try {
        if (!billing.isConfigured()) return sendJson(res, 400, { error: 'Payments are not set up yet.' });
        const url = await billing.createBillingPortalSession(user);
        return sendJson(res, 200, { ok: true, url });
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
      const { kind } = await readJsonBody(req).catch(() => ({}));
      await companion.unpair(user.id, kind);
      return sendJson(res, 200, { ok: true });
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
        return sendJson(res, 500, { error: 'Could not apply that correction — try again.' });
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

    if (req.url === '/api/connections/remove' && req.method === 'POST') {
      try {
        const { id } = await readJsonBody(req);
        if (!id) return sendJson(res, 400, { error: 'id is required.' });
        await connections.removeConnection(user.id, id);
        return sendJson(res, 200, { ok: true });
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
        return sendJson(res, 500, { error: 'Could not extract memories — try again.' });
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
        return sendJson(res, 500, { error: 'Could not save that memory — try again.' });
      }
    }

    // The autonomous task loop — same engine grow.js runs on a daily cron,
    // now actually reachable by the person it belongs to, not just a
    // background job. Can take a while (multi-turn tool use), so this just
    // awaits it rather than pretending it's instant.
    if (req.url === '/api/task' && req.method === 'POST') {
      try {
        const usage = await auth.checkTokenUsage(user.id);
        if (!usage.allowed) {
          return sendJson(res, 429, { error: `Token budget exceeded (${usage.used}/${usage.budget}) — resets at midnight UTC.` });
        }
        const { task, history, mode } = await readJsonBody(req);
        if (typeof task !== 'string' || !task.trim()) {
          return sendJson(res, 400, { error: 'task must be a non-empty string' });
        }
        const effectiveUser = { ...user };
        if (usage.suggestDownscale) effectiveUser.model = 'pulse';
        const opts = mode === 'deep' ? { mode: 'deep' } : {};
        const { result, usage: tokensUsed } = await runTask(user.id, effectiveUser, task.trim(), sanitizeHistory(history, usage.suggestDownscale ? 6 : 12), opts);
        await auth.incrementTokenUsage(user.id, tokensUsed.input_tokens + tokensUsed.output_tokens);
        return sendJson(res, 200, { result });
      } catch (e) {
        console.error('Task error:', e);
        return sendJson(res, 500, { error: 'The task failed — try again or simplify it.' });
      }
    }

    if (req.url === '/api/chat' && req.method === 'POST') {
      try {
        const usage = await auth.checkTokenUsage(user.id);
        if (!usage.allowed) {
          return sendJson(res, 429, { error: `Token budget exceeded (${usage.used}/${usage.budget}) — resets at midnight UTC.` });
        }
        const { message, history, mode } = await readJsonBody(req);
        if (typeof message !== 'string' || !message.trim()) {
          return sendJson(res, 400, { error: 'message must be a non-empty string' });
        }
        const effectiveUser = { ...user };
        if (usage.suggestDownscale) effectiveUser.model = 'pulse';
        const { reply, thinking, usage: tokensUsed } = await chatReply(user.id, effectiveUser, message.trim(), sanitizeHistory(history, usage.suggestDownscale ? 6 : 12), mode === 'text' ? 'text' : 'voice');
        await auth.incrementTokenUsage(user.id, tokensUsed.input_tokens + tokensUsed.output_tokens);
        return sendJson(res, 200, thinking ? { reply, thinking } : { reply });
} catch (e) {
      console.error('Chat error:', e);
      return sendJson(res, 500, { error: 'Something went wrong while replying — try again.' });
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
    const headers = { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream', ...SECURITY_HEADERS };
    // The whole app is one HTML file with everything inlined — no separate,
    // hash-named JS bundle to cache-bust. Without this, a browser can hold
    // onto a stale copy across a plain reload and never notice a real
    // deploy shipped (this is genuinely how a live user ended up staring at
    // pairing instructions from before a fix went out). Every other static
    // file (images, the manifest, the companion zip) is unaffected.
    if (path === '/index.html') headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    res.end(readFileSync(filePath));
  } catch (e) {
    console.error('Static file error:', e);
    res.writeHead(500);
    res.end('Server error');
  }
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((e) => {
    console.error('Unhandled request error:', e);
    if (res.headersSent) return res.end();
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Server error' }));
  });
});

// Last-resort net: something outside any request (a background timer, the
// companion WebSocket handling, a stray rejection) should still never take
// the whole server down for everyone else connected to it.
process.on('uncaughtException', (e) => console.error('Uncaught exception:', e));
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));

// Lets the Chrome extension's side panel chat and identity header work
// over its already-authenticated pairing connection, with no session
// cookie needed — companion.js can't import agent.js/auth.js directly
// (agent.js already imports companion.js for sendCommand), so this hands
// it the two functions it needs instead of creating an import cycle.
companion.registerAgentHooks({
  chat: async (userId, message, history) => {
    const user = await auth.findUserById(userId);
    if (!user) throw new Error('Account not found.');
    if (typeof message !== 'string' || !message.trim()) throw new Error('message must be a non-empty string');
    const usage = await auth.checkTokenUsage(userId);
    if (!usage.allowed) throw new Error(`Token budget exceeded (${usage.used}/${usage.budget}) — resets at midnight UTC.`);
    const effectiveUser = { ...user };
    if (usage.suggestDownscale) effectiveUser.model = 'pulse';
    const { reply, usage: tokensUsed } = await chatReply(userId, effectiveUser, message.trim(), sanitizeHistory(history, usage.suggestDownscale ? 6 : 12), 'text-plain');
    await auth.incrementTokenUsage(userId, tokensUsed.input_tokens + tokensUsed.output_tokens);
    return reply;
  },
  identity: async (userId) => {
    const user = await auth.findUserById(userId);
    return user ? { aiName: user.aiName, displayName: user.displayName } : null;
  },
});

companion.attach(server);
scheduler.startScheduler();
server.listen(PORT, () => console.log(`Brain graph running at http://localhost:${PORT}`));
