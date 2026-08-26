import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../src/reconcile.js';
test('full report', () => {
  assert.deepEqual(reconcile(), {
    matched: 2,
    mismatched: [{ ref: 'A101', bank: 10.5, ledger: 11.5 }],
    missingInLedger: ['A102', 'A104'],
    missingInBank: ['A103'],
  });
});
