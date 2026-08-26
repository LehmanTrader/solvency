import test from 'node:test';
import assert from 'node:assert/strict';
import { createCache } from '../src/cache.js';

const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

test('single-flight: concurrent gets share one load', async () => {
  const g = gate();
  const cache = createCache(async (k) => { await g.p; return `v:${k}`; });
  const a = cache.get('k'), b = cache.get('k'), c = cache.get('k');
  g.open();
  assert.deepEqual(await Promise.all([a, b, c]), ['v:k', 'v:k', 'v:k']);
  assert.equal(cache.stats().loads, 1);
  assert.equal(await cache.get('k'), 'v:k');
  assert.equal(cache.stats().loads, 1);
});
test('distinct keys load independently', async () => {
  const cache = createCache(async (k) => k.toUpperCase());
  assert.deepEqual(await Promise.all([cache.get('a'), cache.get('b')]), ['A', 'B']);
  assert.equal(cache.stats().loads, 2);
});
test('invalidate during in-flight load prevents stale write-back', async () => {
  const g = gate();
  let n = 0;
  const cache = createCache(async () => { n++; if (n === 1) { await g.p; return 'stale'; } return 'fresh'; });
  const inflight = cache.get('k');
  cache.invalidate('k');
  g.open();
  assert.equal(await inflight, 'stale'); // waiting caller still gets its value
  assert.equal(await cache.get('k'), 'fresh'); // but nothing was cached
  assert.equal(cache.stats().loads, 2);
});
test('rejection propagates to all waiters and caches nothing', async () => {
  const g = gate();
  let n = 0;
  const cache = createCache(async () => { n++; if (n === 1) { await g.p; throw new Error('down'); } return 'up'; });
  const a = cache.get('k').catch((e) => e.message);
  const b = cache.get('k').catch((e) => e.message);
  g.open();
  assert.deepEqual(await Promise.all([a, b]), ['down', 'down']);
  assert.equal(await cache.get('k'), 'up');
  assert.equal(cache.stats().loads, 2);
});
