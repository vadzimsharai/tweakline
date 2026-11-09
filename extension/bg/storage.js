const NAME_SUFFIX_BYTES = 3;

export const store = {
  get: (key, fallback) => chrome.storage.local.get(key).then((found) => found[key] ?? fallback),
  set: (key, value) => chrome.storage.local.set({ [key]: value }),
};

// Sockets and tabs write the same keys at once and storage has no transactions.
let writes = Promise.resolve();
export function update(key, fallback, change) {
  const result = writes.then(async () => {
    const value = await store.get(key, fallback);
    const next = change(value) ?? value;
    await store.set(key, next);
    return next;
  });
  writes = result.catch(() => {});
  return result;
}

export const getServers = () => store.get('servers', []);
export const getSessions = () => store.get('sessions', {});
export const getTabSessions = () => store.get('tabSessions', {});

export async function serverById(id) {
  const server = (await getServers()).find((s) => s.id === id);
  if (!server) throw new Error('This server is not connected');
  return server;
}

export async function deviceName() {
  const saved = await store.get('deviceName', null);
  if (saved) return saved;
  const suffix = [...crypto.getRandomValues(new Uint8Array(NAME_SUFFIX_BYTES))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const name = `browser-${suffix}`;
  await store.set('deviceName', name);
  return name;
}
