import { quoteBuildPlan, type BuildPlanV1, type BuildQuoteV1 } from './build-cost.ts';
import type { Model } from './engine.ts';

export type SensitivityAxis = 'role_calls' | 'tokens_per_call' | 'model_rates' | 'system_success';

export interface BuildSensitivityV1 {
  schemaVersion: 1;
  axis: SensitivityAxis;
  requestedDelta: number;
  lowFactor: number;
  highFactor: number;
  assumption: string;
  available: boolean;
  missingReason: string | null;
  low: BuildQuoteV1 | null;
  base: BuildQuoteV1;
  high: BuildQuoteV1 | null;
}

export type BreakEvenKind =
  | 'crosses'
  | 'current_always_lower'
  | 'baseline_always_lower'
  | 'equal_all_volumes'
  | 'unavailable';

export interface BuildBreakEvenV1 {
  schemaVersion: 1;
  kind: BreakEvenKind;
  available: boolean;
  reason: string | null;
  attemptedBuildsPerMonth: number | null;
  lowerBelow: 'current' | 'baseline' | 'equal' | null;
  lowerAbove: 'current' | 'baseline' | 'equal' | null;
  currentAttemptCostUsd: number | null;
  baselineAttemptCostUsd: number | null;
  currentFixedMonthlyUsd: number | null;
  baselineFixedMonthlyUsd: number | null;
}

const clone = <T>(value: T): T => structuredClone(value);

function scaledRatePlan(plan: BuildPlanV1, catalog: Model[], factor: number): BuildPlanV1 {
  const scaled = clone(plan);
  for (const role of scaled.roles) {
    const model = catalog.find((candidate) => candidate.model_id === role.modelId);
    if (!model) continue;
    const current = role.priceOverride;
    const input = current?.inputPerMtok ?? model.input_per_mtok;
    const output = current?.outputPerMtok ?? model.output_per_mtok;
    const cacheRead = current?.cacheReadPerMtok ?? model.cached_input_per_mtok ?? input;
    const cacheWrite = current?.cacheWritePerMtok;
    role.priceOverride = {
      inputPerMtok: input * factor,
      outputPerMtok: output * factor,
      ...(role.usagePerInvocation.cacheReadTokens > 0 || current?.cacheReadPerMtok !== undefined
        ? { cacheReadPerMtok: cacheRead * factor }
        : {}),
      ...(cacheWrite !== undefined ? { cacheWritePerMtok: cacheWrite * factor } : {}),
      basis: 'user_supplied',
    };
  }
  return scaled;
}

function scaledPlan(plan: BuildPlanV1, catalog: Model[], axis: SensitivityAxis, factor: number): BuildPlanV1 | null {
  if (axis === 'model_rates') return scaledRatePlan(plan, catalog, factor);
  const scaled = clone(plan);
  if (axis === 'role_calls') {
    for (const role of scaled.roles) role.expectedInvocationsPerBuildAttempt *= factor;
  } else if (axis === 'tokens_per_call') {
    for (const role of scaled.roles) {
      role.usagePerInvocation.uncachedInputTokens *= factor;
      role.usagePerInvocation.cacheReadTokens *= factor;
      role.usagePerInvocation.cacheWriteTokens *= factor;
      role.usagePerInvocation.outputTokens *= factor;
      role.usagePerInvocation.basis = 'user_supplied';
    }
  } else if (axis === 'system_success') {
    if (!scaled.endToEndSuccess) return null;
    scaled.endToEndSuccess = {
      rate: Math.min(1, scaled.endToEndSuccess.rate * factor),
      basis: 'user_assumption',
    };
  }
  return scaled;
}

export function analyzeBuildSensitivity(
  plan: BuildPlanV1,
  catalog: Model[],
  axis: SensitivityAxis,
  requestedDelta: number,
  quotedAt = new Date().toISOString(),
): BuildSensitivityV1 {
  if (!Number.isFinite(requestedDelta) || requestedDelta <= 0 || requestedDelta >= 1) {
    throw new RangeError('Sensitivity range must be greater than 0% and less than 100%.');
  }
  if (!['role_calls', 'tokens_per_call', 'model_rates', 'system_success'].includes(axis)) {
    throw new RangeError('Sensitivity axis is invalid.');
  }

  const base = quoteBuildPlan(plan, catalog, quotedAt);
  const lowRequested = 1 - requestedDelta;
  const highRequested = 1 + requestedDelta;
  if (!base.valid) {
    return {
      schemaVersion: 1, axis, requestedDelta, lowFactor: lowRequested, highFactor: highRequested,
      assumption: 'Hypothetical one-variable sensitivity; all other plan inputs are held constant.',
      available: false,
      missingReason: 'The current plan is invalid. Resolve its quote errors before calculating sensitivity.',
      low: null, base, high: null,
    };
  }
  const lowPlan = scaledPlan(plan, catalog, axis, lowRequested);
  const highPlan = scaledPlan(plan, catalog, axis, highRequested);
  if (!lowPlan || !highPlan) {
    return {
      schemaVersion: 1, axis, requestedDelta, lowFactor: lowRequested, highFactor: highRequested,
      assumption: 'Hypothetical one-variable sensitivity; all other plan inputs are held constant.',
      available: false,
      missingReason: 'Whole-system success must be supplied before success-rate sensitivity can be calculated.',
      low: null, base, high: null,
    };
  }

  const low = quoteBuildPlan(lowPlan, catalog, quotedAt);
  const high = quoteBuildPlan(highPlan, catalog, quotedAt);
  const baseSuccess = plan.endToEndSuccess?.rate;
  const lowFactor = axis === 'system_success' && baseSuccess ? lowPlan.endToEndSuccess!.rate / baseSuccess : lowRequested;
  const highFactor = axis === 'system_success' && baseSuccess ? highPlan.endToEndSuccess!.rate / baseSuccess : highRequested;
  return {
    schemaVersion: 1, axis, requestedDelta, lowFactor, highFactor,
    assumption: 'Hypothetical one-variable sensitivity; all other plan inputs are held constant.',
    available: base.valid && low.valid && high.valid,
    missingReason: base.valid && low.valid && high.valid ? null : 'The current or perturbed plan is invalid.',
    low, base, high,
  };
}

export function breakEvenBuildPlans(
  currentPlan: BuildPlanV1,
  baselinePlan: BuildPlanV1,
  catalog: Model[],
  quotedAt = new Date().toISOString(),
): BuildBreakEvenV1 {
  const current = quoteBuildPlan(currentPlan, catalog, quotedAt);
  const baseline = quoteBuildPlan(baselinePlan, catalog, quotedAt);
  const currentAttempt = current.buildAttemptCostUsd;
  const baselineAttempt = baseline.buildAttemptCostUsd;
  const currentFixedRaw = currentPlan.harness.fixedMonthlyCostUsd;
  const baselineFixedRaw = baselinePlan.harness.fixedMonthlyCostUsd;
  const currentFixed = Number.isFinite(currentFixedRaw) && currentFixedRaw >= 0 ? currentFixedRaw : null;
  const baselineFixed = Number.isFinite(baselineFixedRaw) && baselineFixedRaw >= 0 ? baselineFixedRaw : null;
  const unavailable = (reason: string): BuildBreakEvenV1 => ({
    schemaVersion: 1, kind: 'unavailable', available: false, reason,
    attemptedBuildsPerMonth: null, lowerBelow: null, lowerAbove: null,
    currentAttemptCostUsd: currentAttempt, baselineAttemptCostUsd: baselineAttempt,
    currentFixedMonthlyUsd: currentFixed, baselineFixedMonthlyUsd: baselineFixed,
  });
  if (!current.valid || !baseline.valid || currentAttempt === null || baselineAttempt === null || currentFixed === null || baselineFixed === null) {
    return unavailable('Both plans need valid per-attempt quotes.');
  }

  const slope = currentAttempt - baselineAttempt;
  const intercept = currentFixed - baselineFixed;
  if (!Number.isFinite(slope) || !Number.isFinite(intercept)) return unavailable('The cost difference is outside the supported numeric range.');
  if (slope === 0) {
    if (intercept === 0) return {
      schemaVersion: 1, kind: 'equal_all_volumes', available: true, reason: null,
      attemptedBuildsPerMonth: null, lowerBelow: 'equal', lowerAbove: 'equal',
      currentAttemptCostUsd: currentAttempt, baselineAttemptCostUsd: baselineAttempt,
      currentFixedMonthlyUsd: currentFixed, baselineFixedMonthlyUsd: baselineFixed,
    };
    return {
      schemaVersion: 1, kind: intercept < 0 ? 'current_always_lower' : 'baseline_always_lower', available: true, reason: null,
      attemptedBuildsPerMonth: null,
      lowerBelow: intercept < 0 ? 'current' : 'baseline', lowerAbove: intercept < 0 ? 'current' : 'baseline',
      currentAttemptCostUsd: currentAttempt, baselineAttemptCostUsd: baselineAttempt,
      currentFixedMonthlyUsd: currentFixed, baselineFixedMonthlyUsd: baselineFixed,
    };
  }

  const crossing = -intercept / slope;
  if (!Number.isFinite(crossing)) return unavailable('The break-even volume is outside the supported numeric range.');
  if (crossing <= 0) {
    const currentLower = slope < 0;
    return {
      schemaVersion: 1, kind: currentLower ? 'current_always_lower' : 'baseline_always_lower', available: true, reason: null,
      attemptedBuildsPerMonth: crossing < 0 ? null : 0,
      lowerBelow: crossing < 0 ? (currentLower ? 'current' : 'baseline') : 'equal',
      lowerAbove: currentLower ? 'current' : 'baseline',
      currentAttemptCostUsd: currentAttempt, baselineAttemptCostUsd: baselineAttempt,
      currentFixedMonthlyUsd: currentFixed, baselineFixedMonthlyUsd: baselineFixed,
    };
  }

  const baselineLowerAtZero = intercept > 0;
  return {
    schemaVersion: 1, kind: 'crosses', available: true, reason: null,
    attemptedBuildsPerMonth: crossing,
    lowerBelow: baselineLowerAtZero ? 'baseline' : 'current',
    lowerAbove: baselineLowerAtZero ? 'current' : 'baseline',
    currentAttemptCostUsd: currentAttempt, baselineAttemptCostUsd: baselineAttempt,
    currentFixedMonthlyUsd: currentFixed, baselineFixedMonthlyUsd: baselineFixed,
  };
}
