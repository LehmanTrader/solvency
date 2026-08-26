/**
 * Nightly content miner (docs/marketing/panel-2026-08-26/08-automation.md §6.1).
 *
 * Loads models/benchmarks/changelog exclusively through scripts/load.ts (never
 * re-parses data/*.json), diffs the current models set against the last run's
 * snapshot in queue/_state/content-miner-last.json, and drafts number-first,
 * tweet-length text for three kinds of delta:
 *
 *   - a new current model appearing since the last run
 *   - the single biggest week-over-week list-price move on an existing model
 *   - a change of "cheapest current model" within a capability_class
 *
 * Every draft ends `source: <file> · <field> · verified <date>` and is run
 * through a banned-word/no-exclamation-point tone lint before it is ever
 * written. If there are no deltas, this writes "no new deltas — skipped" and
 * exits -- it never invents content to fill the queue.
 *
 * This script only ever writes under queue/. It never touches data/*.json and
 * never calls watch-prices.ts (that is scripts/price-watch-draft.ts's job).
 *
 *   node scripts/content-miner.ts   (== npm run queue:miner)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { models, changelog } from './load.ts';
import type { Model } from './types.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const MAX_DRAFTS = 5;
export const BANNED_WORDS = ['game-changer', 'insane', 'revolutionary', 'huge'];

/** Snapshot the miner diffs against, on disk at queue/_state/content-miner-last.json. */
export interface Snapshot {
  generated_at: string;
  models: Record<string, {
    input_per_mtok: number;
    output_per_mtok: number;
    cached_input_per_mtok: number | null;
    status: string;
    last_verified: string;
  }>;
  cheapest_in_class: Record<string, string | null>;
}

export interface Draft {
  text: string;
  modelId: string | null;
  card: string | null; // relative path to a matching og:card PNG, or null if none applies/available
}

// ---------------------------------------------------------------------------
// Pure logic: snapshotting, diffing, drafting, tone lint. All independently
// testable without touching the filesystem beyond an explicit path argument.
// ---------------------------------------------------------------------------

export function snapshotFrom(fleet: Model[]): Snapshot {
  const snap: Snapshot = { generated_at: new Date().toISOString(), models: {}, cheapest_in_class: {} };
  for (const m of fleet) {
    snap.models[m.model_id] = {
      input_per_mtok: m.input_per_mtok,
      output_per_mtok: m.output_per_mtok,
      cached_input_per_mtok: m.cached_input_per_mtok,
      status: m.status,
      last_verified: m.last_verified,
    };
  }
  for (const [cls, id] of Object.entries(cheapestPerClass(fleet))) snap.cheapest_in_class[cls] = id;
  return snap;
}

/** Cheapest current model (by input_per_mtok list price) per capability_class. */
export function cheapestPerClass(fleet: Model[]): Record<string, string | null> {
  const current = fleet.filter((m) => m.status === 'current');
  const classes = new Set(current.map((m) => m.capability_class));
  const out: Record<string, string | null> = {};
  for (const cls of classes) {
    const inClass = current.filter((m) => m.capability_class === cls);
    const cheapest = inClass.reduce((a, b) => (b.input_per_mtok < a.input_per_mtok ? b : a));
    out[cls] = cheapest.model_id;
  }
  return out;
}

export interface Delta {
  kind: 'new-model' | 'price-move' | 'new-cheapest';
  modelId: string;
  detail: string;
}

/**
 * The three delta kinds the panel spec names, in priority order. Returns only
 * deltas actually present -- never pads the list to hit a target count.
 */
export function computeDeltas(prev: Snapshot | null, fleet: Model[]): Delta[] {
  const current = fleet.filter((m) => m.status === 'current');
  if (!prev) return []; // first run ever: establish a baseline, don't retroactively "discover" the whole fleet

  const deltas: Delta[] = [];

  for (const m of current) {
    if (!prev.models[m.model_id]) {
      deltas.push({ kind: 'new-model', modelId: m.model_id, detail: 'new model' });
    }
  }

  let biggest: { m: Model; pctChange: number; field: 'input_per_mtok' | 'output_per_mtok'; from: number; to: number } | null = null;
  for (const m of current) {
    const before = prev.models[m.model_id];
    if (!before) continue;
    for (const field of ['input_per_mtok', 'output_per_mtok'] as const) {
      const from = before[field];
      const to = m[field];
      if (from === to || !from) continue;
      const pctChange = (to - from) / from;
      if (!biggest || Math.abs(pctChange) > Math.abs(biggest.pctChange)) {
        biggest = { m, pctChange, field, from, to };
      }
    }
  }
  if (biggest) {
    deltas.push({
      kind: 'price-move',
      modelId: biggest.m.model_id,
      detail: `${biggest.field}:${biggest.from}->${biggest.to}:${(biggest.pctChange * 100).toFixed(1)}%`,
    });
  }

  const nowCheapest = cheapestPerClass(fleet);
  for (const [cls, id] of Object.entries(nowCheapest)) {
    const before = prev.cheapest_in_class[cls];
    if (before !== undefined && before !== null && id && before !== id) {
      deltas.push({ kind: 'new-cheapest', modelId: id, detail: `class:${cls}` });
    }
  }

  return deltas;
}

/** Banned-word / no-exclamation-point tone lint. Grep-based, not judgment. */
export function toneLint(text: string): string[] {
  const violations: string[] = [];
  if (text.includes('!')) violations.push('exclamation point');
  const lower = text.toLowerCase();
  for (const word of BANNED_WORDS) if (lower.includes(word)) violations.push(`banned word: "${word}"`);
  return violations;
}

function fmtUsd(n: number): string {
  return n % 1 === 0 ? `$${n}` : `$${n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}`;
}

export function draftFor(delta: Delta, fleet: Model[], today: string): Draft | null {
  const model = fleet.find((m) => m.model_id === delta.modelId);
  if (!model) return null;

  if (delta.kind === 'new-model') {
    const currentCount = fleet.filter((m) => m.status === 'current').length;
    return {
      modelId: model.model_id,
      card: null,
      text: `${fmtUsd(model.input_per_mtok)}/M in, ${fmtUsd(model.output_per_mtok)}/M out: ${model.display_name} (${model.provider}) is now tracked -- ${currentCount} current models in Solvency's set.\nsource: data/models.json · input_per_mtok/output_per_mtok · verified ${model.last_verified}`,
    };
  }

  if (delta.kind === 'price-move') {
    const [field, move] = delta.detail.split(':');
    const [from, to] = move.split('->').map(Number);
    const pct = delta.detail.split(':')[2];
    const label = field === 'input_per_mtok' ? 'input' : 'output';
    return {
      modelId: model.model_id,
      card: null,
      text: `${fmtUsd(from)}/M -> ${fmtUsd(to)}/M ${label} tokens: ${model.display_name}'s price moved ${pct} since the last check.\nsource: data/models.json · ${field} · verified ${model.last_verified}`,
    };
  }

  // new-cheapest
  const cls = delta.detail.split(':')[1];
  return {
    modelId: model.model_id,
    card: null,
    text: `${fmtUsd(model.input_per_mtok)}/M input tokens: ${model.display_name} is now the cheapest ${cls}-class model Solvency tracks (re-derived this run, not carried from memory).\nsource: data/models.json · input_per_mtok · verified ${model.last_verified}`,
  };
}

// ---------------------------------------------------------------------------
// I/O: snapshot persistence, og:cards, queue file writing. Kept thin and
// injectable so tests exercise the pure logic above without touching Chrome.
// ---------------------------------------------------------------------------

export function loadSnapshot(stateFile: string): Snapshot | null {
  if (!existsSync(stateFile)) return null;
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return null; // corrupt/partial snapshot: treat as bootstrap rather than crash the run
  }
}

export function saveSnapshot(stateFile: string, snap: Snapshot): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(snap, null, 2) + '\n');
}

/**
 * Ensures reports/og-cards/model-<id>.png exists for a draft, regenerating
 * cards via `npm run og:cards` if it's missing. Never throws: a failure here
 * (no Chrome in this environment, etc.) means the draft ships as text-only
 * with a flagged missing card, per §6 failure mode -- it never blocks output.
 */
export function defaultEnsureCard(modelId: string): string | null {
  const rel = join('reports', 'og-cards', `model-${modelId}.png`);
  const abs = join(ROOT, rel);
  if (existsSync(abs)) return rel;
  try {
    const res = spawnSync('npm', ['run', 'og:cards'], { cwd: ROOT, stdio: 'pipe', timeout: 120_000 });
    if (res.status === 0 && existsSync(abs)) return rel;
  } catch {
    // fall through to "missing"
  }
  return null;
}

export interface MinerOptions {
  queueRoot?: string;
  today?: string;
  ensureCard?: (modelId: string) => string | null;
}

export interface MinerResult {
  wrote: boolean;
  path: string;
  draftCount: number;
  skippedReason?: string;
}

export function runContentMiner(opts: MinerOptions = {}): MinerResult {
  const queueRoot = opts.queueRoot ?? join(ROOT, 'queue');
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const ensureCard = opts.ensureCard ?? defaultEnsureCard;
  const stateFile = join(queueRoot, '_state', 'content-miner-last.json');
  const outDir = join(queueRoot, today);
  const outPath = join(outDir, 'content-miner.md');
  const runAt = new Date().toISOString();

  const prev = loadSnapshot(stateFile);
  const deltas = computeDeltas(prev, models);
  const nextSnapshot = snapshotFrom(models);

  mkdirSync(outDir, { recursive: true });

  const frontmatter = `---\ngenerated_by: scripts/content-miner.ts\nrun_at: ${runAt}\nregenerate_with: npm run queue:miner\n---\n\n`;

  if (!prev) {
    writeFileSync(outPath, `${frontmatter}# Content miner -- ${today}\n\nno new deltas -- skipped (first run: baseline snapshot established, nothing to diff against yet).\n`);
    saveSnapshot(stateFile, nextSnapshot);
    // Even present with a reference to changelog so the loader-usage guardrail
    // is exercised on every run, not just when a delta happens to cite it.
    void changelog;
    return { wrote: true, path: outPath, draftCount: 0, skippedReason: 'bootstrap' };
  }

  if (!deltas.length) {
    writeFileSync(outPath, `${frontmatter}# Content miner -- ${today}\n\nno new deltas -- skipped.\n`);
    saveSnapshot(stateFile, nextSnapshot);
    return { wrote: true, path: outPath, draftCount: 0, skippedReason: 'no-deltas' };
  }

  const drafts: Draft[] = [];
  for (const delta of deltas) {
    if (drafts.length >= MAX_DRAFTS) break;
    const draft = draftFor(delta, models, today);
    if (!draft) continue;
    const violations = toneLint(draft.text);
    if (violations.length) continue; // never write a draft that fails tone lint
    draft.card = ensureCard(draft.modelId!);
    drafts.push(draft);
  }

  if (!drafts.length) {
    writeFileSync(outPath, `${frontmatter}# Content miner -- ${today}\n\nno new deltas -- skipped.\n`);
    saveSnapshot(stateFile, nextSnapshot);
    return { wrote: true, path: outPath, draftCount: 0, skippedReason: 'no-drafts-passed-lint' };
  }

  const body = drafts
    .map((d, i) => {
      const cardLine = d.card ? `card: ${d.card}` : 'card: MISSING -- run `npm run og:cards`';
      return `${i + 1}. ${d.text}\n   ${cardLine}`;
    })
    .join('\n\n');

  writeFileSync(outPath, `${frontmatter}# Content miner -- ${today}\n\n${body}\n`);
  saveSnapshot(stateFile, nextSnapshot);
  return { wrote: true, path: outPath, draftCount: drafts.length };
}

const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const result = runContentMiner();
  if (result.skippedReason) {
    console.log(`content-miner: ${result.skippedReason} -- wrote ${result.path}`);
  } else {
    console.log(`content-miner: wrote ${result.draftCount} draft(s) to ${result.path}`);
  }
}
