export function createCache(loader) {
  const values = new Map();
  let loads = 0;
  return {
    async get(key) {
      if (values.has(key)) return values.get(key);
      loads++;
      const value = await loader(key);
      values.set(key, value);
      return value;
    },
    invalidate(key) { values.delete(key); },
    stats() { return { loads }; },
  };
}
