import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST_ROOT = join(SITE_ROOT, 'dist');
const FORBIDDEN = [
  'stripe-sandbox-console',
  'Stripe test-mode billing harness',
  '/api/checkout',
  '/api/billing-portal',
  '/api/billing-readiness',
  'd1-functions-preview.solvency-ru5.pages.dev',
];

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Production artifact contains a symbolic link: ${relative(DIST_ROOT, path)}`);
    }
    if (entry.isDirectory()) files.push(...await filesBelow(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

const files = await filesBelow(DIST_ROOT);
if (files.length === 0) throw new Error('Production artifact is empty.');
const findings = [];
for (const path of files) {
  const content = await readFile(path);
  for (const marker of FORBIDDEN) {
    if (content.includes(Buffer.from(marker))) {
      findings.push(`${relative(DIST_ROOT, path)} contains ${JSON.stringify(marker)}`);
    }
  }
}
if (findings.length > 0) {
  throw new Error(`Production artifact contains Preview billing material:\n${findings.join('\n')}`);
}
console.log(`Production artifact is Stripe-sandbox dark across ${files.length} files.`);
