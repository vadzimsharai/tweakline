import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { addressGuardSource, createOps, guardSource, markedCode, runPageJs } from '../lib/ops.js';

const MARK_IN_CODE = /^document\.dispatchEvent\(new CustomEvent\("([^"]+)"\)\);\n/;

// A page the fake APIs act on: which ways of running JS and CSS really take effect there.
function fakeChrome({ userScripts, silentUserScripts = false, silentDebugger = false, debuggerOff = false, userCssApplies = true, sheetApplies = true, script = null }) {
  const calls = { userScripts: [], debugger: [], scripting: [], page: [] };
  const heard = new Set();
  const hear = (code) => { const found = MARK_IN_CODE.exec(code); if (found) heard.add(found[1]); };
  const pageFunctions = {
    armRunMark: () => true,
    takeRunMark: (mark) => heard.has(mark),
    cssMarkComputes: () => userCssApplies,
    adoptSheet: () => sheetApplies,
    dropSheet: () => true,
    evalInPage: (code) => (script ? script(code) : { ok: true, value: `page ran ${code}` }),
  };
  globalThis.chrome = {
    userScripts: userScripts && {
      execute: async (options) => {
        calls.userScripts.push(options);
        const injections = await userScripts(options);
        if (!silentUserScripts && !injections?.[0]?.error) hear(options.js[0].code);
        return injections;
      },
    },
    debugger: {
      attach: async () => { if (debuggerOff) throw new Error('Cannot access this target'); calls.debugger.push('attach'); },
      detach: async () => {},
      sendCommand: async (_target, _method, params) => {
        calls.debugger.push(params.expression);
        if (!silentDebugger) hear(params.expression.slice(params.expression.indexOf('document.dispatchEvent')));
        return { result: { value: 'from debugger' } };
      },
    },
    scripting: {
      executeScript: async (options) => {
        const pageFunction = pageFunctions[options.func.name];
        if (pageFunction) {
          calls.page.push({ name: options.func.name, args: options.args, target: options.target, world: options.world });
          return [{ result: pageFunction(...options.args) }];
        }
        calls.scripting.push(options);
        return [{ result: 'read' }];
      },
      insertCSS: async (options) => { calls.scripting.push(options); },
      removeCSS: async (options) => { calls.scripting.push({ removed: options.css, target: options.target }); },
    },
    tabs: { reload: async (tabId) => { calls.reloads = [...(calls.reloads || []), tabId]; } },
  };
  return calls;
}

const pageCalls = (calls, name) => calls.page.filter((call) => call.name === name);
const newOps = () => createOps({ undoStacks: new Map(), captureAndStore: async () => null, proposePatch: () => null, noteBefore: async () => {} });

test('a page error whose text looks like "userScripts disabled" is reported, the code never runs a second time', async () => {
  const calls = fakeChrome({ userScripts: () => [{ error: 'Error: User scripts are disabled by this page' }] });
  await assert.rejects(runPageJs(1, 'throw new Error("User scripts are disabled by this page")'), /User scripts are disabled/);
  assert.equal(calls.userScripts.length, 1);
  assert.deepEqual(pageCalls(calls, 'evalInPage'), [], 'no page-world run either');
  assert.deepEqual(calls.debugger, [], 'the debugger was not used');
});

test('an unavailable userScripts API runs the code once in the page world through scripting, without the debugger', async () => {
  const calls = fakeChrome({ userScripts: () => { throw new Error('The userScripts API is only available for users in developer mode'); } });
  assert.equal(await runPageJs(1, '1 + 1'), 'page ran 1 + 1');
  assert.equal(pageCalls(calls, 'evalInPage').length, 1);
  assert.deepEqual(calls.debugger, []);
  const missing = fakeChrome({ userScripts: null });
  assert.equal(await runPageJs(1, '1 + 1'), 'page ran 1 + 1');
  assert.equal(pageCalls(missing, 'armRunMark').length, 0, 'nothing to verify without userScripts');
  assert.deepEqual(missing.debugger, []);
});

test('userScripts that answers without running the code (Android) is not taken for a run: scripting runs it in the page world', async () => {
  const calls = fakeChrome({ userScripts: () => [{ result: null }], silentUserScripts: true });
  assert.equal(await runPageJs(1, 'document.title'), 'page ran document.title');
  assert.equal(calls.userScripts.length, 1);
  assert.match(calls.userScripts[0].js[0].code, MARK_IN_CODE, 'the code announces itself first');
  assert.ok(calls.userScripts[0].js[0].code.endsWith('\ndocument.title'));
  assert.equal(pageCalls(calls, 'evalInPage')[0].args[0], 'document.title', 'the page world gets the bare code');
  assert.equal(pageCalls(calls, 'evalInPage')[0].world, 'MAIN');
  assert.deepEqual(calls.debugger, []);
});

test('userScripts that runs the code answers with its value and nothing else runs', async () => {
  const calls = fakeChrome({ userScripts: () => [{ result: 'Title' }] });
  assert.equal(await runPageJs(1, 'document.title'), 'Title');
  assert.deepEqual(pageCalls(calls, 'evalInPage'), []);
  assert.deepEqual(calls.debugger, []);
});

test('an error thrown by the code in the page world is the answer, the debugger does not run it again', async () => {
  const calls = fakeChrome({ userScripts: null, script: () => ({ ok: false, error: 'ReferenceError: nope is not defined' }) });
  await assert.rejects(runPageJs(1, 'nope()'), /nope is not defined/);
  assert.deepEqual(calls.debugger, []);
});

test('a page whose CSP blocks eval runs the code through the debugger, which must announce the run', async () => {
  const blocked = { blocked: "the page's Content-Security-Policy blocks eval" };
  const calls = fakeChrome({ userScripts: null, script: () => blocked });
  assert.equal(await runPageJs(1, 'go()'), 'from debugger');
  assert.match(calls.debugger[1], /^document\.dispatchEvent\(new CustomEvent\("tweakline-ran-[0-9a-f]+"\)\);\ngo\(\)$/);
  fakeChrome({ userScripts: null, script: () => blocked, debuggerOff: true });
  await assert.rejects(runPageJs(1, 'go()'), /JS did not run: the page's Content-Security-Policy blocks eval, and the debugger unavailable/);
  fakeChrome({ userScripts: null, script: () => blocked, silentDebugger: true });
  await assert.rejects(runPageJs(1, 'go()'), /debugger answered without running it/);
});

test('the run mark keeps the value of the code: the code is still the last statement', () => {
  const dispatched = [];
  const context = { document: { dispatchEvent: (event) => dispatched.push(event.type) }, CustomEvent: class { constructor(type) { this.type = type; } } };
  assert.equal(vm.runInNewContext(markedCode('const a = 2; a * 3', 'tweakline-ran-x'), context), 6);
  assert.deepEqual(dispatched, ['tweakline-ran-x']);
});

test('css that the browser applies stays a user style and undo removes exactly it', async () => {
  const calls = fakeChrome({ userScripts: null });
  const ops = newOps();
  assert.deepEqual(await ops.css({ tabId: 4, documentId: 'd', args: { css: 'a{color:red}' }, session: 's' }), { applied: true, via: 'user' });
  const inserted = calls.scripting.find((c) => c.css);
  assert.match(inserted.css, /^:root\{--tweakline-applied-[0-9a-f]+:1\}\na\{color:red\}$/, 'the mark rule goes first');
  assert.deepEqual(pageCalls(calls, 'adoptSheet'), []);
  assert.deepEqual(await ops.undo({ tabId: 4, documentId: 'd', session: 's' }), { undone: true });
  assert.equal(calls.scripting.at(-1).removed, inserted.css);
});

test('css that insertCSS accepts but never applies (Android) goes into an adopted stylesheet, undo drops it', async () => {
  const calls = fakeChrome({ userScripts: null, userCssApplies: false });
  const ops = newOps();
  assert.deepEqual(await ops.css({ tabId: 4, documentId: 'd', args: { css: 'a{color:red}' }, session: 's' }), { applied: true, via: 'sheet' });
  const [adopted] = pageCalls(calls, 'adoptSheet');
  const inserted = calls.scripting.find((c) => c.css);
  assert.equal(adopted.args[1], inserted.css, 'the same CSS with its mark');
  assert.ok(calls.scripting.some((c) => c.removed === inserted.css), 'the ignored user style is taken back');
  assert.deepEqual(adopted.target, { tabId: 4, documentIds: ['d'] });
  assert.deepEqual(await ops.undo({ tabId: 4, documentId: 'd', session: 's' }), { undone: true });
  assert.deepEqual(pageCalls(calls, 'dropSheet').at(-1).args, [adopted.args[0]]);
});

test('css that takes effect in no way is an error, not "applied", and leaves nothing to undo', async () => {
  const calls = fakeChrome({ userScripts: null, userCssApplies: false, sheetApplies: false });
  const ops = newOps();
  await assert.rejects(ops.css({ tabId: 4, documentId: 'd', args: { css: 'a{color:red}' }, session: 's' }), /CSS did not take effect/);
  assert.equal(pageCalls(calls, 'dropSheet').length, 1);
  assert.deepEqual(await ops.undo({ tabId: 4, documentId: 'd', session: 's' }), { undone: false });
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
  assert.ok(calls.page.every((c) => c.target.documentIds[0] === 'doc-1'), 'checks and fallbacks too');
  assert.deepEqual(calls.userScripts[0].target, { tabId: 4, documentIds: ['doc-1'] });
});

test('the debugger path checks the page against the grants inside the evaluated code', async () => {
  const calls = fakeChrome({ userScripts: null, script: () => ({ blocked: "eval blocked" }) });
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
  assert.match(calls.scripting.at(-1).removed, /\na\{color:red\}$/, 'its own step, not the newer one of the other session');
  assert.deepEqual(await ops.undo({ tabId: 4, documentId: 'd', session: 'mine' }), { undone: false });
  assert.deepEqual(await ops.undo({ tabId: 4, documentId: 'd' }), { undone: false }, 'no session, no step');
  assert.deepEqual(await ops.undo({ tabId: 4, documentId: 'd', session: 'other' }), { undone: true });
  assert.match(calls.scripting.at(-1).removed, /\nb\{color:red\}$/);
  assert.deepEqual(calls.scripting.at(-1).target, { tabId: 4, documentIds: ['d'] });
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
  const calls = fakeChrome({ userScripts: null, script: () => ({ blocked: "eval blocked" }) });
  await runPageJs(4, 'go()', { onlyAt: 'https://a.example/x?q' });
  assert.ok(calls.debugger[1].startsWith(addressGuardSource('https://a.example/x?q')));
  const run = (href) => vm.runInNewContext(`${addressGuardSource('https://a.example/x?q')}'ran'`, { location: { href } });
  assert.equal(run('https://a.example/x?q'), 'ran');
  assert.throws(() => run('https://a.example/other'), /page changed/);
  assert.throws(() => run('https://evil.test/'), /page changed/);
});
