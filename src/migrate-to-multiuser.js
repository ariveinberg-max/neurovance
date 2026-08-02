// One-time, idempotent migration: turns the original single-user
// memory/memories.json into "user #1" under the new per-user layout.
// Run manually once: ARI_MIGRATE_PASSWORD=whatever node src/migrate-to-multiuser.js
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync } from 'fs';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { hashPassword } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEMORY_DIR = join(__dirname, '..', 'memory');
const OLD_STORE = join(MEMORY_DIR, 'memories.json');
const USERS_PATH = join(MEMORY_DIR, 'users.json');
const BACKUP_DIR = join(MEMORY_DIR, 'legacy-backup');

function main() {
  if (existsSync(USERS_PATH)) {
    console.log('Already migrated — memory/users.json exists. Nothing to do.');
    return;
  }

  if (!existsSync(OLD_STORE)) {
    console.log('No memory/memories.json found — nothing to migrate.');
    return;
  }

  const password = process.env.ARI_MIGRATE_PASSWORD;
  if (!password) {
    console.error('Set ARI_MIGRATE_PASSWORD before running this, e.g.:');
    console.error('  ARI_MIGRATE_PASSWORD=yourpassword node src/migrate-to-multiuser.js');
    process.exit(1);
  }

  const memories = JSON.parse(readFileSync(OLD_STORE, 'utf-8'));

  mkdirSync(BACKUP_DIR, { recursive: true });
  copyFileSync(OLD_STORE, join(BACKUP_DIR, 'memories.json.pre-migration.bak'));

  // Built directly rather than via the normal email-verification signup flow
  // — this is a one-time system migration for an account that already
  // exists, not a new signup.
  const user = {
    id: randomUUID(),
    username: 'ari',
    email: null,
    passwordHash: hashPassword(password),
    displayName: 'Ari',
    aiName: 'Ari V2',
    createdAt: new Date().toISOString(),
  };
  writeFileSync(USERS_PATH, JSON.stringify([user], null, 2));

  const userDir = join(MEMORY_DIR, 'users', user.id);
  mkdirSync(userDir, { recursive: true });
  writeFileSync(join(userDir, 'memories.json'), JSON.stringify(memories, null, 2));

  renameSync(OLD_STORE, join(MEMORY_DIR, 'memories.json.migrated'));

  console.log(`Migrated ${memories.length} memories to user "ari" (id ${user.id}).`);
  console.log('Log in with username "ari" and the password you set in ARI_MIGRATE_PASSWORD.');
  console.log('Original file preserved at memory/memories.json.migrated and memory/legacy-backup/.');
}

main();
