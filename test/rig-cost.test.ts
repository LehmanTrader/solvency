import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  quoteRig,
  localPassRateComparable,
  escalationBlend,
  subscriptionBreakEven,
  RIG_QUOTE_BASIS,
  type RigSpecV1,
  type LocalModelV1,
} from '../site/src/lib/rig-cost.ts';
import { RIG_LIMITS } from '../site/src/lib/rig-limits.ts';

const base = (): RigSpecV1 => ({
  schemaVersion: 1,
  name: 'Mac Studio local rig',
  components: [
    { componentId: 'gpu', label: 'GPU/SoC', condition: 'new', priceUsd: 4700 },
    { componentId: 'ram', label: 'RAM & storage', condition: 'new', priceUsd: 800 },
    { componentId: 'case', label: 'Case & PSU', condition: 'new', priceUsd: 300 },
  ],
  resale: { residualUsd: 1800 },
  horizonMonths: 36,
  power: { systemWatts: 450, method: 'software_reported' },
  electricity: { usdPerKwh: 0.18 },
  throughput: {
    tokensPerSecond: 60, runtime: 'llama.cpp', runtimeVersion: 'b3600',
    contextTokens: 8192, method: 'llama_bench',
  },
  model: {
    modelName: 'Llama-3-8B-Instruct', quantization: 'Q4_K_M',
    passRate: { rate: 0.55, benchmark: 'internal-agent-tasks', basis: 'measured_by_user' },
  },
  workload: { tasksPerMonth: 2000, tokensPerAttempt: 8000, overheadSecondsPerAttempt: 30 },
});

const rig = (patch: Partial<RigSpecV1> = {}): RigSpecV1 => ({ ...base(), ...patch });

describe('RigSpecV1 local-rig quote engine', () => {
  test('happy path: every derived number matches independent arithmetic', () => {
    const quote = quoteRig(rig(), '2026-08-24T00:00:00.000Z');
    assert.equal(quote.valid, true, quote.errors.join('; '));
    assert.equal(quote.basis, 'local_tco_modelled');
    assert.equal(RIG_QUOTE_BASIS, 'local_tco_modelled');

    const buildCostUsd = 4700 + 800 + 300;
    assert.equal(quote.buildCostUsd, buildCostUsd);

    const amortizable = buildCostUsd - 1800;
    const amortizationPerMonthUsd = amortizable / 36;
    assert.ok(Math.abs(quote.amortizationPerMonthUsd! - amortizationPerMonthUsd) < 1e-12);

    const attemptSeconds = 8000 / 60 + 30;
    assert.ok(Math.abs(quote.attemptSeconds! - attemptSeconds) < 1e-12);

    const electricityPerAttemptUsd = (450 * attemptSeconds / 3600 / 1000) * 0.18;
    assert.ok(Math.abs(quote.electricityPerAttemptUsd! - electricityPerAttemptUsd) < 1e-12);

    const amortizationPerAttemptUsd = amortizationPerMonthUsd / 2000;
    assert.ok(Math.abs(quote.amortizationPerAttemptUsd! - amortizationPerAttemptUsd) < 1e-12);

    const costPerAttemptUsd = amortizationPerAttemptUsd + electricityPerAttemptUsd;
    assert.ok(Math.abs(quote.costPerAttemptUsd! - costPerAttemptUsd) < 1e-12);

    const costPerSolvedTaskUsd = costPerAttemptUsd / 0.55;
    assert.ok(Math.abs(quote.costPerSolvedTaskUsd! - costPerSolvedTaskUsd) < 1e-9);

    const monthlyCostUsd = amortizationPerMonthUsd + electricityPerAttemptUsd * 2000;
    assert.ok(Math.abs(quote.monthlyCostUsd! - monthlyCostUsd) < 1e-9);

    assert.deepEqual(quote.missing, []);
    assert.deepEqual(quote.warnings, []);
  });

  test('missing pass rate leaves cost-per-solved null but keeps other derived numbers', () => {
    const p = rig();
    delete p.model.passRate;
    const quote = quoteRig(p);
    assert.equal(quote.valid, true, quote.errors.join('; '));
    assert.equal(quote.costPerSolvedTaskUsd, null);
    assert.ok(quote.missing.includes('model.passRate'));
    assert.notEqual(quote.buildCostUsd, null);
    assert.notEqual(quote.costPerAttemptUsd, null);
    assert.notEqual(quote.monthlyCostUsd, null);
  });

  test('unquantified pass rate never yields a $/solved figure', () => {
    const p = rig();
    p.model.quantization = null;
    const quote = quoteRig(p);
    assert.equal(quote.valid, true, quote.errors.join('; '));
    assert.equal(quote.costPerSolvedTaskUsd, null);
    assert.ok(quote.missing.includes('model.quantization'));
  });

  test('runtime-unversioned throughput never yields a $/solved figure', () => {
    const p = rig();
    p.throughput.runtimeVersion = null;
    const quote = quoteRig(p);
    assert.equal(quote.valid, true, quote.errors.join('; '));
    assert.equal(quote.costPerSolvedTaskUsd, null);
    assert.ok(quote.missing.includes('throughput.runtimeVersion'));
  });

  test('rejects residual value above build cost', () => {
    const p = rig();
    p.resale.residualUsd = p.components.reduce((s, c) => s + c.priceUsd, 0) + 1;
    const quote = quoteRig(p);
    assert.equal(quote.valid, false);
    assert.ok(quote.errors.some((e) => /residual/i.test(e)));
    assert.equal(quote.buildCostUsd, null);
  });

  test('rejects negative residual', () => {
    const p = rig();
    p.resale.residualUsd = -1;
    const quote = quoteRig(p);
    assert.equal(quote.valid, false);
    assert.ok(quote.errors.some((e) => /residual/i.test(e)));
  });

  test('nameplate TDP power draws a warning but stays valid', () => {
    const p = rig();
    p.power.method = 'nameplate_tdp';
    const quote = quoteRig(p);
    assert.equal(quote.valid, true, quote.errors.join('; '));
    assert.ok(quote.warnings.some((w) => /nameplate/i.test(w)));
  });

  test('self-reported throughput draws a warning but stays valid', () => {
    const p = rig();
    p.throughput.method = 'self_reported';
    const quote = quoteRig(p);
    assert.equal(quote.valid, true, quote.errors.join('; '));
    assert.ok(quote.warnings.some((w) => /self.reported/i.test(w)));
  });

  test('a used component without a verification date is flagged as a dated snapshot', () => {
    const withoutDate = rig();
    withoutDate.components[0].condition = 'used';
    const quoteWithout = quoteRig(withoutDate);
    assert.equal(quoteWithout.valid, true, quoteWithout.errors.join('; '));
    assert.ok(quoteWithout.warnings.some((w) => /used|dated|snapshot/i.test(w)));

    const withDate = rig();
    withDate.components[0].condition = 'used';
    withDate.components[0].lastVerified = '2026-08-01';
    const quoteWith = quoteRig(withDate);
    assert.equal(quoteWith.valid, true, quoteWith.errors.join('; '));
    assert.ok(!quoteWith.warnings.some((w) => /used|dated|snapshot/i.test(w)));
  });

  test('a source_verified claim without a source URL and verification date is invalid', () => {
    const p = rig();
    p.power.assertionOrigin = 'source_verified';
    const quote = quoteRig(p);
    assert.equal(quote.valid, false);
    assert.ok(quote.errors.some((e) => /source_verified/.test(e)));

    const q = rig();
    q.power.assertionOrigin = 'source_verified';
    q.power.sourceUrl = 'https://example.com/wattage';
    q.power.lastVerified = '2026-08-01';
    const quoteOk = quoteRig(q);
    assert.equal(quoteOk.valid, true, quoteOk.errors.join('; '));
  });

  test('a derived-dollar ceiling breach invalidates the quote even when every field is within its own cap', () => {
    const p = rig();
    p.throughput.tokensPerSecond = 0.0001;
    p.workload.tokensPerAttempt = RIG_LIMITS.maxTokensPerAttempt;
    p.workload.overheadSecondsPerAttempt = 0;
    p.power.systemWatts = RIG_LIMITS.maxSystemWatts;
    p.electricity.usdPerKwh = RIG_LIMITS.maxUsdPerKwh;
    p.workload.tasksPerMonth = 1;
    const quote = quoteRig(p);
    assert.equal(quote.valid, false);
    assert.ok(quote.errors.some((e) => /numeric range|derived/i.test(e)));
    assert.equal(quote.electricityPerAttemptUsd, null);
  });

  test('pass rate must be greater than zero and no more than one', () => {
    const zero = rig();
    zero.model.passRate!.rate = 0;
    assert.equal(quoteRig(zero).valid, false);

    const over = rig();
    over.model.passRate!.rate = 1.2;
    assert.equal(quoteRig(over).valid, false);

    const boundaryOk = rig();
    boundaryOk.model.passRate!.rate = 1;
    assert.equal(quoteRig(boundaryOk).valid, true);
  });

  test('an invalid quote still populates every RigQuoteV1 key', () => {
    const good = quoteRig(rig());
    const bad = rig();
    bad.resale.residualUsd = -1;
    const badQuote = quoteRig(bad);
    assert.equal(badQuote.valid, false);
    assert.deepEqual(Object.keys(badQuote).sort(), Object.keys(good).sort());
  });
});

describe('localPassRateComparable', () => {
  const m = (patch: Partial<LocalModelV1> = {}): LocalModelV1 => ({
    modelName: 'Llama-3-8B-Instruct',
    quantization: 'Q4_K_M',
    passRate: { rate: 0.55, benchmark: 'internal-agent-tasks', basis: 'measured_by_user' },
    ...patch,
  });

  test('allows two rows only when model and benchmark match and quantization differs', () => {
    const a = m();
    const b = m({ quantization: 'Q8_0', passRate: { rate: 0.62, benchmark: 'internal-agent-tasks', basis: 'measured_by_user' } });
    assert.equal(localPassRateComparable(a, b), true);
  });

  test('refuses the full matrix of unmatched or absent metadata', () => {
    const a = m();
    assert.equal(localPassRateComparable(a, m({ modelName: 'Mixtral-8x7B' })), false, 'different model');
    assert.equal(
      localPassRateComparable(a, m({ quantization: 'Q8_0', passRate: { rate: 0.6, benchmark: 'other-bench', basis: 'measured_by_user' } })),
      false,
      'different benchmark',
    );
    assert.equal(localPassRateComparable(a, m({ quantization: null })), false, 'missing quant on other side');
    assert.equal(localPassRateComparable(m({ quantization: null }), m()), false, 'missing quant on this side');
    assert.equal(localPassRateComparable(a, m()), false, 'equal quantization is not a quant delta');
    assert.equal(localPassRateComparable(a, m({ quantization: 'Q8_0', passRate: undefined })), false, 'missing pass rate');
  });
});

describe('escalationBlend', () => {
  test('hand-computed local-then-cloud-escalation blend', () => {
    const local = { costPerAttemptUsd: 0.06, passRate: 0.55 };
    const cloud = { costPerAttemptUsd: 0.20, passRate: 0.95 };
    const out = escalationBlend(local, cloud)!;
    const costPerTaskUsd = 0.06 + (1 - 0.55) * 0.20;
    const solvedFraction = 0.55 + (1 - 0.55) * 0.95;
    const costPerSolvedTaskUsd = costPerTaskUsd / solvedFraction;
    assert.ok(Math.abs(out.costPerTaskUsd - costPerTaskUsd) < 1e-12);
    assert.ok(Math.abs(out.solvedFraction - solvedFraction) < 1e-12);
    assert.ok(Math.abs(out.costPerSolvedTaskUsd - costPerSolvedTaskUsd) < 1e-12);
  });

  test('returns null on invalid pass rates, negative costs, or non-finite input', () => {
    assert.equal(escalationBlend({ costPerAttemptUsd: 0.1, passRate: 0 }, { costPerAttemptUsd: 0.2, passRate: 0.9 }), null);
    assert.equal(escalationBlend({ costPerAttemptUsd: 0.1, passRate: 1.5 }, { costPerAttemptUsd: 0.2, passRate: 0.9 }), null);
    assert.equal(escalationBlend({ costPerAttemptUsd: -0.1, passRate: 0.5 }, { costPerAttemptUsd: 0.2, passRate: 0.9 }), null);
    assert.equal(escalationBlend({ costPerAttemptUsd: NaN, passRate: 0.5 }, { costPerAttemptUsd: 0.2, passRate: 0.9 }), null);
  });
});

describe('subscriptionBreakEven', () => {
  test('crossover: local is cheaper below the crossover volume, subscription cheaper above it', () => {
    const rigSide = { amortizationPerMonthUsd: 5, electricityPerAttemptUsd: 0.01, passRate: 0.7 };
    const sub = { usdPerMonth: 200, passRate: 0.9 };
    const out = subscriptionBreakEven(rigSide, sub);
    assert.equal(out.kind, 'crossover');
    const threshold = (sub.usdPerMonth * rigSide.passRate) / sub.passRate;
    const expectedV = (threshold - rigSide.amortizationPerMonthUsd) / rigSide.electricityPerAttemptUsd;
    if (out.kind !== 'crossover') throw new Error('unreachable');
    assert.ok(Math.abs(out.tasksPerMonth - expectedV) < 1e-6);

    // Prove the direction by evaluating both cost-per-solved formulas directly at V*0.9 and V*1.1.
    const localCostPerSolved = (V: number) => (rigSide.amortizationPerMonthUsd / V + rigSide.electricityPerAttemptUsd) / rigSide.passRate;
    const subCostPerSolved = (V: number) => sub.usdPerMonth / (V * sub.passRate);
    const below = out.tasksPerMonth * 0.9;
    const above = out.tasksPerMonth * 1.1;
    assert.ok(localCostPerSolved(below) < subCostPerSolved(below), 'local should be cheaper below the crossover');
    assert.ok(localCostPerSolved(above) > subCostPerSolved(above), 'subscription should be cheaper above the crossover');
  });

  test('zero-electricity rig: whichever side has the lower constant coefficient wins at every volume', () => {
    const cheaperLocal = subscriptionBreakEven(
      { amortizationPerMonthUsd: 5, electricityPerAttemptUsd: 0, passRate: 0.7 },
      { usdPerMonth: 200, passRate: 0.9 },
    );
    assert.equal(cheaperLocal.kind, 'local_always_cheaper');

    const cheaperSub = subscriptionBreakEven(
      { amortizationPerMonthUsd: 200, electricityPerAttemptUsd: 0, passRate: 0.7 },
      { usdPerMonth: 5, passRate: 0.9 },
    );
    assert.equal(cheaperSub.kind, 'subscription_always_cheaper');

    const tied = subscriptionBreakEven(
      { amortizationPerMonthUsd: 90, electricityPerAttemptUsd: 0, passRate: 0.9 },
      { usdPerMonth: 90, passRate: 0.9 },
    );
    assert.equal(tied.kind, 'equal');
  });

  test('a nonzero electricity floor means subscription always wins once amortization is not cheap enough', () => {
    const out = subscriptionBreakEven(
      { amortizationPerMonthUsd: 100, electricityPerAttemptUsd: 0.01, passRate: 0.8 },
      { usdPerMonth: 50, passRate: 0.9 },
    );
    assert.equal(out.kind, 'subscription_always_cheaper');
  });

  test('returns undefined on invalid inputs', () => {
    assert.equal(subscriptionBreakEven(
      { amortizationPerMonthUsd: 5, electricityPerAttemptUsd: 0.01, passRate: 0 },
      { usdPerMonth: 200, passRate: 0.9 },
    ).kind, 'undefined');
    assert.equal(subscriptionBreakEven(
      { amortizationPerMonthUsd: -5, electricityPerAttemptUsd: 0.01, passRate: 0.7 },
      { usdPerMonth: 200, passRate: 0.9 },
    ).kind, 'undefined');
    assert.equal(subscriptionBreakEven(
      { amortizationPerMonthUsd: 5, electricityPerAttemptUsd: NaN, passRate: 0.7 },
      { usdPerMonth: 200, passRate: 0.9 },
    ).kind, 'undefined');
  });
});
