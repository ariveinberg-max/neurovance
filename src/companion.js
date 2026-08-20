import { WebSocketServer } from 'ws';
import { randomBytes, randomUUID } from 'crypto';
import { getDoc, setDoc } from './db.js';
import * as pendingNotes from './pending-notes.js';

// Lets a user's own agent reach a small, read-only, explicitly-scoped folder
// on their own computer, plus open URLs in their own Safari — via a local
// "Companion" app they install and pair themselves (companion/companion.js).
// Nothing here can read outside that one folder or write/delete anything;
// that's enforced on the companion side (see resolveScoped there), since
// the companion is the thing that actually touches the filesystem.

async function loadRecord(userId) {
  const record = await getDoc('companions', userId);
  return record && !record.unpaired ? record : null;
}

async function saveRecord(userId, record) {
  await setDoc('companions', userId, record);
}

// Pairing codes and live sockets are in-memory only — a server restart just
// means paired companions reconnect on their own (they retry every 5s), and
// any pairing code that was mid-flight has to be requested again, which is
// fine since it's a 10-minute-lived, one-time-use code anyway.
const pairingCodes = new Map(); // code -> { userId, expiresAt }
const liveConnections = new Map(); // userId -> WebSocket
const pendingCommands = new Map(); // commandId -> { resolve, reject, timeout }

// Most recent screenshot of the user's own Safari window, taken by the
// Companion after any action that changes what's on screen (open/click/type)
// — lets the web app show a live-ish preview of what the Superself is
// actually looking at while it browses. In-memory and per-process, same as
// the connection/command maps above: it's a live "what's happening right
// now" signal, not something worth persisting across a restart.
const latestFrames = new Map(); // userId -> { data, ts }
const FRAME_MAX_AGE_MS = 2 * 60 * 1000;

export function setLatestFrame(userId, base64, pageUrl) {
  if (!base64) return;
  latestFrames.set(userId, { data: base64, url: pageUrl || '', ts: Date.now() });
}

export function getLatestFrame(userId) {
  const frame = latestFrames.get(userId);
  if (!frame || Date.now() - frame.ts > FRAME_MAX_AGE_MS) return null;
  return frame;
}

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 15 * 1000;

export function generatePairingCode(userId) {
  const code = String(randomBytes(3).readUIntBE(0, 3) % 1000000).padStart(6, '0');
  pairingCodes.set(code, { userId, expiresAt: Date.now() + PAIRING_CODE_TTL_MS });
  return code;
}

export async function isPaired(userId) {
  return !!(await loadRecord(userId));
}

export async function companionStatus(userId) {
  const record = await loadRecord(userId);
  if (!record) return { paired: false };
  return { paired: true, pairedAt: record.pairedAt, hostname: record.hostname, online: liveConnections.has(userId), lastSeen: record.lastSeen };
}

export async function unpair(userId) {
  liveConnections.get(userId)?.close();
  liveConnections.delete(userId);
  await saveRecord(userId, { unpaired: true });
}

export function attach(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/companion-ws') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  wss.on('connection', (ws) => {
    let userId = null;

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'pair') {
        const entry = pairingCodes.get(msg.code);
        if (!entry || entry.expiresAt < Date.now()) {
          ws.send(JSON.stringify({ type: 'pair_result', ok: false, error: 'Invalid or expired code.' }));
          return ws.close();
        }
        pairingCodes.delete(msg.code);
        userId = entry.userId;
        liveConnections.set(userId, ws);
        const existing = await loadRecord(userId);
        await saveRecord(userId, {
          pairedAt: existing?.pairedAt || new Date().toISOString(),
          lastSeen: new Date().toISOString(),
          hostname: msg.hostname || 'unknown computer',
        });
        ws.send(JSON.stringify({ type: 'pair_result', ok: true, userId }));
        return;
      }

      if (msg.type === 'reconnect') {
        if (!(await isPaired(msg.userId))) {
          ws.send(JSON.stringify({ type: 'reconnect_result', ok: false }));
          return ws.close();
        }
        userId = msg.userId;
        liveConnections.set(userId, ws);
        const existing = await loadRecord(userId);
        await saveRecord(userId, { ...existing, lastSeen: new Date().toISOString() });
        ws.send(JSON.stringify({ type: 'reconnect_result', ok: true }));
        return;
      }

      // Ambient presence: the Companion watches the shared folder itself and
      // tells us when something changes — this only ever queues a note the
      // user sees inside a session they opened, never a push notification.
      if (msg.type === 'event' && msg.name === 'file_changed' && userId) {
        await pendingNotes.addNote(userId, 'companion', `I noticed "${msg.data.filename}" changed in your Neurovance folder.`);
        return;
      }

      if (msg.type === 'result') {
        const pending = pendingCommands.get(msg.id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        pendingCommands.delete(msg.id);
        if (msg.ok) pending.resolve(msg.data);
        else pending.reject(new Error(msg.error || 'Companion command failed.'));
      }
    });

    ws.on('close', () => {
      if (userId && liveConnections.get(userId) === ws) liveConnections.delete(userId);
    });
  });
}

export function sendCommand(userId, action, params = {}) {
  const ws = liveConnections.get(userId);
  if (!ws) {
    return Promise.reject(new Error('The Neurovance Companion app is not connected right now — open it on your computer.'));
  }
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCommands.delete(id);
      reject(new Error('Companion did not respond in time.'));
    }, COMMAND_TIMEOUT_MS);
    pendingCommands.set(id, { resolve, reject, timeout });
    ws.send(JSON.stringify({ type: 'command', id, action, params }));
  });
}
