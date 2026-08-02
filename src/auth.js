import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEMORY_DIR = join(__dirname, '..', 'memory');
const USERS_PATH = join(MEMORY_DIR, 'users.json');
const SESSIONS_PATH = join(MEMORY_DIR, 'sessions.json');
const PENDING_SIGNUPS_PATH = join(MEMORY_DIR, 'pending-signups.json');

function ensureMemoryDir() {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
}

function loadUsers() {
  if (!existsSync(USERS_PATH)) return [];
  return JSON.parse(readFileSync(USERS_PATH, 'utf-8'));
}

function saveUsers(users) {
  ensureMemoryDir();
  writeFileSync(USERS_PATH, JSON.stringify(users, null, 2));
}

function loadSessions() {
  if (!existsSync(SESSIONS_PATH)) return {};
  return JSON.parse(readFileSync(SESSIONS_PATH, 'utf-8'));
}

function saveSessions(sessions) {
  ensureMemoryDir();
  writeFileSync(SESSIONS_PATH, JSON.stringify(sessions, null, 2));
}

function loadPendingSignups() {
  if (!existsSync(PENDING_SIGNUPS_PATH)) return {};
  return JSON.parse(readFileSync(PENDING_SIGNUPS_PATH, 'utf-8'));
}

function savePendingSignups(pending) {
  ensureMemoryDir();
  writeFileSync(PENDING_SIGNUPS_PATH, JSON.stringify(pending, null, 2));
}

// No new dependency for this — Node's built-in scrypt is exactly what
// Node's own docs recommend for hand-rolled password hashing.
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password, storedHash) {
  const [scheme, salt, hash] = storedHash.split('$');
  if (scheme !== 'scrypt') return false;
  const candidate = scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

export function findUserByUsername(username) {
  const normalized = username.trim().toLowerCase();
  return loadUsers().find((u) => u.username === normalized) || null;
}

export function findUserByEmail(email) {
  const normalized = email.trim().toLowerCase();
  return loadUsers().find((u) => u.email === normalized) || null;
}

export function findUserById(userId) {
  return loadUsers().find((u) => u.id === userId) || null;
}

export function listUsers() {
  return loadUsers();
}

// ---------- Email + password signup, verified by a code sent to that email,
// username picked only after verification succeeds ----------

const CODE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const VERIFIED_TOKEN_EXPIRY_MS = 15 * 60 * 1000; // window to finish picking a username after verifying

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
}

export function startSignup({ email, password }) {
  const normalizedEmail = email.trim().toLowerCase();
  if (findUserByEmail(normalizedEmail)) {
    throw new Error('An account with that email already exists.');
  }
  const pending = loadPendingSignups();
  const code = generateCode();
  pending[normalizedEmail] = {
    email: normalizedEmail,
    passwordHash: hashPassword(password),
    code,
    verified: false,
    verifiedToken: null,
    createdAt: Date.now(),
    expiresAt: Date.now() + CODE_EXPIRY_MS,
  };
  savePendingSignups(pending);
  return code; // caller emails this — never logged or returned to the client directly
}

export function verifySignupCode({ email, code }) {
  const normalizedEmail = email.trim().toLowerCase();
  const pending = loadPendingSignups();
  const record = pending[normalizedEmail];
  if (!record) throw new Error('No signup in progress for that email — start over.');
  if (Date.now() > record.expiresAt) throw new Error('That code expired — request a new one.');
  if (record.code !== String(code).trim()) throw new Error('Wrong code.');

  record.verified = true;
  record.verifiedToken = randomBytes(24).toString('hex');
  record.verifiedTokenExpiresAt = Date.now() + VERIFIED_TOKEN_EXPIRY_MS;
  savePendingSignups(pending);
  return record.verifiedToken;
}

export function finishSignup({ email, verifiedToken, username, displayName, aiName }) {
  const normalizedEmail = email.trim().toLowerCase();
  const pending = loadPendingSignups();
  const record = pending[normalizedEmail];
  if (!record || !record.verified || record.verifiedToken !== verifiedToken) {
    throw new Error('Email verification expired or invalid — start over.');
  }
  if (Date.now() > record.verifiedTokenExpiresAt) {
    throw new Error('That verification expired — start over.');
  }

  const normalizedUsername = username.trim().toLowerCase();
  if (findUserByUsername(normalizedUsername)) {
    throw new Error('That username is already taken.');
  }

  const users = loadUsers();
  const user = {
    id: randomUUID(),
    username: normalizedUsername,
    email: normalizedEmail,
    passwordHash: record.passwordHash,
    displayName: displayName.trim(),
    aiName: aiName.trim(),
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  saveUsers(users);

  delete pending[normalizedEmail];
  savePendingSignups(pending);

  return user;
}

// ---------- Real (not fake) face matching, used as a mandatory second
// factor after password login — same honest caveat as before: no
// liveness/depth check, so it's a fun real feature, not bank-vault security.
const FACE_MATCH_THRESHOLD = 0.5;

function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

export function setFaceDescriptor(userId, descriptor) {
  const users = loadUsers();
  const user = users.find((u) => u.id === userId);
  if (!user) throw new Error('User not found.');
  user.faceDescriptor = descriptor;
  saveUsers(users);
  return user;
}

// Checks a descriptor against ONE specific already-identified user (this is
// a 2FA check, not an open "whose face is this" lookup across everyone).
export function verifyFaceForUser(userId, descriptor) {
  const user = findUserById(userId);
  if (!user || !Array.isArray(user.faceDescriptor)) return false;
  return euclideanDistance(user.faceDescriptor, descriptor) <= FACE_MATCH_THRESHOLD;
}

// Sessions now have a `verified` flag: password login gets you a session,
// but it stays unverified (limited access) until the face-scan second
// factor succeeds — same shape real 2FA takes, just face instead of a code.
export function createSession(userId, verified = false) {
  const token = randomBytes(32).toString('hex');
  const sessions = loadSessions();
  sessions[token] = { userId, verified, createdAt: new Date().toISOString() };
  saveSessions(sessions);
  return token;
}

export function getSession(token) {
  if (!token) return null;
  const sessions = loadSessions();
  return sessions[token] || null;
}

export function markSessionVerified(token) {
  const sessions = loadSessions();
  if (sessions[token]) {
    sessions[token].verified = true;
    saveSessions(sessions);
  }
}

export function destroySession(token) {
  if (!token) return;
  const sessions = loadSessions();
  delete sessions[token];
  saveSessions(sessions);
}
