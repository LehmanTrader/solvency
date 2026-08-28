/**
 * Renders the per-page social stat cards: one per research note, one for the
 * homepage, one per current model. Same headless-Chrome shot() approach as
 * scripts/png.ts. Driven entirely by scripts/og-card-data.ts — nothing here
 * is a hand-typed figure.
 *
 * Redesign stage 3 (docs/redesign-2026-08/direction.md §7): every DEFAULT
 * card (home, model-<id>, note-NN) now renders through the cream/purple
 * ranked-leaderboard template below (rankedCardHtml/renderRanked) — the same
 * template the og-ranked-cards design exploration shipped. The old dark flat
 * "big number + claim" template (cardHtml/render) is retired: nothing calls
 * it any more now that og-card-data.ts's noteCardData/homeCardData/
 * modelCardData all return RankedCardData.
 *
 * Fonts are the repo's self-hosted woff2 files (site/public/fonts), loaded by
 * absolute file:// URL so the card renders correctly outside the site build.
 *
 *   npm run og:cards
 *
 * Idempotent: always writes all cards + manifest.json to reports/og-cards/,
 * the same committed-source-of-truth pattern as reports/charts/ and
 * reports/png/ (see site/scripts/sync-assets.mjs, which copies this
 * directory into site/public/og/cards/ before every site build/dev server --
 * site/public/og/ itself is gitignored, a build-time mirror, not a source).
 * test/og-cards.test.ts checks reports/og-cards/manifest.json against the
 * live data on every test run so a stale card (data/models.json changed,
 * cards not regenerated) fails CI.
 */
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import {
  ROOT, allReportFrontmatter, noteCardData, homeCardData, currentModels, modelCardData,
  rankedCostCardData, rankedHarnessCardData, rankedSolvencyHarnessCardData, rankedModeledCardData,
  type RankedCardData, type RankedRow, type RankedBasis,
} from './og-card-data.ts';

const OUT = join(ROOT, 'reports', 'og-cards');
const TMP = join(ROOT, 'reports', 'build', '_og-cards');
const FONTS = join(ROOT, 'site', 'public', 'fonts');
const BRAND_DIR = join(ROOT, 'site', 'public', 'brand', 'providers');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const BRAND_AMBER = '#5B45E0'; // enterprise indigo (2026-08-27 repaint); const name kept — it's the brand-highlight slot

mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });

function shot(html: string, w: number, h: number, out: string, scale = 2) {
  const page = join(TMP, 'page.html');
  writeFileSync(page, html);
  execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--force-device-scale-factor=${scale}`, `--window-size=${w},${h}`,
    `--screenshot=${out}`, '--virtual-time-budget=4000',
    // Every card is the light ranked template now (RC_BG below) — no dark card remains.
    `--default-background-color=${RC_BG.slice(1)}ff`, `file://${page}`,
  ], { stdio: 'pipe' });
}

const fontUrl = (file: string) => pathToFileURL(join(FONTS, file)).href;
const providerMarkUrl = (file: string) => pathToFileURL(join(BRAND_DIR, file)).href;
const FONT_FACE_CSS = `
  @font-face { font-family: 'JetBrains Mono'; font-style: normal; font-weight: 400 800; src: url('${fontUrl('jetbrains-mono-latin.woff2')}') format('woff2'); }
  @font-face { font-family: 'Source Serif 4'; font-style: normal; font-weight: 200 900; src: url('${fontUrl('source-serif-4-latin.woff2')}') format('woff2'); }
`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------------------------------------------------------------------------
// Ranked-bar leaderboard variant (design exploration — see scripts/og-card-data.ts
// for the data functions; keyed `ranked-*`, not wired into any page yet).
// Off-white card, unlike the dark cards above: a deliberate contrast choice for
// an X timeline (X's chrome is dark; a light card pops the way it doesn't in a
// feed of other dark cards) and it matches the founder's Arena.ai reference.
// Brand-consistent regardless: the mark, wordmark and headline highlight are
// the same brand amber (#E0A02E) the dark cards use; site/public/brand/mark.svg
// and lockup.svg already ship this exact ink-on-light variant. Bars use the
// purple data accent (RC_PURPLE below), not amber — see basisBarCss.
// ---------------------------------------------------------------------------
const RC_BG = '#F4F5F7', RC_INK = '#191B22', RC_MUTED = '#5D6373', RC_RULE = '#DDE0E7';
// Data accent (docs/redesign-2026-08/direction.md §1/§3, stage 1.1 color
// note): a vivid violet, the same hue for both measured (solid) and
// modeled (hatched) bars — the hatch alone carries the basis distinction.
// Brand amber is reserved for highlight/brand duty only (headline
// highlighter, #1-row outline + circle below) and never doubles as a bar
// color, so the two jobs stay visually separate.
const RC_PURPLE = '#5B45E0', RC_STALE = '#B23A2A';
const RC_LEAD_TINT = 'rgba(91,69,224,0.08)';

/**
 * Colored provider chips (direction doc §4), mirroring site/src/lib/providers.ts's
 * chipMarkup() so cards and site agree: vendored marks (their own official
 * brand hex/color, see site/public/brand/providers/LOGOS.md) for every
 * tracked provider. As of stage 1.3, that is all six providers in
 * data/models.json (openai and xai included — real vendored marks, not the
 * MONOGRAM_COLORS chips they used before) — MONOGRAM_COLORS stays only as
 * the fallback for any future provider with no clean asset yet.
 */
const PROVIDER_MARK_FILES: Record<string, string> = {
  anthropic: 'anthropic.svg', google: 'google.svg', mistral: 'mistral.svg', deepseek: 'deepseek.svg',
  openai: 'openai.svg', xai: 'xai.png',
};
const CHIP_BG = '#F4F3F1', CHIP_BORDER = '#CFCCC6';
const MONOGRAM_COLORS: Record<string, string> = {};

function chipHtml(provider: string | undefined, text: string): string {
  const markFile = provider ? PROVIDER_MARK_FILES[provider] : undefined;
  if (markFile) {
    return `<span class="chip chip-mark"><img src="${providerMarkUrl(markFile)}" width="18" height="18" alt=""/></span>`;
  }
  const mono = provider ? MONOGRAM_COLORS[provider] : undefined;
  const bg = mono ?? CHIP_BG, fg = mono ? '#FFFFFF' : RC_INK, border = mono ?? CHIP_BORDER;
  return `<span class="chip" style="background:${bg};color:${fg};border-color:${border}">${esc(text)}</span>`;
}

const RANKED_FONT_FACE_CSS = FONT_FACE_CSS + `
  @font-face { font-family: 'IBM Plex Sans'; font-style: normal; font-weight: 300 700; src: url('${fontUrl('ibm-plex-sans-latin.woff2')}') format('woff2'); }
`;

// The Ledger S (operator's pick 2026-08-28, round-5 concept 01). Ink-colored
// bars with the fixed indigo middle bar, on transparency, so it sits on the
// card ground directly. Raster of site/public/brand/mark-s1.svg.
const BRAND_MARK = pathToFileURL(join(ROOT, 'site', 'public', 'brand', 'mark-s1.png')).href;
const rankedMarkSvg = (px: number) =>
  `<img src="${BRAND_MARK}" width="${px}" height="${px}" style="display:block" alt=""/>`;

/** Measured/harness bars are solid purple (both are observed-cost bases, no
 * loop assumption — harness rows are source_usage_repriced, same solid
 * treatment as measured); modeled bars are the same purple hatched; stale
 * bars are a dashed hollow outline — same basis semantics as
 * site/src/lib/charts.ts, just CSS instead of an SVG pattern. Brand amber
 * never appears here; it is reserved for the headline highlight and the
 * #1-row outline/circle. */
function basisBarCss(basis: RankedBasis): string {
  if (basis === 'modelled') {
    return `background:repeating-linear-gradient(135deg, ${RC_PURPLE}, ${RC_PURPLE} 3px, transparent 3px, transparent 7px);border:1px solid ${RC_PURPLE}`;
  }
  if (basis === 'stale') {
    return `background:transparent;border:1.5px dashed ${RC_STALE}`;
  }
  return `background:${RC_PURPLE};border:1px solid ${RC_PURPLE}`; // measured, harness
}

function rankedRowHtml(r: RankedRow, rank: number, maxCost: number, rowH: number): string {
  const pct = maxCost > 0 ? Math.max(4, Math.round((r.cost / maxCost) * 100)) : 4;
  // A row's own `lead` wins when set (a per-model default card outlines its
  // subject wherever it actually ranks); otherwise rank 1 is lead, the
  // original leaderboard-card behavior (rankedCostCardData and friends
  // never set `lead`, so nothing changes for them).
  const lead = r.lead ?? rank === 1;
  // Founder review 2026-08-26: the provider chip sits BESIDE the name, the
  // whole row is one vertically-centered line, sub text trails the name.
  const chip = r.chip ? chipHtml(r.provider, r.chip) : '';
  const secondary = r.sub ? `<span class="sub">${esc(r.sub)}</span>` : '';
  return `<div class="row${lead ? ' lead' : ''}" style="height:${rowH}px">
      <div class="rank">${rank}</div>
      <div class="who">${chip}<span class="name">${esc(r.name)}</span>${secondary}</div>
      <div class="track"><div class="bar" style="width:${pct}%;${basisBarCss(r.basis)}"></div></div>
      <div class="val">${esc(r.value)}</div>
    </div>`;
}

/**
 * Every section of the card gets an explicit pixel height that sums to
 * exactly 630 (the card's fixed height), rather than leaning on flexbox to
 * absorb a variable number of rows: with up to 6 rows the content is dense
 * enough that shrink-to-fit flex sizing let the headline and the row list
 * overlap. Explicit math is the same approach scripts/charts.ts already uses
 * for its SVG layouts — deterministic, and it throws if a future change
 * makes the budget not add up rather than silently overlapping again.
 */
function rankedLayout(rowCount: number) {
  const padTop = 44, padSide = 60, padBottom = 40;
  const topH = 30, gap1 = 14, headH = 88, gap2 = 18, gap3 = 0, footH = 0;
  const fixed = padTop + topH + gap1 + headH + gap2 + gap3 + footH + padBottom;
  const rowsH = 630 - fixed;
  if (rowsH < rowCount * 40) throw new Error(`rankedLayout: ${rowCount} rows do not fit the card (only ${rowsH}px available)`);
  const rowGap = rowCount <= 4 ? 14 : 8;
  const rowH = Math.floor((rowsH - rowGap * (rowCount - 1)) / rowCount);
  return { padTop, padSide, padBottom, topH, gap1, headH, gap2, gap3, footH, rowsH, rowGap, rowH };
}

function rankedCardHtml(card: RankedCardData): string {
  // barMax lets a per-model card that excerpts a longer field (see
  // og-card-data.ts's excerptAroundId) size bars against the *full* field's
  // most expensive row, not just the rows actually printed — otherwise an
  // excerpted card's own priciest visible row would always draw a full-width
  // bar regardless of where it truly sits.
  const maxCost = card.barMax ?? Math.max(...card.rows.map((r) => r.cost));
  const L = rankedLayout(card.rows.length);
  const rows = card.rows.map((r, i) => rankedRowHtml(r, r.rank ?? i + 1, maxCost, L.rowH)).join('');
  return `<!doctype html><meta charset="utf-8"><style>
    ${RANKED_FONT_FACE_CSS}
    html,body{margin:0;width:1200px;height:630px;background:${RC_BG};overflow:hidden;
      font-family:'IBM Plex Sans','Helvetica Neue',Arial,sans-serif}
    .wrap{width:1200px;height:630px;box-sizing:border-box;
      padding:${L.padTop}px ${L.padSide}px ${L.padBottom}px}
    .top{height:${L.topH}px;display:flex;justify-content:space-between;align-items:center}
    .eyebrow{color:${RC_MUTED};font-family:'JetBrains Mono',monospace;font-size:15px;
      letter-spacing:.12em;font-weight:600}
    .lockup{display:flex;align-items:center;gap:8px}
    .lockup svg{display:block}
    .wordmark{color:${RC_INK};font-size:15px;letter-spacing:.2em}
    .wordmark b{font-weight:700}
    .headline{height:${L.headH}px;margin-top:${L.gap1}px;font-family:'Source Serif 4',Georgia,serif;
      font-weight:400;color:${RC_INK};font-size:34px;line-height:1.25;max-width:1080px;
      display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .hl{background:#EDEAFB;padding:0 6px;box-decoration-break:clone;-webkit-box-decoration-break:clone}
    .rows{height:${L.rowsH}px;margin-top:${L.gap2}px;display:flex;flex-direction:column;gap:${L.rowGap}px}
    .row{display:grid;grid-template-columns:34px 1fr 380px 100px;align-items:center;
      column-gap:16px;padding:0 14px;border-radius:10px;border:2px solid transparent;box-sizing:border-box}
    .row.lead{border-color:${BRAND_AMBER};background:${RC_LEAD_TINT}}
    .rank{width:30px;height:30px;border-radius:50%;border:1.5px solid ${RC_INK};
      display:flex;align-items:center;justify-content:center;font-family:'JetBrains Mono',monospace;
      font-size:14px;font-weight:700;color:${RC_INK}}
    .row.lead .rank{background:${BRAND_AMBER};border-color:${BRAND_AMBER};color:#FFFFFF}
    .who{display:flex;flex-direction:row;align-items:center;gap:10px;min-width:0}
    .name{font-weight:600;font-size:19px;color:${RC_INK};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sub{font-size:12px;color:${RC_MUTED};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .chip{width:fit-content;padding:1px 6px;border-radius:4px;border:1px solid transparent;
      font-size:11px;font-weight:700;letter-spacing:.04em}
    .chip-mark{padding:3px;display:flex;align-items:center;justify-content:center;
      background:${CHIP_BG};border-color:${CHIP_BORDER}}
    .chip-mark img{display:block}
    .track{position:relative;height:12px;border-radius:4px;background:${RC_RULE}}
    .bar{position:absolute;left:0;top:0;height:100%;border-radius:4px}
    .val{font-family:'JetBrains Mono',monospace;font-weight:700;font-size:18px;color:${RC_INK};text-align:right}
  </style>
  <div class="wrap">
    <div class="top">
      <span class="eyebrow">${esc(card.eyebrow)}</span>
      <span class="lockup">${rankedMarkSvg(22)}<span class="wordmark"><b>S</b>OLVENCY</span></span>
    </div>
    <div class="headline">${esc(card.headlinePrefix)}<span class="hl">${esc(card.headlineHighlight)}</span>${esc(card.headlineSuffix)}</div>
    <div class="rows">${rows}</div>
  </div>`;
}

function renderRanked(card: RankedCardData) {
  // ONLY=<substring> renders just matching cards' PNGs (fast selective
  // regen); every card's DATA still lands in the manifest either way.
  if (!process.env.ONLY || card.key.includes(process.env.ONLY)) {
    shot(rankedCardHtml(card), 1200, 630, join(OUT, `${card.key}.png`), 2);
  }
  return card;
}

const manifest: { generated_at: string; cards: Record<string, RankedCardData> } = {
  generated_at: new Date().toISOString(),
  cards: {},
};

const notes = allReportFrontmatter();
for (const fm of notes) {
  const card = renderRanked(noteCardData(fm));
  manifest.cards[card.key] = card;
  console.log(`${card.key}: ${card.rows.length} rows, "${card.headlineHighlight}"`);
}

const home = renderRanked(homeCardData());
manifest.cards[home.key] = home;
console.log(`${home.key}: ${home.rows.length} rows, #1 "${home.rows[0].name}" ${home.rows[0].value}`);

const models = currentModels();
for (const m of models) {
  const card = renderRanked(modelCardData(m));
  manifest.cards[card.key] = card;
  console.log(`${card.key}: ${card.rows.length} rows, subject "${card.headlineHighlight}"`);
}

const rankedCards: RankedCardData[] = [rankedCostCardData()];
const harnessCard = rankedHarnessCardData();
if (harnessCard) rankedCards.push(harnessCard);
else console.log('ranked-harness: skipped — no model currently has more than one harness result');
const solvencyHarnessCard = rankedSolvencyHarnessCardData();
if (solvencyHarnessCard) rankedCards.push(solvencyHarnessCard);
else console.log('ranked-harness-solvency: skipped — no first-party harness study on disk');
const modeledCard = rankedModeledCardData();
if (modeledCard) rankedCards.push(modeledCard);
else console.log('ranked-modelled: skipped — no modeled current models to rank');

for (const card of rankedCards) {
  renderRanked(card);
  manifest.cards[card.key] = card;
  console.log(`${card.key}: ${card.rows.length} rows, #1 "${card.rows[0].name}" ${card.rows[0].value}`);
}

writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
console.log(`\nwrote ${Object.keys(manifest.cards).length} cards + manifest.json to reports/og-cards/ (run \`cd site && npm run sync\` to mirror into site/public/og/cards/)`);
