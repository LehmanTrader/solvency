export async function cached(store, key, producer) {
  try { return await store.get(key); } catch {}
  const value = producer();
  await store.put(key, value);
  return value;
}
