// Neurovance Companion — Chrome extension edition.
//
// Talks to the exact same WebSocket endpoint the Node Companion uses
// (wss://app.neurovance.dev/companion-ws), sending the same message types
// (pair/reconnect/command/result) with kind: 'browser' so the server tracks
// this as a separate connection from the desktop Companion — both can be
// paired and live at once; browser actions prefer whichever is actually
// connected, native-only actions (Contacts, Calendar, Music, files) only
// ever go through the desktop Companion.
//
// MV3 service workers get suspended after ~30s idle, which would normally
// kill a persistent WebSocket. Chrome extends a service worker's lifetime
// for as long as it holds an open WebSocket, but as a safety net in case
// that connection ever gets dropped silently, a recurring alarm (the
// shortest interval chrome.alarms allows) wakes this worker back up and
// reconnects if needed — the same "just retry" resilience the desktop
// Companion already relies on.

const WS_URL = 'wss://app.neurovance.dev/companion-ws';
const RECONNECT_DELAY_MS = 5000;

let ws = null;
let reconnectTimer = null;
let pairedUserId = null;

async function loadConfig() {
  const { neurovanceConfig } = await chrome.storage.local.get('neurovanceConfig');
  return neurovanceConfig || null;
}
async function saveConfig(config) {
  await chrome.storage.local.set({ neurovanceConfig: config });
}
async function clearConfig() {
  await chrome.storage.local.remove('neurovanceConfig');
}

function notifyPopup(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // No popup open to receive it — fine, it'll ask for status when it opens.
  });
}

// ---------- Page-interaction functions, injected via chrome.scripting.
// Same matching semantics as the AppleScript-driven versions in
// companion/companion.js (buildClickScript / buildTypeScript /
// buildListElementsScript), ported to real DOM access instead of an
// eval'd string, since a content script needs no injected-JS-as-a-string
// trick to begin with. ----------

function readPageText() {
  return document.body.innerText;
}

function clickElementByText(text) {
  const t = text.toLowerCase();
  const els = Array.from(document.querySelectorAll(
    'a, button, [role="button"], input[type="submit"], input[type="button"], summary, [onclick]'
  ));
  const label = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase();
  // Exact match first — otherwise a shorter target text that happens to be a
  // prefix of a different element's longer text can click the wrong one
  // purely by DOM order.
  const match = els.find((el) => label(el) === t) || els.find((el) => label(el).indexOf(t) !== -1);
  if (!match) return 'NOT_FOUND';
  match.scrollIntoView({ block: 'center' });
  match.click();
  return 'CLICKED: ' + (match.innerText || match.value || match.getAttribute('aria-label') || '').trim().slice(0, 120);
}

function typeIntoFieldByLabel(labelText, value, submit) {
  const l = labelText.toLowerCase();
  const els = Array.from(document.querySelectorAll('input, textarea'));
  const match = els.find((el) => {
    const hay = ((el.placeholder || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.name || '') + ' ' + (el.id || '')).toLowerCase();
    return hay.indexOf(l) !== -1;
  });
  if (!match) return 'NOT_FOUND';
  if (match.type === 'password') return 'BLOCKED_PASSWORD';
  match.focus();
  match.value = value;
  match.dispatchEvent(new Event('input', { bubbles: true }));
  match.dispatchEvent(new Event('change', { bubbles: true }));
  if (submit) {
    match.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    match.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    if (match.form && match.form.requestSubmit) match.form.requestSubmit();
  }
  return 'TYPED';
}

function listClickableElements() {
  const els = Array.from(document.querySelectorAll(
    'a, button, [role="button"], input[type="submit"], input[type="button"], summary, [onclick], [role="radio"], [role="option"]'
  ));
  const items = els.map((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 140);
    if (!text) return null;
    return { text, top: Math.round(r.top), left: Math.round(r.left) };
  }).filter(Boolean);
  items.sort((a, b) => a.top - b.top || a.left - b.left);
  return items.slice(0, 80);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab || null;
}

// chrome.scripting.executeScript throws an opaque internal error on
// chrome://, the Web Store, PDFs, and other non-http(s) pages — Chrome
// blocks script injection there outright. Catching it up front turns that
// into something the model (and the user) can actually act on, instead of
// a raw "Cannot access contents of..." string.
function assertScriptable(tab) {
  if (!/^https?:\/\//.test(tab.url || '')) {
    throw new Error('That tab isn\'t a regular webpage — it looks like a browser-internal page, a PDF, or an extension page, and Chrome doesn\'t allow scripts to run there.');
  }
}

// Which tab browser actions act on, once one has been established (by
// opening a URL or explicitly switching) — without this, every action just
// grabbed "whatever tab is active right now", which silently broke the
// moment the user glanced back at their Neurovance tab between two actions
// in the same task: a click meant for the page just opened would land on
// the chat instead. Falls back to whatever's actually active only when
// nothing has been established yet this session.
let workingTabId = null;

chrome.tabs.onRemoved.addListener((tabId) => {
  if (workingTabId === tabId) workingTabId = null;
});

async function targetTab() {
  if (workingTabId !== null) {
    try {
      return await chrome.tabs.get(workingTabId);
    } catch {
      workingTabId = null;
    }
  }
  const tab = await activeTab();
  if (tab) workingTabId = tab.id;
  return tab;
}

// Cached from the last list_open_tabs call so switch_to_tab can take a
// small, stable index instead of Chrome's own opaque tab id — same pattern
// as list_page_elements/click_page_element (list once, act by position).
let lastTabList = [];

// ---------- Command dispatch — same action names the Node Companion uses
// over the wire, and the same result shapes agent.js already expects
// (result.opened / result.url+title+text / result.result / result.elements),
// so nothing server-side has to know which kind of client answered. ----------

async function handleCommand(action, params) {
  if (action === 'open_url') {
    const url = params.url || '';
    if (!/^https:\/\//.test(url)) throw new Error('Only https:// URLs are allowed.');
    // Always a new tab — updating whichever tab happened to be active used
    // to replace the user's own Neurovance tab out from under them if that's
    // what they were looking at when they asked for something to open. The
    // AppleScript path already opens a new tab via "open location"; this
    // just matches that.
    const tab = await chrome.tabs.create({ url });
    await chrome.windows.update(tab.windowId, { focused: true });
    workingTabId = tab.id;
    return { opened: url };
  }

  if (action === 'go_back') {
    const tab = await targetTab();
    if (!tab) throw new Error('No active tab.');
    await chrome.tabs.goBack(tab.id);
    return { result: 'OK' };
  }

  if (action === 'read_safari_content') {
    const tab = await targetTab();
    if (!tab) throw new Error('No active tab open.');
    assertScriptable(tab);
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPageText });
    return { url: tab.url, title: tab.title, text: (result || '').slice(0, 8000) };
  }

  if (action === 'click_page_element') {
    const tab = await targetTab();
    if (!tab) throw new Error('No active tab open.');
    assertScriptable(tab);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: clickElementByText, args: [params.text || ''],
    });
    if (result === 'NOT_FOUND') throw new Error(`Could not find anything matching "${params.text}" to click on the current page.`);
    return { result };
  }

  if (action === 'type_into_page_field') {
    const tab = await targetTab();
    if (!tab) throw new Error('No active tab open.');
    assertScriptable(tab);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, func: typeIntoFieldByLabel, args: [params.label || '', params.text ?? '', !!params.submit],
    });
    if (result === 'NOT_FOUND') throw new Error(`Could not find a field matching "${params.label}" on the current page.`);
    if (result === 'BLOCKED_PASSWORD') throw new Error('Refusing to type into a password field — the Companion never handles credentials.');
    return { result };
  }

  if (action === 'list_page_elements') {
    const tab = await targetTab();
    if (!tab) throw new Error('No active tab open.');
    assertScriptable(tab);
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: listClickableElements });
    return { elements: result };
  }

  // Genuine Chrome-extension-only capability — AppleScript never exposed a
  // clean way to enumerate/switch tabs, so this has no native equivalent.
  if (action === 'list_open_tabs') {
    const tabs = await chrome.tabs.query({});
    lastTabList = tabs;
    return { tabs: tabs.map((t, i) => ({ index: i + 1, title: t.title, url: t.url, active: t.active })) };
  }

  if (action === 'switch_to_tab') {
    const cached = lastTabList[(params.index || 0) - 1];
    if (!cached) throw new Error(`No tab at index ${params.index} — call list_open_tabs again first.`);
    const tab = await chrome.tabs.get(cached.id).catch(() => null);
    if (!tab) throw new Error('That tab was closed — call list_open_tabs again.');
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    workingTabId = tab.id;
    return { switched: tab.title || tab.url };
  }

  throw new Error(`"${action}" isn't supported by the Chrome extension yet.`);
}

// ---------- Side panel chat / identity — request/response pairs over the
// same connection, keyed by id the way pendingCommands works server-side.
// ----------

const pendingReplies = new Map(); // id -> { resolve, reject, timeout }
const REPLY_TIMEOUT_MS = 60000; // chat can chain several tool calls — longer than a single command's own timeout

function sendAndAwaitReply(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !pairedUserId) {
    return Promise.reject(new Error('Not connected — pair the extension first.'));
  }
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingReplies.delete(id);
      reject(new Error('Timed out waiting for a reply.'));
    }, REPLY_TIMEOUT_MS);
    pendingReplies.set(id, { resolve, reject, timeout });
    ws.send(JSON.stringify({ ...payload, id }));
  });
}

// Whether clicking the toolbar icon shows the pairing popup or opens the
// side panel straight to chat — a popup registered on the action always
// wins over openPanelOnActionClick, so toggling it is how the two states
// share one icon.
async function updateActionPopup() {
  const config = await loadConfig();
  await chrome.action.setPopup({ popup: config?.userId ? '' : 'popup.html' });
}

// ---------- WebSocket connection ----------

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  ws = new WebSocket(WS_URL);

  ws.addEventListener('open', async () => {
    const config = await loadConfig();
    if (config?.userId) {
      ws.send(JSON.stringify({ type: 'reconnect', userId: config.userId, kind: 'browser' }));
    }
  });

  ws.addEventListener('message', async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === 'pair_result') {
      if (msg.ok) {
        pairedUserId = msg.userId;
        await saveConfig({ userId: msg.userId });
        await updateActionPopup();
      }
      notifyPopup({ type: 'pair_status', ok: msg.ok, error: msg.error });
      return;
    }

    if (msg.type === 'reconnect_result') {
      if (!msg.ok) {
        await clearConfig();
        pairedUserId = null;
        await updateActionPopup();
      } else {
        pairedUserId = (await loadConfig())?.userId || null;
      }
      return;
    }

    if (msg.type === 'command') {
      try {
        const data = await handleCommand(msg.action, msg.params || {});
        ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, data }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: e.message }));
      }
      return;
    }

    if (msg.type === 'chat_result' || msg.type === 'identity_result') {
      const pending = pendingReplies.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      pendingReplies.delete(msg.id);
      if (msg.ok) pending.resolve(msg.type === 'chat_result' ? msg.reply : msg.identity);
      else pending.reject(new Error(msg.error || 'Request failed.'));
      return;
    }
  });

  ws.addEventListener('close', () => {
    ws = null;
    scheduleReconnect();
  });
  ws.addEventListener('error', () => {
    // The close event fires right after — reconnect is scheduled there.
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_DELAY_MS);
}

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

// 0.5 minutes is the shortest interval chrome.alarms allows — a safety net
// in case the WebSocket ever gets silently dropped without a close event.
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') connect();
});

// Clicking the toolbar icon opens the side panel straight to chat — but
// only takes effect while no popup is registered on the action (see
// updateActionPopup), so unpaired still gets the small pairing popup.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

connect();
updateActionPopup();

// ---------- Messages from the popup and the side panel ----------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'get_status') {
    (async () => {
      const config = await loadConfig();
      sendResponse({
        paired: !!config?.userId,
        connected: ws?.readyState === WebSocket.OPEN && !!pairedUserId,
      });
    })();
    return true;
  }

  if (message.type === 'submit_pair_code') {
    connect();
    const trySend = () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'pair', code: message.code, kind: 'browser' }));
      } else {
        setTimeout(trySend, 300);
      }
    };
    trySend();
    return false;
  }

  if (message.type === 'unpair') {
    (async () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'unpair', kind: 'browser' }));
      }
      await clearConfig();
      pairedUserId = null;
      await updateActionPopup();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === 'get_identity') {
    sendAndAwaitReply({ type: 'get_identity' })
      .then((identity) => sendResponse({ ok: true, identity }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (message.type === 'chat_send') {
    sendAndAwaitReply({ type: 'chat', message: message.text, history: message.history || [] })
      .then((reply) => sendResponse({ ok: true, reply }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});
