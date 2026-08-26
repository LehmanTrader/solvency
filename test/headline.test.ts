/**
 * site/src/lib/headline.ts: the /research + share-copy headline, and its two
 * free-model-coverage guards (docs/free-models-scoping.md §2B/§2C/§7):
 *   - ratio()/fmtX() must never render the literal string "Infinity" when a
 *     $0 price reaches them (the confirmed /research hazard, §2C).
 *   - leaderboard()'s measured/modelled/historical buckets must never admit
 *     an access_tier "free" row, however cheap it computes to be -- that is
 *     what keeps headline()'s cheap/dear selection (the homepage hero,
 *     /research and tweetText()) from ever presenting a rate-capped $0 row
 *     as an unqualified "cheapest," a benchmark the free row was never
 *     measured against.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ratio, fmtX, leaderboard, headline, tweetText } from '../site/src/lib/headline.ts';
import { models } from '../scripts/load.ts';

describe('ratio()/fmtX(): the confirmed §2C Infinity hazard', () => {
  test('ratio(0, y) and ratio(x, 0) never return a usable Infinity -- they return NaN, a labelled sentinel', () => {
    assert.ok(Number.isNaN(ratio(0, 5)));
    assert.ok(Number.isNaN(ratio(5, 0)));
    assert.ok(Number.isNaN(ratio(0, 0)));
  });

  test('fmtX() never emits the literal string "Infinity" for any input, including the raw Infinity value', () => {
    for (const bad of [Infinity, -Infinity, NaN, ratio(0, 5), ratio(5, 0)]) {
      const out = fmtX(bad);
      assert.doesNotMatch(out, /Infinity/i, `fmtX(${bad}) produced "${out}"`);
    }
  });

  test('fmtX() still formats ordinary positive ratios exactly as before', () => {
    assert.equal(fmtX(3), '3.0x');
    assert.equal(fmtX(12), '12x');
    assert.equal(fmtX(ratio(2, 8)), '4.0x');
  });
});

describe('leaderboard(): free-tier rows never enter a superlative bucket', () => {
  test('the dataset has at least one access_tier "free" model, so this guard is actually exercised', () => {
    assert.ok(models.some((m) => m.access_tier === 'free'), 'expected at least one free-tier model in data/models.json');
  });

  test('no row in measured/modelled/historical belongs to an access_tier "free" model', () => {
    const lb = leaderboard('heavy');
    for (const bucket of [lb.measured, lb.modelled, lb.historical]) {
      for (const row of bucket) assert.notEqual(row.m.access_tier, 'free', `${row.m.model_id} leaked into a superlative bucket`);
    }
  });

  test('free rows are ranked separately, by pass rate (cost is uniformly $0 within the group)', () => {
    const { free } = leaderboard('heavy');
    for (const row of free) assert.equal(row.m.access_tier, 'free');
    for (let i = 1; i < free.length; i++) assert.ok(free[i - 1].r.pass_rate >= free[i].r.pass_rate, 'free bucket must be pass-rate descending');
  });

  test('headline()\'s cheap/dear pair is never a free-tier row, even though a free row is $0', () => {
    const h = headline();
    assert.notEqual(h.cheap.m.access_tier, 'free');
    assert.notEqual(h.dear.m.access_tier, 'free');
  });

  test('tweetText() never names a free-tier model as "cheapest"', () => {
    const text = tweetText();
    for (const m of models) {
      if (m.access_tier === 'free') assert.doesNotMatch(text, new RegExp(m.display_name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });
});
