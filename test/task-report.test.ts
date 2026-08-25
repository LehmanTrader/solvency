/**
 * Research Note 03 is a rendering of the task-count study. Parse the public
 * cross-bucket table and re-derive n, median and quartiles per bucket from
 * data/task-study/final_table.csv, the same way harness-report.test.ts and
 * report.test.ts re-derive Note 02 and Note 01 from their canonical data.
 *
 * Quartile method: the study's own numbers turn out to match exactly one
 * well-defined convention -- Tukey's hinges (median of the lower half and
 * median of the upper half of the sorted bucket, with the bucket's own
 * median excluded from both halves when n is odd). That convention is
 * implemented here and used to re-derive every published Q1/Q3, so a future
 * edit that silently drifts to a different quartile definition fails this
 * test rather than shipping unnoticed.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assumptions, tiers, modelById, bestResultFor, extrasFor } from '../scripts/load.ts';
import { costPerSolvedTask, defaultOptions } from '../scripts/solved-cost.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = join(ROOT, 'reports', '2026-08-what-is-a-task.md');
const CSV = join(ROOT, 'data', 'task-study', 'final_table.csv');
const md = readFileSync(REPORT, 'utf8');
const opts = defaultOptions(assumptions);

// ---- minimal CSV parser (handles quoted fields with embedded commas) ------
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split('\n');
  const splitRow = (line: string): string[] => {
    const cells: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') { inQuotes = false; }
        else cur += c;
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        cells.push(cur); cur = '';
      } else {
        cur += c;
      }
    }
    cells.push(cur);
    return cells;
  };
  const header = splitRow(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitRow(line);
    const row: Record<string, string> = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    return row;
  });
}

const rows = parseCsv(readFileSync(CSV, 'utf8'));
assert.equal(rows.length, 60, 'expected 60 repo rows in final_table.csv');

const BUCKETS: Record<string, string> = {
  a: 'Marketing/landing site',
  b: 'Full web app (SaaS)',
  c: '2D indie game',
  d: 'CLI tool/utility',
  e: 'Data/ML pipeline',
  f: 'Mobile app',
};

function countsFor(bucket: string): number[] {
  return rows.filter((r) => r.bucket === bucket).map((r) => Number(r.count_used));
}

function median(sorted: number[]): number {
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Tukey's hinges: median-of-halves, excluding the overall median when n is odd. */
function tukeyHinges(vals: number[]): { median: number; q1: number; q3: number; min: number; max: number } {
  const v = [...vals].sort((a, b) => a - b);
  const n = v.length;
  const lower = n % 2 === 0 ? v.slice(0, n / 2) : v.slice(0, (n - 1) / 2);
  const upper = n % 2 === 0 ? v.slice(n / 2) : v.slice((n + 1) / 2);
  return { median: median(v), q1: median(lower), q3: median(upper), min: v[0], max: v[n - 1] };
}

const cells = (line: string) => line.split('|').slice(1, -1).map((c) => c.trim());
const num = (s: string) => Number(s.replace(/,/g, ''));
/** Matches the table's own formatting: thousands separators, one decimal only when non-integer. */
const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(1).replace(/\B(?=(\d{3})+(?!\d)\.)/g, ','));

describe('Research Note 03 matches the task-count dataset', () => {
  test('the CSV has 60 rows split across exactly the six published buckets', () => {
    for (const b of Object.keys(BUCKETS)) {
      assert.ok(countsFor(b).length > 0, `bucket ${b} has no rows`);
    }
    const total = Object.keys(BUCKETS).reduce((sum, b) => sum + countsFor(b).length, 0);
    assert.equal(total, 60);
  });

  test('every row of the cross-bucket summary table re-derives from the CSV via Tukey hinges', () => {
    const tableBlock = md.match(/\| Bucket \| n \| Median \| Q1–Q3 \| Range \|[\s\S]*?\n\n### /)?.[0] ?? '';
    const tableLines = tableBlock.split('\n').filter((l) => /^\|/.test(l) && !/^\|---/.test(l) && !/^\| Bucket \|/.test(l));
    assert.equal(tableLines.length, 6, 'expected 6 published bucket rows');

    for (const line of tableLines) {
      const [bucketName, nStr, medianStr, q1q3, range] = cells(line);
      const bucketKey = Object.keys(BUCKETS).find((k) => BUCKETS[k] === bucketName);
      assert.ok(bucketKey, `unknown bucket name in report: ${bucketName}`);

      const counts = countsFor(bucketKey!);
      const stats = tukeyHinges(counts);

      assert.equal(Number(nStr), counts.length, `${bucketName}: n`);
      assert.equal(medianStr, fmt(stats.median), `${bucketName}: median`);

      const [q1Str, q3Str] = q1q3.split('–').map((s) => s.trim());
      assert.equal(q1Str, fmt(stats.q1), `${bucketName}: Q1`);
      assert.equal(q3Str, fmt(stats.q3), `${bucketName}: Q3`);

      const [minStr, maxStr] = range.split('–').map((s) => s.trim());
      assert.equal(num(minStr), stats.min, `${bucketName}: range min`);
      assert.equal(num(maxStr), stats.max, `${bucketName}: range max`);
    }
  });

  test('the example repos per bucket cite counts that exist in the CSV', () => {
    const examples: [string, string, number][] = [
      ['PostHog/posthog.com', 'PRs', 14344],
      ['monicahq/marketing_site', 'PRs', 331],
      ['cruip/open-react-template', 'commits', 13],
      ['documenso/documenso', 'PRs', 1609],
      ['chatwoot/chatwoot', 'PRs', 202],
      ['formbricks/formbricks', 'commits', 56],
      ['deathkiller/jazz2-native', 'commits', 1681],
      ['fishfolk/jumpy', 'PRs', 192],
      ['Walkator/Kailius', 'commits', 19],
      ['eza-community/eza', 'commits', 1825],
      ['charmbracelet/gum', 'commits', 133],
      ['google/zx', 'PRs', 14],
      ['cloudquery/cloudquery', 'PRs', 19723],
      ['bruin-data/ingestr', 'PRs', 479],
      ['turbot/steampipe', 'commits', 8],
      ['openfoodfacts/smooth-app', 'PRs', 288],
      ['maxrave-dev/SimpMusic', 'commits', 48],
      ['rafsoh/dimeApp', 'PRs', 18],
    ];
    for (const [repo, unitWord, count] of examples) {
      const row = rows.find((r) => r.repo === repo);
      assert.ok(row, `report cites a repo not in the CSV: ${repo}`);
      assert.equal(Number(row!.count_used), count, `${repo}: count_used`);
      const unit = unitWord === 'PRs' ? 'PRs' : 'commits';
      assert.equal(row!.unit_used, unit, `${repo}: unit_used`);
      assert.ok(md.includes(`[${repo}]`), `report does not link ${repo}`);
      assert.ok(md.includes(`https://github.com/${repo}`), `report does not link to github.com/${repo}`);
    }
  });

  test('worked example 1 (mobile app, Claude Opus 5) arithmetic matches the engine and data/models.json', () => {
    const model = modelById('claude-opus-5')!;
    assert.ok(model, 'claude-opus-5 missing from data/models.json');
    const r = bestResultFor(model.model_id)!;
    const perSolved = costPerSolvedTask(model, 'heavy', tiers.heavy, r.pass_rate, opts, extrasFor(r)).value!.naive;
    assert.equal(perSolved.toFixed(2), '12.01');
    assert.ok(md.includes('$12.01 per solved task'));

    const rate = Number(perSolved.toFixed(2));
    const counts = countsFor('f');
    const stats = tukeyHinges(counts);
    assert.equal(stats.q1, 22, 'bucket f Q1');
    assert.equal(stats.median, 48, 'bucket f median');
    assert.equal(stats.q3, 113, 'bucket f Q3');

    const low = Math.round(stats.q1 * rate);
    const mid = Math.round(stats.median * rate);
    const high = Math.round(stats.q3 * rate);
    assert.equal(low, 264);
    assert.equal(mid, 576);
    assert.equal(high, 1357);
    assert.match(md, /22 tasks {2}× \$12\.01 = \$264/);
    assert.match(md, /48 tasks {2}× \$12\.01 = \$576 {3}\(median\)/);
    assert.match(md, /113 tasks × \$12\.01 = \$1,357/);
    assert.match(md, /≈ \$264–\$1,357, median ≈ \$576/);
  });

  test('worked example 2 (CLI tool, DeepSeek V4 Flash) arithmetic matches the engine and data/models.json', () => {
    const model = modelById('deepseek-v4-flash')!;
    assert.ok(model, 'deepseek-v4-flash missing from data/models.json');
    const r = bestResultFor(model.model_id)!;
    const perSolved = costPerSolvedTask(model, 'heavy', tiers.heavy, r.pass_rate, opts, extrasFor(r)).value!.naive;
    assert.equal(perSolved.toFixed(2), '0.12');
    assert.ok(md.includes('$0.12 per solved task'));

    const rate = Number(perSolved.toFixed(2));
    const counts = countsFor('d');
    const stats = tukeyHinges(counts);
    assert.equal(stats.q1, 21, 'bucket d Q1');
    assert.equal(stats.median, 133, 'bucket d median');
    assert.equal(stats.q3, 316.5, 'bucket d Q3');

    assert.equal((stats.q1 * rate).toFixed(2), '2.52');
    assert.equal((stats.median * rate).toFixed(2), '15.96');
    assert.equal((stats.q3 * rate).toFixed(2), '37.98');
    assert.match(md, /21 {4}tasks × \$0\.12 = \$2\.52/);
    assert.match(md, /133 {3}tasks × \$0\.12 = \$15\.96 {2}\(median\)/);
    assert.match(md, /316\.5 tasks × \$0\.12 = \$37\.98/);
    assert.match(md, /≈ \$2\.52–\$38, median ≈ \$16/);
  });

  test('dataset paths, measurement dates and verification dates are stated', () => {
    assert.match(md, /data\/task-study\/final_table\.csv/);
    assert.match(md, /data\/task-study\/measure_repo\.sh/);
    assert.match(md, /data\/task-study\/repos\.txt/);
    assert.match(md, /2026-08-24\/25/);
    assert.ok(md.includes(model_prices_verified()), 'report states its price verification date');
    assert.match(md, /Curated, not randomly sampled/);
    assert.match(md, /Survivorship bias/);
    assert.match(md, /lower bounds/);

    function model_prices_verified(): string {
      return modelById('claude-opus-5')!.last_verified;
    }
  });
});
