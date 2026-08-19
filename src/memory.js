import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const USERS_DIR = join(__dirname, '..', 'memory', 'users');

function storePathFor(userId) {
  return join(USERS_DIR, userId, 'memories.json');
}

function ensureUserStore(userId) {
  const dir = join(USERS_DIR, userId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = storePathFor(userId);
  if (!existsSync(path)) writeFileSync(path, '[]');
}

function load(userId) {
  ensureUserStore(userId);
  return JSON.parse(readFileSync(storePathFor(userId), 'utf-8'));
}

function save(userId, memories) {
  ensureUserStore(userId);
  writeFileSync(storePathFor(userId), JSON.stringify(memories, null, 2));
}

export function remember(userId, content, tags = [], importance = 1) {
  const memories = load(userId);
  const entry = {
    id: memories.length ? memories[memories.length - 1].id + 1 : 1,
    timestamp: new Date().toISOString(),
    content,
    tags,
    importance,
  };
  memories.push(entry);
  save(userId, memories);
  return entry;
}

// Keyword-overlap scoring, no embeddings — keeps recall free of API calls.
export function recall(userId, query, limit = 5) {
  const memories = load(userId);
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

export function recentMemories(userId, limit = 5) {
  const memories = load(userId);
  return memories.slice(-limit).reverse();
}

// Core identity facts that should ground every conversation regardless of
// whether the user's wording happens to overlap with them — keyword recall
// alone misses paraphrased or indirect questions constantly.
export function coreMemories(userId, limit = 8) {
  const memories = load(userId);
  return memories
    .filter((m) => m.importance >= 4)
    .sort((a, b) => b.importance - a.importance || b.id - a.id)
    .slice(0, limit);
}

export function allMemories(userId) {
  return load(userId);
}

export function findMemory(userId, id) {
  return load(userId).find((m) => m.id === id) || null;
}

// Overwrites a memory's content in place (e.g. the user correcting something
// it got wrong) rather than appending a new one, so the graph doesn't end up
// with both the wrong fact and its correction sitting side by side forever.
export function updateMemory(userId, id, content) {
  const memories = load(userId);
  const entry = memories.find((m) => m.id === id);
  if (!entry) throw new Error(`No memory #${id} to update.`);
  entry.content = content;
  entry.correctedAt = new Date().toISOString();
  save(userId, memories);
  return entry;
}
