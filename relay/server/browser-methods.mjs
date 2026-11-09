import { isBoundedJson, isPlainObject, MAX_ASK_BYTES, MAX_NOTES_BYTES, MAX_PATCH_BYTES, MAX_TEXT_LENGTH } from '../protocol.mjs';
import { CLOSE_CODES } from './browser-socket.mjs';
import { check, isOptionalTab } from './checks.mjs';
import { decodeBase64 } from './session-files.mjs';

const SESSION_KINDS = new Set(['page', 'browser']);

const checkText = (text) => check(typeof text === 'string' && text.length <= MAX_TEXT_LENGTH, `text must be a string of at most ${MAX_TEXT_LENGTH} characters`);
const checkBounded = (value, maxBytes, name) => check(value === undefined || isBoundedJson(value, maxBytes), `${name} is too deep or too large`);

// The calls a paired browser makes over its socket, each as (browser, params) => reply data.
export function createBrowserMethods({ store, credentials, sessions, events, chats, sessionFiles }) {
  function ownedSession(browser, id) {
    const session = store.byId(id);
    if (!session || session.owner !== browser.id) throw new Error('unknown session');
    return session;
  }

  return {
    'session.create': (browser, { kind, tab }) => {
      if (!SESSION_KINDS.has(kind)) throw new Error('bad kind');
      check(isOptionalTab(tab), 'tab must be a number');
      const { session, token } = store.createSession({ kind, tab, owner: browser.id, device: browser.name });
      return { ...sessions.describe(session), addresses: sessions.addressesFor(token) };
    },
    'session.address': (browser, { id }) => sessions.newAddress(ownedSession(browser, id)),
    'session.list': (browser) => store.list(browser.id).map(sessions.describe),
    'session.revoke': (browser, { id }) => {
      const session = ownedSession(browser, id);
      store.revoke(session);
      events.wake(session);
    },
    // Before the browser pairs again or drops this server, so nothing it leaves behind stays reachable.
    'device.revokeSelf': (browser) => {
      for (const session of store.list(browser.id)) {
        store.revoke(session);
        events.wake(session);
      }
      credentials.revoke(browser.id);
      setImmediate(() => browser.ws.close(CLOSE_CODES.unauthorized, 'revoked'));
    },
    'session.history': (browser, { id, after = 0 }) => ownedSession(browser, id).events.filter((e) => e.seq > after),
    'session.chats': (browser, { id }) => chats.listChats(ownedSession(browser, id)),
    'session.setTab': (browser, { id, tab }) => {
      const session = ownedSession(browser, id);
      check(isOptionalTab(tab), 'tab must be a number');
      store.update(session, { tab });
    },
    'user.say': (browser, { session: id, text = '', files, notes }) => {
      const session = ownedSession(browser, id);
      checkText(text);
      check(files === undefined || Array.isArray(files), 'files must be a list');
      checkBounded(files, MAX_ASK_BYTES, 'files');
      checkBounded(notes, MAX_NOTES_BYTES, 'notes');
      return events.publish(session, 'user', { text, files, notes });
    },
    'user.edit': (browser, { session: id, target, text }) => {
      const session = ownedSession(browser, id);
      const edited = session.events.find((e) => e.seq === target && e.type === 'user');
      if (!edited) throw new Error('unknown message');
      if (typeof text !== 'string' || !text.trim()) throw new Error('an edit needs text');
      checkText(text);
      return events.publishToBrowser(session, 'edit', { target, text }, edited.chat);
    },
    'user.newChat': (browser, { session: id }) => chats.startChat(ownedSession(browser, id)),
    'user.continueChat': (browser, { session: id, chat }) => chats.continueChat(ownedSession(browser, id), chat),
    'user.action': (browser, { session: id, action }) => {
      checkBounded(action, MAX_ASK_BYTES, 'action');
      return events.publish(ownedSession(browser, id), 'action', { action });
    },
    'user.access': (browser, { session: id, grant }) => {
      checkBounded(grant, MAX_ASK_BYTES, 'grant');
      return events.publish(ownedSession(browser, id), 'access', { grant });
    },
    'user.patch': (browser, { session: id, patch }) => {
      checkBounded(patch, MAX_PATCH_BYTES, 'patch');
      return events.publish(ownedSession(browser, id), 'patch', { patch });
    },
    'file.put': (browser, { session: id, name, type, base64 }) => sessionFiles.save(ownedSession(browser, id), { name, type, body: decodeBase64(base64) }),
    'file.get': (browser, { session: id, file }) => sessionFiles.read(ownedSession(browser, id), file),
    'patch.list': () => store.listPatches(),
    'patch.put': (_browser, { patch }) => {
      check(isPlainObject(patch), 'patch must be an object');
      checkBounded(patch, MAX_PATCH_BYTES, 'patch');
      return store.putPatch(patch);
    },
    'patch.delete': (_browser, { id }) => {
      check(typeof id === 'string', 'id must be a string');
      store.deletePatch(id);
    },
  };
}
