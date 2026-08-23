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
  const uses = [...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)].map((m) => m[1]);
  assert.ok(uses.length >= 3);
  for (const action of uses) assert.match(action, /@[0-9a-f]{40}$/);
  assert.match(workflow, /run: npm ci --no-audit --no-fund/);
  assert.match(workflow, /^\s*environment: production$/m);
});
