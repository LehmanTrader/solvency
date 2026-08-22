/**
 * Price-change watcher. Fetches each model's own source page and checks whether
 * the prices we recorded still appear on it. It NEVER edits the dataset — it
 * reports, and a human verifies and edits.
 *
 *   node scripts/watch-prices.ts            # check every current model
 *   node scripts/watch-prices.ts --all      # include legacy and retired
 *
 * Design note: parsing provider pricing pages is brittle and they change layout
 * constantly. Instead of parsing, this asserts a much weaker and far more robust
 * claim — "the number we published is still on the page it came from". A miss is
 * a prompt to look, not proof of a change.
 */
import { models } from './load.ts';
import type { Model } from './types.ts';

const all = process.argv.includes('--all');
const fleet = models.filter((m) => all || m.status === 'current');

const variants = (n: number): string[] => {
  const out = new Set<string>();
  for (const s of [String(n), n.toFixed(2), n.toFixed(3), n.toFixed(1), n.toFixed(0)]) {
    out.add(s); out.add('$' + s);
  }
  if (Number.isInteger(n)) { out.add(`$${n}`); out.add(`${n} /`); }
  return [...out];
};

const strip = (html: string) =>
  html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

interface Row { model: Model; status: string; missing: string[] }
const rows: Row[] = [];
const pages = new Map<string, string | null>();

for (const m of fleet) {
  if (!pages.has(m.source_url)) {
    try {
      const res = await fetch(m.source_url, { headers: { 'user-agent': 'SolvencyPriceWatcher/1.0 (+https://solvency.dev)' } });
      pages.set(m.source_url, res.ok ? strip(await res.text()) : null);
    } catch { pages.set(m.source_url, null); }
  }
  const text = pages.get(m.source_url);
  if (text === null) { rows.push({ model: m, status: 'FETCH FAILED', missing: [] }); continue; }

  const checks: [string, number | null][] = [
    ['input', m.input_per_mtok], ['output', m.output_per_mtok], ['cached', m.cached_input_per_mtok],
  ];
  const missing = checks
    .filter(([, v]) => v !== null)
    .filter(([, v]) => !variants(v as number).some((s) => text!.includes(s)))
    .map(([k]) => k);
  rows.push({ model: m, status: missing.length ? 'REVIEW' : 'ok', missing });
}

const review = rows.filter((r) => r.status !== 'ok');
console.log(`PRICE WATCH — ${fleet.length} models, ${pages.size} pages fetched\n`);
for (const r of rows) {
  const tag = r.status === 'ok' ? '  ok    ' : r.status === 'REVIEW' ? '  REVIEW' : '  FETCH!';
  console.log(`${tag} ${r.model.model_id.padEnd(24)} ${r.missing.length ? 'not found on page: ' + r.missing.join(', ') : ''}`);
}
console.log(`\n${review.length} of ${rows.length} need a human look.`);
if (review.length) {
  console.log(`
A REVIEW result means a price we published no longer appears verbatim on its
source page. That can mean the price changed, or merely that the page was
reformatted. Open the page, check, and if it changed:
  1. edit data/models.json and bump last_verified
  2. add a data/changelog.json entry
  3. rebuild — every table, chart, report figure and page follows automatically
Never let this script write the dataset.`);
}
process.exitCode = 0;
