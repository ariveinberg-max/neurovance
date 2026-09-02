import { getAllDocs, setDoc, deleteDoc } from './db.js';

// A small inbox of things a Superself wants to bring up on its own —
// something it noticed while consolidating memories, a question it wants to
// ask, a file it saw appear in the Companion folder. Not a notification
// system (nothing pushes to the user outside the app) — just a queue the
// chat flow and the UI both check, so "proactive" still only ever surfaces
// inside a session the user actually opened.

function notesPath(userId) {
  return `users/${userId}/pendingNotes`;
}

async function loadAll(userId) {
  const notes = await getAllDocs(notesPath(userId));
  return notes.sort((a, b) => a.id - b.id);
}

// Same read→max+1→write id allocation as memory.js: concurrent addNote calls
// (e.g. a Companion file event landing alongside a dream insight) could both
// compute the same id and one would silently overwrite the other. Serialize
// per user.
const noteQueues = new Map();
function enqueueNote(userId, task) {
  const prev = noteQueues.get(userId) || Promise.resolve();
  const next = prev.then(task, task);
  noteQueues.set(userId, next.catch(() => {}));
  return next;
}

export function addNote(userId, kind, text) {
  return enqueueNote(userId, async () => {
    const notes = await loadAll(userId);
    const entry = {
      id: notes.length ? notes[notes.length - 1].id + 1 : 1,
      kind, // 'insight' | 'curiosity' | 'companion'
      text,
      createdAt: new Date().toISOString(),
      seen: false,
    };
    await setDoc(notesPath(userId), String(entry.id), entry);

    // Keep this small and current — an unbounded backlog of stale "I noticed
    // X" notes from weeks ago is noise, not presence.
    const all = [...notes, entry];
    if (all.length > 20) {
      const excess = all.slice(0, all.length - 20);
      await Promise.all(excess.map((n) => deleteDoc(notesPath(userId), String(n.id))));
    }

    return entry;
  });
}

export async function unseenNotes(userId) {
  const notes = await loadAll(userId);
  return notes.filter((n) => !n.seen);
}

export async function markSeen(userId, id) {
  const notes = await loadAll(userId);
  const entry = notes.find((n) => n.id === id);
  if (entry) {
    entry.seen = true;
    await setDoc(notesPath(userId), String(id), entry);
  }
}

export async function markAllSeen(userId) {
  const notes = await loadAll(userId);
  await Promise.all(notes.map((n) => setDoc(notesPath(userId), String(n.id), { ...n, seen: true })));
}
