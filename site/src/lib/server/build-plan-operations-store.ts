import type { BuildPlanV1, BuildQuoteV1 } from '../build-cost.ts';
import type { D1DatabaseLike } from './pages-types.ts';

export const MAX_BUILD_PLAN_SHARES_PER_OWNER = 100;
export const MAX_BUILD_PLAN_SHARES_PER_PLAN = 20;
export const MAX_BUILD_PLAN_ALERTS_PER_OWNER = 100;
export const MAX_BUILD_PLAN_ALERTS_PER_PLAN = 20;
export const OPERATION_IDEMPOTENCY_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type BuildAlertTrigger =
  | 'model_price_change'
  | 'monthly_spend_above'
  | 'monthly_spend_change_percent'
  | 'baseline_delta_percent';

interface ShareRow {
  id: string;
  plan_id: string;
  version: number;
  token_hash: string;
  allow_quote_export: number;
  expires_at: string | null;
  created_at: string;
}

interface AlertRow {
  id: string;
  plan_id: string;
  version: number;
  trigger_type: BuildAlertTrigger;
  threshold: number | null;
  baseline_version: number | null;
  status: 'inactive';
  created_at: string;
  updated_at: string;
}

interface OperationRow {
  request_hash: string;
  resource_id: string;
  result_kind: 'created' | 'updated' | 'revoked' | 'deleted';
}

interface PublicShareRow {
  plan_json: string;
  quote_json: string;
  allow_quote_export: number;
}

export interface OwnedBuildPlanShare {
  id: string;
  planId: string;
  version: number;
  allowQuoteExport: boolean;
  expiresAt: string | null;
  status: 'active' | 'expired';
  createdAt: string;
}

export interface PublicSharedBuildPlan {
  schemaVersion: 1;
  plan: BuildPlanV1;
  quote: BuildQuoteV1;
  policy: { allowQuoteExport: boolean };
}

export interface InactiveBuildPlanAlert {
  id: string;
  planId: string;
  version: number;
  trigger: BuildAlertTrigger;
  threshold: number | null;
  baselineVersion: number | null;
  status: 'inactive';
  createdAt: string;
  updatedAt: string;
}

export type OperationFailureReason =
  | 'not_found'
  | 'duplicate'
  | 'idempotency_conflict'
  | 'share_limit'
  | 'alert_limit'
  | 'operation_limit'
  | 'state_changed';

export type OperationMutationResult<T> =
  | { ok: true; replayed: boolean; resource: T }
  | { ok: false; reason: OperationFailureReason };

export type OperationDeleteResult =
  | { ok: true; replayed: boolean }
  | { ok: false; reason: OperationFailureReason };

function shareResource(row: ShareRow, now: string): OwnedBuildPlanShare {
  return {
    id: row.id,
    planId: row.plan_id,
    version: row.version,
    allowQuoteExport: row.allow_quote_export === 1,
    expiresAt: row.expires_at,
    status: row.expires_at !== null && row.expires_at <= now ? 'expired' : 'active',
    createdAt: row.created_at,
  };
}

function alertResource(row: AlertRow): InactiveBuildPlanAlert {
  return {
    id: row.id,
    planId: row.plan_id,
    version: row.version,
    trigger: row.trigger_type,
    threshold: row.threshold,
    baselineVersion: row.baseline_version,
    status: 'inactive',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function ownedPlanExists(db: D1DatabaseLike, ownerUserId: string, planId: string): Promise<boolean> {
  return (await db.prepare(
    'SELECT 1 AS present FROM build_plans WHERE id = ? AND owner_user_id = ?',
  ).bind(planId, ownerUserId).first<{ present: number }>())?.present === 1;
}

async function ownedVersionExists(
  db: D1DatabaseLike,
  ownerUserId: string,
  planId: string,
  version: number,
): Promise<boolean> {
  return (await db.prepare(
    `SELECT 1 AS present
       FROM build_plan_versions v
       JOIN build_plans p ON p.id = v.plan_id
      WHERE p.id = ? AND p.owner_user_id = ? AND v.version = ?`,
  ).bind(planId, ownerUserId, version).first<{ present: number }>())?.present === 1;
}

async function priorOperation(
  db: D1DatabaseLike,
  ownerUserId: string,
  operation: string,
  idempotencyKey: string,
  now: string,
): Promise<OperationRow | null> {
  return db.prepare(
    `SELECT request_hash, resource_id, result_kind
       FROM build_plan_operation_requests
      WHERE owner_user_id = ? AND operation = ? AND idempotency_key = ?
        AND expires_at > ?`,
  ).bind(ownerUserId, operation, idempotencyKey, now).first<OperationRow>();
}

async function operationCount(db: D1DatabaseLike, ownerUserId: string, now: string): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS count FROM build_plan_operation_requests
      WHERE owner_user_id = ? AND expires_at > ?`,
  ).bind(ownerUserId, now).first<{ count: number }>();
  return row?.count ?? 0;
}

function operationExpiry(now: string): string {
  return new Date(Date.parse(now) + OPERATION_IDEMPOTENCY_REPLAY_WINDOW_MS).toISOString();
}

async function ownedShareById(
  db: D1DatabaseLike,
  ownerUserId: string,
  planId: string,
  shareId: string,
): Promise<ShareRow | null> {
  return db.prepare(
    `SELECT s.id, s.plan_id, s.version, s.token_hash, s.allow_quote_export, s.expires_at, s.created_at
       FROM build_plan_shares s
       JOIN build_plans p ON p.id = s.plan_id
      WHERE s.id = ? AND s.plan_id = ? AND s.owner_user_id = ?
        AND p.owner_user_id = ?`,
  ).bind(shareId, planId, ownerUserId, ownerUserId).first<ShareRow>();
}

async function shareReplay(
  db: D1DatabaseLike,
  input: {
    ownerUserId: string;
    planId: string;
    operation: string;
    idempotencyKey: string;
    requestHash: string;
    tokenHash: string;
    now: string;
  },
): Promise<OperationMutationResult<OwnedBuildPlanShare> | null> {
  const previous = await priorOperation(
    db, input.ownerUserId, input.operation, input.idempotencyKey, input.now,
  );
  if (!previous) return null;
  if (previous.request_hash !== input.requestHash) return { ok: false, reason: 'idempotency_conflict' };
  const row = await ownedShareById(db, input.ownerUserId, input.planId, previous.resource_id);
  if (!row || row.token_hash !== input.tokenHash) return { ok: false, reason: 'state_changed' };
  return { ok: true, replayed: true, resource: shareResource(row, input.now) };
}

export async function listOwnedBuildPlanShares(
  db: D1DatabaseLike,
  ownerUserId: string,
  planId: string,
  now: string,
): Promise<OwnedBuildPlanShare[] | null> {
  if (!await ownedPlanExists(db, ownerUserId, planId)) return null;
  const result = await db.prepare(
    `SELECT s.id, s.plan_id, s.version, s.token_hash, s.allow_quote_export, s.expires_at, s.created_at
       FROM build_plan_shares s
       JOIN build_plans p ON p.id = s.plan_id
      WHERE s.plan_id = ? AND s.owner_user_id = ? AND p.owner_user_id = ?
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT ?`,
  ).bind(planId, ownerUserId, ownerUserId, MAX_BUILD_PLAN_SHARES_PER_PLAN).all<ShareRow>();
  return (result.results ?? []).map((row) => shareResource(row, now));
}

export async function createOwnedBuildPlanShare(
  db: D1DatabaseLike,
  input: {
    ownerUserId: string;
    planId: string;
    version: number;
    shareId: string;
    tokenHash: string;
    allowQuoteExport: boolean;
    expiresAt: string | null;
    idempotencyKey: string;
    requestHash: string;
    now: string;
  },
): Promise<OperationMutationResult<OwnedBuildPlanShare>> {
  const operation = `share.create:${input.planId}`;
  const replay = await shareReplay(db, { ...input, operation });
  if (replay) return replay;
  if (!await ownedVersionExists(db, input.ownerUserId, input.planId, input.version)) {
    return { ok: false, reason: 'not_found' };
  }

  try {
    const results = await db.batch([
      db.prepare(
        `INSERT INTO build_plan_shares
           (id, owner_user_id, plan_id, version, token_hash, allow_quote_export, expires_at, created_at)
         SELECT ?, ?, v.plan_id, v.version, ?, ?, ?, ?
           FROM build_plan_versions v
           JOIN build_plans p ON p.id = v.plan_id
          WHERE p.id = ? AND p.owner_user_id = ? AND v.version = ?`,
      ).bind(
        input.shareId, input.ownerUserId, input.tokenHash, input.allowQuoteExport ? 1 : 0,
        input.expiresAt, input.now, input.planId, input.ownerUserId, input.version,
      ),
      db.prepare(
        `INSERT INTO build_plan_operation_requests
           (owner_user_id, operation, idempotency_key, request_hash, plan_id,
            resource_type, resource_id, result_kind, created_at, expires_at)
         SELECT ?, ?, ?, ?, s.plan_id, 'share', s.id, 'created', ?, ?
           FROM build_plan_shares s
          WHERE s.id = ? AND s.owner_user_id = ?`,
      ).bind(
        input.ownerUserId, operation, input.idempotencyKey, input.requestHash,
        input.now, operationExpiry(input.now), input.shareId, input.ownerUserId,
      ),
    ]);
    if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) {
      return { ok: false, reason: 'not_found' };
    }
  } catch {
    const raced = await shareReplay(db, { ...input, operation });
    if (raced) return raced;
    const duplicate = await db.prepare(
      `SELECT 1 AS present FROM build_plan_shares
        WHERE owner_user_id = ? AND plan_id = ? AND version = ?`,
    ).bind(input.ownerUserId, input.planId, input.version).first<{ present: number }>();
    if (duplicate?.present === 1) return { ok: false, reason: 'duplicate' };
    const counts = await db.prepare(
      `SELECT
         (SELECT COUNT(*) FROM build_plan_shares WHERE owner_user_id = ?) AS owner_count,
         (SELECT COUNT(*) FROM build_plan_shares WHERE plan_id = ?) AS plan_count`,
    ).bind(input.ownerUserId, input.planId).first<{ owner_count: number; plan_count: number }>();
    if ((counts?.owner_count ?? 0) >= MAX_BUILD_PLAN_SHARES_PER_OWNER
      || (counts?.plan_count ?? 0) >= MAX_BUILD_PLAN_SHARES_PER_PLAN) {
      return { ok: false, reason: 'share_limit' };
    }
    if (await operationCount(db, input.ownerUserId, input.now) >= 4096) {
      return { ok: false, reason: 'operation_limit' };
    }
    throw new Error('Build plan share transaction failed.');
  }

  const row = await ownedShareById(db, input.ownerUserId, input.planId, input.shareId);
  if (!row) throw new Error('Created build plan share could not be read.');
  return { ok: true, replayed: false, resource: shareResource(row, input.now) };
}

export async function revokeOwnedBuildPlanShare(
  db: D1DatabaseLike,
  input: {
    ownerUserId: string;
    planId: string;
    shareId: string;
    idempotencyKey: string;
    requestHash: string;
    now: string;
  },
): Promise<OperationDeleteResult> {
  const operation = `share.revoke:${input.shareId}`;
  const previous = await priorOperation(
    db, input.ownerUserId, operation, input.idempotencyKey, input.now,
  );
  if (previous) {
    return previous.request_hash === input.requestHash
      ? { ok: true, replayed: true }
      : { ok: false, reason: 'idempotency_conflict' };
  }
  if (!await ownedShareById(db, input.ownerUserId, input.planId, input.shareId)) {
    return { ok: false, reason: 'not_found' };
  }
  try {
    const results = await db.batch([
      db.prepare(
        `INSERT INTO build_plan_operation_requests
           (owner_user_id, operation, idempotency_key, request_hash, plan_id,
            resource_type, resource_id, result_kind, created_at, expires_at)
         SELECT ?, ?, ?, ?, s.plan_id, 'share', s.id, 'revoked', ?, ?
           FROM build_plan_shares s
           JOIN build_plans p ON p.id = s.plan_id
          WHERE s.id = ? AND s.plan_id = ? AND s.owner_user_id = ? AND p.owner_user_id = ?`,
      ).bind(
        input.ownerUserId, operation, input.idempotencyKey, input.requestHash, input.now,
        operationExpiry(input.now),
        input.shareId, input.planId, input.ownerUserId, input.ownerUserId,
      ),
      db.prepare(
        `DELETE FROM build_plan_shares
          WHERE id = ? AND plan_id = ? AND owner_user_id = ?`,
      ).bind(input.shareId, input.planId, input.ownerUserId),
    ]);
    if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) {
      const raced = await priorOperation(
        db, input.ownerUserId, operation, input.idempotencyKey, input.now,
      );
      if (raced) {
        return raced.request_hash === input.requestHash
          ? { ok: true, replayed: true }
          : { ok: false, reason: 'idempotency_conflict' };
      }
      return { ok: false, reason: 'not_found' };
    }
  } catch {
    const raced = await priorOperation(
      db, input.ownerUserId, operation, input.idempotencyKey, input.now,
    );
    if (raced) {
      return raced.request_hash === input.requestHash
        ? { ok: true, replayed: true }
        : { ok: false, reason: 'idempotency_conflict' };
    }
    if (await operationCount(db, input.ownerUserId, input.now) >= 4096) {
      return { ok: false, reason: 'operation_limit' };
    }
    throw new Error('Build plan share revocation transaction failed.');
  }
  return { ok: true, replayed: false };
}

export async function getPublicSharedBuildPlan(
  db: D1DatabaseLike,
  tokenHash: string,
  now: string,
): Promise<PublicSharedBuildPlan | null> {
  const row = await db.prepare(
    `SELECT v.plan_json, v.quote_json, s.allow_quote_export
       FROM build_plan_shares s
       JOIN build_plan_versions v ON v.plan_id = s.plan_id AND v.version = s.version
      WHERE s.token_hash = ? AND (s.expires_at IS NULL OR s.expires_at > ?)
      LIMIT 1`,
  ).bind(tokenHash, now).first<PublicShareRow>();
  if (!row) return null;
  return {
    schemaVersion: 1,
    plan: JSON.parse(row.plan_json) as BuildPlanV1,
    quote: JSON.parse(row.quote_json) as BuildQuoteV1,
    policy: { allowQuoteExport: row.allow_quote_export === 1 },
  };
}

async function ownedAlertById(
  db: D1DatabaseLike,
  ownerUserId: string,
  planId: string,
  alertId: string,
): Promise<AlertRow | null> {
  return db.prepare(
    `SELECT a.id, a.plan_id, a.version, a.trigger_type, a.threshold,
            a.baseline_version, a.status, a.created_at, a.updated_at
       FROM build_plan_alert_settings a
       JOIN build_plans p ON p.id = a.plan_id
      WHERE a.id = ? AND a.plan_id = ? AND a.owner_user_id = ?
        AND p.owner_user_id = ?`,
  ).bind(alertId, planId, ownerUserId, ownerUserId).first<AlertRow>();
}

async function alertReplay(
  db: D1DatabaseLike,
  input: {
    ownerUserId: string;
    planId: string;
    operation: string;
    idempotencyKey: string;
    requestHash: string;
    now: string;
    version: number;
    trigger: BuildAlertTrigger;
    threshold: number | null;
    baselineVersion: number | null;
  },
): Promise<OperationMutationResult<InactiveBuildPlanAlert> | null> {
  const previous = await priorOperation(
    db, input.ownerUserId, input.operation, input.idempotencyKey, input.now,
  );
  if (!previous) return null;
  if (previous.request_hash !== input.requestHash) return { ok: false, reason: 'idempotency_conflict' };
  const row = await ownedAlertById(db, input.ownerUserId, input.planId, previous.resource_id);
  if (!row
    || row.version !== input.version
    || row.trigger_type !== input.trigger
    || row.threshold !== input.threshold
    || row.baseline_version !== input.baselineVersion) {
    return { ok: false, reason: 'state_changed' };
  }
  return { ok: true, replayed: true, resource: alertResource(row) };
}

export async function listOwnedBuildPlanAlerts(
  db: D1DatabaseLike,
  ownerUserId: string,
  planId: string,
): Promise<InactiveBuildPlanAlert[] | null> {
  if (!await ownedPlanExists(db, ownerUserId, planId)) return null;
  const result = await db.prepare(
    `SELECT a.id, a.plan_id, a.version, a.trigger_type, a.threshold,
            a.baseline_version, a.status, a.created_at, a.updated_at
       FROM build_plan_alert_settings a
       JOIN build_plans p ON p.id = a.plan_id
      WHERE a.plan_id = ? AND a.owner_user_id = ? AND p.owner_user_id = ?
      ORDER BY a.updated_at DESC, a.id DESC
      LIMIT ?`,
  ).bind(planId, ownerUserId, ownerUserId, MAX_BUILD_PLAN_ALERTS_PER_PLAN).all<AlertRow>();
  return (result.results ?? []).map(alertResource);
}

async function duplicateAlertExists(
  db: D1DatabaseLike,
  input: {
    ownerUserId: string;
    planId: string;
    version: number;
    trigger: BuildAlertTrigger;
    threshold: number | null;
    baselineVersion: number | null;
    exceptId?: string;
  },
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS present
       FROM build_plan_alert_settings
      WHERE owner_user_id = ? AND plan_id = ? AND version = ? AND trigger_type = ?
        AND COALESCE(threshold, -1) = COALESCE(?, -1)
        AND COALESCE(baseline_version, 0) = COALESCE(?, 0)
        AND (? IS NULL OR id <> ?)`,
  ).bind(
    input.ownerUserId, input.planId, input.version, input.trigger,
    input.threshold, input.baselineVersion, input.exceptId ?? null, input.exceptId ?? null,
  ).first<{ present: number }>();
  return row?.present === 1;
}

async function alertLimitReached(db: D1DatabaseLike, ownerUserId: string, planId: string): Promise<boolean> {
  const counts = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM build_plan_alert_settings WHERE owner_user_id = ?) AS owner_count,
       (SELECT COUNT(*) FROM build_plan_alert_settings WHERE plan_id = ?) AS plan_count`,
  ).bind(ownerUserId, planId).first<{ owner_count: number; plan_count: number }>();
  return (counts?.owner_count ?? 0) >= MAX_BUILD_PLAN_ALERTS_PER_OWNER
    || (counts?.plan_count ?? 0) >= MAX_BUILD_PLAN_ALERTS_PER_PLAN;
}

export async function createOwnedBuildPlanAlert(
  db: D1DatabaseLike,
  input: {
    ownerUserId: string;
    planId: string;
    alertId: string;
    version: number;
    trigger: BuildAlertTrigger;
    threshold: number | null;
    baselineVersion: number | null;
    idempotencyKey: string;
    requestHash: string;
    now: string;
  },
): Promise<OperationMutationResult<InactiveBuildPlanAlert>> {
  const operation = `alert.create:${input.planId}`;
  const replay = await alertReplay(db, { ...input, operation });
  if (replay) return replay;
  if (!await ownedVersionExists(db, input.ownerUserId, input.planId, input.version)
    || (input.baselineVersion !== null
      && !await ownedVersionExists(db, input.ownerUserId, input.planId, input.baselineVersion))) {
    return { ok: false, reason: 'not_found' };
  }
  try {
    const results = await db.batch([
      db.prepare(
        `INSERT INTO build_plan_alert_settings
           (id, owner_user_id, plan_id, version, trigger_type, threshold,
            baseline_version, status, created_at, updated_at)
         SELECT ?, ?, v.plan_id, v.version, ?, ?, ?, 'inactive', ?, ?
           FROM build_plan_versions v
           JOIN build_plans p ON p.id = v.plan_id
          WHERE p.id = ? AND p.owner_user_id = ? AND v.version = ?`,
      ).bind(
        input.alertId, input.ownerUserId, input.trigger, input.threshold, input.baselineVersion,
        input.now, input.now, input.planId, input.ownerUserId, input.version,
      ),
      db.prepare(
        `INSERT INTO build_plan_operation_requests
           (owner_user_id, operation, idempotency_key, request_hash, plan_id,
            resource_type, resource_id, result_kind, created_at, expires_at)
         SELECT ?, ?, ?, ?, a.plan_id, 'alert', a.id, 'created', ?, ?
           FROM build_plan_alert_settings a
          WHERE a.id = ? AND a.owner_user_id = ?`,
      ).bind(
        input.ownerUserId, operation, input.idempotencyKey, input.requestHash,
        input.now, operationExpiry(input.now), input.alertId, input.ownerUserId,
      ),
    ]);
    if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) {
      return { ok: false, reason: 'not_found' };
    }
  } catch {
    const raced = await alertReplay(db, { ...input, operation });
    if (raced) return raced;
    if (await duplicateAlertExists(db, input)) return { ok: false, reason: 'duplicate' };
    if (await alertLimitReached(db, input.ownerUserId, input.planId)) {
      return { ok: false, reason: 'alert_limit' };
    }
    if (await operationCount(db, input.ownerUserId, input.now) >= 4096) {
      return { ok: false, reason: 'operation_limit' };
    }
    throw new Error('Build plan alert transaction failed.');
  }
  const row = await ownedAlertById(db, input.ownerUserId, input.planId, input.alertId);
  if (!row) throw new Error('Created build plan alert could not be read.');
  return { ok: true, replayed: false, resource: alertResource(row) };
}

export async function updateOwnedBuildPlanAlert(
  db: D1DatabaseLike,
  input: {
    ownerUserId: string;
    planId: string;
    alertId: string;
    version: number;
    trigger: BuildAlertTrigger;
    threshold: number | null;
    baselineVersion: number | null;
    idempotencyKey: string;
    requestHash: string;
    now: string;
  },
): Promise<OperationMutationResult<InactiveBuildPlanAlert>> {
  const operation = `alert.update:${input.alertId}`;
  const replay = await alertReplay(db, { ...input, operation });
  if (replay) return replay;
  if (!await ownedVersionExists(db, input.ownerUserId, input.planId, input.version)
    || (input.baselineVersion !== null
      && !await ownedVersionExists(db, input.ownerUserId, input.planId, input.baselineVersion))) {
    return { ok: false, reason: 'not_found' };
  }
  try {
    const results = await db.batch([
      db.prepare(
        `UPDATE build_plan_alert_settings
            SET version = ?, trigger_type = ?, threshold = ?, baseline_version = ?,
                status = 'inactive', updated_at = ?
          WHERE id = ? AND plan_id = ? AND owner_user_id = ?`,
      ).bind(
        input.version, input.trigger, input.threshold, input.baselineVersion, input.now,
        input.alertId, input.planId, input.ownerUserId,
      ),
      db.prepare(
        `INSERT INTO build_plan_operation_requests
           (owner_user_id, operation, idempotency_key, request_hash, plan_id,
            resource_type, resource_id, result_kind, created_at, expires_at)
         SELECT ?, ?, ?, ?, a.plan_id, 'alert', a.id, 'updated', ?, ?
           FROM build_plan_alert_settings a
          WHERE a.id = ? AND a.plan_id = ? AND a.owner_user_id = ?`,
      ).bind(
        input.ownerUserId, operation, input.idempotencyKey, input.requestHash, input.now,
        operationExpiry(input.now),
        input.alertId, input.planId, input.ownerUserId,
      ),
    ]);
    if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) {
      return { ok: false, reason: 'not_found' };
    }
  } catch {
    const raced = await alertReplay(db, { ...input, operation });
    if (raced) return raced;
    if (await duplicateAlertExists(db, { ...input, exceptId: input.alertId })) {
      return { ok: false, reason: 'duplicate' };
    }
    if (await operationCount(db, input.ownerUserId, input.now) >= 4096) {
      return { ok: false, reason: 'operation_limit' };
    }
    throw new Error('Build plan alert update transaction failed.');
  }
  const row = await ownedAlertById(db, input.ownerUserId, input.planId, input.alertId);
  if (!row) throw new Error('Updated build plan alert could not be read.');
  return { ok: true, replayed: false, resource: alertResource(row) };
}

export async function deleteOwnedBuildPlanAlert(
  db: D1DatabaseLike,
  input: {
    ownerUserId: string;
    planId: string;
    alertId: string;
    idempotencyKey: string;
    requestHash: string;
    now: string;
  },
): Promise<OperationDeleteResult> {
  const operation = `alert.delete:${input.alertId}`;
  const previous = await priorOperation(
    db, input.ownerUserId, operation, input.idempotencyKey, input.now,
  );
  if (previous) {
    return previous.request_hash === input.requestHash
      ? { ok: true, replayed: true }
      : { ok: false, reason: 'idempotency_conflict' };
  }
  if (!await ownedAlertById(db, input.ownerUserId, input.planId, input.alertId)) {
    return { ok: false, reason: 'not_found' };
  }
  try {
    const results = await db.batch([
      db.prepare(
        `INSERT INTO build_plan_operation_requests
           (owner_user_id, operation, idempotency_key, request_hash, plan_id,
            resource_type, resource_id, result_kind, created_at, expires_at)
         SELECT ?, ?, ?, ?, a.plan_id, 'alert', a.id, 'deleted', ?, ?
           FROM build_plan_alert_settings a
           JOIN build_plans p ON p.id = a.plan_id
          WHERE a.id = ? AND a.plan_id = ? AND a.owner_user_id = ? AND p.owner_user_id = ?`,
      ).bind(
        input.ownerUserId, operation, input.idempotencyKey, input.requestHash, input.now,
        operationExpiry(input.now),
        input.alertId, input.planId, input.ownerUserId, input.ownerUserId,
      ),
      db.prepare(
        `DELETE FROM build_plan_alert_settings
          WHERE id = ? AND plan_id = ? AND owner_user_id = ?`,
      ).bind(input.alertId, input.planId, input.ownerUserId),
    ]);
    if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) {
      const raced = await priorOperation(
        db, input.ownerUserId, operation, input.idempotencyKey, input.now,
      );
      if (raced) {
        return raced.request_hash === input.requestHash
          ? { ok: true, replayed: true }
          : { ok: false, reason: 'idempotency_conflict' };
      }
      return { ok: false, reason: 'not_found' };
    }
  } catch {
    const raced = await priorOperation(
      db, input.ownerUserId, operation, input.idempotencyKey, input.now,
    );
    if (raced) {
      return raced.request_hash === input.requestHash
        ? { ok: true, replayed: true }
        : { ok: false, reason: 'idempotency_conflict' };
    }
    if (await operationCount(db, input.ownerUserId, input.now) >= 4096) {
      return { ok: false, reason: 'operation_limit' };
    }
    throw new Error('Build plan alert delete transaction failed.');
  }
  return { ok: true, replayed: false };
}
