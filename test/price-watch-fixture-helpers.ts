/**
 * Shared fixtures for the price-watch-draft.ts tests. Not itself a test file
 * (doesn't match test/*.test.ts, the npm test glob) -- imported by the three
 * price-watch-draft-*.test.ts files, each of which needs its own process
 * (see their file-level comments for why: SOLVENCY_DATA_DIR and Node's ES
 * module cache for scripts/load.ts).
 */
import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function startFixtureServer(pageText: string): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><body>${pageText}</body></html>`);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/pricing` });
    });
  });
}

export function writeFixtureDataDir(dir: string, sourceUrl: string, wrongInputPrice: number) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'models.json'), JSON.stringify({
    $schema_version: '1.0.0',
    description: 'fixture',
    price_basis: 'fixture',
    models: [
      {
        model_id: 'fixture-model-1',
        provider: 'fixtureco',
        display_name: 'Fixture Model One',
        status: 'current',
        capability_class: 'frontier',
        input_per_mtok: wrongInputPrice,
        output_per_mtok: 40,
        cached_input_per_mtok: null,
        context_window: 100000,
        source_url: sourceUrl,
        last_verified: '2026-08-01',
        pricing_notes: null,
      },
    ],
  }));
  writeFileSync(join(dir, 'benchmarks.json'), JSON.stringify({ $schema_version: '1.0.0', results: [], sources: [] }));
  writeFileSync(join(dir, 'assumptions.json'), JSON.stringify({ $schema_version: '1.0.0', task_tiers: {} }));
  writeFileSync(join(dir, 'changelog.json'), JSON.stringify({ $schema_version: '1.0.0', entries: [] }));
}
