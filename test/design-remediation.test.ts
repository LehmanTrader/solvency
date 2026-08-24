import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rankedBars, type ChartRow } from '../site/src/lib/charts.ts';
import { models } from '../site/src/lib/data.ts';
import { pairPath } from '../site/src/lib/calc.ts';

const ROOT = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

test('mobile compare table fits instead of hiding the second model', () => {
  const page = read('site/src/pages/compare/[pair].astro');
  const css = read('site/src/styles/global.css');
  assert.match(page, /class="tbl tbl-compare"/);
  assert.match(css, /\.tbl-compare\s*\{[^}]*table-layout:\s*fixed;[^}]*white-space:\s*normal;/s);
});

test('desktop models table assigns every field a visible column', () => {
  const page = read('site/src/pages/models/index.astro');
  const css = read('site/src/styles/global.css');
  assert.match(page, /class="tbl tbl-models"/);
  assert.match(page, /<colgroup>[\s\S]*models-model[\s\S]*models-verified[\s\S]*<\/colgroup>/);
  assert.match(css, /@media \(min-width: 1024px\)[\s\S]*\.tbl-models\s*\{[^}]*table-layout:\s*fixed;[^}]*white-space:\s*normal;/);
  assert.match(page, /class="tbl-wrap tbl-scroll-region" role="region" tabindex="0" aria-labelledby="models-table-caption" aria-describedby="models-table-scroll-help" data-models-scroll/);
  assert.match(page, /id="models-table-scroll-help"[^>]*>Scroll horizontally to see every pricing field, cost basis and the Verified date/);
  assert.match(page, /<caption id="models-table-caption">/);
  assert.match(page, /event\.key !== 'ArrowLeft' && event\.key !== 'ArrowRight'/);
  assert.match(page, /scrollRegion\.scrollBy\(\{[\s\S]*left: event\.key === 'ArrowRight' \? 80 : -80/);
  assert.match(css, /\.tbl-scroll-region:focus-visible\s*\{[^}]*outline-offset:\s*-2px;/);
});

test('mobile navigation reveals the current item and keeps direct sign-in', () => {
  const base = read('site/src/layouts/Base.astro');
  const css = read('site/src/styles/global.css');
  assert.match(base, /querySelector\('\[aria-current="page"\]'\)/);
  assert.match(base, /scrollLeft\s*=/);
  assert.match(base, /n\.scrollWidth\s*>\s*n\.clientWidth\s*\+\s*1/);
  assert.doesNotMatch(base, /id="auth-signin"[^>]*\bhidden\b/);
  assert.match(base, /<button type="button" id="auth-signin"[^>]*disabled>Sign in<\/button>/);
  assert.match(base, /id="auth-signup"[^>]*disabled/);
  assert.match(base, /s\.disabled = !available/);
  assert.match(base, /observeClerkAuth/);
  assert.match(base, /Account controls are loading/);
  assert.match(base, /dataset\.clerkUiReady='true';document\.dispatchEvent\(new Event\('clerk:ready'\)\)/);
  assert.match(base, /\.catch\(\(\)=>\{[^}]*dataset\.clerkUiError='true';document\.dispatchEvent\(new Event\('clerk:error'\)\)/);
  assert.match(base, /onerror="[^\"]*dataset\.clerkUiError='true';document\.dispatchEvent\(new Event\('clerk:error'\)\)"/);
  const client = read('site/src/lib/clerk-client.ts');
  assert.match(client, /if \(!c\?\.loaded \|\| !clerkUiReady\(\)\) return 'unavailable'/);
  assert.match(client, /document\.addEventListener\('clerk:error', failed, \{ once: true \}\)/);
  assert.match(base, /flex-wrap sm:flex-nowrap/);
  assert.match(base, /basis-full sm:order-none sm:basis-0 flex-1 min-w-0/);
  assert.doesNotMatch(base, /hidden lg:block small shrink-0[^>]*>prices verified/);
  assert.match(css, /@media \(max-width: 359px\)[\s\S]*\.site-header-lockup\s*\{[^}]*min-width:\s*2\.75rem;[^}]*min-height:\s*2\.75rem;[\s\S]*\.site-header-lockup \.wordmark\s*\{\s*display:\s*none;/);
  assert.match(css, /\.btn:disabled, \.btn:disabled:hover, \.btn:disabled:active\s*\{[^}]*cursor:\s*not-allowed;/);
  assert.match(css, /\.btn\[aria-busy="true"\]\s*\{[^}]*cursor:\s*progress;/);
});

test('mobile auth does not render the fixed context strip', () => {
  const client = read('site/src/lib/clerk-client.ts');
  assert.match(client, /max-width:\s*639px/);
});

test('compare-page copy separates its unavailable table export from current free Composer exports', () => {
  const page = read('site/src/pages/compare/[pair].astro');
  assert.match(page, /Export compare table/);
  assert.match(page, />Planned<\/span>/);
  assert.match(page, /Build Composer JSON, CSV and PNG downloads are available now without Pro/);
  assert.doesNotMatch(page, /Pro soon|Table export is planned for Pro/);
  assert.doesNotMatch(page, />Download table /);
});

test('calculator copy keeps current custom prices and exports free while planned Pro remains unavailable', () => {
  const page = read('site/src/components/Calculator.astro');
  assert.match(page, /Build Composer already includes per-plan custom prices and local exports/);
  assert.match(page, /Planned Pro value:<\/span> reusable cross-plan profiles and active price\/budget monitoring—neither is available yet/);
  assert.match(page, />Share interest<\/button>/);
  assert.match(page, /Both are planned and unavailable today; nothing will be purchased or reserved/);
  assert.doesNotMatch(page, /Pro \(soon\):[^\n]*export|Notify me|Get notified when Pro ships/);
});

test('compact chart compare links include their visible “vs” label in the accessible name', () => {
  const row: ChartRow = {
    id: 'a', name: 'Model A', href: '/models/a', compare: '/compare/a-vs-b',
    cost: 1, pass: 0.5, basis: 'measured',
  };
  const html = rankedBars([row], { width: 350, volume: 100, basis: 'measured', compact: true });
  assert.match(html, /aria-label="Compare vs Model A head to head"/);
});

test('research headline preserves word spacing and every note card has share controls', () => {
  const page = read('site/src/pages/research/index.astro');
  assert.match(page, /per input token and\{' '\}\s*\{fmtX\(h\.outX\)\}/);
  assert.match(page, /data-note-share/);
  assert.match(page, /const noteOne = reports\.find\(\(report\) => report\.data\.note === 1\)/);
  assert.match(page, /href\(noteOne\)/);
  assert.match(page, /<Share url=\{new URL\(href\(r\), Astro\.site\)\.href\} text=/);
  const article = read('site/src/pages/research/[...slug].astro');
  assert.match(article, /text=\{shareText\}/);
});

test('build planner accepts a free-form harness and exposes the paid workflow before billing', () => {
  const page = read('site/src/pages/build-planner.astro');
  assert.match(page, /id="b-harness"[^>]*list="harness-examples"/);
  assert.doesNotMatch(page, /<select[^>]+id="b-harness"/);
  assert.match(page, /Type any public, internal or custom harness/);
  assert.match(page, /Add model role/);
  assert.match(page, /custom or contracted token prices/);
  assert.match(page, /Current access · open preview/);
  assert.match(page, /No subscription or Pro entitlement is active/);
  assert.match(page, /Build pricing, sensitivity, tab-only versions and local downloads work now/);
  assert.match(page, /Unlisted-link delivery and monitoring remain settings-only prototypes/);
  assert.match(page, /Save in this tab/);
  assert.match(page, /Duplicate plan/);
  assert.match(page, /Preview storage[^.]+limited to this open tab/);
  assert.match(page, /Sensitivity and break-even/);
  assert.match(page, /Hypothetical one-variable sensitivity/);
  assert.match(page, /common attempted-build volume/);
  assert.match(page, /analyzeBuildSensitivity/);
  assert.match(page, /breakEvenBuildPlans/);
  assert.doesNotMatch(page, /prices the graph you enter/i);
  assert.match(page, /id="build-operations"/);
  assert.match(page, /Export, share and monitor/);
  assert.match(page, /id="b-export-json"[^>]*>Download JSON/);
  assert.match(page, /id="b-export-csv"[^>]*>Download CSV/);
  assert.match(page, /id="b-export-png"[^>]*>Download PNG/);
  assert.match(page, /no link is created, no plan is uploaded by these controls and no email is sent/i);
  assert.match(page, /Draft · no link/);
  assert.match(page, /Draft · off/);
  assert.match(page, /Unlisted link · preview/);
  assert.match(page, /Anyone with the unlisted link · view only/);
  assert.doesNotMatch(page, /xl:grid-cols-3/);
  assert.match(page, /id="b-share-save" disabled/);
  assert.match(page, /id="b-alert-save" disabled/);
  assert.match(page, /id="b-share-save" disabled>Save settings in this tab/);
  assert.match(page, /id="b-alert-save" disabled>Save inactive draft in this tab/);
  assert.match(page, /Account shares and inactive alert settings work only after you sign in and select a saved account plan/);
  assert.match(page, /Anyone with the bearer link can view the saved plan name, internal or custom harness inputs, model choices, usage assumptions and custom or contract rates/);
  assert.match(page, /id="b-share-created" hidden/);
  assert.match(page, /id="b-share-copy">Copy bearer URL/);
  assert.match(page, /id="b-share-hide">Hide bearer URL/);
  assert.match(page, /Existing bearer URLs are not returned/);
  assert.match(page, /Inactive · no monitoring/);
  assert.match(page, /StableAccountOperationKeys/);
  assert.match(page, /parseAccountShareList/);
  assert.match(page, /parseAccountAlertList/);
  assert.match(page, /accountOperationRequestCurrent/);
  assert.match(page, /b-operations-refresh/);
  assert.match(page, /build_quote_first_edit_valid/);
  assert.doesNotMatch(page, /build_quote_valid/);
  assert.doesNotMatch(page, /openSignUp\('build-pro-price-interest'/);
  assert.doesNotMatch(page, /track\('build_pro_price_interest'/);
  assert.match(page, /if \(signedIn\(\)\) \{[\s\S]*await recordProductIntentSignal\('pro_price_interest'\)/);
  assert.match(page, /proInterestMeasurementEnabled = document\.documentElement\.dataset\.productIntentsEnabled === 'true'/);
  assert.match(page, /Account-based research measurement is unavailable in this build\. No interest can be submitted or charged/);
  assert.match(page, /We could not confirm your interest signal\. You can retry safely; account-based signals are deduplicated/);
  assert.match(page, /After signing in, select this button again to submit your interest\. Nothing was submitted or charged yet/);
  assert.match(page, /id="b-account-signin" disabled>Sign in to save/);
  assert.match(page, /id="b-account-signup" disabled>Create free account/);
  assert.match(page, /authActionsReady = accountSessionExpired \|\| accountAuth\.status === 'signed-out'/);
  assert.match(page, /signin\.disabled = !authActionsReady; signup\.disabled = !authActionsReady/);
  assert.match(page, /Planned expiry:/);
  assert.match(page, /noticeReserve\s*=\s*160/);
  assert.match(page, /I’d consider Pro at \$19/);
  assert.match(page, /Requires a free account so one person counts once\. Research signal only—no upgrade, checkout, trial, subscription or charge/);
  assert.match(page, /PUBLIC_ACCOUNT_PLANS_ENABLED === 'true'/);
  assert.match(page, /Nothing from the editor is uploaded until you choose an account save action/);
  assert.match(page, /Preview safety limits are \{ACCOUNT_PLAN_PREVIEW_MAX_PLANS\} account plans and \{ACCOUNT_PLAN_PREVIEW_MAX_VERSIONS\} immutable versions per plan/);
  assert.match(page, /id="b-account-capacity">0 of \{ACCOUNT_PLAN_PREVIEW_MAX_PLANS\} plans/);
  assert.match(page, /accountPlans\.length >= accountPlanMaxPlans/);
  assert.match(page, /currentVersion >= accountPlanMaxVersions/);
  assert.match(page, /conflictedAccountPlanId === selectedAccountPlan\.plan\.id/);
  assert.match(page, /Reload its versions before appending or deleting/);
  assert.match(page, /Version limit reached/);
  assert.match(page, /Plan limit reached/);
  assert.match(page, /id="b-account-status" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(page, /authenticatedJsonFetch/);
  assert.match(page, /'Idempotency-Key'/);
  assert.match(page, /'If-Match'/);
  assert.match(page, /preserveComposerDraftForAuth/);
  assert.match(page, /consumeComposerDraftAfterAuth/);
  assert.match(page, /Preview access does not guarantee final tier placement/);
  assert.doesNotMatch(page, /account-tier limits are not enforced yet/);
  assert.match(page, /There is no upgrade or paid entitlement today/);
  assert.match(page, /Available now · open preview/);
  assert.match(page, /Keep the budget current/);
  assert.match(page, /intended recurring value is re-planning, review and monitoring—not a paywall on public research/);
  assert.match(page, /Higher limits are planned for Pro, but upgrades are not available yet/);
  for (const id of ['b-account-error', 'b-export-error', 'b-share-error', 'b-alert-error']) {
    assert.match(page, new RegExp(`id="${id}" role="alert" aria-atomic="true"`));
  }
  assert.match(page, /id="b-name" maxlength=\{BUILD_PLAN_LIMITS\.maxPlanNameChars\}/);
  assert.match(page, /data-field="label"[^>]*maxlength=\{BUILD_PLAN_LIMITS\.maxRoleLabelChars\}/);
  assert.match(page, /data-field="calls"[^>]*max=\{BUILD_PLAN_LIMITS\.maxExpectedInvocations\}/);
  assert.match(page, /validateUntrustedBuildPlanV1\(draft, eligibleModels\)/);
  assert.match(page, /function renderInvalidDraft\(/);
  assert.match(page, /setAttribute\('aria-invalid', 'true'\)/);
  assert.match(page, /setAttribute\('aria-errormessage', errorId\)/);
  assert.match(page, /descriptions\.add\(errorId\)/);
  assert.match(page, /\.ctl\[data-plan-invalid='true'\]/);
  assert.match(page, /\.plan-field-error/);
  assert.match(page, /numericInput\s*=\s*\(input:[^)]+\)\s*=>\s*input\.value === '' \? Number\.NaN : input\.valueAsNumber/);
  assert.match(page, /data-field="calls"[^>]*step="any"[^>]*value="1"/);
  assert.match(page, /data-field="fresh"[^>]*step="any"/);
  assert.doesNotMatch(page, /data-field="calls"[^>]*step="0\.25"/);
  assert.match(page, /disabled = !lastQuote\.valid/);
  assert.match(page, /if \(!lastDraftValid \|\| !lastQuote\.valid\) return/);
  assert.doesNotMatch(page, /priceOverride:\s*custom\s*\?[^\n]+:\s*undefined/);
  assert.doesNotMatch(page, /endToEndSuccess:\s*successText\s*\?[^\n]+:\s*undefined/);
  assert.match(page, /form\.addEventListener\('focusout'/);
  for (const event of ['build-add-role', 'build-save-version', 'build-duplicate']) {
    assert.equal(page.match(new RegExp(event, 'g'))?.length, 1, `${event} should have one instrumentation path`);
  }
});

test('pricing offers one disclosed, non-transactional first-party price-interest action', () => {
  const page = read('site/src/pages/pricing.astro');
  assert.match(page, /id="pricing-pro-interest" data-clerk-enabled=/);
  assert.match(page, /id="pricing-pro-interest-button"[^>]*disabled>I’d consider Pro at \$19/);
  assert.match(page, /Requires a free account so one person counts once/);
  assert.match(page, /research signal only—no plan is reserved and there is no upgrade, checkout, trial, subscription or charge/);
  assert.doesNotMatch(page, /track\('build_pro_price_interest'/);
  assert.equal(page.match(/recordProductIntentSignal\('pro_price_interest'\)/g)?.length, 1);
  assert.match(page, /if \(signedIn\(\)\) \{[\s\S]*await recordProductIntentSignal\('pro_price_interest'\)/);
  assert.match(page, /measurementEnabled = document\.documentElement\.dataset\.productIntentsEnabled === 'true'/);
  assert.match(page, /Account-based research measurement is unavailable in this build\. No interest can be submitted or charged/);
  assert.match(page, /We could not confirm your interest signal\. You can retry safely; account-based signals are deduplicated/);
  assert.doesNotMatch(page, /openSignUp\('build-pro-price-interest'/);
  assert.match(page, /After signing in, select this button again to submit your interest\. Nothing was submitted or charged yet/);
  assert.doesNotMatch(page, /id="pricing-pro-interest-button"[^>]*data-analytics/);
  assert.match(page, /observeClerkAuth\(renderAuth/);
  assert.match(page, /result === 'unavailable'/);
});

test('privacy discloses bounded D1 throttling without implying request-content logging', () => {
  const page = read('site/src/pages/privacy.astro');
  assert.match(page, /one rate-limit counter row per verified Clerk account ID/);
  assert.match(page, /current minute bucket and a capped request count/);
  assert.match(page, /request contents are not logged in that row/);
  assert.match(page, /per-account rate-limit records, will be deleted within 30 days/);
});

test('every model pair uses the one generated canonical compare path', () => {
  for (let i = 0; i < models.length; i += 1) {
    for (let j = i + 1; j < models.length; j += 1) {
      const expected = `/compare/${models[i].model_id}-vs-${models[j].model_id}`;
      assert.equal(pairPath(models[i].model_id, models[j].model_id), expected);
      assert.equal(pairPath(models[j].model_id, models[i].model_id), expected);
    }
  }
  const page = read('site/src/pages/models/[id].astro');
  assert.match(page, /href=\{pairPath\(model\.model_id, p\.model_id\)\}/);
});
