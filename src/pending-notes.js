import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// A small inbox of things a Superself wants to bring up on its own —
// something it noticed while consolidating memories, a question it wants to
// ask, a file it saw appear in the Companion folder. Not a notification
// system (nothing pushes to the user outside the app) — just a queue the
// chat flow and the UI both check, so "proactive" still only ever surfaces
// inside a session the user actually opened.

const __dirname = dirname(fileURLToPath(import.meta.url));
const USERS_DIR = join(__dirname, '..', 'memory', 'users');

function pathFor(userId) {
  return join(USERS_DIR, userId, 'pending-notes.json');
}

function ensureStore(userId) {
  const dir = join(USERS_DIR, userId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = pathFor(userId);
  if (!existsSync(path)) writeFileSync(path, '[]');
}

function load(userId) {
  ensureStore(userId);
  return JSON.parse(readFileSync(pathFor(userId), 'utf-8'));
}

function save(userId, notes) {
  ensureStore(userId);
  writeFileSync(pathFor(userId), JSON.stringify(notes, null, 2));
}

export function addNote(userId, kind, text) {
  const notes = load(userId);
  const entry = {
    id: notes.length ? notes[notes.length - 1].id + 1 : 1,
    kind, // 'insight' | 'curiosity' | 'companion'
    text,
    createdAt: new Date().toISOString(),
    seen: false,
  };
  notes.push(entry);
  // Keep this small and current — an unbounded backlog of stale "I noticed
  // X" notes from weeks ago is noise, not presence.
  save(userId, notes.slice(-20));
  return entry;
}

export function unseenNotes(userId) {
  return load(userId).filter((n) => !n.seen);
}

export function markSeen(userId, id) {
  const notes = load(userId);
  const entry = notes.find((n) => n.id === id);
  if (entry) entry.seen = true;
  save(userId, notes);
}

export function markAllSeen(userId) {
  const notes = load(userId).map((n) => ({ ...n, seen: true }));
  save(userId, notes);
}
