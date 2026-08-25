import { BUILD_PLAN_LIMITS } from '../build-plan-limits.ts';
import type { D1DatabaseLike } from './pages-types.ts';
import { logServerError, type ServerErrorBoundary } from './safe-server-log.ts';

export type ApiErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_JSON'
  | 'AUTH_REQUIRED'
  | 'ORIGIN_FORBIDDEN'
  | 'PRO_REQUIRED'
  | 'RESOURCE_NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'VERSION_CONFLICT'
  | 'VERSION_LIMIT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'PLAN_LIMIT'
  | 'BODY_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'PLAN_INVALID'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE';

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    requestId: string;
    issues?: unknown[];
  };
}

const API_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  Vary: 'Authorization, Cookie',
};

export function withApiHeaders(response: Response, requestId?: string): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(API_HEADERS)) headers.set(name, value);
  if (requestId) headers.set('X-Request-Id', requestId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function apiJson(
  value: unknown,
  status = 200,
  extraHeaders?: HeadersInit,
): Response {
  const headers = new Headers(extraHeaders);
  for (const [name, headerValue] of Object.entries(API_HEADERS)) headers.set(name, headerValue);
  return new Response(JSON.stringify(value), { status, headers });
}

export function apiError(
  requestId: string,
  status: number,
  code: ApiErrorCode,
  message: string,
  options: { issues?: unknown[]; allow?: string; logBoundary?: ServerErrorBoundary } = {},
): Response {
  if (code === 'INTERNAL_ERROR') {
    logServerError(requestId, options.logBoundary ?? 'api_handler');
  }
  const body: ApiErrorBody = {
    error: {
      code,
      message,
      requestId,
      ...(options.issues ? { issues: options.issues } : {}),
    },
  };
  const headers = new Headers(options.allow ? { Allow: options.allow } : undefined);
  // Codes come from the closed ApiErrorCode union, giving same-origin clients a
  // stable signal without requiring them to consume or display server messages.
  headers.set('X-Error-Code', code);
  return apiJson(body, status, headers);
}

export const ACCOUNT_PLAN_RATE_LIMIT = 120;
export const ACCOUNT_PLAN_RATE_WINDOW_MS = 60_000;

/**
 * Consume one exact fixed-window request allowance after Clerk has verified the
 * stable owner ID. The UPSERT is one D1 statement, so concurrent requests cannot
 * read the same old count. One row per owner bounds storage independently of
 * request volume; there is no append-only request log.
 */
export async function enforceOwnerRateLimit(
  db: D1DatabaseLike | undefined,
  ownerUserId: string,
  requestId: string,
  nowMs = Date.now(),
): Promise<Response | null> {
  if (!db || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    return apiError(requestId, 503, 'SERVICE_UNAVAILABLE', 'Account plan storage is unavailable.');
  }
  const windowBucket = Math.floor(nowMs / ACCOUNT_PLAN_RATE_WINDOW_MS);
  try {
    const result = await db.prepare(
      `INSERT INTO build_plan_rate_limits (owner_user_id, window_bucket, request_count)
       VALUES (?, ?, 1)
       ON CONFLICT(owner_user_id) DO UPDATE SET
         window_bucket = excluded.window_bucket,
         request_count = CASE
           WHEN build_plan_rate_limits.window_bucket = excluded.window_bucket
             THEN build_plan_rate_limits.request_count + 1
           ELSE 1
         END
       WHERE build_plan_rate_limits.window_bucket < excluded.window_bucket
          OR (build_plan_rate_limits.window_bucket = excluded.window_bucket
              AND build_plan_rate_limits.request_count < ?)
       RETURNING request_count`,
    ).bind(ownerUserId, windowBucket, ACCOUNT_PLAN_RATE_LIMIT).all<{ request_count: number }>();
    if (result.success !== true || !Array.isArray(result.results)) {
      return apiError(requestId, 503, 'SERVICE_UNAVAILABLE', 'Account plan storage is unavailable.');
    }
    if (result.results.length === 0) {
      return apiError(requestId, 429, 'RATE_LIMITED', 'Too many account plan requests. Try again shortly.');
    }
    return result.results.length === 1
      && Number.isSafeInteger(result.results[0]?.request_count)
      && result.results[0].request_count >= 1
      && result.results[0].request_count <= ACCOUNT_PLAN_RATE_LIMIT
      ? null
      : apiError(requestId, 503, 'SERVICE_UNAVAILABLE', 'Account plan storage is unavailable.');
  } catch {
    logServerError(requestId, 'rate_limit');
    return apiError(requestId, 503, 'SERVICE_UNAVAILABLE', 'Account plan storage is unavailable.');
  }
}

export type BodyReadResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; response: Response };

function parseContentLength(value: string | null): number | null | 'invalid' {
  if (value === null) return null;
  if (!/^(0|[1-9]\d*)$/.test(value)) return 'invalid';
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 'invalid';
}

/**
 * Reads an untrusted plan body without request.text(), json(), or arrayBuffer().
 * One fixed-size allocation bounds memory even when Content-Length is absent or false.
 */
export async function readBoundedPlanBody(
  request: Request,
  requestId: string,
): Promise<BodyReadResult> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return { ok: false, response: apiError(requestId, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.') };
  }
  const encoding = request.headers.get('content-encoding')?.trim().toLowerCase();
  if (encoding && encoding !== 'identity') {
    return { ok: false, response: apiError(requestId, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Compressed request bodies are not accepted.') };
  }
  const declared = parseContentLength(request.headers.get('content-length'));
  if (declared === 'invalid') {
    return { ok: false, response: apiError(requestId, 400, 'INVALID_REQUEST', 'Content-Length is invalid.') };
  }
  if (declared !== null && declared > BUILD_PLAN_LIMITS.maxBodyBytes) {
    return { ok: false, response: apiError(requestId, 413, 'BODY_TOO_LARGE', 'Request body is too large.') };
  }
  if (!request.body) return { ok: true, bytes: new Uint8Array(0) };

  const buffer = new Uint8Array(BUILD_PLAN_LIMITS.maxBodyBytes);
  const reader = request.body.getReader();
  let offset = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = part.value;
      if (!(chunk instanceof Uint8Array) || chunk.byteLength > BUILD_PLAN_LIMITS.maxBodyBytes - offset) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, response: apiError(requestId, 413, 'BODY_TOO_LARGE', 'Request body is too large.') };
      }
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, response: apiError(requestId, 400, 'INVALID_REQUEST', 'Request body could not be read.') };
  } finally {
    reader.releaseLock();
  }
  if (declared !== null && declared !== offset) {
    return { ok: false, response: apiError(requestId, 400, 'INVALID_REQUEST', 'Content-Length does not match the request body.') };
  }
  return { ok: true, bytes: buffer.slice(0, offset) };
}

export function validateMutationBoundary(
  request: Request,
  requestId: string,
  authorizedParties: readonly string[],
): Response | null {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return null;
  const origin = request.headers.get('origin');
  if (!origin || !authorizedParties.includes(origin)) {
    return apiError(requestId, 403, 'ORIGIN_FORBIDDEN', 'Request origin is not allowed.');
  }
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite !== null && fetchSite !== 'same-origin') {
    return apiError(requestId, 403, 'ORIGIN_FORBIDDEN', 'Cross-site requests are not allowed.');
  }
  const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return apiError(requestId, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
  }
  const encoding = request.headers.get('content-encoding')?.trim().toLowerCase();
  if (encoding && encoding !== 'identity') {
    return apiError(requestId, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Compressed request bodies are not accepted.');
  }
  const length = parseContentLength(request.headers.get('content-length'));
  if (length === 'invalid') return apiError(requestId, 400, 'INVALID_REQUEST', 'Content-Length is invalid.');
  if (length !== null && length > BUILD_PLAN_LIMITS.maxBodyBytes) {
    return apiError(requestId, 413, 'BODY_TOO_LARGE', 'Request body is too large.');
  }
  return null;
}
