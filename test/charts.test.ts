import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rankedBars, scatterPareto, volumeLines, paretoFrontier, money, capsLabel, type ChartRow } from '../site/src/lib/charts.ts';
import { models, bestResultFor, extrasFor, tiers, assumptions } from '../scripts/load.ts';
import { costPerSolvedTask, defaultOptions } from '../scripts/solved-cost.ts';

/** The default scenario (moderate tier, naive) as chart rows, built from the repo data. */
function rows(): ChartRow[] {
  const basisOf: Record<string, ChartRow['basis']> = { measured_by_source: 'measured', modelled_by_solvency: 'modelled', historical_at_run_date: 'stale', free_tier_capped: 'free', measured_by_solvency: 'measured' };
  const out: ChartRow[] = [];
  for (const m of models) {
    const r = bestResultFor(m.model_id); if (!r) continue;
    const c = costPerSolvedTask(m, 'moderate', tiers.moderate, r.pass_rate, defaultOptions(assumptions), extrasFor(r));
    if (!c.value) continue;
    out.push({ id: m.model_id, name: m.display_name, href: `/models/${m.model_id}`, cost: c.value.naive, pass: r.pass_rate, basis: basisOf[r.cost_basis], harness: r.cost_basis });
  }
  return out;
}

describe('inline SVG charts', () => {
  const all = rows();
  // basisKey rides in `harness` for fixture purposes: one chart never mixes
  // the AA population with the first-party Solvency Bench population.
  const measured = all.filter((r) => r.harness === 'measured_by_source');
  const modelled = all.filter((r) => r.harness === 'modelled_by_solvency');

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

describe('free-model coverage: log-axis guards (docs/free-models-scoping.md §2D)', () => {
  const zeroRow: ChartRow = { id: 'zero-fixture', name: 'Zero Fixture', href: '/models/zero-fixture', cost: 0, pass: 0.5, basis: 'free' };
  const positiveRow: ChartRow = { id: 'pos-fixture', name: 'Positive Fixture', href: '/models/pos-fixture', cost: 1.5, pass: 0.7, basis: 'measured' };

  test('scatterPareto never divides log10(0): a $0 point produces a finite viewBox and no NaN/Infinity in any y attribute', () => {
    const svg = scatterPareto([zeroRow, positiveRow], { width: 720 });
    assert.doesNotMatch(svg, /NaN/);
    assert.doesNotMatch(svg, /Infinity/i);
    const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1] ?? '';
    for (const n of viewBox.split(' ')) assert.ok(Number.isFinite(Number(n)), `viewBox number "${n}" is not finite`);
    for (const y of [...svg.matchAll(/\sy="([^"]+)"/g)].map((m) => m[1])) assert.ok(Number.isFinite(Number(y)), `y="${y}" is not finite`);
    // the $0 point is excluded from the plotted set, and the omission is stated, not silent
    assert.doesNotMatch(svg, /href="\/models\/zero-fixture"/);
    assert.match(svg, /href="\/models\/pos-fixture"/);
    assert.match(svg, /1 free-tier \(\$0\) row excluded/);
  });

  test('scatterPareto with only $0 points never crashes (Math.min(...[]) === Infinity guard)', () => {
    const svg = scatterPareto([zeroRow], { width: 720 });
    assert.doesNotMatch(svg, /NaN/);
    assert.doesNotMatch(svg, /Infinity/i);
  });

  test('volumeLines never divides log10(0): a $0 series is dropped, remaining series stay finite', () => {
    const series = [
      { id: 'zero-fixture', name: 'Zero Fixture', basis: 'free' as const, perTask: 0 },
      { id: 'pos-fixture', name: 'Positive Fixture', basis: 'measured' as const, perTask: 1.5 },
    ];
    const svg = volumeLines(series, { width: 640, volume: 200 });
    assert.doesNotMatch(svg, /NaN/);
    assert.doesNotMatch(svg, /Infinity/i);
    assert.equal(svg.match(/class="line /g)?.length, 1, 'only the positive-cost series is plotted');
    assert.match(svg, /1 free-tier \(\$0\) series excluded/);
  });

  test('volumeLines with every series at $0 never crashes', () => {
    const svg = volumeLines([{ id: 'zero-fixture', name: 'Zero Fixture', basis: 'free' as const, perTask: 0 }], { width: 640, volume: 200 });
    assert.doesNotMatch(svg, /NaN/);
    assert.doesNotMatch(svg, /Infinity/i);
  });
});

describe('free-model coverage: rendering (docs/free-models-scoping.md §3/§4)', () => {
  test('capsLabel() formats a compact cap string, and says "not published" rather than fabricating unlimited', () => {
    assert.equal(capsLabel(null), 'cap: not published');
    assert.equal(capsLabel(undefined), 'cap: not published');
    assert.equal(capsLabel({ requests_per_minute: 20, requests_per_day: 50, tokens_per_minute: null, tokens_per_day: null, source_url: 'https://example.com', last_verified: '2026-08-26' }), 'cap: 20 req/min, 50 req/day');
    assert.equal(capsLabel({ requests_per_minute: null, requests_per_day: null, tokens_per_minute: null, tokens_per_day: null, source_url: null, last_verified: null }), 'cap: not published');
  });

  test('a free-basis ranked row is dotted/outlined (never solid or hatched, and never the measured/modelled fill), carries the FREE badge, and shows its cap compactly', () => {
    const row: ChartRow = { id: 'free-row', name: 'Free Row', href: '/models/free-row', cost: 0, pass: 0.6, basis: 'free', provider: 'openrouter', caps: 'cap: 20 req/min, 50 req/day' };
    const svg = rankedBars([row], { width: 846, volume: 200, basis: 'free' });
    assert.match(svg, /FREE · RATE-CAPPED/);
    assert.match(svg, /stroke="var\(--color-free\)"/);
    assert.doesNotMatch(svg, /fill="var\(--color-measured\)"/);
    assert.doesNotMatch(svg, /url\(#hatch-modelled\)/);
    assert.match(svg, /cap: 20 req\/min, 50 req\/day/);
  });

  test('a tied-$0 free group ranks by pass rate by default, not cost, and suppresses the amber "cheapest" lead mark', () => {
    const a: ChartRow = { id: 'a', name: 'A', href: '/models/a', cost: 0, pass: 0.3, basis: 'free' };
    const b: ChartRow = { id: 'b', name: 'B', href: '/models/b', cost: 0, pass: 0.8, basis: 'free' };
    const svg = rankedBars([a, b], { width: 846, volume: 200, basis: 'free' });
    const order = [...svg.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(order, ['b', 'a'], 'higher pass rate ranks first in the free group by default');
    assert.doesNotMatch(svg, /class="row lead"/, 'no row is marked "cheapest" when every row ties at $0');
  });
});
