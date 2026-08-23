import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rankedBars, type ChartRow } from '../site/src/lib/charts.ts';

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
});

test('mobile navigation reveals the current item and keeps direct sign-in', () => {
  const base = read('site/src/layouts/Base.astro');
  assert.match(base, /querySelector\('\[aria-current="page"\]'\)/);
  assert.match(base, /scrollLeft\s*=/);
  assert.doesNotMatch(base, /id="auth-signin"[^>]*\bhidden\b/);
});

test('mobile auth does not render the fixed context strip', () => {
  const client = read('site/src/lib/clerk-client.ts');
  assert.match(client, /max-width:\s*639px/);
});

test('pre-launch export copy says that Pro is not yet available', () => {
  const page = read('site/src/pages/compare/[pair].astro');
  assert.match(page, /Export table/);
  assert.match(page, /Pro soon/);
  assert.doesNotMatch(page, />Download table /);
});

test('compact chart compare links include their visible “vs” label in the accessible name', () => {
  const row: ChartRow = {
    id: 'a', name: 'Model A', href: '/models/a', compare: '/compare/a-vs-b',
    cost: 1, pass: 0.5, basis: 'measured',
  };
  const html = rankedBars([row], { width: 350, volume: 100, basis: 'measured', compact: true });
  assert.match(html, /aria-label="Compare vs Model A head to head"/);
});
