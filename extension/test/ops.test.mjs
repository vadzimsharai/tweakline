import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { addressGuardSource, createOps, guardSource, runPageJs } from '../lib/ops.js';

function fakeChrome({ userScripts }) {
  const calls = { userScripts: [], debugger: [], scripting: [] };
  globalThis.chrome = {
    userScripts: userScripts && { execute: async (options) => { calls.userScripts.push(options); return userScripts(options); } },
    debugger: {
      attach: async () => { calls.debugger.push('attach'); },
      detach: async () => {},
      sendCommand: async (_target, _method, params) => { calls.debugger.push(params.expression); return { result: { value: 'from debugger' } }; },
    },
    scripting: {
      executeScript: async (options) => { calls.scripting.push(options); return [{ result: 'read' }]; },
      insertCSS: async (options) => { calls.scripting.push(options); },
      removeCSS: async (options) => { calls.scripting.push({ removed: options.css, target: options.target }); },
    },
    tabs: { reload: async (tabId) => { calls.reloads = [...(calls.reloads || []), tabId]; } },
  };
  return calls;
}

test('a page error whose text looks like "userScripts disabled" is reported, the code never runs a second time', async () => {
  const calls = fakeChrome({ userScripts: () => [{ error: 'Error: User scripts are disabled by this page' }] });
  await assert.rejects(runPageJs(1, 'throw new Error("User scripts are disabled by this page")'), /User scripts are disabled/);
  assert.equal(calls.userScripts.length, 1);
  assert.deepEqual(calls.debugger, [], 'the debugger was not used');
});

test('an unavailable userScripts API falls back to the debugger once', async () => {
  const calls = fakeChrome({ userScripts: () => { throw new Error('The userScripts API is only available for users in developer mode'); } });
  assert.equal(await runPageJs(1, '1 + 1'), 'from debugger');
  assert.equal(calls.debugger.length, 2);
  const missing = fakeChrome({ userScripts: null });
  assert.equal(await runPageJs(1, '1 + 1'), 'from debugger');
  assert.equal(missing.debugger.length, 2);
});

test('an ordinary failure of userScripts.execute is reported and does not reach the debugger', async () => {
  const calls = fakeChrome({ userScripts: () => { throw new Error('No document with id abc'); } });
  await assert.rejects(runPageJs(1, 'x()', { documentId: 'abc' }), /No document/);
  assert.deepEqual(calls.debugger, []);
});

test('ops run on the document the grant was checked on', async () => {
  const calls = fakeChrome({ userScripts: () => [{ result: 3 }] });
  const ops = createOps({ undoStacks: new Map(), captureAndStore: async () => null, proposePatch: () => null, noteBefore: async () => {} });
  await ops.read({ tabId: 4, documentId: 'doc-1', args: {} });
  await ops.css({ tabId: 4, documentId: 'doc-1', args: { css: 'a{}' } });
  assert.equal((await ops.js({ tabId: 4, documentId: 'doc-1', args: { code: '3' } })).value, 3);
  assert.deepEqual(calls.scripting.map((c) => c.target), [{ tabId: 4, documentIds: ['doc-1'] }, { tabId: 4, documentIds: ['doc-1'] }]);
  assert.deepEqual(calls.userScripts[0].target, { tabId: 4, documentIds: ['doc-1'] });
});

test('the debugger path checks the page against the grants inside the evaluated code', async () => {
  const calls = fakeChrome({ userScripts: null });
  const grants = [{ kind: 'tab', tabId: 4, origin: 'https://a.example' }];
  await runPageJs(4, 'go()', { guard: grants });
  assert.ok(calls.debugger[1].startsWith(guardSource(grants)));
  const run = (href, list) => {
    const url = new URL(href);
    const location = { href: url.href, origin: url.origin, hostname: url.hostname };
    return vm.runInNewContext(`${guardSource(list)}'ran'`, { location });
  };
  assert.equal(run('https://a.example/x', grants), 'ran');
  assert.throws(() => run('https://evil.test/', grants), /not granted/);
  assert.equal(run('https://a.example/p#h', [{ kind: 'page', url: 'https://a.example/p' }]), 'ran');
  assert.throws(() => run('https://a.example/q', [{ kind: 'page', url: 'https://a.example/p' }]), /not granted/);
  assert.equal(run('https://a.example/q', [{ kind: 'site', host: 'a.example' }]), 'ran');
  assert.equal(run('https://a.example/q', [{ kind: 'regexp', pattern: 'https://a\\.example/.*' }]), 'ran');
  assert.throws(() => run('https://evil.test/?https://a.example/', [{ kind: 'regexp', pattern: 'https://a\\.example/.*' }]), /not granted/);
  assert.throws(() => run('https://a.example/', []), /not granted/);
});

test('undo takes only the steps of the session that asks, whatever other sessions left on the tab', async () => {
  const calls = fakeChrome({ userScripts: () => [{ result: 1 }] });
  const ops = createOps({ undoStacks: new Map(), captureAndStore: async () => null, proposePatch: () => null, noteBefore: async () => {} });
  await ops.css({ tabId: 4, documentId: 'd', args: { css: 'a{color:red}' }, session: 'mine' });
  await ops.css({ tabId: 4, documentId: 'd', args: { css: 'b{color:red}' }, session: 'other' });
  assert.deepEqual(await ops.undo({ tabId: 4, documentId: 'd', session: 'mine' }), { undone: true });
  assert.equal(calls.scripting.at(-1).removed, 'a{color:red}', 'its own step, not the newer one of the other session');
  assert.deepEqual(await ops.undo({ tabId: 4, documentId: 'd', session: 'mine' }), { undone: false });
  assert.deepEqual(await ops.undo({ tabId: 4, documentId: 'd' }), { undone: false }, 'no session, no step');
  assert.deepEqual(await ops.undo({ tabId: 4, documentId: 'd', session: 'other' }), { undone: true });
  assert.deepEqual(calls.scripting.at(-1), { removed: 'b{color:red}', target: { tabId: 4, documentIds: ['d'] } });
});

test('undo of JS without undo code tells the page before it reloads', async () => {
  const calls = fakeChrome({ userScripts: () => [{ result: 1 }] });
  const order = [];
  const ops = createOps({ undoStacks: new Map(), captureAndStore: async () => null, proposePatch: () => null, noteBefore: async () => {}, beforeReload: async (tabId) => { order.push(`notice ${tabId}`); } });
  await ops.js({ tabId: 4, documentId: 'd', args: { code: '1' }, session: 's' });
  const realReload = globalThis.chrome.tabs.reload;
  globalThis.chrome.tabs.reload = async (tabId) => { order.push(`reload ${tabId}`); return realReload(tabId); };
  assert.deepEqual(await ops.undo({ tabId: 4, documentId: 'd', session: 's' }), { undone: true, reloaded: true });
  assert.deepEqual(order, ['notice 4', 'reload 4']);
  assert.deepEqual(calls.reloads, [4]);
});

test('the debugger path runs a patch only on the address its scope was checked on', async () => {
  const calls = fakeChrome({ userScripts: null });
  await runPageJs(4, 'go()', { onlyAt: 'https://a.example/x?q' });
  assert.ok(calls.debugger[1].startsWith(addressGuardSource('https://a.example/x?q')));
  const run = (href) => vm.runInNewContext(`${addressGuardSource('https://a.example/x?q')}'ran'`, { location: { href } });
  assert.equal(run('https://a.example/x?q'), 'ran');
  assert.throws(() => run('https://a.example/other'), /page changed/);
  assert.throws(() => run('https://evil.test/'), /page changed/);
});
