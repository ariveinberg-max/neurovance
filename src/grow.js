import 'dotenv/config';
import { pathToFileURL } from 'url';
import { runTask, runDreamCycle, runCuriosityCycle } from './agent.js';
import { allMemories, consolidateMemories, thinTopics } from './memory.js';
import * as pendingNotes from './pending-notes.js';
import { listUsers, checkTokenUsage, incrementTokenUsage } from './auth.js';
import { sendBroadcast } from './mailer.js';

// Routine "grow one thing" prompt — the baseline daily task that kept working
// before autonomy was broadened. Kept for fresh stores and low-budget users.
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

// Self-directed: with a real (non-trivial) memory store, the brain decides for
// itself what the single most valuable piece of work today is — from what it
// knows and what it has on its mind — instead of always doing the same
// canned "search one topic" task. The result of that work is what lands in
// the digest, so growth is driven by judgement, not a template.
function buildSelfDirectedPrompt(memories, pending, thin = []) {
  const topics = [...new Set(memories.flatMap((m) => m.tags))].slice(0, 16).join(', ');
  const recent = memories.slice(-12).map((m) => `- [${m.timestamp.slice(0, 10)}] ${m.content}`).join('\n');
  const minds = pending.length ? pending.map((n) => `- ${n.text}`).join('\n') : '(nothing queued)';
  return [
    'You are working alone, unattended, for the person these memories belong to.',
    'Decide for yourself the SINGLE most valuable thing you can do right now for them, given what you know.',
    `Topics you know matter to them: ${topics || 'none yet'}.`,
    thin.length ? `Topics you know very little about yet (thin coverage — real gaps worth enriching, not re-treading): ${thin.join(', ')}.` : '',
    `Worth doing today — pick ONE of these, whichever would help them most:\n` +
      '1. Research one topic they care about and save the most useful new thing you find (use search_web to find it, then fetch_webpage to actually READ the best source rather than just its one-line summary).\n' +
      '2. Prepare (draft only) something useful they could use — a plan, a message, a to-do, a piece of writing.\n' +
      '3. Notice a pattern or connection across their memories and articulate a genuinely useful insight (something they could actually act on).\n' +
      '4. Flag a risk or gap worth their attention — a goal that has gone quiet, a plan that may be stale, a contradiction or overlooked problem you can see from what you know (name it, don\'t fix it).\n' +
      '5. Connect something you already know to a specific external resource that would help them (search_web for it by name, verify it with fetch_webpage, and save it as a usable next step).\n' +
      '6. Improve the store itself — sharpen one vague memory or pending note into a clearer, better-tagged version of itself.\n' +
      '7. Ask yourself one sharp follow-up question about their goals and save it for them.\n' +
      'Prefer real action (research, a prepared draft, or surfacing a real risk) over just another question, unless the honest best move is a question.',
    `What you already know (most recent):\n${recent || '(nothing yet)'}`,
    `Things on your mind to resolve or grow:\n${minds}`,
    'Actually DO the one thing you choose using your tools (search_web, remember, and the read-only Companion tools you have). This is an unattended run: do NOT send any message/email, complete any purchase, or delete/cancel anything — prepare drafts and save what you learn instead.',
    'End by reporting in ONE short paragraph what you did and why it was the most valuable thing.',
  ].join('\n');
}

// Digest items are LLM-generated text embedded into an HTML email. Escape it
// so stray markup the model produces (or a prompt-injected page) can't inject
// content into the mail the user opens — the waitlist mail escapes values for
// the same reason, and the digest should be no looser.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
      <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#6b6c74;margin-bottom:6px;">${escapeHtml(i.label)}</div>
      <div>${escapeHtml(i.text)}</div>
    </div>
  `).join('');
  await sendBroadcast(user.email, `${user.aiName} — today's update`, bodyHtml, bodyText);
}

// The whole daily pass, exported so it can run either standalone (node
// src/grow.js, as the old external cron did) or be invoked in-process by the
// server's own scheduler when it comes due — so the brain keeps working even
// with no external cron configured. It is idempotent per call and gated by
// each user's token budget, so running it from more than one place never
// doubles spend: the budget check is the real limiter, not the trigger.
export async function runDailyGrow() {
  for (const user of await listUsers()) {
    const memories = await allMemories(user.id);
    const pending = await pendingNotes.unseenNotes(user.id);
    const digestItems = [];

    const usage = await checkTokenUsage(user.id);
    if (!usage.allowed) {
      console.log(`[${new Date().toISOString()}] [${user.username}] skipped — token budget reached.`);
      continue;
    }

    // Normalize the store first (free-ish hygiene; cheap, no model call) so
    // the identity it reasons from isn't full of near-duplicates.
    try {
      const merged = await consolidateMemories(user.id);
      if (merged > 0) console.log(`[${new Date().toISOString()}] [${user.username}] consolidated ${merged} duplicate memories`);
    } catch (e) {
      console.error(`[${new Date().toISOString()}] [${user.username}] consolidation failed:`, e.message);
    }

    try {
      // Real autonomy: decide the task, run it deep, unattended. If the store
      // is basically empty there's nothing to self-direct on, so fall back to
      // the lightweight routine prompt to seed the store.
      const thin = memories.length >= 4 ? await thinTopics(user.id) : [];
      const prompt = memories.length >= 4
        ? buildSelfDirectedPrompt(memories, pending, thin)
        : buildPrompt(memories);
      const { result, usage: tokensUsed } = await runTask(user.id, user, prompt, [], { unattended: true, mode: 'deep' });
      if (tokensUsed) await incrementTokenUsage(user.id, tokensUsed.input_tokens + tokensUsed.output_tokens);
      console.log(`[${new Date().toISOString()}] [${user.username}] grew: ${result.slice(0, 240)}`);
      if (result) digestItems.push({ label: 'Worked on', text: result.slice(0, 400) });
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
}

// Standard entry when run as a script — calls the exported pass so the CLI
// and the in-process scheduler always behave identically.
async function main() {
  await runDailyGrow();
}

// Only auto-run when grow.js is invoked directly (node src/grow.js, as the
// old external cron did), never when it's imported — otherwise importing the
// scheduler (which pulls runDailyGrow in for the in-process daily run) would
// accidentally kick off the whole pass on every server boot.
async function isDirectEntry() {
  try {
    const expected = pathToFileURL(process.argv[1]).href;
    return import.meta.url === expected;
  } catch {
    return false;
  }
}

if (await isDirectEntry()) {
  main().catch(console.error);
}
