// Unit tests for the code-agent disk helpers added for large-file workflows
// and undo: appendToFile, truncateToLineCount, and snapshot/restore.
// Uses a throwaway temp workspace so nothing on the real machine is touched.
//
//   node scripts/test_codefiles.mjs
//
// NOTE: codeFiles.js resolves paths both from CODE_WORKSPACE_DIR / cwd and
// accepts absolute paths, so tests pass absolute temp paths directly.

import { test as run } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let cf;
let root;

const envBak = { ...process.env };
function withEnv(mut) {
  for (const k of Object.keys(process.env)) if (!(k in envBak)) delete process.env[k];
  Object.assign(process.env, envBak);
  Object.assign(process.env, mut);
}

run('setup: temp workspace + fresh import', async () => {
  root = await fsp.mkdtemp(join(tmpdir(), 'cf-test-'));
  withEnv({ CODE_WORKSPACE_DIR: root });
  cf = await import('../src/codeFiles.js?t=' + Date.now());
  const ws = cf.workspaceRoot();
  assert.equal(ws, root, 'workspace root honors CODE_WORKSPACE_DIR');
});

run('appendToFile creates + appends, trailing newline', async () => {
  const p = join(root, 'log.txt');
  await cf.appendToFile('u', p, 'line one');
  await cf.appendToFile('u', p, 'line two');
  const content = (await fsp.readFile(p, 'utf8')).split('\n');
  assert.deepEqual(content.filter(Boolean), ['line one', 'line two']);
});

run('truncateToLineCount keeps first N lines', async () => {
  const p = join(root, 'log.txt');
  const { file, previousLines } = await cf.truncateToLineCount('u', p, 1);
  assert.equal(previousLines, 3, 'three lines existed');
  assert.equal((file.content || '').split('\n').filter(Boolean).length, 1);
});

run('snapshot saved before truncate; restore brings file back', async () => {
  const p = join(root, 'log.txt');
  await cf.appendToFile('u', p, 'more');
  await cf.truncateToLineCount('u', p, 1); // now 1 line
  const beforeRestore = (await fsp.readFile(p, 'utf8')).split('\n').filter(Boolean).length;
  assert.equal(beforeRestore, 1, 'truncated down to 1 line');
  const { restored } = await cf.restoreFileSnapshot('u', p);
  assert.equal(restored, true, 'snapshot exists');
  const content = (await fsp.readFile(p, 'utf8')).split('\n').filter(Boolean);
  assert.ok(content.includes('more'), 'appended line restored from snapshot');
});

run('edit + delete also snapshot; restore after delete recreates', async () => {
  const p = join(root, 'victim.txt');
  await cf.writeCodeFile('u', p, 'original');
  await cf.editCodeFile('u', p, 'original', 'modified');
  await cf.deleteCodeFileByName('u', p);
  assert.equal(await fsp.access(p).then(() => true).catch(() => false), false, 'file deleted');
  const { restored } = await cf.restoreFileSnapshot('u', p);
  assert.equal(restored, true);
  assert.equal(await fsp.readFile(p, 'utf8'), 'modified', 'deleted file restored from snapshot');
});

run('restore with no snapshot reports restored:false', async () => {
  const p = join(root, 'brand-new.txt');
  await cf.writeCodeFile('u', p, 'first'); // first write snapshots nothing (did not exist)
  const { restored } = await cf.restoreFileSnapshot('u', p);
  assert.equal(restored, false, 'no prior snapshot for a freshly created file');
});

run('snapshots dir is hidden from list_code_files (incl. recursive)', async () => {
  const l = await cf.listCodeFiles(root, { recursive: true });
  for (const f of l) assert.ok(!f.name.includes('.agent-snapshots'), 'snapshot dir hidden');
  for (const f of l) assert.ok(!f.name.split('/').pop().startsWith('.'), 'all dotfiles hidden');
});

run('detectRunHints reads package.json scripts (dev/test)', async () => {
  await fsp.writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', test: 'vitest', build: 'vite build' } }));
  const h = await cf.detectRunHints();
  assert.equal(h.dev, 'vite');
  assert.equal(h.test, 'vitest');
  assert.equal(h.build, 'vite build');
  await fsp.unlink(join(root, 'package.json'));
});

run('detectRunHints returns nulls when no package.json', async () => {
  const h = await cf.detectRunHints();
  assert.equal(h.dev, null);
  assert.equal(h.test, null);
});

run('teardown: remove temp workspace', async () => {
  await fsp.rm(root, { recursive: true, force: true });
});