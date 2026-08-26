import test from 'node:test';
import assert from 'node:assert/strict';
import { paginate } from '../src/paginate.js';
test('middle page', () => {
  assert.deepEqual(paginate([1,2,3,4,5], 2, 2), { page: 2, totalPages: 3, items: [3,4] });
});
