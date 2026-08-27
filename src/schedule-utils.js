// Presets are just a starting point the UI pre-fills into the editable
// custom-task form — there's no backend templating, the user just tweaks
// the prompt (e.g. filling in a real topic) before saving.
export const SCHEDULE_PRESETS = [
  {
    id: 'daily-briefing',
    name: 'Daily briefing',
    icon: '☀️',
    prompt: "Give me a short daily briefing — check my calendar and inbox (if connected) for anything today needs attention on, and summarize it plainly.",
    schedule: { frequency: 'weekdays', time: '08:00' },
  },
  {
    id: 'inbox-triage',
    name: 'Inbox triage',
    icon: '📥',
    prompt: "Check my inbox, categorize what's in it, and draft replies to anything urgent — do not send anything, just prepare drafts and tell me what needs a reply.",
    schedule: { frequency: 'weekdays', time: '08:00' },
  },
  {
    id: 'weekly-review',
    name: 'Weekly review',
    icon: '📋',
    prompt: 'Give me a short review of this week — what happened, based on what you know from memory and anything on my calendar or inbox.',
    schedule: { frequency: 'weekly', time: '16:00', weekday: 5 },
  },
  {
    id: 'monitor-topic',
    name: 'Monitor a topic',
    icon: '🔍',
    prompt: 'Search the web for the latest news on: [replace this with your topic]. Summarize anything new or notable.',
    schedule: { frequency: 'daily', time: '09:00' },
  },
];

export const FREQUENCIES = ['daily', 'weekdays', 'weekly'];

export function assertValidSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') throw new Error('A schedule is required.');
  if (!FREQUENCIES.includes(schedule.frequency)) throw new Error('Frequency must be daily, weekdays, or weekly.');
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(schedule.time || '')) throw new Error('Time must be in HH:MM (24-hour) format.');
  if (schedule.frequency === 'weekly') {
    if (!Number.isInteger(schedule.weekday) || schedule.weekday < 0 || schedule.weekday > 6) {
      throw new Error('A weekly task needs a day of the week (0=Sunday..6=Saturday).');
    }
  }
  if (schedule.tzOffsetMinutes !== undefined && typeof schedule.tzOffsetMinutes !== 'number') {
    throw new Error('tzOffsetMinutes must be a number.');
  }
}

// tzOffsetMinutes matches JS's Date.getTimezoneOffset(): minutes to ADD to
// local time to get UTC (e.g. +300 for UTC-5). Fixed at task-creation time —
// no DST auto-adjustment, which is an accepted MVP tradeoff, not an oversight.
export function computeNextRun(schedule, from = new Date()) {
  const { frequency, time, weekday, tzOffsetMinutes = 0 } = schedule;
  const [h, m] = time.split(':').map(Number);
  const localMinutes = h * 60 + m;
  const utcMinutes = (((localMinutes + tzOffsetMinutes) % 1440) + 1440) % 1440;
  const targetH = Math.floor(utcMinutes / 60);
  const targetM = utcMinutes % 60;

  const candidate = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), targetH, targetM, 0, 0));

  function validDay(d) {
    const day = d.getUTCDay();
    if (frequency === 'weekdays') return day >= 1 && day <= 5;
    if (frequency === 'weekly') return day === weekday;
    return true;
  }

  while (candidate <= from || !validDay(candidate)) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate;
}
