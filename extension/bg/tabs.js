import { tabsBoundTo } from '../lib/bindings.js';
import { getTabSessions } from './storage.js';

export const sendToTab = (tabId, message) => chrome.tabs.sendMessage(tabId, { to: 'ui', ...message }).catch(() => {});

export async function broadcast(message) {
  for (const tab of await chrome.tabs.query({})) if (tab.id !== undefined) sendToTab(tab.id, message);
}

// The server is part of the match: a session id coming from one server must never reach a tab bound to another.
export async function deliverToTabs(serverId, sessionId, message) {
  for (const tabId of tabsBoundTo(await getTabSessions(), serverId, sessionId)) sendToTab(tabId, message);
}

export const topFrame = (tabId) => chrome.webNavigation.getFrame({ tabId, frameId: 0 }).catch(() => null);

export const activeTab = async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
