import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = join(SITE_ROOT, '..');
const PREVIEW_ORIGIN = 'https://d1-functions-preview.solvency-ru5.pages.dev';
const FLAG_NAMES = [
  'ACCOUNT_PLANS_ENABLED',
  'ENTITLEMENTS_ENABLED',
  'PRODUCT_INTENTS_ENABLED',
  'PREVIEW_ACCOUNT_ERASURE_ENABLED',
  'STRIPE_WEBHOOK_ENABLED',
  'STRIPE_PORTAL_ENABLED',
  'STRIPE_CHECKOUT_ENABLED',
];

function fail(message) {
  throw new Error(`Rollout-state verification failed: ${message}`);
}

function parseToml(source) {
  const sections = new Map();
  let current = '';
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (!line) continue;
    const heading = line.match(/^\[([^\]]+)\]$/);
    if (heading) {
      current = heading[1];
      if (!sections.has(current)) sections.set(current, new Map());
      continue;
    }
    const assignment = line.match(/^([A-Z][A-Z0-9_]*)\s*=\s*"([^"]*)"$/);
    if (assignment && sections.has(current)) sections.get(current).set(assignment[1], assignment[2]);
  }
  return sections;
}

function requiredValue(section, name, sectionName) {
  const value = section?.get(name);
  if (value === undefined) fail(`${sectionName}.${name} is missing or is not an exact quoted string.`);
  return value;
}

function booleanValue(section, name, sectionName) {
  const value = requiredValue(section, name, sectionName);
  if (value !== 'true' && value !== 'false') fail(`${sectionName}.${name} must be exactly "true" or "false".`);
  return value === 'true';
}

function uniqueWorkflowLiteral(source, name, workflowName) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...source.matchAll(new RegExp(`^\\s+${escaped}: '([^']+)'$`, 'gm'))];
  if (matches.length !== 1) fail(`${workflowName} must contain exactly one literal ${name} build value.`);
  return matches[0][1];
}

function exactObject(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Reflect.ownKeys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function parsePreviewManifest(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    fail('preview-rollout.json must be valid JSON.');
  }
  if (!exactObject(value, ['version', 'stripeSandboxUiEnabled', 'webhookAccessMode'])
    || value.version !== 1 || typeof value.stripeSandboxUiEnabled !== 'boolean'
    || !['protected', 'exact-path-bypass'].includes(value.webhookAccessMode)) {
    fail('preview-rollout.json must contain only the supported version, UI flag and webhook Access mode.');
  }
  return value;
}

function parseWorkflowJobs(source, workflowName) {
  const lines = source.split(/\r?\n/);
  const jobsIndex = lines.findIndex((line) => line === 'jobs:');
  if (jobsIndex === -1) fail(`${workflowName} must contain one top-level jobs mapping.`);
  const jobs = new Map();
  let current = null;
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    const match = lines[index].match(/^  ([a-z][a-z0-9-]*):$/);
    if (match) {
      if (current) jobs.set(current.name, lines.slice(current.start, index).join('\n'));
      if (jobs.has(match[1])) fail(`${workflowName} contains a duplicate ${match[1]} job.`);
      current = { name: match[1], start: index };
    }
  }
  if (current) jobs.set(current.name, lines.slice(current.start).join('\n'));
  return jobs;
}

function namedSteps(job, jobName) {
  const lines = job.split(/\r?\n/);
  const steps = new Map();
  let current = null;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^      - name: (.+)$/);
    const anyStep = /^      - (?:name:|uses:)/.test(lines[index]);
    if (anyStep && current) {
      steps.set(current.name, lines.slice(current.start, index).join('\n'));
      current = null;
    }
    if (match) {
      if (steps.has(match[1])) fail(`${jobName} contains a duplicate ${match[1]} step.`);
      current = { name: match[1], start: index };
    }
  }
  if (current) steps.set(current.name, lines.slice(current.start).join('\n'));
  return steps;
}

function requiredJob(jobs, name, workflowName) {
  const job = jobs.get(name);
  if (!job) fail(`${workflowName} is missing the ${name} job.`);
  return job;
}

function requiredStep(steps, name, jobName) {
  const step = steps.get(name);
  if (!step) fail(`${jobName} is missing the ${name} step.`);
  return step;
}

function stepEnvironment(step, name, stepName) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...step.matchAll(new RegExp(`^          ${escaped}: (.+)$`, 'gm'))];
  if (matches.length !== 1) fail(`${stepName} must define exactly one ${name} environment value.`);
  return matches[0][1];
}

function exactJobCondition(job, expected, jobName) {
  const matches = [...job.matchAll(/^    if: (.+)$/gm)];
  if (matches.length !== 1 || matches[0][1] !== expected) fail(`${jobName} must use the exact reviewed job condition.`);
}

function exactStepCondition(step, expected, stepName) {
  const matches = [...step.matchAll(/^        if: (.+)$/gm)];
  if (matches.length !== 1 || matches[0][1] !== expected) fail(`${stepName} must use the exact rollout condition.`);
}

function assertFalse(section, name, sectionName) {
  if (booleanValue(section, name, sectionName)) fail(`${sectionName}.${name} must remain false.`);
}

const [wranglerSource, productionWorkflow, previewWorkflow, manifestSource] = await Promise.all([
  readFile(join(SITE_ROOT, 'wrangler.toml'), 'utf8'),
  readFile(join(REPO_ROOT, '.github/workflows/deploy.yml'), 'utf8'),
  readFile(join(REPO_ROOT, '.github/workflows/deploy-preview.yml'), 'utf8'),
  readFile(join(SITE_ROOT, 'preview-rollout.json'), 'utf8'),
]);

const sections = parseToml(wranglerSource);
const manifest = parsePreviewManifest(manifestSource);
const production = sections.get('vars');
const preview = sections.get('env.preview.vars');
if (!production || !preview) fail('wrangler.toml must define [vars] and [env.preview.vars].');

for (const name of FLAG_NAMES) {
  if (name !== 'PREVIEW_ACCOUNT_ERASURE_ENABLED') assertFalse(production, name, '[vars]');
}
assertFalse(production, 'PREVIEW_ACCOUNT_ERASURE_ENABLED', '[vars]');
if (requiredValue(production, 'APP_ENV', '[vars]') !== 'production') fail('[vars].APP_ENV must be production.');
if (requiredValue(production, 'CLERK_AUTHORIZED_PARTIES', '[vars]') !== 'https://solvency.dev') {
  fail('[vars].CLERK_AUTHORIZED_PARTIES must be the exact Production origin.');
}

const previewState = Object.fromEntries(
  FLAG_NAMES.map((name) => [name, booleanValue(preview, name, '[env.preview.vars]')]),
);
if (requiredValue(preview, 'APP_ENV', '[env.preview.vars]') !== 'preview') {
  fail('[env.preview.vars].APP_ENV must be preview.');
}
if (requiredValue(preview, 'CLERK_AUTHORIZED_PARTIES', '[env.preview.vars]') !== PREVIEW_ORIGIN) {
  fail('[env.preview.vars].CLERK_AUTHORIZED_PARTIES must be the exact protected Preview origin.');
}

const stripeEnabled = previewState.STRIPE_WEBHOOK_ENABLED
  || previewState.STRIPE_PORTAL_ENABLED
  || previewState.STRIPE_CHECKOUT_ENABLED;
if (stripeEnabled) {
  for (const name of [
    'STRIPE_ACCOUNT_ID', 'STRIPE_PORTAL_CONFIGURATION_ID',
    'STRIPE_PRO_MONTHLY_PRICE_ID', 'STRIPE_PRO_ANNUAL_PRICE_ID',
  ]) requiredValue(preview, name, '[env.preview.vars]');
}
if (stripeEnabled && previewState.PREVIEW_ACCOUNT_ERASURE_ENABLED) {
  fail('Preview account erasure must be false before any Stripe surface is enabled.');
}
if (previewState.STRIPE_PORTAL_ENABLED && !previewState.STRIPE_WEBHOOK_ENABLED) {
  fail('Preview billing portal requires the signed webhook path to be enabled first.');
}
if (previewState.STRIPE_CHECKOUT_ENABLED
  && (!previewState.STRIPE_WEBHOOK_ENABLED || !previewState.STRIPE_PORTAL_ENABLED)) {
  fail('Preview Checkout requires both webhook processing and the billing portal.');
}
if (stripeEnabled && (!previewState.ACCOUNT_PLANS_ENABLED
  || !previewState.ENTITLEMENTS_ENABLED || !previewState.PRODUCT_INTENTS_ENABLED)) {
  fail('Every Preview account/entitlement/product-intent gate must be true before Stripe is enabled.');
}
if (previewState.STRIPE_WEBHOOK_ENABLED && manifest.webhookAccessMode !== 'exact-path-bypass') {
  fail('Preview webhook processing requires the exact-path Access bypass to be staged first.');
}

if (uniqueWorkflowLiteral(productionWorkflow, 'PUBLIC_DEPLOYMENT_ENV', 'deploy.yml') !== 'production'
  || uniqueWorkflowLiteral(productionWorkflow, 'PUBLIC_STRIPE_SANDBOX_UI_ENABLED', 'deploy.yml') !== 'false') {
  fail('Production must build with the Preview Stripe console impossible and disabled.');
}
const previewUi = manifest.stripeSandboxUiEnabled;
if (previewUi && !previewState.STRIPE_CHECKOUT_ENABLED) {
  fail('The Preview Stripe console may be enabled only after webhook, portal and Checkout are enabled.');
}

const jobs = parseWorkflowJobs(previewWorkflow, 'deploy-preview.yml');
const resolveJob = requiredJob(jobs, 'resolve-rollout', 'deploy-preview.yml');
const providerJob = requiredJob(jobs, 'stripe-config-preflight', 'deploy-preview.yml');
const deployJob = requiredJob(jobs, 'deploy-preview', 'deploy-preview.yml');
const smokeJob = requiredJob(jobs, 'smoke-preview', 'deploy-preview.yml');
const deploySteps = namedSteps(deployJob, 'deploy-preview');
const smokeSteps = namedSteps(smokeJob, 'smoke-preview');
if (resolveJob.includes('vars.') || resolveJob.includes('secrets.') || resolveJob.includes('environment:')) {
  fail('resolve-rollout must remain independent of environment-scoped configuration and credentials.');
}
const deploymentCredentials = requiredStep(
  deploySteps, 'Verify checked-out commit and deployment credentials', 'deploy-preview',
);
if (!deploymentCredentials.includes('vars.PREVIEW_CLERK_PUBLISHABLE_KEY')
  || !deploymentCredentials.includes('PREVIEW_CLERK_PUBLISHABLE_KEY" != pk_test_*')) {
  fail('deploy-preview must reject a non-test environment-scoped Clerk publishable key.');
}
exactJobCondition(providerJob,
  "needs.resolve-rollout.outputs.preview_stripe_enabled == 'true'", 'stripe-config-preflight');
exactJobCondition(deployJob,
  "${{ !cancelled() && needs.resolve-rollout.result == 'success' && (needs.resolve-rollout.outputs.preview_stripe_enabled == 'false' || needs.stripe-config-preflight.result == 'success') }}",
  'deploy-preview');
const buildStep = requiredStep(deploySteps, 'Build reviewed Preview artifact', 'deploy-preview');
if (stepEnvironment(buildStep, 'PUBLIC_DEPLOYMENT_ENV', 'Build reviewed Preview artifact') !== "'preview'"
  || stepEnvironment(buildStep, 'PUBLIC_ACCOUNT_PLANS_ENABLED', 'Build reviewed Preview artifact')
    !== '${{ needs.resolve-rollout.outputs.preview_account_plans_enabled }}'
  || stepEnvironment(buildStep, 'PUBLIC_PRODUCT_INTENTS_ENABLED', 'Build reviewed Preview artifact')
    !== '${{ needs.resolve-rollout.outputs.preview_product_intents_enabled }}'
  || stepEnvironment(buildStep, 'PUBLIC_STRIPE_SANDBOX_UI_ENABLED', 'Build reviewed Preview artifact')
    !== '${{ needs.resolve-rollout.outputs.preview_sandbox_ui_enabled }}') {
  fail('Preview public flags must come from the exact verified rollout outputs.');
}
const releaseStep = requiredStep(smokeSteps, 'Run non-destructive Preview release attestation', 'smoke-preview');
if (!releaseStep.includes('run: npm run smoke:preview-release')) {
  fail('Preview release attestation must always run.');
}
const destructiveStep = requiredStep(smokeSteps,
  'Run destructive two-user account smoke while billing is dark', 'smoke-preview');
exactStepCondition(destructiveStep,
  "needs.resolve-rollout.outputs.preview_destructive_smoke_enabled == 'true'", destructiveStep.split('\n')[0]);
const authenticatedStep = requiredStep(smokeSteps,
  'Run authenticated provider-read-only smoke after billing state exists', 'smoke-preview');
exactStepCondition(authenticatedStep,
  "needs.resolve-rollout.outputs.preview_stripe_enabled == 'true'", authenticatedStep.split('\n')[0]);

const outputPathIndex = process.argv.indexOf('--github-output');
if (outputPathIndex !== -1) {
  const outputPath = process.argv[outputPathIndex + 1];
  if (!outputPath || process.argv[outputPathIndex + 2]) fail('--github-output accepts exactly one path.');
  await appendFile(outputPath, [
    `preview_stripe_enabled=${stripeEnabled}`,
    `preview_account_plans_enabled=${previewState.ACCOUNT_PLANS_ENABLED}`,
    `preview_product_intents_enabled=${previewState.PRODUCT_INTENTS_ENABLED}`,
    `preview_erasure_enabled=${previewState.PREVIEW_ACCOUNT_ERASURE_ENABLED}`,
    `preview_webhook_enabled=${previewState.STRIPE_WEBHOOK_ENABLED}`,
    `preview_portal_enabled=${previewState.STRIPE_PORTAL_ENABLED}`,
    `preview_checkout_enabled=${previewState.STRIPE_CHECKOUT_ENABLED}`,
    `preview_sandbox_ui_enabled=${previewUi}`,
    `preview_webhook_access_mode=${manifest.webhookAccessMode}`,
    `preview_destructive_smoke_enabled=${!stripeEnabled && previewState.PREVIEW_ACCOUNT_ERASURE_ENABLED}`,
    '',
  ].join('\n'), { encoding: 'utf8', flag: 'a' });
}

console.log(`Rollout state verified: Preview Stripe ${stripeEnabled ? 'staged' : 'dark'}, account erasure ${previewState.PREVIEW_ACCOUNT_ERASURE_ENABLED ? 'enabled' : 'disabled'}, sandbox UI ${previewUi}, webhook Access ${manifest.webhookAccessMode}.`);
