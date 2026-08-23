import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { models } from '../scripts/load.ts';
import { quoteBuildPlan, type BuildPlanV1 } from '../site/src/lib/build-cost.ts';
import { compareBuildQuotes, createBuildSnapshot, duplicateBuildSnapshot } from '../site/src/lib/build-workspace.ts';

const makePlan = (name = 'Custom agent stack'): BuildPlanV1 => ({
  schemaVersion: 1,
  name,
  workload: { buildsPerMonth: 100, volumeBasis: 'attempted_builds' },
  harness: {
    name: 'My private harness', version: 'v1', configBasis: 'user_supplied',
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
});

describe('Build Composer version workspace', () => {
  test('increments versions within one plan and deep-clones immutable snapshots', () => {
    const plan = makePlan();
    const first = createBuildSnapshot([], 'plan-a', 'snap-a1', plan, models, '2026-08-23T10:01:00.000Z');
    plan.name = 'Mutated after save';
    assert.equal(first.version, 1);
    assert.equal(first.plan.name, 'Custom agent stack');
    const second = createBuildSnapshot([first], 'plan-a', 'snap-a2', makePlan(), models);
    assert.equal(second.version, 2);
  });

  test('duplicates into an independent named plan starting at version one', () => {
    const plan = makePlan();
    const source = createBuildSnapshot([], 'plan-a', 'snap-a1', plan, models);
    const copy = duplicateBuildSnapshot(source, 'plan-b', 'snap-b1', 'Cheaper worker mix', models);
    assert.equal(copy.version, 1);
    assert.equal(copy.planId, 'plan-b');
    assert.equal(copy.plan.name, 'Cheaper worker mix');
    copy.plan.harness.name = 'Changed copy';
    assert.equal(source.plan.harness.name, 'My private harness');
  });

  test('computes signed attempt, solved and monthly deltas', () => {
    const baselinePlan = makePlan();
    baselinePlan.endToEndSuccess = { rate: 0.8, basis: 'user_assumption' };
    const currentPlan = makePlan();
    currentPlan.roles[0].usagePerInvocation.uncachedInputTokens = 50_000;
    currentPlan.endToEndSuccess = { rate: 0.8, basis: 'user_assumption' };
    const baseline = quoteBuildPlan(baselinePlan, models);
    const current = quoteBuildPlan(currentPlan, models);
    const delta = compareBuildQuotes(current, baseline);
    assert.ok(delta.buildAttemptCostUsd.absolute! < 0);
    assert.ok(delta.buildAttemptCostUsd.percent! < 0);
    assert.equal(delta.monthlyCostUsd.absolute, delta.buildAttemptCostUsd.absolute! * 100);
    assert.ok(delta.variableCostPerSuccessfulBuildUsd.absolute! < 0);
  });

  test('keeps dependent deltas missing when either quote lacks the metric', () => {
    const missing = quoteBuildPlan(makePlan(), models);
    const withSuccessPlan = makePlan();
    withSuccessPlan.endToEndSuccess = { rate: 0.8, basis: 'user_assumption' };
    const withSuccess = quoteBuildPlan(withSuccessPlan, models);
    const delta = compareBuildQuotes(withSuccess, missing);
    assert.equal(delta.variableCostPerSuccessfulBuildUsd.absolute, null);
    assert.equal(delta.variableCostPerSuccessfulBuildUsd.percent, null);
  });

  test('refuses invalid quotes and duplicate snapshot IDs', () => {
    const invalidPlan = makePlan('');
    assert.throws(() => createBuildSnapshot([], 'plan-a', 'snap-a1', invalidPlan, models), /valid build quote/);
    const plan = makePlan();
    const first = createBuildSnapshot([], 'plan-a', 'snap-a1', plan, models);
    assert.throws(() => createBuildSnapshot([first], 'plan-a', 'snap-a1', plan, models), /unique/);
    assert.throws(() => duplicateBuildSnapshot(first, '', 'snap-b1', 'Copy', models), /Plan ID/);
  });
});
