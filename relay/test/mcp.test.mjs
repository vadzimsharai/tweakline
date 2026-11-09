import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import fs from 'node:fs';
import path from 'node:path';
import { openCredentials } from '../store.mjs';
import { addressOf, bootWithDevice, CLI, delay, runCli, tempDir } from './helpers.mjs';

const TOOL_NAMES = ['act', 'file_get', 'file_put', 'say', 'session_address', 'session_name', 'sessions_list', 'status', 'wait'];
const INIT_BODY = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

async function connectMcp(t, base, token) {
  const client = new Client({ name: 'test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  t.after(() => client.close());
  await client.connect(transport);
  return client;
}

async function setup(t) {
  const booted = await bootWithDevice(t);
  const { token, id } = openCredentials(booted.dataDir).createMcpToken('ai');
  const client = await connectMcp(t, booted.base, token);
  const { data: session } = await booted.ext.call('session.create', { kind: 'page', tab: 1 });
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return { ...result, json: result.content?.[0]?.type === 'text' ? safeJson(result.content[0].text) : undefined };
  };
  return { ...booted, token, tokenId: id, client, session, call };
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

test('no token, a wrong token and a revoked token answer 401', async (t) => {
  const { base, dataDir, token, tokenId } = await setup(t);
  const post = (headers) => fetch(`${base}/mcp`, { method: 'POST', headers: { ...MCP_HEADERS, ...headers }, body: JSON.stringify(INIT_BODY) });
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await post({ authorization: `Bearer ${token}` })).status, 200);
  openCredentials(dataDir).revoke(tokenId);
  assert.equal((await post({ authorization: `Bearer ${token}` })).status, 401);
});

test('a device token is not an MCP token', async (t) => {
  const { base, device } = await setup(t);
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...MCP_HEADERS, authorization: `Bearer ${device.deviceToken}` }, body: JSON.stringify(INIT_BODY) });
  assert.equal(res.status, 401);
});

test('GET /mcp is refused in stateless mode', async (t) => {
  const { base, token } = await setup(t);
  const res = await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' } });
  assert.equal(res.status, 405);
});

test('tools/list has exactly the agreed names and warns about untrusted content', async (t) => {
  const { client } = await setup(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), TOOL_NAMES);
  for (const name of ['wait', 'act', 'file_get']) {
    assert.match(tools.find((tool) => tool.name === name).description, /untrusted/i, name);
  }
  assert.equal(tools.find((tool) => tool.name === 'wait').inputSchema.properties.seconds.maximum, 50);
});

test('sessions_list sees a new session with its device and no addresses', async (t) => {
  const { call, ext, session } = await setup(t);
  const first = await call('sessions_list');
  assert.equal(first.json.sessions.length, 1);
  assert.equal(first.json.sessions[0].id, session.id);
  assert.equal(first.json.sessions[0].device, 'b1');
  assert.equal(first.json.sessions[0].addresses, undefined);
  await ext.call('session.create', { kind: 'browser' });
  assert.equal((await call('sessions_list')).json.sessions.length, 2);
});

test('say reaches the browser socket', async (t) => {
  const { call, ext, session } = await setup(t);
  const result = await call('say', { session: session.id, text: 'hello', actions: [{ id: 'a', label: 'A' }], ask: { access: true }, files: ['f'] });
  assert.ok(!result.isError);
  const { event, session: id } = await ext.next('event');
  assert.equal(id, session.id);
  assert.equal(event.type, 'ai');
  assert.deepEqual(event.data, { text: 'hello', actions: [{ id: 'a', label: 'A' }], ask: { access: true }, files: ['f'] });
});

test('session_name reaches the browser', async (t) => {
  const { call, ext, session } = await setup(t);
  await call('session_name', { session: session.id, title: 'Edits', ai: 'claude' });
  const { event } = await ext.next('event');
  assert.equal(event.type, 'title');
  assert.deepEqual(event.data, { title: 'Edits', ai: 'claude' });
  assert.equal((await ext.call('session.list')).data[0].title, 'Edits');
});

test('wait returns a queued event, and a later one while waiting', async (t) => {
  const { call, ext, session } = await setup(t);
  await ext.call('user.say', { session: session.id, text: 'one' });
  const queued = await call('wait', { session: session.id, after: 0, seconds: 0 });
  assert.equal(queued.json.events[0].data.text, 'one');
  const seq = queued.json.events[0].seq;
  const waiting = call('wait', { session: session.id, after: seq, seconds: 5 });
  await delay(80);
  await ext.call('user.say', { session: session.id, text: 'two' });
  assert.equal((await waiting).json.events[0].data.text, 'two');
});

test('wait over the limit is refused, and wait marks the AI online', async (t) => {
  const { client, call, ext, session } = await setup(t);
  const over = await client.callTool({ name: 'wait', arguments: { session: session.id, after: 0, seconds: 51 } }).catch((error) => ({ isError: true, content: [{ text: error.message }] }));
  assert.equal(over.isError, true);
  await call('wait', { session: session.id, after: 0, seconds: 0 });
  assert.deepEqual((({ session: id, online }) => ({ id, online }))(await ext.next('presence')), { id: session.id, online: true });
});

test('act forwards do and returns its result', async (t) => {
  const { call, ext, session } = await setup(t);
  const acting = call('act', { session: session.id, op: 'read', args: { limit: 5 }, tab: 7 });
  const cmd = await ext.next('do');
  assert.equal(cmd.session, session.id);
  assert.equal(cmd.op, 'read');
  assert.deepEqual(cmd.args, { limit: 5 });
  assert.equal(cmd.tab, 7);
  ext.send({ type: 'done', id: cmd.id, ok: true, data: 'text' });
  const result = await acting;
  assert.ok(!result.isError);
  assert.deepEqual(result.json, { ok: true, data: 'text' });
});

test('a refused act is a tool error with the reason', async (t) => {
  const { call, ext, session } = await setup(t);
  const acting = call('act', { session: session.id, op: 'click', args: {} });
  const cmd = await ext.next('do');
  ext.send({ type: 'done', id: cmd.id, ok: false, error: 'not granted' });
  const result = await acting;
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not granted/);
});

test('an offline browser gives browser offline', async (t) => {
  const { call, ext, session } = await setup(t);
  ext.ws.close();
  await ext.closed;
  await delay(30);
  const result = await call('act', { session: session.id, op: 'read', args: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /browser offline/);
});

test('session_address mints a working address', async (t) => {
  const { call, session } = await setup(t);
  const result = await call('session_address', { session: session.id });
  assert.deepEqual(result.json.addresses.map((a) => a.kind), ['local', 'public']);
  assert.equal((await fetch(addressOf(result.json))).status, 200);
});

test('an unknown session is a tool error', async (t) => {
  const { call } = await setup(t);
  for (const [name, args] of [['session_address', {}], ['session_name', { title: 'x', ai: 'y' }], ['wait', { after: 0, seconds: 0 }], ['say', { text: 'x' }], ['act', { op: 'read', args: {} }], ['file_get', { file: 'x' }], ['file_put', { name: 'x', type: 'text/plain', base64: '' }]]) {
    const result = await call(name, { session: 'nope', ...args });
    assert.equal(result.isError, true, name);
    assert.match(result.content[0].text, /unknown session/, name);
  }
});

test('files round trip, and images come back as image content', async (t) => {
  const { call, ext, session } = await setup(t);
  const base64 = Buffer.from('png-bytes').toString('base64');
  const put = await call('file_put', { session: session.id, name: 'a.png', type: 'image/png', base64 });
  assert.ok(put.json.id);
  const browserView = await ext.call('file.get', { session: session.id, file: put.json.id });
  assert.equal(browserView.data.base64, base64);
  const image = await call('file_get', { session: session.id, file: put.json.id });
  const imageBlock = image.content.find((block) => block.type === 'image');
  assert.equal(imageBlock.data, base64);
  assert.equal(imageBlock.mimeType, 'image/png');
  const text = await call('file_put', { session: session.id, name: 'a.txt', type: 'text/plain', base64 });
  const got = await call('file_get', { session: session.id, file: text.json.id });
  assert.equal(got.json.base64, base64);
  assert.equal(got.json.name, 'a.txt');
  const other = await ext.call('session.create', { kind: 'browser' });
  const denied = await call('file_get', { session: other.data.id, file: put.json.id });
  assert.equal(denied.isError, true);
});

test('a revoked device hides its sessions from MCP', async (t) => {
  const { call, dataDir, device, session } = await setup(t);
  assert.equal((await call('sessions_list')).json.sessions.length, 1);
  openCredentials(dataDir).revoke(device.deviceId);
  assert.equal((await call('sessions_list')).json.sessions.length, 0);
  assert.equal((await call('say', { session: session.id, text: 'x' })).isError, true);
});

test('instructions mention nothing about MCP tokens', () => {
  const text = fs.readFileSync(new URL('../instructions.md', import.meta.url), 'utf8');
  assert.ok(!/mcp/i.test(text));
});

async function stdioClient(t, env) {
  const client = new Client({ name: 'stdio-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env: { PATH: process.env.PATH, ...env }, stderr: 'pipe' });
  t.after(() => client.close());
  await client.connect(transport);
  return client;
}

test('tweakline mcp over stdio with env lists tools and calls them', async (t) => {
  const { base, ext, session, token } = await setup(t);
  const client = await stdioClient(t, { TWEAKLINE_URL: base, TWEAKLINE_TOKEN: token, HOME: tempDir() });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), TOOL_NAMES);
  const said = await client.callTool({ name: 'say', arguments: { session: session.id, text: 'over stdio' } });
  assert.ok(!said.isError);
  assert.equal((await ext.next('event')).event.data.text, 'over stdio');
});

test('token new writes the config once, and tweakline mcp reads it', async (t) => {
  const { base, dataDir, session } = await setup(t);
  const home = tempDir();
  const env = { HOME: home };
  const configFile = path.join(home, '.config', 'tweakline', 'config.json');
  const { stdout } = await runCli(['token', 'new', '--name', 'cli', '--data', dataDir], env);
  const token = stdout.trim();
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.deepEqual(config, { url: 'https://wg.test', token });
  assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
  await runCli(['token', 'new', '--name', 'second', '--data', dataDir], env);
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).token, token);

  fs.writeFileSync(configFile, JSON.stringify({ url: base, token }));
  const client = await stdioClient(t, env);
  const listed = await client.callTool({ name: 'sessions_list', arguments: {} });
  assert.equal(JSON.parse(listed.content[0].text).sessions[0].id, session.id);
});

test('tweakline mcp without any config fails with a clear message', async () => {
  await assert.rejects(runCli(['mcp'], { HOME: tempDir(), TWEAKLINE_URL: '', TWEAKLINE_TOKEN: '' }), /token new/);
});
