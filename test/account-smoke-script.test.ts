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
  assert.match(source, /clerk as clerkTesting, clerkSetup/);
  assert.match(source, /chromium/);
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
  assert.match(source, /async function accessRequest[\s\S]*redirect: 'manual'/);
  assert.match(source, /a Cloudflare Access login redirect/);
  assert.match(source, /const destination = `\$\{target\.hostname\}\$\{target\.pathname\}`/);
  assert.match(source, /target\.origin === baseUrl/);
  assert.doesNotMatch(source, /baseUrl\.origin/);
  assert.doesNotMatch(source, /target\.search/);
  assert.match(source, /\['\/', 'text\/html'\]/);
  assert.match(source, /\['\/api\/build-plans', 'application\/json'\]/);
  assert.match(source, /!response\.headers\.has\('x-error-code'\)/);
  assert.match(source, /const errorCode = response\.headers\.get\('x-error-code'\)/);
  assert.match(source, /finally \{/);
  assert.match(source, /accounts\.push\(account\)[\s\S]*clerk\.users\.createUser/);
  assert.match(source, /clerk\.users\.getUserList\(\{[\s\S]*externalId: \[account\.externalId\]/);
  assert.match(source, /user = await recoverAccountUser\(account\)/);
  assert.match(source, /await eraseAllAccountData\(account\)/);
  assert.match(source, /storageState/);
  assert.match(source, /let erasureConfirmed = account\.storageState === 'none'/);
  assert.match(source, /if \(!erasureConfirmed\) continue/);
  assert.match(source, /DELETE_MY_ISOLATED_PREVIEW_DATA/);
  assert.match(source, /await clerk\.users\.deleteUser\(user\.id\)/);
  assert.match(source, /new AggregateError/);
  assert.ok(source.indexOf('await eraseAllAccountData(account)') < source.indexOf('await clerk.users.deleteUser(user.id)'));
  assert.doesNotMatch(source, /Promise\.all\(\[createAccount/);
  assert.doesNotMatch(source, /clerk\.sessions\.createSession/);
  assert.doesNotMatch(source, /clerk\.sessions\.getToken/);
  assert.doesNotMatch(source, /console\.(?:log|error|warn)\([^\n]*(?:secretKey|publishableKey|clientSecret|token|account\.user)/);
});

test('authenticated account smoke obtains origin-bound tokens without leaking Access credentials', () => {
  assert.match(source, /await clerkSetup\(\{ publishableKey, secretKey, dotenv: false \}\)/);
  assert.match(source, /process\.env\.CLERK_TESTING_TOKEN/);
  assert.match(source, /process\.env\.GITHUB_ACTIONS === 'true'/);
  assert.match(source, /::add-mask::/);
  assert.match(source, /testingToken\.replaceAll\('%', '%25'\)/);
  assert.match(source, /await chromium\.launch\(\{ headless: true \}\)/);
  assert.match(source, /account\.context\.route\(`\$\{baseUrl\}\/\*\*`/);
  assert.match(source, /new URL\(route\.request\(\)\.url\(\)\)\.origin !== baseUrl/);
  assert.match(source, /const response = await route\.fetch\(\{/);
  assert.match(source, /maxRedirects: 0/);
  assert.match(source, /await route\.fulfill\(\{ response \}\)/);
  assert.doesNotMatch(source, /route\.continue\(\{\s*headers:/);
  assert.match(source, /clerkTesting\.signIn\(\{[\s\S]*page,[\s\S]*emailAddress: account\.emailAddress/);
  assert.match(source, /getToken\(forceRefresh \? \{ skipCache: true \} : undefined\)/);
  assert.match(source, /claims\?\.sub !== account\.user\.id \|\| claims\?\.azp !== baseUrl/);
  assert.match(source, /full signature, issuer, expiry, session-state and authorized-party checks/);
  assert.doesNotMatch(source, /authorizedParties:\s*\[\]/);
  assert.doesNotMatch(source, /setExtraHTTPHeaders/);
  assert.match(source, /const exactAuthRejection = response\.status === 401/);
  assert.match(source, /account\.storageState = 'touched'/);
  assert.match(source, /including for GET requests and application-level errors/);
  assert.match(source, /Authenticated erasure requires a live browser session/);
  assert.match(source, /withBrowserDeadline/);
  assert.match(source, /Clerk session token request timed out/);
  const setup = source.indexOf('await clerkSetup({ publishableKey, secretKey, dotenv: false });');
  const mask = source.indexOf('maskDynamicClerkTestingToken();');
  const launch = source.indexOf('browser = await chromium.launch({ headless: true });');
  assert.ok(setup >= 0 && setup < mask && mask < launch);
});

test('authenticated account smoke narrowly reconciles prior synthetic identities before creating more', () => {
  assert.match(source, /SYNTHETIC_EXTERNAL_ID = \/\^solvency-preview-smoke-/);
  assert.match(source, /user\.privateMetadata\?\.purpose !== 'automated_preview_smoke'/);
  assert.match(source, /user\.privateMetadata\?\.runId !== match\[1\]/);
  assert.match(source, /entry\.emailAddress === expectedEmail/);
  assert.match(source, /STALE_IDENTITY_LIMIT/);
  assert.match(source, /await reconcileStaleAccounts\(\)/);
  assert.match(source, /homepage loads Clerk but does not issue account-owned API requests/);
  assert.match(source, /account\.page\.goto\(`\$\{baseUrl\}\/`/);
  const reconcile = source.indexOf('await reconcileStaleAccounts();');
  const firstAccount = source.indexOf("await createAccount('a')");
  assert.ok(reconcile >= 0 && reconcile < firstAccount);
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
  const entitlementBoundary = source.slice(
    source.indexOf('closed-default entitlement'),
    source.indexOf('const shareBody'),
  );
  assert.match(entitlementBoundary, /tier: 'free',[\s\S]*source: 'none',[\s\S]*status: 'none'/);
  assert.match(entitlementBoundary, /billingInterval: null/);
  assert.match(entitlementBoundary, /currentPeriodEnd: null/);
  assert.match(entitlementBoundary, /cancelAtPeriodEnd: false/);
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
