/**
 * Pure data for the per-page social stat cards (scripts/og-cards.ts renders
 * these into PNGs; test/og-cards.test.ts re-derives the same figures from the
 * same sources and asserts the committed manifest still matches).
 *
 * Every number here traces to one of:
 *   - reports/*.md frontmatter (`description`, `note`, `price_verified`, `pdf_verified`, `pdf_sources`)
 *   - site/src/lib/headline.ts's leaderboard()/money()/fmtX() (the same
 *     engine that drives the hero, Share.astro and the report tests)
 *   - site/src/lib/data.ts's models/sourceFor (data/models.json, data/benchmarks.json)
 *   - data/task-study/final_table.csv (research note 03's own measurement)
 * No number is authored by hand; a note whose description does not carry the
 * expected figure throws rather than silently guessing.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fmtX, money, leaderboard } from '../site/src/lib/headline.ts';
import {
  models, sourceFor, modelById, tiers, assumptions, results,
  HARNESS_BENCHMARKS, harnessResultsFor, extrasFor,
} from '../site/src/lib/data.ts';
import { costPerSolvedTask, defaultOptions } from '../site/src/lib/engine.ts';
import { providerLabel } from '../site/src/lib/providers.ts';
import { quoteBuildPlan } from '../site/src/lib/build-cost.ts';

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

/**
 * Redesign stage 3 (docs/redesign-2026-08/direction.md §7): the site's
 * DEFAULT unfurl cards — home, every model page, every research note — were
 * the dark flat "big number + claim" template (see git history for that
 * shape). They now render through the same cream/purple ranked-leaderboard
 * grammar as the og-ranked-cards design exploration below, via
 * note01CardData/note02CardData/note03CardData/homeCardData/modelCardData,
 * so the DEFAULT card a page shares IS the ranked-card style rather than a
 * separate variant. Dispatches by note number rather than a generic
 * deriveNumber() because each note earns its own row set now, not just its
 * own headline figure.
 */
export function noteCardData(fm: ReportFrontmatter): RankedCardData {
  if (fm.note === 1) return note01CardData(fm);
  if (fm.note === 2) return note02CardData(fm);
  if (fm.note === 3) return note03CardData(fm);
  if (fm.note === 4) return note04CardData(fm);
  throw new Error(`no og-card builder for research note ${fm.note} (${fm.file}) — add one before generating cards`);
}

/** The homepage default card: the same measured cost-per-solved-task ranking as
 * rankedCostCardData(), keyed 'home' for site/src/layouts/Base.astro's default og image. */
export function homeCardData(): RankedCardData {
  return { ...rankedCostCardData(), key: 'home' };
}

export function currentModels() {
  return models.filter((m: any) => m.status === 'current');
}

/**
 * Note 04 ("Composing the Stack"): the three worked compositions, quoted
 * live through the Build Composer engine — the same three plans
 * test/composer-report.test.ts pins, so the card can never drift from the
 * note or the engine.
 */
function note04Rows(): RankedRow[] {
  const usage = (fresh: number, output: number) => ({
    uncachedInputTokens: fresh, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: output,
    basis: 'template_assumption' as const,
  });
  const mk = (name: string, sub: string, orch: string, worker: string, fallback: string) => ({
    name, sub,
    plan: {
      schemaVersion: 1 as const, name,
      workload: { buildsPerMonth: 200, volumeBasis: 'attempted_builds' as const },
      harness: { name: 'Claude Code', version: null, configBasis: 'solvency_template' as const, fixedCostPerBuildAttemptUsd: 0, fixedMonthlyCostUsd: 0 },
      roles: [
        { roleId: 'r1', kind: 'orchestrator' as const, label: 'Lead orchestrator', modelId: orch, expectedInvocationsPerBuildAttempt: 1, usagePerInvocation: usage(6000, 600) },
        { roleId: 'r2', kind: 'worker' as const, label: 'Worker pool', modelId: worker, expectedInvocationsPerBuildAttempt: 3, usagePerInvocation: usage(20000, 3000) },
        { roleId: 'r3', kind: 'other' as const, label: 'Fallback route', modelId: fallback, expectedInvocationsPerBuildAttempt: 0.3, usagePerInvocation: usage(20000, 3000) },
      ],
    },
  });
  const plans = [
    mk('All-frontier monolith', 'Fable 5 in every seat', 'claude-fable-5', 'claude-fable-5', 'claude-fable-5'),
    mk('Composed stack', 'Fable conducts · DeepSeek types · Opus catches', 'claude-fable-5', 'deepseek-v4-flash', 'claude-opus-5'),
    mk('All-value monolith', 'DeepSeek V4 Flash in every seat', 'deepseek-v4-flash', 'deepseek-v4-flash', 'deepseek-v4-flash'),
  ];
  return plans.map(({ name, sub, plan }) => {
    const q = quoteBuildPlan(plan as any, models as any, '2026-08-26T00:00:00Z');
    if (!q.valid) throw new Error(`note04Rows: ${name} did not quote cleanly: ${q.errors.join('; ')}`);
    return {
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name, sub,
      cost: q.buildAttemptCostUsd,
      value: `$${q.buildAttemptCostUsd.toFixed(2)}`,
      basis: 'modelled' as const,
      detail: `$${q.monthlyCostUsd.toFixed(2)} a month at 200 attempted builds`,
    };
  }).sort((a, b) => a.cost - b.cost);
}

function note04CardData(fm: ReportFrontmatter): RankedCardData {
  const rows = note04Rows();
  const spread = extractLastXNumber(fm.description);
  return {
    key: 'note-04',
    eyebrow: `RESEARCH NOTE 04 · ${fm.title.toUpperCase()}`,
    headlinePrefix: '',
    headlineHighlight: spread,
    headlineSuffix: ' apart on composition alone — same workload, three ways to staff it.',
    rows,
    sourceLine: 'Source: Solvency Build Composer engine, template assumptions',
    noteLine: `NOTE: MODELLED, ROLE USAGE × VERIFIED PRICES · ${fm.date}`,
    raw: { note: fm.note, planIds: rows.map((r) => r.id), spread },
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
  /** data/models.json provider id, e.g. 'anthropic' — drives the chip's color/mark (scripts/og-cards.ts). */
  provider?: string;
  /** $ per solved task. */
  cost: number;
  /** money()-formatted, mono. */
  value: string;
  basis: RankedBasis;
  /** Printed nowhere on the card yet; carried for future detail/aria text. */
  detail: string;
  /** True field rank (1 = cheapest), independent of this row's position in a
   * truncated `rows` array — see excerptAroundId(). Falls back to array
   * position when omitted, which is exact for a card that prints every row. */
  rank?: number;
  /** Marks the row the card is *about* (brand-amber outline), independent of
   * rank. Falls back to "rank 1" when no row sets this — the original
   * leaderboard-card behaviour. */
  lead?: boolean;
}

export interface RankedCardData {
  key: string;
  eyebrow: string;
  headlinePrefix: string;
  /** The one span the headline highlights, brand-amber background. */
  headlineHighlight: string;
  headlineSuffix: string;
  /** Ascending by cost — rows[0] is the #1 (cheapest) row, outlined, unless a
   * row sets `lead` explicitly (per-model default cards: the subject model,
   * wherever it actually ranks). */
  rows: RankedRow[];
  /** Bar-width denominator. Defaults to the max cost in `rows`; a card that
   * excerpts a longer field (excerptAroundId()) sets this to the *full*
   * field's max so a truncated card's bars stay proportionally honest. */
  barMax?: number;
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
 * Ascending-by-rank copy of `rows` with `rank` stamped on every row (1 =
 * cheapest), then trimmed to `max`: the cheapest `max - 1` plus — if it
 * would otherwise fall outside that cut — the row whose id is `keepId`,
 * appended with its true rank intact rather than relabelled. Used by every
 * per-model default card: a model far down a long field still gets its real
 * rank number, never a fabricated one, and the bars stay comparable because
 * callers pass the *full* field's max cost as `RankedCardData.barMax`
 * alongside this excerpt rather than recomputing it from the trimmed rows.
 */
function excerptAroundId(rows: RankedRow[], keepId: string, max = 6): RankedRow[] {
  const ranked = rows.map((r, i) => ({ ...r, rank: i + 1 }));
  const idx = ranked.findIndex((r) => r.id === keepId);
  if (idx === -1) throw new Error(`excerptAroundId: "${keepId}" is not in the row set`);
  const picked = ranked.length <= max || idx < max ? ranked.slice(0, max) : [...ranked.slice(0, max - 1), ranked[idx]];
  // Stamp `lead` on every row, true or false, rather than leaving it unset on
  // the rest: a per-model card is about exactly one row, which may not be
  // rank 1, and rankedRowHtml's "rank 1 is lead" fallback only kicks in when
  // a row's `lead` is left unset — leaving it unset here would double-outline
  // both the true #1 and the subject on a card where they differ.
  return picked.map((r) => ({ ...r, lead: r.id === keepId }));
}

/**
 * All current models with a measured (not modelled, not stale) cost per
 * solved task, cheapest first. Single basis, single source — verified by
 * asserting every row shares one benchmark before building the rows.
 * Shared by the homepage default card and every measured model's own
 * default card (modelCardData), so both agree on one computation.
 */
function measuredCostRows() {
  // The measured leaderboard card is the AA population by definition; the
  // first-party Solvency Bench population (2026-08-26) is its own group and
  // never joins this ranking.
  const measured = leaderboard('heavy').measured.filter((r) => r.r.benchmark === 'aa-coding-agent-index');
  if (!measured.length) throw new Error('measuredCostRows: no measured current models to rank');
  const src = sourceFor(measured[0].r.benchmark);
  if (!src) throw new Error('measuredCostRows: no source metadata for the measured benchmark');

  const rows: RankedRow[] = measured.map((r) => ({
    id: r.m.model_id,
    name: r.m.display_name,
    chip: monogram(r.m.provider),
    provider: r.m.provider,
    cost: r.cost,
    value: money(r.cost),
    basis: 'measured',
    detail: `${(r.r.pass_rate * 100).toFixed(0)}% pass rate`,
  }));
  const leader = rows[0], priciest = rows[rows.length - 1];
  const spread = fmtX(priciest.cost / leader.cost);
  // The 630px card canvas fits at most 9 ranked rows (rankedLayout's 40px
  // floor). With the 2026-08-26 AA re-read the measured set grew past that;
  // the card excerpts the cheapest 9 and SAYS SO in its note line — never a
  // silent cap. barMax keeps the printed bars scaled against the full set's
  // priciest row so the excerpt cannot exaggerate.
  const CARD_MAX_ROWS = 9;
  const shown = rows.slice(0, CARD_MAX_ROWS);
  const omitted = rows.length - shown.length;
  return { rows: shown, allRows: rows, omitted, barMax: priciest.cost, src, leader, priciest, spread };
}

/**
 * All current models with a measured (not modelled, not stale) cost per
 * solved task, cheapest first. Single basis, single source — verified by
 * asserting every row shares one benchmark before building the card.
 */
export function rankedCostCardData(): RankedCardData {
  const { rows, allRows, omitted, barMax, src, leader, spread } = measuredCostRows();

  return {
    key: 'ranked-cost-per-solved-task',
    eyebrow: 'COST PER SOLVED TASK · CURRENT MODELS',
    headlinePrefix: '',
    headlineHighlight: leader.name,
    headlineSuffix: ' costs the least per solved task, measured.',
    rows,
    barMax,
    // AA's Data Platform Terms s.5 require this exact attribution string,
    // unparaphrased — it already carries a "(domain)" citation, so it is
    // used verbatim rather than run through the generic SOURCE: template.
    sourceLine: src.attribution,
    noteLine: `NOTE: CHEAPEST ${rows.length} OF ${allRows.length} MEASURED · VERIFIED ${src.last_verified}`,
    raw: { modelIds: rows.map((r) => r.id), allModelIds: allRows.map((r) => r.id), omitted, leaderId: leader.id, spread },
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
    eyebrow: `SAME MODEL, ${rows.length} HARNESSES · COST PER SOLVED TASK`,
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
 * The first-party five-arm harness card: Solvency's own single-turn run of one
 * model through bare API + four harnesses (data/harness-study/solvency-bench-v0.json).
 * Own population — never merged with the OpenBench rankedHarnessCardData() card.
 */
export function rankedSolvencyHarnessCardData(): RankedCardData | null {
  const studyPath = join(ROOT, 'data', 'harness-study', 'solvency-bench-v0.json');
  if (!existsSync(studyPath)) return null;
  const study = JSON.parse(readFileSync(studyPath, 'utf8'));
  const armName = (h: string | null) => h === null ? 'API, no harness'
    : h === 'aider' ? 'Aider' : h === 'codex' ? 'Codex' : h === 'pi' ? 'Pi' : h === 'goose' ? 'Goose' : h === 'cline' ? 'Cline'
    : h === 'opencode' ? 'OpenCode' : h === 'hermes' ? 'Hermes Agent' : h;
  const arms = [...study.arms].sort((a: any, b: any) => a.cost_per_solved_usd - b.cost_per_solved_usd);
  if (arms.length < 2) return null;
  const modelId = String(arms[0].model).replace(/^[^/]+\//, '');
  const model = modelById(modelId);
  if (!model) throw new Error(`rankedSolvencyHarnessCardData: ${modelId} is not in data/models.json`);
  const rows: RankedRow[] = arms.map((a: any) => ({
    id: `${modelId}-${a.harness ?? 'bare'}`,
    name: armName(a.harness),
    sub: a.harness_version,
    cost: a.cost_per_solved_usd,
    value: `$${a.cost_per_solved_usd.toFixed(4)}`,
    basis: 'harness' as const,
    detail: `${(a.pass_rate * 100).toFixed(0)}% pass rate`,
  }));
  const spread = fmtX(rows[rows.length - 1].cost / rows[0].cost);
  return {
    key: `ranked-harness-solvency-${modelId}`,
    eyebrow: `SAME MODEL, ${rows.length} HARNESS ARMS · COST PER SOLVED TASK`,
    headlinePrefix: '',
    headlineHighlight: model.display_name,
    headlineSuffix: `, ${rows.length} harness arms, ${spread} apart on cost — measured by Solvency.`,
    rows,
    sourceLine: `Source: Solvency Bench v0 — run by Solvency, ${study.run_date}`,
    noteLine: 'NOTE: HARNESS-REPORTED USAGE × VERIFIED CATALOG PRICES · OWN POPULATION',
    raw: { modelId, arms: rows.map((r) => r.id), spread },
  };
}

/**
 * All current models whose cost per solved task is modelled_by_solvency (a
 * published pass rate, but no source-observed cost — Solvency's task-tier
 * loop model fills the gap). Cheapest first. Kept separate from the measured
 * card: mixing modelled cost into a measured ranking is exactly the basis
 * blend the engine's docs forbid.
 */
function modelledCostRows() {
  const { modelled } = leaderboard('heavy');
  if (!modelled.length) return null;
  const benchmarks = new Set(modelled.map((r) => r.r.benchmark));
  if (benchmarks.size !== 1) {
    throw new Error(`modelledCostRows: modelled rows span multiple sources (${[...benchmarks].join(', ')}) — a single-basis card needs one`);
  }
  const src = sourceFor([...benchmarks][0]);
  if (!src) throw new Error('modelledCostRows: no source metadata for the modelled benchmark');

  const rows: RankedRow[] = modelled.map((r) => ({
    id: r.m.model_id,
    name: r.m.display_name,
    chip: monogram(r.m.provider),
    provider: r.m.provider,
    cost: r.cost,
    value: money(r.cost),
    basis: 'modelled',
    detail: `${(r.r.pass_rate * 100).toFixed(0)}% pass rate`,
  }));
  const leader = rows[0], priciest = rows[rows.length - 1];
  const spread = fmtX(priciest.cost / leader.cost);
  return { rows, src, leader, priciest, spread };
}

/**
 * All current models whose cost per solved task is modelled_by_solvency (a
 * published pass rate, but no source-observed cost — Solvency's task-tier
 * loop model fills the gap). Cheapest first. Kept separate from the measured
 * card: mixing modelled cost into a measured ranking is exactly the basis
 * blend the engine's docs forbid.
 */
export function rankedModelledCardData(): RankedCardData | null {
  const built = modelledCostRows();
  if (!built) return null;
  const { rows, src, leader, spread } = built;

  return {
    key: 'ranked-modelled-cost-per-solved-task',
    eyebrow: 'COST PER SOLVED TASK, MODELLED · LEGACY & PREVIEW MODELS',
    // Rewritten from the founder-flagged "<Model> is cheapest among modelled
    // models." (clunky, doubled "modelled") to natural measured voice: say
    // what Solvency's loop model actually did (priced it), and lead with the
    // number, same as the measured card's headline pattern.
    headlinePrefix: 'Our loop model prices ',
    headlineHighlight: leader.name,
    headlineSuffix: ` lowest — ${leader.value} per solved task.`,
    rows,
    sourceLine: `Source: Scale SEAL, SWE-bench Pro (${domainOf(src.source_url)})`,
    noteLine: `NOTE: MODELLED COST, TASK-TIER MODEL · VERIFIED ${src.last_verified}`,
    raw: { modelIds: rows.map((r) => r.id), leaderId: leader.id, spread },
  };
}

/**
 * Every current model's verified list price per million input tokens,
 * cheapest first — the only ranking available for a model with no published
 * pass rate (so no cost-per-solved-task figure exists yet). `basis:
 * 'measured'` here means "a verified real number", not "a benchmark-measured
 * cost per solved task" — there is no modelled/stale ambiguity for a list
 * price, so the bar is solid, same as any other verified figure.
 */
function priceRankedRows(): RankedRow[] {
  const list = currentModels().slice().sort((a: any, b: any) => a.input_per_mtok - b.input_per_mtok);
  return list.map((m: any) => ({
    id: m.model_id,
    name: m.display_name,
    chip: monogram(m.provider),
    provider: m.provider,
    cost: m.input_per_mtok,
    value: `$${m.input_per_mtok}/M`,
    basis: 'measured',
    detail: 'list price per million input tokens',
  }));
}

/**
 * The default social card for a model's own page (site/src/pages/models/[id].astro),
 * replacing the old flat dark stat card with the same ranked-leaderboard
 * grammar as the homepage: this model's row outlined in brand amber wherever
 * it actually falls in the field, not repositioned to look like a winner.
 *
 * Basis is decided by which leaderboard('heavy') bucket the model is
 * actually in (the same split rankedCostCardData/rankedModelledCardData use)
 * rather than re-deriving it — one source of truth for "is this row
 * measured or modelled." A model with no cost-per-solved-task result at all
 * (no published pass rate yet) falls back to the list-price ranking above,
 * so every current model gets a truthful default card instead of none.
 */
export function modelCardData(model: any): RankedCardData {
  const { measured, modelled } = leaderboard('heavy');
  const inMeasured = measured.some((r) => r.m.model_id === model.model_id);
  const inModelled = modelled.some((r) => r.m.model_id === model.model_id);

  if (inMeasured) {
    const { allRows, src } = measuredCostRows();
    const barMax = Math.max(...allRows.map((r) => r.cost));
    const mine = allRows.find((r) => r.id === model.model_id)!;
    return {
      key: `model-${model.model_id}`,
      eyebrow: 'COST PER SOLVED TASK · CURRENT MODELS',
      headlinePrefix: '',
      headlineHighlight: model.display_name,
      headlineSuffix: ` costs ${mine.value} per solved task, measured.`,
      rows: excerptAroundId(allRows, model.model_id),
      barMax,
      sourceLine: src.attribution,
      noteLine: `NOTE: MEASURED COST PER SOLVED TASK · VERIFIED ${src.last_verified}`,
      raw: { modelId: model.model_id, cost: mine.cost, basisKey: 'measured_by_source' },
    };
  }

  if (inModelled) {
    const built = modelledCostRows()!;
    const { rows, src } = built;
    const barMax = Math.max(...rows.map((r) => r.cost));
    const mine = rows.find((r) => r.id === model.model_id)!;
    return {
      key: `model-${model.model_id}`,
      eyebrow: 'COST PER SOLVED TASK, MODELLED · LEGACY & PREVIEW MODELS',
      headlinePrefix: 'Our loop model prices ',
      headlineHighlight: model.display_name,
      headlineSuffix: ` at ${mine.value} per solved task.`,
      rows: excerptAroundId(rows, model.model_id),
      barMax,
      sourceLine: `Source: Scale SEAL, SWE-bench Pro (${domainOf(src.source_url)})`,
      noteLine: `NOTE: MODELLED COST, TASK-TIER MODEL · VERIFIED ${src.last_verified}`,
      raw: { modelId: model.model_id, cost: mine.cost, basisKey: 'modelled_by_solvency' },
    };
  }

  // No published pass rate yet: no cost-per-solved-task figure exists to
  // rank. Fall back to the one figure every model has — verified list price.
  const rows = priceRankedRows();
  const barMax = Math.max(...rows.map((r) => r.cost));
  return {
    key: `model-${model.model_id}`,
    eyebrow: 'LIST PRICE PER MILLION INPUT TOKENS · CURRENT MODELS',
    headlinePrefix: '',
    headlineHighlight: model.display_name,
    headlineSuffix: ` lists at $${model.input_per_mtok}/M input — no published pass rate yet.`,
    rows: excerptAroundId(rows, model.model_id),
    barMax,
    sourceLine: `Source: ${providerLabel(model.provider)} pricing page (${domainOf(model.source_url)})`,
    noteLine: `NOTE: LIST PRICE, NO SOLVED-TASK COST YET · VERIFIED ${model.last_verified}`,
    raw: { modelId: model.model_id, cost: null, basisKey: null, inputPerMtok: model.input_per_mtok },
  };
}

// ---------------------------------------------------------------------------
// Research-note default cards (site/src/pages/research/[...slug].astro's
// `og={/og/cards/note-NN.png}`) — same ranked grammar, one row set per note's
// own finding rather than a hand-typed number.
// ---------------------------------------------------------------------------

const TASK_STUDY_CSV = join(ROOT, 'data', 'task-study', 'final_table.csv');
const TASK_BUCKETS: Record<string, string> = {
  a: 'Marketing/landing site', b: 'Full web app (SaaS)', c: '2D indie game',
  d: 'CLI tool/utility', e: 'Data/ML pipeline', f: 'Mobile app',
};

/** Same minimal quoted-CSV parser as test/task-report.test.ts. */
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
      } else if (c === '"') { inQuotes = true; }
      else if (c === ',') { cells.push(cur); cur = ''; }
      else { cur += c; }
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

const fmtCount = (n: number) => (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(1));

/** Bucket, n and median task count per use case, straight from the CSV — see test/task-report.test.ts. */
function taskBucketMedians(): { bucket: string; label: string; n: number; median: number }[] {
  const rows = parseCsv(readFileSync(TASK_STUDY_CSV, 'utf8'));
  return Object.entries(TASK_BUCKETS).map(([key, label]) => {
    const counts = rows.filter((r) => r.bucket === key).map((r) => Number(r.count_used)).sort((a, b) => a - b);
    if (!counts.length) throw new Error(`taskBucketMedians: bucket "${key}" has no rows in ${TASK_STUDY_CSV}`);
    return { bucket: key, label, n: counts.length, median: median(counts) };
  });
}

/** Research note 01 (Cost Per Solved Task): the same measured field as the
 * homepage card, reframed around the cheapest-vs-priciest spread the note leads with. */
function note01CardData(fm: ReportFrontmatter): RankedCardData {
  const { allRows, barMax, src, leader, priciest } = measuredCostRows();
  const gap = NOTE_CONFIG[1].deriveNumber(fm);
  // Note 01's card tells the cheapest-to-priciest gap story, so its 9-row
  // excerpt keeps BOTH ends of the range: the 5 cheapest and the 4 priciest,
  // each row carrying its true rank, with the cut stated in the note line.
  const ends = allRows.length <= 9
    ? allRows.map((r, i) => ({ ...r, rank: i + 1 }))
    : [...allRows.slice(0, 5).map((r, i) => ({ ...r, rank: i + 1 })),
       ...allRows.slice(-4).map((r, i) => ({ ...r, rank: allRows.length - 3 + i }))];
  return {
    key: 'note-01',
    eyebrow: 'RESEARCH NOTE 01 · COST PER SOLVED TASK',
    headlinePrefix: '',
    headlineHighlight: gap,
    headlineSuffix: ` apart — ${leader.name} vs. ${priciest.name}, cheapest to priciest, measured.`,
    rows: ends,
    barMax,
    sourceLine: src.attribution,
    noteLine: allRows.length <= 9
      ? `NOTE: MEASURED COST PER SOLVED TASK · VERIFIED ${src.last_verified}`
      : `NOTE: BOTH ENDS OF ${allRows.length} MEASURED · VERIFIED ${src.last_verified}`,
    raw: { note: fm.note, leaderId: leader.id, priciestId: priciest.id, gap },
  };
}

/** Research note 02 (Same Model, Four Harnesses) IS the harness ranking — no
 * separate construction, just the note's own key and eyebrow on top of it. */
function note02CardData(fm: ReportFrontmatter): RankedCardData {
  // The note's title counts the distinct-harness union across all three
  // populations ("Ten Harnesses"); the ranked rows must come from ONE
  // population — ranking across benchmarks is the exact basis blend the
  // note forbids. Since 2026-08-26 the rows are population three, the
  // first-party eight-arm Solvency Bench run (the note's lead finding);
  // the footer names the population so the banner count and the row count
  // can never read as the same claim.
  const card = rankedSolvencyHarnessCardData();
  if (!card) throw new Error('note02CardData: rankedSolvencyHarnessCardData() returned null — research note 02 needs the first-party harness study on disk');
  return {
    ...card,
    key: 'note-02',
    eyebrow: `RESEARCH NOTE 02 · ${fm.title.toUpperCase()}`,
    noteLine: 'NOTE: SOLVENCY BENCH · POPULATION 3 OF 3 · FIRST-PARTY, RUN 2026-08-26',
    raw: { ...card.raw, note: fm.note },
  };
}

/** Research note 03 (What Is a Task): median tasks-to-first-ship per use
 * case, ranked — bars sized by task count instead of dollars, straight from
 * data/task-study/final_table.csv (see taskBucketMedians()). */
function note03CardData(fm: ReportFrontmatter): RankedCardData {
  const buckets = taskBucketMedians().slice().sort((a, b) => a.median - b.median);
  const { text: ratio, lo, hi } = extractMedianRatio(fm.description);
  const many = buckets.find((b) => b.median === hi);
  const few = buckets.find((b) => b.median === lo);
  if (!many || !few) throw new Error(`note03CardData: could not match the description's "median ${lo}"/"median ${hi}" to a bucket`);

  const rows: RankedRow[] = buckets.map((b) => ({
    id: b.bucket,
    name: b.label,
    sub: `n=${b.n} repos`,
    cost: b.median,
    value: fmtCount(b.median),
    basis: 'measured',
    detail: `median tasks to first ship, ${b.n} repos measured`,
  }));

  return {
    key: 'note-03',
    eyebrow: 'RESEARCH NOTE 03 · TASKS TO FIRST SHIP',
    headlinePrefix: `${many.label} needs `,
    headlineHighlight: ratio,
    headlineSuffix: ` more tasks to ship than a ${few.label}, measured.`,
    rows,
    sourceLine: "Source: Solvency's own GitHub measurement, 60 repos",
    noteLine: `NOTE: MEDIAN TASKS TO FIRST SHIP · MEASURED ${fm.pdf_verified ?? fm.date}`,
    raw: { note: fm.note, manyBucket: many.bucket, fewBucket: few.bucket, ratio },
  };
}
