import { assumptions, extrasFor, harnessResultsFor, modelById, sourceFor, tiers } from './data.ts';
import { costPerSolvedTask, defaultOptions, type BenchmarkResult } from './engine.ts';

export interface HarnessCostRow {
  result: BenchmarkResult;
  harness: string;
  version: string;
  passRate: number;
  solved: number;
  countable: number;
  excluded: number;
  attemptCost: number;
  solvedCost: number;
  versusLowest: number;
}

/**
 * Reprice source-observed usage for a single model. These rows deliberately
 * never enter the general leaderboard: comparability requires the same model
 * and benchmark, with only the harness changing.
 */
export function harnessCostsFor(modelId: string): HarnessCostRow[] {
  const model = modelById(modelId);
  if (!model) return [];
  const priced = harnessResultsFor(modelId).flatMap((result) => {
    const out = costPerSolvedTask(
      model, 'heavy', tiers.heavy, result.pass_rate,
      defaultOptions(assumptions), extrasFor(result),
    );
    if (!out.value || !result.harness || !result.harness_version) return [];
    return [{
      result,
      harness: result.harness,
      version: result.harness_version,
      passRate: result.pass_rate,
      solved: result.solved_attempts_n ?? 0,
      countable: result.countable_attempts_n ?? 0,
      excluded: result.excluded_attempts_n ?? 0,
      attemptCost: out.value.attempt.costUsd,
      solvedCost: out.value.naive,
      versusLowest: 1,
    }];
  }).sort((a, b) => a.solvedCost - b.solvedCost);
  const lowest = priced[0]?.solvedCost;
  return priced.map((row) => ({ ...row, versusLowest: lowest ? row.solvedCost / lowest : 1 }));
}

export function harnessSource(modelId: string) {
  const benchmark = harnessResultsFor(modelId)[0]?.benchmark;
  return benchmark ? sourceFor(benchmark) : undefined;
}
