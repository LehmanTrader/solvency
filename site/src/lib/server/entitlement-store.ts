import type { D1DatabaseLike } from './pages-types.ts';

export const BILLING_EVENT_RETENTION_SECONDS = 90 * 24 * 60 * 60;

export type BillingSubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'paused'
  | 'unpaid'
  | 'incomplete'
  | 'incomplete_expired'
  | 'canceled';

export interface OwnerEntitlement {
  tier: 'free' | 'pro';
  active: boolean;
  source: 'none' | 'stripe';
  status: BillingSubscriptionStatus | 'none';
  billingInterval: 'month' | 'year' | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

interface CustomerRow {
  owner_user_id: string;
  provider_customer_id: string;
}

interface SubscriptionRow extends CustomerRow {
  provider_subscription_id: string;
  provider_price_id: string | null;
  provider_price_quantity: number | null;
  provider_price_currency: string | null;
  provider_price_interval: string | null;
  status: string;
  current_period_end: number;
  cancel_at_period_end: number;
  last_event_created: number;
  last_event_id: string;
}

interface EventRow {
  payload_hash: string;
  owner_user_id: string;
}

export interface VerifiedBillingEvent {
  eventId: string;
  eventType: string;
  payloadHash: string;
  customerId: string;
  subscriptionId: string;
  /** Every recurring price item on the subscription; ambiguity fails closed. */
  priceItems: readonly VerifiedBillingPriceItem[];
  status: BillingSubscriptionStatus;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
  eventCreated: number;
}

export interface VerifiedBillingPriceItem {
  priceId: string;
  quantity: number;
  currency: string;
  interval: 'month' | 'year';
}

export interface ProPriceConfiguration {
  monthlyPriceId?: string;
  annualPriceId?: string;
}

export type BillingEventResult =
  | { ok: true; ownerUserId: string; replayed: boolean; applied: boolean }
  | { ok: false; reason: 'invalid' | 'customer_not_found' | 'idempotency_conflict' | 'identity_conflict' };

const OWNER_ID = /^user_[A-Za-z0-9_-]{3,123}$/;
const CUSTOMER_ID = /^cus_[A-Za-z0-9]{4,124}$/;
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]{4,124}$/;
const EVENT_ID = /^evt_[A-Za-z0-9]{4,124}$/;
const PRICE_ID = /^price_[A-Za-z0-9]{4,122}$/;
const CURRENCY = /^[a-z]{3}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STATUSES = new Set<BillingSubscriptionStatus>([
  'trialing', 'active', 'past_due', 'paused', 'unpaid', 'incomplete', 'incomplete_expired', 'canceled',
]);
const SUBSCRIPTION_EVENT_TYPES = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);
/** Only statuses that conclusively end the subscription may authorize replacement. */
const TERMINAL_STATUSES = new Set<BillingSubscriptionStatus>(['incomplete_expired', 'canceled']);

function validUnixSeconds(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 253_402_300_799;
}

/**
 * Reduces the complete subscription item list to the only representation that
 * can be persisted. Missing, malformed and multi-price input all become NULL.
 */
export function normalizeBillingPriceItems(value: unknown): VerifiedBillingPriceItem | null {
  try {
    if (!Array.isArray(value) || value.length !== 1) return null;
    const item = value[0] as Partial<VerifiedBillingPriceItem> | null;
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.priceId !== 'string' || !PRICE_ID.test(item.priceId)
      || !Number.isSafeInteger(item.quantity) || (item.quantity ?? 0) < 1 || (item.quantity ?? 0) > 1_000_000
      || typeof item.currency !== 'string' || !CURRENCY.test(item.currency)
      || (item.interval !== 'month' && item.interval !== 'year')) {
      return null;
    }
    return {
      priceId: item.priceId,
      quantity: item.quantity,
      currency: item.currency,
      interval: item.interval,
    } as VerifiedBillingPriceItem;
  } catch {
    return null;
  }
}

function storedBillingPrice(row: SubscriptionRow): VerifiedBillingPriceItem | null | undefined {
  const values = [
    row.provider_price_id,
    row.provider_price_quantity,
    row.provider_price_currency,
    row.provider_price_interval,
  ];
  if (values.every((value) => value === null)) return null;
  if (values.some((value) => value === null || value === undefined)) return undefined;
  return normalizeBillingPriceItems([{
    priceId: row.provider_price_id,
    quantity: row.provider_price_quantity,
    currency: row.provider_price_currency,
    interval: row.provider_price_interval,
  }]) ?? undefined;
}

function isAllowedProPrice(
  price: VerifiedBillingPriceItem | null,
  configuration: ProPriceConfiguration,
): boolean {
  try {
    const { monthlyPriceId, annualPriceId } = configuration;
    if (!monthlyPriceId || !annualPriceId || !PRICE_ID.test(monthlyPriceId)
      || !PRICE_ID.test(annualPriceId) || monthlyPriceId === annualPriceId
      || !price || price.quantity !== 1 || price.currency !== 'usd') {
      return false;
    }
    return (price.priceId === monthlyPriceId && price.interval === 'month')
      || (price.priceId === annualPriceId && price.interval === 'year');
  } catch {
    return false;
  }
}

function validEvent(value: unknown, receivedAt: number): value is VerifiedBillingEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const candidate = value as VerifiedBillingEvent;
    return EVENT_ID.test(candidate.eventId)
      && SUBSCRIPTION_EVENT_TYPES.has(candidate.eventType)
      && SHA256.test(candidate.payloadHash)
      && CUSTOMER_ID.test(candidate.customerId)
      && SUBSCRIPTION_ID.test(candidate.subscriptionId)
      && STATUSES.has(candidate.status)
      && (candidate.eventType !== 'customer.subscription.deleted' || candidate.status === 'canceled')
      && validUnixSeconds(candidate.currentPeriodEnd)
      && validUnixSeconds(candidate.eventCreated)
      && validUnixSeconds(receivedAt)
      && receivedAt >= candidate.eventCreated
      && typeof candidate.cancelAtPeriodEnd === 'boolean';
  } catch {
    return false;
  }
}

export async function bindBillingCustomer(
  db: D1DatabaseLike,
  ownerUserId: string,
  customerId: string,
  now: string,
): Promise<'bound' | 'replayed' | 'identity_conflict' | 'invalid'> {
  if (!OWNER_ID.test(ownerUserId) || !CUSTOMER_ID.test(customerId) || !ISO_INSTANT.test(now)) return 'invalid';
  try {
    const result = await db.prepare(
      `INSERT INTO billing_customers
         (owner_user_id, provider_customer_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).bind(ownerUserId, customerId, now, now).run();
    if (result.success !== true || (result.meta?.changes ?? 0) !== 1) {
      throw new Error('Billing customer mapping was not persisted.');
    }
    return 'bound';
  } catch (cause) {
    const [byOwner, byCustomer] = await Promise.all([
      db.prepare(
        `SELECT owner_user_id, provider_customer_id FROM billing_customers WHERE owner_user_id = ?`,
      ).bind(ownerUserId).first<CustomerRow>(),
      db.prepare(
        `SELECT owner_user_id, provider_customer_id FROM billing_customers WHERE provider_customer_id = ?`,
      ).bind(customerId).first<CustomerRow>(),
    ]).catch(() => { throw cause; });
    if (byOwner?.provider_customer_id === customerId && byCustomer?.owner_user_id === ownerUserId) return 'replayed';
    if (byOwner || byCustomer) return 'identity_conflict';
    throw cause;
  }
}

/**
 * Resolve only the provider customer already bound to this verified owner.
 * Checkout and Portal callers must never accept either identifier from the
 * browser or from webhook metadata.
 */
export async function getBoundBillingCustomerId(
  db: D1DatabaseLike,
  ownerUserId: string,
): Promise<string | null> {
  if (!OWNER_ID.test(ownerUserId)) return null;
  const row = await db.prepare(
    `SELECT owner_user_id, provider_customer_id
       FROM billing_customers
      WHERE owner_user_id = ?`,
  ).bind(ownerUserId).first<CustomerRow>();
  return row?.owner_user_id === ownerUserId && CUSTOMER_ID.test(row.provider_customer_id)
    ? row.provider_customer_id
    : null;
}

function freeEntitlement(): OwnerEntitlement {
  return {
    tier: 'free', active: false, source: 'none', status: 'none',
    billingInterval: null, currentPeriodEnd: null, cancelAtPeriodEnd: false,
  };
}

export async function getOwnerEntitlement(
  db: D1DatabaseLike,
  ownerUserId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  priceConfiguration: ProPriceConfiguration = {},
): Promise<OwnerEntitlement> {
  if (!OWNER_ID.test(ownerUserId) || !validUnixSeconds(nowSeconds)) return freeEntitlement();
  const row = await db.prepare(
    `SELECT owner_user_id, provider_customer_id, provider_subscription_id,
            provider_price_id, provider_price_quantity, provider_price_currency,
            provider_price_interval, status,
            current_period_end, cancel_at_period_end, last_event_created, last_event_id
       FROM billing_subscriptions
      WHERE owner_user_id = ?`,
  ).bind(ownerUserId).first<SubscriptionRow>();
  if (!row || !OWNER_ID.test(row.owner_user_id) || !CUSTOMER_ID.test(row.provider_customer_id)
    || !SUBSCRIPTION_ID.test(row.provider_subscription_id) || !STATUSES.has(row.status as BillingSubscriptionStatus)
    || !validUnixSeconds(row.current_period_end) || !validUnixSeconds(row.last_event_created)
    || !EVENT_ID.test(row.last_event_id) || ![0, 1].includes(row.cancel_at_period_end)) {
    return freeEntitlement();
  }
  const price = storedBillingPrice(row);
  if (price === undefined) return freeEntitlement();
  const status = row.status as BillingSubscriptionStatus;
  const active = (status === 'active' || status === 'trialing')
    && row.current_period_end > nowSeconds
    && isAllowedProPrice(price, priceConfiguration);
  return {
    tier: active ? 'pro' : 'free',
    active,
    source: 'stripe',
    status,
    billingInterval: price?.interval ?? null,
    currentPeriodEnd: new Date(row.current_period_end * 1000).toISOString(),
    cancelAtPeriodEnd: row.cancel_at_period_end === 1,
  };
}

async function existingEvent(db: D1DatabaseLike, eventId: string): Promise<EventRow | null> {
  return db.prepare(
    `SELECT payload_hash, owner_user_id FROM billing_events WHERE provider_event_id = ?`,
  ).bind(eventId).first<EventRow>();
}

async function replayOrConflict(
  db: D1DatabaseLike,
  value: VerifiedBillingEvent,
): Promise<BillingEventResult | null> {
  const previous = await existingEvent(db, value.eventId);
  if (!previous) return null;
  return previous.payload_hash === value.payloadHash
    ? { ok: true, ownerUserId: previous.owner_user_id, replayed: true, applied: false }
    : { ok: false, reason: 'idempotency_conflict' };
}

/**
 * Retire only the safety generation bound to the exact subscription whose
 * current authoritative reducer state is terminal. The owner/customer joins
 * prevent a foreign event from clearing another account, while the persisted
 * subscription ID prevents an old terminal replay from clearing a newer
 * Checkout generation.
 */
async function retireExactTerminalCheckoutAttempt(
  db: D1DatabaseLike,
  ownerUserId: string,
  value: VerifiedBillingEvent,
): Promise<void> {
  if (!TERMINAL_STATUSES.has(value.status)) return;
  const result = await db.prepare(
    `DELETE FROM billing_checkout_attempts
      WHERE owner_user_id = ?
        AND state = 'completed_pending_webhook'
        AND provider_subscription_id = ?
        AND EXISTS (
          SELECT 1
            FROM billing_customers c
            JOIN billing_subscriptions s
              ON s.owner_user_id = c.owner_user_id
             AND s.provider_customer_id = c.provider_customer_id
           WHERE c.owner_user_id = billing_checkout_attempts.owner_user_id
             AND c.provider_customer_id = ?
             AND s.provider_subscription_id = ?
             AND s.status IN ('incomplete_expired', 'canceled')
        )`,
  ).bind(
    ownerUserId,
    value.subscriptionId,
    value.customerId,
    value.subscriptionId,
  ).run();
  const changes = result.meta?.changes ?? 0;
  if (result.success !== true || (changes !== 0 && changes !== 1)) {
    throw new Error('Terminal Checkout receipt retirement failed.');
  }
}

/**
 * Applies only an already signature-verified and normalized provider event.
 * The provider customer must have been bound by authenticated checkout code.
 */
export async function applyVerifiedBillingEvent(
  db: D1DatabaseLike,
  value: VerifiedBillingEvent,
  receivedAt = Math.floor(Date.now() / 1000),
): Promise<BillingEventResult> {
  if (!validEvent(value, receivedAt)) return { ok: false, reason: 'invalid' };
  const normalizedPrice = normalizeBillingPriceItems(value.priceItems);
  const replay = await replayOrConflict(db, value);
  if (replay) {
    if (replay.ok) {
      await retireExactTerminalCheckoutAttempt(db, replay.ownerUserId, value);
    }
    return replay;
  }
  const customer = await db.prepare(
    `SELECT owner_user_id, provider_customer_id
       FROM billing_customers
      WHERE provider_customer_id = ?`,
  ).bind(value.customerId).first<CustomerRow>();
  if (!customer || !OWNER_ID.test(customer.owner_user_id)) return { ok: false, reason: 'customer_not_found' };

  let results;
  try {
    results = await db.batch([
      db.prepare(
        `INSERT INTO billing_events
           (provider_event_id, payload_hash, event_type, owner_user_id,
            provider_customer_id, provider_subscription_id, provider_price_id,
            provider_price_quantity, provider_price_currency, provider_price_interval,
            subscription_status, current_period_end, cancel_at_period_end,
            event_created, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        value.eventId, value.payloadHash, value.eventType, customer.owner_user_id,
        value.customerId, value.subscriptionId, normalizedPrice?.priceId ?? null,
        normalizedPrice?.quantity ?? null, normalizedPrice?.currency ?? null,
        normalizedPrice?.interval ?? null, value.status, value.currentPeriodEnd,
        value.cancelAtPeriodEnd ? 1 : 0, value.eventCreated, receivedAt,
      ),
      db.prepare(
        `INSERT INTO billing_subscriptions
           (owner_user_id, provider_customer_id, provider_subscription_id,
            provider_price_id, provider_price_quantity, provider_price_currency,
            provider_price_interval, status,
            current_period_end, cancel_at_period_end, last_event_created, last_event_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_user_id) DO UPDATE SET
           provider_subscription_id = excluded.provider_subscription_id,
           provider_price_id = CASE
             WHEN billing_subscriptions.last_event_created = excluded.last_event_created
               AND NOT (
                 excluded.provider_price_id IS billing_subscriptions.provider_price_id
                 AND excluded.provider_price_quantity IS billing_subscriptions.provider_price_quantity
                 AND excluded.provider_price_currency IS billing_subscriptions.provider_price_currency
                 AND excluded.provider_price_interval IS billing_subscriptions.provider_price_interval
               )
             THEN NULL ELSE excluded.provider_price_id END,
           provider_price_quantity = CASE
             WHEN billing_subscriptions.last_event_created = excluded.last_event_created
               AND NOT (
                 excluded.provider_price_id IS billing_subscriptions.provider_price_id
                 AND excluded.provider_price_quantity IS billing_subscriptions.provider_price_quantity
                 AND excluded.provider_price_currency IS billing_subscriptions.provider_price_currency
                 AND excluded.provider_price_interval IS billing_subscriptions.provider_price_interval
               )
             THEN NULL ELSE excluded.provider_price_quantity END,
           provider_price_currency = CASE
             WHEN billing_subscriptions.last_event_created = excluded.last_event_created
               AND NOT (
                 excluded.provider_price_id IS billing_subscriptions.provider_price_id
                 AND excluded.provider_price_quantity IS billing_subscriptions.provider_price_quantity
                 AND excluded.provider_price_currency IS billing_subscriptions.provider_price_currency
                 AND excluded.provider_price_interval IS billing_subscriptions.provider_price_interval
               )
             THEN NULL ELSE excluded.provider_price_currency END,
           provider_price_interval = CASE
             WHEN billing_subscriptions.last_event_created = excluded.last_event_created
               AND NOT (
                 excluded.provider_price_id IS billing_subscriptions.provider_price_id
                 AND excluded.provider_price_quantity IS billing_subscriptions.provider_price_quantity
                 AND excluded.provider_price_currency IS billing_subscriptions.provider_price_currency
                 AND excluded.provider_price_interval IS billing_subscriptions.provider_price_interval
               )
             THEN NULL ELSE excluded.provider_price_interval END,
           status = excluded.status,
           current_period_end = CASE
             WHEN billing_subscriptions.last_event_created = excluded.last_event_created
               AND NOT (
                 excluded.provider_price_id IS billing_subscriptions.provider_price_id
                 AND excluded.provider_price_quantity IS billing_subscriptions.provider_price_quantity
                 AND excluded.provider_price_currency IS billing_subscriptions.provider_price_currency
                 AND excluded.provider_price_interval IS billing_subscriptions.provider_price_interval
               )
               AND excluded.current_period_end > billing_subscriptions.current_period_end
             THEN billing_subscriptions.current_period_end ELSE excluded.current_period_end END,
           cancel_at_period_end = CASE
             WHEN billing_subscriptions.last_event_created = excluded.last_event_created
               AND NOT (
                 excluded.provider_price_id IS billing_subscriptions.provider_price_id
                 AND excluded.provider_price_quantity IS billing_subscriptions.provider_price_quantity
                 AND excluded.provider_price_currency IS billing_subscriptions.provider_price_currency
                 AND excluded.provider_price_interval IS billing_subscriptions.provider_price_interval
               )
               AND excluded.cancel_at_period_end < billing_subscriptions.cancel_at_period_end
             THEN billing_subscriptions.cancel_at_period_end ELSE excluded.cancel_at_period_end END,
           last_event_created = excluded.last_event_created,
           last_event_id = excluded.last_event_id,
           updated_at = excluded.updated_at
         WHERE billing_subscriptions.provider_customer_id = excluded.provider_customer_id
           AND (
             billing_subscriptions.provider_subscription_id = excluded.provider_subscription_id
             OR billing_subscriptions.status IN ('incomplete_expired', 'canceled')
           )
           AND (
             billing_subscriptions.last_event_created < excluded.last_event_created
             OR (
               billing_subscriptions.last_event_created = excluded.last_event_created
               AND (
                 (CASE excluded.status
                   WHEN 'trialing' THEN 1 WHEN 'active' THEN 1 WHEN 'past_due' THEN 2
                   WHEN 'paused' THEN 3 WHEN 'incomplete' THEN 4 WHEN 'unpaid' THEN 5
                   WHEN 'incomplete_expired' THEN 6 WHEN 'canceled' THEN 7 ELSE 99 END)
                   > (CASE billing_subscriptions.status
                   WHEN 'trialing' THEN 1 WHEN 'active' THEN 1 WHEN 'past_due' THEN 2
                   WHEN 'paused' THEN 3 WHEN 'incomplete' THEN 4 WHEN 'unpaid' THEN 5
                   WHEN 'incomplete_expired' THEN 6 WHEN 'canceled' THEN 7 ELSE 99 END)
                 OR (
                   (CASE excluded.status
                     WHEN 'trialing' THEN 1 WHEN 'active' THEN 1 WHEN 'past_due' THEN 2
                     WHEN 'paused' THEN 3 WHEN 'incomplete' THEN 4 WHEN 'unpaid' THEN 5
                     WHEN 'incomplete_expired' THEN 6 WHEN 'canceled' THEN 7 ELSE 99 END)
                     = (CASE billing_subscriptions.status
                     WHEN 'trialing' THEN 1 WHEN 'active' THEN 1 WHEN 'past_due' THEN 2
                     WHEN 'paused' THEN 3 WHEN 'incomplete' THEN 4 WHEN 'unpaid' THEN 5
                     WHEN 'incomplete_expired' THEN 6 WHEN 'canceled' THEN 7 ELSE 99 END)
                   AND (
                     NOT (
                       excluded.provider_price_id IS billing_subscriptions.provider_price_id
                       AND excluded.provider_price_quantity IS billing_subscriptions.provider_price_quantity
                       AND excluded.provider_price_currency IS billing_subscriptions.provider_price_currency
                       AND excluded.provider_price_interval IS billing_subscriptions.provider_price_interval
                     )
                     OR (
                       excluded.provider_price_id IS billing_subscriptions.provider_price_id
                       AND excluded.provider_price_quantity IS billing_subscriptions.provider_price_quantity
                       AND excluded.provider_price_currency IS billing_subscriptions.provider_price_currency
                       AND excluded.provider_price_interval IS billing_subscriptions.provider_price_interval
                       AND excluded.current_period_end <= billing_subscriptions.current_period_end
                       AND excluded.cancel_at_period_end >= billing_subscriptions.cancel_at_period_end
                       AND (
                         excluded.current_period_end < billing_subscriptions.current_period_end
                         OR excluded.cancel_at_period_end > billing_subscriptions.cancel_at_period_end
                       )
                     )
                   )
                 )
               )
             )
           )`,
      ).bind(
        customer.owner_user_id, value.customerId, value.subscriptionId,
        normalizedPrice?.priceId ?? null, normalizedPrice?.quantity ?? null,
        normalizedPrice?.currency ?? null, normalizedPrice?.interval ?? null,
        value.status, value.currentPeriodEnd, value.cancelAtPeriodEnd ? 1 : 0,
        value.eventCreated, value.eventId, new Date(receivedAt * 1000).toISOString(),
      ),
      db.prepare(
        `DELETE FROM billing_events
          WHERE received_at < ?
            AND NOT EXISTS (
              SELECT 1 FROM billing_subscriptions s
               WHERE s.last_event_id = billing_events.provider_event_id
            )`,
      ).bind(Math.max(0, receivedAt - BILLING_EVENT_RETENTION_SECONDS)),
    ]);
  } catch (cause) {
    const raced = await replayOrConflict(db, value).catch(() => null);
    if (raced) return raced;
    const collision = await db.prepare(
      `SELECT owner_user_id, provider_customer_id, provider_subscription_id, status,
              current_period_end, cancel_at_period_end, last_event_created, last_event_id
         FROM billing_subscriptions
        WHERE provider_subscription_id = ? OR provider_customer_id = ?`,
    ).bind(value.subscriptionId, value.customerId).first<SubscriptionRow>().catch(() => null);
    if (collision && (collision.owner_user_id !== customer.owner_user_id
      || collision.provider_customer_id !== value.customerId
      || (collision.provider_subscription_id !== value.subscriptionId
        && !TERMINAL_STATUSES.has(collision.status as BillingSubscriptionStatus)))) {
      return { ok: false, reason: 'identity_conflict' };
    }
    throw cause;
  }

  if (results.some((result) => result.success !== true)) {
    throw new Error('Verified billing event transaction failed.');
  }
  const applied = (results[1]?.meta?.changes ?? 0) === 1;
  if (!applied) {
    const current = await db.prepare(
      `SELECT owner_user_id, provider_customer_id, provider_subscription_id, status,
              current_period_end, cancel_at_period_end, last_event_created, last_event_id
         FROM billing_subscriptions
        WHERE owner_user_id = ?`,
    ).bind(customer.owner_user_id).first<SubscriptionRow>();
    if (!current || current.provider_customer_id !== value.customerId
      || (current.provider_subscription_id !== value.subscriptionId
        && !TERMINAL_STATUSES.has(current.status as BillingSubscriptionStatus))) {
      return { ok: false, reason: 'identity_conflict' };
    }
  }
  await retireExactTerminalCheckoutAttempt(db, customer.owner_user_id, value);
  return { ok: true, ownerUserId: customer.owner_user_id, replayed: false, applied };
}
