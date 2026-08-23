import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { models } from '../scripts/load.ts';
import type { BuildPlanV1 } from '../site/src/lib/build-cost.ts';
import { analyzeBuildSensitivity, breakEvenBuildPlans } from '../site/src/lib/build-sensitivity.ts';

const makePlan = (): BuildPlanV1 => ({
  schemaVersion: 1,
  name: 'Sensitivity plan',
  workload: { buildsPerMonth: 100, volumeBasis: 'attempted_builds' },
  harness: {
    name: 'Any custom harness', version: null, configBasis: 'user_supplied',
    fixedCostPerBuildAttemptUsd: 0, fixedMonthlyCostUsd: 0,
  },
  roles: [{
    roleId: 'orchestrator', kind: 'orchestrator', label: 'Orchestrator', modelId: 'claude-fable-5',
    expectedInvocationsPerBuildAttempt: 1,
    usagePerInvocation: {
      uncachedInputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0,
      outputTokens: 10_000, basis: 'user_supplied',
    },
  }],
  endToEndSuccess: { rate: 0.8, basis: 'user_assumption' },
});

describe('Build Composer sensitivity analysis', () => {
  test('varies role calls one factor at a time without mutating the source plan', () => {
    const plan = makePlan();
    const result = analyzeBuildSensitivity(plan, models, 'role_calls', 0.25, '2026-08-23T00:00:00.000Z');
    assert.equal(result.available, true);
    assert.equal(result.lowFactor, 0.75);
    assert.equal(result.highFactor, 1.25);
    assert.ok(result.low!.buildAttemptCostUsd! < result.base.buildAttemptCostUsd!);
    assert.ok(result.high!.buildAttemptCostUsd! > result.base.buildAttemptCostUsd!);
    assert.equal(plan.roles[0].expectedInvocationsPerBuildAttempt, 1);
  });

  test('varies token usage and current model rates independently', () => {
    const plan = makePlan();
    plan.roles[0].usagePerInvocation.basis = 'measured';
    const tokens = analyzeBuildSensitivity(plan, models, 'tokens_per_call', 0.2);
    const rates = analyzeBuildSensitivity(plan, models, 'model_rates', 0.2);
    assert.ok(tokens.low!.monthlyCostUsd! < tokens.base.monthlyCostUsd!);
    assert.equal(tokens.base.roles[0].usageBasis, 'measured');
    assert.equal(tokens.low!.roles[0].usageBasis, 'user_supplied');
    assert.equal(tokens.high!.roles[0].usageBasis, 'user_supplied');
    assert.ok(rates.high!.monthlyCostUsd! > rates.base.monthlyCostUsd!);
    assert.equal(rates.high!.roles[0].priceBasis, 'user_supplied');
    assert.equal(rates.high!.roles[0].priceSourceUrl, undefined);
    assert.equal(rates.high!.roles[0].priceLastVerified, undefined);
  });

  test('varies only explicit whole-system success and reports the missing state otherwise', () => {
    const plan = makePlan();
    const result = analyzeBuildSensitivity(plan, models, 'system_success', 0.25);
    assert.equal(result.available, true);
    assert.equal(result.base.buildAttemptCostUsd, result.low!.buildAttemptCostUsd);
    assert.ok(result.low!.variableCostPerSuccessfulBuildUsd! > result.base.variableCostPerSuccessfulBuildUsd!);
    assert.ok(result.high!.variableCostPerSuccessfulBuildUsd! < result.base.variableCostPerSuccessfulBuildUsd!);
    delete plan.endToEndSuccess;
    const missing = analyzeBuildSensitivity(plan, models, 'system_success', 0.25);
    assert.equal(missing.available, false);
    assert.equal(missing.low, null);
    assert.match(missing.missingReason!, /success/i);
  });

  test('caps hypothetical success at 100% and rejects invalid ranges and axes', () => {
    const plan = makePlan();
    plan.endToEndSuccess!.rate = 0.9;
    const result = analyzeBuildSensitivity(plan, models, 'system_success', 0.5);
    assert.equal(result.highFactor, 1 / 0.9);
    assert.throws(() => analyzeBuildSensitivity(plan, models, 'role_calls', 1), /less than 100%/);
    assert.throws(() => analyzeBuildSensitivity(plan, models, 'bad' as never, 0.2), /axis/);
  });

  test('reports current-plan errors before a missing success input', () => {
    const plan = makePlan();
    plan.name = '';
    delete plan.endToEndSuccess;
    const result = analyzeBuildSensitivity(plan, models, 'system_success', 0.25);
    assert.equal(result.available, false);
    assert.match(result.missingReason!, /current plan is invalid/i);
  });
});

describe('Build Composer break-even analysis', () => {
  test('solves the common attempted-build volume where monthly totals cross', () => {
    const current = makePlan();
    current.harness.fixedCostPerBuildAttemptUsd = 0.5;
    current.harness.fixedMonthlyCostUsd = 100;
    current.roles[0].usagePerInvocation.uncachedInputTokens = 0;
    current.roles[0].usagePerInvocation.outputTokens = 0;
    const baseline = structuredClone(current);
    baseline.harness.fixedCostPerBuildAttemptUsd = 1;
    baseline.harness.fixedMonthlyCostUsd = 0;
    const result = breakEvenBuildPlans(current, baseline, models);
    assert.equal(result.kind, 'crosses');
    assert.equal(result.attemptedBuildsPerMonth, 200);
    assert.equal(result.lowerBelow, 'baseline');
    assert.equal(result.lowerAbove, 'current');
  });

  test('identifies always-lower and equal cost structures', () => {
    const current = makePlan();
    const baseline = makePlan();
    current.harness.fixedMonthlyCostUsd = 10;
    baseline.harness.fixedMonthlyCostUsd = 20;
    assert.equal(breakEvenBuildPlans(current, baseline, models).kind, 'current_always_lower');
    current.harness.fixedMonthlyCostUsd = 20;
    assert.equal(breakEvenBuildPlans(current, baseline, models).kind, 'equal_all_volumes');
  });

  test('returns unavailable rather than calculating from an invalid plan', () => {
    const current = makePlan();
    current.harness.fixedMonthlyCostUsd = Number.NaN;
    const result = breakEvenBuildPlans(current, makePlan(), models);
    assert.equal(result.kind, 'unavailable');
    assert.match(result.reason!, /valid/);
    assert.equal(result.currentFixedMonthlyUsd, null);
    assert.equal(JSON.stringify(result).includes('null'), true);
  });

  test('preserves a real sub-picodollar slope and finite large-volume crossing', () => {
    const current = makePlan();
    const baseline = makePlan();
    for (const plan of [current, baseline]) {
      plan.roles[0].usagePerInvocation.uncachedInputTokens = 0;
      plan.roles[0].usagePerInvocation.outputTokens = 0;
    }
    current.harness.fixedCostPerBuildAttemptUsd = 5e-13;
    baseline.harness.fixedMonthlyCostUsd = 1_000_000;
    const result = breakEvenBuildPlans(current, baseline, models);
    assert.equal(result.kind, 'crosses');
    assert.equal(result.attemptedBuildsPerMonth, 2e18);
  });
});
