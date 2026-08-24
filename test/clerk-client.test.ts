import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  AuthenticatedJsonError,
  COMPOSER_AUTH_DRAFT_MAX_BYTES,
  authenticatedJsonFetch,
  consumeComposerDraftAfterAuth,
  observeClerkAuth,
  preserveComposerDraftForAuth,
} from '../site/src/lib/clerk-client.ts';

const originals = {
  window: (globalThis as any).window,
  document: (globalThis as any).document,
  location: (globalThis as any).location,
  sessionStorage: (globalThis as any).sessionStorage,
  fetch: globalThis.fetch,
};

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function setBrowser(clerk: unknown = undefined): MemoryStorage {
  const storage = new MemoryStorage();
  (globalThis as any).window = { Clerk: clerk };
  (globalThis as any).location = new URL('https://solvency.dev/build-planner/');
  (globalThis as any).sessionStorage = storage;
  (globalThis as any).document = {
    querySelector: () => null,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return storage;
}

afterEach(() => {
  (globalThis as any).window = originals.window;
  (globalThis as any).document = originals.document;
  (globalThis as any).location = originals.location;
  (globalThis as any).sessionStorage = originals.sessionStorage;
  globalThis.fetch = originals.fetch;
});

test('auth observer settles immediately when Clerk is disabled', () => {
  setBrowser();
  const states: string[] = [];
  const stop = observeClerkAuth((state) => states.push(state.status));
  assert.deepEqual(states, ['disabled']);
  stop();
});

test('auth observer reports loaded auth and unsubscribes', () => {
  let listener: (() => void) | undefined;
  let unsubscribed = false;
  const clerk = {
    loaded: true,
    user: { id: 'user_1' },
    session: { id: 'session_1' },
    addListener(callback: () => void) { listener = callback; return () => { unsubscribed = true; }; },
  };
  setBrowser(clerk);
  const states: string[] = [];
  const stop = observeClerkAuth((state) => states.push(state.status));
  clerk.user = null as any;
  listener?.();
  stop();
  assert.deepEqual(states, ['signed-in', 'signed-out']);
  assert.equal(unsubscribed, true);
});

test('auth observer settles an enabled Clerk load failure and may be stopped', async () => {
  setBrowser();
  const states: string[] = [];
  const stop = observeClerkAuth((state) => states.push(state.status), { enabled: true, timeoutMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  stop();
  assert.deepEqual(states, ['checking', 'error']);
});

test('authenticated JSON fetch sends a bearer token and retries one 401 with a fresh token', async () => {
  const tokenOptions: unknown[] = [];
  const session = {
    id: 'session_1',
    async getToken(options?: unknown) {
      tokenOptions.push(options);
      return options ? 'fresh-token' : 'cached-token';
    },
  };
  setBrowser({ loaded: true, user: { id: 'user_1' }, session });
  const authorizations: string[] = [];
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    authorizations.push(new Headers(init?.headers).get('authorization') ?? '');
    calls += 1;
    return calls === 1
      ? new Response(null, { status: 401 })
      : Response.json({ ok: true });
  };

  const result = await authenticatedJsonFetch<{ ok: boolean }>('/api/build-plans', {
    method: 'POST',
    json: { name: 'Canonical plan' },
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(authorizations, ['Bearer cached-token', 'Bearer fresh-token']);
  assert.deepEqual(tokenOptions, [undefined, { skipCache: true }]);
});

test('authenticated JSON fetch rejects cross-origin URLs before fetching', async () => {
  const session = { id: 'session_1', async getToken() { return 'token'; } };
  setBrowser({ loaded: true, user: { id: 'user_1' }, session });
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; return Response.json({}); };
  await assert.rejects(
    authenticatedJsonFetch('https://attacker.example/api/build-plans'),
    (error: unknown) => error instanceof AuthenticatedJsonError && error.code === 'INVALID_URL',
  );
  assert.equal(fetched, false);
});

test('authenticated JSON fetch rejects non-JSON request bodies before fetching', async () => {
  const session = { id: 'session_1', async getToken() { return 'token'; } };
  setBrowser({ loaded: true, user: { id: 'user_1' }, session });
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; return Response.json({}); };
  await assert.rejects(
    authenticatedJsonFetch('/api/build-plans', { method: 'POST', json: { invalid: Number.NaN } }),
    (error: unknown) => error instanceof AuthenticatedJsonError && error.code === 'INVALID_REQUEST',
  );
  assert.equal(fetched, false);
});

test('authenticated JSON errors never expose a response body', async () => {
  const session = { id: 'session_1', async getToken() { return 'token'; } };
  setBrowser({ loaded: true, user: { id: 'user_1' }, session });
  globalThis.fetch = async () => new Response('sensitive server detail', {
    status: 500,
    headers: { 'x-request-id': 'request_123' },
  });
  await assert.rejects(authenticatedJsonFetch('/api/build-plans'), (error: unknown) => {
    assert.ok(error instanceof AuthenticatedJsonError);
    assert.equal(error.code, 'SERVER_ERROR');
    assert.equal(error.requestId, 'request_123');
    assert.equal(error.message.includes('sensitive'), false);
    return true;
  });
});

test('authenticated JSON fetch allowlists trusted 409 error headers without reading response bodies', async () => {
  const session = { id: 'session_1', async getToken() { return 'token'; } };
  setBrowser({ loaded: true, user: { id: 'user_1' }, session });
  const cases = [
    ['PLAN_LIMIT', '20 plans'],
    ['VERSION_LIMIT', '100 versions'],
    ['VERSION_CONFLICT', 'changed since it was loaded'],
    ['IDEMPOTENCY_CONFLICT', 'earlier attempt'],
  ] as const;

  for (const [code, messageFragment] of cases) {
    globalThis.fetch = async () => new Response('sensitive server detail', {
      status: 409,
      headers: { 'x-error-code': code, 'x-request-id': `request_${code}` },
    });
    await assert.rejects(authenticatedJsonFetch('/api/build-plans'), (error: unknown) => {
      assert.ok(error instanceof AuthenticatedJsonError);
      assert.equal(error.code, code);
      assert.equal(error.requestId, `request_${code}`);
      assert.match(error.message, new RegExp(messageFragment));
      assert.equal(error.message.includes('sensitive'), false);
      return true;
    });
  }

  globalThis.fetch = async () => new Response('sensitive server detail', {
    status: 409,
    headers: { 'x-error-code': 'UNTRUSTED_CONFLICT' },
  });
  await assert.rejects(authenticatedJsonFetch('/api/build-plans'), (error: unknown) => {
    assert.ok(error instanceof AuthenticatedJsonError);
    assert.equal(error.code, 'CONFLICT');
    assert.equal(error.message.includes('sensitive'), false);
    return true;
  });
});

test('Composer auth draft storage is bounded, JSON-safe and one-shot', () => {
  setBrowser();
  const draft = { schemaVersion: 1, name: 'Canonical plan', roles: [{ modelId: 'model-1' }] };
  assert.equal(preserveComposerDraftForAuth(draft), true);
  assert.deepEqual(consumeComposerDraftAfterAuth(), draft);
  assert.equal(consumeComposerDraftAfterAuth(), null);
  assert.equal(preserveComposerDraftForAuth({ invalid: Number.NaN }), false);
  assert.equal(preserveComposerDraftForAuth({ value: 'x'.repeat(COMPOSER_AUTH_DRAFT_MAX_BYTES) }), false);
});

test('Composer auth draft storage expires old data and still removes it', () => {
  setBrowser();
  const now = Date.now;
  let time = 1_000_000;
  Date.now = () => time;
  try {
    assert.equal(preserveComposerDraftForAuth({ schemaVersion: 1 }), true);
    time += 31 * 60 * 1000;
    assert.equal(consumeComposerDraftAfterAuth(), null);
    assert.equal(consumeComposerDraftAfterAuth(), null);
  } finally {
    Date.now = now;
  }
});
