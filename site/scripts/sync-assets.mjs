/** Copies generated figures into the site's public directory before a build. */
import { mkdirSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

const jobs = [
  { from: join(repo, 'reports', 'charts'), to: join(here, '..', 'public', 'charts'), ext: '.svg' },
  { from: join(repo, 'reports', 'png'), to: join(here, '..', 'public', 'og'), ext: '.png' },
  // datasets are copied in so the client bundle can import them; the repo's
  // /data remains canonical and is the only place they are edited
  { from: join(repo, 'data'), to: join(here, '..', 'src', 'data'), ext: '.json' },
];

for (const { from, to, ext } of jobs) {
  if (!existsSync(from)) { console.warn(`skip: ${from} missing`); continue; }
  mkdirSync(to, { recursive: true });
  const files = readdirSync(from).filter((f) => f.endsWith(ext));
  for (const f of files) copyFileSync(join(from, f), join(to, f));
  console.log(`synced ${files.length} ${ext} -> ${to.replace(repo, '.')}`);
}

// ---- open data export -------------------------------------------------------
// Benchmark rows are third-party and carry redistributable:false. Only Solvency's
// own pricing compilation is exported, and the export asserts that rather than
// relying on whoever edits this next to remember.
import { writeFileSync, readFileSync } from 'node:fs';

const modelsPath = join(repo, 'data', 'models.json');
const benchPath = join(repo, 'data', 'benchmarks.json');
const models = JSON.parse(readFileSync(modelsPath, 'utf8'));
const bench = JSON.parse(readFileSync(benchPath, 'utf8'));

const notRedistributable = bench.results.filter((r) => r.redistributable !== false);
if (notRedistributable.length) {
  throw new Error(`refusing to build: ${notRedistributable.length} benchmark rows are not marked redistributable:false`);
}

const outData = join(here, '..', 'public', 'data');
mkdirSync(outData, { recursive: true });

const payload = {
  name: 'Solvency model pricing dataset',
  license: 'CC-BY-4.0',
  attribution: 'Source: Solvency (solvency.dev)',
  note: 'Prices verified against each provider\'s own pricing page on the last_verified date. Benchmark pass rates are NOT included: they are third-party and are cited and linked rather than redistributed.',
  generated_from: 'data/models.json',
  schema_version: models.$schema_version,
  price_basis: models.price_basis,
  models: models.models,
};
writeFileSync(join(outData, 'models.json'), JSON.stringify(payload, null, 2) + '\n');

const cols = ['model_id','provider','display_name','status','capability_class','input_per_mtok','output_per_mtok','cached_input_per_mtok','context_window','source_url','last_verified'];
const esc = (v) => v === null || v === undefined ? '' : (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g,'""')}"` : String(v));
const csv = [cols.join(','), ...models.models.map((m) => cols.map((c) => esc(m[c])).join(','))].join('\n') + '\n';
writeFileSync(join(outData, 'models.csv'), csv);
console.log(`exported ${models.models.length} priced models to public/data (CC-BY); 0 benchmark rows`);
