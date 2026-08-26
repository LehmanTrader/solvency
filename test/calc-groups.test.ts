import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compute, DEFAULTS, GROUPS, gateDelta, calloutHtml, projectTotalHtml, type Settings } from '../site/src/lib/calc.ts';

/** Which group every model lands in (measured / modelled / stale / missing) under one setting. */
function membership(s: Settings): Record<string, string> {
  const { rows, missing } = compute(s);
  const out: Record<string, string> = {};
  for (const r of rows) out[r.m.model_id] = r.basisKey;
  for (const name of missing) out[`missing:${name.replace(/ \(.*$/, '')}`] = 'missing';
  return out;
}

describe('group membership is invariant under every assumption control', () => {
  const base = membership(DEFAULTS);
  const variants: [string, Partial<Settings>][] = [
    ['cache 50%', { cache: 0.5 }], ['cache 90%', { cache: 0.9 }],
    ['residual $500', { residual: 500 }], ['residual $1,000,000', { residual: 1_000_000 }],
    ['frontier off', { frontier: false }],
    ['variant capped', { variant: 'capped' }], ['variant truncatedGeometric', { variant: 'truncatedGeometric' }],
    ['tier light', { tier: 'light' }], ['tier heavy', { tier: 'heavy' }],
    ['everything at once', { tier: 'heavy', cache: 0.9, residual: 1000, frontier: false, variant: 'truncatedGeometric' }],
  ];
  for (const [name, patch] of variants) {
    test(name, () => {
      assert.deepEqual(membership({ ...DEFAULTS, ...patch }), base, `${name} changed a group`);
    });
  }

  test('a model with no cached-input price stays in its group, computed uncached and annotated', (t) => {
    const { rows } = compute({ ...DEFAULTS, cache: 0.5 });
    const flagged = rows.filter((r) => r.uncached);
    // With the stale (historical_at_run_date) rows retired from ranking
    // (2026-08-26), the computable set may hold no null-cache model. The
    // uncached path still exists for future rows; skip rather than fake one.
    if (flagged.length === 0) {
      for (const r of rows.filter((r) => r.basisKey !== 'measured_by_source'))
        assert.notEqual(r.m.cached_input_per_mtok, null);
      t.skip('no computable model currently lacks a cached-input price');
      return;
    }
    for (const r of flagged) {
      assert.equal(r.m.cached_input_per_mtok, null);
      const at0 = compute(DEFAULTS).rows.find((x) => x.m.model_id === r.m.model_id)!;
      assert.equal(r.cost, at0.cost, 'computed at the uncached price');
    }
    for (const r of rows.filter((r) => !r.uncached && r.basisKey !== 'measured_by_source'))
      assert.notEqual(r.m.cached_input_per_mtok, null);
  });

  test('measured rows never move under any assumption', () => {
    // Both measured bases: third-party (measured_by_source) and first-party
    // (measured_by_solvency, 2026-08-26) — an observed dollar bill has no knobs.
    const isMeasured = (k: string) => k === 'measured_by_source' || k === 'measured_by_solvency';
    const a = compute(DEFAULTS).rows.filter((r) => isMeasured(r.basisKey));
    const b = compute({ ...DEFAULTS, cache: 0.9, residual: 1000, frontier: false, tier: 'heavy' }).rows.filter((r) => isMeasured(r.basisKey));
    assert.deepEqual(a.map((r) => [r.m.model_id, r.cost]), b.map((r) => [r.m.model_id, r.cost]));
    assert.ok(a.some((r) => r.basisKey === 'measured_by_solvency'), 'expected at least one first-party measured row');
  });

  test('GROUPS are the four groups, measured first, Solvency Bench isolated', () => {
    // Stale retired 2026-08-26 (operator); the first-party Solvency Bench
    // group joined the same day — measured styling, own population, and
    // excluded from every superlative (see SUPERLATIVE_GROUPS).
    assert.deepEqual(GROUPS.map((g) => g.key),
      ['measured_by_source', 'modelled_by_solvency', 'measured_by_solvency', 'free_tier_capped']);
  });

  test('a free_tier_capped row never moves group under any assumption, same as measured', () => {
    const a = compute(DEFAULTS).rows.filter((r) => r.basisKey === 'free_tier_capped');
    assert.ok(a.length > 0, 'expected at least one free_tier_capped row under default settings');
    const b = compute({ ...DEFAULTS, cache: 0.9, residual: 1000, frontier: false, tier: 'heavy' }).rows.filter((r) => r.basisKey === 'free_tier_capped');
    assert.deepEqual(a.map((r) => [r.m.model_id, r.cost]), b.map((r) => [r.m.model_id, r.cost]));
    for (const r of a) assert.equal(r.cost, 0, `${r.m.model_id}: a free row's computed cost must stay $0 regardless of assumptions`);
  });

  describe('free_tier_capped rows are excluded from every "cheapest" superlative (docs/free-models-scoping.md §2B/§4)', () => {
    const { rows } = compute(DEFAULTS);
    const freeIds = new Set(rows.filter((r) => r.basisKey === 'free_tier_capped').map((r) => r.m.model_id));

    test('the dataset actually has a free_tier_capped row to exercise this guard', () => {
      assert.ok(freeIds.size > 0);
    });

    test('calloutHtml() never names a free-tier model, even though its cost ($0) is the global minimum', () => {
      const html = calloutHtml(rows, 200);
      for (const r of rows) if (freeIds.has(r.m.model_id)) assert.doesNotMatch(html, new RegExp(r.m.display_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });

    test('projectTotalHtml() never names a free-tier model either', () => {
      const html = projectTotalHtml(rows, 40);
      for (const r of rows) if (freeIds.has(r.m.model_id)) assert.doesNotMatch(html, new RegExp(r.m.display_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });
  });

  test('gateDelta reports a no-op when nothing moved, and names the top modelled row when it did', () => {
    const before = compute(DEFAULTS).rows;
    const same = gateDelta(before, compute({ ...DEFAULTS, frontier: false }).rows, 'Frontier efficiency off');
    assert.equal(same.moved, false);
    const after = compute({ ...DEFAULTS, cache: 0.5 }).rows;
    const d = gateDelta(before, after, 'Cache 50%');
    assert.equal(d.moved, true);
    const top = after.find((r) => r.basisKey === 'modelled_by_solvency')!;
    assert.ok(d.text.includes(top.m.display_name), `names the top modelled row: ${d.text}`);
  });
});
