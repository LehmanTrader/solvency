/**
 * Estimates the API cost of a Solvency benchmark run, and the statistical
 * precision that scope buys. Phase 3 requires a dry-run estimate before any
 * live spend; this is that estimator.
 *
 *   node scripts/bench-budget.ts
 *
 * Cost basis: Artificial Analysis's MEASURED cost per task per model, which
 * already reflects real token burn on agentic SWE tasks at current prices.
 * That is an ASSUMPTION about our own task mix -- our four task types may be
 * cheaper or dearer than AA's DeepSWE / Terminal-Bench / SWE-Atlas blend.
 */
import { models, bestResultFor } from './load.ts';

const fleet = models
  .map((m) => ({ m, r: bestResultFor(m.model_id) }))
  .filter((x) => x.r?.cost_basis === 'measured_by_source')
  .map(({ m, r }) => ({ id: m.display_name, perTask: r!.measured_cost_per_task_usd!, p: r!.pass_rate }))
  .sort((a, b) => b.perTask - a.perTask);

/** 95% CI half-width on a pass rate from n independent attempts. */
const ci95 = (p: number, n: number) => 1.96 * Math.sqrt((p * (1 - p)) / n);

const SCENARIOS = [
  { name: 'Plan as written', tasks: 4, attempts: 3 },
  { name: 'Tier-separating', tasks: 30, attempts: 3 },
  { name: 'Publishable', tasks: 120, attempts: 3 },
  { name: 'AA-comparable', tasks: 326, attempts: 3 },
];

const usd = (n: number) => (n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(0)}`);

console.log('BENCHMARK RUN COST — 6 measured models, one full run\n');
console.log('scenario          runs/model   ' + fleet.map((f) => f.id.split(' ')[0].padStart(9)).join('') + '      TOTAL   ±95% CI');
console.log('-'.repeat(112));

for (const s of SCENARIOS) {
  const n = s.tasks * s.attempts;
  const cells = fleet.map((f) => usd(n * f.perTask).padStart(9)).join('');
  const total = fleet.reduce((acc, f) => acc + n * f.perTask, 0);
  const meanP = fleet.reduce((a, f) => a + f.p, 0) / fleet.length;
  console.log(
    `${s.name.padEnd(18)}${String(n).padStart(7)}      ${cells}${usd(total).padStart(11)}` +
    `${(ci95(meanP, n) * 100).toFixed(1).padStart(9)}pp`,
  );
}

console.log('\nPER-MODEL COST PER 100 TASK-ATTEMPTS');
for (const f of fleet) console.log(`  ${f.id.padEnd(20)} ${usd(100 * f.perTask).padStart(8)}   (AA measured $${f.perTask.toFixed(2)}/task)`);

const cheap = fleet.filter((f) => f.perTask < 3), dear = fleet.filter((f) => f.perTask >= 3);
const share = dear.reduce((a, f) => a + f.perTask, 0) / fleet.reduce((a, f) => a + f.perTask, 0);
console.log(`\n  ${dear.length} frontier models drive ${(share * 100).toFixed(0)}% of the bill; the ${cheap.length} cheap ones are rounding error.`);

console.log('\nMONTHLY CADENCE (12 runs/year)');
for (const s of SCENARIOS) {
  const n = s.tasks * s.attempts;
  const total = fleet.reduce((acc, f) => acc + n * f.perTask, 0);
  console.log(`  ${s.name.padEnd(18)} ${usd(total).padStart(8)}/run   ${usd(total * 12).padStart(8)}/year`);
}

console.log(`
NOT INCLUDED
  - Failed attempts often cost MORE than passing ones: an agent that cannot
    solve a task loops until it hits the turn limit. These figures use AA's
    blended per-task average, which already includes their failures, so this
    is partly covered -- but a harder task suite shifts the mix toward failure.
  - Infrastructure retries, aborted runs, and debugging the harness itself.
  - Engineering time to build and maintain the suite and grader.
  - Provider rate limits may force runs to span days.`);
