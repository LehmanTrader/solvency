/**
 * Renders the per-page social stat cards: one per research note, one for the
 * homepage, one per current model. Same headless-Chrome shot() approach as
 * scripts/png.ts, but the template is card-specific (dominant amber number,
 * serif claim, mono attribution) and driven entirely by scripts/og-card-data.ts
 * — nothing here is a hand-typed figure.
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
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ROOT, allReportFrontmatter, noteCardData, homeCardData, currentModels, modelCardData,
  type CardData,
} from './og-card-data.ts';

const OUT = join(ROOT, 'reports', 'og-cards');
const TMP = join(ROOT, 'reports', 'build', '_og-cards');
const FONTS = join(ROOT, 'site', 'public', 'fonts');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const BG = '#0A0C0D', INK = '#E6EAED', MUTED = '#78838A', ACCENT = '#E0A02E', RULE = '#1C2226';
const BRAND_AMBER = '#E0A02E';

mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });

function shot(html: string, w: number, h: number, out: string, scale = 2) {
  const page = join(TMP, 'page.html');
  writeFileSync(page, html);
  execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--force-device-scale-factor=${scale}`, `--window-size=${w},${h}`,
    `--screenshot=${out}`, '--virtual-time-budget=4000',
    `--default-background-color=${BG.slice(1)}ff`, `file://${page}`,
  ], { stdio: 'pipe' });
}

const fontUrl = (file: string) => pathToFileURL(join(FONTS, file)).href;
const FONT_FACE_CSS = `
  @font-face { font-family: 'JetBrains Mono'; font-style: normal; font-weight: 400 800; src: url('${fontUrl('jetbrains-mono-latin.woff2')}') format('woff2'); }
  @font-face { font-family: 'Source Serif 4'; font-style: normal; font-weight: 200 900; src: url('${fontUrl('source-serif-4-latin.woff2')}') format('woff2'); }
`;

const markSvg = (px: number) =>
  `<svg width="${px}" height="${px}" viewBox="0 0 100 100" aria-hidden="true">` +
  `<rect x="18" y="10" width="64" height="18" fill="${INK}"/>` +
  `<rect x="10" y="44" width="80" height="7" fill="${INK}"/>` +
  `<rect x="42" y="66" width="16" height="18" fill="${BRAND_AMBER}"/></svg>`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Keeps THE NUMBER inside the spec's 160-220px(@1x) band regardless of string length. */
const numberSize = (s: string) => (s.length <= 5 ? 220 : 190);

function cardHtml({ eyebrow, number, claim, attribution }: CardData): string {
  return `<!doctype html><meta charset="utf-8"><style>
    ${FONT_FACE_CSS}
    html,body{margin:0;width:1200px;height:630px;background:${BG};overflow:hidden;
      font-family:'JetBrains Mono','SFMono-Regular',Menlo,Consolas,monospace}
    .wrap{width:1200px;height:630px;box-sizing:border-box;padding:64px;
      display:flex;flex-direction:column;justify-content:space-between}
    .top{display:flex;justify-content:space-between;align-items:center}
    .eyebrow{color:${MUTED};font-size:28px;letter-spacing:.14em;font-weight:500}
    .mark{display:block}
    .mid{flex:1;display:flex;flex-direction:column;justify-content:center;min-height:0}
    .number{color:${ACCENT};font-weight:700;line-height:1;letter-spacing:-0.01em;
      font-size:${numberSize(number)}px;white-space:nowrap}
    .claim{margin-top:22px;color:${INK};font-family:'Source Serif 4',Georgia,serif;font-weight:400;
      font-size:52px;line-height:1.28;max-width:1000px;
      display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .bottom{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;
      border-top:1px solid ${RULE};padding-top:20px}
    .attribution{color:${MUTED};font-size:15px;letter-spacing:.02em;max-width:860px;
      line-height:1.55}
    .site{color:${MUTED};font-size:15px;letter-spacing:.06em;flex:none}
  </style>
  <div class="wrap">
    <div class="top">
      <span class="eyebrow">${esc(eyebrow)}</span>
      <span class="mark">${markSvg(22)}</span>
    </div>
    <div class="mid">
      <div class="number">${esc(number)}</div>
      <div class="claim">${esc(claim)}</div>
    </div>
    <div class="bottom">
      <span class="attribution">${esc(attribution)}</span>
      <span class="site">solvency.dev</span>
    </div>
  </div>`;
}

function render(card: CardData) {
  shot(cardHtml(card), 1200, 630, join(OUT, `${card.key}.png`), 2);
  return card;
}

const manifest: { generated_at: string; cards: Record<string, CardData> } = {
  generated_at: new Date().toISOString(),
  cards: {},
};

const notes = allReportFrontmatter();
for (const fm of notes) {
  const card = render(noteCardData(fm));
  manifest.cards[card.key] = card;
  console.log(`${card.key}: "${card.number}" — ${card.claim}`);
}

const home = render(homeCardData());
manifest.cards[home.key] = home;
console.log(`${home.key}: "${home.number}" — ${home.claim}`);

const models = currentModels();
for (const m of models) {
  const card = render(modelCardData(m));
  manifest.cards[card.key] = card;
  console.log(`${card.key}: "${card.number}" — ${card.claim}`);
}

writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
console.log(`\nwrote ${Object.keys(manifest.cards).length} cards + manifest.json to reports/og-cards/ (run \`cd site && npm run sync\` to mirror into site/public/og/cards/)`);
