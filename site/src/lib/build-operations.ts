import type { BuildQuoteV1 } from './build-cost.ts';
import type { BuildSnapshotV1 } from './build-workspace.ts';

export type ShareExpiryDays = 7 | 30 | null;

export interface BuildShareDraftV1 {
  schemaVersion: 1;
  snapshotId: string;
  access: 'unlisted_link_view_only';
  expiresInDays: ShareExpiryDays;
  allowQuoteExport: boolean;
  status: 'draft_no_link';
  draftedAt: string;
}

export type BuildAlertTrigger =
  | 'model_price_change'
  | 'monthly_spend_above'
  | 'monthly_spend_change_percent'
  | 'baseline_delta_percent';

export interface BuildAlertDraftV1 {
  schemaVersion: 1;
  alertId: string;
  snapshotId: string;
  trigger: BuildAlertTrigger;
  threshold: number | null;
  baselineSnapshotId: string | null;
  status: 'draft_off';
  draftedAt: string;
}

const finitePositive = (value: number) => Number.isFinite(value) && value > 0;

function savedValidSnapshot(snapshots: BuildSnapshotV1[], snapshotId: string): BuildSnapshotV1 {
  const snapshot = snapshots.find((item) => item.snapshotId === snapshotId);
  if (!snapshot) throw new Error('Choose a saved plan version.');
  if (!snapshot.quote.valid) throw new Error('Only a valid saved version can be used.');
  return snapshot;
}

/** A local-only policy draft containing policy fields only—never locator, token, or identity data. */
export function createShareDraft(
  snapshots: BuildSnapshotV1[],
  snapshotId: string,
  expiresInDays: ShareExpiryDays,
  allowQuoteExport: boolean,
  draftedAt = new Date().toISOString(),
): BuildShareDraftV1 {
  savedValidSnapshot(snapshots, snapshotId);
  if (![7, 30, null].includes(expiresInDays)) throw new Error('Share expiry is invalid.');
  return {
    schemaVersion: 1,
    snapshotId,
    access: 'unlisted_link_view_only',
    expiresInDays,
    allowQuoteExport,
    status: 'draft_no_link',
    draftedAt,
  };
}

/** An inert alert rule. Delivery and monitoring stay off until a future server owns the plan. */
export function createAlertDraft(
  snapshots: BuildSnapshotV1[],
  input: {
    alertId: string;
    snapshotId: string;
    trigger: BuildAlertTrigger;
    threshold?: number | null;
    baselineSnapshotId?: string | null;
  },
  draftedAt = new Date().toISOString(),
): BuildAlertDraftV1 {
  savedValidSnapshot(snapshots, input.snapshotId);
  if (!input.alertId.trim()) throw new Error('Alert draft ID is required.');
  if (![
    'model_price_change', 'monthly_spend_above',
    'monthly_spend_change_percent', 'baseline_delta_percent',
  ].includes(input.trigger)) throw new Error('Alert trigger is invalid.');

  const needsThreshold = input.trigger !== 'model_price_change';
  const threshold = needsThreshold ? input.threshold : null;
  if (needsThreshold && (threshold === null || threshold === undefined || !finitePositive(threshold))) {
    throw new Error('Enter a threshold greater than 0.');
  }
  if (threshold !== null && threshold !== undefined && threshold > 1_000_000_000) {
    throw new Error('Alert threshold is outside the supported range.');
  }

  const baselineSnapshotId = input.trigger === 'baseline_delta_percent'
    ? input.baselineSnapshotId ?? null
    : null;
  if (input.trigger === 'baseline_delta_percent') {
    if (!baselineSnapshotId) throw new Error('Choose a saved baseline for this alert.');
    savedValidSnapshot(snapshots, baselineSnapshotId);
    if (baselineSnapshotId === input.snapshotId) throw new Error('The alert version and baseline must be different.');
  }

  return {
    schemaVersion: 1,
    alertId: input.alertId,
    snapshotId: input.snapshotId,
    trigger: input.trigger,
    threshold: threshold ?? null,
    baselineSnapshotId,
    status: 'draft_off',
    draftedAt,
  };
}

export function alertSummary(draft: BuildAlertDraftV1, quote: BuildQuoteV1): string {
  if (!quote.valid) throw new Error('Alert summaries require a valid quote.');
  if (draft.trigger === 'model_price_change') return 'Trigger when a model price in this plan changes';
  if (draft.trigger === 'monthly_spend_above') return `Trigger when monthly spend exceeds $${draft.threshold!.toLocaleString()}`;
  if (draft.trigger === 'monthly_spend_change_percent') return `Trigger when monthly spend changes by ${draft.threshold!.toLocaleString()}%`;
  return `Trigger when the selected version exceeds its baseline by ${draft.threshold!.toLocaleString()}%`;
}
