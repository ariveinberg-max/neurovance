import { randomUUID } from 'crypto';
import { getDoc, setDoc, deleteDoc, getAllDocs } from './db.js';

// Same per-user nested-collection pattern as memory.js's memoriesPath — a
// virtual workspace, not a real filesystem. No execution, no git, no disk:
// just named text files the code-editor AI can read and write, scoped to
// one user the same way their memories are.
function codeFilesPath(userId) {
  return `users/${userId}/codeFiles`;
}

const EXT_LANGUAGE_MAP = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', tsx: 'tsx',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  html: 'htmlmixed', htm: 'htmlmixed', css: 'css', json: 'application/json',
  md: 'markdown', sh: 'shell', bash: 'shell', sql: 'sql', yaml: 'yaml', yml: 'yaml',
  php: 'php', swift: 'swift', kt: 'kotlin',
};
export function guessLanguage(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return EXT_LANGUAGE_MAP[ext] || 'text/plain';
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
  const existing = await getCodeFile(userId, fileId);
  if (!existing) throw new Error('File not found.');
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
