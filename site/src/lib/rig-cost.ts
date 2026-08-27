import type { BuildInputOrigin } from './build-cost.ts';
import { RIG_LIMITS } from './rig-limits.ts';

export type RigComponentCondition = 'new' | 'used';
export type PowerDrawMethod = 'wall_meter' | 'software_reported' | 'nameplate_tdp';
export type ThroughputMethod = 'llama_bench' | 'self_reported';
export type LocalPassRateBasis = 'measured_by_solvency' | 'measured_by_user' | 'published' | 'user_assumption';

export const RIG_QUOTE_BASIS = 'local_tco_modeled' as const;

export interface RigComponentV1 {
  componentId: string;
  label: string;
  condition: RigComponentCondition;
  priceUsd: number;
  assertionOrigin?: BuildInputOrigin;
  sourceUrl?: string;
  lastVerified?: string;
}

/** System-level watts, deliberately: Apple Silicon has no discrete GPU draw to isolate. */
export interface RigPowerV1 {
  systemWatts: number;
  method: PowerDrawMethod;
  assertionOrigin?: BuildInputOrigin;
  sourceUrl?: string;
  lastVerified?: string;
}

export interface RigThroughputV1 {
  tokensPerSecond: number;
  runtime: string;
  runtimeVersion: string | null;
  contextTokens: number | null;
  method: ThroughputMethod;
  /** Names the rented proxy host when measurement is rent-as-proxy. */
  measurementPlatform?: string;
  assertionOrigin?: BuildInputOrigin;
  sourceUrl?: string;
  lastVerified?: string;
}

export interface LocalPassRateV1 {
  rate: number;
  benchmark: string;
  basis: LocalPassRateBasis;
  assertionOrigin?: BuildInputOrigin;
  sourceUrl?: string;
  lastVerified?: string;
}

export interface LocalModelV1 {
  modelName: string;
  quantization: string | null;
  passRate?: LocalPassRateV1;
}

export interface RigSpecV1 {
  schemaVersion: 1;
  name: string;
  components: RigComponentV1[];
  resale: {
    residualUsd: number;
    assertionOrigin?: BuildInputOrigin;
    sourceUrl?: string;
    lastVerified?: string;
  };
  horizonMonths: number;
  power: RigPowerV1;
  electricity: {
    usdPerKwh: number;
    region?: string;
    assertionOrigin?: BuildInputOrigin;
    sourceUrl?: string;
    lastVerified?: string;
  };
  throughput: RigThroughputV1;
  model: LocalModelV1;
  workload: {
    tasksPerMonth: number;
    tokensPerAttempt: number;
    overheadSecondsPerAttempt?: number;
  };
}

export interface RigQuoteV1 {
  schemaVersion: 1;
  engineVersion: 'rig-cost-v1';
  basis: typeof RIG_QUOTE_BASIS;
  quotedAt: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
  missing: string[];
  rigName: string;
  buildCostUsd: number | null;
  amortizationPerMonthUsd: number | null;
  attemptSeconds: number | null;
  electricityPerAttemptUsd: number | null;
  amortizationPerAttemptUsd: number | null;
  costPerAttemptUsd: number | null;
  costPerSolvedTaskUsd: number | null;
  monthlyCostUsd: number | null;
  passRate: RigSpecV1['model']['passRate'] | null;
  power: RigSpecV1['power'];
  throughput: RigSpecV1['throughput'];
}

const finiteNonnegative = (value: number) => Number.isFinite(value) && value >= 0;
const finitePositive = (value: number) => Number.isFinite(value) && value > 0;
const oneOf = <T extends string>(value: string, allowed: readonly T[]): value is T => allowed.includes(value as T);
const INPUT_ORIGINS = ['user_asserted', 'solvency_template', 'source_verified'] as const;
const byteLen = (value: string) => Buffer.byteLength(value, 'utf8');

function validateAssertionOrigin(
  label: string,
  origin: BuildInputOrigin | undefined,
  sourceUrl: string | undefined,
  lastVerified: string | undefined,
  errors: string[],
): void {
  if (origin !== undefined && !oneOf(origin, INPUT_ORIGINS)) errors.push(`${label}: assertion origin is invalid.`);
  if (origin === 'source_verified' && (!sourceUrl?.trim() || !lastVerified?.trim())) {
    errors.push(`${label}: source_verified inputs require a source URL and verification date.`);
  }
}

function checkCap(label: string, value: number, cap: number, errors: string[]): void {
  if (Number.isFinite(value) && value > cap) errors.push(`${label} is above the supported limit.`);
}

function checkChars(label: string, value: string, maxChars: number, errors: string[]): void {
  if (value.length > maxChars) errors.push(`${label} is longer than the supported limit.`);
}

function checkBytes(label: string, value: string, maxBytes: number, errors: string[]): void {
  if (byteLen(value) > maxBytes) errors.push(`${label} is larger than the supported byte limit.`);
}

function nullQuote(spec: RigSpecV1, quotedAt: string, errors: string[], warnings: string[], missing: string[]): RigQuoteV1 {
  return {
    schemaVersion: 1, engineVersion: 'rig-cost-v1', basis: RIG_QUOTE_BASIS, quotedAt, valid: false,
    errors, warnings, missing, rigName: spec.name,
    buildCostUsd: null, amortizationPerMonthUsd: null, attemptSeconds: null,
    electricityPerAttemptUsd: null, amortizationPerAttemptUsd: null,
    costPerAttemptUsd: null, costPerSolvedTaskUsd: null, monthlyCostUsd: null,
    passRate: spec.model.passRate ?? null,
    power: { ...spec.power },
    throughput: { ...spec.throughput },
  };
}

export function quoteRig(spec: RigSpecV1, quotedAt = new Date().toISOString()): RigQuoteV1 {
  const errors: string[] = [];
  const warnings: string[] = [];
  const missing: string[] = [];

  if (spec.schemaVersion !== 1) errors.push('Unsupported rig-spec schema version.');
  if (!spec.name.trim()) errors.push('Rig name is required.');
  checkChars('Rig name', spec.name, RIG_LIMITS.maxRigNameChars, errors);
  checkBytes('Rig name', spec.name, RIG_LIMITS.maxRigNameBytes, errors);

  if (!spec.components.length) errors.push('At least one component is required.');
  checkCap('Component count', spec.components.length, RIG_LIMITS.maxComponents, errors);

  const componentIds = new Set<string>();
  for (const component of spec.components) {
    const prefix = component.label.trim() || component.componentId || 'Component';
    if (!component.componentId.trim()) errors.push(`${prefix}: component ID is required.`);
    else if (componentIds.has(component.componentId)) errors.push(`${prefix}: component ID must be unique.`);
    componentIds.add(component.componentId);
    if (!component.label.trim()) errors.push(`${prefix}: label is required.`);
    checkChars(`${prefix}: component ID`, component.componentId, RIG_LIMITS.maxComponentIdChars, errors);
    checkChars(`${prefix}: label`, component.label, RIG_LIMITS.maxComponentLabelChars, errors);
    checkBytes(`${prefix}: label`, component.label, RIG_LIMITS.maxComponentLabelBytes, errors);
    if (!oneOf(component.condition, ['new', 'used'])) errors.push(`${prefix}: condition is invalid.`);
    if (!finiteNonnegative(component.priceUsd)) errors.push(`${prefix}: price must be zero or greater.`);
    checkCap(`${prefix}: price`, component.priceUsd, RIG_LIMITS.maxComponentPriceUsd, errors);
    validateAssertionOrigin(`${prefix}: price`, component.assertionOrigin, component.sourceUrl, component.lastVerified, errors);
    if (component.condition === 'used' && !component.lastVerified?.trim()) {
      warnings.push(`${prefix}: used-component price has no verification date; street prices are dated snapshots.`);
    }
  }

  if (!finiteNonnegative(spec.resale.residualUsd)) errors.push('Resale residual value must be zero or greater.');
  validateAssertionOrigin('Resale residual', spec.resale.assertionOrigin, spec.resale.sourceUrl, spec.resale.lastVerified, errors);

  if (!finitePositive(spec.horizonMonths)) errors.push('Amortization horizon must be greater than zero months.');
  checkCap('Amortization horizon', spec.horizonMonths, RIG_LIMITS.maxHorizonMonths, errors);

  const buildCostUsd = spec.components.reduce((sum, component) => sum + component.priceUsd, 0);
  if (finiteNonnegative(spec.resale.residualUsd) && finiteNonnegative(buildCostUsd) && spec.resale.residualUsd > buildCostUsd) {
    errors.push('Resale residual value cannot exceed the total build cost.');
  }

  if (!finitePositive(spec.power.systemWatts)) errors.push('System power draw must be greater than zero watts.');
  checkCap('System power draw', spec.power.systemWatts, RIG_LIMITS.maxSystemWatts, errors);
  if (!oneOf(spec.power.method, ['wall_meter', 'software_reported', 'nameplate_tdp'])) errors.push('Power draw method is invalid.');
  validateAssertionOrigin('Power draw', spec.power.assertionOrigin, spec.power.sourceUrl, spec.power.lastVerified, errors);
  if (spec.power.method === 'nameplate_tdp') {
    warnings.push('Power draw uses nameplate TDP, not measured draw; treat electricity cost as an upper bound.');
  }

  if (!finiteNonnegative(spec.electricity.usdPerKwh)) errors.push('Electricity price must be zero or greater.');
  checkCap('Electricity price', spec.electricity.usdPerKwh, RIG_LIMITS.maxUsdPerKwh, errors);
  if (spec.electricity.region !== undefined) checkChars('Electricity region', spec.electricity.region, RIG_LIMITS.maxRegionChars, errors);
  validateAssertionOrigin('Electricity price', spec.electricity.assertionOrigin, spec.electricity.sourceUrl, spec.electricity.lastVerified, errors);

  if (!finitePositive(spec.throughput.tokensPerSecond)) errors.push('Throughput must be greater than zero tokens per second.');
  checkCap('Throughput', spec.throughput.tokensPerSecond, RIG_LIMITS.maxTokensPerSecond, errors);
  if (!spec.throughput.runtime.trim()) errors.push('Runtime is required.');
  checkChars('Runtime', spec.throughput.runtime, RIG_LIMITS.maxRuntimeChars, errors);
  if (spec.throughput.runtimeVersion !== null) checkChars('Runtime version', spec.throughput.runtimeVersion, RIG_LIMITS.maxRuntimeVersionChars, errors);
  if (spec.throughput.contextTokens !== null) {
    if (!finitePositive(spec.throughput.contextTokens)) errors.push('Context length must be greater than zero tokens.');
    checkCap('Context length', spec.throughput.contextTokens, RIG_LIMITS.maxContextTokens, errors);
  }
  if (spec.throughput.measurementPlatform !== undefined) {
    checkChars('Measurement platform', spec.throughput.measurementPlatform, RIG_LIMITS.maxMeasurementPlatformChars, errors);
  }
  if (!oneOf(spec.throughput.method, ['llama_bench', 'self_reported'])) errors.push('Throughput method is invalid.');
  validateAssertionOrigin('Throughput', spec.throughput.assertionOrigin, spec.throughput.sourceUrl, spec.throughput.lastVerified, errors);
  if (spec.throughput.method === 'self_reported') {
    warnings.push('Throughput is self-reported, not benchmarked by llama-bench; treat it as an estimate.');
  }

  if (!spec.model.modelName.trim()) errors.push('Model name is required.');
  checkChars('Model name', spec.model.modelName, RIG_LIMITS.maxModelNameChars, errors);
  if (spec.model.quantization !== null) checkChars('Quantization', spec.model.quantization, RIG_LIMITS.maxQuantizationChars, errors);

  const passRate = spec.model.passRate;
  if (passRate) {
    if (!oneOf(passRate.basis, ['measured_by_solvency', 'measured_by_user', 'published', 'user_assumption'])) {
      errors.push('Pass-rate basis is invalid.');
    }
    if (!Number.isFinite(passRate.rate) || passRate.rate <= 0 || passRate.rate > 1) {
      errors.push('Pass rate must be greater than 0% and no more than 100%.');
    }
    if (!passRate.benchmark.trim()) errors.push('Pass-rate benchmark is required.');
    validateAssertionOrigin('Pass rate', passRate.assertionOrigin, passRate.sourceUrl, passRate.lastVerified, errors);
  } else {
    missing.push('model.passRate');
  }
  if (spec.model.quantization === null) missing.push('model.quantization');
  if (spec.throughput.runtimeVersion === null) missing.push('throughput.runtimeVersion');

  if (!finitePositive(spec.workload.tasksPerMonth)) errors.push('Monthly task volume must be greater than zero.');
  checkCap('Monthly task volume', spec.workload.tasksPerMonth, RIG_LIMITS.maxTasksPerMonth, errors);
  if (!finitePositive(spec.workload.tokensPerAttempt)) errors.push('Tokens per attempt must be greater than zero.');
  checkCap('Tokens per attempt', spec.workload.tokensPerAttempt, RIG_LIMITS.maxTokensPerAttempt, errors);
  const overheadSeconds = spec.workload.overheadSecondsPerAttempt ?? 0;
  if (!finiteNonnegative(overheadSeconds)) errors.push('Per-attempt overhead seconds must be zero or greater.');
  checkCap('Per-attempt overhead seconds', overheadSeconds, RIG_LIMITS.maxOverheadSecondsPerAttempt, errors);

  for (const url of [
    spec.resale.sourceUrl, spec.power.sourceUrl, spec.electricity.sourceUrl,
    spec.throughput.sourceUrl, passRate?.sourceUrl,
    ...spec.components.map((c) => c.sourceUrl),
  ]) {
    if (url !== undefined) checkBytes('Source URL', url, RIG_LIMITS.maxSourceUrlBytes, errors);
  }

  if (errors.length) return nullQuote(spec, quotedAt, errors, warnings, missing);

  const amortizable = buildCostUsd - spec.resale.residualUsd;
  const amortizationPerMonthUsd = amortizable / spec.horizonMonths;
  const attemptSeconds = spec.workload.tokensPerAttempt / spec.throughput.tokensPerSecond + overheadSeconds;
  const electricityPerAttemptUsd = (spec.power.systemWatts * attemptSeconds / 3600 / 1000) * spec.electricity.usdPerKwh;
  const amortizationPerAttemptUsd = amortizationPerMonthUsd / spec.workload.tasksPerMonth;
  const costPerAttemptUsd = amortizationPerAttemptUsd + electricityPerAttemptUsd;
  const canSolveForCost = Boolean(passRate) && spec.model.quantization !== null && spec.throughput.runtimeVersion !== null;
  const costPerSolvedTaskUsd = canSolveForCost ? costPerAttemptUsd / passRate!.rate : null;
  const monthlyCostUsd = amortizationPerMonthUsd + electricityPerAttemptUsd * spec.workload.tasksPerMonth;

  for (const [label, value] of [
    ['build cost', buildCostUsd],
    ['monthly amortization', amortizationPerMonthUsd],
    ['electricity per attempt', electricityPerAttemptUsd],
    ['amortization per attempt', amortizationPerAttemptUsd],
    ['cost per attempt', costPerAttemptUsd],
    ['cost per solved task', costPerSolvedTaskUsd],
    ['monthly cost', monthlyCostUsd],
  ] as const) {
    if (value !== null && (!Number.isFinite(value) || value > RIG_LIMITS.maxDerivedQuoteUsd)) {
      errors.push(`Derived ${label} is outside the supported numeric range.`);
    }
  }
  if (errors.length) return nullQuote(spec, quotedAt, errors, warnings, missing);

  return {
    schemaVersion: 1, engineVersion: 'rig-cost-v1', basis: RIG_QUOTE_BASIS, quotedAt, valid: true,
    errors, warnings, missing, rigName: spec.name,
    buildCostUsd, amortizationPerMonthUsd, attemptSeconds,
    electricityPerAttemptUsd, amortizationPerAttemptUsd,
    costPerAttemptUsd, costPerSolvedTaskUsd, monthlyCostUsd,
    passRate: passRate ?? null,
    power: { ...spec.power },
    throughput: { ...spec.throughput },
  };
}

/**
 * Mirrors harnessComparable in compare.ts: local quantization deltas are
 * meaningful only inside one model on one benchmark. Absent metadata never
 * becomes a wildcard, and two rows at the same quantization are not a
 * quantization delta.
 */
export function localPassRateComparable(a: LocalModelV1, b: LocalModelV1): boolean {
  return Boolean(a.passRate)
    && Boolean(b.passRate)
    && a.modelName === b.modelName
    && a.passRate!.benchmark === b.passRate!.benchmark
    && Boolean(a.quantization)
    && Boolean(b.quantization)
    && a.quantization !== b.quantization;
}

export function escalationBlend(
  local: { costPerAttemptUsd: number; passRate: number },
  cloud: { costPerAttemptUsd: number; passRate: number },
): { costPerTaskUsd: number; solvedFraction: number; costPerSolvedTaskUsd: number } | null {
  const validRate = (v: number) => Number.isFinite(v) && v > 0 && v <= 1;
  const validCost = (v: number) => Number.isFinite(v) && v >= 0;
  if (!validCost(local.costPerAttemptUsd) || !validCost(cloud.costPerAttemptUsd)
    || !validRate(local.passRate) || !validRate(cloud.passRate)) {
    return null;
  }
  const costPerTaskUsd = local.costPerAttemptUsd + (1 - local.passRate) * cloud.costPerAttemptUsd;
  const solvedFraction = local.passRate + (1 - local.passRate) * cloud.passRate;
  return { costPerTaskUsd, solvedFraction, costPerSolvedTaskUsd: costPerTaskUsd / solvedFraction };
}

/**
 * 'multi_seat': the tier has a hard per-seat/per-tier task cap, but the buyer
 * is assumed to stack additional seats/tiers to cover any volume above it —
 * cost/solved is a sawtooth of usdPerMonth*ceil(V/cap)/(V*p_c). 'hard_cap':
 * the tier simply cannot serve volume above its cap; no stacking assumption
 * is made, and cost/solved is undefined (null) above the cap. Default is
 * 'multi_seat' since most real subscription tiers can be stacked.
 */
export type SubscriptionScaling = 'multi_seat' | 'hard_cap';

/**
 * Cost per solved task for a subscription with an optional usage cap.
 * No cap (tasksPerMonthCap null/absent): plain flat-fee dilution,
 * usdPerMonth/(V*p_c) — identical to the uncapped math subscriptionBreakEven
 * has always used. With a cap under 'multi_seat', the buyer is modeled as
 * stacking ceil(V/cap) seats/tiers to cover the volume, so cost/solved is
 * ceil(V/cap)*usdPerMonth/(V*p_c) — this is a documented assumption, not a
 * measured fact: real multi-seat pricing may include per-seat discounts this
 * model does not capture. With a cap under 'hard_cap', any volume above the
 * cap returns null: the tier cannot serve it, and this function never
 * extrapolates a served cost past that limit.
 */
export function cappedSubscriptionCostPerSolved(
  subscription: {
    usdPerMonth: number;
    passRate: number;
    tasksPerMonthCap?: number | null;
    scaling?: SubscriptionScaling;
  },
  tasksPerMonth: number,
): number | null {
  const { usdPerMonth: S, passRate: pc, tasksPerMonthCap: cap = null, scaling = 'multi_seat' } = subscription;
  const validRate = (v: number) => Number.isFinite(v) && v > 0 && v <= 1;
  const validCost = (v: number) => Number.isFinite(v) && v >= 0;
  if (!validCost(S) || !validRate(pc) || !Number.isFinite(tasksPerMonth) || tasksPerMonth <= 0) return null;

  if (cap === null || cap === undefined) return S / (tasksPerMonth * pc);
  if (!Number.isFinite(cap) || cap <= 0) return null;

  if (scaling === 'hard_cap') {
    if (tasksPerMonth > cap) return null;
    return S / (tasksPerMonth * pc);
  }

  const seats = Math.ceil(tasksPerMonth / cap);
  return (seats * S) / (tasksPerMonth * pc);
}

/**
 * Local cost per solved task at monthly volume V is (A/V + e)/p_l: hardware
 * amortization A dilutes with volume, electricity e is a true per-task
 * marginal cost that never dilutes. Subscription cost per solved task is
 * S/(V*p_c): the flat monthly fee dilutes fully with volume. So whenever
 * e > 0, local has a nonzero floor (e/p_l) while subscription falls toward
 * zero — subscription always wins at high enough volume. The only question
 * is whether a low-volume regime exists where local is still cheaper, i.e.
 * whether amortization A starts out below the tie threshold S*p_l/p_c.
 * Solving (A + eV)/p_l = S/p_c for V gives the crossover volume below.
 *
 * This closed form assumes an uncapped flat fee. The subscription parameter
 * accepts the same optional tasksPerMonthCap/scaling fields as
 * cappedSubscriptionCostPerSolved for type convenience (a caller may reuse
 * one subscription object across both this function and breakEvenScan), but
 * this function ignores them: a cap turns subscription cost/solved into a
 * sawtooth with its own nonzero floor, which has no single closed-form
 * crossover. Use breakEvenScan for cap-aware analysis.
 */
export function subscriptionBreakEven(
  rig: { amortizationPerMonthUsd: number; electricityPerAttemptUsd: number; passRate: number },
  subscription: {
    usdPerMonth: number;
    passRate: number;
    tasksPerMonthCap?: number | null;
    scaling?: SubscriptionScaling;
  },
):
  | { kind: 'crossover'; tasksPerMonth: number }
  | { kind: 'local_always_cheaper' }
  | { kind: 'subscription_always_cheaper' }
  | { kind: 'equal' }
  | { kind: 'undefined' } {
  const { amortizationPerMonthUsd: A, electricityPerAttemptUsd: e, passRate: pl } = rig;
  const { usdPerMonth: S, passRate: pc } = subscription;
  const validRate = (v: number) => Number.isFinite(v) && v > 0 && v <= 1;
  const validCost = (v: number) => Number.isFinite(v) && v >= 0;
  if (!validCost(A) || !validCost(e) || !validCost(S) || !validRate(pl) || !validRate(pc)) {
    return { kind: 'undefined' };
  }

  const threshold = (S * pl) / pc; // amortization level at which the two tie when e === 0

  if (e === 0) {
    if (A < threshold) return { kind: 'local_always_cheaper' };
    if (A > threshold) return { kind: 'subscription_always_cheaper' };
    return { kind: 'equal' };
  }

  // A nonzero electricity floor means local cost/solved never reaches zero, so
  // once amortization alone is not cheap enough to beat the tie threshold,
  // subscription wins at every volume — there is no positive crossover.
  if (A >= threshold) return { kind: 'subscription_always_cheaper' };

  return { kind: 'crossover', tasksPerMonth: (threshold - A) / e };
}

/**
 * A capped subscription's cost/solved is a sawtooth (cappedSubscriptionCostPerSolved,
 * 'multi_seat'), so there is no single closed-form crossover the way there is
 * in subscriptionBreakEven. This numerically scans log-spaced monthly volumes
 * from 1 to maxTasksPerMonth (default 1e6, default 400 steps) and compares
 * local cost/solved (A/V + e)/p_l against the capped subscription cost/solved
 * at each point, reporting the first volume where local becomes cheaper.
 * 'crossover' means local wins from that point on for the rest of the
 * scanned range (single-crossing); 'mixed' means the sawtooth's seat jumps
 * cause the relation to flip more than once, and firstLocalWin is only the
 * first such volume, not a guarantee that local stays cheaper above it.
 * A hard_cap subscription is excluded from the comparison at any volume it
 * cannot serve (null), rather than treated as infinitely expensive there.
 */
export function breakEvenScan(
  rig: { amortizationPerMonthUsd: number; electricityPerAttemptUsd: number; passRate: number },
  subscription: {
    usdPerMonth: number;
    passRate: number;
    tasksPerMonthCap?: number | null;
    scaling?: SubscriptionScaling;
  },
  opts?: { maxTasksPerMonth?: number; steps?: number },
):
  | { kind: 'crossover'; tasksPerMonth: number }
  | { kind: 'local_always_cheaper' }
  | { kind: 'subscription_always_cheaper' }
  | { kind: 'mixed'; firstLocalWin: number }
  | { kind: 'undefined' } {
  const { amortizationPerMonthUsd: A, electricityPerAttemptUsd: e, passRate: pl } = rig;
  const validRate = (v: number) => Number.isFinite(v) && v > 0 && v <= 1;
  const validCost = (v: number) => Number.isFinite(v) && v >= 0;
  if (!validCost(A) || !validCost(e) || !validRate(pl)) return { kind: 'undefined' };

  const maxTasksPerMonth = opts?.maxTasksPerMonth ?? 1_000_000;
  const steps = opts?.steps ?? 400;
  if (!Number.isFinite(maxTasksPerMonth) || maxTasksPerMonth <= 1 || !Number.isInteger(steps) || steps < 2) {
    return { kind: 'undefined' };
  }

  const logMin = Math.log(1);
  const logMax = Math.log(maxTasksPerMonth);
  const localCostPerSolved = (V: number) => (A / V + e) / pl;

  let sawLocalWin = false;
  let sawSubWin = false;
  let firstLocalWin: number | null = null;
  let flips = 0;
  let prevLocalCheaper: boolean | null = null;

  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const V = Math.exp(logMin + t * (logMax - logMin));
    const subCost = cappedSubscriptionCostPerSolved(subscription, V);
    if (subCost === null) continue; // subscription cannot serve this volume: excluded, never extrapolated
    const localCheaper = localCostPerSolved(V) < subCost;
    if (localCheaper) {
      sawLocalWin = true;
      if (firstLocalWin === null) firstLocalWin = V;
    } else {
      sawSubWin = true;
    }
    if (prevLocalCheaper !== null && localCheaper !== prevLocalCheaper) flips++;
    prevLocalCheaper = localCheaper;
  }

  if (!sawLocalWin && !sawSubWin) return { kind: 'undefined' };
  if (!sawLocalWin) return { kind: 'subscription_always_cheaper' };
  if (!sawSubWin) return { kind: 'local_always_cheaper' };
  if (flips <= 1) return { kind: 'crossover', tasksPerMonth: firstLocalWin! };
  return { kind: 'mixed', firstLocalWin: firstLocalWin! };
}
