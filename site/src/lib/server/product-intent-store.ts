import type { D1DatabaseLike } from './pages-types.ts';

export const PRODUCT_INTENT_RETENTION_SECONDS = 90 * 24 * 60 * 60;
export const PRODUCT_INTENT_OWNER_LIMIT = 512;
export const PRODUCT_INTENT_SIGNAL_VERSION = 1;
export const PRODUCT_INTENT_PRICE_EXPERIMENT_ID = 'pro_19_monthly_190_annual_v1' as const;

export const CLIENT_PRODUCT_INTENT_NAMES = [
  'planner_started',
  'valid_quote_created',
  'export_downloaded',
  'pro_price_interest',
] as const;

export const SERVER_CONFIRMED_PRODUCT_INTENT_NAMES = [
  'account_plan_saved',
  'share_created',
  'alert_setting_saved',
] as const;

export const PRODUCT_INTENT_NAMES = [
  ...CLIENT_PRODUCT_INTENT_NAMES,
  ...SERVER_CONFIRMED_PRODUCT_INTENT_NAMES,
] as const;

export type ClientProductIntentName = typeof CLIENT_PRODUCT_INTENT_NAMES[number];
export type ServerConfirmedProductIntentName = typeof SERVER_CONFIRMED_PRODUCT_INTENT_NAMES[number];
export type ProductIntentName = typeof PRODUCT_INTENT_NAMES[number];

export type RecordProductIntentResult =
  | { ok: true; replayed: boolean }
  | { ok: false; reason: 'invalid' | 'idempotency_conflict' | 'owner_limit' };

interface IntentRow { event_name: string }

const OWNER_ID = /^user_[A-Za-z0-9_-]{3,123}$/;
const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NAMES = new Set<string>(PRODUCT_INTENT_NAMES);
const CLIENT_NAMES = new Set<string>(CLIENT_PRODUCT_INTENT_NAMES);
const SERVER_NAMES = new Set<string>(SERVER_CONFIRMED_PRODUCT_INTENT_NAMES);

export function validProductIntentEventId(value: unknown): value is string {
  return typeof value === 'string' && EVENT_ID.test(value);
}

export function validProductIntentName(value: unknown): value is ProductIntentName {
  return typeof value === 'string' && NAMES.has(value);
}

export function validClientProductIntentName(value: unknown): value is ClientProductIntentName {
  return typeof value === 'string' && CLIENT_NAMES.has(value);
}

export function validServerConfirmedProductIntentName(
  value: unknown,
): value is ServerConfirmedProductIntentName {
  return typeof value === 'string' && SERVER_NAMES.has(value);
}

function validUnixSeconds(value: number): boolean {
  return Number.isSafeInteger(value)
    && value >= 0
    && value <= 253_402_300_799 - PRODUCT_INTENT_RETENTION_SECONDS;
}

async function priorIntent(
  db: D1DatabaseLike,
  ownerUserId: string,
  eventId: string,
  nowSeconds: number,
): Promise<IntentRow | null> {
  return db.prepare(
    `SELECT event_name FROM product_intent_events
      WHERE owner_user_id = ? AND event_id = ? AND expires_at > ?`,
  ).bind(ownerUserId, eventId, nowSeconds).first<IntentRow>();
}

async function priorSemanticIntent(
  db: D1DatabaseLike,
  ownerUserId: string,
  eventName: ProductIntentName,
  nowSeconds: number,
): Promise<IntentRow | null> {
  return db.prepare(
    `SELECT event_name FROM product_intent_events
      WHERE owner_user_id = ? AND event_name = ?
        AND signal_version = ? AND price_experiment_id = ? AND expires_at > ?`,
  ).bind(
    ownerUserId,
    eventName,
    PRODUCT_INTENT_SIGNAL_VERSION,
    PRODUCT_INTENT_PRICE_EXPERIMENT_ID,
    nowSeconds,
  ).first<IntentRow>();
}

function replayResult(row: IntentRow | null, eventName: ProductIntentName): RecordProductIntentResult | null {
  if (!row) return null;
  return row.event_name === eventName
    ? { ok: true, replayed: true }
    : { ok: false, reason: 'idempotency_conflict' };
}

/** Stores only a verified owner, closed coarse name, UUID and server time. */
export async function recordProductIntent(
  db: D1DatabaseLike,
  input: {
    ownerUserId: string;
    eventId: string;
    eventName: ProductIntentName;
    nowSeconds?: number;
  },
): Promise<RecordProductIntentResult> {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!OWNER_ID.test(input.ownerUserId)
    || !validProductIntentEventId(input.eventId)
    || !validProductIntentName(input.eventName)
    || !validUnixSeconds(nowSeconds)) return { ok: false, reason: 'invalid' };

  const previous = replayResult(
    await priorIntent(db, input.ownerUserId, input.eventId, nowSeconds),
    input.eventName,
  );
  if (previous) return previous;
  if (await priorSemanticIntent(db, input.ownerUserId, input.eventName, nowSeconds)) {
    return { ok: true, replayed: true };
  }

  try {
    const inserted = await db.prepare(
      `INSERT INTO product_intent_events
         (owner_user_id, event_id, event_name, signal_version, price_experiment_id,
          recorded_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.ownerUserId,
      input.eventId,
      input.eventName,
      PRODUCT_INTENT_SIGNAL_VERSION,
      PRODUCT_INTENT_PRICE_EXPERIMENT_ID,
      nowSeconds,
      nowSeconds + PRODUCT_INTENT_RETENTION_SECONDS,
    ).run();
    if (inserted.success !== true) {
      throw new Error('Product intent was not persisted.');
    }
  } catch (cause) {
    const raced = replayResult(
      await priorIntent(db, input.ownerUserId, input.eventId, nowSeconds).catch(() => null),
      input.eventName,
    );
    if (raced) return raced;
    const semanticRace = await priorSemanticIntent(
      db, input.ownerUserId, input.eventName, nowSeconds,
    ).catch(() => null);
    if (semanticRace) return { ok: true, replayed: true };
    const count = await db.prepare(
      `SELECT COUNT(*) AS count FROM product_intent_events
        WHERE owner_user_id = ? AND expires_at > ?`,
    ).bind(input.ownerUserId, nowSeconds).first<{ count: number }>().catch(() => null);
    if ((count?.count ?? 0) >= PRODUCT_INTENT_OWNER_LIMIT) {
      return { ok: false, reason: 'owner_limit' };
    }
    throw cause;
  }

  const committed = await priorIntent(db, input.ownerUserId, input.eventId, nowSeconds);
  if (!committed || committed.event_name !== input.eventName) {
    throw new Error('Product intent commit could not be verified.');
  }
  return { ok: true, replayed: false };
}
