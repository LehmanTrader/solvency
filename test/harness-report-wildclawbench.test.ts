/**
 * Research Note 02, population two: the WildClawBench harness-comparison
 * table. Every published cell must re-derive from the transcribed dataset in
 * data/harness-study/wildclawbench.json, and the isolation rules the note
 * promises must hold in its own prose.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const md = readFileSync(join(ROOT, 'reports', '2026-08-same-model-four-harnesses.md'), 'utf8');
const study = JSON.parse(readFileSync(join(ROOT, 'data', 'harness-study', 'wildclawbench.json'), 'utf8'));
const cells = (line: string) => line.split('|').slice(1, -1).map((c: string) => c.trim());
const num = (s: string) => Number(s.replace(/[*$%,x]/g, ''));

type Cell = { model: string; harness: string; time_min_per_task: number; cost_usd_per_task: number; score_pct: number };
const results: Cell[] = study.results;
const scoreEq = (r: Cell) => r.cost_usd_per_task / (r.score_pct / 100);

describe('Research Note 02 population two matches the WildClawBench study file', () => {
  const tableLines = md
    .split('\n')
    .filter((l) => /^\| (GPT-5\.4|GLM 5|MiMo V2 Pro|MiniMax M2\.7) \|/.test(l));

  test('all sixteen published cells re-derive from the transcribed dataset', () => {
    assert.equal(tableLines.length, 16, 'the note publishes exactly the 16 source cells');
    for (const line of tableLines) {
      const [model, harness, cost, score, minutes, perScoreEq, versus] = cells(line);
      const row = results.find((r) => r.model === model && r.harness === harness);
      assert.ok(row, `published cell not in dataset: ${model} + ${harness}`);
      assert.equal(num(cost).toFixed(2), row!.cost_usd_per_task.toFixed(2), `${model}+${harness}: $/task`);
      assert.equal(num(score).toFixed(1), row!.score_pct.toFixed(1), `${model}+${harness}: score`);
      assert.equal(num(minutes).toFixed(2), row!.time_min_per_task.toFixed(2), `${model}+${harness}: min/task`);
      assert.equal(num(perScoreEq).toFixed(3), scoreEq(row!).toFixed(3), `${model}+${harness}: $/score-eq`);
      const cheapest = Math.min(...results.filter((r) => r.model === model).map(scoreEq));
      assert.equal(num(versus).toFixed(2), (scoreEq(row!) / cheapest).toFixed(2), `${model}+${harness}: vs cheapest`);
    }
  });

  test('the headline spreads and score swing are exact', () => {
    const spreads = ['GPT-5.4', 'GLM 5', 'MiMo V2 Pro', 'MiniMax M2.7'].map((model) => {
      const eqs = results.filter((r) => r.model === model).map(scoreEq);
      return Math.max(...eqs) / Math.min(...eqs);
    });
    assert.equal(Math.min(...spreads).toFixed(1), '1.9');
    assert.equal(Math.max(...spreads).toFixed(1), '2.8');
    assert.match(md, /1\.9x to 2\.8x within each model/);
    const glm = results.filter((r) => r.model === 'GLM 5').map((r) => r.score_pct);
    assert.equal((Math.max(...glm) - Math.min(...glm)).toFixed(1), '15.4');
    assert.match(md, /15\.4 points/);
  });

  test('Hermes tops three models and is never the cheapest per score-equivalent task', () => {
    let hermesTops = 0;
    for (const model of ['GPT-5.4', 'GLM 5', 'MiMo V2 Pro', 'MiniMax M2.7']) {
      const arms = results.filter((r) => r.model === model);
      const best = arms.reduce((a, b) => (b.score_pct > a.score_pct ? b : a));
      const cheapest = arms.reduce((a, b) => (scoreEq(b) < scoreEq(a) ? b : a));
      if (best.harness === 'Hermes Agent') hermesTops++;
      assert.notEqual(cheapest.harness, 'Hermes Agent', `${model}: Hermes must not be cheapest`);
      assert.notEqual(best.harness, cheapest.harness, `${model}: best score and cheapest must differ`);
    }
    assert.equal(hermesTops, 3);
  });

  test('the note states the basis, gaps and isolation rules for population two', () => {
    assert.match(md, /score-equivalent task/);
    assert.match(md, /not a strict pass rate/);
    assert.match(md, /per-cell\s+token usage is not published/);
    assert.match(md, /Docker image tags/);
    assert.match(md, /never merged with population one/);
    assert.ok(md.includes(study.source.last_verified), 'WildClawBench verification date appears in the note');
    assert.ok(md.includes(study.source.paper_v1_date), 'the paper v1 date appears in the note');
    assert.equal(study.source.redistributable, false);
    assert.equal(study.score_semantics, 'graded_0_100_average_not_pass_rate');
  });
});
