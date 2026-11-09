import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSessionLists, sessionRows } from '../lib/sessions.js';

const servers = [{ id: 's1', name: 'one' }, { id: 's2', name: 'two' }];
const ok = (value) => ({ status: 'fulfilled', value });
const down = { status: 'rejected', reason: new Error('down') };

test('a reachable server adds its sessions and drops the ones it no longer has', () => {
  const all = { old: { serverId: 's1', kind: 'browser' }, kept: { serverId: 's1', kind: 'browser', title: 'was' }, other: { serverId: 's2' } };
  const { reachable, gone } = mergeSessionLists(all, servers, [ok([{ id: 'kept', title: 'now' }, { id: 'new' }]), down], 100);
  assert.deepEqual([...reachable], ['s1']);
  assert.deepEqual(gone, ['old']);
  assert.deepEqual(all, {
    kept: { id: 'kept', serverId: 's1', kind: 'browser', title: 'now' },
    new: { id: 'new', serverId: 's1', kind: 'page' },
    other: { serverId: 's2' },
  });
});

test('a session saved after the lists were asked for stays', () => {
  const all = { fresh: { serverId: 's1', savedAt: 200 } };
  const { gone } = mergeSessionLists(all, servers, [ok([]), ok([])], 100);
  assert.deepEqual(gone, []);
  assert.ok(all.fresh);
});

test('a server cannot take over a session of another server or set its kind', () => {
  const all = { mine: { serverId: 's2', kind: 'page' } };
  mergeSessionLists(all, servers, [ok([{ id: 'mine', title: 'stolen' }, { id: 'x', kind: 'browser' }]), down], 100);
  assert.deepEqual(all.mine, { serverId: 's2', kind: 'page' });
  assert.equal(all.x.kind, 'page');
});

test('an answer that is not a list counts as unreachable', () => {
  const all = { a: { serverId: 's1' } };
  const { reachable, gone } = mergeSessionLists(all, servers, [ok({ nope: true }), down], 100);
  assert.equal(reachable.size, 0);
  assert.deepEqual(gone, []);
});

test('sessionRows hides private fields, names the server and marks reachability', () => {
  const sessions = {
    a: { id: 'a', serverId: 's1', addresses: ['x'], savedAt: 1, polling: true },
    b: { id: 'b', serverId: 's2', polling: true },
    c: { id: 'c', serverId: 'gone' },
  };
  assert.deepEqual(sessionRows(sessions, servers, new Set(['s1'])), [
    { id: 'a', serverId: 's1', polling: true, serverName: 'one', unreachable: false },
    { id: 'b', serverId: 's2', polling: false, serverName: 'two', unreachable: true },
  ]);
});
