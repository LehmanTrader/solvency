import { models } from '../data.ts';
import { BUILD_PLAN_LIMITS, validateBuildPlanJson, type BuildPlanFailure } from '../build-plan-schema.ts';
import { apiError, apiJson, readBoundedPlanBody } from './api-http.ts';
import {
  appendOwnedBuildPlanVersion,
  createOwnedBuildPlan,
  deleteOwnedBuildPlan,
  getOwnedBuildPlan,
  listOwnedBuildPlans,
  MAX_BUILD_PLAN_VERSIONS,
  parseListLimit,
  sha256Hex,
  type StoreWriteResult,
} from './build-plan-store.ts';
import type { PagesContextLike } from './pages-types.ts';

const PLAN_ID = /^plan_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/;

function requestId(context: PagesContextLike): string {
  return context.data.requestId ?? crypto.randomUUID();
}

function owner(context: PagesContextLike): string | null {
  return context.data.ownerUserId ?? null;
}

function routePlanId(context: PagesContextLike): string | null {
  const raw = context.params.planId;
  return typeof raw === 'string' && PLAN_ID.test(raw) ? raw : null;
}

function idempotencyKey(request: Request): string | null {
  const value = request.headers.get('idempotency-key');
  return value && IDEMPOTENCY_KEY.test(value) ? value : null;
}

function expectedVersion(request: Request): number | null {
  const value = request.headers.get('if-match');
  const match = value && /^"([1-9]\d*)"$/.exec(value);
  if (!match) return null;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) && version <= MAX_BUILD_PLAN_VERSIONS ? version : null;
}

function requestedVersion(url: URL): number | null | 'invalid' {
  const raw = url.searchParams.get('version');
  if (raw === null) return null;
  if (!/^[1-9]\d*$/.test(raw)) return 'invalid';
  const value = Number(raw);
  return Number.isSafeInteger(value) && value <= MAX_BUILD_PLAN_VERSIONS ? value : 'invalid';
}

function planFailureResponse(requestIdValue: string, failure: BuildPlanFailure): Response {
  const codes = new Set(failure.issues.map((issue) => issue.code));
  if (codes.has('BODY_TOO_LARGE')) {
    return apiError(requestIdValue, 413, 'BODY_TOO_LARGE', 'Request body is too large.');
  }
  if (codes.has('INVALID_JSON') || codes.has('INVALID_UTF8') || codes.has('TOO_DEEP')) {
    return apiError(requestIdValue, 400, 'INVALID_JSON', 'Request body is not valid plan JSON.');
  }
  return apiError(requestIdValue, 422, 'PLAN_INVALID', 'Build plan is invalid.', {
    issues: failure.issues.slice(0, BUILD_PLAN_LIMITS.maxIssues),
  });
}

function writeResultResponse(requestIdValue: string, result: StoreWriteResult): Response {
  if (!result.ok) {
    if (result.reason === 'not_found') {
      return apiError(requestIdValue, 404, 'RESOURCE_NOT_FOUND', 'Build plan was not found.');
    }
    if (result.reason === 'idempotency_conflict') {
      return apiError(requestIdValue, 409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for different content.');
    }
    if (result.reason === 'plan_limit') {
      return apiError(requestIdValue, 409, 'PLAN_LIMIT', 'Account plan storage limit has been reached.');
    }
    if (result.reason === 'version_limit') {
      return apiError(requestIdValue, 409, 'VERSION_LIMIT', 'Build plan version limit has been reached.');
    }
    return apiError(requestIdValue, 409, 'VERSION_CONFLICT', 'Build plan changed since it was loaded.');
  }
  return apiJson(
    { data: result.resource },
    result.replayed ? 200 : 201,
    { 'Idempotency-Replayed': result.replayed ? 'true' : 'false' },
  );
}

async function validateRequestPlan(context: PagesContextLike): Promise<
  | { ok: true; value: ReturnType<typeof validateBuildPlanJson> & { ok: true }; bytes: Uint8Array; now: string }
  | { ok: false; response: Response }
> {
  const id = requestId(context);
  const body = await readBoundedPlanBody(context.request, id);
  if (!body.ok) return body;
  const now = new Date().toISOString();
  const validated = validateBuildPlanJson(body.bytes, models, now);
  if (!validated.ok) return { ok: false, response: planFailureResponse(id, validated) };
  return { ok: true, value: validated, bytes: body.bytes, now };
}

export async function handleBuildPlanCollection(context: PagesContextLike): Promise<Response> {
  const id = requestId(context);
  const ownerUserId = owner(context);
  if (!ownerUserId || !context.env.DB) return apiError(id, 503, 'SERVICE_UNAVAILABLE', 'Account plan storage is unavailable.');

  if (context.request.method === 'GET') {
    const url = new URL(context.request.url);
    const limit = parseListLimit(url.searchParams.get('limit'));
    if (limit === 'invalid' || [...url.searchParams.keys()].some((key) => !['limit', 'cursor'].includes(key))) {
      return apiError(id, 400, 'INVALID_REQUEST', 'List parameters are invalid.');
    }
    try {
      const result = await listOwnedBuildPlans(context.env.DB, ownerUserId, {
        limit,
        cursor: url.searchParams.get('cursor'),
      });
      if (result === 'invalid_cursor') return apiError(id, 400, 'INVALID_REQUEST', 'List cursor is invalid.');
      return apiJson({ data: result.plans, nextCursor: result.nextCursor });
    } catch {
      return apiError(id, 500, 'INTERNAL_ERROR', 'Account plans could not be loaded.');
    }
  }

  if (context.request.method === 'POST') {
    const key = idempotencyKey(context.request);
    if (!key) return apiError(id, 400, 'INVALID_REQUEST', 'A valid Idempotency-Key header is required.');
    const parsed = await validateRequestPlan(context);
    if (!parsed.ok) return parsed.response;
    const canonicalPlan = JSON.stringify(parsed.value.value);
    const requestHash = await sha256Hex(`create\n${canonicalPlan}`);
    try {
      return writeResultResponse(id, await createOwnedBuildPlan(context.env.DB, {
        ownerUserId,
        idempotencyKey: key,
        requestHash,
        planId: `plan_${crypto.randomUUID()}`,
        versionId: `version_${crypto.randomUUID()}`,
        plan: parsed.value.value,
        quote: parsed.value.quote,
        now: parsed.now,
      }));
    } catch {
      return apiError(id, 500, 'INTERNAL_ERROR', 'Build plan could not be saved.');
    }
  }

  return apiError(id, 405, 'METHOD_NOT_ALLOWED', 'Method is not allowed.', { allow: 'GET, POST' });
}

export async function handleBuildPlanResource(context: PagesContextLike): Promise<Response> {
  const id = requestId(context);
  const ownerUserId = owner(context);
  if (!ownerUserId || !context.env.DB) return apiError(id, 503, 'SERVICE_UNAVAILABLE', 'Account plan storage is unavailable.');
  const planId = routePlanId(context);
  if (!planId) return apiError(id, 404, 'RESOURCE_NOT_FOUND', 'Build plan was not found.');

  if (context.request.method === 'GET') {
    const url = new URL(context.request.url);
    const version = requestedVersion(url);
    if (version === 'invalid' || [...url.searchParams.keys()].some((key) => key !== 'version')) {
      return apiError(id, 400, 'INVALID_REQUEST', 'Requested version is invalid.');
    }
    try {
      const resource = await getOwnedBuildPlan(context.env.DB, ownerUserId, planId, version ?? undefined);
      return resource
        ? apiJson({ data: resource })
        : apiError(id, 404, 'RESOURCE_NOT_FOUND', 'Build plan was not found.');
    } catch {
      return apiError(id, 500, 'INTERNAL_ERROR', 'Build plan could not be loaded.');
    }
  }

  if (context.request.method === 'DELETE') {
    const expected = expectedVersion(context.request);
    if (expected === null) return apiError(id, 400, 'INVALID_REQUEST', 'If-Match with the current quoted version is required.');
    try {
      const result = await deleteOwnedBuildPlan(context.env.DB, ownerUserId, planId, expected);
      if (result === 'not_found') return apiError(id, 404, 'RESOURCE_NOT_FOUND', 'Build plan was not found.');
      if (result === 'version_conflict') return apiError(id, 409, 'VERSION_CONFLICT', 'Build plan changed since it was loaded.');
      return apiJson({ data: { deleted: true, planId } });
    } catch {
      return apiError(id, 500, 'INTERNAL_ERROR', 'Build plan could not be deleted.');
    }
  }

  return apiError(id, 405, 'METHOD_NOT_ALLOWED', 'Method is not allowed.', { allow: 'GET, DELETE' });
}

export async function handleBuildPlanVersions(context: PagesContextLike): Promise<Response> {
  const id = requestId(context);
  const ownerUserId = owner(context);
  if (!ownerUserId || !context.env.DB) return apiError(id, 503, 'SERVICE_UNAVAILABLE', 'Account plan storage is unavailable.');
  if (context.request.method !== 'POST') {
    return apiError(id, 405, 'METHOD_NOT_ALLOWED', 'Method is not allowed.', { allow: 'POST' });
  }
  const planId = routePlanId(context);
  if (!planId) return apiError(id, 404, 'RESOURCE_NOT_FOUND', 'Build plan was not found.');
  const key = idempotencyKey(context.request);
  const expected = expectedVersion(context.request);
  if (!key) return apiError(id, 400, 'INVALID_REQUEST', 'A valid Idempotency-Key header is required.');
  if (expected === null) return apiError(id, 400, 'INVALID_REQUEST', 'If-Match with the current quoted version is required.');
  const parsed = await validateRequestPlan(context);
  if (!parsed.ok) return parsed.response;
  const canonicalPlan = JSON.stringify(parsed.value.value);
  const requestHash = await sha256Hex(`append\n${planId}\n${expected}\n${canonicalPlan}`);
  try {
    return writeResultResponse(id, await appendOwnedBuildPlanVersion(context.env.DB, {
      ownerUserId,
      planId,
      expectedVersion: expected,
      idempotencyKey: key,
      requestHash,
      versionId: `version_${crypto.randomUUID()}`,
      plan: parsed.value.value,
      quote: parsed.value.quote,
      now: parsed.now,
    }));
  } catch {
    return apiError(id, 500, 'INTERNAL_ERROR', 'Build plan version could not be saved.');
  }
}
