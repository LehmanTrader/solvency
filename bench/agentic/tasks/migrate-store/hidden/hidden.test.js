import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createSessions } from '../src/session.js';
import { cached } from '../src/cache-facade.js';
import { record, entries } from '../src/audit.js';

test('v2 store contract', async () => {
  const s = createStore();
  await s.put('k', 42);
  assert.equal(await s.get('k'), 42);
  await s.put('t', 'x', { ttlMs: 1000 });
  assert.equal(await s.get('t'), 'x');
  assert.equal(await s.del('k'), true);
  assert.equal(await s.del('k'), false);
  await assert.rejects(() => s.get('k'), (e) => e.message === 'not found: k');
});
test('sessions migrate cleanly', async () => {
  const s = createStore();
  const sessions = createSessions(s);
  assert.equal(await sessions.open('1', 'roy'), 'roy');
  assert.equal(await sessions.whoIs('1'), 'roy');
  assert.equal(await sessions.whoIs('nope'), null);
});
test('cache facade produces once', async () => {
  const s = createStore();
  let calls = 0;
  const producer = () => { calls++; return 'val'; };
  assert.equal(await cached(s, 'x', producer), 'val');
  assert.equal(await cached(s, 'x', producer), 'val');
  assert.equal(calls, 1);
});
test('audit log appends and reads', async () => {
  const s = createStore();
  assert.deepEqual(await entries(s), []);
  assert.equal(await record(s, 'a'), 1);
  assert.equal(await record(s, 'b'), 2);
  assert.deepEqual(await entries(s), ['a', 'b']);
});
