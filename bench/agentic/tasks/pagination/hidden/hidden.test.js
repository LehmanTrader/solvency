import test from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from '../src/paginate.js';
test('exact multiple has no phantom page', () => {
  assert.deepEqual(paginate([1,2,3,4], 2, 2), { page: 2, totalPages: 2, items: [3,4] });
});
test('page slice never overlaps the next page', () => {
  assert.deepEqual(paginate([1,2,3,4,5], 1, 2).items, [1,2]);
});
test('page below 1 clamps up', () => {
  assert.deepEqual(paginate([1,2,3], 0, 2), { page: 1, totalPages: 2, items: [1,2] });
});
test('page beyond the end clamps down', () => {
  assert.deepEqual(paginate([1,2,3], 9, 2), { page: 2, totalPages: 2, items: [3] });
});
test('empty list', () => {
  assert.deepEqual(paginate([], 5, 10), { page: 1, totalPages: 1, items: [] });
});
