export type CapabilityClass = 'frontier' | 'small';
export type ModelStatus = 'current' | 'legacy' | 'retired';
export type TierName = 'light' | 'moderate' | 'heavy';

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
}

export interface BenchmarkResult {
  model_id: string | null;
  entry_label: string;
  benchmark: string;
  pass_rate: number;
  cost_basis: 'measured_by_source' | 'modelled_by_denominator' | 'historical_at_run_date';
  tasks_n: number;
  run_date: string;
  source_url: string;
  redistributable: boolean;
  harness?: string;
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
