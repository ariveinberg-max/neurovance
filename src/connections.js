import { randomUUID } from 'crypto';
import { getAllDocs, setDoc, deleteDoc, queryDocsByField } from './db.js';
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

async function loadAll() {
  return getAllDocs('connections');
}

async function loadForUser(userId) {
  const [asSender, asRecipient] = await Promise.all([
    queryDocsByField('connections', 'fromUserId', userId),
    queryDocsByField('connections', 'toUserId', userId),
  ]);
  const seen = new Set();
  return [...asSender, ...asRecipient].filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
}

async function saveOne(entry) {
  await setDoc('connections', entry.id, entry);
}

async function publicUser(userId) {
  const u = await findUserById(userId);
  return u ? { username: u.username, displayName: u.displayName, aiName: u.aiName } : null;
}

export async function requestConnection(fromUserId, toUsername) {
  const toUser = await findUserByUsername(toUsername);
  if (!toUser) throw new Error('No account with that username.');
  if (toUser.id === fromUserId) throw new Error('You cannot connect with yourself.');

  const connections = await loadForUser(fromUserId);
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
  await saveOne(entry);
  return entry;
}

export async function listConnectionsFor(userId) {
  const connections = await loadForUser(userId);
  return Promise.all(connections.map(async (c) => {
    const otherId = c.fromUserId === userId ? c.toUserId : c.fromUserId;
    return {
      id: c.id,
      status: c.status,
      direction: c.fromUserId === userId ? 'outgoing' : 'incoming',
      other: await publicUser(otherId),
      createdAt: c.createdAt,
    };
  }));
}

export async function respondToConnection(userId, connectionId, accept) {
  const connections = await loadForUser(userId);
  const entry = connections.find((c) => c.id === connectionId);
  if (!entry) throw new Error('No such connection request.');
  if (entry.toUserId !== userId) throw new Error('Only the invited person can respond to this.');
  if (entry.status !== 'pending') throw new Error('This request was already responded to.');

  entry.status = accept ? 'accepted' : 'declined';
  entry.respondedAt = new Date().toISOString();
  await saveOne(entry);
  return entry;
}

// Unfriending, canceling a sent request, or clearing a declined one — all
// the same action from either side, since a removed connection just frees
// both usernames to request each other again later.
export async function removeConnection(userId, connectionId) {
  const connections = await loadForUser(userId);
  const entry = connections.find((c) => c.id === connectionId);
  if (!entry) throw new Error('No such connection.');
  if (entry.fromUserId !== userId && entry.toUserId !== userId) throw new Error('Not your connection.');
  await deleteDoc('connections', connectionId);
}

// A topic only counts as "theirs" if it shows up more than once — a single
// one-off tag isn't a real recurring interest, and treating it like one
// would make the overlap feature leak more than it's meant to.
async function recurringTags(userId) {
  const counts = {};
  for (const m of await allMemories(userId)) {
    for (const tag of m.tags || []) counts[tag] = (counts[tag] || 0) + 1;
  }
  return new Set(Object.entries(counts).filter(([, n]) => n >= 2).map(([tag]) => tag));
}

export async function getOverlap(userId, connectionId) {
  const connections = await loadForUser(userId);
  const entry = connections.find((c) => c.id === connectionId);
  if (!entry) throw new Error('No such connection.');
  if (entry.fromUserId !== userId && entry.toUserId !== userId) throw new Error('Not your connection.');
  if (entry.status !== 'accepted') throw new Error('Both people have to accept before anything is shared.');

  const otherId = entry.fromUserId === userId ? entry.toUserId : entry.fromUserId;
  const mine = await recurringTags(userId);
  const theirs = await recurringTags(otherId);
  const shared = [...mine].filter((tag) => theirs.has(tag));
  return { shared };
}
