import test from 'node:test';
import assert from 'node:assert/strict';
import { checkTabOp, findEndedGrant, grantForTab, grantKey, grantsCovering, isTabGrant, removeLastMatching, tabsCoveredBy, withoutGrant } from '../lib/grants.js';

const SITE = 'https://a.example';
const tabGrant = { kind: 'tab', tabId: 1, origin: SITE, until: null };

test('grantKey ignores key order', () => {
  assert.equal(grantKey({ kind: 'page', url: 'x', until: null }), grantKey({ until: null, url: 'x', kind: 'page' }));
  assert.notEqual(grantKey({ kind: 'page', url: 'x' }), grantKey({ kind: 'page', url: 'y' }));
  assert.equal(isTabGrant(tabGrant), true);
  assert.equal(isTabGrant({ kind: 'site' }), false);
  assert.equal(isTabGrant(undefined), false);
});

test('grantForTab binds a tab grant to the asking tab and its origin, other kinds stay as asked', () => {
  const tab = { id: 7, url: `${SITE}/page?q=1` };
  assert.deepEqual(grantForTab({ kind: 'tab', tabId: 99, until: 5 }, tab), { kind: 'tab', tabId: 7, origin: SITE, until: 5 });
  const site = { kind: 'site', host: 'a.example', until: null };
  assert.equal(grantForTab(site, tab), site);
  assert.throws(() => grantForTab({ kind: 'tab' }, { id: 7, url: 'about:blank' }), /cannot be granted by tab/);
});

test('findEndedGrant finds a run-out grant that would cover the target, once', () => {
  const target = { tabId: 1, url: `${SITE}/x` };
  const ended = { ...tabGrant, until: 50 };
  assert.equal(findEndedGrant([ended], target, 100), ended);
  assert.equal(findEndedGrant([{ ...ended, endNoticed: true }], target, 100), undefined, 'already told');
  assert.equal(findEndedGrant([{ ...ended, until: 200 }], target, 100), undefined, 'still running');
  assert.equal(findEndedGrant([tabGrant], target, 100), undefined, 'never ends');
  assert.equal(findEndedGrant([ended], { tabId: 2, url: `${SITE}/x` }, 100), undefined, 'another tab');
});

test('removeLastMatching removes only the last match and tolerates a missing list', () => {
  const list = [1, 2, 1, 3];
  removeLastMatching(list, (n) => n === 1);
  assert.deepEqual(list, [1, 2, 3]);
  removeLastMatching(list, (n) => n === 9);
  assert.deepEqual(list, [1, 2, 3]);
  assert.doesNotThrow(() => removeLastMatching(undefined, () => true));
});

test('tabsCoveredBy lists only covered tabs, with their public fields', () => {
  const tabs = [{ id: 1, url: `${SITE}/a`, title: 'A', active: true, windowId: 3 }, { id: 2, url: 'https://b.example/', title: 'B', active: false }, { id: 3 }];
  assert.deepEqual(tabsCoveredBy(tabs, [{ kind: 'site', host: 'a.example', until: null }]), [{ id: 1, url: `${SITE}/a`, title: 'A', active: true }]);
  assert.deepEqual(tabsCoveredBy(tabs, []), []);
});

test('checkTabOp: the frame and the tab must be covered', () => {
  const tab = { url: `${SITE}/x` };
  assert.deepEqual(checkTabOp({ grants: [tabGrant], tabId: 1, url: `${SITE}/x`, tab, op: 'read', args: {} }), { allowed: true });
  assert.deepEqual(checkTabOp({ grants: [], tabId: 1, url: `${SITE}/x`, tab, op: 'read', args: {} }), { refused: { tabId: 1, url: `${SITE}/x` } });
  assert.deepEqual(checkTabOp({ grants: [tabGrant], tabId: 1, url: `${SITE}/x`, tab: { url: 'https://b.example/' }, op: 'read', args: {} }), { refused: { tabId: 1, url: `${SITE}/x` } }, 'tab url on another site');
});

test('checkTabOp: a tab loading another site is not acted on', () => {
  const result = checkTabOp({ grants: [tabGrant], tabId: 1, url: `${SITE}/x`, tab: { url: `${SITE}/x`, pendingUrl: 'https://b.example/' }, op: 'read', args: {} });
  assert.match(result.error, /opening another site/);
  const sameSite = checkTabOp({ grants: [tabGrant], tabId: 1, url: `${SITE}/x`, tab: { url: `${SITE}/x`, pendingUrl: `${SITE}/y` }, op: 'read', args: {} });
  assert.deepEqual(sameSite, { allowed: true });
});

test('checkTabOp: navigate needs its destination covered too', () => {
  const base = { grants: [tabGrant], tabId: 1, url: `${SITE}/x`, tab: { url: `${SITE}/x` }, op: 'navigate' };
  assert.deepEqual(checkTabOp({ ...base, args: { url: `${SITE}/y` } }), { allowed: true });
  assert.deepEqual(checkTabOp({ ...base, args: { url: 'https://b.example/' } }), { refused: { tabId: 1, url: 'https://b.example/' } });
});

test('grantsCovering keeps only the grants that cover the target now', () => {
  const page = { kind: 'page', url: `${SITE}/x`, until: null };
  const other = { kind: 'site', host: 'b.example', until: null };
  const expired = { ...tabGrant, until: 10 };
  assert.deepEqual(grantsCovering([tabGrant, page, other, expired], { tabId: 1, url: `${SITE}/x`, now: 100 }), [tabGrant, page]);
});

test('withoutGrant removes the grant by what it is, whatever its place or key order', () => {
  const a = { kind: 'site', host: 'a.example', until: null, always: true };
  const b = { kind: 'site', host: 'b.example', until: null, always: true };
  assert.deepEqual(withoutGrant([a, b], { always: true, until: null, host: 'b.example', kind: 'site' }), [a]);
  assert.deepEqual(withoutGrant([b], a), [b], 'a grant already gone removes nothing else');
});
