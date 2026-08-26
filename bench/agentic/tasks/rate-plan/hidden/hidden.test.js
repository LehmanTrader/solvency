import test from 'node:test';
import assert from 'node:assert/strict';
import { invoice } from '../src/plan.js';

const plan = {
  tiers: [ { upTo: 100, centsPerUnit: 10 }, { upTo: 1000, centsPerUnit: 4 }, { upTo: null, centsPerUnit: 1 } ],
  platformFeeCents: 3000,
  minimumCents: 0,
  credits: [],
};

test('graduated tiers price only their own units', () => {
  const inv = invoice(plan, { units: 1500, daysActive: 30, daysInMonth: 30 });
  assert.deepEqual(inv.lines, [
    { kind: 'tier', upTo: 100, units: 100, cents: 1000 },
    { kind: 'tier', upTo: 1000, units: 900, cents: 3600 },
    { kind: 'tier', upTo: null, units: 500, cents: 500 },
    { kind: 'platform-fee', cents: 3000 },
  ]);
  assert.equal(inv.subtotalCents, 8100);
  assert.equal(inv.totalCents, 8100);
});
test('boundary exactly at a tier edge; empty tiers omitted', () => {
  const inv = invoice(plan, { units: 100, daysActive: 30, daysInMonth: 30 });
  assert.deepEqual(inv.lines[0], { kind: 'tier', upTo: 100, units: 100, cents: 1000 });
  assert.equal(inv.lines.length, 2);
});
test('proration rounds half-up; fractional per-tier cents round too', () => {
  const p = { ...plan, tiers: [{ upTo: null, centsPerUnit: 0.5 }] };
  const inv = invoice(p, { units: 3, daysActive: 1, daysInMonth: 31 });
  // 3 * 0.5 = 1.5 -> 2 ; fee 3000 * 1/31 = 96.77 -> 97
  assert.deepEqual(inv.lines, [
    { kind: 'tier', upTo: null, units: 3, cents: 2 },
    { kind: 'platform-fee', cents: 97 },
  ]);
});
test('minimum true-up then ordered credits with cap and skip', () => {
  const p = { ...plan, minimumCents: 10_000, credits: [ { id: 'c1', cents: 4000 }, { id: 'c2', cents: 9000 }, { id: 'c3', cents: 50 } ] };
  const inv = invoice(p, { units: 10, daysActive: 30, daysInMonth: 30 });
  // usage 100 + fee 3000 = 3100 -> trueup 6900 -> subtotal 10000
  assert.deepEqual(inv.lines[inv.lines.length - 1], { kind: 'minimum-trueup', cents: 6900 });
  assert.equal(inv.subtotalCents, 10_000);
  assert.equal(inv.creditsAppliedCents, 10_000); // c1 4000 + c2 6000(capped); c3 skipped
  assert.equal(inv.totalCents, 0);
});
test('bad tier shapes throw', () => {
  assert.throws(() => invoice({ ...plan, tiers: [{ upTo: 5, centsPerUnit: 1 }, { upTo: 5, centsPerUnit: 1 }, { upTo: null, centsPerUnit: 1 }] }, { units: 1, daysActive: 1, daysInMonth: 30 }), (e) => e.message === 'bad tiers');
  assert.throws(() => invoice({ ...plan, tiers: [{ upTo: null, centsPerUnit: 1 }, { upTo: 10, centsPerUnit: 1 }] }, { units: 1, daysActive: 1, daysInMonth: 30 }), (e) => e.message === 'bad tiers');
});
