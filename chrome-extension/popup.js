const disconnectedView = document.getElementById('disconnected-view');
const connectedView = document.getElementById('connected-view');
const codeInput = document.getElementById('code-input');
const connectBtn = document.getElementById('connect-btn');
const errorText = document.getElementById('error-text');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const disconnectBtn = document.getElementById('disconnect-btn');

function render(status) {
  if (status.paired) {
    disconnectedView.style.display = 'none';
    connectedView.style.display = '';
    statusDot.className = 'dot' + (status.connected ? ' online' : '');
    statusText.className = 'status-text' + (status.connected ? ' online' : '');
    statusText.textContent = status.connected ? 'Online' : 'Paired, reconnecting…';
  } else {
    disconnectedView.style.display = '';
    connectedView.style.display = 'none';
  }
}

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: 'get_status' });
  render(status);
}

connectBtn.addEventListener('click', () => {
  const code = codeInput.value.trim();
  if (!/^\d{6}$/.test(code)) {
    errorText.textContent = 'Enter the 6-digit code shown on Neurovance.';
    return;
  }
  errorText.textContent = '';
  connectBtn.disabled = true;
  connectBtn.textContent = 'Connecting…';
  chrome.runtime.sendMessage({ type: 'submit_pair_code', code });
});

disconnectBtn.addEventListener('click', async () => {
  disconnectBtn.disabled = true;
  await chrome.runtime.sendMessage({ type: 'unpair' });
  render({ paired: false });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'pair_status') {
    connectBtn.disabled = false;
    connectBtn.textContent = 'Connect';
    if (message.ok) {
      errorText.textContent = '';
      refresh();
    } else {
      errorText.textContent = message.error || 'Could not connect — try a fresh code.';
    }
  }
  if (message.type === 'status_changed') refresh();
});

refresh();
