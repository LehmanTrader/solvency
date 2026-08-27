/**
 * Bulk-ingest Solvency Bench runs into data/benchmarks.json.
 *
 *   node scripts/ingest-bench.mjs [--dry]
 *
 * Rebuilds every measured_by_solvency result row from bench/results/*
 * (skipping INVALID/SUPERSEDED runs and the same-model harness-arm study,
 * which lives in data/harness-study/, not the leaderboard). One row per
 * (model, protocol); when a model has both a bare metered run and a
 * subscription-harness run, the bare metered run wins (same access path for
 * every ranked row; subscription runs are kept only when they are the only
 * access to the model, with the harness recorded in harness_config).
 * Third-party rows are never touched. Idempotent by construction.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS = join(ROOT, 'bench', 'results');
const BENCH_PATH = join(ROOT, 'data', 'benchmarks.json');
const DRY = process.argv.includes('--dry');

const models = JSON.parse(readFileSync(join(ROOT, 'data', 'models.json'), 'utf8')).models;
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const modelByNorm = new Map(models.map((m) => [norm(m.model_id), m]));
// OR slug tails that differ from catalog ids (free-tier rows carry
// provider/tier suffixes in the catalog): map them explicitly.
const ALIASES = { 'northminicodefree': 'north-mini-code-cohere-free' };
for (const [aliasNorm, id] of Object.entries(ALIASES)) {
  const m = models.find((x) => x.model_id === id);
  if (m) modelByNorm.set(aliasNorm, m);
}

/** The GPT-5.6 Sol harness-arm study: same model many scaffolds — never a leaderboard row per arm. */
const HARNESS_STUDY_MODEL = 'gpt-5.6-sol';

const candidates = new Map(); // model_id -> { benchmark -> best summary }
const skipped = { invalid: 0, superseded: 0, incomplete: 0, unmapped: [], harnessStudy: 0 };

for (const dir of readdirSync(RESULTS)) {
  const base = join(RESULTS, dir);
  const sumPath = join(base, 'summary.json');
  if (!existsSync(sumPath)) { if (!dir.startsWith('_')) skipped.incomplete++; continue; }
  if (existsSync(join(base, 'INVALID.json'))) { skipped.invalid++; continue; }
  if (existsSync(join(base, 'SUPERSEDED.json'))) { skipped.superseded++; continue; }
  const s = JSON.parse(readFileSync(sumPath, 'utf8'));
  const tail = String(s.model ?? '').split('/').pop();
  const m = modelByNorm.get(norm(tail));
  if (!m) { skipped.unmapped.push(dir); continue; }
  if (s.harness && norm(tail) === norm(HARNESS_STUDY_MODEL)) { skipped.harnessStudy++; continue; }
  const protocol = s.protocol ?? 'solvency-bench-v0';
  const benchmark = protocol.startsWith('solvency-bench-a') ? protocol : 'solvency-bench-v0';
  const key = m.model_id;
  const cur = candidates.get(key)?.[benchmark];
  // bare metered beats subscription-harness; later run date beats earlier
  const better = !cur
    || (!s.harness && !!cur.harness)
    || (!!s.harness === !!cur.harness && String(s.runDate ?? '') >= String(cur.runDate ?? ''));
  if (better) candidates.set(key, { ...(candidates.get(key) ?? {}), [benchmark]: s });
}

const rows = [];
for (const [modelId, byBench] of [...candidates.entries()].sort()) {
  for (const [benchmark, s] of Object.entries(byBench)) {
    const countable = s.countableAttempts ?? 36;
    const solved = Math.round((s.passRate ?? 0) * countable);
    rows.push({
      model_id: modelId,
      harness: s.harness?.name ?? null,
      harness_version: s.harness?.version ? String(s.harness.version).split('\n')[0].slice(0, 60) : null,
      harness_config: s.harness
        ? `run through ${s.harness.name} on a local subscription login; usage repriced at catalog API rates`
        : 'bare API single call via OpenRouter; temperature 0; max_tokens 8000',
      entry_label: `${s.harness ? s.harness.name : 'API, no harness'} - ${modelId}`,
      benchmark,
      pass_rate: s.passRate,
      pass_rate_derivation: `${solved} solved / ${countable} countable attempts`,
      attempts_n: countable,
      countable_attempts_n: countable,
      solved_attempts_n: solved,
      measured_cost_per_task_usd: Number((s.costPerTaskUsd ?? 0).toFixed(6)),
      cost_basis: 'measured_by_solvency',
      tasks_n: benchmark.startsWith('solvency-bench-a') ? (s.tasksN ?? 30) : 12,
      run_date: s.runDate ?? '2026-08-26',
      date_basis: 'run_executed_by_solvency',
      source_url: 'https://github.com/LehmanTrader/solvency/tree/main/bench',
      redistributable: true,
    });
  }
}

const bench = JSON.parse(readFileSync(BENCH_PATH, 'utf8'));
const thirdParty = bench.results.filter((r) => r.cost_basis !== 'measured_by_solvency');
const next = { ...bench, results: [...thirdParty, ...rows] };

console.log(`ingest: ${rows.length} first-party rows (${candidates.size} models); third-party rows untouched: ${thirdParty.length}`);
console.log(`skipped: ${skipped.invalid} INVALID, ${skipped.superseded} SUPERSEDED, ${skipped.incomplete} incomplete, ${skipped.harnessStudy} harness-study arms, ${skipped.unmapped.length} unmapped`);
if (skipped.unmapped.length) console.log('unmapped:', skipped.unmapped.slice(0, 8).join(', '));
if (!DRY) {
  writeFileSync(BENCH_PATH, JSON.stringify(next, null, 2) + '\n');
  console.log(`wrote ${BENCH_PATH} — run \`cd site && npm run sync\` next`);
} else {
  console.log('(dry run, nothing written)');
}
