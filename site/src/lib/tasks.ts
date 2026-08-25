/**
 * Bucket task-count medians for the hero's "I want to ship a [bucket]"
 * answer. Re-derived at build time from data/task-study/final_table.csv —
 * the same file, and the same Tukey-hinge convention, that
 * test/task-report.test.ts uses to verify reports/2026-08-what-is-a-task.md
 * (Research Note 03). Nothing here is hand-typed: change the CSV and these
 * numbers move with it. See that report for method, caveats and the six
 * measured use-case buckets.
 *
 * Server/build-only (reads a file via node:fs at import time): Calculator.astro's
 * frontmatter imports this directly, but its client <script> must not — a
 * browser bundle has no node:fs. The client island instead gets the already
 * computed TASK_BUCKETS as embedded JSON (#task-buckets-data) and uses the
 * pure formatting helpers from ../lib/tasks-shared.ts, re-exported below.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { type TaskBucket, bucketById as bucketByIdIn, fmtTasks, provenanceHtml, otherProvenanceHtml } from './tasks-shared.ts';

export type { TaskBucket };
export { fmtTasks, provenanceHtml, otherProvenanceHtml };

// This module runs unbundled under the repo-root test suite (import.meta.url
// is the true source path, three levels below the repo root) and bundled
// into an Astro/Vite build chunk at an unrelated, unpredictable depth (where
// import.meta.url is the *chunk's* location, not tasks.ts's). Rather than
// hard-code a "../../../" that only holds in one of those two contexts, walk
// upward from wherever this module actually executes until the CSV is found.
function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'data', 'task-study', 'final_table.csv'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate data/task-study/final_table.csv above ${startDir}`);
}

const CSV_PATH = join(findRepoRoot(dirname(fileURLToPath(import.meta.url))), 'data', 'task-study', 'final_table.csv');

// ---- minimal CSV parser (handles quoted fields with embedded commas) ------
// Identical in behaviour to the parser in test/task-report.test.ts.
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

/** Tukey's hinges: median-of-halves, excluding the overall median when n is odd. */
function tukeyHinges(vals: number[]): { median: number; q1: number; q3: number; min: number; max: number } {
  const v = [...vals].sort((a, b) => a - b);
  const n = v.length;
  const lower = n % 2 === 0 ? v.slice(0, n / 2) : v.slice(0, (n - 1) / 2);
  const upper = n % 2 === 0 ? v.slice(n / 2) : v.slice((n + 1) / 2);
  return { median: median(v), q1: median(lower), q3: median(upper), min: v[0], max: v[n - 1] };
}

const csvRows = parseCsv(readFileSync(CSV_PATH, 'utf8'));
const countsFor = (bucket: string): number[] => csvRows.filter((r) => r.bucket === bucket).map((r) => Number(r.count_used));

const BUCKET_DEFS: { id: string; label: string; plural: string; csvBucket: string }[] = [
  { id: 'web', label: 'a web app', plural: 'web apps', csvBucket: 'b' },
  { id: 'mobile', label: 'a mobile app', plural: 'mobile apps', csvBucket: 'f' },
  { id: 'marketing', label: 'a marketing site', plural: 'marketing sites', csvBucket: 'a' },
  { id: 'game', label: 'a 2D game', plural: '2D games', csvBucket: 'c' },
  { id: 'cli', label: 'a CLI tool', plural: 'CLI tools', csvBucket: 'd' },
  { id: 'data', label: 'a data/ML pipeline', plural: 'data/ML pipelines', csvBucket: 'e' },
];

/** The six measured buckets, medians re-derived from the CSV, in dropdown order. */
export const TASK_BUCKETS: TaskBucket[] = BUCKET_DEFS.map((d) => {
  const counts = countsFor(d.csvBucket);
  const stats = tukeyHinges(counts);
  return { ...d, n: counts.length, median: stats.median, q1: stats.q1, q3: stats.q3 };
});

export const bucketById = (id: string): TaskBucket | undefined => bucketByIdIn(TASK_BUCKETS, id);
