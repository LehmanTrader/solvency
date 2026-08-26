/**
 * scripts/price-watch-draft.ts: no REVIEW rows -> a clean, honest file, not a
 * forced draft. Own process/file, see test/price-watch-draft.test.ts's header
 * comment for why.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, writeFixtureDataDir } from './price-watch-fixture-helpers.ts';

const REAL_MODELS_PATH = join(import.meta.dirname, '..', 'data', 'models.json');

describe('price-watch-draft: nothing flagged means nothing forced', () => {
  test('recorded price matches the fetched page -> ok, no draft written', async () => {
    const beforeReal = readFileSync(REAL_MODELS_PATH, 'utf8');
    const { server, url } = await startFixtureServer('List price: $3 per million input tokens and $40 per million output tokens.');
    const fixtureDataDir = mkdtempSync(join(tmpdir(), 'solvency-pw-data-ok-'));
    const queueRoot = mkdtempSync(join(tmpdir(), 'solvency-pw-queue-ok-'));

    try {
      // Recorded price matches what the fetched page shows -> watch-prices.ts says ok.
      writeFixtureDataDir(fixtureDataDir, url, 3);
      process.env.SOLVENCY_DATA_DIR = fixtureDataDir;

      const { runPriceWatchDraft } = await import('../scripts/price-watch-draft.ts');
      const result = await runPriceWatchDraft({ queueRoot, today: '2099-02-03' });

      assert.equal(result.reviewCount, 0);
      const body = readFileSync(result.path, 'utf8');
      assert.match(body, /nothing to confirm tonight/);
      assert.doesNotMatch(body, /UNCONFIRMED/);
    } finally {
      server.close();
      delete process.env.SOLVENCY_DATA_DIR;
      rmSync(fixtureDataDir, { recursive: true, force: true });
      rmSync(queueRoot, { recursive: true, force: true });
    }

    const afterReal = readFileSync(REAL_MODELS_PATH, 'utf8');
    assert.equal(afterReal, beforeReal);
  });
});
