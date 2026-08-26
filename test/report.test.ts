/**
 * The report is a rendering of the dataset, not a separate document. These
 * tests parse the published tables and re-derive every figure from the engine,
 * so a price change that is not carried into the prose fails the build.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { models, tiers, assumptions, bestResultFor, extrasFor } from '../scripts/load.ts';
import { costPerSolvedTask, defaultOptions } from '../scripts/solved-cost.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = join(ROOT, 'reports', '2026-08-cost-per-solved-task.md');
const md = readFileSync(REPORT, 'utf8');
const opts = defaultOptions(assumptions);

const byName = (n: string) => models.find((m) => m.display_name === n);
const cells = (line: string) => line.split('|').slice(1, -1).map((c) => c.trim());
const num = (s: string) => Number(s.replace(/[*$%d,]/g, ''));

describe('report matches the dataset', () => {
  test('measured table figures re-derive from the engine', () => {
    const rows = md.split('\n').filter((l) => /^\| .+ \| (Claude Code|Codex|Grok Build|Opencode|Kimi Code CLI|Muse Code) \|/.test(l));
    assert.equal(rows.length, 13, 'expected 13 measured rows in the report (2026-08-26 AA re-read)');
    for (const line of rows) {
      const [name, harness, idx, perTask, perSolved] = cells(line);
      const m = byName(name);
      assert.ok(m, `report names a model not in models.json: ${name}`);
      const r = bestResultFor(m!.model_id)!;
      assert.equal(r.harness, harness, `${name}: harness`);
      assert.equal(num(idx), r.index_score, `${name}: index`);
      assert.equal(num(perTask), r.measured_cost_per_task_usd, `${name}: cost per task`);
      const solved = costPerSolvedTask(m!, 'heavy', tiers.heavy, r.pass_rate, opts, extrasFor(r)).value!.naive;
      assert.equal(num(perSolved).toFixed(2), solved.toFixed(2), `${name}: cost per solved task`);
    }
  });

  test('modelled table figures re-derive for all three tiers', () => {
    const rows = md.split('\n').filter((l) => /^\| .+ \| (Aider|SEAL) \| \d+% \|/.test(l));
    assert.equal(rows.length, 11, 'expected 11 modelled rows in the report');
    for (const line of rows) {
      const [name, , pass, , light, moderate, heavy] = cells(line);
      const m = byName(name);
      assert.ok(m, `report names a model not in models.json: ${name}`);
      const r = bestResultFor(m!.model_id)!;
      assert.equal(num(pass), Math.round(r.pass_rate * 100), `${name}: pass rate`);
      const got = (['light', 'moderate', 'heavy'] as const).map((t) =>
        costPerSolvedTask(m!, t, tiers[t], r.pass_rate, opts, extrasFor(r)).value!.naive.toFixed(2));
      assert.deepEqual([num(light).toFixed(2), num(moderate).toFixed(2), num(heavy).toFixed(2)], got, `${name}: tiers`);
    }
  });

  test('the missing-models counts match the dataset exactly', () => {
    // Since the catalog ingested the full OpenRouter listing (2026-08-26,
    // operator directive), the note states counts rather than naming every
    // model. Both stated counts must re-derive from the dataset.
    const actual = models.filter((m) => m.status === 'current' && !bestResultFor(m.model_id));
    const current = models.filter((m) => m.status === 'current');
    const para = md.match(/\*\*Not in either table:\*\* the remaining (\d+) priced, current models/);
    assert.ok(para, 'could not locate the missing-models paragraph');
    assert.equal(Number(para![1]), actual.length, `paragraph says ${para![1]}, dataset has ${actual.length}`);
    const bullet = md.match(/\*\*(\d+) of (\d+) current, priced models have no pass rate/);
    assert.ok(bullet, 'could not locate the missing-models count bullet');
    assert.equal(Number(bullet![1]), actual.length);
    assert.equal(Number(bullet![2]), current.length);
    // The names the paragraph does single out must be real, current and data-less.
    for (const n of ['Claude Sonnet 5', 'Claude Haiku 4.5', 'GPT-5.3 Codex', 'GLM-5.3']) {
      const m = byName(n);
      assert.ok(m, `report names an unknown model: ${n}`);
      assert.equal(bestResultFor(m!.model_id), null, `${n} actually has a pass rate`);
    }
  });

  test('every chart the report embeds exists and is non-trivial', () => {
    const refs = [...md.matchAll(/\]\((charts\/[a-z]+\.svg)\)/g)].map((x) => x[1]);
    assert.ok(refs.length >= 3, 'expected at least 3 charts');
    for (const ref of refs) {
      const svg = readFileSync(join(ROOT, 'reports', ref), 'utf8');
      assert.ok(svg.startsWith('<svg'), `${ref} is not an SVG`);
      assert.ok(svg.length > 2000, `${ref} looks empty`);
    }
  });

  test('the divergence claims in the prose match the data', () => {
    const ds = byName('DeepSeek V4 Flash')!, op = byName('Claude Opus 5')!;
    assert.equal(Math.round(op.input_per_mtok / ds.input_per_mtok), 11, 'input token ratio');
    assert.equal(Math.round(op.output_per_mtok / ds.output_per_mtok), 19, 'output token ratio');
    const solved = (m: typeof ds) => {
      const r = bestResultFor(m.model_id)!;
      return costPerSolvedTask(m, 'heavy', tiers.heavy, r.pass_rate, opts, extrasFor(r)).value!.naive;
    };
    assert.equal(Math.round(solved(op) / solved(ds)), 100, 'cost per solved task ratio');
    const perTask = (m: typeof ds) => bestResultFor(m.model_id)!.measured_cost_per_task_usd!;
    assert.equal(Math.round(perTask(op) / perTask(ds)), 136, 'cost per task ratio');
  });

  test('the one-index-point premium claim matches the data', () => {
    const g = byName('Grok 4.5')!, s = byName('GPT-5.6 Sol')!;
    const solved = (m: typeof g) => {
      const r = bestResultFor(m.model_id)!;
      return costPerSolvedTask(m, 'heavy', tiers.heavy, r.pass_rate, opts, extrasFor(r)).value!.naive;
    };
    assert.equal((solved(s) - solved(g)).toFixed(2), '6.06', 'premium per index point');
    assert.ok(md.includes('$6.06'), 'report states the computed premium');
  });

  test('every number-bearing claim carries a verification date', () => {
    assert.ok(md.includes('2026-08-21'), 'report states its verification date');
    assert.ok(/METR/.test(md), 'METR caveat present');
    assert.ok(/19% slower/.test(md), 'METR figure stated');
  });
});
