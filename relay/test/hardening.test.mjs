import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import WebSocket from 'ws';
import { clientAddress, trustedPeer } from '../server.mjs';
import { openCredentials } from '../store.mjs';
import { addressOf, boot, bootWithDevice, delay } from './helpers.mjs';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const NON_OBJECT_BODIES = ['null', '[]', '"text"', '42'];

async function rawSocket(t, base) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ext`);
  t.after(() => ws.terminate());
  const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  ws.on('error', () => {});
  await new Promise((resolve) => ws.on('open', resolve));
  return { ws, closed };
}

async function withSession(t) {
  const booted = await bootWithDevice(t);
  const { data: session } = await booted.ext.call('session.create', { kind: 'page', tab: 1 });
  const url = addressOf(session);
  const post = (route, body) => fetch(url + route, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { ...booted, session, url, post };
}

for (const body of [...NON_OBJECT_BODIES, '{"type":null}', '{}']) {
  test(`a pre-hello message ${body} closes the socket and the server lives on`, async (t) => {
    const { base } = await boot(t);
    const { ws, closed } = await rawSocket(t, base);
    ws.send(body);
    assert.ok([4002, 4005].includes(await closed));
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  });
}

test('a non-object message after hello closes the socket with 4002', async (t) => {
  const { base, ext } = await bootWithDevice(t);
  ext.ws.send('null');
  assert.equal(await ext.closed, 4002);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test('a done with a hostile payload neither crashes nor answers a do', async (t) => {
  const { base, ext } = await bootWithDevice(t);
  ext.send({ type: 'done', id: { toString: null }, ok: true });
  assert.equal((await ext.call('constructor')).ok, false);
  assert.equal((await ext.call('__proto__')).ok, false);
  assert.equal((await ext.call('session.list', 'x')).ok, false);
  await delay(50);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await ext.call('session.list')).ok, true);
});

for (const route of ['session', 'say', 'status', 'do']) {
  test(`POST ${route} with a non-object body answers 400`, async (t) => {
    const { post } = await withSession(t);
    for (const body of NON_OBJECT_BODIES) assert.equal((await post(route, body)).status, 400, body);
  });
}

test('POST /pair with a non-object body answers 400', async (t) => {
  const { base } = await boot(t);
  for (const body of NON_OBJECT_BODIES) assert.equal((await fetch(`${base}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 400, body);
});

test('say validates text, actions, files and ask', async (t) => {
  const { post } = await withSession(t);
  const bad = [
    { text: 5 },
    { text: 'x', actions: 'keep' },
    { text: 'x', actions: [{ id: 'a' }] },
    { text: 'x', actions: [{ id: 1, label: 'A' }] },
    { text: 'x', actions: [{ id: 'a', label: 'A', primary: 'yes' }] },
    { text: 'x', files: 'f1' },
    { text: 'x', files: [1] },
    { text: 'x', ask: 'access' },
    { text: 'x', ask: [true] },
    { text: 'x', ask: null },
    { text: 'x', chat: 7 },
  ];
  for (const body of bad) assert.equal((await post('say', body)).status, 400, JSON.stringify(body));
  const good = await post('say', { text: 'ok', actions: [{ id: 'a', label: 'A', primary: true }, { id: 'b', label: 'B' }], files: ['f1'], ask: { access: true } });
  assert.equal(good.status, 200);
});

test('session, status and do validate their fields', async (t) => {
  const { post } = await withSession(t);
  assert.equal((await post('session', { title: { a: 1 } })).status, 400);
  assert.equal((await post('session', { ai: 5 })).status, 400);
  assert.equal((await post('status', { state: 'thinking', text: 5 })).status, 400);
  assert.equal((await post('do', { op: 5 })).status, 400);
  assert.equal((await post('do', { op: 'read', args: [] })).status, 400);
  assert.equal((await post('do', { op: 'read', args: 'x' })).status, 400);
  assert.equal((await post('do', { op: 'read', tab: 'x' })).status, 400);
});

test('MCP say and act refuse malformed actions, ask and args', async (t) => {
  const { base, dataDir, session } = await withSession(t);
  const { token } = openCredentials(dataDir).createMcpToken('ai');
  const client = new Client({ name: 'test', version: '1' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  const call = (name, args) => client.callTool({ name, arguments: { session: session.id, ...args } });
  for (const args of [{ text: 'x', actions: [{ id: 'a' }] }, { text: 'x', actions: ['a'] }, { text: 'x', ask: 'access' }, { text: 'x', ask: [1] }]) {
    assert.equal((await call('say', args)).isError, true, JSON.stringify(args));
  }
  assert.equal((await call('act', { op: 'read', args: [] })).isError, true);
  assert.equal((await call('say', { text: 'x', actions: [{ id: 'a', label: 'A' }], ask: { access: true } })).isError, undefined);
});

test('a non-string text in user.say or user.edit is refused and chats keep working', async (t) => {
  const { ext, session } = await withSession(t);
  for (const text of [5, { a: 1 }, ['x'], null]) {
    assert.equal((await ext.call('user.say', { session: session.id, text })).ok, false, JSON.stringify(text));
  }
  assert.equal((await ext.call('user.say', { session: session.id, text: 'hi', files: 'f' })).ok, false);
  const said = await ext.call('user.say', { session: session.id, text: 'hi' });
  assert.equal(said.ok, true);
  assert.equal((await ext.call('user.edit', { session: session.id, target: said.data.seq, text: 5 })).ok, false);
  const chats = await ext.call('session.chats', { id: session.id });
  assert.equal(chats.ok, true);
  assert.equal(chats.data[0].title, 'hi');
});

test('chat ids are canonical: c01 is not c1', async (t) => {
  const { post, ext, session } = await withSession(t);
  assert.equal((await post('say', { text: 'x', chat: 'c01' })).status, 400);
  assert.equal((await post('say', { text: 'x', chat: 'c1' })).status, 200);
  assert.equal((await ext.call('user.continueChat', { session: session.id, chat: 'c01' })).ok, false);
});

test('patch.put needs an object', async (t) => {
  const { ext } = await bootWithDevice(t);
  for (const patch of ['abc', null, [1]]) assert.equal((await ext.call('patch.put', { patch })).ok, false, JSON.stringify(patch));
  assert.equal((await ext.call('patch.list')).data.length, 0);
});

test('files are served with nosniff, a sandbox CSP, and as attachments unless image or video', async (t) => {
  const { ext, session, url } = await withSession(t);
  const put = (type) => ext.call('file.put', { session: session.id, name: 'f', type, base64: Buffer.from('x').toString('base64') }).then((r) => r.data.id);
  const cases = [['image/png', false], ['video/webm', false], ['text/html', true], ['image/svg+xml', false], ['application/pdf', true]];
  for (const [type, attachment] of cases) {
    const res = await fetch(`${url}files/${await put(type)}`);
    assert.equal(res.headers.get('content-type'), type);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('content-security-policy'), 'sandbox');
    assert.equal(res.headers.get('content-disposition'), attachment ? 'attachment' : null, type);
  }
});

test('content types with CR/LF or parameters are refused everywhere', async (t) => {
  const { ext, session, url } = await withSession(t);
  for (const type of ['text/html\r\nx-evil: 1', 'text/html\n', 'text/html; charset=utf-8', 'html', 'a/b/c', '']) {
    const reply = await ext.call('file.put', { session: session.id, name: 'f', type, base64: 'eA==' });
    assert.equal(reply.ok, false, JSON.stringify(type));
  }
  const res = await fetch(`${url}files`, { method: 'POST', headers: { 'content-type': 'text/html; charset=utf-8' }, body: 'x' });
  assert.equal(res.status, 400);
  const plain = await fetch(`${url}files`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: 'x' });
  assert.equal(plain.status, 200);
});

test('file.put over the socket has the same size limit as HTTP and MCP', async (t) => {
  const { ext, session } = await withSession(t);
  const base64 = Buffer.alloc(MAX_FILE_BYTES + 1).toString('base64');
  const reply = await ext.call('file.put', { session: session.id, name: 'big', type: 'application/octet-stream', base64 });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /too large/);
  const fits = await ext.call('file.put', { session: session.id, name: 'ok', type: 'application/octet-stream', base64: Buffer.alloc(16).toString('base64') });
  assert.equal(fits.ok, true);
});

const forwardedRequest = (peer, forwarded) => ({ socket: { remoteAddress: peer }, headers: forwarded ? { 'x-forwarded-for': forwarded } : {} });

test('without --trust-proxy, X-Forwarded-For counts only behind --domain and from a loopback peer', () => {
  const behindDomain = trustedPeer({ domain: 'gate.example', trustProxy: false });
  const direct = trustedPeer({ domain: undefined, trustProxy: false });
  assert.equal(clientAddress(forwardedRequest('127.0.0.1', '198.51.100.1'), behindDomain), '198.51.100.1');
  assert.equal(clientAddress(forwardedRequest('::1', '203.0.113.9, 198.51.100.1'), behindDomain), '198.51.100.1');
  assert.equal(clientAddress(forwardedRequest('::ffff:127.0.0.1', '198.51.100.1'), behindDomain), '198.51.100.1');
  assert.equal(clientAddress(forwardedRequest('192.0.2.7', '198.51.100.1'), behindDomain), '192.0.2.7');
  assert.equal(clientAddress(forwardedRequest('::ffff:192.0.2.7', '198.51.100.1'), behindDomain), '::ffff:192.0.2.7');
  assert.equal(clientAddress(forwardedRequest('172.18.0.1', '198.51.100.1'), behindDomain), '172.18.0.1');
  assert.equal(clientAddress(forwardedRequest('127.0.0.1', '198.51.100.1'), direct), '127.0.0.1');
  assert.equal(clientAddress(forwardedRequest('127.0.0.1'), behindDomain), '127.0.0.1');
});

test('with --trust-proxy, X-Forwarded-For counts from loopback and private peers only', () => {
  const trusting = trustedPeer({ domain: undefined, trustProxy: true });
  for (const peer of ['127.0.0.1', '::1', '10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.1.1', '::ffff:172.18.0.1', 'fc00::1', 'fd12:3456::1']) {
    assert.equal(clientAddress(forwardedRequest(peer, '203.0.113.9, 198.51.100.1'), trusting), '198.51.100.1', peer);
  }
  for (const peer of ['192.0.2.7', '172.15.0.1', '172.32.0.1', '11.0.0.1', '192.169.0.1', '::ffff:8.8.8.8', '2001:db8::1', 'fe80::1']) {
    assert.equal(clientAddress(forwardedRequest(peer, '198.51.100.1'), trusting), peer, peer);
  }
});

test('the rate limit follows X-Forwarded-For with trustProxy and no domain', async (t) => {
  const { base } = await boot(t, { domain: null, trustProxy: true });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await fetch(`${base}/pair`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.1' }, body: '{"code":"wrong"}' });
  }
  const post = (forwarded) => fetch(`${base}/pair`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': forwarded }, body: '{"code":"wrong"}' }).then((r) => r.status);
  assert.equal(await post('198.51.100.1'), 429);
  assert.equal(await post('198.51.100.2'), 401);
});

test('the pair page points to Servers and Add server, not a missing button', async (t) => {
  const { base } = await boot(t);
  const text = await (await fetch(`${base}/pair`)).text();
  assert.match(text, /Servers/);
  assert.match(text, /Add server/);
  assert.doesNotMatch(text, /New session/);
});

test('instructions show do with args, how js runs, and proposePatch with focus and undo', async (t) => {
  const { url } = await withSession(t);
  const text = await (await fetch(url)).text();
  assert.ok(text.includes(`"op":"css","args":{"css":`), 'do shape');
  assert.doesNotMatch(text, /"full"/);
  assert.match(text, /no top-level `return`/);
  const patchArgs = text.match(/\| proposePatch \| `(\{[^`]*\})`/)[1];
  assert.match(patchArgs, /"focus":/);
  assert.match(patchArgs, /"undo":/);
});
