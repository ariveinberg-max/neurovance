import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { findUserByUsername, findUserById } from './auth.js';
import { allMemories } from './memory.js';

// Mediated introductions between two people's Superselves — private,
// invite-only by exact username (no directory or "browse users" surface to
// scan or scrape), and both sides have to explicitly accept before anything
// is shared. What gets shared is never raw memory content: each side's own
// recurring topic tags are intersected programmatically, and only the tags
// that land in BOTH sets are ever returned to either person. Neither user's
// full tag list, memory content, or counts are exposed — only "you both have
// this in common," nothing else.

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONNECTIONS_PATH = join(__dirname, '..', 'memory', 'connections.json');

function load() {
  if (!existsSync(CONNECTIONS_PATH)) return [];
  return JSON.parse(readFileSync(CONNECTIONS_PATH, 'utf-8'));
}

function save(connections) {
  const dir = dirname(CONNECTIONS_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CONNECTIONS_PATH, JSON.stringify(connections, null, 2));
}

function publicUser(userId) {
  const u = findUserById(userId);
  return u ? { username: u.username, displayName: u.displayName, aiName: u.aiName } : null;
}

export function requestConnection(fromUserId, toUsername) {
  const toUser = findUserByUsername(toUsername);
  if (!toUser) throw new Error('No account with that username.');
  if (toUser.id === fromUserId) throw new Error('You cannot connect with yourself.');

  const connections = load();
  const existing = connections.find((c) =>
    (c.fromUserId === fromUserId && c.toUserId === toUser.id) ||
    (c.fromUserId === toUser.id && c.toUserId === fromUserId)
  );
  if (existing) throw new Error(`A connection with ${toUser.username} already exists (${existing.status}).`);

  const entry = {
    id: randomUUID(),
    fromUserId,
    toUserId: toUser.id,
    status: 'pending',
    createdAt: new Date().toISOString(),
    respondedAt: null,
  };
  connections.push(entry);
  save(connections);
  return entry;
}

export function listConnectionsFor(userId) {
  return load()
    .filter((c) => c.fromUserId === userId || c.toUserId === userId)
    .map((c) => {
      const otherId = c.fromUserId === userId ? c.toUserId : c.fromUserId;
      return {
        id: c.id,
        status: c.status,
        direction: c.fromUserId === userId ? 'outgoing' : 'incoming',
        other: publicUser(otherId),
        createdAt: c.createdAt,
      };
    });
}

export function respondToConnection(userId, connectionId, accept) {
  const connections = load();
  const entry = connections.find((c) => c.id === connectionId);
  if (!entry) throw new Error('No such connection request.');
  if (entry.toUserId !== userId) throw new Error('Only the invited person can respond to this.');
  if (entry.status !== 'pending') throw new Error('This request was already responded to.');

  entry.status = accept ? 'accepted' : 'declined';
  entry.respondedAt = new Date().toISOString();
  save(connections);
  return entry;
}

// A topic only counts as "theirs" if it shows up more than once — a single
// one-off tag isn't a real recurring interest, and treating it like one
// would make the overlap feature leak more than it's meant to.
function recurringTags(userId) {
  const counts = {};
  for (const m of allMemories(userId)) {
    for (const tag of m.tags || []) counts[tag] = (counts[tag] || 0) + 1;
  }
  return new Set(Object.entries(counts).filter(([, n]) => n >= 2).map(([tag]) => tag));
}

export function getOverlap(userId, connectionId) {
  const connections = load();
  const entry = connections.find((c) => c.id === connectionId);
  if (!entry) throw new Error('No such connection.');
  if (entry.fromUserId !== userId && entry.toUserId !== userId) throw new Error('Not your connection.');
  if (entry.status !== 'accepted') throw new Error('Both people have to accept before anything is shared.');

  const otherId = entry.fromUserId === userId ? entry.toUserId : entry.fromUserId;
  const mine = recurringTags(userId);
  const theirs = recurringTags(otherId);
  const shared = [...mine].filter((tag) => theirs.has(tag));
  return { shared };
}
