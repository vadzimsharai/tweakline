import { findOrphanBinding, latestBoundTab, ownBindingFor, sameAddress, withRestartKeys } from '../lib/bindings.js';
import { originOf } from '../lib/gate.js';
import { mergeSessionLists, sessionRows } from '../lib/sessions.js';
import { dropSessionGrants, dropTabGrants } from './grants.js';
import { getServers, getSessions, getTabSessions, serverById, update } from './storage.js';
import { activeTab } from './tabs.js';

// Lists feed the panels, so a server that accepts the socket but stays silent must not hold them open.
const LIST_TIMEOUT_MS = 4000;

export function createSessions({ call }) {
  const bindTab = (tabId, binding) => update('tabSessions', {}, (map) => {
    if (binding) map[tabId] = { ...binding, boundAt: Date.now() }; else delete map[tabId];
  });

  async function unbindClosedTab(tabId) {
    if ((await getTabSessions())[tabId]) await bindTab(tabId, null);
  }

  // Android restarts the browser often, an update too, and tabs come back with new ids. A binding left by a tab that is
  // gone moves to the open tab showing the same page, so the chat keeps its session.
  async function adoptBinding(tab) {
    const map = await getTabSessions();
    const own = map[tab.id] && ownBindingFor(map[tab.id], tab.url);
    // The address is kept current, so after an update the tab is still recognised by it.
    if (own && own.url !== tab.url) await update('tabSessions', {}, (all) => { if (all[tab.id]) all[tab.id].url = tab.url; });
    if (map[tab.id]) return own;
    const open = new Set((await chrome.tabs.query({})).map((t) => String(t.id)));
    const found = findOrphanBinding(map, open, tab.url);
    if (!found) return null;
    const [oldTab, bound] = found;
    await update('tabSessions', {}, (all) => { delete all[oldTab]; all[tab.id] = { ...bound, url: tab.url }; });
    const local = (await getSessions())[bound.sessionId];
    if (local?.kind === 'page') call(bound.serverId, 'session.setTab', { id: bound.sessionId, tab: tab.id }).catch(() => {});
    return bound;
  }

  // After a restart tab ids start over, so a grant or binding for an old id would land on whatever tab gets it next.
  async function forgetTabIdsOncePerBrowserRun() {
    // Session storage empties when the browser quits: a missing mark means a fresh run, even when onStartup does not fire.
    if ((await chrome.storage.session.get('browserRun')).browserRun) return;
    await chrome.storage.session.set({ browserRun: true });
    // An extension update empties it too, but keeps the tab ids: a tab still showing what it showed keeps its grants and session.
    const urls = new Map((await chrome.tabs.query({})).map((tab) => [tab.id, tab.url || '']));
    await dropTabGrants((g) => !urls.has(g.tabId) || originOf(urls.get(g.tabId)) !== g.origin);
    await update('tabSessions', {}, (map) => withRestartKeys(map, Date.now(), (key, bound) => sameAddress(urls.get(Number(key)), bound.url)));
    await chrome.storage.session.set({ browserRunCleaned: true });
  }

  async function sessionRoute(id) {
    const local = (await getSessions())[id];
    if (!local) throw new Error('Session not found');
    return local.serverId;
  }
  const sessionCall = async (id, method, params) => call(await sessionRoute(id), method, params);

  async function forgetSessions(ids) {
    if (!ids.length) return;
    const gone = new Set(ids);
    await update('sessions', {}, (all) => { for (const id of gone) delete all[id]; });
    await dropSessionGrants(gone);
    await update('tabSessions', {}, (map) => {
      for (const [tabId, bound] of Object.entries(map)) if (gone.has(bound?.sessionId)) delete map[tabId];
    });
  }

  const sessionIdsOf = async (serverId) => Object.entries(await getSessions()).filter(([, s]) => s.serverId === serverId).map(([id]) => id);

  async function listSessions() {
    const servers = await getServers();
    const startedAt = Date.now();
    const answers = await Promise.allSettled(servers.map((server) => call(server.id, 'session.list', {}, LIST_TIMEOUT_MS)));
    let merged;
    await update('sessions', {}, (all) => { merged = mergeSessionLists(all, servers, answers, startedAt); });
    await forgetSessions(merged.gone);
    return sessionRows(await getSessions(), servers, merged.reachable);
  }

  async function createSession({ kind, serverId }, tab) {
    const created = await call(serverId, 'session.create', { kind, tab: tab.id });
    const server = await serverById(serverId);
    await update('sessions', {}, (all) => {
      if (all[created.id]) throw new Error('The server returned a session that is not ours');
      all[created.id] = { ...created, kind, serverId, savedAt: Date.now() };
    });
    await bindTab(tab.id, { serverId, sessionId: created.id, url: tab.url });
    return { ...created, kind, serverId, serverName: server.name };
  }

  // A page session acts on one tab: joining it from another one moves it there.
  async function joinSession({ id }, tab) {
    const serverId = await sessionRoute(id);
    if ((await getSessions())[id]?.kind === 'page') {
      await update('tabSessions', {}, (map) => {
        for (const [tabId, bound] of Object.entries(map)) if (bound?.serverId === serverId && bound.sessionId === id) delete map[tabId];
      });
    }
    await bindTab(tab.id, { serverId, sessionId: id, url: tab.url });
    await call(serverId, 'session.setTab', { id, tab: tab.id }).catch(() => {});
    return call(serverId, 'session.history', { id, after: 0 });
  }

  async function sessionAddresses({ id }) {
    const local = (await getSessions())[id];
    if (!local) throw new Error('Session not found');
    if (local.addresses?.length) return local.addresses;
    const addresses = (await call(local.serverId, 'session.address', { id })).addresses;
    await update('sessions', {}, (all) => { if (all[id]) all[id].addresses = addresses; });
    return addresses;
  }

  async function revokeSession({ id }) {
    await sessionCall(id, 'session.revoke', { id });
    await forgetSessions([id]);
  }

  async function resolveTab(session, requested) {
    if (requested !== null && requested !== undefined) {
      if (session.kind !== 'browser') throw new Error('this session is limited to one tab');
      return chrome.tabs.get(requested);
    }
    const bound = latestBoundTab(await getTabSessions(), session.serverId, session.id);
    if (bound !== null) return chrome.tabs.get(bound);
    if (session.kind === 'browser') {
      const active = await activeTab();
      if (active) return active;
    }
    throw new Error('the session has no open tab');
  }

  return {
    bindTab, unbindClosedTab, adoptBinding, forgetTabIdsOncePerBrowserRun, sessionCall, forgetSessions, sessionIdsOf,
    listSessions, createSession, joinSession, sessionAddresses, revokeSession, resolveTab,
  };
}
