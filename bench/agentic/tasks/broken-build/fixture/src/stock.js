import { sum, byId } from './util.js';
export function totalUnits(warehouses) {
  return sum(warehouses.map((w) => sum(w.counts)));
}
export function findItem(items, id) {
  return byId(items).get(id) ?? null;
}
