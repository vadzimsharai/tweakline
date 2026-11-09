const ACCESS_SCOPES = [['tab', 'This tab'], ['page', 'Page'], ['site', 'Whole site'], ['regexp', 'Pattern']];
const ALWAYS = 'always';
const ACCESS_TIMES = [['1 hour', 3600e3], ['8 hours', 8 * 3600e3], ['24 hours', 24 * 3600e3], ['Forever', null], ['Every session', ALWAYS]];
const ALWAYS_INDEX = ACCESS_TIMES.findIndex(([, ttl]) => ttl === ALWAYS);
const DEFAULT_TIME_INDEX = 1;
// A grant's end is stored as a time, so history finds its length again within this slack.
const TTL_MATCH_MS = 5 * 60e3;
const PATTERN_PLACEHOLDER = 'https://site\\.example/path/.*';
const HISTORY_RETRY_MS = 3000;
const AI_STALE_MS = 90000;
const AT_END_PX = 24;
const TA_MAX_SHARE = 0.4;
const TA_MIN_MAX_LINES = 5;
const MIN_HISTORY_PX = 72;
const SHORT_VIEW_PX = 480;
const COMPAT_MOUSE_MS = 400;
const SCROLL_INTENT_MS = 1000;
const ICON_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"';
const ICON_CHECK_PATH = '<path d="m5 12.500 4.500 4.500L19 7.500"/>';
const OWN_STATES = {
  sending: { label: 'Sending', icon: `<svg ${ICON_ATTRS}><circle cx="12" cy="12" r="8"/><path d="M12 7.500V12l3 2"/></svg>` },
  sent: { label: 'Sent', icon: `<svg ${ICON_ATTRS}>${ICON_CHECK_PATH}</svg>` },
  read: { label: 'Read', icon: `<svg ${ICON_ATTRS}><path d="m2.500 12.500 4.500 4.500 9-9.500"/><path d="m12.500 16.500.5.500 9-9.500"/></svg>` },
};
const SAVE_ICON = `<svg ${ICON_ATTRS}>${ICON_CHECK_PATH}</svg>`;
const CHOSEN_ICON = `<svg class="actcheck" aria-hidden="true" ${ICON_ATTRS}>${ICON_CHECK_PATH}</svg>`;
const COMPOSER_PLACEHOLDER = 'Message';
const NO_SESSION_PLACEHOLDER = 'Connect AI first';
const CANCEL_ICON = `<svg width="16" height="16" ${ICON_ATTRS}><path d="M6 6l12 12M18 6 6 18"/></svg>`;
const CHATS_ICON = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 9.500a5.500 5.500 0 0 1-5.500 5.500H4l1.500-2.500A5.500 5.500 0 1 1 15 9.500Z"/><path d="M17.300 8.200A5.500 5.500 0 0 1 18.500 18.500L20 21h-5.500a5.500 5.500 0 0 1-4.300-2"/></svg>';
const UNTITLED_CHAT = 'Images and notes';
// Past any real height: the browser clamps it to the end of the list.
const SCROLL_PAST_END_PX = 1e6;

let renderedSeq = 0;
let draftMedia = [];
let shotOn = false;
let speech = null;
let editing = null;
let aiStatus = null;
let lastOwnSeq = 0, lastActionSeq = 0, lastAiSeq = 0, quietSeq = 0, newsAt = 0;
let actionInFlight = false;
let staleTimer = 0;
let renderingBatch = false;
let msgsAtEnd = true;
let statusLineEl = null;
let msgPress = null;
let keepFocusUntil = 0;
let pastChat = null;
let historyRetry = 0;

panel.querySelector('.comp').insertAdjacentHTML('beforebegin', `<div id="aiLine" class="off" role="status"></div><div id="editBar" class="off"><span>Editing message</span><button class="dicon" id="editCancel" aria-label="Cancel editing">${CANCEL_ICON}</button></div>
  <div id="pastBar" class="off"><span>An earlier chat</span><span class="pastBtns"><button class="btn small" id="pastBack">Back</button><button class="btn small pri" id="pastGo">Continue this chat</button></span></div>`);
$('#fullBtn').insertAdjacentHTML('beforebegin', `<button class="ib off" id="chatsBtn" title="Chats" aria-label="Chats">${CHATS_ICON}</button>`);
const sendIcon = $('#send').innerHTML;

function scrollMsgsToEnd() { $('#msgs').scrollTop = SCROLL_PAST_END_PX; }
function appendRaw(html) {
  $('#msgs').insertAdjacentHTML('beforeend', html);
  scrollMsgsToEnd();
  return $('#msgs').lastElementChild;
}
const aiWho = () => esc(session?.ai || 'AI');
const avatarText = () => esc((session?.ai || 'ai').slice(0, 2));
const continuesGroup = (previous, mine) => Boolean(previous?.classList.contains('m')) && previous.classList.contains('me') === mine;
function appendMessage(html, mine, seq) {
  const last = $('#msgs').lastElementChild;
  const continues = continuesGroup(last, Boolean(mine));
  const seqAttr = Number.isInteger(seq) ? ` data-seq="${seq}"` : '';
  if (mine) return appendRaw(`<div class="m me${continues ? ' cont' : ''}"${seqAttr}><div class="bub">${html}</div><div class="mstat"></div></div>`);
  if (continues) return appendRaw(`<div class="m cont"${seqAttr}><div><div class="bub">${html}</div></div></div>`);
  return appendRaw(`<div class="m"${seqAttr}><div class="av">${avatarText()}</div><div><div class="who">${aiWho()}</div><div class="bub">${html}</div></div></div>`);
}
function appendSystem(text) { appendRaw(`<div class="sysline">${esc(text)}</div>`); }

function buildGrant(kind, ttl, pattern, state) {
  if (ttl === ALWAYS) return { ...buildGrant(kind, null, pattern, state), always: true };
  const until = ttl === null ? null : Date.now() + ttl;
  const url = new URL(state.url);
  if (kind === 'tab') return { kind, tabId: state.tabId, until };
  if (kind === 'page') return { kind, url: state.url, until };
  if (kind === 'site') return { kind, host: url.hostname, until };
  return { kind: 'regexp', pattern, until };
}

// Without `asked` the person opened the card themselves, so it must not read as a request from the AI.
function accessCardHtml(asked = true) {
  const heading = asked ? `${aiWho()} asks to read and change this page` : 'Give access';
  return `<div class="ask"><div class="askh">${heading}</div>
    <div class="lab">Where</div>
    <div class="seg" data-seg="scope">${ACCESS_SCOPES.map(([k, label], i) => `<button class="${i ? '' : 'on'}" data-k="${k}">${label}</button>`).join('')}</div>
    <input class="inp reInp off" aria-label="Pattern" placeholder="${PATTERN_PLACEHOLDER}" autocomplete="off" spellcheck="false">
    <div class="rehint off">Must match the whole address, e.g. ${esc(PATTERN_PLACEHOLDER)}</div>
    <div class="lab">For how long</div>
    <div class="seg" data-seg="ttl">${ACCESS_TIMES.map(([label], i) => `<button class="${i === DEFAULT_TIME_INDEX ? 'on' : ''}" data-i="${i}"${i === ALWAYS_INDEX ? ' disabled' : ''}>${label}</button>`).join('')}</div>
    <div class="askbtns"><button class="btn pri askYes">Allow</button><button class="btn askNo">Deny</button></div></div>`;
}
const scopeLabel = (kind) => (ACCESS_SCOPES.find(([k]) => k === kind)?.[1] || '').toLowerCase();
function grantedLine(kind, timeLabel) {
  const details = [scopeLabel(kind), timeLabel?.toLowerCase()].filter(Boolean).join(', ');
  return `<div class="done-line"><i></i>${esc(details ? `Access granted: ${details}` : 'Access granted')}</div>`;
}
function grantTimeLabel(grant, grantedAt) {
  if (!grant || !('until' in grant)) return '';
  if (grant.until === null) return ACCESS_TIMES.find(([, ttl]) => ttl === null)[0];
  const length = grant.until - grantedAt;
  const match = ACCESS_TIMES.find(([, ttl]) => typeof ttl === 'number' && Math.abs(ttl - length) <= TTL_MATCH_MS);
  return match ? match[0] : '';
}
const answeredLine = (answer) => grantedLine(answer.data?.grant?.kind, grantTimeLabel(answer.data?.grant, answer.at));
const DENIED_LINE = '<div class="done-line off"><i></i>Access denied</div>';
const isDenial = (event) => event.type === 'action' && event.data?.action === 'access-denied';

function wireAccessCard(card, sessionId, onGranted) {
  let kind = 'tab';
  let timeIndex = DEFAULT_TIME_INDEX;
  const always = card.querySelector(`[data-i="${ALWAYS_INDEX}"]`);
  wireSegments((seg, b) => {
    if (seg.dataset.seg === 'scope') {
      kind = b.dataset.k;
      for (const patternPart of ['.reInp', '.rehint']) card.querySelector(patternPart).classList.toggle('off', kind !== 'regexp');
      // A tab ends with its session, so access for every session cannot be tied to it.
      always.disabled = kind === 'tab';
      if (always.disabled && timeIndex === ALWAYS_INDEX) {
        timeIndex = DEFAULT_TIME_INDEX;
        card.querySelectorAll('[data-seg=ttl] button').forEach((x) => x.classList.toggle('on', Number(x.dataset.i) === timeIndex));
      }
    } else timeIndex = Number(b.dataset.i);
  }, card);
  card.querySelector('.askYes').onclick = async () => {
    const pattern = card.querySelector('.reInp').value.trim();
    if (kind === 'regexp' && !pattern) { showToast('Enter a pattern'); return; }
    try {
      const state = await bg('state');
      await bg('grant.set', { session: sessionId, grant: buildGrant(kind, ACCESS_TIMES[timeIndex][1], pattern, state) });
      card.innerHTML = grantedLine(kind, ACCESS_TIMES[timeIndex][0]);
      onGranted?.();
    } catch (error) { showToast('Access not granted', error.message); }
  };
  card.querySelector('.askNo').onclick = () => {
    bg('chat.action', { session: sessionId, action: 'access-denied' }).catch(() => {});
    card.innerHTML = DENIED_LINE;
  };
}

function keepMsgsAtEnd() { if (msgsAtEnd) scrollMsgsToEnd(); }

const fileList = (files) => (Array.isArray(files) ? files.filter((f) => (f && typeof f === 'object') || typeof f === 'string') : []);
function renderFiles(holder, sessionId, files) {
  for (const file of fileList(files)) {
    const box = document.createElement('span');
    box.className = 'msgimg';
    holder.append(box);
    bg('file.fetch', { session: sessionId, file: file.id ?? file }).then(({ type, base64 }) => {
      const src = `data:${type};base64,${base64}`;
      if ((type || '').startsWith('video')) box.innerHTML = `<video src="${esc(src)}" controls muted playsinline></video>`;
      else if (!isPicture(type)) { box.classList.add('msgfile'); box.innerHTML = `<a href="${esc(src)}" download="${esc(file.name || 'file')}">${esc(file.name || 'File')}</a>`; }
      else {
        box.innerHTML = `<img src="${esc(src)}" alt="">`;
        const image = box.querySelector('img');
        image.onclick = () => openViewer([{ kind: 'shot', dataUrl: src }], 0);
        image.onload = keepMsgsAtEnd;
      }
      keepMsgsAtEnd();
    }).catch(() => { box.classList.add('gone'); box.textContent = 'File not available'; });
  }
}

const filesHolder = (files) => (fileList(files).length ? '<div class="mfiles"></div>' : '');
function renderMessageFiles(el, sessionId, files) {
  if (fileList(files).length) renderFiles(el.querySelector('.mfiles'), sessionId, files);
}
const ownMessageHtml = ({ notes = '', text = '', holder = '' }) => `${holder}${notes && `<div class="mnotes">${notes}</div>`}${text && `<div class="mtext">${esc(text)}</div>`}`;

function paintOwnLine(el, state) {
  const parts = [];
  if (state) parts.push(`<span class="mst ${state}">${OWN_STATES[state].icon}${OWN_STATES[state].label}</span>`);
  if (el.dataset.edited) parts.push('<span class="medited">edited</span>');
  el.querySelector('.mstat').innerHTML = parts.join('');
}

function applyEdit(event) {
  const el = root.querySelector(`#msgs .m.me[data-seq="${Number(event.data?.target)}"]`);
  lastOwnSeq = Math.max(lastOwnSeq, event.seq);
  if (!el) return;
  const text = el.querySelector('.mtext');
  if (text) text.textContent = event.data.text;
  el.dataset.edited = '1';
  paintOwnLine(el, el === statusLineEl ? ownState(el) : null);
}

function chooseAction(acts, button) {
  acts.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  button.classList.add('chosen');
  button.setAttribute('aria-pressed', 'true');
  button.insertAdjacentHTML('afterbegin', CHOSEN_ICON);
}
function unchooseAction(acts, button) {
  acts.querySelectorAll('button').forEach((b) => { b.disabled = false; });
  button.classList.remove('chosen');
  button.removeAttribute('aria-pressed');
  button.querySelector('.actcheck')?.remove();
}
async function pressAction(acts, button, sessionId) {
  if (acts.querySelector('.chosen')) return;
  chooseAction(acts, button);
  actionInFlight = true;
  newsAt = Date.now();
  syncAiLine();
  try {
    const event = await bg('chat.action', { session: sessionId, action: button.dataset.action });
    if (session?.id === sessionId) await deliverEvent(event);
  } catch (error) {
    unchooseAction(acts, button);
    showToast('Not sent', error.message);
  } finally {
    actionInFlight = false;
    syncAiLine();
  }
}
// Action events carry only the id, so the choice goes to the newest group that offers it and has none yet.
function applyAction(event) {
  const id = event.data?.action;
  lastActionSeq = event.seq;
  newsAt = Math.max(newsAt, event.at || 0);
  const groups = [...root.querySelectorAll('#msgs .acts')].reverse();
  for (const acts of groups) {
    const button = [...acts.querySelectorAll('[data-action]')].find((b) => b.dataset.action === id);
    if (!button) continue;
    if (button.classList.contains('chosen')) return;
    if (!acts.querySelector('.chosen')) { chooseAction(acts, button); return; }
  }
}

const eventData = (event) => (event.data && typeof event.data === 'object' ? event.data : {});
function renderAiMessage(event) {
  const data = eventData(event);
  const sessionId = session?.id;
  const actions = Array.isArray(data.actions) ? data.actions.filter((a) => a && typeof a === 'object') : [];
  const el = appendMessage(`${filesHolder(data.files)}${renderMarkdown(data.text)}${data.ask?.access ? accessCardHtml() : ''}`, false, event.seq);
  const card = el.querySelector('.ask');
  if (card) {
    if (event.answer) card.innerHTML = isDenial(event.answer) ? DENIED_LINE : answeredLine(event.answer);
    else wireAccessCard(card, sessionId);
  }
  renderMessageFiles(el, sessionId, data.files);
  if (actions.length) {
    const acts = document.createElement('div');
    acts.className = 'acts';
    acts.innerHTML = actions.map((a) => `<button class="${a.primary ? 'pri' : ''}" data-action="${esc(a.id ?? '')}">${esc(a.label ?? '')}</button>`).join('');
    el.querySelector('.bub').parentElement.append(acts);
    scrollMsgsToEnd();
    acts.addEventListener('click', (e) => {
      const b = e.target.closest('[data-action]');
      if (b) pressAction(acts, b, sessionId);
    });
  }
  lastAiSeq = event.seq;
  aiStatus = null;
  countUnread();
}

const noteChipsHtml = (notes) => (Array.isArray(notes) ? notes.filter((n) => n && typeof n === 'object') : [])
  .map((n) => `<span class="chip">${esc(n.n ?? '')} ${esc(MARK_NAMES[n.kind] || '')}${n.text ? ': ' + esc(n.text) : ''}</span>`).join('');
const visibleChat = () => pastChat ?? session?.chat;
function countUnread() {
  if (!chatOpen) { unreadChat += 1; syncRail(); }
}

// A late answer to an earlier chat must not get lost behind a new one.
function noteOtherChat(event) {
  appendRaw(`<div class="sysline"><button class="otherChat" data-chat="${esc(event.chat)}">${aiWho()} replied in an earlier chat</button></div>`);
  countUnread();
}

function renderEvent(event) {
  if (!Number.isInteger(event?.seq) || event.seq <= renderedSeq) return;
  renderedSeq = event.seq;
  const data = eventData(event);
  if (event.type === 'title') return syncSession();
  if (event.type === 'chat') {
    if (!renderingBatch) followChat(data.chat);
    return;
  }
  if (event.chat && event.chat !== visibleChat()) {
    if (event.type === 'ai' && !renderingBatch && !pastChat) noteOtherChat(event);
    return;
  }
  if (event.type === 'user') {
    const el = appendMessage(ownMessageHtml({ notes: noteChipsHtml(data.notes), text: data.text, holder: filesHolder(data.files) }), true, event.seq);
    renderMessageFiles(el, session?.id, data.files);
    lastOwnSeq = event.seq;
  } else if (event.type === 'edit') applyEdit(event);
  else if (event.type === 'action' && !isDenial(event)) applyAction(event);
  else if (event.type === 'patch') appendSystem(`Patch "${data.patch?.title ?? ''}" sent to AI`);
  else if (event.type === 'ai') renderAiMessage(event);
  else return;
  if (!renderingBatch) syncFeedback();
}
// One malformed event must not keep the rest of the history from showing.
function renderEventSafely(event) {
  try { renderEvent(event); } catch (error) { console.warn('Tweakline', error); }
}

function renderHistory(events) {
  $('#msgs').textContent = '';
  renderedSeq = 0;
  lastOwnSeq = 0;
  lastActionSeq = 0;
  actionInFlight = false;
  lastAiSeq = 0;
  quietSeq = 0;
  aiStatus = null;
  statusLineEl = null;
  newsAt = session?.seenAt || 0;
  stopEdit();
  closeMsgTools();
  if (!session) pastChat = null;
  panel.classList.toggle('past', Boolean(pastChat));
  $('#pastBar').classList.toggle('off', !pastChat);
  const valid = (Array.isArray(events) ? events : []).filter((e) => e && typeof e === 'object');
  const answers = valid.filter((e) => e.type === 'access' || isDenial(e));
  renderingBatch = true;
  try {
    for (const event of valid) renderEventSafely({ ...event, answer: answers.find((a) => a.seq > event.seq) });
  } finally {
    renderingBatch = false;
  }
  renderNoSession();
  syncFeedback();
}

// ── read and working feedback ──────────────────────

function ownState(el) {
  if (el.classList.contains('pending')) return 'sending';
  return (session?.seenSeq || 0) >= lastOwnSeq ? 'read' : 'sent';
}
function syncOwnStatus() {
  const own = root.querySelectorAll('#msgs .m.me');
  const last = own[own.length - 1] || null;
  if (statusLineEl && statusLineEl !== last && statusLineEl.isConnected) paintOwnLine(statusLineEl, null);
  statusLineEl = last;
  if (last) paintOwnLine(last, ownState(last));
}
function aiLineContent() {
  if (!session?.polling) return null;
  const who = session.ai || 'AI';
  const answeredUpTo = Math.max(lastAiSeq, quietSeq);
  const messageRead = lastOwnSeq > answeredUpTo && (session.seenSeq || 0) >= lastOwnSeq;
  const awaitingReply = messageRead || actionInFlight || lastActionSeq > answeredUpTo;
  const live = aiStatus ? aiStatus.text || `${who} is ${aiStatus.state}…` : awaitingReply ? `${who} is working…` : '';
  if (!live) return { text: '', live: false };
  if (Date.now() - newsAt >= AI_STALE_MS) return { text: `No reply from ${who} yet`, short: 'No reply yet', live: false };
  return { text: live, live: true };
}
function syncAiLine() {
  const line = $('#aiLine');
  const content = aiLineContent();
  line.classList.toggle('off', !content);
  line.classList.toggle('blank', !content?.text);
  clearTimeout(staleTimer);
  if (!content) return;
  // Rewriting the same text would restart the dots on every presence or message update.
  if (line.dataset.text !== content.text || line.classList.contains('live') !== content.live) {
    line.dataset.text = content.text;
    line.classList.toggle('live', content.live);
    line.dataset.short = content.short || '';
    line.innerHTML = `${content.live ? '<span class="aidots" aria-hidden="true"><i></i><i></i><i></i></span>' : ''}<span class="aitext">${esc(content.text)}</span>`;
    fitAiLine();
  }
  if (content.live) staleTimer = setTimeout(syncAiLine, newsAt + AI_STALE_MS - Date.now());
}
// A narrow chat cuts the AI name off mid-word, so the line falls back to its short form instead.
function fitAiLine() {
  const line = $('#aiLine'), text = line.querySelector('.aitext');
  if (!text || !line.dataset.short) return;
  text.textContent = line.dataset.text;
  if (text.scrollWidth > text.clientWidth) text.textContent = line.dataset.short;
}
function syncPlaceholder() {
  $('#ta').placeholder = session ? COMPOSER_PLACEHOLDER : NO_SESSION_PLACEHOLDER;
  $('#chatsBtn').classList.toggle('off', !session);
}
function syncFeedback() {
  syncPlaceholder();
  syncOwnStatus();
  syncAiLine();
}
function onAiSeen(seq) {
  if (!session || seq <= (session.seenSeq || 0)) return;
  session.seenSeq = seq;
  newsAt = Date.now();
  syncFeedback();
}
function onAiStatus({ state, text, chat }) {
  if (chat && session?.chat && chat !== session.chat) return;
  newsAt = Date.now();
  if (state === 'idle') {
    aiStatus = null;
    quietSeq = Math.max(lastOwnSeq, lastActionSeq);
  } else aiStatus = { state, text };
  syncAiLine();
}

// ── composer ───────────────────────────────────────

function measureTextarea(ta, style) {
  const line = parseFloat(style.lineHeight);
  const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  ta.style.setProperty('--ta-h', '0px');
  const room = $('#msgs').offsetHeight + ta.offsetHeight - padding - MIN_HISTORY_PX;
  return { line, padding, room, lines: Math.max(1, Math.ceil((ta.scrollHeight - padding) / line)) };
}
// A tall input next to three buttons is a narrow column, so once text wraps it takes the whole width.
function syncComposer() {
  const ta = $('#ta'), comp = ta.closest('.comp');
  if (!ta.offsetWidth) return;
  const { scrollTop } = ta;
  ta.classList.remove('capped');
  const style = getComputedStyle(ta);
  comp.classList.remove('multi');
  let size = measureTextarea(ta, style);
  if (size.lines > 1) {
    comp.classList.add('multi');
    size = measureTextarea(ta, style);
  }
  const wantedLines = Math.max(TA_MIN_MAX_LINES, Math.floor((panel.offsetHeight * TA_MAX_SHARE - size.padding) / size.line));
  // A soft keyboard leaves little height: the history keeps its share even below the usual minimum of lines.
  const maxLines = Math.max(1, Math.min(wantedLines, Math.floor(size.room / size.line)));
  // With room for one line a separate button row would take more from the history than it gives the text.
  if (maxLines === 1) comp.classList.remove('multi');
  // Scrolled text shows through the padding as a sliver of a line, so a capped input moves padding to margin.
  const capped = size.lines > maxLines;
  ta.classList.toggle('capped', capped);
  ta.style.setProperty('--ta-h', `${(capped ? 0 : size.padding) + Math.min(size.lines, maxLines) * size.line}px`);
  const caretAtEnd = ta.selectionEnd === ta.value.length;
  ta.scrollTop = capped && caretAtEnd ? ta.scrollHeight : Math.round(scrollTop / size.line) * size.line;
}
function setComposerText(text) {
  $('#ta').value = text;
  syncComposer();
}

function startEdit(el) {
  stopEdit();
  const original = el.querySelector('.mtext').textContent;
  editing = { seq: Number(el.dataset.seq), el, original, draft: $('#ta').value, saving: false };
  el.classList.add('edit-target');
  $('#editBar').classList.remove('off');
  panel.querySelector('.comp').classList.add('editing');
  $('#send').innerHTML = SAVE_ICON;
  $('#send').setAttribute('aria-label', 'Save edit');
  setComposerText(original);
  const ta = $('#ta');
  ta.focus();
  ta.setSelectionRange(original.length, original.length);
  keepFocusUntil = performance.now() + COMPAT_MOUSE_MS;
}
function stopEdit() {
  if (!editing) return;
  const { el, draft } = editing;
  editing = null;
  el.classList.remove('edit-target');
  $('#editBar').classList.add('off');
  panel.querySelector('.comp').classList.remove('editing');
  $('#send').innerHTML = sendIcon;
  $('#send').setAttribute('aria-label', 'Send');
  setComposerText(draft);
}
async function saveEdit() {
  const text = $('#ta').value.trim();
  if (!text || editing.saving) return;
  if (text === editing.original) return stopEdit();
  editing.saving = true;
  try {
    const event = await bg('chat.edit', { session: session.id, target: editing.seq, text });
    stopEdit();
    await deliverEvent(event);
  } catch (error) {
    if (editing) editing.saving = false;
    showToast('Not saved', error.message);
  }
}

// ── tapping an own message ─────────────────────────

const closeMsgTools = () => root.querySelector('#msgs .mtools')?.remove();
async function copyMessage(el, button) {
  try {
    await copyText(el.querySelector('.mtext').textContent);
    button.textContent = 'Copied';
  } catch {
    showToast('Could not copy', 'The browser blocked it');
  }
}
function toggleMsgTools(el) {
  const wasOpen = Boolean(el.querySelector('.mtools'));
  closeMsgTools();
  if (wasOpen) return;
  el.querySelector('.bub').insertAdjacentHTML('afterend', '<div class="mtools"><button class="btn small mEdit">Edit</button><button class="btn small mCopy">Copy</button></div>');
  el.querySelector('.mEdit').onclick = () => { closeMsgTools(); startEdit(el); };
  el.querySelector('.mCopy').onclick = (e) => copyMessage(el, e.currentTarget);
  const msgs = $('#msgs');
  const overflow = el.getBoundingClientRect().bottom - msgs.getBoundingClientRect().bottom;
  if (overflow > 0) msgs.scrollTop += overflow / viewScale;
}
function syncShortView() {
  stage.classList.toggle('short', stage.offsetHeight < SHORT_VIEW_PX);
  keepMsgsAtEnd();
}
function wireMessageTaps() {
  const msgs = $('#msgs');
  msgs.addEventListener('pointerdown', (e) => { msgPress = { id: e.pointerId, x: uiX(e), y: uiY(e), target: e.target }; }, true);
  window.addEventListener('pointercancel', () => { msgPress = null; }, true);
  // Pointer events, not click: touch browsers can drop the click after a swipe, and a swipe must not count as a tap.
  window.addEventListener('pointerup', (e) => {
    const press = msgPress;
    msgPress = null;
    if (!press || press.id !== e.pointerId || suppressClick) return;
    if (Math.hypot(uiX(e) - press.x, uiY(e) - press.y) > DRAG_START_PX) return;
    if (press.target.closest('.mtools') || pastChat) return;
    const bubble = press.target.closest('.m.me[data-seq] .bub');
    if (!bubble || press.target.closest('a,img,video,button') || !bubble.querySelector('.mtext')) { closeMsgTools(); return; }
    toggleMsgTools(bubble.parentElement);
    // The row can appear under the finger, and the click that follows this tap must not press it.
    suppressClick = true;
  }, true);
  // Only the person leaves the end: layout changes also move the list, and their scroll events arrive late.
  let scrolledByHandAt = -Infinity;
  const noteHand = () => { scrolledByHandAt = performance.now(); };
  for (const type of ['touchmove', 'wheel', 'keydown']) msgs.addEventListener(type, noteHand, { capture: true, passive: true });
  msgs.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') noteHand(); }, true);
  msgs.addEventListener('scroll', () => {
    if (!msgs.clientHeight) return;
    if (msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < AT_END_PX) msgsAtEnd = true;
    else if (performance.now() - scrolledByHandAt < SCROLL_INTENT_MS) msgsAtEnd = false;
  }, { passive: true });
  new ResizeObserver(keepMsgsAtEnd).observe(msgs);
  new ResizeObserver(() => { syncComposer(); fitAiLine(); }).observe(panel);
  // The visual viewport shrinks under a soft keyboard and media queries do not see that, the stage does.
  new ResizeObserver(syncShortView).observe(stage);
}
function wireComposer() {
  // After a tap the browser sends a mouse press at the same spot, and that would blur the input and close the keyboard.
  root.addEventListener('mousedown', (e) => { if (performance.now() < keepFocusUntil) e.preventDefault(); }, true);
  $('#ta').addEventListener('input', syncComposer);
  $('#editCancel').onclick = stopEdit;
  $('#ta').addEventListener('keydown', (e) => { if (e.key === 'Escape' && editing) stopEdit(); });
  wireMessageTaps();
}

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const isPicture = (type) => /^image\//.test(type || '');

async function attachFiles(files) {
  for (const file of files) {
    if (file.size > MAX_UPLOAD_BYTES) { showToast(`${file.name} is too big`, 'Files up to 10 MB'); continue; }
    try {
      const dataUrl = await readDataUrl(file);
      const kind = isPicture(file.type) ? 'upload' : 'file';
      const id = await bg('media.add', { kind, dataUrl, name: file.name, type: file.type, url: location.href });
      attachMedia([{ id, kind, dataUrl, name: file.name, type: file.type }]);
    } catch (error) { showToast(`${file.name} not attached`, error.message); }
  }
}

function renderDraft() {
  root.querySelectorAll('#chips .att').forEach((el) => el.remove());
  const preview = (item) => (item.kind === 'file' ? `<span class="attfile">${esc(item.name || 'File')}</span>` : `<img src="${esc(item.poster || item.dataUrl)}" alt="">`);
  const html = draftMedia.map((item, i) => `<span class="att">${preview(item)}<button class="x" data-unattach="${i}" aria-label="Remove attachment">×</button></span>`).join('');
  $('#chips').insertAdjacentHTML('afterbegin', html);
}
function attachMedia(items) {
  for (const item of items) if (!draftMedia.some((d) => d.id === item.id)) draftMedia.push(item);
  renderDraft();
}

// Pending notes go with whatever is sent: the AI gets the page as it is, then the same view with the notes drawn.
async function notesMedia(notesToSend) {
  if (!notesToSend.length) return [];
  return captureNotesPair();
}
async function sendChat() {
  if (editing) return saveEdit();
  const text = $('#ta').value.trim();
  if (!session) return sessionsDialog();
  const notesToSend = pendingNotes();
  if (!text && !draftMedia.length && !notesToSend.length && !shotOn) return;
  const sessionId = session.id;
  const attached = draftMedia;
  const thumbs = attached.map((item) => `<span class="msgimg"><img src="${esc(item.poster || item.dataUrl)}" alt=""></span>`).join('');
  const notes = noteChipsHtml(notesToSend.map(plainNote));
  const pending = appendMessage(ownMessageHtml({ notes, text, holder: thumbs && `<div class="mfiles">${thumbs}</div>` }), true);
  pending.classList.add('pending');
  draftMedia = [];
  renderDraft();
  setComposerText('');
  syncFeedback();
  try {
    const media = [...await notesMedia(notesToSend), ...attached.map((d) => d.id)];
    if (shotOn && !media.length) media.push(await captureForChat());
    const event = await bg('chat.send', { session: sessionId, text, media, notes: notesToSend.length ? notesToSend.map(plainNote) : undefined });
    if (notesToSend.length) {
      await rememberSent(notesToSend);
      removeNotes(notesToSend);
      showMarks();
    }
    await deliverEvent(event);
  } catch (error) {
    showMarks();
    draftMedia = [...attached, ...draftMedia];
    renderDraft();
    if (!$('#ta').value) setComposerText(text);
    showToast('Not sent', error.message);
  } finally {
    const next = pending.nextElementSibling;
    pending.remove();
    if (next?.classList.contains('me')) next.classList.toggle('cont', continuesGroup(next.previousElementSibling, true));
    syncFeedback();
  }
}
async function pullHistory() {
  if (!session) return;
  const { id } = session;
  const events = await bg('session.history', { id, after: renderedSeq });
  if (session?.id !== id) return;
  clearTimeout(historyRetry);
  (Array.isArray(events) ? events : []).forEach(renderEventSafely);
}
function retryHistoryLater() {
  clearTimeout(historyRetry);
  historyRetry = setTimeout(() => pullHistory().catch(retryHistoryLater), HISTORY_RETRY_MS);
}
// Own messages are not pushed, so an event past a gap has to wait for what came before it.
async function deliverEvent(event) {
  if (!Number.isInteger(event?.seq)) return pullHistory();
  const id = session?.id;
  if (event.seq > renderedSeq + 1) {
    // Rendering it anyway would move past the gap for good, so the pull is retried and brings this event too.
    try { await pullHistory(); } catch { retryHistoryLater(); return; }
  }
  if (session?.id === id) renderEvent(event);
}

function toggleSpeech() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) { showToast('Voice unavailable', 'Use the keyboard microphone'); return; }
  if (speech) { speech.stop(); return; }
  speech = new Recognition();
  speech.lang = navigator.language;
  speech.interimResults = false;
  speech.onresult = (event) => {
    const words = [...event.results].map((r) => r[0].transcript).join(' ');
    setComposerText(`${$('#ta').value} ${words}`.trim());
  };
  speech.onerror = (event) => showToast('Voice failed', event.error);
  speech.onend = () => { speech = null; $('#micBtn').classList.remove('on'); $('#rec').classList.remove('on'); };
  speech.start();
  $('#micBtn').classList.add('on');
  $('#rec').classList.add('on');
}

// ── chats in a session ─────────────────────────────

async function reloadChatView() {
  if (!session) return;
  const { id } = session;
  const events = await bg('session.history', { id, after: 0 });
  if (session?.id === id) renderHistory(events);
}
function followChat(chat) {
  if (!session || !chat || (chat === session.chat && !pastChat)) return;
  session.chat = chat;
  pastChat = null;
  reloadChatView().catch((error) => console.warn('Tweakline', error));
}
async function startNewChat() {
  if (!session) return sessionsDialog();
  try {
    const started = await bg('chat.new', { session: session.id });
    pastChat = null;
    session.chat = started.chat;
    await reloadChatView();
    $('#ta').focus();
  } catch (error) { showToast('No new chat', error.message); }
}
async function viewChat(chat) {
  closeDialog();
  openChat();
  pastChat = chat === session.chat ? null : chat;
  await reloadChatView();
}
async function continuePastChat() {
  try {
    const event = await bg('chat.continue', { session: session.id, chat: pastChat });
    pastChat = null;
    session.chat = event.chat;
    await reloadChatView();
  } catch (error) { showToast('Could not continue', error.message); }
}

const messageCount = (value) => {
  const count = Number(value) || 0;
  return `${count} ${count === 1 ? 'message' : 'messages'}`;
};
function chatRow(chat) {
  return `<button class="row${chat.current ? ' on' : ''}" data-chat="${esc(chat.id)}"><span class="rmain"><span class="rtitle">${esc(chat.title || UNTITLED_CHAT)}</span><span class="rsub">${messageCount(chat.count)}</span></span><span class="rmeta">${chat.current ? 'Now' : esc(ago(chat.lastAt))}</span></button>`;
}
async function chatsDialog() {
  if (!session) return sessionsDialog();
  const { id } = session;
  const chats = await bg('chat.list', { session: id }).catch((error) => { showToast('Chats not loaded', error.message); return null; });
  if (!chats || session?.id !== id) return;
  openSheet({
    title: 'Earlier chats',
    body: chats.length ? `<div class="list">${chats.map(chatRow).join('')}</div>` : '<p class="lead">No chats yet. Each new chat starts a separate conversation with your AI.</p>',
    foot: '<button class="btn pri full" id="chatsNew">New chat</button>',
  });
  $('#chatsNew').onclick = () => { closeDialog(); startNewChat(); };
  over.querySelectorAll('[data-chat]').forEach((row) => { row.onclick = () => viewChat(row.dataset.chat); });
}
function chatsMenu(anchor) {
  openMenu('<button data-chats="new">New chat</button><button data-chats="earlier">Earlier chats</button>', anchor);
}
$('#chatsBtn').onclick = (e) => chatsMenu(e.currentTarget);
menu.addEventListener('click', (e) => {
  const choice = e.target.closest('[data-chats]')?.dataset.chats;
  if (choice === 'new') startNewChat();
  if (choice === 'earlier') chatsDialog();
});
$('#pastBack').onclick = () => { pastChat = null; reloadChatView(); };
$('#pastGo').onclick = continuePastChat;
$('#msgs').addEventListener('click', (e) => {
  const other = e.target.closest('.otherChat');
  if (other) viewChat(other.dataset.chat);
});
