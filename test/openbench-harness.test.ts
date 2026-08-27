import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { costPerSolvedTask, defaultOptions } from '../scripts/solved-cost.ts';
import { assumptions, bestResultFor, extrasFor, modelById, results, sourceFor, tiers } from '../scripts/load.ts';
import { harnessComparable } from '../site/src/lib/compare.ts';

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ~= ${b}`);

describe('source-measured usage repricing', () => {
  const model = () => modelById('gpt-5.6-sol')!;
  const sourceUsage = {
    token_basis: 'proxy_measured' as const,
    attempts_n: 2,
    input_uncached_tokens_total: 2_000_000,
    cache_read_tokens_total: 2_000_000,
    cache_write_tokens_total: 0,
    output_tokens_total: 2_000_000,
  };

  test('prices observed token usage without applying the loop model', () => {
    const out = costPerSolvedTask(
      model(), 'heavy', tiers.heavy, 0.5, defaultOptions(assumptions), { sourceUsage } as any,
    );
    assert.equal(out.value!.costBasis, 'source_usage_repriced');
    // Per attempt: 1M uncached input × $5 + 1M cache read × $0.50 + 1M output × $30.
    near(out.value!.attempt.costUsd, 35.5);
    near(out.value!.naive, 71);
  });

  test('task tier, cache and frontier assumptions cannot move a usage-repriced row', () => {
    const base = defaultOptions(assumptions);
    const hostile = {
      ...base,
      cacheHitFraction: 0.99,
      loopsOverride: 999,
      frontierEfficiency: { ...base.frontierEfficiency, multipliers_by_tier: { light: 0.01, moderate: 0.01, heavy: 0.01 } },
    };
    const values = [
      costPerSolvedTask(model(), 'light', tiers.light, 0.5, base, { sourceUsage } as any).value!.naive,
      costPerSolvedTask(model(), 'heavy', tiers.heavy, 0.5, hostile, { sourceUsage } as any).value!.naive,
    ];
    assert.deepEqual(values, [71, 71]);
  });
});

describe('OpenBench GPT-5.6 Sol harness slice', () => {
  const rows = results.filter((r) => r.benchmark === 'openbench-gpt56-harness');

  test('contains only the four comparable proxy-metered harness arms', () => {
    assert.deepEqual(rows.map((r) => r.harness).sort(), ['Claude Code', 'Codex', 'Grok Build', 'Pi']);
    assert.ok(rows.every((r) => r.model_id === 'gpt-5.6-sol'));
    assert.ok(rows.every((r) => r.harness_version && r.harness_config));
    assert.ok(rows.every((r) => r.cost_basis === 'source_usage_repriced'));
    assert.ok(rows.every((r) => r.source_usage?.token_basis === 'proxy_measured'));
  });

  test('re-derives the four published aggregates from source usage and current prices', () => {
    const expected = new Map([
      ['Pi', { pass: 32 / 44, attempt: 0.26421211363636365, solved: 0.3632916562500001 }],
      ['Claude Code', { pass: 35 / 45, attempt: 0.32659393333333336, solved: 0.4199064857142857 }],
      ['Grok Build', { pass: 37 / 45, attempt: 0.4912145555555556, solved: 0.5974231081081082 }],
      ['Codex', { pass: 32 / 44, attempt: 0.9966333409090908, solved: 1.37037084375 }],
    ]);
    for (const row of rows) {
      const want = expected.get(row.harness!)!;
      near(row.pass_rate, want.pass);
      const out = costPerSolvedTask(modelById(row.model_id!)!, 'heavy', tiers.heavy, row.pass_rate, defaultOptions(assumptions), extrasFor(row));
      assert.equal(out.value!.costBasis, 'source_usage_repriced');
      near(out.value!.attempt.costUsd, want.attempt);
      near(out.value!.naive, want.solved);
    }
  });

  test('forms one isolated comparable group and never replaces the general leaderboard row', () => {
    assert.equal(rows.length, 4);
    for (let i = 1; i < rows.length; i++) assert.equal(harnessComparable(rows[0], rows[i]), true);
    // §21 flip: the leaderboard row is now Solvency's own measurement; the
    // invariant this test protects is narrower — the HARNESS-study rows must
    // never become the model's leaderboard row.
    assert.notEqual(bestResultFor('gpt-5.6-sol')!.benchmark, 'openbench-gpt56-harness');
    assert.ok(bestResultFor('gpt-5.6-sol')!.benchmark.startsWith('solvency-bench'), 'ours-first: bench row leads');
    assert.equal(sourceFor('openbench-gpt56-harness')!.tasks_n, 15);
  });
});
