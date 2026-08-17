import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEMORY_DIR = join(__dirname, '..', 'memory');
const USERS_PATH = join(MEMORY_DIR, 'users.json');
const SESSIONS_PATH = join(MEMORY_DIR, 'sessions.json');
const PENDING_SIGNUPS_PATH = join(MEMORY_DIR, 'pending-signups.json');
const PENDING_OAUTH_PATH = join(MEMORY_DIR, 'pending-oauth.json');

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

function loadPendingOAuth() {
  if (!existsSync(PENDING_OAUTH_PATH)) return {};
  return JSON.parse(readFileSync(PENDING_OAUTH_PATH, 'utf-8'));
}

function savePendingOAuth(pending) {
  ensureMemoryDir();
  writeFileSync(PENDING_OAUTH_PATH, JSON.stringify(pending, null, 2));
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

export function findUserByOAuth(provider, providerId) {
  return loadUsers().find((u) => u.oauthProvider === provider && u.oauthId === providerId) || null;
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

const PASSWORD_ERROR = 'Password must be at least 8 characters and include an uppercase and a lowercase letter.';

function isStrongPassword(password) {
  return (
    typeof password === 'string' &&
    password.length >= 8 &&
    /[A-Z]/.test(password) &&
    /[a-z]/.test(password)
  );
}

export function startSignup({ email, password }) {
  const normalizedEmail = email.trim().toLowerCase();
  if (findUserByEmail(normalizedEmail)) {
    throw new Error('An account with that email already exists.');
  }
  if (!isStrongPassword(password)) {
    throw new Error(PASSWORD_ERROR);
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

// ---------- OAuth (Google / GitHub): if the provider's email already
// matches an existing account, link this provider to it and sign straight
// in — no separate "pick a username" step for a returning identity. A
// genuinely new email still goes through choosing a username/AI name, same
// as email+password signup, just skipping straight past the password step
// since the provider already proved who they are.
const OAUTH_PENDING_EXPIRY_MS = 15 * 60 * 1000;

export function startOAuthSignup({ provider, providerId, email }) {
  const existingByOAuth = findUserByOAuth(provider, providerId);
  if (existingByOAuth) return { linked: true, user: existingByOAuth };

  const normalizedEmail = email?.trim().toLowerCase();
  const existingByEmail = normalizedEmail ? findUserByEmail(normalizedEmail) : null;
  if (existingByEmail) {
    const users = loadUsers();
    const user = users.find((u) => u.id === existingByEmail.id);
    user.oauthProvider = provider;
    user.oauthId = providerId;
    saveUsers(users);
    return { linked: true, user };
  }

  const pendingToken = randomBytes(24).toString('hex');
  const pending = loadPendingOAuth();
  pending[pendingToken] = {
    provider,
    providerId,
    email: normalizedEmail || null,
    createdAt: Date.now(),
    expiresAt: Date.now() + OAUTH_PENDING_EXPIRY_MS,
  };
  savePendingOAuth(pending);
  return { linked: false, pendingToken };
}

export function finishOAuthSignup({ pendingToken, username, displayName, aiName }) {
  const pending = loadPendingOAuth();
  const record = pending[pendingToken];
  if (!record) throw new Error('That sign-in expired — start over.');
  if (Date.now() > record.expiresAt) throw new Error('That sign-in expired — start over.');

  const normalizedUsername = username.trim().toLowerCase();
  if (findUserByUsername(normalizedUsername)) {
    throw new Error('That username is already taken.');
  }

  const users = loadUsers();
  const user = {
    id: randomUUID(),
    username: normalizedUsername,
    email: record.email,
    passwordHash: null, // OAuth-only account — no password login until/unless they set one
    oauthProvider: record.provider,
    oauthId: record.providerId,
    displayName: displayName.trim(),
    aiName: aiName.trim(),
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  saveUsers(users);

  delete pending[pendingToken];
  savePendingOAuth(pending);

  return user;
}

export function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  const sessions = loadSessions();
  sessions[token] = { userId, createdAt: new Date().toISOString() };
  saveSessions(sessions);
  return token;
}

export function getSession(token) {
  if (!token) return null;
  const sessions = loadSessions();
  return sessions[token] || null;
}

export function destroySession(token) {
  if (!token) return;
  const sessions = loadSessions();
  delete sessions[token];
  saveSessions(sessions);
}
