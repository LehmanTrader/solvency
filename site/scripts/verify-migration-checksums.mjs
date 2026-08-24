import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = join(here, '..', 'migrations');
const manifestPath = join(migrationsDirectory, 'checksums.json');
const SQL_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;
const SHA256 = /^[0-9a-f]{64}$/;

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === expected.length
    && actual.every((key) => typeof key === 'string' && expected.includes(key));
}

function fail(message) {
  throw new Error(`Migration checksum verification failed: ${message}`);
}

let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
} catch {
  fail('checksums.json is missing or invalid JSON.');
}

if (!exactKeys(manifest, ['version', 'algorithm', 'migrations'])
  || manifest.version !== 1
  || manifest.algorithm !== 'sha256'
  || !Array.isArray(manifest.migrations)
  || manifest.migrations.length === 0) {
  fail('checksums.json does not match the version 1 manifest schema.');
}

const names = [];
const expectedHashes = new Map();
for (const entry of manifest.migrations) {
  if (!exactKeys(entry, ['name', 'sha256'])
    || typeof entry.name !== 'string'
    || !SQL_NAME.test(entry.name)
    || typeof entry.sha256 !== 'string'
    || !SHA256.test(entry.sha256)
    || expectedHashes.has(entry.name)) {
    fail('checksums.json contains an invalid or duplicate migration entry.');
  }
  names.push(entry.name);
  expectedHashes.set(entry.name, entry.sha256);
}

const sortedNames = [...names].sort();
if (names.some((name, index) => name !== sortedNames[index])) {
  fail('migration entries must be sorted by filename.');
}

const sqlFiles = (await readdir(migrationsDirectory))
  .filter((name) => name.endsWith('.sql'))
  .sort();
if (sqlFiles.length !== names.length
  || sqlFiles.some((name, index) => name !== names[index])) {
  fail('every SQL migration must have exactly one manifest entry, with no stale entries.');
}

for (const name of names) {
  const bytes = await readFile(join(migrationsDirectory, name));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expectedHashes.get(name)) {
    fail(`${name} differs from its committed immutable checksum.`);
  }
}

console.log(`Verified ${names.length} immutable migration checksums.`);
