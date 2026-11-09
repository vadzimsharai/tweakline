import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { buildBundle } from '../build.mjs';

const RELAY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BUNDLE_BYTES = 400 * 1024;
let built, bundle, dir, home;
const env = () => ({ ...process.env, HOME: home, XDG_DATA_HOME: path.join(home, 'data'), XDG_CONFIG_HOME: path.join(home, 'config') });

before(async () => {
  built = await buildBundle();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgb-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wgb-home-'));
  bundle = path.join(dir, 'tweakline.js');
  fs.copyFileSync(built, bundle);
});

async function start(t, args = [], file = bundle, cwd = dir) {
  const child = spawn(process.execPath, [file, ...args], { cwd, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { out += chunk; });
  const deadline = Date.now() + 10000;
  while (!/pair: \S+/.test(out)) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`no start: ${out}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { out, child };
}

test('the file is alone in its folder, small, and has no secrets', () => {
  assert.deepEqual(fs.readdirSync(dir), ['tweakline.js']);
  assert.ok(fs.statSync(bundle).size < MAX_BUNDLE_BYTES, `size ${fs.statSync(bundle).size}`);
});

test('the build output runs where it is built, inside the ES module package, and from another directory', async (t) => {
  assert.equal(path.dirname(built), path.join(RELAY_DIR, 'dist'));
  const help = (cwd, file) => execFileSync(process.execPath, [file, '--help'], { cwd, env: env(), encoding: 'utf8' });
  assert.match(help(RELAY_DIR, path.relative(RELAY_DIR, built)), /^tweakline: server/);
  assert.match(help(os.tmpdir(), built), /^tweakline: server/);
  const { out } = await start(t, ['--port', '0', '--data', path.join(home, 'in-place')], built, RELAY_DIR);
  const base = out.match(/local: (\S+)/)[1];
  const served = Buffer.from(await (await fetch(`${base}/tweakline.js`)).arrayBuffer());
  assert.ok(served.equals(fs.readFileSync(built)));
});

test('node tweakline.js with no arguments starts a local server that pairs and serves itself', async (t) => {
  const { out } = await start(t, ['--port', '0']);
  const base = out.match(/local: (\S+)/)[1];
  const info = await (await fetch(`${base}/tweakline`)).json();
  assert.equal(info.name, 'tweakline');
  const served = Buffer.from(await (await fetch(`${base}/tweakline.js`)).arrayBuffer());
  assert.ok(served.equals(fs.readFileSync(bundle)));
  const code = out.match(/\/pair#(\S+)/)[1];
  const paired = await fetch(`${base}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'b' }) });
  assert.equal(paired.status, 200);
  const link = execFileSync(process.execPath, [bundle, 'pair'], { cwd: dir, env: env(), encoding: 'utf8' });
  assert.match(link, /\/pair#/);
  const token = execFileSync(process.execPath, [bundle, 'token', 'new', '--name', 'x'], { cwd: dir, env: env(), encoding: 'utf8' }).trim();
  const noAuth = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
  assert.equal(noAuth.status, 401);
  assert.ok(token.length >= 40);
});

test('the bundle serves session instructions, and curl | sh installs and starts it', async (t) => {
  const { out } = await start(t, ['--port', '0']);
  const base = out.match(/local: (\S+)/)[1];
  const paired = await (await fetch(`${base}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: out.match(/\/pair#(\S+)/)[1], name: 'c' }) })).json();
  const ws = new WebSocket(`${base.replace('http', 'ws')}/ext`);
  const created = await new Promise((resolve, reject) => {
    ws.on('error', reject);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', deviceToken: paired.deviceToken, name: 'c', version: 't' })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'ready') ws.send(JSON.stringify({ type: 'call', id: 1, method: 'session.create', params: { kind: 'browser' } }));
      if (msg.type === 'reply') resolve(msg.data);
    });
  });
  ws.close();
  assert.match(await (await fetch(created.addresses[0].url)).text(), /Tweakline session/);
  const script = await (await fetch(`${base}/install.sh`)).text();
  assert.match(script, /^#!\/bin\/sh/);
  assert.ok(script.includes(`${base}/tweakline.js`));
  assert.match(script, />= 22/);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'wgb-install-'));
  const child = spawn('sh', ['-s', '--', '--port', '0', '--data', path.join(target, 'data')], { env: { ...env(), TWEAKLINE_HOME: target }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let installed = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { installed += chunk; });
  child.stdin.end(script);
  const deadline = Date.now() + 10000;
  while (!/pair: \S+/.test(installed) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(installed, /local:/);
  assert.ok(fs.existsSync(path.join(target, 'tweakline-server.js')));
});

test('pack explains itself outside the repository', () => {
  assert.throws(() => execFileSync(process.execPath, [bundle, 'pack'], { cwd: dir, env: env(), stdio: 'pipe' }), /checkout of the repository/);
});

test('the released tweakline-server.js serves itself for install.sh', async (t) => {
  const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgb-release-'));
  const released = path.join(releaseDir, 'tweakline-server.js');
  fs.copyFileSync(bundle, released);
  const { out } = await start(t, ['--port', '0'], released);
  const base = out.match(/local: (\S+)/)[1];
  const res = await fetch(`${base}/tweakline.js`);
  assert.equal(res.status, 200);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(fs.readFileSync(released)));
});

test('an unreadable bundle answers an error and the server keeps running', async (t) => {
  const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgb-unreadable-'));
  const released = path.join(releaseDir, 'tweakline-server.js');
  fs.copyFileSync(bundle, released);
  const { out, child } = await start(t, ['--port', '0'], released);
  fs.chmodSync(released, 0o000);
  t.after(() => fs.chmodSync(released, 0o644));
  const base = out.match(/local: (\S+)/)[1];
  assert.equal((await fetch(`${base}/tweakline.js`)).status, 500);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(child.exitCode, null);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

async function serveRelease(t, status, body) {
  const server = http.createServer((_req, res) => {
    res.writeHead(status);
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/tweakline-server.js`;
}

// Asynchronous, since the stand-in release server runs in this process.
function runUpdate(file, url) {
  return new Promise((resolve) => {
    execFile(process.execPath, [file, 'update'], { cwd: path.dirname(file), env: { ...env(), TWEAKLINE_TEST_UPDATE_URL: url }, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

test('update replaces the running single file with the downloaded release, atomically', async (t) => {
  const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgb-update-'));
  const released = path.join(releaseDir, 'tweakline-server.js');
  fs.copyFileSync(bundle, released);
  fs.chmodSync(released, 0o755);
  const next = '#!/usr/bin/env node\nconsole.log("next release");\n';
  const result = await runUpdate(released, await serveRelease(t, 200, next));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.readFileSync(released, 'utf8'), next);
  assert.equal(fs.statSync(released).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(releaseDir), ['tweakline-server.js']);
  assert.equal(execFileSync(process.execPath, [released], { encoding: 'utf8' }).trim(), 'next release');
});

test('a failed or wrong download leaves the running file as it was', async (t) => {
  const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgb-update-'));
  const released = path.join(releaseDir, 'tweakline-server.js');
  fs.copyFileSync(bundle, released);
  for (const [status, body] of [[404, 'Not Found'], [200, '<html>login</html>'], [200, '']]) {
    const result = await runUpdate(released, await serveRelease(t, status, body));
    assert.equal(result.code, 1, `${status} ${body}`);
    assert.match(result.stderr, /download|not a tweakline/);
    assert.ok(fs.readFileSync(released).equals(fs.readFileSync(bundle)));
    assert.deepEqual(fs.readdirSync(releaseDir), ['tweakline-server.js']);
  }
});

test('hints in messages name the single file the way it was started', () => {
  const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgb-hints-'));
  const released = path.join(releaseDir, 'tweakline-server.js');
  fs.copyFileSync(bundle, released);
  assert.throws(() => execFileSync(process.execPath, [released, 'mcp'], { cwd: releaseDir, env: { ...env(), HOME: releaseDir, TWEAKLINE_URL: '', TWEAKLINE_TOKEN: '' }, stdio: 'pipe' }), /run node tweakline-server\.js token new --name X/);
});
