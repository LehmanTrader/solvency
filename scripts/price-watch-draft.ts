/**
 * Price-change confirmation workflow (docs/marketing/panel-2026-08-26/08-automation.md §6.2).
 *
 * Wraps scripts/watch-prices.ts UNMODIFIED -- it is imported as-is (its own
 * console output is the only interface used here) and never patched into an
 * auto-detector. For every model it flags REVIEW or FETCH!, this script:
 *
 *   - looks up the recorded price + last_verified via scripts/load.ts
 *   - re-fetches the model's own source_url independently, and grabs a nearby
 *     text snippet (a fetch failure here is reported as "FETCH FAILED, check
 *     manually" -- it is never reported as "no change")
 *   - writes the human checklist verbatim, plus a draft paragraph explicitly
 *     marked UNCONFIRMED, to queue/<today>/price-watch.md
 *
 * This script never writes data/models.json or data/changelog.json under any
 * condition -- confirming and editing those is the founder's job, by hand,
 * after opening source_url personally.
 *
 *   node scripts/price-watch-draft.ts   (== npm run queue:price-watch)
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import type { Model } from './types.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const CHECKLIST = [
  'Open source_url yourself and check the current price.',
  'If it changed: edit data/models.json (the price fields) and bump last_verified.',
  'Append a data/changelog.json entry matching the existing schema.',
  'Run `npm run og:cards && npm test`.',
];

export interface WatchRow {
  modelId: string;
  status: 'ok' | 'REVIEW' | 'FETCH!';
  missing: string[];
}

/** Parses scripts/watch-prices.ts's own console.log table -- its only public interface. */
export function parseWatchOutput(stdout: string): WatchRow[] {
  const rows: WatchRow[] = [];
  const re = /^\s*(ok|REVIEW|FETCH!)\s+(\S+)\s*(?:not found on page: (.+))?$/;
  for (const line of stdout.split('\n')) {
    const m = line.match(re);
    if (!m) continue;
    const [, status, modelId, missingRaw] = m;
    rows.push({
      modelId,
      status: status as WatchRow['status'],
      missing: missingRaw ? missingRaw.split(',').map((s) => s.trim()) : [],
    });
  }
  return rows;
}

/**
 * Runs the real, unmodified watch-prices.ts by dynamic import (its console
 * output is captured, its top-level side effects are exactly what a
 * `node scripts/watch-prices.ts` invocation would do) and returns the parsed
 * rows. Every check it performs -- including its own source_url fetch -- runs
 * for real; nothing about its detection logic is reimplemented here.
 */
export async function runWatchPrices(): Promise<WatchRow[]> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    // Cache-busted: watch-prices.ts is a top-level-side-effect script (it has
    // no exports to call repeatedly), and this function may run more than
    // once in a single process (e.g. across tests). A plain specifier would
    // hit Node's ES module cache after the first import and silently replay
    // nothing on later calls.
    const nonce = `${Date.now()}-${Math.random()}`;
    await import(`${pathToFileURL(join(ROOT, 'scripts', 'watch-prices.ts')).href}?nonce=${nonce}`);
  } finally {
    console.log = originalLog;
  }
  return parseWatchOutput(lines.join('\n'));
}

const strip = (html: string) =>
  html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

export interface Snippet {
  ok: boolean;
  text: string; // the snippet, or "FETCH FAILED, check manually" when ok is false
}

/** Re-fetches source_url independently of watch-prices.ts and grabs text near a dollar figure. */
export async function fetchSnippet(sourceUrl: string, fetchImpl: typeof fetch = fetch): Promise<Snippet> {
  try {
    const res = await fetchImpl(sourceUrl, { headers: { 'user-agent': 'SolvencyPriceWatcher/1.0 (+https://solvency.dev)' } });
    if (!res.ok) return { ok: false, text: 'FETCH FAILED, check manually' };
    const text = strip(await res.text());
    const dollarIdx = text.search(/\$\d/);
    const start = dollarIdx >= 0 ? Math.max(0, dollarIdx - 60) : 0;
    const window = text.slice(start, start + 200).trim();
    return { ok: true, text: window || '(page fetched but no visible text found)' };
  } catch {
    return { ok: false, text: 'FETCH FAILED, check manually' };
  }
}

function fmtUsd(n: number | null): string {
  if (n === null) return 'n/a';
  return n % 1 === 0 ? `$${n}` : `$${n}`;
}

export function draftParagraph(model: Model): string {
  return (
    `${fmtUsd(model.input_per_mtok)}/M in, ${fmtUsd(model.output_per_mtok)}/M out -- ${model.display_name}'s ` +
    `listed price may have changed. Verify at ${model.source_url} before posting anything.\n` +
    `source: data/models.json · input_per_mtok/output_per_mtok · verified ${model.last_verified}`
  );
}

export interface PriceWatchOptions {
  queueRoot?: string;
  today?: string;
  watchPrices?: () => Promise<WatchRow[]>;
  fetchImpl?: typeof fetch;
  fleet?: Model[]; // for output-checklist lookups; defaults to scripts/load.ts's real models
}

export interface PriceWatchResult {
  wrote: boolean;
  path: string;
  reviewCount: number;
  totalCount: number;
}

export async function runPriceWatchDraft(opts: PriceWatchOptions = {}): Promise<PriceWatchResult> {
  const queueRoot = opts.queueRoot ?? join(ROOT, 'queue');
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const watchPrices = opts.watchPrices ?? runWatchPrices;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { models: fleet } = opts.fleet ? { models: opts.fleet } : await import('./load.ts');

  const rows = await watchPrices();
  const flagged = rows.filter((r) => r.status !== 'ok');

  const outDir = join(queueRoot, today);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'price-watch.md');
  const runAt = new Date().toISOString();
  const frontmatter = `---\ngenerated_by: scripts/price-watch-draft.ts\nrun_at: ${runAt}\nregenerate_with: npm run queue:price-watch\n---\n\n`;

  if (!flagged.length) {
    writeFileSync(
      outPath,
      `${frontmatter}# Price watch -- ${today}\n\n0 of ${rows.length} models flagged by watch-prices.ts -- nothing to confirm tonight.\n`,
    );
    return { wrote: true, path: outPath, reviewCount: 0, totalCount: rows.length };
  }

  const checklistBlock = CHECKLIST.map((step, i) => `${i + 1}. ${step}`).join('\n');

  const items: string[] = [];
  for (const row of flagged) {
    const model = fleet.find((m: Model) => m.model_id === row.modelId);
    if (!model) continue; // watch-prices covers a model no longer in the loaded fleet -- skip rather than guess

    const snippet = row.status === 'FETCH!'
      ? { ok: false, text: 'FETCH FAILED, check manually' }
      : await fetchSnippet(model.source_url, fetchImpl);

    const missingNote = row.missing.length ? `not found on page: ${row.missing.join(', ')}` : '(watch-prices.ts could not fetch this page)';

    items.push(
      `## ${items.length + 1}. ${model.model_id}\n\n` +
        `- watch-prices.ts: ${row.status} -- ${missingNote}\n` +
        `- recorded: ${fmtUsd(model.input_per_mtok)}/M in, ${fmtUsd(model.output_per_mtok)}/M out · last_verified ${model.last_verified}\n` +
        `- source_url: ${model.source_url}\n` +
        `- fetched snippet: "${snippet.text}"\n\n` +
        `UNCONFIRMED -- do not use until the checklist above is done:\n"${draftParagraph(model)}"`,
    );
  }

  const body =
    `${flagged.length} of ${rows.length} models flagged by watch-prices.ts. Confirm every one below before ` +
    `touching data/ or using any draft.\n\n` +
    `## Checklist (do this for each flagged model, in order)\n\n${checklistBlock}\n\n` +
    items.join('\n\n');

  writeFileSync(outPath, `${frontmatter}# Price watch -- ${today}\n\n${body}\n`);
  return { wrote: true, path: outPath, reviewCount: flagged.length, totalCount: rows.length };
}

const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const result = await runPriceWatchDraft();
  console.log(`price-watch-draft: ${result.reviewCount} of ${result.totalCount} flagged -- wrote ${result.path}`);
}
