import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openCredentials } from '../store.mjs';
import { addressOf, boot, bootWithDevice, connectExt, delay } from './helpers.mjs';

const STATUS_TEXT_LIMIT = 80;
const SILENCE_MS = 60;

async function setup(t) {
  const booted = await bootWithDevice(t);
  const { data: session } = await booted.ext.call('session.create', { kind: 'page', tab: 1 });
  const url = addressOf(session);
  const post = (route, body) => fetch(url + route, { method: 'POST', body: JSON.stringify(body) });
  const events = (after = 0, wait = 0) => fetch(`${url}events?after=${after}&wait=${wait}`).then((r) => r.json());
  return { ...booted, session, url, post, events };
}

async function connectMcp(t, base, dataDir) {
  const { token } = openCredentials(dataDir).createMcpToken('ai');
  const client = new Client({ name: 'test', version: '1' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

const hasMessage = (ext, type) => ext.inbox.some((m) => m.type === type);

test('events marks a returned user event read and tells the owner once', async (t) => {
  const { ext, session, events } = await setup(t);
  const { data: said } = await ext.call('user.say', { session: session.id, text: 'hi' });
  assert.equal(said.type, 'user');
  assert.equal((await ext.call('session.list')).data[0].seenSeq, 0);
  await events();
  assert.deepEqual(await ext.next('seen'), { type: 'seen', session: session.id, seq: said.seq });
  const [row] = (await ext.call('session.list')).data;
  assert.equal(row.seenSeq, said.seq);
  assert.ok(row.seenAt > 0);
  await events();
  await delay(SILENCE_MS);
  assert.equal(hasMessage(ext, 'seen'), false);
});

test('reading an older range never lowers seenSeq', async (t) => {
  const { ext, session, events } = await setup(t);
  await ext.call('user.say', { session: session.id, text: 'one' });
  const { data: second } = await ext.call('user.say', { session: session.id, text: 'two' });
  await events();
  assert.equal((await ext.next('seen')).seq, second.seq);
  await events(0);
  await events(second.seq);
  assert.equal((await ext.call('session.list')).data[0].seenSeq, second.seq);
});

test('events without a person message do not count as read', async (t) => {
  const { ext, session, events } = await setup(t);
  await ext.call('user.action', { session: session.id, action: 'keep' });
  assert.equal((await events()).events.length, 1);
  await delay(SILENCE_MS);
  assert.equal(hasMessage(ext, 'seen'), false);
  assert.equal((await ext.call('session.list')).data[0].seenSeq, 0);
});

test('a long poll that lost its client does not mark anything read', async (t) => {
  const { ext, session, url } = await setup(t);
  const gone = new AbortController();
  const polling = fetch(`${url}events?after=0&wait=5`, { signal: gone.signal }).catch(() => null);
  await delay(SILENCE_MS);
  gone.abort();
  await polling;
  await delay(SILENCE_MS);
  await ext.call('user.say', { session: session.id, text: 'nobody home' });
  await delay(SILENCE_MS);
  assert.equal(hasMessage(ext, 'seen'), false);
  assert.equal((await ext.call('session.list')).data[0].seenSeq, 0);
});

test('seenSeq survives a restart', async (t) => {
  const first = await setup(t);
  const { data: said } = await first.ext.call('user.say', { session: first.session.id, text: 'hi' });
  await first.events();
  await first.ext.next('seen');
  await first.close();
  const second = await boot(t, { dataDir: first.dataDir });
  const ext = connectExt(t, second.base, first.device);
  await ext.ready;
  assert.equal((await ext.call('session.list')).data[0].seenSeq, said.seq);
});

test('MCP wait marks read and a revoked session stays revoked after its waiter ends', async (t) => {
  const { ext, session, base, dataDir } = await setup(t);
  const client = await connectMcp(t, base, dataDir);
  const { data: said } = await ext.call('user.say', { session: session.id, text: 'hi' });
  await client.callTool({ name: 'wait', arguments: { session: session.id, after: 0, seconds: 0 } });
  assert.equal((await ext.next('seen')).seq, said.seq);
  const waiting = client.callTool({ name: 'wait', arguments: { session: session.id, after: 0, seconds: 5 } });
  await delay(SILENCE_MS);
  await ext.call('session.revoke', { id: session.id });
  await waiting;
  assert.equal((await ext.call('session.list')).data.length, 0);
});

test('status reaches the owner, stays out of history and the feed, and is validated', async (t) => {
  const { ext, session, post, events } = await setup(t);
  const before = Date.now();
  assert.equal((await post('status', { state: 'thinking', text: 'Reading the page' })).status, 200);
  const sent = await ext.next('status');
  assert.equal(sent.session, session.id);
  assert.equal(sent.state, 'thinking');
  assert.equal(sent.text, 'Reading the page');
  assert.ok(sent.at >= before);
  assert.equal((await ext.call('session.history', { id: session.id })).data.length, 0);
  assert.equal((await events()).events.length, 0);
  assert.equal((await post('status', { state: 'dancing' })).status, 400);
  assert.equal((await post('status', {})).status, 400);
  await delay(SILENCE_MS);
  assert.equal(hasMessage(ext, 'status'), false);
});

test('status text is optional, single line and at most 80 chars', async (t) => {
  const { ext, post } = await setup(t);
  await post('status', { state: 'typing' });
  assert.equal((await ext.next('status')).text, '');
  await post('status', { state: 'typing', text: `${'x'.repeat(50)}\n${'y'.repeat(100)}` });
  const { text } = await ext.next('status');
  assert.equal(text.length, STATUS_TEXT_LIMIT);
  assert.equal(text.includes('\n'), false);
});

test('say clears the status to idle after the message', async (t) => {
  const { ext, session, post } = await setup(t);
  await post('status', { state: 'typing' });
  await ext.next('status');
  await post('say', { text: 'done' });
  assert.equal((await ext.next('event')).event.data.text, 'done');
  const cleared = await ext.next('status');
  assert.equal(cleared.session, session.id);
  assert.equal(cleared.state, 'idle');
  assert.equal(cleared.text, '');
});

test('status shows the AI online while it works without polling', async (t) => {
  const { ext, session, post } = await setup(t);
  await post('status', { state: 'thinking' });
  assert.deepEqual(await ext.next('presence'), { type: 'presence', session: session.id, online: true });
  assert.equal((await ext.call('session.list')).data[0].polling, true);
});

test('MCP status tool reaches the owner, a bad state is refused', async (t) => {
  const { ext, session, base, dataDir } = await setup(t);
  const client = await connectMcp(t, base, dataDir);
  const ok = await client.callTool({ name: 'status', arguments: { session: session.id, state: 'thinking', text: 'Looking' } });
  assert.notEqual(ok.isError, true);
  const sent = await ext.next('status');
  assert.equal(sent.state, 'thinking');
  assert.equal(sent.text, 'Looking');
  const bad = await client.callTool({ name: 'status', arguments: { session: session.id, state: 'nope' } }).catch((error) => ({ isError: true, error }));
  assert.equal(bad.isError, true);
  const { tools } = await client.listTools();
  assert.match(tools.find((tool) => tool.name === 'wait').description, /\bedit\b/);
});

test('user.edit appends an edit event for the ai, the history and the other tabs', async (t) => {
  const { ext, session, events } = await setup(t);
  const { data: said } = await ext.call('user.say', { session: session.id, text: 'teh typo' });
  const reply = await ext.call('user.edit', { session: session.id, target: said.seq, text: 'the typo' });
  assert.equal(reply.ok, true);
  assert.equal(reply.data.type, 'edit');
  assert.deepEqual(reply.data.data, { target: said.seq, text: 'the typo' });
  const pushed = await ext.next('event');
  assert.equal(pushed.event.seq, reply.data.seq);
  const feed = (await events()).events;
  assert.deepEqual(feed.map((e) => e.type), ['user', 'edit']);
  assert.equal(feed[0].data.text, 'teh typo');
  assert.equal(feed[1].data.text, 'the typo');
  const history = (await ext.call('session.history', { id: session.id })).data;
  assert.deepEqual(history.map((e) => e.type), ['user', 'edit']);
  assert.equal((await ext.next('seen')).seq, reply.data.seq);
});

test('user.edit wakes a waiting AI', async (t) => {
  const { ext, session, events } = await setup(t);
  const { data: said } = await ext.call('user.say', { session: session.id, text: 'hi' });
  const waiting = events(said.seq, 5);
  await delay(SILENCE_MS);
  const started = Date.now();
  await ext.call('user.edit', { session: session.id, target: said.seq, text: 'hello' });
  const { events: woken } = await waiting;
  assert.equal(woken[0].type, 'edit');
  assert.ok(Date.now() - started < 3000);
});

test('user.edit only targets a person message of that session', async (t) => {
  const { ext, session, post } = await setup(t);
  const { data: other } = await ext.call('session.create', { kind: 'page', tab: 2 });
  const { data: said } = await ext.call('user.say', { session: session.id, text: 'hi' });
  const { seq: aiSeq } = await (await post('say', { text: 'an ai message' })).json();
  const edit = (params) => ext.call('user.edit', { session: session.id, text: 'new', ...params });
  assert.equal((await edit({ target: aiSeq })).ok, false);
  assert.equal((await edit({ target: 999 })).ok, false);
  assert.equal((await edit({ session: other.id, target: said.seq })).ok, false);
  assert.equal((await edit({ target: said.seq, text: '   ' })).ok, false);
  assert.equal((await edit({ target: said.seq, text: 7 })).ok, false);
  const { data: edited } = await edit({ target: said.seq });
  assert.equal((await edit({ target: edited.seq })).ok, false);
});

test('instructions describe status and edit', async (t) => {
  const { url } = await setup(t);
  const text = await (await fetch(url)).text();
  assert.match(text, /status -d/);
  assert.match(text, /`edit`/);
});

test('presence goes offline as soon as polling is stale, not at the next periodic check', async (t) => {
  const pollFreshMs = 300;
  const booted = await bootWithDevice(t, { pollFreshMs });
  const { data: session } = await booted.ext.call('session.create', { kind: 'page', tab: 1 });
  const events = () => fetch(`${addressOf(session)}events?after=0&wait=0`).then((r) => r.json());
  await events();
  assert.deepEqual(await booted.ext.next('presence'), { type: 'presence', session: session.id, online: true });
  await delay(pollFreshMs / 2);
  await events();
  const refreshedAt = Date.now();
  assert.deepEqual(await booted.ext.next('presence'), { type: 'presence', session: session.id, online: false });
  const elapsed = Date.now() - refreshedAt;
  assert.ok(elapsed >= pollFreshMs - 5 && elapsed < pollFreshMs * 2, `offline after ${elapsed} ms`);
  assert.equal((await booted.ext.call('session.list')).data[0].polling, false);
  await events();
  assert.deepEqual(await booted.ext.next('presence'), { type: 'presence', session: session.id, online: true });
});
