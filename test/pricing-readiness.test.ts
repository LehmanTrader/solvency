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
  assert.match(page, /24-role safety cap/);
  assert.match(page, /2-role demo/);
  assert.match(page, /verified catalog list prices only, with the live quote|verified catalog list prices only, with the same live quote/);
  assert.match(page, /Full Composer: up to 24 roles, with custom or contract rates/);
  assert.match(page, /Sensitivity, break-even and scenario deltas/);
  assert.match(page, /Versioned account saves: 20 plans, 100 versions per plan/);
  assert.match(page, /Unlisted share links and JSON, CSV and PNG exports/);
  assert.match(page, /Founding rate lock: your rate never increases while subscribed/);
  assert.doesNotMatch(page, /Unlimited roles|generic exports[^\n]*Pro/i);
  assert.match(page, /re-planning, review and monitoring—not access to public evidence/);
  assert.match(page, /Solvency prices everything — the calculator, the frontier chart and Build Composer — the same way: cost per completed task, verified against a source\. Pro is that same math applied to the plans you save\./);
});

test('pricing names the roadmap items as planned and alerts as not sold until it exists', () => {
  const page = read('site/src/pages/pricing.astro');
  const component = read('site/src/components/ProCheckout.astro');
  const roadmapItems = /re-priced digest email, local-hardware comparison, reusable rate profiles, usage import and an API/;
  assert.match(page, roadmapItems);
  assert.match(component, roadmapItems);
  assert.match(page, /Roadmap, not sold as active features/);
  assert.match(component, /Roadmap, not sold as active features/);
  assert.match(page, /Roadmap — planned, never sold as an active feature/);
  // Alerts are never sold as an active feature: pinned in both comparison columns plus the Pro tile.
  const alertCount = (page.match(/Not sold until it exists/g) ?? []).length;
  assert.ok(alertCount >= 2, 'alerts must be pinned "not sold until it exists" in both comparison columns');
  assert.match(page, /Model-price and budget monitoring \(alerts\) is not sold until it exists/);
  assert.match(component, /Model-price and budget monitoring \(alerts\) is not sold until it exists/);
});

test('pricing funds independent benchmarking, in both flag states', () => {
  const page = read('site/src/pages/pricing.astro');
  const component = read('site/src/components/ProCheckout.astro');
  // Secondary placement: flag-independent, always-visible pricing intro.
  assert.match(page, /Solvency takes no money from model vendors; the paid tier is what funds its independent benchmark runs\./);
  // Primary placement: inside the ProCheckout card, directly under the price\/interval display.
  assert.match(component, /<p class="tile-v mt-3">\$19\/month[\s\S]{0,300}Pro funds the measurements\./);
  assert.match(component, /Pro funds the measurements\.(<\/strong>)? Solvency's benchmark runs — the measured cost-per-solved-task data this site exists to publish — are paid for by subscriptions, not by model vendors\. One full run of a 90-task-per-model batch costs about \$2,700: roughly 142 subscriber-months\. You are not just buying software; you are funding independent measurement\./);
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
  // pricing.astro's own ungated markup — everything outside the
  // `{CHECKOUT_UI_ENABLED && <ProCheckout />}` conditional exercised below —
  // must never itself contain a checkout affordance. This no longer means
  // no checkout markup exists anywhere in source: ProCheckout.astro is a
  // separate, flag-gated component file and is checked on its own terms by
  // the next test.
  assert.doesNotMatch(page, /href=["']\/(?:checkout|subscribe|upgrade)/);
  assert.doesNotMatch(page, /btn-accent/);
});

test('the live checkout surface exists only inside ProCheckout, gated by the exact PUBLIC_STRIPE_CHECKOUT_ENABLED flag', () => {
  const page = read('site/src/pages/pricing.astro');
  const component = read('site/src/components/ProCheckout.astro');
  const client = read('site/src/scripts/pro-checkout-runtime.js');
  const production = read('.github/workflows/deploy.yml');
  const preview = read('.github/workflows/deploy-preview.yml');

  // ProCheckout requires the exact flag const, and pricing.astro renders it
  // only behind that exact condition — the sole place the amber commit
  // button and the checkout/portal request paths can appear.
  assert.match(page, /const CHECKOUT_UI_ENABLED = import\.meta\.env\.PUBLIC_STRIPE_CHECKOUT_ENABLED === 'true';/);
  assert.match(page, /\{CHECKOUT_UI_ENABLED && <ProCheckout \/>\}/);
  // The only occurrence of <ProCheckout is the exact gated render matched
  // above, so no ungated instance can exist elsewhere in the page.
  assert.equal(page.match(/<ProCheckout/g)?.length, 1);

  // The existing free-forever interest signal is the mutually exclusive
  // complement: it renders only while checkout is dark.
  assert.match(page, /\{!CHECKOUT_UI_ENABLED && \(\s*<article class="card card-pad" id="pricing-pro-interest"/);
  // The pre-launch "nothing to buy" status card is likewise suppressed once
  // real checkout exists.
  assert.match(page, /\{!CHECKOUT_UI_ENABLED && \(\s*<section class="card card-pad mt-8/);

  assert.match(component, /id="pro-checkout"/);
  assert.match(component, /btn-accent/);
  assert.match(component, /id="pro-checkout-month"[^>]*disabled>Upgrade to Pro/);
  assert.match(component, /id="pro-checkout-year"[^>]*disabled>Upgrade to Pro/);
  assert.match(component, /id="pro-checkout-portal"[^>]*disabled>Manage billing/);
  assert.match(component, /pro-checkout-runtime\.js\?raw/);
  assert.match(component, /script is:inline type="module"/);
  assert.match(component, /#pro-checkout-month:disabled/);
  assert.match(component, /#pro-checkout-year:disabled/);

  // Required pre-payment disclosure: amount/cadence, auto-renewal,
  // cancellation, refund and tax treatment, each marked as a Phase 3
  // placeholder rather than final copy.
  assert.match(component, /TODO\(launch-runbook Phase 3\)/);
  assert.match(component, /Amount and cadence/);
  assert.match(component, /Auto-renewal/);
  assert.match(component, /Cancellation/);
  assert.match(component, /Refunds/);
  assert.match(component, /Tax/);
  assert.match(component, /docs\/billing-policy-drafts\.md/);

  // Contracts matched from the Functions: exact request shapes and no
  // fabricated success on a disabled/unavailable route.
  assert.match(client, /\/api\/checkout/);
  assert.match(client, /\/api\/billing-portal/);
  assert.match(client, /json: \{ interval \}/);
  assert.match(client, /'Idempotency-Key'/);
  assert.match(client, /Checkout is not available right now\./);
  assert.doesNotMatch(client, /innerHTML|window\.open|unsafeMetadata|sessionStorage|localStorage/);

  // Build-flag plumbing: hardcoded dark in production, derived in preview.
  assert.match(production, /PUBLIC_STRIPE_CHECKOUT_ENABLED: 'false'/);
  assert.match(preview, /PUBLIC_STRIPE_CHECKOUT_ENABLED: \$\{\{ needs\.resolve-rollout\.outputs\.preview_checkout_enabled \}\}/);
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
