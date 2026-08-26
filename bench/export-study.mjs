/**
 * Transcribe finished Solvency Bench harness arms into the committed study
 * file the research note and its tests derive from
 * (data/harness-study/solvency-bench-v0.json). Run after arms complete;
 * refuses runs marked INVALID or SUPERSEDED, and refuses mixed models.
 *
 *   node bench/export-study.mjs <runId> [runId...]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BENCH = dirname(fileURLToPath(import.meta.url));
const ROOT = join(BENCH, '..');
const ids = process.argv.slice(2);
if (ids.length < 2) { console.error('usage: node bench/export-study.mjs <runId> <runId> [...]'); process.exit(1); }

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

const arms = ids.map((id) => {
  const dir = join(BENCH, 'results', id);
  for (const bad of ['INVALID.json', 'SUPERSEDED.json']) {
    if (existsSync(join(dir, bad))) { console.error(`refusing ${id}: ${bad} present`); process.exit(1); }
  }
  const s = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
  const rows = readFileSync(join(dir, 'results.jsonl'), 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l)).filter((r) => !r.infra);
  return {
    run_id: id,
    harness: s.harness?.name ?? null,
    harness_version: s.harness?.version ? String(s.harness.version).split('\n')[0].slice(0, 60) : null,
    access: s.access ?? (s.harness ? (s.costBasis === 'subscription_usage_repriced' ? 'local subscription login' : 'metered provider (OpenRouter)') : 'metered API, single call, no scaffold'),
    cost_basis: s.costBasis ?? 'api_metered_at_catalog_prices',
    model: s.model, prices: s.prices, protocol: s.protocol, protocol_hash: s.protocolHash,
    trials: s.trials, attempts_countable: s.attemptsCountable, infra_excluded: s.infraExcluded,
    pass_rate: s.passRate, cost_per_task_usd: s.costPerTaskUsd, cost_per_solved_usd: s.costPerSolvedUsd,
    run_date: s.runDate,
    median_usage_per_attempt: {
      input: median(rows.map((r) => r.usage.input)),
      cache_read: median(rows.map((r) => r.usage.cacheRead)),
      cache_write: median(rows.map((r) => r.usage.cacheWrite)),
      output: median(rows.map((r) => r.usage.output)),
    },
  };
});
const models = new Set(arms.map((a) => a.model.split('/').pop()));
if (models.size !== 1) { console.error(`refusing: mixed models ${[...models].join(', ')}`); process.exit(1); }

const study = {
  description: 'Solvency Bench harness comparison: one model (GPT-5.6 Sol) through every arm of the single-turn suite (solvency-bench-v0). First-party measurement; its own population, never merged with the OpenBench or WildClawBench populations in Note 02, nor with any leaderboard group. Cache writes are priced at the uncached input rate (write premium not modelled, stated); the bare arm is the no-scaffold control.',
  benchmark: 'solvency-bench-v0-harness',
  source: 'Solvency Bench (bench/ in this repository); journals under bench/results/<run_id>/',
  suite: '12 single-turn code tasks, deterministic hidden-test graders, temperature 0, 3 trials',
  run_date: arms[0].run_date,
  redistributable: true,
  arms,
};
writeFileSync(join(ROOT, 'data', 'harness-study', 'solvency-bench-v0.json'), JSON.stringify(study, null, 2) + '\n');
console.log(`study written: ${arms.length} arms, model ${[...models][0]}`);
