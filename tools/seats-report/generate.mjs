/**
 * Solvency Seats Report v0 — subscription seat economics from a usage export.
 *
 *   node tools/seats-report/generate.mjs --in usage.csv --fee 200 --plan "Claude Max" --out report.html
 *
 * Input CSV (auto-detected):
 *   generic:    seat,date,model,input_tokens,output_tokens[,cache_read_tokens,cache_write_tokens]
 *   openrouter: uses the activity export's model/tokens_prompt/tokens_completion columns,
 *               with api key name as the seat.
 * Method: subscription_usage_repriced — each seat's usage priced at the verified
 * catalog's metered rates (cache reads at the cached rate, writes at the uncached
 * input rate, stated). Flat fees never enter per-task math. Unknown models are
 * listed, never silently priced (fail closed).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const IN = arg('in'), OUT = arg('out', 'seats-report.html');
const FEE = Number(arg('fee', 200)), PLAN = arg('plan', 'subscription');
if (!IN) { console.error('usage: --in usage.csv [--fee 200] [--plan "Claude Max"] [--out report.html]'); process.exit(1); }

const models = JSON.parse(readFileSync(join(ROOT, 'data', 'models.json'), 'utf8')).models;
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const byNorm = new Map(models.map((m) => [norm(m.model_id), m]));
const findModel = (name) => {
  const tail = String(name).split('/').pop();
  return byNorm.get(norm(tail)) ?? models.find((m) => norm(m.model_id).includes(norm(tail)) || norm(tail).includes(norm(m.model_id))) ?? null;
};

// ---- parse ----
const lines = readFileSync(IN, 'utf8').split('\n').filter((l) => l.trim());
const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
const col = (names) => names.map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
const c = {
  seat: col(['seat', 'api_key_name', 'key', 'user']),
  model: col(['model', 'model_id', 'model_permaslug']),
  inTok: col(['input_tokens', 'tokens_prompt', 'prompt_tokens']),
  outTok: col(['output_tokens', 'tokens_completion', 'completion_tokens']),
  cr: col(['cache_read_tokens', 'tokens_cached', 'cached_tokens']),
  cw: col(['cache_write_tokens', 'cache_creation_tokens']),
};
if (c.model < 0 || c.inTok < 0 || c.outTok < 0) { console.error(`unrecognized CSV header: ${header.join(',')}`); process.exit(1); }

const seats = new Map(); const unknown = new Map();
for (const line of lines.slice(1)) {
  const f = line.split(',');
  const seat = c.seat >= 0 ? f[c.seat]?.trim() || 'default' : 'default';
  const m = findModel(f[c.model]);
  const inT = Number(f[c.inTok]) || 0, outT = Number(f[c.outTok]) || 0;
  const cr = c.cr >= 0 ? Number(f[c.cr]) || 0 : 0, cw = c.cw >= 0 ? Number(f[c.cw]) || 0 : 0;
  const s = seats.get(seat) ?? { usd: 0, calls: 0, inT: 0, outT: 0, cr: 0, unknownCalls: 0 };
  if (!m) { s.unknownCalls++; unknown.set(f[c.model], (unknown.get(f[c.model]) ?? 0) + 1); }
  else {
    const cached = m.cached_input_per_mtok ?? m.input_per_mtok;
    s.usd += (inT * m.input_per_mtok + cr * cached + cw * m.input_per_mtok + outT * m.output_per_mtok) / 1e6;
  }
  s.calls++; s.inT += inT; s.outT += outT; s.cr += cr;
  seats.set(seat, s);
}

// ---- verdicts ----
const rows = [...seats.entries()].map(([seat, s]) => {
  const net = s.usd - FEE;
  const verdict = s.unknownCalls > s.calls * 0.2 ? 'incomplete — unknown models'
    : s.usd >= FEE * 1.5 ? 'keep — seat clearly earns its fee'
    : s.usd >= FEE * 0.8 ? 'keep — near break-even'
    : s.usd >= FEE * 0.2 ? 'review — consider a lower tier'
    : 'move to metered API key';
  return { seat, ...s, net, verdict };
}).sort((a, b) => b.usd - a.usd);
const totFee = FEE * rows.length, totWork = rows.reduce((a, r) => a + r.usd, 0);
const money = (n) => `$${n.toLocaleString(undefined, { maximumFractionDigits: n < 10 ? 2 : 0 })}`;
const verClass = (v) => v.startsWith('keep') ? 'ok' : v.startsWith('review') ? 'warn' : v.startsWith('move') ? 'over' : 'warn';
const priceDate = models[0]?.last_verified ?? '';

const html = `<title>Seat Economics — Solvency</title>
<style>
:root{--g:#F4F5F7;--s:#fff;--ink:#191B22;--mut:#7A7F90;--ln:#E3E5EB;--ac:#5B45E0;--acs:#EDEAFB;--good:#1E7A3D;--goodb:#E3F1E7;--bad:#B23A2A;--badb:#F8E7E3;--warn:#9A6A10;--warnb:#F7EBD3;--chip:#EEF0F4}
body{background:var(--g);color:#3E4250;font:14px/1.5 "IBM Plex Sans",-apple-system,sans-serif;margin:0;padding:2.4rem 1.2rem}
.wrap{max-width:880px;margin:0 auto}.mono{font-family:"IBM Plex Mono",monospace;font-variant-numeric:tabular-nums}
h1{font-family:"Source Serif 4",Georgia,serif;font-size:1.7rem;color:var(--ink);margin:0}
.eyebrow{font-family:"IBM Plex Mono",monospace;font-size:.66rem;letter-spacing:.14em;text-transform:uppercase;color:var(--mut)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:.7rem;margin:1.3rem 0}
.kpi{border:1px solid var(--ln);border-radius:9px;padding:.7rem .9rem;background:var(--s)}
.kpi b{display:block;font-size:1.35rem;color:var(--ink);font-family:"IBM Plex Mono",monospace}.kpi span{font-size:.66rem;color:var(--mut);text-transform:uppercase;letter-spacing:.06em}
.panel{border:1px solid var(--ln);border-radius:10px;background:var(--s);overflow:hidden}
table{border-collapse:collapse;width:100%;font-size:.82rem}
th{text-align:left;font-family:"IBM Plex Mono",monospace;font-size:.6rem;letter-spacing:.1em;text-transform:uppercase;color:var(--mut);padding:.5rem .9rem;border-bottom:1px solid var(--ln);background:var(--chip)}
td{padding:.5rem .9rem;border-bottom:1px solid var(--ln);color:var(--ink)}tr:last-child td{border-bottom:none}
td.num,th.num{text-align:right;font-family:"IBM Plex Mono",monospace;white-space:nowrap}
.pill{display:inline-block;font-family:"IBM Plex Mono",monospace;font-size:.6rem;padding:.13rem .5rem;border-radius:99px;white-space:nowrap}
.pill.ok{background:var(--goodb);color:var(--good)}.pill.warn{background:var(--warnb);color:var(--warn)}.pill.over{background:var(--badb);color:var(--bad)}
.foot{font-size:.7rem;color:var(--mut);margin-top:1.2rem;max-width:70ch}
</style>
<div class="wrap">
<p class="eyebrow">Solvency · seat economics · method: subscription_usage_repriced</p>
<h1>Seat report — ${rows.length} seat${rows.length === 1 ? '' : 's'} on ${PLAN}</h1>
<div class="kpis">
<div class="kpi"><span>Seat fees</span><b>${money(totFee)}/mo</b></div>
<div class="kpi"><span>Metered-equivalent work</span><b>${money(totWork)}</b></div>
<div class="kpi"><span>Net vs API</span><b style="color:${totWork - totFee >= 0 ? 'var(--good)' : 'var(--bad)'}">${totWork - totFee >= 0 ? '+' : ''}${money(totWork - totFee)}</b></div>
</div>
<div class="panel"><table>
<tr><th>Seat</th><th class="num">Calls</th><th class="num">Fee</th><th class="num">Metered-equiv.</th><th class="num">Net</th><th>Verdict</th></tr>
${rows.map((r) => `<tr><td>${r.seat}</td><td class="num">${r.calls.toLocaleString()}</td><td class="num">${money(FEE)}</td><td class="num">${money(r.usd)}</td><td class="num" style="color:${r.net >= 0 ? 'var(--good)' : 'var(--bad)'}">${r.net >= 0 ? '+' : ''}${money(r.net)}</td><td><span class="pill ${verClass(r.verdict)}">${r.verdict}</span></td></tr>`).join('\n')}
</table></div>
${unknown.size ? `<p class="foot"><b>Not priced (fail closed):</b> ${[...unknown.entries()].map(([m, n]) => `${m} (${n} calls)`).join(' · ')} — these models are missing from the verified catalog; their cost is excluded, never guessed.</p>` : ''}
<p class="foot">Method: each seat's own usage repriced at verified metered rates (catalog verified ${priceDate}; cache reads at the cached rate, cache writes at the uncached input rate — stated, not hidden). Flat fees never enter per-task math. Verdict thresholds: ≥1.5× fee keep · 0.8–1.5× near break-even · 0.2–0.8× review tier · &lt;0.2× move to metered. Generated by Solvency — solvency.dev</p>
</div>`;
writeFileSync(OUT, html);
console.log(`report: ${OUT} — ${rows.length} seats, fees ${money(totFee)}, metered-equiv ${money(totWork)}${unknown.size ? `, ${unknown.size} unknown models (excluded)` : ''}`);
