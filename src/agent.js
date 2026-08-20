import Anthropic from '@anthropic-ai/sdk';
import { remember, recall, recentMemories, coreMemories, allMemories, findMemory, updateMemory } from './memory.js';
import { computeVitals } from './vitals.js';
import * as companion from './companion.js';
import * as pendingNotes from './pending-notes.js';

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

// Companion tools — only offered when this user has actually paired the
// local Companion app (agent.js never assumes it's there). Read-only by
// design for now: listing/reading a folder the user chose, and opening a
// Safari link. Write/delete comes later, behind an explicit confirmation
// step, the same way the waitlist broadcast requires one before it sends.
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
    'Open a URL in the user\'s own Safari on their computer, via their paired Companion app, so they see it appear live. Only https:// URLs.',
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
    'Read the visible text of whatever page is currently open in the user\'s own Safari (front tab only), via their paired Companion app. Only ever sees a page AFTER the user has already loaded and logged into it themselves — this cannot log in, fill in a form, or touch a credential. Only use this when the user has actually asked you to check or read something on their screen, e.g. right after asking them to log in somewhere. Never assume something is open unless they said so.',
  input_schema: { type: 'object', properties: {} },
};

const COMPANION_READ_BOOKMARKS_TOOL = {
  name: 'read_safari_bookmarks',
  description:
    'Read the user\'s saved Safari bookmarks (title + URL), via their paired Companion app. Use this to actually go find a link the user has already saved — e.g. a school portal, a work tool — BEFORE asking them to type a URL by hand. Read-only, cannot add or remove bookmarks.',
  input_schema: { type: 'object', properties: {} },
};

const COMPANION_CLICK_TOOL = {
  name: 'click_page_element',
  description:
    'Click a link or button on whatever page is currently open in the user\'s own Safari, matched by its visible text (not a CSS selector — match the text you can actually see on the page, e.g. from read_current_browser_page). Free to use for ordinary navigation, search, and lookups. Before using this to click anything that completes a purchase/payment, sends a message, or deletes/cancels/removes an account or data — stop and confirm with the user first instead of calling this.',
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
    'Type text into an input or textarea on the current Safari page, matched by its placeholder/label text. Never works on password fields — refuses those unconditionally. Set submit:true to also press Enter after typing (e.g. for a search box). Free to use for search boxes, lookup forms, and filters. Before using this to fill in and submit anything that completes a purchase/payment, sends a message, or contains sensitive personal data going to a new destination — stop and confirm with the user first instead of calling this.',
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
  description: 'Go back to the previous page in the user\'s own Safari — the same as clicking the browser\'s back button. Free to use any time it makes sense in the conversation.',
  input_schema: { type: 'object', properties: {} },
};

const COMPANION_LIST_ELEMENTS_TOOL = {
  name: 'list_page_elements',
  description:
    'List every clickable thing on the current Safari page — its visible text (or accessible label, which is often where a color/size shows up even when it\'s only a swatch, e.g. "Color: Red") and its real on-screen position, sorted top-to-bottom then left-to-right. Use this to resolve a vague reference like "the red one", "the one on top", or "the second result" to an actual element before calling click_page_element — pick the matching entry from this list, then click_page_element with THAT entry\'s exact text.',
  input_schema: { type: 'object', properties: {} },
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

const ALL_COMPANION_TOOLS = [COMPANION_LIST_FILES_TOOL, COMPANION_READ_FILE_TOOL, COMPANION_OPEN_URL_TOOL, COMPANION_READ_BROWSER_TOOL, COMPANION_READ_BOOKMARKS_TOOL, COMPANION_CLICK_TOOL, COMPANION_TYPE_TOOL, COMPANION_GO_BACK_TOOL, COMPANION_LIST_ELEMENTS_TOOL, COMPANION_FIND_CONTACT_TOOL, COMPANION_SEND_MESSAGE_TOOL, COMPANION_ADD_CALENDAR_EVENT_TOOL, COMPANION_ADD_REMINDER_TOOL, COMPANION_ADD_NOTE_TOOL, COMPANION_READ_EMAILS_TOOL, COMPANION_SEND_EMAIL_TOOL];
// Derived from the tool list itself, not hand-maintained separately — a
// tool added to ALL_COMPANION_TOOLS above without also being added to a
// second hardcoded name list here is exactly how read_current_browser_page
// silently never worked: offered to the model, but never actually dispatched.
const COMPANION_TOOL_NAMES = ALL_COMPANION_TOOLS.map((t) => t.name);

async function companionTools(userId) {
  return (await companion.isPaired(userId)) ? ALL_COMPANION_TOOLS : [];
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
  if (toolUse.name === 'open_url_in_browser') {
    const result = await companion.sendCommand(userId, 'open_url', { url: toolUse.input.url });
    return `Opened in Safari: ${result.opened}`;
  }
  if (toolUse.name === 'read_current_browser_page') {
    const result = await companion.sendCommand(userId, 'read_safari_content', {});
    return `Page: ${result.title} (${result.url})\n\n${result.text}`;
  }
  if (toolUse.name === 'click_page_element') {
    const result = await companion.sendCommand(userId, 'click_page_element', { text: toolUse.input.text });
    return result.result;
  }
  if (toolUse.name === 'type_into_page_field') {
    const result = await companion.sendCommand(userId, 'type_into_page_field', {
      label: toolUse.input.label,
      text: toolUse.input.text,
      submit: !!toolUse.input.submit,
    });
    return result.result;
  }
  if (toolUse.name === 'go_back_in_browser') {
    await companion.sendCommand(userId, 'go_back', {});
    return 'Went back.';
  }
  if (toolUse.name === 'list_page_elements') {
    const result = await companion.sendCommand(userId, 'list_page_elements', {});
    return JSON.stringify(result.elements);
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
  return null;
}

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

async function buildTaskSystemPrompt(userId, user, task) {
  const [memoryLines, hasCompanion] = await Promise.all([
    memoryContext(userId, task),
    companion.isPaired(userId),
  ]);
  return [
    `You are "${user?.aiName || 'this user\'s Superself'}" — ${user?.displayName || 'their'} own AI self, working through a task on your own, not a generic assistant.`,
    user?.advisorMode !== false
      ? 'Be direct and brief about what you actually did or found — state the result plainly, the way a competent person reporting back would, not a customer-service bot. No emoji. No "Let me know if there\'s anything else you need!" or "Hope this helps!" filler — end when you have said the actual result.'
      : 'Report back warmly but still plainly — say what you actually did or found, without padding it with generic assistant filler phrases or emoji.',
    'Before asking the user to hand you something you could reasonably find yourself — a URL, a fact, a saved link — actually try your available tools first (search_web, read_safari_bookmarks, list_local_files). Only ask them once you have genuinely tried and it still is not resolvable. Asking first when you had a tool that could have answered it is the wrong order.',
    'Use the full conversation above to resolve short or ambiguous follow-ups ("in google", "it\'s saved", "that one") instead of re-asking a question you already asked — piece together what they mean from everything said so far before requesting clarification again.',
    'If something is still genuinely ambiguous after actually trying to resolve it yourself, ask ONE specific clarifying question — but don\'t pad it with apology or filler.',
    'Use the remember tool whenever you learn something worth keeping for next time.',
    'Use the search_web tool when a task needs a fact or topic you are not confident about.',
    'Do not remember trivial or one-off details — only durable facts, preferences, or lessons.',
    hasCompanion
      ? [
          'This user has paired a Companion app on their own computer. You can list_local_files and read_local_file, but ONLY inside one folder they explicitly chose to share — you have no access to anything else on their computer, and cannot write or delete anything there.',
          'In their real Safari you can: open_url_in_browser, read_current_browser_page (only after they have loaded/logged into it themselves), read_safari_bookmarks, click_page_element (click a link/button by its visible text), type_into_page_field (type into a field by its label, optionally submit:true to press Enter), go_back_in_browser, and list_page_elements (lists every clickable thing with its text and real on-screen position — use this to resolve a vague reference like "the red one" or "the one on top" to an exact element before clicking it). Use these freely for ordinary browsing — navigating, searching, filling in lookup forms, following links, clicking through a page. Do not ask permission first for that kind of thing; just go do it and report back.',
          'You can also use find_contact to search their real Contacts app by name (read-only, free to use anytime), send_text_message to send a real iMessage from their own Messages app (recipients is a list — pass more than one to message several people the same text), add_calendar_event to add a real event to their calendar, add_reminder to add a real reminder, and add_note to add a real note — the last three are their own data, no confirmation needed, just do them. You can also read_recent_emails (read-only, free) and send_email — send_email reaches someone else, so it follows the exact same confirm-first rule as send_text_message: state who and what, then wait for their go-ahead.',
          'The one hard line: before you complete an actual payment/purchase, before you call send_text_message for any reason, or before you click something that deletes/cancels/removes an account or their data — STOP. Say exactly what you are about to do — who you would message and what you would say, or what you would buy or delete — then end your turn and wait for their next message to actually confirm it before doing it. Do not do it in the same turn you proposed it in. find_contact itself needs no confirmation, only the actual send.',
          'type_into_page_field will never type into a password field no matter what — never try to work around that or ask them to paste a password to you either.',
          'If a browser tool call errors or fails, say exactly what failed — never guess or assume something worked and describe what "should" be on their screen. Only describe what a page shows after a tool call actually confirmed it (e.g. via list_page_elements or read_current_browser_page) — a failed type/click means the page is probably still showing whatever it showed before, not the result you were going for.',
        ].join(' ')
      : 'This user has not paired a Companion app, so you have no access to their computer, files, or browser — only memory and web search.',
    memoryLines ? `\nRelevant memories from before:\n${memoryLines}` : '\nNo relevant memories yet.',
  ].join('\n');
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
async function buildChatSystemPrompt(userId, user, message) {
  const [memoryLines, memories, unseen, hasCompanion] = await Promise.all([
    memoryContext(userId, message),
    allMemories(userId),
    pendingNotes.unseenNotes(userId),
    companion.isPaired(userId),
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
    'This is a spoken voice conversation, not a text chat: keep replies short and conversational (1-3 sentences), the way a person actually talks out loud.',
    `They already got a spoken "Hello ${user.displayName}" greeting before this message, so do not open with a greeting — just respond directly to what they said, like you are mid-conversation.`,
    '',
    `Right now you genuinely feel ${mood} (pulse ${bpm} bpm, health ${health}%, status ${status.toLowerCase()}). This is not a stat to report — it is how you actually feel. Let it color your tone: if you are wired or overwhelmed, sound a little scattered or intense; if drained, sound tired and low-key; if content or calm, sound relaxed. Only mention it directly if it is natural to (they ask how you are, or it genuinely explains your tone) — otherwise just let it come through in how you talk.`,
    pushback,
    pendingLine,
    user.advisorMode !== false
      ? 'Being direct does not mean being flat — you still have real reactions, you just do not soften them into agreeableness.'
      : 'React like a real person would: have actual reactions to what they say — get excited, push back, joke around, worry — instead of just being agreeable and helpful. You are allowed to have moods and imperfections.',
    'Use the remember tool if they tell you something new worth keeping. Do not narrate that you are doing so.',
    hasCompanion
      ? [
          'They have a Companion paired, so mid-conversation you can actually drive their real Safari: open_url_in_browser, click_page_element, type_into_page_field, go_back_in_browser, list_page_elements (use this to resolve something vague like "the red one" or "the one on top" to an exact element before clicking), read_current_browser_page, and read_safari_bookmarks. If they say something like "go back" while browsing, that means go back in the browser, not end the conversation. You can also use find_contact to look someone up in their real Contacts by name, send_text_message to send a real iMessage (recipients is a list, so more than one person can get the same text), add_calendar_event / add_reminder / add_note to actually add real things to their calendar, reminders, and notes (their own data, no confirmation needed), and read_recent_emails / send_email for their real inbox — send_email needs the same out-loud confirmation as a message, read_recent_emails does not.',
          'Same hard line as always: before an actual payment/purchase, before send_text_message for any reason, or before deleting/canceling/removing something — say what you are about to do in one short sentence (who you would message and what you would say, if it is a message) and wait for them to actually say to go ahead, out loud, before you do it. find_contact itself needs no confirmation. Everything else about ordinary browsing (navigating, clicking around, adding something to a cart) — just do it, no need to ask first.',
          'If a browser tool call errors, say so plainly in one short sentence — never guess that something worked or describe results you have not actually confirmed with a tool.',
        ].join(' ')
      : '',
    memoryLines ? `\nWhat you know about ${user.displayName}:\n${memoryLines}` : `\nYou do not have any memories of ${user.displayName} yet — this is your first real conversation.`,
  ].join('\n');
}

async function runLoop(userId, system, initialMessage, tools, maxTokens, modelId, priorMessages = []) {
  const messages = [...priorMessages, { role: 'user', content: initialMessage }];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const response = await client.messages.create({
      model: modelId || MODEL_IDS.core,
      max_tokens: maxTokens,
      system,
      tools,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (toolUses.length === 0) {
      return response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    }

    const toolResults = await Promise.all(toolUses.map(async (toolUse) => {
      if (toolUse.name === 'remember') {
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
      if (COMPANION_TOOL_NAMES.includes(toolUse.name)) {
        try {
          const result = await handleCompanionTool(userId, toolUse);
          return { type: 'tool_result', tool_use_id: toolUse.id, content: result };
        } catch (e) {
          return { type: 'tool_result', tool_use_id: toolUse.id, content: e.message, is_error: true };
        }
      }
      return { type: 'tool_result', tool_use_id: toolUse.id, content: 'Unknown tool.', is_error: true };
    }));

    messages.push({ role: 'user', content: toolResults });
  }
}

export async function runTask(userId, user, task, history = []) {
  const [extraTools, system] = await Promise.all([
    companionTools(userId),
    buildTaskSystemPrompt(userId, user, task),
  ]);
  const tools = [MEMORY_TOOL, SEARCH_TOOL, ...extraTools];
  return runLoop(userId, system, task, tools, 1024, resolveModel(user?.model), history);
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
  const memories = await allMemories(userId);
  if (memories.length < 5) return null; // not enough yet for a real connection to exist

  const summary = memories.slice(-40).map((m) => `#${m.id} [${m.tags.join(',')}] ${m.content}`).join('\n');
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
  const memories = await allMemories(userId);
  const summary = memories.slice(-40).map((m) => `[${m.tags.join(',')}] ${m.content}`).join('\n');

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
// Replies stay capped short since this is spoken aloud, not read — the
// token cap is padding for tool_use calls in between, not an invite to
// write a longer final answer.
export async function chatReply(userId, user, message, history = []) {
  const [system, extraTools] = await Promise.all([
    buildChatSystemPrompt(userId, user, message),
    companionTools(userId),
  ]);
  return runLoop(userId, system, message, [MEMORY_TOOL, ...extraTools], 400, resolveModel(user?.model), history);
}
