import test from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter } from '../src/limiter.js';
test('allows under the cap', () => {
  const l = createLimiter(2, 1000);
  assert.equal(l.allow(0), true);
  assert.equal(l.allow(10), true);
  assert.equal(l.allow(20), false);
});
