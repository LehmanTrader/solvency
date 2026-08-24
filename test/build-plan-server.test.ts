import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { models } from '../scripts/load.ts';
import { quoteBuildPlan, type BuildPlanV1 } from '../site/src/lib/build-cost.ts';
import { BUILD_PLAN_LIMITS } from '../site/src/lib/build-plan-limits.ts';
import {
  ACCOUNT_PLAN_RATE_LIMIT, ACCOUNT_PLAN_RATE_WINDOW_MS, apiError, enforceOwnerRateLimit,
  readBoundedPlanBody, validateMutationBoundary, withApiHeaders,
} from '../site/src/lib/server/api-http.ts';
import { clerkAuthConfiguration } from '../site/src/lib/server/clerk-auth.ts';
import {
  handleBuildPlanCollection,
  handleBuildPlanResource,
  handleBuildPlanVersions,
} from '../site/src/lib/server/build-plan-api.ts';
import {
  appendOwnedBuildPlanVersion,
  createOwnedBuildPlan,
  deleteOwnedBuildPlan,
  getOwnedBuildPlan,
  listOwnedBuildPlans,
  MAX_BUILD_PLAN_VERSIONS,
  MAX_OWNED_BUILD_PLANS,
  sha256Hex,
} from '../site/src/lib/server/build-plan-store.ts';
import type {
  D1DatabaseLike, D1PreparedStatementLike, D1ResultLike, PagesContextLike,
} from '../site/src/lib/server/pages-types.ts';
import { onRequest as apiMiddleware } from '../site/functions/api/_middleware.ts';

const migration = [
  '../site/migrations/0001_build_plans.sql',
  '../site/migrations/0002_build_plan_invariants.sql',
  '../site/migrations/0003_build_plan_rate_limits.sql',
  '../site/migrations/0006_product_intent_events.sql',
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');

class SqliteStatement implements D1PreparedStatementLike {
  private readonly database: DatabaseSync;
  readonly query: string;
  readonly values: unknown[];

  constructor(database: DatabaseSync, query: string, values: unknown[] = []) {
    this.database = database;
    this.query = query;
    this.values = values;
  }

  bind(...values: unknown[]): D1PreparedStatementLike {
    return new SqliteStatement(this.database, this.query, values);
  }

  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.query).get(...this.values) as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1ResultLike<T>> {
    return { success: true, results: this.database.prepare(this.query).all(...this.values) as T[] };
  }

  async run<T>(): Promise<D1ResultLike<T>> {
    const result = this.database.prepare(this.query).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class SqliteD1 implements D1DatabaseLike {
  readonly sqlite = new DatabaseSync(':memory:');

  constructor() {
    this.sqlite.exec(migration);
  }

  prepare(query: string): D1PreparedStatementLike {
    return new SqliteStatement(this.sqlite, query);
  }

  async batch<T>(statements: D1PreparedStatementLike[]): Promise<Array<D1ResultLike<T>>> {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results: Array<D1ResultLike<T>> = [];
      for (const statement of statements) results.push(await statement.run<T>());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (cause) {
      this.sqlite.exec('ROLLBACK');
      throw cause;
    }
  }
}

const makePlan = (name = 'Account-owned build'): BuildPlanV1 => ({
  schemaVersion: 1,
  name,
  workload: { buildsPerMonth: 100, volumeBasis: 'attempted_builds' },
  harness: {
    name: 'Custom internal harness', version: 'v1', configBasis: 'user_supplied',
    assertionOrigin: 'user_asserted', fixedCostPerBuildAttemptUsd: 0, fixedMonthlyCostUsd: 0,
  },
  roles: [{
    roleId: 'orchestrator', kind: 'orchestrator', label: 'Orchestrator', modelId: 'claude-fable-5',
    expectedInvocationsPerBuildAttempt: 1,
    usagePerInvocation: {
      uncachedInputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0,
      outputTokens: 10_000, basis: 'user_supplied', assertionOrigin: 'user_asserted',
    },
  }],
});

function planRequest(body: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request('https://solvency.dev/api/build-plans', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

function context(
  db: D1DatabaseLike,
  request: Request,
  ownerUserId: string | undefined,
  params: Record<string, string> = {},
  extraEnv: Record<string, string> = {},
): PagesContextLike {
  return {
    request,
    env: { DB: db, ...extraEnv },
    params,
    data: { requestId: 'req-handler', ...(ownerUserId ? { ownerUserId } : {}) },
    next: async () => apiError('req-handler', 404, 'RESOURCE_NOT_FOUND', 'Not found.'),
  };
}

function rejectProductIntentQueries(db: D1DatabaseLike): D1DatabaseLike {
  return {
    prepare(query: string) {
      if (query.includes('product_intent_events')) throw new Error('measurement unavailable');
      return db.prepare(query);
    },
    batch<T>(statements: D1PreparedStatementLike[]) { return db.batch<T>(statements); },
  };
}

describe('Pages API request boundary', () => {
  test('streams exact-limit and many-chunk bodies into one bounded result', async () => {
    const exact = new Uint8Array(BUILD_PLAN_LIMITS.maxBodyBytes).fill(0x20);
    const exactResult = await readBoundedPlanBody(planRequest(exact), 'req-exact');
    assert.equal(exactResult.ok, true);
    if (exactResult.ok) assert.equal(exactResult.bytes.byteLength, BUILD_PLAN_LIMITS.maxBodyBytes);

    let chunks = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks === 257) return controller.close();
        controller.enqueue(new Uint8Array([chunks % 255]));
        chunks += 1;
      },
    });
    const tiny = await readBoundedPlanBody(planRequest(stream), 'req-tiny');
    assert.equal(tiny.ok, true);
    if (tiny.ok) assert.equal(tiny.bytes.byteLength, 257);
  });

  test('rejects declared and streamed overflow, bad length, media type and encoding', async () => {
    const declared = await readBoundedPlanBody(planRequest('{}', {
      'content-length': String(BUILD_PLAN_LIMITS.maxBodyBytes + 1),
    }), 'req-declared');
    assert.equal(declared.ok, false);
    if (!declared.ok) assert.equal(declared.response.status, 413);

    const overflow = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(BUILD_PLAN_LIMITS.maxBodyBytes));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {},
    });
    const streamed = await readBoundedPlanBody(planRequest(overflow), 'req-streamed');
    assert.equal(streamed.ok, false);
    if (!streamed.ok) assert.equal(streamed.response.status, 413);

    for (const [request, status] of [
      [planRequest('{}', { 'content-length': '+2' }), 400],
      [new Request('https://solvency.dev/api/build-plans', { method: 'POST', body: '{}', headers: { 'content-type': 'text/plain' } }), 415],
      [planRequest('{}', { 'content-encoding': 'gzip' }), 415],
    ] as const) {
      const result = await readBoundedPlanBody(request, 'req-invalid');
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.response.status, status);
    }
  });

  test('enforces exact mutation origins without CORS and hardens all API responses', async () => {
    const allowed = ['https://solvency.dev'];
    const good = planRequest('{}', { origin: allowed[0], 'sec-fetch-site': 'same-origin' });
    assert.equal(validateMutationBoundary(good, 'req-good', allowed), null);
    for (const headers of [
      {},
      { origin: 'null' },
      { origin: 'https://evil.example' },
      { origin: allowed[0], 'sec-fetch-site': 'cross-site' },
    ]) {
      const failure = validateMutationBoundary(planRequest('{}', headers), 'req-bad', allowed);
      assert.equal(failure?.status, 403);
      assert.equal(failure?.headers.has('access-control-allow-origin'), false);
    }
    const response = withApiHeaders(apiError('req-headers', 401, 'AUTH_REQUIRED', 'Sign in is required.'), 'req-headers');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-request-id'), 'req-headers');
    assert.equal(response.headers.get('x-error-code'), 'AUTH_REQUIRED');
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/);

    for (const code of ['PLAN_LIMIT', 'VERSION_LIMIT', 'VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT'] as const) {
      const conflict = withApiHeaders(apiError('req-conflict', 409, code, 'Stable message.'), 'req-conflict');
      assert.equal(conflict.status, 409);
      assert.equal(conflict.headers.get('x-error-code'), code);
      assert.equal(conflict.headers.has('access-control-allow-origin'), false);
    }
  });

  test('fails auth configuration closed and accepts only exact environment origins', () => {
    const base = {
      DB: new SqliteD1(),
      CLERK_SECRET_KEY: 'sk_test_value',
      CLERK_JWT_KEY: '-----BEGIN PUBLIC KEY-----\\nvalue\\n-----END PUBLIC KEY-----',
      CLERK_PUBLISHABLE_KEY: 'pk_test_value',
    };
    assert.equal(clerkAuthConfiguration(base), null);
    assert.equal(clerkAuthConfiguration({ ...base, APP_ENV: 'production', CLERK_AUTHORIZED_PARTIES: 'https://*.solvency.dev' }), null);
    assert.equal(clerkAuthConfiguration({ ...base, APP_ENV: 'production', CLERK_AUTHORIZED_PARTIES: 'https://www.solvency.dev' }), null);
    assert.deepEqual(
      clerkAuthConfiguration({ ...base, APP_ENV: 'production', CLERK_AUTHORIZED_PARTIES: 'https://solvency.dev' })?.authorizedParties,
      ['https://solvency.dev'],
    );
    assert.deepEqual(
      clerkAuthConfiguration({ ...base, APP_ENV: 'development', CLERK_AUTHORIZED_PARTIES: 'http://localhost:8788' })?.authorizedParties,
      ['http://localhost:8788'],
    );
  });

  test('rate limits concurrent requests exactly, isolates owners and resets the next window', async () => {
    const db = new SqliteD1();
    const now = Date.UTC(2026, 7, 23, 12, 0, 0);
    const attempts = await Promise.all(Array.from({ length: ACCOUNT_PLAN_RATE_LIMIT }, (_, index) =>
      enforceOwnerRateLimit(db, 'user_verified_owner', `req-rate-${index}`, now)));
    assert.equal(attempts.every((response) => response === null), true);

    const limited = await enforceOwnerRateLimit(db, 'user_verified_owner', 'req-rate-limited', now);
    assert.equal(limited?.status, 429);
    assert.equal((await limited?.json() as { error: { code: string } }).error.code, 'RATE_LIMITED');
    assert.equal(db.sqlite.prepare('SELECT request_count FROM build_plan_rate_limits WHERE owner_user_id = ?').get('user_verified_owner')?.request_count, ACCOUNT_PLAN_RATE_LIMIT);

    assert.equal(await enforceOwnerRateLimit(db, 'user_other_owner', 'req-rate-other', now), null);
    assert.equal(await enforceOwnerRateLimit(db, 'user_verified_owner', 'req-rate-reset', now + ACCOUNT_PLAN_RATE_WINDOW_MS), null);
    assert.equal(db.sqlite.prepare('SELECT request_count FROM build_plan_rate_limits WHERE owner_user_id = ?').get('user_verified_owner')?.request_count, 1);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM build_plan_rate_limits').get()?.count, 2);
  });

  test('D1 rate limiting fails closed when storage is missing or errors', async () => {
    assert.equal((await enforceOwnerRateLimit(undefined, 'user_verified_owner', 'req-rate-missing')).status, 503);
    const failedDb = {
      prepare() { throw new Error('D1 unavailable'); },
      async batch() { throw new Error('D1 unavailable'); },
    } as D1DatabaseLike;
    assert.equal((await enforceOwnerRateLimit(failedDb, 'user_verified_owner', 'req-rate-failed')).status, 503);
  });

  test('middleware fails closed before routing and never trusts forged identity headers', async () => {
    const db = new SqliteD1();
    const request = new Request('https://solvency.dev/api/build-plans', {
      headers: { authorization: 'Bearer forged', 'x-user-id': 'user_account_alpha' },
    });
    const missing = await apiMiddleware(context(db, request, undefined));
    assert.equal(missing.status, 503);
    const disabled = context(db, request, undefined);
    disabled.env = {
      DB: db,
      ACCOUNT_PLANS_ENABLED: 'false',
      APP_ENV: 'production',
      CLERK_AUTHORIZED_PARTIES: 'https://solvency.dev',
      CLERK_SECRET_KEY: 'sk_test_value',
      CLERK_JWT_KEY: '-----BEGIN PUBLIC KEY-----\ninvalid\n-----END PUBLIC KEY-----',
      CLERK_PUBLISHABLE_KEY: 'pk_test_value',
    };
    assert.equal((await apiMiddleware(disabled)).status, 503);
    const configured = context(db, request, undefined);
    configured.env = {
      DB: db,
      ACCOUNT_PLANS_ENABLED: 'true',
      APP_ENV: 'production',
      CLERK_AUTHORIZED_PARTIES: 'https://solvency.dev',
      CLERK_SECRET_KEY: 'sk_test_value',
      CLERK_JWT_KEY: '-----BEGIN PUBLIC KEY-----\ninvalid\n-----END PUBLIC KEY-----',
      CLERK_PUBLISHABLE_KEY: 'pk_test_value',
    };
    const unauthenticated = await apiMiddleware(configured);
    assert.equal(unauthenticated.status, 401);
    assert.equal(configured.data.ownerUserId, undefined);
    assert.equal(unauthenticated.headers.get('cache-control'), 'no-store');
  });
});

describe('D1-owned immutable BuildPlan versions', () => {
  test('creates atomically, replays idempotently and isolates two owners', async () => {
    const db = new SqliteD1();
    const now = '2026-08-23T12:00:00.000Z';
    const plan = makePlan();
    const quote = quoteBuildPlan(plan, models, now);
    const requestHash = await sha256Hex(JSON.stringify(plan));
    const input = {
      ownerUserId: 'user_account_alpha', idempotencyKey: 'create-key-000001', requestHash,
      planId: 'plan_11111111-1111-4111-8111-111111111111',
      versionId: 'version_11111111-1111-4111-8111-111111111111', plan, quote, now,
    };
    const created = await createOwnedBuildPlan(db, input);
    assert.equal(created.ok, true);
    if (created.ok) {
      assert.equal(created.replayed, false);
      assert.equal(created.resource.plan.currentVersion, 1);
      assert.equal(created.resource.selectedVersion.quote.quotedAt, now);
    }
    const replayed = await createOwnedBuildPlan(db, { ...input, planId: 'plan_22222222-2222-4222-8222-222222222222' });
    assert.equal(replayed.ok, true);
    if (replayed.ok) {
      assert.equal(replayed.replayed, true);
      assert.equal(replayed.resource.plan.id, input.planId);
    }
    const conflict = await createOwnedBuildPlan(db, { ...input, requestHash: 'f'.repeat(64) });
    assert.deepEqual(conflict, { ok: false, reason: 'idempotency_conflict' });

    assert.equal(await getOwnedBuildPlan(db, 'user_account_beta', input.planId), null);
    assert.deepEqual((await listOwnedBuildPlans(db, 'user_account_beta', { limit: 20, cursor: null })), { plans: [], nextCursor: null });
    assert.equal(await deleteOwnedBuildPlan(db, 'user_account_beta', input.planId, 1), 'not_found');
  });

  test('allocates one next version for a shared expected revision and keeps snapshots immutable', async () => {
    const db = new SqliteD1();
    const plan = makePlan();
    const firstAt = '2026-08-23T12:00:00.000Z';
    const planId = 'plan_33333333-3333-4333-8333-333333333333';
    await createOwnedBuildPlan(db, {
      ownerUserId: 'user_account_alpha', idempotencyKey: 'create-key-000002', requestHash: await sha256Hex('first'),
      planId, versionId: 'version_33333333-3333-4333-8333-333333333331',
      plan, quote: quoteBuildPlan(plan, models, firstAt), now: firstAt,
    });

    const cheaper = makePlan('Cheaper mix');
    cheaper.roles[0].usagePerInvocation.uncachedInputTokens = 50_000;
    const secondAt = '2026-08-23T12:01:00.000Z';
    const appendBase = {
      ownerUserId: 'user_account_alpha', planId, expectedVersion: 1,
      requestHash: await sha256Hex('second'), plan: cheaper,
      quote: quoteBuildPlan(cheaper, models, secondAt), now: secondAt,
    };
    const won = await appendOwnedBuildPlanVersion(db, {
      ...appendBase, idempotencyKey: 'append-key-000001',
      versionId: 'version_33333333-3333-4333-8333-333333333332',
    });
    assert.equal(won.ok, true);
    const stale = await appendOwnedBuildPlanVersion(db, {
      ...appendBase, idempotencyKey: 'append-key-000002', requestHash: await sha256Hex('stale'),
      versionId: 'version_33333333-3333-4333-8333-333333333333',
    });
    assert.deepEqual(stale, { ok: false, reason: 'version_conflict' });

    const resource = await getOwnedBuildPlan(db, 'user_account_alpha', planId, 1);
    assert.equal(resource?.plan.currentVersion, 2);
    assert.equal(resource?.selectedVersion.plan.name, 'Account-owned build');
    assert.equal(resource?.versions.length, 2);
    assert.throws(() => db.sqlite.prepare('UPDATE build_plan_versions SET plan_name = ? WHERE plan_id = ?').run('tampered', planId), /IMMUTABLE_VERSION/);
    assert.throws(() => db.sqlite.prepare('DELETE FROM build_plan_versions WHERE plan_id = ? AND version = 1').run(planId), /IMMUTABLE_VERSION/);

    assert.equal(await deleteOwnedBuildPlan(db, 'user_account_alpha', planId, 1), 'version_conflict');
    assert.equal(await deleteOwnedBuildPlan(db, 'user_account_alpha', planId, 2), 'deleted');
    assert.equal(db.sqlite.prepare('SELECT count(*) AS count FROM build_plan_versions WHERE plan_id = ?').get(planId)?.count, 0);
  });

  test('uses bound owner predicates so SQL injection text is inert', async () => {
    const db = new SqliteD1();
    const payload = `user_account_alpha' OR 1=1 --`;
    assert.deepEqual(await listOwnedBuildPlans(db, payload, { limit: 20, cursor: null }), { plans: [], nextCursor: null });
    assert.equal(await getOwnedBuildPlan(db, payload, 'plan_33333333-3333-4333-8333-333333333333'), null);
  });

  test('enforces an atomic owner plan quota without affecting another owner', async () => {
    const db = new SqliteD1();
    const now = '2026-08-23T12:00:00.000Z';
    const plan = makePlan();
    const quote = quoteBuildPlan(plan, models, now);
    for (let index = 0; index < MAX_OWNED_BUILD_PLANS; index += 1) {
      const suffix = String(index).padStart(12, '0');
      const result = await createOwnedBuildPlan(db, {
        ownerUserId: 'user_account_quota', idempotencyKey: `quota-create-${suffix}`,
        requestHash: await sha256Hex(`quota-${index}`), planId: `plan_quota_${suffix}`,
        versionId: `version_quota_${suffix}`, plan, quote, now,
      });
      assert.equal(result.ok, true);
    }
    const over = await createOwnedBuildPlan(db, {
      ownerUserId: 'user_account_quota', idempotencyKey: 'quota-create-over-0001',
      requestHash: await sha256Hex('quota-over'), planId: 'plan_quota_over_0001',
      versionId: 'version_quota_over_0001', plan, quote, now,
    });
    assert.deepEqual(over, { ok: false, reason: 'plan_limit' });
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM build_plans WHERE owner_user_id = ?').get('user_account_quota')?.count, MAX_OWNED_BUILD_PLANS);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM build_plan_versions v JOIN build_plans p ON p.id = v.plan_id WHERE p.owner_user_id = ?').get('user_account_quota')?.count, MAX_OWNED_BUILD_PLANS);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM build_plan_requests WHERE owner_user_id = ?').get('user_account_quota')?.count, MAX_OWNED_BUILD_PLANS);

    const overHttp = await handleBuildPlanCollection(context(
      db,
      planRequest(JSON.stringify(plan), { 'idempotency-key': 'quota-handler-over-01' }),
      'user_account_quota',
    ));
    assert.equal(overHttp.status, 409);
    assert.equal((await overHttp.json() as { error: { code: string } }).error.code, 'PLAN_LIMIT');
    const other = await createOwnedBuildPlan(db, {
      ownerUserId: 'user_account_other', idempotencyKey: 'quota-other-create-01',
      requestHash: await sha256Hex('quota-other'), planId: 'plan_quota_other_0001',
      versionId: 'version_quota_other_0001', plan, quote, now,
    });
    assert.equal(other.ok, true);
  });

  test('HTTP handlers reject quote envelopes and persist only a server-recomputed quote', async () => {
    const db = new SqliteD1();
    const plan = makePlan();
    const headers = {
      'content-type': 'application/json',
      'idempotency-key': 'handler-create-0001',
      'x-user-id': 'user_account_beta',
    };
    const forged = { ...plan, quote: { valid: true, monthlyCostUsd: 0 } };
    const rejected = await handleBuildPlanCollection(context(db, planRequest(JSON.stringify(forged), headers), 'user_account_alpha'));
    assert.equal(rejected.status, 422);

    const created = await handleBuildPlanCollection(context(db, planRequest(JSON.stringify(plan), headers), 'user_account_alpha'));
    assert.equal(created.status, 201);
    const body = await created.json() as { data: { plan: { id: string; currentVersion: number }; selectedVersion: { quote: { valid: boolean; monthlyCostUsd: number } } } };
    assert.equal(body.data.plan.currentVersion, 1);
    assert.equal(body.data.selectedVersion.quote.valid, true);
    assert.ok(body.data.selectedVersion.quote.monthlyCostUsd > 0);

    const foreign = await handleBuildPlanResource(context(
      db,
      new Request(`https://solvency.dev/api/build-plans/${body.data.plan.id}`),
      'user_account_beta',
      { planId: body.data.plan.id },
    ));
    assert.equal(foreign.status, 404);

    const edited = makePlan('Next version');
    const appendRequest = planRequest(JSON.stringify(edited), {
      'idempotency-key': 'handler-append-0001',
      'if-match': '"1"',
    });
    const appended = await handleBuildPlanVersions(context(
      db, appendRequest, 'user_account_alpha', { planId: body.data.plan.id },
    ));
    assert.equal(appended.status, 201);
    const appendedBody = await appended.json() as { data: { plan: { currentVersion: number } } };
    assert.equal(appendedBody.data.plan.currentVersion, 2);

    const staleRequest = planRequest(JSON.stringify(edited), {
      'idempotency-key': 'handler-append-0002',
      'if-match': '"1"',
    });
    const stale = await handleBuildPlanVersions(context(
      db, staleRequest, 'user_account_alpha', { planId: body.data.plan.id },
    ));
    assert.equal(stale.status, 409);

    const stored = db.sqlite.prepare(
      'SELECT plan_json, quote_json, quoted_at FROM build_plan_versions WHERE plan_id = ? AND version = 2',
    ).get(body.data.plan.id) as { plan_json: string; quote_json: string; quoted_at: string };
    const insertVersion = db.sqlite.prepare(
      `INSERT INTO build_plan_versions
         (id, plan_id, version, plan_name, plan_schema_version, quote_engine_version,
          plan_json, quote_json, quoted_at, created_at)
       VALUES (?, ?, ?, ?, 1, 'build-cost-v1', ?, ?, ?, ?)`,
    );
    for (let version = 3; version <= MAX_BUILD_PLAN_VERSIONS; version += 1) {
      insertVersion.run(
        `version_limit_${String(version).padStart(3, '0')}`, body.data.plan.id, version,
        edited.name, stored.plan_json, stored.quote_json, stored.quoted_at,
        `2026-08-23T12:${String(Math.min(version, 59)).padStart(2, '0')}:00.000Z`,
      );
    }
    const maxedRequest = planRequest(JSON.stringify(edited), {
      'idempotency-key': 'handler-version-limit-01',
      'if-match': `"${MAX_BUILD_PLAN_VERSIONS}"`,
    });
    const maxed = await handleBuildPlanVersions(context(
      db, maxedRequest, 'user_account_alpha', { planId: body.data.plan.id },
    ));
    assert.equal(maxed.status, 409);
    assert.equal((await maxed.json() as { error: { code: string } }).error.code, 'VERSION_LIMIT');
  });

  test('confirms successful plan saves server-side without coupling measurement failures', async () => {
    const db = new SqliteD1();
    const plan = makePlan('Measured plan');
    const enabled = { PRODUCT_INTENTS_ENABLED: 'true' };
    const created = await handleBuildPlanCollection(context(
      db,
      planRequest(JSON.stringify(plan), { 'idempotency-key': 'intent-plan-create-01' }),
      'user_account_intent',
      {},
      enabled,
    ));
    assert.equal(created.status, 201);
    const createdBody = await created.json() as { data: { plan: { id: string } } };
    const savedSignals = db.sqlite.prepare(
      'SELECT event_name FROM product_intent_events WHERE owner_user_id = ?',
    ).all('user_account_intent') as Array<{ event_name: string }>;
    assert.deepEqual(savedSignals.map((row) => row.event_name), ['account_plan_saved']);

    db.sqlite.prepare('DELETE FROM product_intent_events WHERE owner_user_id = ?').run('user_account_intent');
    const appended = await handleBuildPlanVersions(context(
      db,
      planRequest(JSON.stringify(makePlan('Measured plan v2')), {
        'idempotency-key': 'intent-plan-append-01', 'if-match': '"1"',
      }),
      'user_account_intent',
      { planId: createdBody.data.plan.id },
      enabled,
    ));
    assert.equal(appended.status, 201);
    assert.equal(db.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM product_intent_events WHERE event_name = 'account_plan_saved'",
    ).get()?.count, 1);

    db.sqlite.prepare('DELETE FROM product_intent_events WHERE owner_user_id = ?').run('user_account_intent');
    const stale = await handleBuildPlanVersions(context(
      db,
      planRequest(JSON.stringify(makePlan('Rejected stale version')), {
        'idempotency-key': 'intent-plan-stale-001', 'if-match': '"1"',
      }),
      'user_account_intent',
      { planId: createdBody.data.plan.id },
      enabled,
    ));
    assert.equal(stale.status, 409);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM product_intent_events').get()?.count, 0);

    const degraded = new SqliteD1();
    const stillSaved = await handleBuildPlanCollection(context(
      rejectProductIntentQueries(degraded),
      planRequest(JSON.stringify(plan), { 'idempotency-key': 'intent-plan-degraded-1' }),
      'user_account_degraded',
      {},
      enabled,
    ));
    assert.equal(stillSaved.status, 201);
    assert.equal(degraded.sqlite.prepare('SELECT COUNT(*) AS count FROM build_plans').get()?.count, 1);
    assert.equal(degraded.sqlite.prepare('SELECT COUNT(*) AS count FROM product_intent_events').get()?.count, 0);
  });
});
