import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PREVIEW_WEBHOOK_URL,
  PREVIEW_PORTAL_RETURN_URL,
  REQUIRED_WEBHOOK_EVENTS,
  STRIPE_API_VERSION,
  runStripePreviewConfigPreflight,
  stripeApiGet,
  validatePreviewRuntimeIdentifiers,
  validateStripeAccount,
  validateStripePortalConfiguration,
  validateStripeProduct,
  validateStripePrice,
  validateStripeWebhookEndpoint,
} from '../site/scripts/smoke-stripe-preview-config.mjs';

const ROOT = join(import.meta.dirname, '..');
const MONTHLY = 'price_monthly0000000001';
const ANNUAL = 'price_annual00000000001';
const PRODUCT = 'prod_solvencypro000001';
const WEBHOOK = 'we_preview000000000001';
const ACCOUNT = 'acct_solvencypreview001';
const PORTAL = 'bpc_preview00000000001';
const KEY = `rk_test_${'a'.repeat(24)}`;

function previewRuntime(overrides: Record<string, string> = {}) {
  const values = {
    STRIPE_ACCOUNT_ID: ACCOUNT,
    STRIPE_PORTAL_CONFIGURATION_ID: PORTAL,
    STRIPE_PRO_MONTHLY_PRICE_ID: MONTHLY,
    STRIPE_PRO_ANNUAL_PRICE_ID: ANNUAL,
    ...overrides,
  };
  return `[env.preview.vars]\n${Object.entries(values)
    .map(([name, value]) => `${name} = "${value}"`).join('\n')}\n`;
}

test('preflight identifiers must exactly match source-controlled Preview runtime values', () => {
  const expected = {
    STRIPE_ACCOUNT_ID: ACCOUNT,
    STRIPE_PORTAL_CONFIGURATION_ID: PORTAL,
    STRIPE_PRO_MONTHLY_PRICE_ID: MONTHLY,
    STRIPE_PRO_ANNUAL_PRICE_ID: ANNUAL,
  };
  assert.doesNotThrow(() => validatePreviewRuntimeIdentifiers(previewRuntime(), expected));
  assert.throws(() => validatePreviewRuntimeIdentifiers(
    previewRuntime({ STRIPE_PRO_MONTHLY_PRICE_ID: 'price_wrong00000000001' }), expected,
  ), /does not match the reviewed provider preflight value/);
  assert.throws(() => validatePreviewRuntimeIdentifiers(
    '[env.preview.vars]\nSTRIPE_ACCOUNT_ID = "acct_only0000000001"\n', expected,
  ), /does not match the reviewed provider preflight value/);
});

function price(id: string, interval: 'month' | 'year', unitAmount: number) {
  return {
    id,
    object: 'price',
    active: true,
    billing_scheme: 'per_unit',
    currency: 'usd',
    custom_unit_amount: null,
    livemode: false,
    product: PRODUCT,
    recurring: { interval, interval_count: 1, usage_type: 'licensed' },
    type: 'recurring',
    unit_amount: unitAmount,
    unit_amount_decimal: String(unitAmount),
  };
}

function webhook() {
  return {
    id: WEBHOOK,
    object: 'webhook_endpoint',
    api_version: STRIPE_API_VERSION,
    enabled_events: [...REQUIRED_WEBHOOK_EVENTS],
    livemode: false,
    status: 'enabled',
    url: PREVIEW_WEBHOOK_URL,
  };
}

function product() {
  return {
    id: PRODUCT, object: 'product', active: true, livemode: false,
    name: 'Solvency Pro', default_price: MONTHLY,
  };
}

function portal() {
  return {
    id: PORTAL,
    object: 'billing_portal.configuration',
    active: true,
    livemode: false,
    is_default: false,
    default_return_url: PREVIEW_PORTAL_RETURN_URL,
    business_profile: {
      privacy_policy_url: 'https://solvency.dev/privacy',
      terms_of_service_url: 'https://solvency.dev/terms',
    },
    login_page: { enabled: false, url: null },
    features: {
      customer_update: { enabled: false, allowed_updates: [] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: {
        enabled: true,
        mode: 'at_period_end',
        proration_behavior: 'none',
        cancellation_reason: {
          enabled: true,
          options: ['too_expensive', 'missing_features', 'switched_service', 'unused', 'other'],
        },
      },
      subscription_update: {
        enabled: false, default_allowed_updates: [], proration_behavior: 'none', products: null,
      },
      subscription_pause: { enabled: false },
    },
  };
}

test('validates only exact flat test Prices and the pinned webhook contract', () => {
  assert.deepEqual(validateStripeAccount({ id: ACCOUNT, object: 'account' }, ACCOUNT), { id: ACCOUNT });
  assert.deepEqual(validateStripeProduct(product(), {
    id: PRODUCT, monthlyPriceId: MONTHLY, annualPriceId: ANNUAL,
  }), { id: PRODUCT });
  assert.deepEqual(validateStripePrice(price(MONTHLY, 'month', 1_900), {
    id: MONTHLY, interval: 'month', unitAmount: 1_900,
  }), { id: MONTHLY, productId: PRODUCT });
  assert.deepEqual(validateStripeWebhookEndpoint(webhook(), WEBHOOK), { id: WEBHOOK });
  assert.deepEqual(validateStripePortalConfiguration(portal(), PORTAL), { id: PORTAL });

  for (const invalid of [
    { ...price(MONTHLY, 'month', 1_900), livemode: true },
    { ...price(MONTHLY, 'month', 1_900), active: false },
    { ...price(MONTHLY, 'month', 1_900), unit_amount: 1_901 },
    { ...price(MONTHLY, 'month', 1_900), billing_scheme: 'tiered' },
    { ...price(MONTHLY, 'month', 1_900), recurring: { interval: 'month', interval_count: 1, usage_type: 'metered' } },
  ]) assert.throws(() => validateStripePrice(invalid, {
    id: MONTHLY, interval: 'month', unitAmount: 1_900,
  }), /configuration preflight failed/);

  for (const invalid of [
    { ...webhook(), livemode: true },
    { ...webhook(), api_version: '2026-08-20.clover' },
    { ...webhook(), url: `${PREVIEW_WEBHOOK_URL}/extra` },
    { ...webhook(), enabled_events: ['customer.subscription.updated'] },
    { ...webhook(), enabled_events: [...REQUIRED_WEBHOOK_EVENTS, 'invoice.paid'] },
  ]) assert.throws(() => validateStripeWebhookEndpoint(invalid, WEBHOOK), /configuration preflight failed/);

  for (const invalid of [
    { ...portal(), livemode: true },
    { ...portal(), is_default: true },
    { ...portal(), default_return_url: 'https://solvency.dev/pricing' },
    { ...portal(), features: { ...portal().features, subscription_update: {
      enabled: true, default_allowed_updates: ['price'], proration_behavior: 'always_invoice',
    } } },
    { ...portal(), features: { ...portal().features, subscription_cancel: {
      ...portal().features.subscription_cancel, mode: 'immediately',
    } } },
  ]) assert.throws(() => validateStripePortalConfiguration(invalid, PORTAL), /configuration preflight failed/);
});

test('preflight makes six GET-only calls with a restricted test key and pinned API version', async () => {
  const seen: string[] = [];
  const fetchImplementation = async (input: URL, init: RequestInit) => {
    assert.equal(input.origin, 'https://api.stripe.com');
    assert.equal(init.method, 'GET');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('stripe-version'), STRIPE_API_VERSION);
    assert.equal(Buffer.from(headers.get('authorization')?.slice('Basic '.length) ?? '', 'base64').toString(), `${KEY}:`);
    seen.push(input.pathname);
    const values = new Map([
      ['/v1/account', { id: ACCOUNT, object: 'account' }],
      [`/v1/products/${PRODUCT}`, product()],
      [`/v1/prices/${MONTHLY}`, price(MONTHLY, 'month', 1_900)],
      [`/v1/prices/${ANNUAL}`, price(ANNUAL, 'year', 19_000)],
      [`/v1/webhook_endpoints/${WEBHOOK}`, webhook()],
      [`/v1/billing_portal/configurations/${PORTAL}`, portal()],
    ]);
    const value = values.get(input.pathname);
    assert.ok(value, `unexpected Stripe path ${input.pathname}`);
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  };
  const result = await runStripePreviewConfigPreflight({
    STRIPE_CONFIG_READ_ONLY_KEY: KEY,
    STRIPE_ACCOUNT_ID: ACCOUNT,
    STRIPE_PRO_PRODUCT_ID: PRODUCT,
    STRIPE_PRO_MONTHLY_PRICE_ID: MONTHLY,
    STRIPE_PRO_ANNUAL_PRICE_ID: ANNUAL,
    STRIPE_WEBHOOK_ENDPOINT_ID: WEBHOOK,
    STRIPE_PORTAL_CONFIGURATION_ID: PORTAL,
  }, fetchImplementation as typeof fetch);
  assert.deepEqual(new Set(seen), new Set([
    '/v1/account',
    `/v1/products/${PRODUCT}`,
    `/v1/prices/${MONTHLY}`,
    `/v1/prices/${ANNUAL}`,
    `/v1/webhook_endpoints/${WEBHOOK}`,
    `/v1/billing_portal/configurations/${PORTAL}`,
  ]));
  assert.equal(result.apiVersion, STRIPE_API_VERSION);
});

test('preflight rejects broad keys, unapproved paths and mismatched Products', async () => {
  const wrongProduct = 'prod_wrongproduct00001';
  await assert.rejects(
    stripeApiGet(`/v1/prices/${MONTHLY}`, `sk_test_${'a'.repeat(24)}`, async () => new Response('{}')),
    /restricted Stripe test key/,
  );
  await assert.rejects(
    stripeApiGet('/v1/customers', KEY, async () => new Response('{}')),
    /unapproved Stripe API path/,
  );
  await assert.rejects(
    runStripePreviewConfigPreflight({
      STRIPE_CONFIG_READ_ONLY_KEY: KEY,
      STRIPE_ACCOUNT_ID: ACCOUNT,
      STRIPE_PRO_PRODUCT_ID: wrongProduct,
      STRIPE_PRO_MONTHLY_PRICE_ID: MONTHLY,
      STRIPE_PRO_ANNUAL_PRICE_ID: ANNUAL,
      STRIPE_WEBHOOK_ENDPOINT_ID: WEBHOOK,
      STRIPE_PORTAL_CONFIGURATION_ID: PORTAL,
    }, (async (input: URL) => {
      const values = new Map([
        ['/v1/account', { id: ACCOUNT, object: 'account' }],
        [`/v1/products/${wrongProduct}`, { ...product(), id: wrongProduct }],
        [`/v1/prices/${MONTHLY}`, price(MONTHLY, 'month', 1_900)],
        [`/v1/prices/${ANNUAL}`, price(ANNUAL, 'year', 19_000)],
        [`/v1/webhook_endpoints/${WEBHOOK}`, webhook()],
        [`/v1/billing_portal/configurations/${PORTAL}`, portal()],
      ]);
      return new Response(JSON.stringify(values.get(input.pathname)), {
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch),
    /exact configured Pro Product/,
  );
});

test('provider preflight workflow is manual, reviewed, read-only and credential-compartmentalized', () => {
  const workflow = readFileSync(join(ROOT, '.github/workflows/stripe-preview-preflight.yml'), 'utf8');
  assert.match(workflow, /^on:\n\s+workflow_dispatch:$/m);
  assert.match(workflow, /environment:\n\s+name: preview\n\s+deployment: false/);
  assert.match(workflow, /permissions:\n\s+contents: read/);
  assert.match(workflow, /secrets\.PREVIEW_STRIPE_CONFIG_READ_ONLY_KEY/);
  assert.match(workflow, /npm run smoke:stripe-preview-config/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|PREVIEW_CF_ACCESS|CLERK_SECRET|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET/);
  assert.doesNotMatch(workflow, /wrangler|pages deploy|curl|\bPOST\b/);
});
