import test from 'node:test';
import assert from 'node:assert/strict';
import { revenueByRegion } from '../src/report.js';
test('aggregates, rounds, sorts desc with alpha ties', () => {
  assert.deepEqual(revenueByRegion(), [['emea', 1400.5], ['apac', 900], ['na', 900], ['latam', 10.1]]);
});
