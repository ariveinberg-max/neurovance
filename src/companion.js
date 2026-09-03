import { WebSocketServer } from 'ws';
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { getDoc, setDoc } from './db.js';
import * as pendingNotes from './pending-notes.js';

// Constant-time string comparison for the reconnect token — a naive ===
// comparison of a client-supplied secret could leak timing information
// useful for a byte-by-byte guess (the token is 64 hex chars, brute-forced
// byte-by-byte this way is far cheaper than the full 256-bit space).
function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

// Lets a user's own agent reach a small, read-only, explicitly-scoped folder
// on their own computer, and drive their own browser — via two kinds of
// client they can pair independently and use at the same time:
//   - "native": the local Companion app (companion/companion.js, macOS or
//     Windows) — files, Contacts, iMessage, Calendar, Mail, Music, and
//     AppleScript-driven browser control on Mac.
//   - "browser": the Chrome extension — browser actions only (open/read/
//     click/type/list), no download, no AppleScript permission gate.
// When both are paired, browser actions prefer whichever is actually
// connected right now, falling back to the other; native-only actions
// (files, Contacts, etc.) only ever go through the native connection, since
// a browser extension has no way to reach any of that.
//
// Firestore keeps them as two sibling fields on the same companions/{userId}
// doc: the native pairing lives in the same top-level fields it always has
// (pairedAt/hostname/lastSeen/unpaired), untouched, so no migration is
// needed for existing accounts. The extension's pairing lives entirely
// under a new `browserExt` key. Firestore's set() is a full overwrite, not
// a merge, so every write below reads the whole doc first and spreads it —
// forgetting that would silently drop whichever kind isn't being touched.

// Both native (AppleScript) and browser (extension) can do these — prefer
// the extension when it's connected.
const BROWSER_PREFERRED_ACTIONS = new Set([
  'open_url', 'read_safari_content', 'click_page_element',
  'type_into_page_field', 'go_back', 'list_page_elements',
]);

// Extension-only — AppleScript has no clean way to enumerate/switch tabs,
// so these should never silently fall back to the native connection (that
// would just surface a confusing "unknown action" from the desktop app).
const BROWSER_ONLY_ACTIONS = new Set(['list_open_tabs', 'switch_to_tab']);

function normalizeKind(kind) {
  return kind === 'browser' ? 'browser' : 'native';
}

// Set once at startup by server.js (which owns agent.js/auth.js) — avoids a
// circular import, since agent.js already imports this module for
// sendCommand. { chat: (userId, message, history) => reply string,
// identity: (userId) => { aiName, displayName } | null }
let agentHooks = {};
export function registerAgentHooks(hooks) {
  agentHooks = hooks;
}

async function loadDoc(userId) {
  return (await getDoc('companions', userId)) || null;
}

function nativeRecord(doc) {
  return doc && !doc.unpaired ? doc : null;
}

function browserRecord(doc) {
  return doc?.browserExt && !doc.browserExt.unpaired ? doc.browserExt : null;
}

// Pairing codes and live sockets are in-memory only — a server restart just
// means paired clients reconnect on their own (they retry every 5s), and any
// pairing code that was mid-flight has to be requested again, which is fine
// since it's a 10-minute-lived, one-time-use code anyway.
const pairingCodes = new Map(); // code -> { userId, expiresAt }
const liveConnections = new Map(); // userId -> { native: WebSocket|null, browser: WebSocket|null }
const pendingCommands = new Map(); // commandId -> { resolve, reject, timeout }

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 15 * 1000;
// run_shell_command waits on a live human at the terminal (to approve the
// command) and then the command itself (up to 2 minutes, companion.js's own
// cap) — the normal 15s budget every other action gets would time this out
// before the person even finishes reading the prompt.
const SHELL_COMMAND_TIMEOUT_MS = 3 * 60 * 1000;

// A pairing code is only 6 digits (~1M possibilities) — fine against one
// guess-then-reconnect at a time, not against someone opening many
// connections to grind through codes before a real one expires. This caps
// how many pairing attempts one source IP gets in that same window, so
// brute-forcing needs many different IPs, not just many connections.
//
// The reconnect token below complements this: a pair code is a short-lived
// claim of identity, but reconnecting after a drop would otherwise accept
// the userId alone with no proof — the userId is stored in plaintext on the
// user's machine (config file), so someone who read that file could hijack
// the companion connection for life. The token is the secret half of the
// pair: kept alongside the userId on the client, needed to reconnect, and
// regenerated on every new pairing so an old token dies with the session.
const pairAttempts = new Map(); // ip -> { count, resetAt }
const PAIR_MAX_ATTEMPTS = 8;

function clientIp(req) {
  return req.headers['cf-connecting-ip'] || req.socket.remoteAddress || 'unknown';
}

function checkPairRateLimit(ip) {
  const now = Date.now();
  const entry = pairAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    pairAttempts.set(ip, { count: 1, resetAt: now + PAIRING_CODE_TTL_MS });
    return true;
  }
  if (entry.count >= PAIR_MAX_ATTEMPTS) return false;
  entry.count += 1;
  return true;
}

// Kind-agnostic on purpose — the same code works for either client. Which
// kind gets paired is decided by whichever client actually uses it (the
// Node Companion never sends `kind`, so it defaults to native; the
// extension sends `kind: 'browser'`).
export function generatePairingCode(userId) {
  const code = String(randomBytes(3).readUIntBE(0, 3) % 1000000).padStart(6, '0');
  pairingCodes.set(code, { userId, expiresAt: Date.now() + PAIRING_CODE_TTL_MS });
  return code;
}

export async function isPaired(userId) {
  const doc = await loadDoc(userId);
  return !!(nativeRecord(doc) || browserRecord(doc));
}

export async function companionStatus(userId) {
  const doc = await loadDoc(userId);
  const conns = liveConnections.get(userId) || {};
  const native = nativeRecord(doc);
  const browser = browserRecord(doc);
  return {
    native: native
      ? { paired: true, pairedAt: native.pairedAt, hostname: native.hostname, online: !!conns.native, lastSeen: native.lastSeen }
      : { paired: false },
    browser: browser
      ? { paired: true, pairedAt: browser.pairedAt, online: !!conns.browser, lastSeen: browser.lastSeen }
      : { paired: false },
  };
}

// kind omitted unpairs both — kept for a single "disconnect everything"
// action; the Settings UI passes an explicit kind for its two separate
// disconnect buttons.
export async function unpair(userId, kind) {
  const conns = liveConnections.get(userId);
  const doc = (await loadDoc(userId)) || {};
  const next = { ...doc };

  if (!kind || kind === 'native') {
    conns?.native?.close();
    if (conns) conns.native = null;
    next.unpaired = true;
  }
  if (!kind || kind === 'browser') {
    conns?.browser?.close();
    if (conns) conns.browser = null;
    next.browserExt = { ...doc.browserExt, unpaired: true };
  }
  await setDoc('companions', userId, next);
}

export function attach(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/companion-ws') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    let userId = null;
    let kind = null;
    const ip = clientIp(req);

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'pair') {
        if (!checkPairRateLimit(ip)) {
          ws.send(JSON.stringify({ type: 'pair_result', ok: false, error: 'Too many pairing attempts — wait a few minutes and try again.' }));
          return ws.close();
        }
        const entry = pairingCodes.get(msg.code);
        if (!entry || entry.expiresAt < Date.now()) {
          ws.send(JSON.stringify({ type: 'pair_result', ok: false, error: 'Invalid or expired code.' }));
          return ws.close();
        }
        pairingCodes.delete(msg.code);
        userId = entry.userId;
        kind = normalizeKind(msg.kind);

        const conns = liveConnections.get(userId) || { native: null, browser: null };
        conns[kind] = ws;
        liveConnections.set(userId, conns);

        const doc = (await loadDoc(userId)) || {};
        const now = new Date().toISOString();
        // Fresh reconnect token on every pair — an old token dies when it's
        // replaced, so a leaked token can never outlive a re-pairing.
        const reconnectToken = randomBytes(32).toString('hex');
        if (kind === 'native') {
          const prev = nativeRecord(doc);
          await setDoc('companions', userId, {
            ...doc,
            pairedAt: prev?.pairedAt || now,
            lastSeen: now,
            hostname: msg.hostname || 'unknown computer',
            unpaired: false,
            reconnectToken,
          });
        } else {
          const prev = browserRecord(doc);
          await setDoc('companions', userId, {
            ...doc,
            browserExt: { pairedAt: prev?.pairedAt || now, lastSeen: now, unpaired: false, reconnectToken },
          });
        }
        ws.send(JSON.stringify({ type: 'pair_result', ok: true, userId, reconnectToken }));
        return;
      }

      if (msg.type === 'reconnect') {
        const reqKind = normalizeKind(msg.kind);
        const doc = await loadDoc(msg.userId);
        const record = reqKind === 'native' ? nativeRecord(doc) : browserRecord(doc);
        // The reconnect token is the sole proof of identity here — the
        // userId alone is stored in plaintext on the client, so accepting
        // it without the token would let anyone who read that file hijack
        // the connection. Old accounts paired before this existed have no
        // token on record; they must re-pair (one 6-digit code, rate-limited)
        // rather than silently trusting a bare userId.
        const expectedToken = reqKind === 'native' ? doc?.reconnectToken : doc?.browserExt?.reconnectToken;
        if (!record || !expectedToken || !timingSafeEqualStr(msg.reconnectToken, expectedToken)) {
          ws.send(JSON.stringify({ type: 'reconnect_result', ok: false, error: 'Reconnect rejected — re-pair the Companion.' }));
          return ws.close();
        }
        userId = msg.userId;
        kind = reqKind;

        const conns = liveConnections.get(userId) || { native: null, browser: null };
        conns[kind] = ws;
        liveConnections.set(userId, conns);

        const now = new Date().toISOString();
        if (kind === 'native') {
          await setDoc('companions', userId, { ...doc, lastSeen: now });
        } else {
          await setDoc('companions', userId, { ...doc, browserExt: { ...doc.browserExt, lastSeen: now } });
        }
        ws.send(JSON.stringify({ type: 'reconnect_result', ok: true }));
        return;
      }

      // Ambient presence: the Companion watches the shared folder itself and
      // tells us when something changes — this only ever queues a note the
      // user sees inside a session they opened, never a push notification.
      // Native-only; the browser extension never sends this.
      if (msg.type === 'event' && msg.name === 'file_changed' && userId) {
        // The filename comes from the user's own filesystem, but a downloaded
        // file with a crafted name could carry prompt-injection text ("ignore
        // instructions…"). It flows into a pending note which later goes into
        // the system prompt, so strip anything that isn't a plain filename.
        const cleanName = String(msg.data?.filename || '')
          .replace(/[\r\n\t\x00-\x1f]/g, ' ')
          .slice(0, 200)
          .trim();
        await pendingNotes.addNote(userId, 'companion', `I noticed "${cleanName}" changed in your Neurovance folder.`);
        return;
      }

      if (msg.type === 'result') {
        const pending = pendingCommands.get(msg.id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        pendingCommands.delete(msg.id);
        if (msg.ok) pending.resolve(msg.data);
        else pending.reject(new Error(msg.error || 'Companion command failed.'));
        return;
      }

      // Self-service disconnect — the extension has no session cookie on
      // the main site, so it can't call the authenticated /api/companion/
      // unpair route. It's already proven its identity by pairing in the
      // first place, so it can ask to unpair itself over this same
      // connection instead. Scoped to whichever kind THIS socket is.
      if (msg.type === 'unpair' && userId && kind) {
        await unpair(userId, kind);
        return;
      }

      // The extension's side panel chat and its "who am I talking to"
      // header both ride this same already-authenticated connection —
      // it has no session cookie on the main site to call /api/chat or
      // /api/me with directly, but it's already proven its identity by
      // pairing, so agent.chatReply runs server-side exactly like it would
      // from a real browser tab, via the hooks registered in server.js.
      if (msg.type === 'get_identity' && userId) {
        try {
          const identity = agentHooks.identity ? await agentHooks.identity(userId) : null;
          ws.send(JSON.stringify({ type: 'identity_result', id: msg.id, ok: true, identity }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'identity_result', id: msg.id, ok: false, error: e.message }));
        }
        return;
      }

      if (msg.type === 'chat' && userId) {
        if (!agentHooks.chat) {
          ws.send(JSON.stringify({ type: 'chat_result', id: msg.id, ok: false, error: 'Chat is not available right now.' }));
          return;
        }
        try {
          const reply = await agentHooks.chat(userId, msg.message, msg.history || []);
          ws.send(JSON.stringify({ type: 'chat_result', id: msg.id, ok: true, reply }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'chat_result', id: msg.id, ok: false, error: e.message }));
        }
        return;
      }
    });

    ws.on('close', () => {
      if (!userId || !kind) return;
      const conns = liveConnections.get(userId);
      if (conns && conns[kind] === ws) conns[kind] = null;
    });
  });
}

export function sendCommand(userId, action, params = {}) {
  const conns = liveConnections.get(userId) || {};
  let ws;
  if (BROWSER_ONLY_ACTIONS.has(action)) {
    ws = conns.browser;
  } else if (BROWSER_PREFERRED_ACTIONS.has(action)) {
    // Prefer the extension when it's connected — if it's installed, that's
    // what should drive the browser, not AppleScript.
    ws = conns.browser || conns.native;
  } else {
    ws = conns.native;
  }
  if (!ws) {
    let message;
    if (BROWSER_ONLY_ACTIONS.has(action)) {
      message = 'Listing or switching tabs needs the Chrome extension connected — the desktop Companion can\'t do this.';
    } else if (BROWSER_PREFERRED_ACTIONS.has(action)) {
      message = 'Not connected — pair a computer or connect the browser extension first.';
    } else {
      message = 'The Neurovance Companion app is not connected right now — open it on your computer.';
    }
    return Promise.reject(new Error(message));
  }
  const id = randomUUID();
  const timeoutMs = action === 'run_shell_command' ? SHELL_COMMAND_TIMEOUT_MS : COMMAND_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCommands.delete(id);
      reject(new Error('Companion did not respond in time.'));
    }, timeoutMs);
    pendingCommands.set(id, { resolve, reject, timeout });
    ws.send(JSON.stringify({ type: 'command', id, action, params }));
  });
}
