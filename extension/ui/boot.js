const LOCAL_EVENTS = ['pointerdown', 'pointerup', 'click', 'dblclick', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'keydown', 'keyup', 'keypress', 'input', 'beforeinput', 'paste', 'wheel', 'contextmenu'];
const URL_POLL_MS = 1000;
let idleTimer = 0;

const RAIL_IDLE_MS = 10000;
let railIdleTimer = 0;
function markActive() {
  stage.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => stage.classList.add('idle'), IDLE_MS);
  clearTimeout(railIdleTimer);
  railIdleTimer = setTimeout(collapseIdleRail, RAIL_IDLE_MS);
}
// An open rail with nothing in use folds back into the badge on its own.
function collapseIdleRail() {
  const busy = chatOpen || over.classList.contains('on') || menu.classList.contains('on') || rail.querySelector('.ext.open')
    || stage.classList.contains('marking') || stage.classList.contains('recording');
  if (!railOpen || busy) { if (railOpen) railIdleTimer = setTimeout(collapseIdleRail, RAIL_IDLE_MS); return; }
  railOpen = false;
  syncRail();
}
function setHidden(hidden) {
  connected = !hidden;
  stage.classList.toggle('ext-hidden', hidden);
  marksLayer.style.display = hidden ? 'none' : '';
  if (!hidden) placeNoteLabels();
}
function runCommand(command) {
  if (command === 'chat') { if (chatOpen) closeChat(outward()); else openChat(); return; }
  if (command === 'shot') return copyPageShot();
  if (command === 'video') return recording ? stopRecording() : startRecording();
  if (command === 'gallery') return galleryDialog();
  if (command === 'patches') return patchesDialog();
  if (command.startsWith('note-')) chooseTool(command.slice('note-'.length));
}

function wireUi() {
  for (const type of LOCAL_EVENTS) host.addEventListener(type, (e) => e.stopPropagation());
  root.addEventListener('pointerdown', markActive, true);
  root.addEventListener('pointerdown', (e) => { if (e.target.closest('#rail')) closeDialog(); }, true);
  root.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('#wmenu,#posBtn,#rMore')) closeMenu();
    if (!e.target.closest('#rail,#noteBox,#over,#viewer') && !stage.classList.contains('marking')) closeExt();
  }, true);
  $('#collapse').onclick = () => closeChat(outward());
  $('#sessBtn').onclick = sessionsDialog;
  $('#posBtn').onclick = (e) => positionMenu(e.currentTarget);
  $('#fullBtn').onclick = () => setPosition(mode === 'full' ? lastDocked : 'full');
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    closeMenu();
    if (b.dataset.pos) return setPosition(b.dataset.pos);
    if (b.dataset.act === 'sessions') sessionsDialog();
    if (b.dataset.act === 'servers') serversDialog();
    if (b.dataset.act === 'access') accessDialog();
    if (b.dataset.act === 'gest') gesturesDialog();
    if (b.dataset.act === 'keys') keysDialog();
    if (b.dataset.act === 'hide') bg('ui.setHidden', { hidden: true });
  });
  $('#rNotes').onclick = () => toggleExt('extNotes');
  $('#rMedia').onclick = () => toggleExt('extMedia');
  $('#extList').onclick = () => { closeExt(); notesDialog(); };
  $('#extSend').onclick = () => sendNotes('', { stayOnPage: true });
  $('#rChat').onclick = () => { if (chatOpen) closeChat(outward()); else openChat(); };
  $('#rPatches').onclick = patchesDialog;
  $('#rMore').onclick = (e) => moreMenu(e.currentTarget);
  $('#mShot').onclick = copyPageShot;
  $('#mVideo').onclick = startRecording;
  $('#mGallery').onclick = () => { closeExt(); galleryDialog(); };
  root.querySelectorAll('.ext [data-tool]').forEach((b) => { b.onclick = () => chooseTool(b.dataset.tool); });
  $('#plusBtn').onclick = async () => {
    const none = (await galleryItems().catch(() => [])).length === 0;
    $('#addLast').disabled = none;
    $('#addPick').disabled = none;
    $('#plus').classList.toggle('on');
  };
  $('#plus').onclick = () => $('#plus').classList.remove('on');
  $('#addMedia').onclick = () => $('#pickMedia').click();
  $('#addFile').onclick = () => $('#pickFile').click();
  for (const input of [$('#pickMedia'), $('#pickFile')]) {
    input.onchange = () => { attachFiles([...input.files]).finally(() => { input.value = ''; }); };
  }
  $('#addShot').onclick = async () => {
    try {
      const dataUrl = await capturePage();
      const id = await bg('media.add', { kind: 'shot', dataUrl, url: location.href });
      attachMedia([{ id, kind: 'shot', dataUrl }]);
    } catch (error) { showToast('Screenshot not saved', error.message); }
  };
  $('#addLast').onclick = async () => { const [last] = await galleryItems(); if (last) attachMedia([last]); };
  $('#addPick').onclick = galleryDialog;
  $('#micBtn').onclick = toggleSpeech;
  $('#shotBtn').onclick = (e) => {
    shotOn = !shotOn;
    e.currentTarget.classList.toggle('on', shotOn);
    e.currentTarget.setAttribute('aria-pressed', shotOn);
  };
  $('#send').onclick = sendChat;
  wireComposer();
  $('#ta').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) { e.preventDefault(); sendChat(); }
  });
  $('#chips').addEventListener('click', (e) => {
    if (e.target.closest('#notesChip')) notesDialog();
    const un = e.target.closest('[data-unattach]');
    if (un) { draftMedia.splice(Number(un.dataset.unattach), 1); renderDraft(); }
  });
  wireMarkPointers();
  wireViewer();
  wireCompare();
}

function onMessage(message) {
  if (message?.to !== 'ui') return;
  if (message.type === 'hidden') setHidden(message.hidden);
  if (message.type === 'frame') drawVideoFrame(message.data);
  if (message.type === 'command') runCommand(message.command);
  if (message.type === 'proposePatch') addPatchDraft(message.proposal);
  if (message.type === 'event' && session?.id === message.session) {
    if (message.event.type === 'title') { session.title = message.event.data.title; session.ai = message.event.data.ai; session.polling = true; syncSession(); }
    deliverEvent(message.event).catch((error) => console.warn('Tweakline', error));
    if (message.event.type === 'ai' || message.event.type === 'title') onAiConnected();
  }
  if (message.type === 'seen' && session?.id === message.session) onAiSeen(message.seq);
  if (message.type === 'status' && session?.id === message.session) onAiStatus(message);
  if (message.type === 'accessEnded' && session?.id === message.session) appendAccessEnded();
  if (message.type === 'presence' && session?.id === message.session) { session.polling = message.online; syncSession(); if (message.online) onAiConnected(); }
  if (message.type === 'connection' && message.online) { refreshCurrentSession().catch(() => {}); pullHistory().catch(retryHistoryLater); }
  if (message.type === 'shooting') stage.classList.toggle('shooting', message.on);
  if (message.type === 'reloading') showToast('Undoing a change', 'It had no undo code, so the page reloads');
}

async function boot() {
  // The newest copy always takes the page: nothing the page can write keeps it out.
  document.querySelectorAll(`${WG_HOST_TAG},${WG_MARKS_TAG}`).forEach((older) => older.remove());
  document.documentElement.append(marksHost, host);
  setInterval(() => { if (!retired && replacedByNewerCopy()) retire(); }, URL_POLL_MS);
  stage.dataset.side = 'right';
  wireUi();
  setPosition('column');
  syncViewport();
  window.visualViewport?.addEventListener('resize', () => { syncViewport(); placeOpenBox?.(); });
  window.visualViewport?.addEventListener('scroll', syncViewport);
  window.addEventListener('resize', syncViewport);
  window.addEventListener('scroll', placeNoteLabels, { passive: true });
  chrome.runtime.onMessage.addListener(onMessage);
  markActive();
  renderNoSession();
  syncSession();
  await loadNotesForUrl();
  setInterval(loadNotesForUrl, URL_POLL_MS);
  const state = await bg('state');
  setHidden(state.hidden);
  if (!state.sessionId) return;
  const list = await bg('session.list').catch(() => []);
  const found = list.find((s) => s.id === state.sessionId);
  // The list can take seconds with a server down, and by then the person may have picked another session.
  if (!found || session) return;
  await activateSession(found, await bg('session.history', { id: found.id, after: 0 }).catch(() => []));
}
boot().catch((error) => console.warn('Tweakline', error));
