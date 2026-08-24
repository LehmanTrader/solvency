import type { Model } from './engine.ts';
import { BUILD_PLAN_LIMITS } from './build-plan-limits.ts';

export type HarnessBasis = 'published' | 'solvency_template' | 'user_supplied';
export type UsageBasis = 'measured' | 'template_assumption' | 'user_supplied';
export type BuildInputOrigin = 'user_asserted' | 'solvency_template' | 'source_verified';

export interface RoleUsageV1 {
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  basis: UsageBasis;
  assertionOrigin?: BuildInputOrigin;
  sourceUrl?: string;
  lastVerified?: string;
}

export interface PriceOverrideV1 {
  inputPerMtok: number;
  cacheReadPerMtok?: number;
  cacheWritePerMtok?: number;
  outputPerMtok: number;
  basis: 'contract' | 'user_supplied';
  assertionOrigin?: BuildInputOrigin;
  sourceUrl?: string;
  lastVerified?: string;
}

export interface BuildRoleV1 {
  roleId: string;
  kind: 'orchestrator' | 'worker' | 'other';
  label: string;
  modelId: string;
  expectedInvocationsPerBuildAttempt: number;
  usagePerInvocation: RoleUsageV1;
  priceOverride?: PriceOverrideV1;
}

export interface BuildPlanV1 {
  schemaVersion: 1;
  name: string;
  workload: {
    buildsPerMonth: number;
    volumeBasis: 'attempted_builds' | 'successful_builds';
  };
  harness: {
    name: string;
    version: string | null;
    configBasis: HarnessBasis;
    assertionOrigin?: BuildInputOrigin;
    sourceUrl?: string;
    lastVerified?: string;
    fixedCostPerBuildAttemptUsd: number;
    fixedMonthlyCostUsd: number;
  };
  roles: BuildRoleV1[];
  endToEndSuccess?: {
    rate: number;
    basis: 'measured_by_user' | 'published_system_run' | 'user_assumption';
    assertionOrigin?: BuildInputOrigin;
    sourceUrl?: string;
    lastVerified?: string;
  };
}

export interface BuildRoleQuote {
  roleId: string;
  label: string;
  kind: BuildRoleV1['kind'];
  modelId: string;
  modelName: string;
  expectedInvocations: number;
  costPerInvocationUsd: number;
  costPerBuildAttemptUsd: number;
  priceBasis: 'catalog_list' | 'contract' | 'user_supplied';
  priceSourceUrl?: string;
  priceLastVerified?: string;
  usageBasis: UsageBasis;
  usageUncachedInputTokens: number;
  usageCacheReadTokens: number;
  usageCacheWriteTokens: number;
  usageOutputTokens: number;
  usageAssertionOrigin: BuildInputOrigin;
  usageSourceUrl?: string;
  usageLastVerified?: string;
  priceAssertionOrigin: BuildInputOrigin;
  appliedInputPerMtok: number;
  appliedCacheReadPerMtok: number;
  appliedCacheWritePerMtok: number;
  appliedOutputPerMtok: number;
}

export interface BuildQuoteV1 {
  schemaVersion: 1;
  engineVersion: 'build-cost-v1';
  quotedAt: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
  missing: string[];
  planName: string;
  workload: BuildPlanV1['workload'];
  endToEndSuccess: BuildPlanV1['endToEndSuccess'] | null;
  harnessAssertionOrigin: BuildInputOrigin;
  successAssertionOrigin: BuildInputOrigin | null;
  buildAttemptCostUsd: number | null;
  variableCostPerSuccessfulBuildUsd: number | null;
  attemptedBuildsPerMonth: number | null;
  successfulBuildsPerMonth: number | null;
  monthlyCostUsd: number | null;
  roles: BuildRoleQuote[];
  harness: BuildPlanV1['harness'];
}

const finiteNonnegative = (value: number) => Number.isFinite(value) && value >= 0;
const finitePositive = (value: number) => Number.isFinite(value) && value > 0;
const oneOf = <T extends string>(value: string, allowed: readonly T[]): value is T => allowed.includes(value as T);
const INPUT_ORIGINS = ['user_asserted', 'solvency_template', 'source_verified'] as const;

export function harnessAssertionOrigin(harness: BuildPlanV1['harness']): BuildInputOrigin {
  return harness.assertionOrigin ?? (harness.configBasis === 'solvency_template' ? 'solvency_template' : 'user_asserted');
}

export function usageAssertionOrigin(usage: RoleUsageV1): BuildInputOrigin {
  return usage.assertionOrigin ?? (usage.basis === 'template_assumption' ? 'solvency_template' : 'user_asserted');
}

export function priceOverrideAssertionOrigin(override: PriceOverrideV1): BuildInputOrigin {
  return override.assertionOrigin ?? 'user_asserted';
}

export function successAssertionOrigin(success: NonNullable<BuildPlanV1['endToEndSuccess']>): BuildInputOrigin {
  return success.assertionOrigin ?? 'user_asserted';
}

function validateAssertionOrigin(
  label: string,
  origin: BuildInputOrigin | undefined,
  sourceUrl: string | undefined,
  lastVerified: string | undefined,
  errors: string[],
): void {
  if (origin !== undefined && !oneOf(origin, INPUT_ORIGINS)) errors.push(`${label}: assertion origin is invalid.`);
  if (origin === 'source_verified' && (!sourceUrl?.trim() || !lastVerified?.trim())) {
    errors.push(`${label}: source-verified inputs require a source URL and verification date.`);
  }
}

export function quoteBuildPlan(
  plan: BuildPlanV1,
  catalog: Model[],
  quotedAt = new Date().toISOString(),
): BuildQuoteV1 {
  const errors: string[] = [];
  const warnings: string[] = [];
  const missing: string[] = [];
  const roleQuotes: BuildRoleQuote[] = [];

  if (plan.schemaVersion !== 1) errors.push('Unsupported build-plan schema version.');
  if (!plan.name.trim()) errors.push('Plan name is required.');
  if (!plan.harness.name.trim()) errors.push('Harness name is required. Enter any harness or your own custom name.');
  if (!oneOf(plan.harness.configBasis, ['published', 'solvency_template', 'user_supplied'])) errors.push('Harness configuration basis is invalid.');
  validateAssertionOrigin('Harness configuration', plan.harness.assertionOrigin, plan.harness.sourceUrl, plan.harness.lastVerified, errors);
  if (!finiteNonnegative(plan.harness.fixedCostPerBuildAttemptUsd)) errors.push('Harness cost per build attempt must be zero or greater.');
  if (!finiteNonnegative(plan.harness.fixedMonthlyCostUsd)) errors.push('Harness monthly fixed cost must be zero or greater.');
  if (!finitePositive(plan.workload.buildsPerMonth)) errors.push('Monthly build volume must be greater than zero.');
  if (!oneOf(plan.workload.volumeBasis, ['attempted_builds', 'successful_builds'])) errors.push('Monthly build volume basis is invalid.');
  if (!plan.roles.length) errors.push('At least one model role is required.');

  const ids = new Set<string>();
  for (const role of plan.roles) {
    const prefix = role.label.trim() || role.roleId || 'Role';
    if (!role.roleId.trim()) errors.push(`${prefix}: role ID is required.`);
    else if (ids.has(role.roleId)) errors.push(`${prefix}: role ID must be unique.`);
    ids.add(role.roleId);
    if (!role.label.trim()) errors.push(`${prefix}: label is required.`);
    if (!oneOf(role.kind, ['orchestrator', 'worker', 'other'])) errors.push(`${prefix}: role kind is invalid.`);
    if (!finitePositive(role.expectedInvocationsPerBuildAttempt)) errors.push(`${prefix}: expected calls per build must be greater than zero.`);

    const usage = role.usagePerInvocation;
    for (const [label, value] of [
      ['uncached input tokens', usage.uncachedInputTokens],
      ['cache-read tokens', usage.cacheReadTokens],
      ['cache-write tokens', usage.cacheWriteTokens],
      ['output tokens', usage.outputTokens],
    ] as const) if (!finiteNonnegative(value)) errors.push(`${prefix}: ${label} must be zero or greater.`);
    if (!oneOf(usage.basis, ['measured', 'template_assumption', 'user_supplied'])) errors.push(`${prefix}: usage basis is invalid.`);
    validateAssertionOrigin(`${prefix}: usage`, usage.assertionOrigin, usage.sourceUrl, usage.lastVerified, errors);

    const model = catalog.find((candidate) => candidate.model_id === role.modelId);
    if (!model) {
      errors.push(`${prefix}: model ${role.modelId || '(missing)'} is not in the verified price catalog.`);
      continue;
    }
    if (!finiteNonnegative(model.input_per_mtok)
      || !finiteNonnegative(model.output_per_mtok)
      || (model.cached_input_per_mtok !== null && !finiteNonnegative(model.cached_input_per_mtok))) {
      errors.push(`${prefix}: catalog prices are invalid.`);
      continue;
    }

    const override = role.priceOverride;
    if (override) {
      if (!oneOf(override.basis, ['contract', 'user_supplied'])) errors.push(`${prefix}: custom price basis is invalid.`);
      if (!finiteNonnegative(override.inputPerMtok)) errors.push(`${prefix}: custom input price must be zero or greater.`);
      if (!finiteNonnegative(override.outputPerMtok)) errors.push(`${prefix}: custom output price must be zero or greater.`);
      if (override.cacheReadPerMtok !== undefined && !finiteNonnegative(override.cacheReadPerMtok)) errors.push(`${prefix}: custom cache-read price must be zero or greater.`);
      if (override.cacheWritePerMtok !== undefined && !finiteNonnegative(override.cacheWritePerMtok)) errors.push(`${prefix}: custom cache-write price must be zero or greater.`);
      if (usage.cacheReadTokens > 0 && override.cacheReadPerMtok === undefined) errors.push(`${prefix}: custom pricing with cache reads requires an explicit custom cache-read price.`);
      validateAssertionOrigin(`${prefix}: custom pricing`, override.assertionOrigin, override.sourceUrl, override.lastVerified, errors);
    }

    if (usage.cacheWriteTokens > 0 && override?.cacheWritePerMtok === undefined) {
      errors.push(`${prefix}: cache-write tokens require an explicit cache-write price; the catalog does not carry one.`);
      continue;
    }

    const inputRate = override?.inputPerMtok ?? model.input_per_mtok;
    const outputRate = override?.outputPerMtok ?? model.output_per_mtok;
    const cacheReadRate = override ? (override.cacheReadPerMtok ?? 0) : (model.cached_input_per_mtok ?? inputRate);
    const cacheWriteRate = override ? (override.cacheWritePerMtok ?? 0) : 0;
    if (!override && usage.cacheReadTokens > 0 && model.cached_input_per_mtok === null) {
      warnings.push(`${prefix}: no catalog cache-read rate; cache reads are conservatively priced as uncached input.`);
    }

    const perInvocation = (
      usage.uncachedInputTokens * inputRate
      + usage.cacheReadTokens * cacheReadRate
      + usage.cacheWriteTokens * cacheWriteRate
      + usage.outputTokens * outputRate
    ) / 1_000_000;
    const perBuild = perInvocation * role.expectedInvocationsPerBuildAttempt;
    if (!finiteNonnegative(perInvocation) || !finiteNonnegative(perBuild)
      || perInvocation > BUILD_PLAN_LIMITS.maxDerivedQuoteUsd
      || perBuild > BUILD_PLAN_LIMITS.maxDerivedQuoteUsd) {
      errors.push(`${prefix}: the derived role cost is outside the supported numeric range.`);
      continue;
    }
    roleQuotes.push({
      roleId: role.roleId,
      label: role.label,
      kind: role.kind,
      modelId: role.modelId,
      modelName: model.display_name,
      expectedInvocations: role.expectedInvocationsPerBuildAttempt,
      costPerInvocationUsd: perInvocation,
      costPerBuildAttemptUsd: perBuild,
      priceBasis: override?.basis ?? 'catalog_list',
      priceSourceUrl: override ? override.sourceUrl : model.source_url,
      priceLastVerified: override ? override.lastVerified : model.last_verified,
      usageBasis: usage.basis,
      usageUncachedInputTokens: usage.uncachedInputTokens,
      usageCacheReadTokens: usage.cacheReadTokens,
      usageCacheWriteTokens: usage.cacheWriteTokens,
      usageOutputTokens: usage.outputTokens,
      usageAssertionOrigin: usageAssertionOrigin(usage),
      usageSourceUrl: usage.sourceUrl,
      usageLastVerified: usage.lastVerified,
      priceAssertionOrigin: override ? priceOverrideAssertionOrigin(override) : 'source_verified',
      appliedInputPerMtok: inputRate,
      appliedCacheReadPerMtok: cacheReadRate,
      appliedCacheWritePerMtok: cacheWriteRate,
      appliedOutputPerMtok: outputRate,
    });
  }

  const success = plan.endToEndSuccess?.rate;
  if (plan.endToEndSuccess && !oneOf(plan.endToEndSuccess.basis, ['measured_by_user', 'published_system_run', 'user_assumption'])) {
    errors.push('End-to-end success-rate basis is invalid.');
  }
  if (plan.endToEndSuccess) {
    validateAssertionOrigin(
      'End-to-end success rate',
      plan.endToEndSuccess.assertionOrigin,
      plan.endToEndSuccess.sourceUrl,
      plan.endToEndSuccess.lastVerified,
      errors,
    );
  }
  if (success !== undefined && (!Number.isFinite(success) || success <= 0 || success > 1)) {
    errors.push('End-to-end success rate must be greater than 0% and no more than 100%.');
  }

  if (errors.length) {
    return {
      schemaVersion: 1, engineVersion: 'build-cost-v1', quotedAt, valid: false,
      errors, warnings, missing, planName: plan.name, workload: { ...plan.workload },
      endToEndSuccess: plan.endToEndSuccess ? { ...plan.endToEndSuccess } : null,
      harnessAssertionOrigin: harnessAssertionOrigin(plan.harness),
      successAssertionOrigin: plan.endToEndSuccess ? successAssertionOrigin(plan.endToEndSuccess) : null,
      buildAttemptCostUsd: null,
      variableCostPerSuccessfulBuildUsd: null, attemptedBuildsPerMonth: null,
      successfulBuildsPerMonth: null, monthlyCostUsd: null, roles: roleQuotes,
      harness: { ...plan.harness },
    };
  }

  const buildAttemptCostUsd = roleQuotes.reduce((sum, role) => sum + role.costPerBuildAttemptUsd, 0)
    + plan.harness.fixedCostPerBuildAttemptUsd;
  const variableCostPerSuccessfulBuildUsd = success === undefined ? null : buildAttemptCostUsd / success;
  if (success === undefined) missing.push('endToEndSuccess.rate');

  let attemptedBuildsPerMonth: number | null;
  let successfulBuildsPerMonth: number | null;
  if (plan.workload.volumeBasis === 'attempted_builds') {
    attemptedBuildsPerMonth = plan.workload.buildsPerMonth;
    successfulBuildsPerMonth = success === undefined ? null : attemptedBuildsPerMonth * success;
  } else if (success === undefined) {
    attemptedBuildsPerMonth = null;
    successfulBuildsPerMonth = plan.workload.buildsPerMonth;
    missing.push('attemptedBuildsPerMonth');
  } else {
    successfulBuildsPerMonth = plan.workload.buildsPerMonth;
    attemptedBuildsPerMonth = successfulBuildsPerMonth / success;
  }
  const monthlyCostUsd = attemptedBuildsPerMonth === null
    ? null
    : buildAttemptCostUsd * attemptedBuildsPerMonth + plan.harness.fixedMonthlyCostUsd;

  for (const [label, value] of [
    ['build-attempt cost', buildAttemptCostUsd],
    ['cost per successful build', variableCostPerSuccessfulBuildUsd],
    ['monthly cost', monthlyCostUsd],
  ] as const) {
    if (value !== null && (!finiteNonnegative(value) || value > BUILD_PLAN_LIMITS.maxDerivedQuoteUsd)) {
      errors.push(`Derived ${label} is outside the supported numeric range.`);
    }
  }
  for (const [label, value] of [
    ['attempted monthly volume', attemptedBuildsPerMonth],
    ['successful monthly volume', successfulBuildsPerMonth],
  ] as const) {
    if (value !== null && (!finiteNonnegative(value) || value > BUILD_PLAN_LIMITS.maxDerivedBuildVolume)) {
      errors.push(`Derived ${label} is outside the supported numeric range.`);
    }
  }
  if (errors.length) {
    return {
      schemaVersion: 1, engineVersion: 'build-cost-v1', quotedAt, valid: false,
      errors, warnings, missing, planName: plan.name, workload: { ...plan.workload },
      endToEndSuccess: plan.endToEndSuccess ? { ...plan.endToEndSuccess } : null,
      harnessAssertionOrigin: harnessAssertionOrigin(plan.harness),
      successAssertionOrigin: plan.endToEndSuccess ? successAssertionOrigin(plan.endToEndSuccess) : null,
      buildAttemptCostUsd: null,
      variableCostPerSuccessfulBuildUsd: null, attemptedBuildsPerMonth: null,
      successfulBuildsPerMonth: null, monthlyCostUsd: null, roles: roleQuotes,
      harness: { ...plan.harness },
    };
  }

  return {
    schemaVersion: 1, engineVersion: 'build-cost-v1', quotedAt, valid: true,
    errors, warnings, missing, planName: plan.name, workload: { ...plan.workload },
    endToEndSuccess: plan.endToEndSuccess ? { ...plan.endToEndSuccess } : null,
    harnessAssertionOrigin: harnessAssertionOrigin(plan.harness),
    successAssertionOrigin: plan.endToEndSuccess ? successAssertionOrigin(plan.endToEndSuccess) : null,
    buildAttemptCostUsd, variableCostPerSuccessfulBuildUsd,
    attemptedBuildsPerMonth, successfulBuildsPerMonth, monthlyCostUsd,
    roles: roleQuotes, harness: { ...plan.harness },
  };
}
