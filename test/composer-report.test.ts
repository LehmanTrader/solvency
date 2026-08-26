/**
 * Research Note 04 is a rendering of three Build Composer quotes. Rebuild
 * the same three BuildPlanV1s, quote them through the engine the website
 * uses, and fail whenever a published figure, share or ratio drifts.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { quoteBuildPlan, type BuildPlanV1 } from '../site/src/lib/build-cost.ts';
import { models } from '../site/src/lib/data.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const md = readFileSync(join(ROOT, 'reports', '2026-08-composing-the-stack.md'), 'utf8');

const usage = (fresh: number, output: number) => ({
  uncachedInputTokens: fresh, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: output,
  basis: 'template_assumption' as const,
});
const role = (roleId: string, kind: 'orchestrator' | 'worker' | 'other', label: string, modelId: string, calls: number, fresh: number, output: number) => ({
  roleId, kind, label, modelId, expectedInvocationsPerBuildAttempt: calls, usagePerInvocation: usage(fresh, output),
});
const mkPlan = (name: string, orch: string, worker: string, fallback: string): BuildPlanV1 => ({
  schemaVersion: 1, name,
  workload: { buildsPerMonth: 200, volumeBasis: 'attempted_builds' },
  harness: { name: 'Claude Code', version: null, configBasis: 'solvency_template', fixedCostPerBuildAttemptUsd: 0, fixedMonthlyCostUsd: 0 },
  roles: [
    role('r1', 'orchestrator', 'Lead orchestrator', orch, 1, 6000, 600),
    role('r2', 'worker', 'Worker pool', worker, 3, 20000, 3000),
    role('r3', 'other', 'Fallback route', fallback, 0.3, 20000, 3000),
  ],
});

const PLANS = {
  monolithFrontier: mkPlan('All-frontier monolith', 'claude-fable-5', 'claude-fable-5', 'claude-fable-5'),
  composed: mkPlan('Composed', 'claude-fable-5', 'deepseek-v4-flash', 'claude-opus-5'),
  monolithValue: mkPlan('All-value monolith', 'deepseek-v4-flash', 'deepseek-v4-flash', 'deepseek-v4-flash'),
};
const quote = (p: BuildPlanV1) => quoteBuildPlan(p, models as any, '2026-08-26T00:00:00Z');

describe('Research Note 04 matches the Build Composer engine', () => {
  const qa = quote(PLANS.monolithFrontier), qb = quote(PLANS.composed), qc = quote(PLANS.monolithValue);

  test('all three plans quote cleanly with no errors and no success rate', () => {
    for (const q of [qa, qb, qc]) {
      assert.equal(q.valid, true);
      assert.deepEqual(q.errors, []);
      assert.equal(q.successfulBuildsPerMonth, null, 'no completed-build figure without a measured success rate');
    }
  });

  test('the composition table re-derives from the engine', () => {
    const cells = [
      { attempt: qa.buildAttemptCostUsd, month: qa.monthlyCostUsd, a: '$1.2450', m: '$249.00' },
      { attempt: qb.buildAttemptCostUsd, month: qb.monthlyCostUsd, a: '$0.1808', m: '$36.16' },
      { attempt: qc.buildAttemptCostUsd, month: qc.monthlyCostUsd, a: '$0.0455', m: '$9.11' },
    ];
    for (const c of cells) {
      assert.equal(`$${c.attempt.toFixed(4)}`, c.a);
      assert.equal(`$${c.month.toFixed(2)}`, c.m);
      assert.ok(md.includes(c.a) && md.includes(c.m), `note states ${c.a} and ${c.m}`);
    }
    const spread = qa.buildAttemptCostUsd / qb.buildAttemptCostUsd;
    assert.equal(spread.toFixed(1), '6.9');
    assert.match(md, /6\.9x spread from composition alone/);
    assert.match(md, /6\.9x apart on\s+composition alone/);
    assert.equal((qc.buildAttemptCostUsd / qb.buildAttemptCostUsd).toFixed(2), '0.25');
    assert.match(md, /\| 0\.25x \|/);
  });

  test('the composed plan seat shares and per-build figures re-derive', () => {
    const seats = Object.fromEntries(qb.roles.map((r: any) => [r.kind, r]));
    const rows: [string, string, string][] = [
      ['orchestrator', '$0.0900', '50%'],
      ['worker', '$0.0383', '21%'],
      ['other', '$0.0525', '29%'],
    ];
    for (const [kind, dollars, share] of rows) {
      const r = seats[kind];
      assert.ok(r, `composed plan quotes a ${kind} seat`);
      assert.equal(`$${r.costPerBuildAttemptUsd.toFixed(4)}`, dollars, `${kind}: per-build cost`);
      const pct = `${Math.round((r.costPerBuildAttemptUsd / qb.buildAttemptCostUsd) * 100)}%`;
      assert.equal(pct, share, `${kind}: share`);
      assert.ok(md.includes(dollars) && md.includes(`| ${share} |`), `note states ${dollars} and ${share}`);
    }
  });

  test('the note states its basis, template profile and honesty rules', () => {
    assert.match(md, /template assumption/i);
    assert.match(md, /6,000 in \/ 600 out/);
    assert.match(md, /20,000 in \/\s+3,000 out/);
    assert.match(md, /success rate\s+not supplied/i);
    assert.match(md, /Nothing here is\s+measured/);
    assert.ok(md.includes('build-cost-v1'));
    for (const r of qb.roles as any[]) assert.equal(r.priceBasis, 'catalog_list', `${r.kind}: catalog list price, no overrides`);
  });
});
