import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = join(import.meta.dirname, '..');
const SCRIPT_PATH = join(ROOT, 'site/scripts/smoke-account-plans.mjs');
const source = readFileSync(SCRIPT_PATH, 'utf8');

test('authenticated account smoke is locked to an isolated preview and test identities', () => {
  assert.match(source, /const PREVIEW_ORIGIN = 'https:\/\/d1-functions-preview\.solvency-ru5\.pages\.dev';/);
  assert.match(source, /ACCOUNT_SMOKE_CONFIRM/);
  assert.match(source, /DELETE_ISOLATED_PREVIEW_DATA/);
  assert.match(source, /secretKey\.startsWith\('sk_test_'\)/);
  assert.match(source, /publishableKey\.startsWith\('pk_test_'\)/);
  assert.doesNotMatch(source, /https:\/\/solvency\.dev/);

  const originGate = source.indexOf('const baseUrl = previewOrigin();');
  const confirmationGate = source.indexOf("requiredEnvironment('ACCOUNT_SMOKE_CONFIRM')");
  const clientCreation = source.indexOf('createClerkClient({');
  const firstFetch = source.indexOf('await fetch(');
  assert.ok(originGate >= 0 && originGate < confirmationGate);
  assert.ok(confirmationGate < clientCreation && clientCreation < firstFetch);
});

test('authenticated account smoke requires Access service credentials and always cleans up', () => {
  assert.match(source, /requiredEnvironment\('CF_ACCESS_CLIENT_ID'\)/);
  assert.match(source, /requiredEnvironment\('CF_ACCESS_CLIENT_SECRET'\)/);
  assert.match(source, /CF-Access-Client-Id/);
  assert.match(source, /CF-Access-Client-Secret/);
  assert.match(source, /finally \{/);
  assert.match(source, /await deleteAllPlans\(account\)/);
  assert.match(source, /await clerk\.users\.deleteUser\(account\.user\.id\)/);
  assert.doesNotMatch(source, /console\.(?:log|error|warn)\([^\n]*(?:secretKey|publishableKey|clientSecret|token|account\.user)/);
});

test('authenticated account smoke covers the complete pre-billing workflow boundary', () => {
  assert.match(source, /closed-default entitlement/);
  assert.match(source, /create owner A unlisted link/);
  assert.match(source, /cross-account unlisted-link list/);
  assert.match(source, /public unlisted-link HTML/);
  assert.match(source, /public unlisted-link JSON export/);
  assert.match(source, /revoked public unlisted link/);
  assert.match(source, /create owner A inactive alert/);
  assert.match(source, /cross-account inactive-alert list/);
  assert.match(source, /replay owner A inactive-alert delete/);
  assert.match(source, /status !== 'inactive'/);
  assert.match(source, /'token' in listedShares\.body\.data\[0\]/);
});

test('authenticated account smoke fails before network access without explicit configuration', () => {
  const result = spawnSync(process.execPath, [SCRIPT_PATH], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      NODE_NO_WARNINGS: '1',
    },
    timeout: 10_000,
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /PREVIEW_BASE_URL is required/);
});
