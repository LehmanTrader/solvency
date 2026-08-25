import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verdictHtml, type Side } from '../site/src/lib/compare.ts';
import { calloutHtml, type Row } from '../site/src/lib/calc.ts';

const ROOT = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

function workflowJob(source: string, name: string): string {
  const marker = `  ${name}:\n`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing workflow job ${name}`);
  const remainder = source.slice(start + marker.length);
  const next = remainder.search(/^  [a-z0-9][a-z0-9-]*:\n/m);
  return next < 0 ? remainder : remainder.slice(0, next);
}

function workflowStep(job: string, name: string): string {
  const marker = `      - name: ${name}\n`;
  const start = job.indexOf(marker);
  assert.ok(start >= 0, `missing workflow step ${name}`);
  const remainder = job.slice(start + marker.length);
  const next = remainder.search(/^      - (?:name|uses):/m);
  return next < 0 ? remainder : remainder.slice(0, next);
}

function workflowSecrets(job: string): string[] {
  return [...new Set([...job.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]))].sort();
}

test('production headers enforce a scoped content security policy', () => {
  const headers = read('site/public/_headers');
  assert.match(headers, /Content-Security-Policy:/);
  assert.match(headers, /default-src 'self'/);
  assert.match(headers, /frame-ancestors 'none'/);
  assert.match(headers, /\/embed\/table[\s\S]*frame-ancestors \*/);
});

test('the site publishes a valid security contact and a real 404 page', () => {
  const security = read('site/public/.well-known/security.txt');
  assert.match(security, /^Contact: mailto:/m);
  assert.match(security, /^Expires: /m);
  assert.match(security, /^Canonical: https:\/\/solvency\.dev\/\.well-known\/security\.txt$/m);
  assert.match(read('site/src/pages/404.astro'), /Page not found/);
});

test('verdict HTML escapes model names before reaching innerHTML', () => {
  const model = (id: string, name: string, output: number) => ({ model_id: id, display_name: name, output_per_mtok: output });
  const result = { pass_rate: 0.5 };
  const a: Side = { m: model('a', '<img src=x onerror=alert(1)>', 1), r: result, cost: 1, basis: 'measured' };
  const b: Side = { m: model('b', 'Safe & sound', 2), r: result, cost: 2, basis: 'measured' };
  const html = verdictHtml(a, b, 100);
  assert.doesNotMatch(html, /<img\b/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /Safe &amp; sound/);
});

test('calculator callout HTML escapes model names before reaching innerHTML', () => {
  const row = (id: string, name: string, pass: number, cost: number): Row => ({
    m: { model_id: id, display_name: name },
    r: { pass_rate: pass },
    cost,
    basis: 'measured',
    basisKey: 'measured_by_source',
    attempt: cost,
  });
  const html = calloutHtml([
    row('a', '<svg onload=alert(1)>', 0.5, 1),
    row('b', 'Safe & sound', 0.9, 2),
  ], 100);
  assert.doesNotMatch(html, /<svg\b/i);
  assert.match(html, /&lt;svg onload=alert\(1\)&gt;/);
  assert.match(html, /Safe &amp; sound/);
});

test('DOM-only render paths do not assign untrusted table or tooltip HTML', () => {
  assert.doesNotMatch(read('site/src/pages/index.astro'), /tip\.innerHTML\s*=/);
  assert.doesNotMatch(read('site/src/pages/embed/table.astro'), /getElementById\('e-body'\)[\s\S]{0,80}\.innerHTML\s*=/);
  assert.match(read('site/astro.config.mjs'), /\^\[a-z0-9\._-\]\+\$/i);
});

test('client-writable Clerk metadata is documented as conversion data, never authorization', () => {
  const clerk = read('site/src/lib/clerk-client.ts');
  assert.match(clerk, /Never use unsafeMetadata for authorization/);
  assert.doesNotMatch(clerk, /unsafeMetadata\?\.(?:plan|role|entitlement)/);
});

test('deployment actions are immutable and installs are frozen', () => {
  const workflow = read('.github/workflows/deploy.yml');
  const wrangler = read('site/wrangler.toml');
  const developmentVars = read('site/.dev.vars.example');
  const uses = [...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map((m) => m[1]);
  assert.ok(uses.length >= 3);
  for (const action of uses) assert.match(action, /@[0-9a-f]{40}$/);
  assert.match(workflow, /run: npm ci --no-audit --no-fund/);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}[\s\S]*persist-credentials: false/);
  assert.match(workflow, /run: npm run coverage/);
  assert.match(workflow, /^\s*environment: production$/m);
  assert.match(workflow, /GITHUB_REF" != "refs\/heads\/main"/);
  assert.match(workflow, /GITHUB_SHA" =~ \^\[0-9a-f\]\{40\}\$/);
  assert.match(workflow, /git rev-parse HEAD[\s\S]*GITHUB_SHA/);
  assert.match(workflow, /--branch main/);
  assert.match(workflow, /--commit-hash \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /--commit-dirty=false/);
  assert.match(workflow, /PUBLIC_ACCOUNT_PLANS_ENABLED: 'false'/);
  assert.match(workflow, /PUBLIC_PRODUCT_INTENTS_ENABLED: 'false'/);
  assert.match(workflow, /PUBLIC_DEPLOYMENT_ENV: 'production'/);
  assert.match(workflow, /PUBLIC_STRIPE_SANDBOX_UI_ENABLED: 'false'/);
  assert.match(workflow, /npm run verify:production-artifact-dark/);
  assert.match(workflow, /npm run verify:rollout-state/);
  assert.doesNotMatch(workflow, /vars\.PUBLIC_ACCOUNT_PLANS_ENABLED/);
  assert.doesNotMatch(workflow, /vars\.PUBLIC_PRODUCT_INTENTS_ENABLED/);
  const section = (heading: string) => wrangler.split(`[${heading}]\n`, 2)[1]?.split(/\n(?=\[)/, 1)[0] ?? '';
  const productionVars = section('vars');
  const previewVars = section('env.preview.vars');
  assert.match(productionVars, /^ACCOUNT_PLANS_ENABLED = "true"$/m);
  assert.match(productionVars, /^ENTITLEMENTS_ENABLED = "true"$/m);
  assert.match(productionVars, /^PRODUCT_INTENTS_ENABLED = "true"$/m);
  assert.match(productionVars, /^STRIPE_CHECKOUT_ENABLED = "false"$/m);
  assert.match(productionVars, /^STRIPE_PORTAL_ENABLED = "false"$/m);
  assert.match(productionVars, /^STRIPE_WEBHOOK_ENABLED = "true"$/m);
  assert.match(previewVars, /^ACCOUNT_PLANS_ENABLED = "true"$/m);
  assert.match(previewVars, /^ENTITLEMENTS_ENABLED = "true"$/m);
  assert.match(previewVars, /^PRODUCT_INTENTS_ENABLED = "true"$/m);
  assert.match(previewVars, /^PREVIEW_ACCOUNT_ERASURE_ENABLED = "false"$/m);
  assert.match(previewVars, /^STRIPE_CHECKOUT_ENABLED = "true"$/m);
  assert.match(previewVars, /^STRIPE_PORTAL_ENABLED = "true"$/m);
  assert.match(previewVars, /^STRIPE_WEBHOOK_ENABLED = "true"$/m);
  assert.match(previewVars, /^APP_ENV = "preview"$/m);
  assert.match(previewVars, /^CLERK_AUTHORIZED_PARTIES = "https:\/\/d1-functions-preview\.solvency-ru5\.pages\.dev"$/m);
  assert.match(developmentVars, /^STRIPE_WEBHOOK_ENABLED=false$/m);
  assert.match(developmentVars, /^STRIPE_CHECKOUT_ENABLED=false$/m);
  assert.match(developmentVars, /^STRIPE_PORTAL_ENABLED=false$/m);
  const sourceGuard = workflow.indexOf('Require current main as the production source');
  const checkout = workflow.indexOf('actions/checkout@');
  const verifyCommit = workflow.indexOf('Verify checked-out production commit');
  const publish = workflow.indexOf('Publish to Cloudflare Pages');
  assert.ok(sourceGuard >= 0 && sourceGuard < checkout);
  assert.ok(checkout < verifyCommit && verifyCommit < publish);
});

test('preview deployment is staged, same-commit, credential-isolated and migration-fail-closed', () => {
  const workflow = read('.github/workflows/deploy-preview.yml');
  const uses = [...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map((match) => match[1]);
  assert.ok(uses.length > 0);
  for (const action of uses) assert.match(action, /@[0-9a-f]{40}$/);

  const resolveJob = workflowJob(workflow, 'resolve-rollout');
  const providerJob = workflowJob(workflow, 'stripe-config-preflight');
  const deployJob = workflowJob(workflow, 'deploy-preview');
  const smokeJob = workflowJob(workflow, 'smoke-preview');
  const releaseStep = workflowStep(smokeJob, 'Run non-destructive Preview release attestation');
  const authenticatedStep = workflowStep(smokeJob, 'Run authenticated provider-read-only smoke after billing state exists');
  const destructiveStep = workflowStep(smokeJob, 'Run destructive two-user account smoke while billing is dark');

  assert.match(workflow, /^on:\n\s+workflow_dispatch:$/m);
  assert.doesNotMatch(workflow, /^\s+(?:push|pull_request|schedule):/m);
  assert.match(workflow, /^concurrency:\n\s+group: deploy-preview-\$\{\{ github\.ref \}\}\n\s+cancel-in-progress: false$/m);
  assert.match(workflow, /default: do-not-deploy/);
  assert.match(resolveJob, /PREVIEW_DEPLOY_AUTHORIZATION" != "deploy-reviewed-preview"/);
  assert.match(resolveJob, /GITHUB_REF" != "refs\/heads\/main"/);
  assert.match(resolveJob, /git rev-parse HEAD[\s\S]*GITHUB_SHA/);
  assert.match(resolveJob, /npm run verify:rollout-state -- --github-output "\$GITHUB_OUTPUT"/);
  assert.deepEqual(workflowSecrets(resolveJob), []);

  assert.doesNotMatch(resolveJob, /\b(?:vars|secrets)\./);
  assert.doesNotMatch(resolveJob, /^    environment:/m);
  assert.match(deployJob, /vars\.PREVIEW_CLERK_PUBLISHABLE_KEY/);
  assert.match(deployJob, /PREVIEW_CLERK_PUBLISHABLE_KEY" != pk_test_\*/);
  assert.match(resolveJob, /preview_account_plans_enabled: \$\{\{ steps\.rollout\.outputs\.preview_account_plans_enabled \}\}/);
  assert.match(resolveJob, /preview_product_intents_enabled: \$\{\{ steps\.rollout\.outputs\.preview_product_intents_enabled \}\}/);
  assert.match(resolveJob, /preview_sandbox_ui_enabled: \$\{\{ steps\.rollout\.outputs\.preview_sandbox_ui_enabled \}\}/);
  assert.match(resolveJob, /preview_webhook_access_mode: \$\{\{ steps\.rollout\.outputs\.preview_webhook_access_mode \}\}/);

  assert.match(providerJob, /^\s*needs: resolve-rollout$/m);
  assert.match(providerJob, /^\s*if: needs\.resolve-rollout\.outputs\.preview_stripe_enabled == 'true'$/m);
  assert.match(providerJob, /^\s*environment:\n\s+name: preview\n\s+deployment: false$/m);
  assert.match(providerJob, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(providerJob, /git rev-parse HEAD[\s\S]*GITHUB_SHA/);
  assert.match(providerJob, /npm run smoke:stripe-preview-config/);
  assert.deepEqual(workflowSecrets(providerJob), ['PREVIEW_STRIPE_CONFIG_READ_ONLY_KEY']);

  assert.match(deployJob, /^\s*needs: \[resolve-rollout, stripe-config-preflight\]$/m);
  assert.match(deployJob, /^\s*if: \$\{\{ !cancelled\(\) && needs\.resolve-rollout\.result == 'success' && \(needs\.resolve-rollout\.outputs\.preview_stripe_enabled == 'false' \|\| needs\.stripe-config-preflight\.result == 'success'\) \}\}$/m);
  assert.match(deployJob, /^\s*environment: preview$/m);
  assert.match(deployJob, /PUBLIC_ACCOUNT_PLANS_ENABLED: \$\{\{ needs\.resolve-rollout\.outputs\.preview_account_plans_enabled \}\}/);
  assert.match(deployJob, /PUBLIC_PRODUCT_INTENTS_ENABLED: \$\{\{ needs\.resolve-rollout\.outputs\.preview_product_intents_enabled \}\}/);
  assert.match(deployJob, /PUBLIC_DEPLOYMENT_ENV: 'preview'/);
  assert.match(deployJob, /PUBLIC_STRIPE_SANDBOX_UI_ENABLED: \$\{\{ needs\.resolve-rollout\.outputs\.preview_sandbox_ui_enabled \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.deepEqual(workflowSecrets(deployJob), ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']);

  assert.match(smokeJob, /^\s*needs: \[resolve-rollout, deploy-preview\]$/m);
  assert.match(smokeJob, /^\s*if: \$\{\{ !cancelled\(\) && needs\.resolve-rollout\.result == 'success' && needs\.deploy-preview\.result == 'success' \}\}$/m);
  assert.match(smokeJob, /^\s*environment:\n\s+name: preview\n\s+deployment: false$/m);
  assert.match(smokeJob, /EXPECTED_BUILD_SHA: \$\{\{ github\.sha \}\}/);
  assert.deepEqual(workflowSecrets(smokeJob), [
    'PREVIEW_CF_ACCESS_CLIENT_ID',
    'PREVIEW_CF_ACCESS_CLIENT_SECRET',
    'PREVIEW_CLERK_SMOKE_SECRET_KEY',
  ]);
  assert.doesNotMatch(releaseStep, /^\s*if:/m);
  assert.match(releaseStep, /npm run smoke:preview-release/);
  assert.match(releaseStep, /PREVIEW_WEBHOOK_ACCESS_MODE: \$\{\{ needs\.resolve-rollout\.outputs\.preview_webhook_access_mode \}\}/);
  assert.match(authenticatedStep, /^\s*if: needs\.resolve-rollout\.outputs\.preview_stripe_enabled == 'true'$/m);
  assert.match(authenticatedStep, /npm run smoke:preview-authenticated-provider-readonly/);
  assert.doesNotMatch(authenticatedStep, /ACCOUNT_SMOKE_CONFIRM|DELETE_ISOLATED_PREVIEW_DATA/);
  assert.match(destructiveStep, /^\s*if: needs\.resolve-rollout\.outputs\.preview_destructive_smoke_enabled == 'true'$/m);
  assert.match(destructiveStep, /ACCOUNT_SMOKE_CONFIRM: DELETE_ISOLATED_PREVIEW_DATA/);
  assert.match(destructiveStep, /npm run smoke:account-preview/);

  assert.match(smokeJob, /npx --no-install playwright install --with-deps chromium/);
  assert.match(workflow, /npm ci --no-audit --no-fund/);
  assert.match(deployJob, /npm run coverage/);
  assert.match(deployJob, /npm audit --audit-level=high/);
  assert.match(deployJob, /npm run build:functions/);

  assert.match(deployJob, /d1 migrations list solvency-build-plans-preview --env preview --remote/);
  assert.match(deployJob, /grep -Fq "No migrations to apply"/);
  assert.doesNotMatch(workflow, /d1 migrations apply|pages secret (?:put|bulk|delete)/);
  assert.match(deployJob, /--branch d1-functions-preview/);
  assert.match(deployJob, /--commit-hash \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(deployJob, /--branch main/);

  const authorization = workflow.indexOf('Require reviewed preview authorization');
  const provider = workflow.indexOf('Verify same-commit read-only Stripe sandbox configuration');
  const testSuite = workflow.indexOf('Verify datasets, server boundaries and published figures');
  const migrationGate = workflow.indexOf('Require a fully migrated Preview database');
  const publish = workflow.indexOf('Publish current commit to the isolated Preview branch');
  const smoke = workflow.indexOf('Run non-destructive Preview release attestation');
  assert.ok(authorization >= 0 && authorization < provider && provider < testSuite);
  assert.ok(testSuite < migrationGate && migrationGate < publish);
  assert.ok(publish < smoke);
  assert.match(providerJob, /^\s*permissions:\n\s+contents: read$/m);
  assert.match(smokeJob, /^\s*permissions:\n\s+contents: read$/m);
});

test('D1 quota triggers use the remotely compatible parenthesized CASE form', () => {
  for (const path of [
    'site/migrations/0005_build_plan_operations.sql',
    'site/migrations/0006_product_intent_events.sql',
  ]) {
    const migration = read(path);
    assert.match(migration, /SELECT \(CASE WHEN \(/);
    assert.doesNotMatch(migration, /SELECT CASE WHEN \(/);
  }
});

test('first-party intent measurement is dark by default and explicitly surfaced to the client', () => {
  const layout = read('site/src/layouts/Base.astro');
  const example = read('site/.dev.vars.example');
  assert.match(layout, /PUBLIC_PRODUCT_INTENTS_ENABLED === 'true'/);
  assert.match(layout, /data-product-intents-enabled=\{PRODUCT_INTENTS_ENABLED \? 'true' : 'false'\}/);
  assert.match(example, /^PRODUCT_INTENTS_ENABLED=false$/m);
});

test('paid-workflow previews never fabricate private links, monitoring or unsafe export markup', () => {
  const page = read('site/src/pages/build-planner.astro');
  const exports = read('site/src/lib/build-export.ts');
  const limits = read('site/src/lib/build-plan-limits.ts');
  const operations = read('site/src/lib/build-operations.ts');
  const operationsClient = read('site/src/lib/build-operations-client.ts');
  const ignores = read('.gitignore');
  assert.doesNotMatch(page, /Notification\.requestPermission|insertAdjacentHTML|innerHTML/);
  assert.doesNotMatch(exports, /foreignObject|<script|fetch\(|https?:\/\//);
  assert.doesNotMatch(operations, /fetch\(|unsafeMetadata|(?:recipient|email|shareUrl|href)\s*[:=]/);
  assert.match(page, /copyAccountShareUrl\(revealed\.url, location\.origin, writer\)/);
  assert.match(operationsClient, /url\.origin === base\.origin/);
  assert.match(operationsClient, /parsed !== url/);
  assert.match(page, /clearRevealedAccountShare\(\)/);
  assert.match(page, /setTimeout\(clearRevealedAccountShare, 60_000\)/);
  assert.doesNotMatch(page, /track\([^\n]+(?:token|revealedAccountShare|shareUrl|\.url)/);
  assert.match(page, /No link was created or copied/);
  assert.match(page, /Monitoring and email are off/);
  assert.match(exports, /spreadsheetSafeText/);
  assert.match(exports, /MAX_BUILD_EXPORT_ROLES\s*=\s*BUILD_PLAN_LIMITS\.maxRoles/);
  assert.match(limits, /maxRoles:\s*24/);
  assert.match(ignores, /\.dev\.vars/);
  assert.match(ignores, /\.env\.\*/);
});

test('planner analytics disclosure and payloads exclude raw build inputs', () => {
  const page = read('site/src/pages/build-planner.astro');
  const privacy = read('site/src/pages/privacy.astro');
  assert.match(privacy, /cookieless product analytics/);
  assert.match(privacy, /do not include plan or harness names, model selections, token counts, entered prices or thresholds/);
  assert.match(privacy, /coarse Build Composer interaction events/);
  assert.doesNotMatch(page, /track\([^\n]+(?:plan\.name|harness\.name|modelId|threshold)/);
  assert.match(page, /build_quote_first_edit_valid/);
  assert.doesNotMatch(page, /price_hypothesis/);
  assert.doesNotMatch(page, /track\('build_pro_price_interest'/);
  assert.match(page, /await recordProductIntentSignal\('pro_price_interest'\)/);
  assert.match(privacy, /Cloudflare D1 under your verified Clerk account ID/);
  assert.match(privacy, /Custom and contract rates may be commercially sensitive/);
  assert.match(privacy, /session storage/);
  assert.match(privacy, /expires after 30 minutes/);
  assert.match(privacy, /cascades to all of its active versions, quote snapshots, unlisted-link records, inactive alert settings and operation-replay records/);
  assert.match(privacy, /provider backups/);
});

test('every planner mutation and export crosses the shared untrusted-plan gate', () => {
  const page = read('site/src/pages/build-planner.astro');
  const schema = read('site/src/lib/build-plan-schema.ts');
  assert.match(page, /const eligibleModels = models\.filter\(\(model\) => model\.status === 'current'\)/);
  assert.match(page, /const validated = validateUntrustedBuildPlanV1\(draft, eligibleModels\)/);
  assert.match(page, /validateUntrustedBuildPlanV1\(readPlan\(\), eligibleModels\)/);
  assert.match(page, /if \(!lastDraftValid \|\| !lastQuote\.valid\) return/g);
  assert.match(schema, /HTTP[\s\S]{0,30}handlers must enter through parseBuildPlanJson\/validateBuildPlanJson/);
  assert.match(schema, /export function validateBuildPlanJson\(/);
  assert.match(schema, /origin === 'source_verified' \|\| origin === 'solvency_template'/);
  assert.match(schema, /const eligibleCatalog = catalog\.filter\(\(model\) => model\.status === 'current'\)/);
  assert.match(schema, /quoteBuildPlan\(parsed\.value, eligibleCatalog, quotedAt\)/);
  assert.doesNotMatch(page, /assertionOrigin:\s*'(?:source_verified|solvency_template)'/);
});
