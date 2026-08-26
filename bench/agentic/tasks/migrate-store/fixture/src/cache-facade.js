export function cached(store, key, producer, cb) {
  store.get(key, (err, hit) => {
    if (!err) return cb(null, hit);
    const value = producer();
    store.put(key, value, 0, () => cb(null, value));
  });
}
