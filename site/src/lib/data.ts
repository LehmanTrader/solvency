import modelsFile from '../data/models.json' with { type: 'json' };
import benchmarksFile from '../data/benchmarks.json' with { type: 'json' };
import assumptions from '../data/assumptions.json' with { type: 'json' };
import type { Model, BenchmarkResult } from './engine.ts';

export { modelsFile, benchmarksFile, assumptions };
export const models = modelsFile.models as Model[];
export const results = benchmarksFile.results as BenchmarkResult[];
export const sources = benchmarksFile.sources as any[];
export const tiers = assumptions.task_tiers as any;
export const TIER_NAMES = ['light', 'moderate', 'heavy'] as const;

/** Same source-preference policy as the repo loader. */
export const SOURCE_PREFERENCE = ['aa-coding-agent-index', 'seal-swe-bench-pro', 'aider-polyglot'];
/** Harness-only sources are isolated from the general model leaderboard. */
export const HARNESS_BENCHMARKS = ['openbench-gpt56-harness'];

export const modelById = (id: string) => models.find((m) => m.model_id === id);
export const sourceFor = (b: string) => sources.find((s) => s.benchmark === b);

/** Short labels for tight table cells. Attribution strings elsewhere stay verbatim. */
const SHORT_SOURCE: Record<string, string> = {
  'aa-coding-agent-index': 'AA', 'seal-swe-bench-pro': 'SEAL', 'aider-polyglot': 'Aider',
};
export const shortSourceName = (b: string) => SHORT_SOURCE[b] ?? sourceFor(b)?.name ?? b;

export function bestResultFor(modelId: string): BenchmarkResult | null {
  for (const b of SOURCE_PREFERENCE) {
    const c = results.filter((r) => r.model_id === modelId && r.benchmark === b);
    if (c.length) return c.reduce((a, x) => (x.pass_rate > a.pass_rate ? x : a));
  }
  return null;
}

export const allResultsFor = (id: string) => results.filter((r) => r.model_id === id);
export const harnessResultsFor = (id: string) => results.filter((r) => r.model_id === id && HARNESS_BENCHMARKS.includes(r.benchmark));

export function extrasFor(r: BenchmarkResult) {
  return {
    passRateProvenance: { source_url: r.source_url, last_verified: sourceFor(r.benchmark)?.last_verified ?? r.run_date },
    measuredAttemptCostUsd: r.cost_basis === 'measured_by_source' ? (r as any).measured_cost_per_task_usd : undefined,
    sourceUsage: r.cost_basis === 'source_usage_repriced' ? r.source_usage : undefined,
  };
}

export const slugFor = (id: string) => id.replace(/[^a-z0-9.-]+/gi, '-').toLowerCase();
