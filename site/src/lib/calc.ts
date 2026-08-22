/**
 * Calculator rendering, shared by the server build and the client island.
 * The page ships with its default state already rendered, so it is useful
 * without JavaScript and does not shift layout when the island takes over.
 */
import { models, assumptions, tiers, bestResultFor, extrasFor } from './data.ts';
import { costPerSolvedTask, defaultOptions } from './engine.ts';

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

export const money = (n: number) =>
  n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;

const GROUPS = [
  { key: 'measured_by_source', title: 'Measured',
    note: 'The benchmark ran the model and observed this cost. No Solvency assumption is inside these figures.' },
  { key: 'modelled_by_solvency', title: 'Modelled',
    note: "Pass rate published, cost estimated by Solvency's loop model — an assumption." },
  { key: 'historical_at_run_date', title: 'Modelled from stale pass rates',
    note: 'Pass rates published before 2026. Cost recomputed at current prices; the pass rate is old.' },
];

export function compute(s: Settings) {
  const base = defaultOptions(assumptions);
  const opts = {
    ...base,
    cacheHitFraction: s.cache,
    residualHumanCostUsd: s.residual,
    frontierEfficiency: s.frontier ? base.frontierEfficiency
      : { ...base.frontierEfficiency, multipliers_by_tier: { light: 1, moderate: 1, heavy: 1 } },
  };
  const rows: any[] = [];
  const missing: string[] = [];
  for (const m of models) {
    const r = bestResultFor(m.model_id);
    if (!r) { if (m.status === 'current') missing.push(m.display_name); continue; }
    const out = costPerSolvedTask(m as any, s.tier, tiers[s.tier], r.pass_rate, opts, extrasFor(r));
    if (out.value === null) { missing.push(`${m.display_name} (${out.missing[0] ?? 'missing input'})`); continue; }
    rows.push({ m, r, cost: out.value[s.variant], basis: out.value.costBasis, basisKey: r.cost_basis });
  }
  rows.sort((a, b) => a.cost - b.cost);
  return { rows, missing };
}

const rowHtml = ({ m, r, cost, basis }: any, volume: number, i: number) => `
  <tr class="${i === 0 ? 'lead' : ''}">
    <td class="rank">${i + 1}</td>
    <td class="ink">
      <a href="/models/${m.model_id}">${m.display_name}</a>
      ${basis === 'measured_by_source' ? '<span class="ml-2 text-[9px] uppercase tracking-[0.14em] text-[var(--color-accent)]">measured</span>' : ''}
    </td>
    <td class="r">${(r.pass_rate * 100).toFixed(0)}%</td>
    <td class="r ${i === 0 ? 'accent' : 'ink'}">${money(cost)}</td>
    <td class="r ink">${money(cost * volume)}</td>
  </tr>`;

export function groupsHtml(rows: any[], volume: number) {
  return GROUPS.map((g) => {
    const inGroup = rows.filter((x) => x.basisKey === g.key);
    if (!inGroup.length) return '';
    return `
      <div class="border-b border-[var(--color-rule)] last:border-b-0">
        <div class="px-5 pt-4 pb-2">
          <p class="eyebrow ${g.key === 'measured_by_source' ? '' : 'text-[var(--color-warn)]!'}">${g.title}</p>
          <p class="mt-1 small">${g.note}</p>
        </div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr>
            <th class="rank">#</th><th>Model</th><th class="r">Pass</th>
            <th class="r">$ / solved task</th><th class="r">$ / month</th>
          </tr></thead>
          <tbody>${inGroup.map((x, i) => rowHtml(x, volume, i)).join('')}</tbody>
        </table></div>
      </div>`;
  }).join('');
}

/** Compares only within one cost basis; ranking measured against modelled is invalid. */
export function calloutHtml(rows: any[], volume: number) {
  const pool = GROUPS.map((g) => rows.filter((x) => x.basisKey === g.key)).find((g) => g.length > 1) ?? [];
  const cheapest = pool[0];
  const best = pool.slice().sort((a, b) => b.r.pass_rate - a.r.pass_rate)[0];
  if (!cheapest || !best) return '<span class="text-[var(--color-muted)]">No model has both a verified price and a published pass rate under these settings.</span>';
  if (cheapest.m.model_id === best.m.model_id)
    return `<strong class="text-[var(--color-accent)]">${cheapest.m.display_name}</strong> is both the cheapest per solved task and the highest pass rate here.`;
  return `<strong class="text-[var(--color-accent)]">${cheapest.m.display_name}</strong> costs ${money(cheapest.cost)} per solved task against
    <strong>${best.m.display_name}</strong> at ${money(best.cost)} — <strong class="text-[var(--color-accent)]">${(best.cost / cheapest.cost).toFixed(1)}x</strong> more
    for ${((best.r.pass_rate - cheapest.r.pass_rate) * 100).toFixed(0)} more points of pass rate.
    Over ${volume.toLocaleString()} tasks that difference is <strong class="text-[var(--color-accent)]">${money((best.cost - cheapest.cost) * volume)}</strong> a month.`;
}

export const missingHtml = (missing: string[]) =>
  missing.length ? `Not shown — no published pass rate, reported as missing rather than estimated: ${missing.join(', ')}.` : '';
