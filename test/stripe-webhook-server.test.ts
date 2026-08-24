import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { onRequest } from '../site/functions/api/stripe-webhook.ts';
import {
  bindBillingCustomer,
  getOwnerEntitlement,
} from '../site/src/lib/server/entitlement-store.ts';
import type {
  BuildPlansEnv,
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1ResultLike,
  PagesContextLike,
} from '../site/src/lib/server/pages-types.ts';
import {
  handleStripeWebhook,
  logStripeWebhookOutcome,
  STRIPE_WEBHOOK_API_VERSION,
  STRIPE_WEBHOOK_MAX_BODY_BYTES,
  STRIPE_WEBHOOK_OUTCOMES,
  STRIPE_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
} from '../site/src/lib/server/stripe-webhook.ts';

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

interface TestWebhookEnv extends BuildPlansEnv {
  STRIPE_WEBHOOK_SECRET?: string;
}

const SECRET = 'whsec_0123456789abcdefghijklmnopqrstuvwxyz';
const MONTHLY_PRICE_ID = 'price_0000000000000001';
const ANNUAL_PRICE_ID = 'price_0000000000000002';
const CUSTOMER_ID = 'cus_0000000000000001';
const SUBSCRIPTION_ID = 'sub_0000000000000001';
const OWNER_ID = 'user_account_alpha';
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

interface ItemOptions {
  id?: string;
  priceId?: string;
  quantity?: number;
  currency?: string;
  interval?: 'day' | 'week' | 'month' | 'year';
  intervalCount?: number;
  usageType?: 'licensed' | 'metered';
  billingScheme?: 'per_unit' | 'tiered';
  priceType?: 'recurring' | 'one_time';
  currentPeriodEnd?: number;
}

function stripeItem(options: ItemOptions = {}): Record<string, unknown> {
  const priceType = options.priceType ?? 'recurring';
  return {
    id: options.id ?? 'si_0000000000000001',
    object: 'subscription_item',
    current_period_end: options.currentPeriodEnd ?? unixNow() + 3_600,
    quantity: options.quantity ?? 1,
    price: {
      id: options.priceId ?? MONTHLY_PRICE_ID,
      object: 'price',
      type: priceType,
      billing_scheme: options.billingScheme ?? 'per_unit',
      currency: options.currency ?? 'usd',
      recurring: priceType === 'recurring' ? {
        interval: options.interval ?? 'month',
        interval_count: options.intervalCount ?? 1,
        usage_type: options.usageType ?? 'licensed',
      } : null,
    },
  };
}

interface EventOptions {
  id?: string;
  type?: string;
  apiVersion?: string;
  created?: number;
  livemode?: boolean;
  customerId?: string;
  subscriptionId?: string;
  status?: string;
  cancelAtPeriodEnd?: boolean;
  items?: unknown[];
  hasMore?: boolean;
  extra?: Record<string, unknown>;
}

function stripeEvent(options: EventOptions = {}): Record<string, unknown> {
  const livemode = options.livemode ?? false;
  return {
    id: options.id ?? 'evt_0000000000000001',
    object: 'event',
    api_version: options.apiVersion ?? STRIPE_WEBHOOK_API_VERSION,
    created: options.created ?? unixNow() - 1,
    livemode,
    type: options.type ?? 'customer.subscription.updated',
    data: {
      object: {
        id: options.subscriptionId ?? SUBSCRIPTION_ID,
        object: 'subscription',
        customer: options.customerId ?? CUSTOMER_ID,
        status: options.status ?? 'active',
        cancel_at_period_end: options.cancelAtPeriodEnd ?? false,
        livemode,
        items: {
          object: 'list',
          has_more: options.hasMore ?? false,
          data: options.items ?? [stripeItem()],
        },
      },
    },
    ...options.extra,
  };
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function hex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sign(body: string, timestamp: number, secret = SECRET): Promise<string> {
  const encoder = new TextEncoder();
  const bodyBytes = encoder.encode(body);
  const prefix = encoder.encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.byteLength + bodyBytes.byteLength);
  signed.set(prefix);
  signed.set(bodyBytes, prefix.byteLength);
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, signed));
}

interface RequestOptions {
  timestamp?: number;
  signatureHeader?: string | ((validSignature: string, timestamp: number) => string);
  contentType?: string;
  contentEncoding?: string;
  contentLength?: string;
  url?: string;
}

async function signedRequest(
  payload: unknown,
  options: RequestOptions = {},
): Promise<Request> {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const timestamp = options.timestamp ?? unixNow();
  const validSignature = await sign(body, timestamp);
  const signature = typeof options.signatureHeader === 'function'
    ? options.signatureHeader(validSignature, timestamp)
    : options.signatureHeader ?? `t=${timestamp},v1=${validSignature}`;
  const headers = new Headers({
    'content-type': options.contentType ?? 'application/json',
    'stripe-signature': signature,
  });
  if (options.contentEncoding) headers.set('content-encoding', options.contentEncoding);
  if (options.contentLength) headers.set('content-length', options.contentLength);
  return new Request(options.url ?? 'https://solvency.dev/api/stripe-webhook', {
    method: 'POST', headers, body,
  });
}

function context(
  db: D1DatabaseLike,
  request: Request,
  overrides: Partial<TestWebhookEnv> = {},
): PagesContextLike {
  const env: TestWebhookEnv = {
    DB: db,
    APP_ENV: 'preview',
    STRIPE_WEBHOOK_ENABLED: 'true',
    STRIPE_WEBHOOK_SECRET: SECRET,
    STRIPE_PRO_MONTHLY_PRICE_ID: MONTHLY_PRICE_ID,
    STRIPE_PRO_ANNUAL_PRICE_ID: ANNUAL_PRICE_ID,
    ...overrides,
  };
  return {
    request,
    env,
    params: {},
    data: { requestId: REQUEST_ID },
    next: async () => new Response(null, { status: 404 }),
  };
}

async function invoke(value: PagesContextLike): Promise<{
  response: Response;
  logs: string[];
}> {
  const logs: string[] = [];
  const original = console.info;
  console.info = (entry?: unknown) => { logs.push(String(entry)); };
  try {
    return { response: await handleStripeWebhook(value), logs };
  } finally {
    console.info = original;
  }
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

async function bindCustomer(db: SqliteD1): Promise<void> {
  assert.equal(await bindBillingCustomer(
    db, OWNER_ID, CUSTOMER_ID, new Date().toISOString(),
  ), 'bound');
}

async function entitlement(db: SqliteD1, now = unixNow()) {
  return getOwnerEntitlement(db, OWNER_ID, now, {
    monthlyPriceId: MONTHLY_PRICE_ID,
    annualPriceId: ANNUAL_PRICE_ID,
  });
}

describe('Stripe webhook request and signature boundary', () => {
  test('exports only a thin route and remains dark without the exact gate', async () => {
    assert.equal(onRequest, handleStripeWebhook);
    const db = new SqliteD1();
    let bodyAccesses = 0;
    const request = {
      method: 'POST',
      url: 'https://solvency.dev/api/stripe-webhook',
      headers: new Headers({ 'content-type': 'application/json' }),
      get body() {
        bodyAccesses += 1;
        throw new Error('dark handler accessed request body');
      },
    } as unknown as Request;
    const response = await handleStripeWebhook(context(db, request, {
      STRIPE_WEBHOOK_ENABLED: 'false',
    }));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(bodyAccesses, 0);

    const get = new Request('https://solvency.dev/api/stripe-webhook');
    assert.equal((await invoke(context(db, get))).response.status, 405);
    assert.equal((await invoke(context(
      db,
      await signedRequest(stripeEvent(), { url: 'https://solvency.dev/api/stripe-webhook?debug=1' }),
    ))).response.status, 400);
    assert.equal((await invoke(context(
      db,
      await signedRequest(stripeEvent()),
      { STRIPE_WEBHOOK_SECRET: undefined },
    ))).response.status, 503);
    for (const appEnv of [undefined, 'production-typo']) {
      assert.equal((await invoke(context(
        db,
        await signedRequest(stripeEvent()),
        { APP_ENV: appEnv },
      ))).response.status, 503);
    }
  });

  test('rejects declared and streamed overflow before unbounded allocation', async () => {
    const db = new SqliteD1();
    const timestamp = unixNow();
    let bodyAccesses = 0;
    const declared = {
      method: 'POST',
      url: 'https://solvency.dev/api/stripe-webhook',
      headers: new Headers({
        'content-type': 'application/json',
        'content-length': String(STRIPE_WEBHOOK_MAX_BODY_BYTES + 1),
        'stripe-signature': `t=${timestamp},v1=${'0'.repeat(64)}`,
      }),
      get body() {
        bodyAccesses += 1;
        throw new Error('oversized declaration accessed request body');
      },
    } as unknown as Request;
    assert.equal((await invoke(context(db, declared))).response.status, 413);
    assert.equal(bodyAccesses, 0);

    let canceled = false;
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(STRIPE_WEBHOOK_MAX_BODY_BYTES));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() { canceled = true; },
    });
    const streamed = new Request('https://solvency.dev/api/stripe-webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': `t=${timestamp},v1=${'0'.repeat(64)}`,
      },
      body: oversized,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    assert.equal((await invoke(context(db, streamed))).response.status, 413);
    assert.equal(canceled, true);

    assert.equal((await invoke(context(db, await signedRequest('{}', {
      contentLength: '+2',
    })))).response.status, 400);
    assert.equal((await invoke(context(db, await signedRequest('{}', {
      contentLength: '3',
    })))).response.status, 400);

    const locked = await signedRequest('{}');
    const lockedReader = locked.body?.getReader();
    assert.equal((await invoke(context(db, locked))).response.status, 400);
    await lockedReader?.cancel();
    lockedReader?.releaseLock();
  });

  test('requires JSON with identity encoding', async () => {
    const db = new SqliteD1();
    assert.equal((await invoke(context(db, await signedRequest(stripeEvent(), {
      contentType: 'text/plain',
    })))).response.status, 415);
    assert.equal((await invoke(context(db, await signedRequest(stripeEvent(), {
      contentEncoding: 'gzip',
    })))).response.status, 415);
    assert.equal((await invoke(context(db, await signedRequest(stripeEvent(), {
      contentType: 'application/json; charset=latin1',
    })))).response.status, 415);
    assert.equal((await invoke(context(db, await signedRequest(stripeEvent(), {
      contentType: 'application/json; charset=utf-8',
      contentEncoding: 'identity',
    })))).response.status, 409);
  });

  test('rejects bad, stale, future and ambiguous signatures but accepts any valid v1', async () => {
    const payload = stripeEvent();
    const db = new SqliteD1();
    await bindCustomer(db);

    assert.equal((await invoke(context(db, await signedRequest(payload, {
      signatureHeader: (_valid, timestamp) => `t=${timestamp},v1=${'0'.repeat(64)}`,
    })))).response.status, 400);
    assert.equal((await invoke(context(db, await signedRequest(payload, {
      timestamp: unixNow() - STRIPE_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS - 1,
    })))).response.status, 400);
    assert.equal((await invoke(context(db, await signedRequest(payload, {
      timestamp: unixNow() + STRIPE_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS + 1,
    })))).response.status, 400);
    assert.equal((await invoke(context(db, await signedRequest(payload, {
      signatureHeader: (valid, timestamp) => [
        `t=${timestamp}`, `v1=${'0'.repeat(64)}`, 'v0=legacy', `v1=${valid}`,
      ].join(','),
    })))).response.status, 200);

    const ambiguous = await signedRequest(stripeEvent({ id: 'evt_0000000000000002' }), {
      signatureHeader: (valid, timestamp) => `t=${timestamp},t=${timestamp},v1=${valid}`,
    });
    assert.equal((await invoke(context(db, ambiguous))).response.status, 400);
  });

  test('verifies the untouched bytes before UTF-8 decoding or JSON parsing', async () => {
    const db = new SqliteD1();
    const malformed = '{"id":"evt_hostile"';
    const invalidSignature = await signedRequest(malformed, {
      signatureHeader: (_valid, timestamp) => `t=${timestamp},v1=${'f'.repeat(64)}`,
    });
    const first = await invoke(context(db, invalidSignature));
    assert.equal(first.response.status, 400);
    assert.match(JSON.stringify(await responseBody(first.response)), /signature/i);

    const verifiedMalformed = await invoke(context(db, await signedRequest(malformed)));
    assert.equal(verifiedMalformed.response.status, 400);
    assert.equal(verifiedMalformed.response.headers.get('x-error-code'), 'INVALID_JSON');

    const source = readFileSync(new URL(
      '../site/src/lib/server/stripe-webhook.ts', import.meta.url,
    ), 'utf8');
    assert.doesNotMatch(source, /request\.(?:arrayBuffer|json|text)\s*\(/);
    assert.ok(source.indexOf('await verifySignature(body.bytes') < source.indexOf('parseJson(body.bytes)'));
    assert.ok(source.indexOf('await verifySignature(body.bytes') < source.indexOf('sha256Hex(body.bytes)'));
  });
});

describe('Stripe snapshot normalization and reducer integration', () => {
  test('pins API/livemode and reads Basil item-level period end', async () => {
    const rejected = new SqliteD1();
    await bindCustomer(rejected);
    for (const [payload, env] of [
      [stripeEvent({ apiVersion: '2025-07-30.basil' }), {}],
      [stripeEvent({ livemode: true }), {}],
      [stripeEvent({ livemode: false }), { APP_ENV: 'production' }],
    ] as const) {
      assert.equal((await invoke(context(
        rejected, await signedRequest(payload), env,
      ))).response.status, 400);
    }
    assert.equal(rejected.sqlite.prepare('SELECT COUNT(*) AS count FROM billing_events').get()?.count, 0);

    const db = new SqliteD1();
    await bindCustomer(db);
    const periodEnd = unixNow() + 1_234;
    const payload = stripeEvent({
      livemode: true,
      items: [stripeItem({ currentPeriodEnd: periodEnd })],
      extra: { current_period_end: periodEnd + 99_999 },
    });
    const response = await invoke(context(
      db, await signedRequest(payload), { APP_ENV: 'production' },
    ));
    assert.equal(response.response.status, 200);
    assert.equal((await entitlement(db)).currentPeriodEnd, new Date(periodEnd * 1000).toISOString());
  });

  test('never grants on wrong, mixed, quantity or unsupported price shapes', async () => {
    const variants: Array<{ label: string; items: unknown[]; hasMore?: boolean }> = [
      {
        label: 'wrong configured interval',
        items: [stripeItem({ interval: 'year' })],
      },
      {
        label: 'mixed prices',
        items: [
          stripeItem(),
          stripeItem({ id: 'si_0000000000000002', priceId: 'price_0000000000000099' }),
        ],
      },
      {
        label: 'quantity above one',
        items: [stripeItem({ quantity: 2 })],
      },
      {
        label: 'metered price',
        items: [stripeItem({ usageType: 'metered' })],
      },
      {
        label: 'tiered price',
        items: [stripeItem({ billingScheme: 'tiered' })],
      },
      {
        label: 'multi-period price',
        items: [stripeItem({ intervalCount: 2 })],
      },
    ];
    for (const [index, variant] of variants.entries()) {
      const db = new SqliteD1();
      await bindCustomer(db);
      const result = await invoke(context(db, await signedRequest(stripeEvent({
        id: `evt_00000000000001${String(index).padStart(2, '0')}`,
        items: variant.items,
        hasMore: variant.hasMore,
      }))));
      assert.equal(result.response.status, 200, variant.label);
      assert.equal((await entitlement(db)).tier, 'free', variant.label);
    }
  });

  test('rejects malformed allowlisted event shapes without a durable write', async () => {
    const db = new SqliteD1();
    await bindCustomer(db);
    const missingQuantity = stripeItem();
    delete missingQuantity.quantity;
    const missingPeriod = stripeItem();
    delete missingPeriod.current_period_end;
    const missingPriceObject = stripeItem();
    delete (missingPriceObject.price as Record<string, unknown>).object;
    const missingRecurring = stripeItem();
    delete (missingRecurring.price as Record<string, unknown>).recurring;
    const malformedOneTime = stripeItem({ priceType: 'one_time' });
    (malformedOneTime.price as Record<string, unknown>).recurring = {
      interval: 'month', interval_count: 1, usage_type: 'licensed',
    };
    for (const [index, candidate] of [
      { items: [missingQuantity] },
      { items: [missingPeriod] },
      { items: [missingPriceObject] },
      { items: [missingRecurring] },
      { items: [malformedOneTime] },
      { items: [] },
      { items: [stripeItem()], hasMore: true },
    ].entries()) {
      const response = await invoke(context(db, await signedRequest(stripeEvent({
        id: `evt_00000000000002${index}`,
        ...candidate,
      }))));
      assert.equal(response.response.status, 400);
    }
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM billing_events').get()?.count, 0);
  });

  test('hashes exact payload bytes and integrates replay, ordering and revocation', async () => {
    const db = new SqliteD1();
    await bindCustomer(db);
    const now = unixNow();
    const active = stripeEvent({ created: now - 10 });
    const raw = `${JSON.stringify(active, null, 2)}\n`;
    const first = await invoke(context(db, await signedRequest(raw)));
    assert.equal(first.response.status, 200);
    assert.deepEqual((await responseBody(first.response)).data, {
      received: true, ignored: false, replayed: false, applied: true,
    });
    const expectedHash = hex(await crypto.subtle.digest('SHA-256', bytes(raw)));
    assert.equal(db.sqlite.prepare(
      'SELECT payload_hash FROM billing_events WHERE provider_event_id = ?',
    ).get('evt_0000000000000001')?.payload_hash, expectedHash);
    assert.equal((await entitlement(db)).tier, 'pro');

    const replay = await invoke(context(db, await signedRequest(raw)));
    assert.deepEqual((await responseBody(replay.response)).data, {
      received: true, ignored: false, replayed: true, applied: false,
    });

    const stale = stripeEvent({
      id: 'evt_0000000000000002',
      type: 'customer.subscription.deleted',
      status: 'canceled',
      created: now - 20,
    });
    const staleResponse = await invoke(context(db, await signedRequest(stale)));
    assert.deepEqual((await responseBody(staleResponse.response)).data, {
      received: true, ignored: false, replayed: false, applied: false,
    });
    assert.equal((await entitlement(db)).tier, 'pro');

    const deleted = stripeEvent({
      id: 'evt_0000000000000003',
      type: 'customer.subscription.deleted',
      status: 'canceled',
      created: now,
    });
    const deletedResponse = await invoke(context(db, await signedRequest(deleted)));
    assert.equal(deletedResponse.response.status, 200);
    assert.equal((await entitlement(db)).tier, 'free');
    assert.deepEqual(deletedResponse.logs.map((entry) => JSON.parse(entry)), [{
      event: 'billing_webhook_outcome', outcome: 'accepted_applied',
    }]);
  });

  test('acknowledges signed unknown event types without touching billing state', async () => {
    const db = new SqliteD1();
    const result = await invoke(context(db, await signedRequest(stripeEvent({
      type: 'invoice.paid',
      extra: { data: { object: 'not-consumed' } },
    }))));
    assert.equal(result.response.status, 200);
    assert.deepEqual((await responseBody(result.response)).data, { received: true, ignored: true });
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM billing_events').get()?.count, 0);
    assert.deepEqual(result.logs.map((entry) => JSON.parse(entry)), [{
      event: 'billing_webhook_outcome', outcome: 'accepted_ignored',
    }]);
  });

  test('returns a retryable sanitized conflict when customer binding is not ready', async () => {
    const db = new SqliteD1();
    const result = await invoke(context(db, await signedRequest(stripeEvent())));
    assert.equal(result.response.status, 409);
    const serialized = JSON.stringify(await responseBody(result.response));
    assert.doesNotMatch(serialized, /cus_|sub_|evt_|price_/);
    assert.deepEqual(result.logs.map((entry) => JSON.parse(entry)), [{
      event: 'billing_webhook_outcome', outcome: 'retryable_failure',
    }]);
  });
});

describe('identifier-free webhook telemetry', () => {
  test('has a closed enum-only schema and cannot serialize hostile IDs or secrets', async () => {
    assert.deepEqual(STRIPE_WEBHOOK_OUTCOMES, [
      'accepted_applied', 'accepted_replay', 'accepted_stale', 'accepted_ignored',
      'rejected_signature', 'rejected_payload', 'retryable_failure',
    ]);
    const direct: string[] = [];
    logStripeWebhookOutcome(
      `evt_hostile_${SECRET}_${CUSTOMER_ID}`,
      (entry) => direct.push(entry),
    );
    assert.deepEqual(direct.map((entry) => JSON.parse(entry)), [{
      event: 'billing_webhook_outcome', outcome: 'retryable_failure',
    }]);

    const db = new SqliteD1();
    await bindCustomer(db);
    const hostile = `${SECRET}:${CUSTOMER_ID}:${SUBSCRIPTION_ID}:user_hostile`;
    const result = await invoke(context(db, await signedRequest(stripeEvent({
      extra: { metadata: { hostile }, description: hostile },
    }))));
    assert.equal(result.response.status, 200);
    assert.equal(result.logs.length, 1);
    assert.deepEqual(Object.keys(JSON.parse(result.logs[0])).sort(), ['event', 'outcome']);
    assert.doesNotMatch(result.logs[0], /whsec_|cus_|sub_|evt_|price_|user_/);
    assert.equal(result.logs[0].includes(hostile), false);
  });
});
