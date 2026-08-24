import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = join(import.meta.dirname, '..');
const SCRIPT_PATH = join(ROOT, 'site/scripts/smoke-account-plans.mjs');
const source = readFileSync(SCRIPT_PATH, 'utf8');

test('authenticated account smoke is locked to an isolated preview and test identities', () => {
  assert.match(source, /const PREVIEW_ORIGIN = 'https:\/\/d1-functions-preview\.solvency-ru5\.pages\.dev';/);
  assert.match(source, /ACCOUNT_SMOKE_CONFIRM/);
  assert.match(source, /DELETE_ISOLATED_PREVIEW_DATA/);
  assert.match(source, /requiredEnvironment\('EXPECTED_BUILD_SHA'\)/);
  assert.match(source, /SHA256_COMMIT\.test\(expectedBuildSha\)/);
  assert.match(source, /secretKey\.startsWith\('sk_test_'\)/);
  assert.match(source, /publishableKey\.startsWith\('pk_test_'\)/);
  assert.doesNotMatch(source, /https:\/\/solvency\.dev/);

  const originGate = source.indexOf('const baseUrl = previewOrigin();');
  const confirmationGate = source.indexOf("requiredEnvironment('ACCOUNT_SMOKE_CONFIRM')");
  const clientCreation = source.indexOf('createClerkClient({');
  const firstFetch = source.indexOf('await fetch(');
  assert.ok(originGate >= 0 && originGate < confirmationGate);
  assert.ok(confirmationGate < clientCreation && clientCreation < firstFetch);
});

test('authenticated account smoke requires Access service credentials and always cleans up', () => {
  assert.match(source, /requiredEnvironment\('CF_ACCESS_CLIENT_ID'\)/);
  assert.match(source, /requiredEnvironment\('CF_ACCESS_CLIENT_SECRET'\)/);
  assert.match(source, /CF-Access-Client-Id/);
  assert.match(source, /CF-Access-Client-Secret/);
  assert.match(source, /proveUnauthenticatedAccessDenial/);
  assert.match(source, /cloudflareaccess\.com/);
  assert.match(source, /\['\/', 'text\/html'\]/);
  assert.match(source, /\['\/api\/build-plans', 'application\/json'\]/);
  assert.match(source, /!response\.headers\.has\('x-error-code'\)/);
  assert.match(source, /const errorCode = response\.headers\.get\('x-error-code'\)/);
  assert.match(source, /finally \{/);
  assert.match(source, /accounts\.push\(account\)[\s\S]*clerk\.users\.createUser/);
  assert.match(source, /clerk\.users\.getUserList\(\{[\s\S]*externalId: \[account\.externalId\]/);
  assert.match(source, /user = await recoverAccountUser\(account\)/);
  assert.match(source, /await eraseAllAccountData\(account\)/);
  assert.match(source, /DELETE_MY_ISOLATED_PREVIEW_DATA/);
  assert.match(source, /await clerk\.users\.deleteUser\(user\.id\)/);
  assert.match(source, /new AggregateError/);
  assert.ok(source.indexOf('await eraseAllAccountData(account)') < source.indexOf('await clerk.users.deleteUser(user.id)'));
  assert.doesNotMatch(source, /Promise\.all\(\[createAccount/);
  assert.doesNotMatch(source, /console\.(?:log|error|warn)\([^\n]*(?:secretKey|publishableKey|clientSecret|token|account\.user)/);
});

test('authenticated account smoke attests exact Preview readiness before creating identities', () => {
  assert.match(source, /solvency-build-sha/);
  assert.match(source, /data-account-plans-enabled="true"/);
  assert.match(source, /data-product-intents-enabled="true"/);
  assert.match(source, /data-clerk-publishable-key/);
  for (const path of [
    '/api/build-plans',
    '/api/entitlement',
    '/api/intents',
    '/api/preview-account-erasure',
  ]) assert.ok(source.includes(path), `missing Preview readiness probe for ${path}`);
  assert.match(source, /response\.status !== 401/);
  assert.match(source, /AUTH_REQUIRED/);
  assert.match(source, /READINESS_ATTEMPTS/);
  assert.ok(
    [...source.matchAll(/AbortSignal\.timeout\(REQUEST_TIMEOUT_MS\)/g)].length >= 4,
    'every unauthenticated, readiness, authenticated and public fetch path must be bounded',
  );
  assert.doesNotMatch(source, /GET \$\{path\} returned malformed JSON/);
  assert.match(source, /Public share request returned malformed JSON/);

  const accessProof = source.indexOf('await proveUnauthenticatedAccessDenial();');
  const readiness = source.indexOf('await attestPreviewReadiness();');
  const firstAccount = source.indexOf("await createAccount('a')");
  assert.ok(accessProof >= 0 && accessProof < readiness && readiness < firstAccount);
});

test('authenticated account smoke covers the complete pre-billing workflow boundary', () => {
  assert.match(source, /closed-default entitlement/);
  assert.match(source, /create owner A unlisted link/);
  assert.match(source, /cross-account unlisted-link list/);
  assert.match(source, /public unlisted-link HTML/);
  assert.match(source, /public unlisted-link JSON export/);
  assert.match(source, /revoked public unlisted link/);
  assert.match(source, /create owner A inactive alert/);
  assert.match(source, /cross-account inactive-alert list/);
  assert.match(source, /replay owner A inactive-alert delete/);
  assert.match(source, /record owner A product intent/);
  assert.match(source, /replay owner A product intent/);
  assert.match(source, /idempotency-replayed/);
  assert.match(source, /status !== 'inactive'/);
  assert.match(source, /'token' in listedShares\.body\.data\[0\]/);
});

test('authenticated account smoke fails before network access without explicit configuration', () => {
  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      NODE_NO_WARNINGS: '1',
    },
    timeout: 10_000,
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /PREVIEW_BASE_URL is required/);
});
