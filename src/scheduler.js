import * as auth from './auth.js';
import { runTask } from './agent.js';
import { remember } from './memory.js';
import { SCHEDULE_PRESETS } from './schedule-utils.js';

export { SCHEDULE_PRESETS };

// 5 minutes, not 60s — no scheduled task needs minute-level precision, and
// every tick does a full Firestore users-collection read regardless of
// whether anything is due. No sense polling 5x more often than the
// coarsest schedule (daily/weekly) could ever need.
const TICK_INTERVAL_MS = 5 * 60 * 1000;
let ticking = false; // guards against overlapping ticks if one run takes >60s

async function executeTask(user, task) {
  let lastResult, lastError;
  try {
    const usage = await auth.checkAndIncrementUsage(user.id);
    if (!usage.allowed) {
      lastError = 'Skipped — daily message limit reached.';
    } else {
      const output = await runTask(user.id, user, task.prompt, [], { unattended: true });
      lastResult = output;
      await remember(user.id, `[Scheduled: ${task.name}] ${output}`, ['scheduled-task'], 2);
    }
  } catch (e) {
    console.error(`Scheduled task ${task.id} (user ${user.id}) failed:`, e);
    lastError = e.message;
  }
  await auth.recordScheduledTaskRun(user.id, task.id, { lastResult, lastError });
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = new Date();
    const users = await auth.listAllUsers();
    for (const user of users) {
      const due = (user.scheduledTasks || []).filter((t) => t.active && new Date(t.nextRunAt) <= now);
      for (const task of due) {
        await executeTask(user, task);
      }
    }
  } catch (e) {
    console.error('Scheduler tick failed:', e);
  } finally {
    ticking = false;
  }
}

export function startScheduler() {
  setInterval(tick, TICK_INTERVAL_MS);
}

// Manual "Run now" — same execution path as a real tick, just triggered
// directly instead of waiting for nextRunAt.
export async function runScheduledTaskNow(userId, taskId) {
  const user = await auth.findUserById(userId);
  if (!user) throw new Error('No such user.');
  const task = (user.scheduledTasks || []).find((t) => t.id === taskId);
  if (!task) throw new Error('No such scheduled task.');
  await executeTask(user, task);
  return auth.listScheduledTasks(userId);
}
