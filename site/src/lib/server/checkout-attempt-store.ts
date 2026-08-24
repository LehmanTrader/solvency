import type { D1DatabaseLike } from './pages-types.ts';

/** Stripe requires Checkout Sessions to expire at least thirty minutes out. */
export const CHECKOUT_PROVIDER_EXPIRY_SECONDS = 32 * 60;

/**
 * The initial lease includes a three-minute grace after provider expiry. A
 * ready receipt is replayable only before provider expiry; every caller is
 * blocked during the grace, and the receipt is never recycled on time alone.
 */
export const CHECKOUT_CREATING_LOCK_SECONDS = 35 * 60;

/** A short CAS lease bounds one exact-session reconciliation request. */
export const CHECKOUT_RECONCILIATION_LEASE_SECONDS = 30;

/** Open or ambiguous reconciliation results retain the receipt and back off. */
export const CHECKOUT_RECONCILIATION_BACKOFF_SECONDS = 60;

/** Automated reconciliation stops after 72 hours and requires manual review. */
export const CHECKOUT_RECONCILIATION_MAX_AGE_SECONDS = 72 * 60 * 60;

export interface AcquireCheckoutAttemptInput {
  ownerUserId: string;
  requestHash: string;
  now: number;
}

export interface CompleteCheckoutAttemptInput extends AcquireCheckoutAttemptInput {
  leaseToken: string;
  providerSessionId: string;
}

export interface ReleaseCheckoutAttemptInput {
  ownerUserId: string;
  requestHash: string;
  leaseToken: string;
}

export interface ReconcileCheckoutAttemptInput {
  ownerUserId: string;
  reconciliationToken: string;
  providerSessionId: string;
  providerExpiresAt: number;
  now: number;
}

export interface SettleReconciledCheckoutSubscriptionInput extends ReconcileCheckoutAttemptInput {
  requestHash: string;
  providerCustomerId: string;
  providerSubscriptionId: string;
  terminalRecovery: boolean;
}

export interface ReplaceReconciledCheckoutAttemptInput extends ReconcileCheckoutAttemptInput {
  requestHash: string;
}

export type AcquiredCheckoutAttempt = {
  ok: true;
  status: 'acquired';
  leaseToken: string;
  providerExpiresAt: number;
  lockExpiresAt: number;
};

export type AcquireCheckoutAttemptResult =
  | AcquiredCheckoutAttempt
  | {
    ok: true;
    status: 'ready';
    leaseToken: string;
    providerSessionId: string;
    providerExpiresAt: number;
    lockExpiresAt: number;
  }
  | {
    ok: true;
    status: 'reconcile';
    leaseToken: string;
    reconciliationToken: string;
    providerSessionId: string;
    providerExpiresAt: number;
    lockExpiresAt: number;
    terminalRecovery?: true;
  }
  | { ok: false; reason: 'invalid' | 'creating' | 'active_request' | 'pending_webhook' | 'manual_review' };

export type CompleteCheckoutAttemptResult =
  | { ok: true; replayed: boolean; providerExpiresAt: number }
  | { ok: false; reason: 'invalid' | 'not_found' | 'expired' | 'conflict' };

export type ReleaseCheckoutAttemptResult =
  | { ok: true; released: boolean }
  | { ok: false; reason: 'invalid' | 'conflict' };

export type ReconcileCheckoutAttemptResult =
  | { ok: true; committed: boolean; lockExpiresAt?: number }
  | { ok: false; reason: 'invalid' | 'conflict' };

export type ReplaceReconciledCheckoutAttemptResult =
  | AcquiredCheckoutAttempt
  | { ok: false; reason: 'invalid' | 'conflict' };

export type SettleReconciledCheckoutSubscriptionResult =
  | AcquiredCheckoutAttempt
  | { ok: true; status: 'pending_webhook' }
  | { ok: true; status: 'manual_review' }
  | { ok: false; reason: 'invalid' | 'conflict' };

type CheckoutAttemptState =
  | 'creating'
  | 'ready'
  | 'reconciling'
  | 'completed_pending_webhook'
  | 'manual_review';

interface CheckoutAttemptRow {
  owner_user_id: string;
  request_hash: string;
  lease_token: string;
  reconciliation_token: string | null;
  state: CheckoutAttemptState;
  provider_session_id: string | null;
  provider_subscription_id: string | null;
  provider_expires_at: number;
  lock_expires_at: number;
}

const OWNER_ID = /^user_[A-Za-z0-9_-]{3,123}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const LEASE_TOKEN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PROVIDER_SESSION_ID = /^cs_(?:test|live)_[A-Za-z0-9]{4,120}$/;
const PROVIDER_CUSTOMER_ID = /^cus_[A-Za-z0-9]{4,124}$/;
const PROVIDER_SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]{4,124}$/;
const MAX_UNIX_SECONDS = 253_402_300_799;
const ROW_KEYS = [
  'owner_user_id',
  'request_hash',
  'lease_token',
  'reconciliation_token',
  'state',
  'provider_session_id',
  'provider_subscription_id',
  'provider_expires_at',
  'lock_expires_at',
] as const;
const ROW_COLUMNS = ROW_KEYS.join(', ');

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length
    && actual.every((key) => typeof key === 'string' && keys.includes(key))
    && keys.every((key) => Object.hasOwn(value, key));
}

function validUnixSeconds(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_UNIX_SECONDS;
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string' && LEASE_TOKEN.test(value);
}

function freshToken(): string {
  const value = crypto.randomUUID();
  if (!validUuid(value)) throw new Error('Secure Checkout token generation failed.');
  return value;
}

function validAcquireInput(value: unknown): value is AcquireCheckoutAttemptInput {
  return exactObject(value, ['ownerUserId', 'requestHash', 'now'])
    && typeof value.ownerUserId === 'string' && OWNER_ID.test(value.ownerUserId)
    && typeof value.requestHash === 'string' && SHA256.test(value.requestHash)
    && validUnixSeconds(value.now)
    && value.now <= MAX_UNIX_SECONDS - CHECKOUT_CREATING_LOCK_SECONDS;
}

function validCompleteInput(value: unknown): value is CompleteCheckoutAttemptInput {
  return exactObject(value, ['ownerUserId', 'requestHash', 'now', 'leaseToken', 'providerSessionId'])
    && typeof value.ownerUserId === 'string' && OWNER_ID.test(value.ownerUserId)
    && typeof value.requestHash === 'string' && SHA256.test(value.requestHash)
    && validUnixSeconds(value.now)
    && validUuid(value.leaseToken)
    && typeof value.providerSessionId === 'string' && PROVIDER_SESSION_ID.test(value.providerSessionId);
}

function validReleaseInput(value: unknown): value is ReleaseCheckoutAttemptInput {
  return exactObject(value, ['ownerUserId', 'requestHash', 'leaseToken'])
    && typeof value.ownerUserId === 'string' && OWNER_ID.test(value.ownerUserId)
    && typeof value.requestHash === 'string' && SHA256.test(value.requestHash)
    && validUuid(value.leaseToken);
}

function validReconcileInput(value: unknown): value is ReconcileCheckoutAttemptInput {
  return exactObject(value, [
    'ownerUserId', 'reconciliationToken', 'providerSessionId', 'providerExpiresAt', 'now',
  ])
    && typeof value.ownerUserId === 'string' && OWNER_ID.test(value.ownerUserId)
    && validUuid(value.reconciliationToken)
    && typeof value.providerSessionId === 'string' && PROVIDER_SESSION_ID.test(value.providerSessionId)
    && validUnixSeconds(value.providerExpiresAt)
    && validUnixSeconds(value.now)
    && value.now <= MAX_UNIX_SECONDS - Math.max(
      CHECKOUT_CREATING_LOCK_SECONDS,
      CHECKOUT_RECONCILIATION_BACKOFF_SECONDS,
    );
}

function validReplaceInput(value: unknown): value is ReplaceReconciledCheckoutAttemptInput {
  return exactObject(value, [
    'ownerUserId', 'reconciliationToken', 'providerSessionId', 'providerExpiresAt', 'now', 'requestHash',
  ])
    && typeof value.requestHash === 'string' && SHA256.test(value.requestHash)
    && validReconcileInput({
      ownerUserId: value.ownerUserId,
      reconciliationToken: value.reconciliationToken,
      providerSessionId: value.providerSessionId,
      providerExpiresAt: value.providerExpiresAt,
      now: value.now,
    });
}

function validSettlementInput(value: unknown): value is SettleReconciledCheckoutSubscriptionInput {
  return exactObject(value, [
    'ownerUserId', 'reconciliationToken', 'providerSessionId', 'providerExpiresAt', 'now',
    'requestHash', 'providerCustomerId', 'providerSubscriptionId', 'terminalRecovery',
  ])
    && typeof value.requestHash === 'string'
    && SHA256.test(value.requestHash)
    && typeof value.providerCustomerId === 'string'
    && PROVIDER_CUSTOMER_ID.test(value.providerCustomerId)
    && typeof value.providerSubscriptionId === 'string'
    && PROVIDER_SUBSCRIPTION_ID.test(value.providerSubscriptionId)
    && typeof value.terminalRecovery === 'boolean'
    && validReconcileInput({
      ownerUserId: value.ownerUserId,
      reconciliationToken: value.reconciliationToken,
      providerSessionId: value.providerSessionId,
      providerExpiresAt: value.providerExpiresAt,
      now: value.now,
    });
}

function validAttemptRow(value: unknown): value is CheckoutAttemptRow {
  if (!exactObject(value, ROW_KEYS)) return false;
  if (typeof value.owner_user_id !== 'string' || !OWNER_ID.test(value.owner_user_id)
    || typeof value.request_hash !== 'string' || !SHA256.test(value.request_hash)
    || !validUuid(value.lease_token)
    || !['creating', 'ready', 'reconciling', 'completed_pending_webhook', 'manual_review'].includes(
      value.state as string,
    )
    || !validUnixSeconds(value.provider_expires_at)
    || !validUnixSeconds(value.lock_expires_at)
    || value.lock_expires_at < value.provider_expires_at + 180) {
    return false;
  }
  const session = typeof value.provider_session_id === 'string'
    && PROVIDER_SESSION_ID.test(value.provider_session_id);
  const subscription = typeof value.provider_subscription_id === 'string'
    && PROVIDER_SUBSCRIPTION_ID.test(value.provider_subscription_id);
  if (value.state === 'creating') return value.provider_session_id === null
    && value.provider_subscription_id === null && value.reconciliation_token === null;
  if (value.state === 'ready') {
    return session && value.provider_subscription_id === null && value.reconciliation_token === null;
  }
  if (value.state === 'completed_pending_webhook') {
    return session && subscription && value.reconciliation_token === null;
  }
  if (value.state === 'reconciling') return session && value.provider_subscription_id === null
    && validUuid(value.reconciliation_token);
  return value.provider_subscription_id === null && value.reconciliation_token === null
    && (value.provider_session_id === null || session);
}

function assertAttemptRow(value: unknown, ownerUserId: string): CheckoutAttemptRow {
  if (!validAttemptRow(value) || value.owner_user_id !== ownerUserId) {
    throw new Error('Invalid persisted Checkout attempt.');
  }
  return value;
}

async function ownerAttempt(db: D1DatabaseLike, ownerUserId: string): Promise<CheckoutAttemptRow | null> {
  const value = await db.prepare(
    `SELECT ${ROW_COLUMNS}
       FROM billing_checkout_attempts
      WHERE owner_user_id = ?`,
  ).bind(ownerUserId).first<CheckoutAttemptRow>();
  return value === null ? null : assertAttemptRow(value, ownerUserId);
}

function acquiredFromRow(row: CheckoutAttemptRow): AcquiredCheckoutAttempt {
  return {
    ok: true,
    status: 'acquired',
    leaseToken: row.lease_token,
    providerExpiresAt: row.provider_expires_at,
    lockExpiresAt: row.lock_expires_at,
  };
}

function blockedAttemptResult(
  row: CheckoutAttemptRow,
  input: AcquireCheckoutAttemptInput,
): AcquireCheckoutAttemptResult | null {
  if (row.state === 'manual_review') return { ok: false, reason: 'manual_review' };
  if (row.state === 'completed_pending_webhook') return { ok: false, reason: 'pending_webhook' };
  if (row.state === 'creating') {
    return row.lock_expires_at > input.now
      ? { ok: false, reason: row.request_hash === input.requestHash ? 'creating' : 'active_request' }
      : null;
  }
  if (row.state === 'reconciling') {
    return row.lock_expires_at > input.now ? { ok: false, reason: 'creating' } : null;
  }
  if (row.lock_expires_at <= input.now) return null;
  if (row.request_hash !== input.requestHash) return { ok: false, reason: 'active_request' };
  if (row.provider_expires_at <= input.now) return { ok: false, reason: 'creating' };
  return {
    ok: true,
    status: 'ready',
    leaseToken: row.lease_token,
    providerSessionId: row.provider_session_id as string,
    providerExpiresAt: row.provider_expires_at,
    lockExpiresAt: row.lock_expires_at,
  };
}

async function markManualReview(
  db: D1DatabaseLike,
  row: CheckoutAttemptRow,
  now: number,
): Promise<boolean> {
  const permitted = row.state === 'creating'
    ? row.lock_expires_at <= now
    : (row.state === 'ready' || row.state === 'reconciling')
      && row.lock_expires_at <= now
      && row.provider_expires_at <= now - CHECKOUT_RECONCILIATION_MAX_AGE_SECONDS;
  if (!permitted) return false;
  const result = await db.prepare(
    `UPDATE billing_checkout_attempts
        SET state = 'manual_review', reconciliation_token = NULL
      WHERE owner_user_id = ?
        AND request_hash = ?
        AND lease_token = ?
        AND state = ?
        AND lock_expires_at = ?
        AND (
          state = 'creating'
          OR NOT EXISTS (
            SELECT 1
              FROM billing_customers c
              JOIN billing_subscriptions s
                ON s.owner_user_id = c.owner_user_id
               AND s.provider_customer_id = c.provider_customer_id
             WHERE c.owner_user_id = billing_checkout_attempts.owner_user_id
               AND s.status IN ('incomplete_expired', 'canceled')
          )
        )
      RETURNING ${ROW_COLUMNS}`,
  ).bind(
    row.owner_user_id,
    row.request_hash,
    row.lease_token,
    row.state,
    row.lock_expires_at,
  ).all<CheckoutAttemptRow>();
  if (result.success !== true || !Array.isArray(result.results) || result.results.length > 1) {
    throw new Error('Checkout manual-review transition failed.');
  }
  if (result.results.length === 0) return false;
  const updated = assertAttemptRow(result.results[0], row.owner_user_id);
  if (updated.state !== 'manual_review' || updated.reconciliation_token !== null) {
    throw new Error('Checkout manual-review transition returned inconsistent state.');
  }
  return true;
}

async function acquireReconciliation(
  db: D1DatabaseLike,
  row: CheckoutAttemptRow,
  now: number,
  terminalRecovery: boolean,
): Promise<Extract<AcquireCheckoutAttemptResult, { ok: true; status: 'reconcile' }> | null> {
  if ((row.state !== 'ready' && row.state !== 'reconciling')
    || row.lock_expires_at > now
    || (!terminalRecovery
      && row.provider_expires_at <= now - CHECKOUT_RECONCILIATION_MAX_AGE_SECONDS)) return null;
  const reconciliationToken = freshToken();
  const lockExpiresAt = now + CHECKOUT_RECONCILIATION_LEASE_SECONDS;
  const result = await db.prepare(
    `UPDATE billing_checkout_attempts
        SET state = 'reconciling', reconciliation_token = ?, lock_expires_at = ?
      WHERE owner_user_id = ?
        AND request_hash = ?
        AND lease_token = ?
        AND provider_session_id = ?
        AND provider_expires_at = ?
        AND state IN ('ready', 'reconciling')
        AND lock_expires_at <= ?
        AND (? = 1 OR provider_expires_at > ?)
        AND (
          ? = 0
          OR EXISTS (
            SELECT 1
              FROM billing_customers c
              JOIN billing_subscriptions s
                ON s.owner_user_id = c.owner_user_id
               AND s.provider_customer_id = c.provider_customer_id
             WHERE c.owner_user_id = billing_checkout_attempts.owner_user_id
               AND s.status IN ('incomplete_expired', 'canceled')
          )
        )
      RETURNING ${ROW_COLUMNS}`,
  ).bind(
    reconciliationToken,
    lockExpiresAt,
    row.owner_user_id,
    row.request_hash,
    row.lease_token,
    row.provider_session_id,
    row.provider_expires_at,
    now,
    terminalRecovery ? 1 : 0,
    now - CHECKOUT_RECONCILIATION_MAX_AGE_SECONDS,
    terminalRecovery ? 1 : 0,
  ).all<CheckoutAttemptRow>();
  if (result.success !== true || !Array.isArray(result.results) || result.results.length > 1) {
    throw new Error('Checkout reconciliation acquisition failed.');
  }
  if (result.results.length === 0) return null;
  const updated = assertAttemptRow(result.results[0], row.owner_user_id);
  if (updated.state !== 'reconciling' || updated.reconciliation_token !== reconciliationToken
    || updated.lease_token !== row.lease_token || updated.provider_session_id !== row.provider_session_id
    || updated.provider_expires_at !== row.provider_expires_at || updated.lock_expires_at !== lockExpiresAt) {
    throw new Error('Checkout reconciliation acquisition returned inconsistent state.');
  }
  return {
    ok: true,
    status: 'reconcile',
    leaseToken: updated.lease_token,
    reconciliationToken,
    providerSessionId: updated.provider_session_id as string,
    providerExpiresAt: updated.provider_expires_at,
    lockExpiresAt,
    ...(terminalRecovery ? { terminalRecovery: true as const } : {}),
  };
}

async function hasTerminalSubscriptionAuthority(
  db: D1DatabaseLike,
  ownerUserId: string,
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT c.owner_user_id, c.provider_customer_id,
            s.provider_subscription_id, s.status
       FROM billing_customers c
       JOIN billing_subscriptions s
         ON s.owner_user_id = c.owner_user_id
        AND s.provider_customer_id = c.provider_customer_id
      WHERE c.owner_user_id = ?
        AND s.status IN ('incomplete_expired', 'canceled')`,
  ).bind(ownerUserId).first<Record<string, unknown>>();
  if (row === null) return false;
  if (!exactObject(row, [
    'owner_user_id', 'provider_customer_id', 'provider_subscription_id', 'status',
  ]) || row.owner_user_id !== ownerUserId
    || typeof row.provider_customer_id !== 'string'
    || !PROVIDER_CUSTOMER_ID.test(row.provider_customer_id)
    || typeof row.provider_subscription_id !== 'string'
    || !PROVIDER_SUBSCRIPTION_ID.test(row.provider_subscription_id)
    || (row.status !== 'incomplete_expired' && row.status !== 'canceled')) {
    throw new Error('Invalid persisted terminal subscription authority.');
  }
  return true;
}

/**
 * Acquires a new owner generation, replays a still-graceful ready receipt, or
 * takes the short CAS lease required to reconcile an expired receipt. Neither
 * stale creating rows nor expired ready rows are ever blindly overwritten.
 */
export async function acquireCheckoutAttempt(
  db: D1DatabaseLike,
  input: AcquireCheckoutAttemptInput,
): Promise<AcquireCheckoutAttemptResult> {
  if (!validAcquireInput(input)) return { ok: false, reason: 'invalid' };
  const leaseToken = freshToken();
  const providerExpiresAt = input.now + CHECKOUT_PROVIDER_EXPIRY_SECONDS;
  const lockExpiresAt = input.now + CHECKOUT_CREATING_LOCK_SECONDS;

  const inserted = await db.prepare(
    `INSERT INTO billing_checkout_attempts
       (owner_user_id, request_hash, lease_token, reconciliation_token, state,
        provider_session_id, provider_subscription_id, provider_expires_at, lock_expires_at)
     VALUES (?, ?, ?, NULL, 'creating', NULL, NULL, ?, ?)
     ON CONFLICT(owner_user_id) DO NOTHING
     RETURNING ${ROW_COLUMNS}`,
  ).bind(
    input.ownerUserId,
    input.requestHash,
    leaseToken,
    providerExpiresAt,
    lockExpiresAt,
  ).all<CheckoutAttemptRow>();
  if (inserted.success !== true || !Array.isArray(inserted.results) || inserted.results.length > 1) {
    throw new Error('Checkout attempt acquisition failed.');
  }
  if (inserted.results.length === 1) {
    const row = assertAttemptRow(inserted.results[0], input.ownerUserId);
    if (row.request_hash !== input.requestHash || row.lease_token !== leaseToken
      || row.state !== 'creating' || row.provider_session_id !== null
      || row.provider_expires_at !== providerExpiresAt || row.lock_expires_at !== lockExpiresAt) {
      throw new Error('Checkout attempt acquisition returned inconsistent state.');
    }
    return acquiredFromRow(row);
  }

  for (let pass = 0; pass < 3; pass += 1) {
    const current = await ownerAttempt(db, input.ownerUserId);
    if (!current) throw new Error('Checkout attempt disappeared during acquisition.');
    const blocked = blockedAttemptResult(current, input);
    if (blocked) return blocked;
    const agedReceipt = (current.state === 'ready' || current.state === 'reconciling')
      && current.provider_expires_at <= input.now - CHECKOUT_RECONCILIATION_MAX_AGE_SECONDS;
    const terminalRecovery = agedReceipt
      && await hasTerminalSubscriptionAuthority(db, input.ownerUserId);
    if (!terminalRecovery && await markManualReview(db, current, input.now)) {
      return { ok: false, reason: 'manual_review' };
    }
    const reconciliation = await acquireReconciliation(
      db,
      current,
      input.now,
      terminalRecovery,
    );
    if (reconciliation) return reconciliation;
  }
  throw new Error('Checkout attempt could not be reconciled.');
}

/** Marks the exact live generation ready; a response-loss retry is idempotent. */
export async function completeCheckoutAttempt(
  db: D1DatabaseLike,
  input: CompleteCheckoutAttemptInput,
): Promise<CompleteCheckoutAttemptResult> {
  if (!validCompleteInput(input)) return { ok: false, reason: 'invalid' };
  const result = await db.prepare(
    `UPDATE billing_checkout_attempts
        SET state = 'ready', provider_session_id = ?
      WHERE owner_user_id = ?
        AND request_hash = ?
        AND lease_token = ?
        AND state = 'creating'
        AND provider_session_id IS NULL
        AND reconciliation_token IS NULL
        AND provider_expires_at > ?
        AND lock_expires_at > ?
      RETURNING ${ROW_COLUMNS}`,
  ).bind(
    input.providerSessionId,
    input.ownerUserId,
    input.requestHash,
    input.leaseToken,
    input.now,
    input.now,
  ).all<CheckoutAttemptRow>();
  if (result.success !== true || !Array.isArray(result.results) || result.results.length > 1) {
    throw new Error('Checkout attempt completion failed.');
  }
  if (result.results.length === 1) {
    const row = assertAttemptRow(result.results[0], input.ownerUserId);
    if (row.request_hash !== input.requestHash || row.lease_token !== input.leaseToken
      || row.state !== 'ready' || row.provider_session_id !== input.providerSessionId
      || row.provider_expires_at <= input.now || row.lock_expires_at <= input.now) {
      throw new Error('Checkout attempt completion returned inconsistent state.');
    }
    return { ok: true, replayed: false, providerExpiresAt: row.provider_expires_at };
  }

  const current = await ownerAttempt(db, input.ownerUserId);
  if (!current) return { ok: false, reason: 'not_found' };
  const identityMatches = current.request_hash === input.requestHash
    && current.lease_token === input.leaseToken;
  if (identityMatches && current.state === 'ready'
    && current.provider_session_id === input.providerSessionId) {
    return current.provider_expires_at > input.now
      ? { ok: true, replayed: true, providerExpiresAt: current.provider_expires_at }
      : { ok: false, reason: 'expired' };
  }
  if (identityMatches && (current.provider_expires_at <= input.now
    || current.lock_expires_at <= input.now)) return { ok: false, reason: 'expired' };
  return { ok: false, reason: 'conflict' };
}

/**
 * Delete only the exact creating generation after a bounded provider rejection
 * proves that no Checkout Session was created.
 */
export async function releaseCheckoutAttempt(
  db: D1DatabaseLike,
  input: ReleaseCheckoutAttemptInput,
): Promise<ReleaseCheckoutAttemptResult> {
  if (!validReleaseInput(input)) return { ok: false, reason: 'invalid' };
  const result = await db.prepare(
    `DELETE FROM billing_checkout_attempts
      WHERE owner_user_id = ?
        AND request_hash = ?
        AND lease_token = ?
        AND state = 'creating'
        AND reconciliation_token IS NULL
      RETURNING ${ROW_COLUMNS}`,
  ).bind(input.ownerUserId, input.requestHash, input.leaseToken).all<CheckoutAttemptRow>();
  if (result.success !== true || !Array.isArray(result.results) || result.results.length > 1) {
    throw new Error('Checkout attempt release failed.');
  }
  if (result.results.length === 1) {
    const row = assertAttemptRow(result.results[0], input.ownerUserId);
    if (row.request_hash !== input.requestHash || row.lease_token !== input.leaseToken
      || row.state !== 'creating' || row.provider_session_id !== null) {
      throw new Error('Checkout attempt release returned inconsistent state.');
    }
    return { ok: true, released: true };
  }
  const current = await ownerAttempt(db, input.ownerUserId);
  return current === null ? { ok: true, released: false } : { ok: false, reason: 'conflict' };
}

/** Retains an open or ambiguous receipt and applies a bounded retry backoff. */
export async function deferCheckoutReconciliation(
  db: D1DatabaseLike,
  input: ReconcileCheckoutAttemptInput,
): Promise<ReconcileCheckoutAttemptResult> {
  if (!validReconcileInput(input)) return { ok: false, reason: 'invalid' };
  const lockExpiresAt = input.now + CHECKOUT_RECONCILIATION_BACKOFF_SECONDS;
  const result = await db.prepare(
    `UPDATE billing_checkout_attempts
        SET state = 'ready', reconciliation_token = NULL, lock_expires_at = ?
      WHERE owner_user_id = ?
        AND reconciliation_token = ?
        AND provider_session_id = ?
        AND provider_expires_at = ?
        AND state = 'reconciling'
        AND lock_expires_at > ?
      RETURNING ${ROW_COLUMNS}`,
  ).bind(
    lockExpiresAt,
    input.ownerUserId,
    input.reconciliationToken,
    input.providerSessionId,
    input.providerExpiresAt,
    input.now,
  ).all<CheckoutAttemptRow>();
  if (result.success !== true || !Array.isArray(result.results) || result.results.length > 1) {
    throw new Error('Checkout reconciliation deferral failed.');
  }
  if (result.results.length === 0) return { ok: false, reason: 'conflict' };
  const row = assertAttemptRow(result.results[0], input.ownerUserId);
  if (row.state !== 'ready' || row.reconciliation_token !== null || row.lock_expires_at !== lockExpiresAt) {
    throw new Error('Checkout reconciliation deferral returned inconsistent state.');
  }
  return { ok: true, committed: true, lockExpiresAt };
}

/**
 * Resolves a reconciled Session with an exact subscription in one SQL CAS.
 * Existing terminal authority for the exact owner/customer/subscription permits
 * a fresh generation; every other result persists the exact binding pending a
 * verified terminal webhook. This closes the terminal-before-reconciliation
 * race without trusting the Checkout Session as subscription authority.
 */
export async function settleReconciledCheckoutSubscription(
  db: D1DatabaseLike,
  input: SettleReconciledCheckoutSubscriptionInput,
): Promise<SettleReconciledCheckoutSubscriptionResult> {
  if (!validSettlementInput(input)) return { ok: false, reason: 'invalid' };
  const leaseToken = freshToken();
  const providerExpiresAt = input.now + CHECKOUT_PROVIDER_EXPIRY_SECONDS;
  const lockExpiresAt = input.now + CHECKOUT_CREATING_LOCK_SECONDS;
  const result = await db.prepare(
    `WITH terminal_authority AS (
       SELECT EXISTS (
         SELECT 1
           FROM billing_customers c
           JOIN billing_subscriptions s
             ON s.owner_user_id = c.owner_user_id
            AND s.provider_customer_id = c.provider_customer_id
          WHERE c.owner_user_id = ?
            AND c.provider_customer_id = ?
            AND s.provider_subscription_id = ?
            AND s.status IN ('incomplete_expired', 'canceled')
       ) AS permits_replacement
     )
     UPDATE billing_checkout_attempts
        SET request_hash = CASE
              WHEN (SELECT permits_replacement FROM terminal_authority) = 1 THEN ?
              ELSE request_hash END,
            lease_token = CASE
              WHEN (SELECT permits_replacement FROM terminal_authority) = 1 THEN ?
              ELSE lease_token END,
            reconciliation_token = NULL,
            state = CASE
              WHEN (SELECT permits_replacement FROM terminal_authority) = 1 THEN 'creating'
              WHEN ? = 1 THEN 'manual_review'
              ELSE 'completed_pending_webhook' END,
            provider_session_id = CASE
              WHEN (SELECT permits_replacement FROM terminal_authority) = 1 THEN NULL
              ELSE provider_session_id END,
            provider_subscription_id = CASE
              WHEN (SELECT permits_replacement FROM terminal_authority) = 1 THEN NULL
              WHEN ? = 1 THEN NULL
              ELSE ? END,
            provider_expires_at = CASE
              WHEN (SELECT permits_replacement FROM terminal_authority) = 1 THEN ?
              ELSE provider_expires_at END,
            lock_expires_at = CASE
              WHEN (SELECT permits_replacement FROM terminal_authority) = 1 THEN ?
              ELSE lock_expires_at END
      WHERE owner_user_id = ?
        AND reconciliation_token = ?
        AND provider_session_id = ?
        AND provider_expires_at = ?
        AND state = 'reconciling'
        AND lock_expires_at > ?
      RETURNING ${ROW_COLUMNS}`,
  ).bind(
    input.ownerUserId,
    input.providerCustomerId,
    input.providerSubscriptionId,
    input.requestHash,
    leaseToken,
    input.terminalRecovery ? 1 : 0,
    input.terminalRecovery ? 1 : 0,
    input.providerSubscriptionId,
    providerExpiresAt,
    lockExpiresAt,
    input.ownerUserId,
    input.reconciliationToken,
    input.providerSessionId,
    input.providerExpiresAt,
    input.now,
  ).all<CheckoutAttemptRow>();
  if (result.success !== true || !Array.isArray(result.results) || result.results.length > 1) {
    throw new Error('Checkout subscription reconciliation settlement failed.');
  }
  if (result.results.length === 0) return { ok: false, reason: 'conflict' };
  const row = assertAttemptRow(result.results[0], input.ownerUserId);
  if (row.state === 'creating') {
    if (row.request_hash !== input.requestHash || row.lease_token !== leaseToken
      || row.reconciliation_token !== null || row.provider_session_id !== null
      || row.provider_subscription_id !== null || row.provider_expires_at !== providerExpiresAt
      || row.lock_expires_at !== lockExpiresAt) {
      throw new Error('Checkout terminal replacement returned inconsistent state.');
    }
    return acquiredFromRow(row);
  }
  if (row.state === 'manual_review') {
    if (!input.terminalRecovery || row.reconciliation_token !== null
      || row.provider_session_id !== input.providerSessionId
      || row.provider_subscription_id !== null
      || row.provider_expires_at !== input.providerExpiresAt) {
      throw new Error('Checkout terminal-recovery quarantine returned inconsistent state.');
    }
    return { ok: true, status: 'manual_review' };
  }
  if (row.state !== 'completed_pending_webhook' || row.reconciliation_token !== null
    || row.provider_session_id !== input.providerSessionId
    || row.provider_subscription_id !== input.providerSubscriptionId
    || row.provider_expires_at !== input.providerExpiresAt) {
    throw new Error('Checkout pending-webhook transition returned inconsistent state.');
  }
  return { ok: true, status: 'pending_webhook' };
}

/** Quarantines an inconclusive aged terminal-recovery read without another retry cycle. */
export async function quarantineCheckoutReconciliation(
  db: D1DatabaseLike,
  input: ReconcileCheckoutAttemptInput,
): Promise<ReconcileCheckoutAttemptResult> {
  if (!validReconcileInput(input)) return { ok: false, reason: 'invalid' };
  const result = await db.prepare(
    `UPDATE billing_checkout_attempts
        SET state = 'manual_review', reconciliation_token = NULL
      WHERE owner_user_id = ?
        AND reconciliation_token = ?
        AND provider_session_id = ?
        AND provider_expires_at = ?
        AND state = 'reconciling'
        AND lock_expires_at > ?
      RETURNING ${ROW_COLUMNS}`,
  ).bind(
    input.ownerUserId,
    input.reconciliationToken,
    input.providerSessionId,
    input.providerExpiresAt,
    input.now,
  ).all<CheckoutAttemptRow>();
  if (result.success !== true || !Array.isArray(result.results) || result.results.length > 1) {
    throw new Error('Checkout reconciliation quarantine failed.');
  }
  if (result.results.length === 0) return { ok: false, reason: 'conflict' };
  const row = assertAttemptRow(result.results[0], input.ownerUserId);
  if (row.state !== 'manual_review' || row.reconciliation_token !== null
    || row.provider_session_id !== input.providerSessionId
    || row.provider_subscription_id !== null
    || row.provider_expires_at !== input.providerExpiresAt) {
    throw new Error('Checkout reconciliation quarantine returned inconsistent state.');
  }
  return { ok: true, committed: true };
}

/**
 * Retires the exact reconciled expired Session and atomically installs a fresh
 * creating generation. Concurrent callers cannot both obtain replacements.
 */
export async function replaceReconciledCheckoutAttempt(
  db: D1DatabaseLike,
  input: ReplaceReconciledCheckoutAttemptInput,
): Promise<ReplaceReconciledCheckoutAttemptResult> {
  if (!validReplaceInput(input)) return { ok: false, reason: 'invalid' };
  const leaseToken = freshToken();
  const providerExpiresAt = input.now + CHECKOUT_PROVIDER_EXPIRY_SECONDS;
  const lockExpiresAt = input.now + CHECKOUT_CREATING_LOCK_SECONDS;
  const result = await db.prepare(
    `UPDATE billing_checkout_attempts
        SET request_hash = ?,
            lease_token = ?,
            reconciliation_token = NULL,
            state = 'creating',
            provider_session_id = NULL,
            provider_subscription_id = NULL,
            provider_expires_at = ?,
            lock_expires_at = ?
      WHERE owner_user_id = ?
        AND reconciliation_token = ?
        AND provider_session_id = ?
        AND provider_expires_at = ?
        AND state = 'reconciling'
        AND lock_expires_at > ?
      RETURNING ${ROW_COLUMNS}`,
  ).bind(
    input.requestHash,
    leaseToken,
    providerExpiresAt,
    lockExpiresAt,
    input.ownerUserId,
    input.reconciliationToken,
    input.providerSessionId,
    input.providerExpiresAt,
    input.now,
  ).all<CheckoutAttemptRow>();
  if (result.success !== true || !Array.isArray(result.results) || result.results.length > 1) {
    throw new Error('Checkout replacement generation failed.');
  }
  if (result.results.length === 0) return { ok: false, reason: 'conflict' };
  const row = assertAttemptRow(result.results[0], input.ownerUserId);
  if (row.request_hash !== input.requestHash || row.lease_token !== leaseToken
    || row.state !== 'creating' || row.reconciliation_token !== null
    || row.provider_session_id !== null || row.provider_subscription_id !== null
    || row.provider_expires_at !== providerExpiresAt
    || row.lock_expires_at !== lockExpiresAt) {
    throw new Error('Checkout replacement generation returned inconsistent state.');
  }
  return acquiredFromRow(row);
}
