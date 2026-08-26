/**
 * Solvency Bench share card: same model, N harnesses, ranked by cost per
 * solved task — built ENTIRELY from bench/results/ summaries (first-party
 * data, no third-party attribution to carry).
 *
 *   node bench/card.mjs <out.png> <runId> [runId...]
 *
 * Every run must share one model and one protocol; refuses otherwise.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BENCH = dirname(fileURLToPath(import.meta.url));
const ROOT = join(BENCH, '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FONTS = join(ROOT, 'site', 'public', 'fonts');
const MARK = join(ROOT, 'site', 'public', 'brand', 'mark-j1-ink.png');
const [out, ...runIds] = process.argv.slice(2);
if (!out || runIds.length < 2) { console.error('usage: node bench/card.mjs <out.png> <runId> <runId> [...]'); process.exit(1); }

const runs = runIds.map((id) => ({ id, ...JSON.parse(readFileSync(join(BENCH, 'results', id, 'summary.json'), 'utf8')) }));
const models = new Set(runs.map((r) => r.model.split('/').pop()));
if (models.size !== 1) { console.error(`refusing: runs span models ${[...models].join(', ')}`); process.exit(1); }
// v0 vs v0h is the ACCESS PATH (metered API vs subscription harness), not
// the task protocol — same tasks, same grading. Anything else refuses.
const protocols = new Set(runs.map((r) => r.protocol.replace(/h$/, '')));
if (protocols.size !== 1) { console.error(`refusing: runs span protocols ${[...protocols].join(', ')}`); process.exit(1); }
const trialSet = new Set(runs.map((r) => r.trials + ':' + r.attemptsCountable));
if (trialSet.size !== 1) { console.error(`refusing: runs span trial shapes ${[...trialSet].join(', ')}`); process.exit(1); }
const modelName = 'GPT-5.6 Sol'; // display; single-model enforced above
const rows = runs
  .map((r) => ({
    name: r.harness?.name
      ? { 'claude-code': 'Claude Code', codex: 'Codex', hermes: 'Hermes Agent', opencode: 'OpenCode', aider: 'Aider' }[r.harness.name] ?? r.harness.name
      : 'API, no harness',
    sub: r.harness?.version ? String(r.harness.version).replace(/^[a-zA-Z ]*v?/, 'v').slice(0, 22) : 'single call',
    solved: r.costPerSolvedUsd, pass: r.passRate,
  }))
  .sort((a, b) => a.solved - b.solved);
const max = rows[rows.length - 1].solved;
const spread = (max / rows[0].solved).toFixed(1);
const date = runs[0].runDate;

const rowHtml = rows.map((r, i) => `
  <div class="row${i === 0 ? ' lead' : ''}">
    <div class="rank">${i + 1}</div>
    <div class="who"><span class="name">${r.name}</span><span class="sub">${r.sub} · ${Math.round(r.pass * 100)}% pass</span></div>
    <div class="track"><div class="bar" style="width:${Math.max(5, Math.round((r.solved / max) * 100))}%"></div></div>
    <div class="val">$${r.solved.toFixed(4)}</div>
  </div>`).join('');

const html = `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:'Source Serif 4';src:url('file://${FONTS}/source-serif-4-latin.woff2') format('woff2');font-weight:400 700}
@font-face{font-family:'JetBrains Mono';src:url('file://${FONTS}/jetbrains-mono-latin.woff2') format('woff2')}
@font-face{font-family:'IBM Plex Sans';src:url('file://${FONTS}/ibm-plex-sans-latin.woff2') format('woff2');font-weight:300 700}
html,body{margin:0;width:1200px;height:630px;background:#F8F6EE;font-family:'IBM Plex Sans',sans-serif;overflow:hidden}
.wrap{box-sizing:border-box;width:1200px;height:630px;padding:44px 60px 40px}
.top{display:flex;justify-content:space-between;align-items:center;height:30px}
.eyebrow{color:#6B645A;font-family:'JetBrains Mono',monospace;font-size:15px;letter-spacing:.12em;font-weight:600}
.lockup{display:flex;align-items:center;gap:8px}
.lockup img{width:22px;height:22px}
.wordmark{color:#1A1714;font-size:15px;letter-spacing:.2em;font-family:'IBM Plex Sans'}
.wordmark b{font-weight:700}
.headline{margin-top:14px;height:88px;font-family:'Source Serif 4',Georgia,serif;color:#1A1714;font-size:34px;line-height:1.25}
.hl{background:#E0A02E;padding:0 6px}
.rows{margin-top:18px;display:flex;flex-direction:column;gap:10px}
.row{display:grid;grid-template-columns:34px 1fr 380px 130px;align-items:center;column-gap:16px;padding:0 14px;height:64px;border-radius:10px;border:2px solid transparent;box-sizing:border-box}
.row.lead{border-color:#E0A02E;background:rgba(224,160,46,.10)}
.rank{width:30px;height:30px;border-radius:50%;border:1.5px solid #1A1714;display:flex;align-items:center;justify-content:center;font-family:'JetBrains Mono',monospace;font-size:14px;font-weight:700;color:#1A1714}
.row.lead .rank{background:#E0A02E;border-color:#E0A02E}
.who{display:flex;flex-direction:row;align-items:baseline;gap:12px;min-width:0}
.name{font-weight:600;font-size:19px;color:#1A1714;white-space:nowrap}
.sub{font-size:12px;color:#6B645A;white-space:nowrap}
.track{position:relative;height:12px;border-radius:4px;background:#E3DFD3}
.bar{position:absolute;left:0;top:0;height:100%;border-radius:4px;background:#6C3BF4}
.val{font-family:'JetBrains Mono',monospace;font-weight:700;font-size:18px;color:#1A1714;text-align:right}
</style><div class="wrap">
<div class="top"><span class="eyebrow">SAME MODEL, ${rows.length} HARNESSES · COST PER SOLVED TASK · SOLVENCY BENCH · ${date}</span>
<span class="lockup"><img src="file://${MARK}"><span class="wordmark"><b>S</b>OLVENCY</span></span></div>
<div class="headline"><span class="hl">${modelName}</span>, ${rows.length} harnesses, ${spread}x apart on cost — measured by Solvency.</div>
<div class="rows">${rowHtml}</div>
</div>`;

const tmp = join(BENCH, 'results', '_card.html');
writeFileSync(tmp, html);
execFileSync(CHROME, ['--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--force-device-scale-factor=2', '--window-size=1200,630', `--screenshot=${out}`,
  '--virtual-time-budget=4000', `file://${tmp}`], { stdio: 'pipe' });
console.log(`card written: ${out} (${rows.length} arms, ${spread}x spread)`);
