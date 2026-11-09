import { candidates, isOpenTransport, parsePairLink, probe } from '../lib/servers.js';
import { deviceName, getServers, update } from './storage.js';

const PAIR_TIMEOUT_MS = 8000;
const HTTP_UNAUTHORIZED = 401;
const HTTP_TOO_MANY = 429;

async function exchangeCode(baseUrl, code) {
  let response;
  try {
    response = await fetch(`${baseUrl}/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: await deviceName() }),
      signal: AbortSignal.timeout(PAIR_TIMEOUT_MS), credentials: 'omit', cache: 'no-store', redirect: 'error',
    });
  } catch {
    throw new Error(`Server ${baseUrl} is not responding`);
  }
  if (response.status === HTTP_UNAUTHORIZED) throw new Error('Code not accepted: wrong, already used or expired. Get a new link with node tweakline-server.js pair');
  if (response.status === HTTP_TOO_MANY) throw new Error('Too many attempts, wait a minute');
  const answer = response.ok ? await response.json().catch(() => null) : null;
  if (!answer?.deviceToken || !answer.deviceId) throw new Error('The server did not answer like Tweakline');
  return answer;
}

const revokeCommand = (deviceId) => `node tweakline-server.js token revoke ${deviceId}`;

export function createServers({ relay, sessions, patching }) {
  // The server ends this browser's key and every session made with it; an older server without the method gets each session revoked.
  async function revokeThisDevice(serverId, sessionIds) {
    try {
      await relay.call(serverId, 'device.revokeSelf', {});
    } catch {
      await Promise.allSettled(sessionIds.map((id) => relay.call(serverId, 'session.revoke', { id })));
    }
  }

  const publicServer = (server) => ({
    id: server.id, name: server.name, baseUrl: server.baseUrl, addresses: server.addresses,
    online: relay.isOnline(server.id), open: isOpenTransport(server.baseUrl), problem: relay.problemOf(server.id),
  });

  async function list() {
    const servers = await getServers();
    await Promise.allSettled(servers.map(relay.ensureReady));
    return servers.map(publicServer);
  }

  async function firstFound(input) {
    const urls = candidates(input);
    const infos = await Promise.all(urls.map(probe));
    const index = infos.findIndex(Boolean);
    if (index < 0) return null;
    const url = urls[index];
    const paired = (await getServers()).find((server) => server.baseUrl === url);
    return { url, info: infos[index], open: isOpenTransport(url), paired: Boolean(paired), id: paired?.id ?? null };
  }

  async function pair({ link, allowOpen }) {
    const parsed = parsePairLink(link);
    if (!parsed) throw new Error('This is not a pair link. It looks like this: https://address/pair#code');
    const { baseUrl, code } = parsed;
    if (isOpenTransport(baseUrl) && !allowOpen) return { needsConfirm: true, baseUrl };
    const answer = await exchangeCode(baseUrl, code);
    const previous = (await getServers()).find((server) => server.baseUrl === baseUrl);
    // Over the old socket, before the new key replaces it: otherwise the old key and its sessions stay live on the server.
    if (previous && previous.deviceId !== answer.deviceId && relay.isOnline(previous.id)) await revokeThisDevice(previous.id, await sessions.sessionIdsOf(previous.id));
    const saved = {
      id: previous?.id ?? crypto.randomUUID(), baseUrl, name: new URL(baseUrl).host,
      deviceToken: answer.deviceToken, deviceId: answer.deviceId, addresses: answer.addresses || [],
    };
    await update('servers', [], (servers) => [...servers.filter((server) => server.id !== saved.id), saved]);
    if (previous) {
      relay.dropSocket(saved.id);
      if (previous.deviceId !== saved.deviceId) await sessions.forgetSessions(await sessions.sessionIdsOf(saved.id));
    }
    // A proxy without WebSocket upgrades lets the pairing through but never the socket; that is not a working server.
    try {
      await relay.ensureReady(saved);
    } catch {
      throw new Error(`Paired with ${saved.name}, but its live connection did not open. If the server is behind a proxy, the proxy must pass WebSocket upgrades on /ext. The server stays in the list and connects once that works.`);
    }
    return publicServer(saved);
  }

  // Offline the server cannot hear it: the person is told how to end this browser's key there.
  async function remove(id) {
    const ids = await sessions.sessionIdsOf(id);
    const server = (await getServers()).find((s) => s.id === id);
    const online = relay.isOnline(id);
    if (online) await revokeThisDevice(id, ids);
    await patching.forgetServer(id);
    await update('servers', [], (servers) => servers.filter((s) => s.id !== id));
    relay.dropSocket(id);
    await sessions.forgetSessions(ids);
    return online || !server?.deviceId ? { kept: false } : { kept: true, revokeCommand: revokeCommand(server.deviceId) };
  }

  return { list, firstFound, pair, remove };
}
