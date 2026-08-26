/**
 * scripts/price-watch-draft.ts: a temporarily wrong price -- in a throwaway
 * fixture data/ directory, never the real one -- is correctly flagged REVIEW
 * by the real, unmodified scripts/watch-prices.ts, and price-watch-draft.ts
 * turns that into a sane checklist + UNCONFIRMED draft. The real
 * data/models.json is asserted byte-for-byte untouched throughout.
 *
 * Network is mocked with a local 127.0.0.1 HTTP server serving canned pricing
 * text -- never a real outbound request.
 *
 * This file deliberately does NOT statically import scripts/load.ts,
 * scripts/watch-prices.ts, or scripts/price-watch-draft.ts: all three pick up
 * SOLVENCY_DATA_DIR at module-load time via scripts/load.ts, so this file sets
 * the env var first and only *dynamically* imports afterward. (See
 * test/price-watch-draft-fetch-failure.test.ts and
 * test/price-watch-draft-no-review.test.ts for the sibling scenarios --
 * each lives in its own file so each gets Node's default per-file test
 * process, since scripts/load.ts caches its data directory for the life of
 * one process.)
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, writeFixtureDataDir } from './price-watch-fixture-helpers.ts';

const REAL_MODELS_PATH = join(import.meta.dirname, '..', 'data', 'models.json');

describe('price-watch-draft: a wrong price is flagged REVIEW, real data untouched', () => {
  test('fixture price differs from the fetched page -> REVIEW, sane checklist, UNCONFIRMED draft, real models.json byte-identical', async () => {
    const beforeReal = readFileSync(REAL_MODELS_PATH, 'utf8');

    // The fetched page shows $3/$40 -- nothing on it matches the fixture's
    // deliberately wrong recorded input price of $999.
    const { server, url } = await startFixtureServer(
      'Our pricing: $3 per million input tokens and $40 per million output tokens.',
    );
    const fixtureDataDir = mkdtempSync(join(tmpdir(), 'solvency-pw-data-'));
    const queueRoot = mkdtempSync(join(tmpdir(), 'solvency-pw-queue-'));

    try {
      writeFixtureDataDir(fixtureDataDir, url, 999);
      process.env.SOLVENCY_DATA_DIR = fixtureDataDir;

      const { runPriceWatchDraft } = await import('../scripts/price-watch-draft.ts');
      const result = await runPriceWatchDraft({ queueRoot, today: '2099-02-01' });

      assert.equal(result.reviewCount, 1, 'expected the single fixture model to be flagged REVIEW');
      assert.equal(result.totalCount, 1);

      const body = readFileSync(result.path, 'utf8');
      assert.match(body, /^---\ngenerated_by: scripts\/price-watch-draft\.ts\nrun_at: .+\nregenerate_with: npm run queue:price-watch\n---\n/);
      assert.match(body, /1 of 1 models flagged/);

      // Sane checklist, verbatim per §6.2.
      assert.match(body, /Open source_url yourself/);
      assert.match(body, /edit data\/models\.json/);
      assert.match(body, /Append a data\/changelog\.json entry matching the existing schema/);
      assert.match(body, /npm run og:cards && npm test/);

      assert.match(body, /fixture-model-1/);
      assert.match(body, /REVIEW/);
      assert.match(body, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(body, /fetched snippet: "[^"]*\$3[^"]*"/, 'expected the mocked page snippet to surface');
      assert.match(body, /UNCONFIRMED -- do not use until the checklist above is done/);
    } finally {
      server.close();
      delete process.env.SOLVENCY_DATA_DIR;
      rmSync(fixtureDataDir, { recursive: true, force: true });
      rmSync(queueRoot, { recursive: true, force: true });
    }

    const afterReal = readFileSync(REAL_MODELS_PATH, 'utf8');
    assert.equal(afterReal, beforeReal, 'the real data/models.json must be byte-for-byte untouched');
  });
});
