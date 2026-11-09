import { reconnectTarget } from '../lib/servers.js';
import { deviceName, getServers, getSessions, serverById, store } from './storage.js';
import { broadcast, deliverToTabs } from './tabs.js';

const VERSION = chrome.runtime.getManifest().version;
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const CALL_TIMEOUT_MS = 20000;
const READY_TIMEOUT_MS = 3000;
const IDLE_SOCKET_MS = 60000;
const CLOSE_NORMAL = 1000;
const CLOSE_BAD_TOKEN = 4003;
const CLOSE_REPLACED = 4004;
const NO_LINK = 'No connection to the Tweakline server';

// Relay messages passed on to the tabs of their session, with the fields each one carries.
const TAB_MESSAGE_FIELDS = {
  event: ['event'],
  presence: ['online'],
  seen: ['seq'],
  status: ['state', 'text', 'at', 'chat'],
};

const failAll = (conn, error) => {
  for (const { reject, timer } of [...conn.pending.values(), ...conn.waiters]) { clearTimeout(timer); reject(error); }
};

export function createRelay({ onReady, runOp }) {
  const connections = new Map();
  let callId = 0;

  function connectionFor(serverId) {
    if (!connections.has(serverId)) connections.set(serverId, { socket: null, ready: false, delay: RECONNECT_MIN_MS, timer: null, pending: new Map(), waiters: [], lastUsed: 0, problem: '' });
    return connections.get(serverId);
  }

  async function isNeeded(serverId) {
    if (Date.now() - connectionFor(serverId).lastUsed < IDLE_SOCKET_MS) return true;
    if (Object.values(await getSessions()).some((s) => s.serverId === serverId)) return true;
    return (await store.get('patches', [])).some((p) => p.sync && p.syncServer === serverId);
  }

  function scheduleReconnect(serverId) {
    const conn = connectionFor(serverId);
    clearTimeout(conn.timer);
    conn.timer = setTimeout(async () => {
      conn.timer = null;
      if (connections.get(serverId) !== conn || !await isNeeded(serverId)) return;
      const server = reconnectTarget({ connections, serverId, conn, servers: await getServers() });
      if (server) openSocket(server);
    }, conn.delay);
    conn.delay = Math.min(conn.delay * 2, RECONNECT_MAX_MS);
  }

  // No await between the state check and the assignment: two callers must never open two sockets, the second would replace the first with 4004.
  function openSocket(server) {
    const conn = connectionFor(server.id);
    if (conn.socket && conn.socket.readyState <= WebSocket.OPEN) return;
    clearTimeout(conn.timer);
    conn.timer = null;
    const ws = new WebSocket(`${server.baseUrl.replace(/^http/, 'ws')}/ext`);
    conn.socket = ws;
    ws.onopen = async () => {
      const name = await deviceName();
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'hello', deviceToken: server.deviceToken, name, version: VERSION }));
    };
    ws.onmessage = (event) => { if (ws === conn.socket) onMessage(server.id, ws, JSON.parse(event.data)); };
    ws.onclose = (event) => onSocketClosed(server.id, ws, event.code);
    ws.onerror = () => {};
  }

  function onSocketClosed(serverId, ws, code) {
    const conn = connectionFor(serverId);
    if (ws !== conn.socket) return;
    const wasReady = conn.ready;
    conn.socket = null;
    conn.ready = false;
    if (code === CLOSE_BAD_TOKEN) conn.problem = 'The server rejected this browser key, connect it again';
    else if (code === CLOSE_REPLACED) conn.problem = 'This key connected from somewhere else';
    failAll(conn, new Error(conn.problem || NO_LINK));
    conn.pending.clear();
    conn.waiters = [];
    if (wasReady) broadcast({ type: 'connection', serverId, online: false });
    if (code !== CLOSE_BAD_TOKEN && code !== CLOSE_REPLACED) scheduleReconnect(serverId);
  }

  function onReadyMessage(serverId, conn) {
    conn.ready = true;
    conn.problem = '';
    conn.delay = RECONNECT_MIN_MS;
    for (const { resolve, timer } of conn.waiters) { clearTimeout(timer); resolve(conn); }
    conn.waiters = [];
    broadcast({ type: 'connection', serverId, online: true });
  }

  function onReply(conn, msg) {
    const entry = conn.pending.get(msg.id);
    if (!entry) return;
    conn.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg.data); else entry.reject(new Error(msg.error));
  }

  async function onOp(serverId, ws, msg) {
    const reply = (body) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'done', id: msg.id, ...body })); };
    try {
      reply({ ok: true, data: await runOp(serverId, msg) });
    } catch (error) {
      reply({ ok: false, error: error.message });
    }
  }

  async function onMessage(serverId, ws, msg) {
    const conn = connectionFor(serverId);
    if (msg.type === 'ready') {
      onReadyMessage(serverId, conn);
      await onReady(serverId).catch(() => {});
      return;
    }
    if (msg.type === 'reply') return onReply(conn, msg);
    if (Object.hasOwn(TAB_MESSAGE_FIELDS, msg.type)) {
      const message = { type: msg.type, session: msg.session };
      for (const field of TAB_MESSAGE_FIELDS[msg.type]) message[field] = msg[field];
      return deliverToTabs(serverId, msg.session, message);
    }
    if (msg.type === 'do') return onOp(serverId, ws, msg);
  }

  function ensureReady(server) {
    const conn = connectionFor(server.id);
    conn.lastUsed = Date.now();
    if (conn.ready) return Promise.resolve(conn);
    try { openSocket(server); } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: 0 };
      waiter.timer = setTimeout(() => {
        conn.waiters = conn.waiters.filter((w) => w !== waiter);
        reject(new Error(conn.problem || NO_LINK));
      }, READY_TIMEOUT_MS);
      conn.waiters.push(waiter);
    });
  }

  async function call(serverId, method, params = {}, timeoutMs = CALL_TIMEOUT_MS) {
    const conn = await ensureReady(await serverById(serverId));
    return new Promise((resolve, reject) => {
      const id = ++callId;
      const timer = setTimeout(() => { conn.pending.delete(id); reject(new Error('The server is not responding')); }, timeoutMs);
      conn.pending.set(id, { resolve, reject, timer });
      conn.socket.send(JSON.stringify({ type: 'call', id, method, params }));
    });
  }

  async function syncSockets() {
    for (const server of await getServers()) {
      const conn = connectionFor(server.id);
      if (await isNeeded(server.id)) {
        if (!conn.timer && !conn.problem) openSocket(server);
      } else if (conn.socket) {
        conn.socket.close(CLOSE_NORMAL);
      }
    }
  }

  function dropSocket(serverId) {
    const conn = connections.get(serverId);
    if (!conn) return;
    const ws = conn.socket;
    clearTimeout(conn.timer);
    connections.delete(serverId);
    ws?.close(CLOSE_NORMAL);
    failAll(conn, new Error(NO_LINK));
  }

  const isOnline = (serverId) => Boolean(connections.get(serverId)?.ready);
  const problemOf = (serverId) => connections.get(serverId)?.problem || '';
  const readyServerIds = () => [...connections].filter(([, conn]) => conn.ready).map(([serverId]) => serverId);

  return { call, ensureReady, syncSockets, dropSocket, isOnline, problemOf, readyServerIds };
}
