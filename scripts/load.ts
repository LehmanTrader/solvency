/** Loads the repo's JSON datasets and exposes the model <-> benchmark join. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Model, BenchmarkResult, TaskTier, TierName, Provenance } from './types.ts';

/**
 * SOLVENCY_DATA_DIR lets tests point this loader at a fixture data/ directory
 * (e.g. a temp copy of models.json with a deliberately wrong price) instead of
 * the repo's real data/. Unset in normal use -- production and every existing
 * caller resolve the real ../data exactly as before.
 */
const DATA = process.env.SOLVENCY_DATA_DIR
  ? process.env.SOLVENCY_DATA_DIR
  : join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const read = (f: string) => JSON.parse(readFileSync(join(DATA, f), 'utf8'));

export const modelsFile = read('models.json');
export const benchmarksFile = read('benchmarks.json');
export const assumptions = read('assumptions.json');
export const changelogFile = read('changelog.json');
export const changelog: { date: string; kind: string; summary: string; detail: string }[] = changelogFile.entries;

export const models: Model[] = modelsFile.models;
export const results: BenchmarkResult[] = benchmarksFile.results;
export const sources: any[] = benchmarksFile.sources;
export const tiers: Record<TierName, TaskTier> = assumptions.task_tiers;
export const TIER_NAMES: TierName[] = ['light', 'moderate', 'heavy'];

/**
 * Source preference, best first. Ordered by how few Solvency assumptions the
 * row requires, then by freshness:
 *   1. AA  -- publishes an observed per-task cost, so the loop model is bypassed entirely.
 *   2. SEAL -- current models, uniform scaffolding, but pass rate only (cost is modeled).
 *   3. Aider -- pass rate only AND stale (nothing newer than 2025-10-03).
 */
export const SOURCE_PREFERENCE = ['aa-coding-agent-index', 'seal-swe-bench-pro', 'aider-polyglot', 'solvency-bench-a2', 'solvency-bench-v0', 'solvency-bench-a1'];
/** Harness-only sources are isolated from the general model leaderboard. */
export const HARNESS_BENCHMARKS = ['openbench-gpt56-harness'];

export function modelById(id: string): Model | undefined {
  return models.find((m) => m.model_id === id);
}

export function sourceFor(benchmark: string) {
  return sources.find((s) => s.benchmark === benchmark);
}

/**
 * Pick the row Solvency will publish for a model: the most-preferred source
 * that covers it, and within that source the model's best published
 * configuration. The chosen entry_label always travels with the number.
 */
export function bestResultFor(modelId: string): BenchmarkResult | null {
  for (const benchmark of SOURCE_PREFERENCE) {
    const candidates = results.filter((r) => r.model_id === modelId && r.benchmark === benchmark);
    if (candidates.length) return candidates.reduce((a, b) => (b.pass_rate > a.pass_rate ? b : a));
  }
  return null;
}

/** All rows for a model, across every source -- for the per-model pages. */
export function allResultsFor(modelId: string): BenchmarkResult[] {
  return results.filter((r) => r.model_id === modelId);
}

export function harnessResultsFor(modelId: string): BenchmarkResult[] {
  return results.filter((r) => r.model_id === modelId && HARNESS_BENCHMARKS.includes(r.benchmark));
}

export function provenanceFor(r: BenchmarkResult): Provenance {
  return { source_url: r.source_url, last_verified: sourceFor(r.benchmark)?.last_verified ?? r.run_date };
}

/** Extras to hand the engine for a given row: measured cost bypasses the loop model. */
export function extrasFor(r: BenchmarkResult) {
  return {
    passRateProvenance: provenanceFor(r),
    measuredAttemptCostUsd: r.cost_basis === 'measured_by_source' || r.cost_basis === 'measured_by_solvency'
      ? (r as any).measured_cost_per_task_usd
      : undefined,
    sourceUsage: r.cost_basis === 'source_usage_repriced' ? r.source_usage : undefined,
  };
}

export function stalenessDays(runDate: string, asOf: string): number {
  return Math.floor((Date.parse(asOf) - Date.parse(runDate)) / 86_400_000);
}
