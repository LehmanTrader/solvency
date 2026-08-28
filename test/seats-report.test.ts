/**
 * Seats pipeline: the Claude Code importer (tools/seats-report/
 * import-claude-code.mjs) and the browser-side repricing lib
 * (site/src/lib/seats.ts) are pinned to the same hand-computed figures so
 * the CLI and the dashboard cannot drift apart. Fixtures are synthetic.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore -- plain-JS CLI module, no declaration file
import { parseTranscript, aggregate, toCsv } from '../tools/seats-report/import-claude-code.mjs';
import { parseUsageCsv, buildSeatReports, verdictFor, findModel, priceUsage } from '../site/src/lib/seats.ts';

const MODELS = [
  { model_id: 'alpha-1', display_name: 'Alpha 1', input_per_mtok: 3, output_per_mtok: 15, cached_input_per_mtok: 0.3 },
  { model_id: 'beta-2', display_name: 'Beta 2', input_per_mtok: 1, output_per_mtok: 5, cached_input_per_mtok: null },
];

const entry = (id: string, model: string, ts: string, u: Partial<Record<string, number>>) => JSON.stringify({
  type: 'assistant', timestamp: ts,
  message: { id, model, usage: { input_tokens: u.i ?? 0, output_tokens: u.o ?? 0, cache_read_input_tokens: u.cr ?? 0, cache_creation_input_tokens: u.cw ?? 0 } },
});

describe('claude-code importer', () => {
  test('dedups repeated message ids across transcripts (resumed sessions)', () => {
    const t1 = [entry('m1', 'alpha-1', '2026-08-10T02:00:00Z', { i: 100, o: 50 })].join('\n');
    const t2 = [
      entry('m1', 'alpha-1', '2026-08-10T02:00:00Z', { i: 100, o: 50 }), // copied history
      entry('m2', 'alpha-1', '2026-08-11T02:00:00Z', { i: 10, o: 20, cr: 1000, cw: 200 }),
    ].join('\n');
    const entries = new Map();
    const counters = { noId: 0 };
    parseTranscript(t1, entries, counters);
    parseTranscript(t2, entries, counters);
    assert.equal(entries.size, 2);
    const rows = aggregate('roy', entries);
    assert.equal(rows.reduce((a: number, r: any) => a + r.input, 0), 110);
    assert.equal(rows.reduce((a: number, r: any) => a + r.calls, 0), 2);
  });

  test('excludes usage entries without message.id and counts them (fail closed)', () => {
    const noId = JSON.stringify({ type: 'assistant', timestamp: '2026-08-10T00:00:00Z', message: { model: 'alpha-1', usage: { input_tokens: 999 } } });
    const entries = new Map();
    const counters = { noId: 0 };
    parseTranscript([noId, entry('m1', 'alpha-1', '2026-08-10T00:00:00Z', { i: 1 })].join('\n'), entries, counters);
    assert.equal(entries.size, 1);
    assert.equal(counters.noId, 1);
  });

  test('date window filters and CSV round-trips through the lib parser', () => {
    const entries = new Map();
    parseTranscript([
      entry('a', 'alpha-1', '2026-07-31T23:00:00Z', { i: 5 }),
      entry('b', 'alpha-1', '2026-08-02T00:00:00Z', { i: 7, o: 3 }),
    ].join('\n'), entries, { noId: 0 });
    const rows = aggregate('roy', entries, '2026-08-01', '2026-08-31');
    assert.equal(rows.length, 1);
    const parsed = parseUsageCsv(toCsv(rows));
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.rows.length, 1);
    assert.deepEqual(
      { seat: parsed.rows[0].seat, input: parsed.rows[0].input, output: parsed.rows[0].output },
      { seat: 'roy', input: 7, output: 3 });
  });
});

describe('seats lib', () => {
  test('reprices at metered rates: cache reads cached, cache writes uncached', () => {
    // 1M fresh in at $3 + 2M cache-read at $0.30 + 0.5M cache-write at $3 + 0.1M out at $15
    const usd = priceUsage({ input: 1e6, cacheRead: 2e6, cacheWrite: 0.5e6, output: 0.1e6 }, MODELS[0]);
    assert.equal(Number(usd.toFixed(2)), 3 + 0.6 + 1.5 + 1.5);
  });

  test('missing cached rate falls back to the uncached input rate', () => {
    assert.equal(priceUsage({ input: 0, cacheRead: 1e6, cacheWrite: 0, output: 0 }, MODELS[1]), 1);
  });

  test('unknown models are excluded and listed, never priced', () => {
    const csv = 'seat,model,input_tokens,output_tokens\nroy,mystery-9,1000000,1000000\nroy,alpha-1,1000000,0\n';
    const { rows } = parseUsageCsv(csv);
    const { seats, unknown } = buildSeatReports(rows, MODELS);
    assert.equal(seats[0].usd, 3); // only alpha-1 priced
    assert.equal(seats[0].unknownCalls, 1);
    assert.deepEqual(unknown, [{ model: 'mystery-9', calls: 1 }]);
  });

  test('verdict thresholds match the CLI bands', () => {
    const seat = (usd: number, unknownCalls = 0) => ({ seat: 's', calls: 10, usd, input: 0, output: 0, cacheRead: 0, unknownCalls, byModel: [] });
    assert.equal(verdictFor(seat(300), 200).cls, 'ok');       // 1.5x keep
    assert.equal(verdictFor(seat(160), 200).cls, 'ok');       // 0.8x near break-even
    assert.equal(verdictFor(seat(50), 200).cls, 'warn');      // 0.25x review
    assert.equal(verdictFor(seat(10), 200).cls, 'over');      // <0.2x move to metered
    assert.equal(verdictFor(seat(1000, 3), 200).verdict, 'incomplete — unknown models');
  });

  test('model matching tolerates provider prefixes and fuzzy tails', () => {
    assert.equal(findModel(MODELS, 'acme/alpha-1')?.model_id, 'alpha-1');
    assert.equal(findModel(MODELS, 'Alpha 1')?.model_id, 'alpha-1');
    assert.equal(findModel(MODELS, 'nope-x'), null);
  });
});
