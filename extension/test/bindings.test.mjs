import test from 'node:test';
import assert from 'node:assert/strict';
import { findOrphanBinding, isTabKey, latestBoundTab, ownBindingFor, pageOf, RESTART_KEY_PREFIX, sameAddress, tabsBoundTo, withRestartKeys } from '../lib/bindings.js';

const bound = (sessionId, url, serverId = 's1') => ({ serverId, sessionId, url });

test('isTabKey and pageOf', () => {
  assert.equal(isTabKey('12'), true);
  assert.equal(isTabKey(`${RESTART_KEY_PREFIX}1-0`), false);
  assert.equal(pageOf('https://a.example/x?q=1#h'), 'https://a.example/x');
  assert.equal(pageOf('not a url'), null);
});

test('tabsBoundTo matches server and session, and skips keys left from a restart', () => {
  const map = { 1: bound('a', 'x'), 2: bound('a', 'x', 's2'), 3: bound('b', 'x'), [`${RESTART_KEY_PREFIX}1-0`]: bound('a', 'x'), 4: null, 5: bound('a', 'y') };
  assert.deepEqual(tabsBoundTo(map, 's1', 'a'), [1, 5]);
  assert.deepEqual(tabsBoundTo(map, 's2', 'a'), [2]);
  assert.deepEqual(tabsBoundTo(map, 's1', 'zzz'), []);
});

test('ownBindingFor drops the binding once the tab is on another site', () => {
  const own = bound('a', 'https://a.example/x');
  assert.equal(ownBindingFor(own, 'https://a.example/other'), own);
  assert.equal(ownBindingFor(own, 'https://b.example/'), null);
  const old = { serverId: 's1', sessionId: 'a' };
  assert.equal(ownBindingFor(old, 'https://b.example/'), old, 'a binding without a url stays');
});

test('findOrphanBinding takes the binding of the same address first, ignoring the hash', () => {
  const map = { 1: bound('a', 'https://a.example/x?a'), 2: bound('b', 'https://a.example/x?b'), 3: bound('c', 'https://a.example/y') };
  assert.deepEqual(findOrphanBinding(map, new Set(), 'https://a.example/x?a#top'), ['1', map[1]]);
  assert.deepEqual(findOrphanBinding(map, new Set(), 'https://a.example/x?b'), ['2', map[2]]);
});

test('findOrphanBinding leaves the binding orphaned when more than one candidate matches', () => {
  const map = { 1: bound('a', 'https://a.example/x?a'), 2: bound('b', 'https://a.example/x?b') };
  assert.equal(findOrphanBinding(map, new Set(), 'https://a.example/x?c'), null, 'two on the same page, neither is the address');
  const twins = { 1: bound('a', 'https://a.example/x'), 2: bound('b', 'https://a.example/x') };
  assert.equal(findOrphanBinding(twins, new Set(), 'https://a.example/x'), null, 'two on the same address');
  assert.deepEqual(findOrphanBinding({ 1: map[1] }, new Set(), 'https://a.example/x?c'), ['1', map[1]], 'the only one on the page');
});

test('findOrphanBinding falls back to the only orphan on the same site', () => {
  const map = { 1: bound('a', 'https://a.example/x'), 2: bound('b', 'https://b.example/') };
  assert.deepEqual(findOrphanBinding(map, new Set(), 'https://a.example/other'), ['1', map[1]]);
  const two = { ...map, 3: bound('c', 'https://a.example/z') };
  assert.equal(findOrphanBinding(two, new Set(), 'https://a.example/other'), null, 'two candidates on the site: none is taken');
});

test('findOrphanBinding never takes the binding of an open tab', () => {
  const map = { 1: bound('a', 'https://a.example/x'), 2: null };
  assert.equal(findOrphanBinding(map, new Set(['1']), 'https://a.example/x'), null);
  assert.equal(findOrphanBinding({ 1: { serverId: 's1', sessionId: 'a' } }, new Set(), 'https://a.example/x'), null, 'no url, no match');
});

test('withRestartKeys keeps the ids that still show their page, as after an extension update', () => {
  const map = { 1: bound('a', 'https://a.example/x'), 2: bound('b', 'https://a.example/y') };
  const open = { 1: 'https://a.example/x', 2: 'https://b.example/' };
  const moved = withRestartKeys(map, 9, (key, b) => sameAddress(open[key], b.url));
  assert.deepEqual(moved, { 1: map[1], [`${RESTART_KEY_PREFIX}9-0`]: map[2] });
});

test('latestBoundTab picks the tab bound last, then the higher id', () => {
  const map = { 9: { ...bound('a', 'x'), boundAt: 100 }, 3: { ...bound('a', 'y'), boundAt: 200 }, 5: bound('b', 'z') };
  assert.equal(latestBoundTab(map, 's1', 'a'), 3);
  assert.equal(latestBoundTab({ 4: bound('a', 'x'), 7: bound('a', 'y') }, 's1', 'a'), 7, 'old bindings without a time');
  assert.equal(latestBoundTab(map, 's1', 'none'), null);
});

test('withRestartKeys renames tab ids, keeps older restart keys and drops empty bindings', () => {
  const older = `${RESTART_KEY_PREFIX}5-0`;
  const map = { 1: bound('a', 'x'), 2: null, 3: bound('b', 'y'), [older]: bound('c', 'z') };
  assert.deepEqual(withRestartKeys(map, 9), { [`${RESTART_KEY_PREFIX}9-0`]: map[1], [`${RESTART_KEY_PREFIX}9-1`]: map[3], [older]: map[older] });
});
