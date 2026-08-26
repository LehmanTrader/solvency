import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedger } from '../src/ledger.js';

const rates = { USD: 1_000_000, EUR: 1_083_335, JPY: 6_785 };

test('half-to-even conversion at exact .5 boundaries', () => {
  const l = createLedger({ USD: 1_000_000, HALF: 500_000 });
  assert.equal(l.convert(5, 'HALF'), 2);   // 2.5 -> 2
  assert.equal(l.convert(7, 'HALF'), 4);   // 3.5 -> 4
  assert.equal(l.convert(4, 'HALF'), 2);
  assert.throws(() => l.convert(1, 'GBP'), (e) => e.message === 'unknown currency GBP');
});
test('balanced multi-currency entry posts; balances net by currency', () => {
  const l = createLedger(rates);
  // 10834 base ~= 10000 EUR-minor: 10000*1083335/1e6 = 10833.35 -> 10833
  l.post('e1', [
    { account: 'cash', amountMinor: -10833, currency: 'USD' },
    { account: 'revenue', amountMinor: 10000, currency: 'EUR' },
  ]);
  assert.deepEqual(l.balance('cash'), { USD: -10833 });
  assert.deepEqual(l.balance('revenue'), { EUR: 10000 });
  assert.deepEqual(l.trialBalance(), { cash: -10833, revenue: 10833 });
});
test('unbalanced entry names the gap and posts nothing', () => {
  const l = createLedger(rates);
  assert.throws(() => l.post('bad', [
    { account: 'a', amountMinor: 100, currency: 'USD' },
    { account: 'b', amountMinor: -99, currency: 'USD' },
  ]), (e) => e.message === 'unbalanced entry bad by 1');
  assert.deepEqual(l.balance('a'), {});
  assert.deepEqual(l.trialBalance(), {});
});
test('duplicate ids, zero legs, unknown currency in a leg', () => {
  const l = createLedger(rates);
  l.post('e', [
    { account: 'a', amountMinor: 5, currency: 'USD' },
    { account: 'b', amountMinor: -5, currency: 'USD' },
  ]);
  assert.throws(() => l.post('e', [{ account: 'a', amountMinor: 1, currency: 'USD' }]), (e) => e.message === 'duplicate entry e');
  assert.throws(() => l.post('z', [{ account: 'a', amountMinor: 0, currency: 'USD' }]), (e) => e.message === 'zero leg');
  assert.throws(() => l.post('c', [
    { account: 'a', amountMinor: 5, currency: 'XXX' },
    { account: 'b', amountMinor: -5, currency: 'USD' },
  ]), (e) => e.message === 'unknown currency XXX');
});
test('trial balance sorts accounts and drops zero nets', () => {
  const l = createLedger(rates);
  l.post('e1', [
    { account: 'zulu', amountMinor: 700, currency: 'USD' },
    { account: 'alpha', amountMinor: -700, currency: 'USD' },
  ]);
  l.post('e2', [
    { account: 'zulu', amountMinor: -700, currency: 'USD' },
    { account: 'mike', amountMinor: 700, currency: 'USD' },
  ]);
  assert.deepEqual(Object.keys(l.trialBalance()), ['alpha', 'mike']);
});
