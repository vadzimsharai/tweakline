import { MAX_WAIT_SECONDS } from '../protocol.mjs';

const MS_PER_SECOND = 1000;
export const AI_FEED_TYPES = new Set(['user', 'edit', 'access', 'action', 'patch', 'chat']);

// Session events, and the long polls of AIs waiting for them.
export function createEventFeed({ store, toOwner }) {
  const waiters = new Map();

  const waitersOf = (session) => waiters.get(session.id) || [];

  function wake(session) {
    for (const wakeUp of [...waitersOf(session)]) wakeUp();
  }

  function publish(session, type, data, chat) {
    const event = store.addEvent(session, type, data, chat);
    if (AI_FEED_TYPES.has(type)) wake(session);
    return event;
  }

  function publishToBrowser(session, type, data, chat) {
    const event = publish(session, type, data, chat);
    toOwner(session, { type: 'event', session: session.id, event });
    return event;
  }

  const feed = (session, after, chat) => session.events.filter((e) => e.seq > after && AI_FEED_TYPES.has(e.type) && (!chat || e.chat === chat));

  function waitForFeed(session, after, seconds, signal, chat) {
    const wait = Math.min(seconds, MAX_WAIT_SECONDS);
    const ready = feed(session, after, chat);
    if (ready.length || !(wait > 0)) return Promise.resolve(ready);
    return new Promise((resolve) => {
      // A waiter for one chat sleeps on through events of the others.
      const wakeUp = () => { if (feed(session, after, chat).length || store.byId(session.id) !== session) finish(); };
      const finish = () => {
        clearTimeout(timer);
        const remaining = waitersOf(session).filter((entry) => entry !== wakeUp);
        if (remaining.length) waiters.set(session.id, remaining);
        else waiters.delete(session.id);
        signal?.removeEventListener('abort', finish);
        resolve(feed(session, after, chat));
      };
      wakeUp.force = finish;
      const timer = setTimeout(finish, wait * MS_PER_SECOND);
      waiters.set(session.id, [...waitersOf(session), wakeUp]);
      signal?.addEventListener('abort', finish);
    });
  }

  function releaseAll() {
    for (const list of [...waiters.values()]) for (const waiter of [...list]) waiter.force();
  }

  return { publish, publishToBrowser, wake, waitForFeed, releaseAll };
}
