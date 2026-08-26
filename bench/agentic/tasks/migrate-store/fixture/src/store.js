// v1 store: callback-style, positional options, string errors.
export function createStore() {
  const data = new Map();
  return {
    get(key, cb) { queueMicrotask(() => data.has(key) ? cb(null, data.get(key)) : cb('NOT_FOUND')); },
    put(key, value, ttlMs, cb) { data.set(key, value); queueMicrotask(() => cb(null)); },
    del(key, cb) { const had = data.delete(key); queueMicrotask(() => cb(had ? null : 'NOT_FOUND')); },
  };
}
