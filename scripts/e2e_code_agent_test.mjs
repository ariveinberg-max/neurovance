// End-to-end integration test for the code agent's FULL-DEVICE-ACCESS loop:
// real disk files + real command execution, wired through the actual modules
// and one real (cheap) model call.
//
//   ENABLE_LOCAL_CODE_EXECUTION=1 CODE_WORKSPACE_DIR=/tmp/e2e-ws \
//     node scripts/e2e_code_agent_test.mjs
//
// Safe: operates only inside CODE_WORKSPACE_DIR (a temp dir by default), so
// it never touches real home files, and creates/edits/runs files there, then
// cleans up. Spends a tiny slice of pre-approved Anthropic quota.

import 'dotenv/config';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const ENABLE = process.env.ENABLE_LOCAL_CODE_EXECUTION === '1';
if (!ENABLE) {
  console.error('Run with ENABLE_LOCAL_CODE_EXECUTION=1 to allow run_command (the point of this test).');
  process.exit(2);
}

// Dedicated temp workspace so nothing real on disk is touched.
const ws = mkdtempSync(join(tmpdir(), 'e2e-code-ws-'));
process.env.CODE_WORKSPACE_DIR = ws;

const { codeAgentPrompt } = await import('../src/agent.js');

const events = [];
const fail = (m) => { console.error('E2E FAIL: ' + m); process.exitCode = 1; };
const pass = (m) => console.log('E2E PASS: ' + m);

try {
  // Seed one real file on disk in the workspace.
  const greetPath = join(ws, 'greet.js');
  writeFileSync(greetPath, `function greet(name) { return "hello " + name; }\nconsole.log(greet("world"));\n`);

  const user = { model: 'pulse', effortLevel: 'low' };
  const { reply, changedFiles, usage } = await codeAgentPrompt(
    'e2e-user', user,
    'Edit greet.js so it also prints the LENGTH of the name. Then run `node greet.js` with run_command to verify it runs. Reply with the output.',
    greetPath, [], (evt) => events.push(evt),
  );

  const types = events.map((e) => e.type);
  console.log('events:', types.join(' -> '));
  if (!types.includes('status')) fail('no status events streamed');
  if (!types.includes('tool')) fail('no tool events streamed');

  const content = readFileSync(greetPath, 'utf8');
  if (!/.length|\blength\b/i.test(content)) fail('greet.js was not edited (no length logic found)');
  else pass('greet.js edited on real disk to include length logic');

  const ranCommand = events.some((e) => e.type === 'tool' && e.name === 'run_command');
  if (!ranCommand) fail('run_command was never invoked');
  else pass('run_command tool invoked against real disk');

  if (usage && (usage.input_tokens || usage.output_tokens)) pass('usage accumulated: ' + (usage.input_tokens + usage.output_tokens) + ' tokens');
  else fail('usage not accumulated');

  if (reply && reply.trim().length >= 5) pass('reply returned (' + reply.trim().split('\n')[0] + ')');
  else fail('no reply returned');

  console.log('\n--- MODEL REPLY ---\n' + reply.trim() + '\n');
} catch (e) {
  console.error('E2E threw:', e);
  process.exitCode = 1;
} finally {
  rmSync(ws, { recursive: true, force: true });
  console.log('teardown complete (temp workspace removed)');
}

if (process.exitCode) console.error('E2E FAILED');
else console.log('E2E OK');