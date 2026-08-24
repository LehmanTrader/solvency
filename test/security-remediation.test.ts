import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verdictHtml, type Side } from '../site/src/lib/compare.ts';
import { calloutHtml, type Row } from '../site/src/lib/calc.ts';

const ROOT = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

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
  assert.doesNotMatch(workflow, /vars\.PUBLIC_ACCOUNT_PLANS_ENABLED/);
  assert.doesNotMatch(workflow, /vars\.PUBLIC_PRODUCT_INTENTS_ENABLED/);
  const section = (heading: string) => wrangler.split(`[${heading}]\n`, 2)[1]?.split(/\n(?=\[)/, 1)[0] ?? '';
  const productionVars = section('vars');
  const previewVars = section('env.preview.vars');
  assert.match(productionVars, /^ACCOUNT_PLANS_ENABLED = "false"$/m);
  assert.match(productionVars, /^ENTITLEMENTS_ENABLED = "false"$/m);
  assert.match(productionVars, /^PRODUCT_INTENTS_ENABLED = "false"$/m);
  assert.match(productionVars, /^STRIPE_WEBHOOK_ENABLED = "false"$/m);
  assert.match(previewVars, /^ACCOUNT_PLANS_ENABLED = "false"$/m);
  assert.match(previewVars, /^ENTITLEMENTS_ENABLED = "false"$/m);
  assert.match(previewVars, /^PRODUCT_INTENTS_ENABLED = "false"$/m);
  assert.match(previewVars, /^STRIPE_WEBHOOK_ENABLED = "false"$/m);
  assert.match(developmentVars, /^STRIPE_WEBHOOK_ENABLED=false$/m);
  const sourceGuard = workflow.indexOf('Require current main as the production source');
  const checkout = workflow.indexOf('actions/checkout@');
  const verifyCommit = workflow.indexOf('Verify checked-out production commit');
  const publish = workflow.indexOf('Publish to Cloudflare Pages');
  assert.ok(sourceGuard >= 0 && sourceGuard < checkout);
  assert.ok(checkout < verifyCommit && verifyCommit < publish);
});

test('preview deployment is manual, reviewed, isolated and migration-fail-closed', () => {
  const workflow = read('.github/workflows/deploy-preview.yml');
  const uses = [...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map((match) => match[1]);
  assert.equal(uses.length, 3);
  for (const action of uses) assert.match(action, /@[0-9a-f]{40}$/);

  assert.match(workflow, /^on:\n\s+workflow_dispatch:$/m);
  assert.doesNotMatch(workflow, /^\s+(?:push|pull_request|schedule):/m);
  assert.match(workflow, /^\s*environment: preview$/m);
  assert.match(workflow, /default: do-not-deploy/);
  assert.match(workflow, /PREVIEW_DEPLOY_AUTHORIZATION" != "deploy-reviewed-preview"/);
  assert.match(workflow, /GITHUB_REF" != "refs\/heads\/main"/);
  assert.match(workflow, /git rev-parse HEAD[\s\S]*GITHUB_SHA/);

  assert.match(workflow, /vars\.PREVIEW_CLERK_PUBLISHABLE_KEY/);
  assert.match(workflow, /PREVIEW_CLERK_PUBLISHABLE_KEY" != pk_test_\*/);
  assert.match(workflow, /PUBLIC_ACCOUNT_PLANS_ENABLED: 'true'/);
  assert.match(workflow, /PUBLIC_PRODUCT_INTENTS_ENABLED: 'true'/);
  assert.match(workflow, /npm ci --no-audit --no-fund/);
  assert.match(workflow, /npm run coverage/);
  assert.match(workflow, /npm audit --audit-level=high/);
  assert.match(workflow, /npm run build:functions/);
  assert.match(workflow, /Keep STRIPE_WEBHOOK_ENABLED false until a signed, size-bounded POST-only/);
  assert.doesNotMatch(workflow, /STRIPE_WEBHOOK_ENABLED\s*[:=]\s*['"]?true/);

  assert.match(workflow, /d1 migrations list solvency-build-plans-preview --env preview --remote/);
  assert.match(workflow, /grep -Fq "No migrations to apply"/);
  assert.doesNotMatch(workflow, /d1 migrations apply|pages secret (?:put|bulk|delete)/);
  assert.match(workflow, /--branch d1-functions-preview/);
  assert.match(workflow, /--commit-hash \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(workflow, /--branch main/);

  const authorization = workflow.indexOf('Require reviewed preview authorization');
  const testSuite = workflow.indexOf('Verify datasets, server boundaries and published figures');
  const migrationGate = workflow.indexOf('Require a fully migrated Preview database');
  const publish = workflow.indexOf('Publish current commit to the isolated Preview branch');
  assert.ok(authorization >= 0 && authorization < testSuite);
  assert.ok(testSuite < migrationGate && migrationGate < publish);
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
  assert.match(page, /price_hypothesis: '19_monthly'/);
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
