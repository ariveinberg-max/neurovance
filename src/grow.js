import 'dotenv/config';
import { runTask, runDreamCycle, runCuriosityCycle } from './agent.js';
import { allMemories } from './memory.js';
import { listUsers } from './auth.js';

// Runs once a day (via cron) so every user's brain grows without them doing
// anything. One pass per registered user, each scoped to that user's own
// memory store — no cross-user bleed.
function buildPrompt(memories) {
  if (memories.length < 3) {
    return 'This is a fresh memory store. Note one open question or goal worth tracking as this brain grows.';
  }
  const topics = [...new Set(memories.flatMap((m) => m.tags))].slice(0, 12).join(', ');
  return [
    `Based on this person's actual interests and memories so far (topics seen so far: ${topics || 'none yet'}),`,
    'pick ONE well-known entity or topic name genuinely relevant to them — something they\'d actually want to know is happening.',
    'Use search_web with that short entity name (not a full question — it only matches exact topic names) to look it up,',
    'then save one genuinely interesting or useful thing you found as a memory tagged so it\'s easy to bring up again.',
    'If search_web comes back empty, just pick a different entity name and try again once before giving up.',
  ].join(' ');
}

for (const user of await listUsers()) {
  const memories = await allMemories(user.id);
  const prompt = buildPrompt(memories);
  try {
    const result = await runTask(user.id, user, prompt);
    console.log(`[${new Date().toISOString()}] [${user.username}] ${result}`);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] [${user.username}] grow failed:`, e.message);
  }

  try {
    const insight = await runDreamCycle(user.id);
    if (insight) console.log(`[${new Date().toISOString()}] [${user.username}] dreamed: ${insight.content}`);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] [${user.username}] dream cycle failed:`, e.message);
  }

  try {
    const question = await runCuriosityCycle(user.id);
    if (question) console.log(`[${new Date().toISOString()}] [${user.username}] curious about: ${question}`);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] [${user.username}] curiosity cycle failed:`, e.message);
  }
}
