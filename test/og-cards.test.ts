/**
 * Staleness guard for the per-page social stat cards (scripts/og-cards.ts,
 * reports/og-cards/*.png — the committed source; site/public/og/cards/ is a
 * gitignored build-time mirror synced in by site/scripts/sync-assets.mjs,
 * same pattern as reports/charts/ -> site/public/charts/). The homepage and
 * model cards embed numbers that drift with data/models.json; this test
 * re-derives every embedded figure from the same live sources the generator
 * uses and fails loudly if the committed manifest.json — and therefore the
 * committed PNGs — has drifted from the data. `npm run og:cards` regenerates
 * both.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, allReportFrontmatter, noteCardData, homeCardData, currentModels, modelCardData,
} from '../scripts/og-card-data.ts';
import { headline, fmtX, money, solvedFor } from '../site/src/lib/headline.ts';

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

  test('every note card matches its report frontmatter, freshly re-parsed', () => {
    const notes = allReportFrontmatter();
    assert.ok(notes.length > 0, 'expected at least one research note');
    for (const fm of notes) {
      const expected = noteCardData(fm);
      const got = cards[expected.key];
      assert.ok(got, `manifest is missing card "${expected.key}" for research note ${fm.note}`);
      assert.equal(got.number, expected.number, `${expected.key}: number is stale`);
      assert.equal(got.claim, expected.claim, `${expected.key}: claim is stale`);
      assert.equal(got.attribution, expected.attribution, `${expected.key}: attribution is stale`);
      assert.ok(
        existsSync(join(CARDS_DIR, `${expected.key}.png`)),
        `${expected.key}.png is missing from reports/og-cards/`,
      );
    }
  });

  test('the homepage card matches headline() computed now', () => {
    const expected = homeCardData();
    const got = cards.home;
    assert.ok(got, 'manifest is missing the "home" card');
    assert.equal(got.number, expected.number, 'home: headline multiplier is stale');
    assert.equal(got.claim, expected.claim, 'home: claim is stale');
    assert.equal(got.attribution, expected.attribution, 'home: attribution is stale');
    assert.equal(got.raw.cheapId, expected.raw.cheapId, 'home: cheapest model in the headline changed');
    assert.equal(got.raw.dearId, expected.raw.dearId, 'home: reference model in the headline changed');
    assert.equal(got.raw.solvedX, expected.raw.solvedX, 'home: raw multiplier is stale');
    assert.ok(existsSync(join(CARDS_DIR, 'home.png')), 'home.png is missing from reports/og-cards/');
    // Cross-check against the engine directly, not just against the generator's own function.
    const h = headline();
    assert.equal(got.number, fmtX(h.solvedX), 'home: number disagrees with headline() computed here');
  });

  test('every current model has a card, and each matches solvedFor() computed now', () => {
    const models = currentModels();
    assert.ok(models.length > 0, 'expected at least one current model');
    const manifestModelKeys = Object.keys(cards).filter((k) => k.startsWith('model-'));
    assert.equal(
      manifestModelKeys.length, models.length,
      `manifest has ${manifestModelKeys.length} model cards but data/models.json has ${models.length} current models`,
    );
    for (const m of models) {
      const expected = modelCardData(m);
      const got = cards[expected.key];
      assert.ok(got, `manifest is missing card "${expected.key}" for current model ${m.model_id}`);
      assert.equal(got.number, expected.number, `${expected.key}: number is stale`);
      assert.equal(got.claim, expected.claim, `${expected.key}: claim (display name) is stale`);
      assert.equal(got.attribution, expected.attribution, `${expected.key}: attribution is stale`);
      assert.equal(got.raw.cost, expected.raw.cost, `${expected.key}: raw cost is stale`);
      assert.equal(got.raw.basisKey, expected.raw.basisKey, `${expected.key}: cost basis is stale`);
      assert.ok(
        existsSync(join(CARDS_DIR, `${expected.key}.png`)),
        `${expected.key}.png is missing from reports/og-cards/`,
      );
      // Cross-check against the engine directly.
      const mine = solvedFor(m.model_id, 'heavy');
      const wantNumber = mine ? money(mine.cost) : `$${m.input_per_mtok}/M`;
      assert.equal(got.number, wantNumber, `${expected.key}: number disagrees with solvedFor() computed here`);
    }
  });

  test('no card carries a model that is no longer current, or a stale model id', () => {
    const currentIds = new Set(currentModels().map((m: any) => m.model_id));
    for (const [key, card] of Object.entries(cards)) {
      if (!key.startsWith('model-')) continue;
      const id = (card as any).raw?.modelId;
      assert.ok(id && currentIds.has(id), `${key}: model id "${id}" is missing or not a current model`);
    }
  });
});
