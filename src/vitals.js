// Shared vitals/mood calculation — same formulas the client uses for the
// on-screen readouts, but computed server-side too so the chat AI can
// actually know (and express) its own real state, not just describe facts.

const REST_BPM = 58;
const REDLINE_BPM = 130;

function countLinks(memories) {
  let count = 0;
  for (let i = 0; i < memories.length; i++) {
    for (let j = i + 1; j < memories.length; j++) {
      if (memories[i].tags.some((t) => memories[j].tags.includes(t))) count++;
    }
  }
  return count;
}

export function computeVitals(memories) {
  const now = Date.now();
  const timestamps = memories.map((m) => new Date(m.timestamp).getTime());
  const mostRecent = timestamps.length ? Math.max(...timestamps) : null;

  const last5m = timestamps.filter((t) => now - t < 5 * 60 * 1000).length;
  const last30m = timestamps.filter((t) => now - t < 30 * 60 * 1000).length;
  const bpm = Math.max(REST_BPM, Math.min(REST_BPM + last5m * 26 + last30m * 5, 180));

  const avgLinks = memories.length ? (2 * countLinks(memories)) / memories.length : 0;
  const strain = Math.max(0, bpm - 90) * 0.9;
  const health = Math.max(0, Math.min(100, Math.round(50 + avgLinks * 2.5 - strain)));

  let status;
  if (bpm >= REDLINE_BPM) status = 'OVERWORKED';
  else if (mostRecent === null) status = 'DORMANT';
  else {
    const minutesAgo = (now - mostRecent) / (60 * 1000);
    status = minutesAgo < 10 ? 'ACTIVE' : minutesAgo < 90 ? 'IDLE' : 'DORMANT';
  }

  // Recent critical (importance 5) memories skew the mood toward "on edge" —
  // a run of urgent/high-stakes things weighs on mood the way it would for a person.
  const recentCritical = memories.filter((m) => (now - new Date(m.timestamp).getTime()) < 60 * 60 * 1000 && m.importance >= 5).length;

  let mood;
  if (status === 'OVERWORKED') mood = recentCritical > 0 ? 'overwhelmed and on edge' : 'wired and overworked';
  else if (status === 'DORMANT') mood = 'quiet, a little withdrawn';
  else if (health < 35) mood = 'drained and low energy';
  else if (health < 55) mood = 'a bit worn down but pushing through';
  else if (bpm > 90) mood = 'energized and excited';
  else if (health > 80) mood = 'content and steady';
  else mood = 'calm';

  return { bpm, health, status, mood };
}
