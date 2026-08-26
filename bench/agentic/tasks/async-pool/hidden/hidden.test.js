import test from 'node:test';
import assert from 'node:assert/strict';
import { mapPool } from '../src/pool.js';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test('results stay in input order under uneven latency', async () => {
  const r = await mapPool([50, 5, 25], async (ms) => { await sleep(ms); return ms; }, 3);
  assert.deepEqual(r, [50, 5, 25]);
});
test('never exceeds the limit and actually overlaps work', async () => {
  let inFlight = 0, peak = 0;
  await mapPool(Array.from({ length: 8 }, (_, i) => i), async () => {
    inFlight++; peak = Math.max(peak, inFlight);
    await sleep(20);
    inFlight--;
  }, 3);
  assert.ok(peak <= 3, `peak ${peak} > limit`);
  assert.ok(peak >= 2, `peak ${peak} shows no real concurrency`);
});
