import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { models } from '../scripts/load.ts';
import type { BuildPlanV1 } from '../site/src/lib/build-cost.ts';
import { createBuildSnapshot } from '../site/src/lib/build-workspace.ts';
import { alertSummary, createAlertDraft, createShareDraft } from '../site/src/lib/build-operations.ts';

const plan = (name: string): BuildPlanV1 => ({
  schemaVersion: 1,
  name,
  workload: { buildsPerMonth: 100, volumeBasis: 'attempted_builds' },
  harness: {
    name: 'Internal harness', version: 'v1', configBasis: 'user_supplied',
    fixedCostPerBuildAttemptUsd: 0, fixedMonthlyCostUsd: 0,
  },
  roles: [{
    roleId: 'lead', kind: 'orchestrator', label: 'Lead', modelId: 'claude-fable-5',
    expectedInvocationsPerBuildAttempt: 1,
    usagePerInvocation: {
      uncachedInputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0,
      outputTokens: 1_000, basis: 'user_supplied',
    },
  }],
});

const snapshots = () => {
  const first = createBuildSnapshot([], 'plan-a', 'snap-a', plan('Plan A'), models, '2026-08-23T12:00:00.000Z');
  const second = createBuildSnapshot([first], 'plan-a', 'snap-b', plan('Plan B'), models, '2026-08-23T12:05:00.000Z');
  return [first, second];
};

describe('Build Composer operation previews', () => {
  test('creates only an inert private-share draft for an immutable saved version', () => {
    const items = snapshots();
    const draft = createShareDraft(items, 'snap-a', 7, true, '2026-08-23T12:10:00.000Z');
    assert.deepEqual(draft, {
      schemaVersion: 1,
      snapshotId: 'snap-a',
      access: 'unlisted_link_view_only',
      expiresInDays: 7,
      allowQuoteExport: true,
      status: 'draft_no_link',
      draftedAt: '2026-08-23T12:10:00.000Z',
    });
    assert.equal('url' in draft, false);
    assert.equal('recipient' in draft, false);
    assert.throws(() => createShareDraft(items, 'missing', 7, false), /saved plan version/);
    assert.throws(() => createShareDraft(items, 'snap-a', 365 as never, false), /expiry/);
  });

  test('creates alert drafts that remain explicitly off', () => {
    const items = snapshots();
    const price = createAlertDraft(items, {
      alertId: 'alert-a', snapshotId: 'snap-a', trigger: 'model_price_change',
    }, '2026-08-23T12:10:00.000Z');
    assert.equal(price.status, 'draft_off');
    assert.equal(price.threshold, null);
    assert.equal(alertSummary(price, items[0].quote), 'Trigger when a model price in this plan changes');

    const budget = createAlertDraft(items, {
      alertId: 'alert-b', snapshotId: 'snap-a', trigger: 'monthly_spend_above', threshold: 250,
    });
    assert.equal(alertSummary(budget, items[0].quote), 'Trigger when monthly spend exceeds $250');
  });

  test('requires finite thresholds and a different saved baseline when the rule needs one', () => {
    const items = snapshots();
    assert.throws(() => createAlertDraft(items, {
      alertId: 'alert-a', snapshotId: 'snap-a', trigger: 'monthly_spend_above', threshold: 0,
    }), /greater than 0/);
    assert.throws(() => createAlertDraft(items, {
      alertId: 'alert-a', snapshotId: 'snap-a', trigger: 'baseline_delta_percent', threshold: 10,
    }), /saved baseline/);
    assert.throws(() => createAlertDraft(items, {
      alertId: 'alert-a', snapshotId: 'snap-a', trigger: 'baseline_delta_percent', threshold: 10,
      baselineSnapshotId: 'snap-a',
    }), /must be different/);

    const draft = createAlertDraft(items, {
      alertId: 'alert-a', snapshotId: 'snap-b', trigger: 'baseline_delta_percent', threshold: 10,
      baselineSnapshotId: 'snap-a',
    });
    assert.equal(draft.baselineSnapshotId, 'snap-a');
    assert.equal(draft.status, 'draft_off');
  });
});
