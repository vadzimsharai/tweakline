import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { startRelay } from '../server.mjs';

export const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cli.mjs');
export const DOMAIN = 'wg.test';
const execFileAsync = promisify(execFile);

export const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wg-'));

export function runCli(args, env = {}) {
  return execFileAsync(process.execPath, [CLI, ...args], { env: { ...process.env, ...env }, timeout: 20000 });
}

export async function boot(t, { dataDir = tempDir(), domain = DOMAIN, ...rest } = {}) {
  const relay = await startRelay({ port: 0, dataDir, domain, version: 't', ...rest });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await relay.close();
  };
  t.after(close);
  return { relay, dataDir, close, base: `http://127.0.0.1:${relay.port}` };
}

export function postPair(base, body, headers = {}) {
  return fetch(`${base}/pair`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

export async function pairDevice(relay, base, name = 'b1') {
  const res = await postPair(base, { code: relay.createPairCode(), name });
  if (res.status !== 200) throw new Error(`pair failed: ${res.status}`);
  return res.json();
}

export function connectExt(t, base, { deviceToken, name = 'b1' }) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ext`);
  t.after(() => ws.terminate());
  const pending = new Map();
  const inbox = [];
  const waiters = [];
  let id = 0;
  const ready = new Promise((resolve) => waiters.push({ type: 'ready', resolve }));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.type === 'reply') { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    const waiter = waiters.findIndex((w) => w.type === msg.type);
    if (waiter >= 0) waiters.splice(waiter, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', deviceToken, name, version: 't' })));
  ws.on('error', () => {});
  return {
    ws, ready, inbox,
    closed: new Promise((resolve) => ws.on('close', (code) => resolve(code))),
    call: (method, params = {}) => new Promise((resolve) => {
      const callId = ++id;
      pending.set(callId, resolve);
      ws.send(JSON.stringify({ type: 'call', id: callId, method, params }));
    }),
    next: (type) => {
      const at = inbox.findIndex((m) => m.type === type);
      if (at >= 0) return Promise.resolve(inbox.splice(at, 1)[0]);
      return new Promise((resolve) => waiters.push({ type, resolve }));
    },
    send: (msg) => ws.send(JSON.stringify(msg)),
  };
}

export async function bootWithDevice(t, options = {}) {
  const booted = await boot(t, options);
  const device = await pairDevice(booted.relay, booted.base);
  const ext = connectExt(t, booted.base, device);
  await ext.ready;
  return { ...booted, device, ext };
}

export const addressOf = (session, kind = 'local') => session.addresses.find((a) => a.kind === kind).url;
export const tokenOf = (url) => url.split('/s/')[1].replace(/\/$/, '');
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function walkFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(full) : [full];
  });
}
