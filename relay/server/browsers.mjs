import crypto from 'node:crypto';

const DO_TIMEOUT_MS = 150000;

// Connected browsers by device id, and the actions AIs are waiting on them for.
export function createBrowsers() {
  const connected = new Map();
  const pendingDo = new Map();

  const send = (browser, message) => browser.ws.send(JSON.stringify(message));

  function connect(browser) {
    connected.set(browser.id, browser);
  }

  function disconnect(browser) {
    if (connected.get(browser.id) === browser) connected.delete(browser.id);
    failPending(browser, 'browser offline');
  }

  function toOwner(session, message) {
    const browser = connected.get(session.owner);
    if (browser) send(browser, message);
  }

  function forwardDo(session, { op, args, tab }) {
    const browser = connected.get(session.owner);
    if (!browser) return Promise.resolve({ ok: false, error: 'browser offline' });
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pendingDo.delete(id);
        resolve({ ok: false, error: `timeout after ${DO_TIMEOUT_MS} ms` });
      }, DO_TIMEOUT_MS);
      pendingDo.set(id, { resolve, timer, browser });
      send(browser, { type: 'do', id, session: session.id, op, args: args ?? {}, tab: tab ?? null });
    });
  }

  function completeDo(browser, { id, ok, data, error }) {
    const entry = pendingDo.get(id);
    if (!entry || entry.browser !== browser) return;
    clearTimeout(entry.timer);
    pendingDo.delete(id);
    entry.resolve(ok ? { ok: true, data } : { ok: false, error });
  }

  // A null browser fails them all, as on shutdown.
  function failPending(browser, error) {
    for (const [id, entry] of pendingDo) {
      if (browser && entry.browser !== browser) continue;
      clearTimeout(entry.timer);
      pendingDo.delete(id);
      entry.resolve({ ok: false, error });
    }
  }

  return {
    get: (id) => connected.get(id),
    all: () => [...connected.values()],
    send, connect, disconnect, toOwner, forwardDo, completeDo, failPending,
  };
}
