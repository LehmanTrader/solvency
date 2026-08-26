/**
 * Inline SVG charts, built from compute() output. Pure functions: rows in,
 * SVG string out. Rendered once at build (so the page is complete without JS)
 * and again by the island on every input. No library.
 *
 * Rules (docs/landing-spec.md §4, revised by the stage-1.1 color note in
 * docs/redesign-2026-08/direction.md): measured = solid purple, modelled =
 * the SAME purple hatched (the hatch carries the basis distinction, not a
 * second hue), stale = hollow + dashed coral, unchanged — and the word is
 * always printed, never color alone. The lead row in each group gets an
 * amber heat wash instead (see the `mark` builder below): amber is the
 * brand/highlight accent, purple is the data accent, and the two are kept
 * off the same job so bars and highlight read as separate things. Every
 * chart has <title> and <desc>; ranked rows are <g role="listitem"> with an
 * aria-label that reads as a sentence. Colors come from CSS variables (see
 * .chart in global.css) so one SVG serves light and dark.
 *
 * Type inside the charts uses two sizes only — 10.5 (captions, ticks, labels)
 * and 12.8 (values, names) — the two smallest steps of the site's type scale.
 *
 * Ranked-bars rows (Chart A) carry the Arena-grammar leaderboard treatment
 * from docs/redesign-2026-08/direction.md §6: a rank digit, the provider's
 * logo chip (site/src/lib/providers.ts), the model name in mono, a small
 * "Provider" subline, and — since Solvency already groups rows into their
 * own Measured/Modelled/Stale sections (unlike Arena's single interleaved
 * table) — a repeated "· basis" on the subline would be redundant, so it is
 * left off; the group header already carries that word once. The best row
 * in each group (the actual cheapest by cost — see `bestId` in rankedBars,
 * stable across a resort) gets a subtle amber heat wash across the full row,
 * in addition to its existing left rail — amber, not the group's basis
 * color, so the "which row is best" highlight never fights the purple bar
 * for the same job (stage 1.1 color note).
 *
 * Stage 2: rankedBars also carries a Pass column (desktop only) and an
 * optional `sort` (RankedOpts.sort) that reorders rows by name / pass /
 * cost / month — $/month orders identically to cost at a fixed volume, so
 * only the active-header label differs. `sortable: true` (the homepage
 * Ranking view only, wired in Calculator.astro) swaps the inert header
 * caption for real keyboard-operable <button>s with aria-sort, drawn via a
 * <foreignObject> so they get native button semantics rather than an
 * SVG-only approximation of one.
 */
import { chipMarkup, providerLabel } from './providers.ts';
import type { RateCaps } from '../../../scripts/types.ts';

/**
 * Free-model coverage (docs/free-models-scoping.md §4): a fourth basis,
 * `free`, alongside measured/modelled/stale. It is visually distinguished
 * from measured (solid fill) and modelled (hatch fill) by a dotted OUTLINE
 * instead of a new hue — reusing --color-purple's already-cited contrast
 * (5.44:1 light / 7.20:1 dark, site/src/styles/global.css) rather than
 * inventing a color the "two accents, two jobs" rule would then have to
 * account for. Never confused with stale's dashed outline: different color
 * (purple, not stale's rust/coral #A8451B) AND a tighter dash (dotted, not
 * dashed).
 */
export type Basis = 'measured' | 'modelled' | 'stale' | 'free';

export interface ChartRow {
  id: string;
  name: string;
  href: string;
  /** $ per solved task */
  cost: number;
  /** 0..1 */
  pass: number;
  basis: Basis;
  harness?: string;
  /** $ per attempt, where known */
  attempt?: number;
  /** link to /compare/… for this row */
  compare?: string;
  /** a caveat printed in the row's detail (e.g. computed uncached) */
  note?: string;
  /** data/models.json provider id — drives the row's logo chip and subline */
  provider?: string;
  /** Free-model coverage: compact rate-cap label ("cap: 20 req/min, 50 req/day"), free-basis rows only. */
  caps?: string;
}

export const BASIS_OF: Record<string, Basis> = {
  measured_by_source: 'measured', modelled_by_solvency: 'modelled', historical_at_run_date: 'stale',
  free_tier_capped: 'free',
};

export const BASIS_WORD: Record<Basis, string> = { measured: 'MEASURED', modelled: 'MODELLED', stale: 'STALE', free: 'FREE · RATE-CAPPED' };

/**
 * The compact per-row cap label ("cap: 20 req/min, 50 req/day", "cap: 1M
 * tok/day", or "cap: not published" when a free row's caps were checked and
 * nothing was found — MISSING, never fabricated as unlimited). Full
 * provenance (rate_caps.source_url/last_verified) lives on the model page,
 * not squeezed into this label; see site/src/pages/models/[id].astro.
 */
export function capsLabel(caps: RateCaps | null | undefined): string {
  if (!caps) return 'cap: not published';
  const parts: string[] = [];
  if (caps.requests_per_minute != null) parts.push(`${caps.requests_per_minute.toLocaleString()} req/min`);
  if (caps.requests_per_day != null) parts.push(`${caps.requests_per_day.toLocaleString()} req/day`);
  if (caps.tokens_per_minute != null) parts.push(`${caps.tokens_per_minute.toLocaleString()} tok/min`);
  if (caps.tokens_per_day != null) parts.push(`${caps.tokens_per_day.toLocaleString()} tok/day`);
  return parts.length ? `cap: ${parts.join(', ')}` : 'cap: not published';
}

export const money = (n: number) =>
  n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
/** Monthly totals are whole dollars: $24, $423, $2.4k, $1.2M. */
export const moneyMonth = (n: number) =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${Math.round(n)}`;

const esc = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const r1 = (n: number) => Math.round(n * 10) / 10;
const pct = (p: number) => `${Math.round(p * 100)}%`;
const FS_S = 10.5, FS_M = 12.8;
const CHAR = 0.6; // JetBrains Mono advance, em
const textW = (s: string, size: number) => s.length * size * CHAR;
const trunc = (s: string, px: number, size = FS_M) => {
  const n = Math.floor(px / (CHAR * size));
  return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s;
};

/** The modelled hatch, referenced by every modelled bar. Stale bars are a dashed outline instead. */
const hatch = () =>
  `<pattern id="hatch-modelled" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)" style="color:var(--color-modelled)">` +
  `<line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" stroke-width="2"/></pattern>`;

// ---------------------------------------------------------------------------
// Chart A — ranked bars (the result itself)
// ---------------------------------------------------------------------------

/** Stage 2: the four columns the homepage Ranking view's headers can sort by. */
export type RankSortKey = 'name' | 'pass' | 'cost' | 'month';
export interface RankSort { key: RankSortKey; dir: 'asc' | 'desc'; }

export interface RankedOpts {
  width: number;
  volume: number;
  basis: Basis;
  /** Narrow layout: $/month under the name, taller rows. */
  compact?: boolean;
  /** model id to outline (from ?highlight=) */
  highlight?: string;
  title?: string;
  /** Row order. Defaults to cost ascending (the pre-stage-2 behavior). $/month
   * is a monotonic function of cost at a fixed volume (every row in one group
   * shares the same volume), so it orders identically to 'cost' — only which
   * header reads as active differs. */
  sort?: RankSort;
  /** Renders the header cells as real keyboard-operable <button>s with
   * aria-sort (site/src/components/Calculator.astro wires the clicks) instead
   * of the plain inert caption text every other caller keeps. Stage 2, scoped
   * to the homepage Ranking view only — see docs/redesign-2026-08/direction.md
   * §6 and the stage-2 task brief's "Sortable Ranking table" item. */
  sortable?: boolean;
}

/**
 * Horizontal bars, one SVG per cost basis, sorted ascending by $/solved.
 * Bars are scaled to the maximum within this group only; sharing a scale
 * across bases would invite a cross-group reading.
 */
/** Sort comparators for the four ranking columns; $/month reuses cost's
 * (see RankedOpts.sort above — same order, different active-header label). */
const RANK_CMP: Record<RankSortKey, (a: ChartRow, b: ChartRow) => number> = {
  name: (a, b) => a.name.localeCompare(b.name),
  pass: (a, b) => a.pass - b.pass,
  cost: (a, b) => a.cost - b.cost,
  month: (a, b) => a.cost - b.cost,
};

export function rankedBars(rowsIn: ChartRow[], o: RankedOpts): string {
  // "Keep MISSING rows pinned below real values in any sort" (stage-2 brief):
  // rowsIn never contains a missing row to begin with — compute() in calc.ts
  // routes models with no published pass rate into the separate `missing`
  // list before a ChartRow is ever built, so there is nothing here to pin.
  // Free-model coverage: every free row is $0, so "cheapest first" is a
  // degenerate, arbitrary tie-break — the group's own note (calc.ts GROUPS)
  // says free rows are ranked by pass rate instead. Only applies when the
  // caller hasn't already asked for a specific order.
  const sortKey = o.sort?.key ?? (o.basis === 'free' ? 'pass' : 'cost');
  const sortDir = o.sort?.dir ?? (o.basis === 'free' ? 'desc' : 'asc');
  const rows = rowsIn.slice().sort(RANK_CMP[sortKey]);
  if (sortDir === 'desc') rows.reverse();
  // The best-in-class amber mark (direction doc §6) always names the actual
  // cheapest row, independent of the sort column/direction above — sorting by
  // name or pass must not make the highlight jump to whichever row lands
  // first, or "which row is best" and "row 1 of this view" would blur together.
  // Free-model coverage: every row in a free group ties at $0, so no row is
  // meaningfully "cheapest" — the amber lead mark is suppressed there rather
  // than landing on an arbitrary tie-break winner.
  const bestId = (o.basis !== 'free' && rowsIn.length) ? rowsIn.slice().sort((a, b) => a.cost - b.cost)[0].id : undefined;
  const w = Math.max(300, Math.round(o.width));
  const compact = o.compact ?? w < 560;
  // Desktop rows grew from 30 to 44px to fit a logo chip and a "Provider"
  // subline under the model name (direction doc §6); compact rows keep the
  // existing 48px — there is no room there for a third stacked line, so the
  // subline is desktop-only (see the module comment above).
  const rowH = compact ? 48 : 44;
  // Sortable headers (stage 2) are real HTML <button>s in a <foreignObject>,
  // which need more breathing room than the inert caption's 20px band.
  const headH = compact ? 0 : (o.sortable ? 32 : 20);
  const h = headH + rows.length * rowH + 6;
  const max = Math.max(...rows.map((r) => r.cost), 0);
  const basis = o.basis;
  const word = BASIS_WORD[basis];
  const sig = `${basis}|${w}|${compact ? 'c' : 'd'}|${rows.map((r) => r.id).sort().join(',')}`;

  // columns. Pass rate (stage 2, direction doc §6: "pass rate with ±") is a
  // visible desktop column now, not just tooltip/aria-label text — it sits
  // just left of $/solved, in the same reserved-right-margin budget.
  // Founder fix (screenshot review): the sortable header's own label text
  // ("$ / SOLVED", "$ / MONTH") is wider than the numeral it sits above
  // ("$12.01") and was wrapping inside the numeral-sized column budget.
  // Sortable headers get a roomier reserved width so the label always fits
  // on one line; xPass/xSolved/xMonth (each column's right edge, below)
  // don't depend on these widths, so the value cells stay exactly where
  // they were and the header still lands right-aligned over them.
  const cmpW = compact ? 0 : 62,
    monthW = compact ? 0 : (o.sortable ? 92 : 66),
    solvedW = compact ? 0 : (o.sortable ? 98 : 70),
    passW = compact ? 0 : (o.sortable ? 60 : 46),
    gap = 14;
  const labelW = compact ? w : Math.min(230, Math.round(w * 0.27));
  const barX = compact ? 0 : labelW + 12;
  const barEnd = compact ? w - 132 : w - cmpW - monthW - solvedW - passW - gap * 3;
  const barMax = Math.max(40, barEnd - barX);
  const xPass = compact ? w : w - cmpW - monthW - solvedW - gap * 2;
  const xSolved = compact ? w : w - cmpW - monthW - gap;
  const xMonth = compact ? w : w - cmpW;
  const fs = FS_M;

  // rank digit + logo chip + name/subline prefix, ahead of the bar
  const rankW = compact ? 12 : 16;
  const chipSize = compact ? 16 : 20;
  const chipX = rankW + (compact ? 2 : 4);
  const nameX = chipX + chipSize + (compact ? 6 : 8);

  // measured: solid, non-lead dimmed by CSS; modelled: hatched; stale: dashed
  // outline, no hatch; free: DOTTED outline, no hatch, no fill — same purple
  // hue as measured/modelled (not a new color, see the Basis doc comment
  // above) but neither solid nor hatched, so it can never be mistaken for
  // either, and a tighter dash than stale's so the two outline styles don't
  // read as the same thing in a different color.
  // "Lead" here means the actual cheapest row (bestId), not row 0 of whatever
  // sort is active — see the bestId note above the sort in this function.
  const fill = (r: ChartRow) => basis === 'measured'
    ? `fill="var(--color-measured)"${r.id === bestId ? '' : ' data-dim="1"'}`
    : basis === 'modelled'
      ? `fill="url(#hatch-modelled)" stroke="var(--color-modelled)" stroke-width="1"`
      : basis === 'free'
        ? `fill="transparent" stroke="var(--color-free)" stroke-width="1.5" stroke-dasharray="1 2"`
        : `fill="transparent" stroke="var(--color-stale)" stroke-width="1.5" stroke-dasharray="3 2"`;

  // One style for the axis caption and the column headers. Founder note
  // (screenshot review, 2026-08-26): the old "$ / SOLVED ⓘ" / "$ / MONTH ⓘ"
  // pair ran together with no gap, and didn't line up over their own value
  // columns. Root cause: the trailing "ⓘ" glyph was part of the same
  // text-anchor="end" run as the label, so it padded the label's measured
  // width — the label text (not the icon) then ended short of the column's
  // x, misaligned against the plain numeral in the row below it, and at
  // narrower widths the padded label could run into its neighbor's slot.
  // Fix: drop the visible glyph — each label keeps its <title> child, so the
  // WHOLE label is still a native-tooltip hover target — and anchor the bare
  // label text at the exact same x as its value cell below, so header and
  // value are pixel-exact aligned at any width, with no extra glyph to
  // collide with the next column.
  const ariaSort = (key: RankSortKey) => sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none';
  // Interactive header (stage 2, homepage Ranking view only — o.sortable):
  // real <button>s in a <foreignObject>, positioned with the exact same
  // x/width constants the row cells below use, so the header lines up with
  // its column without a second set of magic numbers to keep in sync.
  // site/src/components/Calculator.astro wires the clicks (event delegation)
  // and keeps a live region announcing the new order; this module only draws
  // the buttons and marks the active one via aria-sort.
  const sortBtn = (key: RankSortKey, label: string, x: number, bw: number, end: boolean) =>
    `<button type="button" class="rank-h" data-sort-key="${key}" aria-sort="${ariaSort(key)}" ` +
    `style="left:${end ? x - bw : x}px;width:${bw}px;text-align:${end ? 'right' : 'left'}">${label}</button>`;
  const header = compact ? '' : (o.sortable
    ? `<foreignObject x="0" y="0" width="${w}" height="${headH}">` +
      `<div xmlns="http://www.w3.org/1999/xhtml" class="rank-head" role="group" aria-label="Sort ${esc(word.toLowerCase())} rows">` +
      sortBtn('name', 'Model', nameX, labelW - nameX, false) +
      sortBtn('pass', 'Pass', xPass, passW, true) +
      sortBtn('cost', '$ / solved', xSolved, solvedW, true) +
      sortBtn('month', '$ / month', xMonth, monthW, true) +
      `</div></foreignObject>`
    : `<g class="t3 cap" font-size="${FS_S}" aria-hidden="true">` +
      `<text x="${barX}" y="12">$ / SOLVED TASK · LOWER IS BETTER</text>` +
      `<text x="${xPass}" y="12" text-anchor="end">PASS</text>` +
      `<text x="${xSolved}" y="12" text-anchor="end">$ / SOLVED<title>cost per solved task = cost per attempt ÷ pass rate. What it costs to get a task finished, not what a token costs.</title></text>` +
      `<text x="${xMonth}" y="12" text-anchor="end">$ / MONTH<title>$ / solved task × your monthly task volume.</title></text></g>`);

  const body = rows.map((r, i) => {
    const y = headH + i * rowH;
    const bw = max > 0 ? Math.max(3, Math.round((r.cost / max) * barMax)) : 3;
    const month = moneyMonth(r.cost * o.volume);
    // Free-model coverage: the rate cap is the load-bearing fact for this row
    // (a $0 price alone is meaningless without it — direction §4 "never lets
    // $0 stand alone") so it goes in the tooltip/aria-label detail on every
    // layout, plus a visible line (subline on desktop, replacing the $/mo
    // figure on compact — see below) rather than hover-only.
    const detail = [r.harness ? `harness ${r.harness}` : '', `pass rate ${pct(r.pass)}`, r.attempt != null ? `${money(r.attempt)} per attempt` : '', r.caps ?? '', r.note ?? ''].filter(Boolean).join(' · ');
    const provider = r.provider ? providerLabel(r.provider) : undefined;
    const subline = [provider, r.caps].filter(Boolean).join(' · ');
    const label = `${i + 1}. ${r.name}${provider ? `, ${provider}` : ''}, ${basis}, ${money(r.cost)} per solved task, ${month} a month at ${o.volume.toLocaleString()} tasks. ${detail}.`;
    const cls = `row${r.id === bestId ? ' lead' : ''}${o.highlight === r.id ? ' hl' : ''}`;
    // full-row-height hit rects so every link is a ≥ 44 px target on small screens
    const hitRow = `<rect class="hit" x="0" y="0" width="${compact ? w - 120 : barX}" height="${rowH}" fill="transparent"/>`;
    const cmp = r.compare ? (compact
      ? `<a class="cmp" href="${esc(r.compare)}" aria-label="Compare vs ${esc(r.name)} head to head"><rect class="hit" x="${w - 120}" y="0" width="120" height="${rowH}" fill="transparent"/><text x="${w - 118}" y="${rowH - 14}" font-size="${FS_S}" class="t3">vs ›</text></a>`
      : `<a class="cmp" href="${esc(r.compare)}" aria-label="Compare ${esc(r.name)} head to head"><rect class="hit" x="${w - cmpW}" y="0" width="${cmpW}" height="${rowH}" fill="transparent"/><text x="${w}" y="${rowH / 2 + 4}" text-anchor="end" font-size="${FS_S}" class="t3">compare ›</text></a>`) : '';
    // rail (lead's left-edge accent) and heat wash (lead's full-row amber
    // tint, "best in class" per direction §6) are one <g> immediately after
    // <title> so patchRanked's title-adjacency lookup keeps finding it as a
    // unit. Amber, not var(--color-${basis}): the highlight is a UI job, kept
    // off the bar's own (purple) data color per the stage 1.1 color note.
    const mark = r.id === bestId
      ? `<g class="mark"><rect width="2" height="${rowH}" fill="var(--color-accent)"/><rect class="heat" x="0" y="0" width="${w}" height="${rowH}" fill="var(--color-accent)" opacity=".07"/></g>`
      : '';
    const rank = `<text class="t3 rank-n" data-f="rank" x="${rankW - 4}" y="${rowH / 2 + 4}" text-anchor="end" font-size="${FS_S}">${i + 1}</text>`;
    const chip = r.provider ? `<g transform="translate(${chipX},${(rowH - chipSize) / 2})">${chipMarkup(r.provider, chipSize)}</g>` : '';
    const name = trunc(r.name, (compact ? w - 90 : labelW - 6) - nameX, fs);
    return compact
      ? `<g class="${cls}" data-id="${esc(r.id)}" role="listitem" aria-label="${esc(label)}" style="transform:translateY(${y}px);--i:${i}">` +
        `<title>${esc(detail)}</title>${mark}${rank}${chip}` +
        `<a href="${esc(r.href)}">${hitRow}<text class="name" x="${nameX}" y="16" font-size="${fs}">${esc(name)}</text></a>` +
        `<text class="v c-${basis}" data-f="solved" x="${xSolved}" y="16" text-anchor="end" font-size="${fs}" font-weight="700">${money(r.cost)}</text>` +
        `<rect class="track" x="8" y="${rowH - 22}" width="${barMax - 8}" height="10" rx="2"/>` +
        `<rect class="bar" x="8" y="${rowH - 22}" width="${bw}" height="10" rx="2" style="width:${bw}px" ${fill(r)}/>` +
        cmp +
        // Compact layout has no room for a third stacked line: a free row's
        // $/mo figure is always $0 (uninteresting — it's the row's whole
        // point), so its cap label takes that slot instead of duplicating "$0".
        `<text class="t2" data-f="month" x="${xMonth}" y="${rowH - 13}" text-anchor="end" font-size="${FS_S}">${basis === 'free' && r.caps ? esc(r.caps) : `${month}/mo`}</text></g>`
      : `<g class="${cls}" data-id="${esc(r.id)}" role="listitem" aria-label="${esc(label)}" style="transform:translateY(${y}px);--i:${i}">` +
        `<title>${esc(detail)}</title>${mark}${rank}${chip}` +
        `<a href="${esc(r.href)}">${hitRow}<text class="name" x="${nameX}" y="19" font-size="${fs}">${esc(name)}</text>` +
        (subline ? `<text class="t3 sub" x="${nameX}" y="34" font-size="${FS_S}">${esc(subline)}</text>` : '') + `</a>` +
        `<rect class="track" x="${barX}" y="${rowH / 2 - 5}" width="${barMax}" height="10" rx="2"/>` +
        `<rect class="bar" x="${barX}" y="${rowH / 2 - 5}" width="${bw}" height="10" rx="2" style="width:${bw}px" ${fill(r)}/>` +
        `<text class="v t3" data-f="pass" x="${xPass}" y="${rowH / 2 + 4.5}" text-anchor="end" font-size="${FS_S}">${pct(r.pass)}</text>` +
        `<text class="v c-${basis}" data-f="solved" x="${xSolved}" y="${rowH / 2 + 4.5}" text-anchor="end" font-size="${fs}" font-weight="700">${money(r.cost)}</text>` +
        `<text class="v" data-f="month" x="${xMonth}" y="${rowH / 2 + 4.5}" text-anchor="end" font-size="${fs}">${month}</text>` +
        cmp + `</g>`;
  }).join('');

  const SORT_LABEL: Record<RankSortKey, string> = { name: 'model name', pass: 'pass rate', cost: '$/solved task', month: '$/month' };
  const orderWord = sortKey === 'cost' && sortDir === 'asc' ? 'ranked cheapest first' : `sorted by ${SORT_LABEL[sortKey]}, ${sortDir === 'asc' ? 'ascending' : 'descending'}`;
  const title = o.title ?? `${word}: cost per solved task, ${sortKey === 'cost' && sortDir === 'asc' ? 'ranked' : SORT_LABEL[sortKey] + ' order'}`;
  const desc = `${rows.length} ${basis} rows, ${orderWord}. ${rows.map((r, i) => `${i + 1} ${r.name} ${money(r.cost)}`).join('; ')}. Monthly figures at ${o.volume.toLocaleString()} tasks.`;
  return `<svg class="chart ranked${compact ? ' compact' : ''}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="list" aria-label="${esc(title)}" data-sig="${esc(sig)}" data-basis="${basis}">` +
    `<title>${esc(title)}</title><desc>${esc(desc)}</desc><defs>${hatch()}</defs>${header}${body}</svg>`;
}

/**
 * Re-sort in place: when the row set is unchanged, move the existing <g>
 * rows to their new y (CSS transitions the transform) and patch bar widths
 * and values; otherwise replace the SVG outright.
 */
export function patchRanked(container: Element, html: string): void {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const next = tpl.content.querySelector('svg');
  const cur = container.querySelector('svg');
  if (!next || !cur || cur.getAttribute('data-sig') !== next.getAttribute('data-sig')) {
    container.innerHTML = html;
    return;
  }
  cur.setAttribute('aria-label', next.getAttribute('aria-label') ?? '');
  // Stage 2: title/desc text now names the active sort (see rankedBars'
  // orderWord above), so a resort must patch them too, not just row content.
  const t = next.querySelector('title'), ct = cur.querySelector('title');
  if (t && ct) ct.textContent = t.textContent;
  const d = next.querySelector('desc'), cd = cur.querySelector('desc');
  if (d && cd) cd.textContent = d.textContent;
  // The interactive header (o.sortable) is outside the per-row loop below —
  // sync its aria-sort states here so the newly-active column is marked.
  next.querySelectorAll<HTMLButtonElement>('button.rank-h').forEach((nh) => {
    const key = nh.dataset.sortKey;
    const ch = cur.querySelector<HTMLButtonElement>(`button.rank-h[data-sort-key="${CSS.escape(key ?? '')}"]`);
    if (ch) ch.setAttribute('aria-sort', nh.getAttribute('aria-sort') ?? 'none');
  });
  next.querySelectorAll<SVGGElement>('g.row').forEach((nr) => {
    const id = nr.getAttribute('data-id')!;
    const cr = cur.querySelector<SVGGElement>(`g.row[data-id="${CSS.escape(id)}"]`);
    if (!cr) return;
    cr.setAttribute('class', nr.getAttribute('class') ?? 'row');
    cr.setAttribute('aria-label', nr.getAttribute('aria-label') ?? '');
    cr.style.transform = nr.style.transform;
    const nt = nr.querySelector('title'), ct = cr.querySelector('title');
    if (nt && ct) ct.textContent = nt.textContent;
    const nb = nr.querySelector<SVGRectElement>('rect.bar'), cb = cr.querySelector<SVGRectElement>('rect.bar');
    if (nb && cb) {
      cb.setAttribute('width', nb.getAttribute('width')!);
      cb.style.width = nb.style.width;
      if (nb.hasAttribute('data-dim')) cb.setAttribute('data-dim', '1'); else cb.removeAttribute('data-dim');
    }
    // lead marker (rail + heat wash, one <g class="mark">) appears/disappears with rank
    const nMark = nr.querySelector(':scope > title + g.mark');
    const cMark = cr.querySelector(':scope > title + g.mark');
    if (nMark && !cMark) cr.querySelector('title')!.insertAdjacentElement('afterend', nMark.cloneNode(true) as Element);
    if (!nMark && cMark) cMark.remove();
    nr.querySelectorAll<SVGTextElement>('[data-f]').forEach((nt2) => {
      const ct2 = cr.querySelector<SVGTextElement>(`[data-f="${nt2.dataset.f}"]`);
      if (ct2) ct2.textContent = nt2.textContent;
    });
    const na = nr.querySelector<SVGAElement>('a.cmp'), ca = cr.querySelector<SVGAElement>('a.cmp');
    if (na && ca) ca.setAttribute('href', na.getAttribute('href')!);
  });
}

// ---------------------------------------------------------------------------
// Chart B — cost vs pass rate with a Pareto frontier on measured points
// ---------------------------------------------------------------------------

export interface ScatterOpts {
  width: number;
  height?: number;
  compact?: boolean;
  /** model id to label directly (the visitor's lead row) */
  lead?: string;
  showStale?: boolean;
  /** Include the "Frontier models" ranked list beside the chart. Wide
   * layouts only — the caller decides whether there's room (stage 1.2,
   * Roy's note 6: skip it at narrow widths rather than cram it in). */
  rail?: boolean;
}

/** Measured points nobody beats on both axes, sorted by pass rate ascending. */
export function paretoFrontier(rows: ChartRow[]): ChartRow[] {
  const m = rows.filter((r) => r.basis === 'measured').slice().sort((a, b) => b.pass - a.pass || a.cost - b.cost);
  const out: ChartRow[] = [];
  let best = Infinity;
  for (const r of m) if (r.cost < best) { out.push(r); best = r.cost; }
  return out.sort((a, b) => a.pass - b.pass);
}

/**
 * "Nice" 1-2-5 log-scale steps within [lo, hi] — tight to the plotted data
 * (stage 1.2, Roy's note 6: "no dead space"). A plain floor/ceil-to-power-
 * of-ten domain snaps outward to a whole decade even when the data spans a
 * fraction of one (e.g. $0.08–$0.92 would become the $0.1–$1 frame with a
 * decade of headroom on each side); this instead only ever proposes ticks
 * that actually fall inside the padded domain.
 */
function niceLogTicks(lo: number, hi: number): number[] {
  const out: number[] = [];
  const e0 = Math.floor(Math.log10(lo)), e1 = Math.ceil(Math.log10(hi));
  for (let e = e0; e <= e1; e++) {
    for (const m of [1, 2, 5]) {
      const v = m * Math.pow(10, e);
      if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v);
    }
  }
  return out;
}

/**
 * The "Frontier models" ranked list — logo, name, $/solved — that sits
 * beside the chart on wide layouts (ScatterOpts.rail). Same house grammar
 * as the ranked table: cheapest first, mono values, the same provider logo
 * chips (site/src/lib/providers.ts) used everywhere else a model is named.
 */
function frontierRailHtml(front: ChartRow[]): string {
  if (!front.length) return '';
  const rows = front.slice().sort((a, b) => a.cost - b.cost).map((p) => {
    const chip = `<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">${chipMarkup(p.provider ?? '', 18)}</svg>`;
    return `<li class="frail-row"><span class="frail-chip">${chip}</span>` +
      `<a class="frail-name" href="${esc(p.href)}">${esc(p.name)}</a>` +
      `<span class="frail-cost">${money(p.cost)}</span></li>`;
  }).join('');
  return `<aside class="frontier-rail" aria-label="Frontier models, cheapest first">` +
    `<p class="frail-h t3 cap">FRONTIER MODELS</p><ol class="frail-list">${rows}</ol></aside>`;
}

export function scatterPareto(rows: ChartRow[], o: ScatterOpts): string {
  const compact = o.compact ?? o.width < 560;
  const w = Math.max(300, Math.round(o.width));
  const h = o.height ?? (compact ? w : Math.round(w * 0.58));
  const preZero = rows.filter((r) => r.basis !== 'stale' || o.showStale);
  // Engine guard (docs/free-models-scoping.md §2D): a $0 point poisons
  // Math.log10 (log10(0) === -Infinity), collapsing the log-x axis for every
  // point in the chart, not just the free one. $0 rows are never plotted on
  // this log scale at all — free-model coverage's rows are always $0 by
  // definition, so this is also exactly the "free rows stay off the log
  // chart" honesty rule (docs/free-models-scoping.md §4): the excluded count
  // is folded into `desc` below so the omission is stated, not silent.
  const zeroCount = preZero.filter((r) => !(r.cost > 0)).length;
  const pts = preZero.filter((r) => r.cost > 0);
  // Stage 1.2 (Roy's note 6, 2026-08-26): axes swapped from stage 1 — score
  // (pass rate) on y, cost per solved task on log-x, matching Arena's own
  // Pareto-view grammar (direction.md's "What was actually observed on
  // arena.ai" §). Bounds fit tight to the plotted points on both axes (no
  // dead space): x uses a proportional log pad plus niceLogTicks() above
  // instead of snapping out to the next whole decade; y pads a couple of
  // points and rounds to the nearest 5%. MISSING rows never reach `pts` —
  // they were dropped upstream in calc.ts's allChartRows() — so there is
  // nothing here to impute.
  const ml = 48, mr = compact ? 16 : 20, mt = 36, mb = compact ? 40 : 34;
  const pw = w - ml - mr, ph = h - mt - mb;
  const costs = pts.map((p) => p.cost), passes = pts.map((p) => p.pass);
  // Log-scale domain floors at the minimum POSITIVE cost among the plotted
  // points (never 0 — see the zeroCount guard above); an empty `pts` (every
  // candidate row was $0 or there were none) falls back to an arbitrary
  // finite window rather than Math.min(...[]) === Infinity.
  const xmin = costs.length ? Math.min(...costs) / 1.15 : 0.01;
  const xmax = costs.length ? Math.max(...costs) * 1.15 : 1;
  let ymin = passes.length ? Math.max(0, Math.floor((Math.min(...passes) - 0.02) * 20) / 20) : 0;
  let ymax = passes.length ? Math.min(1, Math.ceil((Math.max(...passes) + 0.02) * 20) / 20) : 1;
  if (ymax - ymin < 0.05) { ymax = Math.min(1, ymin + 0.05); if (ymax - ymin < 0.05) ymin = Math.max(0, ymax - 0.05); }
  const X = (c: number) => ml + ((Math.log10(c) - Math.log10(xmin)) / (Math.log10(xmax) - Math.log10(xmin))) * pw;
  const Y = (p: number) => mt + ph - ((p - ymin) / (ymax - ymin)) * ph;

  const gx: string[] = [], xt: string[] = [];
  const xTicks = niceLogTicks(xmin, xmax);
  xTicks.forEach((c, i) => {
    // extreme ticks anchor inward so nothing hangs outside the frame
    const anchor = i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle';
    const dx = i === 0 ? -2 : i === xTicks.length - 1 ? 2 : 0;
    gx.push(`<line class="grid" x1="${r1(X(c))}" y1="${mt}" x2="${r1(X(c))}" y2="${mt + ph}"/>`);
    xt.push(`<text class="t3" x="${r1(X(c) + dx)}" y="${h - mb + 16}" text-anchor="${anchor}" font-size="${FS_S}">${money(c)}</text>`);
  });
  const yStepPct = ymax - ymin <= 0.2 ? 5 : ymax - ymin <= 0.4 ? 10 : ymax - ymin <= 0.6 ? 15 : 20;
  const yt: string[] = [];
  for (let pPct = Math.round(ymin * 100); pPct <= Math.round(ymax * 100); pPct += yStepPct) {
    const p = pPct / 100;
    yt.push(`<line class="grid" x1="${ml}" y1="${r1(Y(p))}" x2="${ml + pw}" y2="${r1(Y(p))}"/>` +
      `<text class="t3" x="${ml - 8}" y="${r1(Y(p)) + 3.5}" text-anchor="end" font-size="${FS_S}">${pPct}%</text>`);
  }

  const front = paretoFrontier(pts);
  let path = '';
  // the frontier's axis-aligned segments are obstacles for label placement
  const segs: { x0: number; y0: number; x1: number; y1: number }[] = [];
  front.forEach((p, i) => {
    const x = r1(X(p.cost)), y = r1(Y(p.pass));
    if (i === 0) path += `M${x} ${y}`;
    else {
      const prev = front[i - 1], px = r1(X(prev.cost)), py = r1(Y(prev.pass));
      path += ` L${x} ${py} L${x} ${y}`;
      segs.push({ x0: Math.min(px, x), y0: py, x1: Math.max(px, x), y1: py }, { x0: x, y0: Math.min(py, y), x1: x, y1: Math.max(py, y) });
    }
  });
  const crossesLine = (x0: number, y0: number, x1: number, y1: number) =>
    segs.some((g) => x0 < g.x1 + 1 && x1 > g.x0 - 1 && y0 < g.y1 + 1 && y1 > g.y0 - 1);
  const onFront = new Set(front.map((p) => p.id));
  const cheapest = pts.slice().sort((a, b) => a.cost - b.cost)[0]?.id;
  const dearest = pts.slice().sort((a, b) => b.cost - a.cost)[0]?.id;

  // Square logo-chip markers (site/src/lib/providers.ts's chipMarkup — the
  // same colored chips as the ranked table and everywhere else a model is
  // named, stage 1.2 note 1). Frontier models draw full-size and full
  // opacity; dominated models draw smaller and muted (note 6: "dominated
  // models as smaller, muted markers"). A basis ring around the chip —
  // solid for measured, dashed for modelled, dashed+muted for stale — is
  // the outline that keeps bases from ever blending silently; the legend
  // repeats the same distinction in words, never color alone.
  const FRONT_SIZE = compact ? 20 : 26, DOM_SIZE = compact ? 13 : 16;
  const rad = (p: ChartRow) => (onFront.has(p.id) ? FRONT_SIZE : DOM_SIZE) / 2;

  // Direct labels, placed greedily so none overlap: frontier and lead first,
  // then the rest. Right-hand slots are tried before left-hand ones so labels
  // sit on one side unless there is no room. Every mark is an obstacle.
  const FS = FS_S, LH = 12;
  const order = pts.slice().sort((a, b) => (Number(onFront.has(b.id) || b.id === o.lead) - Number(onFront.has(a.id) || a.id === o.lead)) || a.cost - b.cost);
  const placed: { x0: number; y0: number; x1: number; y1: number }[] = pts.map((p) => { const r = rad(p); return { x0: X(p.cost) - r - 1, y0: Y(p.pass) - r - 1, x1: X(p.cost) + r + 1, y1: Y(p.pass) + r + 1 }; });
  const label = new Map<string, { x: number; y: number; anchor: string } | null>();
  for (const p of order) {
    const wanted = onFront.has(p.id) || p.id === o.lead || !compact || p.id === cheapest || p.id === dearest;
    if (!wanted) { label.set(p.id, null); continue; }
    const x = r1(X(p.cost)), y = r1(Y(p.pass));
    const R = rad(p);
    const lw = textW(p.name, FS) + 2;
    const d = R + 4;
    const tries = [
      { x: x + d, y: y + 4, anchor: 'start' },
      { x: x + d, y: y - 6, anchor: 'start' }, { x: x + d, y: y + 14, anchor: 'start' },
      { x: x + d, y: y - 17, anchor: 'start' }, { x: x + d, y: y + 25, anchor: 'start' },
      { x, y: y - 11, anchor: 'middle' }, { x, y: y + 20, anchor: 'middle' },
      { x: x - d, y: y + 4, anchor: 'end' },
      { x: x - d, y: y - 6, anchor: 'end' }, { x: x - d, y: y + 14, anchor: 'end' },
      { x: x - d, y: y - 17, anchor: 'end' }, { x: x - d, y: y + 25, anchor: 'end' },
      { x: x + d, y: y - 28, anchor: 'start' }, { x: x + d, y: y + 36, anchor: 'start' },
      { x: x - d, y: y - 28, anchor: 'end' }, { x: x - d, y: y + 36, anchor: 'end' },
      { x, y: y - 22, anchor: 'middle' }, { x, y: y + 31, anchor: 'middle' },
    ];
    const box = (t: typeof tries[number]) => {
      const x0 = t.anchor === 'start' ? t.x : t.anchor === 'end' ? t.x - lw : t.x - lw / 2;
      return { x0, x1: x0 + lw, y0: t.y - LH + 2, y1: t.y + 3 };
    };
    const inFrame = (b: { x0: number; x1: number; y0: number; y1: number }) => b.x0 >= ml - 6 && b.x1 <= w - 2 && b.y0 >= mt - 2 && b.y1 <= mt + ph + 2;
    const overlap = (b: { x0: number; x1: number; y0: number; y1: number }) => placed.reduce((n, o2) => n + Math.max(0, Math.min(b.x1, o2.x1) - Math.max(b.x0, o2.x0)) * Math.max(0, Math.min(b.y1, o2.y1) - Math.max(b.y0, o2.y0)), 0);
    let pick: typeof tries[number] | null = null;
    for (const t of tries) {
      const b = box(t);
      if (!inFrame(b) || crossesLine(b.x0, b.y0, b.x1, b.y1) || overlap(b) > 0) continue;
      pick = t; placed.push(b); break;
    }
    // a frontier/lead label is never dropped: fall back to the in-frame slot
    // that overlaps least, never one the frontier line crosses
    if (!pick && (onFront.has(p.id) || p.id === o.lead)) {
      const ranked = tries.map((t) => ({ t, b: box(t) })).filter(({ b }) => inFrame(b) && !crossesLine(b.x0, b.y0, b.x1, b.y1))
        .sort((a, c) => overlap(a.b) - overlap(c.b));
      const best = ranked[0] ?? { t: tries[7], b: box(tries[7]) };
      pick = best.t; placed.push(best.b);
    }
    label.set(p.id, pick);
  }
  const marks = pts.slice().sort((a, b) => (a.basis === 'measured' ? 1 : 0) - (b.basis === 'measured' ? 1 : 0)).map((p) => {
    const x = r1(X(p.cost)), y = r1(Y(p.pass));
    const size = onFront.has(p.id) ? FRONT_SIZE : DOM_SIZE;
    const half = size / 2;
    const ringR = Math.max(2, Math.round(size * 0.22)) + 1;
    const tip = `${p.name} · ${BASIS_WORD[p.basis]} · ${money(p.cost)} per solved task · pass ${pct(p.pass)}${p.harness ? ' · ' + p.harness : ''}`;
    const ringCls = p.basis === 'measured' ? 'pt-measured' : p.basis === 'modelled' ? 'pt-modelled' : p.basis === 'free' ? 'pt-free' : 'pt-stale';
    const domCls = onFront.has(p.id) ? ' frontier-pt' : ' dominated';
    const mark = `<rect class="chip-ring" x="-2" y="-2" width="${size + 4}" height="${size + 4}" rx="${ringR}"/>` +
      `<g>${chipMarkup(p.provider ?? '', size)}</g>`;
    const l = label.get(p.id);
    const text = l ? `<text class="lbl${onFront.has(p.id) ? ' front' : ' t2'}" x="${r1(l.x)}" y="${r1(l.y)}" text-anchor="${l.anchor}" font-size="${FS}"${p.id === o.lead ? ' font-weight="700"' : ''}>${esc(p.name)}</text>` : '';
    // the designed tooltip (Calculator.astro reads these); aria-label carries the same sentence
    const data = `data-name="${esc(p.name)}" data-basis="${BASIS_WORD[p.basis]}" data-cost="${money(p.cost)}" data-pass="${pct(p.pass)}"${p.harness ? ` data-harness="${esc(p.harness)}"` : ''}`;
    return `<a class="pt ${ringCls}${domCls}" href="${esc(p.href)}" aria-label="${esc(tip)}" ${data}>` +
      `<circle class="hit" cx="${x}" cy="${y}" r="${Math.max(half + 6, compact ? 20 : 16)}" fill="transparent"/>` +
      `<g transform="translate(${r1(x - half)},${r1(y - half)})">${mark}</g>${text}</a>`;
  }).join('');

  const legendY = 12;
  const legend = compact
    ? `<g font-size="${FS_S}" class="t3"><text x="${ml}" y="${legendY}">PASS RATE ↑</text></g>`
    : `<g font-size="${FS_S}" class="t3"><text x="${ml}" y="${legendY}">PASS RATE ↑</text>` +
      `<rect class="chip-ring pt-measured" x="${ml + pw - 300}" y="${legendY - 8}" width="10" height="10" rx="2"/><text x="${ml + pw - 285}" y="${legendY}">MEASURED</text>` +
      `<rect class="chip-ring pt-modelled" x="${ml + pw - 205}" y="${legendY - 8}" width="10" height="10" rx="2"/><text x="${ml + pw - 190}" y="${legendY}">MODELLED · never on the frontier</text></g>`;

  const title = 'Cost per solved task against pass rate, with the measured Pareto frontier';
  const zeroNote = zeroCount ? ` ${zeroCount} free-tier ($0) row${zeroCount === 1 ? '' : 's'} excluded from this log-scale chart — cost is uniformly $0, which cannot be plotted on a log axis.` : '';
  const desc = `Scatter of ${pts.length} models: x is dollars per solved task on a log scale from $${money(xmin)} to $${money(xmax)}, y is pass rate ${Math.round(ymin * 100)}–${Math.round(ymax * 100)}%. The frontier joins the measured models nobody beats on both axes: ${front.map((p) => `${p.name} (${pct(p.pass)}, ${money(p.cost)})`).join(', ')}.${zeroNote}`;
  const svg = `<svg class="chart scatter" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(title)}">` +
    `<title>${esc(title)}</title><desc>${esc(desc)}</desc>` +
    gx.join('') + yt.join('') +
    `<line class="axis" x1="${ml}" y1="${mt + ph}" x2="${ml + pw}" y2="${mt + ph}"/><line class="axis" x1="${ml}" y1="${mt}" x2="${ml}" y2="${mt + ph}"/>` +
    xt.join('') +
    `<text class="t3" x="${ml + pw}" y="${h - 2}" text-anchor="end" font-size="${FS_S}">$ / SOLVED TASK (log) →</text>` +
    (path ? `<path class="frontier" d="${path}"/>` : '') + legend + marks + `</svg>`;
  return o.rail ? `<div class="frontier-view">${svg}${frontierRailHtml(front)}</div>` : svg;
}

// ---------------------------------------------------------------------------
// Chart C — monthly cost against volume (compare page)
// ---------------------------------------------------------------------------

export interface Series { id: string; name: string; basis: Basis; perTask: number; }
export interface LinesOpts { width: number; height?: number; volume: number; compact?: boolean; }

export const VOL_MIN = 10, VOL_MAX = 100_000;

/**
 * Baselines for a column of labels, pushed apart to `gap` and kept between
 * `lo` and `hi`. Order is preserved, so a label never crosses its neighbour.
 */
function declutter(desired: number[], gap: number, lo: number, hi: number): number[] {
  if (desired.length < 2) return desired.map((y) => Math.min(hi, Math.max(lo, y)));
  const order = desired.map((_, i) => i).sort((a, b) => desired[a] - desired[b]);
  const out = desired.slice();
  let prev = -Infinity;
  for (const i of order) { out[i] = Math.max(desired[i], prev + gap); prev = out[i]; }
  const over = Math.max(...out) - hi;
  if (over > 0) for (let i = 0; i < out.length; i++) out[i] -= over;
  const under = lo - Math.min(...out);
  if (under > 0) for (let i = 0; i < out.length; i++) out[i] += under;
  return out;
}

/**
 * Series color: with one or two lines the lead is amber (the verdict) and the
 * other is ink, so the categorical ramp never competes with the provenance
 * rule; three to six lines use the validated ramp. Dash always carries basis.
 */
export function volumeLines(seriesIn: Series[], o: LinesOpts): string {
  const seriesAll = seriesIn.slice(0, 6); // brand review's validated ceiling
  // Engine guard (docs/free-models-scoping.md §2D): Math.log10(0) === -Infinity
  // would collapse this log-log chart's y-domain the same way it does
  // scatterPareto's — a $0/task series (free-model coverage) has no position
  // on a strictly-positive log axis, so it is dropped here rather than
  // plotted as a phantom line at y=0. It still has its own row on every
  // linear (non-log) surface — the ranked table, the model page — this is
  // the one place it deliberately does not appear.
  const zeroCount = seriesAll.filter((s) => !(s.perTask > 0)).length;
  const series = seriesAll.filter((s) => s.perTask > 0);
  const compact = o.compact ?? o.width < 560;
  const w = Math.max(300, Math.round(o.width));
  const h = o.height ?? (compact ? Math.round(w * 0.75) : Math.round(w * 0.56));
  const ml = 52, mr = compact ? 14 : 150, mt = 22, mb = compact ? 38 : 30;
  const pw = w - ml - mr, ph = h - mt - mb;
  const lx0 = Math.log10(VOL_MIN), lx1 = Math.log10(VOL_MAX);
  const costs = series.map((s) => s.perTask);
  // A domain needs at least one positive-cost series; if every input was
  // $0 (or the array was empty), fall back to a finite, arbitrary window
  // instead of Math.min(...[]) === Infinity.
  const ly0 = costs.length ? Math.log10(Math.min(...costs) * VOL_MIN) - 0.25 : Math.log10(0.01 * VOL_MIN) - 0.25;
  const ly1 = costs.length ? Math.log10(Math.max(...costs) * VOL_MAX) + 0.25 : Math.log10(1 * VOL_MAX) + 0.25;
  const ymin = Math.pow(10, Math.ceil(ly0)), ymax = Math.pow(10, Math.floor(ly1));
  const X = (v: number) => ml + ((Math.log10(v) - lx0) / (lx1 - lx0)) * pw;
  const Y = (c: number) => mt + ph - ((Math.log10(c) - ly0) / (ly1 - ly0)) * ph;
  const kfmt = (n: number) => n >= 1000 ? `${n / 1000}k` : String(n);
  const mfmt = (n: number) => n >= 1e6 ? `$${n / 1e6}M` : n >= 1000 ? `$${n / 1000}k` : `$${n}`;
  const cls = (i: number) => series.length <= 2 && i === 1 ? 's-ink' : `s${i + 1}`;

  const grid: string[] = [];
  const vols: number[] = [];
  for (let v = VOL_MIN; v <= VOL_MAX; v *= 10) vols.push(v);
  vols.forEach((v, i) => {
    const anchor = i === 0 ? 'start' : i === vols.length - 1 ? 'end' : 'middle';
    grid.push(`<line class="grid" x1="${r1(X(v))}" y1="${mt}" x2="${r1(X(v))}" y2="${mt + ph}"/>` +
      `<text class="t3" x="${r1(X(v))}" y="${h - mb + 16}" text-anchor="${anchor}" font-size="${FS_S}">${kfmt(v)}</text>`);
  });
  for (let c = ymin; c <= ymax * 1.0001; c *= 10)
    grid.push(`<line class="grid" x1="${ml}" y1="${r1(Y(c))}" x2="${ml + pw}" y2="${r1(Y(c))}"/>` +
      `<text class="t3" x="${ml - 8}" y="${r1(Y(c)) + 3.5}" text-anchor="end" font-size="${FS_S}">${mfmt(c)}</text>`);

  const vol = Math.min(VOL_MAX, Math.max(VOL_MIN, o.volume));
  const vx = r1(X(vol));
  const right = vx > ml + pw * 0.7;
  // Two models can cost almost the same: their labels would print on top of
  // each other. Push the baselines apart to a minimum gap, keeping the order
  // and the block inside the frame, so the pair always reads as two rows.
  const rightY = declutter(series.map((s) => Y(s.perTask * VOL_MAX) + 4), 26, mt + 10, mt + ph - 12);
  const atY = declutter(series.map((s) => Y(s.perTask * vol) - 7), 19, mt + 14, mt + ph - 2);
  const lines = series.map((s, i) => {
    const k = cls(i);
    const y0 = r1(Y(s.perTask * VOL_MIN)), y1 = r1(Y(s.perTask * VOL_MAX));
    const at = s.perTask * vol;
    const ly = r1(rightY[i]);
    const label = compact ? '' : `<text class="${k}" x="${ml + pw + 8}" y="${ly}" font-size="${FS_S}">${esc(trunc(s.name, mr - 12, FS_S))}</text>` +
      `<text class="t3" x="${ml + pw + 8}" y="${ly + 12}" font-size="${FS_S}">${BASIS_WORD[s.basis]}</text>`;
    return `<g aria-label="${esc(`${s.name}, ${s.basis}: ${moneyMonth(at)} a month at ${vol.toLocaleString()} tasks`)}"><title>${esc(`${s.name} · ${BASIS_WORD[s.basis]} · ${money(s.perTask)} per solved task`)}</title>` +
      `<path class="line ${s.basis} ${k}" d="M${r1(X(VOL_MIN))} ${y0} L${r1(X(VOL_MAX))} ${y1}"/>` +
      `<circle class="${k}" cx="${vx}" cy="${r1(Y(at))}" r="4" fill="var(--color-bg)" stroke-width="2"/>` +
      `<text class="${k}" data-f="at-${i}" x="${vx + (right ? -8 : 8)}" y="${r1(atY[i])}" text-anchor="${right ? 'end' : 'start'}" font-size="${FS_M}" font-weight="700">${moneyMonth(at)}</text>${label}</g>`;
  }).join('');

  const legend = !compact ? '' : `<g font-size="${FS_S}">${series.map((s, i) => `<text class="${cls(i)}" x="${ml + 4}" y="${mt + 12 + i * 15}">— ${esc(trunc(s.name, pw - 60, FS_S))} · ${BASIS_WORD[s.basis]}</text>`).join('')}</g>`;
  const title = 'Monthly cost against tasks per month';
  const zeroNote = zeroCount ? ` ${zeroCount} free-tier ($0) series excluded — cost is uniformly $0, which cannot be plotted on a log axis.` : '';
  const desc = series.length
    ? `Log-log lines for ${series.map((s) => `${s.name} (${s.basis}, ${money(s.perTask)} per solved task)`).join(', ')} from ${VOL_MIN} to ${VOL_MAX.toLocaleString()} tasks a month. Marker at ${vol.toLocaleString()} tasks.${zeroNote}`
    : `No series with a positive cost per solved task to plot on this log scale.${zeroNote}`;
  // the volume marker's label sits above the frame so it can never collide with the x ticks or the axis title
  return `<svg class="chart lines" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(title)}" data-px0="${ml}" data-px1="${ml + pw}" style="touch-action:none">` +
    `<title>${esc(title)}</title><desc>${esc(desc)}</desc>` + grid.join('') +
    `<line class="axis" x1="${ml}" y1="${mt + ph}" x2="${ml + pw}" y2="${mt + ph}"/><line class="axis" x1="${ml}" y1="${mt}" x2="${ml}" y2="${mt + ph}"/>` +
    `<text class="t3" x="${ml + pw}" y="${h - 2}" text-anchor="end" font-size="${FS_S}">TASKS / MONTH (log) →</text>` +
    `<line class="marker" x1="${vx}" y1="${mt}" x2="${vx}" y2="${mt + ph}"/>` +
    `<text class="t2" x="${vx}" y="${mt - 10}" text-anchor="${right ? 'end' : vx < ml + pw * 0.3 ? 'start' : 'middle'}" font-size="${FS_S}">${vol.toLocaleString()} tasks</text>` +
    lines + legend + `</svg>`;
}
