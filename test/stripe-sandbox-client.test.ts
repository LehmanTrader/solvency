import test from 'node:test';
import assert from 'node:assert/strict';
import {
  billingReturnMarker,
  stripeSandboxEntitlement,
  stripeSandboxEntitlementMessage,
  stripeSandboxRedirectUrl,
  stripeCheckoutBrowserKey,
  authenticatedJsonFetch,
  StripeSandboxRequestError,
} from '../site/src/lib/stripe-sandbox-runtime.js';

test('accepts only exact Stripe-hosted test destinations', () => {
  const checkout = 'https://checkout.stripe.com/c/pay/cs_test_0000000000000001#provider-token';
  const portal = 'https://billing.stripe.com/p/session/test_000000000000000000000001';
  assert.equal(stripeSandboxRedirectUrl({ data: { url: checkout } }, 'checkout'), checkout);
  assert.equal(stripeSandboxRedirectUrl({ data: { url: portal } }, 'portal'), portal);
});

test('recognizes only one exact billing return marker', () => {
  assert.equal(billingReturnMarker(new URL('https://preview.example/pricing?checkout=success')), 'checkout-success');
  assert.equal(billingReturnMarker(new URL('https://preview.example/pricing?checkout=canceled')), 'checkout-canceled');
  assert.equal(billingReturnMarker(new URL('https://preview.example/pricing?billing=portal-return')), 'portal-return');
  for (const url of [
    'https://preview.example/pricing',
    'https://preview.example/pricing?checkout=success&extra=1',
    'https://preview.example/pricing?checkout=success&checkout=success',
    'https://preview.example/pricing?checkout=paid',
    'https://preview.example/pricing?billing=portal-return#copied',
  ]) assert.equal(billingReturnMarker(new URL(url)), null);
});

test('derives a stable per-session Checkout replay key without browser storage', async () => {
  const month = await stripeCheckoutBrowserKey('user_account_alpha', 'sess_preview_alpha', 'month');
  assert.match(month, /^solvency-checkout-month-v1-[a-f0-9]{64}$/);
  assert.equal(
    await stripeCheckoutBrowserKey('user_account_alpha', 'sess_preview_alpha', 'month'),
    month,
  );
  assert.notEqual(
    await stripeCheckoutBrowserKey('user_account_alpha', 'sess_preview_alpha', 'year'),
    month,
  );
  assert.notEqual(
    await stripeCheckoutBrowserKey('user_account_alpha', 'sess_preview_beta', 'month'),
    month,
  );
  await assert.rejects(
    stripeCheckoutBrowserKey('', 'sess_preview_alpha', 'month'),
    /INVALID_REQUEST/,
  );
});

test('bounds a stalled Clerk token lookup before any billing fetch can start', async () => {
  const originalWindow = globalThis.window;
  const originalLocation = globalThis.location;
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  Object.defineProperties(globalThis, {
    window: {
      configurable: true,
      writable: true,
      value: {
        Clerk: {
          session: {
            id: 'sess_preview_alpha',
            getToken: () => new Promise(() => {}),
          },
        },
      },
    },
    location: {
      configurable: true,
      writable: true,
      value: new URL('https://d1-functions-preview.solvency-ru5.pages.dev/pricing'),
    },
    fetch: {
      configurable: true,
      writable: true,
      value: async () => {
        fetches += 1;
        throw new Error('fetch must not run');
      },
    },
  });
  try {
    await assert.rejects(
      authenticatedJsonFetch('/api/entitlement', { timeoutMs: 5 }),
      (error: unknown) => error instanceof StripeSandboxRequestError
        && error.code === 'REQUEST_TIMEOUT',
    );
    assert.equal(fetches, 0);
  } finally {
    Object.defineProperties(globalThis, {
      window: { configurable: true, writable: true, value: originalWindow },
      location: { configurable: true, writable: true, value: originalLocation },
      fetch: { configurable: true, writable: true, value: originalFetch },
    });
  }
});

test('accepts only exact, internally consistent entitlement envelopes', () => {
  const none = {
    data: {
      tier: 'free', active: false, source: 'none', status: 'none',
      billingInterval: null, currentPeriodEnd: null, cancelAtPeriodEnd: false,
    },
  };
  const active = {
    data: {
      tier: 'pro', active: true, source: 'stripe', status: 'active',
      billingInterval: 'month', currentPeriodEnd: '2033-05-18T03:33:20.000Z', cancelAtPeriodEnd: false,
    },
  };
  assert.deepEqual(stripeSandboxEntitlement(none), none.data);
  assert.deepEqual(stripeSandboxEntitlement(active), active.data);
  assert.match(stripeSandboxEntitlementMessage(active.data), /Verified Preview access: Pro\. Stripe status: active\. Cadence: monthly\./);
  assert.match(stripeSandboxEntitlementMessage(none.data), /Stripe status: none\. Test Checkout is available/);

  const invalid = [
    { data: { ...active.data, tier: 'free' } },
    { data: { ...active.data, active: false } },
    { data: { ...active.data, status: 'unknown' } },
    { data: { ...active.data, currentPeriodEnd: 'tomorrow' } },
    { data: { ...active.data, billingInterval: null } },
    { data: { ...active.data, status: 'canceled' } },
    { data: { ...active.data, status: 'unpaid' } },
    { data: { ...none.data, source: 'stripe' } },
    { data: { ...none.data }, extra: true },
  ];
  for (const value of invalid) assert.equal(stripeSandboxEntitlement(value), null);
});

test('rejects live, deceptive, credentialed, queried and malformed destinations', () => {
  const invalid: Array<[unknown, 'checkout' | 'portal']> = [
    [{ data: { url: 'https://checkout.stripe.com/c/pay/cs_live_0000000000000001' } }, 'checkout'],
    [{ data: { url: 'https://checkout.stripe.com.evil.example/c/pay/cs_test_0000000000000001' } }, 'checkout'],
    [{ data: { url: 'https://user@checkout.stripe.com/c/pay/cs_test_0000000000000001' } }, 'checkout'],
    [{ data: { url: 'https://checkout.stripe.com/c/pay/cs_test_0000000000000001?next=evil' } }, 'checkout'],
    [{ data: { url: 'https://billing.stripe.com/p/session/live_000000000000000000000001' } }, 'portal'],
    [{ data: { url: 'https://billing.stripe.com/p/session/test_short' } }, 'portal'],
    [{ data: { url: 'https://billing.stripe.com/p/session/test_000000000000000000000001#secret' } }, 'portal'],
    [{ data: { url: 'https://billing.stripe.com/p/session/test_000000000000000000000001', extra: true } }, 'portal'],
    [{ data: { url: 'https://billing.stripe.com/p/session/test_000000000000000000000001' }, extra: true }, 'portal'],
    [null, 'checkout'],
  ];
  for (const [value, destination] of invalid) {
    assert.equal(stripeSandboxRedirectUrl(value, destination), null);
  }
});
