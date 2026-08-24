import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

test('pricing is discoverable in both primary and footer navigation', () => {
  const base = read('site/src/layouts/Base.astro');
  assert.match(base, /\['\/pricing', 'Pricing'\]/);
  assert.equal(base.match(/NAV\.map/g)?.length, 2, 'the shared nav list should render in header and footer');
});

test('pricing page separates what is free now from planned Pro', () => {
  const page = read('site/src/pages/pricing.astro');
  assert.match(page, /Public evidence stays free\./);
  assert.match(page, /Research, methodology, verified model prices and the calculator are free/);
  assert.match(page, /Free · available now/);
  assert.match(page, /Pro · planned, not for sale/);
  assert.match(page, /Free now/);
  assert.match(page, /Pro planned/);
  assert.match(page, /hidden md:block tbl-wrap card/);
  assert.match(page, /grid gap-3 md:hidden/);
  assert.match(page, /<dt class="label">Free now<\/dt>/);
  assert.match(page, /<dt class="label">Pro planned<\/dt>/);
  assert.match(page, /any named or custom harness/);
  assert.match(page, /24-role safety cap/);
  assert.match(page, /up to 20 plans and 100 immutable versions per plan/);
  assert.match(page, /Reusable cross-plan custom-rate and observed-usage profiles/);
  assert.match(page, /JSON, CSV and PNG downloads now/);
  assert.match(page, /Free-account Preview can create controlled unlisted links when enabled/);
  assert.match(page, /inactive settings only; no monitoring or email is delivered/);
  assert.match(page, /Active model-price and budget monitoring, only after delivery exists/);
  assert.doesNotMatch(page, /Unlimited roles|generic exports[^\n]*Pro/i);
  assert.match(page, /re-planning, review and monitoring—not access to public evidence/);
});

test('provisional prices cannot be mistaken for an active offer', () => {
  const page = read('site/src/pages/pricing.astro');
  assert.match(page, /\$19\/month/);
  assert.match(page, /\$190\/year/);
  assert.match(page, /Provisional USD price hypothesis/);
  assert.match(page, /Billing is not live/);
  assert.match(page, /There is nothing to buy today/);
  assert.match(page, /no active checkout, trial, subscription, upgrade or paid entitlement/i);
  assert.match(page, /No plan can be purchased or reserved/);
  assert.doesNotMatch(page, /href=["']\/(?:checkout|subscribe|upgrade)/);
  assert.doesNotMatch(page, /btn-accent/);
});

test('Stripe sandbox controls are double-gated, test-only and distrust browser return markers', () => {
  const page = read('site/src/pages/pricing.astro');
  const component = read('site/src/components/StripeSandbox.astro');
  const client = read('site/src/lib/stripe-sandbox-runtime.js');
  const production = read('.github/workflows/deploy.yml');
  const preview = read('.github/workflows/deploy-preview.yml');
  const rollout = JSON.parse(read('site/preview-rollout.json'));

  assert.match(page, /PUBLIC_DEPLOYMENT_ENV === 'preview'/);
  assert.match(page, /PUBLIC_STRIPE_SANDBOX_UI_ENABLED === 'true'/);
  assert.match(page, /CLERK_PUBLISHABLE_KEY\.startsWith\('pk_test_'\)/);
  assert.match(page, /\{STRIPE_SANDBOX_UI_ENABLED && <StripeSandbox \/>\}/);
  assert.match(component, /id="stripe-sandbox-console"[\s\S]*hidden/);
  assert.match(component, /Protected Preview/);
  assert.match(component, /Use only Stripe test payment details/);
  assert.match(page, /cannot accept a real payment or create a live subscription/);
  assert.match(client, /return URL is not proof of payment or Pro access/);
  assert.match(client, /does not delete an earlier test subscription or prove that no Stripe record exists/);
  assert.match(component, /id="stripe-sandbox-month"[^>]*disabled/);
  assert.match(component, /id="stripe-sandbox-year"[^>]*disabled/);
  assert.match(component, /id="stripe-sandbox-portal"[^>]*disabled/);
  assert.match(component, /id="stripe-sandbox-refresh"[^>]*disabled/);
  assert.match(component, /stripe-sandbox-runtime\.js\?raw/);
  assert.match(component, /script is:inline type="module"/);
  assert.match(client, /authState\.status !== 'signed-in'/);
  assert.match(client, /location\.origin !== previewOrigin/);
  assert.match(client, /sandbox\.remove\(\)/);
  assert.match(client, /history\.replaceState/);
  assert.match(component, /role="alert" aria-atomic="true"/);
  assert.match(client, /authenticatedJsonFetch/);
  assert.match(client, /'Idempotency-Key'/);
  assert.match(client, /stripeCheckoutBrowserKey/);
  assert.match(client, /same signed-in Preview session\/cadence deterministically replays/);
  assert.match(client, /checkout\.stripe\.com/);
  assert.match(client, /billing\.stripe\.com/);
  assert.match(client, /cs_test_/);
  assert.doesNotMatch(client, /innerHTML|window\.open|unsafeMetadata|sessionStorage|localStorage/);
  assert.match(production, /PUBLIC_DEPLOYMENT_ENV: 'production'/);
  assert.match(production, /PUBLIC_STRIPE_SANDBOX_UI_ENABLED: 'false'/);
  assert.match(production, /npm run verify:production-artifact-dark/);
  assert.match(preview, /PUBLIC_DEPLOYMENT_ENV: 'preview'/);
  assert.equal(rollout.stripeSandboxUiEnabled, false);
  assert.match(preview, /PUBLIC_STRIPE_SANDBOX_UI_ENABLED: \$\{\{ needs\.resolve-rollout\.outputs\.preview_sandbox_ui_enabled \}\}/);
  assert.match(preview, /npm run verify:rollout-state/);
  assert.doesNotMatch(production, /vars\.PUBLIC_STRIPE_SANDBOX_UI_ENABLED/);
  assert.doesNotMatch(preview, /vars\.PUBLIC_STRIPE_SANDBOX_UI_ENABLED/);
});

test('pricing names unresolved pre-checkout policy decisions instead of promising terms', () => {
  const page = read('site/src/pages/pricing.astro');
  for (const item of ['Trial', 'Cancellation', 'Refunds', 'Tax']) {
    assert.match(page, new RegExp(`title: '${item}'[\\s\\S]{0,40}Decision pending\\.`));
  }
  assert.match(page, /Required pre-checkout disclosure/);
  assert.match(page, /automatic-renewal terms/);
  assert.match(page, /href="\/terms"/);
  assert.match(page, /href="\/privacy"/);
  assert.match(page, /decided and published before any public or live payment action is shown/);
});
