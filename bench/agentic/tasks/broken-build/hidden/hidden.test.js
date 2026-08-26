import test from 'node:test';
import assert from 'node:assert/strict';
import { sum, byId } from '../src/util.js';
import { lowStock } from '../src/report.js';
test('sum identity holds', () => assert.equal(sum([10]), 10));
test('byId key type preserved', () => {
  const m = byId([{ id: 1 }]);
  assert.ok(m.has(1));
  assert.ok(!m.has('1'));
});
test('lowStock is deterministic and synchronous-safe', async () => {
  const wh = [{ perItem: { 9: 1 } }];
  const r = await lowStock(wh, [{ id: 9, name: 'z' }], 5);
  assert.deepEqual(r, [{ id: 9, name: 'z', units: 1 }]);
});
