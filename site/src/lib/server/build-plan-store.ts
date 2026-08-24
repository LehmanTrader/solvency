import type { BuildPlanV1, BuildQuoteV1 } from '../build-cost.ts';
import type { D1DatabaseLike } from './pages-types.ts';

const MAX_LIST_LIMIT = 50;
const MAX_VERSION_SUMMARIES = 100;
export const MAX_OWNED_BUILD_PLANS = 20;
export const MAX_BUILD_PLAN_VERSIONS = 100;

interface PlanRow {
  id: string;
  display_name: string;
  current_version: number;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  id: string;
  plan_id: string;
  version: number;
  plan_name: string;
  plan_schema_version: number;
  quote_engine_version: string;
  plan_json: string;
  quote_json: string;
  quoted_at: string;
  created_at: string;
}

interface VersionSummaryRow {
  id: string;
  version: number;
  plan_name: string;
  quote_engine_version: string;
  quoted_at: string;
  created_at: string;
}

interface RequestRow {
  request_hash: string;
  plan_id: string;
  version: number;
}

export interface BuildPlanSummary {
  id: string;
  name: string;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface BuildPlanVersionSummary {
  id: string;
  version: number;
  name: string;
  engineVersion: string;
  quotedAt: string;
  createdAt: string;
}

export interface StoredBuildPlanVersion extends BuildPlanVersionSummary {
  planId: string;
  plan: BuildPlanV1;
  quote: BuildQuoteV1;
}

export interface OwnedBuildPlan {
  plan: BuildPlanSummary;
  versions: BuildPlanVersionSummary[];
  selectedVersion: StoredBuildPlanVersion;
}

export type StoreWriteResult =
  | { ok: true; replayed: boolean; resource: OwnedBuildPlan }
  | { ok: false; reason: 'not_found' | 'version_conflict' | 'version_limit' | 'idempotency_conflict' | 'plan_limit' };

const planSummary = (row: PlanRow): BuildPlanSummary => ({
  id: row.id,
  name: row.display_name,
  currentVersion: row.current_version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const versionSummary = (row: VersionSummaryRow): BuildPlanVersionSummary => ({
  id: row.id,
  version: row.version,
  name: row.plan_name,
  engineVersion: row.quote_engine_version,
  quotedAt: row.quoted_at,
  createdAt: row.created_at,
});

function storedVersion(row: VersionRow): StoredBuildPlanVersion {
  return {
    ...versionSummary(row),
    planId: row.plan_id,
    plan: JSON.parse(row.plan_json) as BuildPlanV1,
    quote: JSON.parse(row.quote_json) as BuildQuoteV1,
  };
}

function encodeCursor(row: PlanRow): string {
  return btoa(`${row.updated_at}\n${row.id}`).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeCursor(cursor: string | null): { updatedAt: string; id: string } | null | 'invalid' {
  if (cursor === null) return null;
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(cursor)) return 'invalid';
  try {
    const base64 = cursor.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(cursor.length / 4) * 4, '=');
    const [updatedAt, id, ...rest] = atob(base64).split('\n');
    if (rest.length || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(updatedAt)
      || !/^plan_[0-9a-f-]{36}$/.test(id)) return 'invalid';
    return { updatedAt, id };
  } catch {
    return 'invalid';
  }
}

export function parseListLimit(raw: string | null): number | 'invalid' {
  if (raw === null) return 20;
  if (!/^[1-9]\d*$/.test(raw)) return 'invalid';
  const value = Number(raw);
  return Number.isSafeInteger(value) && value <= MAX_LIST_LIMIT ? value : 'invalid';
}

export async function listOwnedBuildPlans(
  db: D1DatabaseLike,
  ownerUserId: string,
  options: { limit: number; cursor: string | null },
): Promise<{ plans: BuildPlanSummary[]; nextCursor: string | null } | 'invalid_cursor'> {
  const cursor = decodeCursor(options.cursor);
  if (cursor === 'invalid') return 'invalid_cursor';
  const query = cursor
    ? `SELECT id, display_name, current_version, created_at, updated_at
         FROM build_plans
        WHERE owner_user_id = ?
          AND (updated_at < ? OR (updated_at = ? AND id < ?))
        ORDER BY updated_at DESC, id DESC
        LIMIT ?`
    : `SELECT id, display_name, current_version, created_at, updated_at
         FROM build_plans
        WHERE owner_user_id = ?
        ORDER BY updated_at DESC, id DESC
        LIMIT ?`;
  const statement = cursor
    ? db.prepare(query).bind(ownerUserId, cursor.updatedAt, cursor.updatedAt, cursor.id, options.limit + 1)
    : db.prepare(query).bind(ownerUserId, options.limit + 1);
  const result = await statement.all<PlanRow>();
  const rows = result.results ?? [];
  const hasMore = rows.length > options.limit;
  const visible = rows.slice(0, options.limit);
  return {
    plans: visible.map(planSummary),
    nextCursor: hasMore && visible.length ? encodeCursor(visible[visible.length - 1]) : null,
  };
}

async function ownedPlanRow(db: D1DatabaseLike, ownerUserId: string, planId: string): Promise<PlanRow | null> {
  return db.prepare(
    `SELECT id, display_name, current_version, created_at, updated_at
       FROM build_plans
      WHERE id = ? AND owner_user_id = ?`,
  ).bind(planId, ownerUserId).first<PlanRow>();
}

async function ownedVersionRow(
  db: D1DatabaseLike,
  ownerUserId: string,
  planId: string,
  version: number,
): Promise<VersionRow | null> {
  return db.prepare(
    `SELECT v.id, v.plan_id, v.version, v.plan_name, v.plan_schema_version,
            v.quote_engine_version, v.plan_json, v.quote_json, v.quoted_at, v.created_at
       FROM build_plan_versions v
       JOIN build_plans p ON p.id = v.plan_id
      WHERE p.id = ? AND p.owner_user_id = ? AND v.version = ?`,
  ).bind(planId, ownerUserId, version).first<VersionRow>();
}

export async function getOwnedBuildPlan(
  db: D1DatabaseLike,
  ownerUserId: string,
  planId: string,
  selectedVersion?: number,
): Promise<OwnedBuildPlan | null> {
  const plan = await ownedPlanRow(db, ownerUserId, planId);
  if (!plan) return null;
  const version = selectedVersion ?? plan.current_version;
  const [selected, summaries] = await Promise.all([
    ownedVersionRow(db, ownerUserId, planId, version),
    db.prepare(
      `SELECT v.id, v.version, v.plan_name, v.quote_engine_version, v.quoted_at, v.created_at
         FROM build_plan_versions v
         JOIN build_plans p ON p.id = v.plan_id
        WHERE p.id = ? AND p.owner_user_id = ?
        ORDER BY v.version DESC
        LIMIT ?`,
    ).bind(planId, ownerUserId, MAX_VERSION_SUMMARIES).all<VersionSummaryRow>(),
  ]);
  if (!selected) return null;
  return {
    plan: planSummary(plan),
    versions: (summaries.results ?? []).map(versionSummary),
    selectedVersion: storedVersion(selected),
  };
}

async function priorRequest(
  db: D1DatabaseLike,
  ownerUserId: string,
  operation: string,
  idempotencyKey: string,
): Promise<RequestRow | null> {
  return db.prepare(
    `SELECT request_hash, plan_id, version
       FROM build_plan_requests
      WHERE owner_user_id = ? AND operation = ? AND idempotency_key = ?`,
  ).bind(ownerUserId, operation, idempotencyKey).first<RequestRow>();
}

async function replayResult(
  db: D1DatabaseLike,
  ownerUserId: string,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<StoreWriteResult | null> {
  const previous = await priorRequest(db, ownerUserId, operation, idempotencyKey);
  if (!previous) return null;
  if (previous.request_hash !== requestHash) return { ok: false, reason: 'idempotency_conflict' };
  const resource = await getOwnedBuildPlan(db, ownerUserId, previous.plan_id, previous.version);
  if (!resource) throw new Error('Idempotency record points to a missing owned plan version.');
  return { ok: true, replayed: true, resource };
}

export async function createOwnedBuildPlan(
  db: D1DatabaseLike,
  input: {
    ownerUserId: string;
    idempotencyKey: string;
    requestHash: string;
    planId: string;
    versionId: string;
    plan: BuildPlanV1;
    quote: BuildQuoteV1;
    now: string;
  },
): Promise<StoreWriteResult> {
  const operation = 'create';
  const replay = await replayResult(db, input.ownerUserId, operation, input.idempotencyKey, input.requestHash);
  if (replay) return replay;
  try {
    const results = await db.batch([
      db.prepare(
        `INSERT INTO build_plans
           (id, owner_user_id, display_name, current_version, created_at, updated_at)
         SELECT ?, ?, ?, 0, ?, ?
          WHERE (SELECT COUNT(*) FROM build_plans WHERE owner_user_id = ?) < ?`,
      ).bind(
        input.planId, input.ownerUserId, input.plan.name, input.now, input.now,
        input.ownerUserId, MAX_OWNED_BUILD_PLANS,
      ),
      db.prepare(
        `INSERT INTO build_plan_versions
           (id, plan_id, version, plan_name, plan_schema_version, quote_engine_version,
            plan_json, quote_json, quoted_at, created_at)
         SELECT ?, p.id, 1, ?, 1, ?, ?, ?, ?, ?
           FROM build_plans p
          WHERE p.id = ? AND p.owner_user_id = ?`,
      ).bind(
        input.versionId, input.plan.name, input.quote.engineVersion,
        JSON.stringify(input.plan), JSON.stringify(input.quote), input.quote.quotedAt, input.now,
        input.planId, input.ownerUserId,
      ),
      db.prepare(
        `INSERT INTO build_plan_requests
           (owner_user_id, operation, idempotency_key, request_hash, plan_id, version, created_at)
         SELECT ?, ?, ?, ?, v.plan_id, v.version, ?
           FROM build_plan_versions v
          WHERE v.id = ?`,
      ).bind(input.ownerUserId, operation, input.idempotencyKey, input.requestHash, input.now, input.versionId),
    ]);
    if ((results[0]?.meta?.changes ?? 0) !== 1) return { ok: false, reason: 'plan_limit' };
  } catch {
    const raced = await replayResult(db, input.ownerUserId, operation, input.idempotencyKey, input.requestHash);
    if (raced) return raced;
    throw new Error('Build plan create transaction failed.');
  }
  const resource = await getOwnedBuildPlan(db, input.ownerUserId, input.planId, 1);
  if (!resource) throw new Error('Created build plan could not be read.');
  return { ok: true, replayed: false, resource };
}

export async function appendOwnedBuildPlanVersion(
  db: D1DatabaseLike,
  input: {
    ownerUserId: string;
    planId: string;
    expectedVersion: number;
    idempotencyKey: string;
    requestHash: string;
    versionId: string;
    plan: BuildPlanV1;
    quote: BuildQuoteV1;
    now: string;
  },
): Promise<StoreWriteResult> {
  const operation = `append:${input.planId}`;
  const replay = await replayResult(db, input.ownerUserId, operation, input.idempotencyKey, input.requestHash);
  if (replay) return replay;
  if (input.expectedVersion >= MAX_BUILD_PLAN_VERSIONS) {
    const owned = await ownedPlanRow(db, input.ownerUserId, input.planId);
    if (!owned) return { ok: false, reason: 'not_found' };
    return owned.current_version === input.expectedVersion
      ? { ok: false, reason: 'version_limit' }
      : { ok: false, reason: 'version_conflict' };
  }
  let results;
  try {
    results = await db.batch([
      db.prepare(
        `INSERT INTO build_plan_versions
           (id, plan_id, version, plan_name, plan_schema_version, quote_engine_version,
            plan_json, quote_json, quoted_at, created_at)
         SELECT ?, p.id, p.current_version + 1, ?, 1, ?, ?, ?, ?, ?
           FROM build_plans p
          WHERE p.id = ? AND p.owner_user_id = ? AND p.current_version = ?`,
      ).bind(
        input.versionId, input.plan.name, input.quote.engineVersion,
        JSON.stringify(input.plan), JSON.stringify(input.quote), input.quote.quotedAt, input.now,
        input.planId, input.ownerUserId, input.expectedVersion,
      ),
      db.prepare(
        `INSERT INTO build_plan_requests
           (owner_user_id, operation, idempotency_key, request_hash, plan_id, version, created_at)
         SELECT ?, ?, ?, ?, v.plan_id, v.version, ?
           FROM build_plan_versions v
          WHERE v.id = ?`,
      ).bind(input.ownerUserId, operation, input.idempotencyKey, input.requestHash, input.now, input.versionId),
    ]);
  } catch {
    const raced = await replayResult(db, input.ownerUserId, operation, input.idempotencyKey, input.requestHash);
    if (raced) return raced;
    throw new Error('Build plan version transaction failed.');
  }
  const inserted = results[0]?.meta?.changes ?? 0;
  if (inserted !== 1) {
    const owned = await ownedPlanRow(db, input.ownerUserId, input.planId);
    return owned ? { ok: false, reason: 'version_conflict' } : { ok: false, reason: 'not_found' };
  }
  const resource = await getOwnedBuildPlan(db, input.ownerUserId, input.planId, input.expectedVersion + 1);
  if (!resource) throw new Error('Created build plan version could not be read.');
  return { ok: true, replayed: false, resource };
}

export async function deleteOwnedBuildPlan(
  db: D1DatabaseLike,
  ownerUserId: string,
  planId: string,
  expectedVersion: number,
): Promise<'deleted' | 'not_found' | 'version_conflict'> {
  const result = await db.prepare(
    `DELETE FROM build_plans
      WHERE id = ? AND owner_user_id = ? AND current_version = ?`,
  ).bind(planId, ownerUserId, expectedVersion).run();
  if ((result.meta?.changes ?? 0) === 1) return 'deleted';
  return await ownedPlanRow(db, ownerUserId, planId) ? 'version_conflict' : 'not_found';
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
