const PREVIEW_MAX_W = 960;
const PREVIEW_QUALITY = 0.82;
const FOCUS_PAD = 24;
const FOCUS_MIN_W = 280;
const FOCUS_MIN_H = 140;

let patchSite = location.host;
let comparing = null;

async function shrinkShot(dataUrl, area = null) {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const ratio = image.width / innerWidth;
  const crop = area ? focusCrop(area, ratio, image) : { x: 0, y: 0, w: image.width, h: image.height };
  const scale = Math.min(1, PREVIEW_MAX_W / crop.w);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(crop.w * scale);
  canvas.height = Math.round(crop.h * scale);
  canvas.getContext('2d').drawImage(image, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', PREVIEW_QUALITY);
}

// The changed element with some page around it, never smaller than a readable piece of the page.
function focusCrop(area, ratio, image) {
  const w = Math.min(image.width, Math.max(FOCUS_MIN_W, area.width + FOCUS_PAD * 2) * ratio);
  const h = Math.min(image.height, Math.max(FOCUS_MIN_H, area.height + FOCUS_PAD * 2) * ratio);
  const cx = (area.left + area.width / 2) * ratio, cy = (area.top + area.height / 2) * ratio;
  return { x: clamp(cx - w / 2, 0, image.width - w), y: clamp(cy - h / 2, 0, image.height - h), w, h };
}

function findFocus(selector) {
  if (!selector) return null;
  try { return document.querySelector(selector); } catch { return null; }
}

// "Before" can only be compared with a shot of the same page, width and scroll position.
async function patchPreviews(proposal) {
  const saved = await bg('edit.before').catch(() => null);
  const comparable = Boolean(saved?.shot) && saved.url === location.href && saved.width === innerWidth;
  const focus = findFocus(proposal.focus);
  const startY = scrollY;
  if (comparable) scrollTo({ top: saved.scrollY, behavior: 'instant' });
  const rectOf = () => focus?.getBoundingClientRect();
  const visible = !focus || (rectOf().top >= 0 && rectOf().bottom <= innerHeight);
  if (!visible) focus.scrollIntoView({ block: 'center', behavior: 'instant' });
  const area = focus ? rectOf() : null;
  const afterShot = await capturePage().catch(() => null);
  scrollTo({ top: startY, behavior: 'instant' });
  const after = afterShot ? await shrinkShot(afterShot, area).catch(() => null) : null;
  const before = comparable && visible ? await shrinkShot(saved.shot, area).catch(() => null) : null;
  return { before, after };
}

const previewHtml = (before, after) => {
  if (before && after && before !== after) return compareHtml(before, after);
  return after ? `<button class="pshot" aria-label="Open preview"><img src="${esc(after)}" alt=""></button>` : '';
};
function wirePreview(after) {
  over.querySelector('.pshot')?.addEventListener('click', () => openViewer([{ kind: 'shot', dataUrl: after }], 0));
}
function wireCodeToggle() {
  over.querySelectorAll('details.pcode').forEach((box) => box.addEventListener('toggle', () => {
    box.querySelector('summary').textContent = box.open ? 'Hide code' : 'Show code';
  }));
}

const compareHtml = (before, after) => `<div class="cmp" aria-label="Comparison: before and after"><div class="mp">${before ? `<img src="${esc(before)}" alt="">` : ''}</div><div class="mp af">${after ? `<img src="${esc(after)}" alt="">` : ''}</div><i class="cut"></i><span class="tag l">Before</span><span class="tag r">After</span></div>`;

function moveCut(e) {
  const box = uiRect(comparing);
  comparing.style.setProperty('--cut', `${clamp((uiX(e) - box.left) / box.width * 100, 0, 100)}%`);
}
function wireCompare() {
  over.addEventListener('pointerdown', (e) => {
    comparing = e.target.closest('.cmp');
    if (!comparing) return;
    comparing.setPointerCapture(e.pointerId);
    moveCut(e);
  });
  over.addEventListener('pointermove', (e) => { if (comparing) moveCut(e); });
  over.addEventListener('pointerup', () => { comparing = null; });
  over.addEventListener('pointercancel', () => { comparing = null; });
}

function maskFor(where, pattern) {
  const here = new URL(location.href);
  if (where === 'page') return { mask: `${here.host}${here.pathname}${here.search}` };
  if (where === 'section') return { mask: `${here.host}${here.pathname.split('/').slice(0, 2).join('/')}*` };
  if (where === 'site') return { mask: `${here.host}/*` };
  return { pattern };
}

function patchStatus(p) {
  if (p.js && !p.jsApproved) return 'Needs your OK to run its code';
  if (!p.on) return 'Off';
  return p.here ? 'On for this page' : 'On, this page is not covered';
}

const shownCode = (p) => (p.undo ? `${p.js}\n\n// Undo, runs when you switch the patch off\n${p.undo}` : p.js);
const PATCH_RELOAD_MS = 600;

async function setPatchOn(p, button) {
  p.on = !p.on;
  button.classList.toggle('on', p.on);
  button.setAttribute('aria-pressed', p.on);
  const result = await bg('patch.setPrefs', { id: p.id, on: p.on }).catch((error) => ({ ok: false, reason: error.message }));
  if (result?.reload) {
    showToast('Reloading the page', 'This patch has no undo, a reload removes its changes');
    setTimeout(() => location.reload(), PATCH_RELOAD_MS);
    return;
  }
  if (result?.ok === false) showToast(p.on ? 'The patch did not apply' : 'The patch was not removed', result.reason === 'not-approved' ? 'Allow its code on this device first' : `The page blocked it: ${result.reason}`);
}

// A proposal waits in the chat and in the patches list; the save sheet opens only when the person asks.
let patchDrafts = [];
let draftCounter = 0;

function addPatchDraft(proposal) {
  const draft = { ...proposal, draftId: String(++draftCounter) };
  patchDrafts = [...patchDrafts.filter((d) => d.title !== draft.title), draft];
  const card = appendRaw(`<div class="pdraft" data-draft-card="${draft.draftId}"><span class="rmain"><span class="rtitle">${esc(draft.title || 'Patch')}</span><span class="rsub">Ready to save as a patch</span></span><button class="btn small pri" data-save-draft="${draft.draftId}">Save patch</button></div>`);
  card.querySelector('[data-save-draft]').onclick = () => openDraft(draft.draftId);
  countUnread();
}

function openDraft(draftId) {
  const draft = patchDrafts.find((d) => d.draftId === draftId);
  if (!draft) { showToast('This patch was already saved'); return; }
  savePatchDialog(draft).catch((error) => showToast('Patch not saved', error.message));
}

function draftSaved(draftId) {
  patchDrafts = patchDrafts.filter((d) => d.draftId !== draftId);
  root.querySelectorAll(`[data-draft-card="${draftId}"]`).forEach((card) => {
    card.querySelector('.rsub').textContent = 'Saved as a patch';
    card.querySelector('[data-save-draft]').remove();
  });
}

async function patchesDialog() {
  let patches = [];
  try { patches = await bg('patch.list'); } catch (error) { showToast('Patches unavailable', error.message); }
  const sites = [...new Set([location.host, ...patches.map((p) => p.site)])];
  if (!sites.includes(patchSite)) patchSite = location.host;
  const shown = patches.filter((p) => p.site === patchSite);
  const siteTabs = sites.length > 1 ? `<div class="seg psitetabs" role="tablist" aria-label="Sites">${sites.map((site) => `<button role="tab" aria-selected="${site === patchSite}" class="${site === patchSite ? 'on' : ''}" data-site="${esc(site)}">${esc(site)}</button>`).join('')}</div>` : '';
  const rows = shown.map((p, i) => `<div class="row pc${p.on ? '' : ' off'}" data-i="${i}">
      <button class="popen" aria-label="Open ${esc(p.title)}"><span class="rtitle">${esc(p.title)}</span><span class="rsub">${esc(patchStatus(p))}</span></button>
      ${p.js && !p.jsApproved ? '<button class="btn small approve">Allow</button>' : `<button class="tog pon ${p.on ? 'on' : ''}" aria-pressed="${p.on}" aria-label="Turn patch on"></button>`}
    </div>`).join('');
  const drafts = patchSite === location.host ? patchDrafts : [];
  const draftRows = drafts.length ? `<div class="sect">Not saved yet</div><div class="list">${drafts.map((d) => `<div class="row pdraftrow"><span class="rmain"><span class="rtitle">${esc(d.title || 'Patch')}</span><span class="rsub">The AI changed this page</span></span><button class="btn small pri" data-draft="${d.draftId}">Save</button></div>`).join('')}</div>${shown.length ? '<div class="sect">Saved</div>' : ''}` : '';
  openSheet({
    title: 'Patches',
    body: `${siteTabs}${draftRows}${shown.length ? `<div class="list">${rows}</div>` : drafts.length ? '' : `<p class="lead">No patches for ${esc(patchSite)} yet. Ask your AI to change something, then save the result.</p>`}`,
  });
  over.querySelectorAll('[data-site]').forEach((b) => { b.onclick = () => { patchSite = b.dataset.site; patchesDialog(); }; });
  over.querySelectorAll('[data-draft]').forEach((b) => { b.onclick = () => openDraft(b.dataset.draft); });
  over.querySelectorAll('.pc').forEach((row) => {
    const p = shown[Number(row.dataset.i)];
    row.querySelector('.popen').onclick = () => patchDetail(p);
    row.querySelector('.approve')?.addEventListener('click', () => approveJsDialog(p));
    const toggle = row.querySelector('.pon');
    if (toggle) toggle.onclick = async () => {
      await setPatchOn(p, toggle);
      row.classList.toggle('off', !p.on);
      row.querySelector('.rsub').textContent = patchStatus(p);
    };
  });
}

function patchDetail(p) {
  openSheet({
    title: p.title,
    back: patchesDialog,
    body: `${previewHtml(p.before, p.after)}
      ${p.desc ? `<p class="lead">${esc(p.desc)}</p>` : ''}
      <div class="sect">Where it works</div><div class="pscope">${esc(p.mask || p.pattern || '')}</div>
      <div class="psw"><span>Apply when the page opens</span><button class="tog auto ${p.auto ? 'on' : ''}" aria-pressed="${p.auto}" aria-label="Apply when the page opens"></button></div>
      <div class="psw"><span>Sync through the server${p.fromSync ? '<small>Came from the server</small>' : ''}</span><button class="tog syncTog ${p.sync ? 'on' : ''}" aria-pressed="${p.sync}" aria-label="Sync through the server"></button></div>
      ${p.js ? `<details class="pcode"><summary>Show code</summary><pre><code>${esc(shownCode(p))}</code></pre></details>` : ''}
      <div class="sect">For a site you own</div>
      <p class="lead pcodehint">The AI moves this change into the site's source code, so everyone sees it, not only this browser.</p>
      <button class="btn full tocode">Ask AI to add it to the site's code</button>
      <button class="btn full danger del">Delete patch</button>`,
  });
  wirePreview(p.after);
  wireCodeToggle();
  const scope = over.querySelector('.dbody');
  scope.querySelector('.auto').onclick = async (e) => {
    const button = e.currentTarget;
    p.auto = !p.auto;
    button.classList.toggle('on', p.auto);
    button.setAttribute('aria-pressed', p.auto);
    await bg('patch.setPrefs', { id: p.id, auto: p.auto }).catch(() => {});
  };
  scope.querySelector('.syncTog').onclick = async (e) => {
    const button = e.currentTarget;
    const next = !p.sync;
    try {
      await bg('patch.setSync', { id: p.id, sync: next });
      p.sync = next;
      button.classList.toggle('on', next);
      button.setAttribute('aria-pressed', next);
    } catch (error) { showToast('Sync did not change', error.message); }
  };
  scope.querySelector('.tocode').onclick = async () => {
    if (!session) return sessionsDialog();
    await bg('patch.send', { session: session.id, patch: { ...p, before: undefined, after: undefined } });
    closeDialog();
    openChat();
    appendSystem(`Patch "${p.title}" sent to AI to put into code`);
  };
  const del = scope.querySelector('.del');
  del.onclick = async () => {
    if (!del.classList.contains('armed')) { del.classList.add('armed'); del.textContent = 'Tap again to delete'; return; }
    await bg('patch.delete', { id: p.id });
    patchesDialog();
  };
}

function approveJsDialog(patch) {
  openSheet({
    title: 'Allow this code?',
    back: patchesDialog,
    body: `<p class="lead">It will run on ${esc(patch.mask || patch.pattern || '')} on this device. Read it first.</p><div class="pcode"><pre><code>${esc(shownCode(patch))}</code></pre></div>`,
    foot: '<button class="btn" id="jsNo">Cancel</button><button class="btn pri" id="jsYes">Allow</button>',
  });
  $('#jsNo').onclick = patchesDialog;
  $('#jsYes').onclick = async () => {
    await bg('patch.setPrefs', { id: patch.id, approve: { js: patch.js, undo: patch.undo, mask: patch.mask, pattern: patch.pattern } });
    patchesDialog();
  };
}

async function savePatchDialog(proposal) {
  const { before, after } = await patchPreviews(proposal);
  const saved = await bg('patch.list').catch(() => []);
  const replacing = saved.find((p) => p.id === proposal.replaces) || saved.find((p) => p.site === location.host && p.title === proposal.title);
  // The AI's scope is offered only when it covers this page and stays on this host.
  const asked = proposal.mask ? String(proposal.mask) : '';
  const suggestedMask = asked && await bg('patch.scopeFits', { mask: asked }).catch(() => false) ? asked : '';
  let where = suggestedMask ? 'suggested' : 'section';
  const whereButton = (key, label) => `<button class="${where === key ? 'on' : ''}" data-w="${key}">${label}</button>`;
  openSheet({
    title: replacing ? 'Update patch' : 'Save patch',
    body: `${previewHtml(before, after)}
      ${replacing ? `<div class="msg" id="pReplacing">Replaces your patch "${esc(replacing.title)}". Its old version is switched off first.</div>` : ''}
      <label class="field"><span>Name</span><input id="pTitle" value="${esc(proposal.title || '')}" autocomplete="off"></label>
      <label class="field"><span>What it does</span><textarea id="pDesc" rows="2">${esc(proposal.desc || '')}</textarea></label>
      <div class="sect">Where it works</div>
      <div class="seg">${suggestedMask ? whereButton('suggested', 'Suggested') : ''}${whereButton('page', 'This page')}${whereButton('section', 'Section')}${whereButton('site', 'Whole site')}${whereButton('regexp', 'Pattern')}</div>
      <div class="pscope" id="pScope"></div>
      <div class="field pattern" id="pReBox"><input id="pRe" aria-label="Pattern" placeholder="^https://site\\.example/path/.*" value="${esc(proposal.pattern || '')}"></div>
      <div class="psw"><span>Apply when the page opens</span><button class="tog" id="pAuto" aria-label="Apply when the page opens"></button></div>
      ${proposal.js ? `<div class="psw"><span>Allow its code to run on this device<small>Without this the patch stays off.</small></span><button class="tog" id="pJs" aria-label="Allow its code to run"></button></div>
      <details class="pcode"><summary>Show code</summary><pre><code>${esc(shownCode(proposal))}</code></pre></details>` : ''}`,
    foot: `<button class="btn" id="pNo">Cancel</button><button class="btn pri" id="pYes">${replacing ? 'Update patch' : 'Save patch'}</button>`,
  });
  wirePreview(after);
  wireCodeToggle();
  const scopeText = () => (where === 'suggested' ? suggestedMask : maskFor(where, '').mask || '');
  const syncScope = () => {
    $('#pScope').textContent = scopeText();
    $('#pScope').hidden = where === 'regexp';
    $('#pReBox').hidden = where !== 'regexp';
  };
  syncScope();
  $('#pDesc').style.height = `${$('#pDesc').scrollHeight + 2}px`;
  wireSegments((_seg, b) => {
    where = b.dataset.w;
    syncScope();
  });
  $('#pAuto').onclick = (e) => e.currentTarget.classList.toggle('on');
  onClickIfShown('#pJs', (e) => e.currentTarget.classList.toggle('on'));
  $('#pNo').onclick = closeDialog;
  $('#pYes').onclick = async () => {
    const title = $('#pTitle').value.trim();
    if (!title) { showToast('Title required'); return; }
    const pattern = $('#pRe').value.trim();
    if (where === 'regexp') {
      const problem = pattern ? await bg('patch.patternProblem', { pattern }).catch((error) => error.message) : 'Enter a pattern';
      if (problem) { showToast('Patch not saved', problem); return; }
    }
    const patch = {
      site: location.host, title, desc: $('#pDesc').value.trim(),
      css: proposal.css || '', js: proposal.js || '', undo: proposal.js ? String(proposal.undo || '') : '', request: proposal.request || '',
      before, after, ...(where === 'suggested' ? { mask: suggestedMask } : maskFor(where, pattern)),
    };
    try {
      const result = await bg('patch.save', { patch, replaces: replacing?.id, prefs: { auto: $('#pAuto').classList.contains('on'), approveJs: Boolean($('#pJs')?.classList.contains('on')) } });
      if (proposal.draftId) draftSaved(proposal.draftId);
      if (result?.reload) { location.reload(); return; }
      if (result?.failed) showToast('Saved, but the patch did not apply', `The page blocked it: ${result.failed}`);
      patchSite = location.host;
      patchesDialog();
    } catch (error) { showToast('Patch not saved', error.message); }
  };
}
