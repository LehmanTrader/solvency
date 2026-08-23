import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..', 'dist');
const files = (await readdir(root, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => relative(root, resolve(entry.parentPath, entry.name)).split(sep).join('/'));
const available = new Set(files);
const html = files.filter((file) => file.endsWith('.html'));
const broken = [];

const pagePath = (file) => file === 'index.html' ? '/' : `/${file.replace(/index\.html$/, '')}`;
const targetExists = (pathname) => {
  const clean = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (!clean) return available.has('index.html');
  const withoutTrailingSlash = clean.replace(/\/$/, '');
  return available.has(clean)
    || available.has(`${withoutTrailingSlash}/index.html`)
    || available.has(`${withoutTrailingSlash}.html`);
};

for (const file of html) {
  const source = await readFile(resolve(root, file), 'utf8');
  for (const match of source.matchAll(/\bhref=(?:"([^"]+)"|'([^']+)')/g)) {
    const raw = match[1] ?? match[2];
    if (!raw || raw.startsWith('#') || /^(mailto:|tel:|javascript:)/i.test(raw)) continue;
    const url = new URL(raw.replaceAll('&amp;', '&'), new URL(pagePath(file), 'https://solvency.dev'));
    if (url.origin !== 'https://solvency.dev') continue;
    if (!targetExists(url.pathname)) broken.push(`${pagePath(file)} -> ${url.pathname}`);
  }
}

if (broken.length) {
  console.error(`Broken internal links (${broken.length}):\n${broken.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Internal link audit: ${html.length} HTML pages, 0 broken links.`);
}
