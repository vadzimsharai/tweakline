import { withLimit } from './limit.js';

const DEFAULT_READ_LIMIT = 20000;
const SNAPSHOT_TEXT_LIMIT = 4000;
const MAX_REFS = 300;
export const DEBUGGER_VERSION = '1.3';
const MS_PER_SECOND = 1000;

// The document the grant was checked on: a page that navigated meanwhile refuses the injection instead of running it.
export const pageTarget = (tabId, documentId) => (documentId ? { tabId, documentIds: [documentId] } : { tabId });

async function inPage({ tabId, documentId }, func, args = [], world = 'ISOLATED') {
  const [injection] = await chrome.scripting.executeScript({ target: pageTarget(tabId, documentId), func, args, world });
  if (injection?.error) throw new Error(injection.error.message || 'page script failed');
  return injection?.result;
}

function readPage(limit) {
  return { url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, limit) };
}

function snapshotPage(maxRefs, textLimit) {
  const selector = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[onclick],[tabindex]:not([tabindex="-1"])';
  const seen = [];
  for (const el of document.querySelectorAll(selector)) {
    if (seen.length >= maxRefs) break;
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    seen.push(el);
  }
  globalThis.__tweaklineRefs = seen;
  const lines = seen.map((el, i) => {
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    return `[${i}] ${el.tagName.toLowerCase()} ${label}`;
  });
  return { url: location.href, title: document.title, refs: lines, text: (document.body?.innerText || '').slice(0, textLimit) };
}

function actOnPage(action, target, options) {
  const find = () => {
    const [kind, ...rest] = String(target).split(':');
    const value = rest.join(':');
    if (kind === 'ref') return globalThis.__tweaklineRefs?.[Number(value)];
    if (kind === 'css') return document.querySelector(value);
    if (kind === 'text') {
      const wanted = value.trim().toLowerCase();
      return [...document.querySelectorAll('a,button,input,summary,[role=button],[role=link],label')]
        .find((el) => (el.innerText || el.value || '').trim().toLowerCase().includes(wanted));
    }
    return null;
  };
  if (action === 'scroll') { window.scrollBy(0, options.y || 0); return { y: window.scrollY }; }
  const el = find();
  if (!el) throw new Error(`target not found: ${target}`);
  el.scrollIntoView({ block: 'center', inline: 'center' });
  if (action === 'click') { el.click(); return true; }
  el.focus();
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
  const previous = options.clear ? '' : (el.value ?? '');
  if (setter) setter.call(el, previous + options.text); else el.textContent = previous + options.text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  if (options.enter) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    el.form?.requestSubmit?.();
  }
  return true;
}

// A blocked script must still answer the AI: the fold once left it waiting with no reply.
const JS_RUN_LIMIT_MS = 20000;

// The debugger cannot be pinned to a document, so the code itself first checks that the page is still one the grants cover.
export function guardSource(grants) {
  const allowed = JSON.stringify(grants.map(({ kind, origin, url, host, pattern }) => ({ kind, origin, url, host, pattern })));
  return `if (!${allowed}.some((g) => g.kind === 'tab' ? g.origin === location.origin : g.kind === 'page' ? String(g.url).split('#')[0] === location.href.split('#')[0] : g.kind === 'site' ? g.host === location.hostname : g.kind === 'regexp' ? new RegExp('^(?:' + g.pattern + ')$').test(location.href) : false)) throw new Error('not granted');\n`;
}

// A patch is checked against one address; the debugger runs it only while the page is still there.
export const addressGuardSource = (url) => `if (location.href !== ${JSON.stringify(String(url))}) throw new Error('the page changed, try again');\n`;

const DEBUGGER_UNAVAILABLE = 'debugger unavailable';

async function runWithDebugger(tabId, code, guard, onlyAt) {
  try {
    await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
  } catch (error) {
    throw new Error(`${DEBUGGER_UNAVAILABLE}: ${error.message}`);
  }
  try {
    const expression = `${guard ? guardSource(guard) : ''}${onlyAt ? addressGuardSource(onlyAt) : ''}${code}`;
    const { result, exceptionDetails } = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result?.value;
  } finally {
    chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

export function runPageJs(tabId, code, { documentId, guard, onlyAt } = {}) {
  const message = `JS did not finish in ${JS_RUN_LIMIT_MS / MS_PER_SECOND} s. Code runs as a script: no top-level return, wrap it in (() => { ... })()`;
  return withLimit(executePageJs(tabId, code, documentId, guard, onlyAt), JS_RUN_LIMIT_MS, message);
}

const USER_SCRIPTS_OFF = /disabled|not allowed|developer|permission|User scripts/i;
const NONCE_BYTES = 12;
const RUN_MARK_PREFIX = 'tweakline-ran-';

export const newNonce = () => [...crypto.getRandomValues(new Uint8Array(NONCE_BYTES))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

// Some Android browsers answer userScripts.execute without running anything: the code first announces itself, so a silent no-op is told apart from a run.
export const markedCode = (code, mark) => `document.dispatchEvent(new CustomEvent(${JSON.stringify(mark)}));\n${code}`;

// Runs in the extension's isolated world, which sees the page's DOM events but not its globals.
function armRunMark(mark) {
  const marks = globalThis.__tweaklineRunMarks ??= new Map();
  const entry = { heard: false, listener: () => { entry.heard = true; } };
  marks.set(mark, entry);
  document.addEventListener(mark, entry.listener, { once: true });
  return true;
}

function takeRunMark(mark) {
  const marks = globalThis.__tweaklineRunMarks;
  const entry = marks?.get(mark);
  if (!entry) return false;
  marks.delete(mark);
  document.removeEventListener(mark, entry.listener);
  return entry.heard;
}

// A document that went away meanwhile (the code navigated) cannot be asked: the code started, so its answer stands.
const heardRunMark = (page, mark) => inPage(page, takeRunMark, [mark]).catch(() => true);

// Runs in the page's own world: indirect eval keeps the value of the last statement, as a script would. A <script> element added by a content script does not run in MV3, the extension's own CSP blocks it.
function evalInPage(code) {
  try { (0, eval)('0'); } catch { return { blocked: "the page's Content-Security-Policy blocks eval" }; }
  const done = (value) => {
    if (value === undefined) return { ok: true };
    try { return { ok: true, value: JSON.parse(JSON.stringify(value) ?? 'null') }; } catch { return { ok: true, value: String(value) }; }
  };
  const fail = (error) => ({ ok: false, error: String((error && error.stack) || error) });
  try {
    return Promise.resolve((0, eval)(code)).then(done, fail);
  } catch (error) {
    return fail(error);
  }
}

// Only an unavailable or silent userScripts API moves on to the page world, and only a page that forbids eval to the debugger; an error thrown by the page code is the answer, never a reason to run it twice.
async function executePageJs(tabId, code, documentId, guard, onlyAt) {
  const page = { tabId, documentId };
  if (chrome.userScripts?.execute) {
    const mark = `${RUN_MARK_PREFIX}${newNonce()}`;
    await inPage(page, armRunMark, [mark]);
    let injections = null;
    try {
      injections = await chrome.userScripts.execute({ target: pageTarget(tabId, documentId), world: 'MAIN', js: [{ code: markedCode(code, mark) }] });
    } catch (error) {
      if (!USER_SCRIPTS_OFF.test(error.message)) throw error;
    }
    const [first] = injections || [];
    if (first?.error) throw new Error(first.error);
    const ran = await heardRunMark(page, mark);
    if (injections && ran) return first?.result;
  }
  const answer = await inPage(page, evalInPage, [code], 'MAIN');
  if (answer?.ok) return answer.value;
  if (answer?.ok === false) throw new Error(answer.error);
  const blocked = answer?.blocked || 'the browser did not run it in the page';
  const mark = `${RUN_MARK_PREFIX}${newNonce()}`;
  await inPage(page, armRunMark, [mark]);
  let value;
  try {
    value = await runWithDebugger(tabId, markedCode(code, mark), guard, onlyAt);
  } catch (error) {
    if (error.message.startsWith(DEBUGGER_UNAVAILABLE)) throw new Error(`JS did not run: ${blocked}, and the ${error.message}`);
    throw error;
  }
  if (!await heardRunMark(page, mark)) throw new Error(`JS did not run: ${blocked}, and the debugger answered without running it`);
  return value;
}

const CSS_MARK_PREFIX = '--tweakline-applied-';

// The mark goes first, so a broken rule in the CSS itself cannot hide it.
export const markedCss = (css, key) => `:root{${CSS_MARK_PREFIX}${key}:1}\n${css}`;
export const cssKey = (value) => String(value).replace(/[^\w-]/g, '_');

function cssMarkComputes(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() === '1';
}

// A stylesheet adopted by the document: the page's DOM is shared with the isolated world, and the page's CSP does not cover it.
function adoptSheet(key, css, markName) {
  const sheets = globalThis.__tweaklineSheets ??= new Map();
  const old = sheets.get(key);
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  sheets.set(key, sheet);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets.filter((s) => s !== old), sheet];
  return getComputedStyle(document.documentElement).getPropertyValue(markName).trim() === '1';
}

function dropSheet(key) {
  const sheets = globalThis.__tweaklineSheets;
  const sheet = sheets?.get(key);
  if (!sheet) return false;
  sheets.delete(key);
  document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
  return true;
}

// Some Android browsers resolve insertCSS without applying it: a mark rule is read back, and an adopted stylesheet takes over when it does not compute.
export async function applyPageCss(tabId, documentId, css, key) {
  const page = { tabId, documentId };
  const target = pageTarget(tabId, documentId);
  const marked = markedCss(css, key);
  const markName = `${CSS_MARK_PREFIX}${key}`;
  let refused = '';
  try {
    await chrome.scripting.insertCSS({ target, css: marked, origin: 'USER' });
    if (await inPage(page, cssMarkComputes, [markName])) return 'user';
    await chrome.scripting.removeCSS({ target, css: marked, origin: 'USER' }).catch(() => {});
  } catch (error) {
    refused = ` (insertCSS: ${error.message})`;
  }
  if (await inPage(page, adoptSheet, [key, marked, markName])) return 'sheet';
  await inPage(page, dropSheet, [key]).catch(() => {});
  throw new Error(`CSS did not take effect${refused}: the browser ignored both the injected style and a stylesheet on the page`);
}

export async function removePageCss(tabId, documentId, css, key) {
  await inPage({ tabId, documentId }, dropSheet, [key]);
  await chrome.scripting.removeCSS({ target: pageTarget(tabId, documentId), css: markedCss(css, key), origin: 'USER' });
}

// Long enough to read that the page is about to reload.
export const RELOAD_NOTICE_MS = 800;

// Undo steps are kept per tab but belong to the session that made them: a session never undoes another one's change.
export function popUndo(undoStacks, tabId, session) {
  const stack = undoStacks.get(tabId) || [];
  const at = session ? stack.findLastIndex((step) => step.session === session) : -1;
  return at < 0 ? null : stack.splice(at, 1)[0];
}

export function createOps({ undoStacks, captureAndStore, proposePatch, noteBefore, beforeReload = async () => {} }) {
  const pushUndo = (tabId, step) => {
    const stack = undoStacks.get(tabId) || [];
    stack.push(step);
    undoStacks.set(tabId, stack);
  };

  return {
    read: ({ args, ...page }) => inPage(page, readPage, [args.limit || DEFAULT_READ_LIMIT]),
    snapshot: (page) => inPage(page, snapshotPage, [MAX_REFS, SNAPSHOT_TEXT_LIMIT]),
    click: ({ args, ...page }) => inPage(page, actOnPage, ['click', args.target, {}]),
    type: ({ args, ...page }) => inPage(page, actOnPage, ['type', args.target, { text: String(args.text ?? ''), clear: Boolean(args.clear), enter: Boolean(args.enter) }]),
    scroll: ({ args, ...page }) => inPage(page, actOnPage, ['scroll', '', { y: Number(args.y) || 0 }]),
    navigate: async ({ tabId, args }) => { await chrome.tabs.update(tabId, { url: args.url }); return true; },
    shot: ({ tabId, documentId, session }) => captureAndStore(tabId, session, documentId),
    css: async ({ tabId, documentId, args, session }) => {
      await noteBefore(tabId, documentId);
      const css = String(args.css);
      const key = newNonce();
      const via = await applyPageCss(tabId, documentId, css, key);
      pushUndo(tabId, { kind: 'css', css, key, note: args.note, session });
      return { applied: true, via };
    },
    js: async ({ tabId, documentId, guard, args, session }) => {
      await noteBefore(tabId, documentId);
      const value = await runPageJs(tabId, String(args.code), { documentId, guard });
      pushUndo(tabId, { kind: 'js', undo: args.undo ? String(args.undo) : null, note: args.note, session });
      return { applied: true, value };
    },
    undo: async ({ tabId, documentId, guard, session }) => {
      const step = popUndo(undoStacks, tabId, session);
      if (!step) return { undone: false };
      if (step.kind === 'css') await removePageCss(tabId, documentId, step.css, step.key);
      else if (step.undo) await runPageJs(tabId, step.undo, { documentId, guard });
      else {
        await beforeReload(tabId);
        await chrome.tabs.reload(tabId);
        return { undone: true, reloaded: true };
      }
      return { undone: true };
    },
    proposePatch: ({ tabId, args, session }) => proposePatch(tabId, session, args),
  };
}
