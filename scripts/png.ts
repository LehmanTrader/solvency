/**
 * Exports the dark charts as PNG for social and embedding. X and most social
 * cards will not render SVG, so the shareable asset has to be raster.
 *
 *   node scripts/png.ts            # 2x native + 1200x630 OG card for each chart
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'reports', 'charts');
const OUT = join(ROOT, 'reports', 'png');
const TMP = join(ROOT, 'reports', 'build', '_png');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const META = JSON.parse(readFileSync(join(ROOT, 'reports', 'charts-light', 'meta.json'), 'utf8'));

const BG = '#0A0C0D', INK = '#E6EAED', MUTED = '#78838A', ACCENT = '#FFB000';
const BRAND_AMBER = '#E0A02E';
/** The Solvency mark, inline. `bars` lets a light card reuse it unchanged. */
const markSvg = (px: number, bars: string) =>
  `<svg width="${px}" height="${px}" viewBox="0 0 100 100" aria-hidden="true">` +
  `<rect x="18" y="10" width="64" height="18" fill="${bars}"/>` +
  `<rect x="10" y="44" width="80" height="7" fill="${bars}"/>` +
  `<rect x="42" y="66" width="16" height="18" fill="${BRAND_AMBER}"/></svg>`;

const MONO = "'JetBrains Mono','SFMono-Regular',Menlo,Consolas,monospace";

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

const files = readdirSync(SRC).filter((f) => f.endsWith('.svg'));
for (const f of files) {
  const key = f.replace('.svg', '');
  const svg = readFileSync(join(SRC, f), 'utf8');
  const w = Number((svg.match(/width="(\d+)"/) ?? [, '900'])[1]);
  const h = Number((svg.match(/height="(\d+)"/) ?? [, '600'])[1]);

  // 1. native at 2x -- for embedding and for anywhere that wants the raw chart
  shot(`<!doctype html><meta charset="utf-8">
    <style>html,body{margin:0;background:${BG}}svg{display:block}</style>${svg}`,
    w, h, join(OUT, `${key}@2x.png`));

  // 2. 1200x630 social card -- chart fitted, with wordmark and title furniture
  const m = META[key];
  const card = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;width:1200px;height:630px;background:${BG};
      font-family:${MONO};overflow:hidden}
    .wrap{height:630px;display:flex;flex-direction:column;padding:26px 34px 20px}
    .top{display:flex;justify-content:space-between;align-items:center;
      border-bottom:1px solid #1C2226;padding-bottom:11px}
    .lockup{display:flex;align-items:center;gap:8px;color:${INK}}
    .lockup svg{display:block}
    .mark{color:${INK};font-weight:400;letter-spacing:.2em;font-size:13px}
    .mark b{font-weight:700}
    .note{color:${MUTED};font-size:11px;letter-spacing:.14em}
    .title{color:${INK};font-size:23px;font-weight:700;margin:15px 0 2px}
    .sub{color:${MUTED};font-size:12px}
    .plot{flex:1;display:flex;align-items:center;justify-content:center;min-height:0;margin-top:6px}
    .plot svg{max-width:100%;max-height:100%;height:auto;width:auto}
    .foot{color:${MUTED};font-size:10.5px;border-top:1px solid #1C2226;padding-top:9px;
      display:flex;justify-content:space-between}
  </style>
  <div class="wrap">
    <div class="top"><span class="lockup">${markSvg(19, INK)}<span class="mark"><b>S</b>OLVENCY</span></span><span class="note">RESEARCH NOTE 01 · AUGUST 2026</span></div>
    <div class="title">${m?.title ?? key}</div>
    <div class="sub">${(m?.subtitle ?? [])[0] ?? ''}</div>
    <div class="plot">${svg}</div>
    <div class="foot"><span>${(m?.source ?? []).find((l: string) => l.startsWith('Data:')) ?? ''}</span><span>solvency.dev</span></div>
  </div>`;
  shot(card, 1200, 630, join(OUT, `${key}-og.png`), 2);
  console.log(`${key}: ${w}x${h}@2x + 1200x630 og`);
}

if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
console.log(`\nwrote ${files.length * 2} files to reports/png/`);
