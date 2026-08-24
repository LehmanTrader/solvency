import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { apiJson } from '../site/src/lib/server/api-http.ts';
import { authenticateOwner, type AuthConfiguration } from '../site/src/lib/server/clerk-auth.ts';
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1ResultLike,
  PagesContextLike,
} from '../site/src/lib/server/pages-types.ts';
import { onRequest as apiMiddleware } from '../site/functions/api/_middleware.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const configuration: AuthConfiguration = {
  secretKey: 'sk_test_networkless',
  // A syntactically valid development publishable key whose payload is
  // "fake.clerk.accounts.dev$". JWT verification stays networkless because the
  // PEM key below is supplied explicitly.
  publishableKey: 'pk_test_ZmFrZS5jbGVyay5hY2NvdW50cy5kZXYk',
  jwtKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  authorizedParties: ['https://solvency.dev'],
};

type SessionClaims = {
  sub?: string;
  sid?: string;
  sts?: 'active' | 'pending' | 'ended';
  azp?: string;
  iat?: number;
  nbf?: number;
  exp?: number;
  v?: number;
};

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signSession(overrides: SessionClaims = {}, signingKey = privateKey): string {
  const now = Math.floor(Date.now() / 1_000);
  const header = encodeJson({ alg: 'RS256', typ: 'JWT', kid: 'test-session-key' });
  const payload = encodeJson({
    sub: 'user_account_alpha',
    sid: 'sess_account_alpha',
    sts: 'active',
    azp: 'https://solvency.dev',
    iat: now,
    nbf: now - 1,
    exp: now + 60,
    v: 2,
    ...overrides,
  });
  const unsigned = `${header}.${payload}`;
  const signature = createSign('RSA-SHA256')
    .update(unsigned)
    .end()
    .sign(signingKey)
    .toString('base64url');
  return `${unsigned}.${signature}`;
}

function bearerRequest(
  token: string,
  init: RequestInit = {},
  url = 'https://solvency.dev/api/build-plans',
): Request {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return new Request(url, { ...init, headers });
}

class RateStatement implements D1PreparedStatementLike {
  private readonly database: RateDatabase;
  readonly query: string;
  readonly values: unknown[];

  constructor(
    database: RateDatabase,
    query: string,
    values: unknown[] = [],
  ) {
    this.database = database;
    this.query = query;
    this.values = values;
  }

  bind(...values: unknown[]): D1PreparedStatementLike {
    return new RateStatement(this.database, this.query, values);
  }

  async first<T>(): Promise<T | null> {
    return null;
  }

  async all<T>(): Promise<D1ResultLike<T>> {
    this.database.rateLimitBinds.push(this.values);
    return { success: true, results: [{ request_count: 1 } as T] };
  }

  async run<T>(): Promise<D1ResultLike<T>> {
    return { success: true, results: [], meta: { changes: 0 } };
  }
}

class RateDatabase implements D1DatabaseLike {
  readonly prepareCalls: string[] = [];
  readonly rateLimitBinds: unknown[][] = [];

  prepare(query: string): D1PreparedStatementLike {
    this.prepareCalls.push(query);
    return new RateStatement(this, query);
  }

  async batch<T>(): Promise<Array<D1ResultLike<T>>> {
    throw new Error('The auth middleware test does not issue a storage batch.');
  }
}

function middlewareContext(request: Request, database = new RateDatabase()): PagesContextLike {
  const context: PagesContextLike = {
    request,
    env: {
      DB: database,
      ACCOUNT_PLANS_ENABLED: 'true',
      APP_ENV: 'production',
      CLERK_SECRET_KEY: configuration.secretKey,
      CLERK_JWT_KEY: configuration.jwtKey,
      CLERK_PUBLISHABLE_KEY: configuration.publishableKey,
      CLERK_AUTHORIZED_PARTIES: 'https://solvency.dev',
    },
    params: {},
    data: {},
    next: async () => apiJson({ ownerUserId: context.data.ownerUserId }),
  };
  return context;
}

describe('networkless Clerk server authentication', () => {
  test('verifies a real signed active session and returns only its subject owner', async () => {
    const result = await authenticateOwner(bearerRequest(signSession()), configuration);
    assert.deepEqual(result, { ok: true, ownerUserId: 'user_account_alpha' });
  });

  test('fails closed for the wrong party, pending session, expiry and signature', async () => {
    const now = Math.floor(Date.now() / 1_000);
    const { privateKey: foreignKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    for (const token of [
      signSession({ azp: 'https://evil.example' }),
      signSession({ sts: 'pending' }),
      signSession({ iat: now - 180, nbf: now - 180, exp: now - 120 }),
      signSession({}, foreignKey),
    ]) {
      assert.deepEqual(
        await authenticateOwner(bearerRequest(token), configuration),
        { ok: false, reason: 'unauthenticated' },
      );
    }
  });

  test('middleware derives the rate-limit owner from the signed token, never a header', async () => {
    const database = new RateDatabase();
    const request = bearerRequest(signSession(), {
      headers: { 'X-User-Id': 'user_account_attacker' },
    });
    const response = await apiMiddleware(middlewareContext(request, database));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ownerUserId: 'user_account_alpha' });
    assert.equal(database.rateLimitBinds.length, 1);
    assert.equal(database.rateLimitBinds[0]?.[0], 'user_account_alpha');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  test('Stripe webhook is disabled by default without calling next, D1 or reading the body', async () => {
    const database = new RateDatabase();
    const rawBody = '{"id":"evt_raw_body_must_remain_exact"}\n';
    for (const configured of [undefined, 'false']) {
      const request = new Request('https://solvency.dev/api/stripe-webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: rawBody,
      });
      const context = middlewareContext(request, database);
      context.env.STRIPE_WEBHOOK_ENABLED = configured;
      let nextCalls = 0;
      context.next = async () => { nextCalls += 1; return new Response(null, { status: 204 }); };
      const response = await apiMiddleware(context);
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('x-error-code'), 'SERVICE_UNAVAILABLE');
      assert.equal(nextCalls, 0);
      assert.equal(request.bodyUsed, false);
    }
    assert.equal(database.prepareCalls.length, 0);
    assert.equal(database.rateLimitBinds.length, 0);
  });

  test('enabled exact Stripe webhook POST bypasses account boundaries with its raw body untouched', async () => {
    const database = new RateDatabase();
    const rawBody = '{"id":"evt_raw_body_must_remain_exact"}\n';
    const request = new Request('https://solvency.dev/api/stripe-webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': 't=123,v1=test-only',
      },
      body: rawBody,
    });
    const context = middlewareContext(request, database);
    context.env.STRIPE_WEBHOOK_ENABLED = 'true';
    context.env.ACCOUNT_PLANS_ENABLED = 'false';
    context.env.ENTITLEMENTS_ENABLED = 'false';
    context.env.CLERK_SECRET_KEY = undefined;
    context.env.CLERK_JWT_KEY = undefined;
    context.env.CLERK_PUBLISHABLE_KEY = undefined;
    let nextCalls = 0;
    context.next = async () => {
      nextCalls += 1;
      assert.equal(context.request.bodyUsed, false);
      assert.equal(await context.request.text(), rawBody);
      return new Response(null, { status: 204 });
    };
    const response = await apiMiddleware(context);
    assert.equal(response.status, 204);
    assert.equal(nextCalls, 1);
    assert.equal(database.prepareCalls.length, 0);
    assert.equal(database.rateLimitBinds.length, 0);
  });

  test('enabled Stripe webhook rejects non-POST methods and query strings before next or body access', async () => {
    const database = new RateDatabase();
    let nextCalls = 0;
    const getContext = middlewareContext(new Request('https://solvency.dev/api/stripe-webhook'), database);
    getContext.env.STRIPE_WEBHOOK_ENABLED = 'true';
    getContext.next = async () => { nextCalls += 1; return new Response(null, { status: 204 }); };
    const getResponse = await apiMiddleware(getContext);
    assert.equal(getResponse.status, 405);
    assert.equal(getResponse.headers.get('allow'), 'POST');

    const queryRequest = new Request('https://solvency.dev/api/stripe-webhook?expand=data.object', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"id":"evt_query_rejected"}',
    });
    const queryContext = middlewareContext(queryRequest, database);
    queryContext.env.STRIPE_WEBHOOK_ENABLED = 'true';
    queryContext.next = async () => { nextCalls += 1; return new Response(null, { status: 204 }); };
    const queryResponse = await apiMiddleware(queryContext);
    assert.equal(queryResponse.status, 400);
    assert.equal(queryResponse.headers.get('x-error-code'), 'INVALID_REQUEST');
    assert.equal(queryRequest.bodyUsed, false);
    assert.equal(nextCalls, 0);
    assert.equal(database.prepareCalls.length, 0);
    assert.equal(database.rateLimitBinds.length, 0);
  });

  test('an adjacent webhook path retains the normal account boundary', async () => {
    const database = new RateDatabase();
    const rawBody = '{"id":"evt_adjacent_path"}';

    const adjacent = middlewareContext(new Request('https://solvency.dev/api/stripe-webhooks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: rawBody,
    }), database);
    adjacent.env.STRIPE_WEBHOOK_ENABLED = 'true';
    adjacent.env.ACCOUNT_PLANS_ENABLED = 'false';
    adjacent.env.ENTITLEMENTS_ENABLED = 'false';
    adjacent.env.CLERK_SECRET_KEY = undefined;
    let adjacentNextCalls = 0;
    adjacent.next = async () => { adjacentNextCalls += 1; return new Response(null, { status: 204 }); };
    const denied = await apiMiddleware(adjacent);
    assert.equal(denied.status, 503);
    assert.equal(adjacentNextCalls, 0);
    assert.equal(database.prepareCalls.length, 0);
    assert.equal(database.rateLimitBinds.length, 0);
    assert.equal(adjacent.request.bodyUsed, false);
  });

  test('Checkout and Portal are independently disabled before auth, D1, next or body access', async () => {
    for (const [path, flag] of [
      ['/api/checkout', 'STRIPE_CHECKOUT_ENABLED'],
      ['/api/billing-portal', 'STRIPE_PORTAL_ENABLED'],
    ] as const) {
      for (const configured of [undefined, 'false']) {
        const database = new RateDatabase();
        const request = new Request(`https://solvency.dev${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{"must":"remain unread"}',
        });
        const context = middlewareContext(request, database);
        context.env.ACCOUNT_PLANS_ENABLED = 'true';
        context.env[flag] = configured;
        let nextCalls = 0;
        context.next = async () => { nextCalls += 1; return new Response(null, { status: 204 }); };

        const response = await apiMiddleware(context);
        assert.equal(response.status, 503);
        assert.equal(response.headers.get('x-error-code'), 'SERVICE_UNAVAILABLE');
        assert.equal(nextCalls, 0);
        assert.equal(request.bodyUsed, false);
        assert.equal(database.prepareCalls.length, 0);
        assert.equal(database.rateLimitBinds.length, 0);
      }
    }
  });

  test('enabled Checkout and Portal retain exact-origin Clerk auth and owner rate limits', async () => {
    for (const [path, flag] of [
      ['/api/checkout', 'STRIPE_CHECKOUT_ENABLED'],
      ['/api/billing-portal', 'STRIPE_PORTAL_ENABLED'],
    ] as const) {
      const database = new RateDatabase();
      const context = middlewareContext(bearerRequest(
        signSession(),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://solvency.dev',
            'Sec-Fetch-Site': 'same-origin',
          },
          body: '{}',
        },
        `https://solvency.dev${path}`,
      ), database);
      context.env.ACCOUNT_PLANS_ENABLED = 'false';
      context.env.ENTITLEMENTS_ENABLED = 'false';
      context.env[flag] = 'true';

      const response = await apiMiddleware(context);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ownerUserId: 'user_account_alpha' });
      assert.equal(database.rateLimitBinds.length, 1);
      assert.equal(database.rateLimitBinds[0]?.[0], 'user_account_alpha');

      const unauthenticatedDatabase = new RateDatabase();
      const unauthenticatedRequest = new Request(`https://solvency.dev${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://solvency.dev',
          'Sec-Fetch-Site': 'same-origin',
        },
        body: '{}',
      });
      const unauthenticated = middlewareContext(unauthenticatedRequest, unauthenticatedDatabase);
      unauthenticated.env[flag] = 'true';
      const denied = await apiMiddleware(unauthenticated);
      assert.equal(denied.status, 401);
      assert.equal(denied.headers.get('x-error-code'), 'AUTH_REQUIRED');
      assert.equal(unauthenticatedDatabase.rateLimitBinds.length, 0);
    }
  });

  test('entitlement reads use their own rollout flag while retaining verified-owner auth and rate limits', async () => {
    const database = new RateDatabase();
    const enabled = middlewareContext(bearerRequest(
      signSession(),
      {},
      'https://solvency.dev/api/entitlement',
    ), database);
    enabled.env.ACCOUNT_PLANS_ENABLED = 'false';
    enabled.env.ENTITLEMENTS_ENABLED = 'true';
    const response = await apiMiddleware(enabled);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ownerUserId: 'user_account_alpha' });
    assert.equal(database.rateLimitBinds.length, 1);

    const disabledDatabase = new RateDatabase();
    const disabled = middlewareContext(bearerRequest(
      signSession(),
      {},
      'https://solvency.dev/api/entitlement',
    ), disabledDatabase);
    disabled.env.ACCOUNT_PLANS_ENABLED = 'true';
    disabled.env.ENTITLEMENTS_ENABLED = 'false';
    const denied = await apiMiddleware(disabled);
    assert.equal(denied.status, 503);
    assert.equal(disabledDatabase.rateLimitBinds.length, 0);
  });

  test('product-intent writes use their own rollout flag while retaining verified-owner auth and rate limits', async () => {
    const database = new RateDatabase();
    const enabled = middlewareContext(bearerRequest(
      signSession(),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://solvency.dev',
          'Sec-Fetch-Site': 'same-origin',
        },
        body: JSON.stringify({ eventId: crypto.randomUUID(), name: 'planner_started' }),
      },
      'https://solvency.dev/api/intents',
    ), database);
    enabled.env.ACCOUNT_PLANS_ENABLED = 'false';
    enabled.env.ENTITLEMENTS_ENABLED = 'false';
    enabled.env.PRODUCT_INTENTS_ENABLED = 'true';
    const response = await apiMiddleware(enabled);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ownerUserId: 'user_account_alpha' });
    assert.equal(database.rateLimitBinds.length, 1);

    const disabledDatabase = new RateDatabase();
    const disabled = middlewareContext(bearerRequest(
      signSession(),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://solvency.dev',
          'Sec-Fetch-Site': 'same-origin',
        },
        body: JSON.stringify({ eventId: crypto.randomUUID(), name: 'planner_started' }),
      },
      'https://solvency.dev/api/intents',
    ), disabledDatabase);
    disabled.env.ACCOUNT_PLANS_ENABLED = 'true';
    disabled.env.ENTITLEMENTS_ENABLED = 'true';
    disabled.env.PRODUCT_INTENTS_ENABLED = 'false';
    const denied = await apiMiddleware(disabled);
    assert.equal(denied.status, 503);
    assert.equal(disabledDatabase.rateLimitBinds.length, 0);
  });

  test('preview account erasure has an exact preview-only gate and retains auth, origin and rate limits', async () => {
    const previewOrigin = 'https://d1-functions-preview.solvency-ru5.pages.dev';
    const database = new RateDatabase();
    const enabled = middlewareContext(bearerRequest(
      signSession({ azp: previewOrigin }),
      {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Origin: previewOrigin,
          'Sec-Fetch-Site': 'same-origin',
        },
      },
      `${previewOrigin}/api/preview-account-erasure`,
    ), database);
    enabled.env.APP_ENV = 'preview';
    enabled.env.CLERK_AUTHORIZED_PARTIES = previewOrigin;
    enabled.env.ACCOUNT_PLANS_ENABLED = 'false';
    enabled.env.PREVIEW_ACCOUNT_ERASURE_ENABLED = 'true';
    const response = await apiMiddleware(enabled);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ownerUserId: 'user_account_alpha' });
    assert.equal(database.rateLimitBinds.length, 1);

    for (const [url, appEnv, flag] of [
      ['https://solvency.dev/api/preview-account-erasure', 'production', 'true'],
      [`${previewOrigin}/api/preview-account-erasure`, 'preview', 'false'],
      [`${previewOrigin}/api/preview-account-erasures`, 'preview', 'true'],
    ] as const) {
      const deniedDatabase = new RateDatabase();
      const denied = middlewareContext(bearerRequest(signSession({ azp: new URL(url).origin }), {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Origin: new URL(url).origin,
          'Sec-Fetch-Site': 'same-origin',
        },
      }, url), deniedDatabase);
      denied.env.APP_ENV = appEnv;
      denied.env.CLERK_AUTHORIZED_PARTIES = new URL(url).origin;
      denied.env.PREVIEW_ACCOUNT_ERASURE_ENABLED = flag;
      const rejected = await apiMiddleware(denied);
      assert.equal(rejected.status, 503);
      assert.equal(deniedDatabase.rateLimitBinds.length, 0);
    }
  });

  test('preview account erasure fails closed while any Stripe surface is enabled', async () => {
    const previewOrigin = 'https://d1-functions-preview.solvency-ru5.pages.dev';
    for (const stripeFlag of [
      'STRIPE_CHECKOUT_ENABLED',
      'STRIPE_PORTAL_ENABLED',
      'STRIPE_WEBHOOK_ENABLED',
    ] as const) {
      const database = new RateDatabase();
      const context = middlewareContext(bearerRequest(
        signSession({ azp: previewOrigin }),
        {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            Origin: previewOrigin,
            'Sec-Fetch-Site': 'same-origin',
          },
        },
        `${previewOrigin}/api/preview-account-erasure`,
      ), database);
      context.env.APP_ENV = 'preview';
      context.env.CLERK_AUTHORIZED_PARTIES = previewOrigin;
      context.env.PREVIEW_ACCOUNT_ERASURE_ENABLED = 'true';
      context.env[stripeFlag] = 'true';
      let nextCalls = 0;
      context.next = async () => { nextCalls += 1; return new Response(null, { status: 204 }); };

      const response = await apiMiddleware(context);
      assert.equal(response.status, 503, stripeFlag);
      assert.equal(response.headers.get('x-error-code'), 'SERVICE_UNAVAILABLE', stripeFlag);
      assert.equal(nextCalls, 0, stripeFlag);
      assert.equal(database.rateLimitBinds.length, 0, stripeFlag);
    }
  });

  test('rejects an invalid token before rate limiting', async () => {
    const database = new RateDatabase();
    const response = await apiMiddleware(middlewareContext(
      bearerRequest(`${signSession()}tampered`),
      database,
    ));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('x-error-code'), 'AUTH_REQUIRED');
    assert.equal(database.rateLimitBinds.length, 0);
  });

  test('rejects a cross-origin mutation before authentication or storage', async () => {
    const database = new RateDatabase();
    const response = await apiMiddleware(middlewareContext(bearerRequest(signSession(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: '{}',
    }), database));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('x-error-code'), 'ORIGIN_FORBIDDEN');
    assert.equal(database.rateLimitBinds.length, 0);
  });
});
