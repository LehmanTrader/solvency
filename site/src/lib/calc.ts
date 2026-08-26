/**
 * Calculator rendering, shared by the server build and the client island.
 * The page ships with its default state already rendered, so it is useful
 * without JavaScript and does not shift layout when the island takes over.
 */
import { models, assumptions, tiers, bestResultFor, extrasFor } from './data.ts';
import { costPerSolvedTask, defaultOptions } from './engine.ts';
import { rankedBars, BASIS_OF, money, moneyMonth, type ChartRow, type Basis, type RankSort } from './charts.ts';
import { escapeHtml } from './html.ts';

export { money, moneyMonth };

export interface Settings {
  tier: 'light' | 'moderate' | 'heavy';
  volume: number;
  variant: 'naive' | 'capped' | 'truncatedGeometric';
  cache: number;      // 0..1
  residual: number;
  frontier: boolean;
}

export const DEFAULTS: Settings = {
  tier: 'moderate', volume: 200, variant: 'naive', cache: 0, residual: 0, frontier: true,
};

export const TIER_HELP: Record<Settings['tier'], string> = {
  light: tiers.light.examples, moderate: tiers.moderate.examples, heavy: tiers.heavy.examples,
};

export const GROUPS: { key: string; basis: Basis; title: string; note: string }[] = [
  { key: 'measured_by_source', basis: 'measured', title: 'Measured',
    note: 'The benchmark ran the model and observed this cost. No Solvency assumption is inside these figures.' },
  { key: 'modelled_by_solvency', basis: 'modelled', title: 'Modelled',
    note: "Pass rate published; cost is Solvency's loop model at verified prices." },
  { key: 'historical_at_run_date', basis: 'stale', title: 'Stale',
    note: 'Pass rates published before 2026. Cost recomputed at current prices; the pass rate is old.' },
];

export interface Row {
  m: any; r: any; cost: number; basis: string; basisKey: string; attempt: number;
  /** Set when a cache rate was asked for but the provider publishes no cached-input price: the row is computed uncached and says so. Group membership never changes with an assumption. */
  uncached?: boolean;
}

export function compute(s: Settings): { rows: Row[]; missing: string[] } {
  const base = defaultOptions(assumptions);
  const opts = {
    ...base,
    cacheHitFraction: s.cache,
    residualHumanCostUsd: s.residual,
    frontierEfficiency: s.frontier ? base.frontierEfficiency
      : { ...base.frontierEfficiency, multipliers_by_tier: { light: 1, moderate: 1, heavy: 1 } },
  };
  const rows: Row[] = [];
  const missing: string[] = [];
  for (const m of models) {
    const r = bestResultFor(m.model_id);
    if (!r) { if (m.status === 'current') missing.push(m.display_name); continue; }
    // An assumption may move a modelled row; it may never move it out of its
    // group. A model with no published cached-input price is computed at the
    // uncached price and annotated, rather than dropping into "Not shown".
    const uncached = s.cache > 0 && m.cached_input_per_mtok === null;
    const o = uncached ? { ...opts, cacheHitFraction: 0 } : opts;
    const out = costPerSolvedTask(m as any, s.tier, tiers[s.tier], r.pass_rate, o, extrasFor(r));
    if (out.value === null) { missing.push(`${m.display_name} (${out.missing[0] ?? 'missing input'})`); continue; }
    rows.push({ m, r, cost: out.value[s.variant], basis: out.value.costBasis, basisKey: r.cost_basis, attempt: out.value.attempt.costUsd, uncached });
  }
  rows.sort((a, b) => a.cost - b.cost);
  return { rows, missing };
}

const harnessOf = (r: any) => r.cost_basis === 'measured_by_source' ? String(r.entry_label ?? '').split(' - ')[0] : undefined;

/** /compare/[a]-vs-[b] pages exist in models.json order only; keep that order. */
export function pairPath(aId: string, bId: string): string {
  const ia = models.findIndex((m) => m.model_id === aId), ib = models.findIndex((m) => m.model_id === bId);
  const [x, y] = ia <= ib ? [aId, bId] : [bId, aId];
  return `/compare/${x}-vs-${y}`;
}

export function pairHref(aId: string, bId: string, s: Pick<Settings, 'tier' | 'volume'>): string {
  return `${pairPath(aId, bId)}?tier=${s.tier}&volume=${s.volume}`;
}

/** Rows of one cost basis, as the chart module wants them, each with a Compare link to the group lead. */
export function chartRows(rows: Row[], key: string, s: Settings): ChartRow[] {
  const g = rows.filter((x) => x.basisKey === key);
  const lead = g[0], second = g[1];
  return g.map((x) => ({
    id: x.m.model_id, name: x.m.display_name, href: `/models/${x.m.model_id}`,
    cost: x.cost, pass: x.r.pass_rate, basis: BASIS_OF[key] ?? 'modelled',
    harness: harnessOf(x.r), attempt: x.attempt, provider: x.m.provider,
    note: x.uncached && x.basisKey !== 'measured_by_source' ? 'no cached-input price published — computed uncached' : undefined,
    compare: g.length > 1 ? pairHref(x === lead ? second.m.model_id : lead.m.model_id, x.m.model_id, s) : undefined,
  }));
}

/** Every computable row as a chart row (for the scatter). */
export const allChartRows = (rows: Row[], s: Settings) => GROUPS.flatMap((g) => chartRows(rows, g.key, s));

export interface GroupOpts {
  width: number;
  compact?: boolean;
  highlight?: string;
  /** Sort state per basis group (stage 2's homepage Ranking view). Omitted —
   * or a group with no entry — falls back to rankedBars' own default
   * (cost ascending), so callers that don't sort (e.g. the model page's peer
   * chart) are unaffected. */
  sort?: Partial<Record<Basis, RankSort>>;
  /** Renders each group's header as real sortable <button>s. Homepage only. */
  sortable?: boolean;
}

/**
 * The grouped result: measured, then modelled, each with its own header and
 * its own scale; stale rows behind a disclosure. Never interleaved.
 */
export function groupsHtml(rows: Row[], s: Settings, o: GroupOpts): string {
  // Founder fix (screenshot review, 2026-08-26): on the wide/sortable layout
  // the "Find a model" search box (site/src/components/Calculator.astro's
  // #c-find, position:absolute top-right of #c-groups, desktop only) floats
  // right over the first group's own top band. That band used to be just a
  // one-line caption; it's now also home to the interactive sort-header row,
  // and the old 8px gap between them read as the search box crowding the
  // headers. Wide + sortable groups get real breathing room here instead.
  const headGap = o.sortable && !o.compact ? 'mt-7' : 'mt-2';
  return GROUPS.map((g) => {
    const cr = chartRows(rows, g.key, s);
    const svg = cr.length ? rankedBars(cr, { width: o.width, volume: s.volume, basis: g.basis, compact: o.compact, highlight: o.highlight, sort: o.sort?.[g.basis], sortable: o.sortable }) : '';
    const empty = `<p class="small py-2">No ${g.basis} row has both a verified price and a published pass rate under these settings.</p>`;
    const head = `<p class="ghead"><span class="gword t-${g.basis}">${g.title}</span> · ${g.note}</p>`;
    if (g.basis === 'stale') {
      return `<details class="disc group-${g.basis} px-5 py-3 border-t border-[var(--color-rule)]" data-group="${g.basis}">
        <summary><span class="t-stale">Stale pass rates</span> (<span data-count>${cr.length}</span>) · ${g.note}</summary>
        <div class="chart-slot mt-3" data-chart>${svg || empty}</div>
      </details>`;
    }
    return `<div class="group-${g.basis} px-5 pt-4 pb-2${g.basis === 'modelled' ? ' border-t border-[var(--color-rule)]' : ''}" data-group="${g.basis}">
      ${head}
      <div class="chart-slot ${headGap}" data-chart>${svg || empty}</div>
    </div>`;
  }).join('');
}

/**
 * The result headline. Compares only within one cost basis; ranking measured
 * against modelled is invalid. Names are neutral bold — the verdict is carried
 * by the "▼ Nx cheaper" figure in the better/worse color, the same treatment
 * the compare page uses.
 */
export function calloutHtml(rows: Row[], volume: number): string {
  const g = GROUPS.map((g) => ({ g, rows: rows.filter((x) => x.basisKey === g.key) })).find((p) => p.rows.length > 1);
  const pool = g?.rows ?? [];
  const cheapest = pool[0];
  const best = pool.slice().sort((a, b) => b.r.pass_rate - a.r.pass_rate)[0];
  if (!cheapest || !best) return '<span class="text-[var(--color-muted)]">No model has both a verified price and a published pass rate under these settings.</span>';
  const name = (x: Row) => `<strong>${escapeHtml(x.m.display_name)}</strong>`;
  if (cheapest.m.model_id === best.m.model_id) {
    // Stage 1.3 (Roy's note 4, 2026-08-26): "GPT-5.4 is cheapest among
    // modelled models sounds weird please rewrite that sentence." The old
    // single sentence below ("X is both the cheapest ... and the highest
    // pass rate here") read as a benchmark verdict even when the matched
    // pool was modelled, not measured — nothing ran a cost benchmark on
    // these rows, so claiming "the highest pass rate here" alongside
    // "cheapest" sounded like an observed result instead of a priced
    // estimate. Measured pools keep the direct sentence; modelled/stale
    // pools name the modelled basis up front instead.
    if (g!.g.basis !== 'measured')
      return `No harness has published a cost run for these; our loop model prices ${name(cheapest)} lowest at ${money(cheapest.cost)} per solved task, ${moneyMonth(cheapest.cost * volume)} a month — it also carries the highest published pass rate here.`;
    return `${name(cheapest)} is both the cheapest per solved task and the highest pass rate here — ${money(cheapest.cost)} per solved task, ${moneyMonth(cheapest.cost * volume)} a month.`;
  }
  const x = best.cost / cheapest.cost;
  const pts = Math.round((best.r.pass_rate - cheapest.r.pass_rate) * 100);
  const forWhat = pts > 0 ? `for ${pts} fewer point${pts === 1 ? '' : 's'} of pass rate` : 'at the same pass rate';
  return `${name(cheapest)} costs <strong>${money(cheapest.cost)}</strong> per solved task against
    ${name(best)} at <span class="t-worse">${money(best.cost)}</span> — <strong class="t-better">▼ ${x >= 10 ? x.toFixed(0) : x.toFixed(1)}x cheaper</strong> ${forWhat}.
    Over ${volume.toLocaleString()} tasks that is <strong>${moneyMonth((best.cost - cheapest.cost) * volume)}</strong> a month.`;
}

/**
 * The hero's project-total answer: the same cheapest-vs-highest-pass-rate
 * pair calloutHtml uses (first cost basis with more than one row — normally
 * "measured"), priced over a task count instead of a monthly volume. Used
 * when the hero is in bucket mode ("I want to ship a [bucket]"); calloutHtml
 * itself is untouched and still drives monthly mode.
 */
export function projectTotalHtml(rows: Row[], taskCount: number): string {
  const g = GROUPS.map((g) => ({ g, rows: rows.filter((x) => x.basisKey === g.key) })).find((p) => p.rows.length > 1);
  const pool = g?.rows ?? [];
  const cheapest = pool[0];
  const best = pool.slice().sort((a, b) => b.r.pass_rate - a.r.pass_rate)[0];
  if (!cheapest || !best) return '<span class="text-[var(--color-muted)]">No model has both a verified price and a published pass rate under these settings.</span>';
  const name = (x: Row) => `<strong>${escapeHtml(x.m.display_name)}</strong>`;
  const tasks = Number.isInteger(taskCount) ? taskCount.toLocaleString() : taskCount.toFixed(1);
  if (cheapest.m.model_id === best.m.model_id) {
    // Same rewrite as calloutHtml's tie case above (Stage 1.3, Roy's note 4) —
    // this is the hero's bucket-mode twin of that sentence.
    if (g!.g.basis !== 'measured')
      return `No harness has published a cost run for these; our loop model prices ${name(cheapest)} lowest at ${moneyMonth(cheapest.cost * taskCount)} over ~${tasks} tasks — it also carries the highest published pass rate here.`;
    return `${name(cheapest)} is both the cheapest per solved task and the highest pass rate here — ${moneyMonth(cheapest.cost * taskCount)} over ~${tasks} tasks.`;
  }
  return `${name(cheapest)} ships it for <strong class="t-better">${moneyMonth(cheapest.cost * taskCount)}</strong> against
    ${name(best)} at a pricier <strong class="t-worse">${moneyMonth(best.cost * taskCount)}</strong> — over ~${tasks} tasks.`;
}

export interface GateDelta { moved: boolean; text: string; }

/**
 * The sentence the soft gate uses after it has let an assumption change
 * through. It names the visitor's pinned model if that moved, otherwise the
 * top modelled row (the one the eye is on), otherwise the largest mover.
 * Measured rows are never in this list — no assumption can move them.
 * `moved: false` means no row changed: the caller must not gate a no-op.
 */
export function gateDelta(before: Row[], after: Row[], control: string, highlight?: string): GateDelta {
  const prev = new Map(before.filter((r) => r.basisKey !== 'measured_by_source').map((r) => [r.m.model_id, r.cost]));
  const movedOf = (r: Row) => { const a = prev.get(r.m.model_id); return a !== undefined && Math.abs(a - r.cost) >= 0.005 ? { name: r.m.display_name, a, b: r.cost } : null; };
  const modelled = after.filter((r) => r.basisKey === 'modelled_by_solvency');
  const pinned = highlight ? after.find((r) => r.m.model_id === highlight && r.basisKey !== 'measured_by_source') : undefined;
  let pick = (pinned && movedOf(pinned)) || (modelled[0] && movedOf(modelled[0])) || null;
  if (!pick) {
    // the visible modelled group first; stale rows (behind a disclosure) only if nothing else moved
    for (const key of ['modelled_by_solvency', 'historical_at_run_date']) {
      for (const r of after) {
        if (r.basisKey !== key) continue;
        const d = movedOf(r); if (!d) continue;
        if (!pick || Math.abs(d.a - d.b) > Math.abs(pick.a - pick.b)) pick = d;
      }
      if (pick) break;
    }
  }
  return pick
    ? { moved: true, text: `${control} moves ${pick.name} from ${money(pick.a)} to ${money(pick.b)} a task.` }
    : { moved: false, text: `${control} leaves every modelled row where it is at this tier.` };
}

const escText = (t: string) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
/** The "Not shown" sentence; the pinned model's name (from Find a model) is emphasised at the destination. */
export const missingHtml = (missing: string[], emphasise?: string) =>
  missing.length
    ? `No published pass rate, so reported as missing rather than estimated: ${missing.map((n) => emphasise && n.replace(/ \(.*$/, '') === emphasise ? `<strong class="text-[var(--color-ink)]">${escText(n)}</strong>` : escText(n)).join(', ')}.`
    : 'Every tracked current model has a published pass rate under these settings.';

/** Validated model id for ?highlight= */
export const validModelId = (id: string | null) => (id && models.some((m) => m.model_id === id)) ? id : undefined;
