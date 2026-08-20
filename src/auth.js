import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { getDoc, setDoc, deleteDoc, getAllDocs } from './db.js';

// Every user is its own Firestore document (collection "users", doc id =
// user.id) rather than one shared array, so lookups don't require loading
// everyone's account just to find one. Sessions/pending-signups/pending-
// oauth are all short-lived, keyed records — same shape, own collections.

async function loadUsers() {
  return getAllDocs('users');
}

async function saveUser(user) {
  await setDoc('users', user.id, user);
}

async function getSessionRecord(token) {
  return getDoc('sessions', token);
}

async function saveSessionRecord(token, record) {
  await setDoc('sessions', token, { ...record, token });
}

async function deleteSessionRecord(token) {
  await deleteDoc('sessions', token);
}

async function getPendingSignup(email) {
  return getDoc('pendingSignups', email);
}

async function savePendingSignup(email, record) {
  await setDoc('pendingSignups', email, record);
}

async function deletePendingSignup(email) {
  await deleteDoc('pendingSignups', email);
}

async function getPendingOAuth(token) {
  return getDoc('pendingOAuth', token);
}

async function savePendingOAuthRecord(token, record) {
  await setDoc('pendingOAuth', token, record);
}

async function deletePendingOAuthRecord(token) {
  await deleteDoc('pendingOAuth', token);
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

export async function findUserByUsername(username) {
  const normalized = username.trim().toLowerCase();
  const users = await loadUsers();
  return users.find((u) => u.username === normalized) || null;
}

export async function findUserByEmail(email) {
  const normalized = email.trim().toLowerCase();
  const users = await loadUsers();
  return users.find((u) => u.email === normalized) || null;
}

export async function findUserById(userId) {
  return getDoc('users', userId);
}

export async function findUserByOAuth(provider, providerId) {
  const users = await loadUsers();
  return users.find((u) => u.oauthProvider === provider && u.oauthId === providerId) || null;
}

export async function listUsers() {
  return loadUsers();
}

// Custom-branded model tiers — Neurovance's own names, not Anthropic's.
// Starting with two: a fast one and a normal-speed one.
export const MODEL_TIERS = ['pulse', 'core'];
const DEFAULT_MODEL_TIER = 'core';

export async function setModelTier(userId, tier) {
  if (!MODEL_TIERS.includes(tier)) throw new Error(`Unknown model tier: ${tier}`);
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');
  user.model = tier;
  await saveUser(user);
  return user;
}

// Whether this user's Superself is a brutally-honest advisor (the product
// default) or a warm companion — was a code-level escape hatch before, now
// a real per-user setting like model tier above.
export async function setAdvisorMode(userId, advisorMode) {
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');
  user.advisorMode = !!advisorMode;
  await saveUser(user);
  return user;
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

export async function startSignup({ email, password }) {
  const normalizedEmail = email.trim().toLowerCase();
  if (await findUserByEmail(normalizedEmail)) {
    throw new Error('An account with that email already exists.');
  }
  if (!isStrongPassword(password)) {
    throw new Error(PASSWORD_ERROR);
  }
  const code = generateCode();
  await savePendingSignup(normalizedEmail, {
    email: normalizedEmail,
    passwordHash: hashPassword(password),
    code,
    verified: false,
    verifiedToken: null,
    createdAt: Date.now(),
    expiresAt: Date.now() + CODE_EXPIRY_MS,
  });
  return code; // caller emails this — never logged or returned to the client directly
}

export async function verifySignupCode({ email, code }) {
  const normalizedEmail = email.trim().toLowerCase();
  const record = await getPendingSignup(normalizedEmail);
  if (!record) throw new Error('No signup in progress for that email — start over.');
  if (Date.now() > record.expiresAt) throw new Error('That code expired — request a new one.');
  if (record.code !== String(code).trim()) throw new Error('Wrong code.');

  record.verified = true;
  record.verifiedToken = randomBytes(24).toString('hex');
  record.verifiedTokenExpiresAt = Date.now() + VERIFIED_TOKEN_EXPIRY_MS;
  await savePendingSignup(normalizedEmail, record);
  return record.verifiedToken;
}

export async function finishSignup({ email, verifiedToken, username, displayName, aiName }) {
  const normalizedEmail = email.trim().toLowerCase();
  const record = await getPendingSignup(normalizedEmail);
  if (!record || !record.verified || record.verifiedToken !== verifiedToken) {
    throw new Error('Email verification expired or invalid — start over.');
  }
  if (Date.now() > record.verifiedTokenExpiresAt) {
    throw new Error('That verification expired — start over.');
  }

  const normalizedUsername = username.trim().toLowerCase();
  if (await findUserByUsername(normalizedUsername)) {
    throw new Error('That username is already taken.');
  }

  const user = {
    id: randomUUID(),
    username: normalizedUsername,
    email: normalizedEmail,
    passwordHash: record.passwordHash,
    displayName: displayName.trim(),
    aiName: aiName.trim(),
    model: DEFAULT_MODEL_TIER,
    createdAt: new Date().toISOString(),
  };
  await saveUser(user);
  await deletePendingSignup(normalizedEmail);

  return user;
}

// ---------- OAuth (Google / GitHub): if the provider's email already
// matches an existing account, link this provider to it and sign straight
// in — no separate "pick a username" step for a returning identity. A
// genuinely new email still goes through choosing a username/AI name, same
// as email+password signup, just skipping straight past the password step
// since the provider already proved who they are.
const OAUTH_PENDING_EXPIRY_MS = 15 * 60 * 1000;

export async function startOAuthSignup({ provider, providerId, email }) {
  const existingByOAuth = await findUserByOAuth(provider, providerId);
  if (existingByOAuth) return { linked: true, user: existingByOAuth };

  const normalizedEmail = email?.trim().toLowerCase();
  const existingByEmail = normalizedEmail ? await findUserByEmail(normalizedEmail) : null;
  if (existingByEmail) {
    existingByEmail.oauthProvider = provider;
    existingByEmail.oauthId = providerId;
    await saveUser(existingByEmail);
    return { linked: true, user: existingByEmail };
  }

  const pendingToken = randomBytes(24).toString('hex');
  await savePendingOAuthRecord(pendingToken, {
    provider,
    providerId,
    email: normalizedEmail || null,
    createdAt: Date.now(),
    expiresAt: Date.now() + OAUTH_PENDING_EXPIRY_MS,
  });
  return { linked: false, pendingToken };
}

export async function finishOAuthSignup({ pendingToken, username, displayName, aiName }) {
  const record = await getPendingOAuth(pendingToken);
  if (!record) throw new Error('That sign-in expired — start over.');
  if (Date.now() > record.expiresAt) throw new Error('That sign-in expired — start over.');

  const normalizedUsername = username.trim().toLowerCase();
  if (await findUserByUsername(normalizedUsername)) {
    throw new Error('That username is already taken.');
  }

  const user = {
    id: randomUUID(),
    username: normalizedUsername,
    email: record.email,
    passwordHash: null, // OAuth-only account — no password login until/unless they set one
    oauthProvider: record.provider,
    oauthId: record.providerId,
    displayName: displayName.trim(),
    aiName: aiName.trim(),
    model: DEFAULT_MODEL_TIER,
    createdAt: new Date().toISOString(),
  };
  await saveUser(user);
  await deletePendingOAuthRecord(pendingToken);

  return user;
}

export async function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  await saveSessionRecord(token, { userId, createdAt: new Date().toISOString() });
  return token;
}

export async function getSession(token) {
  if (!token) return null;
  return getSessionRecord(token);
}

export async function destroySession(token) {
  if (!token) return;
  await deleteSessionRecord(token);
}
