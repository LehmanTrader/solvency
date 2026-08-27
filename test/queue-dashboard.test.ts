/**
 * scripts/queue-dashboard.ts: the md item-parse + item-delete-rewrite
 * round-trip for both real item shapes ("flat" numbered lists and "header"
 * `## N. Title` sections), the path-traversal guard, and the archive move.
 * Every fixture lives under a throwaway temp dir -- this test never touches
 * the real queue/.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  splitFrontmatter, splitTitle, detectItemStyle, splitItemChunks,
  deleteItemFromMarkdown, extractChecklistSteps, parseQueueFile,
  resolveQueueDateDir, resolveQueueFile, PathGuardError,
  listUnarchivedDates, readDateFiles, archiveDate, buildState, buildRunHealth,
  resolveOgCardFile, extractModelPriceHistory, enrichPriceWatchItem,
  listArchivedDates, daysBetweenIso, loadPricingContext,
} from '../scripts/queue-dashboard.ts';

const FLAT_FILE = `---
generated_by: scripts/content-miner.ts
run_at: 2026-08-26T13:24:01.119Z
regenerate_with: npm run queue:miner
---

# Content miner -- 2026-08-26

1. $2/M in, $10/M out: Model One (Acme) is now tracked -- 7 current models in Solvency's set.
source: data/models.json · input_per_mtok/output_per_mtok · verified 2026-08-26
   card: reports/og-cards/model-one.png

2. $3/M -> $4/M input tokens: Model Two's price moved 33.3% since the last check.
source: data/models.json · input_per_mtok · verified 2026-08-26
   card: MISSING -- run \`npm run og:cards\`

3. $1/M input tokens: Model Three is now the cheapest reasoning-class model Solvency tracks (re-derived this run, not carried from memory).
source: data/models.json · input_per_mtok · verified 2026-08-26
   card: reports/og-cards/model-three.png
`;

const HEADER_FILE = `---
generated_by: scripts/price-watch-draft.ts
run_at: 2026-08-26T13:24:13.347Z
regenerate_with: npm run queue:price-watch
---

# Price watch -- 2026-08-26

2 of 16 models flagged by watch-prices.ts. Confirm every one below before touching data/ or using any draft.

## Checklist (do this for each flagged model, in order)

1. Open source_url yourself and check the current price.
2. If it changed: edit data/models.json (the price fields) and bump last_verified.
3. Append a data/changelog.json entry matching the existing schema.
4. Run \`npm run og:cards && npm test\`.

## 1. model-alpha

- watch-prices.ts: REVIEW -- not found on page: input_per_mtok
- recorded: $2/M in, $8/M out · last_verified 2026-08-20
- source_url: https://example.com/alpha
- fetched snippet: "some text near a dollar figure"

UNCONFIRMED -- do not use until the checklist above is done:
"$2/M in, $8/M out -- Model Alpha's listed price may have changed. Verify at https://example.com/alpha before posting anything.
source: data/models.json · input_per_mtok/output_per_mtok · verified 2026-08-20"

## 2. model-beta

- watch-prices.ts: FETCH! -- (watch-prices.ts could not fetch this page)
- recorded: $5/M in, $15/M out · last_verified 2026-08-19
- source_url: https://example.com/beta
- fetched snippet: "FETCH FAILED, check manually"

UNCONFIRMED -- do not use until the checklist above is done:
"$5/M in, $15/M out -- Model Beta's listed price may have changed. Verify at https://example.com/beta before posting anything.
source: data/models.json · input_per_mtok/output_per_mtok · verified 2026-08-19"
`;

const PROSE_ONLY_FILE = `---
generated_by: scripts/content-miner.ts
run_at: 2026-08-26T13:24:01.119Z
regenerate_with: npm run queue:miner
---

# Content miner -- 2026-08-26

no new deltas -- skipped.
`;

function tmpQueue(): string {
  return mkdtempSync(join(tmpdir(), 'solvency-dash-'));
}

describe('splitFrontmatter', () => {
  test('preserves the frontmatter block byte-for-byte and separates the body', () => {
    const { frontmatterRaw, meta, body } = splitFrontmatter(FLAT_FILE);
    assert.equal(meta.generated_by, 'scripts/content-miner.ts');
    assert.equal(meta.regenerate_with, 'npm run queue:miner');
    assert.ok(frontmatterRaw.startsWith('---\n'));
    assert.ok(body.trim().startsWith('# Content miner')); // frontmatter leaves one blank line ahead of the body, by design
    assert.equal(frontmatterRaw + body, FLAT_FILE);
  });

  test('a file with no frontmatter is treated as all body', () => {
    const { frontmatterRaw, body } = splitFrontmatter('# Just a title\n\nsome text\n');
    assert.equal(frontmatterRaw, '');
    assert.equal(body, '# Just a title\n\nsome text\n');
  });
});

describe('item style detection', () => {
  test('a flat numbered list is detected as flat', () => {
    const { body } = splitFrontmatter(FLAT_FILE);
    const { rest } = splitTitle(body);
    assert.equal(detectItemStyle(rest), 'flat');
  });

  test('## N. Title sections are detected as header, even with nested numbered sub-lists', () => {
    const { body } = splitFrontmatter(HEADER_FILE);
    const { rest } = splitTitle(body);
    assert.equal(detectItemStyle(rest), 'header');
    // The checklist's own "1. Open source_url..." plain numbered list must
    // NOT be mistaken for an item boundary -- exactly 2 header items expected.
    const chunks = splitItemChunks(rest, 'header');
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].n, 1);
    assert.equal(chunks[1].n, 2);
  });

  test('a pure-prose "no new deltas" file has no items', () => {
    const { body } = splitFrontmatter(PROSE_ONLY_FILE);
    const { rest } = splitTitle(body);
    assert.equal(detectItemStyle(rest), 'none');
    assert.deepEqual(splitItemChunks(rest, 'none'), []);
  });
});

describe('extractChecklistSteps', () => {
  test('pulls the 4 shared steps out of the ## Checklist block, not the header items after it', () => {
    const { body } = splitFrontmatter(HEADER_FILE);
    const { rest } = splitTitle(body);
    const steps = extractChecklistSteps(rest);
    assert.equal(steps.length, 4);
    assert.match(steps[0], /Open source_url yourself/);
    assert.match(steps[3], /npm run og:cards && npm test/);
  });
});

describe('deleteItemFromMarkdown: flat style round-trip', () => {
  test('deleting the middle item renumbers the remaining two to 1 and 2, preserving frontmatter and other text verbatim', () => {
    const next = deleteItemFromMarkdown(FLAT_FILE, 2);
    const { meta, body } = splitFrontmatter(next);
    assert.equal(meta.generated_by, 'scripts/content-miner.ts'); // frontmatter untouched
    assert.doesNotMatch(body, /Model Two/);
    assert.match(body, /Model One/);
    assert.match(body, /Model Three/);
    const { rest } = splitTitle(body);
    const chunks = splitItemChunks(rest, 'flat');
    assert.deepEqual(chunks.map((c) => c.n), [1, 2]);
    assert.match(chunks[1].raw, /^2\. \$1\/M input tokens: Model Three/);
    // source lines travel with their item, unindented as the real script writes them
    assert.match(chunks[0].raw, /source: data\/models\.json/);
  });

  test('deleting the first item leaves item 2 renumbered to 1', () => {
    const next = deleteItemFromMarkdown(FLAT_FILE, 1);
    const { rest } = splitTitle(splitFrontmatter(next).body);
    const chunks = splitItemChunks(rest, 'flat');
    assert.deepEqual(chunks.map((c) => c.n), [1, 2]);
    assert.match(chunks[0].raw, /Model Two/);
  });

  test('deleting the last remaining item leaves a well-formed file with zero items', () => {
    let next = deleteItemFromMarkdown(FLAT_FILE, 1);
    next = deleteItemFromMarkdown(next, 1);
    next = deleteItemFromMarkdown(next, 1);
    const { body } = splitFrontmatter(next);
    const { rest } = splitTitle(body);
    assert.equal(detectItemStyle(rest), 'none');
  });

  test('deleting a non-existent item number throws rather than silently no-opping', () => {
    assert.throws(() => deleteItemFromMarkdown(FLAT_FILE, 99), /item 99 not found/);
  });

  test('deleting from a file with no items throws', () => {
    assert.throws(() => deleteItemFromMarkdown(PROSE_ONLY_FILE, 1), /no numbered items/);
  });
});

describe('deleteItemFromMarkdown: header style round-trip', () => {
  test('deleting header item 1 renumbers item 2 down to 1 and keeps the Checklist section untouched', () => {
    const next = deleteItemFromMarkdown(HEADER_FILE, 1);
    const { body } = splitFrontmatter(next);
    assert.doesNotMatch(body, /model-alpha/);
    assert.match(body, /model-beta/);
    const { rest } = splitTitle(body);
    assert.match(rest, /## Checklist \(do this for each flagged model, in order\)/);
    const chunks = splitItemChunks(rest, 'header');
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].n, 1);
    assert.match(chunks[0].raw, /^## 1\. model-beta/);
    // checklist steps still parse correctly after the rewrite
    assert.equal(extractChecklistSteps(rest).length, 4);
  });
});

describe('parseQueueFile', () => {
  test('derives producer, title, items and a first-line intro for a flat file', () => {
    const f = parseQueueFile(FLAT_FILE, '2026-08-26', 'content-miner.md', 12345);
    assert.equal(f.producer, 'scripts/content-miner.ts');
    assert.equal(f.title, 'Content miner -- 2026-08-26');
    assert.equal(f.itemStyle, 'flat');
    assert.equal(f.items.length, 3);
    assert.equal(f.items[0].sourceLine, 'data/models.json · input_per_mtok/output_per_mtok · verified 2026-08-26');
  });

  test('flags FETCH! / FETCH FAILED items and captures the status badge for header-style files', () => {
    const f = parseQueueFile(HEADER_FILE, '2026-08-26', 'price-watch.md', 12345);
    assert.equal(f.items.length, 2);
    assert.equal(f.items[0].statusBadge, 'REVIEW');
    assert.equal(f.items[0].fetchFailed, false);
    assert.equal(f.items[1].statusBadge, 'FETCH!');
    assert.equal(f.items[1].fetchFailed, true);
    assert.equal(f.checklist.length, 4);
  });

  test('a prose-only file has zero items and a non-empty introText', () => {
    const f = parseQueueFile(PROSE_ONLY_FILE, '2026-08-26', 'content-miner.md', 12345);
    assert.equal(f.items.length, 0);
    assert.match(f.introText, /no new deltas -- skipped/);
  });
});

describe('path traversal guard', () => {
  test('rejects a date that is not a plain yyyy-mm-dd segment', () => {
    const queueRoot = tmpQueue();
    try {
      assert.throws(() => resolveQueueDateDir(queueRoot, '../../etc'), PathGuardError);
      assert.throws(() => resolveQueueDateDir(queueRoot, '2026-08-26/../../etc'), PathGuardError);
      assert.throws(() => resolveQueueDateDir(queueRoot, ''), PathGuardError);
    } finally {
      rmSync(queueRoot, { recursive: true, force: true });
    }
  });

  test('rejects a filename that is not a plain .md basename', () => {
    const queueRoot = tmpQueue();
    try {
      assert.throws(() => resolveQueueFile(queueRoot, '2026-08-26', '../../../etc/passwd'), PathGuardError);
      assert.throws(() => resolveQueueFile(queueRoot, '2026-08-26', 'sub/dir.md'), PathGuardError);
      assert.throws(() => resolveQueueFile(queueRoot, '2026-08-26', 'no-extension'), PathGuardError);
      assert.throws(() => resolveQueueFile(queueRoot, '2026-08-26', '..%2fsecret.md'), PathGuardError);
    } finally {
      rmSync(queueRoot, { recursive: true, force: true });
    }
  });

  test('a legitimate date + filename resolves inside queueRoot', () => {
    const queueRoot = tmpQueue();
    try {
      const abs = resolveQueueFile(queueRoot, '2026-08-26', 'content-miner.md');
      assert.ok(abs.startsWith(queueRoot));
      assert.equal(abs, join(queueRoot, '2026-08-26', 'content-miner.md'));
    } finally {
      rmSync(queueRoot, { recursive: true, force: true });
    }
  });
});

describe('archiveDate', () => {
  test('moves queue/<date> to queue/_archive/<date>, and it disappears from listUnarchivedDates', () => {
    const queueRoot = tmpQueue();
    try {
      const dateDir = join(queueRoot, '2026-08-26');
      mkdirSync(dateDir, { recursive: true });
      writeFileSync(join(dateDir, 'content-miner.md'), FLAT_FILE);

      assert.deepEqual(listUnarchivedDates(queueRoot), ['2026-08-26']);
      archiveDate(queueRoot, '2026-08-26');
      assert.deepEqual(listUnarchivedDates(queueRoot), []);
      assert.ok(existsSync(join(queueRoot, '_archive', '2026-08-26', 'content-miner.md')));
      assert.ok(!existsSync(dateDir));
      // content is preserved exactly, not rewritten by the archive move
      assert.equal(readFileSync(join(queueRoot, '_archive', '2026-08-26', 'content-miner.md'), 'utf8'), FLAT_FILE);
    } finally {
      rmSync(queueRoot, { recursive: true, force: true });
    }
  });

  test('refuses to double-archive the same date', () => {
    const queueRoot = tmpQueue();
    try {
      mkdirSync(join(queueRoot, '2026-08-26'), { recursive: true });
      writeFileSync(join(queueRoot, '2026-08-26', 'content-miner.md'), FLAT_FILE);
      archiveDate(queueRoot, '2026-08-26');
      mkdirSync(join(queueRoot, '2026-08-26'), { recursive: true });
      writeFileSync(join(queueRoot, '2026-08-26', 'content-miner.md'), FLAT_FILE);
      assert.throws(() => archiveDate(queueRoot, '2026-08-26'), /already archived/);
    } finally {
      rmSync(queueRoot, { recursive: true, force: true });
    }
  });

  test('rejects an invalid date argument rather than touching disk', () => {
    const queueRoot = tmpQueue();
    try {
      assert.throws(() => archiveDate(queueRoot, '../../etc'), PathGuardError);
    } finally {
      rmSync(queueRoot, { recursive: true, force: true });
    }
  });

  test('_archive and _state are never listed as an unarchived date', () => {
    const queueRoot = tmpQueue();
    try {
      mkdirSync(join(queueRoot, '_archive'), { recursive: true });
      mkdirSync(join(queueRoot, '_state', 'logs'), { recursive: true });
      mkdirSync(join(queueRoot, '2026-08-26'), { recursive: true });
      writeFileSync(join(queueRoot, '2026-08-26', 'content-miner.md'), FLAT_FILE);
      assert.deepEqual(listUnarchivedDates(queueRoot), ['2026-08-26']);
    } finally {
      rmSync(queueRoot, { recursive: true, force: true });
    }
  });
});

describe('readDateFiles + buildState', () => {
  test('reads every *.md in a date dir and orders dates newest-first', () => {
    const queueRoot = tmpQueue();
    try {
      mkdirSync(join(queueRoot, '2026-08-25'), { recursive: true });
      mkdirSync(join(queueRoot, '2026-08-26'), { recursive: true });
      writeFileSync(join(queueRoot, '2026-08-25', 'content-miner.md'), PROSE_ONLY_FILE);
      writeFileSync(join(queueRoot, '2026-08-26', 'content-miner.md'), FLAT_FILE);
      writeFileSync(join(queueRoot, '2026-08-26', 'price-watch.md'), HEADER_FILE);

      const files = readDateFiles(queueRoot, '2026-08-26');
      assert.equal(files.length, 2);

      const state = buildState(queueRoot);
      assert.equal(state.latestDate, '2026-08-26');
      assert.equal(state.dates.length, 2);
      assert.equal(state.dates[0].date, '2026-08-26');
      assert.equal(state.dates[1].date, '2026-08-25');
      assert.equal(state.isAllClear, false); // real items + a FETCH! flag present
      assert.match(state.summary, /draft/);
      assert.match(state.summary, /price flag/);
    } finally {
      rmSync(queueRoot, { recursive: true, force: true });
    }
  });

  test('an all-clear day (both producers report nothing) produces the calm empty-state summary', () => {
    const queueRoot = tmpQueue();
    try {
      mkdirSync(join(queueRoot, '2026-08-26'), { recursive: true });
      writeFileSync(join(queueRoot, '2026-08-26', 'content-miner.md'), PROSE_ONLY_FILE);
      writeFileSync(
        join(queueRoot, '2026-08-26', 'price-watch.md'),
        PROSE_ONLY_FILE.replace('scripts/content-miner.ts', 'scripts/price-watch-draft.ts').replace('no new deltas -- skipped.', '0 of 16 models flagged by watch-prices.ts -- nothing to confirm tonight.'),
      );
      const state = buildState(queueRoot);
      assert.equal(state.isAllClear, true);
      assert.match(state.summary, /Nothing overnight needs you/);
    } finally {
      rmSync(queueRoot, { recursive: true, force: true });
    }
  });
});

describe('buildRunHealth', () => {
  test('falls back to the queue file frontmatter run_at when no log exists yet', () => {
    const queueRoot = tmpQueue();
    try {
      mkdirSync(join(queueRoot, '2026-08-26'), { recursive: true });
      const files = [parseQueueFile(FLAT_FILE, '2026-08-26', 'content-miner.md', 1)];
      const health = buildRunHealth(queueRoot, '2026-08-26', files);
      const cm = health.find((h) => h.id === 'content-miner')!;
      assert.equal(cm.source, 'queue-file');
      assert.equal(cm.lastRunAt, '2026-08-26T13:24:01.119Z');
      assert.equal(cm.fetchFailed, false);
      const pw = health.find((h) => h.id === 'price-watch')!;
      assert.equal(pw.source, 'none'); // no price-watch.md in `files`, no log either
    } finally {
      rmSync(queueRoot, { recursive: true, force: true });
    }
  });

  test('prefers the log file over the queue file when a log exists, and flags FETCH FAILED from its tail', () => {
    const queueRoot = tmpQueue();
    try {
      const logsDir = join(queueRoot, '_state', 'logs');
      mkdirSync(logsDir, { recursive: true });
      writeFileSync(join(logsDir, 'price-watch.log'), 'price-watch-draft: 1 of 16 flagged -- wrote queue/2026-08-26/price-watch.md\n');
      writeFileSync(join(logsDir, 'price-watch.err.log'), 'FETCH FAILED, check manually\n');
      const health = buildRunHealth(queueRoot, '2026-08-26', []);
      const pw = health.find((h) => h.id === 'price-watch')!;
      assert.equal(pw.source, 'log');
      assert.equal(pw.hasErrorLog, true);
      assert.equal(pw.fetchFailed, true);
    } finally {
      rmSync(queueRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// v2: og-card image guard, changelog->sparkline extraction, streak raw
// material. Every fixture below lives under a throwaway temp dir -- none of
// this ever touches the real reports/og-cards/ or data/.
// ---------------------------------------------------------------------------

describe('resolveOgCardFile: read-only og-card path guard', () => {
  test('a legitimate .png filename resolves inside the og-cards root', () => {
    const ogRoot = tmpQueue();
    try {
      const abs = resolveOgCardFile(ogRoot, 'model-two.png');
      assert.equal(abs, join(ogRoot, 'model-two.png'));
    } finally {
      rmSync(ogRoot, { recursive: true, force: true });
    }
  });

  test('rejects a filename with a path separator (no escaping the og-cards root)', () => {
    const ogRoot = tmpQueue();
    try {
      assert.throws(() => resolveOgCardFile(ogRoot, '../../etc/passwd'), PathGuardError);
      assert.throws(() => resolveOgCardFile(ogRoot, 'sub/dir.png'), PathGuardError);
      assert.throws(() => resolveOgCardFile(ogRoot, '..%2fsecret.png'), PathGuardError);
    } finally {
      rmSync(ogRoot, { recursive: true, force: true });
    }
  });

  test('rejects a non-.png filename -- this endpoint serves images, nothing else', () => {
    const ogRoot = tmpQueue();
    try {
      assert.throws(() => resolveOgCardFile(ogRoot, 'model-two.md'), PathGuardError);
      assert.throws(() => resolveOgCardFile(ogRoot, 'model-two.png.md'), PathGuardError);
      assert.throws(() => resolveOgCardFile(ogRoot, 'no-extension'), PathGuardError);
    } finally {
      rmSync(ogRoot, { recursive: true, force: true });
    }
  });

  test('an empty filename is rejected rather than resolving to the directory itself', () => {
    const ogRoot = tmpQueue();
    try {
      assert.throws(() => resolveOgCardFile(ogRoot, ''), PathGuardError);
    } finally {
      rmSync(ogRoot, { recursive: true, force: true });
    }
  });
});

const CHANGELOG_WITH_PRICE_HISTORY = [
  { date: '2026-08-21', kind: 'initial', summary: 'Initial dataset published.' }, // no model_id/price fields -- real data's shape today
  { date: '2026-08-22', kind: 'price_change', model_id: 'model-alpha', input_per_mtok: 2, output_per_mtok: 8 },
  { date: '2026-08-24', kind: 'price_change', model_id: 'model-alpha', input_per_mtok: 2.5, output_per_mtok: 9 },
  { date: '2026-08-23', kind: 'price_change', model_id: 'model-beta', input_per_mtok: 5, output_per_mtok: 15 },
];

describe('extractModelPriceHistory: changelog.json -> sparkline points', () => {
  test('pulls only the named model\'s price-change entries, sorted oldest first', () => {
    const points = extractModelPriceHistory(CHANGELOG_WITH_PRICE_HISTORY, 'model-alpha');
    assert.deepEqual(points, [
      { date: '2026-08-22', input: 2, output: 8 },
      { date: '2026-08-24', input: 2.5, output: 9 },
    ]);
  });

  test('a model with no price-change entries in the changelog gets an empty history, not a crash', () => {
    assert.deepEqual(extractModelPriceHistory(CHANGELOG_WITH_PRICE_HISTORY, 'model-gamma'), []);
  });

  test('entries without model_id/price fields (the real dataset\'s "initial"/"correction" kind entries) are skipped, not guessed at', () => {
    const realShapedEntries = [
      { date: '2026-08-21', kind: 'initial', summary: 'Initial dataset published: 25 models priced.' },
      { date: '2026-08-23', kind: 'correction', summary: 'Research Note 01 test count corrected.' },
    ];
    assert.deepEqual(extractModelPriceHistory(realShapedEntries, 'claude-opus-5'), []);
  });

  test('tolerates a non-array / malformed changelog rather than throwing', () => {
    assert.deepEqual(extractModelPriceHistory(null, 'model-alpha'), []);
    assert.deepEqual(extractModelPriceHistory(undefined, 'model-alpha'), []);
    assert.deepEqual(extractModelPriceHistory('not an array', 'model-alpha'), []);
  });
});

describe('enrichPriceWatchItem', () => {
  const fleet = [
    { model_id: 'model-alpha', input_per_mtok: 2.5, output_per_mtok: 9, last_verified: '2026-08-24', source_url: 'https://example.com/alpha' },
  ];

  test('fills priceHistory + currentPrice on a price-watch model-check item (statusBadge set, heading = model_id)', () => {
    const [item] = parseQueueFile(HEADER_FILE, '2026-08-26', 'price-watch.md', 1).items;
    assert.equal(item.heading, 'model-alpha');
    assert.equal(item.statusBadge, 'REVIEW');
    const enriched = enrichPriceWatchItem(item, fleet, CHANGELOG_WITH_PRICE_HISTORY);
    assert.deepEqual(enriched.priceHistory, [
      { date: '2026-08-22', input: 2, output: 8 },
      { date: '2026-08-24', input: 2.5, output: 9 },
    ]);
    assert.deepEqual(enriched.currentPrice, { input: 2.5, output: 9, lastVerified: '2026-08-24', sourceUrl: 'https://example.com/alpha' });
  });

  test('is a no-op for an item with no statusBadge (not a price-watch model check)', () => {
    const [item] = parseQueueFile(FLAT_FILE, '2026-08-26', 'content-miner.md', 1).items;
    assert.equal(item.statusBadge, null);
    const enriched = enrichPriceWatchItem(item, fleet, CHANGELOG_WITH_PRICE_HISTORY);
    assert.equal(enriched, item); // same object back, untouched
  });

  test('a flagged model absent from the current fleet gets currentPrice: null, not a crash', () => {
    const [, item2] = parseQueueFile(HEADER_FILE, '2026-08-26', 'price-watch.md', 1).items;
    assert.equal(item2.heading, 'model-beta');
    const enriched = enrichPriceWatchItem(item2, fleet, CHANGELOG_WITH_PRICE_HISTORY);
    assert.equal(enriched.currentPrice, null);
    assert.deepEqual(enriched.priceHistory, [{ date: '2026-08-23', input: 5, output: 15 }]);
  });
});

describe('content-miner card: line parsing', () => {
  test('a present card path is captured as a bare filename; MISSING is flagged, not treated as a path', () => {
    const { items } = parseQueueFile(FLAT_FILE, '2026-08-26', 'content-miner.md', 1);
    assert.equal(items[0].cardFilename, 'model-one.png');
    assert.equal(items[0].cardMissing, false);
    assert.equal(items[1].cardFilename, null);
    assert.equal(items[1].cardMissing, true);
    assert.equal(items[2].cardFilename, 'model-three.png');
  });
});

describe('listArchivedDates + daysBetweenIso: streak raw material', () => {
  test('lists queue/_archive/<date> dirs, sorted, ignoring non-date entries', () => {
    const queueRoot = tmpQueue();
    try {
      mkdirSync(join(queueRoot, '_archive', '2026-08-24'), { recursive: true });
      mkdirSync(join(queueRoot, '_archive', '2026-08-25'), { recursive: true });
      mkdirSync(join(queueRoot, '_archive', 'not-a-date'), { recursive: true });
      writeFileSync(join(queueRoot, '_archive', 'stray-file.txt'), 'x');
      assert.deepEqual(listArchivedDates(queueRoot), ['2026-08-24', '2026-08-25']);
    } finally {
      rmSync(queueRoot, { recursive: true, force: true });
    }
  });

  test('an empty/missing _archive dir lists as empty, not an error', () => {
    const queueRoot = tmpQueue();
    try {
      assert.deepEqual(listArchivedDates(queueRoot), []);
    } finally {
      rmSync(queueRoot, { recursive: true, force: true });
    }
  });

  test('daysBetweenIso counts whole days, matching the "days since launch" tile', () => {
    assert.equal(daysBetweenIso('2026-08-21', '2026-08-26'), 5);
    assert.equal(daysBetweenIso('2026-08-26', '2026-08-26'), 0);
  });
});

describe('buildState: v2 fields (data/ enrichment, archivedDates, overnightNumbers)', () => {
  test('enriches a price-watch item with priceHistory/currentPrice from a fixture data/ dir, and computes overnightNumbers', () => {
    const queueRoot = tmpQueue();
    const dataRoot = tmpQueue();
    try {
      mkdirSync(join(queueRoot, '2026-08-26'), { recursive: true });
      writeFileSync(join(queueRoot, '2026-08-26', 'content-miner.md'), FLAT_FILE);
      writeFileSync(join(queueRoot, '2026-08-26', 'price-watch.md'), HEADER_FILE);

      writeFileSync(join(dataRoot, 'models.json'), JSON.stringify({
        models: [{ model_id: 'model-alpha', input_per_mtok: 2.5, output_per_mtok: 9, last_verified: '2026-08-24', source_url: 'https://example.com/alpha' }],
      }));
      // The "earliest changelog entry" fixture is pinned 5 days before the real
      // wall-clock date (buildState's `today` is `localIsoDate(new Date())`, not
      // anything from the queue fixtures) -- so the daysSinceLaunch assertion
      // below holds no matter what day this test actually runs.
      // Local-date arithmetic, matching buildState's localIsoDate — the old
      // toISOString() (UTC) version made this test fail between 8pm and
      // midnight ET, when the UTC date is already tomorrow.
      const d5 = new Date(Date.now() - 5 * 86_400_000);
      const fiveDaysAgo = `${d5.getFullYear()}-${String(d5.getMonth() + 1).padStart(2, '0')}-${String(d5.getDate()).padStart(2, '0')}`;
      const entriesWithPinnedLaunch = [
        { date: fiveDaysAgo, kind: 'initial', summary: 'Initial dataset published.' },
        ...CHANGELOG_WITH_PRICE_HISTORY.filter((e) => e.kind === 'price_change'),
      ];
      writeFileSync(join(dataRoot, 'changelog.json'), JSON.stringify({ entries: entriesWithPinnedLaunch }));

      const state = buildState(queueRoot, dataRoot);
      const priceWatchFile = state.dates[0].files.find((f) => f.filename === 'price-watch.md')!;
      const alpha = priceWatchFile.items.find((it) => it.heading === 'model-alpha')!;
      assert.equal(alpha.currentPrice?.input, 2.5);
      assert.equal(alpha.priceHistory?.length, 2);

      assert.equal(state.overnightNumbers.draftsWaiting, 3); // FLAT_FILE has 3 items
      assert.equal(state.overnightNumbers.daysSinceLaunch, 5);
      assert.deepEqual(state.archivedDates, []);
    } finally {
      rmSync(queueRoot, { recursive: true, force: true });
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  test('a missing/malformed data/ dir degrades gracefully -- empty models/changelog, no crash', () => {
    const queueRoot = tmpQueue();
    const dataRoot = join(tmpdir(), 'solvency-dash-nonexistent-' + Date.now());
    try {
      mkdirSync(join(queueRoot, '2026-08-26'), { recursive: true });
      writeFileSync(join(queueRoot, '2026-08-26', 'price-watch.md'), HEADER_FILE);
      const { models, changelogEntries } = loadPricingContext(dataRoot);
      assert.deepEqual(models, []);
      assert.deepEqual(changelogEntries, []);
      const state = buildState(queueRoot, dataRoot);
      const priceWatchFile = state.dates[0].files.find((f) => f.filename === 'price-watch.md')!;
      assert.equal(priceWatchFile.items[0].currentPrice, null);
      assert.deepEqual(priceWatchFile.items[0].priceHistory, []);
    } finally {
      rmSync(queueRoot, { recursive: true, force: true });
    }
  });
});
