import {
  quoteBuildPlan,
  type BuildQuoteV1,
  type BuildInputOrigin, type BuildPlanV1, type BuildRoleV1, type PriceOverrideV1, type RoleUsageV1,
} from './build-cost.ts';
import { BUILD_PLAN_LIMITS } from './build-plan-limits.ts';
import type { Model } from './engine.ts';

export { BUILD_PLAN_LIMITS } from './build-plan-limits.ts';

export type BuildPlanIssueCode =
  | 'REQUIRED'
  | 'TYPE'
  | 'UNKNOWN_FIELD'
  | 'UNSUPPORTED_VERSION'
  | 'UNSUPPORTED_VALUE'
  | 'INVALID_FORMAT'
  | 'OUT_OF_RANGE'
  | 'TOO_MANY_ITEMS'
  | 'DUPLICATE'
  | 'FORBIDDEN_ORIGIN'
  | 'DEPENDENCY_MISMATCH'
  | 'BODY_TOO_LARGE'
  | 'TOO_DEEP'
  | 'INVALID_UTF8'
  | 'INVALID_JSON'
  | 'MODEL_UNAVAILABLE'
  | 'PRICE_INCOMPLETE'
  | 'QUOTE_OUT_OF_RANGE'
  | 'SEMANTIC_INVALID';

export interface BuildPlanIssue {
  path: string;
  code: BuildPlanIssueCode;
  message: string;
  roleId?: string;
}

export type BuildPlanFailure = { ok: false; issues: BuildPlanIssue[]; truncated: boolean };

export type BuildPlanParseResult =
  | { ok: true; value: BuildPlanV1 }
  | BuildPlanFailure;

export type BuildPlanValidationResult =
  | { ok: true; value: BuildPlanV1; quote: BuildQuoteV1 }
  | BuildPlanFailure;

type PlainRecord = Record<string, unknown>;

const encoder = new TextEncoder();
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const UNSAFE_DISPLAY_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const ASSERTION_ORIGINS = ['user_asserted', 'solvency_template', 'source_verified'] as const;
const HARNESS_BASES = ['published', 'solvency_template', 'user_supplied'] as const;
const ROLE_KINDS = ['orchestrator', 'worker', 'other'] as const;
const USAGE_BASES = ['measured', 'template_assumption', 'user_supplied'] as const;
const PRICE_BASES = ['contract', 'user_supplied'] as const;
const SUCCESS_BASES = ['measured_by_user', 'published_system_run', 'user_assumption'] as const;
const VOLUME_BASES = ['attempted_builds', 'successful_builds'] as const;

class Issues {
  readonly values: BuildPlanIssue[] = [];
  truncated = false;
  totalTextBytes = 0;

  add(path: string, code: BuildPlanIssueCode, message: string, roleId?: string): void {
    if (this.values.length >= BUILD_PLAN_LIMITS.maxIssues) {
      this.truncated = true;
      return;
    }
    this.values.push(roleId ? { path, code, message, roleId } : { path, code, message });
  }

  addText(bytes: number, path: string): void {
    this.totalTextBytes += bytes;
    if (this.totalTextBytes > BUILD_PLAN_LIMITS.maxTotalTextBytes) {
      this.add(path, 'OUT_OF_RANGE', `Total plan text exceeds the ${BUILD_PLAN_LIMITS.maxTotalTextBytes}-byte limit.`);
    }
  }
}

function failure(issues: Issues): BuildPlanFailure {
  return { ok: false, issues: issues.values, truncated: issues.truncated };
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function record(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
  issues: Issues,
): PlainRecord | undefined {
  if (!isPlainRecord(value)) {
    issues.add(path, 'TYPE', 'Expected a plain object.');
    return undefined;
  }
  const allowed = new Set(allowedKeys);
  let examined = 0;
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    examined += 1;
    if (examined > allowedKeys.length + BUILD_PLAN_LIMITS.maxIssues) {
      issues.truncated = true;
      break;
    }
    const fieldPath = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) ? `${path}.${key}` : `${path}.[unknown]`;
    if (!allowed.has(key)) issues.add(fieldPath, 'UNKNOWN_FIELD', 'Unknown fields are not accepted.');
  }
  for (const _symbol of Object.getOwnPropertySymbols(value)) {
    issues.add(path, 'UNKNOWN_FIELD', 'Symbol-keyed fields are not accepted.');
  }
  return value;
}

const owns = (value: PlainRecord, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function requiredValue(value: PlainRecord, key: string, path: string, issues: Issues): unknown {
  if (!owns(value, key)) {
    issues.add(path, 'REQUIRED', 'Field is required.');
    return undefined;
  }
  return value[key];
}

interface TextOptions {
  required?: boolean;
  nullable?: boolean;
  trim?: boolean;
  maxChars: number;
  maxBytes: number;
  safeId?: boolean;
}

function textField(
  value: PlainRecord,
  key: string,
  path: string,
  issues: Issues,
  options: TextOptions,
): string | null | undefined {
  if (!owns(value, key)) {
    if (options.required !== false) issues.add(path, 'REQUIRED', 'Field is required.');
    return undefined;
  }
  const raw = value[key];
  if (raw === null && options.nullable) return null;
  if (typeof raw !== 'string') {
    issues.add(path, 'TYPE', options.nullable ? 'Expected a string or null.' : 'Expected a string.');
    return undefined;
  }
  if (raw.length > options.maxBytes || raw.length > BUILD_PLAN_LIMITS.maxTotalTextBytes) {
    issues.add(path, 'OUT_OF_RANGE', `Text exceeds the ${options.maxBytes}-byte limit.`);
    return undefined;
  }
  const normalized = raw.normalize('NFC');
  const parsed = options.trim === false ? normalized : normalized.trim();
  const bytes = encoder.encode(parsed).byteLength;
  issues.addText(bytes, path);
  if (!parsed) issues.add(path, 'REQUIRED', 'Value must not be empty.');
  if ([...parsed].length > options.maxChars) {
    issues.add(path, 'OUT_OF_RANGE', `Text exceeds the ${options.maxChars}-character limit.`);
  }
  if (bytes > options.maxBytes) issues.add(path, 'OUT_OF_RANGE', `Text exceeds the ${options.maxBytes}-byte limit.`);
  if (UNSAFE_DISPLAY_TEXT.test(parsed)) {
    issues.add(path, 'INVALID_FORMAT', 'Control and bidirectional formatting characters are not accepted.');
  }
  if (options.safeId && !SAFE_ID.test(parsed)) {
    issues.add(path, 'INVALID_FORMAT', 'Value must be a safe ASCII identifier.');
  }
  return parsed;
}

interface NumberOptions {
  required?: boolean;
  minimum: number;
  maximum: number;
  exclusiveMinimum?: boolean;
}

function numberField(
  value: PlainRecord,
  key: string,
  path: string,
  issues: Issues,
  options: NumberOptions,
): number | undefined {
  if (!owns(value, key)) {
    if (options.required !== false) issues.add(path, 'REQUIRED', 'Field is required.');
    return undefined;
  }
  const raw = value[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    issues.add(path, 'TYPE', 'Expected a finite number; numeric strings are not accepted.');
    return undefined;
  }
  if (Object.is(raw, -0)) {
    issues.add(path, 'INVALID_FORMAT', 'Negative zero is not accepted.');
    return undefined;
  }
  const below = options.exclusiveMinimum ? raw <= options.minimum : raw < options.minimum;
  if (below || raw > options.maximum) {
    const lower = options.exclusiveMinimum ? `greater than ${options.minimum}` : `at least ${options.minimum}`;
    issues.add(path, 'OUT_OF_RANGE', `Value must be ${lower} and at most ${options.maximum}.`);
  }
  return raw;
}

function enumField<const T extends readonly string[]>(
  value: PlainRecord,
  key: string,
  path: string,
  issues: Issues,
  allowed: T,
  required = true,
): T[number] | undefined {
  if (!owns(value, key)) {
    if (required) issues.add(path, 'REQUIRED', 'Field is required.');
    return undefined;
  }
  const raw = value[key];
  if (typeof raw !== 'string') {
    issues.add(path, 'TYPE', 'Expected a string enum value.');
    return undefined;
  }
  if (!(allowed as readonly string[]).includes(raw)) {
    issues.add(path, 'UNSUPPORTED_VALUE', `Expected one of: ${allowed.join(', ')}.`);
    return undefined;
  }
  return raw as T[number];
}

function assertionOriginField(
  value: PlainRecord,
  path: string,
  issues: Issues,
): BuildInputOrigin | undefined {
  if (!owns(value, 'assertionOrigin')) return 'user_asserted';
  const origin = enumField(value, 'assertionOrigin', `${path}.assertionOrigin`, issues, ASSERTION_ORIGINS, false);
  if (origin === 'source_verified' || origin === 'solvency_template') {
    issues.add(
      `${path}.assertionOrigin`,
      'FORBIDDEN_ORIGIN',
      `Untrusted input cannot set ${origin}; trusted provenance is minted only by a server-controlled ingestion or template workflow.`,
    );
    return undefined;
  }
  return origin;
}

function validCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

interface Evidence {
  assertionOrigin?: BuildInputOrigin;
  sourceUrl?: string;
  lastVerified?: string;
}

function evidenceFields(value: PlainRecord, path: string, issues: Issues): Evidence {
  const assertionOrigin = assertionOriginField(value, path, issues);
  const sourceUrl = textField(value, 'sourceUrl', `${path}.sourceUrl`, issues, {
    required: false, trim: false, maxChars: BUILD_PLAN_LIMITS.maxSourceUrlBytes,
    maxBytes: BUILD_PLAN_LIMITS.maxSourceUrlBytes,
  }) ?? undefined;
  const lastVerified = textField(value, 'lastVerified', `${path}.lastVerified`, issues, {
    required: false, trim: false, maxChars: 10, maxBytes: 10,
  }) ?? undefined;

  if (sourceUrl !== undefined) {
    try {
      const parsed = new URL(sourceUrl);
      if (parsed.protocol !== 'https:') throw new Error('protocol');
      if (parsed.username || parsed.password) throw new Error('credentials');
    } catch {
      issues.add(`${path}.sourceUrl`, 'INVALID_FORMAT', 'Evidence URL must be an absolute HTTPS URL without embedded credentials.');
    }
  }
  if (lastVerified !== undefined && !validCalendarDate(lastVerified)) {
    issues.add(`${path}.lastVerified`, 'INVALID_FORMAT', 'Verification date must be a real YYYY-MM-DD calendar date.');
  }
  if ((sourceUrl === undefined) !== (lastVerified === undefined)) {
    issues.add(path, 'DEPENDENCY_MISMATCH', 'Evidence URL and verification date must be supplied together.');
  }
  return {
    ...(assertionOrigin === undefined ? {} : { assertionOrigin }),
    ...(sourceUrl === undefined ? {} : { sourceUrl }),
    ...(lastVerified === undefined ? {} : { lastVerified }),
  };
}

function parseUsage(value: unknown, path: string, issues: Issues): RoleUsageV1 | undefined {
  const input = record(value, path, [
    'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'basis',
    'assertionOrigin', 'sourceUrl', 'lastVerified',
  ], issues);
  if (!input) return undefined;
  const uncachedInputTokens = numberField(input, 'uncachedInputTokens', `${path}.uncachedInputTokens`, issues, {
    minimum: 0, maximum: BUILD_PLAN_LIMITS.maxTokensPerInvocation,
  });
  const cacheReadTokens = numberField(input, 'cacheReadTokens', `${path}.cacheReadTokens`, issues, {
    minimum: 0, maximum: BUILD_PLAN_LIMITS.maxTokensPerInvocation,
  });
  const cacheWriteTokens = numberField(input, 'cacheWriteTokens', `${path}.cacheWriteTokens`, issues, {
    minimum: 0, maximum: BUILD_PLAN_LIMITS.maxTokensPerInvocation,
  });
  const outputTokens = numberField(input, 'outputTokens', `${path}.outputTokens`, issues, {
    minimum: 0, maximum: BUILD_PLAN_LIMITS.maxTokensPerInvocation,
  });
  const basis = enumField(input, 'basis', `${path}.basis`, issues, USAGE_BASES);
  const evidence = evidenceFields(input, path, issues);
  if ([uncachedInputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, basis].includes(undefined)) return undefined;
  return {
    uncachedInputTokens: uncachedInputTokens!, cacheReadTokens: cacheReadTokens!,
    cacheWriteTokens: cacheWriteTokens!, outputTokens: outputTokens!, basis: basis!, ...evidence,
  };
}

function parsePriceOverride(value: unknown, path: string, issues: Issues): PriceOverrideV1 | undefined {
  const input = record(value, path, [
    'inputPerMtok', 'cacheReadPerMtok', 'cacheWritePerMtok', 'outputPerMtok', 'basis',
    'assertionOrigin', 'sourceUrl', 'lastVerified',
  ], issues);
  if (!input) return undefined;
  const inputPerMtok = numberField(input, 'inputPerMtok', `${path}.inputPerMtok`, issues, {
    minimum: 0, maximum: BUILD_PLAN_LIMITS.maxPricePerMtokUsd,
  });
  const cacheReadPerMtok = numberField(input, 'cacheReadPerMtok', `${path}.cacheReadPerMtok`, issues, {
    required: false, minimum: 0, maximum: BUILD_PLAN_LIMITS.maxPricePerMtokUsd,
  });
  const cacheWritePerMtok = numberField(input, 'cacheWritePerMtok', `${path}.cacheWritePerMtok`, issues, {
    required: false, minimum: 0, maximum: BUILD_PLAN_LIMITS.maxPricePerMtokUsd,
  });
  const outputPerMtok = numberField(input, 'outputPerMtok', `${path}.outputPerMtok`, issues, {
    minimum: 0, maximum: BUILD_PLAN_LIMITS.maxPricePerMtokUsd,
  });
  const basis = enumField(input, 'basis', `${path}.basis`, issues, PRICE_BASES);
  const evidence = evidenceFields(input, path, issues);
  if ([inputPerMtok, outputPerMtok, basis].includes(undefined)) return undefined;
  return {
    inputPerMtok: inputPerMtok!, outputPerMtok: outputPerMtok!, basis: basis!,
    ...(cacheReadPerMtok === undefined ? {} : { cacheReadPerMtok }),
    ...(cacheWritePerMtok === undefined ? {} : { cacheWritePerMtok }),
    ...evidence,
  };
}

function parseRole(value: unknown, index: number, issues: Issues): BuildRoleV1 | undefined {
  const path = `$.roles[${index}]`;
  const input = record(value, path, [
    'roleId', 'kind', 'label', 'modelId', 'expectedInvocationsPerBuildAttempt',
    'usagePerInvocation', 'priceOverride',
  ], issues);
  if (!input) return undefined;
  const roleId = textField(input, 'roleId', `${path}.roleId`, issues, {
    maxChars: BUILD_PLAN_LIMITS.maxRoleIdChars, maxBytes: BUILD_PLAN_LIMITS.maxRoleIdChars, safeId: true,
  });
  const kind = enumField(input, 'kind', `${path}.kind`, issues, ROLE_KINDS);
  const label = textField(input, 'label', `${path}.label`, issues, {
    maxChars: BUILD_PLAN_LIMITS.maxRoleLabelChars, maxBytes: BUILD_PLAN_LIMITS.maxRoleLabelBytes,
  });
  const modelId = textField(input, 'modelId', `${path}.modelId`, issues, {
    maxChars: BUILD_PLAN_LIMITS.maxModelIdChars, maxBytes: BUILD_PLAN_LIMITS.maxModelIdChars, safeId: true,
  });
  const expectedInvocationsPerBuildAttempt = numberField(
    input, 'expectedInvocationsPerBuildAttempt', `${path}.expectedInvocationsPerBuildAttempt`, issues,
    { minimum: 0, exclusiveMinimum: true, maximum: BUILD_PLAN_LIMITS.maxExpectedInvocations },
  );
  const usagePerInvocation = owns(input, 'usagePerInvocation')
    ? parseUsage(input.usagePerInvocation, `${path}.usagePerInvocation`, issues)
    : (issues.add(`${path}.usagePerInvocation`, 'REQUIRED', 'Field is required.'), undefined);
  const hasOverride = owns(input, 'priceOverride');
  const priceOverride = hasOverride
    ? parsePriceOverride(input.priceOverride, `${path}.priceOverride`, issues)
    : undefined;
  if ([roleId, kind, label, modelId, expectedInvocationsPerBuildAttempt, usagePerInvocation].includes(undefined)) return undefined;
  return {
    roleId: roleId!, kind: kind!, label: label!, modelId: modelId!,
    expectedInvocationsPerBuildAttempt: expectedInvocationsPerBuildAttempt!,
    usagePerInvocation: usagePerInvocation!,
    ...(hasOverride && priceOverride ? { priceOverride } : {}),
  };
}

function parseWorkload(value: unknown, issues: Issues): BuildPlanV1['workload'] | undefined {
  const path = '$.workload';
  const input = record(value, path, ['buildsPerMonth', 'volumeBasis'], issues);
  if (!input) return undefined;
  const buildsPerMonth = numberField(input, 'buildsPerMonth', `${path}.buildsPerMonth`, issues, {
    minimum: 0, exclusiveMinimum: true, maximum: BUILD_PLAN_LIMITS.maxBuildsPerMonth,
  });
  const volumeBasis = enumField(input, 'volumeBasis', `${path}.volumeBasis`, issues, VOLUME_BASES);
  if (buildsPerMonth === undefined || volumeBasis === undefined) return undefined;
  return { buildsPerMonth, volumeBasis };
}

function parseHarness(value: unknown, issues: Issues): BuildPlanV1['harness'] | undefined {
  const path = '$.harness';
  const input = record(value, path, [
    'name', 'version', 'configBasis', 'assertionOrigin', 'sourceUrl', 'lastVerified',
    'fixedCostPerBuildAttemptUsd', 'fixedMonthlyCostUsd',
  ], issues);
  if (!input) return undefined;
  const name = textField(input, 'name', `${path}.name`, issues, {
    maxChars: BUILD_PLAN_LIMITS.maxHarnessNameChars, maxBytes: BUILD_PLAN_LIMITS.maxHarnessNameBytes,
  });
  const version = textField(input, 'version', `${path}.version`, issues, {
    nullable: true, maxChars: BUILD_PLAN_LIMITS.maxHarnessVersionChars,
    maxBytes: BUILD_PLAN_LIMITS.maxHarnessVersionBytes,
  });
  const configBasis = enumField(input, 'configBasis', `${path}.configBasis`, issues, HARNESS_BASES);
  const fixedCostPerBuildAttemptUsd = numberField(
    input, 'fixedCostPerBuildAttemptUsd', `${path}.fixedCostPerBuildAttemptUsd`, issues,
    { minimum: 0, maximum: BUILD_PLAN_LIMITS.maxFixedCostUsd },
  );
  const fixedMonthlyCostUsd = numberField(input, 'fixedMonthlyCostUsd', `${path}.fixedMonthlyCostUsd`, issues, {
    minimum: 0, maximum: BUILD_PLAN_LIMITS.maxFixedCostUsd,
  });
  const evidence = evidenceFields(input, path, issues);
  if ([name, version, configBasis, fixedCostPerBuildAttemptUsd, fixedMonthlyCostUsd].includes(undefined)) return undefined;
  return {
    name: name!, version: version!, configBasis: configBasis!, ...evidence,
    fixedCostPerBuildAttemptUsd: fixedCostPerBuildAttemptUsd!, fixedMonthlyCostUsd: fixedMonthlyCostUsd!,
  };
}

function parseSuccess(value: unknown, issues: Issues): NonNullable<BuildPlanV1['endToEndSuccess']> | undefined {
  const path = '$.endToEndSuccess';
  const input = record(value, path, [
    'rate', 'basis', 'assertionOrigin', 'sourceUrl', 'lastVerified',
  ], issues);
  if (!input) return undefined;
  const rate = numberField(input, 'rate', `${path}.rate`, issues, {
    minimum: 0, exclusiveMinimum: true, maximum: 1,
  });
  const basis = enumField(input, 'basis', `${path}.basis`, issues, SUCCESS_BASES);
  const evidence = evidenceFields(input, path, issues);
  if (rate === undefined || basis === undefined) return undefined;
  return { rate, basis, ...evidence };
}

function parsePlan(input: unknown, issues: Issues): BuildPlanV1 | undefined {
  const root = record(input, '$', ['schemaVersion', 'name', 'workload', 'harness', 'roles', 'endToEndSuccess'], issues);
  if (!root) return undefined;

  const schemaVersion = requiredValue(root, 'schemaVersion', '$.schemaVersion', issues);
  if (schemaVersion !== undefined && typeof schemaVersion !== 'number') {
    issues.add('$.schemaVersion', 'TYPE', 'Schema version must be the number 1.');
  } else if (schemaVersion !== undefined && schemaVersion !== 1) {
    issues.add('$.schemaVersion', 'UNSUPPORTED_VERSION', 'Only BuildPlanV1 schemaVersion 1 is supported.');
  }
  const name = textField(root, 'name', '$.name', issues, {
    maxChars: BUILD_PLAN_LIMITS.maxPlanNameChars, maxBytes: BUILD_PLAN_LIMITS.maxPlanNameBytes,
  });
  const workload = owns(root, 'workload')
    ? parseWorkload(root.workload, issues)
    : (issues.add('$.workload', 'REQUIRED', 'Field is required.'), undefined);
  const harness = owns(root, 'harness')
    ? parseHarness(root.harness, issues)
    : (issues.add('$.harness', 'REQUIRED', 'Field is required.'), undefined);

  let roles: BuildRoleV1[] | undefined;
  if (!owns(root, 'roles')) {
    issues.add('$.roles', 'REQUIRED', 'Field is required.');
  } else if (!Array.isArray(root.roles)) {
    issues.add('$.roles', 'TYPE', 'Expected an array.');
  } else {
    roles = [];
    if (root.roles.length < 1) issues.add('$.roles', 'REQUIRED', 'At least one role is required.');
    if (root.roles.length > BUILD_PLAN_LIMITS.maxRoles) {
      issues.add('$.roles', 'TOO_MANY_ITEMS', `A plan may contain at most ${BUILD_PLAN_LIMITS.maxRoles} roles.`);
    }
    let examined = 0;
    for (const key in root.roles) {
      if (!Object.prototype.hasOwnProperty.call(root.roles, key)) continue;
      examined += 1;
      if (examined > BUILD_PLAN_LIMITS.maxRoles + BUILD_PLAN_LIMITS.maxIssues) {
        issues.truncated = true;
        break;
      }
      const canonicalIndex = /^(0|[1-9]\d*)$/.test(key) && String(Number(key)) === key;
      if (!canonicalIndex || Number(key) >= root.roles.length) {
        issues.add('$.roles.[unknown]', 'UNKNOWN_FIELD', 'Array properties are not accepted.');
      }
    }
    if (Object.getOwnPropertySymbols(root.roles).length) {
      issues.add('$.roles', 'UNKNOWN_FIELD', 'Symbol-keyed array properties are not accepted.');
    }
    const roleIds = new Set<string>();
    const count = Math.min(root.roles.length, BUILD_PLAN_LIMITS.maxRoles);
    for (let index = 0; index < count; index += 1) {
      if (!owns(root.roles as unknown as PlainRecord, String(index))) {
        issues.add(`$.roles[${index}]`, 'REQUIRED', 'Sparse role arrays are not accepted.');
        continue;
      }
      const parsed = parseRole(root.roles[index], index, issues);
      if (!parsed) continue;
      if (roleIds.has(parsed.roleId)) {
        issues.add(`$.roles[${index}].roleId`, 'DUPLICATE', 'Role ID must be unique.', parsed.roleId);
      }
      roleIds.add(parsed.roleId);
      roles.push(parsed);
    }
  }

  const hasSuccess = owns(root, 'endToEndSuccess');
  const endToEndSuccess = hasSuccess ? parseSuccess(root.endToEndSuccess, issues) : undefined;

  if (schemaVersion !== 1 || name === undefined || !workload || !harness || !roles || (hasSuccess && !endToEndSuccess)) {
    return undefined;
  }
  return { schemaVersion: 1, name, workload, harness, roles, ...(endToEndSuccess ? { endToEndSuccess } : {}) };
}

/**
 * Parses an already-materialized value. Browser callers may use this for form drafts, but HTTP
 * handlers must enter through parseBuildPlanJson/validateBuildPlanJson so byte and depth limits
 * are applied before JSON allocation.
 */
export function parseUntrustedBuildPlanV1(input: unknown): BuildPlanParseResult {
  const issues = new Issues();
  try {
    const value = parsePlan(input, issues);
    if (!value || issues.values.length > 0) return failure(issues);
    return { ok: true, value };
  } catch {
    issues.add('$', 'INVALID_FORMAT', 'Input could not be safely inspected.');
    return failure(issues);
  }
}

export function validateUntrustedBuildPlanV1(
  input: unknown,
  catalog: Model[],
  quotedAt = new Date().toISOString(),
): BuildPlanValidationResult {
  const parsed = parseUntrustedBuildPlanV1(input);
  if (!parsed.ok) return parsed;

  const issues = new Issues();
  const eligibleCatalog = catalog.filter((model) => model.status === 'current');
  for (const [index, role] of parsed.value.roles.entries()) {
    const path = `$.roles[${index}]`;
    if (!eligibleCatalog.some((model) => model.model_id === role.modelId)) {
      issues.add(`${path}.modelId`, 'MODEL_UNAVAILABLE', 'Selected model is not available in the verified server catalog.', role.roleId);
    }
    if (role.priceOverride && role.usagePerInvocation.cacheReadTokens > 0
      && role.priceOverride.cacheReadPerMtok === undefined) {
      issues.add(`${path}.priceOverride.cacheReadPerMtok`, 'PRICE_INCOMPLETE', 'Custom pricing requires a cache-read rate when cache-read tokens are used.', role.roleId);
    }
    if (role.usagePerInvocation.cacheWriteTokens > 0
      && role.priceOverride?.cacheWritePerMtok === undefined) {
      issues.add(`${path}.priceOverride.cacheWritePerMtok`, 'PRICE_INCOMPLETE', 'Cache-write usage requires an explicit cache-write rate.', role.roleId);
    }
  }

  const quote = quoteBuildPlan(parsed.value, eligibleCatalog, quotedAt);
  if (!quote.valid && quote.errors.some((error) => /numeric range/i.test(error))) {
    issues.add('$', 'QUOTE_OUT_OF_RANGE', 'Derived build totals exceed the supported quote range. Reduce volume, usage, calls, rates or fixed costs.');
  }
  if (!quote.valid && issues.values.length === 0) {
    issues.add('$', 'SEMANTIC_INVALID', 'Plan cannot be quoted against the current verified catalog.');
  }
  if (issues.values.length) return failure(issues);
  return { ok: true, value: parsed.value, quote };
}

function exceedsJsonDepth(value: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of value) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === '{' || character === '[') {
      depth += 1;
      if (depth > BUILD_PLAN_LIMITS.maxJsonDepth) return true;
    } else if (character === '}' || character === ']') depth = Math.max(0, depth - 1);
  }
  return false;
}

export function parseBuildPlanJson(input: string | Uint8Array): BuildPlanParseResult {
  const issues = new Issues();
  let json: string;
  const stringInput = typeof input === 'string';
  let byteInput = false;
  if (!stringInput) {
    try {
      byteInput = input instanceof Uint8Array;
    } catch {
      issues.add('$', 'INVALID_FORMAT', 'Request bytes could not be safely inspected.');
      return failure(issues);
    }
  }
  if (stringInput) {
    if (input.length > BUILD_PLAN_LIMITS.maxBodyBytes) {
      issues.add('$', 'BODY_TOO_LARGE', `Request body exceeds the ${BUILD_PLAN_LIMITS.maxBodyBytes}-byte limit.`);
      return failure(issues);
    }
    const bytes = encoder.encode(input).byteLength;
    if (bytes > BUILD_PLAN_LIMITS.maxBodyBytes) {
      issues.add('$', 'BODY_TOO_LARGE', `Request body exceeds the ${BUILD_PLAN_LIMITS.maxBodyBytes}-byte limit.`);
      return failure(issues);
    }
    json = input;
  } else if (byteInput) {
    const bytes = input as Uint8Array;
    let byteLength: number;
    try {
      byteLength = bytes.byteLength;
    } catch {
      issues.add('$', 'INVALID_FORMAT', 'Request bytes could not be safely inspected.');
      return failure(issues);
    }
    if (byteLength > BUILD_PLAN_LIMITS.maxBodyBytes) {
      issues.add('$', 'BODY_TOO_LARGE', `Request body exceeds the ${BUILD_PLAN_LIMITS.maxBodyBytes}-byte limit.`);
      return failure(issues);
    }
    try {
      json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      issues.add('$', 'INVALID_UTF8', 'Request body must be valid UTF-8.');
      return failure(issues);
    }
  } else {
    issues.add('$', 'TYPE', 'Expected a JSON string or UTF-8 byte array.');
    return failure(issues);
  }

  if (exceedsJsonDepth(json)) {
    issues.add('$', 'TOO_DEEP', `JSON exceeds the ${BUILD_PLAN_LIMITS.maxJsonDepth}-level nesting depth limit.`);
    return failure(issues);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    issues.add('$', 'INVALID_JSON', 'Request body must contain valid JSON.');
    return failure(issues);
  }
  return parseUntrustedBuildPlanV1(parsed);
}

/** Server-safe one-shot entry point for an untrusted JSON request body and trusted catalog. */
export function validateBuildPlanJson(
  input: string | Uint8Array,
  catalog: Model[],
  quotedAt = new Date().toISOString(),
): BuildPlanValidationResult {
  const parsed = parseBuildPlanJson(input);
  if (!parsed.ok) return parsed;
  return validateUntrustedBuildPlanV1(parsed.value, catalog, quotedAt);
}
