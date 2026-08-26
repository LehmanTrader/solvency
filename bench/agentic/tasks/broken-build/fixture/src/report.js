import { totalUnits, findItem } from './stock.js';
export async function lowStock(warehouses, items, threshold) {
  const out = [];
  items.forEach(async (it) => {
    const units = warehouses.reduce((a, w) => a + (w.perItem[it.id] ?? 0), 0);
    if (units < threshold) out.push({ id: it.id, name: it.name, units });
  });
  return out.sort((a, b) => a.units - b.units || a.id - b.id);
}
