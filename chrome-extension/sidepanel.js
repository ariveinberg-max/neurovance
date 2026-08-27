const notConnectedEl = document.getElementById('not-connected');
const messagesEl = document.getElementById('messages');
const emptyStateEl = document.getElementById('empty-state');
const composerEl = document.getElementById('composer');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');
const aiNameEl = document.getElementById('ai-name');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const disconnectLink = document.getElementById('disconnect-link');

const HISTORY_KEY = 'neurovanceSidepanelHistory';
let history = []; // [{ role: 'user'|'assistant', content: string }]

function renderMessages() {
  messagesEl.innerHTML = '';
  if (history.length === 0) {
    messagesEl.appendChild(emptyStateEl);
    return;
  }
  for (const m of history) {
    const div = document.createElement('div');
    div.className = 'msg ' + (m.role === 'user' ? 'user' : 'assistant');
    div.textContent = m.content;
    messagesEl.appendChild(div);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function loadHistory() {
  const stored = await chrome.storage.session.get(HISTORY_KEY);
  history = Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [];
  renderMessages();
}

async function saveHistory() {
  // Same cap the server itself applies — no reason to keep more locally.
  history = history.slice(-12);
  await chrome.storage.session.set({ [HISTORY_KEY]: history });
}

function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 100) + 'px';
}

async function send() {
  const text = inputEl.value.trim();
  if (!text) return;

  history.push({ role: 'user', content: text });
  renderMessages();
  inputEl.value = '';
  autoGrow();
  inputEl.disabled = true;
  sendBtn.disabled = true;

  const pendingDiv = document.createElement('div');
  pendingDiv.className = 'msg pending';
  pendingDiv.textContent = 'Thinking…';
  messagesEl.appendChild(pendingDiv);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  try {
    const res = await chrome.runtime.sendMessage({ type: 'chat_send', text, history: history.slice(0, -1) });
    pendingDiv.remove();
    if (res.ok) {
      history.push({ role: 'assistant', content: res.reply });
      await saveHistory();
      renderMessages();
    } else {
      const errDiv = document.createElement('div');
      errDiv.className = 'msg error';
      errDiv.textContent = res.error || 'Something went wrong.';
      messagesEl.appendChild(errDiv);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  } catch (e) {
    pendingDiv.remove();
    const errDiv = document.createElement('div');
    errDiv.className = 'msg error';
    errDiv.textContent = e.message;
    messagesEl.appendChild(errDiv);
  }

  inputEl.disabled = false;
  sendBtn.disabled = false;
  inputEl.focus();
}

sendBtn.addEventListener('click', send);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
inputEl.addEventListener('input', autoGrow);

disconnectLink.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'unpair' });
  await refresh();
});

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: 'get_status' });

  if (!status.paired) {
    notConnectedEl.style.display = 'flex';
    messagesEl.style.display = 'none';
    composerEl.style.display = 'none';
    statusText.textContent = 'Not connected';
    statusDot.className = 'dot';
    statusText.className = 'status-text';
    return;
  }

  notConnectedEl.style.display = 'none';
  messagesEl.style.display = 'flex';
  composerEl.style.display = 'flex';
  statusText.textContent = status.connected ? 'Online' : 'Reconnecting…';
  statusDot.className = 'dot' + (status.connected ? ' online' : '');
  statusText.className = 'status-text' + (status.connected ? ' online' : '');

  const idRes = await chrome.runtime.sendMessage({ type: 'get_identity' });
  if (idRes.ok && idRes.identity) {
    aiNameEl.textContent = idRes.identity.aiName || 'Superself';
  }

  await loadHistory();
  inputEl.focus();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'pair_status' || message.type === 'status_changed') refresh();
});

refresh();
