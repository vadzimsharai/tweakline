import test from 'node:test';
import assert from 'node:assert/strict';
import { createPatches } from '../lib/patches.js';
import { MAX_PATTERN_LENGTH } from '../lib/gate.js';

function memoryStore() {
  const data = new Map();
  return {
    get: async (key, fallback) => (data.has(key) ? structuredClone(data.get(key)) : fallback),
    set: async (key, value) => { data.set(key, structuredClone(value)); },
  };
}

function fakeServer() {
  const patches = new Map();
  const state = { offline: false, patches };
  state.call = async (_serverId, method, params) => {
    if (state.offline) throw new Error('offline');
    if (method === 'patch.list') return [...patches.values()];
    if (method === 'patch.put') { patches.set(params.patch.id, { ...params.patch, updatedAt: Date.now() }); return params.patch; }
    if (method === 'patch.delete') { patches.delete(params.id); return null; }
    throw new Error(`unknown ${method}`);
  };
  return state;
}

const device = (call) => createPatches({ store: memoryStore(), call });
const DRAFT = { site: 'a.example', title: 'T', desc: 'D', mask: 'a.example/*', css: 'a{color:red}', js: 'x()', request: 'r', before: 'b', after: 'c' };
const one = async (patches, id) => (await patches.list()).find((p) => p.id === id);

test('save, prefs and delete work without any server', async () => {
  const call = async () => { throw new Error('must not be called'); };
  const patches = device(call);
  const saved = await patches.save(DRAFT, { auto: true, approveJs: true });
  assert.ok(saved.id);
  assert.equal(saved.sync, false);
  let listed = await one(patches, saved.id);
  assert.deepEqual([listed.on, listed.auto, listed.jsApproved], [true, true, true]);
  await patches.setPrefs({ id: saved.id, on: false, auto: false });
  listed = await one(patches, saved.id);
  assert.deepEqual([listed.on, listed.auto], [false, false]);
  await patches.remove(saved.id);
  assert.deepEqual(await patches.list(), []);
});

test('js stays unapproved until asked, and approval is for that exact code', async () => {
  const patches = device(async () => null);
  const { id } = await patches.save(DRAFT, {});
  assert.equal((await one(patches, id)).jsApproved, false);
  await patches.setPrefs({ id, approve: { ...DRAFT, js: 'other()' } });
  assert.equal((await one(patches, id)).jsApproved, false);
  await patches.setPrefs({ id, approve: DRAFT });
  assert.equal((await one(patches, id)).jsApproved, true);
});

test('sync round trip between two devices', async () => {
  const server = fakeServer();
  const a = device(server.call);
  const b = device(server.call);

  const { id } = await a.save(DRAFT, { auto: true, approveJs: true });
  await b.pull('s1');
  assert.deepEqual(await b.list(), [], 'nothing leaves a device before the toggle');

  await a.setSync(id, true, 's1');
  assert.equal(server.patches.size, 1);
  const sent = server.patches.get(id);
  assert.equal('sync' in sent || 'on' in sent || 'jsApproved' in sent || 'auto' in sent, false, 'prefs stay on the device');

  await b.pull('s1');
  let arrived = await one(b, id);
  assert.equal(arrived.css, DRAFT.css);
  assert.deepEqual([arrived.on, arrived.auto, arrived.jsApproved, arrived.sync], [false, false, false, true], 'arrives switched off');
  assert.equal(arrived.fromSync, true);
  assert.deepEqual([(await one(a, id)).on, (await one(a, id)).auto], [true, true], 'prefs are per device');

  await b.setPrefs({ id, on: true, approve: arrived });
  arrived = await one(b, id);
  assert.deepEqual([arrived.on, arrived.jsApproved], [true, true]);

  await b.pull('s1');
  arrived = await one(b, id);
  assert.deepEqual([arrived.on, arrived.jsApproved], [true, true], 'an unchanged patch keeps its prefs');

  server.patches.set(id, { ...sent, js: 'changed()' });
  await b.pull('s1');
  arrived = await one(b, id);
  assert.equal(arrived.js, 'changed()');
  assert.deepEqual([arrived.on, arrived.jsApproved], [false, false], 'changed js needs approval again');

  await b.setPrefs({ id, on: true, approve: { ...DRAFT, js: 'changed()' } });
  server.patches.set(id, { ...sent, js: 'changed()', title: 'New name' });
  await b.pull('s1');
  arrived = await one(b, id);
  assert.equal(arrived.title, 'New name');
  assert.deepEqual([arrived.on, arrived.jsApproved], [true, true], 'a new title alone changes nothing');

  await a.setSync(id, false, 's1');
  assert.equal(server.patches.size, 0);
  await b.pull('s1');
  arrived = await one(b, id);
  assert.equal(arrived.sync, false, 'an enabled copy stays on the device when sync stops');
  assert.equal((await one(a, id)).sync, false);
});

test('a changed css or a wider scope also switches the patch off', async () => {
  const server = fakeServer();
  const a = device(server.call);
  const b = device(server.call);
  const { id } = await a.save(DRAFT, {});
  await a.setSync(id, true, 's1');
  await b.pull('s1');
  await b.setPrefs({ id, on: true, approve: DRAFT });

  const sent = server.patches.get(id);
  server.patches.set(id, { ...sent, css: 'b{color:red}' });
  await b.pull('s1');
  assert.equal((await one(b, id)).on, false);
  assert.equal((await one(b, id)).jsApproved, true);

  await b.setPrefs({ id, on: true });
  server.patches.set(id, { ...sent, css: 'b{color:red}', mask: '*' });
  await b.pull('s1');
  assert.deepEqual([(await one(b, id)).on, (await one(b, id)).jsApproved], [false, false], 'approved js must not follow a new scope');
});

test('an arrived patch nobody enabled disappears with the server copy', async () => {
  const server = fakeServer();
  const a = device(server.call);
  const b = device(server.call);
  const { id } = await a.save(DRAFT, {});
  await a.setSync(id, true, 's1');
  await b.pull('s1');
  assert.ok(await one(b, id));
  await a.remove(id);
  assert.equal(server.patches.size, 0);
  await b.pull('s1');
  assert.deepEqual(await b.list(), []);
});

test('a server cannot overwrite or delete a patch that is not synced with it', async () => {
  const server = fakeServer();
  const a = device(server.call);
  const local = await a.save(DRAFT, { auto: true });
  server.patches.set(local.id, { ...DRAFT, id: local.id, css: 'evil{}' });
  await a.pull('s1');
  assert.equal((await one(a, local.id)).css, DRAFT.css);

  const synced = await a.save(DRAFT, {});
  await a.setSync(synced.id, true, 's1');
  await a.pull('s2');
  assert.equal((await one(a, synced.id)).sync, true, 'another server has no say over it');
});

test('junk from the server is ignored', async () => {
  const a = device(async () => [null, 5, { id: 7 }, { id: 'x', site: 3 }, { site: 'a.example' }]);
  await a.pull('s1');
  assert.deepEqual(await a.list(), []);
  const notArray = device(async () => ({ nope: true }));
  await notArray.pull('s1');
  assert.deepEqual(await notArray.list(), []);
});

test('delete works offline and reaches the server later', async () => {
  const server = fakeServer();
  const a = device(server.call);
  const { id } = await a.save(DRAFT, {});
  await a.setSync(id, true, 's1');
  server.offline = true;
  await a.remove(id);
  assert.deepEqual(await a.list(), []);
  assert.equal(server.patches.size, 1);
  server.offline = false;
  await a.pull('s1');
  assert.equal(server.patches.size, 0);
  assert.deepEqual(await a.list(), [], 'a deleted patch does not come back');
});

test('the sync toggle fails without the server and changes nothing', async () => {
  const server = fakeServer();
  const a = device(server.call);
  const { id } = await a.save(DRAFT, {});
  server.offline = true;
  await assert.rejects(a.setSync(id, true, 's1'));
  assert.equal((await one(a, id)).sync, false);
});

test('concurrent writes do not lose patches', async () => {
  const a = device(async () => null);
  await Promise.all([a.save({ ...DRAFT, title: '1' }, {}), a.save({ ...DRAFT, title: '2' }, {}), a.save({ ...DRAFT, title: '3' }, {})]);
  assert.equal((await a.list()).length, 3);
});

test('forgetting a server stops sync but keeps the patches', async () => {
  const server = fakeServer();
  const a = device(server.call);
  const { id } = await a.save(DRAFT, {});
  await a.setSync(id, true, 's1');
  await a.forgetServer('s1');
  assert.deepEqual([(await one(a, id)).sync, (await one(a, id)).syncServer], [false, null]);
});

test('approval covers the undo too, and replacing a patch keeps its id but asks again', async () => {
  const patches = device(async () => []);
  const saved = await patches.save({ site: 's.test', title: 'Button', js: 'add()', undo: 'remove()' }, { approveJs: true });
  assert.equal((await patches.list())[0].jsApproved, true);
  const { old } = await patches.replace(saved.id, { title: 'Button', js: 'add({ red: true })', undo: 'remove()' }, { auto: true });
  assert.equal(old.js, 'add()');
  const [now] = await patches.list();
  assert.equal(now.id, saved.id);
  assert.equal(now.js, 'add({ red: true })');
  assert.equal(now.jsApproved, false);
  await patches.setPrefs({ id: saved.id, approve: { js: 'add({ red: true })', undo: 'remove()' } });
  assert.equal((await patches.list())[0].jsApproved, true);
  await patches.replace(saved.id, { undo: 'remove({ all: true })' }, { approveJs: false });
  assert.equal((await patches.list())[0].jsApproved, false, 'a new undo is new code');
  assert.equal((await patches.list()).length, 1);
});

test('approval is bound to the shown code, undo and scope', async () => {
  const patches = device(async () => null);
  const { id } = await patches.save({ ...DRAFT, undo: 'u()' }, {});
  await patches.setPrefs({ id, approve: { ...DRAFT, undo: 'other()' } });
  assert.equal((await one(patches, id)).jsApproved, false, 'a different undo than the stored one');
  await patches.setPrefs({ id, approve: { ...DRAFT, undo: 'u()', mask: '*.a.example/*' } });
  assert.equal((await one(patches, id)).jsApproved, false, 'a different scope than the stored one');
  await patches.setPrefs({ id, approve: { ...DRAFT, undo: 'u()' } });
  assert.equal((await one(patches, id)).jsApproved, true);
  await patches.replace(id, { mask: 'a.example/x' }, { approveJs: false });
  assert.equal((await one(patches, id)).jsApproved, false, 'the same code on a new scope needs approval again');
});

test('an update replaces the whole scope: a mask drops an old pattern and a pattern drops an old mask', async () => {
  const patches = device(async () => null);
  const { id } = await patches.save({ ...DRAFT, mask: undefined, pattern: 'https://a\\.example/.*' }, {});
  await patches.replace(id, { mask: 'a.example/x' }, {});
  let now = await one(patches, id);
  assert.deepEqual([now.mask, now.pattern], ['a.example/x', undefined]);
  await patches.replace(id, { pattern: 'https://a\\.example/y' }, {});
  now = await one(patches, id);
  assert.deepEqual([now.mask, now.pattern], [undefined, 'https://a\\.example/y']);
  await patches.replace(id, { title: 'Only a title' }, {});
  assert.equal((await one(patches, id)).pattern, 'https://a\\.example/y', 'an update without a scope keeps it');
});

test('pull writes prefs before patches, so a failed second write leaves a changed patch off', async () => {
  const server = fakeServer();
  const a = device(server.call);
  const backing = memoryStore();
  let failPatches = false;
  const store = { get: backing.get, set: async (key, value) => { if (failPatches && key === 'patches') throw new Error('disk full'); return backing.set(key, value); } };
  const b = createPatches({ store, call: server.call });
  const { id } = await a.save(DRAFT, {});
  await a.setSync(id, true, 's1');
  await b.pull('s1');
  await b.setPrefs({ id, on: true, approve: DRAFT });
  server.patches.set(id, { ...server.patches.get(id), css: 'evil{}' });
  failPatches = true;
  await assert.rejects(b.pull('s1'));
  failPatches = false;
  const kept = await one(b, id);
  assert.equal(kept.css, DRAFT.css);
  assert.equal(kept.on, false, 'switched off although the new content never landed');
});

test('a pulled patch with a dangerous or very long pattern is refused', async () => {
  const good = { id: 'g', site: 'a.example', pattern: 'https://a\\.example/.*' };
  const a = device(async () => [good, { id: 'n', site: 'a.example', pattern: '(a+)+$' }, { id: 'l', site: 'a.example', pattern: 'a'.repeat(MAX_PATTERN_LENGTH + 1) }]);
  await a.pull('s1');
  assert.deepEqual((await a.list()).map((p) => p.id), ['g']);
});

test('an offline edit of a synced patch survives the next pull and reaches the server', async () => {
  const server = fakeServer();
  const a = device(server.call);
  const { id } = await a.save(DRAFT, {});
  await a.setSync(id, true, 's1');
  await a.setPrefs({ id, on: true, approve: DRAFT });
  server.offline = true;
  await a.replace(id, { css: 'b{color:blue}' }, { approveJs: true });
  assert.equal(server.patches.get(id).css, DRAFT.css, 'the push failed');
  assert.equal((await one(a, id)).dirty, true);
  server.offline = false;
  await a.pull('s1');
  const kept = await one(a, id);
  assert.equal(kept.css, 'b{color:blue}', 'the local edit is kept');
  assert.equal(kept.on, true, 'and stays on');
  assert.equal(kept.dirty, false);
  assert.equal(server.patches.get(id).css, 'b{color:blue}', 'the edit reached the server');
});

test('a merge never overwrites a local copy that is newer than the server one', async () => {
  const server = fakeServer();
  const a = createPatches({ store: memoryStore(), call: server.call, now: () => 1000 });
  const { id } = await a.save(DRAFT, {});
  await a.setSync(id, true, 's1');
  server.patches.set(id, { ...server.patches.get(id), css: 'old{}', updatedAt: 500 });
  await a.pull('s1');
  assert.equal((await one(a, id)).css, DRAFT.css);
});

test('a pattern scope that is empty, invalid or unsafe is never saved, on save or on update', async () => {
  const a = device(async () => []);
  const scoped = (pattern) => ({ ...DRAFT, mask: undefined, pattern });
  await assert.rejects(a.save(scoped('')), /Enter a pattern/);
  await assert.rejects(a.save(scoped('(a+)+$')), /can freeze the browser/);
  await assert.rejects(a.save(scoped('a('.repeat(1))), /not a valid pattern/);
  assert.deepEqual(await a.list(), []);
  const { id } = await a.save(scoped('https://a\\.example/.*'));
  await assert.rejects(a.replace(id, { pattern: '(x|y)*z' }), /can freeze the browser/);
  assert.equal((await one(a, id)).pattern, 'https://a\\.example/.*');
});

test('a scope changed on another device replaces the old one whole: a new mask drops the old pattern', async () => {
  const server = fakeServer();
  const a = device(server.call);
  const b = device(server.call);
  const { id } = await a.save({ ...DRAFT, mask: undefined, pattern: 'https://a\\.example/x' }, {});
  await a.setSync(id, true, 's1');
  await b.pull('s1');
  const { pattern, ...withoutPattern } = server.patches.get(id);
  assert.ok(pattern);
  server.patches.set(id, { ...withoutPattern, mask: 'a.example/y', updatedAt: Date.now() + 1000 });
  await b.pull('s1');
  const merged = await one(b, id);
  assert.equal(merged.mask, 'a.example/y');
  assert.equal('pattern' in merged, false, 'the old pattern would still decide where the code runs');
  server.patches.set(id, { ...withoutPattern, mask: undefined, pattern: 'https://a\\.example/z', updatedAt: Date.now() + 2000 });
  await b.pull('s1');
  assert.deepEqual([(await one(b, id)).pattern, 'mask' in await one(b, id)], ['https://a\\.example/z', false]);
});
