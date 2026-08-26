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

export interface DisplayItem {
  n: number;
  style: ItemStyle;
  raw: string;
  heading: string | null; // header style only
  bodyMd: string; // markdown-lite source for the card body
  sourceLine: string | null;
  statusBadge: 'ok' | 'REVIEW' | 'FETCH!' | null;
  fetchFailed: boolean;
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
  return {
    n: chunk.n,
    style,
    raw: chunk.raw,
    heading,
    bodyMd: bodyMd.trim(),
    sourceLine: sourceMatch ? sourceMatch[1].trim() : null,
    statusBadge: (statusMatch?.[1] as DisplayItem['statusBadge']) ?? null,
    fetchFailed,
  };
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

// ---------------------------------------------------------------------------
// Whole-dashboard state assembly + the honest one-line summary.
// ---------------------------------------------------------------------------

export interface DashboardState {
  generatedAt: string;
  today: string; // the server's local date, ISO yyyy-mm-dd -- for the masthead dateline
  latestDate: string | null;
  dates: { date: string; files: DashboardFile[] }[]; // most recent first
  runHealth: ProducerHealth[];
  summary: string;
  isAllClear: boolean;
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

export function buildState(queueRoot: string): DashboardState {
  const dateNames = listUnarchivedDates(queueRoot);
  const dates = dateNames.map((date) => ({ date, files: readDateFiles(queueRoot, date) }));
  const runHealth = buildRunHealth(queueRoot, dates[0]?.date ?? null, dates[0]?.files ?? []);
  const { summary, isAllClear } = summarize(dates, runHealth);
  return {
    generatedAt: new Date().toISOString(),
    today: localIsoDate(new Date()),
    latestDate: dates[0]?.date ?? null,
    dates,
    runHealth,
    summary,
    isAllClear,
  };
}

/** Cheap mtime fingerprint so the server can skip a full reparse when nothing under queue/ changed. */
export function stateFingerprint(queueRoot: string): string {
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
#dawn { height: 9px; width: 100%; background: var(--dawn-gradient, linear-gradient(90deg, var(--purple), var(--amber-fill))); }
a { color: inherit; }
code { font-family: "JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; background: var(--panel-2); padding: .1em .35em; border-radius: 4px; font-size: .92em; }
blockquote { margin: .5rem 0; padding: .1rem 0 .1rem .85rem; border-left: 3px solid var(--rule-strong); color: var(--body); }
.wrap { max-width: 62rem; margin: 0 auto; padding: 0 1.5rem; }

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

.backlog { margin: 1rem 0 0; padding: .6rem .9rem; border: 1px solid var(--amber-fill); border-radius: var(--radius);
  background: color-mix(in srgb, var(--amber-fill) 10%, var(--panel)); font-size: .85rem; }
.backlog a { color: var(--amber); font-weight: 600; text-decoration: none; border-bottom: 1px solid currentColor; }

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

.card-heading { font-weight: 600; font-size: .96rem; }
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
}
`;

const CLIENT_JS = String.raw`
(function () {
  'use strict';

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
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
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
  function saveSet(key, set) { try { localStorage.setItem(key, JSON.stringify([...set])); } catch (e) {} }
  var kept = loadSet(KEPT_KEY);
  var checked = loadSet(CL_KEY);

  // --- render --------------------------------------------------------------
  var app = document.getElementById('app');
  var cardEls = [];
  var selected = -1;

  function itemKey(date, filename, n) { return date + '::' + filename + '::' + n; }

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
      + '<span style="display:flex;align-items:center;gap:.4rem;">' + badge
      + '<button class="keep-btn' + (kept.has(key) ? ' on' : '') + '" data-action="keep" title="Keep (local only)">&#10003;<\/button><\/span><\/div>'
      + heading
      + '<div class="card-body">' + renderMarkdownLite(item.bodyMd) + '<\/div>'
      + '<div class="actions">'
      + '<button data-action="copy">Copy<\/button>'
      + '<button data-action="open">Open file<\/button>'
      + '<button class="danger" data-action="delete">Delete<\/button>'
      + '<\/div><\/div>';
  }

  function checklistHtml(file) {
    if (!file.checklist.length) return '';
    var rows = file.checklist.map(function (step, i) {
      var key = file.date + '::checklist::' + i;
      var isDone = checked.has(key);
      return '<div class="cl-item' + (isDone ? ' done' : '') + '"><input type="checkbox" data-cl-key="' + key + '" id="' + key + '"' + (isDone ? ' checked' : '') + '><label for="' + key + '">' + inline(step) + '<\/label><\/div>';
    }).join('');
    return '<div class="checklist"><div class="cl-title">Checklist<\/div>' + rows + '<\/div>';
  }

  // A bare "2026-08-26" (no time component) is common in the one-off drafting
  // agents' frontmatter -- parsing it as a Date and formatting through the
  // viewer's timezone can shift it to the previous evening. Show those as-is.
  function formatRunAt(v) {
    if (!v) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    var d = new Date(v);
    return isNaN(d.getTime()) ? v : d.toLocaleString();
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
    var wide = file.itemStyle === 'header';
    var body = '';
    if (file.checklist.length) body += checklistHtml(file);
    if (file.items.length) {
      body += '<div class="grid' + (wide ? ' wide' : '') + '">' + file.items.map(function (it) { return cardHtml(file, it); }).join('') + '<\/div>';
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

  var state = null;

  function render() {
    if (!state) return;
    var latest = state.dates[0];
    var healthById = {};
    state.runHealth.forEach(function (h) { healthById[h.id] = h; });

    var html = '<div class="wrap masthead-row">'
      + '<button class="theme-toggle" id="theme-toggle" title="Toggle theme">&#9789;<\/button>'
      + '<div class="masthead">'
      + '<div class="kicker">Solvency &middot; Overnight<\/div>'
      + '<div class="dateline">' + esc(fullDateLabel(latest ? latest.date : state.today)) + '<\/div>'
      + '<div class="summary' + (state.isAllClear ? ' clear' : '') + '">' + esc(state.summary) + '<\/div>';
    if (latest) {
      html += '<div style="margin-top:.9rem;"><button class="archive-btn" id="archive-btn" data-date="' + latest.date + '">Archive ' + esc(latest.date) + '<\/button><\/div>';
    }
    html += '<\/div><\/div><hr class="rule">';

    if (state.dates.length > 1) {
      html += '<div class="wrap"><div class="backlog">' + (state.dates.length - 1) + ' earlier date(s) still open &mdash; scroll down or archive them from queue/.<\/div><\/div>';
    }

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
    card.querySelector('[data-action="keep"]').classList.toggle('on');
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
    fetch('/api/item', {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date: date, filename: filename, n: n })
    }).then(function (r) {
      if (r.ok) refresh(); else r.json().then(function (e) { alert(e.error || 'delete failed'); });
    });
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
