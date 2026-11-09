const TOAST_MS = 3500;
const DIALOG_CLOSE_PX = 80;
let toastTimer = 0;

function closeDialog() { over.classList.remove('on'); }

const RAIL_GAP_PX = 4;
// The rail moves with the chat position, so the sheet is fitted around where it really is.
function keepRailClear() {
  const gaps = { '--over-left': 0, '--over-right': 0, '--over-top': 0, '--over-cut': 0 };
  if (rail.classList.contains('on')) {
    const box = uiRect(rail), area = uiRect(stage);
    if (rail.classList.contains('inhead')) gaps['--over-cut'] = box.bottom - area.top;
    else if (box.width > box.height) gaps['--over-top'] = box.bottom - area.top;
    else if (box.left - area.left > area.right - box.right) gaps['--over-right'] = area.right - box.left + RAIL_GAP_PX;
    else gaps['--over-left'] = box.right - area.left + RAIL_GAP_PX;
  }
  for (const name in gaps) over.style.setProperty(name, `${gaps[name]}px`);
}

const SHEET_ICONS = {
  back: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 6-6 6 6 6"/></svg>',
  close: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  go: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>',
  more: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>',
};

function openSheet({ title, back, body, foot, wide }) {
  $('#toast').classList.remove('on');
  keepRailClear();
  over.innerHTML = `<div class="dlg sheet${wide ? ' wide' : ''}" role="dialog" aria-label="${esc(title)}"><div class="dgrab" aria-hidden="true"><i></i></div>
    <div class="dhead${back ? ' hasback' : ''}">${back ? `<button class="dicon" id="dlgBack" aria-label="Back">${SHEET_ICONS.back}</button>` : ''}<h2>${esc(title)}</h2><button class="dicon" id="dlgClose" aria-label="Close">${SHEET_ICONS.close}</button></div>
    <div class="dbody">${body}</div>${foot ? `<div class="dfoot">${foot}</div>` : ''}</div>`;
  over.classList.add('on');
  $('#dlgClose').onclick = closeDialog;
  if (back) $('#dlgBack').onclick = back;
  // Callers wire their sheet right after this returns, so the update notice takes over once they are done.
  if (replacedNotice) queueMicrotask(showReplacedSheet);
  return over.querySelector('.dbody');
}

function wireSegments(onPick, scope = over) {
  scope.querySelectorAll('.seg').forEach((seg) => seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    if (onPick) onPick(seg, b);
  }));
}

function showToast(title, note, thumb) {
  const toast = $('#toast');
  toast.classList.toggle('plain', !thumb);
  toast.innerHTML = `${thumb ? `<button class="toastThumb" aria-label="Open"><img src="${esc(thumb.url)}" alt=""></button>` : ''}<div><b>${esc(title)}</b>${note ? `<small>${esc(note)}</small>` : ''}</div>`;
  if (thumb) toast.querySelector('.toastThumb').onclick = thumb.open;
  toast.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('on'), TOAST_MS);
}

let dialogDrag = null;
over.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.dgrab')) return;
  dialogDrag = { y: uiY(e), dlg: e.target.closest('.dlg') };
  e.target.closest('.dgrab').setPointerCapture(e.pointerId);
});
over.addEventListener('pointermove', (e) => {
  if (dialogDrag) dialogDrag.dlg.style.transform = `translateY(${Math.max(0, uiY(e) - dialogDrag.y)}px)`;
});
function endDialogDrag(e) {
  if (!dialogDrag) return;
  const { dlg, y } = dialogDrag;
  dialogDrag = null;
  dlg.style.transform = '';
  if (uiY(e) - y > DIALOG_CLOSE_PX) closeDialog();
}
over.addEventListener('pointerup', endDialogDrag);
over.addEventListener('pointercancel', endDialogDrag);
over.addEventListener('click', (e) => { if (e.target === over) closeDialog(); });

const GESTURE_HELP = [
  ['Extension icon', 'Quickly hides and shows Tweakline. The badge turns translucent 5 seconds after a touch.'],
  ['Swipe the chat to the edge', 'Hides the chat, the rail stays. Works anywhere in the chat.'],
  ['Swipe the rail', 'Toward the page opens the chat. Toward the edge collapses the rail into the badge, chat included.'],
  ['Badge', 'Tap or swipe inward to open the rail. A long swipe opens the chat too. Drag along the edge to move it, across the screen to switch sides.'],
  ['Chat edge', 'Drag the inner edge to make the chat wider or narrower. All the way makes it full screen.'],
  ['Header up or double tap', 'Chat goes full screen. Header down or another double tap brings it back.'],
  ['Side chat header down', 'The chat moves to the bottom. From there, header all the way up makes it full screen.'],
  ['Position icon in the header', 'Menu: side, bottom, mini, full screen.'],
  ['Mini', 'Drag to move, tap to bring the chat back, drag past the edge to hide it.'],
  ['Notes on the rail', 'The rail extends down: arrow, point, box and list. After you pick a type the UI hides and only the badge stays at the edge. Tapping it cancels the note.'],
  ['Note on the page', 'Drag to move. Tap to edit the caption or delete: handles appear on arrow ends and box corners, and you can drag them. Arrows and boxes take two touches, with a magnifier above your finger.'],
  ['Camera on the rail', 'The rail extends down: a screenshot is copied right away, video hides the UI and records the screen, the gallery keeps everything.'],
  ['Screenshot viewer', 'Swipe up or down to close, sideways to page through the gallery. Dialogs close with a swipe down on the top handle.'],
];
function gesturesDialog() {
  openSheet({ title: 'Gestures', body: `<p class="lead">You can hide from anywhere. Chat position changes only through the header.</p>
    <ul class="gest">${GESTURE_HELP.map(([title, text]) => `<li><b>${title}</b><span>${text}</span></li>`).join('')}</ul>` });
}

async function keysDialog() {
  const keys = await bg('keys.list').catch(() => []);
  openSheet({
    title: 'Hotkeys',
    body: `<p class="lead">On a computer. Set them in the browser extension settings.</p>
      <ul class="gest keys">${keys.map((key) => `<li><span>${esc(key.description)}</span>${key.shortcut ? `<kbd>${esc(key.shortcut)}</kbd>` : '<small class="unset">Not set</small>'}</li>`).join('')}</ul>`,
    foot: '<button class="btn" id="keysOpen">Configure</button>',
  });
  $('#keysOpen').onclick = () => { bg('keys.open').catch(() => {}); closeDialog(); };
}
