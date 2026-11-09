// Takes each answered server's list into the local sessions; a local one the server no longer has is gone unless it was
// saved after the lists were asked for.
export function mergeSessionLists(all, servers, answers, startedAt) {
  const reachable = new Set();
  const gone = [];
  servers.forEach((server, index) => {
    const { status, value } = answers[index];
    if (status !== 'fulfilled' || !Array.isArray(value)) return;
    reachable.add(server.id);
    const fresh = new Set(value.map((s) => s.id));
    for (const [id, local] of Object.entries(all)) {
      if (local.serverId === server.id && !fresh.has(id) && (local.savedAt || 0) < startedAt) { gone.push(id); delete all[id]; }
    }
    for (const row of value) {
      const local = all[row.id];
      if (local && local.serverId !== server.id) continue;
      // The kind of a session this browser never created is not the server's to choose: the narrow one.
      all[row.id] = { ...local, ...row, serverId: server.id, kind: local?.kind ?? 'page' };
    }
  });
  return { reachable, gone };
}

export function sessionRows(sessions, servers, reachable) {
  const names = new Map(servers.map((server) => [server.id, server.name]));
  return Object.values(sessions).filter((s) => names.has(s.serverId)).map(({ addresses, savedAt, ...row }) => ({
    ...row,
    serverName: names.get(row.serverId),
    unreachable: !reachable.has(row.serverId),
    polling: reachable.has(row.serverId) && row.polling,
  }));
}
