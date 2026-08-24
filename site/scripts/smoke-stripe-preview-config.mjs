import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

export const STRIPE_API_VERSION = '2025-06-30.basil';
export const PREVIEW_WEBHOOK_URL = 'https://d1-functions-preview.solvency-ru5.pages.dev/api/stripe-webhook';
export const PREVIEW_PORTAL_RETURN_URL = 'https://d1-functions-preview.solvency-ru5.pages.dev/pricing?billing=portal-return';
export const REQUIRED_WEBHOOK_EVENTS = Object.freeze([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

const STRIPE_ORIGIN = 'https://api.stripe.com';
const PRICE_ID = /^price_[A-Za-z0-9]{4,122}$/;
const PRODUCT_ID = /^prod_[A-Za-z0-9]{4,123}$/;
const WEBHOOK_ID = /^we_[A-Za-z0-9]{4,124}$/;
const PORTAL_CONFIGURATION_ID = /^bpc_[A-Za-z0-9]{4,124}$/;
const ACCOUNT_ID = /^acct_[A-Za-z0-9]{4,123}$/;
const RESTRICTED_TEST_KEY = /^rk_test_[A-Za-z0-9_]{12,240}$/;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const RUNTIME_IDENTIFIER_NAMES = Object.freeze([
  'STRIPE_ACCOUNT_ID',
  'STRIPE_PORTAL_CONFIGURATION_ID',
  'STRIPE_PRO_MONTHLY_PRICE_ID',
  'STRIPE_PRO_ANNUAL_PRICE_ID',
]);

function fail(message) {
  throw new Error(`Stripe Preview configuration preflight failed: ${message}`);
}

function requiredEnvironment(environment, name) {
  const value = environment[name]?.trim();
  if (!value) fail(`${name} is required.`);
  return value;
}

function exactArray(value, expected) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    && value.length === expected.length
    && [...value].sort().every((item, index) => item === [...expected].sort()[index]);
}

export function validatePreviewRuntimeIdentifiers(wranglerSource, expected) {
  if (typeof wranglerSource !== 'string') fail('wrangler.toml source is unavailable.');
  const values = new Map();
  let section = '';
  for (const rawLine of wranglerSource.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (!line) continue;
    const heading = line.match(/^\[([^\]]+)\]$/);
    if (heading) {
      section = heading[1];
      continue;
    }
    if (section !== 'env.preview.vars') continue;
    const assignment = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*"([^"]*)"$/);
    if (!assignment || !RUNTIME_IDENTIFIER_NAMES.includes(assignment[1])) continue;
    if (values.has(assignment[1])) fail(`wrangler.toml repeats ${assignment[1]}.`);
    values.set(assignment[1], assignment[2]);
  }
  for (const name of RUNTIME_IDENTIFIER_NAMES) {
    if (values.get(name) !== expected[name]) {
      fail(`Preview runtime ${name} does not match the reviewed provider preflight value.`);
    }
  }
}

export function validateStripePrice(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.object !== 'price' || value.id !== expected.id || value.active !== true
    || value.livemode !== false || value.type !== 'recurring'
    || value.billing_scheme !== 'per_unit' || value.currency !== 'usd'
    || value.unit_amount !== expected.unitAmount
    || value.unit_amount_decimal !== String(expected.unitAmount)
    || value.custom_unit_amount !== null || !PRODUCT_ID.test(value.product)
    || !value.recurring || typeof value.recurring !== 'object' || Array.isArray(value.recurring)
    || value.recurring.interval !== expected.interval || value.recurring.interval_count !== 1
    || value.recurring.usage_type !== 'licensed') {
    fail(`${expected.interval} Price is not the exact active, flat, USD, licensed recurring test Price.`);
  }
  return { id: value.id, productId: value.product };
}

export function validateStripeAccount(value, expectedId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.object !== 'account' || value.id !== expectedId) {
    fail('restricted key is not bound to the exact allowlisted Stripe account.');
  }
  return { id: value.id };
}

export function validateStripeProduct(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.object !== 'product' || value.id !== expected.id
    || value.active !== true || value.livemode !== false || value.name !== 'Solvency Pro'
    || (value.default_price !== null
      && value.default_price !== expected.monthlyPriceId
      && value.default_price !== expected.annualPriceId)) {
    fail('Pro Product is not the exact active Solvency Pro test product.');
  }
  return { id: value.id };
}

export function validateStripeWebhookEndpoint(value, expectedId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.object !== 'webhook_endpoint' || value.id !== expectedId
    || value.livemode !== false || value.status !== 'enabled'
    || value.url !== PREVIEW_WEBHOOK_URL || value.api_version !== STRIPE_API_VERSION
    || !exactArray(value.enabled_events, REQUIRED_WEBHOOK_EVENTS)) {
    fail('webhook endpoint must be enabled in test mode with the exact URL, API version and three subscription events.');
  }
  return { id: value.id };
}

export function validateStripePortalConfiguration(value, expectedId) {
  const features = value?.features;
  const cancellation = features?.subscription_cancel;
  const cancellationReason = cancellation?.cancellation_reason;
  const subscriptionUpdate = features?.subscription_update;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.object !== 'billing_portal.configuration' || value.id !== expectedId
    || value.active !== true || value.livemode !== false || value.is_default !== false
    || value.default_return_url !== PREVIEW_PORTAL_RETURN_URL
    || value.business_profile?.privacy_policy_url !== 'https://solvency.dev/privacy'
    || value.business_profile?.terms_of_service_url !== 'https://solvency.dev/terms'
    || value.login_page?.enabled !== false
    || features?.customer_update?.enabled !== false
    || !exactArray(features?.customer_update?.allowed_updates, [])
    || features?.invoice_history?.enabled !== true
    || features?.payment_method_update?.enabled !== true
    || cancellation?.enabled !== true || cancellation?.mode !== 'at_period_end'
    || cancellation?.proration_behavior !== 'none'
    || cancellationReason?.enabled !== true
    || !exactArray(cancellationReason?.options, [
      'too_expensive', 'missing_features', 'switched_service', 'unused', 'other',
    ])
    || subscriptionUpdate?.enabled !== false
    || !exactArray(subscriptionUpdate?.default_allowed_updates, [])
    || subscriptionUpdate?.proration_behavior !== 'none'
    || (subscriptionUpdate?.products !== null
      && subscriptionUpdate?.products !== undefined
      && !exactArray(subscriptionUpdate.products, []))
    || (features?.subscription_pause !== undefined
      && features.subscription_pause?.enabled !== false)) {
    fail('Billing Portal configuration does not match the exact test-only cancellation and legal policy.');
  }
  return { id: value.id };
}

async function boundedJson(response) {
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    fail('Stripe returned a non-JSON response.');
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) fail('Stripe response was too large.');
  if (!response.body) fail('Stripe returned an empty response.');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) fail('Stripe response was too large.');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('Stripe returned malformed JSON.');
  }
}

export async function stripeApiGet(path, restrictedKey, fetchImplementation = fetch) {
  if (!RESTRICTED_TEST_KEY.test(restrictedKey)) fail('preflight requires a restricted Stripe test key (rk_test_).');
  if (!/^\/v1\/(?:account|products\/prod_[A-Za-z0-9]{4,123}|prices\/price_[A-Za-z0-9]{4,122}|webhook_endpoints\/we_[A-Za-z0-9]{4,124}|billing_portal\/configurations\/bpc_[A-Za-z0-9]{4,124})$/.test(path)) {
    fail('attempted an unapproved Stripe API path.');
  }
  const url = new URL(path, STRIPE_ORIGIN);
  if (url.origin !== STRIPE_ORIGIN || url.search || url.hash) fail('attempted an invalid Stripe API URL.');
  let response;
  try {
    response = await fetchImplementation(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${restrictedKey}:`, 'utf8').toString('base64')}`,
        'Stripe-Version': STRIPE_API_VERSION,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    fail('Stripe API request failed before a response was received.');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const requestId = response.headers.get('request-id');
    fail(`Stripe API returned HTTP ${response.status}${requestId ? ` (request ${requestId})` : ''}.`);
  }
  return boundedJson(response);
}

export async function runStripePreviewConfigPreflight(environment = process.env, fetchImplementation = fetch) {
  const restrictedKey = requiredEnvironment(environment, 'STRIPE_CONFIG_READ_ONLY_KEY');
  const accountId = requiredEnvironment(environment, 'STRIPE_ACCOUNT_ID');
  const productId = requiredEnvironment(environment, 'STRIPE_PRO_PRODUCT_ID');
  const monthlyPriceId = requiredEnvironment(environment, 'STRIPE_PRO_MONTHLY_PRICE_ID');
  const annualPriceId = requiredEnvironment(environment, 'STRIPE_PRO_ANNUAL_PRICE_ID');
  const webhookEndpointId = requiredEnvironment(environment, 'STRIPE_WEBHOOK_ENDPOINT_ID');
  const portalConfigurationId = requiredEnvironment(environment, 'STRIPE_PORTAL_CONFIGURATION_ID');
  if (!RESTRICTED_TEST_KEY.test(restrictedKey)) fail('STRIPE_CONFIG_READ_ONLY_KEY must start with rk_test_.');
  if (!ACCOUNT_ID.test(accountId) || !PRODUCT_ID.test(productId)
    || !PRICE_ID.test(monthlyPriceId) || !PRICE_ID.test(annualPriceId)
    || monthlyPriceId === annualPriceId || !WEBHOOK_ID.test(webhookEndpointId)
    || !PORTAL_CONFIGURATION_ID.test(portalConfigurationId)) {
    fail('Stripe Account, Product, Price, webhook or Portal identifiers are malformed or ambiguous.');
  }

  const [accountRaw, productRaw, monthlyRaw, annualRaw, webhookRaw, portalRaw] = await Promise.all([
    stripeApiGet('/v1/account', restrictedKey, fetchImplementation),
    stripeApiGet(`/v1/products/${productId}`, restrictedKey, fetchImplementation),
    stripeApiGet(`/v1/prices/${monthlyPriceId}`, restrictedKey, fetchImplementation),
    stripeApiGet(`/v1/prices/${annualPriceId}`, restrictedKey, fetchImplementation),
    stripeApiGet(`/v1/webhook_endpoints/${webhookEndpointId}`, restrictedKey, fetchImplementation),
    stripeApiGet(`/v1/billing_portal/configurations/${portalConfigurationId}`, restrictedKey, fetchImplementation),
  ]);
  validateStripeAccount(accountRaw, accountId);
  validateStripeProduct(productRaw, { id: productId, monthlyPriceId, annualPriceId });
  const monthly = validateStripePrice(monthlyRaw, {
    id: monthlyPriceId, interval: 'month', unitAmount: 1_900,
  });
  const annual = validateStripePrice(annualRaw, {
    id: annualPriceId, interval: 'year', unitAmount: 19_000,
  });
  if (monthly.productId !== productId || annual.productId !== productId) {
    fail('monthly and annual Prices must belong to the exact configured Pro Product.');
  }
  validateStripeWebhookEndpoint(webhookRaw, webhookEndpointId);
  validateStripePortalConfiguration(portalRaw, portalConfigurationId);
  return {
    accountId,
    productId,
    monthlyPriceId,
    annualPriceId,
    webhookEndpointId,
    portalConfigurationId,
    apiVersion: STRIPE_API_VERSION,
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  validatePreviewRuntimeIdentifiers(
    await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8'),
    Object.fromEntries(RUNTIME_IDENTIFIER_NAMES.map((name) => [
      name, requiredEnvironment(process.env, name),
    ])),
  );
  await runStripePreviewConfigPreflight();
  console.log(`Stripe Preview configuration preflight passed at API ${STRIPE_API_VERSION}.`);
}
