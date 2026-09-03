// Provider router — lets the app call one of several configured LLM
// providers (Anthropic, OpenAI, Gemini/Antigravity, OpenRouter, or any other
// OpenAI-compatible endpoint) so the operator can route model traffic to
// free/cheap tiers instead of paying for every request on the server's own
// Anthropic key.
//
// Architecture: agent.js talks to a single module-level `client` that only
// ever calls `client.messages.create({...})` in the Anthropic Messages wire
// format (system / messages / tools / thinking / max_tokens, returning
// content blocks). That call shape is the contract this module implements, so
// ALL existing call sites keep working unchanged. Under the hood it routes to
// whichever provider is active:
//
//   - Anthropic-mode provider  -> pass-through to the real Anthropic SDK (the
//     native format they speak), zero translation risk in the default path.
//   - OpenAI-mode provider      -> translate the Anthropic messages request to
//     the OpenAI Chat Completions format (used by Anthropic's own OpenAI-compat
//     endpoint, OpenAI, Gemini/Antigravity, OpenRouter, Groq, etc.), then
//     translate the response back into Anthropic content blocks.
//
// Global (server-level) config via env; no per-user keys. Full provider list
// lives in LLM_PROVIDERS as JSON. When no provider is configured, or all
// configured providers fail, this falls back to the server's own
// ANTHROPIC_API_KEY + Claude model — i.e. exactly today's behavior.

import Anthropic from '@anthropic-ai/sdk';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Built-in presets so operators can enable a provider with a one-liner instead
// of hunting for base URLs. Each preset's models map an app model tier
// (pulse = cheap, core = capable) to that provider's model id, per provider.
const PRESETS = {
  anthropic: {
    mode: 'anthropic',
    kind: 'anthropic',
    defaultBaseURL: 'https://api.anthropic.com',
    models: { pulse: 'claude-haiku-4-5-20251001', core: 'claude-sonnet-4-6' },
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    free: false,
  },
  openai: {
    mode: 'openai',
    kind: 'openai',
    defaultBaseURL: 'https://api.openai.com/v1',
    models: { pulse: 'gpt-4o-mini', core: 'gpt-4o' },
    apiKeyEnv: 'OPENAI_API_KEY',
    free: false,
  },
  gemini: {
    mode: 'openai',
    kind: 'gemini',
    defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: { pulse: 'gemini-2.0-flash', core: 'gemini-2.0-flash' },
    apiKeyEnv: 'GEMINI_API_KEY',
    free: true, // free tier exists for Gemini Flash
  },
  antigravity: {
    mode: 'openai',
    kind: 'antigravity',
    defaultBaseURL: 'https://api.antigravity.google/v1beta/openai',
    models: { pulse: 'gemini-3-flash', core: 'gemini-3-pro' },
    apiKeyEnv: 'ANTIGRAVITY_API_KEY',
    free: true,
  },
  openrouter: {
    mode: 'openai',
    kind: 'openrouter',
    defaultBaseURL: 'https://openrouter.ai/api/v1',
    models: { pulse: 'minimax/minimax-m3:free', core: 'minimax/minimax-m3:free' },
    // OpenRouter's :free roster rotates and individual models get rate-limited
    // (429), so keep a set of free alternates to fall through if the primary is
    // unavailable. Order matters: tried in this order after the primary.
    fallbackModels: {
      pulse: ['z-ai/glm-5.2:free', 'google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free', 'minimax/minimax-m2.7:free', 'poolside/laguna-s-2.1:free'],
      core: ['z-ai/glm-5.2:free', 'google/gemma-4-31b-it:free', 'google/gemma-4-26b-a4b-it:free', 'minimax/minimax-m2.7:free', 'poolside/laguna-s-2.1:free'],
    },
    apiKeyEnv: 'OPENROUTER_API_KEY',
    free: true, // OpenRouter has :free model variants
  },
  groq: {
    mode: 'openai',
    kind: 'groq',
    defaultBaseURL: 'https://api.groq.com/openai/v1',
    models: { pulse: 'llama-3.1-8b-instant', core: 'llama-3.3-70b-versatile' },
    apiKeyEnv: 'GROQ_API_KEY',
    free: true,
  },
};

// Reverse map: Claude model id -> tier, so the adapter can take the Claude
// model name a call site passes and map it to the active provider's model.
const CLAUDE_MODEL_TO_TIER = {
  'claude-haiku-4-5-20251001': 'pulse',
  'claude-sonnet-4-6': 'core',
  'claude-3-5-sonnet': 'core',
};

function isNonEmpty(str) { return typeof str === 'string' && str.trim().length > 0; }

// Parse LLM_PROVIDERS (JSON array) plus the *_API_KEY env vars each preset
// references. A provider is "usable" only if it has a resolved key.
function parseProviders() {
  const configured = [];
  try {
    const raw = process.env.LLM_PROVIDERS;
    if (isNonEmpty(raw)) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) configured.push(...parsed);
    }
  } catch (e) {
    // Config parse failure is worth being loud about — silently ignoring a
    // malformed provider list would silently route everything back to the
    // paid default and look like the feature just "didn't work".
    console.error('[providers] LLM_PROVIDERS is not valid JSON — ignoring it. Error:', e.message);
  }
  return configured;
}

// Resolve the provider list to concrete, keyed providers.
//
// Two modes:
//   1. LLM_PROVIDERS is set (JSON)  -> only those providers, in provided order.
//   2. LLM_PROVIDERS is empty       -> auto-discover: enable every preset whose
//      *_API_KEY env var is present (GEMINI_API_KEY, OPENROUTER_API_KEY,
//      OPENAI_API_KEY, ANTHROPIC_API_KEY, ...). This is the "just set a key and
//      go" path — no JSON to hand-write.
function resolveActiveProviders() {
  const explicit = parseProviders();
  const list = explicit.length > 0 ? explicit : autoDiscoverPresets();

  const out = [];
  const seenNames = new Set();
  for (const p of list) {
    const name = String(p.name || '').trim();
    if (!name || seenNames.has(name)) continue;
    seenNames.add(name);

    const presetName = String(p.preset || p.kind || '').trim().toLowerCase();
    const preset = PRESETS[presetName] || null;

    const mode = preset ? preset.mode : (p.mode === 'openai' ? 'openai' : 'openai');
    const baseURL = (p.baseURL && String(p.baseURL).trim()) || preset?.defaultBaseURL || '';
    const apiKey = String(p.apiKey || process.env[p.apiKeyEnv || ''] || '').trim();
    const models = p.models && typeof p.models === 'object' ? p.models : preset?.models || {};
    const free = p.free !== undefined ? !!p.free : !!(preset && preset.free);
    const priority = Number(p.priority) || 0;

    if (!apiKey) continue; // no key -> not usable
    if (mode === 'openai' && !baseURL) continue;
    if (mode === 'anthropic' && !apiKey) continue;

    out.push({ name, mode, kind: preset?.kind || p.kind || 'custom', baseURL, apiKey, models, free, priority,
      fallbackModels: (p.fallbackModels && typeof p.fallbackModels === 'object') ? p.fallbackModels : preset?.fallbackModels || {} });
  }
  return out;
}

// When no explicit LLM_PROVIDERS is configured, enable any preset whose key env
// var is set so adding a single *_API_KEY is enough to route there.
function autoDiscoverPresets() {
  const out = [];
  for (const [presetName, preset] of Object.entries(PRESETS)) {
    // Skip Anthropic — its key is the default fallback, not a "provider" to
    // route to. Keep isProviderConfigured()/pickProvider() meaning "a
    // non-default provider is active".
    if (presetName === 'anthropic') continue;
    if (preset.apiKeyEnv && isNonEmpty(process.env[preset.apiKeyEnv])) {
      out.push({ name: presetName, preset: presetName, apiKey: process.env[preset.apiKeyEnv] });
    }
  }
  return out;
}

export function getActiveProviders() {
  return resolveActiveProviders();
}

// "Route to free/cheap tiers": among usable providers, prefer free ones, then
// by explicit priority (lower = preferred), then by the order they were listed.
// Providers ordered by preference (free first, then priority, then listing
// order) — used both for the single pick and for multi-provider failover.
function orderedProviders() {
  const providers = resolveActiveProviders();
  return [...providers].sort((a, b) => {
    if (a.free !== b.free) return a.free ? -1 : 1;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return 0;
  });
}

export function pickProvider() {
  return orderedProviders()[0] || null;
}

// All providers in preference order, for failover.
function pickProviders() {
  return orderedProviders();
}

// Whether any provider is configured. When false, the server key fallback is
// in effect (today's behavior).
export function isProviderConfigured() {
  return resolveActiveProviders().length > 0;
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

// Given a Claude model string a call site passed, return the tier + the model
// id to actually use on the active provider.
function resolveForProvider(provider, claudeModel) {
  const tier = CLAUDE_MODEL_TO_TIER[claudeModel] || 'core';
  const providerModel = provider.models?.[tier] || provider.models?.core || provider.models?.pulse;
  return { tier, model: providerModel || claudeModel, claudeModel };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible HTTP client + Anthropic<->OpenAI translation
// ---------------------------------------------------------------------------

function anthropicContentToMessages(messages, system) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    const role = m.role;
    const content = m.content;

    // Assistant content that is an array = tool_use / text blocks (Anthropic).
    if (role === 'assistant' && Array.isArray(content)) {
      const toolCalls = content.filter((b) => b.type === 'tool_use').map((b) => ({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
      const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const msg = { role: 'assistant', content: text || '' };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
      continue;
    }

    // User content that is an array = tool_result blocks (Anthropic) -> one
    // OpenAI `tool` message per result.
    if (role === 'user' && Array.isArray(content)) {
      const results = content.filter((b) => b.type === 'tool_result');
      const plainText = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      for (const r of results) {
        const str = typeof r.content === 'string' ? r.content : JSON.stringify(r.content ?? '');
        out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: str });
      }
      if (plainText) out.push({ role: 'user', content: plainText });
      continue;
    }

    // Plain string (or any other) content.
    const text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      : (content || '').toString();
    if (role === 'assistant') out.push({ role: 'assistant', content: text });
    else out.push({ role, content: text });
  }
  return out;
}

function anthropicToolsToOpenAI(tools) {
  return (tools || []).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));
}

function openaiMessageToAnthropicContent(message) {
  const blocks = [];
  if (message.content) blocks.push({ type: 'text', text: message.content });
  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments || '{}'); } catch (e) { input = {}; }
      blocks.push({ type: 'tool_use', id: tc.id || 'call_' + Math.random().toString(36).slice(2, 10), name: tc.function.name, input });
    }
  }
  if (message.refusal) blocks.unshift({ type: 'text', text: message.refusal });
  return blocks;
}

// ---------------------------------------------------------------------------
// The messages.create adapter
// ---------------------------------------------------------------------------

let fallbackAnthropicClient = null;
function getFallbackClient() {
  if (!fallbackAnthropicClient) fallbackAnthropicClient = new Anthropic();
  return fallbackAnthropicClient;
}

export function createProviderClient() {
  return {
    messages: {
      async create(input = {}) {
        // Re-resolve the active providers on every call so config edits pick up
        // without a server restart.
        const providers = pickProviders();

        // No provider configured -> server key, today's exact behavior.
        if (providers.length === 0) {
          const claudeModel = input.model || 'claude-sonnet-4-6';
          return getFallbackClient().messages.create({
            ...input,
            model: claudeModel,
          });
        }

        // Try each provider in preference order; within a provider, try its
        // primary model then any free fallback models (OpenRouter :free rosters
        // rotate and individual models get 429'd). Returns the first success so
        // a rate-limited or dead provider/model never kills the call. Collect
        // errors and surface the first one if everything fails.
        const errors = [];
        for (const provider of providers) {
          const claudeModel = input.model || 'claude-sonnet-4-6';
          let candidates;
          if (provider.mode === 'anthropic') {
            const { model } = resolveForProvider(provider, claudeModel);
            candidates = [model];
          } else {
            const { tier, model } = resolveForProvider(provider, claudeModel);
            const fb = (provider.fallbackModels?.[tier] || []).filter(Boolean);
            candidates = [model, ...fb];
          }
          for (const model of candidates) {
            try {
              if (provider.mode === 'anthropic') {
                const anthropic = new Anthropic({ apiKey: provider.apiKey, baseURL: provider.baseURL || undefined });
                return await anthropic.messages.create({ ...input, model });
              }
              return await openaiCreate(provider, input, model);
            } catch (e) {
              const attemptErr = new Error(`Provider "${provider.name}" (${provider.mode}) model ${model} failed: ${e.message}`);
              attemptErr.cause = e;
              errors.push(attemptErr);
            }
          }
        }

        // Everything failed. Surface which provider(s) tried so it's debuggable
        // — never silently fall back and burn the paid key.
        throw errors[0] || new Error('No configured provider succeeded.');
      },
    },
  };
}

async function openaiCreate(provider, input, model) {
  const body = {
    model,
    messages: anthropicContentToMessages(input.messages || [], input.system),
    max_tokens: input.max_tokens,
  };
  if (Array.isArray(input.tools) && input.tools.length) {
    body.tools = anthropicToolsToOpenAI(input.tools);
  }
  // Extended thinking has no direct OpenAI analogue; the low/default paths
  // sent no thinking anyway. Third-party free tiers rarely support it, so we
  // deliberately omit it when routing to OpenAI-mode providers.

  const resp = await fetch(`${provider.baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
      ...(provider.kind === 'gemini' || provider.kind === 'antigravity'
        ? { 'X-Goog-Api-Key': provider.apiKey }
        : {}),
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status} ${text.slice(0, 400)}`);
  }
  const data = await resp.json();
  const choice = data.choices?.[0];
  if (!choice) throw new Error('Provider returned no choices.');

  return {
    id: data.id || 'chatcmpl-' + Date.now(),
    model: data.model || model,
    content: openaiMessageToAnthropicContent(choice.message || {}),
    usage: {
      input_tokens: data.usage?.prompt_tokens ?? 0,
      output_tokens: data.usage?.completion_tokens ?? 0,
    },
    stop_reason: choice.finish_reason || null,
  };
}

// Keep a default exported client so agent.js's `const client = providerClient()`
// stays a one-line swap.
export const client = createProviderClient();
