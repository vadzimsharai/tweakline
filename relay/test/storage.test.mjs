import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openCredentials, openStore } from '../store.mjs';
import { addressOf, boot, bootWithDevice, connectExt, tempDir } from './helpers.mjs';

const TRUNCATED = '{"id":"abc","tok';
const WEEK_AND_A_DAY_MS = 8 * 24 * 3600 * 1000;

function captureErrors(t) {
  const lines = [];
  const original = console.error;
  console.error = (...parts) => lines.push(parts.join(' '));
  t.after(() => { console.error = original; });
  return lines;
}

test('putFile writes the body and atomic metadata, nothing temporary is left', () => {
  const dataDir = tempDir();
  const store = openStore(dataDir);
  const { id } = store.putFile({ session: 's1', name: 'a.txt', type: 'text/plain', body: Buffer.from('x') });
  const names = fs.readdirSync(path.join(dataDir, 'files')).sort();
  assert.deepEqual(names, [`${id}.bin`, `${id}.json`]);
  assert.equal(store.getFile(id, 's1').body.toString(), 'x');
});

test('the file sweep skips a corrupt metadata file and logs its path', (t) => {
  const dataDir = tempDir();
  const store = openStore(dataDir);
  const { id } = store.putFile({ session: 's1', name: 'a', type: 'text/plain', body: Buffer.from('x') });
  const corrupt = path.join(dataDir, 'files', 'broken.json');
  fs.writeFileSync(corrupt, TRUNCATED);
  const errors = captureErrors(t);
  store.sweepFiles(Date.now() + WEEK_AND_A_DAY_MS);
  assert.ok(!fs.existsSync(path.join(dataDir, 'files', `${id}.json`)));
  assert.ok(errors.some((line) => line.includes(corrupt)), errors.join('\n'));
  assert.equal(store.getFile('broken', 's1'), null);
});

test('a corrupt session file is skipped at startup, the others load', async (t) => {
  const first = await bootWithDevice(t);
  const { data } = await first.ext.call('session.create', { kind: 'page', tab: 1 });
  await first.close();
  const corrupt = path.join(first.dataDir, 'sessions', 'broken.json');
  fs.writeFileSync(corrupt, TRUNCATED);
  const errors = captureErrors(t);
  const second = await boot(t, { dataDir: first.dataDir });
  assert.ok(errors.some((line) => line.includes(corrupt)), errors.join('\n'));
  const url = addressOf(data).replace(first.base, second.base);
  assert.equal((await fetch(url)).status, 200);
});

test('a corrupt patches.json is skipped at startup and the server starts with no patches', async (t) => {
  const dataDir = tempDir();
  const corrupt = path.join(dataDir, 'patches.json');
  fs.writeFileSync(corrupt, TRUNCATED);
  const errors = captureErrors(t);
  const { ext } = await bootWithDevice(t, { dataDir });
  assert.ok(errors.some((line) => line.includes(corrupt)), errors.join('\n'));
  assert.deepEqual((await ext.call('patch.list')).data, []);
  await ext.call('patch.put', { patch: { site: 'a.example', title: 'T', css: 'a{}' } });
  const kept = fs.readdirSync(dataDir).filter((name) => name.startsWith('patches.json.corrupt-'));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(dataDir, kept[0]), 'utf8'), TRUNCATED);
  assert.ok(errors.some((line) => line.includes(path.join(dataDir, kept[0]))), errors.join('\n'));
  assert.equal(JSON.parse(fs.readFileSync(corrupt, 'utf8')).length, 1);
});

test('a corrupt credential record is skipped, other devices and tokens still work', async (t) => {
  const { relay, base, dataDir, device } = await bootWithDevice(t);
  const corrupt = path.join(dataDir, 'devices', 'broken.json');
  fs.writeFileSync(corrupt, TRUNCATED);
  fs.writeFileSync(path.join(dataDir, 'mcp-tokens', 'broken.json'), TRUNCATED);
  fs.writeFileSync(path.join(dataDir, 'pair-codes', 'broken.json'), TRUNCATED);
  const errors = captureErrors(t);
  const again = connectExt(t, base, device);
  await again.ready;
  const credentials = openCredentials(dataDir);
  assert.equal(credentials.list().filter((record) => record.kind === 'device').length, 1);
  assert.equal(credentials.mcpTokenByToken('nope'), null);
  credentials.sweepPairCodes();
  const paired = await fetch(`${base}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: relay.createPairCode(), name: 'x' }) });
  assert.equal(paired.status, 200);
  assert.ok(errors.some((line) => line.includes(corrupt)), errors.join('\n'));
});
