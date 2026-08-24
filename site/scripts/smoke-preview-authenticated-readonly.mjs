import { clerk as clerkTesting, clerkSetup } from '@clerk/testing/playwright';
import { chromium } from '@playwright/test';

// Provider- and product-state read-only: these GETs never mutate Clerk, Stripe,
// plans, entitlements or billing records. Normal authenticated middleware still
// advances the bounded per-owner D1 rate-limit counter for each request.

const PREVIEW_ORIGIN = 'https://d1-functions-preview.solvency-ru5.pages.dev';
const SHA256_COMMIT = /^[0-9a-f]{40}$/;
const OWNER_ID = /^user_[A-Za-z0-9_-]{3,123}$/;
const REQUEST_TIMEOUT_MS = 10_000;
const BROWSER_TIMEOUT_MS = 30_000;
const MAX_JSON_BYTES = 64 * 1024;
const ENTITLEMENT_STATUSES = new Set([
  'none', 'trialing', 'active', 'past_due', 'paused', 'unpaid',
  'incomplete', 'incomplete_expired', 'canceled',
]);

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function fail(message) {
  throw new Error(`Authenticated provider-read-only Preview smoke failed: ${message}`);
}

function exactPreviewOrigin() {
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

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length
    && keys.every((key) => Object.hasOwn(value, key))
    && actual.every((key) => typeof key === 'string' && keys.includes(key));
}

function maskDynamicClerkTestingToken() {
  const testingToken = process.env.CLERK_TESTING_TOKEN;
  if (typeof testingToken !== 'string' || testingToken.length < 16
    || testingToken.length > 4_096 || !/^[\x21-\x7e]+$/.test(testingToken)) {
    fail('Clerk testing token is missing or malformed.');
  }
  if (process.env.GITHUB_ACTIONS === 'true') {
    process.stdout.write(`::add-mask::${testingToken.replaceAll('%', '%25')}\n`);
  }
}

async function boundedJson(response, label) {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.startsWith('application/json')) fail(`${label} did not return JSON.`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) fail(`${label} exceeded the response bound.`);
  if (!response.body) fail(`${label} returned no body.`);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_JSON_BYTES) {
        await reader.cancel().catch(() => undefined);
        fail(`${label} exceeded the response bound.`);
      }
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
    fail(`${label} returned malformed JSON.`);
  }
}

function validateEntitlement(body) {
  if (!exactObject(body, ['data'])
    || !exactObject(body.data, [
      'tier', 'active', 'source', 'status', 'billingInterval',
      'currentPeriodEnd', 'cancelAtPeriodEnd',
    ])) fail('entitlement response has an unexpected shape.');
  const value = body.data;
  if (!['free', 'pro'].includes(value.tier)
    || typeof value.active !== 'boolean'
    || !['none', 'stripe'].includes(value.source)
    || !ENTITLEMENT_STATUSES.has(value.status)
    || ![null, 'month', 'year'].includes(value.billingInterval)
    || typeof value.cancelAtPeriodEnd !== 'boolean'
    || (value.currentPeriodEnd !== null
      && (typeof value.currentPeriodEnd !== 'string'
        || Number.isNaN(Date.parse(value.currentPeriodEnd))))) {
    fail('entitlement response contains an invalid value.');
  }
  if (value.active !== (value.tier === 'pro')) fail('entitlement active/tier state is contradictory.');
  if (value.active && (!['active', 'trialing'].includes(value.status)
    || value.source !== 'stripe'
    || !['month', 'year'].includes(value.billingInterval))) {
    fail('active Pro entitlement is not backed by a valid Stripe state.');
  }
}

function validatePlanList(body) {
  if (!exactObject(body, ['data', 'nextCursor'])
    || !Array.isArray(body.data)
    || body.data.length > 1
    || (body.nextCursor !== null && typeof body.nextCursor !== 'string')) {
    fail('one-plan list response has an unexpected shape.');
  }
}

function validateReadiness(body) {
  if (!exactObject(body, ['data'])
    || !exactObject(body.data, ['ready'])
    || body.data.ready !== true) {
    fail('billing readiness did not return the exact ready envelope.');
  }
}

const baseUrl = exactPreviewOrigin();
const expectedBuildSha = requiredEnvironment('EXPECTED_BUILD_SHA');
if (!SHA256_COMMIT.test(expectedBuildSha)) fail('EXPECTED_BUILD_SHA must be an exact lowercase commit SHA.');
const secretKey = requiredEnvironment('CLERK_SECRET_KEY');
const publishableKey = requiredEnvironment('CLERK_PUBLISHABLE_KEY');
if (!secretKey.startsWith('sk_test_') || !publishableKey.startsWith('pk_test_')) {
  fail('Clerk Development keys are required.');
}
const emailAddress = requiredEnvironment('CLERK_SMOKE_USER_EMAIL');
if (emailAddress.length > 254 || emailAddress.includes(' ') || !/^[^@]+@[^@]+\.[^@]+$/.test(emailAddress)) {
  fail('CLERK_SMOKE_USER_EMAIL must be one valid dedicated test-user email address.');
}
const accessHeaders = {
  'CF-Access-Client-Id': requiredEnvironment('CF_ACCESS_CLIENT_ID'),
  'CF-Access-Client-Secret': requiredEnvironment('CF_ACCESS_CLIENT_SECRET'),
};

await clerkSetup({ publishableKey, secretKey, dotenv: false });
maskDynamicClerkTestingToken();

let browser;
let context;
try {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext();
  await context.route(`${baseUrl}/**`, async (route) => {
    if (new URL(route.request().url()).origin !== baseUrl) {
      fail('Access-header route escaped the exact Preview origin.');
    }
    const response = await route.fetch({
      headers: { ...route.request().headers(), ...accessHeaders },
      maxRedirects: 0,
      timeout: BROWSER_TIMEOUT_MS,
    });
    await route.fulfill({ response });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(BROWSER_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(BROWSER_TIMEOUT_MS);
  const navigation = await page.goto(`${baseUrl}/build-planner/`, { waitUntil: 'domcontentloaded' });
  if (!navigation || navigation.status() !== 200 || new URL(page.url()).origin !== baseUrl) {
    fail('protected Preview application could not be loaded.');
  }
  const html = await page.content();
  if (!html.includes(`<meta name="solvency-build-sha" content="${expectedBuildSha}">`)
    || !html.includes(`data-clerk-publishable-key="${publishableKey}"`)
    || html.includes('data-clerk-publishable-key="pk_live_')) {
    fail('browser page does not attest the expected commit and Clerk Development client.');
  }

  await clerkTesting.signIn({ page, emailAddress });
  const identity = await page.evaluate(() => ({
    id: window.Clerk?.user?.id ?? null,
    emails: window.Clerk?.user?.emailAddresses?.map((entry) => entry.emailAddress) ?? [],
  }));
  if (!OWNER_ID.test(identity.id ?? '') || !identity.emails.includes(emailAddress)) {
    fail('Clerk sign-in did not activate the dedicated Preview test user.');
  }

  const token = await page.evaluate(async () => window.Clerk?.session?.getToken({ skipCache: true }) ?? null);
  if (typeof token !== 'string') fail('Clerk browser session did not return a token.');
  let claims;
  try {
    const segments = token.split('.');
    if (segments.length !== 3) throw new Error('invalid JWT shape');
    claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  } catch {
    fail('Clerk browser session returned an invalid token.');
  }
  if (claims?.sub !== identity.id || claims?.azp !== baseUrl) {
    fail('Clerk token is not bound to the exact Preview origin and test user.');
  }

  const authenticatedGet = async (path, label) => {
    const url = new URL(path, baseUrl);
    if (url.origin !== baseUrl) fail(`${label} escaped the exact Preview origin.`);
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...accessHeaders,
      },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status !== 200
      || response.headers.get('cache-control') !== 'no-store'
      || response.headers.get('x-error-code') !== null) {
      await response.body?.cancel().catch(() => undefined);
      fail(`${label} returned ${response.status} instead of a clean authenticated 200.`);
    }
    return boundedJson(response, label);
  };

  validateEntitlement(await authenticatedGet('/api/entitlement', 'entitlement'));
  validatePlanList(await authenticatedGet('/api/build-plans?limit=1', 'one-plan list'));
  validateReadiness(await authenticatedGet('/api/billing-readiness', 'billing readiness'));
} finally {
  await context?.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
}

console.log(`Authenticated provider-read-only Preview smoke passed for ${expectedBuildSha}.`);
