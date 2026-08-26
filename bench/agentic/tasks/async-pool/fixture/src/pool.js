export async function mapPool(items, fn, limit) {
  const out = [];
  await Promise.all(items.map(async (it) => { out.push(await fn(it)); }));
  return out;
}
