import test from 'node:test';
import assert from 'node:assert/strict';
import { plan } from '../src/scheduler.js';

test('diamond with limit 2, alphabetical fill', () => {
  const g = { a: [], b: ['a'], c: ['a'], d: ['b', 'c'] };
  assert.deepEqual(plan(g, 2), [['a'], ['b', 'c'], ['d']]);
});
test('limit 1 serializes alphabetically within readiness', () => {
  const g = { a: [], b: ['a'], c: ['a'], d: ['b', 'c'], e: [] };
  assert.deepEqual(plan(g, 1), [['a'], ['e'], ['b'], ['c'], ['d']]);
});
test('wide layer splits across batches by limit', () => {
  const g = { a: [], p: ['a'], q: ['a'], r: ['a'], s: ['a'], z: ['p', 'q', 'r', 's'] };
  assert.deepEqual(plan(g, 3), [['a'], ['p', 'q', 'r'], ['s'], ['z']]);
});
test('unknown dependency names the first offender', () => {
  const g = { b: ['ghost'], a: ['b'] };
  assert.throws(() => plan(g, 2), (e) => e.message === 'unknown dependency ghost of b');
});
test('cycle path starts at the smallest id and follows dependencies', () => {
  const g = { c: ['a'], a: ['b'], b: ['c'], x: [] };
  assert.throws(() => plan(g, 2), (e) => e.message === 'cycle: a -> b -> c -> a');
});
test('two-node cycle', () => {
  const g = { m: ['n'], n: ['m'] };
  assert.throws(() => plan(g, 4), (e) => e.message === 'cycle: m -> n -> m');
});
test('empty input', () => { assert.deepEqual(plan({}, 3), []); });
