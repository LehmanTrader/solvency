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

test('build planner accepts a free-form harness and exposes the paid workflow before billing', () => {
  const page = read('site/src/pages/build-planner.astro');
  assert.match(page, /id="b-harness"[^>]*list="harness-examples"/);
  assert.doesNotMatch(page, /<select[^>]+id="b-harness"/);
  assert.match(page, /Type any public, internal or custom harness/);
  assert.match(page, /Add model role/);
  assert.match(page, /custom or contracted token prices/);
  assert.match(page, /Billing and entitlement are intentionally\s+not connected yet/);
  assert.match(page, /Save version/);
  assert.match(page, /Duplicate plan/);
  assert.match(page, /Preview storage is limited to this open tab/);
  assert.match(page, /Sensitivity and break-even/);
  assert.match(page, /Hypothetical one-variable sensitivity/);
  assert.match(page, /common attempted-build volume/);
  assert.match(page, /analyzeBuildSensitivity/);
  assert.match(page, /breakEvenBuildPlans/);
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
