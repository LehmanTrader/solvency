import { apiError, apiJson } from './api-http.ts';
import {
  acquireCheckoutAttempt,
  completeCheckoutAttempt,
  deferCheckoutReconciliation,
  quarantineCheckoutReconciliation,
  replaceReconciledCheckoutAttempt,
  releaseCheckoutAttempt,
  settleReconciledCheckoutSubscription,
  type AcquireCheckoutAttemptResult,
} from './checkout-attempt-store.ts';
import { bindBillingCustomer } from './entitlement-store.ts';
import type { D1DatabaseLike, PagesContextLike } from './pages-types.ts';
import {
  createStripeApi,
  stripeApiConfiguration,
  stripePortalConfiguration,
  stripeProPriceConfiguration,
  validStripeCustomerId,
  type StripeApi,
  type StripeApiConfiguration,
  type StripeApiFailure,
  type StripeFetch,
  type StripePortalConfiguration,
  type StripeProPriceConfiguration,
} from './stripe-api.ts';
import { stripeWebhookConfigurationReady } from './stripe-webhook.ts';

const BILLING_BODY_LIMIT = 256;
const OWNER_ID = /^user_[A-Za-z0-9_-]{3,123}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/;

interface BillingCustomerRow {
  owner_user_id: string;
  provider_customer_id: string;
}

interface BillingSubscriptionRow {
  owner_user_id: string;
  status: string;
}

export interface BillingDependencies {
  fetch?: StripeFetch;
  now?: () => Date;
  outcomeSink?: (serialized: string) => void;
}

type BodyResult = { ok: true; value: unknown } | { ok: false; response: Response };
type OriginResult = { ok: true; origin: string } | { ok: false; reason: 'configuration' | 'forbidden' };
type StripeRuntimeStage = 'webhook' | 'portal' | 'checkout';

interface StripeRuntimeConfiguration {
  stripe: StripeApiConfiguration;
  portal: StripePortalConfiguration;
  prices: StripeProPriceConfiguration;
}

const customerFlights = new WeakMap<object, Map<string, Promise<string>>>();
const BILLING_SUBSCRIPTION_STATUSES = new Set([
  'trialing', 'active', 'past_due', 'paused', 'unpaid',
  'incomplete', 'incomplete_expired', 'canceled',
]);
const TERMINAL_BILLING_SUBSCRIPTION_STATUSES = new Set([
  'incomplete_expired', 'canceled',
]);

export const BILLING_OUTCOMES = [
  'checkout_created',
  'checkout_replayed',
  'checkout_conflict',
  'checkout_provider_rejected',
  'checkout_provider_retryable',
  'checkout_ambiguous_failure',
  'checkout_completion_failure',
  'checkout_pending_webhook',
  'checkout_manual_review',
  'portal_created',
  'portal_replayed',
  'portal_failure',
] as const;

export type BillingOutcome = typeof BILLING_OUTCOMES[number];
const BILLING_OUTCOME_SET = new Set<string>(BILLING_OUTCOMES);

export function logBillingOutcome(
  outcome: BillingOutcome,
  sink: (serialized: string) => void = (serialized) => console.info(serialized),
): void {
  if (typeof outcome !== 'string' || !BILLING_OUTCOME_SET.has(outcome)) return;
  try {
    sink(JSON.stringify({ schema_version: 1, event: 'billing_outcome', outcome }));
  } catch {
    // Operational telemetry must never alter a billing response.
  }
}

function emitOutcome(dependencies: BillingDependencies, outcome: BillingOutcome): void {
  logBillingOutcome(outcome, dependencies.outcomeSink);
}

function requestId(context: PagesContextLike): string {
  return context.data.requestId ?? crypto.randomUUID();
}

function billingUnavailable(id: string): Response {
  return apiError(id, 503, 'SERVICE_UNAVAILABLE', 'Billing service is unavailable.');
}

/**
 * Fails every provider-backed stage closed unless the complete staged billing
 * chain is present in this runtime. The pinned Portal configuration and both
 * Prices are trust anchors even during webhook-only rollout; Checkout also
 * requires the Portal and webhook flags themselves to be enabled.
 */
function stripeRuntimeConfiguration(
  env: PagesContextLike['env'],
  stage: StripeRuntimeStage,
): StripeRuntimeConfiguration | null {
  const stripe = stripeApiConfiguration(env);
  const portal = stripePortalConfiguration(env);
  const prices = stripeProPriceConfiguration(env);
  if (env.STRIPE_WEBHOOK_ENABLED !== 'true'
    || !stripeWebhookConfigurationReady(env)
    || !stripe || !portal || !prices) return null;
  if ((stage === 'portal' || stage === 'checkout') && env.STRIPE_PORTAL_ENABLED !== 'true') return null;
  if (stage === 'checkout' && env.STRIPE_CHECKOUT_ENABLED !== 'true') return null;
  return { stripe, portal, prices };
}

function exactOrigin(value: string, allowLocalhost: boolean): string | null {
  if (!value || value.includes('*')) return null;
  try {
    const url = new URL(value);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.origin !== value || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    if (url.protocol !== 'https:' && !(allowLocalhost && local && url.protocol === 'http:')) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function returnOrigin(context: PagesContextLike): OriginResult {
  const raw = context.env.CLERK_AUTHORIZED_PARTIES?.split(',').map((part) => part.trim()).filter(Boolean) ?? [];
  if (raw.length < 1 || raw.length > 4) return { ok: false, reason: 'configuration' };
  const allowLocalhost = context.env.APP_ENV === 'development';
  const parties = raw.map((value) => exactOrigin(value, allowLocalhost));
  if (parties.some((value) => value === null) || new Set(parties).size !== parties.length) {
    return { ok: false, reason: 'configuration' };
  }
  if (context.env.APP_ENV === 'production'
    && (parties.length !== 1 || parties[0] !== 'https://solvency.dev')) {
    return { ok: false, reason: 'configuration' };
  }
  const requestOrigin = new URL(context.request.url).origin;
  return parties.includes(requestOrigin)
    ? { ok: true, origin: requestOrigin }
    : { ok: false, reason: 'forbidden' };
}

function parseContentLength(value: string | null): number | null | 'invalid' {
  if (value === null) return null;
  if (!/^(0|[1-9]\d*)$/.test(value)) return 'invalid';
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 'invalid';
}

async function readBillingJson(request: Request, id: string): Promise<BodyResult> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return { ok: false, response: apiError(id, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.') };
  }
  const encoding = request.headers.get('content-encoding')?.trim().toLowerCase();
  if (encoding && encoding !== 'identity') {
    return { ok: false, response: apiError(id, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Compressed request bodies are not accepted.') };
  }
  const declared = parseContentLength(request.headers.get('content-length'));
  if (declared === 'invalid') {
    return { ok: false, response: apiError(id, 400, 'INVALID_REQUEST', 'Content-Length is invalid.') };
  }
  if (declared !== null && declared > BILLING_BODY_LIMIT) {
    return { ok: false, response: apiError(id, 413, 'BODY_TOO_LARGE', 'Request body is too large.') };
  }
  if (!request.body) return { ok: false, response: apiError(id, 400, 'INVALID_JSON', 'Request body is not valid JSON.') };

  const bytes = new Uint8Array(BILLING_BODY_LIMIT);
  const reader = request.body.getReader();
  let offset = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array) || part.value.byteLength > BILLING_BODY_LIMIT - offset) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, response: apiError(id, 413, 'BODY_TOO_LARGE', 'Request body is too large.') };
      }
      bytes.set(part.value, offset);
      offset += part.value.byteLength;
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, response: apiError(id, 400, 'INVALID_REQUEST', 'Request body could not be read.') };
  } finally {
    reader.releaseLock();
  }
  if (declared !== null && declared !== offset) {
    return { ok: false, response: apiError(id, 400, 'INVALID_REQUEST', 'Content-Length does not match the request body.') };
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: apiError(id, 400, 'INVALID_JSON', 'Request body is not valid JSON.') };
  }
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length
    && keys.every((key) => Object.hasOwn(value, key))
    && actual.every((key) => typeof key === 'string' && keys.includes(key));
}

function browserIdempotencyKey(request: Request): string | null {
  const value = request.headers.get('idempotency-key');
  return value && IDEMPOTENCY_KEY.test(value) ? value : null;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function providerIdempotencyKey(namespace: string, ownerUserId: string, browserKey?: string): Promise<string> {
  const digest = await sha256Hex(`${namespace}\n${ownerUserId}${browserKey ? `\n${browserKey}` : ''}`);
  return `solvency-${namespace}-v1-${digest}`;
}

async function checkoutProviderIdempotencyKey(ownerUserId: string, generationToken: string): Promise<string> {
  const digest = await sha256Hex(`checkout-generation-v1\n${ownerUserId}\n${generationToken}`);
  return `solvency-checkout-v2-${digest}`;
}

async function checkoutRequestHash(
  ownerUserId: string,
  interval: 'month' | 'year',
  browserKey: string,
): Promise<string> {
  return sha256Hex(`checkout-attempt-v1\n${ownerUserId}\n${interval}\n${browserKey}`);
}

function unixNow(dependencies: BillingDependencies): { iso: string; seconds: number } {
  const value = dependencies.now?.() ?? new Date();
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error('Billing clock is invalid.');
  return { iso: value.toISOString(), seconds: Math.floor(milliseconds / 1000) };
}

async function customerForOwner(db: D1DatabaseLike, ownerUserId: string): Promise<string | null> {
  const row = await db.prepare(
    `SELECT owner_user_id, provider_customer_id
       FROM billing_customers
      WHERE owner_user_id = ?`,
  ).bind(ownerUserId).first<BillingCustomerRow>();
  if (!row) return null;
  if (row.owner_user_id !== ownerUserId || !validStripeCustomerId(row.provider_customer_id)) {
    throw new Error('Invalid billing customer mapping.');
  }
  return row.provider_customer_id;
}

async function ownerForCustomer(db: D1DatabaseLike, customerId: string): Promise<string | null> {
  const row = await db.prepare(
    `SELECT owner_user_id, provider_customer_id
       FROM billing_customers
      WHERE provider_customer_id = ?`,
  ).bind(customerId).first<BillingCustomerRow>();
  if (!row) return null;
  if (!OWNER_ID.test(row.owner_user_id) || row.provider_customer_id !== customerId) {
    throw new Error('Invalid billing customer mapping.');
  }
  return row.owner_user_id;
}

async function hasNonterminalBillingSubscription(
  db: D1DatabaseLike,
  ownerUserId: string,
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT owner_user_id, status
       FROM billing_subscriptions
      WHERE owner_user_id = ?`,
  ).bind(ownerUserId).first<BillingSubscriptionRow>();
  if (!row) return false;
  if (row.owner_user_id !== ownerUserId || !BILLING_SUBSCRIPTION_STATUSES.has(row.status)) {
    throw new Error('Invalid billing subscription state.');
  }
  return !TERMINAL_BILLING_SUBSCRIPTION_STATUSES.has(row.status);
}

async function bindOrReconcileCustomer(
  db: D1DatabaseLike,
  ownerUserId: string,
  customerId: string,
  now: string,
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await bindBillingCustomer(db, ownerUserId, customerId, now);
      if (result === 'bound' || result === 'replayed') return customerId;
      break;
    } catch {
      if (attempt === 1) break;
    }
  }

  const [ownerCustomer, customerOwner] = await Promise.all([
    customerForOwner(db, ownerUserId),
    ownerForCustomer(db, customerId),
  ]);
  if (ownerCustomer === customerId && customerOwner === ownerUserId) return customerId;
  if (customerOwner !== null) {
    throw new Error('Provider customer is already bound.');
  }
  if (ownerCustomer !== null) return ownerCustomer;
  // Do not delete the empty provider customer. A second isolate can receive the
  // deterministic create replay and bind it just after this read. Leaving it
  // recoverable lets a later request replay the same create and retry D1 safely.
  throw new Error('Provider customer could not be bound.');
}

async function createAndBindCustomer(
  db: D1DatabaseLike,
  stripe: StripeApi,
  ownerUserId: string,
  now: string,
): Promise<string> {
  const existing = await customerForOwner(db, ownerUserId);
  if (existing) return existing;
  const key = await providerIdempotencyKey('customer', ownerUserId);
  const created = await stripe.createCustomer(key);
  if (!created.ok) throw new Error('Provider customer could not be created.');
  return bindOrReconcileCustomer(
    db,
    ownerUserId,
    created.value.id,
    now,
  );
}

async function ensureBillingCustomer(
  db: D1DatabaseLike,
  stripe: StripeApi,
  ownerUserId: string,
  now: string,
): Promise<string> {
  let flights = customerFlights.get(db as object);
  if (!flights) {
    flights = new Map();
    customerFlights.set(db as object, flights);
  }
  const active = flights.get(ownerUserId);
  if (active) return active;
  const flight = createAndBindCustomer(db, stripe, ownerUserId, now);
  flights.set(ownerUserId, flight);
  try {
    return await flight;
  } finally {
    if (flights.get(ownerUserId) === flight) flights.delete(ownerUserId);
  }
}

function stripeFailure(id: string, reason: StripeApiFailure): Response {
  return reason === 'idempotency_conflict'
    ? apiError(id, 409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for a different billing request.')
    : billingUnavailable(id);
}

function checkoutConflict(id: string, retryAfter = 5): Response {
  const response = apiError(
    id,
    409,
    'IDEMPOTENCY_CONFLICT',
    'A Checkout attempt is already in progress. Try again shortly.',
  );
  const headers = new Headers(response.headers);
  headers.set('Retry-After', String(retryAfter));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function billingUnavailableWithRetry(id: string, retryAfter: number): Response {
  const response = billingUnavailable(id);
  const headers = new Headers(response.headers);
  headers.set('Retry-After', String(retryAfter));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function releaseAcquiredAttempt(
  db: D1DatabaseLike,
  ownerUserId: string,
  requestHash: string,
  attempt: Extract<AcquireCheckoutAttemptResult, { ok: true; status: 'acquired' }>,
): Promise<boolean> {
  const released = await releaseCheckoutAttempt(db, {
    ownerUserId,
    requestHash,
    leaseToken: attempt.leaseToken,
  });
  return released.ok && released.released;
}

function validateCommon(context: PagesContextLike):
  | { ok: true; id: string; ownerUserId: string; origin: string; browserKey: string }
  | { ok: false; response: Response } {
  const id = requestId(context);
  if (context.request.method !== 'POST') {
    return { ok: false, response: apiError(id, 405, 'METHOD_NOT_ALLOWED', 'Method is not allowed.', { allow: 'POST' }) };
  }
  if ([...new URL(context.request.url).searchParams.keys()].length > 0) {
    return { ok: false, response: apiError(id, 400, 'INVALID_REQUEST', 'Billing request is invalid.') };
  }
  const ownerUserId = context.data.ownerUserId;
  if (!context.env.DB || !ownerUserId || !OWNER_ID.test(ownerUserId)) {
    return { ok: false, response: billingUnavailable(id) };
  }
  const origin = returnOrigin(context);
  if (!origin.ok) {
    return {
      ok: false,
      response: origin.reason === 'forbidden'
        ? apiError(id, 403, 'ORIGIN_FORBIDDEN', 'Request origin is not allowed.')
        : billingUnavailable(id),
    };
  }
  const browserKey = browserIdempotencyKey(context.request);
  if (!browserKey) {
    return { ok: false, response: apiError(id, 400, 'INVALID_REQUEST', 'A valid Idempotency-Key header is required.') };
  }
  return { ok: true, id, ownerUserId, origin: origin.origin, browserKey };
}

export async function handleCheckout(
  context: PagesContextLike,
  dependencies: BillingDependencies = {},
): Promise<Response> {
  const common = validateCommon(context);
  if (!common.ok) return common.response;
  const runtime = stripeRuntimeConfiguration(context.env, 'checkout');
  if (!runtime) return billingUnavailable(common.id);
  const { stripe: stripeConfiguration, prices } = runtime;
  const parsed = await readBillingJson(context.request, common.id);
  if (!parsed.ok) return parsed.response;
  if (!exactObject(parsed.value, ['interval'])
    || (parsed.value.interval !== 'month' && parsed.value.interval !== 'year')) {
    return apiError(common.id, 400, 'INVALID_REQUEST', 'Checkout request is invalid.');
  }
  const interval = parsed.value.interval;
  const stripe = createStripeApi(stripeConfiguration, dependencies.fetch);
  try {
    if (await hasNonterminalBillingSubscription(context.env.DB, common.ownerUserId)) {
      return apiError(
        common.id,
        409,
        'INVALID_REQUEST',
        'An existing subscription must be managed in the billing portal.',
      );
    }
    const now = unixNow(dependencies);
    const customerId = await ensureBillingCustomer(
      context.env.DB,
      stripe,
      common.ownerUserId,
      now.iso,
    );
    // Close the race with a webhook that committed authoritative subscription
    // state while this request was creating or binding the provider customer.
    if (await hasNonterminalBillingSubscription(context.env.DB, common.ownerUserId)) {
      return apiError(
        common.id,
        409,
        'INVALID_REQUEST',
        'An existing subscription must be managed in the billing portal.',
      );
    }
    const requestHash = await checkoutRequestHash(common.ownerUserId, interval, common.browserKey);
    let attempt = await acquireCheckoutAttempt(context.env.DB, {
      ownerUserId: common.ownerUserId,
      requestHash,
      now: now.seconds,
    });
    if (!attempt.ok) {
      if (attempt.reason === 'invalid') throw new Error('Checkout attempt input is invalid.');
      emitOutcome(dependencies, attempt.reason === 'manual_review'
        ? 'checkout_manual_review'
        : attempt.reason === 'pending_webhook'
          ? 'checkout_pending_webhook'
          : 'checkout_conflict');
      return checkoutConflict(common.id);
    }
    if (attempt.status === 'reconcile') {
      const terminalRecovery = attempt.terminalRecovery === true;
      const reconciliationInput = {
        ownerUserId: common.ownerUserId,
        reconciliationToken: attempt.reconciliationToken,
        providerSessionId: attempt.providerSessionId,
        providerExpiresAt: attempt.providerExpiresAt,
      };
      const retrieved = await stripe.retrieveCheckoutSession({
        sessionId: attempt.providerSessionId,
        customerId,
        expiresAt: attempt.providerExpiresAt,
      });
      const reconciledAt = unixNow(dependencies);
      if (!retrieved.ok) {
        try {
          const retained = await (terminalRecovery
            ? quarantineCheckoutReconciliation
            : deferCheckoutReconciliation)(context.env.DB, {
            ...reconciliationInput,
            now: reconciledAt.seconds,
          });
          if (!retained.ok) throw new Error('Checkout reconciliation retention conflicted.');
        } catch {
          // The short reconciliation lease remains fail-closed if D1 cannot
          // persist the longer backoff.
          emitOutcome(dependencies, 'checkout_ambiguous_failure');
          return billingUnavailableWithRetry(common.id, 60);
        }
        if (terminalRecovery) {
          emitOutcome(dependencies, 'checkout_manual_review');
          return checkoutConflict(common.id);
        }
        emitOutcome(dependencies, 'checkout_ambiguous_failure');
        return billingUnavailableWithRetry(common.id, 60);
      }
      if (retrieved.value.subscriptionId !== null) {
        const settled = await settleReconciledCheckoutSubscription(context.env.DB, {
          ...reconciliationInput,
          requestHash,
          providerCustomerId: customerId,
          providerSubscriptionId: retrieved.value.subscriptionId,
          terminalRecovery,
          now: reconciledAt.seconds,
        });
        if (!settled.ok) throw new Error('Checkout completion reconciliation conflicted.');
        if (settled.status === 'acquired') {
          attempt = settled;
        } else if (settled.status === 'manual_review') {
          emitOutcome(dependencies, 'checkout_manual_review');
          return checkoutConflict(common.id);
        } else {
          emitOutcome(dependencies, 'checkout_pending_webhook');
          return apiError(
            common.id,
            409,
            'INVALID_REQUEST',
            'Checkout is being finalized. Try the billing portal shortly.',
          );
        }
      }
      if (attempt.status === 'reconcile' && retrieved.value.status === 'complete') {
        const retained = await (terminalRecovery
          ? quarantineCheckoutReconciliation
          : deferCheckoutReconciliation)(context.env.DB, {
          ...reconciliationInput,
          now: reconciledAt.seconds,
        });
        if (!retained.ok) throw new Error('Checkout subscription-pending retention conflicted.');
        if (terminalRecovery) {
          emitOutcome(dependencies, 'checkout_manual_review');
          return checkoutConflict(common.id);
        }
        emitOutcome(dependencies, 'checkout_ambiguous_failure');
        return billingUnavailableWithRetry(common.id, 60);
      }
      if (attempt.status === 'reconcile' && retrieved.value.status === 'open') {
        const retained = await (terminalRecovery
          ? quarantineCheckoutReconciliation
          : deferCheckoutReconciliation)(context.env.DB, {
          ...reconciliationInput,
          now: reconciledAt.seconds,
        });
        if (!retained.ok) throw new Error('Checkout open-session retention conflicted.');
        if (terminalRecovery) {
          emitOutcome(dependencies, 'checkout_manual_review');
          return checkoutConflict(common.id);
        }
        emitOutcome(dependencies, 'checkout_conflict');
        return checkoutConflict(common.id, 60);
      }
      if (attempt.status === 'reconcile') {
        if (terminalRecovery) {
          const retained = await quarantineCheckoutReconciliation(context.env.DB, {
            ...reconciliationInput,
            now: reconciledAt.seconds,
          });
          if (!retained.ok) throw new Error('Checkout aged-expiry quarantine conflicted.');
          emitOutcome(dependencies, 'checkout_manual_review');
          return checkoutConflict(common.id);
        }
        const replacement = await replaceReconciledCheckoutAttempt(context.env.DB, {
          ...reconciliationInput,
          requestHash,
          now: reconciledAt.seconds,
        });
        if (!replacement.ok) throw new Error('Checkout replacement generation conflicted.');
        attempt = replacement;
      }
    }
    if (await hasNonterminalBillingSubscription(context.env.DB, common.ownerUserId)) {
      if (attempt.status === 'acquired') {
        try {
          if (!await releaseAcquiredAttempt(context.env.DB, common.ownerUserId, requestHash, attempt)) {
            throw new Error('Checkout attempt release was not committed.');
          }
        } catch {
          emitOutcome(dependencies, 'checkout_completion_failure');
          return billingUnavailable(common.id);
        }
      }
      emitOutcome(dependencies, 'checkout_conflict');
      return apiError(
        common.id,
        409,
        'INVALID_REQUEST',
        'An existing subscription must be managed in the billing portal.',
      );
    }
    const key = await checkoutProviderIdempotencyKey(common.ownerUserId, attempt.leaseToken);
    const result = await stripe.createCheckoutSession({
      customerId,
      priceId: interval === 'month' ? prices.monthlyPriceId : prices.annualPriceId,
      successUrl: `${common.origin}/pricing?checkout=success`,
      cancelUrl: `${common.origin}/pricing?checkout=canceled`,
      expiresAt: attempt.providerExpiresAt,
      idempotencyKey: key,
    });
    if (!result.ok) {
      if (attempt.status === 'acquired'
        && (result.reason === 'provider_rejected' || result.reason === 'retryable')) {
        try {
          if (!await releaseAcquiredAttempt(context.env.DB, common.ownerUserId, requestHash, attempt)) {
            throw new Error('Checkout attempt release was not committed.');
          }
          emitOutcome(
            dependencies,
            result.reason === 'retryable' ? 'checkout_provider_retryable' : 'checkout_provider_rejected',
          );
        } catch {
          emitOutcome(dependencies, 'checkout_completion_failure');
        }
      } else {
        emitOutcome(dependencies, 'checkout_ambiguous_failure');
      }
      return result.reason === 'retryable'
        ? billingUnavailableWithRetry(common.id, 30)
        : stripeFailure(common.id, result.reason);
    }
    if (attempt.status === 'ready') {
      if (result.value.id !== attempt.providerSessionId) {
        emitOutcome(dependencies, 'checkout_ambiguous_failure');
        return billingUnavailable(common.id);
      }
    } else {
      const completedAt = unixNow(dependencies);
      let completed;
      try {
        completed = await completeCheckoutAttempt(context.env.DB, {
          ownerUserId: common.ownerUserId,
          requestHash,
          now: completedAt.seconds,
          leaseToken: attempt.leaseToken,
          providerSessionId: result.value.id,
        });
      } catch {
        emitOutcome(dependencies, 'checkout_completion_failure');
        return billingUnavailable(common.id);
      }
      if (!completed.ok || completed.providerExpiresAt !== attempt.providerExpiresAt) {
        emitOutcome(dependencies, 'checkout_completion_failure');
        return billingUnavailable(common.id);
      }
    }
    const replayed = attempt.status === 'ready' || result.replayed;
    emitOutcome(dependencies, replayed ? 'checkout_replayed' : 'checkout_created');
    return apiJson({ data: { url: result.value.url } }, 200, {
      'Idempotency-Replayed': replayed ? 'true' : 'false',
    });
  } catch {
    emitOutcome(dependencies, 'checkout_ambiguous_failure');
    return billingUnavailable(common.id);
  }
}

export async function handleBillingReadiness(
  context: PagesContextLike,
  dependencies: BillingDependencies = {},
): Promise<Response> {
  const id = requestId(context);
  if (context.request.method !== 'GET') {
    return apiError(id, 405, 'METHOD_NOT_ALLOWED', 'Method is not allowed.', { allow: 'GET' });
  }
  const requestUrl = new URL(context.request.url);
  if (requestUrl.pathname !== '/api/billing-readiness'
    || requestUrl.search !== '' || requestUrl.searchParams.size !== 0) {
    return apiError(id, 400, 'INVALID_REQUEST', 'Billing readiness request is invalid.');
  }
  // Temporary readiness diagnostic: fixed enum/boolean fields only — never a
  // configured value, identifier, header or payload. Remove once the Preview
  // rollout's readiness path is proven.
  const diagnostic = (stage: string, extra: Record<string, boolean | string> = {}) => {
    console.error(JSON.stringify({ event: 'billing_readiness_diagnostic', stage, ...extra }));
  };
  const ownerUserId = context.data.ownerUserId;
  if (!ownerUserId || !OWNER_ID.test(ownerUserId)) {
    diagnostic('owner_missing');
    return billingUnavailable(id);
  }
  const webhookEnabled = context.env.STRIPE_WEBHOOK_ENABLED === 'true';
  const portalEnabled = context.env.STRIPE_PORTAL_ENABLED === 'true';
  const checkoutEnabled = context.env.STRIPE_CHECKOUT_ENABLED === 'true';
  const requiredStage: StripeRuntimeStage = checkoutEnabled
    ? 'checkout'
    : portalEnabled
      ? 'portal'
      : 'webhook';
  if (!webhookEnabled && !portalEnabled && !checkoutEnabled) return billingUnavailable(id);
  const runtime = stripeRuntimeConfiguration(context.env, requiredStage);
  if (!runtime) {
    diagnostic('runtime_configuration_null', {
      api: stripeApiConfiguration(context.env) !== null,
      portal: stripePortalConfiguration(context.env) !== null,
      prices: stripeProPriceConfiguration(context.env) !== null,
      webhook_ready: stripeWebhookConfigurationReady(context.env),
    });
    return billingUnavailable(id);
  }
  try {
    const stripe = createStripeApi(runtime.stripe, dependencies.fetch);
    const binding = await stripe.verifyAccountBinding();
    if (!binding.ok) {
      diagnostic('binding_failed', { reason: binding.reason });
      return billingUnavailable(id);
    }
    return apiJson({ data: { ready: true } });
  } catch {
    diagnostic('binding_threw');
    return billingUnavailable(id);
  }
}

export async function handleBillingPortal(
  context: PagesContextLike,
  dependencies: BillingDependencies = {},
): Promise<Response> {
  const common = validateCommon(context);
  if (!common.ok) return common.response;
  const runtime = stripeRuntimeConfiguration(context.env, 'portal');
  if (!runtime) return billingUnavailable(common.id);
  const { stripe: stripeConfiguration, portal: portalConfiguration } = runtime;
  const parsed = await readBillingJson(context.request, common.id);
  if (!parsed.ok) return parsed.response;
  if (!exactObject(parsed.value, [])) {
    return apiError(common.id, 400, 'INVALID_REQUEST', 'Billing portal request is invalid.');
  }
  try {
    const customerId = await customerForOwner(context.env.DB, common.ownerUserId);
    if (!customerId) return apiError(common.id, 404, 'RESOURCE_NOT_FOUND', 'Billing account was not found.');
    const stripe = createStripeApi(stripeConfiguration, dependencies.fetch);
    const key = await providerIdempotencyKey('portal', common.ownerUserId, common.browserKey);
    const result = await stripe.createPortalSession({
      customerId,
      configurationId: portalConfiguration.configurationId,
      returnUrl: `${common.origin}/pricing?billing=portal-return`,
      idempotencyKey: key,
    });
    if (!result.ok) {
      emitOutcome(dependencies, 'portal_failure');
      return stripeFailure(common.id, result.reason);
    }
    emitOutcome(dependencies, result.replayed ? 'portal_replayed' : 'portal_created');
    return apiJson({ data: { url: result.value.url } }, 200, {
      'Idempotency-Replayed': result.replayed ? 'true' : 'false',
    });
  } catch {
    emitOutcome(dependencies, 'portal_failure');
    return billingUnavailable(common.id);
  }
}
