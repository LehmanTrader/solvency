/**
 * The founder's overnight-marketing morning dashboard (queue/README.md).
 *
 * A zero-dependency Node http server, bound to 127.0.0.1 only, that:
 *   - parses every queue/<date>/*.md file for every unarchived date (the
 *     README convention: frontmatter + numbered items -- but see the note
 *     on item styles below, since real producer output uses two shapes)
 *   - serves the dashboard UI (GET /) and a small JSON API (GET /api/state,
 *     DELETE /api/item, POST /api/archive, POST /api/open-file)
 *   - reads (never writes) queue/_state/logs/*.log for per-producer run
 *     health, with a graceful fallback to a queue file's own frontmatter
 *     when a log hasn't been written yet
 *
 * GUARDRAIL: this script never posts, sends, or calls any external service.
 * Every filesystem touch is confined to inside `queue/` (validated by
 * resolveQueueDateDir/resolveQueueFile below) or a read of queue/_state/logs.
 * The one non-queue action (`POST /api/open-file`) shells out to the local
 * macOS `open` command on a path that has already passed the same guard --
 * it never reaches the network.
 *
 * Two real item shapes exist in the wild, both handled:
 *   - "flat": a top-level numbered list, `N. text` (content-miner.ts's
 *     normal shape, and the README's own documented example).
 *   - "header": top-level `## N. Title` sections (price-watch-draft.ts's
 *     shape once anything is flagged, and every other one-off drafting
 *     agent's file under queue/ -- grant-applications.md, outreach-batch.md,
 *     etc). Nested numbered lists inside a section (`### 1.2`, or a plain
 *     `1. ...` sub-list under a heading) are never mistaken for item
 *     boundaries: once a file has any `## N. Title` heading, headings are
 *     the only boundary considered.
 *   A file with neither (a pure prose "no new deltas" day) has zero items
 *   and renders as a quiet FYI line -- never treated as an error.
 *
 *   node scripts/queue-dashboard.ts   (== npm run queue:dashboard)
 *   QUEUE_DIR=/path/to/fixture/queue overrides the queue root (used by the
 *   empty-state screenshot and local testing -- never set in production).
 */
import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_PORT = 4870;

// ---------------------------------------------------------------------------
// Path safety. Every mutating (and file-opening) endpoint routes its inputs
// through one of these before touching disk. Both are pure and independently
// testable against traversal attempts.
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILENAME_RE = /^[A-Za-z0-9._-]+\.md$/;

export class PathGuardError extends Error {}

/** Resolves queue/<date> and asserts it cannot escape queueRoot. */
export function resolveQueueDateDir(queueRoot: string, date: string): string {
  if (!DATE_RE.test(date)) throw new PathGuardError(`invalid date: ${JSON.stringify(date)}`);
  const base = resolve(queueRoot) + sep;
  const abs = resolve(queueRoot, date);
  if (!(abs + sep).startsWith(base)) throw new PathGuardError('date path escapes queue root');
  if (dirname(abs) !== resolve(queueRoot)) throw new PathGuardError('date path escapes queue root');
  return abs;
}

/** Resolves queue/<date>/<filename>.md and asserts it cannot escape queueRoot. */
export function resolveQueueFile(queueRoot: string, date: string, filename: string): string {
  const dateDir = resolveQueueDateDir(queueRoot, date);
  if (!FILENAME_RE.test(filename)) throw new PathGuardError(`invalid filename: ${JSON.stringify(filename)}`);
  const abs = resolve(dateDir, filename);
  if (dirname(abs) !== dateDir) throw new PathGuardError('file path escapes date directory');
  return abs;
}

// ---------------------------------------------------------------------------
// Frontmatter + item parsing. Pure string-in, string/struct-out -- no fs
// here, so every case is a fixture string in the tests below.
// ---------------------------------------------------------------------------

export interface ParsedFile {
  frontmatterRaw: string; // exact original block, including delimiters -- rewritten verbatim, never re-serialized
  meta: Record<string, string>;
  body: string; // everything after the frontmatter block
}

/** Splits `---\nkey: val\n---\n<body>` into its parts. Tolerates no frontmatter (whole file becomes body). */
export function splitFrontmatter(raw: string): ParsedFile {
  const m = raw.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n?)([\s\S]*)$/);
  if (!m) return { frontmatterRaw: '', meta: {}, body: raw };
  const [, frontmatterRaw, body] = m;
  const inner = frontmatterRaw.replace(/^---\r?\n/, '').replace(/\r?\n---\r?\n?$/, '');
  const lines = inner.split('\n');
  const meta: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*):\s?(.*)$/);
    if (!kv) { i++; continue; }
    const key = kv[1];
    let val = kv[2].trim();
    i++;
    if (val === '' || val === '|' || val === '>' || val === '>-' || val === '|-') {
      // Folded/block scalar or a YAML list: best-effort -- join continuation
      // lines for display. Never needs to be exact; the dashboard only shows
      // this in a small meta strip, never rewrites it.
      const cont: string[] = [];
      while (i < lines.length && (/^\s/.test(lines[i]) || lines[i].trim() === '')) {
        const t = lines[i].trim().replace(/^-\s*/, '');
        if (t) cont.push(t);
        i++;
      }
      val = cont.join(' ').trim();
    } else if (val.length >= 2 && val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1);
    }
    while (i < lines.length && /^\s*-\s/.test(lines[i])) i++; // skip an inline YAML list under this key
    meta[key] = val;
  }
  return { frontmatterRaw, meta, body };
}

/**
 * The `# Title` line, if the body (after skipping the blank line frontmatter
 * always leaves behind) opens with one, plus everything after it.
 */
export function splitTitle(body: string): { title: string | null; rest: string } {
  const leading = body.match(/^\r?\n*/)?.[0] ?? '';
  const trimmed = body.slice(leading.length);
  const m = trimmed.match(/^#[ \t]+(.+?)\r?\n+([\s\S]*)$/);
  if (!m) return { title: null, rest: body };
  return { title: m[1].trim(), rest: m[2] };
}

export type ItemStyle = 'flat' | 'header' | 'none';

const HEADER_ITEM_RE = /^##[ \t]+(\d+)\.[ \t]+.*$/gm;
const FLAT_ITEM_RE = /^(\d+)\.[ \t]+.*$/gm;

/** Header items (`## N. Title`) take priority; only if none exist does a flat `N. text` list count. */
export function detectItemStyle(content: string): ItemStyle {
  HEADER_ITEM_RE.lastIndex = 0;
  if ([...content.matchAll(HEADER_ITEM_RE)].length) return 'header';
  FLAT_ITEM_RE.lastIndex = 0;
  if ([...content.matchAll(FLAT_ITEM_RE)].length) return 'flat';
  return 'none';
}

export interface ItemChunk {
  n: number;
  raw: string; // exact original text of this item, marker through (not including) the next item's marker
}

/** Splits content into item chunks at either style's boundary markers. Preserves every byte between markers. */
export function splitItemChunks(content: string, style: ItemStyle): ItemChunk[] {
  if (style === 'none') return [];
  const re = style === 'header' ? HEADER_ITEM_RE : FLAT_ITEM_RE;
  re.lastIndex = 0;
  const matches = [...content.matchAll(re)];
  const chunks: ItemChunk[] = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index!;
    const end = i + 1 < matches.length ? matches[i + 1].index! : content.length;
    chunks.push({ n: Number(matches[i][1]), raw: content.slice(start, end) });
  }
  return chunks;
}

function renumberChunk(raw: string, newN: number, style: ItemStyle): string {
  return style === 'header'
    ? raw.replace(/^(##[ \t]+)\d+(\.[ \t]+)/, `$1${newN}$2`)
    : raw.replace(/^\d+(\.[ \t]+)/, `${newN}$1`);
}

/**
 * Deletes item `n` from a full queue-file string and renumbers what remains,
 * preserving the frontmatter block and the `# Title` line byte-for-byte --
 * this IS the "delete renumbers cleanly" convention from queue/README.md.
 * Throws (never silently no-ops) if the file has no items, or `n` isn't one
 * of them, so the caller can 404 rather than write a corrupt file.
 */
export function deleteItemFromMarkdown(raw: string, n: number): string {
  const { frontmatterRaw, body } = splitFrontmatter(raw);
  const { title, rest } = splitTitle(body);
  const style = detectItemStyle(rest);
  if (style === 'none') throw new PathGuardError('this file has no numbered items to delete');
  const re = style === 'header' ? HEADER_ITEM_RE : FLAT_ITEM_RE;
  re.lastIndex = 0;
  const firstMatch = [...rest.matchAll(re)][0];
  // Everything between the title and the first item marker -- an intro
  // sentence, price-watch's shared "## Checklist" block, etc -- is not part
  // of any item and must survive the rewrite untouched.
  const preamble = rest.slice(0, firstMatch.index!);
  const chunks = splitItemChunks(rest, style);
  const idx = chunks.findIndex((c) => c.n === n);
  if (idx === -1) throw new PathGuardError(`item ${n} not found`);
  chunks.splice(idx, 1);
  const newRest = preamble + chunks.map((c, i) => renumberChunk(c.raw, i + 1, style)).join('');
  const titleBlock = title !== null ? `# ${title}\n\n` : '';
  return frontmatterRaw + titleBlock + newRest;
}

/** The plain numbered steps under a `## Checklist` heading (price-watch-draft.ts's shared 4-step list). */
export function extractChecklistSteps(content: string): string[] {
  const lines = content.split('\n');
  const startIdx = lines.findIndex((l) => /^##[ \t]+Checklist\b/.test(l));
  if (startIdx === -1) return [];
  const steps: string[] = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##[ \t]+/.test(line)) break; // next section: stop
    const m = line.match(/^(\d+)\.[ \t]+(.+)$/);
    if (m) steps.push(m[2].trim());
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Per-item display fields, derived from a chunk for the JSON API / UI. Not
// used for the delete round-trip (that only ever touches `raw`).
// ---------------------------------------------------------------------------

/** A single dated price point, sourced from a data/changelog.json entry or the live data/models.json record. */
export interface PricePoint {
  date: string;
  input: number | null;
  output: number | null;
}

/** The live data/models.json record for a flagged model -- what Solvency currently has on file. */
export interface CurrentPriceInfo {
  input: number | null;
  output: number | null;
  lastVerified: string | null;
  sourceUrl: string | null;
}

export interface DisplayItem {
  n: number;
  style: ItemStyle;
  raw: string;
  heading: string | null; // header style only
  bodyMd: string; // markdown-lite source for the card body
  sourceLine: string | null;
  statusBadge: 'ok' | 'REVIEW' | 'FETCH!' | null;
  fetchFailed: boolean;
  // content-miner draft image cards -- parsed from a `card: <path>` / `card: MISSING ...` line.
  cardFilename: string | null; // basename only, e.g. "model-two.png" -- resolved against reports/og-cards/ by the client
  cardMissing: boolean;
  // price-watch model checks -- parsed from the `- recorded:` / `- source_url:` / `- fetched snippet:` lines.
  // `heading` doubles as the model_id for these items (price-watch-draft.ts writes `## N. <model_id>`).
  recordedLine: string | null;
  fetchedSnippet: string | null;
  // Filled in later by enrichPriceWatchItem (needs fs access to data/) -- null until then, and null forever
  // for every item that isn't a price-watch model check.
  priceHistory: PricePoint[] | null;
  currentPrice: CurrentPriceInfo | null;
}

function toDisplayItem(chunk: ItemChunk, style: ItemStyle): DisplayItem {
  let heading: string | null = null;
  let bodyMd = chunk.raw;
  if (style === 'header') {
    const hm = chunk.raw.match(/^##[ \t]+\d+\.[ \t]+(.*)$/m);
    heading = hm ? hm[1].trim() : null;
    bodyMd = chunk.raw.replace(/^##[ \t]+\d+\.[ \t]+.*\r?\n?/, '');
  } else {
    bodyMd = chunk.raw.replace(/^\d+\.[ \t]+/, '');
  }
  const sourceMatch = chunk.raw.match(/^[ \t]*source:[ \t]*(.+)$/mi);
  const statusMatch = chunk.raw.match(/watch-prices\.ts:\s*(ok|REVIEW|FETCH!)/);
  const fetchFailed = /FETCH FAILED, check manually/.test(chunk.raw) || statusMatch?.[1] === 'FETCH!';

  // content-miner.ts writes exactly `card: reports/og-cards/<file>.png` or `card: MISSING -- run \`npm run og:cards\``.
  const cardMatch = chunk.raw.match(/^[ \t]*card:[ \t]*(.+)$/mi);
  let cardFilename: string | null = null;
  let cardMissing = false;
  if (cardMatch) {
    const val = cardMatch[1].trim();
    if (/^MISSING\b/i.test(val)) cardMissing = true;
    else {
      const fileMatch = val.match(/reports\/og-cards\/([A-Za-z0-9._-]+\.png)/);
      if (fileMatch) cardFilename = fileMatch[1];
    }
  }

  const recordedMatch = chunk.raw.match(/^[ \t]*-?[ \t]*recorded:[ \t]*(.+)$/mi);
  const sourceUrlMatch = chunk.raw.match(/^[ \t]*-?[ \t]*source_url:[ \t]*(.+)$/mi);
  const snippetMatch = chunk.raw.match(/^[ \t]*-?[ \t]*fetched snippet:[ \t]*"?(.*?)"?[ \t]*$/mi);

  return {
    n: chunk.n,
    style,
    raw: chunk.raw,
    heading,
    bodyMd: bodyMd.trim(),
    sourceLine: sourceMatch ? sourceMatch[1].trim() : null,
    statusBadge: (statusMatch?.[1] as DisplayItem['statusBadge']) ?? null,
    fetchFailed,
    cardFilename,
    cardMissing,
    recordedLine: recordedMatch ? recordedMatch[1].trim() : null,
    fetchedSnippet: snippetMatch ? snippetMatch[1].trim() : null,
    priceHistory: null,
    currentPrice: null,
  };
}

/**
 * Pulls a model's dated price history out of data/changelog.json. The schema allows (but does not
 * require) a changelog entry to carry `model_id` + `input_per_mtok`/`output_per_mtok` recording what the
 * price became on that date -- entries without those fields (every entry in the real dataset today: just
 * "initial" and "correction" kind entries) are skipped, not guessed at. Pure and fixture-testable; the
 * real data/changelog.json has no price-change entries yet, so this returns [] against production data
 * and the UI falls back to "no history -- show the current price large" per the dashboard spec.
 */
export function extractModelPriceHistory(entries: unknown, modelId: string): PricePoint[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && (e as any).model_id === modelId)
    .filter((e) => typeof e.input_per_mtok === 'number' || typeof e.output_per_mtok === 'number')
    .filter((e) => typeof e.date === 'string')
    .map((e) => ({
      date: e.date as string,
      input: typeof e.input_per_mtok === 'number' ? (e.input_per_mtok as number) : null,
      output: typeof e.output_per_mtok === 'number' ? (e.output_per_mtok as number) : null,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

interface PricingModel {
  model_id: string;
  input_per_mtok: number;
  output_per_mtok: number;
  last_verified: string;
  source_url: string;
}

/** Fills priceHistory/currentPrice on a price-watch model-check item (statusBadge non-null). A no-op for every other item. */
export function enrichPriceWatchItem(item: DisplayItem, models: PricingModel[], changelogEntries: unknown): DisplayItem {
  if (item.statusBadge === null || !item.heading) return item;
  const modelId = item.heading;
  const model = models.find((m) => m.model_id === modelId) ?? null;
  const priceHistory = extractModelPriceHistory(changelogEntries, modelId);
  const currentPrice: CurrentPriceInfo | null = model
    ? { input: model.input_per_mtok, output: model.output_per_mtok, lastVerified: model.last_verified, sourceUrl: model.source_url }
    : null;
  return { ...item, priceHistory, currentPrice };
}

export interface DashboardFile {
  filename: string;
  date: string;
  producer: string; // meta.generated_by, or the filename stem as a fallback
  title: string | null;
  meta: Record<string, string>;
  itemStyle: ItemStyle;
  items: DisplayItem[];
  checklist: string[]; // price-watch's shared checklist steps, if this file has one
  introText: string; // prose before the first item (the whole body, for 'none' style)
  mtimeMs: number;
}

function firstNonBlankLine(text: string): string | null {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t) return t;
  }
  return null;
}

export function parseQueueFile(raw: string, date: string, filename: string, mtimeMs: number): DashboardFile {
  const { meta, body } = splitFrontmatter(raw);
  const { title, rest } = splitTitle(body);
  const itemStyle = detectItemStyle(rest);
  const chunks = splitItemChunks(rest, itemStyle);
  const items = chunks.map((c) => toDisplayItem(c, itemStyle));
  const checklist = extractChecklistSteps(rest);
  const introText = itemStyle === 'none' ? rest.trim() : (firstNonBlankLine(rest) ?? '');
  const stem = filename.replace(/\.md$/, '');
  return {
    filename,
    date,
    producer: meta.generated_by || stem,
    title,
    meta,
    itemStyle,
    items,
    checklist,
    introText,
    mtimeMs,
  };
}

// ---------------------------------------------------------------------------
// Filesystem I/O -- dates, files, run health, archiving. Thin wrappers around
// the pure logic above; kept separate so the pure logic never needs a real
// disk to test.
// ---------------------------------------------------------------------------

export function listUnarchivedDates(queueRoot: string): string[] {
  if (!existsSync(queueRoot)) return [];
  return readdirSync(queueRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && DATE_RE.test(d.name))
    .map((d) => d.name)
    .sort()
    .reverse();
}

export function readDateFiles(queueRoot: string, date: string): DashboardFile[] {
  const dir = resolveQueueDateDir(queueRoot, date);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((filename) => {
      const abs = join(dir, filename);
      const raw = readFileSync(abs, 'utf8');
      const st = statSync(abs);
      return parseQueueFile(raw, date, filename, st.mtimeMs);
    });
}

export interface ProducerHealth {
  id: string;
  label: string;
  script: string;
  logPath: string;
  errLogPath: string;
  lastRunAt: string | null;
  lastOutcome: string | null;
  source: 'log' | 'queue-file' | 'none';
  hasErrorLog: boolean;
  fetchFailed: boolean;
}

const KNOWN_PRODUCERS: { id: string; label: string; script: string; file: string }[] = [
  { id: 'content-miner', label: 'Content miner', script: 'scripts/content-miner.ts', file: 'content-miner.md' },
  { id: 'price-watch', label: 'Price watch', script: 'scripts/price-watch-draft.ts', file: 'price-watch.md' },
];

function tailLines(filePath: string, n: number): string[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.slice(-n);
}

/** Read-only peek at queue/_state/logs/*.log (launchd's StandardOutPath/StandardErrorPath), never written by this server. */
export function buildRunHealth(queueRoot: string, latestDate: string | null, latestFiles: DashboardFile[]): ProducerHealth[] {
  const logsDir = join(queueRoot, '_state', 'logs');
  return KNOWN_PRODUCERS.map(({ id, label, script, file }) => {
    const logPath = join(logsDir, `${id}.log`);
    const errLogPath = join(logsDir, `${id}.err.log`);
    let lastRunAt: string | null = null;
    let lastOutcome: string | null = null;
    let source: ProducerHealth['source'] = 'none';

    if (existsSync(logPath) && statSync(logPath).size > 0) {
      lastRunAt = statSync(logPath).mtime.toISOString();
      const tail = tailLines(logPath, 5);
      lastOutcome = tail.at(-1) ?? null;
      source = 'log';
    }

    const todayFile = latestFiles.find((f) => f.filename === file);
    if (!lastRunAt && todayFile) {
      lastRunAt = todayFile.meta.run_at ?? null;
      lastOutcome = todayFile.introText || null;
      source = lastRunAt ? 'queue-file' : 'none';
    }

    const hasErrorLog = existsSync(errLogPath) && statSync(errLogPath).size > 0;
    const fileFetchFailed = !!todayFile?.items.some((it) => it.fetchFailed);
    const outcomeFetchFailed = !!(lastOutcome && /FETCH FAILED|FETCH!/.test(lastOutcome));

    return {
      id, label, script, logPath, errLogPath,
      lastRunAt, lastOutcome, source,
      hasErrorLog,
      fetchFailed: hasErrorLog || fileFetchFailed || outcomeFetchFailed,
    };
  });
}

export function archiveDate(queueRoot: string, date: string): void {
  const src = resolveQueueDateDir(queueRoot, date);
  if (!existsSync(src)) throw new PathGuardError(`no such date: ${date}`);
  const archiveRoot = resolve(queueRoot, '_archive');
  mkdirSync(archiveRoot, { recursive: true });
  const dst = resolve(archiveRoot, date);
  if (!(dst + sep).startsWith(resolve(queueRoot) + sep)) throw new PathGuardError('archive target escapes queue root');
  if (existsSync(dst)) throw new PathGuardError(`${date} is already archived`);
  renameSync(src, dst);
}

/** Read-only listing of queue/_archive/<date> dirs -- the streak counter's raw material (client combines it with today's local ring state). */
export function listArchivedDates(queueRoot: string): string[] {
  const dir = resolve(queueRoot, '_archive');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && DATE_RE.test(d.name))
    .map((d) => d.name)
    .sort();
}

// ---------------------------------------------------------------------------
// og-card images (v2). Read-only, same guard discipline as queue/ above:
// regex filename validation + a resolved-path prefix assertion. This never
// serves anything outside reports/og-cards/, and never serves a non-.png.
// ---------------------------------------------------------------------------

export const OG_CARDS_ROOT = join(ROOT, 'reports', 'og-cards');
const OG_CARD_FILENAME_RE = /^[A-Za-z0-9._-]+\.png$/;

export function resolveOgCardFile(ogCardsRoot: string, filename: string): string {
  if (!OG_CARD_FILENAME_RE.test(filename)) throw new PathGuardError(`invalid og-card filename: ${JSON.stringify(filename)}`);
  const dir = resolve(ogCardsRoot);
  const abs = resolve(dir, filename);
  if (dirname(abs) !== dir) throw new PathGuardError('og-card path escapes reports/og-cards');
  return abs;
}

// ---------------------------------------------------------------------------
// data/ (v2). Read-only, always the real repo's data/ regardless of QUEUE_DIR
// -- SOLVENCY_DATA_DIR overrides it only for tests/fixtures, matching the
// convention scripts/load.ts already uses. Nothing under this file ever
// writes here; see the price-watch README note above.
// ---------------------------------------------------------------------------

const DATA_ROOT = process.env.SOLVENCY_DATA_DIR ?? join(ROOT, 'data');

function readJsonSafe(path: string): any {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** Loads data/models.json + data/changelog.json for price-watch enrichment. Tolerant of a missing/malformed file -- returns empty arrays rather than throwing, since this only ever feeds a display enhancement. */
export function loadPricingContext(dataRoot: string): { models: PricingModel[]; changelogEntries: unknown[] } {
  const modelsJson = readJsonSafe(join(dataRoot, 'models.json'));
  const changelogJson = readJsonSafe(join(dataRoot, 'changelog.json'));
  return {
    models: Array.isArray(modelsJson?.models) ? modelsJson.models : [],
    changelogEntries: Array.isArray(changelogJson?.entries) ? changelogJson.entries : [],
  };
}

// ---------------------------------------------------------------------------
// Whole-dashboard state assembly + the honest one-line summary.
// ---------------------------------------------------------------------------

/** "Overnight in numbers" strip -- every figure here is read straight off real state, nothing invented. */
export interface OvernightNumbers {
  draftsWaiting: number; // content-miner.md's item count, latest date
  modelsRechecked: number | null; // the "N of M models flagged" M, parsed from price-watch.md's intro line
  daysSinceLaunch: number | null; // today minus the earliest data/changelog.json entry date
}

/** Whole-day difference between two ISO yyyy-mm-dd dates (positive when b is later than a). */
export function daysBetweenIso(aIso: string, bIso: string): number {
  const a = Date.parse(`${aIso}T00:00:00Z`);
  const b = Date.parse(`${bIso}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

function computeOvernightNumbers(dates: { date: string; files: DashboardFile[] }[], today: string, changelogEntries: unknown[]): OvernightNumbers {
  const latest = dates[0];
  const contentMinerFile = latest?.files.find((f) => f.filename === 'content-miner.md');
  const priceWatchFile = latest?.files.find((f) => f.filename === 'price-watch.md');

  const draftsWaiting = contentMinerFile?.items.length ?? 0;
  const recheckMatch = priceWatchFile?.introText.match(/^\d+ of (\d+) models flagged/);
  const modelsRechecked = recheckMatch ? Number(recheckMatch[1]) : null;

  const dates2 = Array.isArray(changelogEntries)
    ? (changelogEntries as any[]).map((e) => (e && typeof e.date === 'string' ? e.date : null)).filter((d): d is string => !!d).sort()
    : [];
  const earliest = dates2[0] ?? null;
  const daysSinceLaunch = earliest ? daysBetweenIso(earliest, today) : null;

  return { draftsWaiting, modelsRechecked, daysSinceLaunch };
}

export interface DashboardState {
  generatedAt: string;
  today: string; // the server's local date, ISO yyyy-mm-dd -- for the masthead dateline
  latestDate: string | null;
  dates: { date: string; files: DashboardFile[] }[]; // most recent first
  runHealth: ProducerHealth[];
  summary: string;
  isAllClear: boolean;
  archivedDates: string[]; // queue/_archive/<date> dirs, oldest first -- streak raw material
  overnightNumbers: OvernightNumbers;
}

function localIsoDate(d: Date): string {
  const tz = d.getTimezoneOffset();
  const local = new Date(d.getTime() - tz * 60_000);
  return local.toISOString().slice(0, 10);
}

function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function summarize(dates: DashboardState['dates'], runHealth: ProducerHealth[]): { summary: string; isAllClear: boolean } {
  const latest = dates[0];
  const contentMinerFile = latest?.files.find((f) => f.filename === 'content-miner.md');
  const priceWatchFile = latest?.files.find((f) => f.filename === 'price-watch.md');
  const otherFiles = latest?.files.filter((f) => f.filename !== 'content-miner.md' && f.filename !== 'price-watch.md') ?? [];

  const draftCount = contentMinerFile?.items.length ?? 0;
  const flagMatch = priceWatchFile?.introText.match(/^(\d+) of \d+ models flagged/);
  const priceFlags = flagMatch ? Number(flagMatch[1]) : (priceWatchFile?.items.length ?? 0);
  const otherItems = otherFiles.reduce((sum, f) => sum + Math.max(f.items.length, f.itemStyle === 'none' ? 0 : 0), 0);
  const otherDocs = otherFiles.filter((f) => f.items.length > 0 || f.itemStyle !== 'none').length;

  const anyFetchFailed = runHealth.some((h) => h.fetchFailed);
  const bothKnownClean = runHealth.length > 0 && runHealth.every((h) => !h.fetchFailed && !h.hasErrorLog);

  const parts: string[] = [];
  if (draftCount > 0) parts.push(pluralize(draftCount, 'draft'));
  if (priceFlags > 0) parts.push(pluralize(priceFlags, 'price flag'));
  if (otherItems > 0) parts.push(`${otherItems} more from ${pluralize(otherDocs, 'other producer')}`);
  else if (otherDocs > 0) parts.push(`${pluralize(otherDocs, 'other dispatch')} waiting on you`);

  const runsClause = anyFetchFailed
    ? `${runHealth.filter((h) => h.fetchFailed).map((h) => h.label).join(' and ')} needs a look`
    : (bothKnownClean ? 'both nightly runs clean' : null);

  const isAllClear = parts.length === 0 && !anyFetchFailed;

  if (isAllClear) {
    return { summary: bothKnownClean ? 'Nothing overnight needs you. Both nightly runs clean.' : 'Nothing overnight needs you.', isAllClear: true };
  }
  const full = runsClause ? [...parts, runsClause] : parts;
  return { summary: `${full.join(', ')}.`, isAllClear: false };
}

export function buildState(queueRoot: string, dataRoot: string = DATA_ROOT): DashboardState {
  const dateNames = listUnarchivedDates(queueRoot);
  const { models, changelogEntries } = loadPricingContext(dataRoot);
  const dates = dateNames.map((date) => ({
    date,
    files: readDateFiles(queueRoot, date).map((f) => ({
      ...f,
      items: f.items.map((it) => enrichPriceWatchItem(it, models, changelogEntries)),
    })),
  }));
  const runHealth = buildRunHealth(queueRoot, dates[0]?.date ?? null, dates[0]?.files ?? []);
  const { summary, isAllClear } = summarize(dates, runHealth);
  const today = localIsoDate(new Date());
  return {
    generatedAt: new Date().toISOString(),
    today,
    latestDate: dates[0]?.date ?? null,
    dates,
    runHealth,
    summary,
    isAllClear,
    archivedDates: listArchivedDates(queueRoot),
    overnightNumbers: computeOvernightNumbers(dates, today, changelogEntries),
  };
}

/** Cheap mtime fingerprint so the server can skip a full reparse when nothing under queue/ (or the read-only data/ inputs) changed. */
export function stateFingerprint(queueRoot: string, dataRoot: string = DATA_ROOT): string {
  const dates = listUnarchivedDates(queueRoot);
  const parts: string[] = [];
  for (const date of dates) {
    const dir = resolveQueueDateDir(queueRoot, date);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
      parts.push(`${date}/${f}:${statSync(join(dir, f)).mtimeMs}`);
    }
  }
  const logsDir = join(queueRoot, '_state', 'logs');
  if (existsSync(logsDir)) {
    for (const f of readdirSync(logsDir).sort()) {
      parts.push(`log:${f}:${statSync(join(logsDir, f)).mtimeMs}`);
    }
  }
  for (const f of ['models.json', 'changelog.json']) {
    const abs = join(dataRoot, f);
    if (existsSync(abs)) parts.push(`data:${f}:${statSync(abs).mtimeMs}`);
  }
  return parts.join('|');
}

// ---------------------------------------------------------------------------
// HTTP server. Bound to 127.0.0.1 only. Every route that touches disk routes
// through resolveQueueDateDir/resolveQueueFile above.
// ---------------------------------------------------------------------------

function readJsonBody(req: import('node:http').IncomingMessage): Promise<any> {
  return new Promise((resolvePromise, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 1_000_000) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolvePromise({});
      try { resolvePromise(JSON.parse(data)); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

export function startServer(queueRoot: string, port: number) {
  // A tiny mtime-fingerprint cache: /api/state reparses only when something
  // under queue/ actually changed since the last request ("simple mtime
  // polling" -- the client polls this endpoint; the server does the cheap
  // half of the work).
  let cachedFingerprint = '';
  let cachedState: DashboardState | null = null;

  function getState(): DashboardState {
    const fp = stateFingerprint(queueRoot);
    if (cachedState && fp === cachedFingerprint) return cachedState;
    cachedState = buildState(queueRoot);
    cachedFingerprint = fp;
    return cachedState;
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;

      if (req.method === 'GET' && path === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderPage());
        return;
      }

      if (req.method === 'GET' && path === '/api/state') {
        sendJson(res, 200, getState());
        return;
      }

      if (req.method === 'DELETE' && path === '/api/item') {
        const body = await readJsonBody(req);
        const { date, filename, n } = body ?? {};
        if (typeof date !== 'string' || typeof filename !== 'string' || typeof n !== 'number') {
          sendJson(res, 400, { error: 'expected { date, filename, n }' });
          return;
        }
        const abs = resolveQueueFile(queueRoot, date, filename);
        if (!existsSync(abs)) { sendJson(res, 404, { error: 'no such file' }); return; }
        const raw = readFileSync(abs, 'utf8');
        const next = deleteItemFromMarkdown(raw, n);
        writeFileSync(abs, next);
        cachedState = null; // force a reparse on next /api/state
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && path === '/api/archive') {
        const body = await readJsonBody(req);
        const { date } = body ?? {};
        if (typeof date !== 'string') { sendJson(res, 400, { error: 'expected { date }' }); return; }
        archiveDate(queueRoot, date);
        cachedState = null;
        sendJson(res, 200, { ok: true });
        return;
      }

      // Read-only PNG serving for content-miner's draft image cards, confined to
      // reports/og-cards/ by resolveOgCardFile's regex + resolved-path guard --
      // identical discipline to resolveQueueFile above, just a different root.
      if (req.method === 'GET' && path === '/api/og-card') {
        const filename = url.searchParams.get('file') ?? '';
        const abs = resolveOgCardFile(OG_CARDS_ROOT, filename);
        if (!existsSync(abs)) { sendJson(res, 404, { error: 'no such card' }); return; }
        const data = readFileSync(abs);
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': data.length,
          'cache-control': 'no-store',
        });
        res.end(data);
        return;
      }

      if (req.method === 'POST' && path === '/api/open-file') {
        const body = await readJsonBody(req);
        const { date, filename } = body ?? {};
        if (typeof date !== 'string' || typeof filename !== 'string') {
          sendJson(res, 400, { error: 'expected { date, filename }' });
          return;
        }
        const abs = resolveQueueFile(queueRoot, date, filename);
        if (!existsSync(abs)) { sendJson(res, 404, { error: 'no such file' }); return; }
        if (process.platform === 'darwin') {
          spawn('open', [abs], { stdio: 'ignore', detached: true }).unref();
          sendJson(res, 200, { ok: true, path: abs });
        } else {
          sendJson(res, 200, { ok: false, path: abs, reason: 'open-file is macOS-only; path returned for manual use' });
        }
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      const status = err instanceof PathGuardError ? 400 : 500;
      sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  server.listen(port, '127.0.0.1');
  return server;
}

// ---------------------------------------------------------------------------
// The dashboard page itself. See docs/redesign-2026-08/direction.md for the
// token family this is built from (cream/ink/purple/amber, Source Serif 4 /
// IBM Plex Sans / JetBrains Mono). Everything is inlined into one response --
// no separate asset requests, so this server never has to read anything
// outside queue/ at request time.
// ---------------------------------------------------------------------------

function renderPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Solvency · Overnight</title>
<style>${CSS}</style>
</head>
<body>
<div id="dawn" aria-hidden="true"></div>
<div id="app"></div>
<footer class="foot">
  <span class="kbd">j</span><span class="kbd">k</span> select card
  &nbsp;·&nbsp; <span class="kbd">c</span> copy
  &nbsp;·&nbsp; <span class="kbd">d</span> delete
  &nbsp;·&nbsp; click a card to select it
</footer>
<script>${CLIENT_JS}</script>
</body>
</html>`;
}

const CSS = String.raw`
:root {
  --bg: #F8F6EE; --panel: #FFFFFF; --panel-2: #F4F3F1; --panel-3: #E6E4DF;
  --ink: #1A1D20; --body: #3E464C; --muted: #5F6B73;
  --rule: #E2E0DC; --rule-strong: #CFCCC6;
  --purple: #6C3BF4; --amber: #9A6410; --amber-fill: #E0A02E; --wine: #7B1E3D; --good: #1B7F4F;
  --shadow: 0 1px 2px rgb(20 16 8 / .05), 0 8px 24px rgb(20 16 8 / .05);
  --radius: 10px;
}
:root[data-theme="dark"] {
  --bg: #0A0C0D; --panel: #10151A; --panel-2: #151B20; --panel-3: #1B2228;
  --ink: #E8ECEF; --body: #B8C0C6; --muted: #838E95;
  --rule: #232B31; --rule-strong: #333D45;
  --purple: #A78BFA; --amber: #E0A02E; --amber-fill: #E0A02E; --wine: #E1618C; --good: #45C08A;
  --shadow: 0 1px 2px rgb(0 0 0 / .3), 0 8px 28px rgb(0 0 0 / .35);
}
* { box-sizing: border-box; }
html, body { background: var(--bg); }
body {
  margin: 0; color: var(--ink); font-family: "IBM Plex Sans", -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased; padding-bottom: 3.5rem;
}
#dawn { height: 9px; width: 100%; background: var(--dawn-gradient, linear-gradient(90deg, var(--purple), var(--amber-fill))); background-size: 200% 100%; }
@media (prefers-reduced-motion: no-preference) {
  #dawn { animation: dawn-drift 50s linear infinite; }
  @keyframes dawn-drift { from { background-position: 0% 0; } to { background-position: 100% 0; } }
}
a { color: inherit; }
code { font-family: "JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; background: var(--panel-2); padding: .1em .35em; border-radius: 4px; font-size: .92em; }
blockquote { margin: .5rem 0; padding: .1rem 0 .1rem .85rem; border-left: 3px solid var(--rule-strong); color: var(--body); }
.wrap { max-width: 62rem; margin: 0 auto; padding: 0 1.5rem; }
.mono { font-family: "JetBrains Mono", ui-monospace, monospace; }

.masthead { padding: 2.1rem 0 1.4rem; }
.kicker { font-family: "JetBrains Mono", ui-monospace, monospace; font-size: .72rem; letter-spacing: .22em; color: var(--muted); text-transform: uppercase; }
.dateline { font-family: "Source Serif 4", ui-serif, "New York", Charter, Georgia, serif; font-weight: 600; letter-spacing: -.02em;
  font-size: clamp(1.9rem, 4.4vw, 2.7rem); margin: .35rem 0 .55rem; line-height: 1.05; }
.summary { font-size: 1.02rem; color: var(--body); max-width: 42rem; }
.summary.clear { color: var(--good); }
.theme-toggle { position: absolute; top: 1.1rem; right: 1.5rem; background: none; border: 1px solid var(--rule-strong);
  color: var(--muted); border-radius: 999px; width: 2.1rem; height: 2.1rem; cursor: pointer; font-size: .95rem; }
.theme-toggle:hover { border-color: var(--purple); color: var(--purple); }
.masthead-row { position: relative; }

.rule { border: 0; border-top: 1px solid var(--rule-strong); margin: 0; }
.rule-thin { border-top: 1px solid var(--rule); margin-top: 3px; }

/* --- hero: progress ring + streak ------------------------------------- */
.hero-row { display: flex; align-items: center; gap: 2rem; flex-wrap: wrap; padding: .4rem 0 1.6rem; }
.ring-block { display: flex; flex-direction: column; align-items: center; gap: .5rem; }
.ring-wrap { position: relative; width: 132px; height: 132px; }
.ring { transform: rotate(-90deg); }
.ring-track { fill: none; stroke: var(--panel-3); stroke-width: 10; }
.ring-fill { fill: none; stroke: var(--purple); stroke-width: 10; stroke-linecap: round; }
@media (prefers-reduced-motion: no-preference) {
  .ring-fill { transition: stroke-dashoffset .7s cubic-bezier(.22,.8,.32,1), stroke .4s ease; }
}
.ring-wrap.complete .ring-fill { stroke: var(--good); }
.ring-center { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; flex-direction: column; }
.ring-big { font-family: "Source Serif 4", ui-serif, Georgia, serif; font-weight: 600; font-size: 2.1rem; line-height: 1; color: var(--ink); }
.ring-wrap.complete .ring-big { color: var(--good); }
.ring-slash { font-family: "JetBrains Mono", monospace; font-size: 1.1rem; color: var(--muted); font-weight: 400; }
.ring-caption { font-size: .82rem; color: var(--muted); text-align: center; }
.ring-caption.complete { color: var(--good); font-weight: 600; }

.streak-tile { display: flex; align-items: center; gap: .75rem; background: var(--panel); border: 1px solid var(--rule);
  border-radius: var(--radius); padding: .9rem 1.25rem; box-shadow: var(--shadow); }
.streak-flame { font-size: 1.7rem; line-height: 1; }
.streak-num { font-family: "Source Serif 4", serif; font-weight: 600; font-size: 1.9rem; line-height: 1; }
.streak-label { font-size: .78rem; color: var(--muted); align-self: flex-end; padding-bottom: .2rem; }

/* --- overnight in numbers strip ---------------------------------------- */
.numbers-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: .75rem; width: 100%; margin-top: .3rem; }
.num-tile { background: var(--panel-2); border: 1px solid var(--rule); border-radius: var(--radius); padding: .8rem 1rem; }
.num-value { font-family: "Source Serif 4", serif; font-weight: 600; font-size: 1.6rem; line-height: 1.1; }
.num-label { font-family: "JetBrains Mono", monospace; font-size: .68rem; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); margin-top: .25rem; }

.backlog { margin: 1rem 0 0; padding: .6rem .9rem; border: 1px solid var(--amber-fill); border-radius: var(--radius);
  background: color-mix(in srgb, var(--amber-fill) 10%, var(--panel)); font-size: .85rem; }
.backlog a { color: var(--amber); font-weight: 600; text-decoration: none; border-bottom: 1px solid currentColor; }

/* --- night crew row ----------------------------------------------------- */
.crew-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); gap: .85rem; margin: 1.4rem 0; }
.crew-card { display: flex; align-items: center; gap: .8rem; background: var(--panel); border: 1px solid var(--rule);
  border-left: 3px solid var(--rule-strong); border-radius: var(--radius); padding: .8rem 1rem; box-shadow: var(--shadow); }
.crew-card.fail { border-left-color: var(--wine); background: color-mix(in srgb, var(--wine) 6%, var(--panel)); }
.crew-avatar { font-size: 1.6rem; line-height: 1; flex: 0 0 auto; }
.crew-body { flex: 1; min-width: 0; }
.crew-name { font-family: "Source Serif 4", serif; font-weight: 600; font-size: 1.02rem; }
.crew-meta { font-family: "JetBrains Mono", monospace; font-size: .7rem; color: var(--muted); margin-top: .1rem; }
.crew-note { font-size: .78rem; color: var(--muted); margin-top: .2rem; }
.crew-right { display: flex; flex-direction: column; align-items: flex-end; gap: .3rem; flex: 0 0 auto; }
.crew-count { font-family: "JetBrains Mono", monospace; font-size: .7rem; color: var(--muted); }
.status-chip { font-family: "JetBrains Mono", monospace; font-size: .64rem; letter-spacing: .06em; text-transform: uppercase;
  border-radius: 999px; padding: .18rem .55rem; font-weight: 700; border: 1px solid transparent; white-space: nowrap; }
.status-chip.clean { color: var(--good); border-color: var(--good); background: color-mix(in srgb, var(--good) 10%, transparent); }
.status-chip.fail { color: #fff; background: var(--wine); border-color: var(--wine); }

section.producer { margin: 2.1rem 0; }
.producer-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: .6rem; }
.producer-name { font-family: "Source Serif 4", ui-serif, Georgia, serif; font-weight: 600; font-size: 1.28rem; letter-spacing: -.01em; }
.producer-meta { font-family: "JetBrains Mono", monospace; font-size: .72rem; color: var(--muted); text-align: right; }
.producer-meta .warn { color: var(--wine); font-weight: 700; }
.producer-meta .ok { color: var(--good); }

.intro { font-size: .92rem; color: var(--muted); padding: .75rem 0 .3rem; }

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(19.5rem, 1fr)); gap: .85rem; margin-top: .8rem; }
.grid.wide { grid-template-columns: 1fr; }

.card { position: relative; background: var(--panel); border: 1px solid var(--rule); border-radius: var(--radius);
  padding: .95rem 1rem .8rem; box-shadow: var(--shadow); border-left: 3px solid var(--rule-strong);
  display: flex; flex-direction: column; gap: .5rem; }
@media (prefers-reduced-motion: no-preference) {
  .card { transition: opacity .2s ease, transform .2s ease; }
}
.card.removing { opacity: 0; transform: translateY(-6px) scale(.98); pointer-events: none; }
.card.needs-review { border-left-color: var(--amber-fill); }
.card.fetch-failed { border-left-color: var(--wine); }
.card.selected { outline: 2px solid var(--purple); outline-offset: 2px; }
.card.kept { opacity: .55; }
.card-top { display: flex; align-items: flex-start; justify-content: space-between; gap: .5rem; }
.idx { font-family: "JetBrains Mono", monospace; font-size: .72rem; color: var(--muted); }
.badge { font-family: "JetBrains Mono", monospace; font-size: .64rem; letter-spacing: .08em; text-transform: uppercase;
  border-radius: 4px; padding: .12rem .4rem; font-weight: 700; }
.badge.review { background: color-mix(in srgb, var(--amber-fill) 22%, transparent); color: var(--amber); }
.badge.fetch { background: color-mix(in srgb, var(--wine) 18%, transparent); color: var(--wine); }
.keep-btn { border: 1px solid var(--rule-strong); background: none; color: var(--muted); border-radius: 999px;
  width: 1.5rem; height: 1.5rem; cursor: pointer; font-size: .78rem; line-height: 1; }
.keep-btn.on { border-color: var(--purple); color: var(--purple); background: color-mix(in srgb, var(--purple) 12%, transparent); }
@media (prefers-reduced-motion: no-preference) {
  .keep-btn.pulse { animation: keep-pulse .32s ease; }
  @keyframes keep-pulse { 0% { transform: scale(1); } 50% { transform: scale(1.3); } 100% { transform: scale(1); } }
}

.card-heading { font-weight: 600; font-size: .96rem; }
.card-heading.mono { font-family: "JetBrains Mono", monospace; font-weight: 600; font-size: .82rem; color: var(--body); }
.card-body { font-size: .89rem; line-height: 1.5; color: var(--ink); }
.card-body p { margin: 0 0 .5rem; }
.card-body p:last-child { margin-bottom: 0; }
.src { font-family: "JetBrains Mono", monospace; font-size: .74rem; color: var(--muted); margin-top: .1rem; }
.sub-head { font-weight: 700; font-size: .82rem; letter-spacing: .01em; margin: .6rem 0 .1rem; color: var(--muted); text-transform: uppercase; }

.actions { display: flex; gap: .4rem; margin-top: auto; padding-top: .3rem; }
.actions button { font-family: "JetBrains Mono", monospace; font-size: .7rem; letter-spacing: .03em; text-transform: uppercase;
  background: none; border: 1px solid var(--rule-strong); color: var(--body); border-radius: 6px; padding: .3rem .55rem; cursor: pointer; }
.actions button:hover { border-color: var(--purple); color: var(--purple); }
.actions button.danger:hover { border-color: var(--wine); color: var(--wine); }

/* --- content-miner draft image cards ------------------------------------ */
.img-card-list { display: flex; flex-direction: column; gap: .9rem; margin-top: .8rem; }
.img-card { flex-direction: row; align-items: flex-start; gap: 1.1rem; }
.img-card-media { flex: 0 0 15rem; }
.card-thumb { display: block; width: 100%; aspect-ratio: 1200 / 630; object-fit: cover; border-radius: 8px; border: 1px solid var(--rule); background: var(--panel-2); }
.card-thumb.missing { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .2rem;
  border: 1px dashed var(--rule-strong); color: var(--muted); text-align: center; padding: .5rem; }
.card-thumb.missing .thumb-glyph { font-size: 1.4rem; opacity: .7; }
.card-thumb.missing .thumb-note { font-size: .74rem; }
.card-thumb.missing .thumb-hint { font-family: "JetBrains Mono", monospace; font-size: .68rem; }
.img-card-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: .5rem; }

/* --- price-watch sparkline / stat cards ---------------------------------- */
.spark-wrap { position: relative; margin: .2rem 0 .1rem; }
.sparkline { display: block; }
.spark-line { stroke: var(--purple); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.spark-dot { fill: var(--amber-fill); stroke: var(--panel); stroke-width: 1.5; }
.spark-caption { display: flex; justify-content: space-between; font-family: "JetBrains Mono", monospace; font-size: .7rem; color: var(--muted); margin-top: .2rem; }
.spark-current { color: var(--ink); font-weight: 600; }
.spark-tip { position: absolute; top: -1.7rem; transform: translateX(-50%); background: var(--ink); color: var(--bg);
  font-family: "JetBrains Mono", monospace; font-size: .66rem; padding: .16rem .45rem; border-radius: 4px; white-space: nowrap; pointer-events: none; z-index: 2; }
.price-noHistory { padding: .4rem 0 .2rem; }
.price-big { font-family: "Source Serif 4", serif; font-weight: 600; font-size: 1.7rem; }
.price-unit { font-family: "JetBrains Mono", monospace; font-size: .85rem; color: var(--muted); font-weight: 400; margin-left: .2rem; }
.price-sub { font-family: "JetBrains Mono", monospace; font-size: .72rem; color: var(--muted); margin-top: .15rem; }

/* --- compact stepper (price-watch checklist) ---------------------------- */
.stepper { background: var(--panel-2); border: 1px solid var(--rule); border-radius: var(--radius); padding: .9rem 1.1rem; margin-bottom: .9rem; }
.stepper-head { font-family: "JetBrains Mono", monospace; font-size: .68rem; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin-bottom: .7rem; }
.stepper-row { display: flex; align-items: flex-start; }
.step { display: flex; flex-direction: column; align-items: center; gap: .35rem; cursor: pointer; max-width: 8rem; }
.step-dot { width: 1.6rem; height: 1.6rem; border-radius: 999px; border: 1px solid var(--rule-strong); background: var(--panel);
  display: flex; align-items: center; justify-content: center; font-family: "JetBrains Mono", monospace; font-size: .7rem; color: var(--muted); flex: 0 0 auto; }
.step.done .step-dot { background: var(--purple); border-color: var(--purple); color: #fff; }
.step-label { font-size: .72rem; color: var(--muted); text-align: center; line-height: 1.3; }
.step.done .step-label { color: var(--ink); text-decoration: line-through; }
.step-line { flex: 1; height: 1px; background: var(--rule-strong); margin-top: .8rem; min-width: .6rem; }
.step.done + .step-line { background: var(--purple); }

.checklist { background: var(--panel-2); border: 1px solid var(--rule); border-radius: var(--radius); padding: .8rem 1rem; margin-bottom: .9rem; }
.checklist .cl-title { font-family: "JetBrains Mono", monospace; font-size: .68rem; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin-bottom: .5rem; }
.cl-item { display: flex; align-items: flex-start; gap: .5rem; font-size: .87rem; padding: .18rem 0; }
.cl-item input { margin-top: .18rem; accent-color: var(--purple); }
.cl-item.done label { text-decoration: line-through; color: var(--muted); }

.archive-btn { font-family: "JetBrains Mono", monospace; font-size: .72rem; border: 1px solid var(--rule-strong);
  background: none; color: var(--body); border-radius: 6px; padding: .35rem .7rem; cursor: pointer; }
.archive-btn:hover { border-color: var(--purple); color: var(--purple); }
.date-block-head { display: flex; align-items: center; justify-content: space-between; margin: 1.6rem 0 .2rem; }
.date-block-head h2 { font-family: "Source Serif 4", serif; font-weight: 600; font-size: 1.25rem; margin: 0; }

.empty { text-align: center; padding: 4rem 1rem 3rem; }
.empty .glyph { font-size: 1.6rem; margin-bottom: .8rem; opacity: .8; }
.empty .lede { font-family: "Source Serif 4", serif; font-weight: 600; font-size: 1.7rem; letter-spacing: -.01em; }
.empty .sub { color: var(--muted); margin-top: .5rem; font-size: .95rem; }

.foot { position: fixed; bottom: 0; left: 0; right: 0; background: var(--panel); border-top: 1px solid var(--rule);
  font-family: "JetBrains Mono", monospace; font-size: .72rem; color: var(--muted); text-align: center; padding: .55rem 1rem; }
.kbd { display: inline-block; border: 1px solid var(--rule-strong); border-radius: 4px; padding: .02rem .35rem; margin: 0 .1rem; color: var(--ink); }

@media (max-width: 640px) {
  .wrap { padding: 0 1rem; }
  .grid { grid-template-columns: 1fr; }
  .theme-toggle { position: static; margin-bottom: .6rem; }
  .hero-row { gap: 1.1rem; }
  .img-card { flex-direction: column; }
  .img-card-media { flex-basis: auto; width: 100%; }
  .crew-row { grid-template-columns: 1fr; }
  .stepper-row { flex-wrap: wrap; row-gap: .8rem; }
}
`;

const CLIENT_JS = String.raw`
(function () {
  'use strict';

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // --- theme -----------------------------------------------------------
  var THEME_KEY = 'solvency-dash-theme';
  function applyTheme(t) { document.documentElement.setAttribute('data-theme', t); }
  (function initTheme() {
    var stored = null;
    try { stored = localStorage.getItem(THEME_KEY); } catch (e) {}
    var initial = stored || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    applyTheme(initial);
  })();

  // --- dawn ribbon: the one flourish, tied to the actual local hour ----
  function dawnGradient(date) {
    var h = date.getHours() + date.getMinutes() / 60;
    var stops = [
      [0,  '#241A3D', '#2E2350'],
      [4,  '#2A2049', '#4B3468'],
      [6,  '#4A3568', '#C97A4A'],
      [7.5,'#E7B98A', '#F8F6EE'],
      [11, '#F8F6EE', '#F8F6EE'],
      [17, '#F8F6EE', '#E7B98A'],
      [19, '#C97A4A', '#4B3468'],
      [22, '#2E2350', '#241A3D'],
      [24, '#241A3D', '#2E2350']
    ];
    function hex2rgb(hx) { var n = parseInt(hx.slice(1), 16); return [(n>>16)&255,(n>>8)&255,n&255]; }
    function lerp(a,b,t){ return Math.round(a+(b-a)*t); }
    var i = 0;
    while (i < stops.length - 1 && !(h >= stops[i][0] && h <= stops[i+1][0])) i++;
    var a = stops[i], b = stops[Math.min(i+1, stops.length-1)];
    var t = b[0] === a[0] ? 0 : (h - a[0]) / (b[0] - a[0]);
    function mix(ca, cb) {
      var ra = hex2rgb(ca), rb = hex2rgb(cb);
      return 'rgb(' + lerp(ra[0],rb[0],t) + ',' + lerp(ra[1],rb[1],t) + ',' + lerp(ra[2],rb[2],t) + ')';
    }
    return 'linear-gradient(90deg, ' + mix(a[1], b[1]) + ', ' + mix(a[2], b[2]) + ')';
  }
  function paintDawn() {
    document.documentElement.style.setProperty('--dawn-gradient', dawnGradient(new Date()));
  }
  paintDawn();
  setInterval(paintDawn, 5 * 60 * 1000);

  // --- markdown-lite -----------------------------------------------------
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }
  function inline(s) {
    s = esc(s);
    s = s.replace(/\`([^\`]+)\`/g, '<code>$1<\/code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1<\/strong>');
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1<\/a>');
    return s;
  }
  function renderMarkdownLite(raw) {
    var lines = raw.split('\n');
    var html = '';
    var para = [];
    function flush() {
      if (para.length) { html += '<p>' + para.map(inline).join('<br>') + '<\/p>'; para = []; }
    }
    lines.forEach(function (line) {
      var t = line.trim();
      if (!t) { flush(); return; }
      if (/^source:/i.test(t)) { flush(); html += '<div class="src">' + inline(t) + '<\/div>'; return; }
      if (/^card:/i.test(t)) { flush(); return; } // rendered as the image card itself, not as text
      if (/^>\s?/.test(t)) { flush(); html += '<blockquote>' + inline(t.replace(/^>\s?/, '')) + '<\/blockquote>'; return; }
      var headingMatch = t.match(/^#{1,6}\s+(.+)$/);
      if (headingMatch) { flush(); html += '<div class="sub-head">' + inline(headingMatch[1]) + '<\/div>'; return; }
      para.push(t);
    });
    flush();
    return html || '<p></p>';
  }

  // --- local-only "kept" + checklist state --------------------------------
  var KEPT_KEY = 'solvency-dash-kept';
  var CL_KEY = 'solvency-dash-checklist';
  function loadSet(key) { try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch (e) { return new Set(); } }
  function saveSet(key, set) { try { localStorage.setItem(key, JSON.stringify(Array.prototype.slice.call(set))); } catch (e) {} }
  var kept = loadSet(KEPT_KEY);
  var checked = loadSet(CL_KEY);

  // --- render --------------------------------------------------------------
  var app = document.getElementById('app');
  var cardEls = [];
  var selected = -1;

  function itemKey(date, filename, n) { return date + '::' + filename + '::' + n; }

  // A bare "2026-08-26" (no time component) is common in the one-off drafting
  // agents' frontmatter -- parsing it as a Date and formatting through the
  // viewer's timezone can shift it to the previous evening. Show those as-is.
  function formatRunAt(v) {
    if (!v) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    var d = new Date(v);
    return isNaN(d.getTime()) ? v : d.toLocaleString();
  }

  function actionsHtml() {
    return '<div class="actions">'
      + '<button data-action="copy">Copy<\/button>'
      + '<button data-action="open">Open file<\/button>'
      + '<button class="danger" data-action="delete">Delete<\/button>'
      + '<\/div>';
  }
  function keepBtnHtml(key) {
    return '<button class="keep-btn' + (kept.has(key) ? ' on' : '') + '" data-action="keep" title="Keep (local only)">&#10003;<\/button>';
  }

  // --- generic card (every producer other than content-miner / price-watch) ---
  function cardHtml(file, item) {
    var key = itemKey(file.date, file.filename, item.n);
    var cls = ['card'];
    if (item.fetchFailed) cls.push('fetch-failed');
    else if (item.statusBadge === 'REVIEW') cls.push('needs-review');
    if (kept.has(key)) cls.push('kept');
    var badge = '';
    if (item.fetchFailed) badge = '<span class="badge fetch">fetch failed<\/span>';
    else if (item.statusBadge === 'REVIEW') badge = '<span class="badge review">review<\/span>';
    var heading = item.heading ? '<div class="card-heading">' + inline(item.heading) + '<\/div>' : '';
    return '<div class="' + cls.join(' ') + '" data-key="' + key + '" data-date="' + file.date + '" data-filename="' + file.filename + '" data-n="' + item.n + '" tabindex="-1">'
      + '<div class="card-top"><span class="idx">' + String(item.n).padStart(2, '0') + '<\/span>'
      + '<span style="display:flex;align-items:center;gap:.4rem;">' + badge + keepBtnHtml(key) + '<\/span><\/div>'
      + heading
      + '<div class="card-body">' + renderMarkdownLite(item.bodyMd) + '<\/div>'
      + actionsHtml()
      + '<\/div>';
  }

  // --- content-miner draft: the actual og-card PNG beside the tweet text -----
  function imageCardHtml(file, item) {
    var key = itemKey(file.date, file.filename, item.n);
    var cls = ['card', 'img-card'];
    if (kept.has(key)) cls.push('kept');
    var thumb;
    if (item.cardFilename) {
      thumb = '<img class="card-thumb" src="/api/og-card?file=' + encodeURIComponent(item.cardFilename) + '" alt="" loading="lazy">';
    } else {
      thumb = '<div class="card-thumb missing"><div class="thumb-glyph">&#128444;<\/div><div class="thumb-note">card missing<\/div><div class="thumb-hint mono">npm run og:cards<\/div><\/div>';
    }
    return '<div class="' + cls.join(' ') + '" data-key="' + key + '" data-date="' + file.date + '" data-filename="' + file.filename + '" data-n="' + item.n + '" tabindex="-1">'
      + '<div class="img-card-media">' + thumb + '<\/div>'
      + '<div class="img-card-body">'
      + '<div class="card-top"><span class="idx">' + String(item.n).padStart(2, '0') + '<\/span>' + keepBtnHtml(key) + '<\/div>'
      + '<div class="card-body">' + renderMarkdownLite(item.bodyMd) + '<\/div>'
      + actionsHtml()
      + '<\/div><\/div>';
  }

  // --- price-watch model check: sparkline (or a current-price stat tile) -----
  function sparklineHtml(history, current) {
    var points = history.slice();
    var lastH = points[points.length - 1];
    if (current && typeof current.input === 'number' && (!lastH || lastH.date !== current.lastVerified)) {
      points.push({ date: current.lastVerified || 'now', input: current.input, output: current.output });
    }
    var vals = points.map(function (p) { return p.input; }).filter(function (v) { return typeof v === 'number'; });
    if (vals.length < 2) return currentPriceHtml(current, null);
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    if (min === max) { min -= 1; max += 1; }
    var w = 220, h = 56, pad = 6, n = points.length;
    var coords = points.map(function (p, i) {
      var x = pad + (n === 1 ? (w - 2 * pad) / 2 : (i / (n - 1)) * (w - 2 * pad));
      var y = pad + (1 - (p.input - min) / (max - min)) * (h - 2 * pad);
      return [x, y];
    });
    var pathD = coords.map(function (c, i) { return (i === 0 ? 'M' : 'L') + c[0].toFixed(1) + ' ' + c[1].toFixed(1); }).join(' ');
    var lastC = coords[coords.length - 1];
    var lastP = points[points.length - 1];
    var meta = { points: points.map(function (p) { return { date: p.date, input: p.input }; }), min: min, max: max, w: w, h: h, pad: pad };
    var svg = '<svg class="sparkline" viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '" preserveAspectRatio="none" role="img" aria-label="price history">'
      + '<path class="spark-line" d="' + pathD + '" fill="none"><\/path>'
      + '<circle class="spark-dot" cx="' + lastC[0].toFixed(1) + '" cy="' + lastC[1].toFixed(1) + '" r="4"><\/circle>'
      + '<\/svg>';
    var caption = '<div class="spark-caption"><span class="spark-current">$' + lastP.input + '/M in<\/span><span>range $' + min + '&ndash;$' + max + '<\/span><\/div>';
    return '<div class="spark-wrap" data-spark="' + escAttr(JSON.stringify(meta)) + '">' + svg + '<div class="spark-tip" hidden></div>' + caption + '<\/div>';
  }

  function currentPriceHtml(current, recordedLine) {
    if (!current) {
      return recordedLine ? '<div class="price-noHistory"><div class="price-sub">no price history on file &mdash; recorded: ' + esc(recordedLine) + '<\/div><\/div>' : '';
    }
    return '<div class="price-noHistory">'
      + '<div class="price-big">$' + current.input + '<span class="price-unit">/M in<\/span><\/div>'
      + '<div class="price-sub">no price history on file &middot; recorded, verified ' + esc(current.lastVerified || 'unknown') + '<\/div>'
      + '<\/div>';
  }

  function priceCardHtml(file, item) {
    var key = itemKey(file.date, file.filename, item.n);
    var cls = ['card', 'price-card'];
    if (item.fetchFailed) cls.push('fetch-failed');
    else if (item.statusBadge === 'REVIEW') cls.push('needs-review');
    if (kept.has(key)) cls.push('kept');
    var badge = '';
    if (item.fetchFailed) badge = '<span class="badge fetch">fetch failed<\/span>';
    else if (item.statusBadge === 'REVIEW') badge = '<span class="badge review">review<\/span>';
    var heading = item.heading ? '<div class="card-heading mono">' + inline(item.heading) + '<\/div>' : '';
    var chart = (item.priceHistory && item.priceHistory.length >= 2)
      ? sparklineHtml(item.priceHistory, item.currentPrice)
      : currentPriceHtml(item.currentPrice, item.recordedLine);
    return '<div class="' + cls.join(' ') + '" data-key="' + key + '" data-date="' + file.date + '" data-filename="' + file.filename + '" data-n="' + item.n + '" tabindex="-1">'
      + '<div class="card-top"><span class="idx">' + String(item.n).padStart(2, '0') + '<\/span>'
      + '<span style="display:flex;align-items:center;gap:.4rem;">' + badge + keepBtnHtml(key) + '<\/span><\/div>'
      + heading
      + chart
      + '<div class="card-body">' + renderMarkdownLite(item.bodyMd) + '<\/div>'
      + actionsHtml()
      + '<\/div>';
  }

  function bindSparklines(root) {
    root.querySelectorAll('.spark-wrap[data-spark]').forEach(function (wrap) {
      var meta;
      try { meta = JSON.parse(wrap.getAttribute('data-spark')); } catch (e) { return; }
      var svg = wrap.querySelector('svg.sparkline');
      var tip = wrap.querySelector('.spark-tip');
      if (!svg || !tip) return;
      wrap.addEventListener('mousemove', function (e) {
        var rect = svg.getBoundingClientRect();
        var relX = (e.clientX - rect.left) / rect.width * meta.w;
        var n = meta.points.length;
        var idx = n === 1 ? 0 : Math.round(((relX - meta.pad) / (meta.w - 2 * meta.pad)) * (n - 1));
        idx = Math.max(0, Math.min(n - 1, idx));
        var p = meta.points[idx];
        tip.textContent = '$' + p.input + '/M in · ' + p.date;
        tip.hidden = false;
        tip.style.left = relX + 'px';
      });
      wrap.addEventListener('mouseleave', function () { tip.hidden = true; });
    });
  }

  // --- compact stepper: price-watch's shared human checklist -----------------
  function stepperHtml(file) {
    if (!file.checklist.length) return '';
    var doneCount = 0;
    var stepDivs = file.checklist.map(function (step, i) {
      var key = file.date + '::checklist::' + i;
      var isDone = checked.has(key);
      if (isDone) doneCount++;
      return '<div class="step' + (isDone ? ' done' : '') + '" data-cl-key="' + key + '" tabindex="0" role="checkbox" aria-checked="' + isDone + '">'
        + '<div class="step-dot" data-idx="' + (i + 1) + '">' + (isDone ? '&#10003;' : (i + 1)) + '<\/div>'
        + '<div class="step-label">' + inline(step) + '<\/div>'
        + '<\/div>';
    });
    var row = stepDivs.join('<div class="step-line"></div>');
    return '<div class="stepper"><div class="stepper-head">Checklist &middot; ' + doneCount + ' of ' + file.checklist.length + '<\/div><div class="stepper-row">' + row + '<\/div><\/div>';
  }

  function producerMetaHtml(file, health) {
    if (!health) {
      return '<div class="producer-meta">' + esc(formatRunAt(file.meta.run_at)) + '<\/div>';
    }
    var when = health.lastRunAt ? formatRunAt(health.lastRunAt) : 'no run recorded';
    var status = health.fetchFailed ? '<span class="warn">check needed<\/span>' : '<span class="ok">clean<\/span>';
    return '<div class="producer-meta">last run ' + esc(when) + ' &middot; ' + status + '<\/div>';
  }

  function sectionHtml(file, health) {
    var isMiner = file.filename === 'content-miner.md';
    var isPriceWatch = file.filename === 'price-watch.md';
    var wide = file.itemStyle === 'header';
    var body = '';
    if (isPriceWatch && file.checklist.length) body += stepperHtml(file);
    if (file.items.length) {
      if (isMiner) {
        body += '<div class="img-card-list">' + file.items.map(function (it) { return imageCardHtml(file, it); }).join('') + '<\/div>';
      } else if (isPriceWatch) {
        body += '<div class="grid wide">' + file.items.map(function (it) { return priceCardHtml(file, it); }).join('') + '<\/div>';
      } else {
        body += '<div class="grid' + (wide ? ' wide' : '') + '">' + file.items.map(function (it) { return cardHtml(file, it); }).join('') + '<\/div>';
      }
    } else if (file.introText) {
      body += '<div class="intro">' + inline(file.introText) + '<\/div>';
    }
    var producerLabel = health ? health.label : file.producer;
    return '<section class="producer">'
      + '<div class="producer-head"><h3 class="producer-name">' + esc(producerLabel) + '<\/h3>' + producerMetaHtml(file, health) + '<\/div>'
      + '<hr class="rule"><hr class="rule-thin">'
      + body
      + '<\/section>';
  }

  function emptyHtml() {
    return '<div class="empty"><div class="glyph">&#9782;<\/div>'
      + '<div class="lede">Nothing overnight needs you.<\/div>'
      + '<div class="sub">Both nightly runs came back clean. The queue is empty.<\/div><\/div>';
  }

  function fullDateLabel(iso) {
    var d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }

  // --- hero: the morning pass as a game loop --------------------------------
  // "Handled" = kept locally (still present) + deleted server-side (gone from
  // the file). The denominator is snapshotted per-date on first load so a
  // delete moves the ring forward instead of quietly shrinking the goalposts.
  function ringState(state) {
    var latest = state.dates[0];
    var date = latest ? latest.date : state.today;
    var currentTotal = 0;
    var keptForDate = 0;
    if (latest) {
      latest.files.forEach(function (f) {
        currentTotal += f.items.length;
        f.items.forEach(function (it) {
          if (kept.has(itemKey(f.date, f.filename, it.n))) keptForDate++;
        });
      });
    }
    var totalKey = 'solvency-dash-total::' + date;
    var storedTotal = 0;
    try { storedTotal = Number(localStorage.getItem(totalKey) || 0) || 0; } catch (e) {}
    var effectiveTotal = Math.max(storedTotal, currentTotal);
    try { localStorage.setItem(totalKey, String(effectiveTotal)); } catch (e) {}
    var deletedCount = Math.max(0, effectiveTotal - currentTotal);
    var handled = Math.min(effectiveTotal, keptForDate + deletedCount);
    return { date: date, total: effectiveTotal, handled: handled, complete: effectiveTotal === 0 || handled >= effectiveTotal };
  }

  function ringHtml(rs) {
    var pct = rs.total === 0 ? 100 : Math.min(100, Math.round((rs.handled / rs.total) * 100));
    var r = 54, c = 2 * Math.PI * r;
    var offset = c - (pct / 100) * c;
    var big = rs.complete ? '&#10003;' : String(rs.handled);
    var caption = rs.total === 0 ? 'Nothing to work through this morning' : (rs.complete ? 'Morning pass complete' : (rs.handled + ' of ' + rs.total + ' handled'));
    return '<div class="ring-block">'
      + '<div class="ring-wrap' + (rs.complete ? ' complete' : '') + '">'
      + '<svg class="ring" viewBox="0 0 120 120" width="132" height="132" aria-hidden="true">'
      + '<circle class="ring-track" cx="60" cy="60" r="' + r + '"><\/circle>'
      + '<circle class="ring-fill" cx="60" cy="60" r="' + r + '" style="stroke-dasharray:' + c.toFixed(2) + ';stroke-dashoffset:' + offset.toFixed(2) + ';"><\/circle>'
      + '<\/svg>'
      + '<div class="ring-center"><div class="ring-big">' + big + (rs.complete || rs.total === 0 ? '' : '<span class="ring-slash">/' + rs.total + '<\/span>') + '<\/div><\/div>'
      + '<\/div>'
      + '<div class="ring-caption' + (rs.complete ? ' complete' : '') + '">' + esc(caption) + '<\/div>'
      + '<\/div>';
  }

  function isoMinusDays(iso, n) {
    var d = new Date(iso + 'T12:00:00');
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  }

  // Consecutive days with a completed pass: every archived date server-truth
  // knows about, walked back from yesterday, plus today itself if its ring
  // (local kept-state + server deletions) is already settled.
  function computeStreak(archivedDates, today, todayComplete) {
    var set = {};
    (archivedDates || []).forEach(function (d) { set[d] = true; });
    var streak = todayComplete ? 1 : 0;
    var cursor = isoMinusDays(today, 1);
    while (set[cursor]) { streak++; cursor = isoMinusDays(cursor, 1); }
    return streak;
  }

  function streakHtml(streakDays) {
    return '<div class="streak-tile"><div class="streak-flame" aria-hidden="true">&#128293;<\/div>'
      + '<div><div class="streak-num">' + streakDays + '<\/div><div class="streak-label">day streak<\/div><\/div><\/div>';
  }

  function numbersStripHtml(nums, streakDays) {
    var tiles = [
      { label: 'Drafts waiting', value: nums.draftsWaiting },
      { label: 'Models re-checked', value: nums.modelsRechecked },
      { label: 'Streak', value: streakDays },
      { label: 'Days since launch', value: nums.daysSinceLaunch }
    ];
    return '<div class="numbers-strip">' + tiles.map(function (t) {
      var isNum = typeof t.value === 'number';
      return '<div class="num-tile"><div class="num-value"' + (isNum ? ' data-countup="' + t.value + '"' : '') + '>' + (isNum ? '0' : '&mdash;') + '<\/div>'
        + '<div class="num-label">' + esc(t.label) + '<\/div><\/div>';
    }).join('') + '<\/div>';
  }

  function animateCountUps(root) {
    var reduced = reducedMotion();
    root.querySelectorAll('[data-countup]').forEach(function (el) {
      var target = Number(el.getAttribute('data-countup'));
      if (reduced || !isFinite(target)) { el.textContent = String(target); return; }
      var start = null, dur = 650;
      function tick(now) {
        if (start === null) start = now;
        var p = Math.min(1, (now - start) / dur);
        var eased = 1 - Math.pow(1 - p, 3);
        el.textContent = String(Math.round(target * eased));
        if (p < 1) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
  }

  // --- night crew row --------------------------------------------------------
  var CREW = [
    { id: 'content-miner', filename: 'content-miner.md', emoji: '⛏️', label: 'Content miner' },
    { id: 'price-watch', filename: 'price-watch.md', emoji: '👁️', label: 'Price watch' }
  ];

  function crewRowHtml(state) {
    var latest = state.dates[0];
    var healthById = {};
    state.runHealth.forEach(function (h) { healthById[h.id] = h; });
    var fileByName = {};
    if (latest) latest.files.forEach(function (f) { fileByName[f.filename] = f; });

    var cards = CREW.map(function (row) {
      var h = healthById[row.id];
      var f = fileByName[row.filename];
      var count = f ? f.items.length : 0;
      var failed = !!(h && h.fetchFailed);
      var when = h && h.lastRunAt ? formatRunAt(h.lastRunAt) : 'no run recorded';
      var note = (!failed && count === 0 && f && f.introText) ? '<div class="crew-note">' + esc(f.introText) + '<\/div>' : '';
      return '<div class="crew-card' + (failed ? ' fail' : '') + '">'
        + '<div class="crew-avatar" aria-hidden="true">' + row.emoji + '<\/div>'
        + '<div class="crew-body"><div class="crew-name">' + esc(row.label) + '<\/div>'
        + '<div class="crew-meta">last run ' + esc(when) + '<\/div>' + note + '<\/div>'
        + '<div class="crew-right">'
        + '<span class="status-chip ' + (failed ? 'fail' : 'clean') + '">' + (failed ? 'FETCH FAILED' : 'clean') + '<\/span>'
        + '<span class="crew-count">' + count + (count === 1 ? ' item' : ' items') + '<\/span>'
        + '<\/div><\/div>';
    }).join('');
    return '<div class="crew-row">' + cards + '<\/div>';
  }

  var state = null;

  function render() {
    if (!state) return;
    var latest = state.dates[0];
    var healthById = {};
    state.runHealth.forEach(function (h) { healthById[h.id] = h; });

    var rs = ringState(state);
    var streakDays = computeStreak(state.archivedDates, state.today, rs.complete);

    var html = '<div class="wrap masthead-row">'
      + '<button class="theme-toggle" id="theme-toggle" title="Toggle theme">&#9789;<\/button>'
      + '<div class="masthead">'
      + '<div class="kicker">Solvency &middot; Overnight<\/div>'
      + '<div class="dateline">' + esc(fullDateLabel(latest ? latest.date : state.today)) + '<\/div>'
      + '<div class="summary' + (state.isAllClear ? ' clear' : '') + '">' + esc(state.summary) + '<\/div>';
    if (latest) {
      html += '<div style="margin-top:.9rem;"><button class="archive-btn" id="archive-btn" data-date="' + latest.date + '">Archive ' + esc(latest.date) + '<\/button><\/div>';
    }
    html += '<\/div><\/div>';

    html += '<div class="wrap"><div class="hero-row">' + ringHtml(rs) + streakHtml(streakDays) + numbersStripHtml(state.overnightNumbers || {}, streakDays) + '<\/div><\/div>';

    html += '<hr class="rule">';

    if (state.dates.length > 1) {
      html += '<div class="wrap"><div class="backlog">' + (state.dates.length - 1) + ' earlier date(s) still open &mdash; scroll down or archive them from queue/.<\/div><\/div>';
    }

    html += '<div class="wrap">' + crewRowHtml(state) + '<\/div>';

    html += '<div class="wrap">';
    if (!latest || (state.isAllClear && latest.files.every(function (f) { return f.items.length === 0; }))) {
      html += emptyHtml();
    } else {
      latest.files.forEach(function (f) {
        var health = f.filename === 'content-miner.md' ? healthById['content-miner'] : (f.filename === 'price-watch.md' ? healthById['price-watch'] : null);
        html += sectionHtml(f, health);
      });
    }
    html += '<\/div>';

    state.dates.slice(1).forEach(function (d) {
      html += '<div class="wrap"><div class="date-block-head"><h2>' + esc(fullDateLabel(d.date)) + '<\/h2>'
        + '<button class="archive-btn" data-action="archive" data-date="' + d.date + '">Archive<\/button><\/div>';
      d.files.forEach(function (f) { html += sectionHtml(f, null); });
      html += '<\/div>';
    });

    app.innerHTML = html;
    cardEls = Array.prototype.slice.call(document.querySelectorAll('.card'));
    selected = -1;

    var toggle = document.getElementById('theme-toggle');
    if (toggle) toggle.addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme(cur);
      try { localStorage.setItem(THEME_KEY, cur); } catch (e) {}
    });

    document.querySelectorAll('[data-action="archive"], #archive-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var date = btn.getAttribute('data-date');
        if (!confirm('Archive ' + date + '? This moves the whole day to queue/_archive/.')) return;
        fetch('/api/archive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ date: date }) })
          .then(function (r) { if (r.ok) refresh(); else r.json().then(function (e) { alert(e.error || 'archive failed'); }); });
      });
    });

    document.querySelectorAll('.cl-item input').forEach(function (box) {
      box.addEventListener('change', function () {
        var key = box.getAttribute('data-cl-key');
        if (box.checked) checked.add(key); else checked.delete(key);
        saveSet(CL_KEY, checked);
        box.closest('.cl-item').classList.toggle('done', box.checked);
      });
    });

    document.querySelectorAll('.step').forEach(function (stepEl) {
      function toggle() {
        var key = stepEl.getAttribute('data-cl-key');
        var nowDone = !stepEl.classList.contains('done');
        if (nowDone) checked.add(key); else checked.delete(key);
        saveSet(CL_KEY, checked);
        stepEl.classList.toggle('done', nowDone);
        stepEl.setAttribute('aria-checked', String(nowDone));
        var dot = stepEl.querySelector('.step-dot');
        dot.innerHTML = nowDone ? '&#10003;' : dot.getAttribute('data-idx');
      }
      stepEl.addEventListener('click', toggle);
      stepEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    });

    cardEls.forEach(function (card) {
      card.addEventListener('click', function (e) {
        if (e.target.closest('button')) return;
        selectCard(cardEls.indexOf(card));
      });
      card.querySelector('[data-action="copy"]').addEventListener('click', function () { copyCard(card); });
      card.querySelector('[data-action="delete"]').addEventListener('click', function () { deleteCard(card); });
      card.querySelector('[data-action="open"]').addEventListener('click', function () { openCard(card); });
      card.querySelector('[data-action="keep"]').addEventListener('click', function () { toggleKeep(card); });
    });

    animateCountUps(app);
    bindSparklines(app);
  }

  function selectCard(i) {
    if (!cardEls.length) return;
    if (selected >= 0 && cardEls[selected]) cardEls[selected].classList.remove('selected');
    selected = Math.max(0, Math.min(i, cardEls.length - 1));
    var card = cardEls[selected];
    card.classList.add('selected');
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function currentText(card) {
    var body = card.querySelector('.card-body');
    var heading = card.querySelector('.card-heading');
    return (heading ? heading.textContent + '\n\n' : '') + body.textContent.trim();
  }

  function copyCard(card) {
    var text = currentText(card);
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text);
  }

  function toggleKeep(card) {
    var key = card.getAttribute('data-key');
    if (kept.has(key)) kept.delete(key); else kept.add(key);
    saveSet(KEPT_KEY, kept);
    card.classList.toggle('kept');
    var btn = card.querySelector('[data-action="keep"]');
    btn.classList.toggle('on');
    if (!reducedMotion()) {
      btn.classList.remove('pulse');
      void btn.offsetWidth; // restart the animation on repeated toggles
      btn.classList.add('pulse');
    }
  }

  function openCard(card) {
    fetch('/api/open-file', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date: card.getAttribute('data-date'), filename: card.getAttribute('data-filename') })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.reason) alert(j.path + '\n\n(' + j.reason + ')');
    });
  }

  function deleteCard(card) {
    var date = card.getAttribute('data-date'), filename = card.getAttribute('data-filename'), n = Number(card.getAttribute('data-n'));
    if (!confirm('Delete item ' + n + ' from ' + filename + '? This rewrites the file.')) return;
    function doDelete() {
      fetch('/api/item', {
        method: 'DELETE', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ date: date, filename: filename, n: n })
      }).then(function (r) {
        if (r.ok) refresh(); else r.json().then(function (e) { alert(e.error || 'delete failed'); card.classList.remove('removing'); });
      });
    }
    if (reducedMotion()) { doDelete(); return; }
    card.classList.add('removing');
    setTimeout(doDelete, 200);
  }

  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'j') { e.preventDefault(); selectCard(selected + 1); }
    else if (e.key === 'k') { e.preventDefault(); selectCard(selected - 1); }
    else if (e.key === 'c' && selected >= 0) { copyCard(cardEls[selected]); }
    else if (e.key === 'd' && selected >= 0) { deleteCard(cardEls[selected]); }
  });

  function refresh() {
    fetch('/api/state').then(function (r) { return r.json(); }).then(function (j) { state = j; render(); });
  }

  refresh();
  setInterval(refresh, 4000);
})();
`;

// ---------------------------------------------------------------------------

const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const queueRoot = process.env.QUEUE_DIR ?? join(ROOT, 'queue');
  const port = Number(process.env.QUEUE_DASHBOARD_PORT) || DEFAULT_PORT;
  startServer(queueRoot, port);
  console.log(`queue-dashboard: serving ${queueRoot} at http://127.0.0.1:${port}`);
}
