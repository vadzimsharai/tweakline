import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaStore, prepareUploads, base64Bytes, MAX_UPLOAD_BYTES } from '../lib/media.js';

function fakeDb(finish) {
  const db = { closed: false, close() { db.closed = true; } };
  db.transaction = () => {
    const tx = { error: null, objectStore: () => ({ put: () => ({ result: 'key' }) }) };
    setTimeout(() => finish(tx), 0);
    return tx;
  };
  return db;
}

test('an aborted media transaction rejects instead of hanging', async () => {
  const db = fakeDb((tx) => { tx.error = new Error('QuotaExceededError'); tx.onabort(); });
  const media = createMediaStore(async () => db);
  await assert.rejects(media('readwrite', (s) => s.put({})), /QuotaExceeded/);
  assert.equal(db.closed, true);
});

test('a failed media transaction rejects, a complete one resolves with the request result', async () => {
  await assert.rejects(createMediaStore(async () => fakeDb((tx) => { tx.error = new Error('broken'); tx.onerror(); }))('readwrite', (s) => s.put({})), /broken/);
  assert.equal(await createMediaStore(async () => fakeDb((tx) => tx.oncomplete()))('readwrite', (s) => s.put({})), 'key');
});

const dataUrl = (bytes) => `data:video/webm;base64,${Buffer.alloc(bytes).toString('base64')}`;

test('base64Bytes counts decoded bytes', () => {
  for (const n of [0, 1, 2, 3, 10, 1000]) assert.equal(base64Bytes(Buffer.alloc(n).toString('base64')), n);
});

test('a media id missing from the gallery is an error, not a silently dropped file', async () => {
  const items = { a: { kind: 'shot', dataUrl: 'data:image/png;base64,AAAA' } };
  await assert.rejects(prepareUploads(['a', 'gone'], async (id) => items[id]), /no longer in the gallery/);
});

test('a recording over the server file limit is refused before any upload', async () => {
  const items = { small: { kind: 'shot', dataUrl: dataUrl(10) }, big: { kind: 'video', dataUrl: dataUrl(MAX_UPLOAD_BYTES + 1) } };
  await assert.rejects(prepareUploads(['small', 'big'], async (id) => items[id]), /screen\.webm is 10\.0 MB, the server takes files up to 10 MB/);
  const ok = await prepareUploads(['small'], async (id) => items[id]);
  assert.deepEqual(ok.map((u) => [u.name, u.kind]), [['page.png', 'shot']]);
  assert.equal((await prepareUploads(['x'], async () => ({ kind: 'video', dataUrl: dataUrl(MAX_UPLOAD_BYTES) })))[0].name, 'screen.webm', 'exactly the limit passes');
});
