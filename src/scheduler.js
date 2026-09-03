import * as auth from './auth.js';
import { runTask } from './agent.js';
import { remember } from './memory.js';
import { runDailyGrow } from './grow.js';
import { SCHEDULE_PRESETS } from './schedule-utils.js';

export { SCHEDULE_PRESETS };

// 15 minutes. Every tick does a full Firestore users-collection read whether
// or not anything is due, so the interval is a straight multiplier on idle
// read spend (288 sweeps/day at 5 minutes, 96 at 15). Nothing on offer is
// finer-grained than "daily at 08:00", so a worst-case 15-minute lag on a
// scheduled task costs nothing real.
const TICK_INTERVAL_MS = 15 * 60 * 1000;
let ticking = false; // guards against overlapping ticks if one run takes >60s

// The autonomous daily grow loop is now wired into the same scheduler, so the
// brain keeps working even with no external cron. It's not the first tick of
// the day by clock — it's "once per process per day," tracked in memory, so a
// restart doesn't double-fire and re-running the process later doesn't skip.
// Each user's token budget (checked inside runDailyGrow) is the real limiter
// on cost, not this trigger.
let lastGrowRunDate = null;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (lastGrowRunDate !== today) {
      lastGrowRunDate = today;
      console.log(`[${now.toISOString()}] Daily brain grow running in-process…`);
      try {
        await runDailyGrow();
      } catch (e) {
        console.error('In-process daily grow failed:', e);
      }
    }

    const users = await auth.listAllUsers();
    await Promise.all(users.map(async (user) => {
      const due = (user.scheduledTasks || []).filter((t) => t.active && new Date(t.nextRunAt) <= now);
      for (const task of due) {
        await executeTask(user, task);
      }
    }));
  } catch (e) {
    console.error('Scheduler tick failed:', e);
  } finally {
    ticking = false;
  }
}

export function startScheduler() {
  setInterval(tick, TICK_INTERVAL_MS);
}

async function executeTask(user, task) {
  let lastResult, lastError;
  try {
    const usage = await auth.checkTokenUsage(user.id);
    if (!usage.allowed) {
      lastError = 'Skipped — token budget reached.';
    } else {
      const { result, usage: tokensUsed } = await runTask(user.id, user, task.prompt, [], { unattended: true });
      lastResult = result;
      await auth.incrementTokenUsage(user.id, tokensUsed.input_tokens + tokensUsed.output_tokens);
      await remember(user.id, `[Scheduled: ${task.name}] ${result}`, ['scheduled-task'], 2);
    }
  } catch (e) {
    console.error(`Scheduled task ${task.id} (user ${user.id}) failed:`, e);
    lastError = e.message;
  }
  await auth.recordScheduledTaskRun(user.id, task.id, { lastResult, lastError });
}

// Manual "Run now" — same execution path as a real tick, just triggered
// directly instead of waiting for nextRunAt. Capped per-user to one manual
// run every 60 seconds: an authenticated user could otherwise script
// thousands of concurrent model runs here (each one billing an Anthropic
// call) — unlike /api/chat's one-at-a-time, run-now fires independently of
// the caller's own turn. In-memory is fine; a restart just resets the
// cooldown, same tradeoff as the pairing-code map.
const runNowCooldowns = new Map(); // userId -> timestamp of last allowed run
const RUN_NOW_COOLDOWN_MS = 60 * 1000;

export async function runScheduledTaskNow(userId, taskId) {
  const now = Date.now();
  const last = runNowCooldowns.get(userId);
  if (last && now - last < RUN_NOW_COOLDOWN_MS) {
    const waitSec = Math.ceil((RUN_NOW_COOLDOWN_MS - (now - last)) / 1000);
    throw new Error(`Please wait ${waitSec}s before running a task manually again.`);
  }
  runNowCooldowns.set(userId, now);

  const user = await auth.findUserById(userId);
  if (!user) throw new Error('No such user.');
  const task = (user.scheduledTasks || []).find((t) => t.id === taskId);
  if (!task) throw new Error('No such scheduled task.');
  await executeTask(user, task);
  return auth.listScheduledTasks(userId);
}
