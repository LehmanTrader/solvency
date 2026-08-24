import {
  harnessAssertionOrigin, priceOverrideAssertionOrigin, successAssertionOrigin, usageAssertionOrigin,
  type BuildInputOrigin, type BuildPlanV1, type BuildQuoteV1, type BuildRoleV1, type BuildRoleQuote,
} from './build-cost.ts';

export type BuildExportFormat = 'json' | 'csv' | 'png';

export const MAX_BUILD_EXPORT_ROLES = 24;
export const MAX_BUILD_EXPORT_STRING = 10_000;
export const MAX_BUILD_EXPORT_BYTES = 2_000_000;

export const BUILD_EXPORT_NOTICES = [
  'Harness, usage, success and pricing inputs carry machine-readable assertion origins. Catalog prices are source verified; non-catalog inputs remain user asserted unless explicitly marked source verified with evidence.',
  'Missing completed-build cost means no whole-system success rate was supplied. It is never inferred from individual model benchmarks.',
] as const;

export interface BuildExportV1 {
  exportSchemaVersion: 1;
  notices: typeof BUILD_EXPORT_NOTICES;
  plan: BuildPlanV1;
  quote: BuildQuoteV1;
}

export interface BuildExportSummaryV1 {
  exportSchemaVersion: 1;
  planName: string;
  harness: string;
  quotedAt: string;
  engineVersion: BuildQuoteV1['engineVersion'];
  harnessAssertionOrigin: BuildInputOrigin;
  successAssertionOrigin: BuildInputOrigin | null;
  metrics: Array<{ label: string; value: string }>;
  roles: Array<{
    label: string;
    modelName: string;
    expectedInvocations: number;
    costPerBuildAttempt: string;
    priceBasis: string;
    usageBasis: string;
    usageAssertionOrigin: BuildInputOrigin;
    priceAssertionOrigin: BuildInputOrigin;
    appliedInputPerMtok: number;
    appliedCacheReadPerMtok: number;
    appliedCacheWritePerMtok: number;
    appliedOutputPerMtok: number;
    priceLastVerified: string | null;
  }>;
  notices: typeof BUILD_EXPORT_NOTICES;
}

type CsvValue = string | number | null | undefined;

const CSV_COLUMNS = [
  'export_schema_version', 'export_notice', 'plan_schema_version', 'quote_schema_version', 'engine_version', 'quoted_at',
  'plan_name', 'harness_name', 'harness_version', 'harness_config_basis', 'harness_assertion_origin', 'harness_source_url',
  'harness_last_verified', 'harness_cost_per_attempt_usd', 'harness_fixed_monthly_cost_usd',
  'builds_per_month', 'volume_basis', 'system_success_rate', 'system_success_basis', 'system_success_assertion_origin',
  'system_success_source_url', 'system_success_last_verified', 'build_attempt_cost_usd',
  'cost_per_successful_build_usd', 'attempted_builds_per_month', 'successful_builds_per_month',
  'monthly_cost_usd', 'quote_warnings', 'quote_missing', 'role_id', 'role_kind', 'role_label',
  'model_id', 'model_name', 'expected_invocations', 'uncached_input_tokens', 'cache_read_tokens',
  'cache_write_tokens', 'output_tokens', 'usage_basis', 'usage_assertion_origin', 'usage_source_url', 'usage_last_verified',
  'price_basis', 'price_assertion_origin', 'price_source_url', 'price_last_verified', 'applied_input_per_mtok',
  'applied_cache_read_per_mtok', 'applied_cache_write_per_mtok', 'applied_output_per_mtok', 'override_input_per_mtok',
  'override_cache_read_per_mtok', 'override_cache_write_per_mtok', 'override_output_per_mtok',
  'cost_per_invocation_usd', 'role_cost_per_build_attempt_usd',
] as const;

function assertExportable(plan: BuildPlanV1, quote: BuildQuoteV1): void {
  if (!quote.valid) throw new Error('Cannot export an invalid build quote.');
  canonicalize({ plan, quote });
  if (plan.schemaVersion !== 1 || quote.schemaVersion !== 1) throw new Error('Unsupported build export schema version.');
  if (quote.engineVersion !== 'build-cost-v1' || quote.errors.length) throw new Error('Build quote integrity metadata is invalid.');
  if (quote.buildAttemptCostUsd === null) throw new Error('A valid build quote must include build-attempt cost.');
  if (plan.roles.length !== quote.roles.length) throw new Error('Build plan and quote roles do not match.');
  if (plan.roles.length > MAX_BUILD_EXPORT_ROLES) throw new Error(`Build exports support up to ${MAX_BUILD_EXPORT_ROLES} roles.`);

  const mismatch = (subject: string): never => {
    throw new Error(`Build plan and quote ${subject} do not match; generate a fresh quote before exporting.`);
  };
  const same = (left: unknown, right: unknown) => left === right;
  const workload = quote.workload;
  if (quote.planName !== plan.name
    || !workload
    || workload.buildsPerMonth !== plan.workload.buildsPerMonth
    || workload.volumeBasis !== plan.workload.volumeBasis) mismatch('workload');

  const harness = plan.harness;
  const quotedHarness = quote.harness;
  if (!quotedHarness
    || quotedHarness.name !== harness.name
    || quotedHarness.version !== harness.version
    || quotedHarness.configBasis !== harness.configBasis
    || !same(quotedHarness.assertionOrigin, harness.assertionOrigin)
    || !same(quotedHarness.sourceUrl, harness.sourceUrl)
    || !same(quotedHarness.lastVerified, harness.lastVerified)
    || quotedHarness.fixedCostPerBuildAttemptUsd !== harness.fixedCostPerBuildAttemptUsd
    || quotedHarness.fixedMonthlyCostUsd !== harness.fixedMonthlyCostUsd
    || quote.harnessAssertionOrigin !== harnessAssertionOrigin(harness)) mismatch('harness inputs');

  const success = plan.endToEndSuccess ?? null;
  const quotedSuccess = quote.endToEndSuccess ?? null;
  if ((success === null) !== (quotedSuccess === null)
    || (success !== null && quotedSuccess !== null && (
      quotedSuccess.rate !== success.rate
      || quotedSuccess.basis !== success.basis
      || !same(quotedSuccess.assertionOrigin, success.assertionOrigin)
      || !same(quotedSuccess.sourceUrl, success.sourceUrl)
      || !same(quotedSuccess.lastVerified, success.lastVerified)
    ))
    || quote.successAssertionOrigin !== (success ? successAssertionOrigin(success) : null)) mismatch('success inputs');

  const planRoleIds = new Set<string>();
  const quoteRoleIds = new Set<string>();
  let expectedBuildAttemptCostUsd = harness.fixedCostPerBuildAttemptUsd;
  for (let index = 0; index < plan.roles.length; index += 1) {
    const role = plan.roles[index];
    const quoted = quote.roles[index];
    if (!quoted) mismatch(`role ${role.roleId || '(missing)'}`);
    if (planRoleIds.has(role.roleId) || quoteRoleIds.has(quoted.roleId)) throw new Error('Build plan and quote role IDs must be unique.');
    planRoleIds.add(role.roleId);
    quoteRoleIds.add(quoted.roleId);
    if (quoted.roleId !== role.roleId
      || quoted.modelId !== role.modelId
      || quoted.kind !== role.kind
      || quoted.label !== role.label
      || quoted.expectedInvocations !== role.expectedInvocationsPerBuildAttempt) mismatch(`role ${role.roleId || '(missing)'}`);

    const usage = role.usagePerInvocation;
    if (quoted.usageBasis !== usage.basis
      || quoted.usageUncachedInputTokens !== usage.uncachedInputTokens
      || quoted.usageCacheReadTokens !== usage.cacheReadTokens
      || quoted.usageCacheWriteTokens !== usage.cacheWriteTokens
      || quoted.usageOutputTokens !== usage.outputTokens
      || quoted.usageAssertionOrigin !== usageAssertionOrigin(usage)
      || !same(quoted.usageSourceUrl, usage.sourceUrl)
      || !same(quoted.usageLastVerified, usage.lastVerified)) mismatch(`role ${role.roleId || '(missing)'} usage`);

    const rates = [
      quoted.appliedInputPerMtok,
      quoted.appliedCacheReadPerMtok,
      quoted.appliedCacheWritePerMtok,
      quoted.appliedOutputPerMtok,
    ];
    if (!rates.every((rate) => Number.isFinite(rate) && rate >= 0)) throw new Error('Build quote applied prices are invalid.');

    const override = role.priceOverride;
    if (override) {
      if (quoted.priceBasis !== override.basis
        || quoted.priceAssertionOrigin !== priceOverrideAssertionOrigin(override)
        || !same(quoted.priceSourceUrl, override.sourceUrl)
        || !same(quoted.priceLastVerified, override.lastVerified)
        || quoted.appliedInputPerMtok !== override.inputPerMtok
        || quoted.appliedCacheReadPerMtok !== (override.cacheReadPerMtok ?? 0)
        || quoted.appliedCacheWritePerMtok !== (override.cacheWritePerMtok ?? 0)
        || quoted.appliedOutputPerMtok !== override.outputPerMtok) mismatch(`role ${role.roleId || '(missing)'} pricing`);
    } else if (quoted.priceBasis !== 'catalog_list'
      || quoted.priceAssertionOrigin !== 'source_verified'
      || !quoted.priceSourceUrl?.trim()
      || !quoted.priceLastVerified?.trim()) mismatch(`role ${role.roleId || '(missing)'} catalog pricing`);

    const expectedPerInvocation = (
      usage.uncachedInputTokens * quoted.appliedInputPerMtok
      + usage.cacheReadTokens * quoted.appliedCacheReadPerMtok
      + usage.cacheWriteTokens * quoted.appliedCacheWritePerMtok
      + usage.outputTokens * quoted.appliedOutputPerMtok
    ) / 1_000_000;
    const expectedPerBuild = expectedPerInvocation * role.expectedInvocationsPerBuildAttempt;
    if (!Number.isFinite(expectedPerInvocation)
      || !Number.isFinite(expectedPerBuild)
      || quoted.costPerInvocationUsd !== expectedPerInvocation
      || quoted.costPerBuildAttemptUsd !== expectedPerBuild) mismatch(`role ${role.roleId || '(missing)'} costs`);
    expectedBuildAttemptCostUsd += expectedPerBuild;
  }

  const successRate = success?.rate;
  const expectedVariableCost = successRate === undefined ? null : expectedBuildAttemptCostUsd / successRate;
  let expectedAttempted: number | null;
  let expectedSuccessful: number | null;
  if (plan.workload.volumeBasis === 'attempted_builds') {
    expectedAttempted = plan.workload.buildsPerMonth;
    expectedSuccessful = successRate === undefined ? null : expectedAttempted * successRate;
  } else if (successRate === undefined) {
    expectedAttempted = null;
    expectedSuccessful = plan.workload.buildsPerMonth;
  } else {
    expectedSuccessful = plan.workload.buildsPerMonth;
    expectedAttempted = expectedSuccessful / successRate;
  }
  const expectedMonthly = expectedAttempted === null
    ? null
    : expectedBuildAttemptCostUsd * expectedAttempted + harness.fixedMonthlyCostUsd;
  if (quote.buildAttemptCostUsd !== expectedBuildAttemptCostUsd
    || quote.variableCostPerSuccessfulBuildUsd !== expectedVariableCost
    || quote.attemptedBuildsPerMonth !== expectedAttempted
    || quote.successfulBuildsPerMonth !== expectedSuccessful
    || quote.monthlyCostUsd !== expectedMonthly) mismatch('derived totals');

  const expectedMissing = successRate === undefined
    ? ['endToEndSuccess.rate', ...(plan.workload.volumeBasis === 'successful_builds' ? ['attemptedBuildsPerMonth'] : [])]
    : [];
  if (quote.missing.length !== expectedMissing.length
    || quote.missing.some((value, index) => value !== expectedMissing[index])) mismatch('missing-value ledger');
}

/** Sorts every object key so equivalent inputs serialize byte-for-byte identically. */
function canonicalize(value: unknown): unknown {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Build exports cannot contain non-finite numbers.');
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_BUILD_EXPORT_STRING) throw new Error('Build export text exceeds the supported length.');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/** A versioned, canonical JSON document with the complete plan and quote ledgers. */
export function buildExportJson(plan: BuildPlanV1, quote: BuildQuoteV1): string {
  assertExportable(plan, quote);
  const payload: BuildExportV1 = { exportSchemaVersion: 1, notices: BUILD_EXPORT_NOTICES, plan, quote };
  const text = `${JSON.stringify(canonicalize(payload), null, 2)}\n`;
  if (new TextEncoder().encode(text).byteLength > MAX_BUILD_EXPORT_BYTES) throw new Error('Build export exceeds the supported file size.');
  return text;
}

function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'string' ? spreadsheetSafeText(value) : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

/** Keeps user-entered text inert when a CSV is opened by spreadsheet software. */
export function spreadsheetSafeText(value: string): string {
  const text = value.replaceAll('\0', '\uFFFD');
  return /^[\t\r\n ]*[=+\-@]/.test(text) ? `'${text}` : text;
}

function csvRow(role: BuildRoleV1, quoted: BuildRoleQuote, plan: BuildPlanV1, quote: BuildQuoteV1): CsvValue[] {
  const usage = role.usagePerInvocation;
  const override = role.priceOverride;
  const success = plan.endToEndSuccess;
  const values: Record<(typeof CSV_COLUMNS)[number], CsvValue> = {
    export_schema_version: 1,
    export_notice: BUILD_EXPORT_NOTICES.join(' | '),
    plan_schema_version: plan.schemaVersion,
    quote_schema_version: quote.schemaVersion,
    engine_version: quote.engineVersion,
    quoted_at: quote.quotedAt,
    plan_name: plan.name,
    harness_name: plan.harness.name,
    harness_version: plan.harness.version,
    harness_config_basis: plan.harness.configBasis,
    harness_assertion_origin: quote.harnessAssertionOrigin,
    harness_source_url: plan.harness.sourceUrl,
    harness_last_verified: plan.harness.lastVerified,
    harness_cost_per_attempt_usd: plan.harness.fixedCostPerBuildAttemptUsd,
    harness_fixed_monthly_cost_usd: plan.harness.fixedMonthlyCostUsd,
    builds_per_month: plan.workload.buildsPerMonth,
    volume_basis: plan.workload.volumeBasis,
    system_success_rate: success?.rate,
    system_success_basis: success?.basis,
    system_success_assertion_origin: quote.successAssertionOrigin,
    system_success_source_url: success?.sourceUrl,
    system_success_last_verified: success?.lastVerified,
    build_attempt_cost_usd: quote.buildAttemptCostUsd,
    cost_per_successful_build_usd: quote.variableCostPerSuccessfulBuildUsd ?? 'Missing — success rate not supplied',
    attempted_builds_per_month: quote.attemptedBuildsPerMonth ?? 'Missing — success rate required for successful-build volume',
    successful_builds_per_month: quote.successfulBuildsPerMonth ?? 'Missing — success rate not supplied',
    monthly_cost_usd: quote.monthlyCostUsd ?? 'Missing — success rate required for successful-build volume',
    quote_warnings: quote.warnings.join(' | '),
    quote_missing: quote.missing.join(' | '),
    role_id: role.roleId,
    role_kind: role.kind,
    role_label: role.label,
    model_id: role.modelId,
    model_name: quoted.modelName,
    expected_invocations: role.expectedInvocationsPerBuildAttempt,
    uncached_input_tokens: usage.uncachedInputTokens,
    cache_read_tokens: usage.cacheReadTokens,
    cache_write_tokens: usage.cacheWriteTokens,
    output_tokens: usage.outputTokens,
    usage_basis: usage.basis,
    usage_assertion_origin: quoted.usageAssertionOrigin,
    usage_source_url: usage.sourceUrl,
    usage_last_verified: usage.lastVerified,
    price_basis: quoted.priceBasis,
    price_assertion_origin: quoted.priceAssertionOrigin,
    price_source_url: quoted.priceSourceUrl,
    price_last_verified: quoted.priceLastVerified,
    applied_input_per_mtok: quoted.appliedInputPerMtok,
    applied_cache_read_per_mtok: quoted.appliedCacheReadPerMtok,
    applied_cache_write_per_mtok: quoted.appliedCacheWritePerMtok,
    applied_output_per_mtok: quoted.appliedOutputPerMtok,
    override_input_per_mtok: override?.inputPerMtok,
    override_cache_read_per_mtok: override?.cacheReadPerMtok,
    override_cache_write_per_mtok: override?.cacheWritePerMtok,
    override_output_per_mtok: override?.outputPerMtok,
    cost_per_invocation_usd: quoted.costPerInvocationUsd,
    role_cost_per_build_attempt_usd: quoted.costPerBuildAttemptUsd,
  };
  return CSV_COLUMNS.map((column) => values[column]);
}

/** One deterministic CSV row per role, with plan-level values repeated for portable analysis. */
export function buildExportCsv(plan: BuildPlanV1, quote: BuildQuoteV1): string {
  assertExportable(plan, quote);
  canonicalize({ plan, quote }); // Reject non-finite values before CSV stringification.
  const quotedById = new Map(quote.roles.map((role) => [role.roleId, role]));
  const rows = plan.roles.map((role) => csvRow(role, quotedById.get(role.roleId)!, plan, quote));
  const text = [CSV_COLUMNS, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  if (new TextEncoder().encode(text).byteLength > MAX_BUILD_EXPORT_BYTES) throw new Error('Build export exceeds the supported file size.');
  return text;
}

const usd = (value: number | null, missing: string) => value === null
  ? missing
  : `$${value.toLocaleString('en-US', { minimumFractionDigits: value < 1 ? 3 : 2, maximumFractionDigits: value < 1 ? 4 : 2 })}`;

/** Safe, bounded text model for the browser's canvas-only PNG renderer. */
export function buildExportSummary(plan: BuildPlanV1, quote: BuildQuoteV1): BuildExportSummaryV1 {
  assertExportable(plan, quote);
  canonicalize({ plan, quote });
  return {
    exportSchemaVersion: 1,
    planName: plan.name,
    harness: `${plan.harness.name}${plan.harness.version ? ` ${plan.harness.version}` : ''}`,
    quotedAt: quote.quotedAt,
    engineVersion: quote.engineVersion,
    harnessAssertionOrigin: quote.harnessAssertionOrigin,
    successAssertionOrigin: quote.successAssertionOrigin,
    metrics: [
      { label: 'Per build attempt', value: usd(quote.buildAttemptCostUsd, 'Missing') },
      { label: 'Per completed build', value: usd(quote.variableCostPerSuccessfulBuildUsd, 'Missing — success rate not supplied') },
      { label: 'Monthly spend', value: usd(quote.monthlyCostUsd, 'Missing — success rate required') },
      { label: 'Attempted builds / month', value: quote.attemptedBuildsPerMonth === null ? 'Missing — success rate required' : quote.attemptedBuildsPerMonth.toLocaleString('en-US', { maximumFractionDigits: 1 }) },
    ],
    roles: quote.roles.map((role) => ({
      label: role.label,
      modelName: role.modelName,
      expectedInvocations: role.expectedInvocations,
      costPerBuildAttempt: usd(role.costPerBuildAttemptUsd, 'Missing'),
      priceBasis: role.priceBasis,
      usageBasis: role.usageBasis,
      usageAssertionOrigin: role.usageAssertionOrigin,
      priceAssertionOrigin: role.priceAssertionOrigin,
      appliedInputPerMtok: role.appliedInputPerMtok,
      appliedCacheReadPerMtok: role.appliedCacheReadPerMtok,
      appliedCacheWritePerMtok: role.appliedCacheWritePerMtok,
      appliedOutputPerMtok: role.appliedOutputPerMtok,
      priceLastVerified: role.priceLastVerified ?? null,
    })),
    notices: BUILD_EXPORT_NOTICES,
  };
}

/** ASCII-only download name with no path characters and a bounded user-controlled stem. */
export function buildExportFilename(planName: string, format: BuildExportFormat): string {
  if (format !== 'json' && format !== 'csv' && format !== 'png') throw new Error('Unsupported build export format.');
  const stem = planName.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '') || 'build-plan';
  return `${stem}-quote.${format}`;
}
