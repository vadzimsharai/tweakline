const CHAT_MESSAGE_TYPES = new Set(['user', 'ai']);
const MAX_CHAT_TITLE_LENGTH = 80;

export class UnknownChat extends Error {
  message = 'unknown chat';
}

function chatTitle(events) {
  const text = events.find((e) => e.type === 'user' && typeof e.data?.text === 'string' && e.data.text.trim())?.data.text ?? '';
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_CHAT_TITLE_LENGTH);
}

const chatHasMessages = (session, chat) => session.events.some((e) => e.chat === chat && CHAT_MESSAGE_TYPES.has(e.type));

export function createChats({ store, events }) {
  function chatOrCurrent(session, chat) {
    if (chat === undefined || chat === null || chat === '') return session.chat;
    if (!store.hasChat(session, chat)) throw new UnknownChat();
    return chat;
  }

  function listChats(session) {
    const byChat = new Map();
    for (const event of session.events) {
      if (!CHAT_MESSAGE_TYPES.has(event.type)) continue;
      byChat.set(event.chat, [...(byChat.get(event.chat) || []), event]);
    }
    return [...byChat].map(([id, chatEvents]) => ({
      id, title: chatTitle(chatEvents), startedAt: chatEvents[0].at, lastAt: chatEvents.at(-1).at, count: chatEvents.length, current: id === session.chat,
    })).sort((a, b) => b.lastAt - a.lastAt);
  }

  // An empty current chat is reused rather than leaving an empty one behind.
  function startChat(session) {
    if (!chatHasMessages(session, session.chat)) return { chat: session.chat };
    const chat = store.newChat(session);
    return events.publishToBrowser(session, 'chat', { chat }, chat);
  }

  function continueChat(session, chat) {
    if (!store.hasChat(session, chat)) throw new UnknownChat();
    store.update(session, { chat });
    const title = chatTitle(session.events.filter((e) => e.chat === chat));
    return events.publishToBrowser(session, 'chat', { chat, title, continued: true }, chat);
  }

  return { chatOrCurrent, listChats, startChat, continueChat };
}
