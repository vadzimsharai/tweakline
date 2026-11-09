import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { candidates, parsePairLink, isOpenTransport, probe, reconnectTarget } from '../lib/servers.js';

test('candidates: nothing means the local default port', () => {
  assert.deepEqual(candidates(''), ['http://127.0.0.1:8787']);
  assert.deepEqual(candidates('   '), ['http://127.0.0.1:8787']);
});

test('candidates: a domain tries https, the default port, then http', () => {
  assert.deepEqual(candidates('gate.example'), ['https://gate.example', 'https://gate.example:8787', 'http://gate.example']);
  assert.deepEqual(candidates(' gate.example/ '), ['https://gate.example', 'https://gate.example:8787', 'http://gate.example']);
});

test('candidates: an explicit port is kept', () => {
  assert.deepEqual(candidates('gate.example:9000'), ['https://gate.example:9000', 'http://gate.example:9000']);
});

test('candidates: a loopback host goes straight to plain http', () => {
  assert.deepEqual(candidates('localhost'), ['http://localhost:8787']);
  assert.deepEqual(candidates('127.0.0.1:9000'), ['http://127.0.0.1:9000']);
});

test('candidates: a full url is used as is', () => {
  assert.deepEqual(candidates('http://gate.example:81'), ['http://gate.example:81']);
  assert.deepEqual(candidates('https://gate.example/base/'), ['https://gate.example/base']);
});

test('candidates: junk gives nothing', () => {
  assert.deepEqual(candidates('not a host'), []);
  assert.deepEqual(candidates('ftp://gate.example'), []);
});

test('parsePairLink: splits base and code', () => {
  assert.deepEqual(parsePairLink('https://gate.example/pair#abc-DEF_1'), { baseUrl: 'https://gate.example', code: 'abc-DEF_1' });
  assert.deepEqual(parsePairLink('  http://127.0.0.1:8787/pair#x1 '), { baseUrl: 'http://127.0.0.1:8787', code: 'x1' });
});

test('parsePairLink: finds the link inside pasted text', () => {
  assert.deepEqual(parsePairLink('Pair link: http://127.0.0.1:8787/pair#x1\nDone'), { baseUrl: 'http://127.0.0.1:8787', code: 'x1' });
});

test('parsePairLink: a base with a path prefix is refused, the socket lives at /ext of the origin', () => {
  assert.equal(parsePairLink('https://gate.example/base/pair#x1'), null);
  assert.equal(parsePairLink('https://gate.example//pair#x1'), null);
});

test('parsePairLink: rejects everything else', () => {
  for (const bad of ['', 'gate.example', 'https://gate.example/pair', 'https://gate.example/pair#', 'https://gate.example/other#x1', 'ftp://gate.example/pair#x1', 'https://user:pw@gate.example/pair#x1', 'https://gate.example/pair?x=1#x1', 'javascript:alert(1)//pair#x1']) {
    assert.equal(parsePairLink(bad), null, bad);
  }
});

test('isOpenTransport: https and loopback are closed, the rest is open', () => {
  for (const closed of ['https://gate.example', 'https://8.8.8.8:8787', 'http://127.0.0.1:8787', 'http://127.1.2.3', 'http://localhost:1', 'http://[::1]:8787']) {
    assert.equal(isOpenTransport(closed), false, closed);
  }
  for (const open of ['http://gate.example', 'http://192.168.1.2:8787', 'http://localhost.evil.test', 'http://127.0.0.1.evil.test', 'http://127.evil.test', 'garbage']) {
    assert.equal(isOpenTransport(open), true, open);
  }
});

const serve = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); server.close(); } }));
});

test('probe: recognises a server by its identity route', async () => {
  const info = { name: 'tweakline', version: '1', addresses: [{ kind: 'local', url: 'http://x' }] };
  const server = await serve((req, res) => { res.end(req.url === '/tweakline' ? JSON.stringify(info) : '{}'); });
  assert.deepEqual(await probe(server.url), info);
  server.close();
});

test('probe: another service, bad json, a closed port and a redirect all give null', async () => {
  const other = await serve((_req, res) => res.end(JSON.stringify({ name: 'nginx' })));
  assert.equal(await probe(other.url), null);
  other.close();
  const broken = await serve((_req, res) => res.end('<html>'));
  assert.equal(await probe(broken.url), null);
  broken.close();
  assert.equal(await probe(broken.url), null);
  const moved = await serve((_req, res) => { res.writeHead(302, { location: 'https://evil.test/' }); res.end(); });
  assert.equal(await probe(moved.url), null);
  moved.close();
});

test('probe: a server that never answers times out', async () => {
  const silent = await serve(() => {});
  const started = Date.now();
  assert.equal(await probe(silent.url), null);
  assert.ok(Date.now() - started < 2500);
  silent.close();
});

test('reconnectTarget: a timer reopens only its own connection to a server that still exists', () => {
  const conn = {};
  const server = { id: 's1' };
  const connections = new Map([['s1', conn]]);
  assert.equal(reconnectTarget({ connections, serverId: 's1', conn, servers: [server] }), server);
  assert.equal(reconnectTarget({ connections, serverId: 's1', conn, servers: [] }), null, 'removed while the timer waited');
  assert.equal(reconnectTarget({ connections: new Map(), serverId: 's1', conn, servers: [server] }), null, 'its connection was dropped');
  assert.equal(reconnectTarget({ connections: new Map([['s1', {}]]), serverId: 's1', conn, servers: [server] }), null, 're-paired: a new connection');
});
