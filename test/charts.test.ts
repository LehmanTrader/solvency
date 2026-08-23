import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rankedBars, scatterPareto, volumeLines, paretoFrontier, money, type ChartRow } from '../site/src/lib/charts.ts';
import { models, bestResultFor, extrasFor, tiers, assumptions } from '../scripts/load.ts';
import { costPerSolvedTask, defaultOptions } from '../scripts/solved-cost.ts';

/** The default scenario (moderate tier, naive) as chart rows, built from the repo data. */
function rows(): ChartRow[] {
  const basisOf: Record<string, ChartRow['basis']> = { measured_by_source: 'measured', modelled_by_solvency: 'modelled', historical_at_run_date: 'stale' };
  const out: ChartRow[] = [];
  for (const m of models) {
    const r = bestResultFor(m.model_id); if (!r) continue;
    const c = costPerSolvedTask(m, 'moderate', tiers.moderate, r.pass_rate, defaultOptions(assumptions), extrasFor(r));
    if (!c.value) continue;
    out.push({ id: m.model_id, name: m.display_name, href: `/models/${m.model_id}`, cost: c.value.naive, pass: r.pass_rate, basis: basisOf[r.cost_basis] });
  }
  return out;
}

describe('inline SVG charts', () => {
  const all = rows();
  const measured = all.filter((r) => r.basis === 'measured');
  const modelled = all.filter((r) => r.basis === 'modelled');

  test('the measured ranked chart contains no modelled row, and vice versa', () => {
    const svg = rankedBars(measured, { width: 846, volume: 200, basis: 'measured' });
    assert.equal(svg.match(/role="listitem"/g)?.length, measured.length);
    for (const r of modelled) assert.ok(!svg.includes(`data-id="${r.id}"`), `${r.id} leaked into the measured group`);
    assert.ok(svg.includes('MEASURED'), 'the word is printed, never color alone');
    const m2 = rankedBars(modelled, { width: 846, volume: 200, basis: 'modelled' });
    for (const r of measured) assert.ok(!m2.includes(`data-id="${r.id}"`), `${r.id} leaked into the modelled group`);
    assert.ok(m2.includes('url(#hatch-modelled)'), 'modelled bars are hatched');
  });

  test('rows are ranked cheapest first and carry the month figure at the volume', () => {
    const svg = rankedBars(measured, { width: 846, volume: 1000, basis: 'measured' });
    const order = [...svg.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]);
    const sorted = measured.slice().sort((a, b) => a.cost - b.cost).map((r) => r.id);
    assert.deepEqual(order, sorted);
    assert.ok(svg.includes(money(sorted.length ? measured.find((r) => r.id === sorted[0])!.cost * 1000 : 0)));
    assert.ok(svg.includes('<title>') && svg.includes('<desc>'));
  });

  test('the Pareto frontier is measured-only and monotone', () => {
    const f = paretoFrontier(all);
    assert.ok(f.length >= 1);
    for (const p of f) assert.equal(p.basis, 'measured');
    for (let i = 1; i < f.length; i++) {
      assert.ok(f[i].pass > f[i - 1].pass, 'pass rate rises along the frontier');
      assert.ok(f[i].cost > f[i - 1].cost, 'cost rises along the frontier');
    }
    const svg = scatterPareto(all, { width: 720 });
    assert.ok(svg.includes('class="frontier"'));
    assert.ok(svg.includes('pt-modelled') && svg.includes('pt-measured'));
    assert.ok(!svg.includes('pt-stale'), 'stale points are hidden by default');
  });

  test('volume lines cap at six series and carry basis in the line style', () => {
    const series = all.slice(0, 8).map((r) => ({ id: r.id, name: r.name, basis: r.basis, perTask: r.cost }));
    const svg = volumeLines(series, { width: 640, volume: 200 });
    assert.equal(svg.match(/class="line /g)?.length, 6);
    assert.ok(!svg.includes('NaN') && !svg.includes('undefined'));
  });
});
