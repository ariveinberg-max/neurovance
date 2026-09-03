import { getAllDocs, setDoc, deleteDoc, getDoc, vectorSearch, runTransaction, queryOrdered, queryWhereOrdered, queryArrayContains } from './db.js';
import { getEmbedding } from './embeddings.js';

function memoriesPath(userId) {
  return `users/${userId}/memories`;
}

async function loadAll(userId) {
  return getAllDocs(memoriesPath(userId));
}

// Memory ids used to be allocated by loading the whole store and taking
// max+1 — every single save cost one Firestore read per existing memory, so
// the store got quadratically more expensive to write to as it grew. The
// counter is one document, read and bumped in a transaction. Bootstraps off
// the existing store exactly once per user, then never scans again.
function counterPath(userId) {
  return `users/${userId}/meta`;
}
const COUNTER_DOC = 'memoryCounter';

const counterReady = new Set(); // userIds whose counter doc is known to exist

async function nextMemoryId(userId) {
  let seed = 0;
  const needsBootstrap = !counterReady.has(userId);
  if (needsBootstrap) {
    const existing = await getDoc(counterPath(userId), COUNTER_DOC);
    if (!existing || typeof existing.lastId !== 'number') {
      const all = await loadAll(userId);
      seed = all.length ? Math.max(...all.map((m) => m.id)) : 0;
    }
  }
  const id = await runTransaction(counterPath(userId), COUNTER_DOC, async (data) => {
    const last = typeof data?.lastId === 'number' ? data.lastId : seed;
    const next = last + 1;
    return [{ lastId: next }, next];
  });
  // Only after the counter is durably written — marking it ready on a
  // transaction that then threw would let the next call seed from 0 and
  // reissue ids that already exist, silently overwriting old memories.
  counterReady.add(userId);
  return id;
}

// Id allocation is atomic on its own now (the counter transaction), but the
// per-user queue stays: it also serializes the consolidation pass that
// remember() can trigger, which reads and rewrites the whole store and would
// otherwise race with a concurrent save. extractMemories fires several
// remember() calls at once (Promise.all), so that race is real.
const rememberQueues = new Map(); // userId -> Promise chain tail
function enqueueRemember(userId, task) {
  const prev = rememberQueues.get(userId) || Promise.resolve();
  const next = prev.then(task, task);
  rememberQueues.set(userId, next.catch(() => {}));
  return next;
}

export function remember(userId, content, tags = [], importance = 1) {
  return enqueueRemember(userId, async () => {
    const entry = {
      id: await nextMemoryId(userId),
      timestamp: new Date().toISOString(),
      content,
      tags,
      importance,
    };

    try {
      entry.embedding = await getEmbedding(content, 'document');
    } catch (e) {
      console.error('Failed to generate embedding for memory:', e);
      // We still save the memory even if embedding fails, but it won't be semantic-searchable
    }

    await setDoc(memoriesPath(userId), String(entry.id), entry);

    // Opportunistic normalization — a small tax on the path that already runs,
    // so the store stays deduplicated without anyone having to schedule it.
    if (entry.id % CONSOLIDATE_EVERY === 0 && entry.embedding) {
      try {
        const merged = await consolidateMemories(userId);
        if (merged > 0) entry.mergedDuplicates = merged;
      } catch (e) {
        console.error('Memory consolidation failed:', e);
      }
    }

    return entry;
  });
}

// Semantic recall using Voyage AI embeddings and Firestore Vector Search.
export async function recall(userId, query, limit = 5) {
  try {
    const queryVector = await getEmbedding(query, 'query');
    return await vectorSearch(memoriesPath(userId), queryVector, limit);
  } catch (e) {
    console.error('Semantic recall failed, falling back to keyword search:', e);

    // Fallback to keyword-overlap scoring
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
}

export async function recentMemories(userId, limit = 5) {
  return queryOrdered(memoriesPath(userId), 'id', 'desc', limit);
}

// Vitals are all short-window aggregates (activity in the last 5/30/60
// minutes, plus average link density) and they get recomputed on every chat
// turn and every agent-loop iteration — reading the entire store for that was
// the single most expensive repeated query in the app. The newest slice
// covers every window vitals actually looks at.
//
// Cached on its own timer rather than through db.js: that cache is
// invalidated by every write, and an agent run writes memories constantly, so
// vitals would re-read on nearly every loop iteration. Vitals drive a mood
// string and a pivot heuristic — half a minute of staleness is invisible, and
// the windows they measure are 5 minutes at the finest.
const VITALS_TTL_MS = 30_000;
const vitalsCache = new Map(); // userId -> { data, expiresAt }

export async function vitalsWindow(userId, limit = 200) {
  const hit = vitalsCache.get(userId);
  if (hit && hit.expiresAt > Date.now() && hit.limit >= limit) return hit.data;
  const data = await recentMemories(userId, limit);
  vitalsCache.set(userId, { data, limit, expiresAt: Date.now() + VITALS_TTL_MS });
  return data;
}

// Core identity facts that should ground every conversation regardless of
// whether the user's wording happens to overlap with them — keyword recall
// alone misses paraphrased or indirect questions constantly.
export async function coreMemories(userId, limit = 8) {
  const memories = await queryWhereOrdered(
    memoriesPath(userId), 'importance', '>=', 4, 'importance', 'desc', limit,
  );
  return memories.sort((a, b) => b.importance - a.importance || b.id - a.id);
}

export async function allMemories(userId) {
  const memories = await loadAll(userId);
  return memories.sort((a, b) => a.id - b.id);
}

// Which of the brain's known topics have only thin coverage — a cheap signal
// (no model call, just tag counting on what's already loaded) that lets a
// self-directed run pick a genuinely under-covered area to enrich instead of
// re-treading familiar ground. A tag with few memories is more "open gap" than
// "established interest", so the brain can grow where it knows least.
export async function thinTopics(userId, { max = 5, threshold = 2 } = {}) {
  const memories = await loadAll(userId);
  const counts = {};
  for (const m of memories) {
    for (const tag of m.tags || []) {
      counts[tag] = (counts[tag] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .filter(([, n]) => n <= threshold)
    .sort((a, b) => a[1] - b[1])
    .slice(0, max)
    .map(([tag]) => tag);
}

export async function findMemory(userId, id) {
  return getDoc(memoriesPath(userId), String(id));
}

// Overwrites a memory's content in place (e.g., the user correcting something
// it got wrong) rather than appending a new one, so the graph doesn't end up
// with both the wrong fact and its correction sitting side by side forever.
export async function updateMemory(userId, id, content) {
  const entry = await findMemory(userId, id);
  if (!entry) throw new Error(`No memory #${id} to update.`);
  entry.content = content;
  entry.correctedAt = new Date().toISOString();

  try {
    entry.embedding = await getEmbedding(content, 'document');
  } catch (e) {
    console.error('Failed to regenerate embedding for memory:', e);
  }

  await setDoc(memoriesPath(userId), String(id), entry);
  return entry;
}

export async function getProjectMap(userId) {
  const memories = await queryArrayContains(memoriesPath(userId), 'tags', 'project-map');
  return memories
    .sort((a, b) => b.importance - a.importance || b.id - a.id);
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// "Smarter memory": automatic consolidation so that the same fact, learned
// differently on different days, doesn't sit in the store twice diluting
// recall and clogging the graph. Two memories are considered the same *fact*
// when their embeddings are near-identical (cosine > NORMALIZE_THRESHOLD)
// AND they overlap on at least one topic tag — the tag check is what keeps a
// near-synonym from being wrongly collapsed. The higher-importance one wins
// and absorbs the other's tags; the loser is deleted. Runs opportunistically
// inside remember() every N new memories so it never becomes an extra step or
// a separate job — just a small tax on the path that already runs.
const NORMALIZE_THRESHOLD = 0.96;
const CONSOLIDATE_EVERY = 12; // consider consolidating on every 12th new memory

export async function consolidateMemories(userId) {
  const memories = await loadAll(userId);
  if (memories.length < 2) return 0;

  const whitelist = memories.filter((m) => Array.isArray(m.embedding) && m.embedding.length > 0);
  let consolidated = 0;

  // Compare only against a running list of "keepers" so each fact is at most
  // one survivor — never chains A~B then B~C into folding three distinct
  // things together.
  const keepers = [];
  for (const m of whitelist) {
    let absorbed = false;
    for (const k of keepers) {
      if (cosineSimilarity(m.embedding, k.embedding) > NORMALIZE_THRESHOLD) {
        const a = m.tags || [];
        const b = k.tags || [];
        if (a.some((t) => b.includes(t))) {
          k.tags = [...new Set([...k.tags, ...a])];
          k.importance = Math.max(k.importance, m.importance);
          await setDoc(memoriesPath(userId), String(k.id), k);
          await deleteDoc(memoriesPath(userId), String(m.id));
          consolidated++;
          absorbed = true;
          break;
        }
      }
    }
    if (!absorbed) keepers.push({ ...m });
  }

  return consolidated;
}
