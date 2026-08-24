import test from 'node:test';
import assert from 'node:assert/strict';
import {
  StableAccountOperationKeys,
  accountShareUrl,
  copyAccountShareUrl,
  inactiveAccountAlertSummary,
  parseAccountAlertList,
  parseAccountShareList,
  parseCreatedAccountShare,
  parseDeletedAccountAlert,
  parseMutatedAccountAlert,
  parseRevokedAccountShare,
} from '../site/src/lib/build-operations-client.ts';

const PLAN = 'plan_00000000-0000-4000-8000-000000000001';
const SHARE = 'share_00000000-0000-4000-8000-000000000001';
const ALERT = 'alert_00000000-0000-4000-8000-000000000001';
const TOKEN = `sv1_${'a'.repeat(43)}`;
const CREATED = '2026-08-23T12:00:00.000Z';

const share = () => ({
  id: SHARE, planId: PLAN, version: 1, allowQuoteExport: true,
  expiresAt: '2026-08-30T12:00:00.000Z', status: 'active', createdAt: CREATED,
});
const alert = () => ({
  id: ALERT, planId: PLAN, version: 2, trigger: 'baseline_delta_percent',
  threshold: 10, baselineVersion: 1, status: 'inactive',
  createdAt: CREATED, updatedAt: CREATED,
});

test('strictly parses token-free share lists and one-time create locators', () => {
  assert.deepEqual(parseAccountShareList({ data: [share()] }), [share()]);
  assert.equal(parseAccountShareList({ data: [{ ...share(), token: TOKEN }] }), null);
  assert.equal(parseAccountShareList({ data: [{ ...share(), status: 'revoked' }] }), null);
  assert.equal(parseAccountShareList({ data: [share()], extra: true }), null);

  const created = { ...share(), token: TOKEN, path: `/shared-build-plans/${TOKEN}` };
  assert.deepEqual(parseCreatedAccountShare({ data: created }), created);
  assert.equal(parseCreatedAccountShare({ data: { ...created, path: 'https://evil.example/x' } }), null);
  assert.equal(parseCreatedAccountShare({ data: { ...created, ownerUserId: 'user_private' } }), null);
  assert.equal(parseRevokedAccountShare({ data: { revoked: true, shareId: SHARE } }, SHARE), true);
  assert.equal(parseRevokedAccountShare({ data: { revoked: true, shareId: SHARE, token: TOKEN } }, SHARE), false);
});

test('accepts only internally consistent inactive alert records', () => {
  assert.deepEqual(parseAccountAlertList({ data: [alert()] }), [alert()]);
  assert.deepEqual(parseMutatedAccountAlert({ data: alert() }), alert());
  assert.equal(parseMutatedAccountAlert({ data: { ...alert(), status: 'active' } }), null);
  assert.equal(parseMutatedAccountAlert({ data: { ...alert(), baselineVersion: 2 } }), null);
  assert.equal(parseMutatedAccountAlert({ data: { ...alert(), threshold: Number.NaN } }), null);
  assert.equal(parseDeletedAccountAlert({ data: { deleted: true, alertId: ALERT } }, ALERT), true);
  assert.equal(parseDeletedAccountAlert({ data: { deleted: true, alertId: ALERT, delivered: true } }, ALERT), false);
  assert.match(inactiveAccountAlertSummary(alert() as never), /baseline version 1/);
});

test('response parsers fail closed for hostile object shapes', () => {
  const throwing = new Proxy({}, { ownKeys() { throw new Error('hostile'); } });
  assert.equal(parseAccountShareList(throwing), null);
  assert.equal(parseCreatedAccountShare({ data: throwing }), null);
  assert.equal(parseAccountAlertList({ data: [throwing] }), null);
  assert.equal(parseMutatedAccountAlert({ data: throwing }), null);
});

test('idempotency keys survive ambiguous retries until a validated success', () => {
  let index = 0;
  const keys = new StableAccountOperationKeys(() => `composer-operation:key-${String(++index).padStart(4, '0')}`);
  const first = keys.key('share:create:plan', '{"version":1}');
  assert.equal(keys.key('share:create:plan', '{"version":1}'), first);
  const changed = keys.key('share:create:plan', '{"version":2}');
  assert.notEqual(changed, first);
  keys.complete('share:create:plan', '{"version":1}');
  assert.equal(keys.key('share:create:plan', '{"version":2}'), changed);
  keys.complete('share:create:plan', '{"version":2}');
  assert.notEqual(keys.key('share:create:plan', '{"version":2}'), changed);
  keys.clear();
});

test('bearer URLs are same-origin and copied only through an explicit validated writer', async () => {
  const path = `/shared-build-plans/${TOKEN}`;
  const url = `https://solvency.dev${path}`;
  assert.equal(accountShareUrl(path, 'https://solvency.dev'), url);
  assert.equal(accountShareUrl(`//evil.example/${TOKEN}`, 'https://solvency.dev'), null);
  const copied: string[] = [];
  assert.equal(await copyAccountShareUrl(url, 'https://solvency.dev', async (value) => { copied.push(value); }), true);
  assert.deepEqual(copied, [url]);
  assert.equal(await copyAccountShareUrl(`https://evil.example${path}`, 'https://solvency.dev', async () => {}), false);
  assert.equal(await copyAccountShareUrl('not a URL', 'https://solvency.dev', async () => {}), false);
});
