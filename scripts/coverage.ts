/**
 * Coverage audit: which models can produce a cost-per-solved-task, on what
 * basis, and how stale. Run before any report so gaps are stated, not discovered.
 *   node scripts/coverage.ts [asOfDate]
 */
import { models, results, sources, benchmarksFile, bestResultFor, sourceFor, stalenessDays, SOURCE_PREFERENCE } from './load.ts';

const asOf = process.argv[2] ?? new Date().toISOString().slice(0, 10);
const current = models.filter((m) => m.status === 'current');

console.log(`SOLVENCY COVERAGE AUDIT  (as of ${asOf})\n`);
console.log(`Models priced:  ${models.length}  (${current.length} current)`);
console.log(`Benchmark rows: ${results.length}  from ${sources.length} sources\n`);

console.log(`-- Sources, in preference order ------------------------------`);
for (const b of SOURCE_PREFERENCE) {
  const s = sourceFor(b)!;
  const rows = results.filter((r) => r.benchmark === b);
  const joined = rows.filter((r) => r.model_id).length;
  const basis = rows[0]?.cost_basis ?? '--';
  console.log(`  ${s.name}`);
  console.log(`    tasks=${s.tasks_n}  rows=${rows.length}  joined=${joined}  cost_basis=${basis}`);
  console.log(`    covers current models: ${s.covers_current_models ? 'YES' : 'NO'}${s.latest_entry_date ? `  newest entry ${s.latest_entry_date} (${stalenessDays(s.latest_entry_date, asOf)}d)` : ''}`);
  console.log(`    redistributable: ${s.redistributable}  -- ${s.attribution}`);
}

console.log(`\n-- Rejected sources ------------------------------------------`);
for (const s of benchmarksFile.sources_evaluated_and_rejected) {
  console.log(`  ${s.name}\n    ${s.why_rejected}`);
}

const covered = models.map((m) => ({ m, r: bestResultFor(m.model_id) })).filter((x) => x.r);
const byBasis = (b: string) => covered.filter((x) => x.r!.cost_basis === b);

console.log(`\n-- Coverage by cost basis ------------------------------------`);
console.log(`  measured_by_source      ${byBasis('measured_by_source').length}  (no Solvency assumption in the cost)`);
console.log(`  modelled_by_solvency ${byBasis('modelled_by_solvency').length}  (loop model applies -- ASSUMPTION)`);
console.log(`  historical_at_run_date  ${byBasis('historical_at_run_date').length}  (Aider; cost recomputed, pass rate stale)`);

const currentCovered = current.filter((m) => bestResultFor(m.model_id));
console.log(`\n  CURRENT models with a pass rate: ${currentCovered.length} / ${current.length}`);
console.log(`  Current models WITHOUT one:      ${current.filter((m) => !bestResultFor(m.model_id)).map((m) => m.model_id).join(', ') || 'none'}`);

const harnessRows = results.filter((r) => r.harness !== null);
const joinedHarnessRows = harnessRows.filter((r) => r.model_id !== null);
const harnessesByModelBenchmark = new Map<string, Set<string>>();
for (const r of joinedHarnessRows) {
  const key = `${r.model_id}\u0000${r.benchmark}`;
  if (!harnessesByModelBenchmark.has(key)) harnessesByModelBenchmark.set(key, new Set());
  harnessesByModelBenchmark.get(key)!.add(r.harness!);
}
const comparableHarnessGroups = [...harnessesByModelBenchmark.entries()].filter(([, harnesses]) => harnesses.size >= 2);
const comparableHarnessModels = new Set(comparableHarnessGroups.map(([key]) => key.split('\u0000')[0]));

console.log(`\n-- Harness coverage ------------------------------------------`);
console.log(`  Rows naming a harness:                    ${harnessRows.length} / ${results.length}`);
console.log(`  Distinct named harnesses:                 ${new Set(harnessRows.map((r) => r.harness)).size}`);
console.log(`  Named rows with a harness version:        ${harnessRows.filter((r) => r.harness_version !== null).length} / ${harnessRows.length}`);
console.log(`  Named rows with harness config recorded:  ${harnessRows.filter((r) => r.harness_config !== null).length} / ${harnessRows.length}`);
console.log(`  Models with >=2 harnesses on one benchmark: ${comparableHarnessModels.size}`);
if (comparableHarnessModels.size === 0) {
  console.log(`  GAP: zero within-model harness variation; no harness cost comparison can be computed.`);
} else {
  console.log(`  Comparable models: ${[...comparableHarnessModels].sort().join(', ')}`);
}

const benchOnly = results.filter((r) => r.model_id === null);
console.log(`\n-- Benchmarked but unmatched to a verified price --------------`);
for (const r of benchOnly) console.log(`  ${r.entry_label.padEnd(36)} ${(r.pass_rate * 100).toFixed(0)}%  -- ${r.unmatched_reason}`);

console.log(`\n-- Redistribution --------------------------------------------`);
console.log(`  Rows publishable in the CC-BY /data export: ${results.filter((r) => r.redistributable).length} of ${results.length}`);
console.log(`  All ingested benchmark data is third-party, cited and linked only.`);
console.log(`  Only Solvency's own Phase 3 runs may be published as open data.`);
