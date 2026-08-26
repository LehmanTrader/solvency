export function sum(xs) {
  return xs.reduce((a, b) => a + b, 0);
}
export function byId(items) {
  const m = new Map();
  for (const it of items) m.set(it.id, it);
  return m;
}
