import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, balanceOf } from '../src/index.js';
import { project } from '../src/projector.js';
test('balances derive from the log', () => {
  const s = createStore();
  s.append({ type: 'deposit', account: 'a', amount: 100 });
  s.append({ type: 'withdraw', account: 'a', amount: 30 });
  s.append({ type: 'deposit', account: 'b', amount: 5 });
  assert.equal(balanceOf(s, 'a'), 70);
  assert.equal(balanceOf(s, 'b'), 5);
  assert.equal(balanceOf(s, 'ghost'), 0);
});
test('overdraw is ignored, later events still apply', () => {
  const m = project([
    { type: 'deposit', account: 'a', amount: 10 },
    { type: 'withdraw', account: 'a', amount: 50 },
    { type: 'deposit', account: 'a', amount: 1 },
  ]);
  assert.equal(m.get('a'), 11);
});
