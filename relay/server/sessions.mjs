// A session lives only as long as the browser that owns it stays paired.
export function createSessions({ store, credentials, presence, addresses }) {
  const isLive = (session) => Boolean(session) && credentials.deviceExists(session.owner);

  function liveById(id) {
    const session = store.byId(id);
    if (!isLive(session)) throw new Error('unknown session');
    return session;
  }

  const describe = (s) => ({
    id: s.id, kind: s.kind, tab: s.tab, title: s.title, ai: s.ai, createdAt: s.createdAt, lastAt: s.lastAt, seq: s.seq,
    seenSeq: s.seenSeq ?? 0, seenAt: s.seenAt ?? 0, polling: presence.isPolling(s), device: s.device, chat: s.chat,
  });

  const addressesFor = (token) => addresses.map(({ kind, url }) => ({ kind, url: `${url}/s/${token}/` }));

  const newAddress = (session) => ({ id: session.id, addresses: addressesFor(store.addToken(session)) });

  function sweepOrphans() {
    for (const session of store.all()) {
      if (!isLive(session)) store.revoke(session);
    }
  }

  return { isLive, liveById, describe, addressesFor, newAddress, sweepOrphans };
}
