const PRODUCTION_ORIGIN = 'https://solvency.dev';
const SHA256_COMMIT = /^[0-9a-f]{40}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EXPECTED_SHA = process.env.EXPECTED_BUILD_SHA?.trim() ?? '';
const ATTEMPTS = 15;
const RETRY_DELAY_MS = 2_000;
const REQUEST_TIMEOUT_MS = 10_000;

const pagePaths = ['/', '/pricing/', '/build-planner/', '/models/', '/research/'];
const closedRoutes = [
  { method: 'GET', path: '/api/build-plans' },
  { method: 'GET', path: '/api/entitlement' },
  { method: 'GET', path: '/api/intents' },
  { method: 'DELETE', path: '/api/preview-account-erasure' },
  { method: 'POST', path: '/api/stripe-webhook' },
  { method: 'GET', path: `/shared-build-plans/sv1_${'A'.repeat(43)}` },
];

function fail(message) {
  throw new Error(`Production dark-mode attestation failed: ${message}`);
}

async function request(path, method = 'GET') {
  return fetch(new URL(path, PRODUCTION_ORIGIN), {
    method,
    redirect: 'error',
    cache: 'no-store',
    headers: { Accept: 'text/html, application/json', 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function verifyPage(path) {
  const response = await request(path);
  if (response.status !== 200) fail(`${path} returned ${response.status}, expected 200.`);
  if (!response.headers.get('content-type')?.startsWith('text/html')) {
    fail(`${path} did not return HTML.`);
  }
  const body = await response.text();
  const exactStamp = `<meta name="solvency-build-sha" content="${EXPECTED_SHA}">`;
  if (!body.includes(exactStamp)) fail(`${path} does not attest the expected build SHA.`);
  if (!body.includes('data-clerk-publishable-key="pk_live_')
    || body.includes('data-clerk-publishable-key="pk_test_')) {
    fail(`${path} does not attest a Clerk live-mode client.`);
  }
  const csp = response.headers.get('content-security-policy') ?? '';
  const productionClerkOrigin = 'https://clerk.solvency.dev';
  if (csp.split(productionClerkOrigin).length - 1 !== 2
    || csp.includes('.clerk.accounts.dev')) {
    fail(`${path} does not expose the exact production Clerk CSP origin.`);
  }
  if (path === '/build-planner/'
    && (!body.includes('data-account-plans-enabled="false"')
      || !body.includes('data-product-intents-enabled="false"'))) {
    fail('/build-planner/ does not expose both production client gates as false.');
  }
}

async function verifyClosedRoute({ method, path }) {
  const response = await request(path, method);
  if (response.status !== 503) fail(`${method} ${path} returned ${response.status}, expected 503.`);
  if (response.headers.get('x-error-code') !== 'SERVICE_UNAVAILABLE') {
    fail(`${method} ${path} did not return SERVICE_UNAVAILABLE.`);
  }
  if (response.headers.get('cache-control') !== 'no-store') {
    fail(`${method} ${path} was not marked no-store.`);
  }
  if (!response.headers.get('content-type')?.startsWith('application/json')) {
    fail(`${method} ${path} did not return JSON.`);
  }
  const body = await response.json().catch(() => null);
  const error = body?.error;
  const requestIdHeader = response.headers.get('x-request-id');
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Reflect.ownKeys(body).length !== 1 || !Object.hasOwn(body, 'error')
    || !error || typeof error !== 'object' || Array.isArray(error)
    || Reflect.ownKeys(error).length !== 3
    || Reflect.ownKeys(error).some((key) => !['code', 'message', 'requestId'].includes(String(key)))
    || error.code !== 'SERVICE_UNAVAILABLE'
    || typeof error.message !== 'string' || error.message.length === 0 || error.message.length > 200
    || typeof error.requestId !== 'string' || !REQUEST_ID.test(error.requestId)
    || requestIdHeader !== error.requestId) {
    fail(`${method} ${path} returned an invalid closed response envelope.`);
  }
}

async function attest() {
  await Promise.all([
    ...pagePaths.map((path) => verifyPage(path)),
    ...closedRoutes.map((route) => verifyClosedRoute(route)),
  ]);
}

async function main() {
  if (!SHA256_COMMIT.test(EXPECTED_SHA)) {
    fail('EXPECTED_BUILD_SHA must be one exact lowercase 40-character commit SHA.');
  }
  let lastFailure;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    try {
      await attest();
      console.log(`Production dark-mode attestation passed for ${EXPECTED_SHA}.`);
      return;
    } catch (cause) {
      lastFailure = cause;
      if (attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  throw lastFailure;
}

await main();
