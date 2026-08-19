#!/usr/bin/env node
// Neurovance Companion — runs on your own computer, not in the cloud.
//
// What it can do: read files inside one folder (~/Documents/Neurovance) and
// open https:// links in Safari, only when your own paired Superself asks.
// What it can't do: touch anything outside that folder, write or delete
// anything, or run arbitrary commands. That boundary is enforced right here,
// not on the server — the server only ever sees what this file lets it see.
import WebSocket from 'ws';
import { createInterface } from 'readline';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { homedir, hostname } from 'os';
import { join, resolve, sep } from 'path';
import { execFile } from 'child_process';

const CONFIG_DIR = join(homedir(), '.neurovance');
const CONFIG_PATH = join(CONFIG_DIR, 'companion-config.json');
const ALLOWED_ROOT = join(homedir(), 'Documents', 'Neurovance');
const SERVER_WS_URL = process.env.NEUROVANCE_WS_URL || 'wss://app.neurovance.dev/companion-ws';
const MAX_READ_BYTES = 200_000;

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

function saveConfig(config) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function ensureAllowedRoot() {
  if (!existsSync(ALLOWED_ROOT)) {
    mkdirSync(ALLOWED_ROOT, { recursive: true });
    writeFileSync(
      join(ALLOWED_ROOT, 'README.txt'),
      'This folder — and only this folder — is what your Neurovance Superself can read on this computer.\n' +
      'Nothing outside it is reachable. It can read, not write or delete.\n' +
      'Drop in whatever you want it to be able to see.\n'
    );
  }
}

// The one thing standing between "read files in a folder" and "read any
// file on this computer" — has to hold for every input, including
// "../../../etc/passwd" or an absolute path.
function resolveScoped(relativePath) {
  const target = resolve(ALLOWED_ROOT, relativePath || '.');
  if (target !== ALLOWED_ROOT && !target.startsWith(ALLOWED_ROOT + sep)) {
    throw new Error('That path is outside the allowed Neurovance folder.');
  }
  return target;
}

function handleCommand(action, params) {
  if (action === 'list_files') {
    const dir = resolveScoped(params.subpath || '');
    if (!statSync(dir).isDirectory()) throw new Error('Not a folder.');
    return readdirSync(dir, { withFileTypes: true }).map((e) => ({
      name: e.name,
      type: e.isDirectory() ? 'folder' : 'file',
    }));
  }

  if (action === 'read_file') {
    const filePath = resolveScoped(params.path);
    const stat = statSync(filePath);
    if (!stat.isFile()) throw new Error('Not a file.');
    if (stat.size > MAX_READ_BYTES) throw new Error(`File is too large to read (limit ${MAX_READ_BYTES / 1000}KB).`);
    return readFileSync(filePath, 'utf-8');
  }

  if (action === 'open_url') {
    const url = params.url || '';
    if (!/^https:\/\//.test(url)) throw new Error('Only https:// URLs are allowed.');
    // execFile (no shell) + stripped quotes = the URL can't break out of the
    // AppleScript string literal or reach a shell at all.
    const safeUrl = url.replace(/"/g, '');
    return new Promise((res, rej) => {
      execFile('osascript', ['-e', `tell application "Safari" to open location "${safeUrl}"`], (err) => {
        if (err) rej(new Error('Could not open Safari: ' + err.message));
        else res({ opened: safeUrl });
      });
    });
  }

  throw new Error(`Unknown action: ${action}`);
}

function connect(userId) {
  const ws = new WebSocket(SERVER_WS_URL);

  ws.on('open', () => {
    if (userId) ws.send(JSON.stringify({ type: 'reconnect', userId }));
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'pair_result') {
      if (msg.ok) {
        saveConfig({ userId: msg.userId });
        console.log('Paired. Your Superself can now read from:\n  ' + ALLOWED_ROOT);
      } else {
        console.error('Pairing failed:', msg.error);
        process.exit(1);
      }
      return;
    }

    if (msg.type === 'reconnect_result') {
      console.log(msg.ok ? 'Connected.' : 'Reconnect rejected — delete ~/.neurovance/companion-config.json and pair again.');
      return;
    }

    if (msg.type === 'command') {
      try {
        const data = await handleCommand(msg.action, msg.params || {});
        ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, data }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: e.message }));
      }
    }
  });

  ws.on('close', () => {
    console.log('Disconnected — retrying in 5s...');
    setTimeout(() => connect(userId), 5000);
  });

  ws.on('error', (e) => console.error('Connection error:', e.message));

  return ws;
}

function promptForCode() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Enter the pairing code shown on neurovance.dev: ', (code) => {
    rl.close();
    const ws = connect(null);
    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'pair', code: code.trim(), hostname: hostname() }));
    });
  });
}

ensureAllowedRoot();
console.log(`Neurovance Companion\nThis computer will only ever share files from:\n  ${ALLOWED_ROOT}\n`);

const config = loadConfig();
if (config?.userId) {
  connect(config.userId);
} else {
  promptForCode();
}
