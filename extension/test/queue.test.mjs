import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeyedQueue } from '../lib/queue.js';
import { withLimit } from '../lib/limit.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('tasks with one key run one after another, other keys do not wait', async () => {
  const queue = createKeyedQueue();
  const order = [];
  let release;
  const first = queue.run(1, () => new Promise((resolve) => { release = resolve; }).then(() => order.push('first')));
  const second = queue.run(1, () => order.push('second'));
  const other = queue.run(2, () => order.push('other'));
  await other;
  assert.deepEqual(order, ['other']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['other', 'first', 'second']);
});

test('a failed task rejects its own caller only and the key is cleaned up', async () => {
  const queue = createKeyedQueue();
  const failed = queue.run(1, () => { throw new Error('boom'); });
  const next = queue.run(1, () => 'next');
  await assert.rejects(failed, /boom/);
  assert.equal(await next, 'next');
  await tick();
  assert.equal(queue.has(1), false);
});

test('forget drops the wait for a key', async () => {
  const queue = createKeyedQueue();
  queue.run(1, () => new Promise(() => {}));
  queue.forget(1);
  assert.equal(await queue.run(1, () => 'ran'), 'ran');
});

test('withLimit rejects with the message after the limit and passes a faster result through', async () => {
  await assert.rejects(withLimit(new Promise(() => {}), 5, 'too slow'), /too slow/);
  assert.equal(await withLimit(Promise.resolve('fast'), 1000, 'too slow'), 'fast');
});
