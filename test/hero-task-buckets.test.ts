/**
 * The hero's "I want to ship a [bucket]" answer (site/src/components/Calculator.astro)
 * sets its working task count from site/src/lib/tasks.ts's TASK_BUCKETS. This
 * pins those medians (and n, Q1, Q3) against an independent re-derivation
 * from data/task-study/final_table.csv, using the same Tukey-hinge
 * convention as test/task-report.test.ts, so the two can never silently
 * drift apart from the published study.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TASK_BUCKETS, bucketById, fmtTasks } from '../site/src/lib/tasks.ts';

const ROOT = join(import.meta.dirname, '..');
const CSV = join(ROOT, 'data', 'task-study', 'final_table.csv');

// ---- minimal CSV parser, identical in behavior to test/task-report.test.ts --
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

function median(sorted: number[]): number {
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function tukeyHinges(vals: number[]): { median: number; q1: number; q3: number } {
  const v = [...vals].sort((a, b) => a - b);
  const n = v.length;
  const lower = n % 2 === 0 ? v.slice(0, n / 2) : v.slice(0, (n - 1) / 2);
  const upper = n % 2 === 0 ? v.slice(n / 2) : v.slice((n + 1) / 2);
  return { median: median(v), q1: median(lower), q3: median(upper) };
}

const rows = parseCsv(readFileSync(CSV, 'utf8'));
const countsFor = (bucket: string): number[] => rows.filter((r) => r.bucket === bucket).map((r) => Number(r.count_used));

// site/src/lib/tasks.ts's csvBucket letters, from data/task-study/README.md.
const EXPECT: Record<string, string> = {
  web: 'b', mobile: 'f', marketing: 'a', game: 'c', cli: 'd', data: 'e',
};

describe('hero task-bucket medians re-derive from data/task-study/final_table.csv', () => {
  test('the six hero buckets map to the six published CSV buckets, one each', () => {
    assert.equal(TASK_BUCKETS.length, 6);
    assert.deepEqual(new Set(TASK_BUCKETS.map((b) => b.id)), new Set(Object.keys(EXPECT)));
    for (const b of TASK_BUCKETS) assert.equal(b.csvBucket, EXPECT[b.id], `${b.id} -> csv bucket`);
  });

  test('every bucket median, n, Q1 and Q3 match an independent Tukey-hinge re-derivation', () => {
    for (const b of TASK_BUCKETS) {
      const counts = countsFor(b.csvBucket);
      const stats = tukeyHinges(counts);
      assert.equal(b.n, counts.length, `${b.id}: n`);
      assert.equal(b.median, stats.median, `${b.id}: median`);
      assert.equal(b.q1, stats.q1, `${b.id}: q1`);
      assert.equal(b.q3, stats.q3, `${b.id}: q3`);
    }
  });

  test('bucket medians match the published cross-bucket summary in Research Note 03', () => {
    const PUBLISHED: Record<string, number> = { web: 306, mobile: 48, marketing: 248, game: 240.5, cli: 133, data: 479 };
    for (const [id, medianValue] of Object.entries(PUBLISHED)) assert.equal(bucketById(id)?.median, medianValue, id);
  });

  test('fmtTasks matches the report table\'s own formatting (integers plain, halves to one decimal)', () => {
    assert.equal(fmtTasks(48), '48');
    assert.equal(fmtTasks(1609), '1,609');
    assert.equal(fmtTasks(240.5), '240.5');
    assert.equal(fmtTasks(316.5), '316.5');
  });

  test('bucketById resolves every id and rejects unknown ones', () => {
    for (const id of Object.keys(EXPECT)) assert.ok(bucketById(id), id);
    assert.equal(bucketById('nope'), undefined);
  });
});
