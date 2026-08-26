export function createCache(loader) {
  const values = new Map();
  const inflight = new Map(); // key -> { promise, epoch }
  const epochs = new Map();   // key -> invalidation epoch
  let loads = 0;
  return {
    async get(key) {
      if (values.has(key)) return values.get(key);
      if (inflight.has(key)) return inflight.get(key).promise;
      loads++;
      const epoch = epochs.get(key) ?? 0;
      const promise = (async () => {
        try {
          const value = await loader(key);
          if ((epochs.get(key) ?? 0) === epoch) values.set(key, value);
          return value;
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, { promise, epoch });
      return promise;
    },
    invalidate(key) {
      values.delete(key);
      epochs.set(key, (epochs.get(key) ?? 0) + 1);
    },
    stats() { return { loads }; },
  };
}
