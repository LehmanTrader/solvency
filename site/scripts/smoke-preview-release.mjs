import { previewPageBoundaryFailure } from './lib/preview-page-boundary.mjs';

const PREVIEW_ORIGIN = 'https://d1-functions-preview.solvency-ru5.pages.dev';
const SHA256_COMMIT = /^[0-9a-f]{40}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const ATTEMPTS = 15;
const RETRY_DELAY_MS = 2_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 512 * 1024;

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function exactBoolean(name) {
  const value = requiredEnvironment(name);
  if (value !== 'true' && value !== 'false') throw new Error(`${name} must be exactly true or false.`);
  return value === 'true';
}

function fail(message) {
  throw new Error(`Non-destructive Preview attestation failed: ${message}`);
}

function exactOrigin() {
  const raw = requiredEnvironment('PREVIEW_BASE_URL');
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail('PREVIEW_BASE_URL must be an absolute URL.');
  }
  if (url.origin !== PREVIEW_ORIGIN || url.pathname !== '/' || url.search || url.hash) {
    fail(`PREVIEW_BASE_URL must be exactly ${PREVIEW_ORIGIN}.`);
  }
  return url.origin;
}

const baseUrl = exactOrigin();
const expectedBuildSha = requiredEnvironment('EXPECTED_BUILD_SHA');
if (!SHA256_COMMIT.test(expectedBuildSha)) fail('EXPECTED_BUILD_SHA must be one exact lowercase commit SHA.');
const expectedClerkKey = requiredEnvironment('CLERK_PUBLISHABLE_KEY');
if (!expectedClerkKey.startsWith('pk_test_')) fail('Preview must use a Clerk Development publishable key.');
const accessClientId = requiredEnvironment('CF_ACCESS_CLIENT_ID');
const accessClientSecret = requiredEnvironment('CF_ACCESS_CLIENT_SECRET');
const state = {
  erasure: exactBoolean('PREVIEW_ACCOUNT_ERASURE_ENABLED'),
  webhook: exactBoolean('PREVIEW_STRIPE_WEBHOOK_ENABLED'),
  portal: exactBoolean('PREVIEW_STRIPE_PORTAL_ENABLED'),
  checkout: exactBoolean('PREVIEW_STRIPE_CHECKOUT_ENABLED'),
  ui: exactBoolean('PREVIEW_STRIPE_SANDBOX_UI_ENABLED'),
};
const webhookAccessMode = requiredEnvironment('PREVIEW_WEBHOOK_ACCESS_MODE');
if (!['protected', 'exact-path-bypass'].includes(webhookAccessMode)) {
  fail('PREVIEW_WEBHOOK_ACCESS_MODE must be protected or exact-path-bypass.');
}
const stripeEnabled = state.webhook || state.portal || state.checkout;
if (stripeEnabled && state.erasure) fail('account erasure cannot coexist with a Stripe surface.');
if (state.portal && !state.webhook) fail('portal cannot precede webhook.');
if (state.checkout && (!state.webhook || !state.portal)) fail('Checkout cannot precede webhook and portal.');
if (state.ui && !state.checkout) fail('sandbox UI cannot precede Checkout.');
if (state.webhook && webhookAccessMode !== 'exact-path-bypass') {
  fail('enabled webhook requires the exact-path Access bypass.');
}

function exactUrl(path) {
  const url = new URL(path, baseUrl);
  if (url.origin !== baseUrl || url.username || url.password) fail(`request escaped Preview: ${path}`);
  return url;
}

async function boundedText(response, maxBytes = MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) fail(`response exceeded ${maxBytes} bytes.`);
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) fail(`response exceeded ${maxBytes} bytes.`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(combined);
}

async function unauthenticatedRequest(path, method = 'GET') {
  return fetch(exactUrl(path), {
    method,
    headers: { Accept: 'text/html, application/json', 'Cache-Control': 'no-cache' },
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function accessRequest(path, method = 'GET') {
  const response = await fetch(exactUrl(path), {
    method,
    headers: {
      Accept: 'text/html, application/json',
      'Cache-Control': 'no-cache',
      'CF-Access-Client-Id': accessClientId,
      'CF-Access-Client-Secret': accessClientSecret,
    },
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (REDIRECT_STATUSES.has(response.status)) {
    await response.body?.cancel().catch(() => undefined);
    fail(`${method} ${path} redirected after valid Access service authentication.`);
  }
  return response;
}

function isAccessDenial(response) {
  const location = response.headers.get('location');
  if (REDIRECT_STATUSES.has(response.status) && location) {
    try {
      const target = new URL(location, baseUrl);
      if (target.hostname.endsWith('.cloudflareaccess.com')
        && target.pathname.startsWith('/cdn-cgi/access/login/')) return true;
    } catch {
      return false;
    }
  }
  return response.status === 403
    && response.headers.get('server')?.toLowerCase() === 'cloudflare'
    && response.headers.has('cf-ray')
    && !response.headers.has('x-error-code');
}

async function requireAccessDenial(path) {
  const response = await unauthenticatedRequest(path);
  const denied = isAccessDenial(response);
  await response.body?.cancel().catch(() => undefined);
  if (!denied) fail(`${path} is not demonstrably protected by Cloudflare Access.`);
}

async function requireError(path, method, status, code, useAccess = true, allow = null) {
  const response = useAccess ? await accessRequest(path, method) : await unauthenticatedRequest(path, method);
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  const bodyText = await boundedText(response, 16 * 1024).catch(() => '');
  let body = null;
  try {
    body = JSON.parse(bodyText);
  } catch {
    // Validated below as an invalid error envelope.
  }
  const error = body?.error;
  const requestId = response.headers.get('x-request-id');
  if (response.status !== status || response.headers.get('x-error-code') !== code
    || response.headers.get('cache-control') !== 'no-store'
    || !contentType.startsWith('application/json')
    || !body || typeof body !== 'object' || Array.isArray(body)
    || Reflect.ownKeys(body).length !== 1 || !Object.hasOwn(body, 'error')
    || !error || typeof error !== 'object' || Array.isArray(error)
    || error.code !== code || error.requestId !== requestId || !REQUEST_ID.test(requestId ?? '')
    || (allow !== null && response.headers.get('allow') !== allow)) {
    fail(`${method} ${path} returned ${response.status}/${response.headers.get('x-error-code') ?? 'NO_ERROR_CODE'}, expected ${status}/${code}.`);
  }
}

function attestPageBoundary(page, path, requireAccountPlans = false) {
  const failure = previewPageBoundaryFailure(page, {
    path,
    expectedBuildSha,
    expectedClerkKey,
    requireAccountPlans,
  });
  if (failure) fail(failure);
}

async function requirePreviewPage(path, requireAccountPlans = false) {
  const response = await accessRequest(path);
  if (response.status !== 200
    || !response.headers.get('content-type')?.toLowerCase().startsWith('text/html')) {
    await response.body?.cancel().catch(() => undefined);
    fail(`${path} returned ${response.status} instead of Preview HTML.`);
  }
  const page = await boundedText(response);
  attestPageBoundary(page, path, requireAccountPlans);
  return page;
}

function attestPricingUi(page) {
  const markers = [
    'id="stripe-sandbox-console"',
    'Stripe test-mode billing harness',
    '/api/checkout',
    '/api/billing-portal',
    `data-preview-origin="${PREVIEW_ORIGIN}"`,
  ];
  if (!state.ui) {
    for (const marker of markers) {
      if (page.includes(marker)) fail(`/pricing/ contains dark Stripe marker ${JSON.stringify(marker)}.`);
    }
    return;
  }
  for (const marker of markers) {
    if (!page.includes(marker)) fail(`/pricing/ is missing enabled Stripe marker ${JSON.stringify(marker)}.`);
  }
  for (const buttonId of ['stripe-sandbox-month', 'stripe-sandbox-year', 'stripe-sandbox-portal', 'stripe-sandbox-refresh']) {
    if (!new RegExp(`<button[^>]+id="${buttonId}"[^>]+disabled(?:[\\s>])`).test(page)) {
      fail(`/pricing/ does not render ${buttonId} disabled by default.`);
    }
  }
  if (!/<section[^>]+id="stripe-sandbox-console"[^>]+hidden(?:[\s>])/.test(page)
    || /(?:sk|pk)_live_|whsec_|\b(?:price|prod|acct)_[A-Za-z0-9]{4,}/.test(page)) {
    fail('/pricing/ exposes an unsafe initial or provider-identifier state.');
  }
}

async function attestOnce() {
  await Promise.all([
    requireAccessDenial('/'),
    requireAccessDenial('/api/stripe-webhook-neighbor'),
    requireAccessDenial('/api/stripe-webhooks'),
    requireAccessDenial('/api/stripe-webhook/'),
    requireAccessDenial('/api/stripe-webhook%2Fextra'),
    requireAccessDenial('/api/checkout'),
    requireAccessDenial('/api/billing-portal'),
    requireAccessDenial('/api/billing-readiness'),
  ]);

  await requirePreviewPage('/build-planner/', true);
  attestPricingUi(await requirePreviewPage('/pricing/'));

  await Promise.all([
    requireError('/api/build-plans', 'GET', 401, 'AUTH_REQUIRED'),
    requireError('/api/entitlement', 'GET', 401, 'AUTH_REQUIRED'),
    requireError('/api/intents', 'GET', 401, 'AUTH_REQUIRED'),
    requireError('/api/preview-account-erasure', 'GET', state.erasure ? 401 : 503,
      state.erasure ? 'AUTH_REQUIRED' : 'SERVICE_UNAVAILABLE'),
    requireError('/api/checkout', 'GET', state.checkout ? 401 : 503,
      state.checkout ? 'AUTH_REQUIRED' : 'SERVICE_UNAVAILABLE'),
    requireError('/api/billing-portal', 'GET', state.portal ? 401 : 503,
      state.portal ? 'AUTH_REQUIRED' : 'SERVICE_UNAVAILABLE'),
    requireError('/api/billing-readiness', 'GET', stripeEnabled ? 401 : 503,
      stripeEnabled ? 'AUTH_REQUIRED' : 'SERVICE_UNAVAILABLE'),
    requireError('/api/stripe-webhook', 'GET', state.webhook ? 405 : 503,
      state.webhook ? 'METHOD_NOT_ALLOWED' : 'SERVICE_UNAVAILABLE'),
  ]);

  if (state.webhook) {
    await requireError('/api/stripe-webhook', 'GET', 405, 'METHOD_NOT_ALLOWED', false, 'POST');
    await requireError('/api/stripe-webhook', 'POST', 400, 'INVALID_REQUEST', false);
    await requireError('/api/stripe-webhook?unexpected=1', 'POST', 400, 'INVALID_REQUEST', false);
  } else if (webhookAccessMode === 'exact-path-bypass') {
    await requireError('/api/stripe-webhook', 'GET', 503, 'SERVICE_UNAVAILABLE', false);
    await requireError('/api/stripe-webhook', 'POST', 503, 'SERVICE_UNAVAILABLE', false);
  } else {
    await requireAccessDenial('/api/stripe-webhook');
  }
}

let lastFailure;
for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  try {
    await attestOnce();
    console.log(`Non-destructive Preview attestation passed for ${expectedBuildSha}; Stripe ${stripeEnabled ? 'staged' : 'dark'}.`);
    process.exitCode = 0;
    lastFailure = undefined;
    break;
  } catch (cause) {
    lastFailure = cause;
    if (attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  }
}
if (lastFailure) throw lastFailure;
