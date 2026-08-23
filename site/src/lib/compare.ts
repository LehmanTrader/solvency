/**
 * Head-to-head data for /compare/[a]-vs-[b], shared by the build and the
 * page's island so the verdict at ?tier=&volume= is computed the same way
 * the calculator computed it.
 */
import { modelById, bestResultFor, extrasFor, tiers, assumptions, sourceFor } from './data.ts';
import { costPerSolvedTask, defaultOptions } from './engine.ts';
import { money, moneyMonth, BASIS_OF, type Basis, type Series } from './charts.ts';
import { ratio, fmtX } from './headline.ts';

export type Tier = 'light' | 'moderate' | 'heavy';
export interface Side { m: any; r: any | null; cost: number | null; basis: Basis | null; }

export function side(id: string, tier: Tier): Side {
  const m = modelById(id)!;
  const r = bestResultFor(id);
  if (!r) return { m, r: null, cost: null, basis: null };
  const out = costPerSolvedTask(m as any, tier, tiers[tier], r.pass_rate, defaultOptions(assumptions), extrasFor(r));
  return { m, r, cost: out.value?.naive ?? null, basis: BASIS_OF[r.cost_basis] ?? 'modelled' };
}

export function verdictHtml(a: Side, b: Side, volume: number): string {
  const both = a.cost !== null && b.cost !== null;
  if (!both) return `<p class="label">No verdict</p>
    <p class="mt-2 text-[var(--color-ink)] leading-relaxed">Cost per solved task needs a published pass rate for both models. At least one has none, so it is reported as missing rather than estimated.</p>`;
  if (a.basis !== b.basis) return `<p class="label">No verdict</p>
    <p class="mt-2 text-[var(--color-ink)] leading-relaxed">One cost is <span class="t-${a.basis}">${a.basis}</span> and the other is <span class="t-${b.basis}">${b.basis}</span>. The two bases are never ranked against each other, so no verdict is given. Each figure is shown on its own basis below.</p>`;
  const [cheap, dear] = a.cost! <= b.cost! ? [a, b] : [b, a];
  const x = ratio(a.cost!, b.cost!);
  const saving = (dear.cost! - cheap.cost!) * volume;
  const tokenCheap = a.m.output_per_mtok <= b.m.output_per_mtok ? a : b;
  const flips = tokenCheap.m.model_id !== cheap.m.model_id;
  return `<p class="label">Verdict · <span class="t-${cheap.basis}">${cheap.basis}</span> basis</p>
    <p class="mt-2 text-[1.1rem] leading-relaxed text-[var(--color-ink)]">
      <strong>${cheap.m.display_name}</strong> costs <strong>${money(cheap.cost!)}</strong> per solved task against
      <strong>${dear.m.display_name}</strong> at ${money(dear.cost!)} — <strong class="t-better">▼ ${fmtX(x)} cheaper</strong>.
      Over ${volume.toLocaleString()} tasks that is <strong>${moneyMonth(saving)}</strong> a month.
    </p>
    <p class="mt-3 text-sm text-[var(--color-muted)] leading-relaxed">On output token price alone ${tokenCheap.m.display_name} looks ${fmtX(ratio(a.m.output_per_mtok, b.m.output_per_mtok))} cheaper.${flips ? ' The ranking reverses once you divide by pass rate — the cheaper tokens do not win the task.' : ' The ranking holds, but the margin changes.'}</p>`;
}

/** Cheaper first, so the chart's amber line is the verdict winner. */
export function seriesFor(sides: Side[]): Series[] {
  return sides.filter((s) => s.cost !== null).sort((a, b) => a.cost! - b.cost!)
    .map((s) => ({ id: s.m.model_id, name: s.m.display_name, basis: s.basis!, perTask: s.cost! }));
}

export const sourceOf = (s: Side) => (s.r ? sourceFor(s.r.benchmark) : null);
