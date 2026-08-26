import { readFileSync } from 'node:fs';
export function revenueByRegion() {
  const [head, ...rows] = readFileSync('data/orders.csv', 'utf8').trim().split('\n');
  const cols = head.split(',');
  const ri = cols.indexOf('region'), ai = cols.indexOf('amount');
  const sums = {};
  for (const r of rows) {
    const c = r.split(',');
    sums[c[ri]] = (sums[c[ri]] ?? 0) + Number(c[ai]);
  }
  return Object.entries(sums)
    .map(([r, v]) => [r, Math.round(v * 100) / 100])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
