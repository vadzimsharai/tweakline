const EMPTY_MARK = '​';
const DELETES_TO_CANCEL = 2;
const LOUPE_SIZE = 116;
const LOUPE_ZOOM = 2.2;
const LOUPE_LIFT = 86;
const MIN_MARK_PX = 16;
const HANDLE_HIT_PX = 24;
const FRAME_REUSE_MS = 5000;
const UI_SETTLE_MS = 70;
const CAPTION_MAX_H = 120;
// Browsers allow two tab captures per second.
const CAPTURE_GAP_MS = 520;
const NOTES_KEY_PREFIX = 'notes:';
// Page keys are notes:<url>, so this key never meets a page.
const NOTES_HISTORY_KEY = 'notes:history';
const NOTES_HISTORY_LIMIT = 50;
const SVG_NS = 'http://www.w3.org/2000/svg';
const MARK_NAMES = { arrow: 'arrow', point: 'point', rect: 'box' };
const LABEL_GAP_X = 16;
const LABEL_GAP_Y = 14;
const LABEL_EDGE = 6;
const LABEL_SPOTS = [{ dx: 1, dy: 1 }, { dx: -1, dy: 1 }, { dx: 1, dy: -1 }, { dx: -1, dy: -1 }];
const ARROW_HEAD_PX = 14;
const ARROW_HEAD_SPREAD = 0.5;
const BOX_CORNER_RADIUS = 4;
const LOUPE_EDGE_PX = 4;
const NOTE_BOX_OFFSET_X = 18;
const NOTE_BOX_OFFSET_Y = 16;
const NOTE_BOX_EDGE_PX = 8;

const marksHost = document.createElement(WG_MARKS_TAG);
marksHost.style.cssText = 'all:initial;position:absolute;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none;display:block;transition:opacity .16s ease';
const marksRoot = marksHost.attachShadow({ mode: 'closed' });
marksRoot.innerHTML = `<style>${WG_CSS}</style><div class="marks"><svg class="marksvg" width="1" height="1"></svg></div>`;
const marksLayer = marksRoot.querySelector('.marks');
const marksSvg = marksRoot.querySelector('.marksvg');

let notes = [], tool = 'arrow', beforeMarking = null, drawing = null, firstTouch = null, dragNote = null, dragHandle = null;
let openNote = null, saveOpenNote = null, placeOpenBox = null;
let frame = null, frameAt = 0, frameScroll = '';
let notesKey = '';
// Until the stored notes of this page are read, a save would overwrite them with only the new ones.
let notesLoaded = false, notesLoading = false, notesSaveWarned = false;
let sendingNotes = false;

const normalizedUrl = () => location.href.split('#')[0];
const contentPoint = (e) => ({ x: e.clientX + window.scrollX, y: e.clientY + window.scrollY });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const distance = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
const topLeft = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) });
const withoutEmptyMark = (value) => value.replaceAll(EMPTY_MARK, '');

function syncMarksScale() {
  marksLayer.style.setProperty('--mz', String(1 / viewScale));
  placeNoteLabels();
}

function plainNote(m) { return { n: m.n, kind: m.kind, text: m.text, at: m.at, a: m.a, b: m.b, sent: m.sent, group: m.group }; }
function persistNotes() {
  if (!notesLoaded) return;
  bg('notes.set', { key: notesKey, notes: notes.map(plainNote) }).then(() => { notesSaveWarned = false; }, (error) => {
    if (notesSaveWarned || replacedNotice) return;
    notesSaveWarned = true;
    showToast('Notes not saved', error.message);
  });
}
function arrowPath(a, b) {
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const tip = (s) => `${b.x - ARROW_HEAD_PX * Math.cos(angle + s)} ${b.y - ARROW_HEAD_PX * Math.sin(angle + s)}`;
  return `M${a.x} ${a.y}L${b.x} ${b.y}M${tip(ARROW_HEAD_SPREAD)}L${b.x} ${b.y}L${tip(-ARROW_HEAD_SPREAD)}`;
}
function drawShape(mark) {
  if (!mark.shape) return;
  const { a, b, shape } = mark;
  if (mark.kind === 'arrow') { shape.setAttribute('d', arrowPath(a, b)); return; }
  const corner = topLeft(a, b);
  shape.setAttribute('x', corner.x);
  shape.setAttribute('y', corner.y);
  shape.setAttribute('width', Math.abs(b.x - a.x));
  shape.setAttribute('height', Math.abs(b.y - a.y));
  shape.setAttribute('rx', BOX_CORNER_RADIUS);
}
function newShape(kind) {
  const shape = document.createElementNS(SVG_NS, kind === 'arrow' ? 'path' : 'rect');
  marksSvg.append(shape);
  return shape;
}
function visibleArea() {
  const view = window.visualViewport;
  const left = view ? view.pageLeft : window.scrollX, top = view ? view.pageTop : window.scrollY;
  return { left, top, right: left + (view ? view.width : window.innerWidth), bottom: top + (view ? view.height : window.innerHeight) };
}
// The label keeps to the right and below its dot, flips when the visible area has no room there, and is clamped as a last resort.
function placeLabel(mark) {
  const { label, at } = mark;
  const gapX = LABEL_GAP_X / viewScale, gapY = LABEL_GAP_Y / viewScale, edge = LABEL_EDGE / viewScale;
  const width = label.offsetWidth / viewScale, height = label.offsetHeight / viewScale;
  const area = visibleArea();
  const spotAt = ({ dx, dy }) => ({ x: dx > 0 ? at.x + gapX : at.x - gapX - width, y: dy > 0 ? at.y + gapY : at.y - gapY - height });
  const fits = ({ x, y }) => x >= area.left + edge && x + width <= area.right - edge && y >= area.top + edge && y + height <= area.bottom - edge;
  const dotVisible = at.x >= area.left && at.x <= area.right && at.y >= area.top && at.y <= area.bottom;
  let spot = spotAt(LABEL_SPOTS[0]);
  if (dotVisible && !fits(spot)) {
    // A flipped label should not lie on the arrow's own shaft.
    const shaft = mark.kind === 'arrow' && mark.b ? { dx: Math.sign(mark.b.x - mark.a.x), dy: Math.sign(mark.b.y - mark.a.y) } : null;
    const onShaft = (s) => Boolean(shaft) && s.dx === shaft.dx && s.dy === shaft.dy;
    const flips = LABEL_SPOTS.slice(1).sort((p, q) => onShaft(p) - onShaft(q));
    const fitting = flips.map(spotAt).find(fits);
    if (fitting) spot = fitting;
    else {
      const roomy = spotAt({ dx: area.right - at.x >= at.x - area.left ? 1 : -1, dy: area.bottom - at.y >= at.y - area.top ? 1 : -1 });
      spot = {
        x: Math.max(area.left + edge, Math.min(roomy.x, area.right - edge - width)),
        y: Math.max(area.top + edge, Math.min(roomy.y, area.bottom - edge - height)),
      };
    }
  }
  label.style.left = `${spot.x}px`;
  label.style.top = `${spot.y}px`;
}
function placeNoteLabels() { notes.forEach((m) => { if (m.label) placeLabel(m); }); }
function placeNoteMarks(mark) {
  mark.pin.style.left = `${mark.at.x}px`;
  mark.pin.style.top = `${mark.at.y}px`;
  if (mark.label) placeLabel(mark);
  drawShape(mark);
}
function setNoteText(mark, text) {
  mark.text = text;
  if (!text) { mark.label?.remove(); mark.label = null; return; }
  if (!mark.label) {
    mark.label = document.createElement('div');
    mark.label.className = 'mlabel';
    mark.label.dataset.note = mark.n;
    marksLayer.append(mark.label);
  }
  mark.label.textContent = text;
  placeNoteMarks(mark);
}
function buildMark(saved) {
  const pin = document.createElement('div');
  pin.className = 'pin';
  pin.dataset.note = saved.n;
  pin.textContent = saved.n;
  marksLayer.append(pin);
  let shape = saved.shape || null;
  if (!shape && saved.a && saved.kind !== 'point') shape = newShape(saved.kind);
  const mark = { n: saved.n, kind: saved.kind, text: '', at: saved.at, a: saved.a || null, b: saved.b || null, sent: Boolean(saved.sent), group: saved.group || null, pin, shape, label: null };
  placeNoteMarks(mark);
  if (saved.text) setNoteText(mark, saved.text);
  return mark;
}
function removeMarkElements(mark) {
  mark.pin.remove();
  mark.shape?.remove();
  mark.label?.remove();
}
function removeNote(mark) { removeNotes([mark]); }
function removeNotes(marks) {
  marks.forEach(removeMarkElements);
  notes = notes.filter((m) => !marks.includes(m));
  renumberNotes();
  renderNotesCount();
  persistNotes();
}
// A note changed after sending goes out again with the next send.
function markChanged(mark) {
  mark.sent = false;
  renderNotesCount();
  persistNotes();
}
function renumberNotes() {
  notes.forEach((m, i) => {
    m.n = i + 1;
    m.pin.textContent = m.n;
    m.pin.dataset.note = m.n;
    if (m.label) m.label.dataset.note = m.n;
  });
}
function moveNote(mark, dx, dy) {
  const shift = (p) => ({ x: p.x + dx, y: p.y + dy });
  mark.at = shift(mark.at);
  if (mark.a) { mark.a = shift(mark.a); mark.b = shift(mark.b); }
  placeNoteMarks(mark);
}
function setNoteEnd(mark, which, point) {
  mark[which] = point;
  mark.at = mark.kind === 'rect' ? topLeft(mark.a, mark.b) : mark.a;
  placeNoteMarks(mark);
  placeHandle(which, point);
}
function placeHandle(which, point) {
  const handle = marksLayer.querySelector(`.hdl.live[data-handle="${which}"]`);
  if (!handle) return;
  handle.style.left = `${point.x}px`;
  handle.style.top = `${point.y}px`;
}
function showHandles(mark) {
  hideHandles();
  if (!mark.a) return;
  for (const which of ['a', 'b']) {
    const handle = document.createElement('div');
    handle.className = 'hdl live';
    handle.dataset.handle = which;
    marksLayer.append(handle);
    placeHandle(which, mark[which]);
  }
}
function hideHandles() { marksLayer.querySelectorAll('.hdl.live').forEach((el) => el.remove()); }
function clearFirstTouch() {
  firstTouch = null;
  marksRoot.getElementById('firstTouchDot')?.remove();
}
function markFirstTouch(at) {
  firstTouch = at;
  const dot = document.createElement('div');
  dot.id = 'firstTouchDot';
  dot.className = 'hdl';
  dot.style.left = `${at.x}px`;
  dot.style.top = `${at.y}px`;
  marksLayer.append(dot);
}

async function freshFrame() {
  const scroll = `${window.scrollX},${window.scrollY}`;
  if (frame && Date.now() - frameAt < FRAME_REUSE_MS && frameScroll === scroll) return;
  try {
    const dataUrl = await bg('shot.capture');
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    frame = image;
    frameAt = Date.now();
    frameScroll = scroll;
  } catch {
    frame = null;
  }
}
function showLoupe(e) {
  const loupe = $('#loupe');
  let canvas = loupe.querySelector('canvas');
  if (!canvas) {
    loupe.innerHTML = `<canvas width="${LOUPE_SIZE * 2}" height="${LOUPE_SIZE * 2}"></canvas>`;
    canvas = loupe.firstChild;
    loupe.classList.add('on');
  }
  const half = LOUPE_SIZE / 2, x = uiX(e), y = uiY(e);
  const fitsAbove = y - LOUPE_LIFT - LOUPE_SIZE > LOUPE_EDGE_PX;
  loupe.style.left = `${clamp(x - half, LOUPE_EDGE_PX, stage.offsetWidth - LOUPE_SIZE - LOUPE_EDGE_PX)}px`;
  loupe.style.top = `${fitsAbove ? y - LOUPE_LIFT - LOUPE_SIZE : y + LOUPE_LIFT}px`;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#eef0f4';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!frame) return;
  const perCss = frame.naturalWidth / window.innerWidth;
  const span = (LOUPE_SIZE / viewScale / LOUPE_ZOOM) * perCss;
  ctx.drawImage(frame, e.clientX * perCss - span / 2, e.clientY * perCss - span / 2, span, span, 0, 0, canvas.width, canvas.height);
}
function hideLoupe() {
  const loupe = $('#loupe');
  loupe.classList.remove('on');
  loupe.textContent = '';
}

function askNote(mark, isNew) {
  const wrap = document.createElement('div');
  wrap.id = 'noteBox';
  const closeWord = isNew ? 'Cancel note' : 'Delete note';
  wrap.innerHTML = `<div class="fld"><span class="ph2">Caption (optional)</span><textarea id="note" rows="1" aria-label="Note caption" autocomplete="off" spellcheck="true"></textarea></div>
    <button id="noteCancel" aria-label="${closeWord}" title="${closeWord}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.200" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    <button id="noteOk" aria-label="Save note"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.400" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.500 4.500 4.500L19 7.500"/></svg></button>`;
  stage.append(wrap);
  stage.classList.add('note-open');
  placeOpenBox = () => {
    wrap.style.left = `${clamp((mark.at.x - window.scrollX) * viewScale + NOTE_BOX_OFFSET_X, NOTE_BOX_EDGE_PX, stage.offsetWidth - wrap.offsetWidth - NOTE_BOX_EDGE_PX)}px`;
    wrap.style.top = `${clamp((mark.at.y - window.scrollY) * viewScale + NOTE_BOX_OFFSET_Y, NOTE_BOX_EDGE_PX, stage.offsetHeight - wrap.offsetHeight - NOTE_BOX_EDGE_PX)}px`;
  };
  placeOpenBox();
  const input = wrap.querySelector('#note');
  input.value = EMPTY_MARK + mark.text;
  wrap.classList.toggle('has', Boolean(mark.text));
  // The caption wraps and grows like the label it becomes, instead of scrolling sideways.
  const fitCaption = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, CAPTION_MAX_H)}px`;
    placeOpenBox?.();
  };
  fitCaption();
  // The box is fixed over the page: letting focus scroll would move the page away from the note.
  input.focus({ preventScroll: true });
  input.setSelectionRange(input.value.length, input.value.length);
  openNote = mark;
  showHandles(mark);
  let finished = false, emptyDeletes = 0;
  const finish = () => {
    finished = true;
    openNote = null;
    saveOpenNote = null;
    placeOpenBox = null;
    hideHandles();
    wrap.remove();
    stage.classList.remove('note-open');
    if (stage.classList.contains('marking')) exitMarking();
  };
  const save = () => {
    if (finished) return;
    const text = withoutEmptyMark(input.value).trim();
    if (text !== mark.text) {
      setNoteText(mark, text);
      mark.sent = false;
      renderNotesCount();
    }
    persistNotes();
    finish();
  };
  const cancel = () => {
    if (finished) return;
    removeNote(mark);
    finish();
  };
  // A soft keyboard reports nothing for Backspace in an empty field, so the field is never truly empty.
  input.addEventListener('input', () => {
    const lostMark = !input.value.startsWith(EMPTY_MARK);
    const text = withoutEmptyMark(input.value);
    if (lostMark && !text) {
      emptyDeletes += 1;
      if (emptyDeletes >= DELETES_TO_CANCEL) { cancel(); return; }
    } else if (text) emptyDeletes = 0;
    input.value = EMPTY_MARK + text;
    wrap.classList.toggle('has', Boolean(text));
    fitCaption();
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } });
  wrap.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  wrap.querySelector('#noteCancel').onclick = cancel;
  wrap.querySelector('#noteOk').onclick = save;
  saveOpenNote = save;
}

function finishMark(kind, shape, a, b) {
  const at = kind === 'rect' ? topLeft(a, b) : kind === 'point' ? b : a;
  const mark = buildMark({ n: notes.length + 1, kind, at, a: shape ? a : null, b: shape ? b : null, shape });
  notes.push(mark);
  renderNotesCount();
  persistNotes();
  askNote(mark, true);
}

function handleUnderPointer(e) {
  if (!openNote?.a) return null;
  const p = contentPoint(e), reach = HANDLE_HIT_PX / viewScale;
  return ['a', 'b'].find((which) => distance(openNote[which], p) <= reach) || null;
}

function startMarkGesture(e) {
  const capture = $('#capture');
  const which = handleUnderPointer(e);
  if (which) {
    dragHandle = { mark: openNote, which };
    capture.setPointerCapture(e.pointerId);
    showLoupe(e);
    e.preventDefault();
    return;
  }
  if (stage.classList.contains('note-open')) { saveOpenNote?.(); e.preventDefault(); return; }
  if (!stage.classList.contains('marking')) return;
  const a = firstTouch || contentPoint(e);
  let shape = null;
  if (tool !== 'point' && firstTouch) {
    shape = newShape(tool);
    drawShape({ kind: tool, shape, a, b: contentPoint(e) });
  }
  drawing = { a, shape, kind: tool };
  capture.setPointerCapture(e.pointerId);
  showLoupe(e);
  e.preventDefault();
}
function moveMarkGesture(e) {
  if (dragHandle) {
    setNoteEnd(dragHandle.mark, dragHandle.which, contentPoint(e));
    showLoupe(e);
    return;
  }
  if (!drawing) return;
  showLoupe(e);
  if (drawing.shape) drawShape({ kind: drawing.kind, shape: drawing.shape, a: drawing.a, b: contentPoint(e) });
}
function endMarkGesture(e) {
  hideLoupe();
  if (dragHandle) {
    const { mark } = dragHandle;
    dragHandle = null;
    markChanged(mark);
    return;
  }
  if (!drawing) return;
  const { a, shape, kind } = drawing, b = contentPoint(e);
  drawing = null;
  if (kind === 'point') { finishMark('point', null, a, b); return; }
  if (!firstTouch) { markFirstTouch(b); return; }
  if (distance(a, b) < MIN_MARK_PX) { shape.remove(); return; }
  clearFirstTouch();
  finishMark(kind, shape, a, b);
}
function cancelMarkGesture() {
  hideLoupe();
  dragHandle = null;
  drawing?.shape?.remove();
  drawing = null;
}

function wireMarkPointers() {
  const capture = $('#capture');
  capture.addEventListener('pointerdown', startMarkGesture);
  capture.addEventListener('pointermove', moveMarkGesture);
  capture.addEventListener('pointerup', endMarkGesture);
  capture.addEventListener('pointercancel', cancelMarkGesture);
  marksLayer.addEventListener('pointerdown', (e) => {
    const hit = e.target.closest('[data-note]');
    const mark = hit && notes.find((m) => String(m.n) === hit.dataset.note);
    if (!mark) return;
    const start = contentPoint(e);
    dragNote = { mark, last: start, start, moved: false };
    hit.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  });
  marksLayer.addEventListener('pointermove', (e) => {
    if (!dragNote) return;
    const now = contentPoint(e);
    if (!dragNote.moved && distance(now, dragNote.start) <= DRAG_START_PX / viewScale) return;
    if (!dragNote.moved) {
      dragNote.moved = true;
      stage.classList.add('dragging');
      freshFrame();
    }
    moveNote(dragNote.mark, now.x - dragNote.last.x, now.y - dragNote.last.y);
    dragNote.last = now;
    showLoupe(e);
  });
  const endDrag = () => {
    if (!dragNote) return;
    const { mark, moved } = dragNote;
    dragNote = null;
    hideLoupe();
    stage.classList.remove('dragging');
    if (!moved) { askNote(mark, false); return; }
    markChanged(mark);
  };
  marksLayer.addEventListener('pointerup', endDrag);
  marksLayer.addEventListener('pointercancel', endDrag);
  marksLayer.addEventListener('click', (e) => e.stopPropagation());
}

async function enterMarking() {
  beforeMarking = { chat: chatOpen };
  closeMenu();
  stage.classList.add('marking');
  panel.classList.add('closed');
  placeRail();
  syncRail();
  await nextFrame();
  await delay(UI_SETTLE_MS);
  await freshFrame();
}
function exitMarking() {
  clearFirstTouch();
  stage.classList.remove('marking');
  if (beforeMarking?.chat) panel.classList.remove('closed');
  syncRail();
}
function chooseTool(next) {
  tool = next;
  enterMarking();
}

const EXT_BUTTONS = { extNotes: 'rNotes', extMedia: 'rMedia' };
// The extension folds with an animation; the rail can go back only once it is short again.
const EXT_SETTLE_MS = 360;
function closeExt() {
  for (const [ext, btn] of Object.entries(EXT_BUTTONS)) {
    $(`#${ext}`).classList.remove('open');
    $(`#${btn}`).classList.remove('on');
    $(`#${btn}`).setAttribute('aria-expanded', 'false');
  }
  keepRailOnScreen();
  setTimeout(keepRailOnScreen, EXT_SETTLE_MS);
}
function toggleExt(ext) {
  const opening = !$(`#${ext}`).classList.contains('open');
  closeExt();
  if (!opening) return;
  $(`#${ext}`).classList.add('open');
  $(`#${EXT_BUTTONS[ext]}`).classList.add('on');
  $(`#${EXT_BUTTONS[ext]}`).setAttribute('aria-expanded', 'true');
  keepRailOnScreen();
}

const pendingNotes = () => notes.filter((m) => !m.sent);
function renderNotesCount() {
  const count = pendingNotes().length;
  $('#rNotes .cnt').textContent = count;
  $('#rNotes').classList.toggle('has', count > 0);
  const quickSend = $('#extSend');
  quickSend.hidden = count === 0;
  quickSend.classList.toggle('has', count > 0);
  quickSend.querySelector('.cnt').textContent = count;
  quickSend.setAttribute('aria-label', `Send ${count} ${count === 1 ? 'note' : 'notes'} to AI`);
  keepRailOnScreen();
  root.querySelector('#notesChip')?.remove();
  if (count) $('#chips').insertAdjacentHTML('beforeend', `<button id="notesChip">Notes: ${count}</button>`);
}
// The AI gets the page as it is and the same view with the notes drawn on it.
// Both shots come from one hiding of the UI: first with the notes, then a moment without them, so nothing blinks twice.
// The notes stay hidden after the clean shot: they are about to leave the page, and showing them again for a moment
// looks like a glitch. The caller shows them again with showMarks() when sending fails.
function showMarks() { marksHost.style.opacity = ''; }
async function captureNotesPair() {
  placeNoteLabels();
  const [marked, clean] = await withUiHidden(async () => {
    const withNotes = await bg('shot.capture');
    marksHost.style.opacity = '0';
    try {
      await nextFrame();
      await delay(CAPTURE_GAP_MS);
      return [withNotes, await bg('shot.capture')];
    } catch (error) { showMarks(); throw error; }
  });
  flashShot();
  const store = (dataUrl) => bg('media.add', { kind: 'auto', dataUrl, url: location.href });
  return [await store(clean), await store(marked)];
}
async function sendNotes(comment, { stayOnPage = false } = {}) {
  const pending = pendingNotes();
  if (!pending.length || sendingNotes) return;
  if (!session) return sessionsDialog();
  sendingNotes = true;
  try {
    closeDialog();
    placeNoteLabels();
    const media = await captureNotesPair();
    await bg('chat.send', { session: session.id, text: comment, media, notes: pending.map(plainNote) });
    await rememberSent(pending);
    removeNotes(pending);
    showMarks();
    if (stayOnPage) showToast('Notes sent');
    else openChat();
    await pullHistory();
  } catch (error) {
    showMarks();
    showToast('Notes not sent', error.message);
  } finally {
    sendingNotes = false;
  }
}
// Every write of the history follows a read that succeeded, so a failed read never wipes what was kept.
const readNotesHistory = () => bg('notes.get', { key: NOTES_HISTORY_KEY }).then((groups) => (Array.isArray(groups) ? groups : []));
const saveNotesHistory = (groups) => bg('notes.set', { key: NOTES_HISTORY_KEY, notes: groups });
async function rememberSent(sent) {
  const group = { id: `${Date.now()}-${String(Math.random()).slice(2, 8)}`, at: Date.now(), url: normalizedUrl(), notes: sent.map((m) => ({ ...plainNote(m), sent: true })) };
  try {
    await saveNotesHistory([group, ...(await readNotesHistory())].slice(0, NOTES_HISTORY_LIMIT));
  } catch (error) { showToast('Notes sent, not kept in Sent notes', error.message); }
}
const shownOf = (groupId) => notes.filter((m) => m.group === groupId);
function showGroup(group) {
  const shown = group.notes.map((saved) => buildMark({ ...saved, n: notes.length + 1, group: group.id, sent: true }));
  shown.forEach((m) => notes.push(m));
  renderNotesCount();
  persistNotes();
  return shown;
}
function clearPendingNotes() { removeNotes(pendingNotes()); }
function pageLabel(url) {
  if (url === normalizedUrl()) return 'this page';
  try {
    const { host, pathname, search } = new URL(url);
    const path = pathname === '/' && !search ? '' : pathname + search;
    return host === location.host ? path || '/' : host + path;
  } catch { return url; }
}
async function sentNotesDialog() {
  let groups;
  try { groups = await readNotesHistory(); } catch (error) { showToast('Sent notes not loaded', error.message); return; }
  const here = normalizedUrl();
  const rows = groups.map((g) => `<div class="hgroup" data-group="${esc(g.id)}"><div class="row"><span class="rmain">
      <span class="rtitle">${esc(g.notes.map((m) => m.text || 'No caption').join(', '))}</span>
      <span class="rsub">${esc(countOf(g.notes.length, 'note'))}, ${esc(pageLabel(g.url))}</span></span><span class="rmeta">${esc(ago(g.at))}</span></div>
      <div class="hacts">${g.url === here ? `<button class="btn small" data-show>${shownOf(g.id).length ? 'Hide from page' : 'Show on page'}</button>` : ''}<button class="btn small danger" data-forget>Delete</button></div></div>`).join('');
  openSheet({
    title: 'Sent notes',
    back: notesDialog,
    body: groups.length ? `<p class="lead">Notes leave the page once they are sent. They are kept here.</p><div class="list">${rows}</div>` : '<p class="lead">Nothing sent yet.</p>',
  });
  over.querySelectorAll('.hgroup').forEach((el) => {
    const group = groups.find((g) => g.id === el.dataset.group);
    const show = el.querySelector('[data-show]');
    if (show) show.onclick = () => {
      const shown = shownOf(group.id);
      if (shown.length) { removeNotes(shown); sentNotesDialog(); return; }
      const [first] = showGroup(group);
      closeDialog();
      if (first) revealNote(first);
    };
    const forget = el.querySelector('[data-forget]');
    forget.onclick = () => armThen(forget, 'Tap again to delete', async () => {
      try {
        await saveNotesHistory((await readNotesHistory()).filter((g) => g.id !== group.id));
      } catch (error) { showToast('Not deleted', error.message); return; }
      sentNotesDialog();
    });
  });
}
function revealNote(m) {
  window.scrollTo({ top: Math.max(0, m.at.y - window.innerHeight / 3), behavior: 'auto' });
  m.pin.classList.remove('seen');
  void m.pin.offsetWidth;
  m.pin.classList.add('seen');
}
const countOf = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const sentTimes = (count) => (count === 1 ? 'Sent once' : `Sent ${count} times`);
async function notesDialog() {
  const sentGroups = (await readNotesHistory().catch(() => [])).length;
  const rows = notes.map((m, i) => `<div class="nrow${m.sent ? ' sent' : ''}" data-i="${i}"><span class="num">${m.n}</span>
      <div class="tx"><b>${esc(m.text || 'No caption')}</b><span>${esc(MARK_NAMES[m.kind] || '')}${m.sent ? ', sent to AI' : ''}</span></div>
      <button class="nshow" aria-label="Show on page"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.500"/></svg></button>
      <button class="ndel" aria-label="Delete note"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`).join('');
  const pending = pendingNotes().length;
  openSheet({
    title: 'Notes',
    body: `${notes.length ? `<p class="lead">They stay on this page until you send them.</p><div class="nlist">${rows}</div>` : '<p class="lead">No notes yet. Tap Notes on the rail and choose a type.</p>'}
      ${pending ? '<label class="field ncomment"><textarea id="notesComment" rows="2" placeholder="Overall comment (optional)" aria-label="Overall comment"></textarea></label>' : ''}
      ${sentGroups ? `<div class="list nsent"><button class="row" id="sentNotes"><span class="rmain"><span class="rtitle">Sent notes</span><span class="rsub">${sentTimes(sentGroups)}</span></span><span class="rgo">${SHEET_ICONS.go}</span></button></div>` : ''}`,
    foot: pending ? `<button class="btn danger" id="notesClear">Clear notes</button><button class="btn pri" id="notesSend">${session ? `Send to AI (${pending})` : 'Connect AI'}</button>` : '',
  });
  onClickIfShown('#notesSend', () => sendNotes($('#notesComment').value.trim()));
  onClickIfShown('#notesClear', () => armThen($('#notesClear'), 'Tap again to clear', () => { clearPendingNotes(); notesDialog(); }));
  onClickIfShown('#sentNotes', sentNotesDialog);
  over.querySelectorAll('.nrow').forEach((row) => {
    const m = notes[Number(row.dataset.i)];
    row.querySelector('.tx').onclick = () => { closeDialog(); revealNote(m); askNote(m, false); };
    row.querySelector('.nshow').onclick = () => { closeDialog(); revealNote(m); };
    row.querySelector('.ndel').onclick = () => { removeNote(m); notesDialog(); };
  });
}

// Called every second, so a read that failed is simply tried again on the next call.
async function loadNotesForUrl() {
  const key = NOTES_KEY_PREFIX + normalizedUrl();
  if (key !== notesKey) {
    notes.forEach(removeMarkElements);
    notes = [];
    notesKey = key;
    notesLoaded = false;
  }
  if (notesLoaded || notesLoading) return;
  notesLoading = true;
  let saved;
  try { saved = await bg('notes.get', { key }); } catch { return; } finally { notesLoading = false; }
  if (key !== notesKey) return;
  const madeMeanwhile = notes;
  notes = [...(Array.isArray(saved) ? saved : []).filter((m) => m && typeof m === 'object').map(buildMark), ...madeMeanwhile];
  notesLoaded = true;
  renumberNotes();
  renderNotesCount();
  if (madeMeanwhile.length) persistNotes();
}
