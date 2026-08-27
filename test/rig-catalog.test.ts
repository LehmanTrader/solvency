import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RIG_CATALOG,
  ELECTRICITY_DEFAULT,
  DEFAULT_WORKLOAD,
  referenceRigById,
  catalogEntryToRigSpec,
} from '../site/src/lib/rig-catalog.ts';
import { quoteRig, subscriptionBreakEven, breakEvenScan, cappedSubscriptionCostPerSolved } from '../site/src/lib/rig-cost.ts';

/** Every `source_verified` numeric default in the catalog must carry a live citation and a
 * verification date — the honesty rule from docs/local-hardware-tier-plan.md and the
 * 2026-08-26 local-hardware build brief. This walks every sourceable field on every entry. */
function sourceVerifiedAssertions(entry: (typeof RIG_CATALOG)[number]) {
  const out: { label: string; assertionOrigin?: string; sourceUrl?: string; lastVerified?: string }[] = [];
  for (const component of entry.components) {
    out.push({ label: `${entry.id}: component ${component.componentId}`, assertionOrigin: component.assertionOrigin, sourceUrl: component.sourceUrl, lastVerified: component.lastVerified });
  }
  out.push({ label: `${entry.id}: resale`, assertionOrigin: entry.resale.assertionOrigin, sourceUrl: entry.resale.sourceUrl, lastVerified: entry.resale.lastVerified });
  out.push({ label: `${entry.id}: power`, assertionOrigin: entry.power.assertionOrigin, sourceUrl: entry.power.sourceUrl, lastVerified: entry.power.lastVerified });
  out.push({ label: `${entry.id}: throughput`, assertionOrigin: entry.throughput.assertionOrigin, sourceUrl: entry.throughput.sourceUrl, lastVerified: entry.throughput.lastVerified });
  return out;
}

describe('reference rig catalog: sourcing honesty', () => {
  test('every field claiming assertionOrigin "source_verified" carries a non-empty sourceUrl and lastVerified', () => {
    for (const entry of RIG_CATALOG) {
      for (const field of sourceVerifiedAssertions(entry)) {
        if (field.assertionOrigin !== 'source_verified') continue;
        assert.ok(field.sourceUrl && field.sourceUrl.trim(), `${field.label}: source_verified but missing sourceUrl`);
        assert.ok(field.lastVerified && field.lastVerified.trim(), `${field.label}: source_verified but missing lastVerified`);
        assert.match(field.sourceUrl!, /^https:\/\//, `${field.label}: sourceUrl should be a live https link`);
      }
    }
  });

  test('the electricity default is source-verified with a live sourceUrl and lastVerified', () => {
    assert.equal(ELECTRICITY_DEFAULT.assertionOrigin, 'source_verified');
    assert.ok(ELECTRICITY_DEFAULT.sourceUrl && ELECTRICITY_DEFAULT.sourceUrl.startsWith('https://'));
    assert.ok(ELECTRICITY_DEFAULT.lastVerified);
  });

  test('every catalog entry\'s primary hardware component price is independently sourced (not fabricated)', () => {
    for (const entry of RIG_CATALOG) {
      const primary = entry.components[0];
      assert.equal(primary.assertionOrigin, 'source_verified', `${entry.id}: primary hardware price should be sourced, not a bare template guess`);
      assert.ok(primary.sourceUrl, `${entry.id}: primary hardware price is missing a sourceUrl`);
      assert.ok(primary.lastVerified, `${entry.id}: primary hardware price is missing a lastVerified date`);
    }
  });

  test('fields this research pass could not independently verify (resale, most throughput) are honestly labeled modeled, not falsely "source_verified"', () => {
    for (const entry of RIG_CATALOG) {
      assert.notEqual(entry.resale.assertionOrigin, 'source_verified', `${entry.id}: resale residual is a forecast, not a cited fact`);
    }
    // The two used-GPU throughput defaults have no independently disclosed llama-bench figure for
    // this exact model+quant as of 2026-08-26 (see module doc comment) and must stay modeled.
    for (const id of ['used-rtx-4090', 'used-rtx-3090']) {
      const entry = referenceRigById(id)!;
      assert.notEqual(entry.throughput.assertionOrigin, 'source_verified');
      assert.equal(entry.throughput.sourceUrl, undefined, `${id}: no invented citation for an unsourced throughput estimate`);
    }
  });

  test('every catalog entry ships without a pass rate: an unquantified local pass rate is a structural data gap, never invented', () => {
    for (const entry of RIG_CATALOG) {
      assert.equal(entry.model.passRate, undefined, `${entry.id}: catalog must not assert a pass rate Solvency did not measure`);
    }
  });

  test('every catalog entry assembles into a valid RigSpecV1 quote once a pass rate is supplied', () => {
    for (const entry of RIG_CATALOG) {
      const spec = catalogEntryToRigSpec(entry, {
        passRate: { rate: 0.5, benchmark: 'internal-agent-tasks', basis: 'user_assumption' },
      });
      const quote = quoteRig(spec, '2026-08-26T00:00:00.000Z');
      assert.equal(quote.valid, true, `${entry.id}: ${quote.errors.join('; ')}`);
      // Core dollar figures resolve even from the untouched catalog defaults...
      assert.notEqual(quote.buildCostUsd, null);
      assert.notEqual(quote.costPerAttemptUsd, null);
      assert.notEqual(quote.monthlyCostUsd, null);
      // ...but cost-per-solved-task honestly stays Missing: no catalog entry claims a llama.cpp
      // runtime version, because no independently disclosed benchmark run pins one for this
      // model+quant on this hardware. quoteRig refuses to synthesize a $/solved figure from an
      // unpinned runtime, and the catalog must not paper over that by inventing a version string.
      assert.equal(quote.costPerSolvedTaskUsd, null);
      assert.ok(quote.missing.includes('throughput.runtimeVersion'));
    }
  });
});

describe('reference rig catalog: break-even integration against a known cloud fixture', () => {
  test('a known rig fixture + a known uncapped subscription fixture surfaces the correct crossover kind and volume', () => {
    const entry = referenceRigById('used-rtx-4090')!;
    const spec = catalogEntryToRigSpec(entry, {
      workload: { tasksPerMonth: 300, tokensPerAttempt: 8000, overheadSecondsPerAttempt: 30 },
      passRate: { rate: 0.6, benchmark: 'internal-agent-tasks', basis: 'user_assumption' },
    });
    const quote = quoteRig(spec, '2026-08-26T00:00:00.000Z');
    assert.equal(quote.valid, true, quote.errors.join('; '));

    const subscription = { usdPerMonth: 200, passRate: 0.9 };
    const out = subscriptionBreakEven(
      { amortizationPerMonthUsd: quote.amortizationPerMonthUsd!, electricityPerAttemptUsd: quote.electricityPerAttemptUsd!, passRate: quote.passRate!.rate },
      subscription,
    );
    assert.equal(out.kind, 'crossover');
    const threshold = (subscription.usdPerMonth * quote.passRate!.rate) / subscription.passRate;
    const expectedV = (threshold - quote.amortizationPerMonthUsd!) / quote.electricityPerAttemptUsd!;
    if (out.kind !== 'crossover') throw new Error('unreachable');
    assert.ok(Math.abs(out.tasksPerMonth - expectedV) < 1e-6);
    assert.ok(out.tasksPerMonth > 0);
  });

  test('a capped subscription fixture surfaces via breakEvenScan, matching the engine\'s own sawtooth semantics', () => {
    const entry = referenceRigById('mac-studio-m5-max')!;
    const spec = catalogEntryToRigSpec(entry, {
      workload: { tasksPerMonth: 400, tokensPerAttempt: 8000, overheadSecondsPerAttempt: 30 },
      passRate: { rate: 0.55, benchmark: 'internal-agent-tasks', basis: 'user_assumption' },
    });
    const quote = quoteRig(spec, '2026-08-26T00:00:00.000Z');
    assert.equal(quote.valid, true, quote.errors.join('; '));

    const cappedSubscription = { usdPerMonth: 20, passRate: 0.9, tasksPerMonthCap: 50, scaling: 'multi_seat' as const };
    const rigSide = { amortizationPerMonthUsd: quote.amortizationPerMonthUsd!, electricityPerAttemptUsd: quote.electricityPerAttemptUsd!, passRate: quote.passRate!.rate };
    const out = breakEvenScan(rigSide, cappedSubscription);
    assert.ok(out.kind === 'crossover' || out.kind === 'mixed', `expected crossover or mixed, got ${out.kind}`);
    const firstWin = out.kind === 'crossover' ? out.tasksPerMonth : out.kind === 'mixed' ? out.firstLocalWin : NaN;
    assert.ok(Number.isFinite(firstWin) && firstWin > 0);

    const localCostPerSolved = (V: number) => (rigSide.amortizationPerMonthUsd / V + rigSide.electricityPerAttemptUsd) / rigSide.passRate;
    const subCostPerSolved = (V: number) => cappedSubscriptionCostPerSolved(cappedSubscription, V)!;
    assert.ok(localCostPerSolved(firstWin) < subCostPerSolved(firstWin), 'local should be cheaper at the reported first-win volume');
  });

  test('a subscription cheap enough at every volume reports subscription_always_cheaper, never a fabricated crossover', () => {
    const entry = referenceRigById('mac-mini-m5-pro')!;
    const spec = catalogEntryToRigSpec(entry, {
      workload: DEFAULT_WORKLOAD,
      passRate: { rate: 0.4, benchmark: 'internal-agent-tasks', basis: 'user_assumption' },
    });
    const quote = quoteRig(spec, '2026-08-26T00:00:00.000Z');
    assert.equal(quote.valid, true, quote.errors.join('; '));

    // A near-zero subscription price makes the flat fee dilute to nothing long before the rig's
    // electricity floor could ever win: this must resolve to subscription_always_cheaper.
    const out = subscriptionBreakEven(
      { amortizationPerMonthUsd: quote.amortizationPerMonthUsd!, electricityPerAttemptUsd: quote.electricityPerAttemptUsd!, passRate: quote.passRate!.rate },
      { usdPerMonth: 0.01, passRate: 0.95 },
    );
    assert.equal(out.kind, 'subscription_always_cheaper');
  });
});
