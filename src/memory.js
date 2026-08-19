import { getAllDocs, setDoc } from './db.js';

function memoriesPath(userId) {
  return `users/${userId}/memories`;
}

async function loadAll(userId) {
  return getAllDocs(memoriesPath(userId));
}

export async function remember(userId, content, tags = [], importance = 1) {
  const memories = await loadAll(userId);
  const entry = {
    id: memories.length ? Math.max(...memories.map((m) => m.id)) + 1 : 1,
    timestamp: new Date().toISOString(),
    content,
    tags,
    importance,
  };
  await setDoc(memoriesPath(userId), String(entry.id), entry);
  return entry;
}

// Keyword-overlap scoring, no embeddings — keeps recall free of API calls.
export async function recall(userId, query, limit = 5) {
  const memories = await loadAll(userId);
  const queryWords = query.toLowerCase().split(/\W+/).filter(Boolean);

  const scored = memories.map((m) => {
    const haystack = (m.content + ' ' + m.tags.join(' ')).toLowerCase();
    const overlap = queryWords.filter((w) => haystack.includes(w)).length;
    return { ...m, score: overlap * m.importance };
  });

  return scored
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score || b.id - a.id)
    .slice(0, limit);
}

export async function recentMemories(userId, limit = 5) {
  const memories = await loadAll(userId);
  return memories.sort((a, b) => a.id - b.id).slice(-limit).reverse();
}

// Core identity facts that should ground every conversation regardless of
// whether the user's wording happens to overlap with them — keyword recall
// alone misses paraphrased or indirect questions constantly.
export async function coreMemories(userId, limit = 8) {
  const memories = await loadAll(userId);
  return memories
    .filter((m) => m.importance >= 4)
    .sort((a, b) => b.importance - a.importance || b.id - a.id)
    .slice(0, limit);
}

export async function allMemories(userId) {
  const memories = await loadAll(userId);
  return memories.sort((a, b) => a.id - b.id);
}

export async function findMemory(userId, id) {
  const memories = await loadAll(userId);
  return memories.find((m) => m.id === id) || null;
}

// Overwrites a memory's content in place (e.g. the user correcting something
// it got wrong) rather than appending a new one, so the graph doesn't end up
// with both the wrong fact and its correction sitting side by side forever.
export async function updateMemory(userId, id, content) {
  const entry = await findMemory(userId, id);
  if (!entry) throw new Error(`No memory #${id} to update.`);
  entry.content = content;
  entry.correctedAt = new Date().toISOString();
  await setDoc(memoriesPath(userId), String(id), entry);
  return entry;
}
