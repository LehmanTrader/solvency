import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { deleteOwnedAccountData } from '../site/src/lib/server/account-data-store.ts';
import {
  acquireCheckoutAttempt,
  CHECKOUT_CREATING_LOCK_SECONDS,
  CHECKOUT_PROVIDER_EXPIRY_SECONDS,
  CHECKOUT_RECONCILIATION_BACKOFF_SECONDS,
  CHECKOUT_RECONCILIATION_LEASE_SECONDS,
  CHECKOUT_RECONCILIATION_MAX_AGE_SECONDS,
  completeCheckoutAttempt,
  deferCheckoutReconciliation,
  replaceReconciledCheckoutAttempt,
  releaseCheckoutAttempt,
  settleReconciledCheckoutSubscription,
  type AcquireCheckoutAttemptInput,
} from '../site/src/lib/server/checkout-attempt-store.ts';
import type {
  D1DatabaseLike, D1PreparedStatementLike, D1ResultLike,
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

interface Barrier {
  remaining: number;
  promise: Promise<void>;
  release: () => void;
}

class SqliteStatement implements D1PreparedStatementLike {
  private readonly database: DatabaseSync;
  private readonly beforeAll: (query: string) => Promise<void>;
  readonly query: string;
  readonly values: unknown[];

  constructor(
    database: DatabaseSync,
    query: string,
    values: unknown[] = [],
    beforeAll: (query: string) => Promise<void> = async () => undefined,
  ) {
    this.database = database;
    this.query = query;
    this.values = values;
    this.beforeAll = beforeAll;
  }

  bind(...values: unknown[]): D1PreparedStatementLike {
    return new SqliteStatement(this.database, this.query, values, this.beforeAll);
  }

  async first<T>(): Promise<T | null> {
    return (this.database.prepare(this.query).get(...this.values) as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1ResultLike<T>> {
    await this.beforeAll(this.query);
    return { success: true, results: this.database.prepare(this.query).all(...this.values) as T[] };
  }

  async run<T>(): Promise<D1ResultLike<T>> {
    const result = this.database.prepare(this.query).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
}

class SqliteD1 implements D1DatabaseLike {
  readonly sqlite = new DatabaseSync(':memory:');
  private acquireBarrier: Barrier | null = null;
  private beforeAllInterleave: { fragment: string; action: () => void } | null = null;

  constructor() {
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    this.sqlite.exec(migration);
  }

  armAcquireBarrier(participants = 2): void {
    let release = () => undefined;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    this.acquireBarrier = { remaining: participants, promise, release };
  }

  armBeforeAllInterleave(fragment: string, action: () => void): void {
    this.beforeAllInterleave = { fragment, action };
  }

  private readonly beforeAll = async (query: string): Promise<void> => {
    const interleave = this.beforeAllInterleave;
    if (interleave && query.includes(interleave.fragment)) {
      this.beforeAllInterleave = null;
      interleave.action();
    }
    const barrier = this.acquireBarrier;
    if (!barrier || !query.includes('INSERT INTO billing_checkout_attempts')) return;
    barrier.remaining -= 1;
    if (barrier.remaining === 0) {
      this.acquireBarrier = null;
      barrier.release();
    }
    await barrier.promise;
  };

  prepare(query: string): D1PreparedStatementLike {
    return new SqliteStatement(this.sqlite, query, [], this.beforeAll);
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

const OWNER_A = 'user_checkout_alpha';
const OWNER_B = 'user_checkout_bravo';
const CUSTOMER_A = 'cus_0000000000000001';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const SESSION_A = 'cs_test_0000000000000001';
const SESSION_B = 'cs_test_0000000000000002';
const SUBSCRIPTION_A = 'sub_0000000000000001';
const NOW = 1_787_572_800;

function seedCustomer(db: SqliteD1, ownerUserId = OWNER_A, suffix = '0001'): void {
  db.sqlite.prepare(
    `INSERT INTO billing_customers
       (owner_user_id, provider_customer_id, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(
    ownerUserId,
    `cus_000000000000${suffix}`,
    '2026-08-24T12:00:00.000Z',
    '2026-08-24T12:00:00.000Z',
  );
}

function seedSubscription(
  db: SqliteD1,
  status: 'active' | 'canceled' | 'incomplete_expired',
): void {
  db.sqlite.prepare(
    `INSERT INTO billing_subscriptions
       (owner_user_id, provider_customer_id, provider_subscription_id,
        provider_price_id, provider_price_quantity, provider_price_currency,
        provider_price_interval, status, current_period_end,
        cancel_at_period_end, last_event_created, last_event_id, updated_at)
     VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, 0, ?, ?, ?)`,
  ).run(
    OWNER_A,
    CUSTOMER_A,
    SUBSCRIPTION_A,
    status,
    NOW,
    NOW,
    'evt_0000000000000091',
    '2026-08-24T12:00:00.000Z',
  );
}

function acquireInput(overrides: Partial<AcquireCheckoutAttemptInput> = {}): AcquireCheckoutAttemptInput {
  return { ownerUserId: OWNER_A, requestHash: HASH_A, now: NOW, ...overrides };
}

function expectAcquired(
  value: Awaited<ReturnType<typeof acquireCheckoutAttempt>>,
): Extract<Awaited<ReturnType<typeof acquireCheckoutAttempt>>, { ok: true; status: 'acquired' }> {
  assert.equal(value.ok, true);
  assert.equal(value.ok && value.status, 'acquired');
  return value as Extract<typeof value, { ok: true; status: 'acquired' }>;
}

describe('durable Checkout attempt store', () => {
  test('migration stores no hosted URL and cascades the one owner row with its billing customer', async () => {
    const db = new SqliteD1();
    const columns = db.sqlite.prepare('PRAGMA table_info(billing_checkout_attempts)').all() as Array<{ name: string }>;
    assert.deepEqual(columns.map(({ name }) => name), [
      'owner_user_id', 'request_hash', 'lease_token', 'reconciliation_token', 'state', 'provider_session_id',
      'provider_subscription_id', 'provider_expires_at', 'lock_expires_at',
    ]);
    assert.equal(columns.some(({ name }) => name.includes('url')), false);

    seedCustomer(db);
    expectAcquired(await acquireCheckoutAttempt(db, acquireInput()));
    await deleteOwnedAccountData(db, OWNER_A);
    const remaining = db.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM billing_checkout_attempts WHERE owner_user_id = ?',
    ).get(OWNER_A) as { count: number };
    assert.equal(remaining.count, 0);
    assert.equal((db.sqlite.prepare(
      'SELECT COUNT(*) AS count FROM billing_customers WHERE owner_user_id = ?',
    ).get(OWNER_A) as { count: number }).count, 0);
  });

  test('acquires a random lease with the persisted 32-minute provider and 35-minute lock expiries', async () => {
    const db = new SqliteD1();
    seedCustomer(db);
    const acquired = expectAcquired(await acquireCheckoutAttempt(db, acquireInput()));
    assert.match(acquired.leaseToken, /^[a-f0-9-]{36}$/);
    assert.equal(acquired.providerExpiresAt, NOW + CHECKOUT_PROVIDER_EXPIRY_SECONDS);
    assert.equal(acquired.lockExpiresAt, NOW + CHECKOUT_CREATING_LOCK_SECONDS);
    assert.equal(acquired.lockExpiresAt - acquired.providerExpiresAt, 180);

    const row = db.sqlite.prepare(
      `SELECT request_hash, state, provider_session_id, provider_expires_at, lock_expires_at
         FROM billing_checkout_attempts WHERE owner_user_id = ?`,
    ).get(OWNER_A) as Record<string, unknown>;
    assert.deepEqual({ ...row }, {
      request_hash: HASH_A,
      state: 'creating',
      provider_session_id: null,
      provider_expires_at: acquired.providerExpiresAt,
      lock_expires_at: acquired.lockExpiresAt,
    });
  });

  test('atomically permits only one creating attempt across concurrent request hashes', async () => {
    const db = new SqliteD1();
    seedCustomer(db);
    db.armAcquireBarrier();
    const results = await Promise.all([
      acquireCheckoutAttempt(db, acquireInput({ requestHash: HASH_A })),
      acquireCheckoutAttempt(db, acquireInput({ requestHash: HASH_B })),
    ]);
    assert.deepEqual(results.map((value) => (
      value.ok ? value.status : value.reason
    )).sort(), ['acquired', 'active_request']);
    const count = db.sqlite.prepare('SELECT COUNT(*) AS count FROM billing_checkout_attempts').get() as { count: number };
    assert.equal(count.count, 1);
  });

  test('atomically gives concurrent same-hash callers one lease and one creating response', async () => {
    const db = new SqliteD1();
    seedCustomer(db);
    db.armAcquireBarrier();
    const results = await Promise.all([
      acquireCheckoutAttempt(db, acquireInput()),
      acquireCheckoutAttempt(db, acquireInput()),
    ]);
    assert.deepEqual(results.map((value) => (
      value.ok ? value.status : value.reason
    )).sort(), ['acquired', 'creating']);
    const acquired = results.find((value) => value.ok && value.status === 'acquired');
    assert.ok(acquired && acquired.ok && acquired.status === 'acquired');
    const stored = db.sqlite.prepare(
      'SELECT lease_token FROM billing_checkout_attempts WHERE owner_user_id = ?',
    ).get(OWNER_A) as { lease_token: string };
    assert.equal(stored.lease_token, acquired.leaseToken);
  });

  test('completes only the matching live lease and replays the durable provider receipt', async () => {
    const db = new SqliteD1();
    seedCustomer(db);
    const acquired = expectAcquired(await acquireCheckoutAttempt(db, acquireInput()));
    const completeInput = {
      ...acquireInput({ now: NOW + 10 }),
      leaseToken: acquired.leaseToken,
      providerSessionId: SESSION_A,
    };
    assert.deepEqual(await completeCheckoutAttempt(db, completeInput), {
      ok: true, replayed: false, providerExpiresAt: acquired.providerExpiresAt,
    });
    assert.deepEqual(await completeCheckoutAttempt(db, completeInput), {
      ok: true, replayed: true, providerExpiresAt: acquired.providerExpiresAt,
    });
    assert.deepEqual(await acquireCheckoutAttempt(db, acquireInput({ now: NOW + 20 })), {
      ok: true,
      status: 'ready',
      leaseToken: acquired.leaseToken,
      providerSessionId: SESSION_A,
      providerExpiresAt: acquired.providerExpiresAt,
      lockExpiresAt: acquired.lockExpiresAt,
    });
    assert.deepEqual(await acquireCheckoutAttempt(db, acquireInput({
      requestHash: HASH_B, now: NOW + 20,
    })), { ok: false, reason: 'active_request' });

    assert.deepEqual(await completeCheckoutAttempt(db, {
      ...completeInput, leaseToken: '00000000-0000-4000-8000-000000000001',
    }), { ok: false, reason: 'conflict' });
    assert.deepEqual(await completeCheckoutAttempt(db, {
      ...completeInput, requestHash: HASH_B,
    }), { ok: false, reason: 'conflict' });
    assert.deepEqual(await completeCheckoutAttempt(db, {
      ...completeInput, providerSessionId: SESSION_B,
    }), { ok: false, reason: 'conflict' });
  });

  test('keeps a lost-success creating lease through its grace and sends it to manual review', async () => {
    const db = new SqliteD1();
    seedCustomer(db);
    const first = expectAcquired(await acquireCheckoutAttempt(db, acquireInput()));
    assert.deepEqual(await acquireCheckoutAttempt(db, acquireInput({
      requestHash: HASH_B,
      now: first.providerExpiresAt,
    })), { ok: false, reason: 'active_request' });
    assert.deepEqual(await acquireCheckoutAttempt(db, acquireInput({
      requestHash: HASH_B,
      now: first.lockExpiresAt - 1,
    })), { ok: false, reason: 'active_request' });
    assert.deepEqual(await acquireCheckoutAttempt(db, acquireInput({
      requestHash: HASH_B,
      now: first.lockExpiresAt,
    })), { ok: false, reason: 'manual_review' });
    assert.deepEqual({ ...db.sqlite.prepare(
      'SELECT lease_token, state FROM billing_checkout_attempts WHERE owner_user_id = ?',
    ).get(OWNER_A) }, { lease_token: first.leaseToken, state: 'manual_review' });
  });

  test('blocks an expired ready receipt through grace, then CASes exact reconciliation and replacement', async () => {
    const db = new SqliteD1();
    seedCustomer(db);
    const first = expectAcquired(await acquireCheckoutAttempt(db, acquireInput()));
    assert.equal((await completeCheckoutAttempt(db, {
      ...acquireInput({ now: NOW + 1 }),
      leaseToken: first.leaseToken,
      providerSessionId: SESSION_A,
    })).ok, true);
    assert.deepEqual(await acquireCheckoutAttempt(db, acquireInput({
      requestHash: HASH_B,
      now: first.providerExpiresAt - 1,
    })), { ok: false, reason: 'active_request' });
    assert.deepEqual(await acquireCheckoutAttempt(db, acquireInput({
      requestHash: HASH_B,
      now: first.providerExpiresAt,
    })), { ok: false, reason: 'active_request' });
    assert.deepEqual(await acquireCheckoutAttempt(db, acquireInput({
      now: first.providerExpiresAt,
    })), { ok: false, reason: 'creating' });

    const reconciliation = await acquireCheckoutAttempt(db, acquireInput({
      requestHash: HASH_B,
      now: first.lockExpiresAt,
    }));
    assert.equal(reconciliation.ok && reconciliation.status, 'reconcile');
    assert.ok(reconciliation.ok && reconciliation.status === 'reconcile');
    assert.equal(reconciliation.leaseToken, first.leaseToken);
    assert.equal(reconciliation.providerSessionId, SESSION_A);
    assert.equal(reconciliation.lockExpiresAt, first.lockExpiresAt + CHECKOUT_RECONCILIATION_LEASE_SECONDS);

    const concurrent = await acquireCheckoutAttempt(db, acquireInput({
      requestHash: HASH_B,
      now: first.lockExpiresAt,
    }));
    assert.deepEqual(concurrent, { ok: false, reason: 'creating' });

    const replacement = await replaceReconciledCheckoutAttempt(db, {
      ownerUserId: OWNER_A,
      requestHash: HASH_B,
      reconciliationToken: reconciliation.reconciliationToken,
      providerSessionId: SESSION_A,
      providerExpiresAt: first.providerExpiresAt,
      now: first.lockExpiresAt + 1,
    });
    assert.equal(replacement.ok && replacement.status, 'acquired');
    assert.ok(replacement.ok && replacement.status === 'acquired');
    assert.notEqual(replacement.leaseToken, first.leaseToken);
    assert.equal(replacement.providerExpiresAt, first.lockExpiresAt + 1 + CHECKOUT_PROVIDER_EXPIRY_SECONDS);
    assert.deepEqual(await replaceReconciledCheckoutAttempt(db, {
      ownerUserId: OWNER_A,
      requestHash: HASH_B,
      reconciliationToken: reconciliation.reconciliationToken,
      providerSessionId: SESSION_A,
      providerExpiresAt: first.providerExpiresAt,
      now: first.lockExpiresAt + 1,
    }), { ok: false, reason: 'conflict' });
  });

  test('backs off open or ambiguous reconciliation and blocks completed Sessions pending webhook', async () => {
    const db = new SqliteD1();
    seedCustomer(db);
    const first = expectAcquired(await acquireCheckoutAttempt(db, acquireInput()));
    assert.equal((await completeCheckoutAttempt(db, {
      ...acquireInput({ now: NOW + 1 }), leaseToken: first.leaseToken, providerSessionId: SESSION_A,
    })).ok, true);
    const reconciliation = await acquireCheckoutAttempt(db, acquireInput({ now: first.lockExpiresAt }));
    assert.ok(reconciliation.ok && reconciliation.status === 'reconcile');
    const reconcileInput = {
      ownerUserId: OWNER_A,
      reconciliationToken: reconciliation.reconciliationToken,
      providerSessionId: SESSION_A,
      providerExpiresAt: first.providerExpiresAt,
      now: first.lockExpiresAt + 1,
    };
    assert.deepEqual(await deferCheckoutReconciliation(db, reconcileInput), {
      ok: true,
      committed: true,
      lockExpiresAt: reconcileInput.now + CHECKOUT_RECONCILIATION_BACKOFF_SECONDS,
    });
    assert.deepEqual(await acquireCheckoutAttempt(db, acquireInput({
      now: reconcileInput.now + CHECKOUT_RECONCILIATION_BACKOFF_SECONDS - 1,
    })), { ok: false, reason: 'creating' });
    const secondReconciliation = await acquireCheckoutAttempt(db, acquireInput({
      now: reconcileInput.now + CHECKOUT_RECONCILIATION_BACKOFF_SECONDS,
    }));
    assert.ok(secondReconciliation.ok && secondReconciliation.status === 'reconcile');
    assert.notEqual(secondReconciliation.reconciliationToken, reconciliation.reconciliationToken);
    assert.equal(secondReconciliation.leaseToken, first.leaseToken);
    assert.deepEqual(await settleReconciledCheckoutSubscription(db, {
      ownerUserId: OWNER_A,
      reconciliationToken: secondReconciliation.reconciliationToken,
      providerSessionId: SESSION_A,
      requestHash: HASH_A,
      providerCustomerId: CUSTOMER_A,
      providerSubscriptionId: SUBSCRIPTION_A,
      terminalRecovery: false,
      providerExpiresAt: first.providerExpiresAt,
      now: reconcileInput.now + CHECKOUT_RECONCILIATION_BACKOFF_SECONDS + 1,
    }), { ok: true, status: 'pending_webhook' });
    assert.deepEqual({ ...db.sqlite.prepare(
      `SELECT state, provider_subscription_id
         FROM billing_checkout_attempts WHERE owner_user_id = ?`,
    ).get(OWNER_A) }, {
      state: 'completed_pending_webhook',
      provider_subscription_id: SUBSCRIPTION_A,
    });
    assert.deepEqual(await acquireCheckoutAttempt(db, acquireInput({
      now: reconcileInput.now + CHECKOUT_RECONCILIATION_BACKOFF_SECONDS + 2,
    })), { ok: false, reason: 'pending_webhook' });
  });

  test('bounds automated receipt reconciliation to 72 hours and then requires manual review', async () => {
    const db = new SqliteD1();
    seedCustomer(db);
    const first = expectAcquired(await acquireCheckoutAttempt(db, acquireInput()));
    assert.equal((await completeCheckoutAttempt(db, {
      ...acquireInput({ now: NOW + 1 }), leaseToken: first.leaseToken, providerSessionId: SESSION_A,
    })).ok, true);
    const cutoff = first.providerExpiresAt + CHECKOUT_RECONCILIATION_MAX_AGE_SECONDS;
    assert.deepEqual(await acquireCheckoutAttempt(db, acquireInput({ now: cutoff })), {
      ok: false,
      reason: 'manual_review',
    });
    assert.equal(db.sqlite.prepare(
      'SELECT state FROM billing_checkout_attempts WHERE owner_user_id = ?',
    ).get(OWNER_A)?.state, 'manual_review');
  });

  test('atomically observes terminal authority committed between the aged read and manual-review CAS', async () => {
    const db = new SqliteD1();
    seedCustomer(db);
    const first = expectAcquired(await acquireCheckoutAttempt(db, acquireInput()));
    assert.equal((await completeCheckoutAttempt(db, {
      ...acquireInput({ now: NOW + 1 }), leaseToken: first.leaseToken, providerSessionId: SESSION_A,
    })).ok, true);
    db.armBeforeAllInterleave("SET state = 'manual_review'", () => seedSubscription(db, 'canceled'));

    const result = await acquireCheckoutAttempt(db, acquireInput({
      requestHash: HASH_B,
      now: first.providerExpiresAt + CHECKOUT_RECONCILIATION_MAX_AGE_SECONDS,
    }));
    assert.ok(result.ok && result.status === 'reconcile');
    assert.equal(result.terminalRecovery, true);
    assert.equal(db.sqlite.prepare(
      'SELECT state FROM billing_checkout_attempts WHERE owner_user_id = ?',
    ).get(OWNER_A)?.state, 'reconciling');
  });

  test('atomically rejects terminal recovery revoked between the aged read and reconciliation CAS', async () => {
    const db = new SqliteD1();
    seedCustomer(db);
    seedSubscription(db, 'canceled');
    const first = expectAcquired(await acquireCheckoutAttempt(db, acquireInput()));
    assert.equal((await completeCheckoutAttempt(db, {
      ...acquireInput({ now: NOW + 1 }), leaseToken: first.leaseToken, providerSessionId: SESSION_A,
    })).ok, true);
    db.armBeforeAllInterleave("SET state = 'reconciling'", () => {
      db.sqlite.prepare(
        `UPDATE billing_subscriptions
            SET status = 'active', last_event_created = ?, last_event_id = ?, updated_at = ?
          WHERE owner_user_id = ?`,
      ).run(
        NOW + 1,
        'evt_0000000000000092',
        '2026-08-24T12:00:01.000Z',
        OWNER_A,
      );
    });

    assert.deepEqual(await acquireCheckoutAttempt(db, acquireInput({
      requestHash: HASH_B,
      now: first.providerExpiresAt + CHECKOUT_RECONCILIATION_MAX_AGE_SECONDS,
    })), { ok: false, reason: 'manual_review' });
    assert.equal(db.sqlite.prepare(
      'SELECT state FROM billing_checkout_attempts WHERE owner_user_id = ?',
    ).get(OWNER_A)?.state, 'manual_review');
  });

  test('releases only a matching creating lease and never removes a ready receipt', async () => {
    const db = new SqliteD1();
    seedCustomer(db);
    const first = expectAcquired(await acquireCheckoutAttempt(db, acquireInput()));
    assert.deepEqual(await releaseCheckoutAttempt(db, {
      ownerUserId: OWNER_A, requestHash: HASH_B, leaseToken: first.leaseToken,
    }), { ok: false, reason: 'conflict' });
    assert.deepEqual(await releaseCheckoutAttempt(db, {
      ownerUserId: OWNER_A,
      requestHash: HASH_A,
      leaseToken: '00000000-0000-4000-8000-000000000001',
    }), { ok: false, reason: 'conflict' });
    assert.deepEqual(await releaseCheckoutAttempt(db, {
      ownerUserId: OWNER_A, requestHash: HASH_A, leaseToken: first.leaseToken,
    }), { ok: true, released: true });
    assert.deepEqual(await releaseCheckoutAttempt(db, {
      ownerUserId: OWNER_A, requestHash: HASH_A, leaseToken: first.leaseToken,
    }), { ok: true, released: false });

    const second = expectAcquired(await acquireCheckoutAttempt(db, acquireInput()));
    await completeCheckoutAttempt(db, {
      ...acquireInput({ now: NOW + 1 }), leaseToken: second.leaseToken, providerSessionId: SESSION_A,
    });
    assert.deepEqual(await releaseCheckoutAttempt(db, {
      ownerUserId: OWNER_A, requestHash: HASH_A, leaseToken: second.leaseToken,
    }), { ok: false, reason: 'conflict' });
  });

  test('rejects completion at provider expiry without converting the crash-safe lease', async () => {
    const db = new SqliteD1();
    seedCustomer(db);
    const acquired = expectAcquired(await acquireCheckoutAttempt(db, acquireInput()));
    assert.deepEqual(await completeCheckoutAttempt(db, {
      ...acquireInput({ now: acquired.providerExpiresAt }),
      leaseToken: acquired.leaseToken,
      providerSessionId: SESSION_A,
    }), { ok: false, reason: 'expired' });
    const row = db.sqlite.prepare(
      'SELECT state, provider_session_id FROM billing_checkout_attempts WHERE owner_user_id = ?',
    ).get(OWNER_A) as Record<string, unknown>;
    assert.deepEqual({ ...row }, { state: 'creating', provider_session_id: null });
  });

  test('rejects malformed callers before D1 and enforces representation invariants in SQLite', async () => {
    const unavailable: D1DatabaseLike = {
      prepare() { throw new Error('D1 must not be reached'); },
      batch() { throw new Error('D1 must not be reached'); },
    };
    for (const input of [
      { ownerUserId: 'owner', requestHash: HASH_A, now: NOW },
      { ownerUserId: OWNER_A, requestHash: HASH_A.toUpperCase(), now: NOW },
      { ownerUserId: OWNER_A, requestHash: HASH_A, now: NOW + 0.5 },
      { ownerUserId: OWNER_A, requestHash: HASH_A, now: 253_402_300_799 },
      { ownerUserId: OWNER_A, requestHash: HASH_A, now: NOW, extra: true },
    ]) assert.deepEqual(await acquireCheckoutAttempt(unavailable, input as AcquireCheckoutAttemptInput), {
      ok: false, reason: 'invalid',
    });

    assert.deepEqual(await completeCheckoutAttempt(unavailable, {
      ...acquireInput(), leaseToken: 'not-a-lease', providerSessionId: SESSION_A,
    }), { ok: false, reason: 'invalid' });
    assert.deepEqual(await completeCheckoutAttempt(unavailable, {
      ...acquireInput(),
      leaseToken: '00000000-0000-4000-8000-000000000001',
      providerSessionId: 'https://checkout.stripe.com/secret',
    }), { ok: false, reason: 'invalid' });
    assert.deepEqual(await releaseCheckoutAttempt(unavailable, {
      ownerUserId: OWNER_A, requestHash: HASH_A,
      leaseToken: '00000000-0000-4000-7000-000000000001',
    }), { ok: false, reason: 'invalid' });
    assert.deepEqual(await settleReconciledCheckoutSubscription(unavailable, {
      ownerUserId: OWNER_A,
      reconciliationToken: '00000000-0000-4000-8000-000000000001',
      providerSessionId: SESSION_A,
      requestHash: HASH_A,
      providerCustomerId: CUSTOMER_A,
      providerSubscriptionId: null,
      terminalRecovery: false,
      providerExpiresAt: NOW + CHECKOUT_PROVIDER_EXPIRY_SECONDS,
      now: NOW,
    } as never), { ok: false, reason: 'invalid' });

    const db = new SqliteD1();
    seedCustomer(db);
    const insert = db.sqlite.prepare(
      `INSERT INTO billing_checkout_attempts
         (owner_user_id, request_hash, lease_token, state, provider_session_id,
          provider_expires_at, lock_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const validLease = '00000000-0000-4000-8000-000000000001';
    for (const values of [
      [OWNER_A, HASH_A.toUpperCase(), validLease, 'creating', null, NOW + 1_920, NOW + 2_100],
      [OWNER_A, HASH_A, '00000000-0000-4000-7000-000000000001', 'creating', null, NOW + 1_920, NOW + 2_100],
      [OWNER_A, HASH_A, validLease, 'ready', null, NOW + 1_920, NOW + 2_100],
      [OWNER_A, HASH_A, validLease, 'creating', SESSION_A, NOW + 1_920, NOW + 2_100],
      [OWNER_A, HASH_A, validLease, 'creating', null, NOW + 1_920, NOW + 2_099],
    ]) assert.throws(() => insert.run(...values));
    assert.throws(() => db.sqlite.prepare(
      `INSERT INTO billing_checkout_attempts
         (owner_user_id, request_hash, lease_token, state, provider_session_id,
          provider_subscription_id, provider_expires_at, lock_expires_at)
       VALUES (?, ?, ?, 'completed_pending_webhook', ?, NULL, ?, ?)`,
    ).run(OWNER_A, HASH_A, validLease, SESSION_A, NOW + 1_920, NOW + 2_100));
  });

  test('keeps provider Session receipts unique across owners', async () => {
    const db = new SqliteD1();
    seedCustomer(db, OWNER_A, '0001');
    seedCustomer(db, OWNER_B, '0002');
    const first = expectAcquired(await acquireCheckoutAttempt(db, acquireInput()));
    const second = expectAcquired(await acquireCheckoutAttempt(db, acquireInput({ ownerUserId: OWNER_B })));
    assert.equal((await completeCheckoutAttempt(db, {
      ...acquireInput({ now: NOW + 1 }), leaseToken: first.leaseToken, providerSessionId: SESSION_A,
    })).ok, true);
    await assert.rejects(completeCheckoutAttempt(db, {
      ...acquireInput({ ownerUserId: OWNER_B, now: NOW + 1 }),
      leaseToken: second.leaseToken,
      providerSessionId: SESSION_A,
    }));
  });
});
