import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logServerError } from '../site/src/lib/server/safe-server-log.ts';

const ROOT = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

test('structured server errors expose only the closed operational schema', () => {
  const lines: string[] = [];
  const requestId = '123e4567-e89b-42d3-a456-426614174000';
  logServerError(requestId, 'stripe_webhook', (line) => lines.push(line));
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), {
    schema_version: 1,
    event: 'server_error',
    severity: 'error',
    boundary: 'stripe_webhook',
    request_id: requestId,
  });
});

test('structured server errors discard hostile values and logging failures never escape', () => {
  const secret = 'sk_test_must_never_be_logged';
  const lines: string[] = [];
  logServerError(`https://example.test/?token=${secret}`, `owner_${secret}`, (line) => lines.push(line));
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), {
    schema_version: 1,
    event: 'server_error',
    severity: 'error',
    boundary: 'unknown',
    request_id: 'invalid',
  });
  assert.doesNotMatch(lines[0]!, /example|token|owner|sk_test/);
  assert.doesNotThrow(() => logServerError(null, null, () => { throw new Error(secret); }));
});

test('unexpected API, operation, intent and entitlement failures use the safe logger', () => {
  const api = read('site/src/lib/server/api-http.ts');
  const middleware = read('site/functions/api/_middleware.ts');
  const operations = read('site/src/lib/server/build-plan-operations-api.ts');
  const intents = read('site/src/lib/server/product-intent-api.ts');
  const entitlement = read('site/src/lib/server/entitlement-api.ts');
  assert.match(api, /code === 'INTERNAL_ERROR'[\s\S]*logServerError/);
  assert.match(api, /logServerError\(requestId, 'rate_limit'\)/);
  assert.match(middleware, /logBoundary: 'stripe_webhook'/);
  assert.match(middleware, /logBoundary: 'account_api'/);
  assert.match(operations, /code === 'INTERNAL_ERROR'\) logServerError\(id, 'build_plan_operations'\)/);
  assert.match(intents, /code === 'INTERNAL_ERROR'\) logServerError\(id, 'product_intents'\)/);
  assert.match(entitlement, /logServerError\(requestId, 'entitlement'\)/);
});
