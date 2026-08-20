// One-time migration: marks every account that existed before the Core
// paywall was introduced as 'paid', so nobody who was already using Core
// loses access. New signups from here on default to 'free' + 'pulse' in
// auth.js. Idempotent — skips any account that already has a plan set.
// Run manually once: node src/grandfather-paid-plan.js
import 'dotenv/config';
import { listUsers, setPlan } from './auth.js';

const users = await listUsers();
let migrated = 0;
let skipped = 0;

for (const user of users) {
  if (user.plan) {
    skipped++;
    continue;
  }
  await setPlan(user.id, 'paid');
  console.log(`Grandfathered ${user.username} (${user.id}) to paid.`);
  migrated++;
}

console.log(`\nDone. ${migrated} account(s) grandfathered to paid, ${skipped} already had a plan set.`);
process.exit(0);
