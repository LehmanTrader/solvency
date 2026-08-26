/**
 * Pure data for the per-page social stat cards (scripts/og-cards.ts renders
 * these into PNGs; test/og-cards.test.ts re-derives the same figures from the
 * same sources and asserts the committed manifest still matches).
 *
 * Every number here traces to one of:
 *   - reports/*.md frontmatter (`description`, `note`, `price_verified`, `pdf_verified`, `pdf_sources`)
 *   - site/src/lib/headline.ts's headline()/solvedFor()/money()/fmtX() (the same
 *     engine that drives the hero, Share.astro and the report tests)
 *   - site/src/lib/data.ts's models/sourceFor (data/models.json, data/benchmarks.json)
 *   - site/src/lib/charts.ts's BASIS_OF (the same measured/modelled/stale label
 *     used on every model page and chart)
 * No number is authored by hand; a note whose description does not carry the
 * expected figure throws rather than silently guessing.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { headline, fmtX, money, solvedFor, leaderboard } from '../site/src/lib/headline.ts';
import {
  models, sourceFor, modelById, tiers, assumptions, results,
  HARNESS_BENCHMARKS, harnessResultsFor, extrasFor,
} from '../site/src/lib/data.ts';
import { BASIS_OF } from '../site/src/lib/charts.ts';
import { costPerSolvedTask, defaultOptions } from '../site/src/lib/engine.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REPORTS_DIR = join(ROOT, 'reports');

export interface CardData {
  key: string;
  eyebrow: string;
  number: string;
  claim: string;
  attribution: string;
  /** Raw values the staleness test re-derives and compares against. */
  raw: Record<string, unknown>;
}

export interface ReportFrontmatter {
  file: string;
  title: string;
  note: number;
  date: string;
  description: string;
  price_verified?: string;
  pdf_verified?: string;
  pdf_sources?: string;
}

/** Same regex-frontmatter approach as scripts/render-pdf.ts: no YAML dependency. */
export function readReportFrontmatter(file: string): ReportFrontmatter {
  const raw = readFileSync(join(REPORTS_DIR, file), 'utf8');
  const block = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!block) throw new Error(`${file}: no frontmatter block found`);
  const fm: Record<string, string> = {};
  for (const line of block[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  if (!fm.title || !fm.note || !fm.description) {
    throw new Error(`${file}: missing required frontmatter (title/note/description)`);
  }
  return {
    file, title: fm.title, note: Number(fm.note), date: fm.date, description: fm.description,
    price_verified: fm.price_verified, pdf_verified: fm.pdf_verified, pdf_sources: fm.pdf_sources,
  };
}

export function allReportFrontmatter(): ReportFrontmatter[] {
  const files = readdirSync(REPORTS_DIR).filter((f) => /^\d{4}-\d{2}-.*\.md$/.test(f));
  if (!files.length) throw new Error('no report markdown files found in reports/');
  return files.map(readReportFrontmatter).sort((a, b) => a.note - b.note);
}

/** Last "Nx" figure in a description, e.g. "...widens from 38x to 146x." -> "146x". */
export function extractLastXNumber(desc: string): string {
  const matches = [...desc.matchAll(/(\d+(?:\.\d+)?)x\b/gi)];
  if (!matches.length) throw new Error(`could not find an "Nx" figure in description: ${desc}`);
  return `${matches[matches.length - 1][1]}x`;
}

/** The ratio between two "median N" figures in a description, formatted like the site's fmtX(). */
export function extractMedianRatio(desc: string): { text: string; lo: number; hi: number } {
  const matches = [...desc.matchAll(/median (\d+)/g)];
  if (matches.length < 2) throw new Error(`could not find two "median N" figures in description: ${desc}`);
  const nums = matches.map((m) => Number(m[1]));
  const lo = Math.min(...nums), hi = Math.max(...nums);
  return { text: fmtX(hi / lo), lo, hi };
}

/**
 * One config entry per research note: the claim (editorial, written from
 * reading the note) and how to derive its number from the note's own
 * frontmatter description (mechanical, re-run by the staleness test). Notes
 * without an entry fail loudly rather than falling back to a guess.
 */
export const NOTE_CONFIG: Record<number, { claim: string; deriveNumber: (fm: ReportFrontmatter) => string }> = {
  1: {
    claim: 'the gap between cheapest and priciest per solved task',
    deriveNumber: (fm) => extractLastXNumber(fm.description),
  },
  2: {
    claim: 'cost spread across four harnesses at one pass rate',
    deriveNumber: (fm) => extractLastXNumber(fm.description),
  },
  3: {
    claim: 'more tasks to ship a data/ML pipeline than a mobile app',
    deriveNumber: (fm) => extractMedianRatio(fm.description).text,
  },
};

export function noteCardData(fm: ReportFrontmatter): CardData {
  const cfg = NOTE_CONFIG[fm.note];
  if (!cfg) throw new Error(`no og-card config for research note ${fm.note} (${fm.file}) — add one to NOTE_CONFIG before generating cards`);
  const number = cfg.deriveNumber(fm);
  const verified = fm.pdf_verified ?? fm.price_verified ?? fm.date;
  return {
    key: `note-${String(fm.note).padStart(2, '0')}`,
    eyebrow: `RESEARCH NOTE ${String(fm.note).padStart(2, '0')}`,
    number,
    claim: cfg.claim,
    attribution: `${fm.pdf_sources ?? 'Solvency'} · verified ${verified}`,
    raw: { note: fm.note, description: fm.description },
  };
}

export function homeCardData(): CardData {
  const h = headline();
  return {
    key: 'home',
    eyebrow: 'SOLVENCY',
    number: fmtX(h.solvedX),
    claim: 'cost per solved task, measured',
    attribution: `${h.source?.attribution ?? 'Solvency'} · verified ${h.verified}`,
    raw: { solvedX: h.solvedX, cheapId: h.cheap.m.model_id, dearId: h.dear.m.model_id },
  };
}

export function currentModels() {
  return models.filter((m: any) => m.status === 'current');
}

export function modelCardData(model: any): CardData {
  const mine = solvedFor(model.model_id, 'heavy');
  if (mine) {
    const basis = BASIS_OF[mine.basisKey] ?? 'modelled';
    const src = sourceFor(mine.r.benchmark);
    return {
      key: `model-${model.model_id}`,
      eyebrow: 'MODEL',
      number: money(mine.cost),
      claim: model.display_name,
      attribution: `${basis} cost per solved task · ${src?.attribution ?? mine.r.benchmark} · verified ${src?.last_verified ?? mine.r.run_date}`,
      raw: { modelId: model.model_id, cost: mine.cost, basisKey: mine.basisKey },
    };
  }
  return {
    key: `model-${model.model_id}`,
    eyebrow: 'MODEL',
    number: `$${model.input_per_mtok}/M`,
    claim: model.display_name,
    attribution: `list price, no published pass rate · Provider pricing page · verified ${model.last_verified}`,
    raw: { modelId: model.model_id, cost: null, basisKey: null, inputPerMtok: model.input_per_mtok },
  };
}

// ---------------------------------------------------------------------------
// Ranked-bar leaderboard cards (design exploration — see scripts/og-cards.ts).
//
// One card = one ranked list, one cost basis, one source. Never mixes bases
// in a single bar list (a chart that did would need every bar color-coded by
// basis AND the footer stating the split — simpler to keep each card single-
// basis, same as the existing note/model cards).
// ---------------------------------------------------------------------------

export type RankedBasis = 'measured' | 'modelled' | 'stale' | 'harness';

export interface RankedRow {
  id: string;
  /** Row label: a model's display_name, or (for a harness card) the harness name. */
  name: string;
  /** Secondary line under the name, e.g. a harness version. Omit for model rows. */
  sub?: string;
  /** Two-letter monogram chip, derived from `provider` — never a scraped logo. */
  chip?: string;
  /** $ per solved task. */
  cost: number;
  /** money()-formatted, mono. */
  value: string;
  basis: RankedBasis;
  /** Printed nowhere on the card yet; carried for future detail/aria text. */
  detail: string;
}

export interface RankedCardData {
  key: string;
  eyebrow: string;
  headlinePrefix: string;
  /** The one span the headline highlights, brand-amber background. */
  headlineHighlight: string;
  headlineSuffix: string;
  /** Ascending by cost — rows[0] is the #1 (cheapest) row, outlined. */
  rows: RankedRow[];
  /** Left footer: "Source: <name> (<domain>)" — rendered in mono caps by the card CSS. */
  sourceLine: string;
  /** "NOTE: <metric + verified date>" — right footer. */
  noteLine: string;
  raw: Record<string, unknown>;
}

/** First two letters of the provider id, upper-cased — a monogram, not a logo. */
const monogram = (provider: string) => provider.slice(0, 2).toUpperCase();

/** Bare hostname of a source URL, for a short "(domain)" footer citation. */
const domainOf = (url: string) => new URL(url).hostname.replace(/^www\./, '');

/**
 * All current models with a measured (not modelled, not stale) cost per
 * solved task, cheapest first. Single basis, single source — verified by
 * asserting every row shares one benchmark before building the card.
 */
export function rankedCostCardData(): RankedCardData {
  const { measured } = leaderboard('heavy');
  if (!measured.length) throw new Error('rankedCostCardData: no measured current models to rank');
  const benchmarks = new Set(measured.map((r) => r.r.benchmark));
  if (benchmarks.size !== 1) {
    throw new Error(`rankedCostCardData: measured rows span multiple sources (${[...benchmarks].join(', ')}) — a single-basis card needs one`);
  }
  const src = sourceFor([...benchmarks][0]);
  if (!src) throw new Error('rankedCostCardData: no source metadata for the measured benchmark');

  const rows: RankedRow[] = measured.map((r) => ({
    id: r.m.model_id,
    name: r.m.display_name,
    chip: monogram(r.m.provider),
    cost: r.cost,
    value: money(r.cost),
    basis: 'measured',
    detail: `${(r.r.pass_rate * 100).toFixed(0)}% pass rate`,
  }));
  const leader = rows[0], priciest = rows[rows.length - 1];
  const spread = fmtX(priciest.cost / leader.cost);

  return {
    key: 'ranked-cost-per-solved-task',
    eyebrow: 'COST PER SOLVED TASK · CURRENT MODELS',
    headlinePrefix: '',
    headlineHighlight: leader.name,
    headlineSuffix: ' costs the least per solved task, measured.',
    rows,
    // AA's Data Platform Terms s.5 require this exact attribution string,
    // unparaphrased — it already carries a "(domain)" citation, so it is
    // used verbatim rather than run through the generic SOURCE: template.
    sourceLine: src.attribution,
    noteLine: `NOTE: MEASURED COST PER SOLVED TASK · VERIFIED ${src.last_verified}`,
    raw: { modelIds: rows.map((r) => r.id), leaderId: leader.id, spread },
  };
}

/**
 * One model, ranked by cost per solved task across every harness it has been
 * run in. Rows come from HARNESS_BENCHMARKS results only (cost_basis
 * source_usage_repriced: complete token usage a source observed, repriced at
 * today's verified prices — no loop or frontier-efficiency assumption).
 * Returns null (skip, don't fabricate) if no model currently carries more
 * than one harness result.
 */
export function rankedHarnessCardData(): RankedCardData | null {
  const harnessRows = results.filter((r) => HARNESS_BENCHMARKS.includes(r.benchmark));
  const modelIds = [...new Set(harnessRows.map((r) => r.model_id))];
  if (modelIds.length === 0) return null;
  if (modelIds.length > 1) {
    throw new Error(`rankedHarnessCardData: ${modelIds.length} models carry harness rows — "same model, four harnesses" needs exactly one`);
  }
  const model = modelById(modelIds[0]);
  if (!model) throw new Error(`rankedHarnessCardData: ${modelIds[0]} is not in data/models.json`);
  const perHarness = harnessResultsFor(model.model_id);
  if (perHarness.length < 2) return null;

  const opts = defaultOptions(assumptions);
  const rows: RankedRow[] = perHarness.map((r) => {
    const out = costPerSolvedTask(model as any, 'heavy', tiers.heavy, r.pass_rate, opts, extrasFor(r));
    if (!out.value) throw new Error(`rankedHarnessCardData: ${model.model_id}/${r.harness}: ${out.missing.join('; ')}`);
    return {
      id: `${model.model_id}-${r.harness}`,
      name: r.harness!,
      sub: r.harness_version,
      cost: out.value.naive,
      value: money(out.value.naive),
      basis: 'harness' as const,
      detail: `${(r.pass_rate * 100).toFixed(0)}% pass rate`,
    };
  }).sort((a, b) => a.cost - b.cost);

  const src = sourceFor(HARNESS_BENCHMARKS[0]);
  if (!src) throw new Error('rankedHarnessCardData: no source metadata for the harness benchmark');
  const leader = rows[0], priciest = rows[rows.length - 1];
  const spread = fmtX(priciest.cost / leader.cost);

  return {
    key: `ranked-harness-${model.model_id}`,
    eyebrow: `SAME MODEL, ${rows.length} HARNESSES`,
    headlinePrefix: '',
    headlineHighlight: model.display_name,
    headlineSuffix: `, ${rows.length} harnesses, ${spread} apart on cost.`,
    rows,
    sourceLine: `Source: OpenBench harness benchmark (${domainOf(src.source_url)})`,
    noteLine: `NOTE: OBSERVED-TOKEN COST, CURRENT PRICES · VERIFIED ${src.last_verified}`,
    raw: { modelId: model.model_id, harnesses: rows.map((r) => r.id), spread },
  };
}

/**
 * All current models whose cost per solved task is modelled_by_solvency (a
 * published pass rate, but no source-observed cost — Solvency's task-tier
 * loop model fills the gap). Cheapest first. Kept separate from the measured
 * card: mixing modelled cost into a measured ranking is exactly the basis
 * blend the engine's docs forbid.
 */
export function rankedModelledCardData(): RankedCardData | null {
  const { modelled } = leaderboard('heavy');
  if (!modelled.length) return null;
  const benchmarks = new Set(modelled.map((r) => r.r.benchmark));
  if (benchmarks.size !== 1) {
    throw new Error(`rankedModelledCardData: modelled rows span multiple sources (${[...benchmarks].join(', ')}) — a single-basis card needs one`);
  }
  const src = sourceFor([...benchmarks][0]);
  if (!src) throw new Error('rankedModelledCardData: no source metadata for the modelled benchmark');

  const rows: RankedRow[] = modelled.map((r) => ({
    id: r.m.model_id,
    name: r.m.display_name,
    chip: monogram(r.m.provider),
    cost: r.cost,
    value: money(r.cost),
    basis: 'modelled',
    detail: `${(r.r.pass_rate * 100).toFixed(0)}% pass rate`,
  }));
  const leader = rows[0], priciest = rows[rows.length - 1];
  const spread = fmtX(priciest.cost / leader.cost);

  return {
    key: 'ranked-modelled-cost-per-solved-task',
    eyebrow: 'COST PER SOLVED TASK, MODELLED · LEGACY & PREVIEW MODELS',
    headlinePrefix: '',
    headlineHighlight: leader.name,
    headlineSuffix: ' is cheapest among modelled models.',
    rows,
    sourceLine: `Source: Scale SEAL, SWE-bench Pro (${domainOf(src.source_url)})`,
    noteLine: `NOTE: MODELLED COST, TASK-TIER MODEL · VERIFIED ${src.last_verified}`,
    raw: { modelIds: rows.map((r) => r.id), leaderId: leader.id, spread },
  };
}
