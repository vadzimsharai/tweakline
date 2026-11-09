import { withLimit } from '../lib/limit.js';
import { dataUrlParts } from '../lib/media.js';
import { DEBUGGER_VERSION, pageTarget } from '../lib/ops.js';
import { sendToTab, topFrame } from './tabs.js';

// Capturing can hang on Android; a page action must still answer the AI.
const BEFORE_SHOT_LIMIT_MS = 4000;
const SHOT_LIMIT_MS = 15000;
const SHOOT_SETTLE_MS = 220;
const SCREENCAST_QUALITY = 60;

async function captureWithDebugger(tabId) {
  await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
  try {
    const { data } = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', { format: 'png' });
    return `data:image/png;base64,${data}`;
  } finally {
    chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

// captureVisibleTab shoots whatever tab is in front of the window, so it serves only a tab that is in front before and after.
export async function captureTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.active) {
    const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }).catch(() => null);
    if (shot && (await chrome.tabs.get(tabId)).active) return shot;
  }
  return captureWithDebugger(tabId);
}

const screencasts = new Map();

export async function startScreencast(tabId) {
  await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION);
  await chrome.debugger.sendCommand({ tabId }, 'Page.startScreencast', { format: 'jpeg', quality: SCREENCAST_QUALITY, everyNthFrame: 1 });
  screencasts.set(tabId, true);
}

export async function stopScreencast(tabId) {
  if (!screencasts.delete(tabId)) return;
  await chrome.debugger.sendCommand({ tabId }, 'Page.stopScreencast').catch(() => {});
  await chrome.debugger.detach({ tabId }).catch(() => {});
}

export function onDebuggerEvent(source, method, params) {
  if (method !== 'Page.screencastFrame' || !screencasts.has(source.tabId)) return;
  sendToTab(source.tabId, { type: 'frame', data: params.data });
  chrome.debugger.sendCommand({ tabId: source.tabId }, 'Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
}

// The page as it was before the AI's first edit, for the before and after view of a proposed patch.
const beforeShots = new Map();
export const beforeShotOf = (tabId) => beforeShots.get(tabId) || null;
export const forgetBeforeShot = (tabId) => beforeShots.delete(tabId);

export async function noteBefore(tabId, documentId) {
  if (beforeShots.has(tabId)) return;
  sendToTab(tabId, { type: 'shooting', on: true });
  await new Promise((resolve) => setTimeout(resolve, SHOOT_SETTLE_MS));
  const shot = await withLimit(captureTab(tabId), BEFORE_SHOT_LIMIT_MS, 'before shot').catch(() => null);
  const view = await chrome.scripting.executeScript({ target: pageTarget(tabId, documentId), func: () => ({ url: location.href, scrollY, width: innerWidth }) }).then(([found]) => found.result).catch(() => null);
  beforeShots.set(tabId, shot && view ? { shot, ...view } : null);
  sendToTab(tabId, { type: 'shooting', on: false });
}

export function createShotUploader(sessionCall) {
  return async function captureAndStore(tabId, session, documentId) {
    const { type, base64 } = dataUrlParts(await withLimit(captureTab(tabId), SHOT_LIMIT_MS, 'The screenshot did not finish, try again'));
    if (documentId && (await topFrame(tabId))?.documentId !== documentId) throw new Error('the page changed during the screenshot, try again');
    return sessionCall(session, 'file.put', { session, name: 'page.png', type, base64 });
  };
}
