import { actTarget, MAX_STATUS_TEXT_LENGTH } from '../protocol.mjs';
import { cleanLine } from './checks.mjs';
import { decodeBase64 } from './session-files.mjs';

const AI_READ_TYPES = new Set(['user', 'edit']);
const MAX_SESSION_TITLE_LENGTH = 120;
const MAX_AI_NAME_LENGTH = 40;

// What an AI can do in a session. `session` takes the session itself (HTTP finds it by its secret address);
// `byId` takes a session id and is the surface MCP tools call.
export function createAiSurface({ store, sessions, events, chats, presence, browsers, sessionFiles }) {
  function nameSession(session, { title, ai }) {
    store.update(session, { title: String(title ?? session.title).slice(0, MAX_SESSION_TITLE_LENGTH), ai: String(ai ?? session.ai).slice(0, MAX_AI_NAME_LENGTH) });
    events.publishToBrowser(session, 'title', { title: session.title, ai: session.ai });
  }

  const sendStatus = (session, state, text, chat) => browsers.toOwner(session, {
    type: 'status', session: session.id, state, text: cleanLine(String(text ?? ''), MAX_STATUS_TEXT_LENGTH), at: Date.now(), chat,
  });

  function setStatus(session, { state, text, chat }) {
    const target = chats.chatOrCurrent(session, chat);
    presence.markAlive(session);
    sendStatus(session, state, text, target);
  }

  function say(session, { text, actions, ask, files, chat }) {
    const target = chats.chatOrCurrent(session, chat);
    const event = events.publishToBrowser(session, 'ai', { text, actions, ask, files }, target);
    sendStatus(session, 'idle', '', target);
    return event;
  }

  function markRead(session, readEvents) {
    const seq = readEvents.findLast((e) => AI_READ_TYPES.has(e.type))?.seq ?? 0;
    // A waiter can outlive its session, and saving a revoked session would bring its file back.
    if (seq <= (session.seenSeq ?? 0) || store.byId(session.id) !== session) return;
    store.update(session, { seenSeq: seq, seenAt: Date.now() });
    browsers.toOwner(session, { type: 'seen', session: session.id, seq });
  }

  // Only events that reach a live client count as read; a dropped long poll delivered nothing.
  async function readFeed(session, after, seconds, signal, chat) {
    const filter = chat ? chats.chatOrCurrent(session, chat) : null;
    presence.markAlive(session);
    const ready = await events.waitForFeed(session, after, seconds, signal, filter);
    if (!signal?.aborted) markRead(session, ready);
    return { events: ready, chat: session.chat };
  }

  const act = (session, payload) => browsers.forwardDo(session, actTarget(payload));
  const putFile = (session, { name, type, base64 }) => sessionFiles.save(session, { name, type, body: decodeBase64(base64) });

  const session = { name: nameSession, say, status: setStatus, read: readFeed, act };
  const byId = {
    list: () => store.all().filter(sessions.isLive).map(sessions.describe),
    address: (id) => sessions.newAddress(sessions.liveById(id)),
    name: (id, fields) => nameSession(sessions.liveById(id), fields),
    wait: (id, after, seconds, signal, chat) => readFeed(sessions.liveById(id), after, seconds, signal, chat),
    say: (id, message) => ({ seq: say(sessions.liveById(id), message).seq }),
    status: (id, fields) => setStatus(sessions.liveById(id), fields),
    act: (id, payload) => act(sessions.liveById(id), payload),
    getFile: (id, file) => sessionFiles.read(sessions.liveById(id), file),
    putFile: (id, file) => putFile(sessions.liveById(id), file),
  };
  return { session, byId };
}
