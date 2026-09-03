// Unit tests for the provider router. Covers:
//  - free-tier auto-pick (prefer free providers, then priority)
//  - provider parse from env (LLM_PROVIDERS JSON + preset keys)
//  - Anthropic<->OpenAI wire translation via a real in-process mock server
//  - server-key fallback when no provider is configured
//  - error surfacing (provider name in the message)
//
//   node scripts/test_providers.mjs

import { test as run } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// NOTE: providers.js reads env at call-time via pickProvider()/getActiveProviders(),
// so we can mutate process.env between tests without reimporting.
let providers;
const envBak = { ...process.env };

function withEnv(mut) {
  for (const k of Object.keys(process.env)) if (!(k in envBak)) delete process.env[k];
  Object.assign(process.env, envBak);
  for (const [k, v] of Object.entries(mut)) process.env[k] = v;
}

async function bootstrap() {
  const mod = await import('../src/providers.js?t=' + Date.now());
  providers = mod;
}

const mockPayload = (text, toolCalls) => ({
  id: 'chatcmpl-test',
  model: 'mock-model',
  usage: { prompt_tokens: 11, completion_tokens: 7 },
  choices: [{
    finish_reason: toolCalls ? 'tool_calls' : 'stop',
    message: {
      role: 'assistant',
      content: text ?? null,
      ...(toolCalls ? { tool_calls: toolCalls } : {}),
    },
  }],
});

run('module loads', async () => { await bootstrap(); });

run('free provider preferred over paid at same priority', async () => {
  withEnv({
    LLM_PROVIDERS: JSON.stringify([
      { name: 'paid', preset: 'openai', apiKey: 'sk-paid' },
      { name: 'gentle', preset: 'gemini', apiKey: 'AI-free' },
    ]),
    OPENAI_API_KEY: '', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: 'server-key',
  });
  const p = providers.pickProvider();
  assert.equal(p.name, 'gentle', 'should pick the free provider first');
});

run('priority orders providers within same free-ness', async () => {
  withEnv({
    LLM_PROVIDERS: JSON.stringify([
      { name: 'groq', preset: 'groq', apiKey: 'a', priority: 2 },
      { name: 'openrouter', preset: 'openrouter', apiKey: 'b', priority: 1 },
    ]),
    ANTHROPIC_API_KEY: 'server-key',
  });
  assert.equal(providers.pickProvider().name, 'openrouter', 'lower priority number wins');
});

run('provider without a key is skipped', async () => {
  withEnv({
    LLM_PROVIDERS: JSON.stringify([
      { name: 'nokey', preset: 'openai' },
      { name: 'haskey', preset: 'groq', apiKey: 'real' },
    ]),
    ANTHROPIC_API_KEY: 'server-key',
  });
  assert.equal(providers.pickProvider().name, 'haskey');
});

run('no providers configured -> null (fallback to server key)', async () => {
  withEnv({ LLM_PROVIDERS: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: 'server-key' });
  assert.equal(providers.pickProvider(), null);
  assert.equal(providers.isProviderConfigured(), false);
});

run('anthropic<->openai single text round trip', async () => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      assert.equal(req.url, '/v1/chat/completions');
      const parsed = JSON.parse(body);
      assert.equal(parsed.model, 'gpt-4o', 'core Claude name -> openai core model');
      assert.equal(parsed.messages[0].role, 'system');
      assert.equal(parsed.messages[1].content, 'hi');
      assert.equal(req.headers.authorization, 'Bearer sk-x', 'auth header set');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(mockPayload('hello back')));
    });
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  withEnv({
    LLM_PROVIDERS: JSON.stringify([{ name: 'openai', preset: 'openai', apiKey: 'sk-x', baseURL: `http://127.0.0.1:${port}/v1` }]),
    ANTHROPIC_API_KEY: 'server-key',
  });

  const out = await providers.createProviderClient().messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 200,
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(out.content[0].type, 'text');
  assert.equal(out.content[0].text, 'hello back');
  assert.equal(out.usage.input_tokens, 11);
  assert.equal(out.usage.output_tokens, 7);
  server.close();
});

run('tool-use protocol round trip (assistant tool_use -> tool_calls -> tool result)', async () => {
  let stage = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      res.setHeader('content-type', 'application/json');
      if (stage === 0) {
        // first turn: model calls a tool
        assert.ok(Array.isArray(parsed.tools) && parsed.tools[0].function.name === 'remember', 'tools translated');
        // the tool_result user message should have already been converted to tool role BEFORE this call? No — this is turn 1.
        res.end(JSON.stringify(mockPayload(null, [{
          id: 'call_1',
          type: 'function',
          function: { name: 'remember', arguments: JSON.stringify({ content: 'x' }) },
        }])));
        stage++;
      } else {
        // second turn: the prior assistant tool_use -> assistant tool_calls, and
        // the tool_result user message -> role:'tool'
        const toolIdx = parsed.messages.findIndex((m) => m.role === 'tool');
        assert.ok(toolIdx >= 0, 'tool result became a tool-role message');
        assert.equal(parsed.messages[toolIdx].tool_call_id, 'call_1', 'tool_call_id maps across');
        assert.equal(parsed.messages[toolIdx].content, 'Saved.', 'tool result content carried');
        const asst = parsed.messages.find((m) => m.role === 'assistant');
        assert.ok(asst.tool_calls && asst.tool_calls[0].id === 'call_1', 'assistant tool use -> tool_calls');
        res.end(JSON.stringify(mockPayload('done')));
      }
    });
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  withEnv({
    LLM_PROVIDERS: JSON.stringify([{ name: 'openai', preset: 'openai', apiKey: 'sk-x', baseURL: `http://127.0.0.1:${port}/v1` }]),
    ANTHROPIC_API_KEY: 'server-key',
  });
  const client = providers.createProviderClient();

  const out1 = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 200,
    system: 'sys',
    tools: [{ name: 'remember', description: 'save', input_schema: { type: 'object', properties: { content: { type: 'string' } }, required: [] } }],
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(out1.content[0].type, 'tool_use');
  assert.equal(out1.content[0].name, 'remember');

  const out2 = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 200,
    system: 'sys',
    tools: [{ name: 'remember', description: 'save', input_schema: { type: 'object', properties: { content: { type: 'string' } }, required: [] } }],
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: out1.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: out1.content[0].id, content: 'Saved.' }] },
    ],
  });
  assert.equal(out2.content[0].text, 'done');
  server.close();
});

run('provider failure surfaces provider name', async () => {
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => { res.statusCode = 500; res.end('boom'); });
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  withEnv({
    LLM_PROVIDERS: JSON.stringify([{ name: 'BadCo', preset: 'openai', apiKey: 'sk-x', baseURL: `http://127.0.0.1:${port}/v1` }]),
    ANTHROPIC_API_KEY: 'server-key',
  });
  await assert.rejects(
    () => providers.createProviderClient().messages.create({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] }),
    /Provider "BadCo"/,
  );
  server.close();
});

run('Claude model -> provider model mapping', async () => {
  withEnv({
    LLM_PROVIDERS: JSON.stringify([{ name: 'gem', preset: 'gemini', apiKey: 'AI-z' }]),
    ANTHROPIC_API_KEY: 'server-key',
  });
  const p = providers.pickProvider();
  assert.equal(p.models.pulse, 'gemini-2.0-flash');
});
