import 'dotenv/config';
import { incrementTokenUsage, checkTokenUsage } from '../src/auth.js';
import { setDoc, db } from '../src/db.js';

async function runTest() {
  const userId = 'test-user-race-' + Date.now();
  console.log('Creating test user...');
  await setDoc('users', userId, {
    username: 'raceuser',
    email: 'race@test.com',
    tokenUsage: { date: new Date().toISOString().slice(0, 10), used: 0 }
  });

  console.log('Running concurrent increments (10 x 100 tokens)...');
  await Promise.all(
    Array.from({ length: 10 }).map(() => incrementTokenUsage(userId, 100))
  );

  const snap = await db.collection('users').doc(userId).get();
  const user = snap.exists ? snap.data() : null;
  const used = user.tokenUsage?.used ?? 0;

  console.log('Final used:', used);

  if (used !== 1000) {
    console.error(`Race condition detected! Expected 1000, got ${used}`);
    process.exit(1);
  } else {
    console.log('All increments accounted for — no lost updates.');
  }

  const check = await checkTokenUsage(userId);
  console.log('checkTokenUsage allowed:', check.allowed, 'used:', check.used, 'budget:', check.budget);

  if (check.allowed !== true || check.used !== 1000) {
    console.error('checkTokenUsage returned unexpected values.');
    process.exit(1);
  }

  console.log('Test passed.');
}

runTest().catch(console.error);
