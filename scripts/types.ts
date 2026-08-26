export type CapabilityClass = 'frontier' | 'small';
export type ModelStatus = 'current' | 'legacy' | 'retired';
export type TierName = 'light' | 'moderate' | 'heavy';
export type AccessTier = 'free' | 'paid';

/**
 * Free-model coverage (docs/free-models-scoping.md §4/§7). Rate caps a $0
 * access path is subject to -- RPM/RPD/TPM/TPD, each nullable independently
 * because a provider may publish some limits and not others (or none at
 * all: absence here means "not published", never "uncapped"). `source_url`
 * is nullable too: some free tiers (e.g. a vendor's own pricing page) simply
 * have no rate-limit page to cite at all, which is a different, more honest
 * state than "we have a URL but it didn't say"  (source_url set,
 * last_verified null -- see the Gemini free-tier row for that case).
 */
export interface RateCaps {
  requests_per_minute: number | null;
  requests_per_day: number | null;
  tokens_per_minute: number | null;
  tokens_per_day: number | null;
  source_url: string | null;
  last_verified: string | null;
}

export interface Model {
  model_id: string;
  provider: string;
  display_name: string;
  status: ModelStatus;
  capability_class: CapabilityClass;
  input_per_mtok: number;
  output_per_mtok: number;
  cached_input_per_mtok: number | null;
  context_window: number | null;
  source_url: string;
  last_verified: string;
  pricing_notes: string | null;
  /**
   * Defaults to 'paid' when absent, so every one of the original 25 rows is
   * valid with zero migration. 'free' rows must price at exactly $0 (a real,
   * verified number -- not a substitute for `null`, which stays reserved for
   * "not published") and are rendered, ranked and superlative-checked
   * separately from paid rows everywhere in the engine -- see calc.ts's
   * `free_tier_capped` group and the guards in headline.ts/content-miner.ts.
   */
  access_tier?: AccessTier;
  /**
   * Who actually trained/owns the weights, when that differs from `provider`
   * (the serving venue whose price and rate limits actually apply -- e.g.
   * `provider: "openrouter"`, `vendor_provider: "z-ai"` for a $0 OpenRouter
   * route on a Z.ai model). Null/absent when the provider IS the vendor.
   */
  vendor_provider?: string | null;
  /** Present only on `access_tier === 'free'` rows. Null means "not evaluated" (paid rows never have a cap to publish). */
  rate_caps?: RateCaps | null;
}

/** Aggregate usage observed by a benchmark source and safe to reprice. */
export interface SourceUsage {
  token_basis: 'proxy_measured';
  attempts_n: number;
  input_uncached_tokens_total: number;
  cache_read_tokens_total: number;
  cache_write_tokens_total: number;
  output_tokens_total: number;
}

export interface BenchmarkResult {
  model_id: string | null;
  entry_label: string;
  benchmark: string;
  pass_rate: number;
  /**
   * `free_tier_capped` (free-model coverage, docs/free-models-scoping.md §4):
   * a benchmark row for an `access_tier === 'free'` model. Deliberately NOT
   * matched by extrasFor()'s `measured_by_source`/`source_usage_repriced`
   * checks, so the engine always falls through to the ordinary modelled path
   * (loop model at the model's own -- $0 -- price); it exists purely so
   * calc.ts/headline.ts's basisKey grouping puts the row in its own fourth
   * group by construction, the same mechanism that already keeps measured
   * rows from ever blending with modelled ones.
   */
  cost_basis: 'measured_by_source' | 'source_usage_repriced' | 'modelled_by_solvency' | 'historical_at_run_date' | 'free_tier_capped';
  tasks_n: number;
  run_date: string;
  source_url: string;
  redistributable: boolean;
  /** Named coding harness, or null when the source did not publish one. */
  harness: string | null;
  /** Exact harness release/version, or null when the source did not publish it. */
  harness_version: string | null;
  /** Source-published routing/turn/cache configuration, free text initially. */
  harness_config: string | null;
  /** Exact aggregate behind a source_usage_repriced row. */
  source_usage?: SourceUsage;
  attempts_n?: number;
  countable_attempts_n?: number;
  solved_attempts_n?: number;
  excluded_attempts_n?: number;
  variant?: string;
  index_score?: number;
  pass_rate_derivation?: string;
  measured_cost_per_task_usd?: number;
  measured_time_per_task_min?: number;
  total_cost_usd?: number;
  cost_per_task?: number;
  edit_format?: string;
  pass_rate_ci?: number;
  match_confidence?: string;
  match_note?: string;
  row_note?: string;
  date_basis?: string;
  unmatched_reason?: string;
}

export interface TaskTier {
  label: string;
  examples: string;
  input_tokens_per_loop: number;
  output_tokens_per_loop: number;
  loops_low: number;
  loops_high: number;
  loops_default: number;
  kind: string;
  provenance: string;
  provenance_url: string;
  provenance_note: string;
}

/** Every displayed figure carries where it came from and when it was checked. */
export interface Provenance {
  source_url: string;
  last_verified: string;
}

/**
 * A computed figure that is allowed to be absent. `value === null` means the
 * inputs were missing, never that the value is zero. `missing` names exactly
 * which inputs were absent so the UI can say so instead of hiding it.
 */
export interface Computed<T> {
  value: T | null;
  missing: string[];
  provenance: Provenance[];
}
