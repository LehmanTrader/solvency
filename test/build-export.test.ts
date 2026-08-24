import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { models } from '../scripts/load.ts';
import { quoteBuildPlan, type BuildPlanV1 } from '../site/src/lib/build-cost.ts';
import {
  BUILD_EXPORT_NOTICES, MAX_BUILD_EXPORT_ROLES,
  buildExportCsv, buildExportFilename, buildExportJson, buildExportSummary, spreadsheetSafeText,
} from '../site/src/lib/build-export.ts';

const makePlan = (): BuildPlanV1 => ({
  schemaVersion: 1,
  name: 'Private, “budget” plan',
  workload: { buildsPerMonth: 80, volumeBasis: 'successful_builds' },
  harness: {
    name: '=Internal harness', version: 'v2', configBasis: 'published',
    assertionOrigin: 'source_verified',
    sourceUrl: 'https://example.com/harness', lastVerified: '2026-08-23',
    fixedCostPerBuildAttemptUsd: 0.25, fixedMonthlyCostUsd: 19,
  },
  roles: [{
    roleId: 'orchestrator', kind: 'orchestrator', label: 'Lead, "review"\nagent', modelId: 'claude-fable-5',
    expectedInvocationsPerBuildAttempt: 1,
    usagePerInvocation: {
      uncachedInputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 10_000,
      basis: 'measured', sourceUrl: 'https://example.com/usage', lastVerified: '2026-08-22',
      assertionOrigin: 'source_verified',
    },
    priceOverride: {
      inputPerMtok: 1, cacheReadPerMtok: 0.1, outputPerMtok: 2, basis: 'contract',
      assertionOrigin: 'source_verified',
      sourceUrl: 'https://example.com/contract', lastVerified: '2026-08-21',
    },
  }],
  endToEndSuccess: {
    rate: 0.8, basis: 'measured_by_user',
    assertionOrigin: 'source_verified',
    sourceUrl: 'https://example.com/system-run', lastVerified: '2026-08-20',
  },
});

describe('Build Composer exports', () => {
  test('emits deterministic canonical JSON with the complete assumption and provenance ledgers', () => {
    const plan = makePlan();
    const quote = quoteBuildPlan(plan, models, '2026-08-23T12:00:00.000Z');
    const first = buildExportJson(plan, quote);
    const second = buildExportJson(structuredClone(plan), structuredClone(quote));
    assert.equal(first, second);
    assert.equal(first.endsWith('\n'), true);

    const exported = JSON.parse(first);
    assert.equal(exported.exportSchemaVersion, 1);
    assert.deepEqual(exported.notices, BUILD_EXPORT_NOTICES);
    assert.equal(exported.plan.harness.configBasis, 'published');
    assert.equal(exported.plan.harness.sourceUrl, 'https://example.com/harness');
    assert.equal(exported.plan.roles[0].usagePerInvocation.basis, 'measured');
    assert.equal(exported.plan.roles[0].priceOverride.basis, 'contract');
    assert.equal(exported.plan.endToEndSuccess.basis, 'measured_by_user');
    assert.equal(exported.quote.roles[0].priceSourceUrl, 'https://example.com/contract');
    assert.equal(exported.quote.roles[0].usageAssertionOrigin, 'source_verified');
    assert.equal(exported.quote.roles[0].priceAssertionOrigin, 'source_verified');
    assert.deepEqual([
      exported.quote.roles[0].appliedInputPerMtok,
      exported.quote.roles[0].appliedCacheReadPerMtok,
      exported.quote.roles[0].appliedCacheWritePerMtok,
      exported.quote.roles[0].appliedOutputPerMtok,
    ], [1, 0.1, 0, 2]);
    const usage = exported.plan.roles[0].usagePerInvocation;
    const derived = (
      usage.uncachedInputTokens * exported.quote.roles[0].appliedInputPerMtok
      + usage.cacheReadTokens * exported.quote.roles[0].appliedCacheReadPerMtok
      + usage.cacheWriteTokens * exported.quote.roles[0].appliedCacheWritePerMtok
      + usage.outputTokens * exported.quote.roles[0].appliedOutputPerMtok
    ) / 1_000_000;
    assert.equal(derived, exported.quote.roles[0].costPerInvocationUsd);
    assert.deepEqual(Object.keys(exported.plan), [...Object.keys(exported.plan)].sort());
  });

  test('emits stable role CSV with correct escaping, formula neutralization and provenance', () => {
    const plan = makePlan();
    const quote = quoteBuildPlan(plan, models, '2026-08-23T12:00:00.000Z');
    const csv = buildExportCsv(plan, quote);
    assert.equal(csv, buildExportCsv(structuredClone(plan), structuredClone(quote)));
    assert.equal(csv.endsWith('\r\n'), true);
    assert.match(csv, /harness_config_basis/);
    assert.match(csv, /usage_source_url/);
    assert.match(csv, /price_last_verified/);
    assert.match(csv, /harness_assertion_origin/);
    assert.match(csv, /usage_assertion_origin/);
    assert.match(csv, /price_assertion_origin/);
    assert.match(csv, /applied_cache_write_per_mtok/);
    assert.match(csv, /'\=Internal harness/);
    assert.match(csv, /"Lead, ""review""\nagent"/);
    assert.match(csv, /https:\/\/example\.com\/usage/);
    assert.match(csv, /https:\/\/example\.com\/contract/);
    assert.match(csv, /measured_by_user/);
    assert.match(csv, /contract/);
    assert.match(csv, /carry machine-readable assertion origins/);
  });

  test('freezes catalog rates in the export so costs rederive without the live catalog', () => {
    const plan = makePlan();
    delete plan.roles[0].priceOverride;
    const quote = quoteBuildPlan(plan, models, '2026-08-23T12:00:00.000Z');
    const exported = JSON.parse(buildExportJson(plan, quote));
    const role = exported.quote.roles[0];
    const usage = exported.plan.roles[0].usagePerInvocation;
    const catalogModel = models.find((model) => model.model_id === exported.plan.roles[0].modelId)!;
    assert.equal(role.priceBasis, 'catalog_list');
    assert.equal(role.priceAssertionOrigin, 'source_verified');
    assert.deepEqual([
      role.appliedInputPerMtok,
      role.appliedCacheReadPerMtok,
      role.appliedCacheWritePerMtok,
      role.appliedOutputPerMtok,
    ], [
      catalogModel.input_per_mtok,
      catalogModel.cached_input_per_mtok ?? catalogModel.input_per_mtok,
      0,
      catalogModel.output_per_mtok,
    ]);
    assert.equal((
      usage.uncachedInputTokens * role.appliedInputPerMtok
      + usage.cacheReadTokens * role.appliedCacheReadPerMtok
      + usage.cacheWriteTokens * role.appliedCacheWritePerMtok
      + usage.outputTokens * role.appliedOutputPerMtok
    ) / 1_000_000, role.costPerInvocationUsd);
    assert.match(buildExportCsv(plan, quote), /applied_input_per_mtok/);
  });

  test('neutralizes hostile spreadsheet prefixes and preserves explicit missing states', () => {
    const hostile = ['=HYPERLINK("https://evil.invalid")', ' +CMD', '\t@SUM(A1:A2)', '-1+1', '+2', '@name'];
    for (const value of hostile) {
      assert.equal(spreadsheetSafeText(value), `'${value}`);
      const plan = makePlan();
      plan.name = value;
      delete plan.endToEndSuccess;
      plan.workload.volumeBasis = 'successful_builds';
      const csv = buildExportCsv(plan, quoteBuildPlan(plan, models));
      assert.match(csv, /Missing — success rate not supplied/);
      assert.match(csv, /Missing — success rate required for successful-build volume/);
    }

    const plan = makePlan();
    plan.name = 'NUL\0name';
    assert.equal(spreadsheetSafeText(plan.name), 'NUL�name');
    assert.doesNotMatch(buildExportCsv(plan, quoteBuildPlan(plan, models)), /\0/);
  });

  test('builds a bounded canvas-safe PNG summary without markup or inferred success', () => {
    const plan = makePlan();
    plan.name = '</text><script>alert(1)</script>';
    plan.roles[0].label = '<svg onload=alert(1)>';
    delete plan.endToEndSuccess;
    const summary = buildExportSummary(plan, quoteBuildPlan(plan, models, '2026-08-23T12:00:00.000Z'));
    assert.equal(summary.planName, '</text><script>alert(1)</script>');
    assert.equal(summary.roles[0].label, '<svg onload=alert(1)>');
    assert.equal(summary.metrics[1].value, 'Missing — success rate not supplied');
    assert.deepEqual(summary.notices, BUILD_EXPORT_NOTICES);
    assert.equal('html' in summary, false);
    assert.equal('svg' in summary, false);
  });

  test('rejects invalid, mismatched and non-finite quotes instead of exporting partial data', () => {
    const invalidPlan = makePlan();
    invalidPlan.name = '';
    const invalid = quoteBuildPlan(invalidPlan, models);
    assert.throws(() => buildExportJson(invalidPlan, invalid), /invalid build quote/);
    assert.throws(() => buildExportCsv(invalidPlan, invalid), /invalid build quote/);

    const plan = makePlan();
    const quote = quoteBuildPlan(plan, models);
    const mismatched = structuredClone(quote);
    mismatched.roles[0].modelId = 'other-model';
    assert.throws(() => buildExportCsv(plan, mismatched), /do not match/);
    const nonFinite = structuredClone(quote);
    nonFinite.monthlyCostUsd = Number.POSITIVE_INFINITY;
    assert.throws(() => buildExportJson(plan, nonFinite), /non-finite/);
    assert.throws(() => buildExportCsv(plan, nonFinite), /non-finite/);

    const tooMany = makePlan();
    tooMany.roles = Array.from({ length: MAX_BUILD_EXPORT_ROLES + 1 }, (_, index) => ({
      ...structuredClone(tooMany.roles[0]), roleId: `role-${index}`, label: `Role ${index}`,
    }));
    const tooManyQuote = quoteBuildPlan(tooMany, models);
    assert.equal(tooManyQuote.valid, true);
    assert.throws(() => buildExportJson(tooMany, tooManyQuote), /up to 24 roles/);

    const tooLong = makePlan();
    tooLong.name = 'x'.repeat(10_001);
    assert.throws(() => buildExportJson(tooLong, quoteBuildPlan(tooLong, models)), /supported length/);
  });

  test('rejects stale plan/quote pairs and independently verifies every quoted total', () => {
    const staleCases: Array<[string, (plan: BuildPlanV1, quote: ReturnType<typeof quoteBuildPlan>) => void]> = [
      ['plan name', (plan) => { plan.name = 'Renamed after quote'; }],
      ['workload volume', (plan) => { plan.workload.buildsPerMonth = 81; }],
      ['workload basis', (plan) => { plan.workload.volumeBasis = 'attempted_builds'; }],
      ['harness per-attempt cost', (plan) => { plan.harness.fixedCostPerBuildAttemptUsd = 9; }],
      ['harness monthly cost', (plan) => { plan.harness.fixedMonthlyCostUsd = 99; }],
      ['harness provenance', (plan) => { plan.harness.sourceUrl = 'https://example.com/changed'; }],
      ['usage input tokens', (plan) => { plan.roles[0].usagePerInvocation.uncachedInputTokens += 1; }],
      ['usage zero-rate tokens', (plan) => { plan.roles[0].usagePerInvocation.cacheWriteTokens += 1; }],
      ['usage provenance', (plan) => { plan.roles[0].usagePerInvocation.lastVerified = '2026-08-24'; }],
      ['override input rate', (plan) => { plan.roles[0].priceOverride!.inputPerMtok = 3; }],
      ['override unused cache-write rate', (plan) => { plan.roles[0].priceOverride!.cacheWritePerMtok = 0.5; }],
      ['override provenance', (plan) => { plan.roles[0].priceOverride!.sourceUrl = 'https://example.com/new-contract'; }],
      ['success rate', (plan) => { plan.endToEndSuccess!.rate = 0.9; }],
      ['success basis', (plan) => { plan.endToEndSuccess!.basis = 'user_assumption'; }],
      ['quote applied rate', (_plan, quote) => { quote.roles[0].appliedOutputPerMtok = 3; }],
      ['quote role cost', (_plan, quote) => { quote.roles[0].costPerInvocationUsd += 1; }],
      ['quote build total', (_plan, quote) => { quote.buildAttemptCostUsd! += 1; }],
      ['quote success total', (_plan, quote) => { quote.variableCostPerSuccessfulBuildUsd! += 1; }],
      ['quote monthly total', (_plan, quote) => { quote.monthlyCostUsd! += 1; }],
    ];
    for (const [label, mutate] of staleCases) {
      const plan = makePlan();
      const quote = quoteBuildPlan(plan, models, '2026-08-23T12:00:00.000Z');
      mutate(plan, quote);
      assert.throws(() => buildExportJson(plan, quote), /do not match|fresh quote/, label);
      assert.throws(() => buildExportCsv(plan, quote), /do not match|fresh quote/, label);
    }
  });

  test('generates bounded path-safe filenames with a deterministic fallback', () => {
    assert.equal(buildExportFilename('../../Résumé: Q3 / Plan', 'json'), 'resume-q3-plan-quote.json');
    assert.equal(buildExportFilename('  ', 'csv'), 'build-plan-quote.csv');
    assert.equal(buildExportFilename('Plan', 'png'), 'plan-quote.png');
    const long = buildExportFilename('a'.repeat(200), 'json');
    assert.equal(long, `${'a'.repeat(64)}-quote.json`);
    assert.doesNotMatch(long, /[\\/]/);
    assert.throws(() => buildExportFilename('Plan', 'xml' as never), /Unsupported/);
  });
});
