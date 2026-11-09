let gesture = null, lastHeaderTap = 0;
function pointerStart(e, kind) {
  return { kind, id: e.pointerId, x0: uiX(e), y0: uiY(e), t0: performance.now(), axis: null };
}
panel.addEventListener('pointerdown', (e) => {
  if (e.target.closest('textarea,pre,input,#cwGrip')) return;
  const onHeader = !!e.target.closest('#grab,.ph');
  if (e.pointerType === 'mouse' && !onHeader && mode !== 'mini') return;
  const box = uiRect(panel), host = uiRect(stage);
  gesture = { ...pointerStart(e, 'panel'), onHeader, onGrab: !!e.target.closest('#grab'), onButton: !!e.target.closest('button'), h0: panel.offsetHeight, px: box.left - host.left, py: box.top - host.top, boxW: box.width, boxH: box.height };
});
function movePanel(e, g) {
  const dx = uiX(e) - g.x0, dy = uiY(e) - g.y0, W = stage.offsetWidth, H = stage.offsetHeight;
  const host = uiRect(stage);
  if (!g.axis) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) <= DRAG_START_PX) return;
    g.axis = mode === 'mini' ? 'free' : Math.abs(dx) > Math.abs(dy) * AXIS_RATIO ? 'x' : 'y';
    if (g.axis === 'y' && !g.onHeader) { gesture = null; return; }
    panel.setPointerCapture(g.id);
    suppressClick = true;
  }
  if (g.axis === 'free') {
    const x = g.px + dx;
    setVars(panel, { '--x': x + 'px', '--y': clamp(g.py + dy, 0, H - g.boxH) + 'px' });
    const off = Math.max(-x, x + g.boxW - W) / g.boxW;
    if (off > OFF_EDGE_SHARE) showHint('Release to hide chat', x < 0 ? 'l' : 'r'); else clearHint();
    return;
  }
  if (g.axis === 'x') {
    const tx = mode === 'column' ? (side() === 'right' ? Math.max(0, dx) : Math.min(0, dx)) : dx;
    setVars(panel, { '--tx': tx + 'px', '--op': 1 - Math.min(0.65, Math.abs(tx) / W) });
    return;
  }
  if (mode === 'column') {
    if (dy > TO_BOTTOM_PX) showHint('Release to move chat down', 'b');
    else if (dy < -TO_FULL_PX) showHint('Release for full screen', side() === 'right' ? 'tr' : 'tl');
    else clearHint();
    return;
  }
  if (mode === 'full') {
    if (dy > TO_BOTTOM_PX) showHint('Release to go back', 'b'); else clearHint();
    return;
  }
  if (mode === 'sheet') {
    panel.classList.add('drag');
    panel.classList.remove('peek');
    panel.style.setProperty('--h', clamp(g.h0 - dy, PEEK_HEIGHT, H * SHEET_STOPS.full) + 'px');
    if (uiY(e) - host.top < TO_FULL_TOP_PX) showHint('Release for full screen', side() === 'right' ? 'tr' : 'tl'); else clearHint();
  }
}
function endPanel(e, g) {
  clearHint();
  const dx = uiX(e) - g.x0, dy = uiY(e) - g.y0, W = stage.offsetWidth, H = stage.offsetHeight;
  const host = uiRect(stage);
  if (!g.axis) {
    if (mode === 'mini') { suppressClick = true; setPosition(lastDocked); return; }
    if (g.onButton) return;
    if (g.onHeader && !e.target.closest('button')) {
      const now = performance.now();
      if (now - lastHeaderTap < DOUBLE_TAP_MS) { lastHeaderTap = 0; suppressClick = true; setPosition(mode === 'full' ? lastDocked : 'full'); return; }
      lastHeaderTap = now;
    }
    if (mode === 'sheet' && g.onGrab) setSheet({ peek: 'half', half: 'full', full: 'peek' }[sheetStop]);
    return;
  }
  if (g.axis === 'free') {
    const box = uiRect(panel), x = box.left - host.left;
    const off = Math.max(-x, x + box.width - W) / box.width;
    if (off > OFF_EDGE_SHARE) { closeChat(x < 0 ? -1 : 1); return; }
    panel.style.setProperty('--x', clamp(x, 0, W - box.width) + 'px');
    return;
  }
  if (g.axis === 'x') {
    const speed = dx / Math.max(1, performance.now() - g.t0);
    const allowed = mode !== 'column' || Math.sign(dx) === outward();
    if (allowed && (Math.abs(dx) > W * SWIPE_DISTANCE_SHARE || Math.abs(speed) > FLING_PX_PER_MS)) { closeChat(Math.sign(dx)); return; }
    panel.classList.add('fly');
    setVars(panel, { '--tx': '0px', '--op': 1 });
    setTimeout(() => panel.classList.remove('fly'), 190);
    return;
  }
  if (mode === 'column') {
    if (dy > TO_BOTTOM_PX) setPosition('sheet');
    else if (dy < -TO_FULL_PX) setPosition('full');
    return;
  }
  if (mode === 'full') {
    if (dy > TO_BOTTOM_PX) setPosition(lastDocked);
    return;
  }
  if (mode === 'sheet') {
    panel.classList.remove('drag');
    if (uiY(e) - host.top < TO_FULL_TOP_PX) return setPosition('full');
    const heights = { peek: PEEK_HEIGHT, half: H * SHEET_STOPS.half, full: H * SHEET_STOPS.full };
    const now = panel.offsetHeight;
    setSheet(Object.keys(heights).sort((a, b) => Math.abs(heights[a] - now) - Math.abs(heights[b] - now))[0]);
  }
}

let widening = null;
$('#cwGrip').addEventListener('pointerdown', (e) => {
  widening = { id: e.pointerId, x: uiX(e), w: panel.offsetWidth };
  e.currentTarget.setPointerCapture(e.pointerId);
  stage.classList.add('widening');
});
$('#cwGrip').addEventListener('pointermove', (e) => {
  if (!widening) return;
  const grown = (uiX(e) - widening.x) * -outward();
  const max = stage.offsetWidth - RAIL_GUTTER - PAGE_MIN_W;
  stage.style.setProperty('--cw', clamp(widening.w + grown, CHAT_MIN_W, max) + 'px');
});
function endWiden() {
  const atMax = widening && panel.offsetWidth >= stage.offsetWidth - RAIL_GUTTER - PAGE_MIN_W;
  widening = null;
  stage.classList.remove('widening');
  if (atMax) { stage.style.removeProperty('--cw'); setPosition('full'); }
}
$('#cwGrip').addEventListener('pointerup', endWiden);
$('#cwGrip').addEventListener('pointercancel', endWiden);

rail.addEventListener('pointerdown', (e) => {
  const box = uiRect(rail), host = uiRect(stage);
  gesture = { ...pointerStart(e, 'rail'), top: box.top - host.top };
});
const railOverSheet = () => chatOpen && mode === 'sheet';
function moveRail(e, g) {
  const dx = uiX(e) - g.x0, dy = uiY(e) - g.y0;
  if (!g.axis) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) <= DRAG_START_PX) return;
    g.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    suppressClick = true;
  }
  if (g.axis === 'x') {
    const tx = Math.sign(dx) === outward() ? dx : dx * INWARD_DRAG_DAMPING;
    rail.style.setProperty('--rtx', tx + 'px');
  } else if (!railOverSheet()) {
    const top = clamp(g.top + dy, 6, stage.offsetHeight - rail.offsetHeight - 6);
    railWantTop = top;
    stage.style.setProperty('--ry', top + 'px');
    stage.style.setProperty('--by', top + 'px');
  }
}
function endRail(e, g) {
  rail.style.setProperty('--rtx', '0px');
  if (g.axis !== 'x' || stage.classList.contains('marking')) return;
  const dx = uiX(e) - g.x0;
  const speed = Math.abs(dx) / Math.max(1, performance.now() - g.t0);
  if (Math.abs(dx) <= RAIL_SWIPE_PX && speed <= FLING_PX_PER_MS) return;
  if (Math.sign(dx) === outward()) toBadge();
  else if (!chatOpen) openChat();
}

badge.addEventListener('pointerdown', (e) => {
  const box = uiRect(badge), host = uiRect(stage);
  gesture = { ...pointerStart(e, 'badge'), top: box.top - host.top, switched: false, moved: false };
  badge.setPointerCapture(e.pointerId);
});
function moveBadge(e, g) {
  const dx = uiX(e) - g.x0, dy = uiY(e) - g.y0;
  if (Math.max(Math.abs(dx), Math.abs(dy)) > DRAG_START_PX) g.moved = true;
  if (!g.moved) return;
  stage.style.setProperty('--by', clamp(g.top + dy, 6, stage.offsetHeight - badge.offsetHeight - 6) + 'px');
  const host = uiRect(stage);
  const nextSide = uiX(e) - host.left < stage.offsetWidth / 2 ? 'left' : 'right';
  if (nextSide !== side() && Math.abs(dx) > stage.offsetWidth / 3) { stage.dataset.side = nextSide; g.switched = true; }
}
function endBadge(e, g) {
  if (recording) {
    if (!g.moved) stopRecording();
    return;
  }
  if (stage.classList.contains('marking')) {
    if (!g.moved) exitMarking();
    return;
  }
  if (g.switched) return;
  const dx = uiX(e) - g.x0, dy = uiY(e) - g.y0;
  const inward = Math.sign(dx) === -outward() && Math.abs(dx) > BADGE_SWIPE_PX && Math.abs(dx) > Math.abs(dy);
  if (inward && Math.abs(dx) > BADGE_TO_CHAT_PX) return openChat();
  if (!g.moved || inward) openRail();
}

window.addEventListener('pointermove', (e) => {
  if (!gesture || e.pointerId !== gesture.id) return;
  if (gesture.kind === 'panel') movePanel(e, gesture);
  else if (gesture.kind === 'rail') moveRail(e, gesture);
  else moveBadge(e, gesture);
});
function endGesture(e) {
  if (!gesture || e.pointerId !== gesture.id) return;
  const g = gesture;
  gesture = null;
  if (g.kind === 'panel') endPanel(e, g);
  else if (g.kind === 'rail') endRail(e, g);
  else endBadge(e, g);
}
window.addEventListener('pointerup', endGesture, true);
window.addEventListener('pointercancel', (e) => {
  if (!gesture || e.pointerId !== gesture.id) return;
  gesture = null;
  clearHint();
  setVars(panel, { '--tx': '0px', '--op': 1 });
  rail.style.setProperty('--rtx', '0px');
}, true);
root.addEventListener('click', (e) => {
  if (!suppressClick) return;
  suppressClick = false;
  e.stopPropagation();
  e.preventDefault();
}, true);
root.addEventListener('pointerdown', () => { suppressClick = false; }, true);

// Touch browsers drop the synthetic click right after a swipe, so buttons act on pointerup.
let pressedButton = null;
root.addEventListener('pointerdown', (e) => {
  pressedButton = e.pointerType === 'mouse' ? null : { el: e.target.closest?.('button'), x: uiX(e), y: uiY(e) };
}, true);
window.addEventListener('pointerup', (e) => {
  const press = pressedButton;
  pressedButton = null;
  if (!press?.el || suppressClick) return;
  if (Math.hypot(uiX(e) - press.x, uiY(e) - press.y) > DRAG_START_PX) return;
  if (root.elementFromPoint(e.clientX, e.clientY)?.closest('button') !== press.el) return;
  press.el.click();
  suppressClick = true;
  pageClickGuardUntil = Date.now() + PAGE_CLICK_GUARD_MS;
}, true);
// A tap can close the keyboard and shift the layout, so its click lands on the page under Tweakline.
const PAGE_CLICK_GUARD_MS = 700;
let pageClickGuardUntil = 0;
window.addEventListener('pointerdown', (e) => { if (!e.composedPath().includes(host)) pageClickGuardUntil = 0; }, true);
window.addEventListener('click', (e) => {
  if (!e.isTrusted || Date.now() > pageClickGuardUntil || e.composedPath().includes(host)) return;
  pageClickGuardUntil = 0;
  e.stopPropagation();
  e.preventDefault();
}, true);

