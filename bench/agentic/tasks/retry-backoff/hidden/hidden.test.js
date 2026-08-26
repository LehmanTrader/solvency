import test from 'node:test';
import assert from 'node:assert/strict';
import { retry } from '../src/retry.js';

const harness = () => {
  const slept = [];
  return { slept, sleep: async (ms) => { slept.push(ms); }, jitter: (ms) => ms + 1 };
};

test('succeeds third try with exact backoff sequence', async () => {
  const h = harness();
  let calls = 0;
  const out = await retry(async (n) => { calls++; if (n < 3) { const e = new Error('boom'); e.code = 'E'; throw e; } return 'ok'; },
    { retries: 5, baseMs: 100, factor: 2, capMs: 10_000, budgetMs: 60_000, retryable: () => true, ...h });
  assert.equal(out.value, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(h.slept, [101, 201]);
  assert.deepEqual(out.attempts, [{ n: 1, delayMs: 0 }, { n: 2, delayMs: 101 }, { n: 3, delayMs: 201 }]);
});
test('cap applies before jitter', async () => {
  const h = harness();
  await retry(async (n) => { if (n < 4) throw new Error('x'); return 1; },
    { retries: 5, baseMs: 4000, factor: 10, capMs: 5000, budgetMs: 60_000, retryable: () => true, ...h }).catch(() => {});
  assert.deepEqual(h.slept, [4001, 5001, 5001]);
});
test('exhausted retries reject with history and marker', async () => {
  const h = harness();
  const err = await retry(async () => { throw new Error('always'); },
    { retries: 2, baseMs: 10, factor: 2, capMs: 100, budgetMs: 1000, retryable: () => true, ...h }).then(() => null, (e) => e);
  assert.equal(err.message, 'always');
  assert.equal(err.retryStopped, 'exhausted');
  assert.deepEqual(err.attempts.map((a) => a.delayMs), [0, 11, 21]);
});
test('non-retryable rejects immediately without sleeping', async () => {
  const h = harness();
  const err = await retry(async () => { const e = new Error('fatal'); e.fatal = true; throw e; },
    { retries: 5, baseMs: 10, factor: 2, capMs: 100, budgetMs: 1000, retryable: (e) => !e.fatal, ...h }).then(() => null, (e) => e);
  assert.equal(err.retryStopped, 'non-retryable');
  assert.deepEqual(h.slept, []);
  assert.deepEqual(err.attempts, [{ n: 1, delayMs: 0 }]);
});
test('budget stops before overspending sleep', async () => {
  const h = harness();
  const err = await retry(async () => { throw new Error('slow'); },
    { retries: 10, baseMs: 100, factor: 1, capMs: 1000, budgetMs: 250, retryable: () => true, ...h }).then(() => null, (e) => e);
  // delays would be 101 each; 101 + 101 = 202 <= 250, third would hit 303 > 250
  assert.deepEqual(h.slept, [101, 101]);
  assert.equal(err.retryStopped, 'budget');
  assert.equal(err.message, 'slow');
});
