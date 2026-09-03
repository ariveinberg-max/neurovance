// Real-disk code filesystem — the code panel's file store runs directly on
// the device's actual files instead of a per-user Firestore virtual workspace.
//
// This is the "full device access like Claude Code" mode: the agent can read,
// write, edit and delete real files, plus run arbitrary commands against the
// real machine. The workspace root (CODE_WORKSPACE_DIR, default the process
// cwd / home) is where the panel's file tree roots, but paths are otherwise
// unrestricted — any absolute path on the machine is reachable, and relative
// paths resolve from the workspace root.
//
// No spend-safety path filter here by design: the operator chose "full trust"
// for the code panel. The inviolable spend rule still guards every OTHER shell
// path in the app; only this self-hosted local code panel lifts it.

import { promises as fsp } from 'fs';
import { dirname, join, resolve, extname, basename, isAbsolute } from 'path';
import { homedir } from 'os';

const EXT_LANGUAGE_MAP = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'text/typescript', tsx: 'text/jsx',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'text/x-java', c: 'text/x-csrc', h: 'text/x-csrc',
  cpp: 'text/x-c++src', hpp: 'text/x-c++src', cs: 'text/x-csharp',
  html: 'htmlmixed', htm: 'htmlmixed', css: 'css', json: 'application/json',
  md: 'markdown', sh: 'shell', bash: 'shell', sql: 'text/x-sql', yaml: 'yaml', yml: 'yaml',
  php: 'php',
};
export function guessLanguage(filename) {
  const e = extname(filename).slice(1).toLowerCase();
  return EXT_LANGUAGE_MAP[e] || 'text/plain';
}

const LANGUAGE_DISPLAY_NAMES = {
  javascript: 'JavaScript', jsx: 'JSX', 'text/typescript': 'TypeScript', 'text/jsx': 'TSX',
  python: 'Python', ruby: 'Ruby', go: 'Go', rust: 'Rust',
  'text/x-java': 'Java', 'text/x-csrc': 'C', 'text/x-c++src': 'C++', 'text/x-csharp': 'C#',
  htmlmixed: 'HTML', css: 'CSS', 'application/json': 'JSON', markdown: 'Markdown',
  shell: 'Shell', 'text/x-sql': 'SQL', yaml: 'YAML', php: 'PHP', 'text/plain': 'Plain text',
};
export function languageDisplayName(mode) {
  return LANGUAGE_DISPLAY_NAMES[mode] || mode;
}

// The workspace root for the panel's file tree + run_command's default cwd.
// Default to the user's home so "full device access" starts somewhere real,
// reachable, and useful. Overridable with CODE_WORKSPACE_DIR.
export function workspaceRoot() {
  return resolve(process.env.CODE_WORKSPACE_DIR || homedir());
}

// Resolve a user/model-supplied path. Relative paths are relative to the
// workspace root; absolute paths are used as-is (full device access). Returns
// a normalized absolute path.
export function resolvePath(p) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('Path cannot be empty.');
  const trimmed = p.trim();
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(workspaceRoot(), trimmed);
}

function safeName(p) {
  return basename(p);
}

// Deny a few genuinely impossible/unsafe operations regardless of trust level:
// writing into a directory that doesn't exist is an error, and the path must
// resolve to something usable. Binary/size guard stays so the editor + agent
// don't choke on, e.g., opening a big binary file.
const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8 MB read limit for the editor/agent

async function readText(p) {
  const st = await fsp.stat(p);
  if (st.isDirectory()) throw new Error(`${basename(p)} is a directory, not a file.`);
  if (st.size > MAX_FILE_BYTES) throw new Error(`"${basename(p)}" is too large to open (${st.size} bytes, limit ${MAX_FILE_BYTES}).`);
  return fsp.readFile(p, 'utf8');
}

// List files under a directory (the workspace root by default). Recursive=false
// returns immediate children (files + dirs); the agent can pass recursive.
export async function listCodeFiles(dir, { recursive = false } = {}) {
  const root = dir ? resolvePath(dir) : workspaceRoot();
  const out = [];

  const walk = async (d, depth, maxDepth) => {
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch (e) {
      throw new Error(`Cannot read directory "${d}": ${e.message}`);
    }
    for (const ent of entries) {
      const full = resolve(d, ent.name);
      if (ent.isDirectory()) {
        if (recursive && depth < maxDepth) await walk(full, depth + 1, maxDepth);
      } else if (ent.isFile()) {
        let st;
        try { st = await fsp.stat(full); } catch { continue; }
        out.push({
          id: full,
          name: full,           // name IS the path now (full device access)
          path: full,
          language: guessLanguage(ent.name),
          updatedAt: st.mtime.toISOString(),
          size: st.size,
        });
      }
    }
  };

  await walk(root, 0, recursive ? 4 : 0);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Read a file by path.
export async function getCodeFile(userIdOrPath, maybePath) {
  const p = maybePath !== undefined ? resolvePath(String(maybePath)) : resolvePath(String(userIdOrPath));
  return getFileByPath(p);
}

async function getFileByPath(p) {
  try {
    const content = await readText(p);
    const st = await fsp.stat(p);
    return {
      id: p,
      path: p,
      name: p,
      language: guessLanguage(basename(p)),
      content,
      createdAt: st.birthtime.toISOString(),
      updatedAt: st.mtime.toISOString(),
      size: st.size,
    };
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`Cannot read "${p}": ${e.message}`);
  }
}

export async function findCodeFileByName(_userId, pathOrName) {
  // Name is now a path (relative or absolute).
  const p = resolvePath(String(pathOrName));
  return getFileByPath(p);
}

// Write a file, creating parent directories as needed. Returns { file, created }.
export async function writeCodeFile(_userId, pathOrName, content = '') {
  const p = resolvePath(String(pathOrName));
  const existed = await exists(p);
  await fsp.mkdir(dirname(p), { recursive: true });
  await fsp.writeFile(p, String(content ?? ''), 'utf8');
  const st = await fsp.stat(p);
  const file = {
    id: p, path: p, name: p,
    language: guessLanguage(basename(p)),
    content: String(content ?? ''),
    createdAt: st.birthtime.toISOString(),
    updatedAt: st.mtime.toISOString(),
    size: st.size,
  };
  return { file, created: !existed };
}

export async function createCodeFile(_userId, { name, content = '' }) {
  return writeCodeFile(_userId, name, content);
}

export async function editCodeFile(_userId, pathOrName, oldString, newString, replaceAll = false) {
  const p = resolvePath(String(pathOrName));
  const existing = await getFileByPath(p);
  if (!existing) throw new Error(`No file at "${p}".`);
  if (typeof oldString !== 'string' || !oldString) throw new Error('old_string must be a non-empty string.');
  if (typeof newString !== 'string') throw new Error('new_string must be a string.');
  if (oldString === newString) throw new Error('old_string and new_string are identical — nothing to change.');

  const content = existing.content || '';
  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) {
    throw new Error(`old_string was not found in "${basename(p)}". Copy the exact existing text (including indentation and whitespace) you want to replace.`);
  }
  if (occurrences > 1 && !replaceAll) {
    throw new Error(`old_string matches ${occurrences} places in "${basename(p)}". Include more surrounding lines so it is unique, or pass replace_all: true.`);
  }
  const updated = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, () => newString);
  await fsp.writeFile(p, updated, 'utf8');
  const st = await fsp.stat(p);
  const file = { ...existing, content: updated, updatedAt: st.mtime.toISOString() };
  return { file, occurrences: replaceAll ? occurrences : 1 };
}

export async function renameCodeFile(_userId, oldPath, newName) {
  const from = resolvePath(String(oldPath));
  const to = resolvePath(String(newName));
  if (!(await exists(from))) throw new Error(`No file at "${from}".`);
  if (await exists(to)) throw new Error(`A file already exists at "${to}".`);
  await fsp.mkdir(dirname(to), { recursive: true });
  await fsp.rename(from, to);
  return getFileByPath(to);
}

export async function deleteCodeFile(_userId, pathOrName) {
  const p = resolvePath(String(pathOrName));
  const st = await fsp.lstat(p);
  if (st.isDirectory()) await fsp.rm(p, { recursive: true });
  else await fsp.unlink(p);
}

export async function deleteCodeFileByName(_userId, pathOrName) {
  const p = resolvePath(String(pathOrName));
  if (await exists(p)) {
    await deleteCodeFile(_userId, p);
    return true;
  }
  return false;
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

export { safeName };

// Glob-lite: convert a simple pattern (with * and **) into a RegExp.
function globToRegex(glob, { caseSensitive = false } = {}) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // '**' matches across separators
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$+.()[]{}|'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$', caseSensitive ? '' : 'i');
}

// Search the device for files — by filename glob and/or by a substring in the
// file's contents. Claude Code-style device-wide search.
//   pattern: optional filename glob (e.g. "**/*.js", "package.json", "*.py")
//   query:   optional substring to search for inside file contents
//   dir:     root to search under (default workspace root)
//   limit:   max results (default 50)
export async function searchFiles({ pattern, query, dir, limit = 50, maxDepth = 5 } = {}) {
  const root = dir ? resolvePath(String(dir)) : workspaceRoot();
  const matcher = pattern ? globToRegex(String(pattern)) : null;
  const q = query ? String(query).toLowerCase() : null;
  const matches = [];
  const skipped = { dirs: 0 };

  const likelyText = (name) => !/\.(png|jpe?g|gif|webp|ico|mp[34]|mov|avi|zip|gz|tar|pdf|dmg|woff2?|ttf|node_modules)$/i.test(name);

  const walk = async (d, depth) => {
    if (depth > maxDepth || matches.length >= limit) return;
    let entries;
    try { entries = await fsp.readdir(d, { withFileTypes: true }); }
    catch { skipped.dirs++; return; }
    for (const ent of entries) {
      if (matches.length >= limit) return;
      const full = resolve(d, ent.name);
      if (ent.name === '.git' || ent.name === 'node_modules' || ent.name.startsWith('.')) {
        continue;
      }
      if (ent.isDirectory()) {
        await walk(full, depth + 1);
      } else if (ent.isFile()) {
        let hit = false;
        if (matcher) {
          const relFromRoot = full.startsWith(root + '/') ? full.slice(root.length + 1) : ent.name;
          if (matcher.test(full) || matcher.test(relFromRoot) || matcher.test(ent.name)) hit = true;
        }
        let lineNo = -1;
        if (query && !hit && likelyText(ent.name)) {
          try {
            const fd = await fsp.open(full, 'r');
            try {
              const buf = Buffer.alloc(1 * 1024 * 1024); // read up to 1MB, enough for a content-substring hit
              const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
              const text = buf.toString('utf8', 0, bytesRead);
              const lower = text.toLowerCase();
              const idx = lower.indexOf(q);
              if (idx >= 0) {
                hit = true;
                lineNo = text.slice(0, idx).split('\n').length;
              }
            } finally { await fd.close(); }
          } catch { /* unreadable/binary */ }
        }
        if (hit) {
          matches.push({ path: full, name: full, ...(lineNo > 0 ? { line: lineNo } : {}) });
        }
      }
    }
  };

  await walk(root, 0);
  return matches.slice(0, limit);
}
