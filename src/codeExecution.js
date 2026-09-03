import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import net from 'net';
import { listCodeFiles } from './codeFiles.js';
import { assertSpendSafeShell } from './spend-safety.js';

// Real process execution — spawning real interpreters, real dev servers,
// real ports — for the Code panel's "Run" button. This is the one part of
// Neurovance that can never be allowed to run on the live, shared,
// multi-tenant deployment: any signed-up stranger with a browser tab could
// otherwise run arbitrary code on the same server holding every other
// user's data. ENABLE_LOCAL_CODE_EXECUTION is set only in this repo's local
// .env, never in Render's environment — every exported function here
// checks it and refuses outright when it's unset, which is the production
// default. Ari runs this locally for his own dev use; nobody using the
// live app gets execution.
export function isExecutionEnabled() {
  return process.env.ENABLE_LOCAL_CODE_EXECUTION === '1';
}

// Fixed preview port every "Run" binds to, injected as $PORT so generated
// server code (the codeAgentPrompt system prompt tells the model to read
// it) doesn't need its own port-picking logic, and the frontend always
// knows what URL to preview.
export const PREVIEW_PORT = 3999;

const RUNTIME_BY_EXT = {
  js: ['node'], mjs: ['node'], cjs: ['node'],
  py: ['python3'],
  rb: ['ruby'],
  sh: ['bash'],
  go: ['go', 'run'],
};

// One running process per user at a time — this is a personal local dev
// tool, not a multi-session job queue. Starting a new run always stops
// whatever was running first.
const runningByUser = new Map(); // userId -> { proc, port, output: string[], startedAt, status, workDir }

function workDirFor(userId) {
  const safe = String(userId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'unknown';
  return join(tmpdir(), 'neurovance-exec', safe);
}

// Always wipes and rewrites every file fresh from Firestore before running,
// rather than trying to diff/sync — the workspace is small (a personal
// code panel, not a real repo), and this guarantees the disk never drifts
// from what's actually saved, e.g. a file deleted in the UI can't linger
// on disk and get accidentally executed.
async function materializeFiles(userId) {
  const dir = workDirFor(userId);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files = await listCodeFiles(userId);
  for (const file of files) {
    writeFileSync(join(dir, file.name), file.content || '');
  }
  return { dir, files };
}

// package.json present -> npm project (install + run its dev/start script).
// Otherwise a single script file, run directly with the right interpreter.
// Deliberately simple entrypoint rules — this is a personal scratch
// workspace, not a real project layout, so "guess intelligently across a
// nested file tree" isn't worth the complexity it'd add.
function planRun(dir, files) {
  const hasPackageJson = files.some((f) => f.name === 'package.json');
  if (hasPackageJson) {
    let scripts = {};
    try {
      const pkg = JSON.parse(files.find((f) => f.name === 'package.json').content || '{}');
      scripts = pkg.scripts || {};
    } catch (e) {
      throw new Error('package.json is not valid JSON.');
    }
    const scriptName = scripts.dev ? 'dev' : scripts.start ? 'start' : null;
    if (!scriptName) throw new Error('package.json has no "dev" or "start" script to run.');
    return { needsInstall: true, command: 'npm', args: ['run', scriptName] };
  }

  const runnable = files.filter((f) => RUNTIME_BY_EXT[f.name.split('.').pop()?.toLowerCase()]);
  if (runnable.length === 0) throw new Error('No runnable file found (.js, .py, .rb, .sh, .go) and no package.json.');
  const entry =
    runnable.find((f) => /^(main|index|app|server)\./i.test(f.name)) || runnable[0];
  if (runnable.length > 1 && !/^(main|index|app|server)\./i.test(entry.name)) {
    throw new Error(`Multiple runnable files and no clear entry point — name one "main.${entry.name.split('.').pop()}" to pick it.`);
  }
  const ext = entry.name.split('.').pop().toLowerCase();
  const [cmd, ...baseArgs] = RUNTIME_BY_EXT[ext];
  return { needsInstall: false, command: cmd, args: [...baseArgs, entry.name] };
}

function appendOutput(state, line) {
  state.output.push(line);
  if (state.output.length > 500) state.output.shift(); // bounded — this is a live log, not an archive
}

function waitForPort(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tryOnce = () => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(tryOnce, 250);
      });
    };
    tryOnce();
  });
}

// Never inherit the server's full env into spawned user code. The server's
// process.env carries the real secrets (ANTHROPIC_API_KEY, FIREBASE_PRIVATE_KEY,
// GOOGLE_CLIENT_SECRET, GMAIL_APP_PASSWORD, Stripe) and a script the user wrote
// — or a malicious dependency npm install pulls in — could read any of them by
// just listing process.env. The generated code gets the bare minimum it needs
// to actually run: PATH (so npm/node find their own bits) and the preview port.
function childEnv(port) {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: process.env.HOME || '',
    PORT: String(port),
  };
}

export function stopRun(userId) {
  const state = runningByUser.get(userId);
  if (!state) return false;
  clearTimeout(state.killTimer);
  try { state.proc?.kill('SIGKILL'); } catch (e) {}
  runningByUser.delete(userId);
  return true;
}

export function getRunStatus(userId) {
  const state = runningByUser.get(userId);
  if (!state) return { status: 'stopped' };
  return {
    status: state.status,
    output: state.output.join(''),
    previewUrl: state.status === 'running' ? `http://localhost:${PREVIEW_PORT}` : null,
    startedAt: state.startedAt,
  };
}

export async function startRun(userId) {
  if (!isExecutionEnabled()) throw new Error('Code execution is disabled in this environment.');
  stopRun(userId); // only one run at a time

  const { dir, files } = await materializeFiles(userId);
  if (files.length === 0) throw new Error('Nothing to run — the workspace is empty.');
  const plan = planRun(dir, files);

  const state = { proc: null, output: [], startedAt: new Date().toISOString(), status: 'installing', workDir: dir };
  runningByUser.set(userId, state);

  const runProcess = () => {
    state.status = 'running';
    const proc = spawn(plan.command, plan.args, {
      cwd: dir,
      env: childEnv(PREVIEW_PORT),
    });
    state.proc = proc;
    // Hard watchdog: a script that spins forever (a `while(true)`, an
    // embedded dev server that never exits) got to occupy a process and a
    // port indefinitely. A generous cap forces it to die and reports it.
    const MAX_RUN_MS = 30 * 60 * 1000;
    state.killTimer = setTimeout(() => {
      if (runningByUser.get(userId) === state && state.status === 'running') {
        appendOutput(state, '\n[process killed after 30 minute run limit]\n');
      }
      stopRun(userId);
    }, MAX_RUN_MS);
    proc.stdout.on('data', (d) => appendOutput(state, d.toString()));
    proc.stderr.on('data', (d) => appendOutput(state, d.toString()));
    proc.on('exit', (code) => {
      clearTimeout(state.killTimer);
      appendOutput(state, `\n[process exited with code ${code}]\n`);
      if (runningByUser.get(userId) === state) state.status = 'exited';
    });
    proc.on('error', (e) => {
      appendOutput(state, `\n[failed to start: ${e.message}]\n`);
      if (runningByUser.get(userId) === state) state.status = 'error';
    });
  };

  if (plan.needsInstall) {
    appendOutput(state, '$ npm install\n');
    const install = spawn('npm', ['install'], { cwd: dir, env: childEnv(PREVIEW_PORT) });
    install.stdout.on('data', (d) => appendOutput(state, d.toString()));
    install.stderr.on('data', (d) => appendOutput(state, d.toString()));
    install.on('exit', (code) => {
      if (runningByUser.get(userId) !== state) return; // stopped/replaced while installing
      if (code !== 0) {
        appendOutput(state, `\n[npm install failed with code ${code}]\n`);
        state.status = 'error';
        return;
      }
      appendOutput(state, `$ npm run ${plan.args[1]}\n`);
      runProcess();
    });
  } else {
    appendOutput(state, `$ ${plan.command} ${plan.args.join(' ')}\n`);
    runProcess();
  }

  const portOpen = await waitForPort(PREVIEW_PORT, 12000);
  return { status: state.status, previewUrl: portOpen ? `http://localhost:${PREVIEW_PORT}` : null };
}

// One-shot shell command for the code agent's run_command tool. Unlike
// startRun (which picks a single entrypoint and binds a fixed preview port),
// this executes an arbitrary command the model chose, against the workspace
// materialized from Firestore, with three layers of protection:
//
//  1. Spend-safety blocklist (assertSpendSafeShell) — a command mentioning a
//     billing/ad-spend command or provider is refused before anything spawns.
//     Same guard a normal terminal user gets, applied to model-chosen shells.
//  2. Sanitized env (childEnv) — no real secrets leak into the child; it only
//     gets PATH/HOME/PORT, so a tricky `env` dump finds nothing worth exfil.
//  3. Hard timeout + output bound — a runaway (`while(true)`, slow build) is
//     killed and its output truncated, so one bad command can't hang the loop
//     or blow up context memory.
//
// Gated the same as everything else here by isExecutionEnabled(), so it's a
// no-op that throws on the shared deployment.
export async function runCommand(userId, opts = {}) {
  if (!isExecutionEnabled()) throw new Error('Code execution is disabled in this environment.');
  const command = String(opts.command || '').trim();
  if (!command) throw new Error('run_command needs a non-empty command.');
  const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 30000, 1000), 120000);

  assertSpendSafeShell(command);

  const dir = workDirFor(userId);
  await materializeFiles(userId);

  const MAX_OUTPUT_CHARS = 12000;
  let output = '';
  let killed = false;

  const result = await new Promise((resolve) => {
    let settled = false;
    const child = spawn(command, { cwd: dir, env: childEnv(0), shell: true });
    let killTimer;
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(killTimer); resolve(r); } };
    killTimer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch (e) {}
    }, timeoutMs);
    const onOutput = (chunk) => {
      if (output.length >= MAX_OUTPUT_CHARS) return;
      output += chunk;
      if (output.length > MAX_OUTPUT_CHARS) {
        output = output.slice(0, MAX_OUTPUT_CHARS);
        output += '\n…[output truncated at 12,000 chars]\n';
      }
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.on('error', (e) => finish({ exited: false, error: e.message }));
    child.on('exit', (code, signal) => finish({ exited: true, code, signal, killed }));
  });

  if (result.killed) {
    return {
      ok: false,
      output: `${output.trim()}\n\n[command timed out after ${timeoutMs}ms and was killed]\n`.trim(),
      timedOut: true,
    };
  }
  if (result.error) {
    return { ok: false, output: `[failed to start: ${result.error}]`, timedOut: false };
  }
  return {
    ok: result.code === 0,
    code: result.code,
    output: output.trim() || '(no output)',
    timedOut: false,
  };
}
