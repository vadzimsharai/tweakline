import { withLimit } from './limit.js';

const DEFAULT_READ_LIMIT = 20000;
const SNAPSHOT_TEXT_LIMIT = 4000;
const MAX_REFS = 300;
export const DEBUGGER_VERSION = '1.3';
const MS_PER_SECOND = 1000;

// The document the grant was checked on: a page that navigated meanwhile refuses the injection instead of running it.
export const pageTarget = (tabId, documentId) => (documentId ? { tabId, documentIds: [documentId] } : { tabId });

async function inPage({ tabId, documentId }, func, args = []) {
  const [injection] = await chrome.scripting.executeScript({ target: pageTarget(tabId, documentId), func, args });
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

async function runWithDebugger(tabId, code, guard, onlyAt) {
  await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
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

// Only an unavailable userScripts API falls back to the debugger; an error thrown by the page code is the answer, never a reason to run it twice.
async function executePageJs(tabId, code, documentId, guard, onlyAt) {
  let injections = null;
  try {
    if (chrome.userScripts?.execute) injections = await chrome.userScripts.execute({ target: pageTarget(tabId, documentId), world: 'MAIN', js: [{ code }] });
  } catch (error) {
    if (!USER_SCRIPTS_OFF.test(error.message)) throw error;
  }
  if (!injections) return runWithDebugger(tabId, code, guard, onlyAt);
  const [first] = injections;
  if (first?.error) throw new Error(first.error);
  return first?.result;
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
      await chrome.scripting.insertCSS({ target: pageTarget(tabId, documentId), css: String(args.css), origin: 'USER' });
      pushUndo(tabId, { kind: 'css', css: String(args.css), note: args.note, session });
      return { applied: true };
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
      if (step.kind === 'css') await chrome.scripting.removeCSS({ target: pageTarget(tabId, documentId), css: step.css, origin: 'USER' });
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
