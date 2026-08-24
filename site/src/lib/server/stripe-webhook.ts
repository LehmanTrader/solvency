import { apiError, apiJson } from './api-http.ts';
import { expectedDeploymentOrigin } from './deployment-origin.ts';
import {
  applyVerifiedBillingEvent,
  type BillingSubscriptionStatus,
  type VerifiedBillingEvent,
  type VerifiedBillingPriceItem,
} from './entitlement-store.ts';
import type { BuildPlansEnv, PagesContextLike } from './pages-types.ts';

export const STRIPE_WEBHOOK_PATH = '/api/stripe-webhook';
export const STRIPE_WEBHOOK_API_VERSION = '2025-06-30.basil';
export const STRIPE_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;
/**
 * This endpoint consumes only snapshot subscription lifecycle events. A fixed
 * 64 KiB buffer is enough for that bounded shape while preventing an omitted
 * or false Content-Length from turning the webhook into an allocation oracle.
 */
export const STRIPE_WEBHOOK_MAX_BODY_BYTES = 64 * 1024;
export const STRIPE_WEBHOOK_OUTCOMES = [
  'accepted_applied',
  'accepted_replay',
  'accepted_stale',
  'accepted_ignored',
  'rejected_signature',
  'rejected_payload',
  'retryable_failure',
] as const;
export type StripeWebhookOutcome = typeof STRIPE_WEBHOOK_OUTCOMES[number];

const MAX_SIGNATURE_HEADER_BYTES = 4 * 1024;
const MAX_SIGNATURE_FIELDS = 32;
const MAX_V1_SIGNATURES = 8;
const MAX_EMPTY_BODY_CHUNKS = 8;
const ENDPOINT_SECRET = /^whsec_[A-Za-z0-9]{16,255}$/;
const EVENT_ID = /^evt_[A-Za-z0-9]{4,124}$/;
const CUSTOMER_ID = /^cus_[A-Za-z0-9]{4,124}$/;
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]{4,124}$/;
const SUBSCRIPTION_ITEM_ID = /^si_[A-Za-z0-9]{4,124}$/;
const PRICE_ID = /^price_[A-Za-z0-9]{4,122}$/;
const CURRENCY = /^[a-z]{3}$/;
const V1_SIGNATURE = /^[a-f0-9]{64}$/;
const ALLOWED_EVENT_TYPES = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);
const SUBSCRIPTION_STATUSES = new Set<BillingSubscriptionStatus>([
  'trialing', 'active', 'past_due', 'paused', 'unpaid', 'incomplete',
  'incomplete_expired', 'canceled',
]);
const WEBHOOK_OUTCOMES = new Set<string>(STRIPE_WEBHOOK_OUTCOMES);

interface StripeWebhookEnvironment extends BuildPlansEnv {
  STRIPE_WEBHOOK_SECRET?: string;
}

interface WebhookConfiguration {
  secret: string;
  monthlyPriceId: string;
  annualPriceId: string;
  expectedLivemode: boolean;
}

interface ParsedSignature {
  timestamp: number;
  signatures: readonly string[];
}

type BodyReadResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; status: 400 | 413 | 415; kind: 'invalid' | 'large' | 'media' };

type NormalizedEnvelope =
  | { ignored: true }
  | { ignored: false; event: VerifiedBillingEvent };

/** Emits an intentionally identifier-free aggregate suitable for edge logs. */
export function logStripeWebhookOutcome(
  outcome: unknown,
  sink: (serialized: string) => void = (serialized) => console.info(serialized),
): void {
  const record = {
    event: 'billing_webhook_outcome' as const,
    outcome: typeof outcome === 'string' && WEBHOOK_OUTCOMES.has(outcome)
      ? outcome as StripeWebhookOutcome
      : 'retryable_failure' as const,
  };
  try {
    sink(JSON.stringify(record));
  } catch {
    // Aggregate logging must never alter the verified event response path.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validUnixSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= 0 && value <= 253_402_300_799;
}

function configuration(env: StripeWebhookEnvironment): WebhookConfiguration | null {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  const monthlyPriceId = env.STRIPE_PRO_MONTHLY_PRICE_ID;
  const annualPriceId = env.STRIPE_PRO_ANNUAL_PRICE_ID;
  const expectedLivemode = env.APP_ENV === 'production'
    ? true
    : env.APP_ENV === 'preview' || env.APP_ENV === 'development' ? false : null;
  if (!secret || !ENDPOINT_SECRET.test(secret)
    || !monthlyPriceId || !PRICE_ID.test(monthlyPriceId)
    || !annualPriceId || !PRICE_ID.test(annualPriceId)
    || monthlyPriceId === annualPriceId || expectedLivemode === null) {
    return null;
  }
  return {
    secret,
    monthlyPriceId,
    annualPriceId,
    expectedLivemode,
  };
}

/**
 * Validates the complete local runtime configuration required before the
 * signed webhook surface can be considered ready. It deliberately exposes no
 * configured values.
 */
export function stripeWebhookConfigurationReady(env: BuildPlansEnv): boolean {
  return configuration(env) !== null;
}

function parseContentLength(value: string | null): number | null | 'invalid' {
  if (value === null) return null;
  if (!/^(0|[1-9]\d*)$/.test(value)) return 'invalid';
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 'invalid';
}

async function readBoundedRawBody(request: Request): Promise<BodyReadResult> {
  const contentType = request.headers.get('content-type')?.trim();
  if (!contentType
    || !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(contentType)) {
    return { ok: false, status: 415, kind: 'media' };
  }
  const contentEncoding = request.headers.get('content-encoding')?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== 'identity') {
    return { ok: false, status: 415, kind: 'media' };
  }

  const declaredLength = parseContentLength(request.headers.get('content-length'));
  if (declaredLength === 'invalid') return { ok: false, status: 400, kind: 'invalid' };
  if (declaredLength !== null && declaredLength > STRIPE_WEBHOOK_MAX_BODY_BYTES) {
    return { ok: false, status: 413, kind: 'large' };
  }
  if (!request.body) {
    return declaredLength === null || declaredLength === 0
      ? { ok: true, bytes: new Uint8Array(0) }
      : { ok: false, status: 400, kind: 'invalid' };
  }

  // The one payload allocation is fixed before reading any untrusted chunks.
  const buffer = new Uint8Array(STRIPE_WEBHOOK_MAX_BODY_BYTES);
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch {
    return { ok: false, status: 400, kind: 'invalid' };
  }
  let offset = 0;
  let emptyChunks = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, status: 400, kind: 'invalid' };
      }
      if (part.value.byteLength === 0) {
        emptyChunks += 1;
        if (emptyChunks > MAX_EMPTY_BODY_CHUNKS) {
          await reader.cancel().catch(() => undefined);
          return { ok: false, status: 400, kind: 'invalid' };
        }
        continue;
      }
      if (part.value.byteLength > STRIPE_WEBHOOK_MAX_BODY_BYTES - offset) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, status: 413, kind: 'large' };
      }
      buffer.set(part.value, offset);
      offset += part.value.byteLength;
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, status: 400, kind: 'invalid' };
  } finally {
    reader.releaseLock();
  }
  if (declaredLength !== null && declaredLength !== offset) {
    return { ok: false, status: 400, kind: 'invalid' };
  }
  return { ok: true, bytes: buffer.subarray(0, offset) };
}

function parseStripeSignature(value: string | null, nowSeconds: number): ParsedSignature | null {
  if (!value || value.length > MAX_SIGNATURE_HEADER_BYTES || !validUnixSeconds(nowSeconds)) return null;
  const fields = value.split(',');
  if (fields.length < 2 || fields.length > MAX_SIGNATURE_FIELDS) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const rawField of fields) {
    const field = rawField.trim();
    const match = /^([A-Za-z0-9_]+)=([^,]+)$/.exec(field);
    if (!match) return null;
    const [, scheme, candidate] = match;
    if (scheme === 't') {
      if (timestamp !== null || !/^(0|[1-9]\d*)$/.test(candidate)) return null;
      const parsed = Number(candidate);
      if (!validUnixSeconds(parsed)) return null;
      timestamp = parsed;
    } else if (scheme === 'v1') {
      if (!V1_SIGNATURE.test(candidate) || signatures.length >= MAX_V1_SIGNATURES) return null;
      signatures.push(candidate);
    }
  }
  if (timestamp === null || signatures.length === 0
    || Math.abs(nowSeconds - timestamp) > STRIPE_WEBHOOK_SIGNATURE_TOLERANCE_SECONDS) {
    return null;
  }
  return { timestamp, signatures };
}

function decodeHex(value: string): Uint8Array {
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.byteLength ^ right.byteLength;
  const length = Math.max(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function verifySignature(
  body: Uint8Array,
  signature: ParsedSignature,
  secret: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const prefix = encoder.encode(`${signature.timestamp}.`);
  const signedPayload = new Uint8Array(prefix.byteLength + body.byteLength);
  signedPayload.set(prefix);
  signedPayload.set(body, prefix.byteLength);
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, signedPayload));
  let matched = 0;
  // Do not return on the first match: every supplied v1 candidate gets the same
  // fixed-length comparison, including during Stripe endpoint-secret rotation.
  for (const candidate of signature.signatures) {
    matched |= constantTimeEqual(expected, decodeHex(candidate)) ? 1 : 0;
  }
  return matched === 1;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseJson(bytes: Uint8Array): unknown | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function normalizePriceItems(
  value: unknown,
  configurationValue: WebhookConfiguration,
): { priceItems: readonly VerifiedBillingPriceItem[]; currentPeriodEnd: number } | null {
  if (!isRecord(value) || value.object !== 'list' || value.has_more !== false
    || !Array.isArray(value.data) || value.data.length === 0) return null;

  const priceItems: VerifiedBillingPriceItem[] = [];
  const periodEnds: number[] = [];
  let supportedFlatShape = true;
  for (const rawItem of value.data) {
    if (!isRecord(rawItem) || rawItem.object !== 'subscription_item'
      || typeof rawItem.id !== 'string' || !SUBSCRIPTION_ITEM_ID.test(rawItem.id)
      || !validUnixSeconds(rawItem.current_period_end)
      || !Number.isSafeInteger(rawItem.quantity)
      || (rawItem.quantity as number) < 1 || (rawItem.quantity as number) > 1_000_000
      || !isRecord(rawItem.price)
      || rawItem.price.object !== 'price'
      || typeof rawItem.price.id !== 'string' || !PRICE_ID.test(rawItem.price.id)
      || typeof rawItem.price.currency !== 'string' || !CURRENCY.test(rawItem.price.currency)
      || (rawItem.price.billing_scheme !== 'per_unit' && rawItem.price.billing_scheme !== 'tiered')
      || (rawItem.price.type !== 'recurring' && rawItem.price.type !== 'one_time')) {
      return null;
    }
    periodEnds.push(rawItem.current_period_end);
    const price = rawItem.price;
    if (price.type === 'one_time') {
      if (price.recurring !== null) return null;
      supportedFlatShape = false;
      continue;
    }
    if (!isRecord(price.recurring)
      || !['day', 'week', 'month', 'year'].includes(String(price.recurring.interval))
      || !Number.isSafeInteger(price.recurring.interval_count)
      || (price.recurring.interval_count as number) < 1
      || (price.recurring.interval_count as number) > 3 * 365
      || (price.recurring.usage_type !== 'licensed' && price.recurring.usage_type !== 'metered')) {
      return null;
    }
    if (price.billing_scheme !== 'per_unit'
      || price.recurring.usage_type !== 'licensed' || price.recurring.interval_count !== 1
      || (price.recurring.interval !== 'month' && price.recurring.interval !== 'year')) {
      supportedFlatShape = false;
      continue;
    }
    const normalized = {
      priceId: price.id,
      quantity: rawItem.quantity as number,
      currency: price.currency,
      interval: price.recurring.interval,
    } satisfies VerifiedBillingPriceItem;
    if ((normalized.priceId === configurationValue.monthlyPriceId && normalized.interval !== 'month')
      || (normalized.priceId === configurationValue.annualPriceId && normalized.interval !== 'year')) {
      supportedFlatShape = false;
    }
    priceItems.push(normalized);
  }
  return {
    // A complete but commercially unsupported collection is persisted as
    // ambiguous, which the entitlement reducer treats as free. Never filter a
    // mixed subscription down to one apparently valid Pro item.
    priceItems: supportedFlatShape ? priceItems : [],
    currentPeriodEnd: Math.min(...periodEnds),
  };
}

function normalizeEnvelope(
  value: unknown,
  configurationValue: WebhookConfiguration,
  payloadHash: string,
): NormalizedEnvelope | null {
  if (!isRecord(value) || value.object !== 'event'
    || typeof value.id !== 'string' || !EVENT_ID.test(value.id)
    || typeof value.type !== 'string'
    || value.api_version !== STRIPE_WEBHOOK_API_VERSION
    || !validUnixSeconds(value.created)
    || typeof value.livemode !== 'boolean'
    || value.livemode !== configurationValue.expectedLivemode) {
    return null;
  }
  if (!ALLOWED_EVENT_TYPES.has(value.type)) return { ignored: true };
  if (!isRecord(value.data) || !isRecord(value.data.object)) return null;
  const subscription = value.data.object;
  if (subscription.object !== 'subscription'
    || typeof subscription.id !== 'string' || !SUBSCRIPTION_ID.test(subscription.id)
    || typeof subscription.customer !== 'string' || !CUSTOMER_ID.test(subscription.customer)
    || typeof subscription.status !== 'string'
    || !SUBSCRIPTION_STATUSES.has(subscription.status as BillingSubscriptionStatus)
    || typeof subscription.cancel_at_period_end !== 'boolean'
    || typeof subscription.livemode !== 'boolean'
    || subscription.livemode !== value.livemode
    || (value.type === 'customer.subscription.deleted' && subscription.status !== 'canceled')) {
    return null;
  }
  const normalizedItems = normalizePriceItems(subscription.items, configurationValue);
  if (!normalizedItems) return null;
  return {
    ignored: false,
    event: {
      eventId: value.id,
      eventType: value.type,
      payloadHash,
      customerId: subscription.customer,
      subscriptionId: subscription.id,
      priceItems: normalizedItems.priceItems,
      status: subscription.status as BillingSubscriptionStatus,
      currentPeriodEnd: normalizedItems.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      eventCreated: value.created,
    },
  };
}

function bodyFailure(requestId: string, result: Extract<BodyReadResult, { ok: false }>): Response {
  if (result.kind === 'large') {
    return apiError(requestId, 413, 'BODY_TOO_LARGE', 'Webhook request body is too large.');
  }
  if (result.kind === 'media') {
    return apiError(requestId, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Webhook body must use JSON without compression.');
  }
  return apiError(requestId, 400, 'INVALID_REQUEST', 'Webhook request body is invalid.');
}

/** Verifies, normalizes and durably reduces one Stripe snapshot event. */
export async function handleStripeWebhook(context: PagesContextLike): Promise<Response> {
  const requestId = context.data.requestId ?? crypto.randomUUID();
  const env = context.env as StripeWebhookEnvironment;
  const finish = (outcome: StripeWebhookOutcome, response: Response): Response => {
    logStripeWebhookOutcome(outcome);
    return response;
  };
  if (env.STRIPE_WEBHOOK_ENABLED !== 'true') {
    return apiError(requestId, 503, 'SERVICE_UNAVAILABLE', 'Stripe webhook service is unavailable.');
  }
  if (context.request.method !== 'POST') {
    return finish('rejected_payload', apiError(
      requestId, 405, 'METHOD_NOT_ALLOWED', 'Method is not allowed.', { allow: 'POST' },
    ));
  }
  let url: URL;
  try {
    url = new URL(context.request.url);
  } catch {
    return finish('rejected_payload', apiError(requestId, 400, 'INVALID_REQUEST', 'Webhook request is invalid.'));
  }
  const expectedOrigin = expectedDeploymentOrigin(env.APP_ENV);
  if (!expectedOrigin) {
    return finish('retryable_failure', apiError(
      requestId, 503, 'SERVICE_UNAVAILABLE', 'Stripe webhook service is unavailable.',
    ));
  }
  if (url.origin !== expectedOrigin || url.pathname !== STRIPE_WEBHOOK_PATH
    || url.search !== '' || url.searchParams.size !== 0) {
    return finish('rejected_payload', apiError(requestId, 400, 'INVALID_REQUEST', 'Webhook request is invalid.'));
  }
  const configured = configuration(env);
  if (!configured || !env.DB) {
    return finish('retryable_failure', apiError(
      requestId, 503, 'SERVICE_UNAVAILABLE', 'Stripe webhook service is unavailable.',
    ));
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const signature = parseStripeSignature(context.request.headers.get('stripe-signature'), nowSeconds);
  if (!signature) {
    return finish('rejected_signature', apiError(
      requestId, 400, 'INVALID_REQUEST', 'Webhook signature is invalid.',
    ));
  }
  const body = await readBoundedRawBody(context.request);
  if (!body.ok) return finish('rejected_payload', bodyFailure(requestId, body));

  try {
    // Signature verification intentionally precedes UTF-8 decoding, JSON
    // parsing, hashing for persistence and every provider-object read.
    if (!await verifySignature(body.bytes, signature, configured.secret)) {
      return finish('rejected_signature', apiError(
        requestId, 400, 'INVALID_REQUEST', 'Webhook signature is invalid.',
      ));
    }
    const payloadHash = await sha256Hex(body.bytes);
    const parsed = parseJson(body.bytes);
    if (parsed === null) {
      return finish('rejected_payload', apiError(
        requestId, 400, 'INVALID_JSON', 'Webhook body must be valid UTF-8 JSON.',
      ));
    }
    const normalized = normalizeEnvelope(parsed, configured, payloadHash);
    if (!normalized) {
      return finish('rejected_payload', apiError(
        requestId, 400, 'INVALID_REQUEST', 'Webhook event is invalid.',
      ));
    }
    if (normalized.ignored) {
      return finish('accepted_ignored', apiJson({ data: { received: true, ignored: true } }));
    }
    const result = await applyVerifiedBillingEvent(env.DB, normalized.event, nowSeconds);
    if (!result.ok) {
      if (result.reason === 'customer_not_found') {
        return finish('retryable_failure', apiError(
          requestId, 409, 'VERSION_CONFLICT', 'Billing customer is not ready.',
        ));
      }
      if (result.reason === 'idempotency_conflict' || result.reason === 'identity_conflict') {
        return finish('retryable_failure', apiError(
          requestId, 409, 'IDEMPOTENCY_CONFLICT', 'Billing event conflicts with durable state.',
        ));
      }
      return finish('rejected_payload', apiError(
        requestId, 400, 'INVALID_REQUEST', 'Webhook event is invalid.',
      ));
    }
    const outcome: StripeWebhookOutcome = result.replayed
      ? 'accepted_replay'
      : result.applied ? 'accepted_applied' : 'accepted_stale';
    return finish(outcome, apiJson({
      data: {
        received: true,
        ignored: false,
        replayed: result.replayed,
        applied: result.applied,
      },
    }));
  } catch {
    // Stripe retries non-2xx responses. Keep the only webhook diagnostic the
    // enum-only aggregate above; the exception and all request identifiers stay
    // out of logs.
    return finish('retryable_failure', apiError(
      requestId, 503, 'SERVICE_UNAVAILABLE', 'Webhook request could not be completed.',
    ));
  }
}
