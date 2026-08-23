import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { results } from '../scripts/load.ts';
import { harnessComparable } from '../site/src/lib/compare.ts';
import type { BenchmarkResult } from '../scripts/types.ts';

const aa = results.find((r) => r.model_id === 'claude-opus-5')!;
const row = (patch: Partial<BenchmarkResult> = {}): BenchmarkResult => ({
  ...aa,
  harness: 'Claude Code',
  harness_version: null,
  harness_config: null,
  ...patch,
});

describe('harness comparison', () => {
  test('allows two harness rows only when model and benchmark match', () => {
    assert.equal(harnessComparable(row(), row({ harness: 'Codex' })), true);
    assert.equal(harnessComparable(row(), row()), false, 'the same harness is not a harness delta');
    assert.equal(harnessComparable(row(), row({ model_id: 'claude-fable-5', harness: 'Codex' })), false);
    assert.equal(harnessComparable(row(), row({ benchmark: 'seal-swe-bench-pro', harness: 'Codex' })), false);
  });

  test('refuses unmatched rows and rows without a named harness', () => {
    assert.equal(harnessComparable(row(), row({ model_id: null, harness: 'Codex' })), false);
    assert.equal(harnessComparable(row(), row({ harness: null })), false);
  });

  test('every row explicitly records nullable harness metadata', () => {
    for (const r of results) {
      assert.ok(Object.hasOwn(r, 'harness'), `${r.entry_label}: harness must be explicit`);
      assert.ok(Object.hasOwn(r, 'harness_version'), `${r.entry_label}: harness_version must be explicit`);
      assert.ok(Object.hasOwn(r, 'harness_config'), `${r.entry_label}: harness_config must be explicit`);
      assert.ok(r.harness === null || typeof r.harness === 'string', r.entry_label);
      assert.ok(r.harness_version === null || typeof r.harness_version === 'string', r.entry_label);
      assert.ok(r.harness_config === null || typeof r.harness_config === 'string', r.entry_label);
    }
  });

  test('the current dataset has one isolated model+benchmark group with multiple harnesses', () => {
    const grouped = new Map<string, Set<string>>();
    for (const r of results) {
      if (!r.model_id || !r.harness) continue;
      const key = `${r.model_id}\u0000${r.benchmark}`;
      if (!grouped.has(key)) grouped.set(key, new Set());
      grouped.get(key)!.add(r.harness);
    }
    const comparable = [...grouped.entries()].filter(([, harnesses]) => harnesses.size >= 2);
    assert.equal(comparable.length, 1);
    assert.equal(comparable[0][0], 'gpt-5.6-sol\u0000openbench-gpt56-harness');
    assert.deepEqual([...comparable[0][1]].sort(), ['Claude Code', 'Codex', 'Grok Build', 'Pi']);
  });
});
