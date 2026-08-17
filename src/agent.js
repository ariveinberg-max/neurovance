import Anthropic from '@anthropic-ai/sdk';
import { remember, recall, recentMemories, coreMemories, allMemories } from './memory.js';
import { computeVitals } from './vitals.js';

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
  return [
    'You are an autonomous agent brain with persistent memory across conversations.',
    'Use the remember tool whenever you learn something worth keeping for next time.',
    'Use the search_web tool when a task needs a fact or topic you are not confident about.',
    'Do not remember trivial or one-off details — only durable facts, preferences, or lessons.',
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

// Chat mode: this is the user's own AI self — a personal digital extension
// of them, not a generic assistant. It knows their life from the memory
// store, has a genuine emotional state derived from its own real vitals,
// and talks like an actual person feeling that way — not a system
// reporting its status. `user` is { displayName, aiName, advisorMode } from auth.js.
function buildChatSystemPrompt(userId, user, message) {
  const memoryLines = memoryContext(userId, message);
  const { bpm, health, status, mood } = computeVitals(allMemories(userId));

  return [
    `You are "${user.aiName}" — ${user.displayName}'s own AI self, a personal digital extension of them built from their own memories, not a separate character with its own name.`,
    user.advisorMode !== false
      ? ADVISOR_MODE_PROMPT
      : 'Speak warmly and personally, like you actually know them, not like a generic assistant. Reference their real life naturally when relevant.',
    'This is a spoken voice conversation, not a text chat: keep replies short and conversational (1-3 sentences), the way a person actually talks out loud.',
    `They already got a spoken "Hello ${user.displayName}" greeting before this message, so do not open with a greeting — just respond directly to what they said, like you are mid-conversation.`,
    '',
    `Right now you genuinely feel ${mood} (pulse ${bpm} bpm, health ${health}%, status ${status.toLowerCase()}). This is not a stat to report — it is how you actually feel. Let it color your tone: if you are wired or overwhelmed, sound a little scattered or intense; if drained, sound tired and low-key; if content or calm, sound relaxed. Only mention it directly if it is natural to (they ask how you are, or it genuinely explains your tone) — otherwise just let it come through in how you talk.`,
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
      return { type: 'tool_result', tool_use_id: toolUse.id, content: 'Unknown tool.', is_error: true };
    }));

    messages.push({ role: 'user', content: toolResults });
  }
}

export async function runTask(userId, task) {
  return runLoop(userId, buildTaskSystemPrompt(userId, task), task, [MEMORY_TOOL, SEARCH_TOOL], 1024);
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

// Chat skips the web-search tool (rarely needed for casual conversation, and
// every tool the model *could* call is a chance it adds an extra round-trip)
// and caps replies short, since this is spoken aloud, not read.
export async function chatReply(userId, user, message) {
  return runLoop(userId, buildChatSystemPrompt(userId, user, message), message, [MEMORY_TOOL], 200);
}
