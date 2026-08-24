import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { deleteOwnedAccountData } from '../site/src/lib/server/account-data-store.ts';
import {
  acquireCheckoutAttempt,
  completeCheckoutAttempt,
  settleReconciledCheckoutSubscription,
} from '../site/src/lib/server/checkout-attempt-store.ts';
import { handleEntitlement } from '../site/src/lib/server/entitlement-api.ts';
import {
  applyVerifiedBillingEvent,
  BILLING_EVENT_RETENTION_SECONDS,
  bindBillingCustomer,
  getBoundBillingCustomerId,
  getOwnerEntitlement,
  normalizeBillingPriceItems,
  type ProPriceConfiguration,
  type VerifiedBillingEvent,
  type VerifiedBillingPriceItem,
} from '../site/src/lib/server/entitlement-store.ts';
import type {
  D1DatabaseLike, D1PreparedStatementLike, D1ResultLike, PagesContextLike,
} from '../site/src/lib/server/pages-types.ts';

const migration = [
  '../site/migrations/0001_build_plans.sql',
  '../site/migrations/0002_build_plan_invariants.sql',
  '../site/migrations/0003_build_plan_rate_limits.sql',
  '../site/migrations/0004_billing_authority.sql',
  '../site/migrations/0005_build_plan_operations.sql',
  '../site/migrations/0006_product_intent_events.sql',
  '../site/migrations/0007_billing_checkout_attempts.sql',
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

const NOW = 1_787_486_400;
const RECEIVED = NOW + 5;
const MONTHLY_PRICE_ID = 'price_0000000000000001';
const ANNUAL_PRICE_ID = 'price_0000000000000002';
const CHECKOUT_HASH_A = 'c'.repeat(64);
const CHECKOUT_HASH_B = 'd'.repeat(64);
const CHECKOUT_SESSION_A = 'cs_test_0000000000000091';
const PRO_PRICES: ProPriceConfiguration = {
  monthlyPriceId: MONTHLY_PRICE_ID,
  annualPriceId: ANNUAL_PRICE_ID,
};

const MONTHLY_PRICE_ITEM: VerifiedBillingPriceItem = {
  priceId: MONTHLY_PRICE_ID,
  quantity: 1,
  currency: 'usd',
  interval: 'month',
};

function event(overrides: Partial<VerifiedBillingEvent> = {}): VerifiedBillingEvent {
  return {
    eventId: 'evt_0000000000000001',
    eventType: 'customer.subscription.updated',
    payloadHash: 'a'.repeat(64),
    customerId: 'cus_0000000000000001',
    subscriptionId: 'sub_0000000000000001',
    priceItems: [MONTHLY_PRICE_ITEM],
    status: 'active',
    currentPeriodEnd: NOW + 3_600,
    cancelAtPeriodEnd: false,
    eventCreated: NOW,
    ...overrides,
  };
}

function entitlement(db: D1DatabaseLike, ownerUserId: string, now = NOW) {
  return getOwnerEntitlement(db, ownerUserId, now, PRO_PRICES);
}

async function prepareReadyCheckout(
  db: SqliteD1,
  ownerUserId = 'user_account_alpha',
  requestHash = CHECKOUT_HASH_A,
  providerSessionId = CHECKOUT_SESSION_A,
  startedAt = NOW - 4_000,
) {
  const acquired = await acquireCheckoutAttempt(db, {
    ownerUserId,
    requestHash,
    now: startedAt,
  });
  if (!acquired.ok || acquired.status !== 'acquired') {
    throw new Error('Checkout test setup failed to acquire.');
  }
  const completed = await completeCheckoutAttempt(db, {
    ownerUserId,
    requestHash,
    now: startedAt + 1,
    leaseToken: acquired.leaseToken,
    providerSessionId,
  });
  if (!completed.ok) throw new Error('Checkout test setup failed to complete.');
  return acquired;
}

async function acquirePreparedReconciliation(
  db: SqliteD1,
  lockExpiresAt: number,
  requestHash = CHECKOUT_HASH_A,
) {
  const reconciliation = await acquireCheckoutAttempt(db, {
    ownerUserId: 'user_account_alpha',
    requestHash,
    now: lockExpiresAt,
  });
  if (!reconciliation.ok || reconciliation.status !== 'reconcile') {
    throw new Error('Checkout test setup failed to reconcile.');
  }
  return reconciliation;
}

function apiContext(
  db: D1DatabaseLike,
  ownerUserId: string,
  url = 'https://solvency.dev/api/entitlement',
  includePrices = true,
): PagesContextLike {
  return {
    request: new Request(url),
    env: {
      DB: db,
      ...(includePrices ? {
        STRIPE_PRO_MONTHLY_PRICE_ID: MONTHLY_PRICE_ID,
        STRIPE_PRO_ANNUAL_PRICE_ID: ANNUAL_PRICE_ID,
      } : {}),
    },
    params: {},
    data: { ownerUserId, requestId: 'req-entitlement' },
    next: async () => new Response(null, { status: 404 }),
  };
}

describe('server-authoritative entitlement boundary', () => {
  test('defaults closed for absent, expired and malformed state', async () => {
    const db = new SqliteD1();
    assert.deepEqual(await entitlement(db, 'user_account_alpha'), {
      tier: 'free', active: false, source: 'none', status: 'none',
      currentPeriodEnd: null, cancelAtPeriodEnd: false,
    });

    const malformed = {
      prepare() {
        return {
          bind() { return this; },
          async first() {
            return {
              owner_user_id: 'user_account_alpha', provider_customer_id: 'not-a-customer',
              provider_subscription_id: 'sub_0000000000000001', status: 'active',
              provider_price_id: MONTHLY_PRICE_ID, provider_price_quantity: 1,
              provider_price_currency: 'usd', provider_price_interval: 'month',
              current_period_end: NOW + 3_600, cancel_at_period_end: 0,
              last_event_created: NOW, last_event_id: 'evt_0000000000000001',
            };
          },
        };
      },
    } as D1DatabaseLike;
    assert.equal((await entitlement(malformed, 'user_account_alpha')).tier, 'free');

    await bindBillingCustomer(db, 'user_account_alpha', 'cus_0000000000000001', '2026-08-23T12:00:00.000Z');
    await applyVerifiedBillingEvent(db, event({ currentPeriodEnd: NOW - 1 }), RECEIVED);
    const expired = await entitlement(db, 'user_account_alpha');
    assert.equal(expired.tier, 'free');
    assert.equal(expired.status, 'active');
    assert.equal(expired.source, 'stripe');
  });

  test('exposes only the verified owner entitlement and no provider identifiers', async () => {
    const db = new SqliteD1();
    const futurePeriodEnd = 2_000_000_000;
    await bindBillingCustomer(db, 'user_account_alpha', 'cus_0000000000000001', '2026-08-23T12:00:00.000Z');
    assert.deepEqual(await applyVerifiedBillingEvent(db, event({ currentPeriodEnd: futurePeriodEnd }), RECEIVED), {
      ok: true, ownerUserId: 'user_account_alpha', replayed: false, applied: true,
    });
    const response = await handleEntitlement(apiContext(db, 'user_account_alpha'));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const raw = await response.text();
    assert.doesNotMatch(raw, /cus_|sub_|evt_|price_/);
    const parsed = JSON.parse(raw) as { data: { tier: string; active: boolean } };
    assert.deepEqual(parsed.data, {
      tier: 'pro', active: true, source: 'stripe', status: 'active',
      currentPeriodEnd: new Date(futurePeriodEnd * 1000).toISOString(), cancelAtPeriodEnd: false,
    });

    const foreign = await handleEntitlement(apiContext(db, 'user_account_beta'));
    assert.equal((await foreign.json() as { data: { tier: string } }).data.tier, 'free');
    const dark = await handleEntitlement(apiContext(db, 'user_account_alpha', undefined, false));
    assert.equal((await dark.json() as { data: { tier: string; active: boolean } }).data.tier, 'free');
    assert.equal((await handleEntitlement(apiContext(db, 'user_account_alpha', 'https://solvency.dev/api/entitlement?owner=user_account_beta'))).status, 400);
  });

  test('requires one exact configured Pro price with expected quantity, currency and interval', async () => {
    async function evaluate(
      priceItems: VerifiedBillingEvent['priceItems'],
      configuration: ProPriceConfiguration = PRO_PRICES,
      status: VerifiedBillingEvent['status'] = 'active',
    ) {
      const db = new SqliteD1();
      await bindBillingCustomer(db, 'user_account_alpha', 'cus_0000000000000001', '2026-08-23T12:00:00.000Z');
      const result = await applyVerifiedBillingEvent(db, event({ priceItems, status }), RECEIVED);
      assert.equal(result.ok && result.applied, true);
      return {
        db,
        value: await getOwnerEntitlement(db, 'user_account_alpha', NOW, configuration),
      };
    }

    assert.equal((await evaluate([MONTHLY_PRICE_ITEM])).value.tier, 'pro');
    assert.equal((await evaluate([{
      priceId: ANNUAL_PRICE_ID, quantity: 1, currency: 'usd', interval: 'year',
    }], PRO_PRICES, 'trialing')).value.tier, 'pro');

    const absent = await evaluate([]);
    assert.equal(absent.value.tier, 'free');
    assert.equal(absent.value.active, false);
    assert.equal(absent.db.sqlite.prepare(
      'SELECT provider_price_id FROM billing_subscriptions',
    ).get()?.provider_price_id, null);

    const malformed = await evaluate([{
      priceId: 'not-a-price', quantity: 1, currency: 'USD', interval: 'month',
    } as VerifiedBillingPriceItem]);
    assert.equal(malformed.value.tier, 'free');
    assert.equal(malformed.db.sqlite.prepare(
      'SELECT provider_price_id FROM billing_events',
    ).get()?.provider_price_id, null);

    const mixedItems = [
      MONTHLY_PRICE_ITEM,
      { priceId: 'price_0000000000000099', quantity: 1, currency: 'usd', interval: 'month' },
    ] as const;
    assert.equal(normalizeBillingPriceItems(mixedItems), null);
    const mixed = await evaluate(mixedItems);
    assert.equal(mixed.value.tier, 'free');
    assert.equal(mixed.db.sqlite.prepare(
      'SELECT provider_price_id FROM billing_subscriptions',
    ).get()?.provider_price_id, null);

    const unknownPriceId = 'price_0000000000000098';
    const unknown = await evaluate([{
      ...MONTHLY_PRICE_ITEM, priceId: unknownPriceId,
    }]);
    assert.equal(unknown.value.tier, 'free');
    assert.deepEqual({ ...unknown.db.sqlite.prepare(
      `SELECT provider_price_id, provider_price_quantity,
              provider_price_currency, provider_price_interval
         FROM billing_subscriptions`,
    ).get() }, {
      provider_price_id: unknownPriceId,
      provider_price_quantity: 1,
      provider_price_currency: 'usd',
      provider_price_interval: 'month',
    });

    assert.equal((await evaluate([{ ...MONTHLY_PRICE_ITEM, quantity: 2 }])).value.tier, 'free');
    assert.equal((await evaluate([{ ...MONTHLY_PRICE_ITEM, currency: 'eur' }])).value.tier, 'free');
    assert.equal((await evaluate([{ ...MONTHLY_PRICE_ITEM, interval: 'year' }])).value.tier, 'free');
    assert.equal((await evaluate([MONTHLY_PRICE_ITEM], {})).value.tier, 'free');
    assert.equal((await evaluate([MONTHLY_PRICE_ITEM], { monthlyPriceId: MONTHLY_PRICE_ID })).value.tier, 'free');
    assert.equal((await evaluate([MONTHLY_PRICE_ITEM], {
      monthlyPriceId: 'bad', annualPriceId: ANNUAL_PRICE_ID,
    })).value.tier, 'free');
    assert.equal((await evaluate([MONTHLY_PRICE_ITEM], {
      monthlyPriceId: MONTHLY_PRICE_ID, annualPriceId: MONTHLY_PRICE_ID,
    })).value.tier, 'free');
  });

  test('binds provider customers idempotently and rejects cross-owner reassignment', async () => {
    const db = new SqliteD1();
    const at = '2026-08-23T12:00:00.000Z';
    assert.equal(await bindBillingCustomer(db, 'user_account_alpha', 'cus_0000000000000001', at), 'bound');
    assert.equal(await bindBillingCustomer(db, 'user_account_alpha', 'cus_0000000000000001', at), 'replayed');
    assert.equal(await bindBillingCustomer(db, 'user_account_beta', 'cus_0000000000000001', at), 'identity_conflict');
    assert.equal(await bindBillingCustomer(db, 'user_account_alpha', 'cus_0000000000000002', at), 'identity_conflict');
    assert.equal(await bindBillingCustomer(db, 'attacker', 'cus_0000000000000003', at), 'invalid');
    assert.equal(await getBoundBillingCustomerId(db, 'user_account_alpha'), 'cus_0000000000000001');
    assert.equal(await getBoundBillingCustomerId(db, 'user_account_beta'), null);
    assert.equal(await getBoundBillingCustomerId(db, 'attacker'), null);
  });

  test('deduplicates events and rejects event-id reuse with different content', async () => {
    const db = new SqliteD1();
    await bindBillingCustomer(db, 'user_account_alpha', 'cus_0000000000000001', '2026-08-23T12:00:00.000Z');
    const first = event();
    assert.equal((await applyVerifiedBillingEvent(db, first, RECEIVED)).ok, true);
    assert.deepEqual(await applyVerifiedBillingEvent(db, first, RECEIVED), {
      ok: true, ownerUserId: 'user_account_alpha', replayed: true, applied: false,
    });
    assert.deepEqual(await applyVerifiedBillingEvent(db, { ...first, payloadHash: 'b'.repeat(64) }, RECEIVED), {
      ok: false, reason: 'idempotency_conflict',
    });
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM billing_events').get()?.count, 1);
  });

  test('ignores stale and same-time permissive events while applying revocation and recovery in order', async () => {
    const db = new SqliteD1();
    await bindBillingCustomer(db, 'user_account_alpha', 'cus_0000000000000001', '2026-08-23T12:00:00.000Z');
    await applyVerifiedBillingEvent(db, event(), RECEIVED);
    const stale = await applyVerifiedBillingEvent(db, event({
      eventId: 'evt_0000000000000002', payloadHash: 'b'.repeat(64), status: 'canceled',
      eventCreated: NOW - 1,
    }), RECEIVED + 1);
    assert.deepEqual(stale, { ok: true, ownerUserId: 'user_account_alpha', replayed: false, applied: false });
    assert.equal((await entitlement(db, 'user_account_alpha')).tier, 'pro');

    const revoked = await applyVerifiedBillingEvent(db, event({
      eventId: 'evt_0000000000000003', payloadHash: 'c'.repeat(64), status: 'canceled',
      eventCreated: NOW + 10,
    }), RECEIVED + 10);
    assert.equal(revoked.ok && revoked.applied, true);
    assert.equal((await entitlement(db, 'user_account_alpha')).tier, 'free');

    const sameTimeActive = await applyVerifiedBillingEvent(db, event({
      eventId: 'evt_0000000000000004', payloadHash: 'd'.repeat(64), status: 'active',
      eventCreated: NOW + 10,
    }), RECEIVED + 11);
    assert.equal(sameTimeActive.ok && sameTimeActive.applied, false);
    assert.equal((await entitlement(db, 'user_account_alpha')).tier, 'free');

    const recovered = await applyVerifiedBillingEvent(db, event({
      eventId: 'evt_0000000000000005', payloadHash: 'e'.repeat(64), status: 'active',
      eventCreated: NOW + 20,
    }), RECEIVED + 20);
    assert.equal(recovered.ok && recovered.applied, true);
    assert.equal((await entitlement(db, 'user_account_alpha')).tier, 'pro');
  });

  test('same-second status ties apply only monotonic restrictions', async () => {
    const db = new SqliteD1();
    await bindBillingCustomer(db, 'user_account_alpha', 'cus_0000000000000001', '2026-08-23T12:00:00.000Z');
    await applyVerifiedBillingEvent(db, event({ currentPeriodEnd: NOW + 3_600 }), RECEIVED);

    const shorter = await applyVerifiedBillingEvent(db, event({
      eventId: 'evt_0000000000000011', payloadHash: 'b'.repeat(64),
      currentPeriodEnd: NOW + 1_800,
    }), RECEIVED + 1);
    assert.equal(shorter.ok && shorter.applied, true);

    const longer = await applyVerifiedBillingEvent(db, event({
      eventId: 'evt_0000000000000012', payloadHash: 'c'.repeat(64),
      currentPeriodEnd: NOW + 7_200,
    }), RECEIVED + 2);
    assert.equal(longer.ok && longer.applied, false);

    const canceling = await applyVerifiedBillingEvent(db, event({
      eventId: 'evt_0000000000000013', payloadHash: 'd'.repeat(64),
      currentPeriodEnd: NOW + 1_800, cancelAtPeriodEnd: true,
    }), RECEIVED + 3);
    assert.equal(canceling.ok && canceling.applied, true);

    const uncanceling = await applyVerifiedBillingEvent(db, event({
      eventId: 'evt_0000000000000014', payloadHash: 'e'.repeat(64),
      currentPeriodEnd: NOW + 1_200, cancelAtPeriodEnd: false,
    }), RECEIVED + 4);
    assert.equal(uncanceling.ok && uncanceling.applied, false);
    assert.deepEqual({ ...db.sqlite.prepare(
      `SELECT current_period_end, cancel_at_period_end
         FROM billing_subscriptions`,
    ).get() }, { current_period_end: NOW + 1_800, cancel_at_period_end: 1 });

    const unknownPrice = await applyVerifiedBillingEvent(db, event({
      eventId: 'evt_0000000000000015', payloadHash: 'f'.repeat(64),
      currentPeriodEnd: NOW + 7_200, cancelAtPeriodEnd: false,
      priceItems: [{ ...MONTHLY_PRICE_ITEM, priceId: 'price_0000000000000098' }],
    }), RECEIVED + 5);
    assert.equal(unknownPrice.ok && unknownPrice.applied, true);
    assert.equal((await entitlement(db, 'user_account_alpha')).tier, 'free');
    assert.deepEqual({ ...db.sqlite.prepare(
      `SELECT provider_price_id, current_period_end, cancel_at_period_end
         FROM billing_subscriptions`,
    ).get() }, {
      provider_price_id: null,
      current_period_end: NOW + 1_800,
      cancel_at_period_end: 1,
    });

    const priceRestore = await applyVerifiedBillingEvent(db, event({
      eventId: 'evt_0000000000000016', payloadHash: '0'.repeat(64),
      currentPeriodEnd: NOW + 1_800, cancelAtPeriodEnd: true,
    }), RECEIVED + 6);
    assert.equal(priceRestore.ok && priceRestore.applied, true);
    assert.equal(db.sqlite.prepare(
      'SELECT provider_price_id FROM billing_subscriptions',
    ).get()?.provider_price_id, null);

    const newerRestore = await applyVerifiedBillingEvent(db, event({
      eventId: 'evt_0000000000000017', payloadHash: '1'.repeat(64),
      currentPeriodEnd: NOW + 3_600, eventCreated: NOW + 1,
    }), RECEIVED + 7);
    assert.equal(newerRestore.ok && newerRestore.applied, true);
    assert.equal((await entitlement(db, 'user_account_alpha')).tier, 'pro');

    const unknownFirst = new SqliteD1();
    await bindBillingCustomer(unknownFirst, 'user_account_alpha', 'cus_0000000000000001', '2026-08-23T12:00:00.000Z');
    await applyVerifiedBillingEvent(unknownFirst, event({
      priceItems: [{ ...MONTHLY_PRICE_ITEM, priceId: 'price_0000000000000098' }],
    }), RECEIVED);
    assert.equal((await entitlement(unknownFirst, 'user_account_alpha')).tier, 'free');
    const sameSecondAllowed = await applyVerifiedBillingEvent(unknownFirst, event({
      eventId: 'evt_0000000000000018', payloadHash: '2'.repeat(64),
    }), RECEIVED + 1);
    assert.equal(sameSecondAllowed.ok && sameSecondAllowed.applied, true);
    assert.equal((await entitlement(unknownFirst, 'user_account_alpha')).tier, 'free');
    assert.equal(unknownFirst.sqlite.prepare(
      'SELECT provider_price_id FROM billing_subscriptions',
    ).get()?.provider_price_id, null);
  });

  test('derives ownership from the bound customer and blocks subscription collisions', async () => {
    const db = new SqliteD1();
    const at = '2026-08-23T12:00:00.000Z';
    await bindBillingCustomer(db, 'user_account_alpha', 'cus_0000000000000001', at);
    await bindBillingCustomer(db, 'user_account_beta', 'cus_0000000000000002', at);
    assert.deepEqual(await applyVerifiedBillingEvent(db, event({ customerId: 'cus_0000000000000999' })), {
      ok: false, reason: 'customer_not_found',
    });
    await applyVerifiedBillingEvent(db, event(), RECEIVED);
    const collision = await applyVerifiedBillingEvent(db, event({
      eventId: 'evt_0000000000000099', payloadHash: 'f'.repeat(64),
      customerId: 'cus_0000000000000002',
    }), RECEIVED + 1);
    assert.deepEqual(collision, { ok: false, reason: 'identity_conflict' });
    const sameOwnerCollision = event({
      eventId: 'evt_0000000000000100', payloadHash: '0'.repeat(64),
      subscriptionId: 'sub_0000000000000100', eventCreated: NOW + 2,
    });
    assert.deepEqual(await applyVerifiedBillingEvent(db, sameOwnerCollision, RECEIVED + 2), {
      ok: false, reason: 'identity_conflict',
    });
    assert.deepEqual(await applyVerifiedBillingEvent(db, sameOwnerCollision, RECEIVED + 3), {
      ok: false, reason: 'identity_conflict',
    });
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM billing_events').get()?.count, 1);
    assert.equal((await entitlement(db, 'user_account_beta')).tier, 'free');

    const unpaid = new SqliteD1();
    await bindBillingCustomer(
      unpaid, 'user_account_alpha', 'cus_0000000000000001', at,
    );
    assert.equal((await applyVerifiedBillingEvent(unpaid, event({ status: 'unpaid' }), RECEIVED)).ok, true);
    assert.deepEqual(await applyVerifiedBillingEvent(unpaid, event({
      eventId: 'evt_0000000000000101',
      payloadHash: '1'.repeat(64),
      subscriptionId: 'sub_0000000000000101',
      status: 'active',
      eventCreated: NOW + 3,
    }), RECEIVED + 3), { ok: false, reason: 'identity_conflict' });
    assert.equal(unpaid.sqlite.prepare(
      'SELECT provider_subscription_id FROM billing_subscriptions',
    ).get()?.provider_subscription_id, 'sub_0000000000000001');
  });

  test('retires only the exact subscription-bound pending receipt after authoritative terminal state', async () => {
    const db = new SqliteD1();
    const ownerUserId = 'user_account_alpha';
    const customerId = 'cus_0000000000000001';
    const subscriptionId = 'sub_0000000000000001';
    await bindBillingCustomer(db, ownerUserId, customerId, '2026-08-23T12:00:00.000Z');
    const first = await prepareReadyCheckout(db);
    const reconciliation = await acquirePreparedReconciliation(db, first.lockExpiresAt);
    assert.deepEqual(await settleReconciledCheckoutSubscription(db, {
      ownerUserId,
      requestHash: CHECKOUT_HASH_A,
      reconciliationToken: reconciliation.reconciliationToken,
      providerSessionId: CHECKOUT_SESSION_A,
      providerCustomerId: customerId,
      providerSubscriptionId: subscriptionId,
      terminalRecovery: false,
      providerExpiresAt: reconciliation.providerExpiresAt,
      now: reconciliation.lockExpiresAt - 29,
    }), { ok: true, status: 'pending_webhook' });
    assert.deepEqual({ ...db.sqlite.prepare(
      `SELECT state, provider_subscription_id
         FROM billing_checkout_attempts WHERE owner_user_id = ?`,
    ).get(ownerUserId) }, {
      state: 'completed_pending_webhook',
      provider_subscription_id: subscriptionId,
    });

    const active = event({ customerId, subscriptionId });
    assert.equal((await applyVerifiedBillingEvent(db, active, RECEIVED)).ok, true);
    assert.equal(db.sqlite.prepare(
      'SELECT state FROM billing_checkout_attempts WHERE owner_user_id = ?',
    ).get(ownerUserId)?.state, 'completed_pending_webhook');

    assert.equal((await applyVerifiedBillingEvent(db, event({
      eventId: 'evt_0000000000000200',
      payloadHash: '1'.repeat(64),
      customerId,
      subscriptionId,
      status: 'unpaid',
      eventCreated: NOW + 5,
    }), RECEIVED + 5)).ok, true);
    assert.equal(db.sqlite.prepare(
      'SELECT state FROM billing_checkout_attempts WHERE owner_user_id = ?',
    ).get(ownerUserId)?.state, 'completed_pending_webhook');

    const terminal = event({
      eventId: 'evt_0000000000000201',
      payloadHash: '2'.repeat(64),
      eventType: 'customer.subscription.deleted',
      customerId,
      subscriptionId,
      status: 'canceled',
      eventCreated: NOW + 10,
    });
    const terminated = await applyVerifiedBillingEvent(db, terminal, RECEIVED + 10);
    assert.equal(terminated.ok && terminated.applied, true);
    assert.equal(db.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM billing_checkout_attempts WHERE owner_user_id = ?',
    ).get(ownerUserId)?.count, 0);

    const next = await acquireCheckoutAttempt(db, {
      ownerUserId,
      requestHash: CHECKOUT_HASH_B,
      now: NOW + 20,
    });
    assert.equal(next.ok && next.status, 'acquired');
    assert.ok(next.ok && next.status === 'acquired');
    assert.notEqual(next.leaseToken, first.leaseToken);

    assert.deepEqual(await applyVerifiedBillingEvent(db, terminal, RECEIVED + 11), {
      ok: true, ownerUserId, replayed: true, applied: false,
    });
    assert.deepEqual({ ...db.sqlite.prepare(
      `SELECT request_hash, lease_token, state, provider_subscription_id
         FROM billing_checkout_attempts WHERE owner_user_id = ?`,
    ).get(ownerUserId) }, {
      request_hash: CHECKOUT_HASH_B,
      lease_token: next.leaseToken,
      state: 'creating',
      provider_subscription_id: null,
    });
  });

  test('terminal authority received before reconciliation atomically permits a fresh generation', async () => {
    const db = new SqliteD1();
    const ownerUserId = 'user_account_alpha';
    const customerId = 'cus_0000000000000001';
    const subscriptionId = 'sub_0000000000000001';
    await bindBillingCustomer(db, ownerUserId, customerId, '2026-08-23T12:00:00.000Z');
    const first = await prepareReadyCheckout(
      db, ownerUserId, CHECKOUT_HASH_A, CHECKOUT_SESSION_A, NOW,
    );
    assert.equal((await applyVerifiedBillingEvent(db, event(), RECEIVED)).ok, true);
    assert.equal((await applyVerifiedBillingEvent(db, event({
      eventId: 'evt_0000000000000211',
      payloadHash: '3'.repeat(64),
      eventType: 'customer.subscription.deleted',
      status: 'canceled',
      eventCreated: NOW + 10,
    }), RECEIVED + 10)).ok, true);
    assert.equal(db.sqlite.prepare(
      'SELECT state FROM billing_checkout_attempts WHERE owner_user_id = ?',
    ).get(ownerUserId)?.state, 'ready');

    const reconciliation = await acquirePreparedReconciliation(db, first.lockExpiresAt);
    const settled = await settleReconciledCheckoutSubscription(db, {
      ownerUserId,
      requestHash: CHECKOUT_HASH_B,
      reconciliationToken: reconciliation.reconciliationToken,
      providerSessionId: CHECKOUT_SESSION_A,
      providerCustomerId: customerId,
      providerSubscriptionId: subscriptionId,
      terminalRecovery: false,
      providerExpiresAt: reconciliation.providerExpiresAt,
      now: reconciliation.lockExpiresAt - 29,
    });
    assert.equal(settled.ok && settled.status, 'acquired');
    assert.ok(settled.ok && settled.status === 'acquired');
    assert.notEqual(settled.leaseToken, first.leaseToken);
    assert.deepEqual({ ...db.sqlite.prepare(
      `SELECT request_hash, lease_token, state, provider_session_id, provider_subscription_id
         FROM billing_checkout_attempts WHERE owner_user_id = ?`,
    ).get(ownerUserId) }, {
      request_hash: CHECKOUT_HASH_B,
      lease_token: settled.leaseToken,
      state: 'creating',
      provider_session_id: null,
      provider_subscription_id: null,
    });
  });

  test('terminal state changing after reconciliation lease is observed by the single settlement CAS', async () => {
    const db = new SqliteD1();
    const ownerUserId = 'user_account_alpha';
    const customerId = 'cus_0000000000000001';
    const subscriptionId = 'sub_0000000000000001';
    await bindBillingCustomer(db, ownerUserId, customerId, '2026-08-23T12:00:00.000Z');
    const first = await prepareReadyCheckout(
      db, ownerUserId, CHECKOUT_HASH_A, CHECKOUT_SESSION_A, NOW,
    );
    assert.equal((await applyVerifiedBillingEvent(db, event(), RECEIVED)).ok, true);
    const reconciliation = await acquirePreparedReconciliation(db, first.lockExpiresAt);
    assert.equal((await applyVerifiedBillingEvent(db, event({
      eventId: 'evt_0000000000000221',
      payloadHash: '4'.repeat(64),
      eventType: 'customer.subscription.deleted',
      status: 'canceled',
      eventCreated: first.lockExpiresAt,
    }), first.lockExpiresAt + 1)).ok, true);

    const settled = await settleReconciledCheckoutSubscription(db, {
      ownerUserId,
      requestHash: CHECKOUT_HASH_B,
      reconciliationToken: reconciliation.reconciliationToken,
      providerSessionId: CHECKOUT_SESSION_A,
      providerCustomerId: customerId,
      providerSubscriptionId: subscriptionId,
      terminalRecovery: false,
      providerExpiresAt: reconciliation.providerExpiresAt,
      now: reconciliation.lockExpiresAt - 29,
    });
    assert.equal(settled.ok && settled.status, 'acquired');
    assert.equal(db.sqlite.prepare(
      'SELECT state FROM billing_checkout_attempts WHERE owner_user_id = ?',
    ).get(ownerUserId)?.state, 'creating');
  });

  test('an aged ready receipt gets one exact reconciliation path after later terminal authority', async () => {
    const db = new SqliteD1();
    const ownerUserId = 'user_account_alpha';
    const customerId = 'cus_0000000000000001';
    const subscriptionId = 'sub_0000000000000001';
    await bindBillingCustomer(db, ownerUserId, customerId, '2026-08-23T12:00:00.000Z');
    const first = await prepareReadyCheckout(
      db, ownerUserId, CHECKOUT_HASH_A, CHECKOUT_SESSION_A, NOW,
    );
    assert.equal((await applyVerifiedBillingEvent(db, event(), RECEIVED)).ok, true);
    const agedAt = first.providerExpiresAt + 72 * 60 * 60;
    assert.equal((await applyVerifiedBillingEvent(db, event({
      eventId: 'evt_0000000000000241',
      payloadHash: '8'.repeat(64),
      eventType: 'customer.subscription.deleted',
      status: 'canceled',
      eventCreated: agedAt - 10,
    }), agedAt - 5)).ok, true);

    const reconciliation = await acquireCheckoutAttempt(db, {
      ownerUserId,
      requestHash: CHECKOUT_HASH_B,
      now: agedAt,
    });
    assert.equal(reconciliation.ok && reconciliation.status, 'reconcile');
    assert.ok(reconciliation.ok && reconciliation.status === 'reconcile');
    assert.equal(reconciliation.terminalRecovery, true);
    const settled = await settleReconciledCheckoutSubscription(db, {
      ownerUserId,
      requestHash: CHECKOUT_HASH_B,
      reconciliationToken: reconciliation.reconciliationToken,
      providerSessionId: CHECKOUT_SESSION_A,
      providerCustomerId: customerId,
      providerSubscriptionId: subscriptionId,
      providerExpiresAt: reconciliation.providerExpiresAt,
      terminalRecovery: true,
      now: agedAt + 1,
    });
    assert.equal(settled.ok && settled.status, 'acquired');
    assert.equal(db.sqlite.prepare(
      'SELECT state FROM billing_checkout_attempts WHERE owner_user_id = ?',
    ).get(ownerUserId)?.state, 'creating');
  });

  test('an aged terminal recovery quarantines a mismatched retrieved subscription', async () => {
    const db = new SqliteD1();
    const ownerUserId = 'user_account_alpha';
    const customerId = 'cus_0000000000000001';
    await bindBillingCustomer(db, ownerUserId, customerId, '2026-08-23T12:00:00.000Z');
    const first = await prepareReadyCheckout(
      db, ownerUserId, CHECKOUT_HASH_A, CHECKOUT_SESSION_A, NOW,
    );
    const agedAt = first.providerExpiresAt + 72 * 60 * 60;
    assert.equal((await applyVerifiedBillingEvent(db, event({
      eventId: 'evt_0000000000000251',
      payloadHash: '9'.repeat(64),
      eventType: 'customer.subscription.deleted',
      status: 'canceled',
      eventCreated: agedAt - 10,
    }), agedAt - 5)).ok, true);
    const reconciliation = await acquireCheckoutAttempt(db, {
      ownerUserId,
      requestHash: CHECKOUT_HASH_B,
      now: agedAt,
    });
    assert.ok(reconciliation.ok && reconciliation.status === 'reconcile');
    assert.equal(reconciliation.terminalRecovery, true);
    assert.deepEqual(await settleReconciledCheckoutSubscription(db, {
      ownerUserId,
      requestHash: CHECKOUT_HASH_B,
      reconciliationToken: reconciliation.reconciliationToken,
      providerSessionId: CHECKOUT_SESSION_A,
      providerCustomerId: customerId,
      providerSubscriptionId: 'sub_0000000000000099',
      providerExpiresAt: reconciliation.providerExpiresAt,
      terminalRecovery: true,
      now: agedAt + 1,
    }), { ok: true, status: 'manual_review' });
    assert.deepEqual({ ...db.sqlite.prepare(
      `SELECT state, provider_session_id, provider_subscription_id
         FROM billing_checkout_attempts WHERE owner_user_id = ?`,
    ).get(ownerUserId) }, {
      state: 'manual_review',
      provider_session_id: CHECKOUT_SESSION_A,
      provider_subscription_id: null,
    });
  });

  test('stale and foreign terminal events cannot clear an exact newer subscription binding', async () => {
    const db = new SqliteD1();
    const ownerUserId = 'user_account_alpha';
    const customerId = 'cus_0000000000000001';
    const subscriptionId = 'sub_0000000000000001';
    await bindBillingCustomer(db, ownerUserId, customerId, '2026-08-23T12:00:00.000Z');
    await bindBillingCustomer(db, 'user_account_beta', 'cus_0000000000000002', '2026-08-23T12:00:00.000Z');
    const first = await prepareReadyCheckout(db);
    const reconciliation = await acquirePreparedReconciliation(db, first.lockExpiresAt);
    assert.equal((await settleReconciledCheckoutSubscription(db, {
      ownerUserId,
      requestHash: CHECKOUT_HASH_A,
      reconciliationToken: reconciliation.reconciliationToken,
      providerSessionId: CHECKOUT_SESSION_A,
      providerCustomerId: customerId,
      providerSubscriptionId: subscriptionId,
      terminalRecovery: false,
      providerExpiresAt: reconciliation.providerExpiresAt,
      now: reconciliation.lockExpiresAt - 29,
    })).ok, true);

    const oldTerminal = event({
      eventId: 'evt_0000000000000231',
      payloadHash: '5'.repeat(64),
      eventType: 'customer.subscription.deleted',
      subscriptionId: 'sub_0000000000000002',
      status: 'canceled',
    });
    assert.equal((await applyVerifiedBillingEvent(db, oldTerminal, RECEIVED)).ok, true);
    assert.equal(db.sqlite.prepare(
      'SELECT state FROM billing_checkout_attempts WHERE owner_user_id = ?',
    ).get(ownerUserId)?.state, 'completed_pending_webhook');

    assert.equal((await applyVerifiedBillingEvent(db, event({
      eventId: 'evt_0000000000000232',
      payloadHash: '6'.repeat(64),
      subscriptionId,
      eventCreated: NOW + 10,
    }), RECEIVED + 10)).ok, true);
    assert.deepEqual(await applyVerifiedBillingEvent(db, oldTerminal, RECEIVED + 11), {
      ok: true, ownerUserId, replayed: true, applied: false,
    });
    assert.deepEqual(await applyVerifiedBillingEvent(db, event({
      eventId: 'evt_0000000000000233',
      payloadHash: '7'.repeat(64),
      customerId: 'cus_0000000000000002',
      subscriptionId,
      status: 'canceled',
      eventCreated: NOW + 20,
    }), RECEIVED + 20), { ok: false, reason: 'identity_conflict' });
    assert.deepEqual({ ...db.sqlite.prepare(
      `SELECT state, provider_subscription_id
         FROM billing_checkout_attempts WHERE owner_user_id = ?`,
    ).get(ownerUserId) }, {
      state: 'completed_pending_webhook',
      provider_subscription_id: subscriptionId,
    });
  });

  test('prunes normalized replay rows by age without retaining raw payloads', async () => {
    const db = new SqliteD1();
    await bindBillingCustomer(db, 'user_account_alpha', 'cus_0000000000000001', '2026-08-23T12:00:00.000Z');
    await applyVerifiedBillingEvent(db, event({ eventCreated: 1, currentPeriodEnd: NOW + 3_600 }), 2);
    await applyVerifiedBillingEvent(db, event({
      eventId: 'evt_0000000000000002', payloadHash: 'b'.repeat(64),
      eventCreated: BILLING_EVENT_RETENTION_SECONDS + 10,
      currentPeriodEnd: NOW + 7_200,
    }), BILLING_EVENT_RETENTION_SECONDS + 20);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM billing_events').get()?.count, 1);
    const columns = db.sqlite.prepare('PRAGMA table_info(billing_events)').all().map((row) => row.name);
    assert.equal(columns.includes('payload_json'), false);
    assert.equal(columns.includes('payload_hash'), true);
    assert.throws(() => db.sqlite.prepare(
      `UPDATE billing_events SET payload_hash = ? WHERE provider_event_id = ?`,
    ).run('f'.repeat(64), 'evt_0000000000000002'), /IMMUTABLE_BILLING_EVENT/);
  });

  test('rejects malformed normalized events without throwing or writing', async () => {
    const db = new SqliteD1();
    for (const hostile of [
      null,
      { ...event(), eventId: 'bad' },
      { ...event(), payloadHash: 'A'.repeat(64) },
      { ...event(), status: 'free' },
      new Proxy({}, { get() { throw new Error('hostile'); } }),
    ]) {
      assert.deepEqual(await applyVerifiedBillingEvent(db, hostile as VerifiedBillingEvent, RECEIVED), { ok: false, reason: 'invalid' });
    }
    assert.deepEqual(await applyVerifiedBillingEvent(db, event(), NOW - 1), { ok: false, reason: 'invalid' });
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM billing_events').get()?.count, 0);
  });

  test('rejects provider events outside the subscription lifecycle reducer', async () => {
    const db = new SqliteD1();
    await bindBillingCustomer(db, 'user_account_alpha', 'cus_0000000000000001', '2026-08-23T12:00:00.000Z');
    for (const eventType of ['invoice.paid', 'checkout.session.completed', 'customer.subscription.paused']) {
      assert.deepEqual(await applyVerifiedBillingEvent(db, event({ eventType }), RECEIVED), {
        ok: false, reason: 'invalid',
      });
    }
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM billing_events').get()?.count, 0);
  });

  test('requires deleted-subscription events to carry canceled state in store and schema', async () => {
    const db = new SqliteD1();
    await bindBillingCustomer(db, 'user_account_alpha', 'cus_0000000000000001', '2026-08-23T12:00:00.000Z');
    assert.deepEqual(await applyVerifiedBillingEvent(db, event({
      eventType: 'customer.subscription.deleted',
      status: 'active',
    }), RECEIVED), { ok: false, reason: 'invalid' });
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM billing_events').get()?.count, 0);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM billing_subscriptions').get()?.count, 0);

    const rawEvent = db.sqlite.prepare(
      `INSERT INTO billing_events
         (provider_event_id, payload_hash, event_type, owner_user_id,
          provider_customer_id, provider_subscription_id, provider_price_id,
          provider_price_quantity, provider_price_currency, provider_price_interval,
          subscription_status, current_period_end, cancel_at_period_end,
          event_created, received_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 0, ?, ?)`,
    );
    assert.throws(() => rawEvent.run(
      'evt_0000000000000090', '9'.repeat(64), 'customer.subscription.deleted',
      'user_account_alpha', 'cus_0000000000000001', 'sub_0000000000000001',
      'active', NOW + 3_600, NOW, RECEIVED,
    ), /CHECK constraint failed/);
    assert.throws(() => rawEvent.run(
      'evt_0000000000000092', '7'.repeat(64), 'invoice.paid',
      'user_account_alpha', 'cus_0000000000000001', 'sub_0000000000000001',
      'canceled', NOW + 3_600, NOW, RECEIVED,
    ), /CHECK constraint failed/);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM billing_events').get()?.count, 0);

    const deleted = await applyVerifiedBillingEvent(db, event({
      eventId: 'evt_0000000000000091',
      payloadHash: '8'.repeat(64),
      eventType: 'customer.subscription.deleted',
      status: 'canceled',
    }), RECEIVED);
    assert.equal(deleted.ok && deleted.applied, true);
    assert.equal((await entitlement(db, 'user_account_alpha')).tier, 'free');
  });
});

describe('account-data erasure', () => {
  test('atomically removes every owner-keyed record and preserves another owner', async () => {
    const db = new SqliteD1();
    const at = '2026-08-23T12:00:00.000Z';
    for (const [owner, customer, suffix] of [
      ['user_account_alpha', 'cus_0000000000000001', '1'],
      ['user_account_beta', 'cus_0000000000000002', '2'],
    ] as const) {
      await bindBillingCustomer(db, owner, customer, at);
      await applyVerifiedBillingEvent(db, event({
        eventId: `evt_000000000000000${suffix}`,
        payloadHash: suffix.repeat(64),
        customerId: customer,
        subscriptionId: `sub_000000000000000${suffix}`,
      }), RECEIVED);
      db.sqlite.prepare(
        `INSERT INTO build_plans
           (id, owner_user_id, display_name, current_version, created_at, updated_at)
         VALUES (?, ?, 'Plan', 0, ?, ?)`,
      ).run(`plan_000000000000000${suffix}`, owner, at, at);
      db.sqlite.prepare(
        `INSERT INTO build_plan_versions
           (id, plan_id, version, plan_name, plan_schema_version, quote_engine_version,
            plan_json, quote_json, quoted_at, created_at)
         VALUES (?, ?, 1, 'Plan', 1, 'build-cost-v1', '{}', '{}', ?, ?)`,
      ).run(`version_000000000000${suffix}`, `plan_000000000000000${suffix}`, at, at);
      const shareId = `share_${suffix.repeat(8)}-${suffix.repeat(4)}-4${suffix.repeat(3)}-8${suffix.repeat(3)}-${suffix.repeat(12)}`;
      const alertId = `alert_${suffix.repeat(8)}-${suffix.repeat(4)}-4${suffix.repeat(3)}-8${suffix.repeat(3)}-${suffix.repeat(12)}`;
      db.sqlite.prepare(
        `INSERT INTO build_plan_shares
           (id, owner_user_id, plan_id, version, token_hash, allow_quote_export, expires_at, created_at)
         VALUES (?, ?, ?, 1, ?, 0, NULL, ?)`,
      ).run(shareId, owner, `plan_000000000000000${suffix}`, suffix.repeat(64), at);
      db.sqlite.prepare(
        `INSERT INTO build_plan_alert_settings
           (id, owner_user_id, plan_id, version, trigger_type, threshold, baseline_version,
            status, created_at, updated_at)
         VALUES (?, ?, ?, 1, 'model_price_change', NULL, NULL, 'inactive', ?, ?)`,
      ).run(alertId, owner, `plan_000000000000000${suffix}`, at, at);
      db.sqlite.prepare(
        `INSERT INTO build_plan_operation_requests
           (owner_user_id, operation, idempotency_key, request_hash, plan_id,
            resource_type, resource_id, result_kind, created_at, expires_at)
         VALUES (?, 'share.create:test', ?, ?, ?, 'share', ?, 'created', ?, ?)`,
      ).run(
        owner, `operation-key-000${suffix}`, suffix.repeat(64),
        `plan_000000000000000${suffix}`, shareId, at, '2026-08-24T12:00:00.000Z',
      );
      db.sqlite.prepare(
        `INSERT INTO build_plan_rate_limits (owner_user_id, window_bucket, request_count)
         VALUES (?, 1, 1)`,
      ).run(owner);
      db.sqlite.prepare(
        `INSERT INTO product_intent_events
           (owner_user_id, event_id, event_name, recorded_at, expires_at)
         VALUES (?, ?, 'planner_started', ?, ?)`,
      ).run(
        owner,
        `0000000${suffix}-0000-4000-8000-00000000000${suffix}`,
        NOW,
        NOW + 90 * 24 * 60 * 60,
      );
    }

    const failingBatch: D1DatabaseLike = {
      prepare: (query) => db.prepare(query),
      async batch<T>(statements: D1PreparedStatementLike[]): Promise<Array<D1ResultLike<T>>> {
        db.sqlite.exec('BEGIN IMMEDIATE');
        try {
          for (const statement of statements.slice(0, 4)) await statement.run<T>();
          throw new Error('forced batch failure');
        } catch (cause) {
          db.sqlite.exec('ROLLBACK');
          throw cause;
        }
      },
    };
    await assert.rejects(() => deleteOwnedAccountData(failingBatch, 'user_account_alpha'), /forced batch failure/);
    for (const table of [
      'product_intent_events',
      'billing_events', 'billing_subscriptions', 'billing_customers',
      'build_plan_operation_requests', 'build_plan_alert_settings', 'build_plan_shares',
      'build_plans', 'build_plan_rate_limits',
    ]) {
      assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE owner_user_id = ?`).get('user_account_alpha')?.count, 1);
    }
    assert.equal(db.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM build_plan_versions WHERE plan_id = ?',
    ).get('plan_0000000000000001')?.count, 1);
    assert.equal(db.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM build_plan_versions WHERE plan_id = ?',
    ).get('plan_0000000000000002')?.count, 1);

    await deleteOwnedAccountData(db, 'user_account_alpha');
    for (const table of [
      'product_intent_events',
      'billing_events', 'billing_subscriptions', 'billing_customers',
      'build_plan_operation_requests', 'build_plan_alert_settings', 'build_plan_shares',
      'build_plans', 'build_plan_rate_limits',
    ]) {
      assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE owner_user_id = ?`).get('user_account_alpha')?.count, 0);
      assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE owner_user_id = ?`).get('user_account_beta')?.count, 1);
    }
    assert.equal(db.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM build_plan_versions WHERE plan_id = ?',
    ).get('plan_0000000000000001')?.count, 0);
    assert.equal(db.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM build_plan_versions WHERE plan_id = ?',
    ).get('plan_0000000000000002')?.count, 1);
    await deleteOwnedAccountData(db, 'user_account_alpha');
    await assert.rejects(() => deleteOwnedAccountData(db, 'not_verified'));
  });
});
