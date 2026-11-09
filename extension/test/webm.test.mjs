import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withWebmDuration, webmDataUrlWithDuration } from '../lib/webm.js';

const element = (id, body) => [...id, 0x80 | body.length, ...body];
const UNKNOWN_SIZE = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const float64 = (value) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, value); return [...b]; };

function webm({ scale = [0x0f, 0x42, 0x40], duration = null } = {}) {
  const info = [
    ...element([0x2a, 0xd7, 0xb1], scale),
    ...element([0x4d, 0x80], [...'Chrome'].map((c) => c.charCodeAt(0))),
    ...(duration === null ? [] : element([0x44, 0x89], float64(duration))),
  ];
  const cluster = [0x1f, 0x43, 0xb6, 0x75, ...UNKNOWN_SIZE, 0xe7, 0x81, 0x00];
  return Uint8Array.from([
    ...element([0x1a, 0x45, 0xdf, 0xa3], element([0x42, 0x82], [...'webm'].map((c) => c.charCodeAt(0)))),
    0x18, 0x53, 0x80, 0x67, ...UNKNOWN_SIZE,
    ...element([0x15, 0x49, 0xa9, 0x66], info),
    ...cluster,
  ]);
}

function durationOf(bytes) {
  for (let i = 0; i < bytes.length - 10; i++) {
    if (bytes[i] === 0x44 && bytes[i + 1] === 0x89 && bytes[i + 2] === 0x88) return new DataView(bytes.buffer, bytes.byteOffset + i + 3, 8).getFloat64(0);
  }
  return null;
}

test('a recording without a duration gets one, in timecode units, and keeps its frames', () => {
  const original = webm();
  const fixed = withWebmDuration(original, 3200);
  assert.equal(durationOf(original), null);
  assert.equal(durationOf(fixed), 3200);
  assert.deepEqual([...fixed.subarray(fixed.length - 15)], [...original.subarray(original.length - 15)], 'the cluster stays as it was');
});

test('the duration follows the timecode scale', () => {
  assert.equal(durationOf(withWebmDuration(webm({ scale: [0x98, 0x96, 0x80] }), 3000)), 300);
});

test('an existing duration is replaced in place', () => {
  const original = webm({ duration: 0 });
  const fixed = withWebmDuration(original, 1500);
  assert.equal(fixed.length, original.length);
  assert.equal(durationOf(fixed), 1500);
});

test('anything that is not a WebM, or no duration, is left alone', () => {
  const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  assert.equal(withWebmDuration(png, 1000), png);
  const original = webm();
  assert.equal(withWebmDuration(original, 0), original);
  assert.equal(withWebmDuration(original.subarray(0, 20), 1000).length, 20);
});

test('a WebM data URL comes back with the duration, other data URLs unchanged', () => {
  const original = webm();
  const url = `data:video/webm;codecs=vp8;base64,${Buffer.from(original).toString('base64')}`;
  const fixed = webmDataUrlWithDuration(url, 2000);
  assert.match(fixed, /^data:video\/webm;codecs=vp8;base64,/);
  assert.equal(durationOf(new Uint8Array(Buffer.from(fixed.split(',')[1], 'base64'))), 2000);
  assert.equal(webmDataUrlWithDuration('data:image/png;base64,AAAA', 2000), 'data:image/png;base64,AAAA');
});
