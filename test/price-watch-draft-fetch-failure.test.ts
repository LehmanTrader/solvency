/**
 * scripts/price-watch-draft.ts: fetch failure -> "FETCH FAILED, check
 * manually", never "no change". Own process/file, see
 * test/price-watch-draft.test.ts's header comment for why.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFixtureDataDir } from './price-watch-fixture-helpers.ts';

const REAL_MODELS_PATH = join(import.meta.dirname, '..', 'data', 'models.json');

describe('price-watch-draft: fetch failure is never mistaken for "no change"', () => {
  test('nothing listening on the source_url -> FETCH FAILED, check manually', async () => {
    const beforeReal = readFileSync(REAL_MODELS_PATH, 'utf8');
    const fixtureDataDir = mkdtempSync(join(tmpdir(), 'solvency-pw-data-fail-'));
    const queueRoot = mkdtempSync(join(tmpdir(), 'solvency-pw-queue-fail-'));

    try {
      // Port 1 on loopback: nothing listens there, so both watch-prices.ts's
      // own fetch and price-watch-draft.ts's re-fetch fail deterministically,
      // without reaching the real network.
      writeFixtureDataDir(fixtureDataDir, 'http://127.0.0.1:1/pricing', 999);
      process.env.SOLVENCY_DATA_DIR = fixtureDataDir;

      const { runPriceWatchDraft } = await import('../scripts/price-watch-draft.ts');
      const result = await runPriceWatchDraft({ queueRoot, today: '2099-02-02' });

      assert.equal(result.reviewCount, 1);
      const body = readFileSync(result.path, 'utf8');
      assert.match(body, /FETCH FAILED, check manually/);
      assert.doesNotMatch(body, /no change/i);
    } finally {
      delete process.env.SOLVENCY_DATA_DIR;
      rmSync(fixtureDataDir, { recursive: true, force: true });
      rmSync(queueRoot, { recursive: true, force: true });
    }

    const afterReal = readFileSync(REAL_MODELS_PATH, 'utf8');
    assert.equal(afterReal, beforeReal);
  });
});
