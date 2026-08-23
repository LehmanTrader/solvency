import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { models } from '../scripts/load.ts';
import { quoteBuildPlan, type BuildPlanV1 } from '../site/src/lib/build-cost.ts';

const plan = (harnessName = 'My completely custom harness'): BuildPlanV1 => ({
  schemaVersion: 1,
  name: 'Fable orchestrator with Luna workers',
  workload: { buildsPerMonth: 100, volumeBasis: 'attempted_builds' },
  harness: {
    name: harnessName, version: 'internal-2026.08', configBasis: 'user_supplied',
    fixedCostPerBuildAttemptUsd: 0.1, fixedMonthlyCostUsd: 19,
  },
  roles: [
    {
      roleId: 'orchestrator', kind: 'orchestrator', label: 'Orchestrator', modelId: 'claude-fable-5',
      expectedInvocationsPerBuildAttempt: 1,
      usagePerInvocation: {
        uncachedInputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0,
        outputTokens: 10_000, basis: 'template_assumption',
      },
    },
    {
      roleId: 'workers', kind: 'worker', label: 'Worker pool', modelId: 'gpt-5.6-luna',
      expectedInvocationsPerBuildAttempt: 6,
      usagePerInvocation: {
        uncachedInputTokens: 20_000, cacheReadTokens: 30_000, cacheWriteTokens: 0,
        outputTokens: 2_000, basis: 'template_assumption',
      },
    },
  ],
});

describe('BuildPlanV1 multi-model quote engine', () => {
  test('prices orchestrator and worker roles independently, then sums the build graph', () => {
    const quote = quoteBuildPlan(plan(), models, '2026-08-23T00:00:00.000Z');
    assert.equal(quote.valid, true);
    assert.equal(quote.roles.length, 2);
    assert.equal(quote.roles[0].costPerBuildAttemptUsd, 1.5);
    assert.ok(Math.abs(quote.roles[1].costPerBuildAttemptUsd - 0.042) < 1e-12);
    assert.ok(Math.abs(quote.buildAttemptCostUsd! - 1.642) < 1e-12);
    assert.ok(Math.abs(quote.monthlyCostUsd! - 183.2) < 1e-12);
  });

  test('accepts any free-form harness name without an allowlist or special case', () => {
    for (const name of ['Hermes Agent', 'Codex', 'Acme Swarm v9', 'My shell script', '自定义 harness']) {
      const quote = quoteBuildPlan(plan(name), models);
      assert.equal(quote.valid, true, name);
      assert.equal(quote.harness.name, name);
      assert.equal(quote.buildAttemptCostUsd?.toFixed(3), '1.642');
    }
  });

  test('never fabricates system success from role or model benchmark scores', () => {
    const quote = quoteBuildPlan(plan(), models);
    assert.equal(quote.variableCostPerSuccessfulBuildUsd, null);
    assert.deepEqual(quote.missing, ['endToEndSuccess.rate']);
    assert.equal(quote.successfulBuildsPerMonth, null);
  });

  test('uses only an explicit end-to-end success rate for solved-build cost', () => {
    const p = plan();
    p.endToEndSuccess = { rate: 0.8, basis: 'user_assumption' };
    const quote = quoteBuildPlan(p, models);
    assert.ok(Math.abs(quote.variableCostPerSuccessfulBuildUsd! - 2.0525) < 1e-12);
    assert.equal(quote.successfulBuildsPerMonth, 80);
  });

  test('successful-build volume requires the end-to-end rate before monthly spend can be derived', () => {
    const p = plan();
    p.workload = { buildsPerMonth: 80, volumeBasis: 'successful_builds' };
    const quote = quoteBuildPlan(p, models);
    assert.equal(quote.valid, true);
    assert.equal(quote.monthlyCostUsd, null);
    assert.ok(quote.missing.includes('attemptedBuildsPerMonth'));
  });

  test('custom or contracted prices override the catalog for that role only', () => {
    const p = plan();
    p.roles[0].priceOverride = {
      inputPerMtok: 1, cacheReadPerMtok: 0.1, outputPerMtok: 2, basis: 'contract',
    };
    const quote = quoteBuildPlan(p, models);
    assert.equal(quote.roles[0].priceBasis, 'contract');
    assert.equal(quote.roles[0].costPerBuildAttemptUsd, 0.12);
    assert.ok(Math.abs(quote.buildAttemptCostUsd! - 0.262) < 1e-12);
  });

  test('rejects negative inputs, duplicate roles and unpriced cache writes', () => {
    const p = plan();
    p.roles[0].expectedInvocationsPerBuildAttempt = -1;
    p.roles[1].roleId = p.roles[0].roleId;
    p.roles[1].usagePerInvocation.cacheWriteTokens = 10;
    const quote = quoteBuildPlan(p, models);
    assert.equal(quote.valid, false);
    assert.equal(quote.buildAttemptCostUsd, null);
    assert.ok(quote.errors.some((e) => /greater than zero/.test(e)));
    assert.ok(quote.errors.some((e) => /unique/.test(e)));
    assert.ok(quote.errors.some((e) => /cache-write price/.test(e)));
  });

  test('does not attach catalog provenance to user-supplied prices', () => {
    const p = plan();
    p.roles[0].priceOverride = {
      inputPerMtok: 1, cacheReadPerMtok: 0.1, outputPerMtok: 2, basis: 'user_supplied',
    };
    const quote = quoteBuildPlan(p, models);
    assert.equal(quote.valid, true);
    assert.equal(quote.roles[0].priceSourceUrl, undefined);
    assert.equal(quote.roles[0].priceLastVerified, undefined);
  });

  test('rejects numeric overflow instead of exporting null-like costs', () => {
    const p = plan();
    p.roles[0].usagePerInvocation.uncachedInputTokens = Number.MAX_VALUE;
    const quote = quoteBuildPlan(p, models);
    assert.equal(quote.valid, false);
    assert.equal(quote.buildAttemptCostUsd, null);
    assert.ok(quote.errors.some((e) => /numeric range/.test(e)));
  });

  test('rejects unknown discriminants rather than silently choosing a calculation branch', () => {
    const p = plan();
    p.workload.volumeBasis = 'tampered' as BuildPlanV1['workload']['volumeBasis'];
    p.harness.configBasis = 'tampered' as BuildPlanV1['harness']['configBasis'];
    p.roles[0].kind = 'tampered' as BuildPlanV1['roles'][number]['kind'];
    p.roles[0].usagePerInvocation.basis = 'tampered' as BuildPlanV1['roles'][number]['usagePerInvocation']['basis'];
    const quote = quoteBuildPlan(p, models);
    assert.equal(quote.valid, false);
    assert.ok(quote.errors.some((e) => /volume basis/.test(e)));
    assert.ok(quote.errors.some((e) => /configuration basis/.test(e)));
    assert.ok(quote.errors.some((e) => /role kind/.test(e)));
    assert.ok(quote.errors.some((e) => /usage basis/.test(e)));
  });

  test('requires complete custom rates for every token class used by a role', () => {
    const p = plan();
    p.roles[1].priceOverride = { inputPerMtok: 0, outputPerMtok: 0, basis: 'contract' };
    const quote = quoteBuildPlan(p, models);
    assert.equal(quote.valid, false);
    assert.ok(quote.errors.some((e) => /explicit custom cache-read price/.test(e)));
  });
});
