/**
 * Staleness guard for the per-page social stat cards (scripts/og-cards.ts,
 * reports/og-cards/*.png — the committed source; site/public/og/cards/ is a
 * gitignored build-time mirror synced in by site/scripts/sync-assets.mjs,
 * same pattern as reports/charts/ -> site/public/charts/). The homepage,
 * model and research-note cards embed numbers that drift with
 * data/models.json; this test re-derives every embedded figure from the same
 * live sources the generator uses and fails loudly if the committed
 * manifest.json — and therefore the committed PNGs — has drifted from the
 * data. `npm run og:cards` regenerates both.
 *
 * Redesign stage 3 (docs/redesign-2026-08/direction.md §7): every DEFAULT
 * card (home, model-<id>, note-NN) moved from the old dark flat "big number
 * + claim" template to the cream/purple ranked-leaderboard grammar, so
 * noteCardData/homeCardData/modelCardData now return RankedCardData (a
 * headline + a ranked row list), not the old CardData (a headline number +
 * a claim sentence). This test moved with them.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, allReportFrontmatter, noteCardData, homeCardData, currentModels, modelCardData,
} from '../scripts/og-card-data.ts';
import { leaderboard } from '../site/src/lib/headline.ts';

const CARDS_DIR = join(ROOT, 'reports', 'og-cards');
const MANIFEST_PATH = join(CARDS_DIR, 'manifest.json');

describe('og cards: manifest matches the live data', () => {
  test('manifest.json exists (run `npm run og:cards` if this fails)', () => {
    assert.ok(existsSync(MANIFEST_PATH), 'reports/og-cards/manifest.json is missing — run npm run og:cards');
  });

  const manifest = existsSync(MANIFEST_PATH)
    ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    : { cards: {} };
  const cards: Record<string, any> = manifest.cards ?? {};

  /** Shared assertions for any RankedCardData entry: same headline, row set and footers as a freshly computed one. */
  function assertRankedCardMatches(key: string, got: any, expected: any) {
    assert.ok(got, `manifest is missing card "${key}"`);
    assert.equal(got.eyebrow, expected.eyebrow, `${key}: eyebrow is stale`);
    assert.equal(got.headlinePrefix, expected.headlinePrefix, `${key}: headlinePrefix is stale`);
    assert.equal(got.headlineHighlight, expected.headlineHighlight, `${key}: headlineHighlight is stale`);
    assert.equal(got.headlineSuffix, expected.headlineSuffix, `${key}: headlineSuffix is stale`);
    assert.equal(got.sourceLine, expected.sourceLine, `${key}: sourceLine is stale`);
    assert.equal(got.noteLine, expected.noteLine, `${key}: noteLine is stale`);
    assert.deepEqual(got.rows, expected.rows, `${key}: rows are stale`);
    assert.equal(got.barMax, expected.barMax, `${key}: barMax is stale`);
    assert.deepEqual(got.raw, expected.raw, `${key}: raw is stale`);
    assert.ok(existsSync(join(CARDS_DIR, `${key}.png`)), `${key}.png is missing from reports/og-cards/`);
  }

  test('every note card matches its report frontmatter, freshly re-parsed', () => {
    const notes = allReportFrontmatter();
    assert.ok(notes.length > 0, 'expected at least one research note');
    for (const fm of notes) {
      const expected = noteCardData(fm);
      assertRankedCardMatches(expected.key, cards[expected.key], expected);
    }
  });

  test('the homepage card matches the measured leaderboard computed now', () => {
    const expected = homeCardData();
    assertRankedCardMatches('home', cards.home, expected);
    // Cross-check against the engine directly, not just against the generator's
    // own function. The card excerpts the cheapest 9 when the measured set
    // outgrows the 630px canvas (measuredCostRows CARD_MAX_ROWS) and records
    // the full set in raw.allModelIds — both sides are pinned here.
    const { measured } = leaderboard('heavy');
    assert.equal(expected.rows.length, Math.min(9, measured.length), 'home: shown rows disagree with the capped excerpt of leaderboard(\'heavy\').measured');
    assert.deepEqual(expected.raw.allModelIds, measured.map((r: any) => r.m.model_id), 'home: full measured set disagrees with leaderboard(\'heavy\').measured computed here');
    assert.equal(expected.rows[0].id, measured[0].m.model_id, 'home: #1 row disagrees with leaderboard(\'heavy\').measured computed here');
  });

  test('every current model has a card, and each matches modelCardData() computed now', () => {
    const models = currentModels();
    assert.ok(models.length > 0, 'expected at least one current model');
    const manifestModelKeys = Object.keys(cards).filter((k) => k.startsWith('model-'));
    assert.equal(
      manifestModelKeys.length, models.length,
      `manifest has ${manifestModelKeys.length} model cards but data/models.json has ${models.length} current models`,
    );
    for (const m of models) {
      const expected = modelCardData(m);
      assertRankedCardMatches(expected.key, cards[expected.key], expected);
      // The card's own row set must actually contain the model it is about, marked lead.
      const mine = expected.rows.find((r: any) => r.id === m.model_id);
      assert.ok(mine, `${expected.key}: card does not include a row for its own subject model`);
      assert.equal(mine.lead, true, `${expected.key}: subject model's row is not marked lead`);
    }
  });

  test('no card\'s own subject is a model that is no longer current, or a stale model id', () => {
    const currentIds = new Set(currentModels().map((m: any) => m.model_id));
    for (const [key, card] of Object.entries(cards)) {
      if (!key.startsWith('model-')) continue;
      const id = (card as any).raw?.modelId;
      assert.ok(id && currentIds.has(id), `${key}: model id "${id}" is missing or not a current model`);
    }
  });
});
