const VIEWER_CLOSE_PX = 90;
const VIEWER_PAGE_PX = 70;
const VIEWER_MARGIN = 12;
// The close button and the counter get their own band above the picture instead of covering its corner.
const VIEWER_BAR_H = 56;
const THUMB_W = 480;
const THUMB_QUALITY = 0.72;
const VIDEO_FPS = 10;
const VIDEO_MAX_BYTES = 10 * 1024 * 1024;
// Chunks arrive once a second, so recording stops a little early to stay under the limit.
const VIDEO_CHUNK_MS = 1000;
const VIDEO_STOP_SHARE = 0.95;

let recording = null;
let viewer = null;
let viewerDrag = null;

const clockText = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

// Tweakline fades out for a shot and back in after it, so taking one looks deliberate rather than a glitch.
const UI_FADE_MS = 190;
async function withUiHidden(run) {
  stage.classList.add('shooting');
  await nextFrame();
  await delay(UI_FADE_MS);
  try { return await run(); } finally { stage.classList.remove('shooting'); }
}
const capturePage = () => withUiHidden(() => bg('shot.capture'));
async function captureForChat() {
  const dataUrl = await capturePage();
  flashShot();
  return bg('media.add', { kind: 'auto', dataUrl, url: location.href });
}
function flashShot() {
  const flash = $('#shotFlash');
  flash.classList.remove('on');
  void flash.offsetWidth;
  flash.classList.add('on');
}
async function copyPageShot() {
  let dataUrl;
  try {
    dataUrl = await capturePage();
  } catch (error) { showToast('Screenshot failed', error.message); return; }
  let id;
  try {
    id = await bg('media.add', { kind: 'shot', dataUrl, url: location.href });
  } catch (error) { showToast('Screenshot not saved', error.message); return; }
  flashShot();
  const thumb = { url: dataUrl, open: () => openViewer([{ id, kind: 'shot', dataUrl }], 0) };
  try {
    await copyImage(dataUrl);
    showToast('Screenshot copied', '', thumb);
  } catch {
    showToast('Screenshot in gallery', 'The browser blocked copying the image', thumb);
  }
}

function posterFromCanvas(canvas) {
  const small = document.createElement('canvas');
  small.width = THUMB_W;
  small.height = Math.round(canvas.height * (THUMB_W / canvas.width)) || THUMB_W;
  small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
  return small.toDataURL('image/jpeg', THUMB_QUALITY);
}
async function startRecording() {
  closeExt();
  if (typeof MediaRecorder === 'undefined') { showToast('Video unavailable', 'This browser cannot record'); return; }
  const canvas = document.createElement('canvas');
  canvas.width = window.innerWidth * devicePixelRatio;
  canvas.height = window.innerHeight * devicePixelRatio;
  const chunks = [];
  try {
    await withUiHidden(() => bg('video.start'));
  } catch (error) { showToast('Video did not start', error.message); return; }
  const recorder = new MediaRecorder(canvas.captureStream(VIDEO_FPS));
  let bytes = 0;
  recorder.ondataavailable = (e) => {
    if (!e.data.size) return;
    chunks.push(e.data);
    bytes += e.data.size;
    // The server takes files up to 10 MB, so a longer video could never be sent.
    if (recording?.recorder === recorder && bytes >= VIDEO_MAX_BYTES * VIDEO_STOP_SHARE) { recording.capped = true; stopRecording(); }
  };
  recorder.start(VIDEO_CHUNK_MS);
  recording = { canvas, recorder, chunks, start: Date.now(), chat: chatOpen, poster: null, capped: false, frame: null, timer: setInterval(tickRecording, 500) };
  // The browser sends frames only when the page changes; a still page would record a zero-length video.
  recording.redraw = setInterval(() => { if (recording?.frame) canvas.getContext('2d').drawImage(recording.frame, 0, 0); }, 1000 / VIDEO_FPS);
  stage.classList.add('recording');
  tickRecording();
}
function tickRecording() { $('#recTime').textContent = clockText(Math.floor((Date.now() - recording.start) / 1000)); }
function drawVideoFrame(base64) {
  if (!recording) return;
  const image = new Image();
  image.onload = () => {
    if (!recording) return;
    const { canvas } = recording;
    if (canvas.width !== image.width || canvas.height !== image.height) { canvas.width = image.width; canvas.height = image.height; }
    canvas.getContext('2d').drawImage(image, 0, 0);
    recording.frame = image;
    if (!recording.poster) recording.poster = posterFromCanvas(canvas);
  };
  image.src = `data:image/jpeg;base64,${base64}`;
}
async function stopRecording() {
  const active = recording;
  recording = null;
  const durationMs = Date.now() - active.start;
  clearInterval(active.timer);
  clearInterval(active.redraw);
  stage.classList.remove('recording');
  syncRail();
  await bg('video.stop').catch(() => {});
  const stopped = new Promise((resolve) => { active.recorder.onstop = resolve; });
  active.recorder.stop();
  await stopped;
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  const dataUrl = await readDataUrl(new Blob(active.chunks, { type: 'video/webm' }));
  const poster = active.poster || posterFromCanvas(active.canvas);
  let id;
  try {
    id = await bg('media.add', { kind: 'video', dataUrl, poster, url: location.href, seconds, durationMs });
  } catch (error) { showToast('Video not saved', error.message); return; }
  const stored = await bg('media.get', { id }).catch(() => null);
  const saved = active.capped ? ['Recording stopped at 10 MB', 'The most the server takes'] : ['Video saved', clockText(seconds)];
  showToast(...saved, { url: poster, open: () => openViewer([{ id, kind: 'video', dataUrl: stored?.dataUrl || dataUrl, poster, seconds }], 0) });
}

async function galleryItems() {
  const all = await bg('media.list');
  return all.filter((m) => m.kind !== 'auto' && m.kind !== 'file').sort((a, b) => b.at - a.at);
}
async function galleryDialog() {
  const items = await galleryItems();
  const picked = new Set();
  const tiles = items.map((m, i) => `<div class="gwrap"><button class="gt" data-g="${i}" aria-pressed="false" aria-label="${m.kind === 'video' ? 'Video' : 'Screenshot'}"><img src="${esc(m.poster || m.dataUrl)}" alt="">${m.kind === 'video' ? `<i class="vb">▶ ${clockText(m.seconds)}</i>` : ''}<span class="gc"></span></button><button class="gz" data-zoom="${i}" aria-label="Open"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.200" stroke-linecap="round"><circle cx="11" cy="11" r="6.500"/><path d="m16 16 4.500 4.500"/></svg></button></div>`).join('');
  openSheet({
    title: 'Screenshots and video',
    wide: true,
    body: items.length
      ? `<p class="lead">Pick the ones you need and add them to the chat. The magnifier opens them large.</p><div class="ggrid">${tiles}</div>`
      : '<p class="lead">Nothing here yet. Tap the camera on the rail to take a screenshot or video.</p>',
    foot: items.length ? '<button class="btn" id="gDel">Delete</button><button class="btn" id="gCopy">Copy</button><button class="btn pri" id="gIns">To chat</button>' : '',
  });
  const chosen = () => [...picked].map((i) => items[i]);
  // The foot stays in place while picking, so tiles do not jump under the finger.
  const renderFoot = () => {
    if (!items.length) return;
    const count = chosen().length;
    $('#gDel').disabled = !count;
    $('#gIns').disabled = !count;
    $('#gCopy').hidden = !(count === 1 && chosen()[0].kind === 'shot');
    $('#gIns').textContent = count ? `To chat (${count})` : 'To chat';
  };
  if (items.length) {
    $('#gIns').onclick = () => { attachMedia(chosen()); closeDialog(); openChat(); $('#ta').focus(); };
    $('#gDel').onclick = async () => { await bg('media.delete', { ids: chosen().map((m) => m.id) }); galleryDialog(); };
    $('#gCopy').onclick = async () => {
      try {
        await copyImage(chosen()[0].dataUrl);
        showToast('Screenshot copied');
      } catch { showToast('The browser blocked copying the image'); }
    };
  }
  over.querySelectorAll('.gt').forEach((tile) => { tile.onclick = () => {
    const i = Number(tile.dataset.g);
    if (picked.has(i)) picked.delete(i); else picked.add(i);
    tile.classList.toggle('sel', picked.has(i));
    tile.setAttribute('aria-pressed', picked.has(i));
    const order = [...picked];
    over.querySelectorAll('.gt').forEach((t) => { t.querySelector('.gc').textContent = picked.has(Number(t.dataset.g)) ? order.indexOf(Number(t.dataset.g)) + 1 : ''; });
    renderFoot();
  }; });
  over.querySelectorAll('[data-zoom]').forEach((b) => { b.onclick = () => openViewer(items, Number(b.dataset.zoom)); });
  renderFoot();
}

function renderViewer() {
  const el = $('#viewer'), item = viewer.items[viewer.at];
  const count = viewer.items.length > 1 ? `<span class="vcount">${viewer.at + 1} of ${viewer.items.length}</span>` : '';
  const close = '<button id="vClose" aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.200" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>';
  const media = item.kind === 'video'
    ? `<video src="${esc(item.dataUrl)}" poster="${esc(item.poster || '')}" controls playsinline></video>`
    : `<img src="${esc(item.dataUrl)}" alt="">`;
  el.innerHTML = `<div class="vshot">${media}</div>${count}${close}`;
  $('#vClose').onclick = closeViewer;
  const body = el.querySelector('img,video');
  const fit = () => {
    const w = body.naturalWidth || body.videoWidth || stage.offsetWidth, h = body.naturalHeight || body.videoHeight || stage.offsetHeight;
    const roomW = stage.offsetWidth - VIEWER_MARGIN * 2, roomH = stage.offsetHeight - VIEWER_MARGIN - VIEWER_BAR_H;
    const width = Math.floor(Math.min(roomW, roomH * (w / h)));
    const box = el.querySelector('.vshot');
    box.style.width = `${width}px`;
    box.style.height = `${Math.round(width * (h / w))}px`;
  };
  body.addEventListener(item.kind === 'video' ? 'loadedmetadata' : 'load', fit);
  fit();
}
function openViewer(items, at) {
  viewer = { items, at };
  $('#toast').classList.remove('on');
  $('#viewer').classList.add('on');
  renderViewer();
}
function closeViewer() {
  viewer = null;
  const el = $('#viewer');
  el.classList.remove('on');
  el.textContent = '';
  ['--vy', '--vx', '--vo'].forEach((v) => el.style.removeProperty(v));
}
function wireViewer() {
  const el = $('#viewer');
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button,video')) return;
    viewerDrag = { x: uiX(e), y: uiY(e), axis: null, onShot: Boolean(e.target.closest('.vshot')) };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!viewerDrag) return;
    const dx = uiX(e) - viewerDrag.x, dy = uiY(e) - viewerDrag.y;
    if (!viewerDrag.axis && Math.max(Math.abs(dx), Math.abs(dy)) > DRAG_START_PX) viewerDrag.axis = Math.abs(dy) >= Math.abs(dx) ? 'y' : 'x';
    if (viewerDrag.axis === 'y') setVars(el, { '--vy': `${dy}px`, '--vo': 1 - Math.min(0.7, Math.abs(dy) / 320) });
    if (viewerDrag.axis === 'x') setVars(el, { '--vx': `${dx}px` });
  });
  const end = (e) => {
    if (!viewerDrag) return;
    const { axis, x, y, onShot } = viewerDrag, dx = uiX(e) - x, dy = uiY(e) - y;
    viewerDrag = null;
    suppressClick = Boolean(axis);
    if (!axis) { if (!onShot) closeViewer(); return; }
    setVars(el, { '--vy': '0px', '--vx': '0px', '--vo': 1 });
    if (axis === 'y' && Math.abs(dy) > VIEWER_CLOSE_PX) { closeViewer(); return; }
    if (axis === 'x' && Math.abs(dx) > VIEWER_PAGE_PX) {
      if (viewer.items.length === 1) { closeViewer(); return; }
      viewer.at = (viewer.at + (dx < 0 ? 1 : -1) + viewer.items.length) % viewer.items.length;
      renderViewer();
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}
