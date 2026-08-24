import test from 'node:test';
import assert from 'node:assert/strict';
import {
  handlePreviewAccountErasure,
  PREVIEW_ACCOUNT_ERASURE_CONFIRMATION,
  PREVIEW_ACCOUNT_ERASURE_ORIGIN,
  PREVIEW_ACCOUNT_ERASURE_PATH,
} from '../site/src/lib/server/account-data-api.ts';
import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1ResultLike,
  PagesContextLike,
} from '../site/src/lib/server/pages-types.ts';

class ErasureStatement implements D1PreparedStatementLike {
  readonly query: string;
  readonly values: unknown[];

  constructor(query: string, values: unknown[] = []) {
    this.query = query;
    this.values = values;
  }

  bind(...values: unknown[]): D1PreparedStatementLike {
    return new ErasureStatement(this.query, values);
  }

  async first<T>(): Promise<T | null> { return null; }
  async all<T>(): Promise<D1ResultLike<T>> { return { success: true, results: [] }; }
  async run<T>(): Promise<D1ResultLike<T>> { return { success: true, results: [], meta: { changes: 0 } }; }
}

class ErasureDatabase implements D1DatabaseLike {
  batches: ErasureStatement[][] = [];

  prepare(query: string): D1PreparedStatementLike { return new ErasureStatement(query); }

  async batch<T>(statements: D1PreparedStatementLike[]): Promise<Array<D1ResultLike<T>>> {
    this.batches.push(statements as ErasureStatement[]);
    return statements.map(() => ({ success: true, results: [], meta: { changes: 1 } }));
  }
}

function context(
  request: Request,
  database: D1DatabaseLike = new ErasureDatabase(),
  env: Partial<PagesContextLike['env']> = {},
): PagesContextLike {
  return {
    request,
    env: {
      DB: database,
      APP_ENV: 'preview',
      PREVIEW_ACCOUNT_ERASURE_ENABLED: 'true',
      ...env,
    },
    params: {},
    data: { ownerUserId: 'user_preview_smoke_alpha', requestId: 'request-preview-erasure' },
    next: async () => new Response(null, { status: 204 }),
  };
}

function erasureRequest(options: { url?: string; method?: string; body?: string; confirmation?: string } = {}): Request {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'X-Preview-Erasure-Confirm': options.confirmation ?? PREVIEW_ACCOUNT_ERASURE_CONFIRMATION,
  });
  return new Request(options.url ?? `${PREVIEW_ACCOUNT_ERASURE_ORIGIN}${PREVIEW_ACCOUNT_ERASURE_PATH}`, {
    method: options.method ?? 'DELETE',
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

test('preview erasure deletes every owner-keyed D1 group and returns no identity', async () => {
  const database = new ErasureDatabase();
  const response = await handlePreviewAccountErasure(context(erasureRequest(), database));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { erased: true } });
  assert.equal(database.batches.length, 1);
  assert.equal(database.batches[0]?.length, 9);
  assert.ok(database.batches[0]?.every((statement) => statement.values[0] === 'user_preview_smoke_alpha'));
});

test('preview erasure is production-dark before any D1 access', async () => {
  const unavailable: D1DatabaseLike = {
    prepare() { throw new Error('D1 must not be touched'); },
    async batch() { throw new Error('D1 must not be touched'); },
  };
  const response = await handlePreviewAccountErasure(context(erasureRequest(), unavailable, {
    APP_ENV: 'production',
    PREVIEW_ACCOUNT_ERASURE_ENABLED: 'true',
  }));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('x-error-code'), 'SERVICE_UNAVAILABLE');
});

test('preview erasure requires its exact route, confirmation and an empty DELETE body', async () => {
  for (const [request, expected] of [
    [erasureRequest({ method: 'POST' }), 405],
    [erasureRequest({ url: `${PREVIEW_ACCOUNT_ERASURE_ORIGIN}${PREVIEW_ACCOUNT_ERASURE_PATH}?all=true` }), 400],
    [erasureRequest({ confirmation: 'DELETE_SOMEONE_ELSE' }), 400],
    [erasureRequest({ body: '{}' }), 400],
  ] as const) {
    const database = new ErasureDatabase();
    const response = await handlePreviewAccountErasure(context(request, database));
    assert.equal(response.status, expected);
    assert.equal(database.batches.length, 0);
  }
});
