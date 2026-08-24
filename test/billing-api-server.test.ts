import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  BILLING_OUTCOMES,
  handleBillingPortal,
  handleCheckout,
  logBillingOutcome,
} from '../site/src/lib/server/billing-api.ts';
import {
  createStripeApi,
  STRIPE_API_VERSION,
  STRIPE_REQUEST_TIMEOUT_MS,
  STRIPE_RESPONSE_BODY_LIMIT,
  stripeApiConfiguration,
  stripeProPriceConfiguration,
  type StripeFetch,
} from '../site/src/lib/server/stripe-api.ts';
import type {
  BuildPlansEnv,
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1ResultLike,
  PagesContextLike,
} from '../site/src/lib/server/pages-types.ts';

const migration = [
  '../site/migrations/0004_billing_authority.sql',
  '../site/migrations/0007_billing_checkout_attempts.sql',
].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n');

class SqliteStatement implements D1PreparedStatementLike {
  private readonly database: DatabaseSync;
  readonly query: string;
  readonly values: unknown[];

  constructor(
    database: DatabaseSync,
    query: string,
    values: unknown[] = [],
  ) {
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
    this.sqlite.exec('PRAGMA foreign_keys = ON');
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

const TEST_SECRET = `sk_test_${'A'.repeat(32)}`;
const LIVE_SECRET = `sk_live_${'B'.repeat(32)}`;
const MONTHLY_PRICE = 'price_monthly00000001';
const ANNUAL_PRICE = 'price_annual000000001';
const OWNER_A = 'user_billing_alpha';
const OWNER_B = 'user_billing_bravo';
const BROWSER_KEY = 'checkout-key-0001';
const NOW = new Date('2026-08-24T12:00:00.000Z');

type RecordedCall = { url: string; method: string; headers: Headers; body: string };

function stripeJson(value: unknown, replayed = false, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(replayed ? { 'Idempotent-Replayed': 'true' } : {}),
    },
  });
}

function stripeJsonWithHeaders(
  value: unknown,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

class StripeMock {
  readonly calls: RecordedCall[] = [];
  readonly idempotent = new Map<string, { body: string; response: Record<string, unknown> }>();
  readonly checkoutSessions = new Map<string, Record<string, unknown>>();
  customerCount = 0;
  checkoutCount = 0;
  portalCount = 0;
  fixedCustomerId: string | null = null;
  override: ((call: RecordedCall) => Response | Promise<Response> | null) | null = null;

  readonly fetch: StripeFetch = async (input, init = {}) => {
    const call: RecordedCall = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : '',
    };
    this.calls.push(call);
    assert.equal(call.headers.get('stripe-version'), STRIPE_API_VERSION);
    assert.match(call.headers.get('authorization') ?? '', /^Bearer sk_(?:test|live)_/);
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.equal(init.signal instanceof AbortSignal, true);
    const replacement = await this.override?.(call);
    if (replacement) return replacement;

    const key = call.headers.get('idempotency-key');
    const compoundKey = `${call.method} ${call.url}\n${key ?? ''}`;
    if (call.method === 'POST') {
      assert.ok(key);
      const prior = this.idempotent.get(compoundKey);
      if (prior) {
        if (prior.body !== call.body) {
          return stripeJson({ error: { type: 'idempotency_error', message: 'hostile provider detail' } }, false, 400);
        }
        return stripeJson(prior.response, true);
      }
    } else {
      assert.equal(key, null);
    }

    const live = call.headers.get('authorization')?.includes('sk_live_') ?? false;
    let response: Record<string, unknown>;
    if (call.url.endsWith('/v1/customers') && call.method === 'POST') {
      assert.equal(call.headers.get('content-type'), 'application/x-www-form-urlencoded');
      assert.equal(call.body, '');
      this.customerCount += 1;
      response = {
        id: this.fixedCustomerId ?? `cus_${String(this.customerCount).padStart(16, '0')}`,
        object: 'customer',
        livemode: live,
      };
    } else if (call.url.endsWith('/v1/checkout/sessions') && call.method === 'POST') {
      this.checkoutCount += 1;
      const id = `cs_${live ? 'live' : 'test'}_${String(this.checkoutCount).padStart(16, '0')}`;
      const expiresAt = Number(new URLSearchParams(call.body).get('expires_at'));
      const customerId = new URLSearchParams(call.body).get('customer');
      assert.equal(Number.isSafeInteger(expiresAt), true);
      response = {
        id,
        object: 'checkout.session',
        livemode: live,
        customer: customerId,
        mode: 'subscription',
        status: 'open',
        subscription: null,
        expires_at: expiresAt,
        url: `https://checkout.stripe.com/c/pay/${id}#provider-token`,
      };
      this.checkoutSessions.set(id, response);
    } else if (call.method === 'GET' && call.url.includes('/v1/checkout/sessions/')) {
      const id = call.url.slice(call.url.lastIndexOf('/') + 1);
      const session = this.checkoutSessions.get(id);
      return session
        ? stripeJson(session)
        : stripeJson({ error: { type: 'invalid_request_error', message: 'not found' } }, false, 404);
    } else if (call.url.endsWith('/v1/billing_portal/sessions') && call.method === 'POST') {
      this.portalCount += 1;
      response = {
        id: `bps_${String(this.portalCount).padStart(16, '0')}`,
        object: 'billing_portal.session',
        livemode: live,
        url: `https://billing.stripe.com/p/session/test_${String(this.portalCount).padStart(24, '0')}`,
      };
    } else {
      return stripeJson({ error: { type: 'invalid_request_error' } }, false, 404);
    }
    if (call.method === 'POST') this.idempotent.set(compoundKey, { body: call.body, response });
    return stripeJson(response);
  };
}

function baseEnv(db: D1DatabaseLike, overrides: Partial<BuildPlansEnv> = {}): BuildPlansEnv {
  return {
    DB: db,
    APP_ENV: 'development',
    CLERK_AUTHORIZED_PARTIES: 'http://localhost:8788',
    STRIPE_SECRET_KEY: TEST_SECRET,
    STRIPE_PRO_MONTHLY_PRICE_ID: MONTHLY_PRICE,
    STRIPE_PRO_ANNUAL_PRICE_ID: ANNUAL_PRICE,
    ...overrides,
  };
}

function context(
  db: D1DatabaseLike,
  path: '/api/checkout' | '/api/billing-portal',
  body: unknown,
  options: {
    owner?: string;
    idempotencyKey?: string;
    env?: Partial<BuildPlansEnv>;
    url?: string;
    method?: string;
    contentType?: string;
  } = {},
): PagesContextLike {
  const request = new Request(options.url ?? `http://localhost:8788${path}`, {
    method: options.method ?? 'POST',
    headers: {
      'Content-Type': options.contentType ?? 'application/json',
      'Idempotency-Key': options.idempotencyKey ?? BROWSER_KEY,
    },
    ...(options.method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  return {
    request,
    env: baseEnv(db, options.env),
    params: {},
    data: { ownerUserId: options.owner ?? OWNER_A, requestId: 'req-billing' },
    next: async () => new Response(null, { status: 404 }),
  };
}

function checkout(db: D1DatabaseLike, body: unknown = { interval: 'month' }, options = {}) {
  return context(db, '/api/checkout', body, options);
}

function portal(db: D1DatabaseLike, body: unknown = {}, options = {}) {
  return context(db, '/api/billing-portal', body, options);
}

function form(call: RecordedCall): URLSearchParams {
  assert.equal(call.headers.get('content-type'), 'application/x-www-form-urlencoded');
  return new URLSearchParams(call.body);
}

describe('Stripe configuration and transport boundary', () => {
  test('pins test/live secrets to APP_ENV and requires two distinct exact price IDs', () => {
    const db = new SqliteD1();
    assert.deepEqual(stripeApiConfiguration(baseEnv(db)), { secretKey: TEST_SECRET, mode: 'test' });
    assert.deepEqual(stripeApiConfiguration(baseEnv(db, {
      APP_ENV: 'production', STRIPE_SECRET_KEY: LIVE_SECRET,
    })), { secretKey: LIVE_SECRET, mode: 'live' });
    for (const overrides of [
      { APP_ENV: 'production', STRIPE_SECRET_KEY: TEST_SECRET },
      { APP_ENV: 'preview', STRIPE_SECRET_KEY: LIVE_SECRET },
      { APP_ENV: 'staging', STRIPE_SECRET_KEY: TEST_SECRET },
      { APP_ENV: 'development', STRIPE_SECRET_KEY: ` ${TEST_SECRET}` },
      { APP_ENV: 'development', STRIPE_SECRET_KEY: 'rk_test_not_allowed0000000000000' },
    ]) assert.equal(stripeApiConfiguration(baseEnv(db, overrides)), null);

    assert.deepEqual(stripeProPriceConfiguration(baseEnv(db)), {
      monthlyPriceId: MONTHLY_PRICE, annualPriceId: ANNUAL_PRICE,
    });
    assert.equal(stripeProPriceConfiguration(baseEnv(db, { STRIPE_PRO_MONTHLY_PRICE_ID: '19' })), null);
    assert.equal(stripeProPriceConfiguration(baseEnv(db, { STRIPE_PRO_ANNUAL_PRICE_ID: MONTHLY_PRICE })), null);
    assert.equal(stripeProPriceConfiguration(baseEnv(db, { STRIPE_PRO_ANNUAL_PRICE_ID: `${ANNUAL_PRICE} ` })), null);
  });

  test('rejects provider mode, ID, hosted-URL, status and body-cap violations', async () => {
    const configurations = [
      {
        name: 'mode',
        response: { id: 'cus_0000000000000001', object: 'customer', livemode: true },
      },
      {
        name: 'id',
        response: { id: 'acct_injected000001', object: 'customer', livemode: false },
      },
    ];
    for (const scenario of configurations) {
      const api = createStripeApi({ secretKey: TEST_SECRET, mode: 'test' }, async () => stripeJson(scenario.response));
      assert.deepEqual(await api.createCustomer('provider-key-0001'), { ok: false, reason: 'invalid_response' }, scenario.name);
    }

    const oversized = createStripeApi({ secretKey: TEST_SECRET, mode: 'test' }, async () => new Response(
      JSON.stringify({ padding: 'x'.repeat(STRIPE_RESPONSE_BODY_LIMIT) }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    assert.deepEqual(await oversized.createCustomer('provider-key-0001'), { ok: false, reason: 'invalid_response' });

    const wrongStatus = createStripeApi({ secretKey: TEST_SECRET, mode: 'test' }, async () => stripeJson(
      { id: 'cus_0000000000000001', object: 'customer', livemode: false }, false, 201,
    ));
    assert.deepEqual(await wrongStatus.createCustomer('provider-key-0001'), { ok: false, reason: 'invalid_response' });

    const customerBody = JSON.stringify({
      id: 'cus_0000000000000001', object: 'customer', livemode: false,
    });
    const wrongLength = createStripeApi({ secretKey: TEST_SECRET, mode: 'test' }, async () => new Response(
      customerBody,
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(new TextEncoder().encode(customerBody).byteLength - 1),
        },
      },
    ));
    assert.deepEqual(await wrongLength.createCustomer('provider-key-0001'), {
      ok: false, reason: 'invalid_response',
    });

    let checkoutResponse: Record<string, unknown> = {
      id: 'cs_test_0000000000000001', object: 'checkout.session', livemode: false,
      customer: 'cus_0000000000000001', mode: 'subscription', status: 'open', subscription: null,
      expires_at: 1_800_000_000,
      url: 'https://evil.example/c/pay/cs_test_0000000000000001',
    };
    const checkoutApi = createStripeApi({ secretKey: TEST_SECRET, mode: 'test' }, async () => stripeJson(checkoutResponse));
    assert.equal((await checkoutApi.createCheckoutSession({
      customerId: 'cus_0000000000000001', priceId: MONTHLY_PRICE,
      successUrl: 'https://solvency.dev/pricing?checkout=success',
      cancelUrl: 'https://solvency.dev/pricing?checkout=canceled',
      expiresAt: 1_800_000_000, idempotencyKey: 'provider-key-0001',
    })).ok, false);
    checkoutResponse = {
      ...checkoutResponse,
      url: 'https://checkout.stripe.com/c/pay/cs_test_0000000000000001',
      expires_at: 1_800_000_001,
    };
    assert.equal((await checkoutApi.createCheckoutSession({
      customerId: 'cus_0000000000000001', priceId: MONTHLY_PRICE,
      successUrl: 'https://solvency.dev/pricing?checkout=success',
      cancelUrl: 'https://solvency.dev/pricing?checkout=canceled',
      expiresAt: 1_800_000_000, idempotencyKey: 'provider-key-0002',
    })).ok, false);

    const portalApi = createStripeApi({ secretKey: TEST_SECRET, mode: 'test' }, async () => stripeJson({
      id: 'bps_0000000000000001', object: 'billing_portal.session', livemode: false,
      url: 'https://billing.stripe.com.evil.example/p/session/test_000000000000000000000001',
    }));
    assert.equal((await portalApi.createPortalSession({
      customerId: 'cus_0000000000000001', returnUrl: 'https://solvency.dev/pricing',
      idempotencyKey: 'provider-key-0001',
    })).ok, false);
  });

  test('aborts an upstream request at the fixed production cap', async () => {
    assert.equal(STRIPE_REQUEST_TIMEOUT_MS, 10_000);
    let signal: AbortSignal | null = null;
    const api = createStripeApi(
      { secretKey: TEST_SECRET, mode: 'test' },
      async (_input, init) => {
        signal = init?.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
      5,
    );
    assert.deepEqual(await api.createCustomer('provider-key-0001'), { ok: false, reason: 'remote' });
    assert.equal(signal?.aborted, true);
  });

  test('classifies only bounded Stripe errors as conclusive and treats retry directives conservatively', async () => {
    const createWith = async (status: number, body: unknown, shouldRetry?: string) => {
      const api = createStripeApi({ secretKey: TEST_SECRET, mode: 'test' }, async () => stripeJsonWithHeaders(
        body,
        status,
        shouldRetry === undefined ? {} : { 'Stripe-Should-Retry': shouldRetry },
      ));
      return api.createCheckoutSession({
        customerId: 'cus_0000000000000001',
        priceId: MONTHLY_PRICE,
        successUrl: 'https://solvency.dev/pricing?checkout=success',
        cancelUrl: 'https://solvency.dev/pricing?checkout=canceled',
        expiresAt: 1_800_000_000,
        idempotencyKey: 'provider-key-0001',
      });
    };
    for (const [status, type] of [
      [400, 'invalid_request_error'],
      [401, 'authentication_error'],
      [402, 'card_error'],
      [403, 'permission_error'],
    ] as const) {
      assert.deepEqual(await createWith(status, { error: { type, message: 'bounded' } }), {
        ok: false,
        reason: 'provider_rejected',
      });
    }
    assert.deepEqual(await createWith(429, { error: { type: 'rate_limit_error' } }), {
      ok: false,
      reason: 'retryable',
    });
    for (const [name, status, body, directive, reason] of [
      ['request-timeout', 408, { error: { type: 'invalid_request_error' } }, undefined, 'remote'],
      ['conflict', 409, { error: { type: 'invalid_request_error' } }, undefined, 'remote'],
      ['not-found', 404, { error: { type: 'invalid_request_error' } }, undefined, 'remote'],
      ['unprocessable', 422, { error: { type: 'invalid_request_error' } }, undefined, 'remote'],
      ['unknown-status', 418, { error: { type: 'invalid_request_error' } }, undefined, 'remote'],
      ['malformed-envelope', 400, { error: { type: 'invalid_request_error' }, extra: true }, undefined, 'invalid_response'],
      ['unknown-error', 400, { error: { type: 'new_provider_error' } }, undefined, 'invalid_response'],
      ['retry-true', 400, { error: { type: 'invalid_request_error' } }, 'true', 'remote'],
      ['retry-malformed', 400, { error: { type: 'invalid_request_error' } }, 'TRUE', 'invalid_response'],
      ['rate-limit-retry-true', 429, { error: { type: 'rate_limit_error' } }, 'true', 'remote'],
    ] as const) {
      assert.deepEqual(await createWith(status, body, directive), { ok: false, reason }, name);
    }
  });
});

describe('authenticated checkout API', () => {
  test('creates an owner-bound customer and an exact monthly hosted subscription Checkout body', async () => {
    const db = new SqliteD1();
    const stripe = new StripeMock();
    const response = await handleCheckout(checkout(db), { fetch: stripe.fetch, now: () => NOW });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('idempotency-replayed'), 'false');
    assert.match((await response.json() as { data: { url: string } }).data.url, /^https:\/\/checkout\.stripe\.com\//);

    assert.deepEqual({ ...db.sqlite.prepare(
      'SELECT owner_user_id, provider_customer_id FROM billing_customers',
    ).get() }, { owner_user_id: OWNER_A, provider_customer_id: 'cus_0000000000000001' });
    assert.equal(stripe.calls.length, 2);
    assert.match(stripe.calls[0].headers.get('idempotency-key') ?? '', /^solvency-customer-v1-[a-f0-9]{64}$/);
    const values = form(stripe.calls[1]);
    assert.deepEqual([...values.entries()], [
      ['mode', 'subscription'],
      ['ui_mode', 'hosted'],
      ['customer', 'cus_0000000000000001'],
      ['line_items[0][price]', MONTHLY_PRICE],
      ['line_items[0][quantity]', '1'],
      ['expires_at', String(Math.floor(NOW.getTime() / 1000) + 32 * 60)],
      ['success_url', 'http://localhost:8788/pricing?checkout=success'],
      ['cancel_url', 'http://localhost:8788/pricing?checkout=canceled'],
    ]);
    assert.match(stripe.calls[1].headers.get('idempotency-key') ?? '', /^solvency-checkout-v2-[a-f0-9]{64}$/);
    assert.doesNotMatch(stripe.calls[1].body, /user_|amount|redirect|evil/);
  });

  test('selects only the configured annual price and reuses the owner mapping', async () => {
    const db = new SqliteD1();
    db.sqlite.prepare(
      `INSERT INTO billing_customers (owner_user_id, provider_customer_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(OWNER_A, 'cus_9999999999999999', NOW.toISOString(), NOW.toISOString());
    const stripe = new StripeMock();
    const response = await handleCheckout(checkout(db, { interval: 'year' }), { fetch: stripe.fetch, now: () => NOW });
    assert.equal(response.status, 200);
    assert.equal(stripe.customerCount, 0);
    assert.equal(form(stripe.calls[0]).get('customer'), 'cus_9999999999999999');
    assert.equal(form(stripe.calls[0]).get('line_items[0][price]'), ANNUAL_PRICE);
  });

  test('isolates owners even when they reuse the same browser idempotency key', async () => {
    const db = new SqliteD1();
    const stripe = new StripeMock();
    const [alpha, bravo] = await Promise.all([
      handleCheckout(checkout(db, { interval: 'month' }, { owner: OWNER_A }), { fetch: stripe.fetch, now: () => NOW }),
      handleCheckout(checkout(db, { interval: 'month' }, { owner: OWNER_B }), { fetch: stripe.fetch, now: () => NOW }),
    ]);
    assert.equal(alpha.status, 200);
    assert.equal(bravo.status, 200);
    const rows = db.sqlite.prepare(
      'SELECT owner_user_id, provider_customer_id FROM billing_customers ORDER BY owner_user_id',
    ).all();
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].provider_customer_id, rows[1].provider_customer_id);
    const customerKeys = stripe.calls.filter((call) => call.url.endsWith('/v1/customers'))
      .map((call) => call.headers.get('idempotency-key'));
    const checkoutKeys = stripe.calls.filter((call) => call.url.endsWith('/v1/checkout/sessions'))
      .map((call) => call.headers.get('idempotency-key'));
    assert.equal(new Set(customerKeys).size, 2);
    assert.equal(new Set(checkoutKeys).size, 2);
  });

  test('serializes concurrent Checkout and then replays the completed durable attempt', async () => {
    const db = new SqliteD1();
    const stripe = new StripeMock();
    const [first, second] = await Promise.all([
      handleCheckout(checkout(db), { fetch: stripe.fetch, now: () => NOW }),
      handleCheckout(checkout(db), { fetch: stripe.fetch, now: () => NOW }),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409]);
    assert.equal(stripe.customerCount, 1);
    assert.equal(stripe.checkoutCount, 1);
    const success = first.status === 200 ? first : second;
    const conflict = first.status === 409 ? first : second;
    assert.equal(conflict.headers.get('retry-after'), '5');
    const payload = await success.json();
    const replay = await handleCheckout(checkout(db), { fetch: stripe.fetch, now: () => NOW });
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('idempotency-replayed'), 'true');
    assert.deepEqual(await replay.json(), payload);
    assert.equal(stripe.checkoutCount, 1);
  });

  test('same owner/key with a different interval is a sanitized idempotency conflict', async () => {
    const db = new SqliteD1();
    const stripe = new StripeMock();
    assert.equal((await handleCheckout(checkout(db), { fetch: stripe.fetch, now: () => NOW })).status, 200);
    const conflict = await handleCheckout(
      checkout(db, { interval: 'year' }),
      { fetch: stripe.fetch, now: () => NOW },
    );
    assert.equal(conflict.status, 409);
    const raw = await conflict.text();
    assert.match(raw, /IDEMPOTENCY_CONFLICT/);
    assert.doesNotMatch(raw, /hostile provider detail|price_|cus_|user_/);
  });

  test('one durable owner lease blocks simultaneous different-key Checkout Sessions', async () => {
    const db = new SqliteD1();
    const stripe = new StripeMock();
    const [first, second] = await Promise.all([
      handleCheckout(
        checkout(db, { interval: 'month' }, { idempotencyKey: 'checkout-key-alpha' }),
        { fetch: stripe.fetch, now: () => NOW },
      ),
      handleCheckout(
        checkout(db, { interval: 'month' }, { idempotencyKey: 'checkout-key-bravo' }),
        { fetch: stripe.fetch, now: () => NOW },
      ),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409]);
    const conflict = first.status === 409 ? first : second;
    assert.equal(conflict.headers.get('retry-after'), '5');
    assert.equal(stripe.checkoutCount, 1);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM billing_checkout_attempts').get()?.count, 1);
  });

  test('refuses every existing nonterminal subscription before creating Checkout, independent of price', async () => {
    const statuses = ['trialing', 'active', 'past_due', 'paused', 'unpaid', 'incomplete'];
    for (const status of statuses) {
      const db = new SqliteD1();
      db.sqlite.prepare(
        `INSERT INTO billing_customers (owner_user_id, provider_customer_id, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).run(OWNER_A, 'cus_5555555555555555', NOW.toISOString(), NOW.toISOString());
      db.sqlite.prepare(
        `INSERT INTO billing_subscriptions
           (owner_user_id, provider_customer_id, provider_subscription_id,
            provider_price_id, provider_price_quantity, provider_price_currency,
            provider_price_interval, status, current_period_end, cancel_at_period_end,
            last_event_created, last_event_id, updated_at)
         VALUES (?, ?, ?, ?, 1, 'usd', 'month', ?, 2000000000, 0, 1787486400, ?, ?)`,
      ).run(
        OWNER_A, 'cus_5555555555555555', `sub_${status.padEnd(16, '0')}`,
        'price_unknown0000001', status, `evt_${status.padEnd(16, '0')}`, NOW.toISOString(),
      );
      const stripe = new StripeMock();
      const response = await handleCheckout(checkout(db), { fetch: stripe.fetch, now: () => NOW });
      assert.equal(response.status, 409, status);
      assert.equal(stripe.calls.length, 0, status);
      assert.doesNotMatch(await response.text(), /price_|sub_|cus_/);
    }
  });

  test('rejects browser price, amount, customer and redirect injection before Stripe', async () => {
    const forbiddenBodies = [
      { interval: 'month', price: 'price_attacker000001' },
      { interval: 'month', amount: 1 },
      { interval: 'month', customer: 'cus_attacker000001' },
      { interval: 'month', successUrl: 'https://evil.example' },
      { interval: 'week' },
      {},
      null,
    ];
    for (const body of forbiddenBodies) {
      const db = new SqliteD1();
      const stripe = new StripeMock();
      const response = await handleCheckout(checkout(db, body), { fetch: stripe.fetch, now: () => NOW });
      assert.equal(response.status, 400);
      assert.equal(stripe.calls.length, 0);
    }
  });

  test('enforces method, query, origin, idempotency, media and body boundaries', async () => {
    const cases: Array<{ request: PagesContextLike; status: number }> = [
      { request: checkout(new SqliteD1(), {}, { method: 'GET' }), status: 405 },
      { request: checkout(new SqliteD1(), {}, { url: 'http://localhost:8788/api/checkout?price=evil' }), status: 400 },
      { request: checkout(new SqliteD1(), {}, { url: 'http://127.0.0.1:8788/api/checkout' }), status: 403 },
      { request: checkout(new SqliteD1(), {}, { idempotencyKey: 'short' }), status: 400 },
      { request: checkout(new SqliteD1(), {}, { contentType: 'text/plain' }), status: 415 },
      { request: checkout(new SqliteD1(), 'x'.repeat(BILLING_TEST_BODY_LIMIT())), status: 413 },
    ];
    for (const item of cases) {
      const stripe = new StripeMock();
      assert.equal((await handleCheckout(item.request, { fetch: stripe.fetch, now: () => NOW })).status, item.status);
      assert.equal(stripe.calls.length, 0);
    }
  });

  test('fails closed before transport for wrong secret mode, price or authorized-origin configuration', async () => {
    const cases: Array<{ env: Partial<BuildPlansEnv>; url?: string }> = [
      {
        env: { APP_ENV: 'production', STRIPE_SECRET_KEY: TEST_SECRET, CLERK_AUTHORIZED_PARTIES: 'https://solvency.dev' },
        url: 'https://solvency.dev/api/checkout',
      },
      { env: { APP_ENV: 'development', STRIPE_SECRET_KEY: LIVE_SECRET } },
      { env: { STRIPE_PRO_MONTHLY_PRICE_ID: 'price_bad!' } },
      { env: { STRIPE_PRO_ANNUAL_PRICE_ID: MONTHLY_PRICE } },
      { env: { CLERK_AUTHORIZED_PARTIES: 'http://localhost:8788, http://localhost:8788' } },
    ];
    for (const item of cases) {
      const db = new SqliteD1();
      const stripe = new StripeMock();
      const response = await handleCheckout(checkout(db, { interval: 'month' }, {
        env: item.env, ...(item.url ? { url: item.url } : {}),
      }), {
        fetch: stripe.fetch, now: () => NOW,
      });
      assert.equal(response.status, 503);
      assert.equal(stripe.calls.length, 0);
    }
  });

  test('sanitizes provider transport and malformed-response failures', async () => {
    const db = new SqliteD1();
    const throwing: StripeFetch = async () => { throw new Error(`${TEST_SECRET} secret upstream detail`); };
    const unavailable = await handleCheckout(checkout(db), { fetch: throwing, now: () => NOW });
    assert.equal(unavailable.status, 503);
    const raw = await unavailable.text();
    assert.doesNotMatch(raw, /sk_test|upstream detail|price_|user_/);

    const malformedDb = new SqliteD1();
    const stripe = new StripeMock();
    stripe.override = (call) => call.url.endsWith('/v1/customers')
      ? stripeJson({ id: 'cus_invalid!', object: 'customer', livemode: false })
      : null;
    const malformed = await handleCheckout(checkout(malformedDb), { fetch: stripe.fetch, now: () => NOW });
    assert.equal(malformed.status, 503);
    assert.equal(malformedDb.sqlite.prepare('SELECT COUNT(*) AS count FROM billing_customers').get()?.count, 0);
  });

  test('releases only a conclusively rejected provider attempt and permits a clean retry', async () => {
    const db = new SqliteD1();
    const stripe = new StripeMock();
    const outcomes: string[] = [];
    stripe.override = (call) => call.url.endsWith('/v1/checkout/sessions')
      ? stripeJson({ error: { type: 'invalid_request_error', message: 'provider secret detail' } }, false, 400)
      : null;
    const rejected = await handleCheckout(checkout(db), {
      fetch: stripe.fetch, now: () => NOW, outcomeSink: (value) => outcomes.push(value),
    });
    assert.equal(rejected.status, 503);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM billing_checkout_attempts').get()?.count, 0);
    assert.deepEqual(JSON.parse(outcomes.at(-1)!), {
      schema_version: 1, event: 'billing_outcome', outcome: 'checkout_provider_rejected',
    });
    assert.doesNotMatch(outcomes.join(''), /user_|cus_|cs_test_|https:|provider secret/);

    stripe.override = null;
    const retry = await handleCheckout(checkout(db), {
      fetch: stripe.fetch, now: () => NOW, outcomeSink: () => undefined,
    });
    assert.equal(retry.status, 200);
  });

  test('releases a strict 429 for bounded retry but retains 408, 409, 404, malformed and should-retry failures', async () => {
    {
      const db = new SqliteD1();
      const stripe = new StripeMock();
      const outcomes: string[] = [];
      stripe.override = (call) => call.url.endsWith('/v1/checkout/sessions')
        ? stripeJson({ error: { type: 'rate_limit_error', message: 'slow down' } }, false, 429)
        : null;
      const response = await handleCheckout(checkout(db), {
        fetch: stripe.fetch,
        now: () => NOW,
        outcomeSink: (value) => outcomes.push(value),
      });
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('retry-after'), '30');
      assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM billing_checkout_attempts').get()?.count, 0);
      assert.equal(JSON.parse(outcomes.at(-1)!).outcome, 'checkout_provider_retryable');
    }

    const ambiguous: Array<{
      name: string;
      status: number;
      body: unknown;
      headers?: Record<string, string>;
    }> = [
      { name: '408', status: 408, body: { error: { type: 'invalid_request_error' } } },
      { name: '409', status: 409, body: { error: { type: 'invalid_request_error' } } },
      { name: '404', status: 404, body: { error: { type: 'invalid_request_error' } } },
      { name: 'malformed', status: 400, body: { error: { type: 'invalid_request_error' }, extra: true } },
      {
        name: 'should-retry',
        status: 400,
        body: { error: { type: 'invalid_request_error' } },
        headers: { 'Stripe-Should-Retry': 'true' },
      },
      {
        name: 'malformed-retry',
        status: 400,
        body: { error: { type: 'invalid_request_error' } },
        headers: { 'Stripe-Should-Retry': 'TRUE' },
      },
      {
        name: 'rate-limit-should-retry',
        status: 429,
        body: { error: { type: 'rate_limit_error' } },
        headers: { 'Stripe-Should-Retry': 'true' },
      },
    ];
    for (const scenario of ambiguous) {
      const db = new SqliteD1();
      const stripe = new StripeMock();
      stripe.override = (call) => call.url.endsWith('/v1/checkout/sessions')
        ? stripeJsonWithHeaders(scenario.body, scenario.status, scenario.headers ?? {})
        : null;
      const response = await handleCheckout(checkout(db), {
        fetch: stripe.fetch,
        now: () => NOW,
        outcomeSink: () => undefined,
      });
      assert.equal(response.status, 503, scenario.name);
      assert.deepEqual({ ...db.sqlite.prepare(
        'SELECT state, provider_session_id FROM billing_checkout_attempts WHERE owner_user_id = ?',
      ).get(OWNER_A) }, { state: 'creating', provider_session_id: null }, scenario.name);
    }
  });

  test('retains the owner lease after an ambiguous provider failure', async () => {
    const db = new SqliteD1();
    const stripe = new StripeMock();
    stripe.override = (call) => {
      if (call.url.endsWith('/v1/checkout/sessions')) throw new Error('connection lost after write');
      return null;
    };
    const ambiguous = await handleCheckout(checkout(db), {
      fetch: stripe.fetch, now: () => NOW, outcomeSink: () => undefined,
    });
    assert.equal(ambiguous.status, 503);
    assert.deepEqual({ ...db.sqlite.prepare(
      'SELECT state, provider_session_id FROM billing_checkout_attempts WHERE owner_user_id = ?',
    ).get(OWNER_A) }, { state: 'creating', provider_session_id: null });

    stripe.override = null;
    const retry = await handleCheckout(
      checkout(db, { interval: 'month' }, { idempotencyKey: 'different-key-001' }),
      { fetch: stripe.fetch, now: () => NOW, outcomeSink: () => undefined },
    );
    assert.equal(retry.status, 409);
    assert.equal(retry.headers.get('retry-after'), '5');
    assert.equal(stripe.checkoutCount, 0);
  });

  test('emits an identifier-free manual-review outcome when a stale creating generation is quarantined', async () => {
    const db = new SqliteD1();
    const stripe = new StripeMock();
    stripe.override = (call) => {
      if (call.url.endsWith('/v1/checkout/sessions')) throw new Error('ambiguous write');
      return null;
    };
    assert.equal((await handleCheckout(checkout(db), {
      fetch: stripe.fetch, now: () => NOW, outcomeSink: () => undefined,
    })).status, 503);
    const row = db.sqlite.prepare(
      'SELECT lock_expires_at FROM billing_checkout_attempts WHERE owner_user_id = ?',
    ).get(OWNER_A) as { lock_expires_at: number };
    stripe.override = null;
    const outcomes: string[] = [];
    const blocked = await handleCheckout(checkout(db), {
      fetch: stripe.fetch,
      now: () => new Date(row.lock_expires_at * 1000),
      outcomeSink: (value) => outcomes.push(value),
    });
    assert.equal(blocked.status, 409);
    assert.deepEqual(JSON.parse(outcomes.at(-1)!), {
      schema_version: 1,
      event: 'billing_outcome',
      outcome: 'checkout_manual_review',
    });
    assert.doesNotMatch(outcomes.join(''), /user_|cus_|cs_|price_|https?:|sk_test/);
    assert.equal(db.sqlite.prepare(
      'SELECT state FROM billing_checkout_attempts WHERE owner_user_id = ?',
    ).get(OWNER_A)?.state, 'manual_review');
  });

  test('retains a creating lease when durable completion fails after provider success', async () => {
    const db = new SqliteD1();
    function wrapped(statement: D1PreparedStatementLike, failAll: boolean): D1PreparedStatementLike {
      return {
        bind(...values) { return wrapped(statement.bind(...values), failAll); },
        first<T>(columnName?: string) { return statement.first<T>(columnName); },
        all<T>() {
          return failAll
            ? Promise.reject(new Error('completion write unavailable'))
            : statement.all<T>();
        },
        run<T>() { return statement.run<T>(); },
      };
    }
    const failingDb: D1DatabaseLike = {
      prepare(query) {
        return wrapped(db.prepare(query), /UPDATE billing_checkout_attempts\s+SET state = 'ready'/.test(query));
      },
      batch: db.batch.bind(db),
    };
    const stripe = new StripeMock();
    const response = await handleCheckout(checkout(failingDb), {
      fetch: stripe.fetch, now: () => NOW, outcomeSink: () => undefined,
    });
    assert.equal(response.status, 503);
    assert.deepEqual({ ...db.sqlite.prepare(
      'SELECT state, provider_session_id FROM billing_checkout_attempts WHERE owner_user_id = ?',
    ).get(OWNER_A) }, { state: 'creating', provider_session_id: null });
    const retry = await handleCheckout(checkout(db), {
      fetch: stripe.fetch, now: () => NOW, outcomeSink: () => undefined,
    });
    assert.equal(retry.status, 409);
    assert.equal(stripe.checkoutCount, 1);
  });

  test('ready replay requires the exact persisted provider session ID', async () => {
    const db = new SqliteD1();
    const stripe = new StripeMock();
    assert.equal((await handleCheckout(checkout(db), {
      fetch: stripe.fetch, now: () => NOW, outcomeSink: () => undefined,
    })).status, 200);
    stripe.override = (call) => {
      if (!call.url.endsWith('/v1/checkout/sessions')) return null;
      const expiresAt = Number(new URLSearchParams(call.body).get('expires_at'));
      const id = 'cs_test_9999999999999999';
      return stripeJson({
        id, object: 'checkout.session', livemode: false, expires_at: expiresAt,
        customer: 'cus_0000000000000001', mode: 'subscription', status: 'open', subscription: null,
        url: `https://checkout.stripe.com/c/pay/${id}`,
      }, true);
    };
    const replay = await handleCheckout(checkout(db), {
      fetch: stripe.fetch, now: () => NOW, outcomeSink: () => undefined,
    });
    assert.equal(replay.status, 503);
    assert.equal(db.sqlite.prepare(
      'SELECT provider_session_id FROM billing_checkout_attempts WHERE owner_user_id = ?',
    ).get(OWNER_A)?.provider_session_id, 'cs_test_0000000000000001');
  });

  test('reconciles the exact expired Session before atomically creating a new generation', async () => {
    const db = new SqliteD1();
    const stripe = new StripeMock();
    assert.equal((await handleCheckout(checkout(db), {
      fetch: stripe.fetch, now: () => NOW, outcomeSink: () => undefined,
    })).status, 200);
    const original = db.sqlite.prepare(
      `SELECT lease_token, provider_session_id, provider_expires_at, lock_expires_at
         FROM billing_checkout_attempts WHERE owner_user_id = ?`,
    ).get(OWNER_A) as {
      lease_token: string;
      provider_session_id: string;
      provider_expires_at: number;
      lock_expires_at: number;
    };
    const providerSession = stripe.checkoutSessions.get(original.provider_session_id);
    assert.ok(providerSession);
    stripe.checkoutSessions.set(original.provider_session_id, {
      ...providerSession,
      status: 'expired',
      subscription: null,
    });
    const later = new Date(original.lock_expires_at * 1000);
    const response = await handleCheckout(
      checkout(db, { interval: 'year' }, { idempotencyKey: 'replacement-key-0001' }),
      { fetch: stripe.fetch, now: () => later, outcomeSink: () => undefined },
    );
    assert.equal(response.status, 200);
    assert.equal(stripe.checkoutCount, 2);
    const retrieval = stripe.calls.find((call) => call.method === 'GET');
    assert.equal(retrieval?.url, `https://api.stripe.com/v1/checkout/sessions/${original.provider_session_id}`);
    assert.equal(retrieval?.headers.get('idempotency-key'), null);
    const checkoutCalls = stripe.calls.filter((call) => call.url.endsWith('/v1/checkout/sessions'));
    assert.equal(checkoutCalls.length, 2);
    assert.notEqual(
      checkoutCalls[0].headers.get('idempotency-key'),
      checkoutCalls[1].headers.get('idempotency-key'),
    );
    const replacement = db.sqlite.prepare(
      `SELECT lease_token, state, provider_session_id, provider_expires_at
         FROM billing_checkout_attempts WHERE owner_user_id = ?`,
    ).get(OWNER_A) as Record<string, unknown>;
    assert.notEqual(replacement.lease_token, original.lease_token);
    assert.equal(replacement.state, 'ready');
    assert.equal(replacement.provider_session_id, 'cs_test_0000000000000002');
    assert.equal(replacement.provider_expires_at, original.lock_expires_at + 32 * 60);
  });

  test('does not let an aged terminal-recovery exception recycle an uncorrelated expired Session', async () => {
    const db = new SqliteD1();
    const stripe = new StripeMock();
    assert.equal((await handleCheckout(checkout(db), {
      fetch: stripe.fetch, now: () => NOW, outcomeSink: () => undefined,
    })).status, 200);
    const original = db.sqlite.prepare(
      `SELECT provider_session_id, provider_expires_at
         FROM billing_checkout_attempts WHERE owner_user_id = ?`,
    ).get(OWNER_A) as { provider_session_id: string; provider_expires_at: number };
    const providerSession = stripe.checkoutSessions.get(original.provider_session_id);
    assert.ok(providerSession);
    stripe.checkoutSessions.set(original.provider_session_id, {
      ...providerSession,
      status: 'expired',
      subscription: null,
    });
    db.sqlite.prepare(
      `INSERT INTO billing_subscriptions
         (owner_user_id, provider_customer_id, provider_subscription_id,
          provider_price_id, provider_price_quantity, provider_price_currency,
          provider_price_interval, status, current_period_end,
          cancel_at_period_end, last_event_created, last_event_id, updated_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, NULL, 'canceled', ?, 0, ?, ?, ?)`,
    ).run(
      OWNER_A,
      'cus_0000000000000001',
      'sub_0000000000000001',
      Math.floor(NOW.getTime() / 1000),
      Math.floor(NOW.getTime() / 1000),
      'evt_0000000000000091',
      NOW.toISOString(),
    );
    const outcomes: string[] = [];
    const agedAt = new Date((original.provider_expires_at + 72 * 60 * 60) * 1000);
    const response = await handleCheckout(
      checkout(db, { interval: 'year' }, { idempotencyKey: 'aged-expired-key-0001' }),
      { fetch: stripe.fetch, now: () => agedAt, outcomeSink: (value) => outcomes.push(value) },
    );
    assert.equal(response.status, 409);
    assert.equal(stripe.checkoutCount, 1);
    assert.equal(db.sqlite.prepare(
      'SELECT state FROM billing_checkout_attempts WHERE owner_user_id = ?',
    ).get(OWNER_A)?.state, 'manual_review');
    assert.equal(JSON.parse(outcomes.at(-1) ?? '{}').outcome, 'checkout_manual_review');
  });

  test('strict reconciliation blocks open, completed, subscribed and malformed exact-session results', async () => {
    for (const scenario of [
      {
        name: 'open', status: 'open', subscription: null,
        expectedState: 'ready', expectedSubscription: null,
        expectedStatus: 409, expectedOutcome: 'checkout_conflict',
      },
      {
        name: 'complete', status: 'complete', subscription: null,
        expectedState: 'ready', expectedSubscription: null, expectedStatus: 503,
        expectedOutcome: 'checkout_ambiguous_failure',
      },
      {
        name: 'subscribed', status: 'expired', subscription: 'sub_0000000000000001',
        expectedState: 'completed_pending_webhook',
        expectedSubscription: 'sub_0000000000000001', expectedStatus: 409,
        expectedOutcome: 'checkout_pending_webhook',
      },
    ] as const) {
      const db = new SqliteD1();
      const stripe = new StripeMock();
      assert.equal((await handleCheckout(checkout(db), {
        fetch: stripe.fetch, now: () => NOW, outcomeSink: () => undefined,
      })).status, 200);
      const row = db.sqlite.prepare(
        'SELECT provider_session_id, lock_expires_at FROM billing_checkout_attempts WHERE owner_user_id = ?',
      ).get(OWNER_A) as { provider_session_id: string; lock_expires_at: number };
      const providerSession = stripe.checkoutSessions.get(row.provider_session_id);
      assert.ok(providerSession);
      stripe.checkoutSessions.set(row.provider_session_id, {
        ...providerSession,
        status: scenario.status,
        subscription: scenario.subscription,
      });
      const outcomes: string[] = [];
      const response = await handleCheckout(checkout(db), {
        fetch: stripe.fetch,
        now: () => new Date(row.lock_expires_at * 1000),
        outcomeSink: (value) => outcomes.push(value),
      });
      assert.equal(response.status, scenario.expectedStatus, scenario.name);
      assert.deepEqual({ ...db.sqlite.prepare(
        `SELECT state, provider_subscription_id
           FROM billing_checkout_attempts WHERE owner_user_id = ?`,
      ).get(OWNER_A) }, {
        state: scenario.expectedState,
        provider_subscription_id: scenario.expectedSubscription,
      }, scenario.name);
      assert.equal(stripe.checkoutCount, 1, scenario.name);
      assert.equal(JSON.parse(outcomes[0] ?? '{}').outcome, scenario.expectedOutcome, scenario.name);
      if (scenario.name !== 'subscribed') assert.equal(response.headers.get('retry-after'), '60');
    }

    const db = new SqliteD1();
    const stripe = new StripeMock();
    assert.equal((await handleCheckout(checkout(db), {
      fetch: stripe.fetch, now: () => NOW, outcomeSink: () => undefined,
    })).status, 200);
    const row = db.sqlite.prepare(
      'SELECT provider_session_id, lock_expires_at FROM billing_checkout_attempts WHERE owner_user_id = ?',
    ).get(OWNER_A) as { provider_session_id: string; lock_expires_at: number };
    stripe.override = (call) => call.method === 'GET'
      ? stripeJson({
        ...(stripe.checkoutSessions.get(row.provider_session_id) ?? {}),
        customer: 'cus_wrong0000000000',
        status: 'expired',
        subscription: null,
      })
      : null;
    const malformed = await handleCheckout(checkout(db), {
      fetch: stripe.fetch,
      now: () => new Date(row.lock_expires_at * 1000),
      outcomeSink: () => undefined,
    });
    assert.equal(malformed.status, 503);
    assert.equal(malformed.headers.get('retry-after'), '60');
    assert.equal(db.sqlite.prepare(
      'SELECT state FROM billing_checkout_attempts WHERE owner_user_id = ?',
    ).get(OWNER_A)?.state, 'ready');
    assert.equal(stripe.checkoutCount, 1);
  });

  test('billing telemetry has one closed enum field and cannot serialize request data', async () => {
    assert.deepEqual(BILLING_OUTCOMES, [
      'checkout_created', 'checkout_replayed', 'checkout_conflict',
      'checkout_provider_rejected', 'checkout_provider_retryable', 'checkout_ambiguous_failure',
      'checkout_completion_failure', 'checkout_pending_webhook', 'checkout_manual_review',
      'portal_created', 'portal_replayed', 'portal_failure',
    ]);
    const db = new SqliteD1();
    const stripe = new StripeMock();
    const outcomes: string[] = [];
    const response = await handleCheckout(checkout(db), {
      fetch: stripe.fetch, now: () => NOW, outcomeSink: (value) => outcomes.push(value),
    });
    assert.equal(response.status, 200);
    assert.equal(outcomes.length, 1);
    const record = JSON.parse(outcomes[0]) as Record<string, unknown>;
    assert.deepEqual(Object.keys(record), ['schema_version', 'event', 'outcome']);
    assert.deepEqual(record, {
      schema_version: 1, event: 'billing_outcome', outcome: 'checkout_created',
    });
    assert.doesNotMatch(outcomes[0], /req-|user_|cus_|cs_|price_|https?:|sk_test/);
    logBillingOutcome('user_billing_alpha' as never, (value) => outcomes.push(value));
    assert.equal(outcomes.length, 1);
  });

  test('keeps an unbound empty customer recoverable and reuses it after a transient D1 bind failure', async () => {
    const db = new SqliteD1();
    const failingDb: D1DatabaseLike = {
      prepare(query) {
        const statement = db.prepare(query) as SqliteStatement;
        if (/INSERT INTO billing_customers/.test(query)) {
          return {
            bind() { return this; },
            async first<T>() { return null as T | null; },
            async all<T>() { return { success: true, results: [] as T[] }; },
            async run<T>(): Promise<D1ResultLike<T>> { throw new Error('D1 unavailable'); },
          };
        }
        return statement;
      },
      batch: db.batch.bind(db),
    };
    const stripe = new StripeMock();
    const response = await handleCheckout(checkout(failingDb), { fetch: stripe.fetch, now: () => NOW });
    assert.equal(response.status, 503);
    assert.equal(stripe.checkoutCount, 0);
    assert.equal(stripe.calls.some((call) => call.method === 'DELETE'), false);
    const retry = await handleCheckout(checkout(db), { fetch: stripe.fetch, now: () => NOW });
    assert.equal(retry.status, 200);
    assert.equal(stripe.customerCount, 1);
    assert.equal(db.sqlite.prepare(
      'SELECT provider_customer_id FROM billing_customers WHERE owner_user_id = ?',
    ).get(OWNER_A)?.provider_customer_id, 'cus_0000000000000001');
  });

  test('never compensates a provider customer already bound to another owner', async () => {
    const db = new SqliteD1();
    db.sqlite.prepare(
      `INSERT INTO billing_customers (owner_user_id, provider_customer_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(OWNER_A, 'cus_7777777777777777', NOW.toISOString(), NOW.toISOString());
    const stripe = new StripeMock();
    stripe.fixedCustomerId = 'cus_7777777777777777';
    const response = await handleCheckout(
      checkout(db, { interval: 'month' }, { owner: OWNER_B }),
      { fetch: stripe.fetch, now: () => NOW },
    );
    assert.equal(response.status, 503);
    assert.equal(stripe.checkoutCount, 0);
    assert.equal(stripe.calls.some((call) => call.method === 'DELETE'), false);
    assert.equal(db.sqlite.prepare(
      'SELECT owner_user_id FROM billing_customers WHERE provider_customer_id = ?',
    ).get('cus_7777777777777777')?.owner_user_id, OWNER_A);
  });
});

describe('authenticated billing portal API', () => {
  test('opens only the signed-in owner mapping with an exact fixed return URL', async () => {
    const db = new SqliteD1();
    db.sqlite.prepare(
      `INSERT INTO billing_customers (owner_user_id, provider_customer_id, created_at, updated_at)
       VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
    ).run(
      OWNER_A, 'cus_1111111111111111', NOW.toISOString(), NOW.toISOString(),
      OWNER_B, 'cus_2222222222222222', NOW.toISOString(), NOW.toISOString(),
    );
    const stripe = new StripeMock();
    const response = await handleBillingPortal(portal(db, {}, { owner: OWNER_B }), { fetch: stripe.fetch });
    assert.equal(response.status, 200);
    assert.match((await response.json() as { data: { url: string } }).data.url, /^https:\/\/billing\.stripe\.com\//);
    assert.deepEqual([...form(stripe.calls[0]).entries()], [
      ['customer', 'cus_2222222222222222'],
      ['return_url', 'http://localhost:8788/pricing'],
    ]);
    assert.doesNotMatch(stripe.calls[0].body, /user_|cus_1111111111111111|redirect/);
  });

  test('does not create or disclose a foreign billing account when the owner has none', async () => {
    const db = new SqliteD1();
    db.sqlite.prepare(
      `INSERT INTO billing_customers (owner_user_id, provider_customer_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(OWNER_A, 'cus_1111111111111111', NOW.toISOString(), NOW.toISOString());
    const stripe = new StripeMock();
    const response = await handleBillingPortal(portal(db, {}, { owner: OWNER_B }), { fetch: stripe.fetch });
    assert.equal(response.status, 404);
    const raw = await response.text();
    assert.doesNotMatch(raw, /cus_|user_billing_alpha/);
    assert.equal(stripe.calls.length, 0);
  });

  test('requires an empty object and rejects portal parameter injection', async () => {
    for (const body of [
      { customer: 'cus_attacker000001' },
      { returnUrl: 'https://evil.example' },
      { configuration: 'bpc_attacker000001' },
      [],
      null,
    ]) {
      const db = new SqliteD1();
      const stripe = new StripeMock();
      const response = await handleBillingPortal(portal(db, body), { fetch: stripe.fetch });
      assert.equal(response.status, 400);
      assert.equal(stripe.calls.length, 0);
    }
  });
});

function BILLING_TEST_BODY_LIMIT(): number {
  // One byte past the server's deliberately tiny billing-body cap without
  // exporting an implementation detail solely for tests.
  return 257;
}
