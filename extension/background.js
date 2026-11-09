import { createOps, RELOAD_NOTICE_MS } from './lib/ops.js';
import { createShotUploader, forgetBeforeShot, noteBefore, onDebuggerEvent } from './bg/capture.js';
import { dropTabGrants } from './bg/grants.js';
import { createPatching, proposePatch } from './bg/patching.js';
import { createRelay } from './bg/relay.js';
import { createOpRunner } from './bg/runner.js';
import { createServers } from './bg/servers.js';
import { createSessions } from './bg/sessions.js';
import { store } from './bg/storage.js';
import { activeTab, sendToTab } from './bg/tabs.js';
import { createUiMethods } from './bg/ui-methods.js';

// Device tokens live here, so content scripts must not read this storage directly.
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
const KEEPALIVE_ALARM = 'tweakline-keepalive';
const KEEPALIVE_MINUTES = 0.5;
const WEB_PAGES = ['http://*/*', 'https://*/*'];

const undoStacks = new Map();

const relay = createRelay({
  onReady: (serverId) => patching.pull(serverId),
  runOp: (serverId, msg) => runner.runOp(serverId, msg),
});
const sessions = createSessions({ call: relay.call });
const patching = createPatching({ call: relay.call, readyServerIds: relay.readyServerIds });
const servers = createServers({ relay, sessions, patching });
const beforeReload = async (tabId) => {
  sendToTab(tabId, { type: 'reloading' });
  await new Promise((resolve) => setTimeout(resolve, RELOAD_NOTICE_MS));
};
const ops = createOps({ undoStacks, captureAndStore: createShotUploader(sessions.sessionCall), proposePatch, noteBefore, beforeReload });
const runner = createOpRunner({ ops, resolveTab: sessions.resolveTab });
const uiMethods = createUiMethods({ relay, sessions, servers, patching, ops });

const syncSockets = () => { relay.syncSockets().catch(() => {}); };

chrome.tabs.onRemoved.addListener(async (tabId) => {
  undoStacks.delete(tabId);
  runner.forgetTab(tabId);
  await dropTabGrants((g) => g.tabId === tabId);
  await sessions.unbindClosedTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== 'loading') return;
  undoStacks.delete(tabId);
  forgetBeforeShot(tabId);
});

chrome.webNavigation.onCommitted.addListener(async ({ tabId, frameId, documentId, url }) => {
  if (frameId === 0 && documentId) await patching.applyAutoPatches(tabId, { documentId, url });
});

chrome.debugger.onEvent.addListener(onDebuggerEvent);

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.to !== 'bg' || !sender.tab) return false;
  const method = uiMethods[message.method];
  if (!method) { respond({ ok: false, error: `unknown method ${message.method}` }); return false; }
  syncSockets();
  Promise.resolve()
    .then(() => method(message.params || {}, sender.tab))
    .then((data) => respond({ ok: true, data }), (error) => respond({ ok: false, error: error.message }));
  return true;
});

const toggleHidden = async () => uiMethods['ui.setHidden']({ hidden: !(await store.get('hidden', false)) });
globalThis.tweaklineToggle = toggleHidden;
chrome.action.onClicked.addListener(toggleHidden);
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle') return toggleHidden();
  const active = await activeTab();
  if (active?.id !== undefined) sendToTab(active.id, { type: 'command', command });
});

// Open pages keep the old copy after an update, or none after an install; give them the current one now.
async function injectIntoOpenTabs() {
  const files = chrome.runtime.getManifest().content_scripts[0].js;
  const tabs = await chrome.tabs.query({ url: WEB_PAGES });
  await Promise.allSettled(tabs.map((tab) => chrome.scripting.executeScript({ target: { tabId: tab.id }, files })));
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  chrome.storage.local.remove('config');
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
  if (reason === 'install' || reason === 'update') injectIntoOpenTabs().catch(() => {});
  syncSockets();
});
chrome.runtime.onStartup.addListener(() => {
  sessions.forgetTabIdsOncePerBrowserRun().catch(() => {});
  syncSockets();
});
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_MINUTES });
chrome.alarms.onAlarm.addListener(syncSockets);
sessions.forgetTabIdsOncePerBrowserRun().catch(() => {});
syncSockets();
