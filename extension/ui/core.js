const WG_HOST_TAG = 'tweakline-root';
const WG_MARKS_TAG = 'tweakline-marks';
const IDLE_MS = 5000;
const SHEET_STOPS = { half: 0.6, full: 0.92 };
const PEEK_HEIGHT = 118;
const DRAG_START_PX = 8;
const AXIS_RATIO = 1.3;
const FLING_PX_PER_MS = 0.5;
const SWIPE_DISTANCE_SHARE = 0.28;
const RAIL_SWIPE_PX = 26;
const INWARD_DRAG_DAMPING = 0.35;
const BADGE_TO_CHAT_PX = 110;
const BADGE_SWIPE_PX = 18;
const TO_BOTTOM_PX = 80;
const TO_FULL_PX = 50;
const TO_FULL_TOP_PX = 70;
const DOUBLE_TAP_MS = 320;
const OFF_EDGE_SHARE = 0.35;
const MINI_SCALE = 0.46;
const MINI_SIZE = { w: 340, h: 480 };
const RAIL_GUTTER = 60;
const CHAT_MIN_W = 260;
const PAGE_MIN_W = 120;
const POSITION_NAMES = { column: 'Side', sheet: 'Bottom', mini: 'Mini', full: 'Full screen' };
const host = document.createElement(WG_HOST_TAG);
host.style.cssText = 'all:initial;position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;display:block;transform-origin:0 0';
const root = host.attachShadow({ mode: 'closed' });
root.innerHTML = `<style>${WG_CSS}${WG_CSS_SYSTEM}${WG_CSS_PANELS}${WG_CSS_CHAT}</style>${WG_MARKUP}`;
const $ = (s) => root.querySelector(s);
// For buttons a sheet shows only in some states.
const onClickIfShown = (s, handler) => { const el = $(s); if (el) el.onclick = handler; };
const stage = $('#stage'), panel = $('#panel'), over = $('#over');
const badge = $('#badge'), rail = $('#rail'), hint = $('#hint'), menu = $('#wmenu');

let mode = 'column', lastDocked = 'column', sheetStop = 'half', chatOpen = false, railOpen = false, connected = true;
let unreadChat = 0, suppressClick = false, session = null, viewScale = 1;

function esc(text) { return String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
const setVars = (el, vars) => { for (const k in vars) el.style.setProperty(k, vars[k]); };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const side = () => stage.dataset.side;
const outward = () => (side() === 'right' ? 1 : -1);
const uiX = (e) => e.clientX * viewScale;
const uiY = (e) => e.clientY * viewScale;
function uiRect(el) {
  const box = el.getBoundingClientRect();
  return { left: box.left * viewScale, top: box.top * viewScale, right: box.right * viewScale, bottom: box.bottom * viewScale, width: box.width * viewScale, height: box.height * viewScale, x: box.left * viewScale, y: box.top * viewScale };
}

// After an update the old copy on an open page loses the extension; a fresh copy takes over, or the person reloads.
// Only another copy removes this host, and it puts its own in place: page attributes play no part, the page can write them.
let retired = false;
const replacedByNewerCopy = () => !host.isConnected && [...document.querySelectorAll(WG_HOST_TAG)].some((other) => other !== host);
function retire() {
  if (retired) return;
  retired = true;
  host.remove();
  document.querySelector(WG_MARKS_TAG)?.remove();
}
let replacedNotice = false;
function showReplacedSheet() {
  if (over.querySelector('#reloadPage')) return;
  openSheet({ title: 'Tweakline was updated', body: '<p class="lead">Reload this page to keep using it. Your notes and patches are kept.</p>', foot: '<button class="btn pri" id="reloadPage">Reload page</button>' });
  $('#reloadPage').onclick = () => location.reload();
}
function extensionReplaced() {
  if (replacedByNewerCopy()) { retire(); return; }
  replacedNotice = true;
  showReplacedSheet();
}

const CONTEXT_GONE = /context invalidated/i;
function bg(method, params) {
  // After an update the old copy loses the extension: the call throws at once instead of reporting lastError.
  if (!chrome.runtime?.id) { extensionReplaced(); return Promise.reject(new Error('Extension context invalidated')); }
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ to: 'bg', method, params }, (reply) => {
        if (chrome.runtime.lastError) {
          if (CONTEXT_GONE.test(chrome.runtime.lastError.message)) extensionReplaced();
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (!reply?.ok) return reject(new Error(reply?.error || 'Extension did not respond'));
        resolve(reply.data);
      });
    } catch (error) {
      if (CONTEXT_GONE.test(error.message) || !chrome.runtime?.id) extensionReplaced();
      reject(error);
    }
  });
}

const readDataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});
function dataUrlToBlob(dataUrl) {
  const [head, base64] = dataUrl.split(',');
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: head.match(/data:([^;]+)/)[1] });
}
const copyText = (text) => navigator.clipboard.writeText(text);
function copyImage(dataUrl) {
  const blob = dataUrlToBlob(dataUrl);
  return navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
}

// Pages with a desktop viewport render everything small on a phone, so the UI undoes that scale.
function syncViewport() {
  const view = window.visualViewport;
  viewScale = view ? view.scale : 1;
  const width = view ? view.width : window.innerWidth;
  const height = view ? view.height : window.innerHeight;
  host.style.zoom = String(1 / viewScale);
  host.style.width = `${width * viewScale}px`;
  host.style.height = `${height * viewScale}px`;
  host.style.transform = view ? `translate(${view.offsetLeft}px,${view.offsetTop}px)` : '';
  if (typeof syncMarksScale === 'function') syncMarksScale();
  keepRailOnScreen();
  if (over.classList.contains('on')) keepRailClear();
}

function setSheet(stop) {
  sheetStop = stop;
  panel.classList.toggle('peek', stop === 'peek');
  if (stop !== 'peek') panel.style.setProperty('--h', Math.round(SHEET_STOPS[stop] * 100) + '%');
}

function placeRail() {
  const inHeader = mode === 'full' && chatOpen && !stage.classList.contains('marking');
  if (inHeader && rail.parentElement !== $('.ph')) $('.ph').insertBefore(rail, $('#fullBtn'));
  if (!inHeader && rail.parentElement !== stage) stage.insertBefore(rail, hint);
  rail.classList.toggle('inhead', inHeader);
}

function syncRail() {
  placeRail();
  rail.classList.toggle('on', railOpen && connected);
  badge.classList.toggle('on', connected && !railOpen);
  badge.classList.toggle('unread', unreadChat > 0);
  $('#rChat').classList.toggle('on', chatOpen);
  $('#rChat .cnt').textContent = unreadChat;
  $('#rChat').classList.toggle('has', unreadChat > 0);
  stage.classList.toggle('col-open', chatOpen && mode === 'column');
  $('#fullBtn').classList.toggle('on', mode === 'full');
  $('#fullBtn').setAttribute('aria-label', mode === 'full' ? 'Exit full screen' : 'Full screen');
  keepRailOnScreen();
}
// The place the person chose; a keyboard or a short screen moves the rail up only while it lasts.
let railWantTop = null;
function keepRailOnScreen() {
  if (!rail.classList.contains('on') || !stage.offsetHeight) return;
  railWantTop ??= parseFloat(stage.style.getPropertyValue('--ry')) || 64;
  const top = railWantTop;
  const ext = rail.querySelector('.ext.open');
  const stillGrowing = ext ? Math.max(0, ext.scrollHeight - ext.offsetHeight) : 0;
  const room = stage.offsetHeight - rail.offsetHeight - stillGrowing - 6;
  stage.style.setProperty('--ry', Math.min(top, Math.max(6, room)) + 'px');
}

function setPosition(next) {
  if (next === 'column' || next === 'sheet') lastDocked = next;
  mode = next;
  panel.className = next + (chatOpen ? '' : ' closed') + (panel.classList.contains('has-session') ? ' has-session' : '');
  panel.style.cssText = '';
  if (next === 'sheet') setSheet('half');
  if (next === 'mini') {
    const shownW = MINI_SIZE.w * MINI_SCALE;
    const x = side() === 'right' ? stage.offsetWidth - RAIL_GUTTER - shownW - 8 : RAIL_GUTTER + 8;
    setVars(panel, { '--w': MINI_SIZE.w + 'px', '--ch': MINI_SIZE.h + 'px', '--x': x + 'px', '--y': '12px' });
  }
  $('#msgs').scrollTop = 1e6;
  syncRail();
  syncSelected();
}

function openChat() {
  chatOpen = true;
  unreadChat = 0;
  panel.classList.remove('closed');
  alignRailToBadge();
  railOpen = true;
  if (mode === 'sheet' && sheetStop === 'peek') setSheet('half');
  $('#msgs').scrollTop = 1e6;
  syncRail();
}
function closeChat(dir) {
  const finish = () => {
    panel.classList.remove('fly');
    panel.classList.add('closed');
    setVars(panel, { '--tx': '0px', '--op': 1 });
    chatOpen = false;
    syncRail();
  };
  if (!dir) return finish();
  panel.classList.add('fly');
  setVars(panel, { '--tx': dir * stage.offsetWidth + 'px', '--op': 0 });
  setTimeout(finish, 190);
}
function toBadge() {
  closeMenu();
  closeExt();
  railOpen = false;
  if (chatOpen) closeChat(outward());
  syncRail();
}
function alignRailToBadge() {
  if (!railOpen && badge.offsetParent) { railWantTop = badge.offsetTop; stage.style.setProperty('--ry', railWantTop + 'px'); }
}
function openRail() { alignRailToBadge(); railOpen = true; syncRail(); }

function showHint(text, pos) { hint.textContent = text; hint.dataset.p = pos; hint.classList.add('on'); }
function clearHint() { hint.classList.remove('on'); }

function closeMenu() { menu.classList.remove('on'); menuAnchor = null; }
let menuAnchor = null;
function openMenu(html, anchor) {
  // A second tap on the button that opened the menu closes it.
  if (menu.classList.contains('on') && menuAnchor === anchor) { closeMenu(); return; }
  menuAnchor = anchor;
  menu.innerHTML = html;
  menu.classList.add('on');
  const box = uiRect(anchor), host = uiRect(stage);
  const left = side() === 'right' ? box.left - host.left - menu.offsetWidth - 8 : box.right - host.left + 8;
  menu.style.left = clamp(left, 8, stage.offsetWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = clamp(box.bottom - host.top + 4, 8, stage.offsetHeight - menu.offsetHeight - 8) + 'px';
}
function syncSelected() { menu.querySelectorAll('[data-pos]').forEach((b) => b.classList.toggle('on', b.dataset.pos === mode)); }
function positionMenu(anchor) {
  openMenu(Object.keys(POSITION_NAMES).map((k) => `<button data-pos="${k}">${POSITION_NAMES[k]}</button>`).join(''), anchor);
  syncSelected();
}
function moreMenu(anchor) {
  openMenu(`<button data-act="sessions">Sessions</button><button data-act="servers">Servers</button>${session ? '<button data-act="access">AI access</button>' : ''}<button data-act="gest">Gestures</button><button data-act="keys">Hotkeys</button><button data-act="hide">Hide Tweakline</button>`, anchor);
}


