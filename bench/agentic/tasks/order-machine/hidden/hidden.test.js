import test from 'node:test';
import assert from 'node:assert/strict';
import { createOrder } from '../src/machine.js';
test('full happy lifecycle with history', () => {
  const o = createOrder(() => 0);
  o.send('submit', 10); o.send('pay', 20); o.send('ship', 30); o.send('deliver', 40);
  assert.equal(o.state(), 'delivered');
  assert.deepEqual(o.history(), [
    { from: 'draft', to: 'placed', event: 'submit', atMs: 10 },
    { from: 'placed', to: 'paid', event: 'pay', atMs: 20 },
    { from: 'paid', to: 'shipped', event: 'ship', atMs: 30 },
    { from: 'shipped', to: 'delivered', event: 'deliver', atMs: 40 },
  ]);
});
test('refund inside the window', () => {
  const o = createOrder(() => 0);
  o.send('submit', 0); o.send('pay', 1000); o.send('refund', 3_600_999);
  assert.equal(o.state(), 'refunded');
});
test('refund outside the window throws and preserves state/history', () => {
  const o = createOrder(() => 0);
  o.send('submit', 0); o.send('pay', 1000);
  assert.throws(() => o.send('refund', 3_602_000), (e) => e.message === 'refund window closed');
  assert.equal(o.state(), 'paid');
  assert.equal(o.history().length, 2);
});
test('illegal transitions name event and state', () => {
  const o = createOrder(() => 0);
  assert.throws(() => o.send('pay', 5), (e) => e.message === 'cannot pay from draft');
  o.send('submit', 5); o.send('cancel', 6);
  assert.equal(o.state(), 'cancelled');
  assert.throws(() => o.send('pay', 7), (e) => e.message === 'cannot pay from cancelled');
});
