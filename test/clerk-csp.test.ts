import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clerkPublishableKeyConfiguration } from '../site/src/lib/clerk-key.ts';
import { renderSecurityHeaders } from '../site/scripts/render-security-headers.ts';

const ROOT = join(import.meta.dirname, '..');
const headers = readFileSync(join(ROOT, 'site/public/_headers'), 'utf8');

function key(environment: 'test' | 'live', host: string): string {
  const encoded = Buffer.from(`${host}$`, 'utf8').toString('base64').replace(/=+$/, '');
  return `pk_${environment}_${encoded}`;
}

test('the production host payload accepts Clerk canonical unpadded encoding', () => {
  const paddedPayload = Buffer.from('clerk.solvency.dev$', 'utf8').toString('base64');
  const unpaddedPayload = paddedPayload.replace(/=+$/, '');
  const expected = {
    environment: 'live',
    frontendHost: 'clerk.solvency.dev',
    frontendOrigin: 'https://clerk.solvency.dev',
  };

  // Regression for the real production encoding shape without embedding the
  // deploy key itself in source or test output.
  assert.equal(unpaddedPayload.length, 26);
  assert.equal(unpaddedPayload.length % 4, 2);
  assert.doesNotMatch(unpaddedPayload, /=/);
  assert.deepEqual(clerkPublishableKeyConfiguration(`pk_live_${unpaddedPayload}`), expected);
  assert.deepEqual(clerkPublishableKeyConfiguration(`pk_live_${paddedPayload}`), expected);

  assert.equal(clerkPublishableKeyConfiguration(`pk_live_${unpaddedPayload}=`), null);
  assert.equal(clerkPublishableKeyConfiguration(`pk_live_${unpaddedPayload.slice(0, -1)}B`), null);
  assert.equal(clerkPublishableKeyConfiguration('pk_live_A'), null);
});

test('Clerk publishable keys admit only the exact production or Development frontend host shape', () => {
  assert.deepEqual(clerkPublishableKeyConfiguration(key('live', 'clerk.solvency.dev')), {
    environment: 'live',
    frontendHost: 'clerk.solvency.dev',
    frontendOrigin: 'https://clerk.solvency.dev',
  });
  assert.deepEqual(clerkPublishableKeyConfiguration(key('test', 'isolated-preview.clerk.accounts.dev')), {
    environment: 'test',
    frontendHost: 'isolated-preview.clerk.accounts.dev',
    frontendOrigin: 'https://isolated-preview.clerk.accounts.dev',
  });

  for (const invalid of [
    key('live', 'other.example.com'),
    key('test', 'clerk.solvency.dev'),
    key('test', 'clerk.accounts.dev'),
    key('test', '*.clerk.accounts.dev'),
    key('test', 'UPPER.clerk.accounts.dev'),
    key('test', 'preview.clerk.accounts.dev:443'),
    `${key('test', 'preview.clerk.accounts.dev')}=`,
    ` ${key('test', 'preview.clerk.accounts.dev')}`,
    'pk_test_not-base64',
  ]) assert.equal(clerkPublishableKeyConfiguration(invalid), null, invalid);
});

test('security headers contain exactly the frontend host encoded by this build and never a Clerk wildcard', () => {
  const previewOrigin = 'https://isolated-preview.clerk.accounts.dev';
  const rendered = renderSecurityHeaders(headers, key('test', 'isolated-preview.clerk.accounts.dev'));
  assert.equal(rendered.split(previewOrigin).length - 1, 2);
  assert.doesNotMatch(rendered, /https:\/\/clerk\.solvency\.dev/);
  assert.doesNotMatch(rendered, /https:\/\/\*\.clerk\.accounts\.dev/);

  const production = renderSecurityHeaders(headers, key('live', 'clerk.solvency.dev'));
  assert.equal(production, headers);
  const disabled = renderSecurityHeaders(headers, undefined);
  assert.doesNotMatch(disabled, /https:\/\/clerk\.solvency\.dev/);
});

test('security-header rendering fails closed for malformed keys and template drift', () => {
  assert.throws(
    () => renderSecurityHeaders(headers, key('live', 'attacker.example.com')),
    /allowed exact frontend host/,
  );
  assert.throws(
    () => renderSecurityHeaders(headers.replace('https://clerk.solvency.dev', ''), key('live', 'clerk.solvency.dev')),
    /exactly two Clerk frontend origin/,
  );
});
