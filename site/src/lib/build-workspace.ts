import { quoteBuildPlan, type BuildPlanV1, type BuildQuoteV1 } from './build-cost.ts';
import type { Model } from './engine.ts';

export interface BuildSnapshotV1 {
  schemaVersion: 1;
  snapshotId: string;
  planId: string;
  version: number;
  savedAt: string;
  plan: BuildPlanV1;
  quote: BuildQuoteV1;
}

export interface QuoteMetricDelta {
  current: number | null;
  baseline: number | null;
  absolute: number | null;
  percent: number | null;
}

export interface BuildQuoteDeltaV1 {
  buildAttemptCostUsd: QuoteMetricDelta;
  variableCostPerSuccessfulBuildUsd: QuoteMetricDelta;
  monthlyCostUsd: QuoteMetricDelta;
}

const clone = <T>(value: T): T => structuredClone(value);

export function nextPlanVersion(snapshots: BuildSnapshotV1[], planId: string): number {
  return snapshots.reduce((highest, item) => item.planId === planId ? Math.max(highest, item.version) : highest, 0) + 1;
}

export function createBuildSnapshot(
  snapshots: BuildSnapshotV1[],
  planId: string,
  snapshotId: string,
  plan: BuildPlanV1,
  catalog: Model[],
  savedAt = new Date().toISOString(),
): BuildSnapshotV1 {
  if (!planId.trim()) throw new Error('Plan ID is required.');
  if (!snapshotId.trim()) throw new Error('Snapshot ID is required.');
  if (snapshots.some((item) => item.snapshotId === snapshotId)) throw new Error('Snapshot ID must be unique.');
  const quote = quoteBuildPlan(plan, catalog, savedAt);
  if (!quote.valid) throw new Error('Only a valid build quote can be saved as a version.');
  return {
    schemaVersion: 1,
    snapshotId,
    planId,
    version: nextPlanVersion(snapshots, planId),
    savedAt,
    plan: clone(plan),
    quote: clone(quote),
  };
}

export function duplicateBuildSnapshot(
  source: BuildSnapshotV1,
  newPlanId: string,
  newSnapshotId: string,
  name: string,
  catalog: Model[],
  savedAt = new Date().toISOString(),
): BuildSnapshotV1 {
  if (!newPlanId.trim()) throw new Error('Plan ID is required.');
  if (!newSnapshotId.trim()) throw new Error('Snapshot ID is required.');
  const plan = clone(source.plan);
  plan.name = name.trim();
  if (!plan.name) throw new Error('Duplicated plan name is required.');
  const quote = quoteBuildPlan(plan, catalog, savedAt);
  if (!quote.valid) throw new Error('Only a valid build quote can be duplicated.');
  return {
    schemaVersion: 1,
    snapshotId: newSnapshotId,
    planId: newPlanId,
    version: 1,
    savedAt,
    plan,
    quote,
  };
}

function metric(current: number | null, baseline: number | null): QuoteMetricDelta {
  if (current === null || baseline === null) return { current, baseline, absolute: null, percent: null };
  const absolute = current - baseline;
  return { current, baseline, absolute, percent: baseline === 0 ? null : absolute / baseline };
}

export function compareBuildQuotes(current: BuildQuoteV1, baseline: BuildQuoteV1): BuildQuoteDeltaV1 {
  return {
    buildAttemptCostUsd: metric(current.buildAttemptCostUsd, baseline.buildAttemptCostUsd),
    variableCostPerSuccessfulBuildUsd: metric(current.variableCostPerSuccessfulBuildUsd, baseline.variableCostPerSuccessfulBuildUsd),
    monthlyCostUsd: metric(current.monthlyCostUsd, baseline.monthlyCostUsd),
  };
}
