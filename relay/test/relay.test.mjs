import test from 'node:test';
import assert from 'node:assert/strict';
import { addressOf, boot, bootWithDevice, connectExt, delay, tokenOf } from './helpers.mjs';

test('session.create gives a secret address with at least 256 bits', async (t) => {
  const { ext } = await bootWithDevice(t);
  const { data } = await ext.call('session.create', { kind: 'page', tab: 3 });
  const token = tokenOf(addressOf(data));
  assert.ok(Buffer.from(token, 'base64url').length >= 32);
  assert.ok(data.id && data.id !== token);
  assert.equal(data.tab, 3);
  assert.equal(data.device, 'b1');
});

test('wrong device token closes the socket with 4003', async (t) => {
  const { base } = await boot(t);
  const ext = connectExt(t, base, { deviceToken: 'y'.repeat(43) });
  assert.equal(await ext.closed, 4003);
});

test('unknown session answers 404 and instructions contain curl', async (t) => {
  const { base, ext } = await bootWithDevice(t);
  assert.equal((await fetch(`${base}/s/nope/`)).status, 404);
  const { data } = await ext.call('session.create', { kind: 'browser' });
  const text = await (await fetch(addressOf(data))).text();
  assert.match(text, /curl/);
  assert.ok(text.includes(addressOf(data)));
});

test('long poll returns queued user events and honours after', async (t) => {
  const { ext } = await bootWithDevice(t);
  const { data } = await ext.call('session.create', { kind: 'page', tab: 1 });
  const url = addressOf(data);
  await ext.call('user.say', { session: data.id, text: 'привет' });
  const first = await (await fetch(`${url}events?after=0&wait=0`)).json();
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].data.text, 'привет');
  const started = Date.now();
  const waiting = fetch(`${url}events?after=${first.events[0].seq}&wait=5`).then((r) => r.json());
  await delay(80);
  await ext.call('user.say', { session: data.id, text: 'more' });
  const second = await waiting;
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].data.text, 'more');
  assert.ok(Date.now() - started < 3000);
  const none = await (await fetch(`${url}events?after=${second.events[0].seq}&wait=0`)).json();
  assert.equal(none.events.length, 0);
});

test('ai messages and title reach the browser and the history, not the ai feed', async (t) => {
  const { ext } = await bootWithDevice(t);
  const { data } = await ext.call('session.create', { kind: 'page', tab: 1 });
  const url = addressOf(data);
  const post = (p, body) => fetch(url + p, { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await post('session', { title: 'Edits', ai: 'claude-code' })).status, 200);
  assert.equal((await ext.next('event')).event.type, 'title');
  await post('say', { text: 'done' });
  assert.equal((await ext.next('event')).event.data.text, 'done');
  const list = await ext.call('session.list');
  assert.equal(list.data[0].title, 'Edits');
  assert.equal(list.data[0].ai, 'claude-code');
  assert.equal(list.data[0].device, 'b1');
  assert.equal(list.data[0].addresses, undefined);
  const history = await ext.call('session.history', { id: data.id, after: 0 });
  assert.equal(history.data.length, 2);
  const feed = await (await fetch(`${url}events?after=0&wait=0`)).json();
  assert.equal(feed.events.length, 0);
});

test('do is forwarded to the browser, and offline answers an error', async (t) => {
  const { ext } = await bootWithDevice(t);
  const { data } = await ext.call('session.create', { kind: 'page', tab: 1 });
  const url = addressOf(data);
  const doing = fetch(`${url}do`, { method: 'POST', body: JSON.stringify({ op: 'read', args: { a: 1 } }) }).then((r) => r.json());
  const cmd = await ext.next('do');
  assert.equal(cmd.op, 'read');
  assert.equal(cmd.session, data.id);
  ext.send({ type: 'done', id: cmd.id, ok: true, data: 'text' });
  assert.deepEqual(await doing, { ok: true, data: 'text' });
  ext.ws.close();
  await ext.closed;
  await delay(30);
  const offline = await (await fetch(`${url}do`, { method: 'POST', body: '{"op":"read"}' })).json();
  assert.deepEqual(offline, { ok: false, error: 'browser offline' });
});

test('a do in flight fails at once when the browser disconnects', async (t) => {
  const { ext } = await bootWithDevice(t);
  const { data } = await ext.call('session.create', { kind: 'page', tab: 1 });
  const doing = fetch(`${addressOf(data)}do`, { method: 'POST', body: '{"op":"read"}' }).then((r) => r.json());
  await ext.next('do');
  ext.ws.close();
  assert.deepEqual(await doing, { ok: false, error: 'browser offline' });
});

test('revoked session answers 404', async (t) => {
  const { ext } = await bootWithDevice(t);
  const { data } = await ext.call('session.create', { kind: 'browser' });
  await ext.call('session.revoke', { id: data.id });
  assert.equal((await fetch(addressOf(data))).status, 404);
});

test('sessions and events survive a restart, on the same device', async (t) => {
  const first = await bootWithDevice(t);
  const { data } = await first.ext.call('session.create', { kind: 'page', tab: 1 });
  await first.ext.call('user.say', { session: data.id, text: 'before restart' });
  await first.close();
  const second = await boot(t, { dataDir: first.dataDir });
  const url = addressOf(data).replace(first.base, second.base);
  const feed = await (await fetch(`${url}events?after=0&wait=0`)).json();
  assert.equal(feed.events[0].data.text, 'before restart');
  const ext = connectExt(t, second.base, first.device);
  await ext.ready;
  await ext.call('user.say', { session: data.id, text: 'after' });
  const again = await (await fetch(`${url}events?after=${feed.events[0].seq}&wait=0`)).json();
  assert.equal(again.events.length, 1);
  assert.ok(again.events[0].seq > feed.events[0].seq);
});

test('body over the limit answers 413 and files round trip', async (t) => {
  const { ext } = await bootWithDevice(t);
  const { data } = await ext.call('session.create', { kind: 'browser' });
  const url = addressOf(data);
  const big = await fetch(`${url}say`, { method: 'POST', body: 'x'.repeat(2 * 1024 * 1024) });
  assert.equal(big.status, 413);
  const put = await ext.call('file.put', { session: data.id, name: 'a.png', type: 'image/png', base64: Buffer.from('png').toString('base64') });
  const got = await fetch(`${url}files/${put.data.id}`);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.equal(await got.text(), 'png');
  const other = await ext.call('session.create', { kind: 'browser' });
  assert.equal((await fetch(`${addressOf(other.data)}files/${put.data.id}`)).status, 404);
});

test('patches are stored and listed', async (t) => {
  const { ext } = await bootWithDevice(t);
  const put = await ext.call('patch.put', { patch: { site: 'a.example', mask: 'a.example/*', title: 'T', css: 'a{}' } });
  assert.ok(put.data.id);
  const list = await ext.call('patch.list');
  assert.equal(list.data.length, 1);
  await ext.call('patch.delete', { id: put.data.id });
  assert.equal((await ext.call('patch.list')).data.length, 0);
});
