import modelsFile from '../data/models.json';
import benchmarksFile from '../data/benchmarks.json';
import assumptions from '../data/assumptions.json';
import type { Model, BenchmarkResult } from './engine.ts';

export { modelsFile, benchmarksFile, assumptions };
export const models = modelsFile.models as Model[];
export const results = benchmarksFile.results as BenchmarkResult[];
export const sources = benchmarksFile.sources as any[];
export const tiers = assumptions.task_tiers as any;
export const TIER_NAMES = ['light', 'moderate', 'heavy'] as const;

/** Same source-preference policy as the repo loader. */
export const SOURCE_PREFERENCE = ['aa-coding-agent-index', 'seal-swe-bench-pro', 'aider-polyglot'];

export const modelById = (id: string) => models.find((m) => m.model_id === id);
export const sourceFor = (b: string) => sources.find((s) => s.benchmark === b);

export function bestResultFor(modelId: string): BenchmarkResult | null {
  for (const b of SOURCE_PREFERENCE) {
    const c = results.filter((r) => r.model_id === modelId && r.benchmark === b);
    if (c.length) return c.reduce((a, x) => (x.pass_rate > a.pass_rate ? x : a));
  }
  return null;
}

export const allResultsFor = (id: string) => results.filter((r) => r.model_id === id);

export function extrasFor(r: BenchmarkResult) {
  return {
    passRateProvenance: { source_url: r.source_url, last_verified: sourceFor(r.benchmark)?.last_verified ?? r.run_date },
    measuredAttemptCostUsd: r.cost_basis === 'measured_by_source' ? (r as any).measured_cost_per_task_usd : undefined,
  };
}

export const slugFor = (id: string) => id.replace(/[^a-z0-9.-]+/gi, '-').toLowerCase();
