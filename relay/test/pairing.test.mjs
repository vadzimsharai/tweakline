import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { openCredentials } from '../store.mjs';
import { addressOf, boot, bootWithDevice, connectExt, delay, DOMAIN, pairDevice, postPair, runCli, tempDir, tokenOf, walkFiles } from './helpers.mjs';

function getWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
  });
}

test('/tweakline shows identity and addresses without secrets', async (t) => {
  const { relay, base } = await boot(t, { domain: 'gate.example:8443', version: '1.2.3' });
  const res = await fetch(`${base}/tweakline`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await res.json(), {
    name: 'tweakline',
    version: '1.2.3',
    addresses: [{ kind: 'local', url: base }, { kind: 'public', url: 'https://gate.example:8443' }],
  });
  assert.deepEqual(relay.addresses, [{ kind: 'local', url: base }, { kind: 'public', url: 'https://gate.example:8443' }]);
});

test('without a domain only the local address exists', async (t) => {
  const { relay, base } = await boot(t, { domain: null });
  assert.deepEqual(relay.addresses, [{ kind: 'local', url: base }]);
  const { addresses } = await (await fetch(`${base}/tweakline`)).json();
  assert.deepEqual(addresses, [{ kind: 'local', url: base }]);
});

test('default bind is loopback', async (t) => {
  const { relay } = await boot(t);
  assert.equal(relay.host, '127.0.0.1');
  const outside = Object.values(os.networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal);
  if (outside) await assert.rejects(fetch(`http://${outside.address}:${relay.port}/tweakline`));
});

test('pair preflight is allowed from any origin', async (t) => {
  const { base } = await boot(t);
  const res = await fetch(`${base}/pair`, { method: 'OPTIONS', headers: { origin: 'chrome-extension://x', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  assert.ok(res.status < 300);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('access-control-allow-headers'), /content-type/);
});

test('a pair code works once and gives a device token', async (t) => {
  const { relay, base } = await boot(t);
  const code = relay.createPairCode();
  const first = await postPair(base, { code, name: 'fold' });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('access-control-allow-origin'), '*');
  const body = await first.json();
  assert.ok(Buffer.from(body.deviceToken, 'base64url').length >= 32);
  assert.ok(body.deviceId);
  assert.deepEqual(body.addresses, relay.addresses);
  assert.equal((await postPair(base, { code, name: 'fold' })).status, 401);
});

test('a wrong or malformed code answers 401', async (t) => {
  const { base } = await boot(t);
  assert.equal((await postPair(base, { code: 'nope', name: 'x' })).status, 401);
  assert.equal((await postPair(base, { name: 'x' })).status, 401);
  assert.equal((await postPair(base, { code: 42, name: 'x' })).status, 401);
});

test('an expired code answers 401', async (t) => {
  const { dataDir, base } = await boot(t);
  const code = openCredentials(dataDir).createPairCode(-1);
  assert.equal((await postPair(base, { code, name: 'x' })).status, 401);
});

test('a pair code lives ten minutes', async (t) => {
  const dataDir = tempDir();
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const credentials = openCredentials(dataDir);
  const before = Date.now();
  credentials.createPairCode();
  const [file] = walkFiles(dataDir);
  const { expiresAt } = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Math.abs(expiresAt - before - 10 * 60 * 1000) < 2000);
});

test('more than ten failed attempts a minute are refused, even with the right code', async (t) => {
  const { relay, base } = await boot(t);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal((await postPair(base, { code: 'wrong', name: 'x' })).status, 401);
  }
  assert.equal((await postPair(base, { code: 'wrong', name: 'x' })).status, 429);
  assert.equal((await postPair(base, { code: relay.createPairCode(), name: 'x' })).status, 429);
});

test('the rate limit ignores forwarded addresses unless a domain says there is a proxy', async (t) => {
  const direct = await boot(t, { domain: null });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await postPair(direct.base, { code: 'wrong' }, { 'x-forwarded-for': `10.0.0.${attempt}` });
  }
  assert.equal((await postPair(direct.base, { code: 'wrong' }, { 'x-forwarded-for': '10.0.1.1' })).status, 429);

  const proxied = await boot(t);
  for (let attempt = 0; attempt < 11; attempt += 1) {
    await postPair(proxied.base, { code: 'wrong' }, { 'x-forwarded-for': '198.51.100.1' });
  }
  assert.equal((await postPair(proxied.base, { code: 'wrong' }, { 'x-forwarded-for': '198.51.100.1' })).status, 429);
  assert.equal((await postPair(proxied.base, { code: 'wrong' }, { 'x-forwarded-for': '198.51.100.2' })).status, 401);
  assert.equal((await postPair(proxied.base, { code: 'wrong' }, { 'x-forwarded-for': '203.0.113.9, 198.51.100.1' })).status, 429);
});

test('a code from tweakline pair run as a separate process is accepted by a running server', async (t) => {
  const { dataDir, base } = await boot(t);
  const { stdout } = await runCli(['pair', '--data', dataDir]);
  const link = stdout.trim();
  assert.ok(link.startsWith('https://wg.test/pair#'), link);
  const code = link.split('#')[1];
  assert.equal((await postPair(base, { code, name: 'cli' })).status, 200);
  assert.equal((await postPair(base, { code, name: 'cli' })).status, 401);
});

test('hello with a device token works, a revoked one closes 4003', async (t) => {
  const { dataDir, relay, base } = await boot(t);
  const device = await pairDevice(relay, base);
  const ext = connectExt(t, base, device);
  await ext.ready;
  assert.equal(openCredentials(dataDir).revoke(device.deviceId), 'device');
  ext.call('session.list');
  assert.equal(await ext.closed, 4003);
  const again = connectExt(t, base, device);
  assert.equal(await again.closed, 4003);
});

test('revoking a device from the CLI kills its session addresses', async (t) => {
  const { dataDir, ext, device } = await bootWithDevice(t);
  const { data } = await ext.call('session.create', { kind: 'page', tab: 1 });
  assert.equal((await fetch(addressOf(data))).status, 200);
  await runCli(['token', 'revoke', device.deviceId, '--data', dataDir]);
  assert.equal((await fetch(addressOf(data))).status, 404);
});

test('a second socket with the same device replaces the first with 4004', async (t) => {
  const { base, device, ext } = await bootWithDevice(t);
  const second = connectExt(t, base, device);
  await second.ready;
  assert.equal(await ext.closed, 4004);
  assert.equal((await second.call('session.list')).ok, true);
});

test('hello accepts a Russian browser name and updates it on the sessions', async (t) => {
  const { base, device, ext } = await bootWithDevice(t);
  const { data } = await ext.call('session.create', { kind: 'page', tab: 1 });
  assert.equal(data.device, 'b1');
  const renamed = connectExt(t, base, { ...device, name: 'Телефон' });
  await renamed.ready;
  assert.equal((await renamed.call('session.list')).data[0].device, 'Телефон');
});

test('device A cannot list or touch the session of device B', async (t) => {
  const { relay, base, ext: extA } = await bootWithDevice(t);
  const deviceB = await pairDevice(relay, base, 'b2');
  const extB = connectExt(t, base, { ...deviceB, name: 'b2' });
  await extB.ready;
  const { data: session } = await extB.call('session.create', { kind: 'page', tab: 1 });
  const { data: file } = await extB.call('file.put', { session: session.id, name: 'f', type: 'text/plain', base64: 'aGk=' });
  assert.deepEqual((await extA.call('session.list')).data, []);
  const denied = [
    ['session.revoke', { id: session.id }],
    ['session.history', { id: session.id }],
    ['session.setTab', { id: session.id, tab: 9 }],
    ['session.address', { id: session.id }],
    ['user.say', { session: session.id, text: 'x' }],
    ['user.action', { session: session.id, action: 'x' }],
    ['user.access', { session: session.id, grant: {} }],
    ['user.patch', { session: session.id, patch: {} }],
    ['file.put', { session: session.id, name: 'f', type: 't', base64: 'aGk=' }],
    ['file.get', { session: session.id, file: file.id }],
  ];
  for (const [method, params] of denied) {
    const reply = await extA.call(method, params);
    assert.equal(reply.ok, false, method);
    assert.equal(reply.error, 'unknown session', method);
  }
  assert.equal((await extB.call('session.list')).data.length, 1);
});

test('a done from another device does not answer a do', async (t) => {
  const { relay, base, ext: extA } = await bootWithDevice(t);
  const deviceB = await pairDevice(relay, base, 'b2');
  const extB = connectExt(t, base, deviceB);
  await extB.ready;
  const { data: session } = await extA.call('session.create', { kind: 'page', tab: 1 });
  const doing = fetch(`${addressOf(session)}do`, { method: 'POST', body: '{"op":"read"}' }).then((r) => r.json());
  const cmd = await extA.next('do');
  extB.send({ type: 'done', id: cmd.id, ok: true, data: 'forged' });
  await delay(30);
  extA.send({ type: 'done', id: cmd.id, ok: true, data: 'real' });
  assert.deepEqual(await doing, { ok: true, data: 'real' });
});

test('addresses list local and public with the same token', async (t) => {
  const { base, ext } = await bootWithDevice(t);
  const { data } = await ext.call('session.create', { kind: 'page', tab: 1 });
  assert.deepEqual(data.addresses.map((a) => a.kind), ['local', 'public']);
  const token = tokenOf(addressOf(data));
  assert.equal(addressOf(data), `${base}/s/${token}/`);
  assert.equal(addressOf(data, 'public'), `https://${DOMAIN}/s/${token}/`);
  for (const field of ['kind', 'tab', 'title', 'ai', 'createdAt', 'lastAt', 'seq', 'polling', 'device']) assert.ok(field in data, field);
});

test('instructions name the address they were read through, never a forged host', async (t) => {
  const { ext } = await bootWithDevice(t);
  const { data } = await ext.call('session.create', { kind: 'page', tab: 1 });
  const local = addressOf(data);
  const publicUrl = addressOf(data, 'public');
  const viaLocal = await (await fetch(local)).text();
  assert.ok(viaLocal.includes(local));
  assert.ok(!viaLocal.includes(publicUrl));
  const viaPublic = await getWithHost(local, DOMAIN);
  assert.ok(viaPublic.includes(publicUrl));
  const viaForged = await getWithHost(local, 'evil.example');
  assert.ok(!viaForged.includes('evil.example'));
  assert.ok(viaForged.includes(publicUrl));
});

test('session.address mints a working token and revoke kills them all', async (t) => {
  const { ext } = await bootWithDevice(t);
  const { data } = await ext.call('session.create', { kind: 'page', tab: 1 });
  const { data: minted } = await ext.call('session.address', { id: data.id });
  assert.equal(minted.id, data.id);
  assert.deepEqual(minted.addresses.map((a) => a.kind), ['local', 'public']);
  assert.notEqual(tokenOf(addressOf(minted)), tokenOf(addressOf(data)));
  assert.equal((await fetch(addressOf(minted))).status, 200);
  assert.equal((await fetch(addressOf(data))).status, 200);
  await ext.call('session.revoke', { id: data.id });
  assert.equal((await fetch(addressOf(minted))).status, 404);
  assert.equal((await fetch(addressOf(data))).status, 404);
});

test('session tokens from session.address survive a restart', async (t) => {
  const first = await bootWithDevice(t);
  const { data } = await first.ext.call('session.create', { kind: 'page', tab: 1 });
  const { data: minted } = await first.ext.call('session.address', { id: data.id });
  await first.close();
  const second = await boot(t, { dataDir: first.dataDir });
  assert.equal((await fetch(addressOf(minted).replace(first.base, second.base))).status, 200);
});

test('data files contain no raw tokens or pair codes', async (t) => {
  const { relay, dataDir, device, ext } = await bootWithDevice(t);
  const { data } = await ext.call('session.create', { kind: 'page', tab: 1 });
  const { data: minted } = await ext.call('session.address', { id: data.id });
  const { token: mcpToken } = openCredentials(dataDir).createMcpToken('ai');
  const unusedCode = relay.createPairCode();
  const secrets = [device.deviceToken, tokenOf(addressOf(data)), tokenOf(addressOf(minted)), mcpToken, unusedCode];
  const files = walkFiles(dataDir);
  assert.ok(files.length >= 4);
  for (const file of files) {
    const text = file + fs.readFileSync(file, 'latin1');
    for (const secret of secrets) assert.ok(!text.includes(secret), `${path.basename(file)} holds a secret`);
  }
});

test('session files of the first build are ignored', async (t) => {
  const dataDir = tempDir();
  fs.mkdirSync(path.join(dataDir, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'sessions', 'old.json'), JSON.stringify({ id: 'old', tokenHash: 'abc', owner: 'fold', events: [] }));
  const { ext } = await bootWithDevice(t, { dataDir });
  assert.deepEqual((await ext.call('session.list')).data, []);
});

test('POST /pair without a JSON content type answers 415 and spends no code', async (t) => {
  const { relay, base } = await boot(t);
  const code = relay.createPairCode();
  for (const type of [undefined, 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
    const res = await fetch(`${base}/pair`, { method: 'POST', headers: type ? { 'content-type': type } : {}, body: JSON.stringify({ code, name: 'x' }) });
    assert.equal(res.status, 415, String(type));
  }
  assert.equal((await postPair(base, { code, name: 'x' }, { 'content-type': 'application/json; charset=utf-8' })).status, 200);
});

test('device.revokeSelf revokes the calling browser, its sessions and their files, and closes its socket', async (t) => {
  const { ext, base, dataDir, device } = await bootWithDevice(t);
  const { data: session } = await ext.call('session.create', { kind: 'page', tab: 1 });
  await ext.call('file.put', { session: session.id, name: 'a', type: 'text/plain', base64: 'eA==' });
  assert.equal((await ext.call('device.revokeSelf')).ok, true);
  assert.equal(await ext.closed, 4003);
  assert.equal((await fetch(session.addresses[0].url)).status, 404);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'sessions')), []);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'files')), []);
  assert.equal(openCredentials(dataDir).list().filter((record) => record.kind === 'device').length, 0);
  const again = connectExt(t, base, device);
  assert.equal(await again.closed, 4003);
});
