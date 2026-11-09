import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import WebSocket from 'ws';
import { MAX_EVENT_BYTES, MAX_FREEFORM_DEPTH, MAX_SESSION_EVENT_BYTES, MAX_SESSION_FILES, MAX_TEXT_LENGTH } from '../protocol.mjs';
import { MAX_HELLO_BYTES, MAX_UNAUTHENTICATED_SOCKETS } from '../server/browser-socket.mjs';
import { openCredentials, openStore } from '../store.mjs';
import { addressOf, boot, bootWithDevice, connectExt, delay, tempDir } from './helpers.mjs';

const POISON_DEPTH = 5000;
// The test's own socket client cannot serialize much deeper than this.
const SOCKET_POISON_DEPTH = 4000;
const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const KIB = 1024;
const MIB = 1024 * KIB;

const nestedJson = (depth) => `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`;
const nested = (depth) => JSON.parse(nestedJson(depth));

function captureErrors(t) {
  const lines = [];
  const original = console.error;
  console.error = (...parts) => lines.push(parts.join(' '));
  t.after(() => { console.error = original; });
  return lines;
}

async function withSession(t, options) {
  const booted = await bootWithDevice(t, options);
  const { data: session } = await booted.ext.call('session.create', { kind: 'page', tab: 1 });
  const url = addressOf(session);
  const post = (route, body) => fetch(url + route, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { ...booted, session, url, post };
}

test('a say with a deeply nested ask answers 400 and the session still saves, polls and survives a restart', async (t) => {
  const { post, url, ext, session, dataDir, close } = await withSession(t);
  const poisoned = await post('say', `{"text":"x","ask":${nestedJson(POISON_DEPTH)}}`);
  assert.equal(poisoned.status, 400);
  assert.equal((await post('say', { text: 'x', ask: nested(MAX_FREEFORM_DEPTH + 1) })).status, 400);
  assert.equal((await post('say', { text: 'x', ask: { blob: 'y'.repeat(64 * KIB) } })).status, 400);
  assert.equal((await post('say', { text: 'fine', ask: { access: true } })).status, 200);
  await ext.call('user.say', { session: session.id, text: 'hello' });
  assert.equal((await fetch(`${url}events?after=0&wait=0`)).status, 200);
  assert.equal((await ext.call('session.history', { id: session.id })).ok, true);
  await close();
  const again = await boot(t, { dataDir });
  const feed = await (await fetch(`${url.replace(/127\.0\.0\.1:\d+/, `127.0.0.1:${again.relay.port}`)}events?after=0&wait=0`)).json();
  assert.equal(feed.events.at(-1).data.text, 'hello');
});

test('an MCP say with a deeply nested ask is refused and the session keeps working', async (t) => {
  const { base, dataDir, post, session } = await withSession(t);
  const { token } = openCredentials(dataDir).createMcpToken('ai');
  const call = (args) => fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...MCP_HEADERS, authorization: `Bearer ${token}` },
    body: `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"say","arguments":${args}}}`,
  });
  const answer = await (await call(`{"session":"${session.id}","text":"x","ask":${nestedJson(POISON_DEPTH)}}`)).json();
  assert.equal(answer.result?.isError ?? Boolean(answer.error), true, JSON.stringify(answer).slice(0, 300));
  assert.equal((await post('say', { text: 'still fine' })).status, 200);
});

test('deep or huge notes, patches and grants from the browser are refused, the session keeps saving', async (t) => {
  const { ext, session, post } = await withSession(t);
  assert.equal((await ext.call('user.say', { session: session.id, text: 'x', notes: nested(SOCKET_POISON_DEPTH) })).ok, false);
  assert.equal((await ext.call('user.say', { session: session.id, text: 'x', notes: [{ caption: 'y'.repeat(MIB) }] })).ok, false);
  assert.equal((await ext.call('user.say', { session: session.id, text: 'y'.repeat(MAX_TEXT_LENGTH + 1) })).ok, false);
  assert.equal((await ext.call('user.patch', { session: session.id, patch: nested(SOCKET_POISON_DEPTH) })).ok, false);
  assert.equal((await ext.call('user.access', { session: session.id, grant: nested(SOCKET_POISON_DEPTH) })).ok, false);
  assert.equal((await ext.call('patch.put', { patch: nested(SOCKET_POISON_DEPTH) })).ok, false);
  assert.equal((await ext.call('user.say', { session: session.id, text: 'ok', notes: [{ n: 1, caption: 'here' }] })).ok, true);
  assert.equal((await post('say', { text: 'fine' })).status, 200);
});

test('an event that cannot be saved leaves the session as it was', () => {
  const dataDir = tempDir();
  const store = openStore(dataDir);
  const { session } = store.createSession({ kind: 'page', tab: 1, owner: 'o', device: 'd' });
  store.addEvent(session, 'user', { text: 'first' });
  const before = fs.readFileSync(path.join(dataDir, 'sessions', `${session.id}.json`), 'utf8');
  assert.throws(() => store.addEvent(session, 'ai', { ask: nested(POISON_DEPTH * 4) }));
  assert.throws(() => store.addEvent(session, 'ai', { big: 1n }));
  assert.equal(session.seq, 1);
  assert.equal(session.events.length, 1);
  assert.equal(fs.readFileSync(path.join(dataDir, 'sessions', `${session.id}.json`), 'utf8'), before);
  store.addEvent(session, 'user', { text: 'second' });
  assert.deepEqual(openStore(dataDir).byId(session.id).events.map((e) => e.data.text), ['first', 'second']);
});

test('a session keeps at most its byte budget of events, dropping the oldest', () => {
  const dataDir = tempDir();
  const store = openStore(dataDir);
  const { session } = store.createSession({ kind: 'page', tab: 1, owner: 'o', device: 'd' });
  const text = 'x'.repeat(MAX_EVENT_BYTES - KIB);
  const count = Math.ceil(MAX_SESSION_EVENT_BYTES / MAX_EVENT_BYTES) * 2;
  for (let i = 0; i < count; i += 1) store.addEvent(session, 'user', { text });
  const file = path.join(dataDir, 'sessions', `${session.id}.json`);
  assert.ok(fs.statSync(file).size <= MAX_SESSION_EVENT_BYTES + KIB, `file ${fs.statSync(file).size}`);
  assert.equal(session.seq, count);
  assert.ok(session.events.length < count && session.events.length > 1, `kept ${session.events.length}`);
  assert.equal(session.events.at(-1).seq, count);
  const reloaded = openStore(dataDir);
  const kept = reloaded.byId(session.id);
  reloaded.addEvent(kept, 'user', { text });
  assert.ok(fs.statSync(file).size <= MAX_SESSION_EVENT_BYTES + KIB);
  assert.throws(() => store.addEvent(session, 'user', { text: 'x'.repeat(MAX_EVENT_BYTES) }), /too large/);
  assert.equal(session.seq, count);
});

test('a say over the text limit answers 400, one at the limit is stored', async (t) => {
  const { post, ext, session } = await withSession(t);
  assert.equal((await post('say', { text: 'x'.repeat(MAX_TEXT_LENGTH + 1) })).status, 400);
  const before = (await ext.call('session.history', { id: session.id })).data.length;
  assert.equal((await post('say', { text: 'x'.repeat(MAX_TEXT_LENGTH) })).status, 200);
  assert.equal((await ext.call('session.history', { id: session.id })).data.length, before + 1);
});

async function rawSocket(t, base) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ext`);
  t.after(() => ws.terminate());
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  const failed = new Promise((resolve) => ws.on('unexpected-response', (_req, res) => resolve(res.statusCode)));
  ws.on('error', () => {});
  const opened = new Promise((resolve) => ws.on('open', () => resolve(true)));
  return { ws, closed, failed, opened };
}

test('before hello a socket takes only small frames; after hello large ones pass', async (t) => {
  const { base, device } = await withSession(t);
  const early = await rawSocket(t, base);
  await early.opened;
  early.ws.send('x'.repeat(MAX_HELLO_BYTES + 1));
  assert.equal(await early.closed, 1009);
  const again = connectExt(t, base, device, { name: 'b1' });
  await again.ready;
  const { data: session } = await again.call('session.create', { kind: 'page', tab: 1 });
  const body = Buffer.alloc(2 * MIB, 7).toString('base64');
  const put = await again.call('file.put', { session: session.id, name: 'a.bin', type: 'application/octet-stream', base64: body });
  assert.equal(put.ok, true);
});

test('sockets that have not said hello are capped', async (t) => {
  const { base } = await boot(t);
  const sockets = [];
  for (let i = 0; i < MAX_UNAUTHENTICATED_SOCKETS; i += 1) {
    const socket = await rawSocket(t, base);
    await socket.opened;
    sockets.push(socket);
  }
  const extra = await rawSocket(t, base);
  assert.equal(await extra.failed, 503);
  sockets[0].ws.terminate();
  await sockets[0].closed;
  await delay(50);
  const later = await rawSocket(t, base);
  assert.equal(await later.opened, true);
});

test('files past the per-session count drop the oldest, revoking a session deletes its files', async (t) => {
  const { ext, session, dataDir } = await withSession(t);
  const ids = [];
  for (let i = 0; i <= MAX_SESSION_FILES; i += 1) {
    const put = await ext.call('file.put', { session: session.id, name: `${i}.txt`, type: 'text/plain', base64: Buffer.from(String(i)).toString('base64') });
    assert.equal(put.ok, true, put.error);
    ids.push(put.data.id);
  }
  assert.equal((await ext.call('file.get', { session: session.id, file: ids[0] })).ok, false);
  assert.equal((await ext.call('file.get', { session: session.id, file: ids.at(-1) })).ok, true);
  assert.equal(fs.readdirSync(path.join(dataDir, 'files')).length, MAX_SESSION_FILES * 2);
  await ext.call('session.revoke', { id: session.id });
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'files')), []);
});

test('files past the per-session byte quota drop the oldest', () => {
  const dataDir = tempDir();
  const quota = 10 * KIB;
  const store = openStore(dataDir, { maxSessionFileBytes: quota });
  const body = Buffer.alloc(4 * KIB);
  const ids = [1, 2, 3].map(() => store.putFile({ session: 's1', name: 'a', type: 'text/plain', body }).id);
  assert.equal(store.getFile(ids[0], 's1'), null);
  assert.ok(store.getFile(ids[2], 's1'));
  assert.throws(() => store.putFile({ session: 's1', name: 'a', type: 'text/plain', body: Buffer.alloc(quota + 1) }), /quota/);
  const reopened = openStore(dataDir, { maxSessionFileBytes: quota });
  reopened.putFile({ session: 's1', name: 'a', type: 'text/plain', body });
  assert.equal(reopened.getFile(ids[1], 's1'), null);
});

test('session files with a wrong shape or that cannot be read are moved aside, startup goes on', async (t) => {
  const first = await bootWithDevice(t);
  const { data } = await first.ext.call('session.create', { kind: 'page', tab: 1 });
  await first.close();
  const sessionsDir = path.join(first.dataDir, 'sessions');
  const good = JSON.parse(fs.readFileSync(path.join(sessionsDir, `${data.id}.json`), 'utf8'));
  fs.writeFileSync(path.join(sessionsDir, 'nullevent.json'), JSON.stringify({ ...good, id: 'nullevent', events: [null] }));
  fs.writeFileSync(path.join(sessionsDir, 'other.json'), JSON.stringify({ ...good, id: 'mismatch' }));
  fs.writeFileSync(path.join(sessionsDir, 'nohashes.json'), JSON.stringify({ ...good, id: 'nohashes', tokenHashes: [5] }));
  fs.mkdirSync(path.join(sessionsDir, 'folder.json'));
  fs.mkdirSync(path.join(first.dataDir, 'devices', 'folder.json'));
  fs.mkdirSync(path.join(first.dataDir, 'files', 'folder.json'));
  const errors = captureErrors(t);
  const second = await boot(t, { dataDir: first.dataDir });
  for (const name of ['nullevent.json', 'other.json', 'nohashes.json', 'folder.json']) {
    assert.ok(errors.some((line) => line.includes(path.join(sessionsDir, name))), `${name}: ${errors.join('\n')}`);
    assert.ok(!fs.existsSync(path.join(sessionsDir, name)), name);
  }
  assert.equal((await fetch(addressOf(data).replace(first.base, second.base))).status, 200);
  const ext = connectExt(t, second.base, first.device);
  await ext.ready;
  assert.equal((await ext.call('session.list')).data.length, 1);
});

test('a body over the limit gets 413 and the connection is closed while the client still streams', async (t) => {
  const { url } = await withSession(t);
  const { port } = new URL(url);
  const socket = net.connect(Number(port), '127.0.0.1');
  t.after(() => socket.destroy());
  await new Promise((resolve) => socket.once('connect', resolve));
  let answer = '';
  socket.on('data', (chunk) => { answer += chunk; });
  socket.on('error', () => {});
  const closed = new Promise((resolve) => socket.once('close', resolve));
  const pathname = new URL(url).pathname;
  socket.write(`POST ${pathname}say HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${100 * MIB}\r\n\r\n`);
  const chunk = Buffer.alloc(64 * KIB, 0x20);
  let streaming = true;
  (async () => {
    while (streaming && !socket.destroyed) {
      if (!socket.write(chunk)) await Promise.race([new Promise((resolve) => socket.once('drain', resolve)), delay(50)]);
      await delay(1);
    }
  })();
  const outcome = await Promise.race([closed.then(() => 'closed'), delay(5000).then(() => 'open')]);
  streaming = false;
  assert.equal(outcome, 'closed');
  assert.match(answer, /^HTTP\/1\.1 413/);
});

test('a tab misplaced into args is taken as the target tab', async (t) => {
  const { ext, post } = await withSession(t);
  const pending = post('do', { op: 'read', args: { tab: 12, limit: 5 } });
  const forwarded = await ext.next('do');
  assert.equal(forwarded.tab, 12);
  assert.deepEqual(forwarded.args, { limit: 5 });
  ext.send({ type: 'done', id: forwarded.id, ok: true, data: 'x' });
  assert.equal((await pending).status, 200);
  const top = post('do', { op: 'read', tab: 3, args: { tab: 12 } });
  const explicit = await ext.next('do');
  assert.equal(explicit.tab, 3);
  ext.send({ type: 'done', id: explicit.id, ok: true, data: 'x' });
  assert.equal((await top).status, 200);
});

test('instructions say where tab goes, for page and whole-browser sessions', async (t) => {
  const { ext } = await bootWithDevice(t);
  const { data: page } = await ext.call('session.create', { kind: 'page', tab: 1 });
  const { data: browser } = await ext.call('session.create', { kind: 'browser' });
  for (const session of [page, browser]) {
    const text = await (await fetch(addressOf(session))).text();
    assert.ok(text.includes('{"op":"read","tab":12}'), session.kind);
  }
  assert.match(await (await fetch(addressOf(browser))).text(), /not inside `args`/);
});
