import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash, randomInt } from 'crypto';
import { getDoc, setDoc, deleteDoc, getAllDocs, queryDocsByField, runTransaction } from './db.js';
import { computeNextRun, assertValidSchedule } from './schedule-utils.js';

// Every user is its own Firestore document (collection "users", doc id =
// user.id) rather than one shared array, so lookups don't require loading
// everyone's account just to find one. Sessions/pending-signups/pending-
// oauth are all short-lived, keyed records — same shape, own collections.

async function loadUsers() {
  return getAllDocs('users');
}

export async function saveUser(user) {
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

// Display names (and the AI's name) are rendered into other users' browsers
// (e.g. the connections list), so they must not carry HTML/metacharacters a
// hostile signup could slip through as stored XSS. Keep it display-friendly:
// letters, numbers, spaces, and a small set of harmless punctuation; strip
// anything that could open a tag or attribute.
const DISPLAY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.'\-()]{0,49}$/;
function sanitizeDisplayName(raw) {
  const trimmed = String(raw ?? '').trim().replace(/[<>]/g, '').slice(0, 50);
  if (!DISPLAY_NAME_RE.test(trimmed)) {
    throw new Error('Name can only use letters, numbers, and basic punctuation.');
  }
  return trimmed;
}

export async function findUserByUsername(username) {
  const normalized = username.trim().toLowerCase();
  const results = await queryDocsByField('users', 'username', normalized);
  return results[0] || null;
}

export async function findUserByEmail(email) {
  const normalized = email.trim().toLowerCase();
  const results = await queryDocsByField('users', 'email', normalized);
  return results[0] || null;
}

export async function findUserById(userId) {
  return getDoc('users', userId);
}

export async function findUserByOAuth(provider, providerId) {
  const results = await queryDocsByField('users', 'oauthId', providerId);
  return results.find((u) => u.oauthProvider === provider) || null;
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
  const results = await queryDocsByField('users', 'stripeSubscriptionId', subscriptionId);
  return results[0] || null;
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

// Token budget defaults if not set. Exported — server.js's /api/usage route
// needs it as a fallback for a fresh account with no tokenBudget of its own
// yet; was un-exported, so `auth.DEFAULT_TOKEN_BUDGET` there silently
// resolved to undefined and broke the usage bar for exactly that case.
export const DEFAULT_TOKEN_BUDGET = 1_000_000;

// Machine "tuning" settings — the knobs a user can turn to make their
// Superself behave a certain way. Kept out of the top-level user model in
// one flat object so new knobs can be added without migrating the schema:
// defaults merge over whatever's stored, so an old account picks up brand
// new knobs automatically. Exported so server.js's /api/me + agent.js can
// read the same source of truth instead of each guessing.
export const DEFAULT_PREFERENCES = {
  // Model & depth
  temperature: 0.7,      // 0..1 creativity
  topP: 0.9,             // 0..1 nucleus sampling
  maxTokens: 4096,       // output ceiling for a normal (non-deep) response
  contextTurns: 20,      // how many prior turns are sent as context
  model: 'core',         // core | pulse
  // Autonomy & abilities
  webFetch: true,        // allow the fetch_webpage tool
  shellAccess: false,    // allow the companion run_shell tool
  maxIterations: 20,     // per-run tool-use step ceiling
  autoRun: false,        // allow unattended/deep runs to fire on their own
  // Communication
  verbosity: 'balanced', // concise | balanced | detailed
  formality: 'casual',   // casual | professional
  tone: '',              // free-text extra instruction for how to talk
  // Memory & learning
  autoMemory: true,      // write new memories during conversations
  dailyGrow: true,       // run the overnight self-improvement pass
  consolidation: true,   // dedupe/merge memories on the write path
  // Automation
  proactive: false,      // volunteer unprompted suggestions/observations
  dailyGrowTime: '08:00',// local "HH:MM" for the daily grow window
};

export function mergePreferences(user) {
  return { ...DEFAULT_PREFERENCES, ...(user?.preferences || {}) };
}

// PATCH-style update: only writes the keys actually present, merges over the
// existing preferences, and validates the constrained ones so a bad value
// can't be persisted. Returns the merged preferences for the caller to echo.
export async function updatePreferences(userId, patch = {}) {
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');
  const merged = mergePreferences(user);
  const next = { ...merged };

  if (patch.temperature !== undefined) {
    const v = Number(patch.temperature);
    if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error('temperature must be between 0 and 1.');
    next.temperature = v;
  }
  if (patch.topP !== undefined) {
    const v = Number(patch.topP);
    if (!Number.isFinite(v) || v < 0 || v > 1) throw new Error('topP must be between 0 and 1.');
    next.topP = v;
  }
  if (patch.maxTokens !== undefined) {
    const v = parseInt(patch.maxTokens, 10);
    if (!Number.isFinite(v) || v < 256 || v > 32000) throw new Error('maxTokens must be between 256 and 32000.');
    next.maxTokens = v;
  }
  if (patch.contextTurns !== undefined) {
    const v = parseInt(patch.contextTurns, 10);
    if (!Number.isFinite(v) || v < 1 || v > 100) throw new Error('contextTurns must be between 1 and 100.');
    next.contextTurns = v;
  }
  if (patch.model !== undefined) {
    if (!MODEL_TIERS.includes(patch.model)) throw new Error('model must be core or pulse.');
    next.model = patch.model;
  }
  if (patch.webFetch !== undefined) next.webFetch = !!patch.webFetch;
  if (patch.shellAccess !== undefined) next.shellAccess = !!patch.shellAccess;
  if (patch.maxIterations !== undefined) {
    const v = parseInt(patch.maxIterations, 10);
    if (!Number.isFinite(v) || v < 1 || v > 100) throw new Error('maxIterations must be between 1 and 100.');
    next.maxIterations = v;
  }
  if (patch.autoRun !== undefined) next.autoRun = !!patch.autoRun;
  if (patch.verbosity !== undefined) {
    if (!['concise', 'balanced', 'detailed'].includes(patch.verbosity)) throw new Error('verbosity must be concise, balanced, or detailed.');
    next.verbosity = patch.verbosity;
  }
  if (patch.formality !== undefined) {
    if (!['casual', 'professional'].includes(patch.formality)) throw new Error('formality must be casual or professional.');
    next.formality = patch.formality;
  }
  if (patch.tone !== undefined) {
    if (typeof patch.tone !== 'string' || patch.tone.length > 500) throw new Error('tone must be text, 500 chars or fewer.');
    next.tone = patch.tone;
  }
  if (patch.autoMemory !== undefined) next.autoMemory = !!patch.autoMemory;
  if (patch.dailyGrow !== undefined) next.dailyGrow = !!patch.dailyGrow;
  if (patch.consolidation !== undefined) next.consolidation = !!patch.consolidation;
  if (patch.proactive !== undefined) next.proactive = !!patch.proactive;
  if (patch.dailyGrowTime !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(patch.dailyGrowTime)) throw new Error('dailyGrowTime must be HH:MM.');
    next.dailyGrowTime = patch.dailyGrowTime;
  }

  user.preferences = next;
  await saveUser(user);
  return next;
}

// Referral codes: every account gets one, assigned at signup (or backfilled
// on first request from an older account). Each successful referral raises
// the referrer's own daily limit — a real, immediate perk that doesn't need
// Stripe, a price, or any money at all, which matters since there's nothing
// paid to offer yet. Capped so it can't be farmed into an unlimited bypass
// of the cap the limit exists to enforce in the first place.
const REFERRAL_BONUS_PER_INVITE = 50;
const REFERRAL_BONUS_MAX = 500;

function generateReferralCode() {
  return randomBytes(4).toString('hex').toUpperCase();
}

async function findUserByReferralCode(code) {
  if (!code) return null;
  const results = await queryDocsByField('users', 'referralCode', code.toUpperCase());
  return results[0] || null;
}

// Called once, on a brand-new user object, before its first save — never
// on an existing account, so a code can't be "applied" twice to farm bonus
// messages. Mutates `user` in place (assigns its own code; sets referredBy
// if it arrived via someone else's) and separately saves the referrer.
async function applyReferral(user, referralCode) {
  user.referralCode = generateReferralCode();
  if (!referralCode) return;
  const referrer = await findUserByReferralCode(referralCode);
  if (!referrer || referrer.id === user.id) return;
  referrer.referralCount = (referrer.referralCount || 0) + 1;
  await saveUser(referrer);
  user.referredBy = referrer.id;
}

export async function getReferralInfo(userId) {
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');
  if (!user.referralCode) {
    // Backfill for an account that existed before this feature shipped.
    user.referralCode = generateReferralCode();
    await saveUser(user);
  }
  const count = user.referralCount || 0;
  return {
    code: user.referralCode,
    count,
    bonus: Math.min(count * REFERRAL_BONUS_PER_INVITE, REFERRAL_BONUS_MAX),
    maxBonus: REFERRAL_BONUS_MAX,
    perInvite: REFERRAL_BONUS_PER_INVITE,
  };
}

function dailyLimit(user) {
  const envVal = parseInt(process.env.DAILY_MESSAGE_LIMIT, 10);
  const base = Number.isFinite(envVal) && envVal > 0 ? envVal : DEFAULT_DAILY_LIMIT;
  const bonus = Math.min((user?.referralCount || 0) * REFERRAL_BONUS_PER_INVITE, REFERRAL_BONUS_MAX);
  return base + bonus;
}
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

export async function checkTokenUsage(userId) {
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');

  const budget = user.tokenBudget || DEFAULT_TOKEN_BUDGET;
  const today = todayUTC();
  const usage = user.tokenUsage?.date === today ? user.tokenUsage : { date: today, used: 0 };

  // The token budget is always enforced as a hard cap — the failure mode
  // of a budget that can be exceeded is exactly what this exists to prevent
  // (a runaway loop quietly billing unlimited Anthropic tokens). Strict mode
  // makes the cap tight and absolute; without it, a soft ceiling sits at the
  // budget with a hard floor at 3x, so a normal user going slightly over is
  // tolerated (suggesting a downscale) but a real runaway loop always stops.
  const HARD_CAP_MULTIPLIER = 3;
  const hardCap = budget * HARD_CAP_MULTIPLIER;

  if (user.strictModeEnabled && usage.used >= budget) {
    return { allowed: false, used: usage.used, budget };
  }

  if (usage.used >= hardCap) {
    return { allowed: false, used: usage.used, budget };
  }

  return {
    allowed: true,
    used: usage.used,
    budget,
    suggestDownscale: usage.used / budget > 0.8
  };
}

// Updates the user's daily token consumption in Firestore.
export async function incrementTokenUsage(userId, tokens) {
  return await runTransaction('users', userId, async (user) => {
    if (!user) throw new Error('No such user.');
    const today = todayUTC();
    const usage = user.tokenUsage?.date === today ? user.tokenUsage : { date: today, used: 0 };
    usage.used += tokens;
    return [{ tokenUsage: usage }];
  });
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
  const sanitized = sanitizeDisplayName(newAiName);
  if (!sanitized) throw new Error('Name cannot be empty.');
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');
  user.aiName = sanitized;
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
// Codes are what you know with access to the inbox. A brute force over the
// 6-digit space can't be fully stopped by per-IP route limits alone (many
// IPs each grinds a slice), so a code also self-destructs after this many
// wrong guesses — a global cap no amount of rotating sources can outrun.
const MAX_CODE_ATTEMPTS = 10;

function generateCode() {
  return String(randomInt(100000, 1000000)); // 6 digits, crypto-random
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

  const wrongGuesses = record.attempts || 0;
  if (wrongGuesses >= MAX_CODE_ATTEMPTS) {
    await deletePendingSignup(normalizedEmail);
    throw new Error('Too many wrong attempts — request a new code.');
  }
  if (record.code !== String(code).trim()) {
    record.attempts = wrongGuesses + 1;
    await savePendingSignup(normalizedEmail, record);
    throw new Error('Wrong code.');
  }

  record.verified = true;
  record.verifiedToken = randomBytes(24).toString('hex');
  record.verifiedTokenExpiresAt = Date.now() + VERIFIED_TOKEN_EXPIRY_MS;
  await savePendingSignup(normalizedEmail, record);
  return record.verifiedToken;
}

export async function finishSignup({ email, verifiedToken, username, displayName, aiName, referralCode }) {
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
    displayName: sanitizeDisplayName(displayName),
    aiName: sanitizeDisplayName(aiName),
    plan: DEFAULT_PLAN,
    model: 'pulse', // free-tier default — Core requires 'paid', see setModelTier
    createdAt: new Date().toISOString(),
  };
  await applyReferral(user, referralCode);
  await saveUser(user);
  await deletePendingSignup(normalizedEmail);

  return user;
}

// ---------- Invite: waitlist entry -> real account ----------
// This is the missing handoff from the marketing site's actual flow: a person
// joins the waitlist (a `waitlist` doc), and now the admin invites them, which
// provisions a real `users` account so they can actually sign in, pair the
// Companion, and install the extension. It refuses emails that are already a
// user or already invited (so an invite can't overwrite a live account), and
// the temporary password is generated fresh, returned to the caller ONCE so it
// can be mailed, and never stored — the first thing the new user should do is
// change it, but they can't be locked out before that.

const INVITE_USERNAME_BASE = 'member';
async function uniqueInviteUsername() {
  // Keep trying short suffixes until one isn't taken — the base name is a
  // realistic 6 chars and collisions are rare, so this terminates almost
  // immediately in practice.
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? INVITE_USERNAME_BASE : `${INVITE_USERNAME_BASE}${Math.floor(Math.random() * 900 + 100)}`;
    if (!(await findUserByUsername(candidate))) return candidate;
  }
  throw new Error('Could not allocate a username.');
}

function generateTemporaryPassword() {
  return `nv-${randomBytes(9).toString('base64url')}`; // ~12 chars, URL-safe
}

export async function inviteFromWaitlist({ email, displayName, aiName }) {
  const normalizedEmail = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new Error('That is not a valid email address.');
  }
  if (await findUserByEmail(normalizedEmail)) {
    throw new Error('That email already has an account.');
  }
  const existingInvite = await getDoc('invites', normalizedEmail);
  if (existingInvite) {
    throw new Error('That email was already invited.');
  }

  const username = await uniqueInviteUsername();
  const temporaryPassword = generateTemporaryPassword();
  const user = {
    id: randomUUID(),
    username,
    email: normalizedEmail,
    passwordHash: hashPassword(temporaryPassword),
    displayName: sanitizeDisplayName(displayName || 'Member'),
    aiName: sanitizeDisplayName(aiName || 'Superself'),
    plan: DEFAULT_PLAN,
    model: 'pulse',
    createdAt: new Date().toISOString(),
    invitedAt: new Date().toISOString(),
    mustChangePassword: true,
  };
  await saveUser(user);
  // Mark the waitlist entry invited so the admin UI can show it, and record
  // the invite (without the password) so a re-invite is refused.
  await setDoc('invites', normalizedEmail, { userId: user.id, username, invitedAt: user.invitedAt });
  await setDoc('waitlist', normalizedEmail, {
    invited: true,
    invitedAt: user.invitedAt,
  });

  return { user, temporaryPassword };
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

  // A wrong code that's been guessed too many times burns the code outright.
  // Without this, a distributed attacker (many IPs, spoofed sources) could
  // grind through the 6-digit space with no way to cap them per-code — the
  // per-IP route limit only slows a single IP source. Global per-code cap is
  // the hard stop an account-takeover brute force can't route around.
  const wrongGuesses = record.attempts || 0;
  if (wrongGuesses >= MAX_CODE_ATTEMPTS) {
    await deletePasswordReset(normalizedEmail);
    throw new Error('Too many wrong attempts — request a new code.');
  }
  if (record.code !== String(code).trim()) {
    record.attempts = wrongGuesses + 1;
    await savePasswordReset(normalizedEmail, record);
    throw new Error('Wrong code.');
  }

  record.attempts = 0;
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

  const wrongGuesses = record.attempts || 0;
  if (wrongGuesses >= MAX_CODE_ATTEMPTS) {
    await deletePendingEmailChange(userId);
    throw new Error('Too many wrong attempts — request a new code.');
  }
  if (record.code !== String(code).trim()) {
    record.attempts = wrongGuesses + 1;
    await savePendingEmailChange(userId, record);
    throw new Error('Wrong code.');
  }
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

export async function finishOAuthSignup({ pendingToken, username, displayName, aiName, referralCode }) {
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
    displayName: sanitizeDisplayName(displayName),
    aiName: sanitizeDisplayName(aiName),
    plan: DEFAULT_PLAN,
    model: 'pulse', // free-tier default — Core requires 'paid', see setModelTier
    createdAt: new Date().toISOString(),
  };
  await applyReferral(user, referralCode);
  await saveUser(user);
  await deletePendingOAuthRecord(pendingToken);

  return user;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — matches the cookie's Max-Age for "remember me"

export async function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  const now = new Date();
  await saveSessionRecord(token, {
    userId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
  });
  return token;
}

export async function getSession(token) {
  if (!token) return null;
  const session = await getSessionRecord(token);
  if (!session) return null;
  // Older sessions created before expiration was added have no expiresAt —
  // treat them as never expiring rather than locking out everyone who was
  // already signed in.
  if (session.expiresAt && Date.now() > new Date(session.expiresAt).getTime()) {
    await deleteSessionRecord(token);
    return null;
  }
  return session;
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

// Scheduled tasks: a saved prompt that runs itself on a recurring schedule,
// unattended, and files its output away as a memory instead of a chat
// reply — same trust level and storage shape as skills, just with a
// schedule + run-state attached.
const MAX_SCHEDULED_TASKS_PER_USER = 10;
const MAX_TASK_NAME_LENGTH = 60;
const MAX_TASK_PROMPT_LENGTH = 2000;

export async function listScheduledTasks(userId) {
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');
  return user.scheduledTasks || [];
}

export async function addScheduledTask(userId, { name, prompt, schedule, presetId }) {
  if (!name?.trim()) throw new Error('Give the task a name.');
  if (!prompt?.trim()) throw new Error('Give the task some instructions.');
  if (name.trim().length > MAX_TASK_NAME_LENGTH) throw new Error(`Name must be under ${MAX_TASK_NAME_LENGTH} characters.`);
  if (prompt.trim().length > MAX_TASK_PROMPT_LENGTH) throw new Error(`Instructions must be under ${MAX_TASK_PROMPT_LENGTH} characters.`);
  assertValidSchedule(schedule);
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');
  const existing = user.scheduledTasks || [];
  if (existing.length >= MAX_SCHEDULED_TASKS_PER_USER) throw new Error(`You can have up to ${MAX_SCHEDULED_TASKS_PER_USER} scheduled tasks at a time.`);
  const now = new Date();
  const task = {
    id: randomUUID(),
    name: name.trim(),
    prompt: prompt.trim(),
    schedule,
    presetId: presetId || null,
    active: true,
    createdAt: now.toISOString(),
    lastRunAt: null,
    lastResult: null,
    nextRunAt: computeNextRun(schedule, now).toISOString(),
  };
  user.scheduledTasks = [...existing, task];
  await saveUser(user);
  return task;
}

export async function removeScheduledTask(userId, taskId) {
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');
  user.scheduledTasks = (user.scheduledTasks || []).filter((t) => t.id !== taskId);
  await saveUser(user);
}

export async function setScheduledTaskActive(userId, taskId, active) {
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');
  const task = (user.scheduledTasks || []).find((t) => t.id === taskId);
  if (!task) throw new Error('No such scheduled task.');
  task.active = !!active;
  // Re-anchor from now so flipping it back on doesn't immediately fire on a
  // run time that already passed while it was off.
  if (task.active) task.nextRunAt = computeNextRun(task.schedule, new Date()).toISOString();
  await saveUser(user);
  return task;
}

export async function recordScheduledTaskRun(userId, taskId, { lastResult, lastError }) {
  const user = await findUserById(userId);
  if (!user) return;
  const task = (user.scheduledTasks || []).find((t) => t.id === taskId);
  if (!task) return;
  const now = new Date();
  task.lastRunAt = now.toISOString();
  task.lastResult = lastError ? `Error: ${lastError}` : lastResult;
  task.nextRunAt = computeNextRun(task.schedule, now).toISOString();
  await saveUser(user);
  return task;
}

// Used by the scheduler tick to find due tasks across every account without
// each caller re-implementing the "load everyone" scan.
export async function listAllUsers() {
  return loadUsers();
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

export async function setAiSettings(userId, settings) {
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');
  user.aiSettings = {
    temperature: settings.temperature ?? 0.7,
    topP: settings.topP ?? 0.9,
    maxTokens: settings.maxTokens ?? 4096,
    contextTurns: settings.contextTurns ?? 20,
  };
  await saveUser(user);
  return user.aiSettings;
}

export async function setPrivacyTrain(userId, enabled) {
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');
  user.privacyTrain = !!enabled;
  await saveUser(user);
}

export async function deleteUser(userId) {
  const user = await findUserById(userId);
  if (!user) throw new Error('No such user.');

  // Revoke all API keys associated with the user
  if (user.apiKeys) {
    for (const key of user.apiKeys) {
      await deleteDoc('apiKeys', key.keyHash);
    }
  }

  await deleteDoc('users', userId);
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
