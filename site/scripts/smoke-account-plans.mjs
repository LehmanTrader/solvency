import { randomUUID } from 'node:crypto';
import { createClerkClient } from '@clerk/backend';

const PREVIEW_ORIGIN = 'https://d1-functions-preview.solvency-ru5.pages.dev';
const REQUIRED_CONFIRMATION = 'DELETE_ISOLATED_PREVIEW_DATA';
const PLAN_LIMIT = 20;

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function previewOrigin() {
  const raw = requiredEnvironment('PREVIEW_BASE_URL');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('PREVIEW_BASE_URL must be an absolute URL.');
  }
  if (url.origin !== PREVIEW_ORIGIN || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`Authenticated smoke tests are locked to ${PREVIEW_ORIGIN}.`);
  }
  return url.origin;
}

function accessHeaders() {
  const clientId = requiredEnvironment('CF_ACCESS_CLIENT_ID');
  const clientSecret = requiredEnvironment('CF_ACCESS_CLIENT_SECRET');
  return { 'CF-Access-Client-Id': clientId, 'CF-Access-Client-Secret': clientSecret };
}

const baseUrl = previewOrigin();
if (requiredEnvironment('ACCOUNT_SMOKE_CONFIRM') !== REQUIRED_CONFIRMATION) {
  throw new Error(`ACCOUNT_SMOKE_CONFIRM must equal ${REQUIRED_CONFIRMATION}.`);
}

const secretKey = requiredEnvironment('CLERK_SECRET_KEY');
const publishableKey = requiredEnvironment('CLERK_PUBLISHABLE_KEY');
if (!secretKey.startsWith('sk_test_') || !publishableKey.startsWith('pk_test_')) {
  throw new Error('Authenticated preview smoke tests require Clerk Development keys.');
}

const clerk = createClerkClient({
  secretKey,
  publishableKey,
  telemetry: { disabled: true },
});
const cloudflareAccessHeaders = accessHeaders();
const runId = randomUUID().replaceAll('-', '');
const accounts = [];

function testPlan(name) {
  return {
    schemaVersion: 1,
    name,
    workload: { buildsPerMonth: 100, volumeBasis: 'attempted_builds' },
    harness: {
      name: 'Automated preview smoke harness',
      version: 'test-only',
      configBasis: 'user_supplied',
      assertionOrigin: 'user_asserted',
      fixedCostPerBuildAttemptUsd: 0,
      fixedMonthlyCostUsd: 0,
    },
    roles: [{
      roleId: 'orchestrator',
      kind: 'orchestrator',
      label: 'Orchestrator',
      modelId: 'claude-fable-5',
      expectedInvocationsPerBuildAttempt: 1,
      usagePerInvocation: {
        uncachedInputTokens: 100_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 10_000,
        basis: 'user_supplied',
        assertionOrigin: 'user_asserted',
      },
    }],
  };
}

async function createAccount(label) {
  const user = await clerk.users.createUser({
    externalId: `solvency-preview-smoke-${runId}-${label}`,
    emailAddress: [`solvency+clerk_test_${runId}_${label}@example.com`],
    firstName: 'Solvency',
    lastName: `Smoke ${label.toUpperCase()}`,
    skipPasswordRequirement: true,
    skipLegalChecks: true,
    privateMetadata: { purpose: 'automated_preview_smoke', runId },
  });
  accounts.push({ user, session: null });
  const session = await clerk.sessions.createSession({ userId: user.id });
  accounts[accounts.length - 1].session = session;
  return accounts[accounts.length - 1];
}

async function sessionToken(account) {
  if (!account.session) throw new Error('Test session was not created.');
  return (await clerk.sessions.getToken(account.session.id)).jwt;
}

async function apiRequest(account, path, options = {}) {
  const token = await sessionToken(account);
  const method = options.method ?? 'GET';
  const headers = new Headers({
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    ...cloudflareAccessHeaders,
    ...options.headers,
  });
  if (method !== 'GET') {
    headers.set('Content-Type', 'application/json');
    headers.set('Origin', baseUrl);
    headers.set('Sec-Fetch-Site', 'same-origin');
  }
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'error',
  });
  let body = null;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.startsWith('application/json')) {
    try {
      body = await response.json();
    } catch {
      throw new Error(`${method} ${path} returned malformed JSON (${response.status}).`);
    }
  } else {
    await response.body?.cancel().catch(() => undefined);
  }
  return { response, body };
}

async function publicRequest(path) {
  const response = await fetch(new URL(path, baseUrl), {
    headers: {
      Accept: 'application/json',
      ...cloudflareAccessHeaders,
    },
    redirect: 'error',
  });
  const contentType = response.headers.get('content-type') ?? '';
  let body = null;
  if (contentType.startsWith('application/json')) {
    try {
      body = await response.json();
    } catch {
      throw new Error(`GET ${path} returned malformed JSON (${response.status}).`);
    }
  } else {
    body = await response.text();
  }
  return { response, body };
}

function expectStatus(result, expected, operation) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(result.response.status)) {
    const code = result.response.headers.get('x-error-code') ?? 'NO_ERROR_CODE';
    throw new Error(`${operation} returned ${result.response.status} (${code}); expected ${allowed.join(' or ')}.`);
  }
  return result;
}

function planResource(result, operation) {
  const resource = result.body?.data;
  if (!resource?.plan?.id || !Number.isSafeInteger(resource.plan.currentVersion)) {
    throw new Error(`${operation} did not return a valid account plan resource.`);
  }
  return resource;
}

function expectDataObject(result, operation) {
  const data = result.body?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${operation} did not return a data object.`);
  }
  return data;
}

async function listAllPlans(account) {
  const collected = [];
  let cursor = null;
  do {
    const query = new URLSearchParams({ limit: '20' });
    if (cursor) query.set('cursor', cursor);
    const result = expectStatus(
      await apiRequest(account, `/api/build-plans?${query}`),
      200,
      'list account plans',
    );
    if (!Array.isArray(result.body?.data)) throw new Error('List response data is invalid.');
    collected.push(...result.body.data);
    cursor = result.body.nextCursor ?? null;
  } while (cursor);
  return collected;
}

async function deleteAllPlans(account) {
  for (const plan of await listAllPlans(account)) {
    if (!plan?.id || !Number.isSafeInteger(plan.currentVersion)) continue;
    const result = await apiRequest(account, `/api/build-plans/${encodeURIComponent(plan.id)}`, {
      method: 'DELETE',
      headers: { 'If-Match': `"${plan.currentVersion}"` },
    });
    expectStatus(result, [200, 404], 'delete test plan');
  }
}

async function runSmoke() {
  const [accountA, accountB] = await Promise.all([createAccount('a'), createAccount('b')]);

  expectStatus(await apiRequest(accountA, '/api/build-plans'), 200, 'initial owner A list');
  expectStatus(await apiRequest(accountB, '/api/build-plans'), 200, 'initial owner B list');

  const firstPlan = testPlan('Smoke account plan 01');
  const createKey = `smoke-create-${runId}-01`;
  const createdResult = expectStatus(await apiRequest(accountA, '/api/build-plans', {
    method: 'POST',
    headers: { 'Idempotency-Key': createKey },
    body: firstPlan,
  }), 201, 'create owner A plan');
  const created = planResource(createdResult, 'create owner A plan');

  const replay = expectStatus(await apiRequest(accountA, '/api/build-plans', {
    method: 'POST',
    headers: { 'Idempotency-Key': createKey },
    body: firstPlan,
  }), 200, 'replay owner A create');
  if (replay.response.headers.get('idempotency-replayed') !== 'true'
    || planResource(replay, 'replay owner A create').plan.id !== created.plan.id) {
    throw new Error('Create idempotency replay did not return the original resource.');
  }

  expectStatus(
    await apiRequest(accountB, `/api/build-plans/${encodeURIComponent(created.plan.id)}`),
    404,
    'cross-account read',
  );
  expectStatus(await apiRequest(accountB, `/api/build-plans/${encodeURIComponent(created.plan.id)}`, {
    method: 'DELETE',
    headers: { 'If-Match': '"1"' },
  }), 404, 'cross-account delete');

  const appendPlan = testPlan('Smoke account plan next version');
  const appendResults = await Promise.all([
    apiRequest(accountA, `/api/build-plans/${encodeURIComponent(created.plan.id)}/versions`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `smoke-append-${runId}-a`, 'If-Match': '"1"' },
      body: appendPlan,
    }),
    apiRequest(accountA, `/api/build-plans/${encodeURIComponent(created.plan.id)}/versions`, {
      method: 'POST',
      headers: { 'Idempotency-Key': `smoke-append-${runId}-b`, 'If-Match': '"1"' },
      body: appendPlan,
    }),
  ]);
  const appendStatuses = appendResults.map((result) => result.response.status).sort((a, b) => a - b);
  if (appendStatuses[0] !== 201 || appendStatuses[1] !== 409) {
    throw new Error(`Concurrent append returned ${appendStatuses.join(', ')}; expected 201 and 409.`);
  }
  const conflict = appendResults.find((result) => result.response.status === 409);
  if (conflict?.response.headers.get('x-error-code') !== 'VERSION_CONFLICT') {
    throw new Error('Concurrent append did not return VERSION_CONFLICT for the stale writer.');
  }

  const entitlement = expectStatus(
    await apiRequest(accountA, '/api/entitlement'),
    200,
    'closed-default entitlement',
  );
  if (JSON.stringify(entitlement.body?.data) !== JSON.stringify({
    tier: 'free',
    active: false,
    source: 'none',
    status: 'none',
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
  })) {
    throw new Error('An account without verified billing state did not default to Free.');
  }

  const shareBody = { version: 2, expiresInDays: 7, allowQuoteExport: true };
  const shareKey = `smoke-share-${runId}-create`;
  const createdShareResult = expectStatus(await apiRequest(
    accountA,
    `/api/build-plans/${encodeURIComponent(created.plan.id)}/shares`,
    { method: 'POST', headers: { 'Idempotency-Key': shareKey }, body: shareBody },
  ), 201, 'create owner A unlisted link');
  const createdShare = expectDataObject(createdShareResult, 'create owner A unlisted link');
  if (typeof createdShare.id !== 'string' || typeof createdShare.token !== 'string'
    || createdShare.path !== `/shared-build-plans/${createdShare.token}`) {
    throw new Error('Unlisted-link creation did not return one valid bearer locator.');
  }
  const replayedShareResult = expectStatus(await apiRequest(
    accountA,
    `/api/build-plans/${encodeURIComponent(created.plan.id)}/shares`,
    { method: 'POST', headers: { 'Idempotency-Key': shareKey }, body: shareBody },
  ), 200, 'replay owner A unlisted link');
  const replayedShare = expectDataObject(replayedShareResult, 'replay owner A unlisted link');
  if (replayedShareResult.response.headers.get('idempotency-replayed') !== 'true'
    || replayedShare.id !== createdShare.id || replayedShare.token !== createdShare.token
    || replayedShare.path !== createdShare.path) {
    throw new Error('Unlisted-link replay did not return the original bearer locator.');
  }

  const listedShares = expectStatus(await apiRequest(
    accountA,
    `/api/build-plans/${encodeURIComponent(created.plan.id)}/shares`,
  ), 200, 'list owner A unlisted links');
  if (!Array.isArray(listedShares.body?.data) || listedShares.body.data.length !== 1
    || 'token' in listedShares.body.data[0] || 'path' in listedShares.body.data[0]) {
    throw new Error('Unlisted-link list exposed a bearer locator or returned the wrong count.');
  }
  expectStatus(await apiRequest(
    accountB,
    `/api/build-plans/${encodeURIComponent(created.plan.id)}/shares`,
  ), 404, 'cross-account unlisted-link list');

  const publicShare = expectStatus(
    await publicRequest(createdShare.path),
    200,
    'public unlisted-link HTML',
  );
  if (!publicShare.response.headers.get('content-type')?.startsWith('text/html')
    || typeof publicShare.body !== 'string' || !publicShare.body.includes('noindex,nofollow,noarchive')
    || publicShare.body.includes(accountA.user.id) || publicShare.body.includes(accountB.user.id)) {
    throw new Error('Public unlisted-link HTML violated its content or identity boundary.');
  }
  const publicDownload = expectStatus(
    await publicRequest(`${createdShare.path}?download=json`),
    200,
    'public unlisted-link JSON export',
  );
  if (publicDownload.body?.data?.policy?.allowQuoteExport !== true
    || publicDownload.body?.data?.plan?.name !== appendPlan.name) {
    throw new Error('Permitted unlisted-link JSON export did not return the immutable version.');
  }

  const alertBody = {
    version: 2,
    trigger: 'model_price_change',
    threshold: null,
    baselineVersion: null,
  };
  const alertKey = `smoke-alert-${runId}-create`;
  const createdAlertResult = expectStatus(await apiRequest(
    accountA,
    `/api/build-plans/${encodeURIComponent(created.plan.id)}/alerts`,
    { method: 'POST', headers: { 'Idempotency-Key': alertKey }, body: alertBody },
  ), 201, 'create owner A inactive alert');
  const createdAlert = expectDataObject(createdAlertResult, 'create owner A inactive alert');
  if (typeof createdAlert.id !== 'string' || createdAlert.status !== 'inactive') {
    throw new Error('Alert settings were not created in the required inactive state.');
  }
  const replayedAlert = expectStatus(await apiRequest(
    accountA,
    `/api/build-plans/${encodeURIComponent(created.plan.id)}/alerts`,
    { method: 'POST', headers: { 'Idempotency-Key': alertKey }, body: alertBody },
  ), 200, 'replay owner A inactive alert');
  if (replayedAlert.response.headers.get('idempotency-replayed') !== 'true'
    || replayedAlert.body?.data?.id !== createdAlert.id) {
    throw new Error('Inactive-alert replay did not return the original setting.');
  }
  expectStatus(await apiRequest(
    accountB,
    `/api/build-plans/${encodeURIComponent(created.plan.id)}/alerts`,
  ), 404, 'cross-account inactive-alert list');

  const updatedAlertBody = {
    version: 2,
    trigger: 'baseline_delta_percent',
    threshold: 10,
    baselineVersion: 1,
  };
  const updatedAlert = expectDataObject(expectStatus(await apiRequest(
    accountA,
    `/api/build-plans/${encodeURIComponent(created.plan.id)}/alerts/${encodeURIComponent(createdAlert.id)}`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': `smoke-alert-${runId}-update` },
      body: updatedAlertBody,
    },
  ), 201, 'update owner A inactive alert'), 'update owner A inactive alert');
  if (updatedAlert.status !== 'inactive' || updatedAlert.trigger !== 'baseline_delta_percent'
    || updatedAlert.baselineVersion !== 1 || updatedAlert.threshold !== 10) {
    throw new Error('Inactive-alert update returned inconsistent settings.');
  }

  const deleteAlertKey = `smoke-alert-${runId}-delete`;
  expectStatus(await apiRequest(
    accountA,
    `/api/build-plans/${encodeURIComponent(created.plan.id)}/alerts/${encodeURIComponent(createdAlert.id)}`,
    { method: 'DELETE', headers: { 'Idempotency-Key': deleteAlertKey }, body: {} },
  ), 200, 'delete owner A inactive alert');
  const replayedAlertDelete = expectStatus(await apiRequest(
    accountA,
    `/api/build-plans/${encodeURIComponent(created.plan.id)}/alerts/${encodeURIComponent(createdAlert.id)}`,
    { method: 'DELETE', headers: { 'Idempotency-Key': deleteAlertKey }, body: {} },
  ), 200, 'replay owner A inactive-alert delete');
  if (replayedAlertDelete.response.headers.get('idempotency-replayed') !== 'true') {
    throw new Error('Inactive-alert delete replay was not acknowledged.');
  }

  const revokeShareKey = `smoke-share-${runId}-revoke`;
  expectStatus(await apiRequest(
    accountA,
    `/api/build-plans/${encodeURIComponent(created.plan.id)}/shares/${encodeURIComponent(createdShare.id)}`,
    { method: 'DELETE', headers: { 'Idempotency-Key': revokeShareKey }, body: {} },
  ), 200, 'revoke owner A unlisted link');
  const replayedShareRevoke = expectStatus(await apiRequest(
    accountA,
    `/api/build-plans/${encodeURIComponent(created.plan.id)}/shares/${encodeURIComponent(createdShare.id)}`,
    { method: 'DELETE', headers: { 'Idempotency-Key': revokeShareKey }, body: {} },
  ), 200, 'replay owner A unlisted-link revoke');
  if (replayedShareRevoke.response.headers.get('idempotency-replayed') !== 'true') {
    throw new Error('Unlisted-link revoke replay was not acknowledged.');
  }
  expectStatus(await publicRequest(createdShare.path), 404, 'revoked public unlisted link');

  for (let index = 2; index <= PLAN_LIMIT; index += 1) {
    const suffix = String(index).padStart(2, '0');
    expectStatus(await apiRequest(accountA, '/api/build-plans', {
      method: 'POST',
      headers: { 'Idempotency-Key': `smoke-create-${runId}-${suffix}` },
      body: testPlan(`Smoke account plan ${suffix}`),
    }), 201, `create quota plan ${suffix}`);
  }
  const overLimit = expectStatus(await apiRequest(accountA, '/api/build-plans', {
    method: 'POST',
    headers: { 'Idempotency-Key': `smoke-create-${runId}-over` },
    body: testPlan('Smoke account plan over limit'),
  }), 409, 'owner A plan limit');
  if (overLimit.response.headers.get('x-error-code') !== 'PLAN_LIMIT') {
    throw new Error('Plan quota did not return PLAN_LIMIT.');
  }

  const ownerAPlans = await listAllPlans(accountA);
  const ownerBPlans = await listAllPlans(accountB);
  if (ownerAPlans.length !== PLAN_LIMIT || ownerBPlans.length !== 0) {
    throw new Error(`Owner isolation count mismatch (${ownerAPlans.length}, ${ownerBPlans.length}).`);
  }

  await deleteAllPlans(accountA);
  if ((await listAllPlans(accountA)).length !== 0) {
    throw new Error('Owner A cleanup left account plans behind.');
  }
}

let failure;
try {
  await runSmoke();
} catch (cause) {
  failure = cause;
} finally {
  for (const account of accounts) {
    try {
      await deleteAllPlans(account);
    } catch {
      // Continue to identity cleanup and report the original smoke failure.
    }
  }
  for (const account of accounts) {
    try {
      await clerk.users.deleteUser(account.user.id);
    } catch {
      if (!failure) failure = new Error('A Clerk smoke-test user could not be deleted.');
    }
  }
}

if (failure) throw failure;
console.log('Authenticated preview smoke passed: entitlement default, ownership, operations, replay, concurrency, quota and deletion.');
