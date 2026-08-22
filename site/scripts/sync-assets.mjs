/** Copies generated figures into the site's public directory before a build. */
import { mkdirSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

const jobs = [
  { from: join(repo, 'reports', 'charts'), to: join(here, '..', 'public', 'charts'), ext: '.svg' },
  { from: join(repo, 'reports', 'png'), to: join(here, '..', 'public', 'og'), ext: '.png' },
];

for (const { from, to, ext } of jobs) {
  if (!existsSync(from)) { console.warn(`skip: ${from} missing`); continue; }
  mkdirSync(to, { recursive: true });
  const files = readdirSync(from).filter((f) => f.endsWith(ext));
  for (const f of files) copyFileSync(join(from, f), join(to, f));
  console.log(`synced ${files.length} ${ext} -> ${to.replace(repo, '.')}`);
}
