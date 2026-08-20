import 'dotenv/config';
import { runTask, runDreamCycle, runCuriosityCycle } from './agent.js';
import { allMemories } from './memory.js';
import { listUsers } from './auth.js';
import { sendBroadcast } from './mailer.js';

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

// Reuses the same broadcast template as waitlist emails — this is the
// "reach out first" piece that was previously only a pendingNote sitting
// unseen until the user happened to open the Talk drawer. Only sends when
// there's actually something to say; a "nothing new today" email would
// just be spam.
async function sendDigest(user, items) {
  const bodyText = items.map((i) => `${i.label}: ${i.text}`).join('\n\n');
  const bodyHtml = items.map((i) => `
    <div style="margin-bottom:22px;">
      <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#6b6c74;margin-bottom:6px;">${i.label}</div>
      <div>${i.text}</div>
    </div>
  `).join('');
  await sendBroadcast(user.email, `${user.aiName} — today's update`, bodyHtml, bodyText);
}

for (const user of await listUsers()) {
  const memories = await allMemories(user.id);
  const prompt = buildPrompt(memories);
  const digestItems = [];

  try {
    const result = await runTask(user.id, user, prompt);
    console.log(`[${new Date().toISOString()}] [${user.username}] ${result}`);
  } catch (e) {
    console.error(`[${new Date().toISOString()}] [${user.username}] grow failed:`, e.message);
  }

  try {
    const insight = await runDreamCycle(user.id);
    if (insight) {
      console.log(`[${new Date().toISOString()}] [${user.username}] dreamed: ${insight.content}`);
      digestItems.push({ label: 'Made a connection', text: insight.content });
    }
  } catch (e) {
    console.error(`[${new Date().toISOString()}] [${user.username}] dream cycle failed:`, e.message);
  }

  try {
    const question = await runCuriosityCycle(user.id);
    if (question) {
      console.log(`[${new Date().toISOString()}] [${user.username}] curious about: ${question}`);
      digestItems.push({ label: 'Got curious about', text: question });
    }
  } catch (e) {
    console.error(`[${new Date().toISOString()}] [${user.username}] curiosity cycle failed:`, e.message);
  }

  if (digestItems.length > 0 && user.email) {
    try {
      await sendDigest(user, digestItems);
      console.log(`[${new Date().toISOString()}] [${user.username}] digest sent`);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] [${user.username}] digest email failed:`, e.message);
    }
  }
}
