// An AI counts as online while it keeps long polling; the browser hears when that changes.
export function createPresence({ pollFreshMs, toOwner }) {
  const offlineTimers = new Map();

  const isPolling = (session) => Boolean(session.pollingAt) && Date.now() - session.pollingAt < pollFreshMs;
  const announce = (session, online) => toOwner(session, { type: 'presence', session: session.id, online });

  function markOffline(session) {
    if (!session.pollingAt || isPolling(session)) return;
    clearTimeout(offlineTimers.get(session.id));
    offlineTimers.delete(session.id);
    session.pollingAt = null;
    announce(session, false);
  }

  function scheduleOffline(session) {
    clearTimeout(offlineTimers.get(session.id));
    const left = session.pollingAt + pollFreshMs - Date.now();
    offlineTimers.set(session.id, setTimeout(() => (isPolling(session) ? scheduleOffline(session) : markOffline(session)), Math.max(0, left)));
  }

  // The periodic check alone would report offline up to a whole check interval after the session list already does.
  function markAlive(session) {
    const wasOffline = !isPolling(session);
    session.pollingAt = Date.now();
    scheduleOffline(session);
    if (wasOffline) announce(session, true);
  }

  function stop() {
    for (const timer of offlineTimers.values()) clearTimeout(timer);
  }

  return { isPolling, markAlive, markOffline, stop };
}
