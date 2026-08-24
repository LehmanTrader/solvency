import type { BuildPlansEnv } from './pages-types.ts';

export const STRIPE_API_VERSION = '2025-06-30.basil';
export const STRIPE_RESPONSE_BODY_LIMIT = 16 * 1024;
export const STRIPE_REQUEST_TIMEOUT_MS = 10_000;

const STRIPE_API_ORIGIN = 'https://api.stripe.com';
const SECRET_KEY = /^sk_(test|live)_[A-Za-z0-9]{16,200}$/;
const ACCOUNT_ID = /^acct_[A-Za-z0-9]{4,124}$/;
const PRICE_ID = /^price_[A-Za-z0-9]{4,122}$/;
const CUSTOMER_ID = /^cus_[A-Za-z0-9]{4,124}$/;
const CHECKOUT_SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{4,120}$/;
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]{4,124}$/;
const PORTAL_SESSION_ID = /^bps_[A-Za-z0-9]{4,124}$/;
const PORTAL_CONFIGURATION_ID = /^bpc_[A-Za-z0-9]{4,124}$/;

export type StripeMode = 'test' | 'live';
export type StripeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface StripeApiConfiguration {
  secretKey: string;
  mode: StripeMode;
  accountId: string;
}

export interface StripeProPriceConfiguration {
  monthlyPriceId: string;
  annualPriceId: string;
}

export interface StripePortalConfiguration {
  configurationId: string;
}

export type StripeApiFailure =
  | 'provider_rejected'
  | 'retryable'
  | 'remote'
  | 'invalid_response'
  | 'idempotency_conflict';
export type StripeApiResult<T> =
  | { ok: true; value: T; replayed: boolean }
  | { ok: false; reason: StripeApiFailure };

export interface StripeCustomer {
  id: string;
}

export interface StripeHostedSession {
  id: string;
  url: string;
}

export interface StripeAccountBinding {
  id: string;
}

export interface StripeCheckoutSessionSnapshot {
  id: string;
  status: 'open' | 'complete' | 'expired';
  subscriptionId: string | null;
}

export interface StripeApi {
  verifyAccountBinding(): Promise<StripeApiResult<StripeAccountBinding>>;
  createCustomer(idempotencyKey: string): Promise<StripeApiResult<StripeCustomer>>;
  createCheckoutSession(input: {
    customerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    expiresAt: number;
    idempotencyKey: string;
  }): Promise<StripeApiResult<StripeHostedSession>>;
  retrieveCheckoutSession(input: {
    sessionId: string;
    customerId: string;
    expiresAt: number;
  }): Promise<StripeApiResult<StripeCheckoutSessionSnapshot>>;
  createPortalSession(input: {
    customerId: string;
    configurationId: string;
    returnUrl: string;
    idempotencyKey: string;
  }): Promise<StripeApiResult<StripeHostedSession>>;
}

function exactConfiguredValue(value: string | undefined): string | null {
  return typeof value === 'string' && value.length > 0 && value === value.trim() ? value : null;
}

export function stripeApiConfiguration(env: BuildPlansEnv): StripeApiConfiguration | null {
  const secretKey = exactConfiguredValue(env.STRIPE_SECRET_KEY);
  const accountId = exactConfiguredValue(env.STRIPE_ACCOUNT_ID);
  const match = secretKey && SECRET_KEY.exec(secretKey);
  if (!secretKey || !match || !accountId || !ACCOUNT_ID.test(accountId)) return null;
  if (env.APP_ENV === 'production' && match[1] === 'live') return { secretKey, mode: 'live', accountId };
  if ((env.APP_ENV === 'preview' || env.APP_ENV === 'development') && match[1] === 'test') {
    return { secretKey, mode: 'test', accountId };
  }
  return null;
}

export function stripePortalConfiguration(env: BuildPlansEnv): StripePortalConfiguration | null {
  const configurationId = exactConfiguredValue(env.STRIPE_PORTAL_CONFIGURATION_ID);
  return configurationId && PORTAL_CONFIGURATION_ID.test(configurationId)
    ? { configurationId }
    : null;
}

export function stripeProPriceConfiguration(env: BuildPlansEnv): StripeProPriceConfiguration | null {
  const monthlyPriceId = exactConfiguredValue(env.STRIPE_PRO_MONTHLY_PRICE_ID);
  const annualPriceId = exactConfiguredValue(env.STRIPE_PRO_ANNUAL_PRICE_ID);
  if (!monthlyPriceId || !annualPriceId || !PRICE_ID.test(monthlyPriceId)
    || !PRICE_ID.test(annualPriceId) || monthlyPriceId === annualPriceId) return null;
  return { monthlyPriceId, annualPriceId };
}

export function validStripeCustomerId(value: unknown): value is string {
  return typeof value === 'string' && CUSTOMER_ID.test(value);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validContentLength(value: string | null): number | null | 'invalid' {
  if (value === null) return null;
  if (!/^(0|[1-9]\d*)$/.test(value)) return 'invalid';
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 'invalid';
}

async function readBoundedResponseJson(response: Response): Promise<unknown | null> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') return null;
  const declared = validContentLength(response.headers.get('content-length'));
  if (declared === 'invalid' || (declared !== null && declared > STRIPE_RESPONSE_BODY_LIMIT) || !response.body) {
    return null;
  }
  const bytes = new Uint8Array(STRIPE_RESPONSE_BODY_LIMIT);
  const reader = response.body.getReader();
  let offset = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)
        || part.value.byteLength > STRIPE_RESPONSE_BODY_LIMIT - offset) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      bytes.set(part.value, offset);
      offset += part.value.byteLength;
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  } finally {
    reader.releaseLock();
  }
  if (declared !== null && declared !== offset) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function idempotencyFailure(value: unknown): boolean {
  return validStripeErrorEnvelope(value)?.type === 'idempotency_error';
}

const STRIPE_ERROR_TYPES = new Set([
  'api_error',
  'authentication_error',
  'card_error',
  'idempotency_error',
  'invalid_request_error',
  'permission_error',
  'rate_limit_error',
]);
const STRIPE_ERROR_KEYS = new Set([
  'type', 'code', 'decline_code', 'doc_url', 'message', 'param', 'request_log_url', 'charge',
]);

function validOptionalBoundedString(value: unknown, maximum: number): boolean {
  return value === undefined || value === null
    || (typeof value === 'string' && value.length >= 1 && value.length <= maximum);
}

function validStripeErrorEnvelope(value: unknown): { type: string } | null {
  if (!plainObject(value) || Reflect.ownKeys(value).length !== 1 || !Object.hasOwn(value, 'error')
    || !plainObject(value.error)) return null;
  const keys = Reflect.ownKeys(value.error);
  if (keys.length < 1 || keys.length > STRIPE_ERROR_KEYS.size
    || keys.some((key) => typeof key !== 'string' || !STRIPE_ERROR_KEYS.has(key))) return null;
  const type = value.error.type;
  if (typeof type !== 'string' || !STRIPE_ERROR_TYPES.has(type)
    || !validOptionalBoundedString(value.error.code, 128)
    || !validOptionalBoundedString(value.error.decline_code, 128)
    || !validOptionalBoundedString(value.error.doc_url, 2048)
    || !validOptionalBoundedString(value.error.message, 2048)
    || !validOptionalBoundedString(value.error.param, 256)
    || !validOptionalBoundedString(value.error.request_log_url, 2048)
    || !validOptionalBoundedString(value.error.charge, 256)) return null;
  return { type };
}

function conclusivelyRejected(status: number, errorType: string): boolean {
  if (status === 400) return errorType === 'invalid_request_error' || errorType === 'card_error';
  if (status === 401) return errorType === 'authentication_error';
  if (status === 402) return errorType === 'card_error';
  if (status === 403) return errorType === 'permission_error';
  return false;
}

function expectedLiveMode(configuration: StripeApiConfiguration): boolean {
  return configuration.mode === 'live';
}

function validCheckoutUrl(value: unknown, sessionId: string): value is string {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const url = new URL(value);
    const hostedPaths = [`/c/pay/${sessionId}`, `/pay/${sessionId}`];
    const hostedPath = hostedPaths.some((path) => url.pathname === path || url.pathname.startsWith(`${path}/`));
    return url.protocol === 'https:' && url.hostname === 'checkout.stripe.com' && url.port === ''
      && !url.username && !url.password && url.search === '' && hostedPath;
  } catch {
    return false;
  }
}

function validPortalUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'billing.stripe.com' && url.port === ''
      && !url.username && !url.password && url.search === '' && url.hash === ''
      && /^\/p\/session\/[A-Za-z0-9_-]{16,2048}$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function createStripeApi(
  configuration: StripeApiConfiguration,
  transport: StripeFetch = (input, init) => fetch(input, init),
  requestTimeoutMs = STRIPE_REQUEST_TIMEOUT_MS,
): StripeApi {
  const timeoutMs = Number.isSafeInteger(requestTimeoutMs)
    && requestTimeoutMs >= 1 && requestTimeoutMs <= STRIPE_REQUEST_TIMEOUT_MS
    ? requestTimeoutMs
    : STRIPE_REQUEST_TIMEOUT_MS;

  async function request(
    path: string,
    method: 'GET' | 'POST',
    idempotencyKey?: string,
    parameters?: URLSearchParams,
  ): Promise<StripeApiResult<unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = new Headers({
        Authorization: `Bearer ${configuration.secretKey}`,
        'Stripe-Version': STRIPE_API_VERSION,
      });
      if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);
      if (parameters) headers.set('Content-Type', 'application/x-www-form-urlencoded');
      const response = await transport(`${STRIPE_API_ORIGIN}${path}`, {
        method,
        headers,
        ...(parameters ? { body: parameters.toString() } : {}),
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
      const value = await readBoundedResponseJson(response);
      if (response.status !== 200) {
        const error = validStripeErrorEnvelope(value);
        if (response.status >= 500) return { ok: false, reason: 'remote' };
        if (!error) return { ok: false, reason: 'invalid_response' };
        const retryDirective = response.headers.get('stripe-should-retry');
        if (retryDirective !== null && retryDirective !== 'true' && retryDirective !== 'false') {
          return { ok: false, reason: 'invalid_response' };
        }
        if (retryDirective === 'true') return { ok: false, reason: 'remote' };
        if (response.status === 429 && error.type === 'rate_limit_error') {
          return { ok: false, reason: 'retryable' };
        }
        if (response.status === 400 && idempotencyFailure(value)) {
          return { ok: false, reason: 'idempotency_conflict' };
        }
        if (conclusivelyRejected(response.status, error.type)) {
          return { ok: false, reason: 'provider_rejected' };
        }
        // 408, 409 and every unrecognized status/type combination are
        // ambiguous. They can never authorize releasing a Checkout lease.
        return { ok: false, reason: 'remote' };
      }
      if (value === null) return { ok: false, reason: 'invalid_response' };
      const replayHeader = response.headers.get('idempotent-replayed');
      if (replayHeader !== null && replayHeader !== 'true') {
        return { ok: false, reason: 'invalid_response' };
      }
      return { ok: true, value, replayed: replayHeader === 'true' };
    } catch {
      return { ok: false, reason: 'remote' };
    } finally {
      clearTimeout(timeout);
    }
  }

  let accountBinding: Promise<StripeApiResult<StripeAccountBinding>> | null = null;

  function verifyAccountBinding(): Promise<StripeApiResult<StripeAccountBinding>> {
    if (accountBinding) return accountBinding;
    accountBinding = (async () => {
      const result = await request('/v1/account', 'GET');
      if (!result.ok) return result;
      const value = result.value;
      if (result.replayed || !plainObject(value) || value.object !== 'account'
        || value.id !== configuration.accountId || value.deleted === true) {
        return { ok: false, reason: 'invalid_response' };
      }
      return { ok: true, value: { id: configuration.accountId }, replayed: false };
    })();
    return accountBinding;
  }

  return {
    verifyAccountBinding,

    async createCustomer(idempotencyKey) {
      const account = await verifyAccountBinding();
      if (!account.ok) return account;
      const result = await request('/v1/customers', 'POST', idempotencyKey, new URLSearchParams());
      if (!result.ok) return result;
      const value = result.value;
      if (!plainObject(value) || value.object !== 'customer' || !validStripeCustomerId(value.id)
        || value.livemode !== expectedLiveMode(configuration) || value.deleted === true) {
        return { ok: false, reason: 'invalid_response' };
      }
      return { ok: true, value: { id: value.id }, replayed: result.replayed };
    },

    async createCheckoutSession(input) {
      if (!validStripeCustomerId(input.customerId) || !PRICE_ID.test(input.priceId)
        || !Number.isSafeInteger(input.expiresAt) || input.expiresAt < 0
        || input.expiresAt > 253_402_300_799) {
        return { ok: false, reason: 'invalid_response' };
      }
      const account = await verifyAccountBinding();
      if (!account.ok) return account;
      const parameters = new URLSearchParams();
      parameters.set('mode', 'subscription');
      parameters.set('ui_mode', 'hosted');
      parameters.set('customer', input.customerId);
      parameters.set('line_items[0][price]', input.priceId);
      parameters.set('line_items[0][quantity]', '1');
      parameters.set('expires_at', String(input.expiresAt));
      parameters.set('success_url', input.successUrl);
      parameters.set('cancel_url', input.cancelUrl);
      const result = await request('/v1/checkout/sessions', 'POST', input.idempotencyKey, parameters);
      if (!result.ok) return result;
      const value = result.value;
      const sessionMatch = plainObject(value) && typeof value.id === 'string'
        ? CHECKOUT_SESSION_ID.exec(value.id)
        : null;
      if (!plainObject(value) || value.object !== 'checkout.session' || !sessionMatch
        || sessionMatch[1] !== configuration.mode || value.livemode !== expectedLiveMode(configuration)
        || value.customer !== input.customerId || value.mode !== 'subscription'
        || value.status !== 'open' || value.subscription !== null
        || value.expires_at !== input.expiresAt
        || !validCheckoutUrl(value.url, value.id as string)) {
        return { ok: false, reason: 'invalid_response' };
      }
      return {
        ok: true,
        value: { id: value.id as string, url: value.url as string },
        replayed: result.replayed,
      };
    },

    async retrieveCheckoutSession(input) {
      const sessionMatch = CHECKOUT_SESSION_ID.exec(input.sessionId);
      if (!sessionMatch || sessionMatch[1] !== configuration.mode
        || !validStripeCustomerId(input.customerId)
        || !Number.isSafeInteger(input.expiresAt) || input.expiresAt < 0
        || input.expiresAt > 253_402_300_799) {
        return { ok: false, reason: 'invalid_response' };
      }
      const result = await request(`/v1/checkout/sessions/${input.sessionId}`, 'GET');
      if (!result.ok) return result;
      if (result.replayed) return { ok: false, reason: 'invalid_response' };
      const value = result.value;
      const subscriptionId = plainObject(value) && value.subscription === null
        ? null
        : plainObject(value) && typeof value.subscription === 'string' && SUBSCRIPTION_ID.test(value.subscription)
          ? value.subscription
          : undefined;
      if (!plainObject(value) || value.object !== 'checkout.session'
        || value.id !== input.sessionId || value.customer !== input.customerId
        || value.livemode !== expectedLiveMode(configuration) || value.mode !== 'subscription'
        || value.expires_at !== input.expiresAt
        || (value.status !== 'open' && value.status !== 'complete' && value.status !== 'expired')
        || subscriptionId === undefined) {
        return { ok: false, reason: 'invalid_response' };
      }
      return {
        ok: true,
        value: {
          id: input.sessionId,
          status: value.status,
          subscriptionId,
        },
        replayed: false,
      };
    },

    async createPortalSession(input) {
      if (!validStripeCustomerId(input.customerId) || !PORTAL_CONFIGURATION_ID.test(input.configurationId)) {
        return { ok: false, reason: 'invalid_response' };
      }
      const account = await verifyAccountBinding();
      if (!account.ok) return account;
      const parameters = new URLSearchParams();
      parameters.set('customer', input.customerId);
      parameters.set('configuration', input.configurationId);
      parameters.set('return_url', input.returnUrl);
      const result = await request('/v1/billing_portal/sessions', 'POST', input.idempotencyKey, parameters);
      if (!result.ok) return result;
      const value = result.value;
      if (!plainObject(value) || value.object !== 'billing_portal.session'
        || typeof value.id !== 'string' || !PORTAL_SESSION_ID.test(value.id)
        || value.configuration !== input.configurationId
        || value.livemode !== expectedLiveMode(configuration) || !validPortalUrl(value.url)) {
        return { ok: false, reason: 'invalid_response' };
      }
      return {
        ok: true,
        value: { id: value.id, url: value.url },
        replayed: result.replayed,
      };
    },
  };
}
