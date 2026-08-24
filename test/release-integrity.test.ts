import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

test('the immutable migration manifest covers every SQL file with its exact digest', () => {
  const manifest = JSON.parse(read('site/migrations/checksums.json')) as {
    version: number;
    algorithm: string;
    migrations: Array<{ name: string; sha256: string }>;
  };
  assert.equal(manifest.version, 1);
  assert.equal(manifest.algorithm, 'sha256');
  const sqlFiles = readdirSync(join(ROOT, 'site/migrations')).filter((name) => name.endsWith('.sql')).sort();
  assert.deepEqual(manifest.migrations.map((entry) => entry.name), sqlFiles);
  for (const entry of manifest.migrations) {
    assert.match(entry.name, /^\d{4}_[a-z0-9_]+\.sql$/);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    const actual = createHash('sha256')
      .update(readFileSync(join(ROOT, 'site/migrations', entry.name)))
      .digest('hex');
    assert.equal(actual, entry.sha256, `${entry.name} changed after its checksum was committed`);
  }

  const result = spawnSync(process.execPath, ['scripts/verify-migration-checksums.mjs'], {
    cwd: join(ROOT, 'site'), encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Verified 7 immutable migration checksums/);
});

test('both deploy workflows verify migrations, stamp the SHA, and reject a dirty build tree', () => {
  for (const path of ['.github/workflows/deploy.yml', '.github/workflows/deploy-preview.yml']) {
    const workflow = read(path);
    assert.match(workflow, /npm run check:migrations/);
    assert.match(workflow, /PUBLIC_BUILD_SHA: \$\{\{ github\.sha \}\}/);
    assert.match(workflow, /git diff --check/);
    assert.match(workflow, /git status --porcelain --untracked-files=all/);
    const functionsBuild = workflow.indexOf('Verify Pages Functions bundle');
    const cleanGate = workflow.indexOf('Require a clean generated source tree');
    const publish = workflow.indexOf('Publish');
    assert.ok(functionsBuild >= 0 && functionsBuild < cleanGate && cleanGate < publish);
  }
  const ignore = read('site/.gitignore');
  assert.match(ignore, /^public\/charts-light\/harness\.svg$/m);
  assert.doesNotMatch(ignore, /^public\/charts-light\/$/m);
});

test('production deploy attests exact source SHA and every dark route after publish', () => {
  const workflow = read('.github/workflows/deploy.yml');
  const script = read('site/scripts/verify-production-dark.mjs');
  const layout = read('site/src/layouts/Base.astro');
  assert.match(layout, /PUBLIC_BUILD_SHA/);
  assert.match(layout, /meta name="solvency-build-sha" content=\{BUILD_SHA\}/);
  assert.match(workflow, /EXPECTED_BUILD_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /PUBLIC_CLERK_PUBLISHABLE_KEY: \$\{\{ vars\.PUBLIC_CLERK_PUBLISHABLE_KEY \}\}/);
  assert.match(workflow, /PUBLIC_CLERK_PUBLISHABLE_KEY" != pk_live_\*/);
  assert.match(workflow, /npm run verify:production-dark/);
  assert.ok(workflow.indexOf('Publish to Cloudflare Pages') < workflow.indexOf('Attest production SHA and dark-mode health'));
  assert.match(script, /const PRODUCTION_ORIGIN = 'https:\/\/solvency\.dev'/);
  for (const path of [
    '/pricing/', '/build-planner/', '/models/', '/research/',
    '/api/build-plans', '/api/entitlement', '/api/intents',
    '/api/preview-account-erasure', '/api/checkout', '/api/billing-portal',
    '/api/stripe-webhook',
    '/shared-build-plans/',
  ]) assert.ok(script.includes(path), `missing production attestation for ${path}`);
  assert.match(script, /response\.status !== 503/);
  assert.match(script, /x-error-code/);
  assert.match(script, /cache-control/);
  assert.match(script, /data-account-plans-enabled="false"/);
  assert.match(script, /data-product-intents-enabled="false"/);
  assert.match(script, /data-clerk-publishable-key="pk_live_/);
  assert.match(script, /csp\.split\(productionClerkOrigin\)\.length - 1 !== 2/);
  assert.match(script, /csp\.includes\('\.clerk\.accounts\.dev'\)/);
  assert.match(script, /Reflect\.ownKeys\(body\)\.length !== 1/);
  assert.match(script, /requestIdHeader !== error\.requestId/);
});

test('preview deploy hands the exact published SHA to an isolated authenticated smoke job', () => {
  const workflow = read('.github/workflows/deploy-preview.yml');
  const smoke = read('site/scripts/smoke-account-plans.mjs');
  const publish = workflow.indexOf('Publish current commit to the isolated Preview branch');
  const smokeJob = workflow.indexOf('smoke-preview:');
  const attestation = workflow.indexOf('Attest exact Preview SHA and run authenticated smoke');
  assert.ok(publish >= 0 && publish < smokeJob && smokeJob < attestation);
  assert.match(workflow, /needs: deploy-preview/);
  assert.match(workflow, /EXPECTED_BUILD_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /deployment: false/);
  assert.match(workflow, /smoke-preview:[\s\S]*timeout-minutes: 15/);
  assert.match(workflow, /npx --no-install playwright install --with-deps chromium/);
  assert.match(smoke, /EXPECTED_BUILD_SHA/);
  assert.match(smoke, /solvency-build-sha/);
  assert.match(smoke, /attestPreviewReadiness/);
});

test('the tracked operations runbook covers rollback, recovery and the exact reducer boundary', () => {
  const runbook = read('site/OPERATIONS.md');
  assert.match(runbook, /wrangler pages deployment list --project-name solvency --json/);
  assert.match(runbook, /EXPECTED_BUILD_SHA=KNOWN_GOOD_40_CHARACTER_SHA npm run verify:production-dark/);
  assert.match(runbook, /wrangler d1 time-travel info/);
  assert.match(runbook, /wrangler d1 time-travel restore/);
  assert.match(runbook, /wrangler pages deployment tail/);
  assert.match(runbook, /billing_webhook_outcome/);
  assert.match(runbook, /applied,[\s\S]*replayed,\s*stale,\s*ignored,\s*signature-rejected,\s*payload-rejected and retryable/);
  assert.match(runbook, /Migration `0007_billing_checkout_attempts\.sql` must be applied/);
  assert.match(runbook, /Limit customers[\s\S]*to one subscription/);
  assert.match(runbook, /both an `active` and an `unpaid` test subscription are redirected/);
  assert.match(runbook, /required backstop for the final D1 subscription-check-to-Stripe-create race/);
  assert.match(runbook, /provider expiry 32 minutes in the future and a crash-safe[\s\S]*lock lasting 35 minutes/);
  assert.match(runbook, /never\s+stores the raw browser idempotency key or hosted Checkout[\s\S]*URL/);
  assert.match(runbook, /Before the 72-hour[\s\S]*only an exact `expired` Session with no subscription may directly/);
  assert.match(runbook, /exact owner, bound customer and retrieved subscription is[\s\S]*`canceled` or `incomplete_expired`/);
  assert.match(runbook, /`unpaid` is not terminal[\s\S]*for replacement/);
  assert.match(runbook, /one narrow recovery path[\s\S]*same atomic\s+acquisition UPDATE proves current D1 authority/);
  assert.match(runbook, /expired Session with no subscription,[\s\S]*moves the aged receipt to `manual_review`/);
  assert.match(runbook, /Status 408, 409, 404, 422,[\s\S]*ambiguous and[\s\S]*retain the generation/);
  assert.match(runbook, /Alert immediately on any `checkout_manual_review` outcome/);
  assert.match(runbook, /Do not[\s\S]*treat `checkout_pending_webhook` as the same incident/);
  for (const event of [
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
  ]) assert.ok(runbook.includes(event));
  assert.match(runbook, /Checkout completion and invoice events[\s\S]*not passed to the[\s\S]*reducer/);
  assert.match(runbook, /never gain an owner ID, bearer token, URL, header/);
});
