/**
 * Denominator core computation.
 *
 * cost per solved task = cost per attempt / probability the attempt solves it
 *
 * Everything here is a pure function of (verified prices, benchmark pass rates,
 * labelled assumptions). Nothing fetches, nothing caches, nothing guesses.
 * A missing input yields `value: null` plus the reason -- never a substituted number.
 */
import type {
  Model, TaskTier, TierName, Computed, Provenance,
} from './types.ts';

export interface FrontierEfficiency {
  multipliers_by_tier: Record<TierName, number>;
  applies_to_capability_class: string;
}

export interface EngineOptions {
  /** Fraction of input tokens served from prompt cache, 0..1. */
  cacheHitFraction: number;
  /** Attempts after which a human takes over. */
  maxAttempts: number;
  /** Cost booked when all attempts fail and a person finishes the job. */
  residualHumanCostUsd: number;
  frontierEfficiency: FrontierEfficiency;
  /** Override the tier's default loop count (e.g. to show the low/high band). */
  loopsOverride?: number;
}

export interface AttemptCost {
  loops: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
}

const MTOK = 1_000_000;

/** Loop count after the (assumed) frontier-efficiency adjustment. */
export function effectiveLoops(
  model: Model, tierName: TierName, tier: TaskTier, opts: EngineOptions,
): number {
  const base = opts.loopsOverride ?? tier.loops_default;
  const applies = model.capability_class === opts.frontierEfficiency.applies_to_capability_class;
  const multiplier = applies ? opts.frontierEfficiency.multipliers_by_tier[tierName] : 1;
  return base * multiplier;
}

/**
 * Dollar cost of one attempt at a task: loops x per-loop tokens x current price.
 *
 * Deliberately recomputed from live prices rather than reusing the benchmark's
 * measured cost, which was incurred at the prices of its run date.
 */
export function costPerAttempt(
  model: Model, tierName: TierName, tier: TaskTier, opts: EngineOptions,
): Computed<AttemptCost> {
  const missing: string[] = [];
  const provenance: Provenance[] = [
    { source_url: model.source_url, last_verified: model.last_verified },
  ];

  if (opts.cacheHitFraction > 0 && model.cached_input_per_mtok === null) {
    missing.push(
      `${model.model_id}: no published cached-input price, so a ` +
      `${(opts.cacheHitFraction * 100).toFixed(0)}% cache hit rate cannot be modelled`,
    );
    return { value: null, missing, provenance };
  }

  const loops = effectiveLoops(model, tierName, tier, opts);
  const inputTokens = loops * tier.input_tokens_per_loop;
  const outputTokens = loops * tier.output_tokens_per_loop;
  const cachedInputTokens = inputTokens * opts.cacheHitFraction;
  const freshInputTokens = inputTokens - cachedInputTokens;

  const costUsd =
    (freshInputTokens / MTOK) * model.input_per_mtok +
    (cachedInputTokens / MTOK) * (model.cached_input_per_mtok ?? 0) +
    (outputTokens / MTOK) * model.output_per_mtok;

  return {
    value: { loops, inputTokens, cachedInputTokens, outputTokens, costUsd },
    missing,
    provenance,
  };
}

/** Which cost basis produced the attempt cost. Never conflated in output. */
export type CostBasis = 'measured_by_source' | 'modelled_by_denominator';

export interface SolvedCost {
  /** Where the attempt cost came from. `measured_by_source` uses NO loop assumption. */
  costBasis: CostBasis;
  /** cost / p. Assumes unlimited retries and that retries are independent. */
  naive: number;
  /** Brief's stated model: min(1/p, maxAttempts) attempts, plus residual on failure. */
  capped: number;
  /**
   * Rigorous truncated-geometric variant, normalised by the probability the
   * task is EVER solved within maxAttempts. Differs from `capped` because
   * min(1/p, K) overstates attempts for high p and understates the cost of
   * tasks that are never solved. See /methodology.
   */
  truncatedGeometric: number;
  expectedAttemptsCapped: number;
  expectedAttemptsTruncated: number;
  probabilitySolvedWithinCap: number;
  attempt: AttemptCost;
}

/**
 * Join one model's current price to one benchmark pass rate.
 *
 * `passRate` must come from a benchmark run; it is never inferred from price,
 * capability class, or a sibling model.
 */
export interface SolvedCostExtras {
  passRateProvenance?: Provenance;
  /**
   * A per-task cost the benchmark source actually OBSERVED. When supplied it
   * replaces the modelled attempt cost outright: no loop count, no
   * frontier-efficiency multiplier, no per-loop token assumption is applied.
   * This is the preferred basis wherever a source publishes it.
   */
  measuredAttemptCostUsd?: number;
}

export function costPerSolvedTask(
  model: Model,
  tierName: TierName,
  tier: TaskTier,
  passRate: number | null,
  opts: EngineOptions,
  extras: SolvedCostExtras = {},
): Computed<SolvedCost> {
  const measured = extras.measuredAttemptCostUsd;
  const useMeasured = typeof measured === 'number';

  // A measured cost still needs an attempt shape for reporting, but its dollar
  // figure must not be contaminated by the loop model.
  const modelled = costPerAttempt(model, tierName, tier, opts);
  const attempt: Computed<AttemptCost> = useMeasured
    ? {
        value: { loops: NaN, inputTokens: NaN, cachedInputTokens: NaN, outputTokens: NaN, costUsd: measured },
        missing: [],
        provenance: [],
      }
    : modelled;

  const provenance = [...attempt.provenance];
  if (extras.passRateProvenance) provenance.push(extras.passRateProvenance);

  const missing = [...attempt.missing];

  if (passRate === null) {
    missing.push(`${model.model_id}: no published pass rate to divide by`);
  } else if (passRate <= 0 || passRate > 1) {
    missing.push(`${model.model_id}: pass rate ${passRate} outside (0,1]`);
  }

  if (attempt.value === null || passRate === null || passRate <= 0 || passRate > 1) {
    return { value: null, missing, provenance };
  }

  const p = passRate;
  const K = opts.maxAttempts;
  const cost = attempt.value.costUsd;
  const residual = opts.residualHumanCostUsd;

  const pFailAll = Math.pow(1 - p, K);
  const pSolved = 1 - pFailAll;

  const expectedAttemptsCapped = Math.min(1 / p, K);
  const expectedAttemptsTruncated = pSolved / p;

  return {
    value: {
      costBasis: useMeasured ? 'measured_by_source' : 'modelled_by_denominator',
      naive: cost / p,
      capped: expectedAttemptsCapped * cost + residual * pFailAll,
      truncatedGeometric: pSolved === 0
        ? Infinity
        : (expectedAttemptsTruncated * cost + pFailAll * residual) / pSolved,
      expectedAttemptsCapped,
      expectedAttemptsTruncated,
      probabilitySolvedWithinCap: pSolved,
      attempt: attempt.value,
    },
    missing,
    provenance,
  };
}

export function defaultOptions(assumptions: any): EngineOptions {
  return {
    cacheHitFraction: assumptions.cache_hit_fraction.value,
    maxAttempts: assumptions.retry_model.max_attempts,
    residualHumanCostUsd: assumptions.retry_model.residual_human_cost_usd,
    frontierEfficiency: {
      multipliers_by_tier: assumptions.frontier_efficiency.multipliers_by_tier,
      applies_to_capability_class: assumptions.frontier_efficiency.applies_to_capability_class,
    },
  };
}
