/**
 * Research Note 02 is a rendering of the canonical OpenBench slice. Parse the
 * public table and fail whenever its claims drift from the engine or sources.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assumptions, bestResultFor, extrasFor, harnessResultsFor, modelById, sourceFor, tiers } from '../scripts/load.ts';
import { costPerSolvedTask, defaultOptions } from '../scripts/solved-cost.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = join(ROOT, 'reports', '2026-08-same-model-four-harnesses.md');
const md = readFileSync(REPORT, 'utf8');
const opts = defaultOptions(assumptions);
const model = modelById('gpt-5.6-sol')!;
const rows = harnessResultsFor(model.model_id);
const cells = (line: string) => line.split('|').slice(1, -1).map((c) => c.trim());
const num = (s: string) => Number(s.replace(/[*$%,x]/g, ''));

describe('Research Note 02 matches the harness dataset', () => {
  test('all four published rows re-derive from observed usage', () => {
    const tableBlock = md.match(/\| Harness \| Version \| Solved[\s\S]*?\n\nSource:/)?.[0] ?? '';
    const table = tableBlock.split('\n').filter((l) => /^\| (Pi|Claude Code|Grok Build|Codex) \|/.test(l));
    assert.equal(table.length, 4);
    const lowest = Math.min(...rows.map((r) =>
      costPerSolvedTask(model, 'heavy', tiers.heavy, r.pass_rate, opts, extrasFor(r)).value!.naive));

    for (const line of table) {
      const [harness, version, solved, pass, attempt, perSolved, versus] = cells(line);
      const row = rows.find((r) => r.harness === harness)!;
      assert.ok(row, `unknown harness in report: ${harness}`);
      assert.equal(version, row.harness_version);
      assert.equal(solved, `${row.solved_attempts_n}/${row.countable_attempts_n}`);
      assert.equal(num(pass).toFixed(1), (row.pass_rate * 100).toFixed(1));
      const out = costPerSolvedTask(model, 'heavy', tiers.heavy, row.pass_rate, opts, extrasFor(row)).value!;
      assert.equal(num(attempt).toFixed(3), out.attempt.costUsd.toFixed(3));
      assert.equal(num(perSolved).toFixed(3), out.naive.toFixed(3));
      assert.equal(num(versus).toFixed(2), (out.naive / lowest).toFixed(2));
    }
  });

  test('the matched-rate headline is exact and the general leaderboard stays isolated', () => {
    const pi = rows.find((r) => r.harness === 'Pi')!;
    const codex = rows.find((r) => r.harness === 'Codex')!;
    const solved = (r: typeof pi) => costPerSolvedTask(model, 'heavy', tiers.heavy, r.pass_rate, opts, extrasFor(r)).value!.naive;
    assert.equal(pi.pass_rate, codex.pass_rate);
    assert.equal((solved(codex) / solved(pi)).toFixed(2), '3.77');
    assert.match(md, /3\.77x spread at the same 72\.7% pass rate/);
    // §21 flip: the leaderboard row is Solvency's own; the invariant here is
    // only that harness-study rows never take that slot.
    assert.notEqual(bestResultFor(model.model_id)!.benchmark, 'openbench-gpt56-harness');
  });

  test('measurement basis, exclusions, dates and limitations are explicit', () => {
    assert.match(md, /source usage repriced/i);
    assert.match(md, /Cursor and OpenCode are absent/);
    assert.match(md, /Devin is absent/);
    assert.match(md, /success rate not supplied/i);
    assert.match(md, /user-modelled architecture/i);
    assert.ok(md.includes(sourceFor('openbench-gpt56-harness')!.last_verified));
    assert.ok(md.includes(model.last_verified));
  });

  test('the report chart exists and is non-trivial', () => {
    const ref = (md.match(/\]\((charts\/harness\.svg)\)/) ?? [])[1];
    assert.equal(ref, 'charts/harness.svg');
    const svg = readFileSync(join(ROOT, 'reports', ref), 'utf8');
    assert.ok(svg.startsWith('<svg'));
    assert.ok(svg.length > 2_000);
  });
});
