import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { clerkPublishableKeyConfiguration } from '../src/lib/clerk-key.ts';

const TEMPLATE_CLERK_ORIGIN = 'https://clerk.solvency.dev';

export function renderSecurityHeaders(template: string, publishableKey: string | undefined): string {
  const occurrences = template.split(TEMPLATE_CLERK_ORIGIN).length - 1;
  if (occurrences !== 2) {
    throw new Error('Security-header template must contain exactly two Clerk frontend origin sources.');
  }
  const key = publishableKey?.trim() ?? '';
  if (!key) return template.replaceAll(TEMPLATE_CLERK_ORIGIN, '');
  if (key !== publishableKey) throw new Error('Clerk publishable key must not contain surrounding whitespace.');
  const configuration = clerkPublishableKeyConfiguration(key);
  if (!configuration) throw new Error('Clerk publishable key does not encode an allowed exact frontend host.');
  const rendered = template.replaceAll(TEMPLATE_CLERK_ORIGIN, configuration.frontendOrigin);
  if (rendered.includes('https://*.clerk.accounts.dev')) {
    throw new Error('Wildcard Clerk frontend CSP sources are forbidden.');
  }
  return rendered;
}

export function renderBuiltSecurityHeaders(
  siteRoot: string,
  publishableKey = process.env.PUBLIC_CLERK_PUBLISHABLE_KEY,
): void {
  const templatePath = join(siteRoot, 'public', '_headers');
  const outputPath = join(siteRoot, 'dist', '_headers');
  const rendered = renderSecurityHeaders(readFileSync(templatePath, 'utf8'), publishableKey);
  writeFileSync(outputPath, rendered);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  renderBuiltSecurityHeaders(join(dirname(fileURLToPath(import.meta.url)), '..'));
}
