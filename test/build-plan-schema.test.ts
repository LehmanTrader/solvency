import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { models } from '../scripts/load.ts';
import type { BuildPlanV1 } from '../site/src/lib/build-cost.ts';
import {
  BUILD_PLAN_LIMITS,
  parseBuildPlanJson,
  parseUntrustedBuildPlanV1,
  validateBuildPlanJson,
  validateUntrustedBuildPlanV1,
} from '../site/src/lib/build-plan-schema.ts';

const makePlan = (): BuildPlanV1 => ({
  schemaVersion: 1,
  name: 'Mixed-model build',
  workload: { buildsPerMonth: 100, volumeBasis: 'attempted_builds' },
  harness: {
    name: '自定义 harness', version: 'v2.4.1', configBasis: 'user_supplied',
    assertionOrigin: 'user_asserted', sourceUrl: 'https://example.com/harness',
    lastVerified: '2026-08-23', fixedCostPerBuildAttemptUsd: 0.25, fixedMonthlyCostUsd: 19,
  },
  roles: [{
    roleId: 'orchestrator', kind: 'orchestrator', label: 'Orchestrator', modelId: 'claude-fable-5',
    expectedInvocationsPerBuildAttempt: 1,
    usagePerInvocation: {
      uncachedInputTokens: 100_000, cacheReadTokens: 20_000, cacheWriteTokens: 0,
      outputTokens: 10_000, basis: 'user_supplied', assertionOrigin: 'user_asserted',
      sourceUrl: 'https://example.com/usage', lastVerified: '2026-08-22',
    },
    priceOverride: {
      inputPerMtok: 1, cacheReadPerMtok: 0.1, outputPerMtok: 2,
      basis: 'contract', assertionOrigin: 'user_asserted',
      sourceUrl: 'https://example.com/contract', lastVerified: '2026-08-21',
    },
  }],
  endToEndSuccess: {
    rate: 0.8, basis: 'measured_by_user', assertionOrigin: 'user_asserted',
    sourceUrl: 'https://example.com/system-run', lastVerified: '2026-08-20',
  },
});

const messages = (result: ReturnType<typeof parseUntrustedBuildPlanV1>): string =>
  result.ok ? '' : result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n');

describe('untrusted BuildPlanV1 runtime schema', () => {
  test('accepts and rebuilds a valid harness-agnostic plan without sharing input references', () => {
    const input = makePlan();
    const result = parseUntrustedBuildPlanV1(input);
    assert.equal(result.ok, true, messages(result));
    if (!result.ok) return;
    assert.deepEqual(result.value, input);
    assert.notEqual(result.value, input);
    assert.notEqual(result.value.roles, input.roles);
    assert.notEqual(result.value.roles[0].usagePerInvocation, input.roles[0].usagePerInvocation);
    input.roles[0].label = 'Changed after parsing';
    assert.equal(result.value.roles[0].label, 'Orchestrator');

    const repeated = parseUntrustedBuildPlanV1(result.value);
    assert.equal(repeated.ok, true, messages(repeated));
    if (repeated.ok) {
      assert.deepEqual(repeated.value, result.value);
      assert.notEqual(repeated.value, result.value);
    }
  });

  test('returns bounded diagnostics rather than throwing for arbitrary object shapes', () => {
    for (const value of [null, undefined, true, 1, 'plan', [], () => undefined, Symbol('plan')]) {
      assert.doesNotThrow(() => parseUntrustedBuildPlanV1(value));
      const result = parseUntrustedBuildPlanV1(value);
      assert.equal(result.ok, false);
      assert.match(messages(result), /plain object/i);
    }

    const throwing = new Proxy({}, { ownKeys: () => { throw new Error('secret from getter'); } });
    const result = parseUntrustedBuildPlanV1(throwing);
    assert.equal(result.ok, false);
    assert.doesNotThrow(() => messages(result));
    assert.doesNotMatch(messages(result), /secret from getter/);
  });

  test('parses bounded UTF-8 JSON and ignores structural punctuation inside strings', () => {
    const plan = makePlan();
    plan.name = 'Literal { [ \\"quoted\\" ] } text';
    const json = JSON.stringify(plan);
    const textResult = parseBuildPlanJson(json);
    assert.equal(textResult.ok, true, messages(textResult));
    const byteResult = parseBuildPlanJson(new TextEncoder().encode(json));
    assert.equal(byteResult.ok, true, messages(byteResult));
  });

  test('fails closed on malformed, oversized, invalid UTF-8 and over-nested JSON', () => {
    const malformed = parseBuildPlanJson('{"schemaVersion":1');
    assert.equal(malformed.ok, false);
    assert.match(messages(malformed), /valid JSON/i);

    const oversized = parseBuildPlanJson(' '.repeat(BUILD_PLAN_LIMITS.maxBodyBytes + 1));
    assert.equal(oversized.ok, false);
    assert.match(messages(oversized), /byte limit/i);

    const invalidUtf8 = parseBuildPlanJson(new Uint8Array([0xc3, 0x28]));
    assert.equal(invalidUtf8.ok, false);
    assert.match(messages(invalidUtf8), /UTF-8/i);

    const nested = `${'['.repeat(BUILD_PLAN_LIMITS.maxJsonDepth + 1)}0${']'.repeat(BUILD_PLAN_LIMITS.maxJsonDepth + 1)}`;
    const deep = parseBuildPlanJson(nested);
    assert.equal(deep.ok, false);
    assert.match(messages(deep), /nesting depth/i);

    const proxiedBytes = new Proxy(new Uint8Array([0x7b, 0x7d]), {});
    assert.doesNotThrow(() => parseBuildPlanJson(proxiedBytes));
    const proxiedResult = parseBuildPlanJson(proxiedBytes);
    assert.equal(proxiedResult.ok, false);
    assert.match(messages(proxiedResult), /safely inspected/i);

    const revoked = Proxy.revocable(new Uint8Array([0x7b, 0x7d]), {});
    revoked.revoke();
    assert.doesNotThrow(() => parseBuildPlanJson(revoked.proxy));
    assert.match(messages(parseBuildPlanJson(revoked.proxy)), /safely inspected/i);
  });

  test('rejects unknown fields at every schema level and never accepts a client quote envelope', () => {
    const cases: Array<[string, (value: Record<string, unknown>) => void, RegExp]> = [
      ['top level', (value) => { value.quote = { valid: true }; }, /\$\.quote/],
      ['workload', (value) => { (value.workload as Record<string, unknown>).admin = true; }, /\$\.workload\.admin/],
      ['harness', (value) => { (value.harness as Record<string, unknown>).__protoPollution = true; }, /\$\.harness\.__protoPollution/],
      ['role', (value) => { ((value.roles as unknown[])[0] as Record<string, unknown>).entitlement = 'pro'; }, /entitlement/],
      ['usage', (value) => { ((((value.roles as unknown[])[0] as Record<string, unknown>).usagePerInvocation) as Record<string, unknown>).html = '<script>'; }, /usagePerInvocation\.html/],
      ['override', (value) => { ((((value.roles as unknown[])[0] as Record<string, unknown>).priceOverride) as Record<string, unknown>).currency = 'USD'; }, /priceOverride\.currency/],
      ['success', (value) => { (value.endToEndSuccess as Record<string, unknown>).modelPassRate = 0.9; }, /endToEndSuccess\.modelPassRate/],
    ];
    for (const [label, mutate, path] of cases) {
      const value = structuredClone(makePlan()) as unknown as Record<string, unknown>;
      mutate(value);
      const result = parseUntrustedBuildPlanV1(value);
      assert.equal(result.ok, false, label);
      assert.match(messages(result), path, label);
    }

    const polluted = parseBuildPlanJson(`{"schemaVersion":1,"__proto__":{"isAdmin":true}}`);
    assert.equal(polluted.ok, false);
    assert.match(messages(polluted), /\$\.__proto__/);
    assert.equal(({} as { isAdmin?: boolean }).isAdmin, undefined);
  });

  test('rejects unsupported schema versions, discriminants and type coercion', () => {
    const input = makePlan() as unknown as Record<string, unknown>;
    input.schemaVersion = 2;
    (input.workload as Record<string, unknown>).buildsPerMonth = '100';
    (input.workload as Record<string, unknown>).volumeBasis = 'tampered';
    (input.harness as Record<string, unknown>).configBasis = 'tampered';
    const role = (input.roles as unknown[])[0] as Record<string, unknown>;
    role.kind = 'subagent';
    (role.usagePerInvocation as Record<string, unknown>).basis = 'estimated';
    (role.priceOverride as Record<string, unknown>).basis = 'catalog';
    (input.endToEndSuccess as Record<string, unknown>).basis = 'model_benchmark';

    const result = parseUntrustedBuildPlanV1(input);
    assert.equal(result.ok, false);
    const errors = messages(result);
    for (const expected of [
      /schemaVersion/, /buildsPerMonth/, /volumeBasis/, /configBasis/, /\.kind/,
      /usagePerInvocation\.basis/, /priceOverride\.basis/, /endToEndSuccess\.basis/,
    ]) assert.match(errors, expected);
  });

  test('enforces finite numeric ceilings and the success-rate domain', () => {
    const mutations: Array<[string, (plan: BuildPlanV1) => void]> = [
      ['non-finite volume', (plan) => { plan.workload.buildsPerMonth = Number.POSITIVE_INFINITY; }],
      ['excess volume', (plan) => { plan.workload.buildsPerMonth = BUILD_PLAN_LIMITS.maxBuildsPerMonth + 1; }],
      ['negative fixed cost', (plan) => { plan.harness.fixedMonthlyCostUsd = -1; }],
      ['excess fixed cost', (plan) => { plan.harness.fixedMonthlyCostUsd = BUILD_PLAN_LIMITS.maxFixedCostUsd + 1; }],
      ['zero calls', (plan) => { plan.roles[0].expectedInvocationsPerBuildAttempt = 0; }],
      ['excess calls', (plan) => { plan.roles[0].expectedInvocationsPerBuildAttempt = BUILD_PLAN_LIMITS.maxExpectedInvocations + 1; }],
      ['negative tokens', (plan) => { plan.roles[0].usagePerInvocation.outputTokens = -1; }],
      ['excess tokens', (plan) => { plan.roles[0].usagePerInvocation.outputTokens = BUILD_PLAN_LIMITS.maxTokensPerInvocation + 1; }],
      ['excess rate', (plan) => { plan.roles[0].priceOverride!.outputPerMtok = BUILD_PLAN_LIMITS.maxPricePerMtokUsd + 1; }],
      ['zero success', (plan) => { plan.endToEndSuccess!.rate = 0; }],
      ['excess success', (plan) => { plan.endToEndSuccess!.rate = 1.01; }],
    ];
    for (const [label, mutate] of mutations) {
      const plan = makePlan();
      mutate(plan);
      const result = parseUntrustedBuildPlanV1(plan);
      assert.equal(result.ok, false, label);
      assert.match(messages(result), /finite number|between|greater than|no more than|at most/i, label);
    }
  });

  test('accepts every exact primitive ceiling before rejecting values beyond it', () => {
    const exact = makePlan();
    exact.workload.buildsPerMonth = BUILD_PLAN_LIMITS.maxBuildsPerMonth;
    exact.harness.fixedCostPerBuildAttemptUsd = BUILD_PLAN_LIMITS.maxFixedCostUsd;
    exact.harness.fixedMonthlyCostUsd = BUILD_PLAN_LIMITS.maxFixedCostUsd;
    exact.roles[0].expectedInvocationsPerBuildAttempt = BUILD_PLAN_LIMITS.maxExpectedInvocations;
    exact.roles[0].usagePerInvocation.uncachedInputTokens = BUILD_PLAN_LIMITS.maxTokensPerInvocation;
    exact.roles[0].usagePerInvocation.cacheReadTokens = BUILD_PLAN_LIMITS.maxTokensPerInvocation;
    exact.roles[0].usagePerInvocation.outputTokens = BUILD_PLAN_LIMITS.maxTokensPerInvocation;
    exact.roles[0].priceOverride!.inputPerMtok = BUILD_PLAN_LIMITS.maxPricePerMtokUsd;
    exact.roles[0].priceOverride!.cacheReadPerMtok = BUILD_PLAN_LIMITS.maxPricePerMtokUsd;
    exact.roles[0].priceOverride!.outputPerMtok = BUILD_PLAN_LIMITS.maxPricePerMtokUsd;
    exact.endToEndSuccess!.rate = 1;
    const exactResult = parseUntrustedBuildPlanV1(exact);
    assert.equal(exactResult.ok, true, messages(exactResult));

    const beyond = structuredClone(exact);
    beyond.roles[0].priceOverride!.inputPerMtok = BUILD_PLAN_LIMITS.maxPricePerMtokUsd + 1;
    assert.equal(parseUntrustedBuildPlanV1(beyond).ok, false);
  });

  test('caps roles and rejects sparse, duplicate or unsafe identifiers', () => {
    const tooMany = makePlan();
    tooMany.roles = Array.from({ length: BUILD_PLAN_LIMITS.maxRoles + 1 }, (_, index) => ({
      ...structuredClone(tooMany.roles[0]), roleId: `role-${index}`,
    }));
    assert.match(messages(parseUntrustedBuildPlanV1(tooMany)), /at most 24 roles/i);

    const duplicate = makePlan();
    duplicate.roles.push(structuredClone(duplicate.roles[0]));
    assert.match(messages(parseUntrustedBuildPlanV1(duplicate)), /role ID must be unique/i);

    const unsafe = makePlan();
    unsafe.roles[0].roleId = '../admin';
    unsafe.roles[0].modelId = 'model/../../other';
    assert.match(messages(parseUntrustedBuildPlanV1(unsafe)), /roleId.*safe.*identifier|modelId.*safe.*identifier/is);

    const sparse = makePlan() as unknown as { roles: unknown[] };
    sparse.roles = new Array(1);
    assert.match(messages(parseUntrustedBuildPlanV1(sparse)), /roles\[0\]/);
  });

  test('caps every stored string, validates evidence dates and permits only HTTPS evidence URLs', () => {
    const long = makePlan();
    long.name = 'x'.repeat(BUILD_PLAN_LIMITS.maxPlanNameBytes + 1);
    long.roles[0].label = 'x'.repeat(BUILD_PLAN_LIMITS.maxRoleLabelBytes + 1);
    assert.match(messages(parseUntrustedBuildPlanV1(long)), /name.*byte limit|label.*byte limit/is);

    const badEvidence = makePlan();
    badEvidence.harness.sourceUrl = 'javascript:alert(1)';
    badEvidence.roles[0].usagePerInvocation.sourceUrl = 'http://example.com/usage';
    badEvidence.roles[0].priceOverride!.lastVerified = '2026-02-31';
    badEvidence.endToEndSuccess!.lastVerified = 'yesterday';
    const errors = messages(parseUntrustedBuildPlanV1(badEvidence));
    assert.match(errors, /harness\.sourceUrl.*HTTPS/is);
    assert.match(errors, /usagePerInvocation\.sourceUrl.*HTTPS/is);
    assert.match(errors, /priceOverride\.lastVerified.*calendar date/is);
    assert.match(errors, /endToEndSuccess\.lastVerified.*calendar date/is);

    const incomplete = makePlan();
    delete incomplete.roles[0].usagePerInvocation.lastVerified;
    assert.match(messages(parseUntrustedBuildPlanV1(incomplete)), /Evidence URL and verification date must be supplied together/);
  });

  test('rejects negative zero and invisible control text without reflecting raw values', () => {
    const plan = makePlan();
    plan.harness.fixedCostPerBuildAttemptUsd = -0;
    plan.name = 'Admin\u0000\u202eeman';
    const result = parseUntrustedBuildPlanV1(plan);
    assert.equal(result.ok, false);
    const errors = messages(result);
    assert.match(errors, /Negative zero/);
    assert.match(errors, /Control and bidirectional formatting characters/);
    assert.doesNotMatch(errors, /Admin/);
  });

  test('prevents client input from escalating provenance to source-verified', () => {
    const plan = makePlan();
    plan.harness.assertionOrigin = 'source_verified';
    plan.roles[0].usagePerInvocation.assertionOrigin = 'source_verified';
    plan.roles[0].priceOverride!.assertionOrigin = 'source_verified';
    plan.endToEndSuccess!.assertionOrigin = 'source_verified';
    const result = parseUntrustedBuildPlanV1(plan);
    assert.equal(result.ok, false);
    const errors = messages(result);
    assert.equal(errors.match(/source_verified/g)?.length, 4);
    assert.match(errors, /trusted provenance.*server-controlled/i);
  });

  test('prevents explicit and implicit template provenance escalation at the user boundary', () => {
    const claimed = makePlan();
    claimed.harness.configBasis = 'solvency_template';
    claimed.harness.assertionOrigin = 'solvency_template';
    claimed.roles[0].usagePerInvocation.basis = 'template_assumption';
    claimed.roles[0].usagePerInvocation.assertionOrigin = 'solvency_template';
    const rejected = parseUntrustedBuildPlanV1(claimed);
    assert.equal(rejected.ok, false);
    assert.equal(messages(rejected).match(/solvency_template/g)?.length, 2);

    const omitted = makePlan();
    omitted.harness.configBasis = 'solvency_template';
    omitted.roles[0].usagePerInvocation.basis = 'template_assumption';
    delete omitted.harness.assertionOrigin;
    delete omitted.roles[0].usagePerInvocation.assertionOrigin;
    delete omitted.roles[0].priceOverride!.assertionOrigin;
    delete omitted.endToEndSuccess!.assertionOrigin;
    const canonical = parseUntrustedBuildPlanV1(omitted);
    assert.equal(canonical.ok, true, messages(canonical));
    if (!canonical.ok) return;
    assert.equal(canonical.value.harness.assertionOrigin, 'user_asserted');
    assert.equal(canonical.value.roles[0].usagePerInvocation.assertionOrigin, 'user_asserted');
    assert.equal(canonical.value.roles[0].priceOverride!.assertionOrigin, 'user_asserted');
    assert.equal(canonical.value.endToEndSuccess!.assertionOrigin, 'user_asserted');
  });

  test('bounds diagnostics instead of reflecting an attacker-sized error list', () => {
    const plan = makePlan() as unknown as Record<string, unknown>;
    for (let index = 0; index < BUILD_PLAN_LIMITS.maxIssues + 20; index += 1) plan[`unknown-${index}`] = index;
    const result = parseUntrustedBuildPlanV1(plan);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.issues.length, BUILD_PLAN_LIMITS.maxIssues);
    assert.equal(result.truncated, true);
  });

  test('hands canonical typed data to a catalog-aware quote gate with stable issues', () => {
    const validated = validateUntrustedBuildPlanV1(makePlan(), models, '2026-08-23T12:00:00.000Z');
    assert.equal(validated.ok, true, validated.ok ? '' : validated.issues.map((issue) => issue.message).join('\n'));
    if (!validated.ok) return;
    assert.equal(validated.quote.valid, true);

    const missingModel = makePlan();
    missingModel.roles[0].modelId = 'not-in-the-server-catalog';
    const missingModelResult = validateUntrustedBuildPlanV1(missingModel, models);
    assert.equal(missingModelResult.ok, false);
    if (!missingModelResult.ok) assert.equal(missingModelResult.issues[0].code, 'MODEL_UNAVAILABLE');

    const retiredModel = models.find((model) => model.status === 'retired');
    assert.ok(retiredModel, 'fixture should include a retired catalog model');
    const retiredSelection = makePlan();
    retiredSelection.roles[0].modelId = retiredModel.model_id;
    const retiredResult = validateUntrustedBuildPlanV1(retiredSelection, models);
    assert.equal(retiredResult.ok, false);
    if (!retiredResult.ok) assert.equal(retiredResult.issues[0].code, 'MODEL_UNAVAILABLE');

    const missingCacheRate = makePlan();
    delete missingCacheRate.roles[0].priceOverride!.cacheReadPerMtok;
    const missingRateResult = validateUntrustedBuildPlanV1(missingCacheRate, models);
    assert.equal(missingRateResult.ok, false);
    if (!missingRateResult.ok) assert.equal(missingRateResult.issues[0].code, 'PRICE_INCOMPLETE');

    const fromJson = validateBuildPlanJson(JSON.stringify(makePlan()), models, '2026-08-23T12:00:00.000Z');
    assert.equal(fromJson.ok, true, fromJson.ok ? '' : fromJson.issues.map((issue) => issue.message).join('\n'));
    const oversizedJson = validateBuildPlanJson(' '.repeat(BUILD_PLAN_LIMITS.maxBodyBytes + 1), models);
    assert.equal(oversizedJson.ok, false);
    if (!oversizedJson.ok) assert.equal(oversizedJson.issues[0].code, 'BODY_TOO_LARGE');
  });

  test('rejects noncanonical and symbol array properties', () => {
    const noncanonical = makePlan() as unknown as { roles: Array<unknown> & Record<string, unknown> };
    noncanonical.roles['00'] = structuredClone(noncanonical.roles[0]);
    assert.match(messages(parseUntrustedBuildPlanV1(noncanonical)), /Array properties are not accepted/);
    delete noncanonical.roles['00'];
    Object.defineProperty(noncanonical.roles, Symbol('hidden'), { value: true, enumerable: true });
    assert.match(messages(parseUntrustedBuildPlanV1(noncanonical)), /Symbol-keyed array properties/);
  });

  test('preflights giant direct strings before normalization', () => {
    const plan = makePlan();
    const giant = 'x'.repeat(10_000_000);
    plan.name = giant;
    const started = performance.now();
    const result = parseUntrustedBuildPlanV1(plan);
    assert.equal(result.ok, false);
    assert.match(messages(result), /byte limit/);
    assert.ok(performance.now() - started < 500, 'giant direct string should fail without full normalization');
  });
});
