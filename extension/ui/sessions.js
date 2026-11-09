const MINUTE_MS = 60000;
const RELATIVE_STEPS = [[60, 'min'], [24, 'h'], [Infinity, 'd']];

function ago(at) {
  let amount = Math.floor((Date.now() - at) / MINUTE_MS);
  if (amount < 1) return 'Just now';
  for (const [size, unit] of RELATIVE_STEPS) {
    if (amount < size) return `${amount} ${unit} ago`;
    amount = Math.floor(amount / size);
  }
  return '';
}
const UNIT_WORDS = { min: 'minute', h: 'hour', d: 'day' };
function remaining(until) {
  let amount = Math.max(1, Math.ceil((until - Date.now()) / MINUTE_MS));
  for (const [size, unit] of RELATIVE_STEPS) {
    if (amount < size) return `${amount} more ${UNIT_WORDS[unit]}${amount === 1 ? '' : 's'}`;
    amount = Math.floor(amount / size);
  }
  return '';
}
const ARM_RESET_MS = 4000;
const CHECK_MIN_MS = 600;
const PAIR_COMMAND = 'node tweakline-server.js pair';
const COMMANDS = [PAIR_COMMAND];
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
// Escapes text and shows terminal commands in it as code.
const withCommands = (text) => COMMANDS.reduce((html, command) => html.replaceAll(command, `<code>${command}</code>`), esc(text));
const INSTALL_REQUEST = 'Install Tweakline using the AI instructions in the README: https://github.com/vadzimsharai/tweakline';
const INSTALL_COMMAND = 'curl -fLO https://github.com/vadzimsharai/tweakline/releases/latest/download/tweakline-server.js && node tweakline-server.js';
const PAIR_PLACEHOLDER = 'https://address/pair#code';
const NOT_A_LINK = "That's not a server link. Paste the link your server printed, or its address.";
const OPT_ICONS = {
  page: '<svg class="oico" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/></svg>',
  browser: '<svg class="oico" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 7.5h.01M10 7.5h.01"/></svg>',
};
const sessionWhere = (s, tabId) => {
  if (s.kind === 'browser') return 'whole browser';
  return s.tab === tabId ? 'this page' : 'another tab';
};
const capitalized = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const sessionTitle = (s) => s.title || 'New session';
// Sheets still open when a list fails: they show it as empty.
const sessionsOrNone = () => bg('session.list').catch(() => []);
const serversOrNone = () => bg('server.list').catch(() => []);
const serverDot = (server) => `<span class="rdot ${server.online ? 'ok' : 'warn'}"></span>`;

function renderNoSession() {
  $('#sessCard')?.remove();
  if (session) return;
  const el = appendRaw(`<div class="sess" id="sessCard"><h3>Connect an AI to chat</h3><p>Notes, screenshots and patches work without it.</p><button class="btn pri" id="connectBtn">Connect AI</button></div>`);
  el.querySelector('#connectBtn').onclick = () => connectAi();
}
function syncSession() {
  $('#sessName').textContent = session ? sessionTitle(session) : 'No AI';
  panel.classList.toggle('has-session', Boolean(session && session.polling));
  $('#sessOff')?.remove();
  if (session && !session.polling) $('#aiLine').insertAdjacentHTML('beforebegin', '<div class="offline" id="sessOff">AI is offline, messages will wait</div>');
  renderNoSession();
  syncFeedback();
}
async function refreshCurrentSession() {
  if (!session) return;
  const list = await bg('session.list');
  const found = list.find((s) => s.id === session.id);
  if (found) { session = found; syncSession(); return; }
  endSessionHere();
}
async function activateSession(next, history) {
  session = next;
  pastChat = null;
  renderHistory(history);
  syncSession();
}

const ADDRESS_LABELS = { public: 'Public', local: 'This computer only' };
let chosenServerId = null;

function armThen(button, armedLabel, action) {
  if (button.dataset.armed === '1') { action(); return; }
  const label = button.textContent;
  button.dataset.armed = '1';
  button.textContent = armedLabel;
  button.classList.add('armed');
  setTimeout(() => {
    button.dataset.armed = '';
    button.textContent = label;
    button.classList.remove('armed');
  }, ARM_RESET_MS);
}
function endSessionHere() {
  session = null;
  renderHistory([]);
  syncSession();
}
const orderAddresses = (addresses) => [...addresses].sort((a, b) => Number(b.kind === 'public') - Number(a.kind === 'public'));

function addressBox(address, label) {
  return `${label ? `<div class="clabel">${esc(label)}</div>` : ''}<div class="copybox addr" data-kind="${esc(address.kind)}"><span class="aurl">${esc(address.url)}</span><button class="btn small" data-copy="${esc(address.url)}">Copy</button></div>`;
}
// Only for display, the copied text comes from data-copy: lines should break at a slash or between options, never inside a flag.
const wrappableText = (text) => esc(text).replace(/\//g, '/<wbr>').replace(/--\w+/g, '<span class="nb">$&</span>');
function copyItem(label, text) {
  return `<div class="clabel">${esc(label)}</div><div class="copybox wrap"><code>${wrappableText(text)}</code><button class="btn small" data-copy="${esc(text)}">Copy</button></div>`;
}
function wireCopy(scope) {
  scope.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = async () => {
    try {
      await copyText(b.dataset.copy);
      b.textContent = 'Copied';
    } catch {
      over.querySelectorAll('.addr').forEach((box) => box.classList.add('wrap'));
      showToast('Could not copy', 'Select the address manually');
    }
  }; });
}

function sessionRow(s, tabId, showServer) {
  const current = session?.id === s.id;
  const detail = [s.ai || 'Waiting for AI', sessionWhere(s, tabId)];
  if (showServer) detail.push(s.serverName);
  const when = current ? 'Now' : s.polling ? 'Online' : ago(s.lastAt);
  // On a narrow screen the time moves under the title, so the title gets the whole row.
  return `<div class="row split${current ? ' on' : ''}"><button class="rtap" data-join="${esc(s.id)}"><span class="rdot${s.polling ? ' ok' : ''}"></span>
    <span class="rmain"><span class="rtitle">${esc(sessionTitle(s))}</span><span class="rsub"><span class="rwhen">${esc(when)} · </span>${esc(detail.join(', '))}</span></span><span class="rmeta">${esc(when)}</span></button><button class="dicon" data-addr="${esc(s.id)}" aria-label="Session details">${SHEET_ICONS.more}</button></div>`;
}
const downServersText = (count) => (count === 1 ? "1 server can't be reached" : `${count} servers can't be reached`);

// With `only`, the sheet lists the sessions of one server and goes back to that server's detail.
async function sessionsDialog(filter = null) {
  const only = filter?.serverId ? filter : null;
  const again = () => sessionsDialog(only);
  const [list, servers, state] = await Promise.all([sessionsOrNone(), serversOrNone(), bg('state')]);
  const reachable = list.filter((s) => !s.unreachable && (!only || s.serverId === only.serverId));
  const here = reachable.filter((s) => s.kind === 'browser' || s.tab === state.tabId);
  const other = reachable.filter((s) => !here.includes(s));
  const down = only ? 0 : servers.filter((server) => !server.online).length;
  const section = (title, items) => (items.length ? `<div class="sect">${title}</div><div class="list">${items.map((s) => sessionRow(s, state.tabId, servers.length > 1)).join('')}</div>` : '');
  openSheet({ title: only ? `Sessions on ${only.name}` : 'Sessions', back: only?.back, body: `${reachable.length ? '' : `<p class="lead">${only ? 'No sessions on this server yet.' : 'No sessions yet. Connect an AI to start one.'}</p>`}
    <button class="btn pri full" id="newSess">Connect AI</button>
    ${section('On this page', here)}${section('Other', other)}
    ${down ? `<button class="quietline" id="serversDown"><span class="rdot warn"></span><span class="rmain">${downServersText(down)}</span><span class="rgo">${SHEET_ICONS.go}</span></button>` : ''}` });
  $('#newSess').onclick = () => connectAi(again);
  if (down) $('#serversDown').onclick = () => serversDialog(again);
  over.querySelectorAll('[data-addr]').forEach((b) => { b.onclick = () => {
    const chosen = list.find((s) => s.id === b.dataset.addr);
    sessionDetail(chosen, sessionWhereLine(chosen, state.tabId, servers), again);
  }; });
  over.querySelectorAll('[data-join]').forEach((b) => { b.onclick = async () => {
    const chosen = list.find((s) => s.id === b.dataset.join);
    try {
      const history = await bg('session.join', { id: chosen.id });
      closeDialog();
      openChat();
      await activateSession(chosen, history);
    } catch (error) { showToast('Could not connect', error.message); }
  }; });
}
function sessionWhereLine(s, tabId, servers) {
  const where = capitalized(sessionWhere(s, tabId));
  return servers.length > 1 ? `${where}, ${s.serverName}` : where;
}

async function sessionDetail(s, whereLine, back = sessionsDialog) {
  let addresses = null;
  let problem = '';
  try { addresses = orderAddresses(await bg('session.addresses', { id: s.id })); } catch (error) { problem = error.message; }
  const labelled = addresses?.length === 2;
  openSheet({
    title: sessionTitle(s), back,
    body: `<p class="lead" id="sessWhere">${esc(whereLine)}</p>
      <div class="sect">Address for your AI</div>
      ${addresses ? addresses.map((a) => addressBox(a, labelled ? ADDRESS_LABELS[a.kind] : '')).join('') : `<div class="msg warn">${esc(problem)}</div>`}
      <p class="lead aftbox">Your AI sees only this session, and can act only with the access you give.</p>
      ${session?.id === s.id ? '<button class="btn full" id="noAi">Work without AI</button>' : ''}`,
    foot: `<button class="btn danger" data-revoke="${esc(s.id)}">Delete session</button>`,
  });
  wireCopy(over);
  onClickIfShown('#noAi', async () => {
    await bg('session.leave');
    endSessionHere();
    closeDialog();
  });
  const remove = over.querySelector('[data-revoke]');
  remove.onclick = () => armThen(remove, 'Tap again to delete', async () => {
    try {
      await bg('session.revoke', { id: s.id });
      if (session?.id === s.id) endSessionHere();
      sessionsDialog();
    } catch (error) { showToast('Could not delete', error.message); }
  });
}

function serverProblem(server) {
  return server.problem || "Can't be reached. Is it running?";
}
function serverLine(server, sessions) {
  if (!server.online) return serverProblem(server);
  const count = sessions.filter((s) => s.serverId === server.id).length;
  return `Connected, ${count === 1 ? '1 session' : `${count || 'no'} sessions`}`;
}
function serverRow(server, line, attribute, selected) {
  return `<button class="row${selected ? ' on' : ''}" ${attribute}="${esc(server.id)}">${serverDot(server)}
    <span class="rmain"><span class="rtitle">${esc(server.name)}</span><span class="rsub">${esc(line)}</span></span><span class="rgo">${SHEET_ICONS.go}</span></button>`;
}

async function serversDialog(back) {
  const [servers, sessions, local] = await Promise.all([serversOrNone(), sessionsOrNone(), bg('server.probeLocal').catch(() => null)]);
  const reopen = () => serversDialog(back);
  const route = { back: reopen, done: reopen };
  openSheet({
    title: 'Servers', back,
    body: `${servers.length ? `<div class="list">${servers.map((server) => serverRow(server, serverLine(server, sessions), 'data-server-row')).join('')}</div>` : '<p class="lead" id="noServers">Notes, screenshots and patches work without a server. To talk to an AI, add one.</p>'}
      ${local && !local.paired ? `<div class="sect">Found on this computer</div><div class="row"><span class="rdot"></span><span class="rmain"><span class="rtitle">${esc(new URL(local.url).host)}</span></span><button class="btn small" id="localConnect">Connect</button></div>` : ''}`,
    foot: '<button class="btn pri" id="addServer">Add server</button>',
  });
  $('#addServer').onclick = () => addServerSheet(route);
  onClickIfShown('#localConnect', () => addServerSheet(route));
  over.querySelectorAll('[data-server-row]').forEach((b) => { b.onclick = () => serverDetail(b.dataset.serverRow, reopen); });
}

async function serverDetail(id, back, minWaitMs = 0) {
  const [servers, sessions] = await Promise.all([bg('server.list').catch(() => null), sessionsOrNone(), pause(minWaitMs)]);
  const server = servers?.find((candidate) => candidate.id === id);
  if (!server) {
    openSheet({
      title: 'Server', back,
      body: `<div class="msg err" id="serverGone">${servers ? 'This server is no longer in the list. It may have been removed.' : 'Could not load the servers. Try again in a moment.'}</div>`,
    });
    return;
  }
  openSheet({
    title: server.name, back,
    body: `<dl class="info"><dt>Address</dt><dd>${esc(server.baseUrl)}</dd>
        <dt>Status</dt><dd id="serverStatus">${serverDot(server)}${esc(server.online ? 'Connected' : serverProblem(server))}</dd>
        </dl>
      <div class="list"><button class="row" id="serverSessionsOpen"><span class="rmain"><span class="rtitle">Sessions</span></span><span class="rmeta" id="serverSessions">${sessions.filter((s) => s.serverId === id).length}</span><span class="rgo">${SHEET_ICONS.go}</span></button></div>
      ${server.open ? '<div class="msg warn" id="openNote">This address has no encryption: chats and screenshots can be read on the network. Use it only on a network you trust.</div>' : ''}
      <button class="btn full" id="serverCheck">Check again</button>`,
    foot: `<p class="note">Sessions on this server will end in this browser</p><button class="btn danger" data-unpair="${esc(id)}">Remove server</button>`,
  });
  $('#serverSessionsOpen').onclick = () => sessionsDialog({ serverId: id, name: server.name, back: () => serverDetail(id, back) });
  $('#serverCheck').onclick = (e) => {
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = 'Checking…';
    serverDetail(id, back, CHECK_MIN_MS);
  };
  const remove = over.querySelector('[data-unpair]');
  remove.onclick = () => armThen(remove, 'Tap again to remove', async () => {
    try {
      const removed = await bg('server.remove', { id });
      if (session?.serverId === id) endSessionHere();
      back();
      if (removed?.kept) showToast('The server still has this browser', `It keeps its sessions until you run ${removed.revokeCommand} there`);
    } catch (error) { showToast('Could not remove', error.message); }
  });
}

async function addServerSheet(route, value = '') {
  const local = await bg('server.probeLocal').catch(() => null);
  openSheet({
    title: 'Add server', back: route.back,
    body: `${local && !local.paired ? `<div class="msg" id="foundLocal">Found a server on this computer: ${esc(local.url)}. To connect it, paste its link: run <code>${PAIR_COMMAND}</code> there, or ask your AI.</div>` : ''}
      <label class="field"><span>Link from your server</span><textarea id="serverInput" rows="1" placeholder="${PAIR_PLACEHOLDER}" autocomplete="off" spellcheck="false">${esc(value)}</textarea></label>
      <div id="serverMsg" role="status"></div>
      <button class="btn pri full" id="serverGo">Connect</button>
      <div class="sect">No server yet?</div>
      ${copyItem('Ask your AI', INSTALL_REQUEST)}${copyItem('Or run it yourself', INSTALL_COMMAND)}`,
  });
  wireCopy(over);
  $('#serverGo').onclick = () => submitServerInput(route);
  const input = $('#serverInput');
  // A long link wraps instead of hiding its end, so the field grows with it.
  const fit = () => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight + input.offsetHeight - input.clientHeight}px`; };
  input.addEventListener('input', fit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitServerInput(route); } });
  fit();
}
function looksLikeAddress(input) {
  if (/\s/.test(input)) return false;
  try {
    const { hostname } = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `http://${input}`);
    return hostname === 'localhost' || hostname.includes('.') || hostname.startsWith('[');
  } catch { return false; }
}
function serverMessage(text, kind = '') {
  $('#serverMsg').innerHTML = `<div class="msg ${kind}">${withCommands(text)}</div>`;
}

async function submitServerInput(route) {
  const input = $('#serverInput').value.trim();
  if (!input) { serverMessage('Paste the link from your server', 'err'); return; }
  if (input.includes('/pair#')) return pairWithLink(input, false, route);
  if (!looksLikeAddress(input)) { serverMessage(NOT_A_LINK, 'err'); return; }
  serverMessage('Looking for a server…');
  try {
    const found = await bg('server.check', { input });
    if (!found) serverMessage('No Tweakline server found at this address. Check it and that the server is running.', 'err');
    else if (found.paired) { chosenServerId = found.id; route.done(); }
    else serverMessage(`Found server ${found.url}${found.open ? ', open address without encryption' : ''}. Now you need its link: run ${PAIR_COMMAND} there, or ask your AI.`);
  } catch (error) { serverMessage(error.message, 'err'); }
}

async function pairWithLink(link, allowOpen, route) {
  serverMessage('Connecting…');
  try {
    const result = await bg('server.pair', { link, allowOpen });
    if (result.needsConfirm) { confirmOpenServer(link, result.baseUrl, route); return; }
    chosenServerId = result.id;
    route.done();
  } catch (error) { serverMessage(error.message, 'err'); }
}

function confirmOpenServer(link, baseUrl, route) {
  const backToForm = () => addServerSheet(route, link);
  openSheet({
    title: 'Connect without encryption?', back: backToForm,
    body: `<div class="msg warn" id="openWarn">${esc(baseUrl)} is an open address: the browser key, chats and screenshots travel unencrypted. Connect only if the network is yours.</div><div id="serverMsg" role="status"></div>`,
    foot: '<button class="btn" id="openNo">Cancel</button><button class="btn pri" id="openYes">Connect without encryption</button>',
  });
  $('#openNo').onclick = backToForm;
  $('#openYes').onclick = () => pairWithLink(link, true, route);
}

function defaultServer(servers, sessions) {
  const usable = (id) => servers.find((server) => server.online && server.id === id);
  const lastUsed = sessions.filter((s) => usable(s.serverId)).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0))[0];
  return usable(chosenServerId) ?? usable(session?.serverId) ?? usable(lastUsed?.serverId) ?? servers.find((server) => server.online) ?? servers[0];
}

async function connectAi(back) {
  const servers = await serversOrNone();
  if (!servers.length) return addServerSheet({ back, done: () => connectAi(back) });
  kindStep(servers, defaultServer(servers, await sessionsOrNone()), back);
}

function kindOption(kind, title, detail, disabled) {
  return `<button class="opt" data-kind="${kind}"${disabled ? ' disabled' : ''}>${OPT_ICONS[kind]}<span class="rmain"><span class="rtitle">${title}</span><span class="rsub">${detail}</span></span><span class="rgo">${SHEET_ICONS.go}</span></button>`;
}
function kindStep(servers, server, back) {
  openSheet({
    title: 'What should the AI work with?', back,
    body: `${servers.length > 1 ? `<div class="list pick"><button class="row" id="serverPick">${serverDot(server)}<span class="rmain"><span class="rtitle">Server: ${esc(server.name)}</span></span><span class="rgo">${SHEET_ICONS.go}</span></button></div>` : ''}
      ${server.online ? '' : `<div class="msg warn" id="serverOff">${esc(server.name)} can't be reached. Check it in Servers${servers.length > 1 ? ' or choose another one' : ''}.</div><button class="btn full offerservers" id="openServers">Servers</button>`}
      ${kindOption('page', 'This page', 'Chat stays with this tab', !server.online)}${kindOption('browser', 'Whole browser', 'The AI can ask to work in any tab', !server.online)}`,
  });
  const reopen = () => connectAi(back);
  onClickIfShown('#serverPick', () => serverPicker(servers, server, back));
  onClickIfShown('#openServers', () => serversDialog(reopen));
  over.querySelectorAll('[data-kind]').forEach((b) => { b.onclick = () => createSession(b.dataset.kind, server.id, back); });
}
function serverPicker(servers, current, back) {
  openSheet({
    title: 'Choose a server', back: () => kindStep(servers, current, back),
    body: `<div class="list">${servers.map((server) => serverRow(server, server.online ? 'Connected' : serverProblem(server), 'data-server', server.id === current.id)).join('')}</div>`,
  });
  over.querySelectorAll('[data-server]').forEach((b) => { b.onclick = () => {
    chosenServerId = b.dataset.server;
    kindStep(servers, servers.find((server) => server.id === chosenServerId), back);
  }; });
}

async function createSession(kind, serverId, back) {
  const options = [...over.querySelectorAll('[data-kind]')];
  options.forEach((b) => { b.disabled = true; });
  const previous = session;
  try {
    const created = await bg('session.create', { kind, serverId });
    chosenServerId = serverId;
    await activateSession(created, []);
    addressStep(created, previous, back);
  } catch (error) {
    options.forEach((b) => { b.disabled = false; });
    showToast('Session not created', error.message);
  }
}

function addressStep(created, previous, back) {
  const [main, ...others] = orderAddresses(created.addresses || []);
  openSheet({
    title: 'Send this address to your AI',
    back: () => undoCreatedSession(created.id, previous).then(() => connectAi(back)),
    body: `<p class="lead">Paste it into your AI chat. It connects by itself.</p>
      ${main ? addressBox(main) : ''}
      ${others.length ? `<div class="sect">This computer only</div>${others.map((a) => addressBox(a)).join('')}` : ''}
      <div class="wait" id="aiWait" role="status"><span class="spin"></span>Waiting for your AI…</div>`,
    foot: main ? `<button class="btn pri big" id="copyAddress" data-copy="${esc(main.url)}">Copy address</button>` : '',
  });
  wireCopy(over);
}

// Going back means the address was not wanted: without this every retry leaves a session nobody will ever connect to.
async function undoCreatedSession(id, previous) {
  await bg('session.revoke', { id }).catch(() => {});
  if (!previous) return endSessionHere();
  const history = await bg('session.join', { id: previous.id }).catch(() => null);
  if (!history) return endSessionHere();
  await activateSession(previous, history);
}

function onAiConnected() {
  if (!$('#aiWait') || !over.classList.contains('on')) return;
  closeDialog();
  openChat();
}

const GRANT_SHOWN_MS = 700;
async function accessDialog() {
  if (!session) return sessionsDialog();
  const [grants, always] = await Promise.all([bg('grant.list', { session: session.id }), bg('grant.always').catch(() => [])]);
  const grantTitle = (g) => esc({ tab: 'This tab', page: 'This page', site: g.host, regexp: g.pattern }[g.kind] || g.kind);
  const ended = (g) => Boolean(g.until) && g.until <= Date.now();
  const timeLine = (g) => {
    if (!g.until) return 'Until you revoke it';
    return ended(g) ? `Ended ${ago(g.until).toLowerCase()}` : remaining(g.until);
  };
  const grantRow = (g) => `<div class="row grant${ended(g) ? ' ended' : ''}"><span class="rdot ${ended(g) ? 'warn' : 'ok'}"></span><span class="rmain"><span class="rtitle">${grantTitle(g)}</span><span class="rsub">${esc(timeLine(g))}</span></span></div>`;
  openSheet({
    title: 'AI access',
    body: `<p class="lead">Read the page, click, change the look and run JS.</p>
      ${grants.length ? `<div class="sect">This session</div><div class="list">${grants.map(grantRow).join('')}</div>` : '<p class="lead" id="noGrants">No access granted in this session yet.</p>'}
      <div id="grantBox"></div>
      ${always.length ? `<div class="sect">Every session</div><div class="list">${always.map((g, i) => `<div class="row grant always"><span class="rdot ok"></span><span class="rmain"><span class="rtitle">${grantTitle(g)}</span><span class="rsub">Any AI session, until you revoke it</span></span><button class="btn small danger" data-always="${i}">Revoke</button></div>`).join('')}</div>` : ''}`,
    foot: `<button class="btn pri" id="grantNew">Grant access</button>${grants.length ? '<button class="btn danger" id="grantsOff">Revoke all</button>' : ''}`,
  });
  onClickIfShown('#grantsOff', async () => { await bg('grant.clear', { session: session.id }); accessDialog(); });
  $('#grantNew').onclick = () => {
    $('#grantNew').remove();
    const box = over.querySelector('#grantBox');
    box.innerHTML = accessCardHtml(false);
    wireAccessCard(box.querySelector('.ask'), session.id, () => setTimeout(accessDialog, GRANT_SHOWN_MS));
  };
  over.querySelectorAll('[data-always]').forEach((b) => { b.onclick = async () => { await bg('grant.revokeAlways', { grant: always[Number(b.dataset.always)] }); accessDialog(); }; });
}

function appendAccessEnded() {
  const sessionId = session.id;
  appendSystem(`Access for ${session.ai || 'AI'} ended`);
  const line = $('#msgs').lastElementChild;
  line.classList.add('accend');
  line.insertAdjacentHTML('beforeend', '<button class="btn small" data-grant-again>Grant again</button>');
  line.querySelector('[data-grant-again]').onclick = (e) => {
    e.currentTarget.remove();
    const card = appendMessage(accessCardHtml(false), false).querySelector('.ask');
    wireAccessCard(card, sessionId);
  };
}
