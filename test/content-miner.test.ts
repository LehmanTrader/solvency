/**
 * scripts/content-miner.ts: idempotence (a stale snapshot produces a delta and
 * a draft; re-running against the now-current snapshot produces no new deltas
 * and no duplicate content) and the tone lint that guards every draft before
 * it is written. Runs against the repo's real data/ (read-only, via the same
 * scripts/load.ts every other test uses) but writes only into a throwaway
 * temp queue directory -- it never touches the real queue/ or data/.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runContentMiner, snapshotFrom, toneLint, BANNED_WORDS, cheapestPerClass,
} from '../scripts/content-miner.ts';
import { models } from '../scripts/load.ts';
import type { Model } from '../scripts/types.ts';

describe('content miner: idempotence', () => {
  test('a stale snapshot produces a delta and a draft; the next run on the now-current snapshot finds none', () => {
    const queueRoot = mkdtempSync(join(tmpdir(), 'solvency-miner-'));
    try {
      // "Yesterday's" snapshot: identical to today's real fleet, except one
      // current model's recorded input price is different -- a genuine,
      // detectable price-move delta, without ever writing to data/.
      const stale = snapshotFrom(models);
      const target = models.find((m) => m.status === 'current');
      assert.ok(target, 'expected at least one current model in data/models.json');
      stale.models[target!.model_id] = {
        ...stale.models[target!.model_id],
        input_per_mtok: stale.models[target!.model_id].input_per_mtok * 2 + 1,
      };
      const stateFile = join(queueRoot, '_state', 'content-miner-last.json');
      mkdirSync(join(queueRoot, '_state'), { recursive: true });
      writeFileSync(stateFile, JSON.stringify(stale, null, 2));

      const run1 = runContentMiner({ queueRoot, today: '2099-01-01', ensureCard: () => null });
      assert.equal(run1.wrote, true);
      assert.ok(run1.draftCount >= 1, 'expected the seeded price delta to produce at least one draft');
      const body1 = readFileSync(run1.path, 'utf8');
      assert.match(body1, /^---\ngenerated_by: scripts\/content-miner\.ts\nrun_at: .+\nregenerate_with: npm run queue:miner\n---\n/);
      assert.match(body1, /source: data\/models\.json/);
      assert.doesNotMatch(body1, /no new deltas/);

      // Second run: the snapshot written by run 1 now matches the real,
      // unchanged fleet exactly -- there is nothing left to diff.
      const run2 = runContentMiner({ queueRoot, today: '2099-01-01', ensureCard: () => null });
      assert.equal(run2.draftCount, 0);
      assert.equal(run2.skippedReason, 'no-deltas');
      const body2 = readFileSync(run2.path, 'utf8');
      assert.match(body2, /no new deltas -- skipped/);
      // Overwritten, not appended: run 1's draft content must not survive into run 2's file.
      assert.doesNotMatch(body2, new RegExp(target!.model_id));

      // A third run confirms the state is stable, not oscillating.
      const run3 = runContentMiner({ queueRoot, today: '2099-01-01', ensureCard: () => null });
      assert.equal(run3.draftCount, 0);
    } finally {
      rmSync(queueRoot, { recursive: true, force: true });
    }
  });

  test('the very first run ever (no snapshot at all) establishes a baseline and never force-drafts the whole fleet', () => {
    const queueRoot = mkdtempSync(join(tmpdir(), 'solvency-miner-bootstrap-'));
    try {
      const result = runContentMiner({ queueRoot, today: '2099-01-02', ensureCard: () => null });
      assert.equal(result.draftCount, 0);
      assert.equal(result.skippedReason, 'bootstrap');
      const body = readFileSync(result.path, 'utf8');
      assert.match(body, /no new deltas -- skipped/);
    } finally {
      rmSync(queueRoot, { recursive: true, force: true });
    }
  });
});

describe('cheapestPerClass(): free-tier rows never win a class (docs/free-models-scoping.md §2B/§7 item 5)', () => {
  test('the real fleet has at least one free row cheaper by input_per_mtok than every paid row in its class, and it still does not win', () => {
    const free = models.filter((m) => m.access_tier === 'free' && m.status === 'current');
    assert.ok(free.length > 0, 'expected at least one current free-tier model in data/models.json');
    const result = cheapestPerClass(models);
    for (const [cls, id] of Object.entries(result)) {
      const winner = models.find((m) => m.model_id === id);
      assert.notEqual(winner?.access_tier, 'free', `class "${cls}" was won by free-tier model ${id}`);
    }
  });

  test('fixture: a free ($0) model strictly cheaper than every paid model in its class is still excluded from the result', () => {
    const paid: Model = {
      model_id: 'fixture-paid', provider: 'fixture', display_name: 'Fixture Paid', status: 'current',
      capability_class: 'small', input_per_mtok: 5, output_per_mtok: 10, cached_input_per_mtok: null,
      context_window: null, source_url: 'https://example.com', last_verified: '2026-08-26', pricing_notes: null,
    };
    const free: Model = {
      ...paid, model_id: 'fixture-free', display_name: 'Fixture Free',
      input_per_mtok: 0, output_per_mtok: 0, cached_input_per_mtok: 0, access_tier: 'free',
    };
    const out = cheapestPerClass([paid, free]);
    assert.equal(out.small, paid.model_id, 'the $0 free row must never win, even when it is the only candidate cheaper than the paid one');
  });
});

describe('content miner: tone lint', () => {
  test('rejects every banned word (case-insensitive) and exclamation points', () => {
    for (const word of BANNED_WORDS) {
      assert.ok(toneLint(`This is a ${word} moment.`).length > 0, `expected "${word}" to be flagged`);
      assert.ok(toneLint(`THIS IS A ${word.toUpperCase()} MOMENT.`).length > 0, `expected uppercase "${word}" to be flagged`);
    }
    assert.ok(toneLint('Prices dropped today!').length > 0, 'expected the exclamation point to be flagged');
  });

  test('passes a clean, number-first draft through untouched', () => {
    const clean = '$2/M in, $10/M out: Claude Sonnet 5 is now tracked -- 16 current models in Solvency\'s set.\nsource: data/models.json · input_per_mtok/output_per_mtok · verified 2026-08-21';
    assert.deepEqual(toneLint(clean), []);
  });

  test('every generated draft in a real delta run passes its own tone lint (belt-and-suspenders on the templates themselves)', () => {
    const queueRoot = mkdtempSync(join(tmpdir(), 'solvency-miner-lint-'));
    try {
      const stale = snapshotFrom(models);
      const target = models.find((m) => m.status === 'current');
      stale.models[target!.model_id] = {
        ...stale.models[target!.model_id],
        input_per_mtok: stale.models[target!.model_id].input_per_mtok * 3 + 1,
      };
      mkdirSync(join(queueRoot, '_state'), { recursive: true });
      writeFileSync(join(queueRoot, '_state', 'content-miner-last.json'), JSON.stringify(stale, null, 2));

      const result = runContentMiner({ queueRoot, today: '2099-01-03', ensureCard: () => null });
      assert.ok(result.draftCount >= 1);
      const body = readFileSync(result.path, 'utf8');
      for (const word of BANNED_WORDS) assert.doesNotMatch(body, new RegExp(word, 'i'));
      assert.doesNotMatch(body.replace(/^---[\s\S]*?---\n/, ''), /!/);
    } finally {
      rmSync(queueRoot, { recursive: true, force: true });
    }
  });
});
