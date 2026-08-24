import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { previewPageBoundaryFailure } from '../site/scripts/lib/preview-page-boundary.mjs';

const ROOT = join(import.meta.dirname, '..');
const SHA = '05d10ee9e55bb0a58af69e301ce2cffafe107e56';
const CLERK_KEY = 'pk_test_preview_fixture';
const commonBoundary = [
  `<meta name="solvency-build-sha" content="${SHA}">`,
  '<html data-product-intents-enabled="true">',
  `<script data-clerk-publishable-key="${CLERK_KEY}"></script>`,
].join('');

test('pricing Preview boundary does not require the Build Composer account-plan marker', () => {
  assert.equal(previewPageBoundaryFailure(commonBoundary, {
    path: '/pricing/',
    expectedBuildSha: SHA,
    expectedClerkKey: CLERK_KEY,
  }), null);
});

test('Build Composer Preview boundary still requires its account-plan marker', () => {
  assert.match(previewPageBoundaryFailure(commonBoundary, {
    path: '/build-planner/',
    expectedBuildSha: SHA,
    expectedClerkKey: CLERK_KEY,
    requireAccountPlans: true,
  }) ?? '', /account-plan client boundary/);

  assert.equal(previewPageBoundaryFailure(`${commonBoundary}<form data-account-plans-enabled="true">`, {
    path: '/build-planner/',
    expectedBuildSha: SHA,
    expectedClerkKey: CLERK_KEY,
    requireAccountPlans: true,
  }), null);
});

test('shared Preview boundary fails closed on every exact client-attestation mismatch', () => {
  const cases = [
    {
      name: 'wrong SHA',
      page: commonBoundary,
      expectedBuildSha: 'a'.repeat(40),
      expectedClerkKey: CLERK_KEY,
      expected: /exact deployed commit/,
    },
    {
      name: 'wrong Clerk key',
      page: commonBoundary,
      expectedBuildSha: SHA,
      expectedClerkKey: 'pk_test_other_fixture',
      expected: /exact Preview client boundary/,
    },
    {
      name: 'live Clerk key',
      page: commonBoundary.replace(CLERK_KEY, 'pk_live_preview_fixture'),
      expectedBuildSha: SHA,
      expectedClerkKey: 'pk_live_preview_fixture',
      expected: /exact Preview client boundary/,
    },
    {
      name: 'disabled product intents',
      page: commonBoundary.replace('data-product-intents-enabled="true"', 'data-product-intents-enabled="false"'),
      expectedBuildSha: SHA,
      expectedClerkKey: CLERK_KEY,
      expected: /exact Preview client boundary/,
    },
  ];

  for (const entry of cases) {
    assert.match(previewPageBoundaryFailure(entry.page, {
      path: '/pricing/',
      expectedBuildSha: entry.expectedBuildSha,
      expectedClerkKey: entry.expectedClerkKey,
    }) ?? '', entry.expected, entry.name);
  }
});

test('release smoke scopes the account-plan assertion to Build Composer', () => {
  const source = readFileSync(join(ROOT, 'site/scripts/smoke-preview-release.mjs'), 'utf8');
  assert.match(source, /requirePreviewPage\('\/build-planner\/', true\)/);
  assert.match(source, /attestPricingUi\(await requirePreviewPage\('\/pricing\/'\)\)/);
});
