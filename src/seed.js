// Generates a large batch of plausible-looking memories so the sphere graph
// can be previewed at realistic scale, without needing real agent runs (free, no API calls).
// Usage: node src/seed.js <userId> — writes into that user's own store, so
// this is safe to run against a demo/throwaway account without ever touching
// anyone's real data.
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const userId = process.argv[2];
if (!userId) {
  console.error('Usage: node src/seed.js <userId>');
  process.exit(1);
}

const userDir = join(__dirname, '..', 'memory', 'users', userId);
mkdirSync(userDir, { recursive: true });
const STORE_PATH = join(userDir, 'memories.json');

const TAGS = [
  'architecture', 'memory', 'planning', 'cost', 'identity', 'project',
  'communication', 'preferences', 'tools', 'reasoning', 'safety', 'ux',
  'performance', 'research', 'agents', 'x-updates', 'debugging', 'ideas',
  'growth', 'users',
];

const TEMPLATES = [
  'Tried {a} for {b} but switched to {c} because it was more reliable.',
  'Ari prefers {a} over {b} when working on {c}.',
  'Learned that {a} breaks down once {b} gets past a certain scale.',
  'The agent should always {a} before attempting {b}.',
  'Users kept getting confused by {a}, fixed by simplifying {b}.',
  'A good rule of thumb: {a} only matters once {b} is solid.',
  'Posted an update on X about {a} — got good engagement on the {b} angle.',
  'Debugged an issue where {a} caused {b} to silently fail.',
  'Decided against {a} for now, revisit once {b} is figured out.',
  'The brain got noticeably smarter after adding {a}.',
  'Cost stayed flat after switching {a} to {b}.',
  'Key lesson: {a} is more valuable than {b} for long-term reliability.',
  '{a} turned out to be the actual bottleneck, not {b}.',
  'Ari wants the agent to ask before doing anything involving {a}.',
  'Refactored {a} to make {b} easier to extend later.',
];

const WORDS = [
  'keyword-based recall', 'embeddings', 'the planning loop', 'tool use',
  'the memory store', 'graph visualization', 'the sphere layout', 'auto-rotate',
  'importance scoring', 'tag overlap', 'the CLI', 'error handling',
  'the system prompt', 'context window limits', 'the recall function',
  'multi-step tasks', 'self-correction', 'the remember tool', 'node coloring',
  'API cost', 'batching requests', 'the force-graph library', 'bloom effects',
  'the HUD', 'task retries', 'timeout handling', 'the agent loop',
  'zoomToFit timing', 'link generation', 'sample data',
];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pickN(arr, n) {
  const copy = [...arr];
  const out = [];
  for (let i = 0; i < n && copy.length; i++) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return out;
}

function weightedImportance() {
  const r = Math.random();
  if (r < 0.55) return 1;
  if (r < 0.8) return 2;
  if (r < 0.93) return 3;
  if (r < 0.98) return 4;
  return 5;
}

const COUNT = 90;
const now = Date.now();
const memories = [];

for (let i = 1; i <= COUNT; i++) {
  const template = pick(TEMPLATES);
  const content = template
    .replace('{a}', pick(WORDS))
    .replace('{b}', pick(WORDS))
    .replace('{c}', pick(WORDS));
  const tags = pickN(TAGS, 1 + Math.floor(Math.random() * 3));
  memories.push({
    id: i,
    timestamp: new Date(now - (COUNT - i) * 6 * 60 * 60 * 1000).toISOString(),
    content,
    tags,
    importance: weightedImportance(),
  });
}

writeFileSync(STORE_PATH, JSON.stringify(memories, null, 2));
console.log(`Seeded ${memories.length} memories.`);
