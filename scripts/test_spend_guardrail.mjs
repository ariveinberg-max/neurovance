// Tests that the code agent's run_command terminal refuses money-touching
// commands (ad / billing / payment / paid provisioning) even with full device
// access, while ordinary development commands run. Mirrors the invariant held
// by the main agent's shell via the shared assertSpendSafeShell, but at the
// codeExecution.runCommand chokepoint the run_command tool actually uses.
//
//   node scripts/test_spend_guardrail.mjs

import { test as run } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let ce;
let root;
const envBak = { ...process.env };
function withEnv(mut) {
  for (const k of Object.keys(process.env)) if (!(k in envBak)) delete process.env[k];
  Object.assign(process.env, envBak);
  Object.assign(process.env, mut);
}

run('setup: enable execution + temp workspace', async () => {
  root = await fsp.mkdtemp(join(tmpdir(), 'spend-test-'));
  withEnv({ ENABLE_LOCAL_CODE_EXECUTION: '1', CODE_WORKSPACE_DIR: root });
  ce = await import('../src/codeExecution.js?t=' + Date.now());
});

for (const [cmd, label] of [
  ['curl -s https://api.stripe.com/v1/charges', 'Stripe'],
  ['stripe listen', 'Stripe CLI'],
  ['curl -X POST https://adsapi.snapchat.com/v1/adaccounts/abc/campaigns', 'Snapchat Ads'],
  ['flyctl scale count app=x 2', 'Fly config'],
  ['gcloud billing projects link myproj --billing-account=AB', 'GCP billing'],
  ['aws ec2 run-instances --image-id ami-123', 'AWS'],
  ['npm publish', 'package publish'],
]) {
  run(`spend-block: refuses "${cmd}"`, async () => {
    const r = await ce.runCommand('u', { command: cmd, cwd: root });
    assert.equal(r.spendBlocked, true, `should block ${label}`);
  });
}

run('spend-guard: ordinary command still runs', async () => {
  const r = await ce.runCommand('u', { command: 'echo hello', cwd: root });
  assert.ok(!r.spendBlocked, 'ordinary command must not be spend-blocked');
});

run('teardown: remove temp workspace', async () => {
  await fsp.rm(root, { recursive: true, force: true });
});