import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = join(SITE_ROOT, '..');
const PRODUCTION_ORIGIN = 'https://solvency.dev';
const SHA256_COMMIT = /^[0-9a-f]{40}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EXPECTED_SHA = process.env.EXPECTED_BUILD_SHA?.trim() ?? '';
const ATTEMPTS = 15;
const RETRY_DELAY_MS = 2_000;
const REQUEST_TIMEOUT_MS = 10_000;

function fail(message) {
  throw new Error(`Production release attestation failed: ${message}`);
}

// The launched expectations are derived from the same reviewed sources the
// rollout verifier enforces: [vars] server flags and the deploy.yml PUBLIC
// build literals in this exact checkout.
function productionFlags(wrangler) {
  const section = wrangler.split('[vars]\n', 2)[1]?.split(/\n(?=\[)/, 1)[0] ?? '';
  const value = (name) => {
    const match = section.match(new RegExp(`^${name} = "(true|false)"$`, 'm'));
    if (!match) fail(`wrangler.toml [vars] is missing ${name}.`);
    return match[1] === 'true';
  };
  return {
    plans: value('ACCOUNT_PLANS_ENABLED'),
    entitlements: value('ENTITLEMENTS_ENABLED'),
    intents: value('PRODUCT_INTENTS_ENABLED'),
    webhook: value('STRIPE_WEBHOOK_ENABLED'),
    portal: value('STRIPE_PORTAL_ENABLED'),
    checkout: value('STRIPE_CHECKOUT_ENABLED'),
  };
}

function workflowLiteral(workflow, name) {
  const matches = [...workflow.matchAll(new RegExp(`${name}: '([a-z]+)'`, 'g'))];
  if (matches.length !== 1) fail(`deploy.yml must define ${name} exactly once.`);
  return matches[0][1];
}

const [wranglerSource, workflowSource] = await Promise.all([
  readFile(join(SITE_ROOT, 'wrangler.toml'), 'utf8'),
  readFile(join(REPO_ROOT, '.github/workflows/deploy.yml'), 'utf8'),
]);
const flags = productionFlags(wranglerSource);
const stripeEnabled = flags.webhook || flags.portal || flags.checkout;
const publicCheckout = workflowLiteral(workflowSource, 'PUBLIC_STRIPE_CHECKOUT_ENABLED') === 'true';
const publicPlans = workflowLiteral(workflowSource, 'PUBLIC_ACCOUNT_PLANS_ENABLED') === 'true';
const publicIntents = workflowLiteral(workflowSource, 'PUBLIC_PRODUCT_INTENTS_ENABLED') === 'true';

const pagePaths = ['/', '/pricing/', '/build-planner/', '/models/', '/research/'];
const gated = (enabled, open, closedStatus = 503, closedCode = 'SERVICE_UNAVAILABLE') => (
  enabled ? open : { status: closedStatus, code: closedCode }
);
const apiRoutes = [
  { method: 'GET', path: '/api/build-plans', ...gated(flags.plans, { status: 401, code: 'AUTH_REQUIRED' }) },
  { method: 'GET', path: '/api/entitlement', ...gated(flags.entitlements, { status: 401, code: 'AUTH_REQUIRED' }) },
  { method: 'GET', path: '/api/intents', ...gated(flags.intents, { status: 401, code: 'AUTH_REQUIRED' }) },
  { method: 'DELETE', path: '/api/preview-account-erasure', status: 503, code: 'SERVICE_UNAVAILABLE' },
  { method: 'GET', path: '/api/checkout', ...gated(flags.checkout, { status: 401, code: 'AUTH_REQUIRED' }) },
  { method: 'GET', path: '/api/billing-portal', ...gated(flags.portal, { status: 401, code: 'AUTH_REQUIRED' }) },
  { method: 'GET', path: '/api/billing-readiness', ...gated(stripeEnabled, { status: 401, code: 'AUTH_REQUIRED' }) },
  { method: 'GET', path: '/api/stripe-webhook', ...gated(flags.webhook, { status: 405, code: 'METHOD_NOT_ALLOWED' }) },
  {
    method: 'GET',
    path: `/shared-build-plans/sv1_${'A'.repeat(43)}`,
    ...gated(flags.plans, { status: 404, code: 'RESOURCE_NOT_FOUND' }),
  },
];

async function request(path, method = 'GET') {
  return fetch(new URL(path, PRODUCTION_ORIGIN), {
    method,
    redirect: 'manual',
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
    && (!body.includes(`data-account-plans-enabled="${publicPlans}"`)
      || !body.includes(`data-product-intents-enabled="${publicIntents}"`))) {
    fail('/build-planner/ does not expose the reviewed production client gates.');
  }
  if (path === '/pricing/') {
    for (const marker of ['stripe-sandbox-console', 'Stripe test-mode billing harness']) {
      if (body.includes(marker)) fail('/pricing/ exposes the Preview-only Stripe sandbox harness.');
    }
    for (const marker of ['/api/checkout', '/api/billing-portal']) {
      if (publicCheckout && !body.includes(marker)) {
        fail(`/pricing/ is missing the launched checkout marker ${JSON.stringify(marker)}.`);
      }
      if (!publicCheckout && body.includes(marker)) {
        fail(`/pricing/ exposes the dark checkout marker ${JSON.stringify(marker)}.`);
      }
    }
  }
}

async function verifyApiRoute({ method, path, status, code }) {
  const response = await request(path, method);
  if (response.status !== status) fail(`${method} ${path} returned ${response.status}, expected ${status}.`);
  if (response.headers.get('x-error-code') !== code) {
    fail(`${method} ${path} did not return ${code}.`);
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
    || error.code !== code
    || typeof error.message !== 'string' || error.message.length === 0 || error.message.length > 200
    || typeof error.requestId !== 'string' || !REQUEST_ID.test(error.requestId)
    || requestIdHeader !== error.requestId) {
    fail(`${method} ${path} returned an invalid response envelope.`);
  }
}

async function attest() {
  await Promise.all([
    ...pagePaths.map((path) => verifyPage(path)),
    ...apiRoutes.map((route) => verifyApiRoute(route)),
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
      console.log(`Production release attestation passed for ${EXPECTED_SHA}.`);
      return;
    } catch (cause) {
      lastFailure = cause;
      if (attempt < ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
  throw lastFailure;
}

await main();
