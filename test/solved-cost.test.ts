import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { costPerAttempt, costPerSolvedTask, effectiveLoops, defaultOptions } from '../scripts/solved-cost.ts';
import { models, results, modelById, tiers, assumptions, bestResultFor, extrasFor, sourceFor, sources, TIER_NAMES } from '../scripts/load.ts';
import type { Model } from '../scripts/types.ts';

const opts = defaultOptions(assumptions);
const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ~= ${b}`);

describe('cost per attempt', () => {
  test('hand-computed: gpt-5 on heavy tier', () => {
    const m = modelById('gpt-5')!;
    const c = costPerAttempt(m, 'heavy', tiers.heavy, opts);
    // 25 default loops x 0.6 frontier multiplier = 15 loops
    // input  15 x 30_000 = 450_000 tok @ $1.25/Mtok = $0.5625
    // output 15 x  6_000 =  90_000 tok @ $10.00/Mtok = $0.9000
    assert.equal(c.value!.loops, 15);
    assert.equal(c.value!.inputTokens, 450_000);
    assert.equal(c.value!.outputTokens, 90_000);
    near(c.value!.costUsd, 1.4625);
  });

  test('hand-computed: gpt-4.1 (small class) on light tier gets no efficiency discount', () => {
    const m = modelById('gpt-4.1')!;
    const c = costPerAttempt(m, 'light', tiers.light, opts);
    assert.equal(c.value!.loops, 2);
    near(c.value!.costUsd, 0.044); // 10k @ $2 + 3k @ $8
  });

  test('frontier efficiency applies only to frontier models, and only where the multiplier is not 1', () => {
    const frontier = modelById('gpt-5')!;
    const small = modelById('gpt-4.1')!;
    assert.equal(effectiveLoops(frontier, 'heavy', tiers.heavy, opts), 25 * 0.6);
    assert.equal(effectiveLoops(small, 'heavy', tiers.heavy, opts), 25);
    // light/moderate multipliers are 1.0, so both classes match there
    assert.equal(effectiveLoops(frontier, 'light', tiers.light, opts), 2);
    assert.equal(effectiveLoops(small, 'light', tiers.light, opts), 2);
  });

  test('setting the frontier multiplier to 1.0 removes the assumption entirely', () => {
    const neutral = { ...opts, frontierEfficiency: { ...opts.frontierEfficiency, multipliers_by_tier: { light: 1, moderate: 1, heavy: 1 } } };
    const m = modelById('gpt-5')!;
    assert.equal(effectiveLoops(m, 'heavy', tiers.heavy, neutral), 25);
    const withA = costPerAttempt(m, 'heavy', tiers.heavy, opts).value!.costUsd;
    const withoutA = costPerAttempt(m, 'heavy', tiers.heavy, neutral).value!.costUsd;
    near(withoutA / withA, 1 / 0.6, 1e-9);
  });

  test('prompt caching lowers cost, and is refused when no cached price is published', () => {
    const cached = { ...opts, cacheHitFraction: 0.9 };
    const priced = costPerAttempt(modelById('gpt-5')!, 'moderate', tiers.moderate, cached);
    assert.ok(priced.value!.costUsd < costPerAttempt(modelById('gpt-5')!, 'moderate', tiers.moderate, opts).value!.costUsd);

    const unpriced = costPerAttempt(modelById('o3-pro')!, 'moderate', tiers.moderate, cached);
    assert.equal(unpriced.value, null, 'must not silently treat a missing cache price as $0');
    assert.match(unpriced.missing[0], /no published cached-input price/);
  });
});

describe('cost per solved task', () => {
  const m = () => modelById('gpt-5')!;

  test('naive variant is exactly cost / pass_rate', () => {
    const r = costPerSolvedTask(m(), 'heavy', tiers.heavy, 0.88, opts);
    near(r.value!.naive, 1.4625 / 0.88);
  });

  test('with residual cost $0 the truncated-geometric variant reduces exactly to naive', () => {
    // E[attempts] = (1-(1-p)^K)/p, and dividing by P(solved) = 1-(1-p)^K
    // cancels the truncation term. This is a property, not a coincidence.
    for (const p of [0.1, 0.3, 0.524, 0.72, 0.88]) {
      const r = costPerSolvedTask(m(), 'moderate', tiers.moderate, p, opts);
      near(r.value!.truncatedGeometric, r.value!.naive, 1e-9);
    }
  });

  test('the capped variant UNDERSTATES cost for low pass rates -- the brief formula flatters weak models', () => {
    const low = costPerSolvedTask(m(), 'moderate', tiers.moderate, 0.2, opts);
    assert.ok(low.value!.capped < low.value!.naive,
      'min(1/p, 3) truncates the retry tail without charging for unsolved tasks');
    near(low.value!.expectedAttemptsCapped, 3); // 1/0.2 = 5, capped to 3
    // High pass rate: cap never binds, so the two agree.
    const high = costPerSolvedTask(m(), 'moderate', tiers.moderate, 0.88, opts);
    near(high.value!.capped, high.value!.naive, 1e-9);
  });

  test('a non-zero residual human cost restores the penalty the cap removed', () => {
    const withResidual = { ...opts, residualHumanCostUsd: 200 };
    const a = costPerSolvedTask(m(), 'moderate', tiers.moderate, 0.2, opts).value!.capped;
    const b = costPerSolvedTask(m(), 'moderate', tiers.moderate, 0.2, withResidual).value!.capped;
    // P(fail 3x) at p=0.2 is 0.8^3 = 0.512, so residual adds 0.512 * $200
    near(b - a, 0.512 * 200, 1e-9);
  });

  test('missing pass rate yields null with a reason, never zero and never a guess', () => {
    const r = costPerSolvedTask(modelById('claude-opus-5')!, 'heavy', tiers.heavy, null, opts);
    assert.equal(r.value, null);
    assert.match(r.missing.join(' '), /no published pass rate/);
  });

  test('out-of-range pass rates are rejected rather than clamped', () => {
    for (const bad of [0, -0.1, 1.5]) {
      assert.equal(costPerSolvedTask(m(), 'light', tiers.light, bad, opts).value, null);
    }
  });

  test('every computed figure carries provenance', () => {
    const r = costPerSolvedTask(m(), 'heavy', tiers.heavy, 0.88, opts, { passRateProvenance: { source_url: 'https://aider.chat/docs/leaderboards/', last_verified: '2026-08-21' } });
    assert.ok(r.provenance.length >= 2);
    for (const p of r.provenance) {
      assert.match(p.source_url, /^https:\/\//);
      assert.match(p.last_verified, /^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('measured cost supersedes the loop model', () => {
  const m = () => modelById('claude-opus-5')!;

  test('a measured attempt cost replaces the modelled one outright', () => {
    const out = costPerSolvedTask(m(), 'heavy', tiers.heavy, 0.68, opts, { measuredAttemptCostUsd: 8.17 });
    assert.equal(out.value!.costBasis, 'measured_by_source');
    near(out.value!.attempt.costUsd, 8.17);
    near(out.value!.naive, 8.17 / 0.68);
  });

  test('the frontier-efficiency assumption cannot touch a measured row', () => {
    const neutral = { ...opts, frontierEfficiency: { ...opts.frontierEfficiency, multipliers_by_tier: { light: 1, moderate: 1, heavy: 1 } } };
    const a = costPerSolvedTask(m(), 'heavy', tiers.heavy, 0.68, opts, { measuredAttemptCostUsd: 8.17 });
    const b = costPerSolvedTask(m(), 'heavy', tiers.heavy, 0.68, neutral, { measuredAttemptCostUsd: 8.17 });
    assert.equal(a.value!.naive, b.value!.naive, 'changing an assumption must not move a measured number');
  });

  test('the task tier cannot move a measured row either', () => {
    const vals = TIER_NAMES.map((t) => costPerSolvedTask(m(), t, tiers[t], 0.68, opts, { measuredAttemptCostUsd: 8.17 }).value!.naive);
    assert.equal(new Set(vals).size, 1, 'a measured per-task cost is not a function of Solvency task tiers');
  });

  test('rows without a measured cost still report the modelled basis', () => {
    const out = costPerSolvedTask(m(), 'heavy', tiers.heavy, 0.68, opts);
    assert.equal(out.value!.costBasis, 'modelled_by_solvency');
  });

  test('measured and modelled figures for the same model genuinely differ', () => {
    // Guards against a refactor that silently makes the bypass a no-op.
    const meas = costPerSolvedTask(m(), 'heavy', tiers.heavy, 0.68, opts, { measuredAttemptCostUsd: 8.17 }).value!.naive;
    const mod = costPerSolvedTask(m(), 'heavy', tiers.heavy, 0.68, opts).value!.naive;
    assert.ok(Math.abs(meas - mod) > 1, `measured ${meas} vs modelled ${mod}`);
  });
});

describe('data integrity', () => {
  test('every model row has a source URL and a last_verified date', () => {
    for (const m of models as Model[]) {
      assert.match(m.source_url, /^https:\/\//, `${m.model_id} source_url`);
      assert.match(m.last_verified, /^\d{4}-\d{2}-\d{2}$/, `${m.model_id} last_verified`);
    }
  });

  test('prices are positive numbers; absent cache prices are null, never 0', () => {
    for (const m of models as Model[]) {
      assert.ok(m.input_per_mtok > 0 && m.output_per_mtok > 0, m.model_id);
      assert.ok(m.cached_input_per_mtok === null || m.cached_input_per_mtok > 0,
        `${m.model_id}: a missing cache price must be null, not 0`);
      assert.ok(m.context_window === null || m.context_window > 0, m.model_id);
    }
  });

  test('every benchmark row has a valid pass rate, source and run date', () => {
    for (const r of results) {
      assert.ok(r.pass_rate > 0 && r.pass_rate <= 1, r.entry_label);
      assert.match(r.source_url, /^https:\/\//, r.entry_label);
      assert.match(r.run_date, /^\d{4}-\d{2}-\d{2}$/, r.entry_label);
      assert.equal(r.tasks_n, sourceFor(r.benchmark)!.tasks_n,
        `${r.entry_label}: tasks_n must match its source's declared task count`);
    }
  });

  test('where a source published a total cost, cost_per_task is consistent with it', () => {
    const withTotals = results.filter((r) => r.total_cost_usd !== undefined);
    assert.ok(withTotals.length > 0, 'expected at least one row carrying a published total cost');
    for (const r of withTotals) near(r.cost_per_task!, r.total_cost_usd! / r.tasks_n, 1e-5);
  });

  test('historical costs are never presented as current, and measured costs never as modelled', () => {
    for (const r of results) {
      if (r.cost_basis === 'historical_at_run_date') {
        assert.ok(r.run_date < '2026-01-01',
          `${r.entry_label}: a historical cost basis implies an older run_date`);
      }
      if (r.cost_basis === 'modelled_by_solvency') {
        assert.equal(r.measured_cost_per_task_usd, undefined,
          `${r.entry_label}: a modelled row must not carry a measured cost`);
      }
    }
  });

  test('unmatched benchmark rows explain why they are unmatched', () => {
    for (const r of results.filter((x) => x.model_id === null)) {
      assert.ok(r.unmatched_reason && r.unmatched_reason.length > 20, r.entry_label);
    }
  });

  test('every benchmark model_id resolves to a priced model', () => {
    for (const r of results.filter((x) => x.model_id !== null)) {
      assert.ok(modelById(r.model_id!), `${r.entry_label} -> unknown model ${r.model_id}`);
    }
  });

  test('every modelled assumption is labelled as an assumption with provenance', () => {
    for (const [name, t] of Object.entries(tiers)) {
      assert.equal((t as any).kind, 'assumption', name);
      assert.match((t as any).provenance_url, /^https:\/\//, name);
    }
    assert.equal(assumptions.frontier_efficiency.kind, 'assumption');
    assert.equal(assumptions.retry_model.kind, 'assumption');
    assert.equal(assumptions.cache_hit_fraction.kind, 'assumption');
  });

  test('every benchmark row is marked non-redistributable (third-party, cite-only)', () => {
    for (const r of results) {
      assert.equal(r.redistributable, false,
        `${r.entry_label}: ingested third-party data must never enter the CC-BY export`);
    }
    for (const s of sources) assert.equal(s.redistributable, false, s.name);
  });

  test('every row declares a cost basis, and measured rows carry a measured cost', () => {
    const valid = ['measured_by_source', 'modelled_by_solvency', 'historical_at_run_date'];
    for (const r of results) {
      assert.ok(valid.includes(r.cost_basis), `${r.entry_label}: ${r.cost_basis}`);
      if (r.cost_basis === 'measured_by_source') {
        assert.equal(typeof r.measured_cost_per_task_usd, 'number', r.entry_label);
        assert.ok(r.measured_cost_per_task_usd! > 0, r.entry_label);
      }
    }
  });

  test('derived pass rates disclose their derivation', () => {
    for (const r of results.filter((x) => x.index_score !== undefined)) {
      assert.ok(r.pass_rate_derivation, `${r.entry_label} derives pass_rate but does not say how`);
      assert.equal(r.pass_rate, r.index_score! / 100, r.entry_label);
    }
  });

  test('approximate model matches are flagged, not silently joined', () => {
    const approx = results.filter((r) => r.match_confidence === 'approximate');
    for (const r of approx) assert.ok(r.match_note && r.match_note.length > 40, r.entry_label);
  });

  test('every source records how and when it was verified, plus attribution', () => {
    for (const s of sources) {
      assert.match(s.source_url, /^https:\/\//, s.name);
      assert.match(s.last_verified, /^\d{4}-\d{2}-\d{2}$/, s.name);
      assert.ok(s.attribution && s.attribution.length > 5, s.name);
      assert.ok(Array.isArray(s.caveats) && s.caveats.length > 0, `${s.name} states no caveats`);
    }
  });

  test('the engine produces a finite number for every joinable model, on its own basis', () => {
    let measured = 0, modelled = 0;
    for (const m of models as Model[]) {
      const r = bestResultFor(m.model_id);
      if (!r) continue;
      const out = costPerSolvedTask(m, 'heavy', tiers.heavy, r.pass_rate, opts, extrasFor(r));
      assert.ok(out.value !== null && Number.isFinite(out.value.naive), m.model_id);
      if (out.value!.costBasis === 'measured_by_source') measured++; else modelled++;
    }
    assert.ok(measured >= 6, `expected at least 6 measured rows, got ${measured}`);
    assert.ok(modelled >= 10, `expected at least 10 modelled rows, got ${modelled}`);
  });
});
