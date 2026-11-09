import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openCredentials } from '../store.mjs';
import { addressOf, boot, bootWithDevice, connectExt, delay } from './helpers.mjs';

const FIRST_CHAT = 'c1';
const SILENCE_MS = 60;

async function setup(t, options) {
  const booted = await bootWithDevice(t, options);
  const { data: session } = await booted.ext.call('session.create', { kind: 'page', tab: 1 });
  const url = addressOf(session);
  const post = (route, body) => fetch(url + route, { method: 'POST', body: JSON.stringify(body) });
  const events = (after = 0, wait = 0, chat = '') => fetch(`${url}events?after=${after}&wait=${wait}${chat ? `&chat=${chat}` : ''}`).then((r) => r.json());
  const say = (text) => booted.ext.call('user.say', { session: session.id, text }).then((r) => r.data);
  return { ...booted, session, url, post, events, say };
}

async function connectMcp(t, base, dataDir) {
  const { token } = openCredentials(dataDir).createMcpToken('ai');
  const client = new Client({ name: 'test', version: '1' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

test('a new session starts in its first chat and every event carries it', async (t) => {
  const { ext, session, post, events, say } = await setup(t);
  assert.equal(session.chat, FIRST_CHAT);
  assert.equal((await ext.call('session.list')).data[0].chat, FIRST_CHAT);
  const said = await say('hi');
  assert.equal(said.chat, FIRST_CHAT);
  await post('say', { text: 'hello' });
  const history = (await ext.call('session.history', { id: session.id })).data;
  assert.deepEqual(history.map((e) => e.chat), [FIRST_CHAT, FIRST_CHAT]);
  const feed = await events();
  assert.equal(feed.chat, FIRST_CHAT);
  assert.equal(feed.events[0].chat, FIRST_CHAT);
});

test('user.newChat switches the current chat, tells the AI and the other tabs', async (t) => {
  const { ext, session, post, events, say } = await setup(t);
  await say('first topic');
  const { data: started } = await ext.call('user.newChat', { session: session.id });
  assert.equal(started.type, 'chat');
  assert.notEqual(started.chat, FIRST_CHAT);
  assert.equal(started.data.chat, started.chat);
  assert.equal((await ext.next('event')).event.seq, started.seq);
  assert.equal((await ext.call('session.list')).data[0].chat, started.chat);
  const second = await say('second topic');
  assert.equal(second.chat, started.chat);
  const { seq } = await (await post('say', { text: 'on it' })).json();
  const history = (await ext.call('session.history', { id: session.id })).data;
  assert.equal(history.find((e) => e.seq === seq).chat, started.chat);
  const feed = await events();
  assert.deepEqual(feed.events.map((e) => [e.type, e.chat]), [['user', FIRST_CHAT], ['chat', started.chat], ['user', started.chat]]);
  assert.equal(feed.chat, started.chat);
});

test('user.newChat on an empty chat keeps it and tells nobody', async (t) => {
  const { ext, session, events } = await setup(t);
  const { data } = await ext.call('user.newChat', { session: session.id });
  assert.deepEqual(data, { chat: FIRST_CHAT });
  assert.equal((await events()).events.length, 0);
  await delay(SILENCE_MS);
  assert.equal(ext.inbox.some((m) => m.type === 'event'), false);
});

test('a new chat wakes a waiting AI', async (t) => {
  const { ext, session, events, say } = await setup(t);
  const said = await say('hi');
  const waiting = events(said.seq, 5);
  await delay(SILENCE_MS);
  await ext.call('user.newChat', { session: session.id });
  const { events: woken } = await waiting;
  assert.equal(woken[0].type, 'chat');
});

test('session.chats lists chats newest first with title, time, count and the current one', async (t) => {
  const { ext, session, post, say } = await setup(t);
  await say('  Fix the header\nand the footer');
  await post('say', { text: 'done' });
  await say('thanks');
  const { data: started } = await ext.call('user.newChat', { session: session.id });
  await ext.call('user.say', { session: session.id, text: '', notes: [{ n: 1, kind: 'point' }] });
  const { data: chats } = await ext.call('session.chats', { id: session.id });
  assert.deepEqual(chats.map((c) => c.id), [started.chat, FIRST_CHAT]);
  const [current, first] = chats;
  assert.equal(current.current, true);
  assert.equal(current.count, 1);
  assert.equal(current.title, '');
  assert.equal(first.current, false);
  assert.equal(first.title, 'Fix the header and the footer');
  assert.equal(first.count, 3);
  assert.ok(first.lastAt >= first.startedAt && first.startedAt > 0);
  const { data: other } = await ext.call('session.create', { kind: 'page', tab: 2 });
  assert.deepEqual((await ext.call('session.chats', { id: other.id })).data, []);
});

test('user.continueChat makes an earlier chat current and tells the AI with its title', async (t) => {
  const { ext, session, events, say } = await setup(t);
  await say('old topic');
  await ext.call('user.newChat', { session: session.id });
  await say('new topic');
  const { data: back } = await ext.call('user.continueChat', { session: session.id, chat: FIRST_CHAT });
  assert.equal(back.type, 'chat');
  assert.equal(back.chat, FIRST_CHAT);
  assert.deepEqual(back.data, { chat: FIRST_CHAT, title: 'old topic', continued: true });
  assert.equal((await ext.call('session.list')).data[0].chat, FIRST_CHAT);
  assert.equal((await say('more on the old topic')).chat, FIRST_CHAT);
  assert.equal((await events()).events.filter((e) => e.type === 'chat').length, 2);
  assert.equal((await ext.call('user.continueChat', { session: session.id, chat: 'c99' })).ok, false);
  assert.equal((await ext.call('user.continueChat', { session: session.id, chat: 'nope' })).ok, false);
});

test('say with chat goes to that chat, without it to the current one, an unknown chat is refused', async (t) => {
  const { ext, session, post, say } = await setup(t);
  await say('old');
  const { data: started } = await ext.call('user.newChat', { session: session.id });
  ext.inbox.length = 0;
  const late = await (await post('say', { text: 'late answer', chat: FIRST_CHAT })).json();
  const now = await (await post('say', { text: 'fresh' })).json();
  const history = (await ext.call('session.history', { id: session.id })).data;
  assert.equal(history.find((e) => e.seq === late.seq).chat, FIRST_CHAT);
  assert.equal(history.find((e) => e.seq === now.seq).chat, started.chat);
  assert.equal(history.find((e) => e.seq === late.seq).data.chat, undefined);
  assert.equal((await post('say', { text: 'x', chat: 'c42' })).status, 400);
});

test('events with chat return only that chat and keep waiting past other chats', async (t) => {
  const { ext, session, events, say } = await setup(t);
  const old = await say('old');
  const { data: started } = await ext.call('user.newChat', { session: session.id });
  const fresh = await say('new');
  assert.deepEqual((await events(0, 0, FIRST_CHAT)).events.map((e) => e.seq), [old.seq]);
  assert.deepEqual((await events(0, 0, started.chat)).events.map((e) => e.seq), [started.seq, fresh.seq]);
  const waiting = events(fresh.seq, 5, FIRST_CHAT);
  await delay(SILENCE_MS);
  await say('still new');
  await delay(SILENCE_MS);
  await ext.call('user.continueChat', { session: session.id, chat: FIRST_CHAT });
  const { events: got } = await waiting;
  assert.deepEqual(got.map((e) => [e.type, e.chat]), [['chat', FIRST_CHAT]]);
});

test('an edit stays in the chat of the message it changes, status names its chat', async (t) => {
  const { ext, session, post, say } = await setup(t);
  const old = await say('teh');
  const { data: started } = await ext.call('user.newChat', { session: session.id });
  const { data: edit } = await ext.call('user.edit', { session: session.id, target: old.seq, text: 'the' });
  assert.equal(edit.chat, FIRST_CHAT);
  ext.inbox.length = 0;
  await post('status', { state: 'thinking', chat: FIRST_CHAT });
  assert.equal((await ext.next('status')).chat, FIRST_CHAT);
  await post('status', { state: 'typing' });
  assert.equal((await ext.next('status')).chat, started.chat);
  assert.equal((await post('status', { state: 'typing', chat: 'c9' })).status, 400);
});

test('the current chat survives a restart, old sessions without chats load into the first chat', async (t) => {
  const first = await setup(t);
  await first.say('hi');
  const { data: started } = await first.ext.call('user.newChat', { session: first.session.id });
  await first.close();
  const file = path.join(first.dataDir, 'sessions', `${first.session.id}.json`);
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
  const legacyId = 'legacy';
  fs.writeFileSync(path.join(first.dataDir, 'sessions', `${legacyId}.json`), JSON.stringify({
    ...legacy, id: legacyId, tokenHashes: [], chat: undefined, chatCount: undefined,
    events: legacy.events.slice(0, 1).map(({ chat, ...event }) => event),
  }));
  const second = await boot(t, { dataDir: first.dataDir });
  const ext = connectExt(t, second.base, first.device);
  await ext.ready;
  const rows = (await ext.call('session.list')).data;
  assert.equal(rows.find((s) => s.id === first.session.id).chat, started.chat);
  assert.equal(rows.find((s) => s.id === legacyId).chat, FIRST_CHAT);
  assert.equal((await ext.call('session.history', { id: legacyId })).data[0].chat, FIRST_CHAT);
  const { data: next } = await ext.call('user.newChat', { session: legacyId });
  assert.equal(next.chat, 'c2');
});

test('MCP wait filters by chat and say takes a chat', async (t) => {
  const { ext, session, base, dataDir, say } = await setup(t);
  const client = await connectMcp(t, base, dataDir);
  await say('old');
  const { data: started } = await ext.call('user.newChat', { session: session.id });
  const waited = await client.callTool({ name: 'wait', arguments: { session: session.id, after: 0, seconds: 0, chat: started.chat } });
  const result = JSON.parse(waited.content[0].text);
  assert.equal(result.chat, started.chat);
  assert.deepEqual(result.events.map((e) => e.chat), [started.chat]);
  const said = await client.callTool({ name: 'say', arguments: { session: session.id, text: 'late', chat: FIRST_CHAT } });
  const { seq } = JSON.parse(said.content[0].text);
  const history = (await ext.call('session.history', { id: session.id })).data;
  assert.equal(history.find((e) => e.seq === seq).chat, FIRST_CHAT);
  const bad = await client.callTool({ name: 'say', arguments: { session: session.id, text: 'x', chat: 'c7' } });
  assert.equal(bad.isError, true);
  const { tools } = await client.listTools();
  assert.match(tools.find((tool) => tool.name === 'wait').description, /\bchat\b/);
});

test('instructions explain chats and one helper per chat', async (t) => {
  const { url } = await setup(t);
  const text = await (await fetch(url)).text();
  assert.match(text, /`chat`/);
  assert.match(text, /separate conversation/i);
  assert.match(text, /one (subagent|helper) per chat/i);
});
