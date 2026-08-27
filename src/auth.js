import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash } from 'crypto';
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

// Enforced at every path that can create or change a username — signup,
// OAuth signup, and the settings change — none of them validated this
// before, which is how a real account ended up with a literal space in its
// username (pre-filled from an OAuth display name and never checked).
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
function assertValidUsername(normalized) {
  if (!USERNAME_RE.test(normalized)) {
    throw new Error('Usernames can only use lowercase letters, numbers, and underscores (3-20 characters).');
  }
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

// Paid plan gates the Core model tier only — never the Companion, which
// stays free for everyone; it's the product's actual differentiator, and
// paywalling it would hurt adoption more than it protects revenue. Core
// costs more per reply than Pulse, so gating it (not a feature) is what
// actually protects margin as usage grows. New signups default to 'free'
// and 'pulse' together; every account that existed before this gate was
// introduced was grandfathered to 'paid' in one pass (see
// src/grandfather-paid-plan.js) so nobody already using Core lost it.
export const PLANS = ['free', 'paid'];
const DEFAULT_PLAN = 'free';

// Switched off for the initial friends-and-family send-out — Stripe isn't
// in live mode yet, so nobody could actually pay anyway. Flip this back to
// true once live checkout is wired up; nothing else needs to change, the
// gate below is the only thing this controls.
const PAYMENTS_ENABLED = false;

export async function setPlan(userId, plan) {
  if (!PLANS.includes(plan)) throw new Error(`Unknown plan: ${plan}`);
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');
  user.plan = plan;
  await saveUser(user);
  return user;
}

// Links this user to their Stripe customer/subscription records — set once
// at checkout, read back by the billing portal and by the webhook handler
// when a subscription is later canceled server-side (Stripe's dashboard,
// a failed renewal, etc.), which only ever gives us the subscription
// object, never our own userId directly.
export async function setStripeInfo(userId, { customerId, subscriptionId }) {
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');
  if (customerId) user.stripeCustomerId = customerId;
  if (subscriptionId) user.stripeSubscriptionId = subscriptionId;
  await saveUser(user);
  return user;
}

export async function findUserByStripeSubscriptionId(subscriptionId) {
  const users = await loadUsers();
  return users.find((u) => u.stripeSubscriptionId === subscriptionId) || null;
}

export async function setModelTier(userId, tier) {
  if (!MODEL_TIERS.includes(tier)) throw new Error(`Unknown model tier: ${tier}`);
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');
  if (PAYMENTS_ENABLED && tier === 'core' && user.plan !== 'paid') {
    throw new Error('Core is a paid feature — upgrade to switch to it.');
  }
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

export const BROWSERS = ['safari', 'chrome'];

// Which real browser the Companion drives for open_url/click/type/read
// actions — Mac only (Windows automation goes through Outlook, not a
// browser). Defaults to Safari since that's what every account had before
// this setting existed.
export async function setBrowserPref(userId, browser) {
  if (!BROWSERS.includes(browser)) throw new Error(`Unknown browser: ${browser}`);
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');
  user.browser = browser;
  await saveUser(user);
  return user;
}

export const LANGUAGES = [
  'English', 'Spanish', 'French', 'German', 'Portuguese', 'Italian',
  'Japanese', 'Korean', 'Chinese', 'Hindi', 'Arabic', 'Russian',
];

// Which language this user's Superself replies in — injected into the
// system prompt, not a UI translation layer. Defaults to English.
export async function setLanguage(userId, language) {
  if (!LANGUAGES.includes(language)) throw new Error(`Unknown language: ${language}`);
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');
  user.language = language;
  await saveUser(user);
  return user;
}

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'max', 'extreme'];

// How much the model actually reasons before answering — maps to Anthropic's
// extended-thinking token budget (see resolveThinking in agent.js). Low is
// today's existing behavior (no extended thinking, fastest); everything
// above it trades latency for more thorough reasoning. Defaults to low.
export async function setEffortLevel(userId, level) {
  if (!EFFORT_LEVELS.includes(level)) throw new Error(`Unknown effort level: ${level}`);
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');
  user.effortLevel = level;
  await saveUser(user);
  return user;
}

// A single global daily cap, applied to every account — protects the app's
// own Anthropic bill, not a per-user preference, so it's set via env var
// (DAILY_MESSAGE_LIMIT) rather than exposed anywhere in the UI. Resets at
// UTC midnight. 500/day is a generous default for real usage, cheap
// insurance against a runaway loop or a compromised account.
const DEFAULT_DAILY_LIMIT = 500;
function dailyLimit() {
  const envVal = parseInt(process.env.DAILY_MESSAGE_LIMIT, 10);
  return Number.isFinite(envVal) && envVal > 0 ? envVal : DEFAULT_DAILY_LIMIT;
}
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// Called once per chat/task request, before it's allowed to run — increments
// on success, and never lets a request through once the day's count is
// already at the cap. A user's own account doc carries its own counter
// (user.usage = { date, count }) rather than a separate collection, since
// this is a simple read-modify-write with no need for atomic increments at
// this app's actual concurrency (one person, one conversation at a time).
export async function checkAndIncrementUsage(userId) {
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');
  const limit = dailyLimit();
  const today = todayUTC();
  const usage = user.usage?.date === today ? user.usage : { date: today, count: 0 };
  if (usage.count >= limit) {
    return { allowed: false, count: usage.count, limit };
  }
  usage.count += 1;
  user.usage = usage;
  await saveUser(user);
  return { allowed: true, count: usage.count, limit };
}

export const PERMISSION_MODES = ['bypass', 'ask'];

// Whether the Superself acts freely (including payments, sending messages,
// deleting things) or pauses to confirm before every single action. Defaults
// to 'bypass' — matches today's existing behavior, and Ari's own stated
// preference for how he likes an agent configured. 'ask' is the strict
// opt-in for someone who wants tighter control; unlike the risk-tiered
// confirm rules this replaces, there is no exception list once 'bypass' is
// chosen — the user is explicitly accepting that.
export async function setPermissionMode(userId, mode) {
  if (!PERMISSION_MODES.includes(mode)) throw new Error(`Unknown permission mode: ${mode}`);
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');
  user.permissionMode = mode;
  await saveUser(user);
  return user;
}

export async function setUsername(userId, newUsername) {
  const normalized = newUsername.trim().toLowerCase();
  assertValidUsername(normalized);
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');
  if (normalized === user.username) return user;
  const existing = await findUserByUsername(normalized);
  if (existing) throw new Error('That username is already taken.');
  user.username = normalized;
  await saveUser(user);
  return user;
}

export async function setAiName(userId, newAiName) {
  const trimmed = newAiName.trim();
  if (!trimmed) throw new Error('Name cannot be empty.');
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');
  user.aiName = trimmed;
  await saveUser(user);
  return user;
}

// Requires the current password when one exists (a password-based account
// changing its own password) — an OAuth-only account (passwordHash: null)
// is setting one for the first time, so there's nothing to verify yet.
export async function changePassword(userId, currentPassword, newPassword) {
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');
  if (user.passwordHash && !(currentPassword && verifyPassword(currentPassword, user.passwordHash))) {
    throw new Error('Current password is incorrect.');
  }
  if (!isStrongPassword(newPassword)) throw new Error(PASSWORD_ERROR);
  user.passwordHash = hashPassword(newPassword);
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
  assertValidUsername(normalizedUsername);
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
    plan: DEFAULT_PLAN,
    model: 'pulse', // free-tier default — Core requires 'paid', see setModelTier
    createdAt: new Date().toISOString(),
  };
  await saveUser(user);
  await deletePendingSignup(normalizedEmail);

  return user;
}

// ---------- Forgot password — same code-then-token shape as signup
// verification above, in its own collection so an in-progress reset can
// never collide with an in-progress signup for the same email. ----------

async function getPasswordReset(email) {
  return getDoc('passwordResets', email);
}
async function savePasswordReset(email, record) {
  await setDoc('passwordResets', email, record);
}
async function deletePasswordReset(email) {
  await deleteDoc('passwordResets', email);
}

// Always returns quietly (never throws for "no such account") — the server
// sends the same "check your email" response either way, so this can't be
// used to probe which emails have accounts. Returns null when there's
// nothing to email; the caller simply skips sending in that case.
export async function startPasswordReset(email) {
  const normalizedEmail = email.trim().toLowerCase();
  const user = await findUserByEmail(normalizedEmail);
  if (!user) return null;
  const code = generateCode();
  await savePasswordReset(normalizedEmail, {
    email: normalizedEmail,
    code,
    verified: false,
    resetToken: null,
    createdAt: Date.now(),
    expiresAt: Date.now() + CODE_EXPIRY_MS,
  });
  return code;
}

export async function verifyPasswordResetCode({ email, code }) {
  const normalizedEmail = email.trim().toLowerCase();
  const record = await getPasswordReset(normalizedEmail);
  if (!record) throw new Error('No reset in progress for that email — request a new code.');
  if (Date.now() > record.expiresAt) throw new Error('That code expired — request a new one.');
  if (record.code !== String(code).trim()) throw new Error('Wrong code.');

  record.verified = true;
  record.resetToken = randomBytes(24).toString('hex');
  record.resetTokenExpiresAt = Date.now() + VERIFIED_TOKEN_EXPIRY_MS;
  await savePasswordReset(normalizedEmail, record);
  return record.resetToken;
}

export async function finishPasswordReset({ email, resetToken, newPassword }) {
  const normalizedEmail = email.trim().toLowerCase();
  const record = await getPasswordReset(normalizedEmail);
  if (!record || !record.verified || record.resetToken !== resetToken) {
    throw new Error('Reset verification expired or invalid — start over.');
  }
  if (Date.now() > record.resetTokenExpiresAt) throw new Error('That verification expired — start over.');
  if (!isStrongPassword(newPassword)) throw new Error(PASSWORD_ERROR);

  const user = await findUserByEmail(normalizedEmail);
  if (!user) throw new Error('No such account.');
  user.passwordHash = hashPassword(newPassword);
  await saveUser(user);
  await deletePasswordReset(normalizedEmail);
  return user;
}

// ---------- Change email — requires the current password (when the account
// has one) before even starting, then a code sent to the NEW address to
// prove it's actually reachable, the same two-factor shape signup itself
// uses. Keyed by userId, not email, since this is an already-authenticated
// action, not a public one. ----------

async function getPendingEmailChange(userId) {
  return getDoc('pendingEmailChanges', userId);
}
async function savePendingEmailChange(userId, record) {
  await setDoc('pendingEmailChanges', userId, record);
}
async function deletePendingEmailChange(userId) {
  await deleteDoc('pendingEmailChanges', userId);
}

export async function startEmailChange(userId, newEmail, currentPassword) {
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');
  if (user.passwordHash && !(currentPassword && verifyPassword(currentPassword, user.passwordHash))) {
    throw new Error('Current password is incorrect.');
  }
  const normalizedEmail = newEmail.trim().toLowerCase();
  if (normalizedEmail === user.email) throw new Error('That is already your email.');
  if (await findUserByEmail(normalizedEmail)) throw new Error('That email is already in use.');

  const code = generateCode();
  await savePendingEmailChange(userId, {
    userId,
    newEmail: normalizedEmail,
    code,
    createdAt: Date.now(),
    expiresAt: Date.now() + CODE_EXPIRY_MS,
  });
  return { code, newEmail: normalizedEmail };
}

export async function finishEmailChange(userId, code) {
  const record = await getPendingEmailChange(userId);
  if (!record) throw new Error('No email change in progress — start over.');
  if (Date.now() > record.expiresAt) throw new Error('That code expired — request a new one.');
  if (record.code !== String(code).trim()) throw new Error('Wrong code.');
  if (await findUserByEmail(record.newEmail)) throw new Error('That email is already in use.');

  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');
  user.email = record.newEmail;
  await saveUser(user);
  await deletePendingEmailChange(userId);
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
  assertValidUsername(normalizedUsername);
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
    plan: DEFAULT_PLAN,
    model: 'pulse', // free-tier default — Core requires 'paid', see setModelTier
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

// A skill is custom instructions a user writes and saves for their own
// Superself — a reusable persona/behavior fragment, injected into the
// system prompt alongside everything else. No code execution, no new
// network access (that's what a connector is for) — just text the agent
// follows, the same trust level as anything else already in the prompt.
const MAX_SKILLS_PER_USER = 10;
const MAX_SKILL_NAME_LENGTH = 60;
const MAX_SKILL_INSTRUCTIONS_LENGTH = 2000;

export async function listSkills(userId) {
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');
  return user.skills || [];
}

export async function addSkill(userId, { name, instructions }) {
  if (!name?.trim()) throw new Error('Give the skill a name.');
  if (!instructions?.trim()) throw new Error('Give the skill some instructions.');
  if (name.trim().length > MAX_SKILL_NAME_LENGTH) throw new Error(`Name must be under ${MAX_SKILL_NAME_LENGTH} characters.`);
  if (instructions.trim().length > MAX_SKILL_INSTRUCTIONS_LENGTH) throw new Error(`Instructions must be under ${MAX_SKILL_INSTRUCTIONS_LENGTH} characters.`);
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');
  const existing = user.skills || [];
  if (existing.length >= MAX_SKILLS_PER_USER) throw new Error(`You can have up to ${MAX_SKILLS_PER_USER} skills at a time.`);
  const skill = { id: randomUUID(), name: name.trim(), instructions: instructions.trim(), createdAt: new Date().toISOString() };
  user.skills = [...existing, skill];
  await saveUser(user);
  return skill;
}

export async function removeSkill(userId, skillId) {
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');
  user.skills = (user.skills || []).filter((s) => s.id !== skillId);
  await saveUser(user);
}

// API keys let a user call Neurovance from their own external apps
// (Authorization: Bearer nv_...) instead of a browser session cookie.
// Deliberately NOT the same hashing as passwords: a password is short,
// human-chosen, and needs slow salted hashing to resist offline guessing;
// an API key is a 192-bit random secret this app generates itself —
// brute-forcing it is infeasible regardless of hash speed, and a request
// needs to identify WHICH user a key belongs to without already knowing,
// which needs a direct O(1) lookup a slow salted hash can't give you. A
// plain SHA-256 of the full key is the standard pattern for this (same
// approach GitHub/Stripe-style API keys use) — stored as the document id
// in its own collection, keyed by the key itself rather than by user.
const MAX_API_KEYS_PER_USER = 5;

function hashApiKey(rawKey) {
  return createHash('sha256').update(rawKey).digest('hex');
}

export async function listApiKeys(userId) {
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');
  return (user.apiKeys || []).map(({ keyHash, name, prefix, createdAt, lastUsedAt }) => ({
    id: keyHash, name, prefix, createdAt, lastUsedAt,
  }));
}

// Returns the full raw key exactly once — only the prefix and a hash are
// ever stored, so this is the only time it's recoverable.
export async function createApiKey(userId, name) {
  if (!name?.trim()) throw new Error('Give the key a name.');
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');
  const existing = user.apiKeys || [];
  if (existing.length >= MAX_API_KEYS_PER_USER) throw new Error(`You can have up to ${MAX_API_KEYS_PER_USER} API keys at a time.`);

  const fullKey = `nv_${randomBytes(24).toString('base64url')}`;
  const keyHash = hashApiKey(fullKey);
  const now = new Date().toISOString();
  const listEntry = { keyHash, name: name.trim(), prefix: fullKey.slice(0, 10), createdAt: now, lastUsedAt: null };

  user.apiKeys = [...existing, listEntry];
  await saveUser(user);
  await setDoc('apiKeys', keyHash, { userId, createdAt: now });

  return { name: listEntry.name, prefix: listEntry.prefix, key: fullKey };
}

export async function revokeApiKey(userId, keyHash) {
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');
  user.apiKeys = (user.apiKeys || []).filter((k) => k.keyHash !== keyHash);
  await saveUser(user);
  await deleteDoc('apiKeys', keyHash);
}

// The auth path for /api/v1/* — a raw key straight off the wire, resolved
// to the account it belongs to. Updates lastUsedAt best-effort so it never
// slows down or fails the actual request over a bookkeeping write.
export async function findUserByApiKey(rawKey) {
  if (!rawKey || !rawKey.startsWith('nv_')) return null;
  const keyHash = hashApiKey(rawKey);
  const record = await getDoc('apiKeys', keyHash);
  if (!record) return null;
  const user = await findUserById(record.userId);
  if (!user) return null;
  const entry = (user.apiKeys || []).find((k) => k.keyHash === keyHash);
  if (entry) {
    entry.lastUsedAt = new Date().toISOString();
    saveUser(user).catch((e) => console.error('Failed to update API key lastUsedAt:', e.message));
  }
  return user;
}
