import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { models } from '../scripts/load.ts';
import { quoteBuildPlan, type BuildPlanV1 } from '../site/src/lib/build-cost.ts';
import {
  deriveBuildPlanShareToken,
  handleBuildPlanAlertCollection,
  handleBuildPlanAlertResource,
  handleBuildPlanShareCollection,
  handleBuildPlanShareResource,
  handlePublicBuildPlanShare,
  validBuildPlanShareSecret,
} from '../site/src/lib/server/build-plan-operations-api.ts';
import {
  createOwnedBuildPlanAlert,
  createOwnedBuildPlanShare,
  deleteOwnedBuildPlanAlert,
  getPublicSharedBuildPlan,
  listOwnedBuildPlanAlerts,
  listOwnedBuildPlanShares,
  MAX_BUILD_PLAN_ALERTS_PER_OWNER,
  MAX_BUILD_PLAN_ALERTS_PER_PLAN,
  MAX_BUILD_PLAN_SHARES_PER_OWNER,
  MAX_BUILD_PLAN_SHARES_PER_PLAN,
  OPERATION_IDEMPOTENCY_REPLAY_WINDOW_MS,
  revokeOwnedBuildPlanShare,
  updateOwnedBuildPlanAlert,
} from '../site/src/lib/server/build-plan-operations-store.ts';
import { sha256Hex } from '../site/src/lib/server/build-plan-store.ts';
import type {
  D1DatabaseLike, D1PreparedStatementLike, D1ResultLike, PagesContextLike,
} from '../site/src/lib/server/pages-types.ts';

const migration = [
  '../site/migrations/0001_build_plans.sql',
  '../site/migrations/0002_build_plan_invariants.sql',
  '../site/migrations/0005_build_plan_operations.sql',
  '../site/migrations/0006_product_intent_events.sql',
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');

class SqliteStatement implements D1PreparedStatementLike {
  private readonly database: DatabaseSync;
  readonly query: string;
  readonly values: unknown[];
  private readonly includeTriggerChanges: boolean;

  constructor(
    database: DatabaseSync,
    query: string,
    values: unknown[] = [],
    includeTriggerChanges = false,
  ) {
    this.database = database;
    this.query = query;
    this.values = values;
    this.includeTriggerChanges = includeTriggerChanges;
  }

  bind(...values: unknown[]): D1PreparedStatementLike {
    return new SqliteStatement(this.database, this.query, values, this.includeTriggerChanges);
  }

  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.query).get(...this.values) as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1ResultLike<T>> {
    return { success: true, results: this.database.prepare(this.query).all(...this.values) as T[] };
  }

  async run<T>(): Promise<D1ResultLike<T>> {
    const before = this.includeTriggerChanges
      ? Number((this.database.prepare('SELECT total_changes() AS count').get() as { count: number }).count)
      : 0;
    const result = this.database.prepare(this.query).run(...this.values);
    const changes = this.includeTriggerChanges
      ? Number((this.database.prepare('SELECT total_changes() AS count').get() as { count: number }).count) - before
      : Number(result.changes);
    return { success: true, results: [], meta: { changes } };
  }
}

class SqliteD1 implements D1DatabaseLike {
  readonly sqlite = new DatabaseSync(':memory:');
  private batchTail: Promise<void> = Promise.resolve();
  private readonly includeTriggerChanges: boolean;

  constructor(includeTriggerChanges = false) {
    this.includeTriggerChanges = includeTriggerChanges;
    this.sqlite.exec(migration);
  }

  prepare(query: string): D1PreparedStatementLike {
    return new SqliteStatement(this.sqlite, query, [], this.includeTriggerChanges);
  }

  async batch<T>(statements: D1PreparedStatementLike[]): Promise<Array<D1ResultLike<T>>> {
    let release = () => undefined;
    const turn = this.batchTail;
    this.batchTail = new Promise<void>((resolve) => { release = resolve; });
    await turn;
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results: Array<D1ResultLike<T>> = [];
      for (const statement of statements) results.push(await statement.run<T>());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (cause) {
      this.sqlite.exec('ROLLBACK');
      throw cause;
    } finally {
      release();
    }
  }
}

class BarrierSqliteD1 extends SqliteD1 {
  private barrier: {
    remaining: number;
    promise: Promise<void>;
    release: () => void;
  } | null = null;

  armBatchBarrier(participants = 2): void {
    let release = () => undefined;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    this.barrier = { remaining: participants, promise, release };
  }

  override async batch<T>(statements: D1PreparedStatementLike[]): Promise<Array<D1ResultLike<T>>> {
    const barrier = this.barrier;
    if (barrier) {
      barrier.remaining -= 1;
      if (barrier.remaining === 0) {
        this.barrier = null;
        barrier.release();
      }
      await barrier.promise;
    }
    return super.batch<T>(statements);
  }
}

const OWNER_A = 'user_owner_alpha';
const OWNER_B = 'user_owner_bravo';
const NOW = '2026-08-23T12:00:00.000Z';
const LATER = '2026-08-23T13:00:00.000Z';
const SHARE_SECRET = 'a'.repeat(43);

function uuidFor(index: number): string {
  const head = index.toString(16).padStart(8, '0').slice(-8);
  const tail = index.toString(16).padStart(12, '0').slice(-12);
  return `${head}-0000-4000-8000-${tail}`;
}

const planId = (index: number) => `plan_${uuidFor(index)}`;
const shareId = (index: number) => `share_${uuidFor(index)}`;
const alertId = (index: number) => `alert_${uuidFor(index)}`;
const hashFor = (index: number) => index.toString(16).padStart(64, '0').slice(-64);

const makePlan = (name = 'Durable operations plan'): BuildPlanV1 => ({
  schemaVersion: 1,
  name,
  workload: { buildsPerMonth: 100, volumeBasis: 'attempted_builds' },
  harness: {
    name: 'Any custom harness', version: 'v1', configBasis: 'user_supplied',
    assertionOrigin: 'user_asserted', fixedCostPerBuildAttemptUsd: 0, fixedMonthlyCostUsd: 0,
  },
  roles: [{
    roleId: 'orchestrator', kind: 'orchestrator', label: 'Lead model', modelId: 'claude-fable-5',
    expectedInvocationsPerBuildAttempt: 1,
    usagePerInvocation: {
      uncachedInputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0,
      outputTokens: 10_000, basis: 'user_supplied', assertionOrigin: 'user_asserted',
    },
  }],
});

function seedPlan(
  db: SqliteD1,
  ownerUserId: string,
  id: string,
  versionCount = 2,
  planFactory: (version: number) => BuildPlanV1 = (version) => makePlan(`Plan version ${version}`),
): void {
  db.sqlite.prepare(
    `INSERT INTO build_plans
       (id, owner_user_id, display_name, current_version, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?)`,
  ).run(id, ownerUserId, 'Seed plan', NOW, NOW);
  for (let version = 1; version <= versionCount; version += 1) {
    const plan = planFactory(version);
    const quotedAt = new Date(Date.parse(NOW) + version * 1_000).toISOString();
    const quote = quoteBuildPlan(plan, models, quotedAt);
    assert.equal(quote.valid, true);
    db.sqlite.prepare(
      `INSERT INTO build_plan_versions
         (id, plan_id, version, plan_name, plan_schema_version, quote_engine_version,
          plan_json, quote_json, quoted_at, created_at)
       VALUES (?, ?, ?, ?, 1, 'build-cost-v1', ?, ?, ?, ?)`,
    ).run(
      `version_${id.slice(5, 17)}_${version}`, id, version, plan.name,
      JSON.stringify(plan), JSON.stringify(quote), quote.quotedAt, quotedAt,
    );
  }
}

function context(
  db: D1DatabaseLike,
  request: Request,
  ownerUserId: string | undefined,
  params: Record<string, string>,
  extraEnv: Record<string, string> = {},
): PagesContextLike {
  return {
    request,
    env: { DB: db, ACCOUNT_PLANS_ENABLED: 'true', ...extraEnv },
    params,
    data: { requestId: 'req-operations', ...(ownerUserId ? { ownerUserId } : {}) },
    next: async () => new Response(null, { status: 404 }),
  } as PagesContextLike;
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

function jsonRequest(url: string, method: string, value?: unknown, idempotencyKey?: string): Request {
  return new Request(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
}

async function createShare(
  db: SqliteD1,
  input: {
    ownerUserId?: string;
    planId: string;
    version?: number;
    shareIndex?: number;
    idempotencyKey?: string;
    allowQuoteExport?: boolean;
    expiresAt?: string | null;
    now?: string;
    secret?: string;
  },
) {
  const ownerUserId = input.ownerUserId ?? OWNER_A;
  const version = input.version ?? 1;
  const idempotencyKey = input.idempotencyKey ?? `share-idempotency-${input.shareIndex ?? 1}`;
  const secret = input.secret ?? SHARE_SECRET;
  const token = await deriveBuildPlanShareToken(secret, {
    ownerUserId, planId: input.planId, version, idempotencyKey,
  });
  const body = { planId: input.planId, version, allowQuoteExport: input.allowQuoteExport ?? true };
  return {
    token,
    result: await createOwnedBuildPlanShare(db, {
      ownerUserId,
      planId: input.planId,
      version,
      shareId: shareId(input.shareIndex ?? 1),
      tokenHash: await sha256Hex(token),
      allowQuoteExport: input.allowQuoteExport ?? true,
      expiresAt: input.expiresAt ?? null,
      idempotencyKey,
      requestHash: await sha256Hex(JSON.stringify(body)),
      now: input.now ?? NOW,
    }),
  };
}

async function createAlert(
  db: SqliteD1,
  input: {
    ownerUserId?: string;
    planId: string;
    alertIndex?: number;
    version?: number;
    trigger?: 'model_price_change' | 'monthly_spend_above' | 'monthly_spend_change_percent' | 'baseline_delta_percent';
    threshold?: number | null;
    baselineVersion?: number | null;
    idempotencyKey?: string;
    now?: string;
  },
) {
  const ownerUserId = input.ownerUserId ?? OWNER_A;
  const version = input.version ?? 1;
  const trigger = input.trigger ?? 'model_price_change';
  const threshold = input.threshold ?? null;
  const baselineVersion = input.baselineVersion ?? null;
  const idempotencyKey = input.idempotencyKey ?? `alert-idempotency-${input.alertIndex ?? 1}`;
  const canonical = { planId: input.planId, version, trigger, threshold, baselineVersion };
  return createOwnedBuildPlanAlert(db, {
    ownerUserId,
    planId: input.planId,
    alertId: alertId(input.alertIndex ?? 1),
    version,
    trigger,
    threshold,
    baselineVersion,
    idempotencyKey,
    requestHash: await sha256Hex(JSON.stringify(canonical)),
    now: input.now ?? NOW,
  });
}

describe('durable unlisted build-plan links', () => {
  test('public bearer route remains dark without the server rollout flag and never reads D1', async () => {
    let databaseAccesses = 0;
    const guardedDb = {
      prepare() {
        databaseAccesses += 1;
        throw new Error('Dark public routes must not read D1.');
      },
      async batch() {
        databaseAccesses += 1;
        throw new Error('Dark public routes must not write D1.');
      },
    } as D1DatabaseLike;
    const token = `sv1_${'a'.repeat(43)}`;
    const response = await handlePublicBuildPlanShare(context(
      guardedDb,
      new Request(`https://solvency.dev/shared-build-plans/${token}`),
      undefined,
      { token },
      { ACCOUNT_PLANS_ENABLED: 'false' },
    ));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('x-error-code'), 'SERVICE_UNAVAILABLE');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(databaseAccesses, 0);
  });

  test('stores only token hashes and publicly returns one immutable plan/quote without owner identity', async () => {
    const db = new SqliteD1();
    const firstPlan = planId(1);
    seedPlan(db, OWNER_A, firstPlan);
    seedPlan(db, OWNER_B, planId(2));

    const created = await createShare(db, { planId: firstPlan, shareIndex: 1, allowQuoteExport: false });
    assert.equal(created.result.ok, true);
    const stored = db.sqlite.prepare('SELECT * FROM build_plan_shares').get() as Record<string, unknown>;
    assert.equal(stored.token_hash, await sha256Hex(created.token));
    assert.equal(JSON.stringify(stored).includes(created.token), false);
    assert.equal(JSON.stringify(stored).includes(SHARE_SECRET), false);
    assert.equal(db.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM pragma_table_info('build_plan_shares') WHERE name IN ('token', 'owner_email')",
    ).get()?.count, 0);

    const publicPlan = await getPublicSharedBuildPlan(db, await sha256Hex(created.token), LATER);
    assert.ok(publicPlan);
    assert.deepEqual(Object.keys(publicPlan).sort(), ['plan', 'policy', 'quote', 'schemaVersion']);
    assert.equal(publicPlan.policy.allowQuoteExport, false);
    assert.equal(JSON.stringify(publicPlan).includes(OWNER_A), false);
    assert.equal('planId' in publicPlan, false);
    assert.equal('ownerUserId' in publicPlan, false);

    assert.equal(await listOwnedBuildPlanShares(db, OWNER_B, firstPlan, LATER), null);
    assert.deepEqual((await listOwnedBuildPlanShares(db, OWNER_A, firstPlan, LATER))?.map((share) => share.id), [shareId(1)]);
    const crossOwner = await createShare(db, {
      ownerUserId: OWNER_B, planId: firstPlan, shareIndex: 2, idempotencyKey: 'cross-owner-share-0001',
    });
    assert.deepEqual(crossOwner.result, { ok: false, reason: 'not_found' });
  });

  test('expires and revokes links without revealing whether another owner has them', async () => {
    const db = new SqliteD1();
    const firstPlan = planId(3);
    seedPlan(db, OWNER_A, firstPlan);
    const expiresAt = '2026-08-30T12:00:00.000Z';
    const created = await createShare(db, { planId: firstPlan, shareIndex: 3, expiresAt });
    assert.ok(await getPublicSharedBuildPlan(db, await sha256Hex(created.token), '2026-08-30T11:59:59.999Z'));
    assert.equal(await getPublicSharedBuildPlan(db, await sha256Hex(created.token), expiresAt), null);
    assert.equal((await listOwnedBuildPlanShares(db, OWNER_A, firstPlan, expiresAt))?.[0]?.status, 'expired');

    const wrongOwner = await revokeOwnedBuildPlanShare(db, {
      ownerUserId: OWNER_B, planId: firstPlan, shareId: shareId(3),
      idempotencyKey: 'revoke-wrong-owner-1', requestHash: hashFor(300), now: LATER,
    });
    assert.deepEqual(wrongOwner, { ok: false, reason: 'not_found' });
    const revokeUrl = `https://solvency.dev/api/build-plans/${firstPlan}/shares/${shareId(3)}`;
    const revoke = () => handleBuildPlanShareResource(context(
      db,
      jsonRequest(revokeUrl, 'DELETE', undefined, 'revoke-share-idem-1'),
      OWNER_A,
      { planId: firstPlan, shareId: shareId(3) },
    ));
    const revoked = await Promise.all([revoke(), revoke()]);
    assert.deepEqual(revoked.map((response) => response.status), [200, 200]);
    assert.deepEqual(
      revoked.map((response) => response.headers.get('idempotency-replayed')).sort(),
      ['false', 'true'],
    );
    const differentKey = await handleBuildPlanShareResource(context(
      db,
      jsonRequest(revokeUrl, 'DELETE', undefined, 'revoke-share-different-1'),
      OWNER_A,
      { planId: firstPlan, shareId: shareId(3) },
    ));
    assert.equal(differentKey.status, 404);
    assert.equal(await getPublicSharedBuildPlan(db, await sha256Hex(created.token), LATER), null);
  });

  test('serializes create races and fails a replay closed after token-secret rotation', async () => {
    const db = new SqliteD1();
    const firstPlan = planId(4);
    seedPlan(db, OWNER_A, firstPlan);
    const url = `https://solvency.dev/api/build-plans/${firstPlan}/shares`;
    const body = { version: 1, expiresInDays: 7, allowQuoteExport: true };
    const key = 'share-handler-idem-0001';
    const invoke = (secret: string) => handleBuildPlanShareCollection(context(
      db,
      jsonRequest(url, 'POST', body, key),
      OWNER_A,
      { planId: firstPlan },
      { BUILD_SHARE_TOKEN_SECRET: secret },
    ));
    const [one, two] = await Promise.all([invoke(SHARE_SECRET), invoke(SHARE_SECRET)]);
    assert.deepEqual([one.status, two.status].sort(), [200, 201]);
    const firstBody = await one.json() as { data: { token: string } };
    const secondBody = await two.json() as { data: { token: string } };
    assert.equal(firstBody.data.token, secondBody.data.token);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM build_plan_shares').get()?.count, 1);

    const rotated = await invoke('b'.repeat(43));
    assert.equal(rotated.status, 409);
    assert.equal(rotated.headers.get('x-error-code'), 'RESOURCE_STATE_CHANGED');
    assert.equal((await rotated.text()).includes('sv1_'), false);
    const tokenHash = db.sqlite.prepare('SELECT token_hash FROM build_plan_shares').get()?.token_hash;
    assert.equal(tokenHash, await sha256Hex(firstBody.data.token));
  });

  test('serves safe noindex HTML to browsers and gates explicit JSON downloads by export policy', async () => {
    const db = new SqliteD1();
    const firstPlan = planId(5);
    seedPlan(db, OWNER_A, firstPlan, 1, () => {
      const plan = makePlan('<img src=x onerror=alert(1)>');
      plan.harness.name = '<script>alert(2)</script>';
      plan.roles[0].label = 'Lead & <svg onload=alert(3)>';
      return plan;
    });
    const created = await createShare(db, {
      planId: firstPlan, shareIndex: 5, allowQuoteExport: false,
    });
    const requestUrl = `https://solvency.dev/shared-build-plans/${created.token}`;
    const htmlResponse = await handlePublicBuildPlanShare(context(
      db,
      new Request(requestUrl, { headers: { accept: 'text/html,application/xhtml+xml' } }),
      undefined,
      { token: created.token },
    ));
    assert.equal(htmlResponse.status, 200);
    assert.match(htmlResponse.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal(htmlResponse.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
    assert.match(htmlResponse.headers.get('content-security-policy') ?? '', /script-src 'none'/);
    const html = await htmlResponse.text();
    assert.doesNotMatch(html, /<img src=x|<script>alert\(2\)|<svg onload/);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(html, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /Download plan and quote JSON/);
    assert.match(html, /Price and assumption provenance/);
    assert.match(html, /Catalog list price/);
    assert.match(html, /href="https:\/\/[^" ]+" rel="noopener noreferrer">Price source<\/a> · verified \d{4}-\d{2}-\d{2}/);
    assert.match(html, /Assumptions and list or user-entered rates can differ from actual usage, discounts, taxes and spend/);
    assert.doesNotMatch(html, /href="javascript:/);

    const denied = await handlePublicBuildPlanShare(context(
      db, new Request(`${requestUrl}?download=json`), undefined, { token: created.token },
    ));
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('x-error-code'), 'EXPORT_FORBIDDEN');

    const api = await handlePublicBuildPlanShare(context(
      db, new Request(requestUrl, { headers: { accept: 'application/json' } }), undefined,
      { token: created.token },
    ));
    assert.match(api.headers.get('content-type') ?? '', /^text\/html/);
    assert.equal((await api.text()).includes(OWNER_A), false);

    const exportPlan = planId(6);
    seedPlan(db, OWNER_A, exportPlan, 1, () => {
      const plan = makePlan('User-entered rate plan');
      plan.roles[0].priceOverride = {
        inputPerMtok: 1, outputPerMtok: 2, basis: 'user_supplied', assertionOrigin: 'user_asserted',
        sourceUrl: 'javascript:alert(9)', lastVerified: '2026-08-23',
      };
      return plan;
    });
    const exportable = await createShare(db, {
      planId: exportPlan, shareIndex: 6, allowQuoteExport: true,
    });
    const download = await handlePublicBuildPlanShare(context(
      db,
      new Request(`https://solvency.dev/shared-build-plans/${exportable.token}?download=json`),
      undefined,
      { token: exportable.token },
    ));
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition') ?? '', /^attachment;/);
    assert.equal(JSON.stringify(await download.json()).includes(OWNER_A), false);
    const customHtml = await handlePublicBuildPlanShare(context(
      db,
      new Request(`https://solvency.dev/shared-build-plans/${exportable.token}`),
      undefined,
      { token: exportable.token },
    ));
    const customMarkup = await customHtml.text();
    assert.match(customMarkup, /User-entered custom rate/);
    assert.match(customMarkup, /No external source or verification date; this rate was entered by the plan owner/);
    assert.doesNotMatch(customMarkup, /href="javascript:/);
  });
});

describe('durable inactive alert settings', () => {
  test('keeps closed-enum settings explicitly inactive with valid owned version and baseline references', async () => {
    const db = new SqliteD1();
    const firstPlan = planId(10);
    seedPlan(db, OWNER_A, firstPlan, 2);
    seedPlan(db, OWNER_B, planId(11), 2);

    const price = await createAlert(db, { planId: firstPlan, alertIndex: 10 });
    assert.equal(price.ok, true);
    if (price.ok) {
      assert.equal(price.resource.status, 'inactive');
      assert.equal(price.resource.threshold, null);
    }
    const baseline = await createAlert(db, {
      planId: firstPlan, alertIndex: 11, version: 2, trigger: 'baseline_delta_percent',
      threshold: 10, baselineVersion: 1,
    });
    assert.equal(baseline.ok, true);
    assert.equal((await listOwnedBuildPlanAlerts(db, OWNER_A, firstPlan))?.length, 2);
    assert.equal(await listOwnedBuildPlanAlerts(db, OWNER_B, firstPlan), null);
    assert.equal((await createAlert(db, {
      ownerUserId: OWNER_B, planId: firstPlan, alertIndex: 12,
    })).ok, false);

    assert.throws(() => db.sqlite.prepare(
      `INSERT INTO build_plan_alert_settings
       (id, owner_user_id, plan_id, version, trigger_type, threshold, baseline_version,
        status, created_at, updated_at) VALUES (?, ?, ?, 1, 'email_sent', NULL, NULL, 'inactive', ?, ?)`,
    ).run(alertId(20), OWNER_A, firstPlan, NOW, NOW));
    assert.throws(() => db.sqlite.prepare(
      "UPDATE build_plan_alert_settings SET status = 'active' WHERE id = ?",
    ).run(alertId(10)));
    assert.throws(() => db.sqlite.prepare(
      `INSERT INTO build_plan_alert_settings
       (id, owner_user_id, plan_id, version, trigger_type, threshold, baseline_version,
        status, created_at, updated_at) VALUES (?, ?, ?, 1, 'baseline_delta_percent', 10, 1, 'inactive', ?, ?)`,
    ).run(alertId(21), OWNER_A, firstPlan, NOW, NOW));
  });

  test('rejects duplicate settings, supports idempotent update/delete and isolates owner mutations', async () => {
    const db = new SqliteD1();
    const firstPlan = planId(12);
    seedPlan(db, OWNER_A, firstPlan, 2);
    const created = await createAlert(db, {
      planId: firstPlan, alertIndex: 30, trigger: 'monthly_spend_above', threshold: 250,
    });
    assert.equal(created.ok, true);
    const replayed = await createAlert(db, {
      planId: firstPlan, alertIndex: 999, trigger: 'monthly_spend_above', threshold: 250,
      idempotencyKey: 'alert-idempotency-30',
    });
    assert.equal(replayed.ok && replayed.replayed, true);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM build_plan_alert_settings').get()?.count, 1);
    const duplicate = await createAlert(db, {
      planId: firstPlan, alertIndex: 31, trigger: 'monthly_spend_above', threshold: 250,
      idempotencyKey: 'different-alert-idem-31',
    });
    assert.deepEqual(duplicate, { ok: false, reason: 'duplicate' });

    const updateInput = {
      ownerUserId: OWNER_A, planId: firstPlan, alertId: alertId(30), version: 2,
      trigger: 'monthly_spend_change_percent' as const, threshold: 15, baselineVersion: null,
      idempotencyKey: 'update-alert-idem-30', requestHash: hashFor(30), now: LATER,
    };
    const updated = await updateOwnedBuildPlanAlert(db, updateInput);
    assert.equal(updated.ok && updated.resource.status === 'inactive', true);
    assert.equal((await updateOwnedBuildPlanAlert(db, updateInput)).ok, true);
    assert.deepEqual(await createAlert(db, {
      planId: firstPlan, alertIndex: 999, trigger: 'monthly_spend_above', threshold: 250,
      idempotencyKey: 'alert-idempotency-30',
    }), { ok: false, reason: 'state_changed' });
    const secondUpdate = {
      ...updateInput,
      threshold: 20,
      idempotencyKey: 'update-alert-idem-31',
      requestHash: hashFor(34),
      now: '2026-08-23T14:00:00.000Z',
    };
    assert.equal((await updateOwnedBuildPlanAlert(db, secondUpdate)).ok, true);
    assert.deepEqual(await updateOwnedBuildPlanAlert(db, updateInput), {
      ok: false, reason: 'state_changed',
    });
    assert.deepEqual(await updateOwnedBuildPlanAlert(db, {
      ...updateInput, requestHash: hashFor(31), threshold: 20,
    }), { ok: false, reason: 'idempotency_conflict' });
    assert.deepEqual(await updateOwnedBuildPlanAlert(db, {
      ...updateInput, ownerUserId: OWNER_B, idempotencyKey: 'cross-owner-update-1', requestHash: hashFor(32),
    }), { ok: false, reason: 'not_found' });

    const deleteInput = {
      ownerUserId: OWNER_A, planId: firstPlan, alertId: alertId(30),
      idempotencyKey: 'delete-alert-idem-30', requestHash: hashFor(33), now: LATER,
    };
    assert.deepEqual(await deleteOwnedBuildPlanAlert(db, deleteInput), { ok: true, replayed: false });
    assert.deepEqual(await deleteOwnedBuildPlanAlert(db, deleteInput), { ok: true, replayed: true });
    assert.equal((await listOwnedBuildPlanAlerts(db, OWNER_A, firstPlan))?.length, 0);
  });

  test('handlers bound bodies and refuse delivery claims, unknown fields and invalid thresholds', async () => {
    const db = new SqliteD1();
    const firstPlan = planId(13);
    seedPlan(db, OWNER_A, firstPlan, 2);
    const url = `https://solvency.dev/api/build-plans/${firstPlan}/alerts`;
    for (const [body, expectedStatus] of [
      [{ version: 1, trigger: 'model_price_change', threshold: null, baselineVersion: null, status: 'active' }, 422],
      [{ version: 1, trigger: 'email_delivery', threshold: null, baselineVersion: null }, 422],
      [{ version: 1, trigger: 'monthly_spend_above', threshold: 0, baselineVersion: null }, 422],
      [{ version: 1, trigger: 'baseline_delta_percent', threshold: 10, baselineVersion: 1 }, 422],
    ] as const) {
      const response = await handleBuildPlanAlertCollection(context(
        db, jsonRequest(url, 'POST', body, `handler-alert-${Math.random().toString(16).padEnd(16, '0')}`),
        OWNER_A, { planId: firstPlan },
      ));
      assert.equal(response.status, expectedStatus);
    }

    const huge = await handleBuildPlanAlertCollection(context(
      db,
      jsonRequest(url, 'POST', { version: 1, trigger: 'model_price_change', padding: 'x'.repeat(5_000) }, 'handler-alert-huge-1'),
      OWNER_A,
      { planId: firstPlan },
    ));
    assert.equal(huge.status, 413);

    const valid = await handleBuildPlanAlertCollection(context(
      db,
      jsonRequest(url, 'POST', {
        version: 2, trigger: 'baseline_delta_percent', threshold: 10, baselineVersion: 1,
      }, 'handler-alert-valid-1'),
      OWNER_A,
      { planId: firstPlan },
    ));
    assert.equal(valid.status, 201);
    const data = (await valid.json() as { data: { id: string; status: string } }).data;
    assert.equal(data.status, 'inactive');
    assert.match(data.id, /^alert_/);

    const remove = () => handleBuildPlanAlertResource(context(
      db,
      jsonRequest(`${url}/${data.id}`, 'DELETE', undefined, 'handler-alert-delete-1'),
      OWNER_A,
      { planId: firstPlan, alertId: data.id },
    ));
    const deleted = await Promise.all([remove(), remove()]);
    assert.deepEqual(deleted.map((response) => response.status), [200, 200]);
    assert.deepEqual(
      deleted.map((response) => response.headers.get('idempotency-replayed')).sort(),
      ['false', 'true'],
    );
    const differentKey = await handleBuildPlanAlertResource(context(
      db,
      jsonRequest(`${url}/${data.id}`, 'DELETE', undefined, 'handler-alert-delete-2'),
      OWNER_A,
      { planId: firstPlan, alertId: data.id },
    ));
    assert.equal(differentKey.status, 404);
  });
});

describe('server-confirmed operation measurement', () => {
  test('emits only after successful share and inactive-alert saves and stays best-effort', async () => {
    const db = new SqliteD1();
    const firstPlan = planId(50);
    seedPlan(db, OWNER_A, firstPlan, 2);
    const enabled = { BUILD_SHARE_TOKEN_SECRET: SHARE_SECRET, PRODUCT_INTENTS_ENABLED: 'true' };

    const shareUrl = `https://solvency.dev/api/build-plans/${firstPlan}/shares`;
    const shared = await handleBuildPlanShareCollection(context(
      db,
      jsonRequest(shareUrl, 'POST', {
        version: 1, expiresInDays: 7, allowQuoteExport: true,
      }, 'intent-share-create-01'),
      OWNER_A,
      { planId: firstPlan },
      enabled,
    ));
    assert.equal(shared.status, 201);

    const alertUrl = `https://solvency.dev/api/build-plans/${firstPlan}/alerts`;
    const alert = await handleBuildPlanAlertCollection(context(
      db,
      jsonRequest(alertUrl, 'POST', {
        version: 1, trigger: 'model_price_change', threshold: null, baselineVersion: null,
      }, 'intent-alert-create-01'),
      OWNER_A,
      { planId: firstPlan },
      enabled,
    ));
    assert.equal(alert.status, 201);
    const alertBody = await alert.json() as { data: { id: string } };
    const operationSignals = db.sqlite.prepare(
      'SELECT event_name FROM product_intent_events WHERE owner_user_id = ? ORDER BY event_name',
    ).all(OWNER_A) as Array<{ event_name: string }>;
    assert.deepEqual(operationSignals.map((row) => row.event_name), [
      'alert_setting_saved', 'share_created',
    ]);

    db.sqlite.prepare(
      "DELETE FROM product_intent_events WHERE owner_user_id = ? AND event_name = 'alert_setting_saved'",
    ).run(OWNER_A);
    const updated = await handleBuildPlanAlertResource(context(
      db,
      jsonRequest(`${alertUrl}/${alertBody.data.id}`, 'POST', {
        version: 2, trigger: 'monthly_spend_above', threshold: 250, baselineVersion: null,
      }, 'intent-alert-update-01'),
      OWNER_A,
      { planId: firstPlan, alertId: alertBody.data.id },
      enabled,
    ));
    assert.equal(updated.status, 201);
    assert.equal(db.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM product_intent_events WHERE event_name = 'alert_setting_saved'",
    ).get()?.count, 1);

    db.sqlite.prepare('DELETE FROM product_intent_events').run();
    const rejected = await handleBuildPlanShareCollection(context(
      db,
      jsonRequest(shareUrl, 'POST', {
        version: 99, expiresInDays: 7, allowQuoteExport: true,
      }, 'intent-share-reject-01'),
      OWNER_A,
      { planId: firstPlan },
      enabled,
    ));
    assert.equal(rejected.status, 404);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM product_intent_events').get()?.count, 0);

    const degraded = new SqliteD1();
    const degradedPlan = planId(51);
    seedPlan(degraded, OWNER_A, degradedPlan, 1);
    const unavailable = rejectProductIntentQueries(degraded);
    const shareStillSucceeds = await handleBuildPlanShareCollection(context(
      unavailable,
      jsonRequest(`https://solvency.dev/api/build-plans/${degradedPlan}/shares`, 'POST', {
        version: 1, expiresInDays: null, allowQuoteExport: false,
      }, 'intent-share-degraded-1'),
      OWNER_A,
      { planId: degradedPlan },
      enabled,
    ));
    assert.equal(shareStillSucceeds.status, 201);
    const alertStillSucceeds = await handleBuildPlanAlertCollection(context(
      unavailable,
      jsonRequest(`https://solvency.dev/api/build-plans/${degradedPlan}/alerts`, 'POST', {
        version: 1, trigger: 'model_price_change', threshold: null, baselineVersion: null,
      }, 'intent-alert-degraded-1'),
      OWNER_A,
      { planId: degradedPlan },
      enabled,
    ));
    assert.equal(alertStillSucceeds.status, 201);
    assert.equal(degraded.sqlite.prepare('SELECT COUNT(*) AS count FROM build_plan_shares').get()?.count, 1);
    assert.equal(degraded.sqlite.prepare('SELECT COUNT(*) AS count FROM build_plan_alert_settings').get()?.count, 1);
    assert.equal(degraded.sqlite.prepare('SELECT COUNT(*) AS count FROM product_intent_events').get()?.count, 0);
  });
});

describe('operation quotas, retention and cascades', () => {
  test('enforces hard per-plan and per-owner share/alert quotas plus duplicate uniqueness', () => {
    assert.equal(MAX_BUILD_PLAN_SHARES_PER_PLAN, 20);
    assert.equal(MAX_BUILD_PLAN_SHARES_PER_OWNER, 100);
    assert.equal(MAX_BUILD_PLAN_ALERTS_PER_PLAN, 20);
    assert.equal(MAX_BUILD_PLAN_ALERTS_PER_OWNER, 100);

    const planQuota = new SqliteD1();
    const crowdedPlan = planId(100);
    seedPlan(planQuota, OWNER_A, crowdedPlan, 21);
    for (let version = 1; version <= MAX_BUILD_PLAN_SHARES_PER_PLAN; version += 1) {
      planQuota.sqlite.prepare(
        `INSERT INTO build_plan_shares
         (id, owner_user_id, plan_id, version, token_hash, allow_quote_export, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, 1, NULL, ?)`,
      ).run(shareId(100 + version), OWNER_A, crowdedPlan, version, hashFor(100 + version), NOW);
    }
    assert.throws(() => planQuota.sqlite.prepare(
      `INSERT INTO build_plan_shares
       (id, owner_user_id, plan_id, version, token_hash, allow_quote_export, expires_at, created_at)
       VALUES (?, ?, ?, 21, ?, 1, NULL, ?)`,
    ).run(shareId(999), OWNER_A, crowdedPlan, hashFor(999), NOW), /PLAN_SHARE_LIMIT/);

    for (let threshold = 1; threshold <= MAX_BUILD_PLAN_ALERTS_PER_PLAN; threshold += 1) {
      planQuota.sqlite.prepare(
        `INSERT INTO build_plan_alert_settings
         (id, owner_user_id, plan_id, version, trigger_type, threshold, baseline_version,
          status, created_at, updated_at)
         VALUES (?, ?, ?, 1, 'monthly_spend_above', ?, NULL, 'inactive', ?, ?)`,
      ).run(alertId(100 + threshold), OWNER_A, crowdedPlan, threshold, NOW, NOW);
    }
    assert.throws(() => planQuota.sqlite.prepare(
      `INSERT INTO build_plan_alert_settings
       (id, owner_user_id, plan_id, version, trigger_type, threshold, baseline_version,
        status, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'monthly_spend_above', 21, NULL, 'inactive', ?, ?)`,
    ).run(alertId(999), OWNER_A, crowdedPlan, NOW, NOW), /PLAN_ALERT_LIMIT/);
    assert.throws(() => planQuota.sqlite.prepare(
      `INSERT INTO build_plan_alert_settings
       (id, owner_user_id, plan_id, version, trigger_type, threshold, baseline_version,
        status, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'monthly_spend_above', 1, NULL, 'inactive', ?, ?)`,
    ).run(alertId(998), OWNER_A, crowdedPlan, NOW, NOW));

    const ownerQuota = new SqliteD1();
    for (let planIndex = 0; planIndex < 6; planIndex += 1) {
      seedPlan(ownerQuota, OWNER_A, planId(200 + planIndex), 20);
    }
    for (let planIndex = 0; planIndex < 5; planIndex += 1) {
      for (let version = 1; version <= 20; version += 1) {
        const index = 2_000 + planIndex * 20 + version;
        ownerQuota.sqlite.prepare(
          `INSERT INTO build_plan_shares
           (id, owner_user_id, plan_id, version, token_hash, allow_quote_export, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, 0, NULL, ?)`,
        ).run(shareId(index), OWNER_A, planId(200 + planIndex), version, hashFor(index), NOW);
        ownerQuota.sqlite.prepare(
          `INSERT INTO build_plan_alert_settings
           (id, owner_user_id, plan_id, version, trigger_type, threshold, baseline_version,
            status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'monthly_spend_above', ?, NULL, 'inactive', ?, ?)`,
        ).run(alertId(index), OWNER_A, planId(200 + planIndex), version, index, NOW, NOW);
      }
    }
    assert.throws(() => ownerQuota.sqlite.prepare(
      `INSERT INTO build_plan_shares
       (id, owner_user_id, plan_id, version, token_hash, allow_quote_export, expires_at, created_at)
       VALUES (?, ?, ?, 1, ?, 0, NULL, ?)`,
    ).run(shareId(9_000), OWNER_A, planId(205), hashFor(9_000), NOW), /OWNER_SHARE_LIMIT/);
    assert.throws(() => ownerQuota.sqlite.prepare(
      `INSERT INTO build_plan_alert_settings
       (id, owner_user_id, plan_id, version, trigger_type, threshold, baseline_version,
        status, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'monthly_spend_above', 999999, NULL, 'inactive', ?, ?)`,
    ).run(alertId(9_000), OWNER_A, planId(205), NOW, NOW), /OWNER_ALERT_LIMIT/);
  });

  test('prunes expired idempotency records on mutation and bounds replay to 24 hours', () => {
    const db = new SqliteD1();
    const firstPlan = planId(300);
    seedPlan(db, OWNER_A, firstPlan, 1);
    assert.equal(OPERATION_IDEMPOTENCY_REPLAY_WINDOW_MS, 86_400_000);
    db.sqlite.prepare(
      `INSERT INTO build_plan_operation_requests
       (owner_user_id, operation, idempotency_key, request_hash, plan_id,
        resource_type, resource_id, result_kind, created_at, expires_at)
       VALUES (?, 'alert.delete:old', 'expired-idempotency-1', ?, ?, 'alert', ?, 'deleted', ?, ?)`,
    ).run(OWNER_A, hashFor(1), firstPlan, alertId(1), NOW, '2026-08-24T12:00:00.000Z');
    db.sqlite.prepare(
      `INSERT INTO build_plan_operation_requests
       (owner_user_id, operation, idempotency_key, request_hash, plan_id,
        resource_type, resource_id, result_kind, created_at, expires_at)
       VALUES (?, 'alert.delete:new', 'current-idempotency-1', ?, ?, 'alert', ?, 'deleted', ?, ?)`,
    ).run(
      OWNER_A, hashFor(2), firstPlan, alertId(2), '2026-08-25T12:00:00.000Z',
      '2026-08-26T12:00:00.000Z',
    );
    const rows = db.sqlite.prepare(
      'SELECT idempotency_key FROM build_plan_operation_requests ORDER BY idempotency_key',
    ).all() as Array<{ idempotency_key: string }>;
    assert.deepEqual(rows.map((row) => row.idempotency_key), ['current-idempotency-1']);
  });

  test('uses durable receipts when D1 change counts include expired-receipt pruning', async () => {
    const db = new SqliteD1(true);
    const firstPlan = planId(350);
    seedPlan(db, OWNER_A, firstPlan, 2);
    const seedExpiredReceipt = (index: number) => {
      db.sqlite.prepare(
        `INSERT INTO build_plan_operation_requests
           (owner_user_id, operation, idempotency_key, request_hash, plan_id,
            resource_type, resource_id, result_kind, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'alert', ?, 'deleted', ?, ?)`,
      ).run(
        OWNER_A, `alert.delete:expired-${index}`, `expired-receipt-${String(index).padStart(4, '0')}`,
        hashFor(8_000 + index), firstPlan, alertId(8_000 + index),
        '2026-08-20T12:00:00.000Z', '2026-08-21T12:00:00.000Z',
      );
    };

    seedExpiredReceipt(1);
    const shared = await createShare(db, { planId: firstPlan, shareIndex: 350, now: NOW });
    assert.equal(shared.result.ok, true);
    if (shared.result.ok) assert.equal(shared.result.replayed, false);

    seedExpiredReceipt(2);
    const alert = await createAlert(db, {
      planId: firstPlan, alertIndex: 350, trigger: 'monthly_spend_above', threshold: 250, now: NOW,
    });
    assert.equal(alert.ok, true);
    if (alert.ok) assert.equal(alert.replayed, false);
    if (!alert.ok || !shared.result.ok) return;

    seedExpiredReceipt(3);
    const updated = await updateOwnedBuildPlanAlert(db, {
      ownerUserId: OWNER_A, planId: firstPlan, alertId: alert.resource.id, version: 2,
      trigger: 'monthly_spend_change_percent', threshold: 15, baselineVersion: null,
      idempotencyKey: 'prune-alert-update-1', requestHash: hashFor(8_103), now: LATER,
    });
    assert.equal(updated.ok && !updated.replayed, true);

    seedExpiredReceipt(4);
    assert.deepEqual(await revokeOwnedBuildPlanShare(db, {
      ownerUserId: OWNER_A, planId: firstPlan, shareId: shared.result.resource.id,
      idempotencyKey: 'prune-share-revoke-1', requestHash: hashFor(8_104), now: LATER,
    }), { ok: true, replayed: false });

    seedExpiredReceipt(5);
    assert.deepEqual(await deleteOwnedBuildPlanAlert(db, {
      ownerUserId: OWNER_A, planId: firstPlan, alertId: alert.resource.id,
      idempotencyKey: 'prune-alert-delete-1', requestHash: hashFor(8_105), now: LATER,
    }), { ok: true, replayed: false });
  });

  test('classifies a same-key concurrent revoke or delete loser as replayed', async () => {
    const db = new BarrierSqliteD1(true);
    const firstPlan = planId(375);
    seedPlan(db, OWNER_A, firstPlan, 2);
    const shared = await createShare(db, { planId: firstPlan, shareIndex: 375, now: NOW });
    const alert = await createAlert(db, {
      planId: firstPlan, alertIndex: 375, trigger: 'monthly_spend_above', threshold: 250, now: NOW,
    });
    assert.equal(shared.result.ok, true);
    assert.equal(alert.ok, true);
    if (!shared.result.ok || !alert.ok) return;

    const revokeInput = {
      ownerUserId: OWNER_A, planId: firstPlan, shareId: shared.result.resource.id,
      idempotencyKey: 'concurrent-share-revoke-1', requestHash: hashFor(8_375), now: LATER,
    };
    db.armBatchBarrier();
    const revoked = await Promise.all([
      revokeOwnedBuildPlanShare(db, revokeInput),
      revokeOwnedBuildPlanShare(db, revokeInput),
    ]);
    assert.deepEqual(revoked.map((result) => result.ok && result.replayed).sort(), [false, true]);

    const deleteInput = {
      ownerUserId: OWNER_A, planId: firstPlan, alertId: alert.resource.id,
      idempotencyKey: 'concurrent-alert-delete-1', requestHash: hashFor(8_376), now: LATER,
    };
    db.armBatchBarrier();
    const deleted = await Promise.all([
      deleteOwnedBuildPlanAlert(db, deleteInput),
      deleteOwnedBuildPlanAlert(db, deleteInput),
    ]);
    assert.deepEqual(deleted.map((result) => result.ok && result.replayed).sort(), [false, true]);
  });

  test('plan deletion cascades shares, inactive alerts and their idempotency records', async () => {
    const db = new SqliteD1();
    const firstPlan = planId(400);
    seedPlan(db, OWNER_A, firstPlan, 2);
    assert.equal((await createShare(db, { planId: firstPlan, shareIndex: 400 })).result.ok, true);
    assert.equal((await createAlert(db, {
      planId: firstPlan, alertIndex: 400, version: 2,
      trigger: 'baseline_delta_percent', threshold: 5, baselineVersion: 1,
    })).ok, true);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM build_plan_operation_requests').get()?.count, 2);
    db.sqlite.prepare('DELETE FROM build_plans WHERE id = ? AND owner_user_id = ?').run(firstPlan, OWNER_A);
    for (const table of [
      'build_plan_shares', 'build_plan_alert_settings', 'build_plan_operation_requests',
      'build_plan_versions',
    ]) {
      assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, 0, table);
    }
  });

  test('Cloudflare routes only API and the exact public share subtree through Functions', () => {
    const routes = JSON.parse(readFileSync(
      new URL('../site/public/_routes.json', import.meta.url), 'utf8',
    )) as { include: string[]; exclude: string[] };
    assert.deepEqual(routes.include, ['/api/*', '/shared-build-plans/*']);
    assert.deepEqual(routes.exclude, []);
    const example = readFileSync(new URL('../site/.dev.vars.example', import.meta.url), 'utf8');
    const placeholder = /^BUILD_SHARE_TOKEN_SECRET=(.*)$/m.exec(example)?.[1];
    assert.equal(validBuildPlanShareSecret(placeholder), false);
  });
});
