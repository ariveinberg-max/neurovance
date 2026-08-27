// A minimal MCP client (Streamable HTTP transport) — just enough of the
// spec to discover a connected server's tools and call them: initialize,
// notifications/initialized, tools/list, tools/call. No resources, prompts,
// sampling, or roots — connectors only ever need tool-calling. Hand-rolled
// with plain fetch rather than the official SDK, same spirit as the rest
// of this app (no framework for something this bounded), but this one
// genuinely matters to get protocol-correct, so it's kept deliberately
// small and was verified against a real mock MCP server before ever
// touching a live one.
//
// Every call here connects fresh rather than keeping a persistent session
// across chat turns — simpler lifecycle, and the requests are infrequent
// enough (once per turn a connector's tools are actually needed) that the
// extra round trip isn't a real cost.

const PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT_MS = 10000;

function headersFor(connector, sessionId) {
  const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };
  if (connector.authToken) headers['Authorization'] = `Bearer ${connector.authToken}`;
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  return headers;
}

// A server may reply with a single JSON object, or with an SSE stream
// containing one or more "data: {...}" events — the spec allows either for
// a POST response. Only the JSON-RPC response matching our request id is
// what we actually want out of a stream; server-initiated messages
// (progress notifications etc.) are ignored since this client never keeps
// a session open long enough to care about them.
async function parseRpcResponse(res, expectedId) {
  const contentType = res.headers.get('content-type') || '';
  const raw = await res.text();
  if (contentType.includes('text/event-stream')) {
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const parsed = JSON.parse(line.slice(5).trim());
        if (parsed.id === expectedId) return parsed;
      } catch { /* not a JSON-RPC data line, skip */ }
    }
    throw new Error('No matching response in event stream.');
  }
  if (!raw) return null;
  return JSON.parse(raw);
}

async function rpcCall(connector, method, params, id, sessionId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(connector.url, {
      method: 'POST',
      headers: headersFor(connector, sessionId),
      body: JSON.stringify(id === undefined ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }),
      signal: controller.signal,
    });
    const newSessionId = res.headers.get('mcp-session-id') || sessionId;
    if (!res.ok) {
      throw new Error(`Connector responded with ${res.status}${res.status === 401 || res.status === 403 ? ' (check its auth token)' : ''}.`);
    }
    // Notifications (no id) get no body worth parsing.
    if (id === undefined) return { sessionId: newSessionId, result: null };
    const parsed = await parseRpcResponse(res, id);
    if (parsed?.error) throw new Error(parsed.error.message || 'Connector returned an error.');
    return { sessionId: newSessionId, result: parsed?.result };
  } finally {
    clearTimeout(timeout);
  }
}

// initialize -> notifications/initialized -> tools/list, all against a
// fresh connection. Returns the session id (some servers want it echoed
// back on tools/call within the same logical session) alongside the tools.
async function handshakeAndListTools(connector) {
  const init = await rpcCall(connector, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'Neurovance', version: '1.0' },
  }, 1);
  await rpcCall(connector, 'notifications/initialized', {}, undefined, init.sessionId);
  const list = await rpcCall(connector, 'tools/list', {}, 2, init.sessionId);
  return { sessionId: init.sessionId, tools: list.result?.tools || [] };
}

// Used when adding a connector — a real round trip against the URL the
// user just typed in, so a typo'd URL or wrong token fails immediately
// with a clear reason instead of silently sitting there until the first
// time the agent tries to use it.
export async function testConnector(connector) {
  const { tools } = await handshakeAndListTools(connector);
  return { ok: true, toolCount: tools.length, tools: tools.map((t) => t.name) };
}

export async function listConnectorTools(connector) {
  const { tools } = await handshakeAndListTools(connector);
  return tools;
}

export async function callConnectorTool(connector, toolName, args) {
  const init = await rpcCall(connector, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'Neurovance', version: '1.0' },
  }, 1);
  await rpcCall(connector, 'notifications/initialized', {}, undefined, init.sessionId);
  const { result } = await rpcCall(connector, 'tools/call', { name: toolName, arguments: args || {} }, 2, init.sessionId);
  // MCP tool results are a content-block array (text/image/resource) — this
  // app's tool-result plumbing everywhere else just wants a string, so
  // flatten to the text blocks the same way a human would read them.
  const content = result?.content || [];
  const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  if (result?.isError) throw new Error(text || 'Connector tool call failed.');
  return text || JSON.stringify(content);
}
