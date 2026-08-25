import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = join(import.meta.dirname, '..');

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'solvency-rollout-'));
  mkdirSync(join(directory, 'site/scripts'), { recursive: true });
  mkdirSync(join(directory, '.github/workflows'), { recursive: true });
  cpSync(join(ROOT, 'site/scripts/verify-rollout-state.mjs'), join(directory, 'site/scripts/verify-rollout-state.mjs'));
  cpSync(join(ROOT, 'site/wrangler.toml'), join(directory, 'site/wrangler.toml'));
  cpSync(join(ROOT, 'site/preview-rollout.json'), join(directory, 'site/preview-rollout.json'));
  cpSync(join(ROOT, '.github/workflows/deploy.yml'), join(directory, '.github/workflows/deploy.yml'));
  cpSync(join(ROOT, '.github/workflows/deploy-preview.yml'), join(directory, '.github/workflows/deploy-preview.yml'));
  return directory;
}

function replace(directory: string, path: string, before: string, after: string) {
  const absolute = join(directory, path);
  const source = readFileSync(absolute, 'utf8');
  assert.ok(source.includes(before), `${path} fixture is missing ${before}`);
  writeFileSync(absolute, source.replace(before, after));
}

function addPreviewStripeIdentifiers(directory: string) {
  const authorizedParty = 'CLERK_AUTHORIZED_PARTIES = "https://d1-functions-preview.solvency-ru5.pages.dev"';
  replace(directory, 'site/wrangler.toml', authorizedParty, [
    authorizedParty,
    'STRIPE_ACCOUNT_ID = "acct_preview_fixture"',
    'STRIPE_PORTAL_CONFIGURATION_ID = "bpc_preview_fixture"',
    'STRIPE_PRO_MONTHLY_PRICE_ID = "price_preview_monthly_fixture"',
    'STRIPE_PRO_ANNUAL_PRICE_ID = "price_preview_annual_fixture"',
  ].join('\n'));
}

function run(directory: string, output = false) {
  const outputPath = join(directory, 'rollout-output.txt');
  const args = ['scripts/verify-rollout-state.mjs'];
  if (output) args.push('--github-output', outputPath);
  const result = spawnSync(process.execPath, args, {
    cwd: join(directory, 'site'), encoding: 'utf8', timeout: 10_000,
  });
  return { ...result, outputPath };
}

function withFixture(task: (directory: string) => void) {
  const directory = fixture();
  try {
    task(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('current rollout state passes and exposes only non-secret workflow outputs', () => withFixture((directory) => {
  const result = run(directory, true);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Preview Stripe staged, account erasure disabled, sandbox UI false/);
  assert.equal(readFileSync(result.outputPath, 'utf8'), [
    'preview_stripe_enabled=true',
    'preview_account_plans_enabled=true',
    'preview_product_intents_enabled=true',
    'preview_erasure_enabled=false',
    'preview_webhook_enabled=true',
    'preview_portal_enabled=false',
    'preview_checkout_enabled=false',
    'preview_sandbox_ui_enabled=false',
    'preview_webhook_access_mode=exact-path-bypass',
    'preview_destructive_smoke_enabled=false',
    '',
  ].join('\n'));
}));

test('rollout verifier rejects production billing and unsafe Preview stage order', () => {
  const cases: Array<[string, (directory: string) => void, RegExp]> = [
    ['production Stripe', (directory) => replace(directory, 'site/wrangler.toml',
      'STRIPE_WEBHOOK_ENABLED = "false"', 'STRIPE_WEBHOOK_ENABLED = "true"'), /\[vars\]\.STRIPE_WEBHOOK_ENABLED must remain false/],
    ['erasure plus webhook', (directory) => replace(directory, 'site/wrangler.toml',
      'PREVIEW_ACCOUNT_ERASURE_ENABLED = "false"\nSTRIPE_CHECKOUT_ENABLED = "false"\nSTRIPE_PORTAL_ENABLED = "false"\nSTRIPE_WEBHOOK_ENABLED = "true"\nAPP_ENV = "preview"',
      'PREVIEW_ACCOUNT_ERASURE_ENABLED = "true"\nSTRIPE_CHECKOUT_ENABLED = "false"\nSTRIPE_PORTAL_ENABLED = "false"\nSTRIPE_WEBHOOK_ENABLED = "true"\nAPP_ENV = "preview"'),
    /account erasure must be false/],
    ['portal before webhook', (directory) => replace(directory, 'site/wrangler.toml',
      'PREVIEW_ACCOUNT_ERASURE_ENABLED = "false"\nSTRIPE_CHECKOUT_ENABLED = "false"\nSTRIPE_PORTAL_ENABLED = "false"\nSTRIPE_WEBHOOK_ENABLED = "true"\nAPP_ENV = "preview"',
      'PREVIEW_ACCOUNT_ERASURE_ENABLED = "false"\nSTRIPE_CHECKOUT_ENABLED = "false"\nSTRIPE_PORTAL_ENABLED = "true"\nSTRIPE_WEBHOOK_ENABLED = "false"\nAPP_ENV = "preview"'),
    /billing portal requires the signed webhook path/],
    ['Checkout before portal', (directory) => replace(directory, 'site/wrangler.toml',
      'PREVIEW_ACCOUNT_ERASURE_ENABLED = "false"\nSTRIPE_CHECKOUT_ENABLED = "false"\nSTRIPE_PORTAL_ENABLED = "false"\nSTRIPE_WEBHOOK_ENABLED = "true"\nAPP_ENV = "preview"',
      'PREVIEW_ACCOUNT_ERASURE_ENABLED = "false"\nSTRIPE_CHECKOUT_ENABLED = "true"\nSTRIPE_PORTAL_ENABLED = "false"\nSTRIPE_WEBHOOK_ENABLED = "true"\nAPP_ENV = "preview"'),
    /Checkout requires both webhook processing and the billing portal/],
    ['sandbox UI before Checkout', (directory) => replace(directory, 'site/preview-rollout.json',
      '"stripeSandboxUiEnabled": false', '"stripeSandboxUiEnabled": true'),
    /console may be enabled only after webhook, portal and Checkout/],
  ];
  for (const [label, mutate, expected] of cases) withFixture((directory) => {
    mutate(directory);
    addPreviewStripeIdentifiers(directory);
    const result = run(directory);
    assert.notEqual(result.status, 0, label);
    assert.match(result.stderr, expected, label);
  });
});

test('fully ordered Preview Stripe state passes only with erasure off and the test UI explicit', () => withFixture((directory) => {
  replace(directory, 'site/wrangler.toml', 'PREVIEW_ACCOUNT_ERASURE_ENABLED = "false"\nSTRIPE_CHECKOUT_ENABLED = "false"\nSTRIPE_PORTAL_ENABLED = "false"\nSTRIPE_WEBHOOK_ENABLED = "true"\nAPP_ENV = "preview"',
    'PREVIEW_ACCOUNT_ERASURE_ENABLED = "false"\nSTRIPE_CHECKOUT_ENABLED = "true"\nSTRIPE_PORTAL_ENABLED = "true"\nSTRIPE_WEBHOOK_ENABLED = "true"\nAPP_ENV = "preview"');
  replace(directory, 'site/preview-rollout.json',
    '"stripeSandboxUiEnabled": false', '"stripeSandboxUiEnabled": true');
  addPreviewStripeIdentifiers(directory);
  const result = run(directory, true);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(readFileSync(result.outputPath, 'utf8'), /preview_stripe_enabled=true/);
  assert.match(readFileSync(result.outputPath, 'utf8'), /preview_erasure_enabled=false/);
  assert.match(readFileSync(result.outputPath, 'utf8'), /preview_sandbox_ui_enabled=true/);
}));
