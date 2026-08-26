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
 * in each group (i === 0) gets a subtle amber heat wash across the full row,
 * in addition to its existing left rail — amber, not the group's basis
 * color, so the "which row is best" highlight never fights the purple bar
 * for the same job (stage 1.1 color note).
 */
import { chipMarkup, providerLabel } from './providers.ts';

export type Basis = 'measured' | 'modelled' | 'stale';

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
}

export const BASIS_OF: Record<string, Basis> = {
  measured_by_source: 'measured', modelled_by_solvency: 'modelled', historical_at_run_date: 'stale',
};

export const BASIS_WORD: Record<Basis, string> = { measured: 'MEASURED', modelled: 'MODELLED', stale: 'STALE' };

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

export interface RankedOpts {
  width: number;
  volume: number;
  basis: Basis;
  /** Narrow layout: $/month under the name, taller rows. */
  compact?: boolean;
  /** model id to outline (from ?highlight=) */
  highlight?: string;
  title?: string;
}

/**
 * Horizontal bars, one SVG per cost basis, sorted ascending by $/solved.
 * Bars are scaled to the maximum within this group only; sharing a scale
 * across bases would invite a cross-group reading.
 */
export function rankedBars(rowsIn: ChartRow[], o: RankedOpts): string {
  const rows = rowsIn.slice().sort((a, b) => a.cost - b.cost);
  const w = Math.max(300, Math.round(o.width));
  const compact = o.compact ?? w < 560;
  // Desktop rows grew from 30 to 44px to fit a logo chip and a "Provider"
  // subline under the model name (direction doc §6); compact rows keep the
  // existing 48px — there is no room there for a third stacked line, so the
  // subline is desktop-only (see the module comment above).
  const rowH = compact ? 48 : 44;
  const headH = compact ? 0 : 20;
  const h = headH + rows.length * rowH + 6;
  const max = Math.max(...rows.map((r) => r.cost), 0);
  const basis = o.basis;
  const word = BASIS_WORD[basis];
  const sig = `${basis}|${w}|${compact ? 'c' : 'd'}|${rows.map((r) => r.id).sort().join(',')}`;

  // columns
  const cmpW = compact ? 0 : 62, monthW = compact ? 0 : 66, solvedW = compact ? 0 : 70, gap = 14;
  const labelW = compact ? w : Math.min(230, Math.round(w * 0.27));
  const barX = compact ? 0 : labelW + 12;
  const barEnd = compact ? w - 132 : w - cmpW - monthW - solvedW - gap * 2;
  const barMax = Math.max(40, barEnd - barX);
  const xSolved = compact ? w : w - cmpW - monthW - gap;
  const xMonth = compact ? w : w - cmpW;
  const fs = FS_M;

  // rank digit + logo chip + name/subline prefix, ahead of the bar
  const rankW = compact ? 12 : 16;
  const chipSize = compact ? 16 : 20;
  const chipX = rankW + (compact ? 2 : 4);
  const nameX = chipX + chipSize + (compact ? 6 : 8);

  // measured: solid, non-lead dimmed by CSS; modelled: hatched; stale: dashed outline, no hatch
  const fill = (i: number) => basis === 'measured'
    ? `fill="var(--color-measured)"${i === 0 ? '' : ' data-dim="1"'}`
    : basis === 'modelled'
      ? `fill="url(#hatch-modelled)" stroke="var(--color-modelled)" stroke-width="1"`
      : `fill="transparent" stroke="var(--color-stale)" stroke-width="1.5" stroke-dasharray="3 2"`;

  // one style for the axis caption and the column headers; ⓘ carries a
  // native SVG hover tooltip with the same explanation the "How it is
  // computed" panel gives (site/src/pages/index.astro's `how` tiles).
  const header = compact ? '' :
    `<g class="t3 cap" font-size="${FS_S}" aria-hidden="true">` +
    `<text x="${barX}" y="12">$ / SOLVED TASK · LOWER IS BETTER</text>` +
    `<text x="${xSolved}" y="12" text-anchor="end">$ / SOLVED ⓘ<title>cost per solved task = cost per attempt ÷ pass rate. What it costs to get a task finished, not what a token costs.</title></text>` +
    `<text x="${xMonth}" y="12" text-anchor="end">$ / MONTH ⓘ<title>$ / solved task × your monthly task volume.</title></text></g>`;

  const body = rows.map((r, i) => {
    const y = headH + i * rowH;
    const bw = max > 0 ? Math.max(3, Math.round((r.cost / max) * barMax)) : 3;
    const month = moneyMonth(r.cost * o.volume);
    const detail = [r.harness ? `harness ${r.harness}` : '', `pass rate ${pct(r.pass)}`, r.attempt != null ? `${money(r.attempt)} per attempt` : '', r.note ?? ''].filter(Boolean).join(' · ');
    const provider = r.provider ? providerLabel(r.provider) : undefined;
    const label = `${i + 1}. ${r.name}${provider ? `, ${provider}` : ''}, ${basis}, ${money(r.cost)} per solved task, ${month} a month at ${o.volume.toLocaleString()} tasks. ${detail}.`;
    const cls = `row${i === 0 ? ' lead' : ''}${o.highlight === r.id ? ' hl' : ''}`;
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
    const mark = i === 0
      ? `<g class="mark"><rect width="2" height="${rowH}" fill="var(--color-accent)"/><rect class="heat" x="0" y="0" width="${w}" height="${rowH}" fill="var(--color-accent)" opacity=".07"/></g>`
      : '';
    const rank = `<text class="t3 rank-n" data-f="rank" x="${rankW - 4}" y="${rowH / 2 + 4}" text-anchor="end" font-size="${FS_S}">${i + 1}</text>`;
    const chip = r.provider ? `<g transform="translate(${chipX},${(rowH - chipSize) / 2})">${chipMarkup(r.provider, chipSize)}</g>` : '';
    const name = trunc(r.name, (compact ? w - 90 : labelW - 6) - nameX, fs);
    return compact
      ? `<g class="${cls}" data-id="${esc(r.id)}" role="listitem" aria-label="${esc(label)}" style="transform:translateY(${y}px)">` +
        `<title>${esc(detail)}</title>${mark}${rank}${chip}` +
        `<a href="${esc(r.href)}">${hitRow}<text class="name" x="${nameX}" y="16" font-size="${fs}">${esc(name)}</text></a>` +
        `<text class="v c-${basis}" data-f="solved" x="${xSolved}" y="16" text-anchor="end" font-size="${fs}" font-weight="700">${money(r.cost)}</text>` +
        `<rect class="track" x="8" y="${rowH - 22}" width="${barMax - 8}" height="10" rx="2"/>` +
        `<rect class="bar" x="8" y="${rowH - 22}" width="${bw}" height="10" rx="2" style="width:${bw}px" ${fill(i)}/>` +
        cmp +
        `<text class="t2" data-f="month" x="${xMonth}" y="${rowH - 13}" text-anchor="end" font-size="${FS_S}">${month}/mo</text></g>`
      : `<g class="${cls}" data-id="${esc(r.id)}" role="listitem" aria-label="${esc(label)}" style="transform:translateY(${y}px)">` +
        `<title>${esc(detail)}</title>${mark}${rank}${chip}` +
        `<a href="${esc(r.href)}">${hitRow}<text class="name" x="${nameX}" y="19" font-size="${fs}">${esc(name)}</text>` +
        (provider ? `<text class="t3 sub" x="${nameX}" y="34" font-size="${FS_S}">${esc(provider)}</text>` : '') + `</a>` +
        `<rect class="track" x="${barX}" y="${rowH / 2 - 5}" width="${barMax}" height="10" rx="2"/>` +
        `<rect class="bar" x="${barX}" y="${rowH / 2 - 5}" width="${bw}" height="10" rx="2" style="width:${bw}px" ${fill(i)}/>` +
        `<text class="v c-${basis}" data-f="solved" x="${xSolved}" y="${rowH / 2 + 4.5}" text-anchor="end" font-size="${fs}" font-weight="700">${money(r.cost)}</text>` +
        `<text class="v" data-f="month" x="${xMonth}" y="${rowH / 2 + 4.5}" text-anchor="end" font-size="${fs}">${month}</text>` +
        cmp + `</g>`;
  }).join('');

  const title = o.title ?? `${word}: cost per solved task, ranked`;
  const desc = `${rows.length} ${basis} rows ranked cheapest first. ${rows.map((r, i) => `${i + 1} ${r.name} ${money(r.cost)}`).join('; ')}. Monthly figures at ${o.volume.toLocaleString()} tasks.`;
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
  const d = next.querySelector('desc'), cd = cur.querySelector('desc');
  if (d && cd) cd.textContent = d.textContent;
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
}

/** Measured points nobody beats on both axes, sorted by pass rate ascending. */
export function paretoFrontier(rows: ChartRow[]): ChartRow[] {
  const m = rows.filter((r) => r.basis === 'measured').slice().sort((a, b) => b.pass - a.pass || a.cost - b.cost);
  const out: ChartRow[] = [];
  let best = Infinity;
  for (const r of m) if (r.cost < best) { out.push(r); best = r.cost; }
  return out.sort((a, b) => a.pass - b.pass);
}

export function scatterPareto(rows: ChartRow[], o: ScatterOpts): string {
  const compact = o.compact ?? o.width < 560;
  const w = Math.max(300, Math.round(o.width));
  const h = o.height ?? (compact ? w : Math.round(w * 0.58));
  const pts = rows.filter((r) => r.basis !== 'stale' || o.showStale);
  // legend and the y caption live above the frame, never over a gridline;
  // no rotated axis title, so the ticks sit tight against the plot
  // compact keeps a taller bottom band so the tick row and the axis title
  // never share space at the right-hand corner
  const ml = 44, mr = compact ? 20 : 24, mt = 34, mb = compact ? 38 : 30;
  const pw = w - ml - mr, ph = h - mt - mb;
  const passes = pts.map((p) => p.pass), costs = pts.map((p) => p.cost);
  const xmin = Math.max(0, Math.floor((Math.min(...passes) - 0.04) * 10) / 10);
  const xmax = Math.min(1, Math.ceil((Math.max(...passes) + 0.04) * 10) / 10);
  const ymin = Math.pow(10, Math.floor(Math.log10(Math.min(...costs))));
  const ymax = Math.pow(10, Math.ceil(Math.log10(Math.max(...costs))));
  const X = (p: number) => ml + ((p - xmin) / (xmax - xmin)) * pw;
  const Y = (c: number) => mt + ph - ((Math.log10(c) - Math.log10(ymin)) / (Math.log10(ymax) - Math.log10(ymin))) * ph;

  const xt: string[] = [], gx: string[] = [];
  const xs: number[] = [];
  for (let p = xmin; p <= xmax + 1e-9; p = r1(p + 0.1)) xs.push(p);
  xs.forEach((p, i) => {
    // extreme ticks anchor inward so nothing hangs outside the frame
    const anchor = i === 0 ? 'start' : i === xs.length - 1 ? 'end' : 'middle';
    const dx = i === 0 ? -2 : i === xs.length - 1 ? 2 : 0;
    gx.push(`<line class="grid" x1="${r1(X(p))}" y1="${mt}" x2="${r1(X(p))}" y2="${mt + ph}"/>`);
    xt.push(`<text class="t3" x="${r1(X(p) + dx)}" y="${h - mb + 16}" text-anchor="${anchor}" font-size="${FS_S}">${Math.round(p * 100)}%</text>`);
  });
  const yt: string[] = [];
  for (let c = ymin; c <= ymax * 1.0001; c *= 10) {
    yt.push(`<line class="grid" x1="${ml}" y1="${r1(Y(c))}" x2="${ml + pw}" y2="${r1(Y(c))}"/>` +
      `<text class="t3" x="${ml - 8}" y="${r1(Y(c)) + 3.5}" text-anchor="end" font-size="${FS_S}">$${c < 1 ? c.toFixed(1) : c}</text>`);
  }

  const front = paretoFrontier(pts);
  let path = '';
  // the frontier's axis-aligned segments are obstacles for label placement
  const segs: { x0: number; y0: number; x1: number; y1: number }[] = [];
  front.forEach((p, i) => {
    const x = r1(X(p.pass)), y = r1(Y(p.cost));
    if (i === 0) path += `M${x} ${y}`;
    else {
      const prev = front[i - 1], px = r1(X(prev.pass)), py = r1(Y(prev.cost));
      path += ` L${x} ${py} L${x} ${y}`;
      segs.push({ x0: Math.min(px, x), y0: py, x1: Math.max(px, x), y1: py }, { x0: x, y0: Math.min(py, y), x1: x, y1: Math.max(py, y) });
    }
  });
  const crossesLine = (x0: number, y0: number, x1: number, y1: number) =>
    segs.some((g) => x0 < g.x1 + 1 && x1 > g.x0 - 1 && y0 < g.y1 + 1 && y1 > g.y0 - 1);
  const onFront = new Set(front.map((p) => p.id));
  const cheapest = pts.slice().sort((a, b) => a.cost - b.cost)[0]?.id;
  const dearest = pts.slice().sort((a, b) => b.cost - a.cost)[0]?.id;

  // Direct labels, placed greedily so none overlap: frontier and lead first,
  // then the rest. Right-hand slots are tried before left-hand ones so labels
  // sit on one side unless there is no room. Every mark is an obstacle.
  const FS = FS_S, LH = 12, R = 6;
  const order = pts.slice().sort((a, b) => (Number(onFront.has(b.id) || b.id === o.lead) - Number(onFront.has(a.id) || a.id === o.lead)) || a.cost - b.cost);
  const placed: { x0: number; y0: number; x1: number; y1: number }[] = pts.map((p) => ({ x0: X(p.pass) - R - 1, y0: Y(p.cost) - R - 1, x1: X(p.pass) + R + 1, y1: Y(p.cost) + R + 1 }));
  const label = new Map<string, { x: number; y: number; anchor: string } | null>();
  for (const p of order) {
    const wanted = onFront.has(p.id) || p.id === o.lead || !compact || p.id === cheapest || p.id === dearest;
    if (!wanted) { label.set(p.id, null); continue; }
    const x = r1(X(p.pass)), y = r1(Y(p.cost));
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
    const x = r1(X(p.pass)), y = r1(Y(p.cost));
    const tip = `${p.name} · ${BASIS_WORD[p.basis]} · ${money(p.cost)} per solved task · pass ${pct(p.pass)}${p.harness ? ' · ' + p.harness : ''}`;
    const mark = p.basis === 'measured'
      ? `<circle class="pt-measured" cx="${x}" cy="${y}" r="${R}"/>`
      : p.basis === 'modelled'
        ? `<circle class="pt-modelled" cx="${x}" cy="${y}" r="${R}"/>`
        : `<circle class="pt-stale" cx="${x}" cy="${y}" r="${R}"/>`;
    const l = label.get(p.id);
    const text = l ? `<text class="lbl${p.basis === 'measured' ? '' : ' t2'}" x="${r1(l.x)}" y="${r1(l.y)}" text-anchor="${l.anchor}" font-size="${FS}"${p.id === o.lead ? ' font-weight="700"' : ''}>${esc(p.name)}</text>` : '';
    // the designed tooltip (index.astro) reads these; aria-label carries the same sentence
    const data = `data-name="${esc(p.name)}" data-basis="${BASIS_WORD[p.basis]}" data-cost="${money(p.cost)}" data-pass="${pct(p.pass)}"${p.harness ? ` data-harness="${esc(p.harness)}"` : ''}`;
    return `<a class="pt" href="${esc(p.href)}" aria-label="${esc(tip)}" ${data}><circle class="hit" cx="${x}" cy="${y}" r="${compact ? 22 : 14}" fill="transparent"/>${mark}${text}</a>`;
  }).join('');

  const legendY = 12;
  const legend = compact
    ? `<g font-size="${FS_S}" class="t3"><text x="${ml}" y="${legendY}">$ / SOLVED TASK (log) ↑</text></g>`
    : `<g font-size="${FS_S}" class="t3"><text x="${ml}" y="${legendY}">$ / SOLVED TASK (log) ↑</text>` +
      `<circle class="pt-measured" cx="${ml + pw - 290}" cy="${legendY - 3.5}" r="4"/><text x="${ml + pw - 280}" y="${legendY}">MEASURED</text>` +
      `<circle class="pt-modelled" cx="${ml + pw - 200}" cy="${legendY - 3.5}" r="4"/><text x="${ml + pw - 190}" y="${legendY}">MODELLED · never on the frontier</text></g>`;

  const title = 'Cost per solved task against pass rate, with the measured Pareto frontier';
  const desc = `Scatter of ${pts.length} models: x is pass rate ${Math.round(xmin * 100)}–${Math.round(xmax * 100)}%, y is dollars per solved task on a log scale from $${ymin} to $${ymax}. The frontier joins the measured models nobody beats on both axes: ${front.map((p) => `${p.name} (${pct(p.pass)}, ${money(p.cost)})`).join(', ')}.`;
  return `<svg class="chart scatter" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(title)}">` +
    `<title>${esc(title)}</title><desc>${esc(desc)}</desc>` +
    gx.join('') + yt.join('') +
    `<line class="axis" x1="${ml}" y1="${mt + ph}" x2="${ml + pw}" y2="${mt + ph}"/><line class="axis" x1="${ml}" y1="${mt}" x2="${ml}" y2="${mt + ph}"/>` +
    xt.join('') +
    `<text class="t3" x="${ml + pw}" y="${h - 2}" text-anchor="end" font-size="${FS_S}">PASS RATE →</text>` +
    (path ? `<path class="frontier" d="${path}"/>` : '') + legend + marks + `</svg>`;
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
  const series = seriesIn.slice(0, 6); // brand review's validated ceiling
  const compact = o.compact ?? o.width < 560;
  const w = Math.max(300, Math.round(o.width));
  const h = o.height ?? (compact ? Math.round(w * 0.75) : Math.round(w * 0.56));
  const ml = 52, mr = compact ? 14 : 150, mt = 22, mb = compact ? 38 : 30;
  const pw = w - ml - mr, ph = h - mt - mb;
  const lx0 = Math.log10(VOL_MIN), lx1 = Math.log10(VOL_MAX);
  const costs = series.map((s) => s.perTask);
  // y-domain fitted to the drawn lines (a quarter decade of padding), not to whole decades
  const ly0 = Math.log10(Math.min(...costs) * VOL_MIN) - 0.25, ly1 = Math.log10(Math.max(...costs) * VOL_MAX) + 0.25;
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
  const desc = `Log-log lines for ${series.map((s) => `${s.name} (${s.basis}, ${money(s.perTask)} per solved task)`).join(', ')} from ${VOL_MIN} to ${VOL_MAX.toLocaleString()} tasks a month. Marker at ${vol.toLocaleString()} tasks.`;
  // the volume marker's label sits above the frame so it can never collide with the x ticks or the axis title
  return `<svg class="chart lines" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(title)}" data-px0="${ml}" data-px1="${ml + pw}" style="touch-action:none">` +
    `<title>${esc(title)}</title><desc>${esc(desc)}</desc>` + grid.join('') +
    `<line class="axis" x1="${ml}" y1="${mt + ph}" x2="${ml + pw}" y2="${mt + ph}"/><line class="axis" x1="${ml}" y1="${mt}" x2="${ml}" y2="${mt + ph}"/>` +
    `<text class="t3" x="${ml + pw}" y="${h - 2}" text-anchor="end" font-size="${FS_S}">TASKS / MONTH (log) →</text>` +
    `<line class="marker" x1="${vx}" y1="${mt}" x2="${vx}" y2="${mt + ph}"/>` +
    `<text class="t2" x="${vx}" y="${mt - 10}" text-anchor="${right ? 'end' : vx < ml + pw * 0.3 ? 'start' : 'middle'}" font-size="${FS_S}">${vol.toLocaleString()} tasks</text>` +
    lines + legend + `</svg>`;
}
