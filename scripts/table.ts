/**
 * Headline table: cost per solved task at current prices.
 *   node scripts/table.ts [--variant=naive|capped|truncatedGeometric]
 *
 * Rows split by cost basis, because a measured cost and a modeled cost are not
 * the same kind of number and must never be read as one column.
 */
import { models, tiers, assumptions, bestResultFor, extrasFor, sourceFor, stalenessDays, TIER_NAMES } from './load.ts';
import { costPerSolvedTask, defaultOptions } from './solved-cost.ts';

const variant = (process.argv.find((a) => a.startsWith('--variant='))?.split('=')[1] ?? 'naive') as
  'naive' | 'capped' | 'truncatedGeometric';
const asOf = new Date().toISOString().slice(0, 10);
const opts = defaultOptions(assumptions);
const money = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);

const rows = models.map((m) => ({ m, r: bestResultFor(m.model_id) })).filter((x) => x.r);
const measured = rows.filter((x) => x.r!.cost_basis === 'measured_by_source');
const modeled = rows.filter((x) => x.r!.cost_basis !== 'measured_by_source');

console.log(`COST PER SOLVED TASK  --  variant=${variant}  --  computed ${asOf}\n`);

console.log(`== MEASURED  (source observed real cost; NO Solvency loop assumption) ==`);
console.log(`${'model'.padEnd(24)}${'harness'.padEnd(13)}${'pass'.padStart(6)}${'$/task'.padStart(9)}${'$/solved'.padStart(10)}`);
console.log('-'.repeat(60));
for (const { m, r } of measured.sort((a, b) => b.r!.pass_rate - a.r!.pass_rate)) {
  const out = costPerSolvedTask(m, 'heavy', tiers.heavy, r!.pass_rate, opts, extrasFor(r!));
  console.log(
    m.model_id.padEnd(24) + (r!.harness ?? '').padEnd(13) +
    `${(r!.pass_rate * 100).toFixed(0)}%`.padStart(6) +
    money(r!.measured_cost_per_task_usd!).padStart(9) +
    money(out.value![variant]).padStart(10),
  );
}

console.log(`\n== MODELED  (pass rate published, cost from Solvency's ASSUMED loop model) ==`);
console.log(`${'model'.padEnd(24)}${'source'.padEnd(13)}${'pass'.padStart(6)}${'age'.padStart(7)}` + TIER_NAMES.map((t) => t.padStart(10)).join(''));
console.log('-'.repeat(80));
for (const { m, r } of modeled.sort((a, b) => b.r!.pass_rate - a.r!.pass_rate)) {
  const cells = TIER_NAMES.map((t) => {
    const out = costPerSolvedTask(m, t, tiers[t], r!.pass_rate, opts, extrasFor(r!));
    return (out.value === null ? 'MISSING' : money(out.value[variant])).padStart(10);
  });
  const src = r!.benchmark === 'seal-swe-bench-pro' ? 'SEAL' : 'Aider';
  const age = r!.benchmark === 'aider-polyglot' ? `${stalenessDays(r!.run_date, asOf)}d` : '--';
  console.log(m.model_id.padEnd(24) + src.padEnd(13) + `${(r!.pass_rate * 100).toFixed(0)}%`.padStart(6) + age.padStart(7) + cells.join(''));
}

const uncovered = models.filter((m) => m.status === 'current' && !bestResultFor(m.model_id));
console.log(`\n== NO PASS RATE ANYWHERE (shown as MISSING, never imputed) ==`);
console.log('  ' + (uncovered.map((m) => m.model_id).join(', ') || 'none'));

console.log(`\nMeasured rows: ${sourceFor('aa-coding-agent-index').attribution}. Harness+model pairs, not bare models.`);
console.log(`Modeled rows apply the loop model + frontier-efficiency multiplier -- both ASSUMPTIONS. See data/assumptions.json.`);
