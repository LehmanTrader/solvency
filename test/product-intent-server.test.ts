import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handleProductIntent } from '../site/src/lib/server/product-intent-api.ts';
import {
  CLIENT_PRODUCT_INTENT_NAMES,
  PRODUCT_INTENT_NAMES,
  PRODUCT_INTENT_OWNER_LIMIT,
  PRODUCT_INTENT_PRICE_EXPERIMENT_ID,
  PRODUCT_INTENT_RETENTION_SECONDS,
  PRODUCT_INTENT_SIGNAL_VERSION,
  SERVER_CONFIRMED_PRODUCT_INTENT_NAMES,
  recordProductIntent,
} from '../site/src/lib/server/product-intent-store.ts';
import type {
  D1DatabaseLike, D1PreparedStatementLike, D1ResultLike, PagesContextLike,
} from '../site/src/lib/server/pages-types.ts';

const migration = readFileSync(
  new URL('../site/migrations/0006_product_intent_events.sql', import.meta.url),
  'utf8',
);

class Statement implements D1PreparedStatementLike {
  private readonly database: DatabaseSync;
  private readonly query: string;
  private readonly values: unknown[];
  constructor(database: DatabaseSync, query: string, values: unknown[] = []) {
    this.database = database;
    this.query = query;
    this.values = values;
  }
  bind(...values: unknown[]): D1PreparedStatementLike {
    return new Statement(this.database, this.query, values);
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
  constructor() { this.sqlite.exec(migration); }
  prepare(query: string): D1PreparedStatementLike { return new Statement(this.sqlite, query); }
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

const OWNER_A = 'user_intent_alpha';
const OWNER_B = 'user_intent_bravo';
const NOW = 1_787_486_400;

function uuid(index: number): string {
  return `${index.toString(16).padStart(8, '0')}-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function context(
  db: D1DatabaseLike,
  body: unknown,
  ownerUserId: string | undefined = OWNER_A,
  url = 'https://solvency.dev/api/intents',
): PagesContextLike {
  return {
    request: new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env: { DB: db }, params: {}, data: { ownerUserId, requestId: 'req-intent' },
    next: async () => new Response(null, { status: 404 }),
  };
}

describe('append-only product-intent measurement', () => {
  test('stores only closed names with a server-selected version, experiment and owner isolation', async () => {
    const db = new SqliteD1();
    for (const [index, eventName] of PRODUCT_INTENT_NAMES.entries()) {
      assert.deepEqual(await recordProductIntent(db, {
        ownerUserId: OWNER_A, eventId: uuid(index + 1), eventName, nowSeconds: NOW + index,
      }), { ok: true, replayed: false });
    }
    assert.deepEqual(await recordProductIntent(db, {
      ownerUserId: OWNER_B, eventId: uuid(1), eventName: 'planner_started', nowSeconds: NOW,
    }), { ok: true, replayed: false });
    const rows = db.sqlite.prepare(
      `SELECT owner_user_id, event_id, event_name, signal_version, price_experiment_id,
              recorded_at, expires_at
         FROM product_intent_events ORDER BY owner_user_id, event_id`,
    ).all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 8);
    assert.equal(rows[0].recorded_at, NOW);
    assert.equal(rows[0].expires_at, NOW + PRODUCT_INTENT_RETENTION_SECONDS);
    assert.equal(rows.every((row) => row.signal_version === PRODUCT_INTENT_SIGNAL_VERSION), true);
    assert.equal(rows.every((row) => row.price_experiment_id === PRODUCT_INTENT_PRICE_EXPERIMENT_ID), true);
    assert.equal(rows.some((row) => Object.keys(row).some((key) => /plan_json|path|rate|threshold|payload|body/.test(key))), false);
  });

  test('deduplicates one owner and semantic event for 90 days while preserving UUID conflicts', async () => {
    const db = new SqliteD1();
    const input = { ownerUserId: OWNER_A, eventId: uuid(20), eventName: 'valid_quote_created' as const, nowSeconds: NOW };
    const [first, raced] = await Promise.all([recordProductIntent(db, input), recordProductIntent(db, input)]);
    assert.equal([first, raced].filter((result) => result.ok && !result.replayed).length, 1);
    assert.equal([first, raced].filter((result) => result.ok && result.replayed).length, 1);
    assert.deepEqual(await recordProductIntent(db, { ...input, eventId: uuid(21) }), {
      ok: true, replayed: true,
    });
    assert.deepEqual(await recordProductIntent(db, { ...input, eventName: 'export_downloaded' }), {
      ok: false, reason: 'idempotency_conflict',
    });
    assert.deepEqual(await recordProductIntent(db, { ...input, ownerUserId: OWNER_B, eventId: uuid(21) }), {
      ok: true, replayed: false,
    });
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM product_intent_events').get()?.count, 2);
  });

  test('prunes expired owner rows and enforces immutable, closed, quota-bounded rows', async () => {
    const db = new SqliteD1();
    await recordProductIntent(db, {
      ownerUserId: OWNER_A, eventId: uuid(30), eventName: 'planner_started', nowSeconds: NOW,
    });
    await recordProductIntent(db, {
      ownerUserId: OWNER_A, eventId: uuid(31), eventName: 'planner_started',
      nowSeconds: NOW + PRODUCT_INTENT_RETENTION_SECONDS,
    });
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM product_intent_events').get()?.count, 1);
    assert.throws(() => db.sqlite.prepare(
      'UPDATE product_intent_events SET event_name = ? WHERE owner_user_id = ?',
    ).run('share_created', OWNER_A), /IMMUTABLE_PRODUCT_INTENT/);

    assert.equal(PRODUCT_INTENT_OWNER_LIMIT, 512);
    const migrationText = migration;
    assert.match(migrationText, /OWNER_PRODUCT_INTENT_LIMIT/);
    assert.match(migrationText, />= 512/);
    const constrainedInsert = db.sqlite.prepare(
      `INSERT INTO product_intent_events
         (owner_user_id, event_id, event_name, signal_version, price_experiment_id,
          recorded_at, expires_at)
       VALUES (?, ?, 'export_downloaded', ?, ?, ?, ?)`,
    );
    assert.throws(() => constrainedInsert.run(
      OWNER_A, uuid(40), 2, PRODUCT_INTENT_PRICE_EXPERIMENT_ID,
      NOW, NOW + PRODUCT_INTENT_RETENTION_SECONDS,
    ));
    assert.throws(() => constrainedInsert.run(
      OWNER_A, uuid(41), PRODUCT_INTENT_SIGNAL_VERSION, 'client_supplied_experiment',
      NOW, NOW + PRODUCT_INTENT_RETENTION_SECONDS,
    ));
  });

  test('API requires verified ownership, exact bounded JSON and echoes no submitted fields', async () => {
    const db = new SqliteD1();
    const hostile = '<secret-plan path=/internal rate=99 threshold=7>';
    const wrongMethod = context(db, { eventId: uuid(49), name: 'planner_started' });
    wrongMethod.request = new Request('https://solvency.dev/api/intents');
    assert.equal((await handleProductIntent(wrongMethod, NOW)).status, 405);
    assert.equal((await handleProductIntent(context(db, 'x'.repeat(513)), NOW)).status, 413);
    const wrongMedia = context(db, { eventId: uuid(49), name: 'planner_started' });
    wrongMedia.request = new Request('https://solvency.dev/api/intents', {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}',
    });
    assert.equal((await handleProductIntent(wrongMedia, NOW)).status, 415);
    const extra = await handleProductIntent(context(db, {
      eventId: uuid(50), name: 'planner_started', path: hostile,
    }), NOW);
    assert.equal(extra.status, 422);
    assert.equal((await extra.text()).includes(hostile), false);

    assert.equal((await handleProductIntent(context(db, {
      eventId: uuid(50), name: 'not_allowed',
    }), NOW)).status, 422);
    for (const name of SERVER_CONFIRMED_PRODUCT_INTENT_NAMES) {
      assert.equal((await handleProductIntent(context(db, {
        eventId: uuid(60), name,
      }), NOW)).status, 422);
    }
    assert.equal((await handleProductIntent(context(db, {
      eventId: uuid(61), name: CLIENT_PRODUCT_INTENT_NAMES[0], signalVersion: 99,
    }), NOW)).status, 422);
    assert.equal((await handleProductIntent(context(db, {
      eventId: uuid(62), name: CLIENT_PRODUCT_INTENT_NAMES[0], priceExperimentId: 'forged',
    }), NOW)).status, 422);
    const unauthenticated = context(db, { eventId: uuid(50), name: 'planner_started' });
    unauthenticated.data.ownerUserId = undefined;
    assert.equal((await handleProductIntent(unauthenticated, NOW)).status, 503);
    const query = context(db, { eventId: uuid(50), name: 'planner_started' }, OWNER_A, 'https://solvency.dev/api/intents?path=secret');
    assert.equal((await handleProductIntent(query, NOW)).status, 400);

    const accepted = await handleProductIntent(context(db, {
      eventId: uuid(50), name: 'pro_price_interest',
    }), NOW);
    assert.equal(accepted.status, 201);
    assert.deepEqual(await accepted.json(), { data: { accepted: true, replayed: false } });
    const replay = await handleProductIntent(context(db, {
      eventId: uuid(50), name: 'pro_price_interest',
    }), NOW + 1);
    assert.equal(replay.status, 200);
    const raw = await replay.text();
    assert.deepEqual(JSON.parse(raw), { data: { accepted: true, replayed: true } });
    assert.equal(raw.includes(uuid(50)), false);
    assert.equal(raw.includes('pro_price_interest'), false);
  });

  test('migration and route expose only the narrow append endpoint', () => {
    const db = new SqliteD1();
    const columns = db.sqlite.prepare("PRAGMA table_info('product_intent_events')").all().map((row) => row.name);
    assert.deepEqual(columns, [
      'owner_user_id', 'event_id', 'event_name', 'signal_version', 'price_experiment_id',
      'recorded_at', 'expires_at',
    ]);
    const route = readFileSync(new URL('../site/functions/api/intents.ts', import.meta.url), 'utf8');
    assert.match(route, /handleProductIntent/);
    assert.doesNotMatch(route, /console\.|request\.(?:text|json|arrayBuffer)/);
  });
});
