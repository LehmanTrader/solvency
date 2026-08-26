import test from 'node:test';
import assert from 'node:assert/strict';
import { sum, byId } from '../src/util.js';
import { totalUnits, findItem } from '../src/stock.js';
import { lowStock } from '../src/report.js';
test('sum starts at zero', () => { assert.equal(sum([]), 0); assert.equal(sum([1,2,3]), 6); });
test('byId works with numeric ids', () => {
  assert.deepEqual(byId([{ id: 7, name: 'x' }]).get(7), { id: 7, name: 'x' });
});
test('totalUnits composes', () => {
  assert.equal(totalUnits([{ counts: [1,2] }, { counts: [3] }]), 6);
});
test('findItem by numeric id', () => {
  assert.deepEqual(findItem([{ id: 3, name: 'bolt' }], 3), { id: 3, name: 'bolt' });
});
test('lowStock aggregates across warehouses and sorts', async () => {
  const wh = [{ perItem: { 1: 5, 2: 0 } }, { perItem: { 1: 1, 2: 2 } }];
  const items = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }];
  assert.deepEqual(await lowStock(wh, items, 7), [
    { id: 2, name: 'b', units: 2 },
    { id: 1, name: 'a', units: 6 },
  ]);
});
