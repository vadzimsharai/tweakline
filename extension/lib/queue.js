// Tasks with the same key run one after another; a failed task does not stop the ones queued behind it.
export function createKeyedQueue() {
  const tails = new Map();
  return {
    run(key, task) {
      const result = (tails.get(key) || Promise.resolve()).then(task);
      const tail = result.then(() => {}, () => {});
      tails.set(key, tail);
      tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
      return result;
    },
    forget: (key) => tails.delete(key),
    has: (key) => tails.has(key),
  };
}
