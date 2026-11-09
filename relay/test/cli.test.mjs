import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { boot, CLI, pairDevice, postPair, runCli, tempDir } from './helpers.mjs';

const WRAPPER = fileURLToPath(new URL('../../skill/tweakline/bin/tweakline', import.meta.url));

async function startServe(t, args, env = {}) {
  const child = spawn(process.execPath, [CLI, 'serve', ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 10000;
  while (!/pair: \S+/.test(output)) {
    if (Date.now() > deadline) throw new Error(`serve did not start: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { child, output: () => output };
}

test('serve prints addresses and a pair link, and uses the default data dir', async (t) => {
  const home = tempDir();
  const { child, output } = await startServe(t, ['--port', '0'], { HOME: home });
  const local = output().match(/local: (http:\/\/127\.0\.0\.1:\d+)/)[1];
  assert.ok(!/public:/.test(output()));
  const link = output().match(/pair: (\S+)/)[1];
  assert.ok(link.startsWith(`${local}/pair#`));
  assert.equal((await postPair(local, { code: link.split('#')[1], name: 'x' })).status, 200);
  assert.ok(fs.existsSync(path.join(home, '.local', 'share', 'tweakline', 'devices')));
  const { name, version } = await (await fetch(`${local}/tweakline`)).json();
  assert.equal(name, 'tweakline');
  assert.equal(version, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  child.kill('SIGTERM');
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
});

test('serve with a domain prints the public address and pairs through it', async (t) => {
  const { child, output } = await startServe(t, ['--port', '0', '--domain', 'gate.example', '--data', tempDir()]);
  assert.match(output(), /public: https:\/\/gate\.example/);
  assert.match(output(), /pair: https:\/\/gate\.example\/pair#/);
  child.kill('SIGTERM');
  await once(child, 'exit');
});

test('serve on a busy port fails with a message', async (t) => {
  const { relay } = await boot(t);
  await assert.rejects(runCli(['serve', '--port', String(relay.port), '--data', tempDir()]), /in use/);
});

test('pair without a known server falls back to the default local address', async () => {
  const { stdout } = await runCli(['pair', '--data', tempDir()]);
  assert.match(stdout.trim(), /^http:\/\/127\.0\.0\.1:8787\/pair#[\w-]{20,}$/);
});

test('token ls shows MCP tokens and devices without secrets, and revoke removes them', async (t) => {
  const { relay, base, dataDir } = await boot(t);
  const device = await pairDevice(relay, base, 'fold');
  const home = tempDir();
  const token = (await runCli(['token', 'new', '--name', 'claude', '--data', dataDir], { HOME: home })).stdout.trim();
  assert.ok(Buffer.from(token, 'base64url').length >= 32);
  const listed = (await runCli(['token', 'ls', '--data', dataDir])).stdout;
  assert.match(listed, /mcp\s+claude/);
  assert.match(listed, /device\s+fold/);
  assert.ok(listed.includes(device.deviceId));
  assert.ok(!listed.includes(token));
  assert.ok(!listed.includes(device.deviceToken));
  const id = listed.split('\n').find((line) => line.includes('claude')).split(/\s+/)[0];
  await runCli(['token', 'revoke', id, '--data', dataDir]);
  assert.ok(!(await runCli(['token', 'ls', '--data', dataDir])).stdout.includes('claude'));
  await assert.rejects(runCli(['token', 'revoke', id, '--data', dataDir]), /unknown/);
  await assert.rejects(runCli(['token', 'new', '--data', dataDir], { HOME: home }), /--name/);
});

test('status reports a running server and a stopped one', async (t) => {
  const { base, dataDir, close } = await boot(t, { domain: null });
  assert.match((await runCli(['status', '--data', dataDir])).stdout, new RegExp(`${base}: tweakline t`));
  await close();
  assert.match((await runCli(['status', '--data', dataDir])).stdout, new RegExp(`${base}: unreachable`));
});

test('pack builds a zip without tests, node_modules or any config', async () => {
  const { stdout } = await runCli(['pack']);
  const zip = stdout.trim();
  const names = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).split('\n');
  fs.rmSync(path.dirname(zip), { recursive: true, force: true });
  assert.ok(names.includes('tweakline/manifest.json'));
  assert.ok(!names.some((name) => /node_modules|\/test\/|config\.json|package\.json/.test(name)));
});

test('serve on all interfaces does not claim to be reachable from this machine only', async (t) => {
  const { output } = await startServe(t, ['--port', '0', '--host', '0.0.0.0', '--data', tempDir()]);
  assert.doesNotMatch(output(), /this machine only/);
});

test('serve on loopback says it is reachable from this machine only', async (t) => {
  const { output } = await startServe(t, ['--port', '0', '--data', tempDir()]);
  assert.match(output(), /this machine only/);
});

test('usage has no pack --update and documents --trust-proxy', async () => {
  const { stdout } = await runCli(['--help']);
  assert.doesNotMatch(stdout, /--update/);
  assert.match(stdout, /--trust-proxy/);
});

test('serve --trust-proxy rate-limits by the forwarded address', async (t) => {
  const { output } = await startServe(t, ['--port', '0', '--trust-proxy', '--data', tempDir()]);
  const local = output().match(/local: (\S+)/)[1];
  const post = (forwarded) => postPair(local, { code: 'wrong' }, { 'x-forwarded-for': forwarded }).then((r) => r.status);
  for (let attempt = 0; attempt < 10; attempt += 1) await post('198.51.100.1');
  assert.equal(await post('198.51.100.1'), 429);
  assert.equal(await post('198.51.100.2'), 401);
});

test('unknown command prints usage and fails', async () => {
  await assert.rejects(runCli(['nope']), /tweakline serve/);
  assert.match((await runCli(['--help'])).stdout, /tweakline serve/);
});

test('the skill wrapper runs the same CLI through a symlink', async () => {
  const link = path.join(tempDir(), 'tweakline');
  fs.symlinkSync(WRAPPER, link);
  const { stdout } = await promisify(execFile)(link, ['pair', '--data', tempDir()], { timeout: 20000 });
  assert.match(stdout.trim(), /^http:\/\/127\.0\.0\.1:8787\/pair#/);
});

test('behind a proxy: only the public address, and no pair link in the output', async (t) => {
  const { output } = await startServe(t, ['--port', '0', '--domain', 'gate.example', '--no-local', '--no-pair-link', '--data', tempDir()]);
  const text = output();
  assert.match(text, /https:\/\/gate\.example/);
  assert.doesNotMatch(text, /127\.0\.0\.1/);
  assert.doesNotMatch(text, /\/pair#/);
  assert.doesNotMatch(text, /this machine only/);
});

test('update from a source checkout says to use git pull', async () => {
  await assert.rejects(runCli(['update']), (error) => error.code === 1 && /git pull/.test(error.stderr));
});

test('hints from a source checkout name the tweakline command', async () => {
  await assert.rejects(runCli(['mcp'], { HOME: tempDir(), TWEAKLINE_URL: '', TWEAKLINE_TOKEN: '' }), (error) => /run tweakline token new --name X/.test(error.stderr));
});
