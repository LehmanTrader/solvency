export function createStore() {
  const data = new Map();
  return {
    async get(key) {
      if (!data.has(key)) throw new Error(`not found: ${key}`);
      return data.get(key);
    },
    async put(key, value, { ttlMs } = {}) { data.set(key, value); },
    async del(key) { return data.delete(key); },
  };
}
