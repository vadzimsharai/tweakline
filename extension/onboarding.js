const byId = (id) => document.getElementById(id);
const COMMANDS = ['node tweakline-server.js pair'];
const DONE_STEPS = 2;
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const withCommands = (text) => COMMANDS.reduce((html, command) => html.replaceAll(command, `<code>${command}</code>`), escapeHtml(text));

function bg(method, params) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ to: 'bg', method, params }, (reply) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!reply?.ok) return reject(new Error(reply?.error || 'Extension did not respond'));
      resolve(reply.data);
    });
  });
}

function showMessage(text, kind) {
  const message = byId('pairMsg');
  message.innerHTML = withCommands(text);
  message.className = kind || '';
}

function wireCopy(button) {
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(byId(button.dataset.copyFrom).textContent.trim());
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Select it manually';
    }
  });
}

async function pair(allowOpen) {
  const link = byId('pairInput').value.trim();
  byId('openBox').hidden = true;
  if (!link) { showMessage('Paste the link from your server', 'bad'); return; }
  showMessage('Connecting…');
  try {
    const result = await bg('server.pair', { link, allowOpen });
    if (result.needsConfirm) {
      showMessage('');
      byId('openWarn').textContent = `${result.baseUrl} is an open address: the browser key, chats and screenshots travel unencrypted. Connect only if the network is yours.`;
      byId('openBox').hidden = false;
      return;
    }
    byId('pairInput').value = '';
    showMessage(`Server ${result.name} connected. Open any page and tap the small tab at the screen edge.`, 'good');
    showDone();
  } catch (error) {
    showMessage(error.message, 'bad');
  }
}

function showDone() {
  document.querySelectorAll('.steps > li').forEach((step, index) => {
    step.classList.toggle('done', index < DONE_STEPS);
    step.classList.toggle('now', index === DONE_STEPS);
  });
}

async function showLocalStatus() {
  const local = await bg('server.probeLocal').catch(() => null);
  if (!local) return;
  byId('localStatus').innerHTML = withCommands(local.paired
    ? `Server ${local.url} is already connected.`
    : `A server is already running on this computer: ${local.url}. Get its link with node tweakline-server.js pair.`);
}

document.querySelectorAll('[data-copy-from]').forEach(wireCopy);
byId('pairGo').addEventListener('click', () => pair(false));
byId('pairInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') pair(false); });
byId('openYes').addEventListener('click', () => pair(true));
byId('openNo').addEventListener('click', () => { byId('openBox').hidden = true; });
showLocalStatus();
