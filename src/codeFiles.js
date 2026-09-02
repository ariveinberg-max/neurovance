import { randomUUID } from 'crypto';
import { getDoc, setDoc, deleteDoc, getAllDocs } from './db.js';

// Same per-user nested-collection pattern as memory.js's memoriesPath — a
// virtual workspace, not a real filesystem. No execution, no git, no disk:
// just named text files the code-editor AI can read and write, scoped to
// one user the same way their memories are.
function codeFilesPath(userId) {
  return `users/${userId}/codeFiles`;
}

// Values are real CodeMirror 5 mode names/MIME types, matched to exactly
// the mode files index.html loads for the code editor — not display
// labels. Kept in this same file (rather than duplicated in index.html)
// since the AI's write_file tool and the editor both need to agree on
// what language a given extension means. swift/kt have no real CM5 mode
// loaded, so they fall back to plain text rather than referencing a mode
// that isn't there.
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
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return EXT_LANGUAGE_MAP[ext] || 'text/plain';
}

// Files live in a per-user virtual workspace that can be materialized onto
// real disk (codeExecution.js joins workDir + name) and fed to an interpreter,
// so a name must be a plain filename — no path separators, no traversal, no
// hidden-dot tricks. The write_file/rename_file agent tools take arbitrary
// model-controlled names, and a prompt-injected instruction could otherwise
// write outside the workspace. Throws on a bad name.
export function assertValidFilename(name) {
  if (typeof name !== 'string' || !name.trim()) throw new Error('Filename cannot be empty.');
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error('Filename cannot contain path separators.');
  }
  if (name === '.' || name === '..') throw new Error('Invalid filename.');
  if (name.length > 200) throw new Error('Filename is too long.');
}

// Display label for the language a file's stored as — the raw CM5
// mode/MIME values above are correct for the editor but not something a
// human should see in the file tree or the AI's file listing.
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

export async function listCodeFiles(userId) {
  const files = await getAllDocs(codeFilesPath(userId));
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getCodeFile(userId, fileId) {
  return getDoc(codeFilesPath(userId), fileId);
}

export async function findCodeFileByName(userId, name) {
  const files = await listCodeFiles(userId);
  return files.find((f) => f.name === name) || null;
}

export async function createCodeFile(userId, { name, content = '' }) {
  assertValidFilename(name);
  if (await findCodeFileByName(userId, name)) {
    throw new Error(`A file named "${name}" already exists.`);
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const file = { id, name, language: guessLanguage(name), content, createdAt: now, updatedAt: now };
  await setDoc(codeFilesPath(userId), id, file);
  return file;
}

// Upsert by name — the AI tool is write_file(name, content), not
// write_file(id, content), since the model only ever knows files by name.
export async function writeCodeFile(userId, name, content) {
  assertValidFilename(name);
  const existing = await findCodeFileByName(userId, name);
  const now = new Date().toISOString();
  if (existing) {
    const updated = { ...existing, content, updatedAt: now };
    await setDoc(codeFilesPath(userId), existing.id, updated);
    return { file: updated, created: false };
  }
  const id = randomUUID();
  const file = { id, name, language: guessLanguage(name), content, createdAt: now, updatedAt: now };
  await setDoc(codeFilesPath(userId), id, file);
  return { file, created: true };
}

export async function renameCodeFile(userId, fileId, newName) {
  assertValidFilename(newName);
  const existing = await getCodeFile(userId, fileId);
  if (!existing) throw new Error('File not found.');
  if (await findCodeFileByName(userId, newName)) {
    throw new Error(`A file named "${newName}" already exists.`);
  }
  const updated = { ...existing, name: newName, language: guessLanguage(newName), updatedAt: new Date().toISOString() };
  await setDoc(codeFilesPath(userId), fileId, updated);
  return updated;
}

export async function deleteCodeFile(userId, fileId) {
  await deleteDoc(codeFilesPath(userId), fileId);
}

export async function deleteCodeFileByName(userId, name) {
  const existing = await findCodeFileByName(userId, name);
  if (!existing) return false;
  await deleteDoc(codeFilesPath(userId), existing.id);
  return true;
}
