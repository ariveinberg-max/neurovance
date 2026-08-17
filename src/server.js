import 'dotenv/config';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { allMemories, remember } from './memory.js';
import { chatReply, getLastRecall, extractMemories } from './agent.js';
import { computeVitals } from './vitals.js';
import * as auth from './auth.js';
import { sendVerificationCode } from './mailer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PORT = process.env.PORT || 4173;
const SESSION_COOKIE = 'ari_session';

// Mission-control palette: mostly grey/silver so the graph reads as one
// instrument, with telemetry-alert red reserved for genuinely critical memories.
function colorForMemory(importance) {
  if (importance >= 5) return '#e8432c';
  if (importance >= 4) return '#c8c9cf';
  return '#6b6c74';
}

function buildGraph(userId) {
  const memories = allMemories(userId);

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
function getSessionAndUser(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies[SESSION_COOKIE];
  const session = auth.getSession(token);
  if (!session) return { session: null, user: null, token: null };
  return { session, user: auth.findUserById(session.userId), token };
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
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  // ---------- Signup: email + password -> emailed code -> pick username ----------

  if (req.url === '/api/signup-start' && req.method === 'POST') {
    try {
      const { email, password } = await readJsonBody(req);
      if (!email?.trim() || !password) {
        return sendJson(res, 400, { error: 'Email and password are required.' });
      }
      const code = auth.startSignup({ email, password });
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
      const verifiedToken = auth.verifySignupCode({ email, code });
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
      const user = auth.finishSignup({ email, verifiedToken, username, displayName, aiName });
      const token = auth.createSession(user.id);
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
      const user = username && auth.findUserByUsername(username);
      if (!user || !auth.verifyPassword(password || '', user.passwordHash)) {
        return sendJson(res, 401, { error: 'Wrong username or password.' });
      }
      const token = auth.createSession(user.id);
      setSessionCookie(res, token, remember !== false);
      sendJson(res, 200, { ok: true, displayName: user.displayName, aiName: user.aiName });
    } catch (e) {
      sendJson(res, 400, { error: e.message });
    }
    return;
  }

  if (req.url === '/api/logout' && req.method === 'POST') {
    const cookies = parseCookies(req.headers.cookie || '');
    auth.destroySession(cookies[SESSION_COOKIE]);
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.url === '/api/me') {
    const { user } = getSessionAndUser(req);
    if (!user) return sendJson(res, 401, { ok: false });
    sendJson(res, 200, { ok: true, displayName: user.displayName, aiName: user.aiName, username: user.username });
    return;
  }

  // Everything below requires a valid session.
  if (req.url.startsWith('/api/')) {
    const { user } = getSessionAndUser(req);
    if (!user) return sendJson(res, 401, { error: 'Not authenticated' });

    if (req.url === '/api/graph') {
      return sendJson(res, 200, buildGraph(user.id));
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
        const entry = remember(
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

    if (req.url === '/api/chat' && req.method === 'POST') {
      try {
        const { message } = await readJsonBody(req);
        if (typeof message !== 'string' || !message.trim()) {
          return sendJson(res, 400, { error: 'message must be a non-empty string' });
        }
        const reply = await chatReply(user.id, user, message.trim());
        return sendJson(res, 200, { reply });
      } catch (e) {
        console.error('Chat error:', e);
        return sendJson(res, 500, { error: 'Chat failed: ' + e.message });
      }
    }

    return sendJson(res, 404, { error: 'Not found' });
  }

  const path = req.url === '/' ? '/index.html' : req.url;
  const filePath = join(PUBLIC_DIR, path.split('?')[0]);
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
  res.end(readFileSync(filePath));
}).listen(PORT, () => console.log(`Brain graph running at http://localhost:${PORT}`));
