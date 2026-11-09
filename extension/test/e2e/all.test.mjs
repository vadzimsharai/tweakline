import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startWorld, startFakeServer, driver, aiClient, DEFAULT_AI_STALE_MS } from './lib.mjs';

let world, d, page;
const open = async (name = 'plain') => { await page.goto(`${world.siteBase}/${name}`); await page.waitForSelector('#badge', { state: 'attached', timeout: 5000 }); await d.wait(150); };
const openRailAndChat = async () => {
  if (!(await d.vis('#rail'))) { await d.tap('#badge'); await d.wait(); }
  if (!(await d.vis('#panel'))) { await d.tap('#rChat'); await d.wait(260); }
};
const mainWidth = () => page.evaluate(() => document.getElementById('main').getBoundingClientRect().width);

const FAILED_PAIR_LIMIT = 11;
const JS_ANSWER_LIMIT_MS = 25000;
const SILENT_SERVER_LIMIT_MS = 6000;
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/AAAMBAQAY3Y2wAAAAAElFTkSuQmCC';
const LOCAL_ADDRESS = '.addr[data-kind=local] .aurl';
const PUBLIC_ADDRESS = '.addr[data-kind=public] .aurl';
const worker = () => world.context.serviceWorkers()[0];
const storedServers = () => worker().evaluate(() => chrome.storage.local.get('servers').then((found) => found.servers || []));
const storedSessions = () => worker().evaluate(() => chrome.storage.local.get('sessions').then((found) => found.sessions || {}));
const fillServerInput = async (value) => {
  await page.locator('#serverInput').fill(value);
  await d.tap('#serverGo');
  await d.wait(350);
};
const openLatestDraft = async () => {
  if (await d.vis('#dlgClose')) { await d.tap('#dlgClose'); await d.wait(); }
  if (!(await d.vis('#rail'))) { await d.tap('#badge'); await d.wait(); }
  await d.tap('#rPatches');
  await d.wait(300);
  await d.tap('[data-draft] >> nth=-1');
  await d.wait(900);
};
const openNewSession = async () => {
  await openRailAndChat();
  await d.tap('#sessBtn');
  await d.wait(250);
  await d.tap('#newSess');
  await d.wait(250);
};
const makeSession = async (kind = 'page') => {
  await d.tap(`[data-kind=${kind}]`);
  await d.wait(250);
};
const openServers = async () => {
  await d.tap('#rMore');
  await d.wait();
  await d.tap('[data-act=servers]');
  await d.wait(300);
};
const openAddServer = async () => {
  await openServers();
  await d.tap('#addServer');
  await d.wait(200);
};
const serverRowOf = (host) => `[data-server-row]:has-text("${host}")`;
const removeOpenServer = async () => {
  await d.tap('[data-unpair]');
  await d.wait(80);
  assert.equal(await d.text('[data-unpair]'), 'Tap again to remove');
  await d.tap('[data-unpair]');
  await d.wait(500);
};
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const joinSessionNamed = async (title) => {
  await d.tap('#sessBtn');
  await d.wait(250);
  for (const row of await page.locator('[data-join]').all()) {
    if ((await row.textContent()).includes(title)) { await row.scrollIntoViewIfNeeded(); const b = await row.boundingBox(); await d.touchAt(b.x + 40, b.y + 10); break; }
  }
  await d.wait(300);
};

before(async () => { world = await startWorld(); d = driver(world); page = world.page; });
after(async () => { await world.close(); });

test('first run: onboarding opens by itself and offers both ways, without a server', async () => {
  const welcome = world.onboarding;
  assert.ok(welcome, 'onboarding tab opened on install');
  await welcome.bringToFront();
  await welcome.waitForLoadState();
  assert.equal(await welcome.locator('#serveCommand').textContent(), 'curl -fLO https://github.com/vadzimsharai/tweakline/releases/latest/download/tweakline-server.js && node tweakline-server.js');
  assert.match(await welcome.locator('#askText').textContent(), /README/);
  assert.equal(await welcome.locator('h1').textContent(), 'Tweakline is installed');
  assert.equal(await welcome.locator('.steps > li').count(), 3);
  await welcome.locator('#copyServe').click();
  await welcome.waitForFunction(() => document.getElementById('copyServe').textContent === 'Copied');
  assert.equal(await welcome.evaluate(() => navigator.clipboard.readText()), 'curl -fLO https://github.com/vadzimsharai/tweakline/releases/latest/download/tweakline-server.js && node tweakline-server.js');
  await welcome.locator('#copyAsk').click();
  assert.match(await welcome.evaluate(() => navigator.clipboard.readText()), /github\.com\/vadzimsharai\/tweakline$/);
  await welcome.waitForFunction(() => document.getElementById('localStatus').textContent !== '');
  assert.match(await welcome.locator('#localStatus').textContent(), /node tweakline-server\.js pair/);
  await welcome.locator('#pairInput').fill('nonsense');
  await welcome.locator('#pairGo').click();
  await welcome.waitForFunction(() => /not a pair link/.test(document.getElementById('pairMsg').textContent));
  await welcome.locator('#pairInput').fill(`${world.relayBase}/pair#wrong`);
  await welcome.locator('#pairGo').click();
  await welcome.waitForFunction(() => /Code not accepted/.test(document.getElementById('pairMsg').textContent));
  await welcome.close();
  await page.bringToFront();
});

test('no server at all: patches save, apply, toggle and delete, sync asks for a server', async () => {
  await open();
  assert.deepEqual(await storedServers(), []);
  const url = page.url();
  await worker().evaluate(async (target) => {
    const [tab] = await chrome.tabs.query({ url: target });
    await chrome.tabs.sendMessage(tab.id, { to: 'ui', type: 'proposePatch', proposal: { title: 'No panel', desc: 'Local', css: '#side{display:none}' } });
  }, url);
  await d.wait(900);
  assert.equal(await d.vis('#pTitle'), false, 'a proposal does not open the save sheet by itself');
  await openLatestDraft();
  assert.equal(await page.locator('#pTitle').inputValue(), 'No panel');
  await d.tap('[data-w=site]');
  assert.equal(await page.locator('#pAuto.on').count(), 0, 'an AI proposal does not apply on open unless the person says so');
  await page.locator('#pAuto').scrollIntoViewIfNeeded();
  await d.tap('#pAuto');
  await d.tap('#pYes');
  await d.wait(500);
  assert.equal(await d.count('.pc'), 1);
  await d.tap('.popen');
  await d.wait(150);
  await d.tap('.syncTog');
  await d.wait(250);
  assert.match(await d.text('#toast'), /Connect a server first/);
  assert.equal(await page.locator('.syncTog').getAttribute('aria-pressed'), 'false');
  await d.tap('#dlgClose');
  await open();
  assert.equal(await page.locator('#side').isVisible(), false);
  await d.tap('#badge');
  await d.wait();
  await d.tap('#rPatches');
  await d.wait(300);
  await d.tap('.pc .tog');
  await d.wait(300);
  assert.equal(await page.locator('#side').isVisible(), true);
  await d.tap('.pc .tog');
  await d.wait(300);
  assert.equal(await page.locator('#side').isVisible(), false);
  await d.tap('.popen');
  await d.wait(150);
  await d.tap('.del');
  await d.wait(100);
  await d.tap('.del');
  await d.wait(300);
  assert.equal(await d.count('.pc'), 0);
  await d.tap('#dlgClose');
  await open();
  assert.equal(await page.locator('#side').isVisible(), true);
});

test('servers sheet without servers: an empty state, the local server offers Add server with a hint', async () => {
  await open();
  await d.tap('#badge');
  await d.wait();
  await openServers();
  assert.match(await d.text('#noServers'), /To talk to an AI, add one/);
  assert.equal(await d.count('[data-server-row]'), 0);
  assert.equal(await d.vis('#addServer'), true);
  await d.tap('#localConnect');
  await d.wait(300);
  assert.ok((await d.text('#foundLocal')).includes(world.relayBase));
  assert.equal(await d.vis('#serverInput'), true);
  assert.match(await d.text('#over .dbody'), /Ask your AI.*Or run it yourself/s);
  await d.tap('#dlgBack');
  await d.wait(300);
  assert.match(await d.text('.dhead h2'), /Servers/);
  await d.tap('#dlgClose');
});

test('pairing: Connect AI goes straight to Add server, wrong and used codes fail, a link returns to the flow', async () => {
  await open();
  await openRailAndChat();
  assert.equal(await d.text('#sessCard h3'), 'Connect an AI to chat');
  await d.tap('#connectBtn');
  await d.wait(300);
  assert.ok((await d.text('#foundLocal')).includes(world.relayBase));
  assert.match(await d.text('#foundLocal'), /node tweakline-server\.js pair/);
  assert.equal(await d.count('[data-kind]'), 0);
  await fillServerInput(`${world.relayBase}/pair#wrong`);
  assert.match(await d.text('#serverMsg'), /Code not accepted/);
  assert.deepEqual(await storedServers(), []);
  await fillServerInput(new URL(world.relayBase).host);
  assert.match(await d.text('#serverMsg'), /Found server.*node tweakline-server\.js pair/);
  assert.deepEqual(await storedServers(), []);
  await fillServerInput('nothing-here.invalid');
  assert.match(await d.text('#serverMsg'), /No Tweakline server found/);
  const link = world.pairLink();
  await fillServerInput(link);
  await d.wait(200);
  assert.equal(await d.text('.dhead h2'), 'What should the AI work with?');
  assert.equal(await d.vis('[data-kind=page]'), true);
  assert.equal(await d.count('#serverPick'), 0, 'a single server is not shown');
  const [saved] = await storedServers();
  assert.equal(saved.baseUrl, world.relayBase);
  assert.ok(saved.deviceToken && saved.deviceId);
  await d.tap('#dlgClose');
  await d.wait();
  await openAddServer();
  await fillServerInput(link);
  assert.match(await d.text('#serverMsg'), /Code not accepted/);
  assert.equal((await storedServers()).length, 1);
  assert.equal((await storedServers())[0].deviceToken, saved.deviceToken);
  await d.tap('#dlgClose');
});

test('session addresses: a row per address, copy, curl reads instructions, the AI still needs a grant', async () => {
  await open();
  await openNewSession();
  await makeSession();
  const local = await d.text(LOCAL_ADDRESS);
  const external = await d.text(PUBLIC_ADDRESS);
  assert.ok(local.startsWith(`${world.relayBase}/s/`));
  assert.ok(external.startsWith(`${world.publicBase}/s/`));
  assert.equal(new URL(local).pathname, new URL(external).pathname, 'one token serves all addresses');
  await d.tap('#copyAddress');
  await d.wait(120);
  assert.equal(await d.text('#copyAddress'), 'Copied');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), external);
  // Must stay async: the relay under test lives in this process and a sync child would deadlock it.
  const { stdout: read } = await promisify(execFile)('curl', ['-s', local], { encoding: 'utf8' });
  assert.match(read, /curl/);
  assert.match(read, /\/s\//);
  const ai = aiClient(local);
  assert.deepEqual(await ai.act('read'), { ok: false, error: 'not granted' });
  await d.tap('#dlgClose');
  await d.tap('#sessBtn');
  await d.wait(250);
  assert.equal((await d.text('.row.on')).includes(new URL(world.relayBase).host), false, 'one server: no server name');
  assert.match(await d.text('.row.on .rsub'), /Waiting for AI, this page/);
  assert.equal(await d.text('.row.on .rmeta'), 'Now');
  await d.tap('.row.on [data-addr]');
  await d.wait(200);
  assert.equal(await d.text(LOCAL_ADDRESS), local);
  assert.equal(await d.count('.addr'), 2);
  assert.deepEqual(await page.locator('.dbody .clabel').allTextContents(), ['Public', 'This computer only']);
  assert.equal(await page.locator('.addr').first().getAttribute('data-kind'), 'public');
  await d.tap('#dlgBack');
  await d.wait(250);
  await worker().evaluate(async () => {
    const { sessions } = await chrome.storage.local.get('sessions');
    for (const entry of Object.values(sessions)) delete entry.addresses;
    await chrome.storage.local.set({ sessions });
  });
  await d.tap('.row.on [data-addr]');
  await d.wait(250);
  const minted = await d.text(LOCAL_ADDRESS);
  assert.notEqual(minted, local, 'without a saved address the server mints a new one');
  assert.equal((await fetch(minted)).status, 200);
  await d.tap('[data-revoke]');
  await d.wait(80);
  await d.tap('[data-revoke].armed');
  await d.wait(500);
  assert.equal((await fetch(local)).status, 404);
  assert.equal((await fetch(minted)).status, 404);
  assert.equal(await d.text('#sessName'), 'No AI');
  await d.tap('#dlgClose');
});

test('badge: size, bottom position, fade after 5 s, rail never fades', async () => {
  await open();
  const b = await d.box('#badge');
  assert.deepEqual([b.width, b.height], [16, 38]);
  assert.ok(b.y > world.height * 0.6);
  await d.wait(5400);
  assert.equal(await page.locator('#badge').evaluate((e) => getComputedStyle(e).opacity), '0.42');
  await d.tap('#badge');
  await d.wait(5600);
  assert.equal(await page.locator('#rail').evaluate((e) => getComputedStyle(e).opacity), '1');
  const r = await d.box('#rail');
  assert.ok(r.y + r.height <= world.height);
});

test('chat lies over the page and never changes its layout', async () => {
  await open();
  const w0 = await mainWidth();
  await openRailAndChat();
  assert.equal(await mainWidth(), w0);
  const p = await d.box('#panel');
  assert.equal(Math.round(p.x + p.width), world.width);
  const expected = Math.min(world.width - 60, Math.max(360, world.width * 0.6));
  assert.ok(Math.abs(p.width - expected) < 2);
  const r = await d.box('#rail');
  assert.equal(Math.round(r.x + r.width), Math.round(p.x));
});

test('swipes: chat body hides chat without leaving the page, rail opens and collapses', async () => {
  await open();
  await openRailAndChat();
  const url = page.url();
  const m = await d.box('#msgs');
  await d.swipe(m.x + 30, m.y + m.height / 2, world.width - 2, m.y + m.height / 2);
  assert.equal(page.url(), url);
  assert.equal(await d.vis('#panel'), false);
  assert.equal(await d.vis('#rail'), true);
  const r = await d.box('#rail');
  await d.swipe(r.x + 30, r.y + 60, r.x - 50, r.y + 60, 5);
  assert.equal(await d.vis('#panel'), true);
  await d.tap('#collapse');
  await d.wait(300);
  const r2 = await d.box('#rail');
  await d.swipe(r2.x + 10, r2.y + 40, world.width - 2, r2.y + 40, 5);
  assert.equal(await d.vis('#rail'), false);
  assert.equal(await d.vis('#badge'), true);
  const b = await d.box('#badge');
  await d.swipe(b.x + 14, b.y + 15, b.x - 130, b.y + 15, 6);
  assert.equal(await d.vis('#panel'), true);
});

test('header gestures change position, width grip widens, full keeps rail in the header', async () => {
  await open();
  await openRailAndChat();
  let h = await d.box('.ph');
  await d.swipe(h.x + 60, h.y + 20, h.x + 60, h.y + 170, 10);
  assert.match(await d.cls('#panel'), /sheet/);
  h = await d.box('.ph');
  await d.swipe(h.x + 60, h.y + 20, h.x + 60, 50, 12);
  assert.match(await d.cls('#panel'), /full/);
  const more = await d.box('#rMore'), full = await d.box('#fullBtn');
  assert.ok(Math.abs((more.y + more.height / 2) - (full.y + full.height / 2)) < 0.6);
  assert.ok(more.x + more.width <= full.x);
  await d.tap('#fullBtn');
  await d.wait(150);
  assert.match(await d.cls('#panel'), /sheet/);
  await d.tap('#posBtn');
  await d.wait(80);
  await d.tap('[data-pos=column]');
  await d.wait(150);
  assert.match(await d.cls('#panel'), /column/);
  const w0 = (await d.box('#panel')).width;
  const g = await d.box('#cwGrip');
  await d.swipe(g.x + 10, g.y + g.height / 2, g.x - 40, g.y + g.height / 2, 6);
  assert.ok((await d.box('#panel')).width - w0 > 30);
});

test('hostile page keeps the UI clickable and on top', async () => {
  await open('hostile');
  await d.tap('#badge');
  await d.wait();
  assert.equal(await d.vis('#rail'), true);
  await d.tap('#rChat');
  await d.wait(260);
  assert.equal(await d.vis('#panel'), true);
  await d.tap('#connectBtn');
  await d.wait(250);
  assert.equal(await d.vis('[data-kind=page]'), true);
  await d.tap('#dlgClose');
});

test('extension hide state shows and hides everything', async () => {
  await open();
  const sw = world.context.serviceWorkers()[0];
  await sw.evaluate(() => chrome.storage.local.set({ hidden: false }));
  await d.tap('#badge');
  await d.wait();
  await d.tap('#rMore');
  await d.wait();
  await d.tap('[data-act=hide]');
  await d.wait(200);
  assert.equal(await d.vis('#badge'), false);
  await sw.evaluate(() => globalThis.tweaklineToggle());
  await d.wait(250);
  assert.equal(await d.vis('#rail'), true);
});

test('markdown renders no raw html and drops javascript links', async () => {
  const html = await world.context.serviceWorkers()[0].evaluate(() => 1);
  assert.equal(html, 1);
  await open();
  await openRailAndChat();
  await d.tap('#connectBtn');
  await d.wait(200);
  await makeSession();
  const url = await d.text(LOCAL_ADDRESS);
  const ai = aiClient(url);
  await ai.say('<img src=x onerror=alert(1)> **bold** `code` [bad](javascript:alert(1)) [good](https://a.example/)\n```\n<b>x</b>\n```');
  await d.wait(250);
  if (await d.vis('#dlgClose')) await d.tap('#dlgClose');
  const last = page.locator('#msgs .m .md').last();
  assert.equal(await last.locator('img').count(), 0);
  assert.equal(await last.locator('b').first().textContent(), 'bold');
  assert.equal(await last.locator('a').count(), 1);
  assert.equal(await last.locator('a').getAttribute('href'), 'https://a.example/');
  assert.equal(await last.locator('pre code').textContent(), '<b>x</b>');
  await page.evaluate(() => 0);
});

let sessionUrl;
test('session: AI names it, access is required and enforced, history is separate', async () => {
  await open();
  await openRailAndChat();
  await d.tap('#sessBtn');
  await d.wait(200);
  await d.tap('#newSess');
  await d.wait(200);
  await makeSession();
  sessionUrl = await d.text(LOCAL_ADDRESS);
  const ai = aiClient(sessionUrl);
  assert.match(await ai.instructions(), /curl/);
  const denied = await ai.act('read');
  assert.deepEqual(denied, { ok: false, error: 'not granted' });
  await ai.name('Header edits', 'test-ai');
  await d.wait(200);
  assert.equal(await d.text('#sessName'), 'Header edits');
  await ai.say('Need access', { ask: { access: true } });
  await d.wait(250);
  if (await d.vis('#dlgClose')) { await d.tap('#dlgClose'); await d.wait(); }
  await d.tap('.askYes >> nth=-1');
  await d.wait(250);
  const read = await ai.act('read');
  assert.equal(read.ok, true);
  assert.equal(read.data.title, 'Plain');
  const feed = await ai.events(0, 0);
  assert.ok(feed.events.some((e) => e.type === 'access'));
  assert.equal(JSON.stringify(feed).includes('tabId'), false);
  const clicked = await ai.act('click', { target: 'css:#go' });
  assert.equal(clicked.ok, true);
  assert.equal(await page.title(), 'clicked');
  assert.deepEqual(await ai.act('tabs'), { ok: false, error: 'this op needs a whole-browser session' });
  await ai.act('css', { css: '#side{display:none}', note: 'hide' });
  await d.wait(120);
  assert.equal(await page.locator('#side').isVisible(), false);
  const undone = await ai.act('undo');
  assert.equal(undone.data.undone, true);
  assert.equal(await page.locator('#side').isVisible(), true);
  await d.wait(100);
  await page.locator('#ta').fill('привет');
  await d.tap('#shotBtn');
  await d.tap('#send');
  await d.wait(350);
  const after = await ai.events(0, 0);
  const said = after.events.find((e) => e.type === 'user' && e.data.text === 'привет');
  assert.ok(said);
  await d.tap('#shotBtn');
  const started = Date.now();
  const broken = await ai.act('js', { code: 'return 1' });
  assert.equal(broken.ok, false);
  assert.ok(Date.now() - started < JS_ANSWER_LIMIT_MS, `answered after ${Date.now() - started} ms`);
  assert.equal((await ai.act('js', { code: '(() => { return 2; })()' })).data.value, 2);
  const stuckStart = Date.now();
  const stuck = await ai.act('js', { code: 'window.wgStuck = new Promise(() => {})' });
  assert.equal(stuck.ok, false);
  assert.match(stuck.error, /did not finish/);
  assert.ok(Date.now() - stuckStart < JS_ANSWER_LIMIT_MS, `answered after ${Date.now() - stuckStart} ms`);
});

test('session: grant by tab follows the tab, a new session starts without rights', async () => {
  const ai = aiClient(sessionUrl);
  await page.goto(`${world.siteBase}/csp`);
  await page.waitForSelector('#badge', { state: 'attached' });
  await d.wait(200);
  assert.equal((await ai.act('read')).data.title, 'Csp');
  await open();
  await openRailAndChat();
  await d.tap('#sessBtn');
  await d.wait(200);
  await d.tap('#newSess');
  await d.wait(200);
  await makeSession('browser');
  const other = aiClient(await d.text(LOCAL_ADDRESS));
  assert.deepEqual(await other.act('read'), { ok: false, error: 'not granted' });
  assert.equal((await other.act('tabs')).ok, true);
  assert.deepEqual((await other.act('tabs')).data, []);
  await other.name('Whole browser', 'other');
  await d.wait(150);
  assert.equal(await d.count('#msgs .me'), 0);
  await d.tap('#sessBtn');
  await d.wait(250);
  assert.ok((await d.count('[data-join]')) >= 2);
  await d.tap('#dlgClose');
});

test('notes: rail stretches down, marking hides the UI, two-touch shapes, handles, edit, delete', async () => {
  await open();
  if (!(await d.vis('#rail'))) { await d.tap('#badge'); await d.wait(); }
  if (await d.vis('#panel')) { await d.tap('#collapse'); await d.wait(300); }
  await d.tap('#sessBtn').catch(() => {});
  await d.tap('#rNotes');
  await d.wait(250);
  const n = await d.box('#rNotes'), first = await d.box('#extNotes [data-tool=arrow]');
  assert.ok(first.y > n.y && Math.abs(first.x - n.x) < 3);
  const r = await d.box('#rail');
  assert.ok(r.y + r.height <= world.height);
  await d.tap('#extNotes [data-tool=arrow]');
  await d.wait(350);
  assert.equal(await d.vis('#rail'), false);
  assert.equal(await d.vis('#badge'), true);
  const ringed = await page.locator('#stage').evaluate((e) => e.classList.contains('marking'));
  assert.equal(ringed, true);
  await d.touchAt(world.width * 0.6, 300);
  assert.equal(await d.vis('#noteBox'), false);
  assert.equal(await d.vis('#firstTouchDot'), true);
  await d.down(world.width * 0.4, 260);
  await d.wait(50);
  assert.equal(await d.vis('#loupe canvas'), true);
  await d.move(world.width * 0.25, 230);
  await d.up();
  await d.wait(150);
  assert.equal(await d.vis('#noteBox'), true);
  assert.equal(await d.count('.hdl.live'), 2);
  await page.keyboard.type('here');
  await page.keyboard.press('Enter');
  await d.wait(150);
  assert.equal(await d.text('#rNotes .cnt'), '1');
  assert.equal(await d.text('tweakline-marks .pin'), '1');
  assert.equal(await d.vis('#rail'), true);
  assert.equal(await d.vis('#extNotes'), true);

  await d.tap('#extNotes [data-tool=rect]');
  await d.wait(300);
  await d.touchAt(40, 420);
  await d.down(world.width * 0.5, 500);
  await d.up();
  await d.wait(150);
  assert.equal(await d.count('tweakline-marks .marksvg rect'), 1);
  await d.tap('#noteCancel');
  await d.wait(120);
  assert.equal(await d.count('tweakline-marks .marksvg rect'), 0);
  assert.equal(await d.text('#rNotes .cnt'), '1');

  if (!(await d.vis('#extNotes'))) { await d.tap('#rNotes'); await d.wait(200); }
  await d.tap('#extNotes [data-tool=point]');
  await d.wait(300);
  const tap = [world.width * 0.3, 560];
  await d.down(...tap);
  await d.wait(40);
  await d.move(tap[0] + 20, tap[1] - 14);
  await d.up();
  await d.wait(150);
  const pin2 = await d.box('tweakline-marks .pin >> nth=1');
  assert.ok(Math.abs(pin2.x + pin2.width / 2 - (tap[0] + 20)) < 3);
  await page.keyboard.press('Backspace');
  await d.wait(40);
  assert.equal(await d.vis('#noteBox'), true);
  await page.keyboard.press('Backspace');
  await d.wait(120);
  assert.equal(await d.vis('#noteBox'), false);
  assert.equal(await d.text('#rNotes .cnt'), '1');

  const p0 = await d.box('tweakline-marks .pin');
  const path0 = await page.locator('tweakline-marks .marksvg path').getAttribute('d');
  await d.swipe(p0.x + 12, p0.y + 12, p0.x - 18, p0.y + 52, 6);
  const p1 = await d.box('tweakline-marks .pin');
  assert.equal(Math.round(p1.y - p0.y), 40);
  assert.notEqual(await page.locator('tweakline-marks .marksvg path').getAttribute('d'), path0);
  await d.touchAt(p1.x + 12, p1.y + 12);
  await d.wait(150);
  assert.equal(await d.vis('#noteBox'), true);
  const hb = await d.box('tweakline-marks .hdl.live[data-handle=b]');
  const path1 = await page.locator('tweakline-marks .marksvg path').getAttribute('d');
  await d.swipe(hb.x + 9, hb.y + 9, hb.x + 40, hb.y + 50, 6);
  assert.notEqual(await page.locator('tweakline-marks .marksvg path').getAttribute('d'), path1);
  assert.equal(await d.vis('#noteBox'), true);
  await page.keyboard.type(' too');
  await page.keyboard.press('Enter');
  await d.wait(120);
  assert.equal(await d.text('tweakline-marks .mlabel'), 'here too');
});

test('notes: badge cancels marking, survive reload, hide on another url', async () => {
  if (!(await d.vis('#extNotes'))) { await d.tap('#rNotes'); await d.wait(200); }
  await d.tap('#extNotes [data-tool=point]');
  await d.wait(300);
  await d.tap('#badge');
  await d.wait(120);
  assert.equal(await page.locator('#stage').evaluate((e) => e.classList.contains('marking')), false);
  await page.reload();
  await page.waitForSelector('#badge', { state: 'attached' });
  await d.wait(400);
  assert.equal(await d.count('tweakline-marks .pin'), 1);
  await page.evaluate(() => history.pushState({}, '', '/plain?other=1'));
  await d.wait(1300);
  assert.equal(await d.count('tweakline-marks .pin'), 0);
  await page.evaluate(() => history.back());
  await d.wait(1300);
  assert.equal(await d.count('tweakline-marks .pin'), 1);
});

test('notes: send goes as one event with a screenshot', async () => {
  await open();
  const ai = aiClient(sessionUrl);
  await d.tap('#badge').catch(() => {});
  await d.wait();
  await d.tap('#rChat');
  await d.wait(260);
  await d.tap('#sessBtn');
  await d.wait(250);
  const rows = await page.locator('[data-join]').all();
  for (const row of rows) if ((await row.textContent()).includes('Header edits')) { const b = await row.boundingBox(); await d.touchAt(b.x + 40, b.y + 10); break; }
  await d.wait(300);
  if (await d.vis('#collapse')) { await d.tap('#collapse'); await d.wait(300); }
  await d.tap('#rNotes');
  await d.wait(200);
  await d.tap('#extList');
  await d.wait(200);
  await page.locator('#notesComment').fill('fix this');
  await d.tap('#notesSend');
  await d.wait(800);
  const { events } = await ai.events(0, 0);
  const sent = events.find((e) => e.type === 'user' && e.data.notes?.length);
  assert.ok(sent);
  assert.equal(sent.data.text, 'fix this');
  assert.equal(sent.data.notes[0].text, 'here too');
  assert.equal(sent.data.files.length, 2, 'a clean screenshot and one with the notes');
  const file = await ai.file(sent.data.files[0].id);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.equal(await d.text('#rNotes .cnt'), '0');
  assert.equal(await d.count('tweakline-marks .pin'), 0, 'sent notes leave the page');
});

const LONG_CAPTION = 'the label near the right edge stays visible';
const SIZES = { unfolded: { width: 724, height: 746 }, folded: { width: 360, height: 740 } };
const shoot = (name) => (process.env.WG_SHOTS ? page.screenshot({ path: `${process.env.WG_SHOTS}/${name}.png` }) : null);
const drawNote = async (tool, from, to, caption) => {
  if (!(await d.vis('#rail'))) { await d.tap('#badge'); await d.wait(); }
  if (await d.vis('#collapse')) { await d.tap('#collapse'); await d.wait(300); }
  if (!(await d.vis('#extNotes'))) { await d.tap('#rNotes'); await d.wait(200); }
  await d.tap(`#extNotes [data-tool=${tool}]`);
  await d.wait(300);
  if (from) await d.touchAt(...from);
  await d.down(...to);
  await d.wait(40);
  await d.up();
  await d.wait(150);
  await page.keyboard.type(caption);
  await page.keyboard.press('Enter');
  await d.wait(150);
};
test('notes: a caption near the right edge flips and stays inside the viewport', async () => {
  try {
    for (const size of Object.values(SIZES)) {
      await page.setViewportSize(size);
      await open(`plain?labels=${size.width}`);
      await drawNote('arrow', [size.width - 40, 220], [size.width - 140, 360], LONG_CAPTION);
      const label = await d.box('tweakline-marks .mlabel');
      const pin = await d.box('tweakline-marks .pin');
      assert.ok(label.x >= 0 && label.x + label.width <= size.width, `${size.width}: label x ${label.x} w ${label.width}`);
      assert.ok(label.y >= 0 && label.y + label.height <= size.height, `${size.width}: label y ${label.y} h ${label.height}`);
      assert.ok(label.x + label.width <= pin.x + pin.width / 2, `${size.width}: flipped to the left of the dot`);
      assert.ok(label.y + label.height <= pin.y + pin.height / 2, `${size.width}: above, off the arrow going down`);
      await shoot(`label-edge-${size.width}`);
      await page.evaluate(() => window.scrollBy(0, 160));
      await d.wait(150);
      const scrolled = await d.box('tweakline-marks .mlabel');
      assert.ok(scrolled.y >= 0 && scrolled.x + scrolled.width <= size.width, `${size.width}: inside after a scroll`);
    }
  } finally {
    await page.setViewportSize({ width: world.width, height: world.height });
  }
});

test('notes: quick send from the rail sends without opening the chat and hides the button', async () => {
  const ai = aiClient(sessionUrl);
  try {
    for (const size of Object.values(SIZES)) {
      await page.setViewportSize(size);
      await open(`plain?quick=${size.width}`);
      await openRailAndChat();
      await joinSessionNamed('Header edits');
      if (await d.vis('#collapse')) { await d.tap('#collapse'); await d.wait(300); }
      await d.tap('#rNotes');
      await d.wait(200);
      assert.equal(await d.vis('#extSend'), false);
      const before = (await ai.events(0, 0)).events.length;
      await drawNote('point', null, [size.width / 2, 300], 'quick');
      assert.equal(await d.vis('#extSend'), true);
      assert.equal(await d.text('#extSend .cnt'), '1');
      const rail = await d.box('#rail');
      assert.ok(rail.y + rail.height <= size.height, `${size.width}: rail fits with the send button`);
      await shoot(`rail-send-${size.width}`);
      await d.tap('#extSend');
      await page.waitForFunction(() => /Notes sent/.test(document.querySelector('tweakline-root').shadowRoot.querySelector('#toast').textContent), null, { timeout: 8000 });
      await shoot(`sent-toast-${size.width}`);
      const { events } = await ai.events(0, 0);
      const sent = events.slice(before).filter((e) => e.type === 'user');
      assert.equal(sent.length, 1);
      assert.equal(sent[0].data.notes.length, 1);
      assert.equal(sent[0].data.notes[0].text, 'quick');
      assert.ok(!sent[0].data.text);
      assert.equal(sent[0].data.files.length, 2, 'a clean screenshot and one with the notes');
      assert.equal(await d.vis('#panel'), false);
      assert.equal(await d.vis('#extSend'), false);
      assert.equal(await d.text('#rNotes .cnt'), '0');
      assert.equal(await d.count('tweakline-marks .pin'), 0, 'sent notes leave the page');
      await ai.say('Got the notes');
      await d.wait(600);
      assert.equal(await d.text('#rChat .cnt'), '1');
      assert.equal(await d.vis('#panel'), false);
    }
  } finally {
    await page.setViewportSize({ width: world.width, height: world.height });
  }
});

const openNotesList = async () => {
  if (await d.vis('#dlgClose')) { await d.tap('#dlgClose'); await d.wait(); }
  if (!(await d.vis('#rail'))) { await d.tap('#badge'); await d.wait(); }
  if (!(await d.vis('#extNotes'))) { await d.tap('#rNotes'); await d.wait(200); }
  await d.tap('#extList');
  await d.wait(250);
};
const openSentNotes = async () => {
  await openNotesList();
  await d.tap('#sentNotes');
  await d.wait(250);
};
test('notes: sent notes are kept in history, show on page again, clear removes unsent ones', async () => {
  try {
    for (const size of Object.values(SIZES)) {
      await page.setViewportSize(size);
      await open(`plain?quick=${size.width}`);
      assert.equal(await d.count('tweakline-marks .pin'), 0);
      await openSentNotes();
      assert.equal(await d.text('.dhead h2'), 'Sent notes');
      const own = '.hgroup:has-text("this page")';
      assert.match(await d.text(`${own} .rtitle`), /quick/);
      const other = Object.values(SIZES).find((s) => s !== size);
      const foreign = `.hgroup:has-text("quick=${other.width}")`;
      if (await d.count(foreign)) assert.equal(await d.count(`${foreign} [data-show]`), 0, 'another page cannot be shown here');
      await shoot(`sent-notes-${size.width}`);
      await d.tap(`${own} [data-show]`);
      await d.wait(250);
      assert.equal(await d.count('#over.on'), 0);
      assert.equal(await d.count('tweakline-marks .pin'), 1);
      assert.equal(await d.text('tweakline-marks .mlabel'), 'quick');
      assert.equal(await d.text('#rNotes .cnt'), '0', 'shown notes are not unsent');
      await openSentNotes();
      assert.equal(await d.text(`${own} [data-show]`), 'Hide from page');
      await d.tap(`${own} [data-show]`);
      await d.wait(250);
      assert.equal(await d.count('tweakline-marks .pin'), 0);
      await d.tap(`${own} [data-forget]`);
      await d.wait(80);
      assert.equal(await d.text(`${own} [data-forget]`), 'Tap again to delete');
      await d.tap(`${own} [data-forget]`);
      await d.wait(300);
      assert.equal(await d.count(own), 0);

      await d.tap('#dlgClose');
      await d.wait();
      await drawNote('point', null, [size.width / 3, 260], 'one');
      await drawNote('point', null, [size.width / 3, 420], 'two');
      assert.equal(await d.count('tweakline-marks .pin'), 2);
      await openNotesList();
      await d.tap('#notesClear');
      await d.wait(80);
      assert.equal(await d.text('#notesClear'), 'Tap again to clear');
      assert.equal(await d.count('tweakline-marks .pin'), 2, 'one tap clears nothing');
      await shoot(`clear-armed-${size.width}`);
      await d.tap('#notesClear');
      await d.wait(250);
      assert.equal(await d.count('tweakline-marks .pin'), 0);
      assert.equal(await d.text('#rNotes .cnt'), '0');
      assert.equal(await d.count('#notesClear'), 0);
      await d.tap('#dlgClose');
      await d.wait();
    }
  } finally {
    await page.setViewportSize({ width: world.width, height: world.height });
  }
});

test('media: shot goes to the gallery, viewer fits, swipe closes, video records', async () => {
  await open();
  if (!(await d.vis('#rail'))) { await d.tap('#badge'); await d.wait(); }
  if (await d.vis('#panel')) { await d.tap('#collapse'); await d.wait(300); }
  await d.tap('#rMedia');
  await d.wait(220);
  assert.equal(await d.vis('#extMedia'), true);
  assert.equal(await d.vis('#extNotes'), false);
  await d.tap('#mShot');
  await d.wait(600);
  assert.equal(await d.vis('#toast'), true);
  assert.match(await d.text('#toast b'), /Screenshot/);
  await d.tap('.toastThumb');
  await d.wait(200);
  const v = await d.box('#viewer .vshot');
  assert.ok(v.y >= 0 && v.y + v.height <= world.height && v.x >= 0 && v.x + v.width <= world.width);
  assert.ok(v.width > 100);
  await d.swipe(v.x + v.width / 2, v.y + v.height / 2, v.x + v.width / 2, v.y + v.height / 2 + 160, 6);
  assert.equal(await d.vis('#viewer'), false);
  if (!(await d.vis('#extMedia'))) { await d.tap('#rMedia'); await d.wait(200); }
  await d.tap('#mVideo');
  await d.wait(1500);
  assert.equal(await d.vis('#rail'), false);
  assert.equal(await d.vis('#recTime'), true);
  await page.evaluate(() => { document.body.style.background = '#cde'; });
  await d.wait(400);
  await d.tap('#badge');
  await d.wait(900);
  assert.equal(await d.vis('#rail'), true);
  assert.match(await d.text('#toast b'), /Video/);
  const ext = await extensionPage();
  try {
    const { data: stored } = await ext.call('media.list');
    const video = stored.filter((m) => m.kind === 'video').sort((a, b) => b.at - a.at)[0];
    const duration = await page.evaluate((src) => new Promise((resolve) => {
      const player = document.createElement('video');
      player.onloadedmetadata = () => resolve(player.duration);
      player.onerror = () => resolve(-1);
      player.src = src;
    }), video.dataUrl);
    assert.ok(Number.isFinite(duration) && duration > 1, `a still page records a playable video with a duration, got ${duration}`);
  } finally { await ext.close(); }
  if (!(await d.vis('#extMedia'))) { await d.tap('#rMedia'); await d.wait(200); }
  await d.tap('#mGallery');
  await d.wait(250);
  assert.ok((await d.count('.gt')) >= 2);
  assert.equal(await d.count('.gt .vb'), 1);
  await d.tap('.gt >> nth=0');
  await d.tap('.gt >> nth=1');
  await d.wait(80);
  assert.equal(await d.count('.gt.sel'), 2);
  const zoom = await d.box('.gz');
  const svg = await d.box('.gz svg');
  assert.ok(Math.abs((zoom.x + zoom.width / 2) - (svg.x + svg.width / 2)) < 1);
  await d.tap('#gIns');
  await d.wait(250);
  assert.equal(await d.count('#chips .att'), 2);
  await d.tap('#chips .att .x');
  await d.wait(60);
  assert.equal(await d.count('#chips .att'), 1);
  await page.locator('#ta').fill('look');
  await d.tap('#send');
  await d.wait(700);
  assert.equal(await d.count('#chips .att'), 0);
  const { events } = await aiClient(sessionUrl).events(0, 0);
  const media = events.filter((e) => e.type === 'user' && e.data.text === 'look');
  assert.equal(media[0].data.files.length, 1);
});

test('gallery and notes open as sheets with a close icon, no Close button and no inline styles', async () => {
  await open();
  if (!(await d.vis('#rail'))) { await d.tap('#badge'); await d.wait(); }
  if (await d.vis('#panel')) { await d.tap('#collapse'); await d.wait(300); }
  if (!(await d.vis('#extMedia'))) { await d.tap('#rMedia'); await d.wait(200); }
  await d.tap('#mGallery');
  await d.wait(250);
  assert.equal(await d.count('.dlg.sheet'), 1);
  assert.equal(await d.text('.dhead h2'), 'Screenshots and video');
  assert.equal(await d.count('#over [style]'), 0);
  assert.equal(await page.locator('#over button', { hasText: /^Close$/ }).count(), 0);
  assert.equal(await page.locator('#gIns').isDisabled(), true);
  const firstIsVideo = (await d.count('.gwrap >> nth=0 >> .vb')) === 1;
  await d.tap('.gt >> nth=0');
  await d.wait(80);
  assert.equal(await page.locator('#gIns').isDisabled(), false);
  assert.equal(await d.text('#gIns'), 'To chat (1)');
  assert.equal(await d.vis('#gCopy'), !firstIsVideo);
  await d.tap('#dlgClose');
  await d.wait();
  assert.equal(await d.count('#over.on'), 0);
  if (!(await d.vis('#extNotes'))) { await d.tap('#rNotes'); await d.wait(200); }
  await d.tap('#extList');
  await d.wait(250);
  assert.equal(await d.count('.dlg.sheet'), 1);
  assert.equal(await d.text('.dhead h2'), 'Notes');
  assert.equal(await d.count('#over [style]'), 0);
  assert.equal(await page.locator('#over button', { hasText: /^Close$/ }).count(), 0);
  await d.tap('#dlgClose');
  await d.wait();
  assert.equal(await d.count('#over.on'), 0);
});

test('patches: propose, per-site cards, auto on reopen, switch off, js needs approval, csp', async () => {
  await open();
  const ai = aiClient(sessionUrl);
  assert.equal((await ai.act('css', { css: '#side{display:none}' })).ok, true);
  await d.wait(200);
  assert.equal((await ai.act('proposePatch', { title: 'No side panel', desc: 'Hides the panel', css: '#side{display:none}', js: "document.title='patched'" })).ok, true);
  await d.wait(900);
  assert.equal(await d.vis('#pTitle'), false, 'a proposal does not open the save sheet by itself');
  assert.ok(await d.count('#msgs [data-save-draft]') >= 1, 'the chat offers a save button');
  await openLatestDraft();
  assert.equal(await page.locator('#pTitle').inputValue(), 'No side panel');
  await d.tap('[data-w=site]');
  await page.locator('#pAuto').scrollIntoViewIfNeeded();
  await d.tap('#pAuto');
  await d.tap('#pYes');
  await d.wait(500);
  assert.equal(await d.count('.pc'), 1);
  assert.match(await d.text('.pc .rsub'), /OK to run its code/);
  await d.tap('#dlgClose');
  await open();
  assert.equal(await page.locator('#side').isVisible(), false);
  assert.notEqual(await page.title(), 'patched');
  await d.tap('#badge').catch(() => {});
  await d.wait();
  await d.tap('#rPatches');
  await d.wait(300);
  assert.equal(await d.vis('.approve'), true);
  await d.tap('.approve');
  await d.wait(120);
  await d.tap('#jsYes');
  await d.wait(300);
  await d.tap('#dlgClose');
  await open();
  assert.equal(await page.title(), 'patched');
  await d.tap('#badge').catch(() => {});
  await d.wait();
  await d.tap('#rPatches');
  await d.wait(300);
  await d.tap('.pc .tog');
  await d.wait(300);
  assert.equal(await page.locator('#side').isVisible(), true);
  await d.tap('#dlgClose');
  await page.goto(`${world.siteBase}/csp`);
  await page.waitForSelector('#badge', { state: 'attached', timeout: 5000 });
  await d.wait(200);
  assert.equal(await d.vis('#badge'), true);
  const csp = await ai.act('css', { css: '#t{color:rgb(1,2,3)}' });
  assert.equal(csp.ok, true);
  await d.wait(100);
  assert.equal(await page.locator('#t').evaluate((e) => getComputedStyle(e).color), 'rgb(1, 2, 3)');
});

test('patch preview: compares only the same view, shows the changed place, stays sharp', async () => {
  await open();
  const ai = aiClient(sessionUrl);
  const propose = async (args) => {
    assert.equal((await ai.act('proposePatch', { title: 'Preview', css: '#side{color:red}', ...args })).ok, true);
    await d.wait(900);
    assert.equal(await d.vis('#pTitle'), false, 'a proposal does not open the save sheet by itself');
    await openLatestDraft();
  };
  assert.equal((await ai.act('css', { css: '#side{outline:3px solid red}' })).ok, true);
  await d.wait(300);
  await propose({});
  assert.equal(await d.count('.dbody>.cmp'), 1);
  const hiddenWhileShooting = await page.evaluate(async () => {
    const r = document.querySelector('tweakline-root').shadowRoot;
    const stageEl = r.querySelector('#stage');
    stageEl.classList.add('shooting');
    await new Promise((resolve) => setTimeout(resolve, 260));
    const seen = getComputedStyle(stageEl).opacity === '0' ? [] : ['#stage'];
    stageEl.classList.remove('shooting');
    return seen;
  });
  assert.deepEqual(hiddenWhileShooting, [], 'no part of Tweakline gets into a screenshot');
  await d.tap('#pNo');
  await page.evaluate(() => history.pushState({}, '', '/plain?elsewhere'));
  await d.wait(120);
  await propose({ focus: '#side' });
  assert.equal(await d.count('.dbody>.cmp'), 0);
  assert.equal(await d.count('.pshot img'), 1);
  const sharp = await page.locator('.pshot img').evaluate(async (img) => { await img.decode(); return img.naturalWidth; });
  const full = await page.evaluate(() => innerWidth * devicePixelRatio);
  assert.ok(sharp >= 280 && sharp < full, `preview ${sharp} of ${full}: the changed place, not the whole page`);
  await d.tap('#pNo');
});

test('switching a JS patch off runs its undo, and reloads the page when it has none', async () => {
  await open();
  const ai = aiClient(sessionUrl);
  const save = async (title, args) => {
    assert.equal((await ai.act('proposePatch', { title, mask: `${new URL(page.url()).host}/*`, ...args })).ok, true);
    await d.wait(900);
    assert.equal(await d.vis('#pTitle'), false, 'a proposal does not open the save sheet by itself');
    await openLatestDraft();
    await page.locator('#pJs').scrollIntoViewIfNeeded();
    await d.tap('#pJs');
    await d.tap('#pYes');
    await d.wait(500);
  };
  await save('Undoable', { js: "document.body.dataset.undoable='on'", undo: "delete document.body.dataset.undoable" });
  await d.tap('#dlgClose');
  assert.equal((await ai.act('proposePatch', { title: 'Undoable', mask: `${new URL(page.url()).host}/*`, js: "document.body.dataset.undoable='on'", undo: "delete document.body.dataset.undoable" })).ok, true);
  await d.wait(900);
  assert.equal(await d.vis('#pTitle'), false, 'a proposal does not open the save sheet by itself');
  await openLatestDraft();
  assert.equal(await d.vis('#pReplacing'), true);
  assert.equal(await d.text('#pYes'), 'Update patch');
  await page.locator('#pJs').scrollIntoViewIfNeeded();
  await d.tap('#pJs');
  await d.tap('#pYes');
  await d.wait(500);
  assert.equal(await page.locator('.pc', { hasText: 'Undoable' }).count(), 1, 'updated, not added');
  await d.tap('#dlgClose');
  await page.evaluate(() => { document.body.dataset.undoable = 'on'; });
  await d.tap('#badge').catch(() => {});
  await d.wait();
  await d.tap('#rPatches');
  await d.wait(300);
  const rowOf = (title) => page.locator('.pc', { hasText: title });
  await d.tap(`.pc:has-text("Undoable") .pon`);
  await d.wait(400);
  assert.equal(await page.evaluate(() => document.body.dataset.undoable ?? null), null);
  await d.tap('#dlgClose');
  await save('No undo', { js: "document.body.dataset.noundo='on'" });
  await page.evaluate(() => { document.body.dataset.noundo = 'on'; window.wgBeforeReload = true; });
  await d.tap(`.pc:has-text("No undo") .pon`);
  await page.waitForFunction(() => !window.wgBeforeReload, null, { timeout: 5000 });
  await page.waitForSelector('#badge', { state: 'attached', timeout: 5000 });
  assert.equal(await page.evaluate(() => document.body.dataset.noundo ?? null), null);
  assert.ok(rowOf);
  await d.wait(300);
  if (await d.vis('#rPatches')) {
    await d.tap('#rPatches');
    await d.wait(300);
    for (const title of ['Undoable', 'No undo']) {
      await d.tap(`.pc:has-text("${title}") .popen`);
      await d.wait(150);
      await d.tap('.del');
      await d.wait(80);
      await d.tap('.del');
      await d.wait(300);
    }
    await d.tap('#dlgClose');
  }
});

test('a keyboard moves the rail up only while it is open', async () => {
  await open();
  await page.setViewportSize({ width: 724, height: 746 });
  await d.wait(200);
  if (!(await d.vis('#rail'))) { await d.tap('#badge'); await d.wait(); }
  if (await d.vis('#panel')) { await d.tap('#collapse'); await d.wait(300); }
  const grab = await d.box('#rail');
  const drop = 746 - grab.height - 40 - grab.y;
  await d.swipe(grab.x + grab.width / 2, grab.y + grab.height / 2, grab.x + grab.width / 2, grab.y + grab.height / 2 + drop, 12);
  await d.wait(250);
  const moved = (await d.box('#rail')).y;
  assert.ok(Math.abs(moved - (grab.y + drop)) < 24, `the rail moved to ${moved}, wanted ${grab.y + drop} from ${grab.y}`);
  const before = (await d.box('#rail')).y;
  await page.setViewportSize({ width: 724, height: 380 });
  await d.wait(300);
  const squeezed = await d.box('#rail');
  assert.ok(squeezed.y + squeezed.height <= 380, `rail fits the short screen: ${squeezed.y}+${squeezed.height}`);
  await page.setViewportSize({ width: 724, height: 746 });
  await d.wait(300);
  assert.ok(Math.abs((await d.box('#rail')).y - before) < 3, `rail is back where it was: ${before} -> ${(await d.box('#rail')).y}`);
  await d.tap('#rMedia');
  await d.wait(400);
  await d.tap('#rMedia');
  await d.wait(400);
  assert.ok(Math.abs((await d.box('#rail')).y - before) < 3, `rail is back after the camera extension closes: ${before} -> ${(await d.box('#rail')).y}`);
});

test('access for every session works in a new session and can be revoked', async () => {
  const first = await chatSession('Always first');
  await first.say('Need access', { ask: { access: true } });
  await d.wait(300);
  await d.tap('.ask [data-k=site] >> nth=-1');
  await d.tap('.ask [data-i="4"] >> nth=-1');
  await d.tap('.askYes >> nth=-1');
  await d.wait(300);
  assert.equal((await first.act('read')).ok, true);
  const second = await chatSession('Always second');
  assert.equal((await second.act('read')).ok, true, 'a new session already has access');
  await d.tap('#rMore');
  await d.wait();
  await d.tap('[data-act=access]');
  await d.wait(250);
  assert.equal(await d.count('.grant.always'), 1);
  await d.tap('[data-always]');
  await d.wait(250);
  assert.equal(await d.count('.grant.always'), 0);
  await d.tap('#dlgClose');
  assert.deepEqual(await second.act('read'), { ok: false, error: 'not granted' });
});

test('photo and file pickers attach, page clicks still work right after a tap', async () => {
  const ai = await chatSession('Pickers');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/AAAMBAQAY3Y2wAAAAAElFTkSuQmCC', 'base64');
  await page.locator('#pickMedia').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: png });
  await page.locator('#pickFile').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await page.waitForFunction(() => document.querySelector('tweakline-root').shadowRoot.querySelectorAll('#chips .att').length === 2, null, { timeout: 5000 });
  assert.equal(await d.text('#chips .attfile'), 'notes.txt');
  await d.tap('#send');
  await d.wait(800);
  const { events } = await ai.events(0, 0);
  const sent = events.filter((e) => e.type === 'user').pop();
  assert.equal(sent.data.files.length, 2);
  assert.deepEqual(sent.data.files.map((f) => f.type), ['image/png', 'text/plain']);
  assert.equal(sent.data.files[1].name, 'notes.txt');
  assert.equal(await (await ai.file(sent.data.files[1].id)).text(), 'hello');

  await page.evaluate(() => { window.wgPageClicks = 0; document.addEventListener('click', () => { window.wgPageClicks += 1; }); });
  await d.tap('#fullBtn');
  await page.evaluate(() => document.body.click());
  assert.equal(await page.evaluate(() => window.wgPageClicks), 1, 'clicks made by the page or the AI still work right after a tap');
  await d.tap('#fullBtn');
  await d.wait(300);
});

test('a desktop-layout page on a phone keeps the UI at its real size and working', async () => {
  await open('desktop');
  const scale = await page.evaluate(() => window.visualViewport.scale);
  assert.ok(scale < 0.9, `scale ${scale}`);
  const b = await d.box('#badge');
  assert.ok(b.width * scale > 12 && b.width * scale < 20, `badge ${b.width} x ${scale}`);
  await d.tap('#badge');
  await d.wait();
  assert.equal(await d.vis('#rail'), true);
  const shot = await d.box('#rNotes');
  assert.ok(shot.width * scale > 30);
  const r = await d.box('#rail');
  assert.ok((r.y + r.height) * scale <= world.height + 2);
});

let secondRelay;
test('two servers at once: an open address needs confirmation, each session talks to its own server', async () => {
  secondRelay = await world.addRelay(world.openHost);
  await open();
  await openRailAndChat();
  await openAddServer();
  const before = (await storedServers()).length;
  await fillServerInput(secondRelay.pairLink());
  assert.match(await d.text('#openWarn'), /open address/);
  assert.equal((await storedServers()).length, before);
  await d.tap('#openNo');
  await d.wait(200);
  assert.equal(await d.vis('#serverInput'), true);
  await fillServerInput(secondRelay.pairLink());
  await d.tap('#openYes');
  await d.wait(500);
  assert.equal((await storedServers()).length, before + 1);
  assert.equal(await d.count('[data-server-row]'), before + 1);
  await d.tap(serverRowOf(secondRelay.host));
  await d.wait(300);
  assert.match(await d.text('#openNote'), /no encryption/);
  await d.tap('#dlgClose');
  await d.wait(100);
  await d.tap('#sessBtn');
  await d.wait(250);
  await d.tap('#newSess');
  await d.wait(250);
  assert.match(await d.text('#serverPick'), new RegExp(`Server: ${secondRelay.host}`), 'the just added server is the default');
  await d.tap('#serverPick');
  await d.wait(120);
  assert.equal(await d.count('[data-server]'), before + 1);
  assert.ok((await d.text('[data-server].on')).includes(secondRelay.host));
  await d.tap('#dlgBack');
  await d.wait(120);
  await makeSession();
  const onSecond = aiClient(await d.text(LOCAL_ADDRESS));
  await onSecond.name('Second server', 'ai-2');
  await d.wait(200);
  assert.equal(await d.text('#sessName'), 'Second server');
  assert.equal(await d.vis('#over'), false, 'the sheet closes when the AI connects');

  await joinSessionNamed('Header edits');
  assert.equal(await d.text('#sessName'), 'Header edits');
  const onFirst = aiClient(sessionUrl);
  await onFirst.say('from the first server');
  await onSecond.say('from the second server');
  await d.wait(400);
  assert.equal(await page.locator('#msgs .m .md', { hasText: 'from the first server' }).count(), 1);
  assert.equal(await page.locator('#msgs .m .md', { hasText: 'from the second server' }).count(), 0);

  await d.tap('#sessBtn');
  await d.wait(250);
  const rows = (await page.locator('[data-join]').allTextContents()).join('\n');
  assert.ok(rows.includes(secondRelay.host), 'row names the second server');
  assert.ok(rows.includes(new URL(world.relayBase).host), 'row names the first server');
  await d.tap('#dlgClose');
  await d.wait(100);
  await joinSessionNamed('Second server');
  assert.equal(await page.locator('#msgs .m .md', { hasText: 'from the second server' }).count(), 1);
  assert.equal(await page.locator('#msgs .m .md', { hasText: 'from the first server' }).count(), 0);
  await page.locator('#ta').fill('to the second');
  await d.tap('#send');
  await d.wait(350);
  assert.ok((await onSecond.events(0, 0)).events.some((e) => e.type === 'user' && e.data.text === 'to the second'));
  assert.equal((await aiClient(sessionUrl).events(0, 0)).events.some((e) => e.type === 'user' && e.data.text === 'to the second'), false);
});

test('a server down: a marked row, the rest of the UI keeps working, the server can be removed', async () => {
  await secondRelay.stop();
  await open();
  await d.wait(400);
  assert.equal(await d.text('#sessName'), 'Second server', 'a tab on a dead server keeps its session');
  await openRailAndChat();
  await d.tap('#sessBtn');
  await d.wait(400);
  assert.equal(await d.text('#serversDown .rmain'), "1 server can't be reached");
  assert.equal((await page.locator('[data-join]').allTextContents()).join('\n').includes('Second server'), false);
  assert.ok((await d.count('[data-join]')) >= 1, 'sessions of the live server stay listed');
  assert.equal(await d.vis('#newSess'), true);
  await d.tap('#newSess');
  await d.wait(300);
  assert.equal(await d.count('#serverOff'), 0, 'the default is a server that is online');
  assert.equal(await page.locator('[data-kind=page]').isEnabled(), true);
  await d.tap('#serverPick');
  await d.wait(120);
  await d.tap(`[data-server]:has-text("${secondRelay.host}")`);
  await d.wait(120);
  assert.match(await d.text('#serverOff'), /can't be reached/);
  assert.equal(await page.locator('[data-kind=page]').isEnabled(), false);
  await d.tap('#openServers');
  await d.wait(300);
  assert.match(await d.text(serverRowOf(secondRelay.host)), /Can't be reached/);
  await d.tap('#dlgBack');
  await d.wait(300);
  assert.equal(await d.text('.dhead h2'), 'What should the AI work with?');
  await d.tap('#dlgClose');
  await d.wait(100);
  await d.tap('#rPatches');
  await d.wait(300);
  assert.equal(await d.vis('[role=dialog][aria-label=Patches]'), true);
  await d.tap('#dlgClose');
  await d.tap('#sessBtn');
  await d.wait(400);
  await d.tap('#serversDown');
  await d.wait(300);
  await d.tap(serverRowOf(secondRelay.host));
  await d.wait(300);
  await removeOpenServer();
  assert.equal(await d.count(serverRowOf(secondRelay.host)), 0);
  assert.equal((await storedServers()).length, 1);
  assert.equal(Object.values(await storedSessions()).some((s) => s.title === 'Second server'), false);
  await d.tap('#dlgClose');
});

test('a misbehaving paired server cannot act through a session of another server', async () => {
  const fake = await startFakeServer();
  await open();
  await openRailAndChat();
  await openAddServer();
  await fillServerInput(fake.pairLink);
  await d.wait(200);
  const [foreignId] = Object.entries(await storedSessions()).filter(([, s]) => s.title === 'Header edits').map(([id]) => id);
  assert.ok(foreignId);
  const answer = await fake.forge(foreignId, 'read');
  assert.deepEqual([answer.ok, answer.error], [false, 'unknown session']);
  fake.setSessions([{ id: foreignId, kind: 'browser', title: 'Spoofed', lastAt: 1 }]);
  await d.tap('#dlgClose');
  await d.wait(100);
  await openServers();
  fake.setSilent(true);
  const silentStart = Date.now();
  await d.tap(serverRowOf(new URL(fake.base).host));
  await page.waitForFunction(() => document.querySelector('tweakline-root').shadowRoot.querySelector('#serverCheck'), null, { timeout: SILENT_SERVER_LIMIT_MS });
  assert.ok(Date.now() - silentStart < SILENT_SERVER_LIMIT_MS, `detail after ${Date.now() - silentStart} ms`);
  fake.setSilent(false);
  await d.tap('#dlgClose');
  await d.wait(100);
  await d.tap('#sessBtn');
  await d.wait(300);
  const stored = (await storedSessions())[foreignId];
  assert.equal(stored.title, 'Header edits');
  assert.deepEqual([(await fake.forge(foreignId, 'read')).error], ['unknown session']);
  await joinSessionNamed('Header edits').catch(() => {});
  await d.wait(100);
  const before = await page.locator('#msgs .m .md').count();
  fake.send({ type: 'event', session: foreignId, event: { seq: 9999, type: 'ai', at: Date.now(), data: { text: 'forged' } } });
  await d.wait(250);
  assert.equal(await page.locator('#msgs .m .md').count(), before);
  const hellosBefore = fake.hellos();
  fake.revokeDevice();
  await d.wait(2600);
  assert.equal(fake.hellos(), hellosBefore, 'a revoked device does not reconnect by itself');
  await d.tap('#sessBtn');
  await d.wait(400);
  await d.tap('#serversDown');
  await d.wait(300);
  const fakeRow = serverRowOf(new URL(fake.base).host);
  assert.match(await d.text(fakeRow), /connect it again/);
  await fake.stop();
  await d.tap(fakeRow);
  await d.wait(300);
  await removeOpenServer();
  assert.equal((await storedServers()).length, 1);
  await d.tap('#dlgClose');
});

test('relay restart: the extension reconnects and queued messages arrive once', async () => {
  await open();
  const ai = aiClient(sessionUrl);
  await openRailAndChat();
  await d.tap('#sessBtn');
  await d.wait(250);
  for (const row of await page.locator('[data-join]').all()) {
    if ((await row.textContent()).includes('Header edits')) { const b = await row.boundingBox(); await d.touchAt(b.x + 40, b.y + 10); break; }
  }
  await d.wait(300);
  await world.restartRelay();
  await d.wait(300);
  await page.locator('#ta').fill('');
  await ai.say('after restart');
  await d.wait(3500);
  assert.equal(await page.locator('#msgs .m .md', { hasText: 'after restart' }).count(), 1);
  await page.reload();
  await page.waitForSelector('#badge', { state: 'attached' });
  await d.wait(500);
  await openRailAndChat();
  assert.equal(await page.locator('#msgs .m .md', { hasText: 'after restart' }).count(), 1);
});

test('service worker stopped by the browser: the next action wakes it', async () => {
  await open();
  const browserSession = await world.context.browser()?.newBrowserCDPSession?.();
  const stopper = browserSession || world.cdp;
  await stopper.send('ServiceWorker.enable').catch(() => {});
  await stopper.send('ServiceWorker.stopAllWorkers').catch(() => {});
  await d.wait(400);
  await d.tap('#badge').catch(() => {});
  await d.wait();
  await d.tap('#rPatches');
  await d.wait(600);
  assert.equal(await d.vis('[role=dialog][aria-label=Patches]'), true);
  await d.tap('#dlgClose');
});

test('a session can be revoked from its detail and its link dies', async () => {
  await open();
  await openRailAndChat();
  await d.tap('#sessBtn');
  await d.wait(250);
  await d.tap('#newSess');
  await d.wait(200);
  await makeSession();
  const url = await d.text(LOCAL_ADDRESS);
  assert.equal((await fetch(url)).status, 200);
  await d.tap('#dlgClose');
  await d.wait(80);
  await d.tap('#sessBtn');
  await d.wait(300);
  const rows = await d.count('[data-join]');
  assert.equal(await d.count('#over [data-revoke]'), 0, 'nothing destructive next to a row');
  await d.tap('.row.on [data-addr]');
  await d.wait(200);
  await d.tap('[data-revoke]');
  await d.wait(80);
  assert.equal(await d.text('[data-revoke]'), 'Tap again to delete');
  assert.match(await d.cls('[data-revoke]'), /armed/);
  assert.equal((await fetch(url)).status, 200, 'one tap deletes nothing');
  await d.tap('[data-revoke]');
  await d.wait(900);
  assert.equal(await d.count('[data-join]'), rows - 1);
  assert.equal((await fetch(url)).status, 404);
  assert.equal(await d.text('#sessName'), 'No AI');
  await d.tap('#dlgClose');
});

test('rail menu: sessions, servers, AI access, gestures, hotkeys, hide', async () => {
  await open();
  await openRailAndChat();
  await joinSessionNamed('Header edits');
  await d.tap('#rMore');
  await d.wait();
  assert.deepEqual(await page.locator('#wmenu button').allTextContents(), ['Sessions', 'Servers', 'AI access', 'Gestures', 'Hotkeys', 'Hide Tweakline']);
  await d.tap('[data-act=access]');
  await d.wait(200);
  assert.equal(await d.text('.dhead h2'), 'AI access');
  assert.ok((await d.count('.dbody .row')) >= 1);
  assert.equal(await d.text('#grantsOff'), 'Revoke all');
  for (const [act, title] of [['gest', 'Gestures'], ['keys', 'Hotkeys']]) {
    await d.tap('#dlgClose');
    await d.wait();
    await d.tap('#rMore');
    await d.wait();
    await d.tap(`[data-act=${act}]`);
    await d.wait(200);
    assert.equal(await d.text('.dhead h2'), title);
    assert.ok((await d.count('.dbody ul.gest li')) >= 7);
  }
  await d.tap('#dlgClose');
});

test('servers sheet: reachable from the rail menu with status, add, detail, check again, remove', async () => {
  const extra = await world.addRelay();
  await open();
  await openRailAndChat();
  await openServers();
  assert.equal(await d.text('.dhead h2'), 'Servers');
  assert.equal(await d.count('#dlgBack'), 0);
  const firstRow = serverRowOf(new URL(world.relayBase).host);
  assert.match(await d.text(firstRow), /Connected, \d+ sessions?/);
  assert.equal(await d.count(`${firstRow} .rdot.ok`), 1);
  await d.tap('#addServer');
  await d.wait(250);
  assert.equal(await d.vis('#dlgBack'), true);
  assert.equal(await d.text('#over .field span'), 'Link from your server');
  await fillServerInput(extra.pairLink());
  await d.wait(300);
  assert.equal(await d.text('.dhead h2'), 'Servers', 'adding returns to where it came from');
  assert.match(await d.text(serverRowOf(extra.host)), /Connected, no sessions/);
  await d.tap(serverRowOf(extra.host));
  await d.wait(300);
  assert.equal(await d.text('.dhead h2'), extra.host);
  assert.ok((await d.text('dl.info')).includes(extra.base));
  assert.match(await d.text('#serverStatus'), /Connected/);
  assert.equal(await d.text('#serverSessions'), '0');
  await d.tap('#serverSessionsOpen');
  await d.wait(250);
  assert.match(await d.text('.dhead h2'), /^Sessions on /);
  assert.equal(await d.count('[data-join]'), 0);
  await d.tap('#dlgBack');
  await d.wait(250);
  assert.equal(await d.vis('#serverCheck'), true);
  assert.match(await d.text('.dfoot .note'), /Sessions on this server will end in this browser/);
  await extra.stop();
  await d.wait(200);
  await d.tap('#serverCheck');
  await d.wait(400);
  assert.equal(await d.text('#serverCheck'), 'Checking…', 'the check stays visible for a moment');
  await page.waitForFunction(() => /Can't be reached/.test(document.querySelector('tweakline-root').shadowRoot.querySelector('#serverStatus')?.textContent), null, { timeout: 8000 });
  assert.equal(await d.text('#serverCheck'), 'Check again');
  await d.tap('#dlgBack');
  await d.wait(300);
  assert.equal(await d.count(`${serverRowOf(extra.host)} .rdot.warn`), 1);
  await d.tap(serverRowOf(extra.host));
  await d.wait(300);
  await removeOpenServer();
  assert.equal(await d.text('.dhead h2'), 'Servers');
  assert.equal(await d.count(serverRowOf(extra.host)), 0);
  await d.tap('#dlgClose');
});

test('connect AI flow: step by step, back removes the unused session and restores the old one', async () => {
  await open();
  await openRailAndChat();
  await joinSessionNamed('Header edits');
  const sessionsBefore = Object.keys(await storedSessions()).length;
  await d.tap('#sessBtn');
  await d.wait(250);
  await d.tap('#newSess');
  await d.wait(250);
  assert.equal(await d.text('.dhead h2'), 'What should the AI work with?');
  assert.deepEqual(await page.locator('.opt .rtitle').allTextContents(), ['This page', 'Whole browser']);
  await d.tap('#dlgBack');
  await d.wait(250);
  assert.equal(await d.text('.dhead h2'), 'Sessions');
  await d.tap('#newSess');
  await d.wait(250);
  await makeSession('browser');
  assert.equal(await d.text('.dhead h2'), 'Send this address to your AI');
  assert.equal(await d.text('#copyAddress'), 'Copy address');
  assert.match(await d.text('#aiWait'), /Waiting for your AI/);
  assert.equal(await d.text('.dbody .sect'), 'This computer only');
  assert.equal(Object.keys(await storedSessions()).length, sessionsBefore + 1);
  const abandonedLocal = await d.text(LOCAL_ADDRESS);
  await d.tap('#dlgBack');
  await d.wait(500);
  assert.equal(await d.text('.dhead h2'), 'What should the AI work with?');
  assert.equal(Object.keys(await storedSessions()).length, sessionsBefore);
  assert.equal((await fetch(abandonedLocal)).status, 404);
  assert.equal(await d.text('#sessName'), 'Header edits');
  await d.tap('#dlgClose');
});

test('connect AI flow: the sheet closes and the chat opens when the AI connects', async () => {
  await open();
  await d.tap('#badge');
  await d.wait();
  await d.tap('#rMore');
  await d.wait();
  await d.tap('[data-act=sessions]');
  await d.wait(250);
  await d.tap('#newSess');
  await d.wait(250);
  await makeSession();
  const ai = aiClient(await d.text(LOCAL_ADDRESS));
  assert.equal(await d.vis('#aiWait'), true);
  assert.equal(await d.vis('#panel'), false);
  await ai.events(0, 0);
  await d.wait(300);
  assert.equal(await d.vis('#over'), false);
  assert.equal(await d.vis('#panel'), true);
  assert.notEqual(await d.text('#sessName'), 'No AI');
});

test('closing the waiting sheet keeps the session, and the AI connecting later does not open the chat', async () => {
  await open();
  await openRailAndChat();
  await d.tap('#sessBtn');
  await d.wait(250);
  await d.tap('#newSess');
  await d.wait(250);
  await makeSession();
  const ai = aiClient(await d.text(LOCAL_ADDRESS));
  await d.tap('#dlgClose');
  await d.wait(100);
  await d.tap('#collapse');
  await d.wait(300);
  await ai.events(0, 0);
  await d.wait(300);
  assert.equal(await d.vis('#panel'), false);
  assert.equal(await d.vis('#over'), false);
});

test('a sheet leaves the rail visible: tapping the rail closes it, so does a swipe down on the handle', async () => {
  await open();
  await openRailAndChat();
  await d.tap('#collapse');
  await d.wait(300);
  await d.tap('#rMore');
  await d.wait();
  await d.tap('[data-act=sessions]');
  await d.wait(300);
  assert.equal(await d.vis('#rail'), true);
  assert.equal(overlaps(await d.box('.dlg.sheet'), await d.box('#rail')), false);
  const rail = await d.box('#rail');
  await d.touchAt(rail.x + rail.width / 2, rail.y + 4);
  await d.wait(120);
  assert.equal(await d.vis('#over'), false);
  await d.tap('#rMore');
  await d.wait();
  await d.tap('[data-act=sessions]');
  await d.wait(300);
  const grab = await d.box('.dgrab');
  const url = page.url();
  await d.swipe(grab.x + grab.width / 2, grab.y + 8, grab.x + grab.width / 2, grab.y + 180, 8);
  assert.equal(page.url(), url);
  assert.equal(await d.vis('#over'), false);
});

test('a sheet keeps clear of the rail in every chat position', async () => {
  await open();
  await openRailAndChat();
  for (const position of ['sheet', 'full', 'column']) {
    await d.tap('#posBtn');
    await d.wait(80);
    await d.tap(`[data-pos=${position}]`);
    await d.wait(200);
    await d.tap('#sessBtn');
    await d.wait(300);
    assert.equal(overlaps(await d.box('.dlg.sheet'), await d.box('#rail')), false, position);
    await d.tap('#dlgClose');
    await d.wait();
  }
});

test('at 360x740 every sheet fits, keeps clear of the rail, and has no horizontal overflow', async () => {
  const PHONE = { width: 360, height: 740 };
  const checkSheet = async (name) => {
    await d.wait(200);
    const dlg = await d.box('.dlg.sheet');
    assert.ok(dlg.x >= 0 && dlg.x + dlg.width <= PHONE.width + 0.5, `${name}: width ${dlg.x} ${dlg.width}`);
    assert.ok(dlg.y >= 0 && dlg.y + dlg.height <= PHONE.height + 0.5, `${name}: height ${dlg.y} ${dlg.height}`);
    assert.equal(overlaps(dlg, await d.box('#rail')), false, `${name}: covers the rail`);
    const overflow = await page.locator('.dlg.sheet .dbody').evaluate((body) => {
      const edge = body.getBoundingClientRect().right;
      const wider = [...body.querySelectorAll('*')].filter((el) => el.getBoundingClientRect().right > edge + 0.5);
      return { scroll: body.scrollWidth - body.clientWidth, wider: wider.map((el) => el.tagName + '.' + el.className) };
    });
    assert.deepEqual(overflow, { scroll: 0, wider: [] }, `${name}: horizontal overflow`);
    const foot = page.locator('.dlg.sheet .dfoot');
    if (await foot.count()) assert.ok(await foot.evaluate((el) => el.scrollWidth <= el.clientWidth), `${name}: foot overflow`);
  };
  await page.setViewportSize(PHONE);
  try {
    for (const chatOpen of [false, true]) {
      await open();
      if (!(await d.vis('#rail'))) { await d.tap('#badge'); await d.wait(); }
      if (chatOpen) { await d.tap('#rChat'); await d.wait(300); }
      const fromMenu = async (act, name) => {
        await d.tap('#rMore');
        await d.wait();
        await d.tap(`[data-act=${act}]`);
        await d.wait(300);
        await checkSheet(`${name}, chat ${chatOpen}`);
      };
      await fromMenu('sessions', 'sessions');
      await d.tap('#newSess');
      await checkSheet(`connect kind, chat ${chatOpen}`);
      await d.tap('#dlgClose');
      await d.wait();
      await fromMenu('servers', 'servers');
      await d.tap('[data-server-row]');
      await checkSheet(`server detail, chat ${chatOpen}`);
      await d.tap('[data-unpair]');
      await checkSheet(`server detail armed, chat ${chatOpen}`);
      await d.tap('#dlgBack');
      await d.wait(300);
      await d.tap('#addServer');
      await checkSheet(`add server, chat ${chatOpen}`);
      await d.tap('#dlgClose');
      await d.wait();
      await fromMenu('gest', 'gestures');
      await d.tap('#dlgClose');
      await d.wait();
      await fromMenu('keys', 'hotkeys');
      await d.tap('#dlgClose');
      await d.wait();
    }
  } finally {
    await page.setViewportSize({ width: world.width, height: world.height });
  }
});

test('onboarding pairs a server by link', async () => {
  const extra = await world.addRelay();
  const welcome = await world.context.newPage();
  await welcome.goto(world.onboarding.url());
  await welcome.locator('#pairInput').fill(extra.pairLink());
  await welcome.locator('#pairGo').click();
  await welcome.waitForFunction(() => document.getElementById('pairMsg').className === 'good');
  assert.ok((await welcome.locator('#pairMsg').textContent()).includes(extra.host));
  await welcome.close();
  await page.bringToFront();
});

test('too many failed codes: a separate message, the right code is refused for now', async () => {
  const extra = await world.addRelay();
  const welcome = await world.context.newPage();
  await welcome.goto(world.onboarding.url());
  for (let attempt = 0; attempt < FAILED_PAIR_LIMIT; attempt += 1) {
    await fetch(`${extra.base}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'wrong', name: 'x' }) });
  }
  await welcome.locator('#pairInput').fill(extra.pairLink());
  await welcome.locator('#pairGo').click();
  await welcome.waitForFunction(() => /Too many attempts/.test(document.getElementById('pairMsg').textContent));
  await welcome.close();
  await page.bringToFront();
});

// ── chat feedback ──────────────────────────────────

const ownLine = () => page.locator('#msgs .m.me').last().locator('.mstat');
const aiLineText = () => page.locator('#aiLine .aitext').textContent();
const send = async (text) => {
  await page.locator('#ta').fill(text);
  await d.tap('#send');
};
const reloadChat = async () => {
  await page.reload();
  await page.waitForSelector('#badge', { state: 'attached' });
  await d.wait(500);
  await openRailAndChat();
  await d.wait(250);
};
// A fresh session with the auto screenshot off, the AI already polling so it counts as online.
async function chatSession(name = 'Feedback', ai = 'test-ai') {
  await open();
  await openNewSession();
  await makeSession();
  const url = await d.text(LOCAL_ADDRESS);
  const client = aiClient(url);
  await client.name(name, ai);
  await client.events(0, 0);
  await d.wait(200);
  // With many sessions the sheet scrolls, and a tap at an off-screen close button would join whatever row is there.
  if (await d.vis('#dlgClose')) { await page.locator('#dlgClose').scrollIntoViewIfNeeded(); await d.tap('#dlgClose'); await d.wait(); }
  assert.equal(await d.text('#sessName'), name);
  if (await page.locator('#shotBtn.on').count()) await d.tap('#shotBtn');
  await d.wait(100);
  return client;
}
const restoreShot = async () => { if (!(await page.locator('#shotBtn.on').count())) await d.tap('#shotBtn'); };
const composerFacts = () => page.evaluate(() => {
  const r = document.querySelector('tweakline-root').shadowRoot;
  const ta = r.querySelector('#ta'), comp = r.querySelector('.comp'), box = (e) => e.getBoundingClientRect();
  const style = getComputedStyle(ta), line = parseFloat(style.lineHeight), pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const buttons = ['#plusBtn', '#micBtn', '#shotBtn', '#send'].map((s) => r.querySelector(s));
  return {
    scrollLeftover: Math.abs(ta.scrollTop / line - Math.round(ta.scrollTop / line)) * line, height: ta.clientHeight, lines: (ta.clientHeight - pad) / line, scrolls: ta.scrollHeight > ta.clientHeight + 1, overflowY: style.overflowY,
    panelHeight: r.querySelector('#panel').offsetHeight, compBottom: box(comp).bottom, viewport: innerHeight,
    taBottom: box(ta).bottom, buttonTops: buttons.map((b) => Math.round(box(b).top)), buttonBottoms: buttons.map((b) => Math.round(box(b).bottom)),
    msgsHeight: r.querySelector('#msgs').clientHeight,
    atEnd: (() => { const m = r.querySelector('#msgs'); return m.scrollHeight - m.scrollTop - m.clientHeight < 4; })(),
  };
});

test('own message: Sending, then Sent, then Read, only under the last one', async () => {
  const ai = await chatSession('Status line');
  await page.evaluate(() => {
    const r = document.querySelector('tweakline-root').shadowRoot;
    window.__wgSeen = [];
    new MutationObserver(() => {
      const label = r.querySelector('#msgs .m.me:last-of-type .mstat .mst');
      if (label) window.__wgSeen.push(label.textContent);
    }).observe(r.querySelector('#msgs'), { subtree: true, childList: true, characterData: true });
  });
  await send('first message');
  await d.wait(300);
  assert.ok((await page.evaluate(() => window.__wgSeen)).includes('Sending'), 'Sending was shown');
  assert.equal(await ownLine().locator('.mst.sent').textContent(), 'Sent');
  assert.equal(await page.locator('#aiLine .aitext').count() && (await aiLineText()), '');
  const { events } = await ai.events(0, 0);
  await d.wait(200);
  assert.equal(await ownLine().locator('.mst.read').textContent(), 'Read');
  await send('second message');
  await d.wait(300);
  assert.equal(await page.locator('#msgs .m.me .mst').count(), 1);
  assert.equal(await ownLine().locator('.mst.sent').textContent(), 'Sent');
  assert.ok(events.length);
  await reloadChat();
  assert.equal(await ownLine().locator('.mst.sent').textContent(), 'Sent');
  await ai.events(0, 0);
  await d.wait(200);
  assert.equal(await ownLine().locator('.mst.read').textContent(), 'Read');
  await reloadChat();
  assert.equal(await ownLine().locator('.mst.read').textContent(), 'Read');
});

test('working line: after read, replaced by status text, cleared by say, stale without news', async () => {
  const ai = await chatSession('Working line');
  const status = (state, text) => fetch(`${ai.url}status`, { method: 'POST', body: JSON.stringify({ state, text }) });
  await send('do the thing');
  await d.wait(250);
  assert.equal(await aiLineText(), '');
  const heightBefore = await page.locator('#msgs').evaluate((e) => e.clientHeight);
  await ai.events(0, 0);
  await d.wait(150);
  assert.equal(await aiLineText(), 'test-ai is working…');
  assert.equal(await page.locator('#aiLine .aidots i').count(), 3);
  assert.equal(await page.locator('#msgs').evaluate((e) => e.clientHeight), heightBefore, 'the line does not move messages');
  assert.notEqual(await page.locator('#aiLine .aidots i').first().evaluate((e) => getComputedStyle(e).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('#aiLine .aidots i').first().evaluate((e) => getComputedStyle(e).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await status('thinking');
  await d.wait(150);
  assert.equal(await aiLineText(), 'test-ai is thinking…');
  await status('typing');
  await d.wait(150);
  assert.equal(await aiLineText(), 'test-ai is typing…');
  await status('thinking', 'Reading <b>the</b> code');
  await d.wait(150);
  assert.equal(await aiLineText(), 'Reading <b>the</b> code');
  assert.equal(await page.locator('#aiLine b').count(), 0);
  await ai.say('all done');
  await d.wait(200);
  assert.equal(await aiLineText(), '');
  assert.equal(await page.locator('#aiLine .aidots').count(), 0);

  await send('one more');
  await d.wait(200);
  await ai.events(0, 0);
  await d.wait(150);
  assert.equal(await aiLineText(), 'test-ai is working…');
  await d.wait(DEFAULT_AI_STALE_MS + 200);
  assert.equal(await aiLineText(), 'No reply from test-ai yet');
  assert.equal(await page.locator('#aiLine .aidots').count(), 0);
  await reloadChat();
  assert.equal(await aiLineText(), 'No reply from test-ai yet');
  await status('typing');
  await d.wait(150);
  assert.equal(await aiLineText(), 'test-ai is typing…');
  await status('idle');
  await d.wait(150);
  assert.equal(await aiLineText(), '');

  await send('are you there');
  await d.wait(200);
  await ai.events(0, 0);
  await d.wait(150);
  await ai.say('yes');
  await d.wait(200);
  assert.equal(await aiLineText(), '');
});

test('edit: a tap opens Edit and Copy, a swipe does not, the bubble updates in place and survives reload', async () => {
  const ai = await chatSession('Editing');
  await send('teh first line');
  await d.wait(300);
  await ai.say('between');
  await d.wait(200);
  await send('later message');
  await d.wait(300);
  const bubble = page.locator('#msgs .m.me .bub', { hasText: 'teh first line' });
  const box = await bubble.boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await d.swipe(cx, cy, cx, cy - 60);
  assert.equal(await d.count('.mtools'), 0, 'vertical swipe');
  await d.swipe(cx, cy, cx - 40, cy, 4);
  assert.equal(await d.count('.mtools'), 0, 'sideways swipe');
  await d.touchAt(cx, cy);
  assert.equal(await d.count('.mtools .btn.small'), 2);
  assert.equal(await page.locator('.mtools .mEdit').textContent(), 'Edit');
  // Messages sit on the composer, so the row that opens lifts the bubble.
  const lifted = await bubble.boundingBox();
  await d.touchAt(lifted.x + lifted.width / 2, lifted.y + lifted.height / 2);
  assert.equal(await d.count('.mtools'), 0, 'a second tap closes');
  await d.touchAt(cx, cy);
  await d.tap('.mtools .mCopy');
  await d.wait(100);
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'teh first line');
  assert.equal(await page.locator('.mtools .mCopy').textContent(), 'Copied');
  for (const s of ['.mtools', '.mtools .mEdit', '.mstat', '#aiLine', '#send']) {
    assert.equal(await page.locator(s).first().evaluate((e) => getComputedStyle(e).touchAction), 'pan-y', s);
  }
  assert.equal(await page.locator('#ta').evaluate((e) => getComputedStyle(e).touchAction), 'auto');

  await page.locator('#ta').fill('my draft');
  const aiBubble = page.locator('#msgs .m:not(.me) .bub').last();
  const aiBox = await aiBubble.boundingBox();
  await d.touchAt(aiBox.x + 10, aiBox.y + 10);
  assert.equal(await d.count('.mtools'), 0, 'a tap on an AI message shows nothing');
  await d.touchAt(cx, cy);
  const sendIcon = await page.locator('#send').innerHTML();
  await d.tap('.mtools .mEdit');
  await d.wait(100);
  assert.equal(await d.vis('#editBar'), true);
  assert.match(await d.text('#editBar'), /Editing message/);
  assert.equal(await page.locator('#ta').inputValue(), 'teh first line');
  assert.equal(await page.evaluate(() => document.querySelector('tweakline-root').shadowRoot.activeElement?.id), 'ta', 'the keyboard stays open');
  assert.notEqual(await page.locator('#send').innerHTML(), sendIcon);
  await d.tap('#editCancel');
  await d.wait(100);
  assert.equal(await d.vis('#editBar'), false);
  assert.equal(await page.locator('#ta').inputValue(), 'my draft');
  assert.equal(await page.locator('#send').innerHTML(), sendIcon);
  assert.equal(await bubble.count(), 1);

  await d.touchAt(cx, cy);
  await d.tap('.mtools .mEdit');
  await d.wait(100);
  await page.locator('#ta').fill('the first line');
  await d.tap('#send');
  await d.wait(300);
  const edited = page.locator('#msgs .m.me', { hasText: 'the first line' });
  assert.equal(await edited.count(), 1);
  assert.equal(await page.locator('#msgs .m.me', { hasText: 'teh first' }).count(), 0);
  assert.equal(await edited.locator('.medited').textContent(), 'edited');
  assert.equal(await edited.locator('.mst').count(), 0, 'not the last message');
  assert.equal(await page.locator('#msgs .m.me').first().locator('.mtext').textContent(), 'the first line');
  assert.equal(await page.locator('#ta').inputValue(), 'my draft');
  await page.locator('#ta').fill('');
  const { events } = await ai.events(0, 0);
  const edit = events.find((e) => e.type === 'edit');
  assert.equal(edit.data.text, 'the first line');
  assert.equal(events.find((e) => e.seq === edit.data.target).data.text, 'teh first line');
  await reloadChat();
  const again = page.locator('#msgs .m.me', { hasText: 'the first line' });
  assert.equal(await again.count(), 1);
  assert.equal(await again.locator('.medited').textContent(), 'edited');
  assert.equal(await page.locator('#msgs .m.me').count(), 2, 'an edit is not a new message');
});

test('edit: the last message shows state and edited, a message without text has no tools', async () => {
  const ai = await chatSession('Editing last');
  await send('last one');
  await d.wait(300);
  await d.tap('#msgs .m.me .bub');
  await d.tap('.mtools .mEdit');
  await d.wait(100);
  await page.locator('#ta').fill('last one, changed');
  await d.tap('#send');
  await d.wait(300);
  assert.equal(await ownLine().locator('.mst.sent').count(), 1);
  assert.equal(await ownLine().locator('.medited').count(), 1);
  await ai.events(0, 0);
  await d.wait(150);
  assert.equal(await ownLine().locator('.mst.read').count(), 1);
  assert.equal(await aiLineText(), 'test-ai is working…');
  await ai.say('ok');
  await d.wait(150);
  await d.tap('#shotBtn');
  await d.tap('#plusBtn');
  await d.wait(120);
  await d.tap('#addShot');
  await d.wait(500);
  await d.tap('#send');
  await d.wait(700);
  await d.tap('#shotBtn');
  const onlyShot = page.locator('#msgs .m.me').last();
  assert.equal(await onlyShot.locator('.mtext').count(), 0, 'no empty text gap');
  const shotBox = await onlyShot.locator('.mfiles').boundingBox();
  await d.touchAt(shotBox.x - 6, shotBox.y + 4);
  assert.equal(await d.count('.mtools'), 0);
});

test('attachments sit above the text, thumbnails are small and wrap', async () => {
  await chatSession('Attachments');
  await d.tap('#shotBtn');
  await page.locator('#ta').fill('text under the picture, long enough to wrap to a second line in this bubble');
  await d.tap('#send');
  await page.locator('#msgs .m.me .msgimg img').first().waitFor({ timeout: 5000 });
  await d.wait(250);
  await d.tap('#shotBtn');
  const message = page.locator('#msgs .m.me').last();
  const shot = await message.locator('.msgimg').boundingBox();
  const text = await message.locator('.mtext').boundingBox();
  assert.ok(shot.width <= 132.5, `thumbnail width ${shot.width}`);
  assert.equal(await message.locator('.msgimg').evaluate((e) => getComputedStyle(e).borderRadius), '8px');
  assert.ok(text.y >= shot.y + shot.height, 'text starts under the thumbnail');
  assert.equal(await page.locator('#msgs').evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight < 4), true, 'still at the end after the image loaded');
});

test('AI messages form groups, system lines are quiet, access card reads plainly', async () => {
  const ai = await chatSession('Groups', 'Claude');
  await ai.say('first');
  await ai.say('second');
  await ai.say('Need the page', { ask: { access: true } });
  await d.wait(300);
  const messages = page.locator('#msgs .m');
  assert.equal(await page.locator('#msgs .m .av').count(), 1);
  assert.equal(await page.locator('#msgs .m .who').count(), 1);
  const gap = async (i) => (await messages.nth(i + 1).boundingBox()).y - ((await messages.nth(i).boundingBox()).y + (await messages.nth(i).boundingBox()).height);
  assert.equal(Math.round(await gap(0)), 4);
  const [first, second] = [await messages.nth(0).locator('.bub').boundingBox(), await messages.nth(1).locator('.bub').boundingBox()];
  assert.equal(first.x, second.x, 'bubbles of a group share the left edge');
  assert.match(await d.text('.askh'), /^Claude asks to read and change this page$/);
  const labels = await page.locator('.ask .lab').allTextContents();
  assert.deepEqual(labels, ['Where', 'For how long']);
  assert.equal(await page.locator('.ask [data-k=regexp]').textContent(), 'Pattern');
  assert.equal(await d.vis('.ask .reInp'), false);
  await d.tap('.ask [data-k=regexp]');
  assert.equal(await d.vis('.ask .reInp'), true);
  await d.tap('.ask [data-k=tab]');
  assert.equal(await page.locator('.ask .askYes').evaluate((e) => e.classList.contains('pri')), true);
  await d.tap('.ask .askNo');
  await d.wait(150);
  assert.equal(await d.text('.ask .done-line'), 'Access denied');
  await reloadChat();
  assert.equal(await d.text('.ask .done-line'), 'Access denied');
  await send('own message');
  await d.wait(300);
  const own = await page.locator('#msgs .m.me').last().boundingBox();
  const before = await page.locator('#msgs .m').nth(await page.locator('#msgs .m').count() - 2).boundingBox();
  assert.equal(Math.round(own.y - (before.y + before.height)), 14);
});

test('composer grows with long text, shrinks after send, buttons stay on the bottom line', async () => {
  const ai = await chatSession('Composer');
  const long = Array.from({ length: 40 }, (_, i) => `line ${i} of a long message`).join('\n');
  for (const [width, height] of [[360, 740], [880, 1000]]) {
    await page.setViewportSize({ width, height });
    await d.wait(250);
    await ai.say('keep me at the end');
    await d.wait(150);
    const one = await composerFacts();
    assert.equal(one.lines, 1);
    await page.locator('#ta').fill('short\nsecond line');
    await d.wait(60);
    const two = await composerFacts();
    assert.equal(two.lines, 2, `two lines at ${width}`);
    assert.equal(two.scrolls, false);
    await page.locator('#ta').fill('a\nb\nc\nd\ne');
    await d.wait(60);
    const five = await composerFacts();
    assert.equal(five.lines, 5, `five lines at ${width}`);
    assert.equal(five.scrolls, false);
    assert.equal(five.atEnd, true, 'messages stay at the end');
    await page.locator('#ta').fill(long);
    await d.wait(60);
    const full = await composerFacts();
    assert.ok(Number.isInteger(full.lines), `whole lines, got ${full.lines}`);
    assert.ok(full.height <= Math.max(full.panelHeight * 0.4, 5 * 20 + 12) + 1, `cap at ${width}: ${full.height} of ${full.panelHeight}`);
    assert.equal(full.scrolls, true, 'scrolls inside once capped');
    assert.ok(full.scrollLeftover < 1, `no half line at the edge: ${full.scrollLeftover}`);
    assert.equal(full.overflowY, 'auto');
    assert.equal(new Set(full.buttonBottoms).size, 1, 'one bottom line');
    assert.ok(full.buttonTops[0] >= full.taBottom - 1, 'buttons under the text');
    assert.ok(full.compBottom <= full.viewport, 'composer on screen');
    assert.equal(full.atEnd, true);
    await d.tap('#send');
    await d.wait(300);
    const after = await composerFacts();
    assert.equal(after.lines, 1, `shrinks after send at ${width}`);
    assert.equal(await page.locator('#ta').inputValue(), '');
    await page.locator('#ta').fill('clear me\nplease');
    await d.wait(60);
    await page.locator('#ta').fill('');
    await d.wait(60);
    assert.equal((await composerFacts()).lines, 1, 'shrinks after clearing');
    await d.tap('#posBtn');
    await d.wait(80);
    await d.tap('[data-pos=sheet]');
    await d.wait(280);
    await page.locator('#ta').fill(long);
    await d.wait(280);
    const sheet = await composerFacts();
    assert.ok(sheet.msgsHeight >= 60, `history keeps room in the sheet: ${sheet.msgsHeight}`);
    assert.ok(sheet.compBottom <= sheet.viewport);
    assert.equal(new Set(sheet.buttonBottoms).size, 1);
    await page.locator('#ta').fill('');
    await d.tap('#posBtn');
    await d.wait(80);
    await d.tap('[data-pos=column]');
    await d.wait(280);
  }
  await page.setViewportSize({ width: world.width, height: world.height });
  await d.wait(200);
});

test('short viewport under a soft keyboard: composer visible, newest message visible', async () => {
  const ai = await chatSession('Keyboard');
  for (let i = 0; i < 6; i += 1) await ai.say(`Reply number ${i} with enough words to take a line or two in the chat`);
  await d.tap('#shotBtn');
  await send('with a picture');
  await page.locator('#msgs .m.me .msgimg img').last().waitFor({ timeout: 5000 });
  await d.tap('#shotBtn');
  await d.wait(250);
  const check = async (label) => {
    const facts = await page.evaluate(() => {
      const r = document.querySelector('tweakline-root').shadowRoot, box = (e) => e.getBoundingClientRect();
      const msgs = r.querySelector('#msgs'), last = msgs.lastElementChild, comp = r.querySelector('.comp');
      return { lastBottom: box(last).bottom, msgsBottom: box(msgs).bottom, msgsHeight: msgs.clientHeight, compTop: box(comp).top, compBottom: box(comp).bottom, viewport: innerHeight, thumb: box(r.querySelector('#msgs .msgimg')).height };
    });
    assert.ok(facts.compBottom <= facts.viewport, `${label}: composer on screen ${facts.compBottom} of ${facts.viewport}`);
    assert.ok(facts.lastBottom <= facts.msgsBottom + 1, `${label}: newest message visible ${facts.lastBottom} vs ${facts.msgsBottom}`);
    assert.ok(facts.msgsHeight >= 72, `${label}: history height ${facts.msgsHeight}`);
    assert.ok(facts.thumb < facts.msgsHeight, `${label}: thumbnail ${facts.thumb} leaves room in ${facts.msgsHeight}`);
  };
  const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  for (const [width, height] of [[880, 420], [360, 380]]) {
    for (const position of ['column', 'sheet', 'full']) {
      await page.setViewportSize({ width, height: 800 });
      await d.wait(120);
      await d.tap('#posBtn');
      await d.wait(80);
      await d.tap(`[data-pos=${position}]`);
      await d.wait(280);
      await page.setViewportSize({ width, height });
      await d.wait(280);
      await check(`${width}x${height} ${position}`);
      await page.locator('#ta').fill(long);
      await d.wait(120);
      await check(`${width}x${height} ${position} with long text`);
      const { scrollLeftover } = await composerFacts();
      assert.ok(scrollLeftover < 1, `${width}x${height} ${position}: no half line, ${scrollLeftover}`);
      await page.locator('#ta').fill('');
      await d.wait(120);
    }
  }
  await page.setViewportSize({ width: world.width, height: world.height });
  await d.wait(150);
  await d.tap('#posBtn');
  await d.wait(80);
  await d.tap('[data-pos=column]');
  await d.wait(280);
});

test('AI messages with actions arrive while the chat is closed, after reopen and after reload', async () => {
  const ai = await chatSession('Lost message');
  await d.tap('#collapse');
  await d.wait(300);
  assert.equal(await d.vis('#panel'), false);
  await ai.say('Pick one', { actions: [{ id: 'keep', label: 'Keep it', primary: true }, { id: 'undo', label: 'Undo' }] });
  await d.wait(300);
  await openRailAndChat();
  const group = () => page.locator('#msgs .m', { hasText: 'Pick one' });
  assert.equal(await group().count(), 1);
  assert.deepEqual(await group().locator('[data-action]').allTextContents(), ['Keep it', 'Undo']);
  assert.equal(await d.vis('#msgs [data-action=keep]'), true);
  await d.tap('#collapse');
  await d.wait(300);
  await page.reload();
  await page.waitForSelector('#badge', { state: 'attached' });
  await d.wait(500);
  await ai.say('While reloaded', { actions: [{ id: 'late', label: 'Late one' }] });
  await d.wait(300);
  await openRailAndChat();
  await d.wait(200);
  assert.equal(await group().locator('[data-action]').count(), 2);
  assert.equal(await page.locator('#msgs [data-action=late]').count(), 1);
  assert.equal(await page.locator('#msgs [data-action=late]').isDisabled(), false);
  await ai.say('A file for you', { files: [(await (await fetch(`${ai.url}files`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: Buffer.from(TINY_PNG, 'base64') })).json()).id] });
  await page.locator('#msgs .m', { hasText: 'A file for you' }).locator('.msgimg img').waitFor({ timeout: 5000 });
});

test('quick replies: the choice shows at once, fires once, starts the working line, survives reload', async () => {
  const ai = await chatSession('Quick replies');
  await ai.say('Pick one', { actions: [{ id: 'keep', label: 'Keep it', primary: true }, { id: 'undo', label: 'Undo' }] });
  await d.wait(250);
  const keep = page.locator('#msgs [data-action=keep]');
  const undo = page.locator('#msgs [data-action=undo]');
  const box = await keep.boundingBox();
  await d.touchAt(box.x + box.width / 2, box.y + box.height / 2);
  assert.equal(await keep.evaluate((e) => e.classList.contains('chosen')), true);
  assert.equal(await keep.isDisabled(), true);
  assert.equal(await undo.isDisabled(), true);
  assert.equal(await aiLineText(), 'test-ai is working…');
  await d.touchAt(box.x + box.width / 2, box.y + box.height / 2);
  const undoBox = await undo.boundingBox();
  await d.touchAt(undoBox.x + undoBox.width / 2, undoBox.y + undoBox.height / 2);
  await d.wait(250);
  const presses = (await ai.events(0, 0)).events.filter((e) => e.type === 'action');
  assert.deepEqual(presses.map((e) => e.data.action), ['keep']);
  assert.equal(await page.locator('#msgs .mst').count(), 0, 'no own status for a button');

  await reloadChat();
  assert.equal(await keep.evaluate((e) => e.classList.contains('chosen')), true);
  assert.equal(await undo.isDisabled(), true);
  assert.equal(await undo.evaluate((e) => e.classList.contains('chosen')), false);
  assert.equal(await aiLineText(), 'test-ai is working…');
  await d.wait(DEFAULT_AI_STALE_MS + 200);
  assert.equal(await aiLineText(), 'No reply from test-ai yet');

  await ai.say('Done', { actions: [{ id: 'keep', label: 'Keep again' }, { id: 'more', label: 'More' }] });
  await d.wait(250);
  assert.equal(await aiLineText(), '');
  const again = page.locator('#msgs .m', { hasText: 'Done' }).locator('[data-action=keep]');
  assert.equal(await again.isDisabled(), false, 'a new group starts open');
  const againBox = await again.boundingBox();
  await d.touchAt(againBox.x + againBox.width / 2, againBox.y + againBox.height / 2);
  await d.wait(250);
  await reloadChat();
  assert.equal(await page.locator('#msgs [data-action].chosen').count(), 2);
  assert.equal(await page.locator('#msgs .m', { hasText: 'Done' }).locator('[data-action=keep].chosen').count(), 1);
});

test('expired access: the sheet marks it ended, the chat says so once and grants again', async () => {
  const ai = await chatSession('Expired access');
  const HOUR_MS = 3600e3;
  await worker().evaluate(async ({ target, hour }) => {
    const [tab] = await chrome.tabs.query({ url: target });
    const { tabSessions, grants = {} } = await chrome.storage.local.get(['tabSessions', 'grants']);
    grants[tabSessions[tab.id].sessionId] = [{ kind: 'tab', tabId: tab.id, origin: new URL(target).origin, until: Date.now() - hour }];
    await chrome.storage.local.set({ grants });
  }, { target: page.url(), hour: HOUR_MS });
  assert.deepEqual(await ai.act('read'), { ok: false, error: 'not granted' });
  await d.wait(300);
  const ended = page.locator('#msgs .sysline.accend');
  assert.equal(await ended.count(), 1);
  assert.match(await ended.textContent(), /Access for test-ai ended/);
  assert.deepEqual(await ai.act('read'), { ok: false, error: 'not granted' });
  await d.wait(300);
  assert.equal(await ended.count(), 1, 'only once per expiry');
  await d.tap('#rMore');
  await d.wait();
  await d.tap('[data-act=access]');
  await d.wait(250);
  assert.equal(await d.count('.grant.ended .rdot.warn'), 1);
  assert.equal(await d.text('.grant .rsub'), 'Ended 1 h ago');
  await d.tap('#dlgClose');
  await d.wait();
  const asks = await d.count('#msgs .ask');
  await d.tap('[data-grant-again]');
  await d.wait(200);
  assert.equal(await d.count('#msgs .ask'), asks + 1);
  assert.equal(await d.count('[data-grant-again]'), 0);
  await d.tap('.askYes >> nth=-1');
  await d.wait(250);
  assert.equal((await ai.act('read')).ok, true);
  await d.tap('#rMore');
  await d.wait();
  await d.tap('[data-act=access]');
  await d.wait(250);
  assert.match(await d.text('.grant:not(.ended) .rsub'), /^\d+ more (minutes?|hours?)$/);
  await d.tap('#dlgClose');
  await d.wait();
});

const OK_DOT = 'rgb(52, 199, 123)';
const presenceFacts = () => page.evaluate(() => {
  const r = document.querySelector('tweakline-root').shadowRoot;
  const avatar = [...r.querySelectorAll('#msgs .av')].pop();
  return {
    header: getComputedStyle(r.querySelector('.ph .dot')).backgroundColor,
    avatar: avatar && getComputedStyle(avatar, '::after').backgroundColor,
    offline: Boolean(r.querySelector('#sessOff')),
  };
});

test('long quick replies wrap inside their pill, the choice stays filled with a check, the rest stay readable', async () => {
  await page.setViewportSize({ width: 360, height: 740 });
  await d.wait(200);
  const ai = await chatSession('Long replies');
  const long = 'Show another variant of the header layout with a smaller button';
  await ai.say('Pick one', { actions: [{ id: 'keep', label: 'Keep', primary: true }, { id: 'long', label: long }] });
  await d.wait(300);
  const fits = () => page.evaluate(() => [...document.querySelector('tweakline-root').shadowRoot.querySelectorAll('#msgs [data-action]')].map((b) => {
    const range = document.createRange();
    range.selectNodeContents(b);
    const text = range.getBoundingClientRect(), box = b.getBoundingClientRect();
    return { inside: text.left >= box.left && text.right <= box.right && text.top >= box.top && text.bottom <= box.bottom, height: box.height, overflow: b.scrollWidth > b.clientWidth };
  }));
  const [short, wrapped] = await fits();
  assert.ok(short.inside && wrapped.inside, 'labels stay inside their buttons');
  assert.ok(!short.overflow && !wrapped.overflow);
  assert.ok(short.height >= 38, `short pill ${short.height}`);
  assert.ok(wrapped.height > short.height, `long pill wraps to ${wrapped.height}`);
  await d.tap('#msgs [data-action=keep]');
  await d.wait(250);
  const keep = page.locator('#msgs [data-action=keep]');
  assert.equal(await keep.locator('.actcheck').count(), 1);
  const look = await page.evaluate(() => {
    const r = document.querySelector('tweakline-root').shadowRoot, style = (s) => getComputedStyle(r.querySelector(s));
    return { chosen: style('#msgs [data-action=keep]').backgroundImage, other: style('#msgs [data-action=long]').opacity, otherColor: style('#msgs [data-action=long]').color };
  });
  assert.match(look.chosen, /gradient/, 'the choice stays filled');
  assert.equal(look.other, '1', 'the others are not faded out');
  assert.notEqual(look.otherColor, 'rgba(0, 0, 0, 0)');
  assert.equal(await page.locator('#ta').getAttribute('placeholder'), 'Message');
  await page.setViewportSize({ width: world.width, height: world.height });
  await d.wait(200);
});

test('a short conversation sits on the composer, a long one still scrolls to the end', async () => {
  for (const [width, height] of [[360, 740], [world.width, world.height]]) {
    await page.setViewportSize({ width, height });
    await d.wait(200);
    const ai = await chatSession(`Bottom ${width}`);
    await send('hello there');
    await d.wait(300);
    const gaps = () => page.evaluate(() => {
      const r = document.querySelector('tweakline-root').shadowRoot, msgs = r.querySelector('#msgs'), box = (e) => e.getBoundingClientRect();
      const style = getComputedStyle(msgs);
      return {
        below: box(msgs).bottom - parseFloat(style.paddingBottom) - box(msgs.lastElementChild).bottom,
        above: box(msgs.firstElementChild).top - box(msgs).top - parseFloat(style.paddingTop),
        atEnd: msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 4,
        scrolls: msgs.scrollHeight > msgs.clientHeight,
      };
    });
    const one = await gaps();
    assert.ok(Math.abs(one.below) < 2, `${width}: the message sits on the composer, gap ${one.below}`);
    assert.ok(one.above > 100, `${width}: free space stays above, ${one.above}`);
    for (let i = 0; i < 12; i += 1) await ai.say(`Reply number ${i} with enough words to take a line or two in the chat`);
    await d.wait(400);
    const many = await gaps();
    assert.ok(many.scrolls && many.atEnd, `${width}: a long history scrolls and stays at its end`);
    await page.locator('#msgs').evaluate((e) => { e.scrollTop = 0; });
    assert.ok(Math.abs((await gaps()).above) < 2, `${width}: the oldest message is reachable at the top`);
  }
  await page.setViewportSize({ width: world.width, height: world.height });
  await d.wait(200);
});

// ── chats in a session and sending without text ────

const SHOTS_DIR = process.env.WG_SHOTS_DIR;
const FOLD = { width: 724, height: 746 };
const FOLDED = { width: 360, height: 740 };
const msgTexts = () => page.locator('#msgs .m .bub').allTextContents();
const lastUserEvent = async (ai) => (await ai.events(0, 0)).events.filter((e) => e.type === 'user').at(-1);
const chatsMenuPick = async (choice) => {
  await d.tap('#chatsBtn');
  await d.wait();
  await d.tap(`[data-chats=${choice}]`);
  await d.wait(400);
};
const shootChat = async (name) => { if (SHOTS_DIR) await page.screenshot({ path: `${SHOTS_DIR}/${name}.png` }); };

test('send without text: an image alone goes, notes alone go with both screenshots', async () => {
  const ai = await chatSession('No text');
  await d.tap('#plusBtn');
  await d.wait();
  await d.tap('#addShot');
  await page.locator('#chips .att').waitFor({ timeout: 5000 });
  assert.equal(await page.locator('#ta').inputValue(), '');
  await d.tap('#send');
  await page.locator('#msgs .m.me .msgimg img').first().waitFor({ timeout: 5000 });
  await d.wait(300);
  const imageOnly = await lastUserEvent(ai);
  assert.equal(imageOnly.data.text, '');
  assert.equal(imageOnly.data.files.length, 1);
  assert.equal(await page.locator('#msgs .m.me').last().locator('.mtext').count(), 0);
  assert.equal(await d.count('#chips .att'), 0);

  await d.tap('#rNotes');
  await d.wait(200);
  await d.tap('#extNotes [data-tool=point]');
  await d.wait(300);
  await d.down(world.width * 0.3, 420);
  await d.wait(40);
  await d.up();
  await d.wait(200);
  await page.keyboard.type('this button');
  await page.keyboard.press('Enter');
  await d.wait(200);
  await openRailAndChat();
  assert.equal(await d.text('#notesChip'), 'Notes: 1');
  await d.tap('#send');
  await page.waitForFunction(() => !document.querySelector('tweakline-root').shadowRoot.querySelector('#notesChip'), null, { timeout: 8000 });
  await d.wait(300);
  const notesOnly = await lastUserEvent(ai);
  assert.equal(notesOnly.data.text, '');
  assert.equal(notesOnly.data.notes.length, 1);
  assert.equal(notesOnly.data.notes[0].text, 'this button');
  assert.equal(notesOnly.data.files.length, 2, 'a clean screenshot and one with the notes');
  assert.equal(await d.text('#rNotes .cnt'), '0');
  assert.match(await page.locator('#msgs .m.me').last().locator('.mnotes').textContent(), /this button/);
  assert.equal(await page.evaluate(() => document.querySelector('tweakline-marks').shadowRoot.querySelectorAll('.mlabel').length), 0, 'notes sent from the chat leave the page too');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('tweakline-marks')).opacity), '1', 'the marks layer is visible again for new notes');
  await d.tap('#send');
  await d.wait(300);
  assert.equal((await lastUserEvent(ai)).seq, notesOnly.seq, 'an empty composer sends nothing');
});

test('chats: a new chat empties the view and tells the AI, earlier chats open read-only and continue, reload keeps the current one', async () => {
  const ai = await chatSession('Threads');
  await send('Make the header blue');
  await d.wait(250);
  await ai.say('Done, the header is blue');
  await d.wait(250);
  await shootChat('chat-before-new');
  await chatsMenuPick('new');
  assert.equal(await d.count('#msgs .m'), 0, 'the view starts empty');
  const feed = await ai.events(0, 0);
  const started = feed.events.find((e) => e.type === 'chat');
  assert.ok(started, 'the AI gets a chat event');
  assert.notEqual(started.chat, 'c1');
  assert.equal(feed.chat, started.chat);
  await send('Now the footer');
  await d.wait(300);
  assert.equal((await lastUserEvent(ai)).chat, started.chat);
  await reloadChat();
  assert.deepEqual(await msgTexts(), ['Now the footer']);

  await chatsMenuPick('earlier');
  assert.equal(await d.text('.dhead h2'), 'Earlier chats');
  const rows = page.locator('.dlg [data-chat]');
  assert.equal(await rows.count(), 2);
  assert.match(await rows.nth(0).textContent(), /Now the footer.*1 message.*Now/);
  assert.match(await rows.nth(1).textContent(), /Make the header blue.*2 messages/);
  await shootChat('earlier-chats-fold');
  await d.tap('.dlg [data-chat=c1]');
  await d.wait(400);
  assert.deepEqual(await msgTexts(), ['Make the header blue', 'Done, the header is blue']);
  assert.equal(await d.vis('#pastBar'), true);
  assert.equal(await d.vis('#ta'), false, 'an earlier chat is read-only');
  await shootChat('earlier-chat-fold');
  await d.tap('#pastBack');
  await d.wait(400);
  assert.deepEqual(await msgTexts(), ['Now the footer']);
  assert.equal(await d.vis('#pastBar'), false);

  await chatsMenuPick('earlier');
  await d.tap('.dlg [data-chat=c1]');
  await d.wait(400);
  await d.tap('#pastGo');
  await d.wait(400);
  assert.equal(await d.vis('#ta'), true);
  await send('And make it darker');
  await d.wait(300);
  const { events } = await ai.events(0, 0);
  assert.deepEqual(events.filter((e) => e.type === 'chat').at(-1).data, { chat: 'c1', title: 'Make the header blue', continued: true });
  assert.equal(events.at(-1).chat, 'c1');
  await reloadChat();
  assert.deepEqual(await msgTexts(), ['Make the header blue', 'Done, the header is blue', 'And make it darker']);

  await ai.say('Footer done', { chat: started.chat });
  await d.wait(300);
  assert.equal(await d.text('#msgs .otherChat'), 'test-ai replied in an earlier chat');
  await d.tap('#msgs .otherChat');
  await d.wait(400);
  assert.deepEqual(await msgTexts(), ['Now the footer', 'Footer done']);
  await d.tap('#pastBack');
  await d.wait(400);

  await page.setViewportSize(FOLDED);
  try {
    await d.wait(300);
    await openRailAndChat();
    await shootChat('chat-folded');
    await d.tap('#chatsBtn');
    await d.wait();
    const [menuBox, stageBox] = [await d.box('#wmenu'), await d.box('#stage')];
    assert.ok(menuBox.x >= stageBox.x && menuBox.x + menuBox.width <= stageBox.x + stageBox.width + 0.5, 'the menu fits');
    await shootChat('chats-menu-folded');
    await d.tap('[data-chats=earlier]');
    await d.wait(400);
    await shootChat('earlier-chats-folded');
    await d.tap(`.dlg [data-chat=${started.chat}]`);
    await d.wait(400);
    await shootChat('earlier-chat-folded');
    const [bar, chat] = [await d.box('#pastBar'), await d.box('#panel')];
    assert.ok(bar.x >= chat.x && bar.x + bar.width <= chat.x + chat.width + 0.5, 'the bar fits in the chat');
    await d.tap('#pastBack');
    await d.wait(300);
    await page.setViewportSize(FOLD);
    await d.wait(300);
    await shootChat('chat-fold');
  } finally {
    await page.setViewportSize({ width: world.width, height: world.height });
  }
});

test('AI offline: header dot, avatar dot and the offline line follow presence within the server timeout', async () => {
  const pollFreshMs = 1500;
  await world.restartRelay({ pollFreshMs });
  await d.wait(2500);
  const ai = await chatSession('Presence');
  await ai.say('here');
  await d.wait(250);
  let facts = await presenceFacts();
  assert.deepEqual(facts, { header: OK_DOT, avatar: OK_DOT, offline: false });
  await d.wait(pollFreshMs + 300);
  facts = await presenceFacts();
  assert.notEqual(facts.header, OK_DOT, 'header dot greys out');
  assert.notEqual(facts.avatar, OK_DOT, 'avatar dot greys out');
  assert.equal(facts.offline, true);
  await ai.events(0, 0);
  await d.wait(250);
  assert.deepEqual(await presenceFacts(), { header: OK_DOT, avatar: OK_DOT, offline: false });
  await world.restartRelay();
  await d.wait(2500);
});

test('a session left by a tab that no longer exists moves to the open tab with the same page', async () => {
  await chatSession('Survives restart');
  await worker().evaluate(async (target) => {
    const [tab] = await chrome.tabs.query({ url: target });
    const { tabSessions } = await chrome.storage.local.get('tabSessions');
    const bound = tabSessions[tab.id];
    delete tabSessions[tab.id];
    tabSessions[987654] = { ...bound, url: target };
    await chrome.storage.local.set({ tabSessions });
  }, page.url());
  await open();
  if (!(await d.vis('#rail'))) { await d.tap('#badge'); await d.wait(); }
  if (!(await d.vis('#panel'))) { await d.tap('#rChat'); await d.wait(300); }
  assert.equal(await d.text('#sessName'), 'Survives restart');
  const map = await worker().evaluate(() => chrome.storage.local.get('tabSessions').then((r) => r.tabSessions));
  assert.equal(map[987654], undefined, 'the orphan binding moved');
});

test('the menu button closes its menu, AI access grants new access, an idle rail folds into the badge', async () => {
  await chatSession('Grant here');
  if (await d.vis('#collapse')) { await d.tap('#collapse'); await d.wait(300); }
  if (!(await d.vis('#rail'))) { await d.tap('#badge'); await d.wait(); }
  await d.tap('#rMore');
  await d.wait(150);
  assert.equal(await d.vis('#wmenu'), true);
  await d.tap('#rMore');
  await d.wait(150);
  assert.equal(await d.vis('#wmenu'), false, 'a second tap closes the menu');
  await d.tap('#rMore');
  await d.wait(150);
  await d.tap('[data-act=access]');
  await d.wait(300);
  await d.tap('#grantNew');
  await d.wait(150);
  await d.tap('#grantBox [data-k=page]');
  await d.tap('#grantBox .askYes');
  await d.wait(1200);
  assert.equal(await d.count('.grant'), 1, 'the new grant is listed');
  await d.tap('#dlgClose');
  await d.wait(200);
  assert.equal(await d.vis('#rail'), true);
  await d.wait(11000);
  assert.equal(await d.vis('#rail'), false, 'the idle rail folded');
  assert.equal(await d.vis('#badge'), true);
});

test('no page errors from the extension', () => {
  assert.deepEqual(world.errors, []);
});

// ── core security fixes ────────────────────────────

const lib = await import('./lib.mjs');
const otherOrigin = () => `http://${world.openHost}:${new URL(world.siteBase).port}`;
const storedKey = (key, fallback) => worker().evaluate(([k, f]) => chrome.storage.local.get(k).then((found) => found[k] ?? f), [key, fallback]);
const grantByTab = async (ai) => {
  await ai.say('Need access', { ask: { access: true } });
  await d.wait(300);
  if (await d.vis('#dlgClose')) { await d.tap('#dlgClose'); await d.wait(); }
  await d.tap('.askYes >> nth=-1');
  await d.wait(300);
};
const tabOf = (url) => worker().evaluate((target) => chrome.tabs.query({ url: target }).then(([tab]) => tab), url);
// An extension page in a tab talks to the background like a content script does.
const extensionPage = async () => {
  const opened = await world.context.newPage();
  await opened.goto(`chrome-extension://${new URL(worker().url()).host}/onboarding.html`);
  return { call: (method, params) => opened.evaluate(([m, p]) => chrome.runtime.sendMessage({ to: 'bg', method: m, params: p }), [method, params]), close: () => opened.close() };
};

test('a tab grant stays on its site: navigate elsewhere is refused, a page that left is out of reach', async () => {
  const ai = await chatSession('Tab origin');
  await grantByTab(ai);
  const sessionId = (await storedKey('tabSessions', {}))[(await tabOf(page.url())).id].sessionId;
  const [grant] = (await storedKey('grants', {}))[sessionId];
  assert.deepEqual([grant.kind, grant.origin], ['tab', new URL(world.siteBase).origin]);
  assert.equal((await ai.act('read')).ok, true);
  assert.deepEqual(await ai.act('navigate', { url: `${otherOrigin()}/plain` }), { ok: false, error: 'not granted' });
  assert.equal((await ai.act('navigate', { url: `${world.siteBase}/csp` })).ok, true, 'the same site is still allowed');
  await page.waitForURL(/\/csp$/);
  await page.waitForSelector('#badge', { state: 'attached' });
  const [left, raced] = await Promise.all([
    ai.act('js', { code: `setTimeout(() => { location.href = '${otherOrigin()}/plain'; }, 0); 1` }),
    ai.act('read'),
  ]);
  assert.equal(left.ok, true);
  if (raced.ok) assert.equal(new URL(raced.data.url).origin, new URL(world.siteBase).origin, 'an op queued behind a navigation never reads the new site');
  await page.waitForURL((url) => url.host.startsWith(world.openHost));
  await page.waitForSelector('#badge', { state: 'attached' });
  for (const op of ['read', 'css', 'js', 'shot']) {
    const answer = await ai.act(op, { css: 'a{}', code: '1' });
    assert.equal(answer.ok, false, op);
  }
  await open();
  assert.equal((await ai.act('read')).ok, true, 'back on the granted site');
});

test('closing a tab removes its tab grants', async () => {
  const ai = await chatSession('Closed tab');
  await grantByTab(ai);
  const { id } = await tabOf(page.url());
  const extra = await worker().evaluate((target) => chrome.tabs.create({ url: target, active: false }).then((t) => t.id), `${world.siteBase}/plain`);
  await worker().evaluate(([tabId, origin]) => chrome.storage.local.get('alwaysGrants').then(({ alwaysGrants = [] }) => chrome.storage.local.set({ alwaysGrants: [...alwaysGrants, { kind: 'tab', tabId, origin, until: null, always: true }] })), [extra, new URL(world.siteBase).origin]);
  await worker().evaluate((tabId) => chrome.tabs.remove(tabId), extra);
  await d.wait(300);
  assert.equal((await storedKey('alwaysGrants', [])).some((g) => g.tabId === extra), false);
  assert.ok(Object.values(await storedKey('grants', {})).flat().some((g) => g.kind === 'tab' && g.tabId === id), 'grants of open tabs stay');
});

test('a binding whose stored page is on another site is not taken by the tab that now has its id', async () => {
  await chatSession('Old id');
  const { id } = await tabOf(page.url());
  await worker().evaluate(([tabId, url]) => chrome.storage.local.get('tabSessions').then(({ tabSessions }) => { tabSessions[tabId] = { ...tabSessions[tabId], url }; return chrome.storage.local.set({ tabSessions }); }), [id, `${otherOrigin()}/plain`]);
  await open();
  await openRailAndChat();
  assert.notEqual(await d.text('#sessName').catch(() => ''), 'Old id');
  await worker().evaluate(([tabId, url]) => chrome.storage.local.get('tabSessions').then(({ tabSessions }) => { tabSessions[tabId] = { ...tabSessions[tabId], url }; return chrome.storage.local.set({ tabSessions }); }), [id, page.url()]);
});

test('shot captures the tab the AI works on, not the tab in front of the window', async () => {
  const ai = await chatSession('Background shot');
  await grantByTab(ai);
  assert.equal((await ai.act('css', { css: 'html,body{background:rgb(255,0,0)!important}body *{visibility:hidden!important}tweakline-root{display:none!important}' })).ok, true);
  const target = await tabOf(page.url());
  const front = await worker().evaluate(([windowId, url]) => chrome.tabs.create({ windowId, url, active: true }).then((t) => t.id), [target.windowId, `${world.siteBase}/desktop`]);
  await d.wait(800);
  try {
    assert.equal((await tabOf(page.url())).active, false, 'the AI tab is behind another one');
    const shot = await ai.act('shot');
    assert.equal(shot.ok, true, shot.error);
    const file = await ai.file(shot.data.id);
    const base64 = Buffer.from(await file.arrayBuffer()).toString('base64');
    const pixel = await page.evaluate(async (data) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      return [...context.getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1).data].slice(0, 3);
    }, base64);
    assert.deepEqual(pixel, [255, 0, 0]);
  } finally {
    await worker().evaluate((tabId) => chrome.tabs.remove(tabId), front);
    await page.bringToFront();
    await ai.act('undo');
  }
});

test('a session the extension never created gets the narrow kind, whatever the server says', async () => {
  const fake = await startFakeServer();
  try {
    await open();
    await openRailAndChat();
    await openAddServer();
    await fillServerInput(fake.pairLink);
    await d.wait(200);
    if (await d.vis('#dlgClose')) { await d.tap('#dlgClose'); await d.wait(); }
    fake.setSessions([{ id: 'planted-browser', kind: 'browser', title: 'Planted', lastAt: 1 }]);
    await d.tap('#sessBtn');
    await d.wait(500);
    assert.equal((await storedSessions())['planted-browser']?.kind, 'page');
    assert.deepEqual((await fake.forge('planted-browser', 'tabs')).error, 'this op needs a whole-browser session');
    await d.tap('#dlgClose');
    await d.wait();

    fake.setFailing('user.access');
    const ext = await extensionPage();
    try {
      const refused = await ext.call('grant.set', { session: 'planted-browser', grant: { kind: 'site', host: 'a.example', until: null } });
      assert.equal(refused.ok, false);
      assert.equal((await storedKey('grants', {}))['planted-browser'], undefined, 'a grant the server never heard of is rolled back');
      const alwaysBefore = await storedKey('alwaysGrants', []);
      assert.equal((await ext.call('grant.set', { session: 'planted-browser', grant: { kind: 'site', host: 'a.example', until: null, always: true } })).ok, false);
      assert.deepEqual(await storedKey('alwaysGrants', []), alwaysBefore);
    } finally {
      await ext.close();
    }
  } finally {
    await page.bringToFront();
    if (await d.vis('#dlgClose')) { await d.tap('#dlgClose'); await d.wait(); }
    if (!(await d.vis('#rail'))) { await d.tap('#badge'); await d.wait(); }
    await openServers();
    await d.tap(serverRowOf(new URL(fake.base).host));
    await d.wait(300);
    await removeOpenServer();
    await d.tap('#dlgClose');
    await fake.stop();
  }
});

test('chat.send reports a missing attachment and refuses a file over the server limit before uploading', async () => {
  const ext = await extensionPage();
  try {
    const missing = await ext.call('chat.send', { session: 'any', text: 'x', media: ['not-there'] });
    assert.deepEqual([missing.ok, /no longer in the gallery/.test(missing.error)], [false, true]);
    const big = `data:video/webm;base64,${'A'.repeat(Math.ceil((10 * 1024 * 1024 + 10) / 3) * 4)}`;
    const added = await ext.call('media.add', { kind: 'video', dataUrl: big, url: 'x', seconds: 1 });
    assert.equal(added.ok, true);
    const tooBig = await ext.call('chat.send', { session: 'any', text: 'x', media: [added.data] });
    assert.equal(tooBig.ok, false);
    assert.match(tooBig.error, /screen\.webm is 10\.0 MB, the server takes files up to 10 MB/);
    await ext.call('media.delete', { ids: [added.data] });
  } finally {
    await ext.close();
    await page.bringToFront();
  }
});

test('pairing with a server whose socket never opens reports it instead of success', async () => {
  const broken = await lib.startNoSocketServer();
  try {
    await open();
    await openRailAndChat();
    await openAddServer();
    await page.locator('#serverInput').fill(broken.pairLink);
    await d.tap('#serverGo');
    await page.waitForFunction(() => /live connection did not open/.test(document.querySelector('tweakline-root').shadowRoot.querySelector('#serverMsg')?.textContent), null, { timeout: 8000 });
    assert.match(await d.text('#serverMsg'), /WebSocket upgrades on \/ext/);
  } finally {
    if (await d.vis('#dlgClose')) { await d.tap('#dlgClose'); await d.wait(); }
    if (!(await d.vis('#rail'))) { await d.tap('#badge'); await d.wait(); }
    await openServers();
    await d.tap(serverRowOf(new URL(broken.base).host));
    await d.wait(300);
    await removeOpenServer();
    await d.tap('#dlgClose');
    await broken.stop();
  }
});

test('an AI-suggested patch scope is offered only when it covers this page on this host', async () => {
  const ai = await chatSession('Scopes');
  await grantByTab(ai);
  const host = new URL(page.url()).host;
  const suggested = async (mask) => {
    assert.equal((await ai.act('proposePatch', { title: `Scope ${mask}`, css: '#side{color:red}', mask })).ok, true);
    await d.wait(900);
    await openLatestDraft();
    const offered = await d.count('[data-w=suggested]');
    await d.tap('#pNo');
    await d.wait();
    return offered;
  };
  assert.equal(await suggested(`${host}/*`), 1);
  assert.equal(await suggested('evil.test/*'), 0, 'another host');
  assert.equal(await suggested(`${host}/nowhere/*`), 0, 'does not cover this page');
  assert.equal(await suggested(`*.${host.split(':')[0]}/*`), 0, 'wider than this host');
});

test('a browser restart clears tab grants and frees tab bindings from their old ids', async () => {
  const { chromium } = await import('playwright-core');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wg-profile-'));
  const extension = lib.buildExtension(1);
  const launch = () => chromium.launchPersistentContext(profile, {
    executablePath: lib.chromiumPath(), headless: false,
    args: ['--headless=new', '--no-sandbox', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const workerOf = async (context) => context.serviceWorkers()[0] || context.waitForEvent('serviceworker');
  const cleaned = (worker) => worker.evaluate(async () => {
    for (let i = 0; i < 50 && !(await chrome.storage.session.get('browserRunCleaned')).browserRunCleaned; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  });
  let context = await launch();
  try {
    const origin = new URL(world.siteBase).origin;
    // The first run's own cleanup must finish first, or it can overwrite what the test plants.
    await cleaned(await workerOf(context));
    await (await workerOf(context)).evaluate(([o]) => chrome.storage.local.set({
      grants: { s1: [{ kind: 'tab', tabId: 7, origin: o, until: null }, { kind: 'site', host: '127.0.0.1', until: null }] },
      alwaysGrants: [{ kind: 'tab', tabId: 7, origin: o, until: null, always: true }],
      tabSessions: { 7: { serverId: 'x', sessionId: 's1', url: `${o}/plain` } },
    }), [origin]);
    await context.close();
    context = await launch();
    const sw = await workerOf(context);
    let stored;
    for (let i = 0; i < 40; i += 1) {
      stored = await sw.evaluate(() => chrome.storage.local.get(['grants', 'alwaysGrants', 'tabSessions']));
      if (!Object.keys(stored.tabSessions).includes('7')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(stored.grants.s1, [{ kind: 'site', host: '127.0.0.1', until: null }]);
    assert.deepEqual(stored.alwaysGrants, []);
    const keys = Object.keys(stored.tabSessions);
    assert.equal(keys.length, 1);
    assert.match(keys[0], /^restart:/, 'the binding keeps its page for adoption but not the old id');
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
    fs.rmSync(extension, { recursive: true, force: true });
  }
});

// ── layout audit: the checks of the UI audit, run on every main screen ──

const AUDIT_SIZES = [{ width: 360, height: 740 }, { width: 724, height: 746 }, { width: 1280, height: 800 }];
const MIN_HIT_PX = 36;
const FOCUS_SCOPES = ['#rail.on', '#panel:not(.closed):not(.mini)', '.dlg', '#viewer.on', '#wmenu.on'];

// Runs in the page: layout problems inside the Tweakline shadow root.
function layoutIssuesInPage() {
  const root = document.querySelector('tweakline-root').shadowRoot;
  const vw = innerWidth, vh = innerHeight;
  const out = [];
  const name = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).join('.')}` : ''} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}"`;
  const add = (check, el, detail) => out.push(`${check} ${name(el)} ${detail}`);
  const shown = (el) => el.getClientRects().length > 0 && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && el.getBoundingClientRect().width > 0;
  const scrolling = (s) => ['auto', 'scroll'].includes(s.overflowX) || ['auto', 'scroll'].includes(s.overflowY);
  const clipAncestor = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflowX !== 'visible' || s.overflowY !== 'visible') return p;
    }
    return null;
  };
  const inScroller = (el) => { const anc = clipAncestor(el); return Boolean(anc) && scrolling(getComputedStyle(anc)); };
  const clipped = (el, box) => {
    let { left, top, right, bottom } = box;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const c = p.getBoundingClientRect();
      if (s.overflowX !== 'visible') { left = Math.max(left, c.left); right = Math.min(right, c.right); }
      if (s.overflowY !== 'visible') { top = Math.max(top, c.top); bottom = Math.min(bottom, c.bottom); }
    }
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  };
  const textBox = (el) => {
    const rects = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).flatMap((n) => {
      const range = document.createRange();
      range.selectNodeContents(n);
      return [...range.getClientRects()];
    });
    if (!rects.length) return null;
    return { left: Math.min(...rects.map((r) => r.left)), top: Math.min(...rects.map((r) => r.top)), right: Math.max(...rects.map((r) => r.right)), bottom: Math.max(...rects.map((r) => r.bottom)) };
  };
  const ellipsized = (s) => s.textOverflow === 'ellipsis' || (s.webkitLineClamp && s.webkitLineClamp !== 'none');
  const interactive = (el) => el.matches('button, a[href], input:not([type=hidden]):not([type=file]), textarea, summary, [role=tab]');
  const all = [...root.querySelectorAll('*')].filter((el) => !(el instanceof SVGElement) && !['STYLE', 'BR', 'I'].includes(el.tagName) && !el.closest('#panel.mini'));
  const vis = all.filter(shown);

  if (document.documentElement.scrollWidth > vw + 1) add('page-hscroll', document.documentElement, `${document.documentElement.scrollWidth} > ${vw}`);
  for (const el of root.querySelectorAll('.dlg, #panel:not(.mini), #rail, #wmenu.on, #viewer.on, #toast.on, #badge, #noteBox, .ext.open, #plus.on, .mtools')) {
    if (!shown(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.left < -0.5 || r.top < -0.5 || r.right > vw + 0.5 || r.bottom > vh + 0.5) add('offscreen', el, `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  for (const dlg of root.querySelectorAll('.dlg')) {
    if (!shown(dlg)) continue;
    for (const part of [dlg, ...dlg.querySelectorAll('.dbody, .dfoot, .dhead')]) {
      if (part.scrollWidth > part.clientWidth + 1) add('sheet-hoverflow', part, `${part.scrollWidth} > ${part.clientWidth}`);
    }
    const body = dlg.querySelector('.dbody');
    if (body && body.scrollHeight > body.clientHeight + 1 && !['auto', 'scroll'].includes(getComputedStyle(body).overflowY)) add('sheet-noscroll', body, `${body.scrollHeight} > ${body.clientHeight}`);
    if (dlg.getBoundingClientRect().height > vh + 0.5) add('sheet-taller-than-viewport', dlg, '');
  }
  for (const el of vis) {
    if (el.matches('textarea, input')) {
      if (el.scrollWidth > el.clientWidth + 1 && !ellipsized(getComputedStyle(el)) && el.tagName === 'INPUT') add('input-text-clipped', el, `${el.scrollWidth} > ${el.clientWidth}`);
      continue;
    }
    if (el.matches('#msgs, .dbody, pre, code, pre *, .pcode *')) continue;
    const text = textBox(el);
    if (!text) continue;
    const s = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    if (!ellipsized(s) && (text.right > box.right + 1 || text.left < box.left - 1)) add(s.overflowX === 'visible' ? 'text-overflows-box' : 'text-clipped', el, `${Math.round(text.right - text.left)} in ${Math.round(box.width)}`);
    const seen = clipped(el, text);
    const anc = clipAncestor(el);
    if (seen.width > 0 && seen.height > 0 && (seen.width < text.right - text.left - 1 || seen.height < text.bottom - text.top - 1) && anc && !scrolling(getComputedStyle(anc)) && !ellipsized(getComputedStyle(anc)) && !ellipsized(s)) add('text-cut-by-ancestor', el, `by ${name(anc)}`);
    if ((text.right > vw + 0.5 || text.left < -0.5) && seen.width > 0 && !inScroller(el) && !ellipsized(s)) add('text-offscreen-x', el, `${Math.round(text.left)}..${Math.round(text.right)}`);
  }
  for (const el of vis.filter(interactive)) {
    const r = el.getBoundingClientRect();
    if (inScroller(el)) continue;
    if (r.left < -0.5 || r.right > vw + 0.5 || r.top < -0.5 || r.bottom > vh + 0.5) add('control-offscreen', el, `${Math.round(r.left)},${Math.round(r.top)}..${Math.round(r.right)},${Math.round(r.bottom)}`);
    const v = clipped(el, r);
    if (v.width > 0 && v.height > 0 && (v.width < r.width - 2 || v.height < r.height - 2)) add('control-clipped', el, `${Math.round(v.width)}x${Math.round(v.height)} of ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  const rail = root.querySelector('#rail');
  if (rail && shown(rail)) {
    const rr = rail.getBoundingClientRect();
    for (const el of vis) {
      if (rail.contains(el) || el.contains(rail)) continue;
      if (!interactive(el) && !textBox(el)) continue;
      const v = clipped(el, el.getBoundingClientRect());
      if (Math.min(v.right, rr.right) - Math.max(v.left, rr.left) > 1 && Math.min(v.bottom, rr.bottom) - Math.max(v.top, rr.top) > 1) add('overlaps-rail', el, '');
    }
  }
  for (const row of vis.filter((el) => el.matches('.row, .pdraft, .psw, .grant, .opt'))) {
    const rr = row.getBoundingClientRect(), cy = rr.top + rr.height / 2;
    for (const item of [...row.querySelectorAll('.rmeta, .dicon, .tog, .btn')].filter(shown)) {
      const ir = item.getBoundingClientRect();
      if (rr.height < 90 && Math.abs(ir.top + ir.height / 2 - cy) > 3) add('row-misaligned', item, `in ${name(row)}`);
      if (ir.right > rr.right + 0.5 || ir.left < rr.left - 0.5) add('row-item-outside', item, `in ${name(row)}`);
    }
  }
  return out;
}

// Runs in the page: controls that show no focus ring when reached from the keyboard.
function missingFocusRingsInPage(scopes) {
  const root = document.querySelector('tweakline-root').shadowRoot;
  const missing = [];
  for (const scope of scopes) {
    for (const base of root.querySelectorAll(scope)) {
      const els = [...base.querySelectorAll('button, a[href], input:not([type=hidden]):not([type=file]), textarea, summary, [role=tab]')].filter((el) => el.getClientRects().length && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && !el.disabled);
      for (const el of els) {
        el.focus({ preventScroll: true });
        if (root.activeElement !== el) continue;
        const ringOn = (node) => { const s = getComputedStyle(node); return (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none'; };
        // The composer draws one ring around the input and its buttons.
        if (!ringOn(el) && !(el.closest('.comp') && ringOn(el.closest('.comp')))) missing.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} ${el.getAttribute('aria-label') || el.textContent.trim().slice(0, 24)}`);
        el.blur();
      }
    }
  }
  return missing;
}

// Runs in the page: the area that really takes a tap, probed outward from the center of each control.
function hitAreasInPage(selector) {
  const root = document.querySelector('tweakline-root').shadowRoot;
  return [...root.querySelectorAll(selector)].filter((el) => el.getClientRects().length && el.checkVisibility({ checkVisibilityCSS: true })).map((el) => {
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const takes = (x, y) => { const hit = root.elementFromPoint(x, y); return Boolean(hit) && el.contains(hit); };
    const reach = (dx, dy) => {
      let steps = 0;
      for (let x = cx + dx, y = cy + dy; x >= 0 && y >= 0 && x < innerWidth && y < innerHeight && takes(x, y); x += dx, y += dy) steps += 1;
      return steps;
    };
    return { el: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${el.className} ${el.getAttribute('aria-label') || el.textContent.trim().slice(0, 20)}`, w: reach(-1, 0) + reach(1, 0) + 1, h: reach(0, -1) + reach(0, 1) + 1, visual: [Math.round(r.width), Math.round(r.height)] };
  });
}

const ensureServer = async () => {
  if (!(await storedServers()).length) {
    await openAddServer();
    await fillServerInput(world.pairLink());
    if (await d.vis('#dlgClose')) { await d.tap('#dlgClose'); await d.wait(); }
  }
};
const auditPhone = async (size) => { await page.setViewportSize(size); await d.wait(300); };
const auditScreen = async (problems, name) => {
  await d.wait(250);
  const issues = await page.evaluate(layoutIssuesInPage);
  await page.keyboard.press('Shift');
  const rings = await page.evaluate(missingFocusRingsInPage, FOCUS_SCOPES);
  problems.push(...issues.map((issue) => `${name}: ${issue}`), ...rings.map((ring) => `${name}: no focus ring on ${ring}`));
};
const closeSheets = async () => {
  for (let i = 0; i < 4 && await d.vis('#dlgClose'); i += 1) { await page.locator('#dlgClose').evaluate((b) => b.click()); await d.wait(150); }
};
const menuSheet = async (act) => {
  if (!(await d.vis('#rail'))) { await d.tap('#badge'); await d.wait(); }
  await d.tap('#rMore');
  await d.wait(150);
  await d.tap(`[data-act=${act}]`);
  await d.wait(350);
};
const setChatPosition = async (position) => {
  await openRailAndChat();
  await d.tap('#posBtn');
  await d.wait(150);
  await d.tap(`[data-pos=${position}]`);
  await d.wait(350);
};

test('layout audit: every main screen at 360, 724 and 1280 fits, keeps clear of the rail and shows its text', async () => {
  await open();
  await openRailAndChat();
  await ensureServer();
  const ai = await chatSession('Sticky header covers the headline on the review page', 'claude-code');
  await ai.say('Found it. The header is `position: sticky` with `z-index: 50`. A long URL: https://www.example.com/reviews/orbit-fold-3/comments?sort=newest&page=2&highlight=header-overlap');
  await ai.say('I need access to this page to try a fix.', { ask: { access: true } });
  await ai.say('Keep it?', { actions: [{ id: 'keep', label: 'Keep it', primary: true }, { id: 'more', label: 'Try a lighter shade of blue for the header background instead' }] });
  await d.wait(400);
  const problems = [];
  try {
    for (const size of AUDIT_SIZES) {
      const at = `${size.width}x${size.height}`;
      await auditPhone(size);
      await open();
      await openRailAndChat();
      await auditScreen(problems, `${at} chat`);
      await d.tap('#sessBtn');
      await auditScreen(problems, `${at} sessions`);
      await d.tap('.row.on [data-addr]');
      await auditScreen(problems, `${at} session detail`);
      await closeSheets();
      await menuSheet('servers');
      await auditScreen(problems, `${at} servers`);
      await d.tap('#addServer');
      await d.wait(300);
      await fillServerInput('not a link at all');
      await auditScreen(problems, `${at} add server error`);
      await closeSheets();
      await menuSheet('access');
      await d.tap('#grantNew');
      await auditScreen(problems, `${at} access`);
      await closeSheets();
      await setChatPosition('full');
      await auditScreen(problems, `${at} full screen chat`);
      await setChatPosition('sheet');
      await auditScreen(problems, `${at} bottom chat`);
      await setChatPosition('column');
      await d.tap('#collapse');
      await d.wait(1200);
      await d.tap('#rNotes');
      await d.wait(200);
      await auditScreen(problems, `${at} rail with notes`);
      await d.tap('#extList');
      await d.wait(300);
      await auditScreen(problems, `${at} notes`);
      await closeSheets();
      await d.tap('#rMedia');
      await d.wait(200);
      await d.tap('#mShot');
      await d.wait(700);
      await d.tap('.toastThumb');
      await d.wait(300);
      await auditScreen(problems, `${at} viewer`);
      await d.tap('#vClose');
      await d.wait(200);
      if (!(await d.vis('#extMedia'))) { await d.tap('#rMedia'); await d.wait(200); }
      await d.tap('#mGallery');
      await d.wait(400);
      await auditScreen(problems, `${at} gallery`);
      await closeSheets();
      await d.tap('#rPatches');
      await d.wait(400);
      await auditScreen(problems, `${at} patches`);
      await closeSheets();
      for (const act of ['gest', 'keys']) {
        await menuSheet(act);
        await auditScreen(problems, `${at} ${act}`);
        await closeSheets();
      }
    }
  } finally {
    await page.setViewportSize({ width: world.width, height: world.height });
  }
  assert.deepEqual(problems, []);
});

test('touch controls take a tap on at least 36 px, the badge reaches toward the page', async () => {
  await auditPhone({ width: 360, height: 740 });
  const small = [];
  const measure = async (selector) => {
    await page.locator(selector).first().waitFor({ state: 'visible', timeout: 5000 });
    await d.wait(300);
    const areas = await page.evaluate(hitAreasInPage, selector);
    assert.ok(areas.length, `${selector} is on screen`);
    small.push(...areas.filter((a) => a.w < MIN_HIT_PX || a.h < MIN_HIT_PX).map((a) => `${a.el}: ${a.w}x${a.h}`));
  };
  try {
    await chatSession('Hit targets', 'claude-code');
    await open();
    await measure('#badge');
    await openRailAndChat();
    await measure('.comp .ib');
    await measure('#send');
    await d.tap('#plusBtn');
    await d.wait(150);
    await d.tap('#addShot');
    await page.locator('#chips .att').waitFor({ timeout: 5000 });
    await measure('#chips .att .x');
    await d.tap('#chips .att .x');
    await send('A message to edit');
    await d.wait(300);
    await d.tap('#msgs .m.me .bub >> nth=-1');
    await d.wait(200);
    await measure('.mtools .btn.small');
    await worker().evaluate(async (target) => {
      const [tab] = await chrome.tabs.query({ url: target });
      await chrome.tabs.sendMessage(tab.id, { to: 'ui', type: 'proposePatch', proposal: { title: 'Hit target patch with a long name that does not fit the field', css: '#side{color:red}' } });
    }, page.url());
    await d.wait(700);
    await openLatestDraft();
    await measure('.dlg .seg button');
    await measure('.dlg .tog');
    await closeSheets();
    if (await d.vis('#collapse')) { await d.tap('#collapse'); await d.wait(1200); }
    if (!(await d.vis('#rail'))) { await d.tap('#badge'); await d.wait(); }
    if (!(await d.vis('#extMedia'))) { await d.tap('#rMedia'); await d.wait(200); }
    await d.tap('#mGallery');
    await d.wait(400);
    await measure('.gz');
    await closeSheets();
    if (!(await d.vis('#extNotes'))) { await d.tap('#rNotes'); await d.wait(200); }
    await d.tap('#extNotes [data-tool=point]');
    await d.wait(300);
    await d.down(150, 300);
    await d.wait(40);
    await d.up();
    await d.wait(200);
    await measure('#noteOk');
    await measure('#noteCancel');
    await d.tap('#noteCancel');
    await d.wait(150);
  } finally {
    await page.setViewportSize({ width: world.width, height: world.height });
  }
  assert.deepEqual(small, []);
});

test('full screen at 360 fits its header, the session name uses the free room, the side chat stays narrow on a wide screen', async () => {
  try {
    await auditPhone({ width: 360, height: 740 });
    await chatSession('Sticky header covers the headline on the review page', 'claude-code');
    await closeSheets();
    await setChatPosition('full');
    const header = await page.evaluate(() => {
      const root = document.querySelector('tweakline-root').shadowRoot;
      const ph = root.querySelector('#panel .ph');
      const box = ph.getBoundingClientRect();
      const outside = [...ph.querySelectorAll('button')].filter((b) => b.getClientRects().length).filter((b) => { const r = b.getBoundingClientRect(); return r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.right > innerWidth; });
      return { overflow: ph.scrollWidth - ph.clientWidth, outside: outside.map((b) => b.id || b.getAttribute('aria-label')), sessW: root.querySelector('#sessBtn').getBoundingClientRect().width };
    });
    assert.deepEqual(header.outside, [], 'every header button is inside the header');
    assert.ok(header.overflow <= 1, `header overflow ${header.overflow}`);
    assert.ok(header.sessW >= 72, `session button ${header.sessW}`);
    await setChatPosition('column');
    await auditPhone({ width: 1280, height: 800 });
    await open();
    await openRailAndChat();
    const room = await page.evaluate(() => {
      const root = document.querySelector('tweakline-root').shadowRoot;
      const name = root.querySelector('#sessName');
      return { cut: name.scrollWidth > name.clientWidth + 1, free: root.querySelector('#panel .ph .sp').getBoundingClientRect().width };
    });
    assert.ok(!room.cut || room.free < 2, `the name is cut while ${room.free}px stay free`);
    const panelW = (await d.box('#panel')).width;
    assert.ok(panelW <= 441, `side chat ${panelW}px on a 1280 screen`);
    const grip = await d.box('#cwGrip');
    await d.swipe(grip.x + 10, grip.y + grip.height / 2, grip.x - 190, grip.y + grip.height / 2, 8);
    assert.ok((await d.box('#panel')).width > panelW + 150, 'a width set by hand is kept');
  } finally {
    await page.setViewportSize({ width: world.width, height: world.height });
  }
});

test('the viewer close button sits outside the picture', async () => {
  for (const size of [{ width: 360, height: 740 }, { width: 724, height: 746 }]) {
    await auditPhone(size);
    await open();
    if (!(await d.vis('#rail'))) { await d.tap('#badge'); await d.wait(); }
    if (await d.vis('#collapse')) { await d.tap('#collapse'); await d.wait(1200); }
    if (!(await d.vis('#extMedia'))) { await d.tap('#rMedia'); await d.wait(200); }
    await d.tap('#mShot');
    await page.locator('.toastThumb').waitFor({ state: 'visible', timeout: 5000 });
    await d.wait(300);
    await d.tap('.toastThumb');
    await page.locator('#vClose').waitFor({ state: 'visible', timeout: 5000 });
    await d.wait(300);
    assert.equal(overlaps(await d.box('#vClose'), await d.box('#viewer .vshot')), false, `${size.width}: close covers the picture`);
    await d.tap('#vClose');
    await d.wait(200);
  }
  await page.setViewportSize({ width: world.width, height: world.height });
});

// ── review fixes: sessions, tabs, undo, patches, copies, media ──

const tabAt = (url) => worker().evaluate((target) => chrome.tabs.query({}).then((tabs) => tabs.find((t) => t.url === target)), url);
const closeSheet = async () => { if (await d.vis('#dlgClose')) { await page.locator('#dlgClose').scrollIntoViewIfNeeded(); await d.tap('#dlgClose'); await d.wait(); } };
const grantSite = async (ai) => {
  await ai.say('Need access', { ask: { access: true } });
  await d.wait(300);
  await closeSheet();
  await d.tap('.ask [data-k=site] >> nth=-1');
  await d.tap('.askYes >> nth=-1');
  await d.wait(300);
};
// A new session in the tab as it is, without the navigation chatSession makes.
const sessionHere = async (name, kind = 'page') => {
  await openNewSession();
  await makeSession(kind);
  const client = aiClient(await d.text(LOCAL_ADDRESS));
  await client.name(name, 'test-ai');
  await client.events(0, 0);
  await d.wait(200);
  await closeSheet();
  assert.equal(await d.text('#sessName'), name);
  return client;
};
const toastFacts = async () => ({ title: await d.text('#toast b'), note: await d.text('#toast small').catch(() => '') });

test('a new session made from an earlier chat shows its own chat with the composer, and switching sessions shows each current chat', async () => {
  const ai = await chatSession('Old threads');
  await send('First thread');
  await d.wait(300);
  await chatsMenuPick('new');
  await send('Second thread');
  await d.wait(300);
  await chatsMenuPick('earlier');
  await d.tap('.dlg [data-chat=c1]');
  await d.wait(400);
  assert.equal(await d.vis('#pastBar'), true);
  const fresh = await sessionHere('Fresh start');
  assert.equal(await d.vis('#pastBar'), false, 'the earlier-chat view of the old session is gone');
  assert.equal(await d.vis('#ta'), true);
  await fresh.say('Hello from the new session');
  await d.wait(300);
  assert.deepEqual(await msgTexts(), ['Hello from the new session']);
  await joinSessionNamed('Old threads');
  await closeSheet();
  assert.equal(await d.text('#sessName'), 'Old threads');
  assert.deepEqual(await msgTexts(), ['Second thread']);
  await ai.say('Back here');
  await d.wait(300);
  assert.deepEqual(await msgTexts(), ['Second thread', 'Back here']);
  await joinSessionNamed('Fresh start');
  await closeSheet();
  assert.deepEqual(await msgTexts(), ['Hello from the new session']);
  assert.equal(await d.vis('#ta'), true);
});

test('joining a page session from another tab moves it there: the old tab lets go, ops reach the tab joined last', async () => {
  const ai = await chatSession('Moves along');
  await grantSite(ai);
  const first = await tabAt(page.url());
  const sessionId = (await storedKey('tabSessions', {}))[first.id].sessionId;
  const boundTabs = async () => { const map = await storedKey('tabSessions', {}); return Object.keys(map).filter((k) => map[k]?.sessionId === sessionId); };
  const [mainPage, mainDriver] = [page, d];
  const second = await world.context.newPage();
  page = second;
  d = driver({ page: second, cdp: await world.context.newCDPSession(second) });
  try {
    await open('desktop');
    await openRailAndChat();
    await joinSessionNamed('Moves along');
    assert.deepEqual(await boundTabs(), [String((await tabAt(second.url())).id)]);
    assert.equal((await ai.act('read')).data.title, 'Desktop');
  } finally {
    page = mainPage;
    d = mainDriver;
  }
  try {
    await page.bringToFront();
    await openRailAndChat();
    await joinSessionNamed('Moves along');
    assert.deepEqual(await boundTabs(), [String(first.id)], 'the second tab let go when the first joined again');
    assert.equal((await ai.act('read')).data.title, 'Plain', 'the tab joined last, not the one with the highest id');
  } finally {
    await second.close();
    await page.bringToFront();
  }
});

test('after an extension update the open tabs keep their sessions and tab grants, a tab that is gone moves to a restart key', async () => {
  await open('plain?a');
  const second = await world.context.newPage();
  await second.goto(`${world.siteBase}/plain?b`);
  await second.waitForSelector('#badge', { state: 'attached', timeout: 5000 });
  const [a, b] = [await tabAt(page.url()), await tabAt(second.url())];
  const origin = new URL(world.siteBase).origin;
  const GONE = 987650;
  const saved = await worker().evaluate(() => chrome.storage.local.get(['tabSessions', 'grants']));
  try {
    await worker().evaluate(([ta, tb, gone, aUrl, bUrl, o]) => chrome.storage.local.set({
      tabSessions: { [ta]: { serverId: 'x', sessionId: 'sa', url: aUrl }, [tb]: { serverId: 'x', sessionId: 'sb', url: bUrl }, [gone]: { serverId: 'x', sessionId: 'sg', url: aUrl } },
      grants: { sa: [{ kind: 'tab', tabId: ta, origin: o, until: null }, { kind: 'tab', tabId: gone, origin: o, until: null }] },
    }), [a.id, b.id, GONE, page.url(), second.url(), origin]);
    // What an update leaves: session storage empty, the same tabs with the same ids.
    await worker().evaluate(() => chrome.storage.session.clear());
    const { targetInfos } = await world.cdp.send('Target.getTargets');
    const target = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'));
    // Stopping the worker makes it run its startup again, as after an update.
    await world.cdp.send('Target.closeTarget', { targetId: target.targetId });
    await d.wait(400);
    await page.reload();
    let cleaned = false;
    for (let i = 0; i < 60 && !cleaned; i += 1) {
      cleaned = await worker()?.evaluate(() => chrome.storage.session.get('browserRunCleaned').then((r) => Boolean(r.browserRunCleaned))).catch(() => false);
      if (!cleaned) await d.wait(100);
    }
    assert.equal(cleaned, true, 'the woken worker ran its cleanup');
    const stored = await worker().evaluate(() => chrome.storage.local.get(['tabSessions', 'grants']));
    assert.equal(stored.tabSessions[a.id]?.sessionId, 'sa');
    assert.equal(stored.tabSessions[b.id]?.sessionId, 'sb', 'two tabs on one page with different queries keep their own sessions');
    assert.equal(stored.tabSessions[GONE], undefined);
    assert.deepEqual(Object.entries(stored.tabSessions).filter(([k]) => k.startsWith('restart:')).map(([, v]) => v.sessionId), ['sg']);
    assert.deepEqual(stored.grants.sa.map((g) => g.tabId), [a.id], 'the grant of the open tab stays, the one of the gone tab ends');
  } finally {
    await worker().evaluate((value) => chrome.storage.local.set({ tabSessions: value.tabSessions || {}, grants: value.grants || {} }), saved);
    await second.close();
    await page.bringToFront();
  }
});

test('undo takes back only what the asking session did, and undoing JS without undo code says so before the reload', async () => {
  const owner = await chatSession('Undo owner');
  await grantByTab(owner);
  assert.equal((await owner.act('css', { css: '#side{display:none}' })).ok, true);
  const other = await sessionHere('Undo other');
  await grantByTab(other);
  assert.deepEqual((await other.act('undo')).data, { undone: false });
  assert.equal(await page.locator('#side').isVisible(), false, 'a change of another session stays');
  await joinSessionNamed('Undo owner');
  await closeSheet();
  assert.deepEqual((await owner.act('undo')).data, { undone: true });
  assert.equal(await page.locator('#side').isVisible(), true);
  assert.equal((await owner.act('js', { code: 'document.body.dataset.mark = "1"' })).ok, true);
  await page.evaluate(() => { window.wgBeforeUndoReload = true; });
  const undone = owner.act('undo');
  await page.waitForFunction(() => document.querySelector('tweakline-root').shadowRoot.querySelector('#toast.on b')?.textContent === 'Undoing a change', null, { timeout: 3000 });
  assert.deepEqual((await undone).data, { undone: true, reloaded: true });
  await page.waitForFunction(() => !window.wgBeforeUndoReload, null, { timeout: 5000 });
  await page.waitForSelector('#badge', { state: 'attached', timeout: 5000 });
});

test('a patch pattern that is empty or could freeze the browser is not saved, and the sheet says why', async () => {
  const ai = await chatSession('Patterns');
  await grantByTab(ai);
  assert.equal((await ai.act('proposePatch', { title: 'Risky pattern', css: '#side{color:red}' })).ok, true);
  await d.wait(900);
  await openLatestDraft();
  await d.tap('[data-w=regexp]');
  const before = (await storedKey('patches', [])).length;
  await page.locator('#pRe').fill('');
  await d.tap('#pYes');
  await d.wait(300);
  assert.deepEqual(await toastFacts(), { title: 'Patch not saved', note: 'Enter a pattern' });
  await page.locator('#pRe').fill('(a+)+$');
  await d.tap('#pYes');
  await d.wait(300);
  assert.match((await toastFacts()).note, /can freeze the browser/);
  assert.equal((await storedKey('patches', [])).length, before);
  assert.equal(await d.vis('#pTitle'), true, 'the sheet stays open to fix the pattern');
  await d.tap('#pNo');
  await d.wait();
});

test('the page cannot retire the UI or keep it out through attributes, and never sees the extension version', async () => {
  await open();
  const marks = () => page.evaluate(() => [...document.documentElement.attributes].map((a) => a.name).filter((n) => n.startsWith('data-tweakline')));
  assert.deepEqual(await marks(), []);
  await page.evaluate(() => {
    for (const { name } of [...document.documentElement.attributes]) document.documentElement.removeAttribute(name);
    document.documentElement.dataset.tweaklineCopy = 'page';
  });
  await d.wait(1500);
  assert.equal(await page.locator('tweakline-root').count(), 1, 'a router rewriting <html> does not retire the UI');
  if (!(await d.vis('#rail'))) { await d.tap('#badge'); await d.wait(); }
  assert.equal(await d.vis('#rail'), true);
  const planted = await world.context.newPage();
  try {
    await planted.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () => {
        document.documentElement.dataset.tweaklineCopy = '1';
        document.documentElement.dataset.tweaklineExt = '0.1.0';
        document.documentElement.append(document.createElement('tweakline-root'));
      });
    });
    await planted.goto(`${world.siteBase}/plain`);
    await planted.waitForFunction(() => document.querySelector('tweakline-root')?.shadowRoot?.querySelector('#badge'), null, { timeout: 5000 });
    assert.equal(await planted.locator('tweakline-root').count(), 1, 'the planted element is replaced by the real UI');
  } finally {
    await planted.close();
    await page.bringToFront();
  }
});

test('revoking an "Every session" grant removes that grant even when the list changed meanwhile', async () => {
  await chatSession('Revoke by key');
  const a = { kind: 'site', host: 'a.example', until: null, always: true };
  const b = { kind: 'site', host: 'b.example', until: null, always: true };
  const saved = await storedKey('alwaysGrants', []);
  const setAlways = (list) => worker().evaluate((value) => chrome.storage.local.set({ alwaysGrants: value }), list);
  await setAlways([a, b]);
  try {
    await d.tap('#rMore');
    await d.wait();
    await d.tap('[data-act=access]');
    await d.wait(300);
    assert.equal(await d.count('.grant.always'), 2);
    await setAlways([b]);
    await d.tap('[data-always="1"]');
    await d.wait(300);
    assert.deepEqual(await storedKey('alwaysGrants', []), []);
  } finally {
    await setAlways(saved);
    await closeSheet();
  }
});

test('a screenshot or a video the gallery cannot store says so, with the reason', async () => {
  await open();
  if (!(await d.vis('#rail'))) { await d.tap('#badge'); await d.wait(); }
  if (await d.vis('#panel')) { await d.tap('#collapse'); await d.wait(300); }
  await worker().evaluate(() => { indexedDB.open = () => { throw new Error('the disk is full'); }; });
  try {
    if (!(await d.vis('#extMedia'))) { await d.tap('#rMedia'); await d.wait(220); }
    await d.tap('#mShot');
    await d.wait(900);
    assert.deepEqual(await toastFacts(), { title: 'Screenshot not saved', note: 'the disk is full' });
    if (!(await d.vis('#extMedia'))) { await d.tap('#rMedia'); await d.wait(220); }
    await d.tap('#mVideo');
    await d.wait(1500);
    await d.tap('#badge');
    await d.wait(1200);
    assert.deepEqual(await toastFacts(), { title: 'Video not saved', note: 'the disk is full' });
  } finally {
    await worker().evaluate(() => { delete indexedDB.open; });
  }
});

test('a whole-browser session opens a tab and acts on the tab it names; a page session refuses another tab', async () => {
  const pageAi = await chatSession('One tab only');
  const ai = await sessionHere('Whole browser ops', 'browser');
  await grantSite(ai);
  const main = await tabAt(page.url());
  const opened = await ai.act('open', { url: `${world.siteBase}/desktop` });
  assert.equal(opened.ok, true, opened.error);
  try {
    let read = null;
    for (let i = 0; i < 40 && read?.data?.title !== 'Desktop'; i += 1) {
      read = await ai.act('read', {}, opened.data.tab);
      if (read?.data?.title !== 'Desktop') await d.wait(100);
    }
    assert.equal(read.data.title, 'Desktop');
    assert.equal((await ai.act('read', {}, main.id)).data.title, 'Plain');
    assert.deepEqual(await ai.act('open', { url: `${otherOrigin()}/plain` }), { ok: false, error: 'not granted' });
    assert.deepEqual(await pageAi.act('read', {}, main.id), { ok: false, error: 'this session is limited to one tab' });
  } finally {
    await worker().evaluate((tabId) => chrome.tabs.remove(tabId), opened.data.tab).catch(() => {});
    await page.bringToFront();
  }
});

test('a paired server: a session it claims twice is refused, re-pairing and removing end the old key there, offline the person is told how', async () => {
  const fake = await startFakeServer();
  const revokes = () => fake.calls().filter((m) => m === 'device.revokeSelf').length;
  const pairFake = async () => {
    await open();
    await openRailAndChat();
    await openAddServer();
    await fillServerInput(fake.pairLink);
    await d.wait(200);
    await closeSheet();
  };
  const removeFake = async () => {
    if (!(await d.vis('#rail'))) { await d.tap('#badge'); await d.wait(); }
    await openServers();
    await d.tap(serverRowOf(new URL(fake.base).host));
    await d.wait(300);
    await removeOpenServer();
  };
  let stopped = false;
  try {
    await pairFake();
    fake.setSessions([{ id: 'planted-twice', kind: 'page', title: 'Already here', lastAt: 1 }]);
    await d.tap('#sessBtn');
    await d.wait(500);
    await closeSheet();
    assert.equal((await storedSessions())['planted-twice']?.title, 'Already here');
    fake.setAnswer('session.create', { id: 'planted-twice', addresses: [] });
    const serverId = (await storedServers()).find((s) => s.baseUrl === fake.base).id;
    const ext = await extensionPage();
    try {
      assert.deepEqual(await ext.call('session.create', { kind: 'browser', serverId }), { ok: false, error: 'The server returned a session that is not ours' });
    } finally {
      await ext.close();
      await page.bringToFront();
    }
    assert.equal((await storedSessions())['planted-twice'].kind, 'page', 'the stored session keeps its narrow kind');

    await pairFake();
    assert.equal(revokes(), 1, 're-pairing ends the old key over the old socket');
    await removeFake();
    assert.equal(revokes(), 2, 'removing an online server ends its key');
    await closeSheet();

    await pairFake();
    await fake.stop();
    stopped = true;
    await d.wait(400);
    await removeFake();
    await d.wait(200);
    assert.deepEqual(await toastFacts(), { title: 'The server still has this browser', note: 'It keeps its sessions until you run node tweakline-server.js token revoke fake-3 there' });
    await closeSheet();
  } finally {
    if (!stopped) await fake.stop();
  }
});

// Reloads the extension, so it has to stay the last test.
test('after an extension update the page offers a reload, and the notice stays above other sheets', async () => {
  await open();
  if (!(await d.vis('#rail'))) { await d.tap('#badge'); await d.wait(); }
  await worker().evaluate(() => chrome.runtime.reload()).catch(() => {});
  await d.wait(1500);
  await d.tap('#rPatches');
  await d.wait(600);
  assert.equal(await d.text('.dhead h2'), 'Tweakline was updated');
  await d.tap('#rMore');
  await d.wait(150);
  await d.tap('[data-act=gest]');
  await d.wait(300);
  assert.equal(await d.text('.dhead h2'), 'Tweakline was updated');
  assert.equal(await d.vis('#reloadPage'), true);
});
