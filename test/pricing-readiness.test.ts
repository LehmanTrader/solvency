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
  assert.match(page, /any named or custom harness/);
  assert.match(page, /Higher plan, version and model-role limits/);
  assert.match(page, /Durable custom-rate and observed-usage profiles/);
  assert.match(page, /Controlled unlisted links and operational exports/);
  assert.match(page, /Model-price and budget monitoring/);
  assert.match(page, /re-planning, review and monitoring—not access to public evidence/);
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
  assert.doesNotMatch(page, /href=["']\/(?:checkout|subscribe|upgrade)/);
  assert.doesNotMatch(page, /btn-accent/);
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
  assert.match(page, /decided and published before any payment action is shown/);
});
