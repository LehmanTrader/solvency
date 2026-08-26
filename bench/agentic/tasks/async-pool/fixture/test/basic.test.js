import test from 'node:test';
import assert from 'node:assert/strict';
import { mapPool } from '../src/pool.js';
test('maps values', async () => {
  assert.deepEqual(await mapPool([1,2,3], async (n) => n * 2, 2), [2,4,6]);
});
