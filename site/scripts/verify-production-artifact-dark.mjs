import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST_ROOT = join(SITE_ROOT, 'dist');
// The sandbox console and the Preview origin are forbidden in production
// forever. The customer checkout routes are forbidden only while the
// production checkout build flag is dark; once it is launched they are
// REQUIRED on the pricing page instead.
const CHECKOUT_LAUNCHED = process.env.PUBLIC_STRIPE_CHECKOUT_ENABLED === 'true';
const ALWAYS_FORBIDDEN = [
  'stripe-sandbox-console',
  'Stripe test-mode billing harness',
  'd1-functions-preview.solvency-ru5.pages.dev',
];
const DARK_ONLY_FORBIDDEN = [
  '/api/checkout',
  '/api/billing-portal',
  '/api/billing-readiness',
];
const FORBIDDEN = CHECKOUT_LAUNCHED ? ALWAYS_FORBIDDEN : [...ALWAYS_FORBIDDEN, ...DARK_ONLY_FORBIDDEN];

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
if (CHECKOUT_LAUNCHED) {
  const pricing = await readFile(join(DIST_ROOT, 'pricing', 'index.html'), 'utf8');
  for (const marker of ['/api/checkout', '/api/billing-portal']) {
    if (!pricing.includes(marker)) {
      throw new Error(`Launched production pricing page is missing ${JSON.stringify(marker)}.`);
    }
  }
  console.log(`Production artifact is launched-checkout clean across ${files.length} files.`);
} else {
  console.log(`Production artifact is Stripe-sandbox dark across ${files.length} files.`);
}
