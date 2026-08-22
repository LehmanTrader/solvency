/**
 * The headline finding, derived from the datasets at build time. Nothing in
 * here is typed by hand: ratios come from data/models.json and the measured
 * AA rows, run through the shared engine. Used by the hero, the share buttons
 * and the tweet text so they can never disagree with the report tables.
 */
import { models, assumptions, tiers, bestResultFor, extrasFor, modelById, sourceFor, results } from './data.ts';
import { costPerSolvedTask, defaultOptions } from './engine.ts';

export type Tier = 'light' | 'moderate' | 'heavy';

export const money = (n: number) =>
  n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
export const ratio = (x: number, y: number) => (x > y ? x / y : y / x);
export const fmtX = (r: number) => `${r >= 10 ? r.toFixed(0) : r.toFixed(1)}x`;

export interface Row {
  m: any; r: any; cost: number; perTask: number | null; basisKey: string;
}

/** Cost per solved task for one model at one tier, or null where an input is missing. */
export function solvedFor(modelId: string, tier: Tier = 'heavy'): Row | null {
  const m = modelById(modelId); if (!m) return null;
  const r = bestResultFor(modelId); if (!r) return null;
  const out = costPerSolvedTask(m as any, tier, tiers[tier], r.pass_rate, defaultOptions(assumptions), extrasFor(r));
  if (!out.value) return null;
  return { m, r, cost: out.value.naive, perTask: (r as any).measured_cost_per_task_usd ?? null, basisKey: r.cost_basis };
}

/** Every model with a computable figure, grouped by cost basis, each group ranked cheapest first. */
export function leaderboard(tier: Tier = 'heavy') {
  const rows = models.map((m) => solvedFor(m.model_id, tier)).filter(Boolean) as Row[];
  const by = (k: string) => rows.filter((x) => x.basisKey === k).sort((a, b) => a.cost - b.cost);
  return {
    measured: by('measured_by_source'),
    modelled: by('modelled_by_solvency'),
    historical: by('historical_at_run_date'),
    missing: models.filter((m) => m.status === 'current' && !bestResultFor(m.model_id)),
  };
}

/**
 * The two models the research note leads with: the cheapest measured model
 * per solved task against the highest-scoring measured model. Both are
 * selected from the data, not named here.
 */
export function headline() {
  const { measured } = leaderboard('heavy');
  const cheap = measured[0];
  const dear = measured.slice().sort((a, b) => b.r.pass_rate - a.r.pass_rate)[0];
  const inX = ratio(cheap.m.input_per_mtok, dear.m.input_per_mtok);
  const outX = ratio(cheap.m.output_per_mtok, dear.m.output_per_mtok);
  const solvedX = ratio(cheap.cost, dear.cost);
  const src = sourceFor(cheap.r.benchmark);
  return {
    cheap, dear, inX, outX, solvedX,
    measuredCount: measured.length,
    verified: src?.last_verified ?? cheap.m.last_verified,
    source: src,
  };
}

/** Prewritten tweet for the share button. Figures come from headline(), never from memory. */
export function tweetText() {
  const h = headline();
  return `${h.cheap.m.display_name} is ~${fmtX(h.inX)} cheaper than ${h.dear.m.display_name} per input token and ~${fmtX(h.outX)} per output token — but ~${fmtX(h.solvedX)} cheaper per solved coding task (${money(h.cheap.cost)} vs ${money(h.dear.cost)}). Token price is not task cost.`;
}

export const shareUrl = (text: string, url: string) =>
  `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;

/** Sources table for the trust section. */
export function sourceSummary() {
  return (sourceFor as any) && (results.length
    ? Array.from(new Set(results.map((r) => r.benchmark))).map((b) => {
        const s = sourceFor(b);
        const rows = results.filter((r) => r.benchmark === b);
        return { s, rows: rows.length, matched: rows.filter((r) => r.model_id).length };
      })
    : []);
}
