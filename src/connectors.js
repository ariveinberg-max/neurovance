import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { lookup as dnsLookup } from 'dns/promises';
import { isIP } from 'net';
import { getDoc, setDoc } from './db.js';
import { testConnector as mcpTestConnector, listConnectorTools, callConnectorTool } from './mcp-client.js';

// Lets a user point their Superself at an external MCP server — their own
// tools become the agent's tools, mid-conversation, the same way Companion
// actions already are. A connector's auth token is the one real secret this
// app stores that isn't a password: a password only ever needs to be
// *verified* (hash and compare), but a connector's token has to come back
// out in plaintext to actually call the server, so hashing doesn't work
// here — this encrypts it at rest instead (AES-256-GCM, key from env),
// the same problem any app storing a live third-party credential has.

const ALGORITHM = 'aes-256-gcm';
const MAX_CONNECTORS_PER_USER = 5;

function encryptionKey() {
  const raw = process.env.CONNECTOR_ENCRYPTION_KEY;
  if (!raw) throw new Error('Connectors are not configured on this server yet (CONNECTOR_ENCRYPTION_KEY is not set).');
  const key = Buffer.from(raw, 'hex');
  if (key.length !== 32) throw new Error('CONNECTOR_ENCRYPTION_KEY must be a 32-byte key, 64 hex characters.');
  return key;
}

function encryptToken(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptToken(stored) {
  const [ivHex, tagHex, dataHex] = stored.split(':');
  const decipher = createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

async function loadUserDoc(userId) {
  const doc = await getDoc('users', userId);
  if (!doc) throw new Error('No such user.');
  return doc;
}

function decryptConnector(record) {
  return { url: record.url, authToken: record.authTokenEncrypted ? decryptToken(record.authTokenEncrypted) : null };
}

// Never returns the encrypted token — nothing outside this module ever
// needs it, including the client.
export async function listConnectors(userId) {
  const user = await loadUserDoc(userId);
  return (user.connectors || []).map(({ id, name, url, createdAt }) => ({ id, name, url, createdAt }));
}

// Connector URLs are fetched server-side, from Node's own network — an
// unrestricted URL would let anyone reach the server's own internal
// network or cloud metadata endpoint by just typing it in as a
// "connector". https-only (below) blocks most of that already (internal
// services rarely have a valid cert), but this catches the direct case:
// resolve the hostname and refuse anything loopback/private/link-local.
function isPrivateOrLoopbackIp(ip) {
  const version = isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 127 || a === 0 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    return false;
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
    if (lower.startsWith('fe80')) return true; // link-local
    return false;
  }
  return true; // couldn't classify it — refuse rather than guess
}

async function assertSafeConnectorUrl(url) {
  if (!/^https:\/\//.test(url || '')) throw new Error('Connector URL must start with https://');
  const hostname = new URL(url).hostname;
  if (hostname === 'localhost') throw new Error('Connector URL can\'t point at localhost.');
  let addresses;
  try {
    addresses = await dnsLookup(hostname, { all: true });
  } catch {
    throw new Error('Could not resolve that URL\'s hostname.');
  }
  if (addresses.some((a) => isPrivateOrLoopbackIp(a.address))) {
    throw new Error('Connector URL can\'t point at a private or internal network address.');
  }
}

export async function addConnector(userId, { name, url, authToken }) {
  if (!name?.trim()) throw new Error('Give the connector a name.');
  await assertSafeConnectorUrl(url);
  const user = await loadUserDoc(userId);
  const existing = user.connectors || [];
  if (existing.length >= MAX_CONNECTORS_PER_USER) throw new Error(`You can connect up to ${MAX_CONNECTORS_PER_USER} at a time.`);

  const candidate = { url: url.trim(), authToken: authToken?.trim() || null };
  // A real round trip before anything is saved — a typo'd URL or wrong
  // token fails right here with a clear reason, not silently the first
  // time the agent tries to use it mid-conversation.
  const check = await mcpTestConnector(candidate);

  const record = {
    id: randomUUID(),
    name: name.trim(),
    url: candidate.url,
    authTokenEncrypted: candidate.authToken ? encryptToken(candidate.authToken) : null,
    createdAt: new Date().toISOString(),
  };
  user.connectors = [...existing, record];
  await setDoc('users', userId, user);
  return { id: record.id, name: record.name, url: record.url, toolCount: check.toolCount };
}

export async function removeConnector(userId, connectorId) {
  const user = await loadUserDoc(userId);
  user.connectors = (user.connectors || []).filter((c) => c.id !== connectorId);
  await setDoc('users', userId, user);
}

// Called once per chat/task turn when the user has any connectors —
// each connector's tools get namespaced with its own id in the tool name
// so two connectors can never collide, and a tool_use can be routed back
// to the right one without guessing. A connector that's down or erroring
// just contributes zero tools for that turn rather than failing the whole
// request — the user still gets a reply, only missing that one connector's
// capabilities for this message.
export async function discoverAllConnectorTools(userId) {
  const user = await loadUserDoc(userId);
  const connectors = user.connectors || [];
  if (connectors.length === 0) return [];

  const results = await Promise.all(connectors.map(async (record) => {
    try {
      const tools = await listConnectorTools(decryptConnector(record));
      return tools.map((t) => ({
        name: `connector_${record.id.slice(0, 8)}__${t.name}`,
        description: `[${record.name}] ${t.description || ''}`.slice(0, 1000),
        input_schema: t.inputSchema || { type: 'object', properties: {} },
      }));
    } catch (e) {
      console.error(`Connector "${record.name}" tool discovery failed:`, e.message);
      return [];
    }
  }));
  return results.flat();
}

export function isConnectorToolName(name) {
  return /^connector_[a-f0-9]{8}__/.test(name);
}

export async function invokeConnectorTool(userId, toolName, args) {
  const match = toolName.match(/^connector_([a-f0-9]{8})__(.+)$/);
  if (!match) throw new Error('Unknown connector tool.');
  const [, connectorIdPrefix, realName] = match;
  const user = await loadUserDoc(userId);
  const record = (user.connectors || []).find((c) => c.id.startsWith(connectorIdPrefix));
  if (!record) throw new Error('That connector is no longer connected.');
  return callConnectorTool(decryptConnector(record), realName, args);
}
