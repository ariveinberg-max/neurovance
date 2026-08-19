import Anthropic from '@anthropic-ai/sdk';
import { remember, recall, recentMemories, coreMemories, allMemories, findMemory, updateMemory } from './memory.js';
import { computeVitals } from './vitals.js';
import * as companion from './companion.js';
import * as pendingNotes from './pending-notes.js';

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

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

function companionTools(userId) {
  return companion.isPaired(userId)
    ? [COMPANION_LIST_FILES_TOOL, COMPANION_READ_FILE_TOOL, COMPANION_OPEN_URL_TOOL]
    : [];
}

async function handleCompanionTool(userId, toolUse) {
  if (toolUse.name === 'list_local_files') {
    const files = await companion.sendCommand(userId, 'list_files', { subpath: toolUse.input.subpath || '' });
    return JSON.stringify(files);
  }
  if (toolUse.name === 'read_local_file') {
    return await companion.sendCommand(userId, 'read_file', { path: toolUse.input.path });
  }
  if (toolUse.name === 'open_url_in_browser') {
    const result = await companion.sendCommand(userId, 'open_url', { url: toolUse.input.url });
    return `Opened in Safari: ${result.opened}`;
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

function memoryContext(userId, query) {
  // Keyword recall alone misses paraphrased or indirect phrasing constantly
  // (voice conversation rarely reuses a memory's exact words), so core
  // identity facts are always included regardless of whether this turn's
  // wording happens to overlap with them.
  const core = coreMemories(userId, 8);
  const relevant = recall(userId, query, 5);
  const recent = recentMemories(userId, 3);
  const seen = new Set();
  const combined = [...core, ...relevant, ...recent]
    .filter((m) => (seen.has(m.id) ? false : seen.add(m.id)));

  lastRecallByUser.set(userId, { ids: combined.map((m) => m.id), ts: Date.now() });

  return combined
    .map((m) => `- [${m.timestamp.slice(0, 10)}] ${m.content}`)
    .join('\n');
}

function buildTaskSystemPrompt(userId, task) {
  const memoryLines = memoryContext(userId, task);
  const hasCompanion = companion.isPaired(userId);
  return [
    'You are an autonomous agent brain with persistent memory across conversations.',
    'Use the remember tool whenever you learn something worth keeping for next time.',
    'Use the search_web tool when a task needs a fact or topic you are not confident about.',
    'Do not remember trivial or one-off details — only durable facts, preferences, or lessons.',
    hasCompanion
      ? 'This user has paired a Companion app on their own computer. You can list_local_files and read_local_file, but ONLY inside one folder they explicitly chose to share — you have no access to anything else on their computer, and cannot write or delete anything. You can also open_url_in_browser to open a link in their real Safari. Do not imply you can see or touch anything beyond that one folder.'
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
function buildChatSystemPrompt(userId, user, message) {
  const memoryLines = memoryContext(userId, message);
  const { bpm, health, status, mood } = computeVitals(allMemories(userId));
  const pushback = vitalsPushbackLine(status, health);

  // Surface at most one unprompted thing per turn — an insight from dreaming,
  // a curiosity question, or something the Companion noticed — and only if
  // it actually fits, not forced into every reply.
  const pending = pendingNotes.unseenNotes(userId)[0];
  if (pending) pendingNotes.markSeen(userId, pending.id);
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
    memoryLines ? `\nWhat you know about ${user.displayName}:\n${memoryLines}` : `\nYou do not have any memories of ${user.displayName} yet — this is your first real conversation.`,
  ].join('\n');
}

async function runLoop(userId, system, initialMessage, tools, maxTokens) {
  const messages = [{ role: 'user', content: initialMessage }];

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
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
        const entry = remember(userId, content, tags, importance);
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
      if (['list_local_files', 'read_local_file', 'open_url_in_browser'].includes(toolUse.name)) {
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

export async function runTask(userId, task) {
  const tools = [MEMORY_TOOL, SEARCH_TOOL, ...companionTools(userId)];
  return runLoop(userId, buildTaskSystemPrompt(userId, task), task, tools, 1024);
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

    const toolResults = toolUses.map((toolUse) => {
      const { content, tags, importance } = toolUse.input;
      const entry = remember(userId, content, tags, importance);
      saved.push(entry);
      return { type: 'tool_result', tool_use_id: toolUse.id, content: `Saved as memory #${entry.id}.` };
    });
    messages.push({ role: 'user', content: toolResults });
  }

  return saved;
}

// "Dreaming": revisits existing memories the way a mind makes connections
// between things while not actively thinking about them, and looks for one
// genuinely non-obvious link — not something already stated directly. Meant
// to run in the background (grow.js), not on-demand from the UI.
export async function runDreamCycle(userId) {
  const memories = allMemories(userId);
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

  const entry = remember(userId, text, ['insight'], 3);
  pendingNotes.addNote(userId, 'insight', text);
  return entry;
}

// Active curiosity: instead of only absorbing whatever it's told, it looks
// for a real gap in what it knows and comes up with one specific, natural
// question worth asking next time — queued as a pending note the chat flow
// can bring up when there's a natural opening.
export async function runCuriosityCycle(userId) {
  const memories = allMemories(userId);
  const summary = memories.slice(-40).map((m) => `[${m.tags.join(',')}] ${m.content}`).join('\n');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 150,
    system: 'Given what is known about this person so far, find ONE genuinely interesting gap — something mentioned only in passing, or a natural follow-up nobody has asked. Write ONE short, specific, natural-sounding question to ask them next time — not a generic "tell me about yourself". Output only the question, nothing else.',
    messages: [{ role: 'user', content: summary || 'Nothing is known about this person yet.' }],
  });
  const question = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!question) return null;

  pendingNotes.addNote(userId, 'curiosity', question);
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
  const target = findMemory(userId, memoryId);
  if (!target) throw new Error(`No memory #${memoryId} found.`);

  const related = recall(userId, `${target.content} ${target.tags.join(' ')}`, 6).filter((m) => m.id !== memoryId);
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

    const toolResults = toolUses.map((toolUse) => {
      const entry = updateMemory(userId, toolUse.input.id, toolUse.input.content);
      updated.push(entry);
      return { type: 'tool_result', tool_use_id: toolUse.id, content: `Updated memory #${entry.id}.` };
    });
    messages.push({ role: 'user', content: toolResults });
  }

  // The model choosing not to call the tool at all would otherwise mean the
  // user's correction silently does nothing — fall back to a direct
  // overwrite of the memory they actually flagged.
  if (updated.length === 0) {
    updated.push(updateMemory(userId, memoryId, correctionText));
  }

  return updated;
}

// Chat skips the web-search tool (rarely needed for casual conversation, and
// every tool the model *could* call is a chance it adds an extra round-trip)
// and caps replies short, since this is spoken aloud, not read.
export async function chatReply(userId, user, message) {
  return runLoop(userId, buildChatSystemPrompt(userId, user, message), message, [MEMORY_TOOL], 200);
}
