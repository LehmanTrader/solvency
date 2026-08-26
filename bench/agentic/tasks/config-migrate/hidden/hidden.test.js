import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateConfig } from '../src/migrate.js';
test('defaults for missing server parts and timeout', () => {
  assert.deepEqual(migrateConfig({}), { listen: '0.0.0.0:8080', timeoutMs: 30000, features: {}, schemaVersion: 2 });
});
test('debug true injects log feature and is dropped', () => {
  const out = migrateConfig({ debug: true, features: ['x'] });
  assert.deepEqual(out.features, { x: true, log: true });
  assert.ok(!('debug' in out));
});
test('debug false just drops', () => {
  assert.deepEqual(migrateConfig({ debug: false }).features, {});
});
test('passthrough keys survive, schemaVersion forced', () => {
  const out = migrateConfig({ name: 'svc', schemaVersion: 99, extra: { deep: 1 } });
  assert.equal(out.name, 'svc');
  assert.equal(out.schemaVersion, 2);
  assert.deepEqual(out.extra, { deep: 1 });
  assert.ok(!('server' in out) || out.server === undefined);
});
test('duplicate features collapse; input not mutated', () => {
  const v1 = { features: ['a', 'a', 'b'] };
  const out = migrateConfig(v1);
  assert.deepEqual(out.features, { a: true, b: true });
  assert.deepEqual(v1, { features: ['a', 'a', 'b'] });
});
