import { maskFitsPage, patternProblem } from '../lib/gate.js';
import { grantForTab } from '../lib/grants.js';
import { prepareUploads } from '../lib/media.js';
import { captureTab, beforeShotOf, forgetBeforeShot, startScreencast, stopScreencast } from './capture.js';
import { addMedia, deleteMedia, listMedia, readMedia } from './gallery.js';
import { addGrant, alwaysGrants, clearSessionGrants, removeAddedGrant, revokeAlwaysGrant, sessionGrants } from './grants.js';
import { getTabSessions, store } from './storage.js';
import { broadcast, topFrame } from './tabs.js';

const NOTES_KEY_PREFIX = 'notes:';
const SHORTCUTS_PAGE = 'chrome://extensions/shortcuts';

// Methods the page UI calls through runtime messages: each gets the request params and the tab that sent it.
export function createUiMethods({ relay, sessions, servers, patching, ops }) {
  const { sessionCall } = sessions;

  async function pageState(tab) {
    const bound = await sessions.adoptBinding(tab);
    const sessionId = bound?.sessionId ?? null;
    return {
      hidden: await store.get('hidden', false), online: Boolean(bound && relay.isOnline(bound.serverId)),
      sessionId, serverId: bound?.serverId ?? null, url: tab.url, tabId: tab.id, grants: await sessionGrants(sessionId),
    };
  }

  async function sendChat({ session, text, media = [], notes }) {
    const uploads = await prepareUploads(media, readMedia);
    const files = [];
    for (const { name, type, base64, kind, ownName } of uploads) {
      const { id } = await sessionCall(session, 'file.put', { session, name, type, base64 });
      files.push({ id, kind, type, ...(ownName ? { name: ownName } : {}) });
    }
    return sessionCall(session, 'user.say', { session, text, files, notes });
  }

  // The person is told "not granted" when the server does not hear about it, so the grant must not stay behind.
  async function setGrant({ session, grant: asked }, tab) {
    const grant = grantForTab(asked, tab);
    const added = await addGrant(session, grant);
    try {
      await sessionCall(session, 'user.access', { session, grant: { kind: grant.kind, until: grant.until } });
    } catch (error) {
      if (added) await removeAddedGrant(session, grant);
      throw error;
    }
  }

  // The person's Undo takes back only what the session of this tab did, on the page that is open now.
  async function undoHere(tab) {
    const bound = (await getTabSessions())[tab.id];
    if (!bound) return { undone: false };
    const frame = await topFrame(tab.id);
    if (!frame?.documentId) throw new Error('the page is not ready, try again');
    return ops.undo({ tabId: tab.id, documentId: frame.documentId, session: bound.sessionId });
  }

  async function listShortcuts() {
    const commands = await chrome.commands.getAll();
    return commands.filter(({ name }) => !name.startsWith('_')).map(({ name, description, shortcut }) => ({ name, description, shortcut }));
  }

  return {
    'notes.get': async ({ key }) => (key.startsWith(NOTES_KEY_PREFIX) ? store.get(key, []) : []),
    'notes.set': async ({ key, notes }) => { if (key.startsWith(NOTES_KEY_PREFIX)) await store.set(key, notes); },
    state: (_params, tab) => pageState(tab),
    'ui.setHidden': async ({ hidden }) => { await store.set('hidden', hidden); broadcast({ type: 'hidden', hidden }); },
    'server.list': () => servers.list(),
    'server.probeLocal': () => servers.firstFound(''),
    'server.check': ({ input }) => servers.firstFound(input),
    'server.pair': servers.pair,
    'server.remove': ({ id }) => servers.remove(id),
    'session.list': () => sessions.listSessions(),
    'session.create': sessions.createSession,
    'session.join': sessions.joinSession,
    'session.leave': (_params, tab) => sessions.bindTab(tab.id, null),
    'session.history': ({ id, after }) => sessionCall(id, 'session.history', { id, after }),
    'session.addresses': sessions.sessionAddresses,
    'session.revoke': sessions.revokeSession,
    'chat.send': sendChat,
    'chat.edit': ({ session, target, text }) => sessionCall(session, 'user.edit', { session, target, text }),
    'chat.action': ({ session, action }) => sessionCall(session, 'user.action', { session, action }),
    'chat.new': ({ session }) => sessionCall(session, 'user.newChat', { session }),
    'chat.continue': ({ session, chat }) => sessionCall(session, 'user.continueChat', { session, chat }),
    'chat.list': ({ session }) => sessionCall(session, 'session.chats', { id: session }),
    'grant.set': setGrant,
    'grant.list': ({ session }) => sessionGrants(session),
    'grant.always': alwaysGrants,
    'grant.revokeAlways': ({ grant }) => revokeAlwaysGrant(grant),
    'grant.clear': ({ session }) => clearSessionGrants(session),
    'file.fetch': ({ session, file }) => sessionCall(session, 'file.get', { session, file }),
    'shot.capture': (_params, tab) => captureTab(tab.id),
    'video.start': (_params, tab) => startScreencast(tab.id),
    'video.stop': (_params, tab) => stopScreencast(tab.id),
    'media.add': addMedia,
    'media.list': listMedia,
    'media.get': ({ id }) => readMedia(id),
    'media.delete': ({ ids }) => deleteMedia(ids),
    'edit.undo': (_params, tab) => undoHere(tab),
    'edit.before': (_params, tab) => beforeShotOf(tab.id),
    'patch.list': (_params, tab) => patching.listForTab(tab),
    'patch.scopeFits': ({ mask }, tab) => maskFitsPage(mask, tab.url || ''),
    'patch.patternProblem': ({ pattern }) => patternProblem(pattern),
    'patch.save': (params, tab) => {
      forgetBeforeShot(tab.id);
      return patching.save(params, tab);
    },
    'patch.setPrefs': patching.setPrefs,
    'patch.setSync': patching.setSync,
    'patch.delete': ({ id }) => patching.remove(id),
    'patch.send': ({ session, patch }) => sessionCall(session, 'user.patch', { session, patch }),
    'keys.list': listShortcuts,
    'keys.open': () => chrome.tabs.create({ url: SHORTCUTS_PAGE }),
  };
}
