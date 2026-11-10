import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startWorld, driver, aiClient } from './lib.mjs';

const LOCAL_ADDRESS = '.addr[data-kind=local] .aurl';

let world, d, page, ai;
const open = async (name = 'plain') => { await page.goto(`${world.siteBase}/${name}`); await page.waitForSelector('#badge', { state: 'attached', timeout: 5000 }); await d.wait(150); };

before(async () => {
  world = await startWorld({ silentInjection: true });
  d = driver(world);
  page = world.page;
  await open();
  await d.tap('#badge');
  await d.wait();
  await d.tap('#rChat');
  await d.wait(260);
  await d.tap('#connectBtn');
  await d.wait(300);
  await page.locator('#serverInput').fill(world.pairLink());
  await d.tap('#serverGo');
  await d.wait(550);
  await d.tap('[data-kind=page]');
  await d.wait(250);
  ai = aiClient(await d.text(LOCAL_ADDRESS));
  await ai.say('Need access', { ask: { access: true } });
  await d.wait(250);
  if (await d.vis('#dlgClose')) { await d.tap('#dlgClose'); await d.wait(); }
  await d.tap('.askYes >> nth=-1');
  await d.wait(250);
});
after(async () => { await world.close(); });

test('silent insertCSS: css still applies through an adopted stylesheet, undo takes it away', async () => {
  const applied = await ai.act('css', { css: '#side{display:none}' });
  assert.deepEqual(applied, { ok: true, data: { applied: true, via: 'sheet' } });
  assert.equal(await page.locator('#side').isVisible(), false);
  assert.equal((await ai.act('undo')).data.undone, true);
  assert.equal(await page.locator('#side').isVisible(), true);
});

test('silent userScripts, no debugger: js runs once in the page world and returns its value', async () => {
  await page.evaluate(() => { window.wgRuns = 0; });
  const set = await ai.act('js', { code: "window.wgRuns += 1; document.title = 'WG:on'; document.title" });
  assert.deepEqual(set, { ok: true, data: { applied: true, value: 'WG:on' } });
  assert.equal(await page.title(), 'WG:on');
  assert.equal(await page.evaluate(() => window.wgRuns), 1, 'ran exactly once');
  assert.equal((await ai.act('js', { code: 'Promise.resolve({ n: 5 })' })).data.value.n, 5);
  assert.equal((await ai.act('js', { code: 'undefined' })).data.value, undefined);
  const broken = await ai.act('js', { code: 'return 1' });
  assert.equal(broken.ok, false);
  assert.match(broken.error, /SyntaxError/);
  const thrown = await ai.act('js', { code: 'nope()' });
  assert.equal(thrown.ok, false);
  assert.match(thrown.error, /nope is not defined/);
});

test('a page whose CSP forbids styles and scripts: css via the sheet, js answers why it could not run', async () => {
  await open('csp');
  const css = await ai.act('css', { css: '#t{color:rgb(1,2,3)}' });
  assert.deepEqual(css, { ok: true, data: { applied: true, via: 'sheet' } });
  assert.equal(await page.locator('#t').evaluate((e) => getComputedStyle(e).color), 'rgb(1, 2, 3)');
  const js = await ai.act('js', { code: "document.title = 'ran'" });
  assert.equal(js.ok, false);
  assert.match(js.error, /^JS did not run: the page's Content-Security-Policy blocks eval, and the debugger unavailable: Cannot attach/);
  assert.equal(await page.title(), 'Csp');
});
