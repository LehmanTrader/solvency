import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

test('authenticated billing smoke is exact-origin, existing-user and provider-read-only', () => {
  const script = read('site/scripts/smoke-preview-authenticated-readonly.mjs');
  const workflow = read('.github/workflows/deploy-preview.yml');
  const packageJson = JSON.parse(read('site/package.json'));
  const middleware = read('site/functions/api/_middleware.ts');
  const apiHttp = read('site/src/lib/server/api-http.ts');

  assert.equal(
    packageJson.scripts['smoke:preview-authenticated-provider-readonly'],
    'node scripts/smoke-preview-authenticated-readonly.mjs',
  );
  assert.match(script, /const PREVIEW_ORIGIN = 'https:\/\/d1-functions-preview\.solvency-ru5\.pages\.dev'/);
  assert.match(script, /clerkTesting\.signIn\(\{ page, emailAddress \}\)/);
  assert.match(script, /claims\?\.azp !== baseUrl/);
  assert.match(script, /\/api\/entitlement/);
  assert.match(script, /\/api\/build-plans\?limit=1/);
  assert.match(script, /\/api\/billing-readiness/);
  assert.match(script, /method: 'GET'/);
  assert.doesNotMatch(script, /createUser|deleteUser|createCustomer|checkout|billing-portal|method: '(?:POST|PUT|PATCH|DELETE)'/);
  assert.doesNotMatch(script, /console\.(?:log|info|warn|error)\([^\n]*(?:token|secretKey|accessHeaders|claims)/);
  assert.match(script, /bounded per-owner D1 rate-limit counter/);
  assert.match(middleware, /enforceOwnerRateLimit/);
  assert.match(apiHttp, /INSERT INTO build_plan_rate_limits/);

  assert.match(workflow, /if: needs\.resolve-rollout\.outputs\.preview_stripe_enabled == 'true'[\s\S]*npm run smoke:preview-authenticated-provider-readonly/);
  assert.match(workflow, /CLERK_SMOKE_USER_EMAIL: \$\{\{ vars\.PREVIEW_CLERK_SMOKE_USER_EMAIL \}\}/);
});

test('release attestation keeps readiness behind Access and the staged feature gate', () => {
  const script = read('site/scripts/smoke-preview-release.mjs');
  assert.match(script, /requireAccessDenial\('\/api\/billing-readiness'\)/);
  assert.match(script, /requireError\('\/api\/billing-readiness', 'GET', stripeEnabled \? 401 : 503/);
});
