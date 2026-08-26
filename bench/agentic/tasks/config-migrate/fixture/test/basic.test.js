import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateConfig } from '../src/migrate.js';
test('happy path', () => {
  assert.deepEqual(
    migrateConfig({ server: { host: 'db', port: 9000 }, timeoutSec: 2, features: ['a'] }),
    { listen: 'db:9000', timeoutMs: 2000, features: { a: true }, schemaVersion: 2 });
});
