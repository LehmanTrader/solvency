import test from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter } from '../src/limiter.js';
test('window slides', () => {
  const l = createLimiter(2, 1000);
  assert.equal(l.allow(0), true);
  assert.equal(l.allow(500), true);
  assert.equal(l.allow(900), false);
  assert.equal(l.allow(1001), true); // the t=0 hit left the window
});
test('rejected calls are not recorded', () => {
  const l = createLimiter(1, 100);
  assert.equal(l.allow(0), true);
  assert.equal(l.allow(50), false);
  assert.equal(l.allow(101), true);
  assert.equal(l.allow(150), false);
});
test('boundary is half-open', () => {
  const l = createLimiter(1, 100);
  assert.equal(l.allow(0), true);
  assert.equal(l.allow(100), false); // the t=0 hit is exactly windowMs old and still counts
  assert.equal(l.allow(101), true);
});
