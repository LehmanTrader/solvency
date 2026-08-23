import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compute, DEFAULTS, GROUPS, gateDelta, type Settings } from '../site/src/lib/calc.ts';

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

  test('a model with no cached-input price stays in its group, computed uncached and annotated', () => {
    const { rows } = compute({ ...DEFAULTS, cache: 0.5 });
    const flagged = rows.filter((r) => r.uncached);
    assert.ok(flagged.length >= 1, 'the dataset has at least one model without a cached price');
    for (const r of flagged) {
      assert.equal(r.m.cached_input_per_mtok, null);
      const at0 = compute(DEFAULTS).rows.find((x) => x.m.model_id === r.m.model_id)!;
      assert.equal(r.cost, at0.cost, 'computed at the uncached price');
    }
    for (const r of rows.filter((r) => !r.uncached && r.basisKey !== 'measured_by_source'))
      assert.notEqual(r.m.cached_input_per_mtok, null);
  });

  test('measured rows never move under any assumption', () => {
    const a = compute(DEFAULTS).rows.filter((r) => r.basisKey === 'measured_by_source');
    const b = compute({ ...DEFAULTS, cache: 0.9, residual: 1000, frontier: false, tier: 'heavy' }).rows.filter((r) => r.basisKey === 'measured_by_source');
    assert.deepEqual(a.map((r) => [r.m.model_id, r.cost]), b.map((r) => [r.m.model_id, r.cost]));
  });

  test('GROUPS are the three bases, measured first', () => {
    assert.deepEqual(GROUPS.map((g) => g.basis), ['measured', 'modelled', 'stale']);
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
