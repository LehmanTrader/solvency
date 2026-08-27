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

// Stage 1.2 (Roy's note 5, 2026-08-26): "what is this line that says build
// composer alread includes per-plan custom prices? remove that whole
// section." The cross-sell paragraph this test used to pin (the "Build
// Composer already includes..." line, its "Planned Pro value" pitch and the
// "Share interest" pro-notify button) is gone from the calculator card
// entirely — moved pin: this test now guards that it stays gone, and that
// no successor pitch reappears in its place.
test('calculator card carries no Build-Composer-vs-Pro cross-sell pitch', () => {
  const page = read('site/src/components/Calculator.astro');
  assert.doesNotMatch(page, /Build Composer already includes per-plan custom prices/);
  assert.doesNotMatch(page, /Planned Pro value/);
  assert.doesNotMatch(page, /id="c-notify"/);
  assert.doesNotMatch(page, />Share interest<\/button>/);
  assert.doesNotMatch(page, /Pro \(soon\):[^\n]*export|Notify me|Get notified when Pro ships/);
  assert.doesNotMatch(page, /'pro-notify'/);
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

test('the Composer accepts a free-form harness and gates paid features honestly', () => {
  // Route swap 2026-08-26 (operator): the org-chart Composer is now
  // /build-planner. Free-form harness entry survives with its new ids; the
  // paid workflow is gated, not faked.
  const page = read('site/src/pages/build-planner.astro');
  // Composer overhaul (operator, 2026-08-27): measured harnesses are a
  // select; free-form entry SURVIVES as the cp-harness input beside it.
  assert.match(page, /id="cp-harness-select"/);
  assert.match(page, /measured/);
  assert.match(page, /<input[^>]+id="cp-harness"/);
  assert.doesNotMatch(page, /<select[^>]+id="cp-harness"[^-]/);
  assert.match(page, /GATE_ADD_ROLE/);
  assert.match(page, /DEMO_ROLE_CEILING/);
  assert.match(page, /href="\/pricing#pro"/);
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
