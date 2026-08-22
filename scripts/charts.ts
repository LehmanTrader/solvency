/**
 * Generates every chart in the Phase 0 report as SVG, from the datasets.
 * No hand-drawn values: change a price in models.json and the charts move.
 *   node scripts/charts.ts
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { models, tiers, assumptions, results, sources, benchmarksFile, bestResultFor, extrasFor, modelById, stalenessDays } from './load.ts';
import { costPerSolvedTask, defaultOptions } from './solved-cost.ts';

/**
 * Two themes. `dark` is the house style for screen and the site. `light` exists
 * because Chrome only paints a page background on the first printed page, so a
 * dark PDF comes out white from page 2 -- the print build uses light charts and
 * a light page rather than a document that is half one theme and half the other.
 */
const THEME = process.env.DENOM_THEME === 'light' ? 'light' : 'dark';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'reports',
  THEME === 'light' ? 'charts-light' : 'charts');
const opts = defaultOptions(assumptions);
const ASOF = '2026-08-21';

const PALETTE = THEME === 'light'
  ? { BG: '#FFFFFF', GRID: '#E7E4DE', TEXT: '#14171A', MUTED: '#6E747B', ACCENT: '#B0691A', ACCENT_DIM: '#D8C3A0' }
  : { BG: '#0A0C0D', GRID: '#1C2226', TEXT: '#E6EAED', MUTED: '#78838A', ACCENT: '#FFB000', ACCENT_DIM: '#8A6210' };
const { BG, GRID, TEXT, MUTED, ACCENT, ACCENT_DIM } = PALETTE;
const MONO = "JetBrains Mono, SFMono-Regular, Menlo, Consolas, monospace";
/** Print figures scale to ~0.75x in the PDF; set type larger so it stays legible. */
const FS = THEME === 'light' ? 1.25 : 1;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const txt = (x: number, y: number, s: string, o: { fill?: string; size?: number; anchor?: string; weight?: number } = {}) =>
  `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" fill="${o.fill ?? TEXT}" font-family="${MONO}" font-size="${((o.size ?? 12) * FS).toFixed(1)}" font-weight="${o.weight ?? 400}" text-anchor="${o.anchor ?? 'start'}">${esc(s)}</text>`;

interface ChartMeta { title: string; subtitle: string[]; source: string[]; }
const META: Record<string, ChartMeta> = {};

/**
 * Screen builds are self-contained SVGs with their own title and source line.
 * Print builds emit only the plot, cropped to its content, and hand the title,
 * subtitle and source back through META so the report can set them as card
 * furniture in real type rather than baked-in SVG text.
 */
function frame(name: string, w: number, h: number, title: string, subtitle: string | string[],
               body: string, footer: string | string[], crop?: { y0: number; y1: number }) {
  const subs = Array.isArray(subtitle) ? subtitle : [subtitle];
  const foots = Array.isArray(footer) ? footer : [footer];
  META[name] = { title, subtitle: subs, source: foots };

  if (THEME === 'light' && crop) {
    const ch = crop.y1 - crop.y0;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${ch}" viewBox="0 ${crop.y0} ${w} ${ch}" role="img" aria-label="${esc(title)}">
<rect x="0" y="${crop.y0}" width="${w}" height="${ch}" fill="${BG}"/>
${body}
</svg>`;
  }

  const subLines = subs.map((l, i) => txt(32, 62 + i * 15 * FS, l, { size: 11, fill: MUTED })).join('\n');
  const footLines = foots.map((l, i) =>
    txt(32, h - 16 - (foots.length - 1 - i) * 14 * FS, l, { size: 10, fill: MUTED })).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
<rect width="${w}" height="${h}" fill="${BG}"/>
${txt(32, 42, title, { size: 16, weight: 700 })}
${subLines}
${body}
${footLines}
</svg>`;
}

const logScale = (v: number, lo: number, hi: number, a: number, b: number) =>
  a + ((Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * (b - a);

/** Measured rows only: these carry an observed cost, so no assumption is inside them. */
const measured = models
  .map((m) => ({ m, r: bestResultFor(m.model_id) }))
  .filter((x) => x.r && x.r.cost_basis === 'measured_by_source')
  .map(({ m, r }) => ({
    m, r: r!,
    solved: costPerSolvedTask(m, 'heavy', tiers.heavy, r!.pass_rate, opts, extrasFor(r!)).value!.naive,
  }))
  .sort((a, b) => a.solved - b.solved);

// ---------------------------------------------------------------- chart 1
// Rank by token price, then by cost per solved task. The orders disagree and
// the spread widens -- that gap is the whole product.
function chartDivergence() {
  const W = 900, H = 600, LX = 300, RX = 660, TOP = 128, BOT = H - 84;
  const cheapTok = Math.min(...measured.map((d) => d.m.output_per_mtok));
  const cheapSolved = Math.min(...measured.map((d) => d.solved));
  const pts = measured.map((d) => ({ ...d, tok: d.m.output_per_mtok / cheapTok, sol: d.solved / cheapSolved }));
  const lo = 0.9, hi = Math.max(...pts.map((p) => Math.max(p.tok, p.sol))) * 1.15;
  const y = (v: number) => BOT - (logScale(v, lo, hi, 0, BOT - TOP));

  let b = '';
  for (const g of [1, 2, 5, 10, 20, 50, 100, 200]) {
    if (g < lo || g > hi) continue;
    // No value labels here: each endpoint is already labelled, and a second
    // set of numbers in the same column collides with them.
    b += `<line x1="${LX - 20}" y1="${y(g)}" x2="${RX + 20}" y2="${y(g)}" stroke="${GRID}" stroke-width="1"/>`;
  }
  b += txt(LX, TOP - 26, 'OUTPUT TOKEN PRICE', { size: 11, weight: 700, anchor: 'middle' });
  b += txt(LX, TOP - 12, 'x cheapest', { size: 10, fill: MUTED, anchor: 'middle' });
  b += txt(RX, TOP - 26, 'COST PER SOLVED TASK', { size: 11, weight: 700, anchor: 'middle', fill: ACCENT });
  b += txt(RX, TOP - 12, 'x cheapest', { size: 10, fill: MUTED, anchor: 'middle' });

  for (const p of pts) {
    const y1 = y(p.tok), y2 = y(p.sol);
    const widen = p.sol > p.tok;
    b += `<line x1="${LX}" y1="${y1}" x2="${RX}" y2="${y2}" stroke="${widen ? ACCENT : MUTED}" stroke-width="${widen ? 2 : 1.2}" opacity="${widen ? 0.9 : 0.5}"/>`;
    b += `<circle cx="${LX}" cy="${y1}" r="4" fill="${MUTED}"/><circle cx="${RX}" cy="${y2}" r="4.5" fill="${ACCENT}"/>`;
    b += txt(LX - 62, y1 + 4, `${p.tok.toFixed(1)}x`, { size: 11, anchor: 'end' });
    b += txt(LX - 118, y1 + 4, p.m.display_name, { size: 11, fill: TEXT, anchor: 'end' });
    b += txt(RX + 14, y2 + 4, `${p.sol.toFixed(0)}x`, { size: 11, fill: ACCENT, weight: 700 });
    b += txt(RX + 60, y2 + 4, `$${p.solved.toFixed(2)}`, { size: 11, fill: MUTED });
  }
  const spreadTok = Math.max(...pts.map((p) => p.tok)), spreadSol = Math.max(...pts.map((p) => p.sol));
  b += txt(32, H - 62, `Spread widens ${spreadTok.toFixed(0)}x -> ${spreadSol.toFixed(0)}x. Ranking by token price does not reproduce the cost ranking.`, { size: 11, fill: ACCENT });

  writeFileSync(join(OUT, 'divergence.svg'), frame('divergence', W, H, 'Token price is not task cost',
    ['Log scale, normalised to the cheapest model on each axis.',
     'Measured rows only, so no Solvency assumption is inside these numbers.'],
    b, ['Cost per solved task = measured cost per task / pass rate.',
        `Data: Artificial Analysis Coding Agent Index v1.4. Prices verified ${ASOF}.`], { y0: 86, y1: H - 46 }));
  return { spreadTok, spreadSol, pts };
}

// ---------------------------------------------------------------- chart 2
function chartPareto() {
  const W = 900, H = 660, L = 96, R = W - 250, T = 128, B = H - 94;
  const xs = measured.map((d) => d.solved);
  const lo = Math.min(...xs) * 0.7, hi = Math.max(...xs) * 1.5;
  const yLo = 45, yHi = 71;
  const X = (v: number) => logScale(v, lo, hi, L, R);
  const Y = (v: number) => B - ((v - yLo) / (yHi - yLo)) * (B - T);

  let b = '';
  for (const g of [0.1, 0.3, 1, 3, 10, 30]) {
    if (g < lo || g > hi) continue;
    b += `<line x1="${X(g)}" y1="${T}" x2="${X(g)}" y2="${B}" stroke="${GRID}"/>`;
    b += txt(X(g), B + 20, `$${g < 1 ? g.toFixed(2) : g}`, { fill: MUTED, size: 10, anchor: 'middle' });
  }
  for (let v = yLo; v <= yHi; v += 5) {
    b += `<line x1="${L}" y1="${Y(v)}" x2="${R}" y2="${Y(v)}" stroke="${GRID}"/>`;
    b += txt(L - 12, Y(v) + 4, String(v), { fill: MUTED, size: 10, anchor: 'end' });
  }
  b += txt((L + R) / 2, H - 44, 'COST PER SOLVED TASK (USD, log)', { size: 11, fill: MUTED, anchor: 'middle' });
  b += `<text x="26" y="${(T + B) / 2}" fill="${MUTED}" font-family="${MONO}" font-size="11" text-anchor="middle" transform="rotate(-90 26 ${(T + B) / 2})">CODING AGENT INDEX</text>`;

  // Pareto frontier: nothing cheaper scores higher.
  const front = [...measured].sort((a, b2) => a.solved - b2.solved)
    .filter((d, i, arr) => arr.slice(0, i).every((p) => p.r.pass_rate < d.r.pass_rate));
  b += `<polyline points="${front.map((d) => `${X(d.solved)},${Y(d.r.pass_rate * 100)}`).join(' ')}" fill="none" stroke="${ACCENT_DIM}" stroke-width="1.5" stroke-dasharray="4 4"/>`;

  // Label placement: try candidate slots around each point and take the first
  // that clears every label already placed. Width is estimated from character
  // count at the monospace advance, so the test is on boxes, not anchor points.
  const CH = 6.6;
  const leaders: string[] = [];
  const boxes: { x0: number; x1: number; y0: number; y1: number }[] = [];
  // A ladder of candidate offsets, nearest-first, on both sides of the point.
  const slots: { dx: number; dy: number; anchor: 'start' | 'end' }[] = [];
  for (const dy of [-6, 20, -30, 44, -54, 68, -78, 92]) {
    slots.push({ dx: 12, dy, anchor: 'start' });
    slots.push({ dx: -12, dy, anchor: 'end' });
  }

  for (const d of measured) {
    const x = X(d.solved), yy = Y(d.r.pass_rate * 100);
    const on = front.includes(d);
    b += `<circle cx="${x}" cy="${yy}" r="${on ? 7 : 5}" fill="${on ? ACCENT : 'none'}" stroke="${on ? ACCENT : MUTED}" stroke-width="1.6"/>`;

    const sub = `$${d.solved.toFixed(2)} / ${(d.r.pass_rate * 100).toFixed(0)}`;
    const w = Math.max(d.m.display_name.length, sub.length) * CH;
    // Score every slot by overlap area; take the first with zero overlap, and
    // otherwise the least-bad one. Falling back to a fixed slot would silently
    // reinstate the collision this whole routine exists to avoid.
    const scored = slots.map((sl) => {
      const x0 = sl.anchor === 'start' ? x + sl.dx : x + sl.dx - w;
      const box = { x0, x1: x0 + w, y0: yy + sl.dy - 12, y1: yy + sl.dy + 18 };
      const outside = !(box.x0 > L - 60 && box.x1 < R + 200 && box.y0 > T - 20 && box.y1 < B);
      const overlap = boxes.reduce((acc, q) => acc +
        Math.max(0, Math.min(box.x1, q.x1) - Math.max(box.x0, q.x0)) *
        Math.max(0, Math.min(box.y1, q.y1) - Math.max(box.y0, q.y0)), 0);
      return { sl, cost: overlap + (outside ? 1e6 : 0) };
    });
    const slot = (scored.find((c) => c.cost === 0) ?? scored.reduce((a, c) => (c.cost < a.cost ? c : a))).sl;

    const lx = x + slot.dx, ly = yy + slot.dy;
    const x0 = slot.anchor === 'start' ? lx : lx - w;
    // Displaced far from its point: draw a leader so the pairing stays obvious.
    if (Math.abs(slot.dy) > 24) {
      leaders.push(`<line x1="${x}" y1="${yy}" x2="${lx}" y2="${ly + (slot.dy < 0 ? 4 : -8)}" stroke="${MUTED}" stroke-width="0.8" opacity="0.45"/>`);
    }
    boxes.push({ x0, x1: x0 + w, y0: ly - 12, y1: ly + 18 });
    b += txt(lx, ly, d.m.display_name, { size: 11, fill: on ? TEXT : MUTED, anchor: slot.anchor });
    b += txt(lx, ly + 14, sub, { size: 10, fill: MUTED, anchor: slot.anchor });
  }
  b = leaders.join('') + b; // leaders underneath, so type always reads on top
  writeFileSync(join(OUT, 'pareto.svg'), frame('pareto', W, H, 'What one index point costs',
    ['Coding Agent Index vs cost per solved task.',
     'Dashed line: the frontier — nothing cheaper scores higher.'],
    b, ['Rows are harness+model pairs, not bare models.',
        `Data: Artificial Analysis Coding Agent Index v1.4. Verified ${ASOF}.`], { y0: 98, y1: H - 30 }));
  return { front };
}

// ---------------------------------------------------------------- chart 3
function chartStaleness() {
  const W = 900, H = 352, L = 240, R = W - 96, T = 140;
  const t0 = Date.parse('2024-11-01'), t1 = Date.parse('2026-10-01');
  const X = (d: string) => L + ((Date.parse(d) - t0) / (t1 - t0)) * (R - L);

  const rows = [
    { name: 'AA Coding Agent Index', date: '2026-08-21', conf: 'observed', used: true },
    { name: 'Scale SEAL', date: null, conf: 'unknown', used: true },
    { name: 'Aider polyglot', date: '2025-10-03', conf: 'exact', used: true },
    { name: 'HAL (Princeton)', date: '2025-09-15', conf: 'approximate', used: false },
  ];

  let b = '';
  for (const y of ['2025-01-01', '2025-07-01', '2026-01-01', '2026-07-01']) {
    b += `<line x1="${X(y)}" y1="${T - 24}" x2="${X(y)}" y2="${T + (rows.length - 1) * 46 + 24}" stroke="${GRID}"/>`;
    b += txt(X(y), T - 32, y.slice(0, 7), { fill: MUTED, size: 10, anchor: 'middle' });
  }
  b += `<line x1="${X(ASOF)}" y1="${T - 24}" x2="${X(ASOF)}" y2="${T + (rows.length - 1) * 46 + 24}" stroke="${ACCENT}" stroke-width="1.5" opacity="0.6"/>`;
  b += txt(X(ASOF) + 6, T - 32, 'today', { fill: ACCENT, size: 10 });

  rows.forEach((r, i) => {
    const y = T + i * 46;
    b += txt(L - 16, y + 4, r.name, { size: 12, anchor: 'end', fill: r.used ? TEXT : MUTED });
    if (r.date === null) {
      b += `<rect x="${L}" y="${y - 9}" width="${R - L}" height="18" fill="url(#hatch)" opacity="0.5"/>`;
      b += txt((L + R) / 2, y + 4, 'NO DATE PUBLISHED — STALENESS UNKNOWN', { size: 10, fill: MUTED, anchor: 'middle' });
    } else {
      const days = stalenessDays(r.date, ASOF);
      b += `<line x1="${X(r.date)}" y1="${y}" x2="${X(ASOF)}" y2="${y}" stroke="${r.used ? ACCENT : MUTED}" stroke-width="${days > 200 ? 2 : 3}" opacity="${days > 200 ? 0.85 : 1}" stroke-dasharray="${r.conf === 'approximate' ? '5 3' : ''}"/>`;
      b += `<circle cx="${X(r.date)}" cy="${y}" r="5" fill="${r.used ? ACCENT : MUTED}"/>`;
      const label = days < 30 ? 'current' : `${days}d stale`;
      b += txt(X(ASOF) + 10, y + 4, label, { size: 11, fill: days > 200 ? ACCENT : MUTED, weight: days > 200 ? 700 : 400 });
      if (r.conf === 'approximate') b += txt(X(r.date) - 8, y + 4, 'approx', { size: 9, fill: MUTED, anchor: 'end' });
      if (!r.used) b += txt(X(r.date) - 52, y + 4, 'rejected', { size: 9, fill: MUTED, anchor: 'end' });
    }
  });
  const defs = `<defs><pattern id="hatch" width="8" height="8" patternTransform="rotate(45)" patternUnits="userSpaceOnUse"><line x1="0" y1="0" x2="0" y2="8" stroke="${MUTED}" stroke-width="2"/></pattern></defs>`;
  writeFileSync(join(OUT, 'staleness.svg'), frame('staleness', W, H, 'Newest entry, by source',
    ['Bar runs from each source’s newest published entry to today. Longer is worse.'],
    defs + b, ['Aider verified against its raw leaderboard YAML.',
               'SEAL publishes no update date, so its staleness is unknown, not zero.'],
    { y0: 96, y1: T + (4 - 1) * 46 + 34 }));
  return rows;
}

const d1 = chartDivergence(); chartPareto(); chartStaleness();

writeFileSync(join(OUT, 'meta.json'), JSON.stringify(META, null, 2) + '\n');
console.log(`wrote ${THEME} charts + meta.json\n`);
console.log('COMPUTED FIGURES FOR THE REPORT');
console.log('-'.repeat(64));
for (const d of measured) {
  const m = d.m;
  console.log(`${m.display_name.padEnd(20)} idx ${(d.r.pass_rate * 100).toFixed(0)}%  $/task ${String(d.r.measured_cost_per_task_usd).padStart(6)}  $/solved ${d.solved.toFixed(2).padStart(7)}  out $/Mtok ${String(m.output_per_mtok).padStart(5)}  in $/Mtok ${String(m.input_per_mtok).padStart(5)}`);
}
const ds = modelById('deepseek-v4-flash')!, op = modelById('claude-opus-5')!;
const dsR = measured.find((x) => x.m.model_id === 'deepseek-v4-flash')!, opR = measured.find((x) => x.m.model_id === 'claude-opus-5')!;
console.log('-'.repeat(64));
console.log(`DeepSeek V4 Flash vs Opus 5: input ${(op.input_per_mtok / ds.input_per_mtok).toFixed(1)}x, output ${(op.output_per_mtok / ds.output_per_mtok).toFixed(1)}x cheaper per token`);
console.log(`  ...but ${(opR.r.measured_cost_per_task_usd! / dsR.r.measured_cost_per_task_usd!).toFixed(0)}x cheaper per task and ${(opR.solved / dsR.solved).toFixed(0)}x cheaper per SOLVED task`);
console.log(`Token-price spread ${d1.spreadTok.toFixed(0)}x -> solved-cost spread ${d1.spreadSol.toFixed(0)}x`);
const gs = measured.find((x) => x.m.model_id === 'grok-4.5')!, sol = measured.find((x) => x.m.model_id === 'gpt-5.6-sol')!;
console.log(`Grok 4.5 ${(gs.r.pass_rate * 100).toFixed(0)} @ $${gs.solved.toFixed(2)} vs GPT-5.6 Sol ${(sol.r.pass_rate * 100).toFixed(0)} @ $${sol.solved.toFixed(2)}  -> ${(sol.solved - gs.solved).toFixed(2)} per index point`);
