import { apiJson } from './api-http.ts';
import { sha256Hex } from './build-plan-store.ts';
import { ownerHasActivePro } from './entitlement-api.ts';
import {
  createOwnedBuildPlanAlert,
  createOwnedBuildPlanShare,
  deleteOwnedBuildPlanAlert,
  getPublicSharedBuildPlan,
  listOwnedBuildPlanAlerts,
  listOwnedBuildPlanShares,
  revokeOwnedBuildPlanShare,
  updateOwnedBuildPlanAlert,
  type BuildAlertTrigger,
  type OperationDeleteResult,
  type OperationFailureReason,
  type OperationMutationResult,
} from './build-plan-operations-store.ts';
import { recordServerConfirmedProductIntent } from './product-intent-api.ts';
import type { PagesContextLike } from './pages-types.ts';
import { logServerError } from './safe-server-log.ts';

const OPERATION_BODY_LIMIT = 4 * 1024;
const OPERATION_RESPONSE_LIMIT = 512 * 1024;
const PLAN_ID = /^plan_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHARE_ID = /^share_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ALERT_ID = /^alert_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/;
const SHARE_TOKEN = /^sv1_[A-Za-z0-9_-]{43}$/;
const SHARE_SECRET = /^[A-Za-z0-9_-]{43,128}$/;
const ALERT_TRIGGERS = new Set<BuildAlertTrigger>([
  'model_price_change',
  'monthly_spend_above',
  'monthly_spend_change_percent',
  'baseline_delta_percent',
]);

type OperationErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_JSON'
  | 'RESOURCE_NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'DUPLICATE_RESOURCE'
  | 'PRO_REQUIRED'
  | 'SHARE_LIMIT'
  | 'ALERT_LIMIT'
  | 'OPERATION_LIMIT'
  | 'RESOURCE_STATE_CHANGED'
  | 'EXPORT_FORBIDDEN'
  | 'BODY_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE';

interface ShareBody {
  version: number;
  expiresInDays: 7 | 30 | null;
  allowQuoteExport: boolean;
}

interface AlertBody {
  version: number;
  trigger: BuildAlertTrigger;
  threshold: number | null;
  baselineVersion: number | null;
}

function requestId(context: PagesContextLike): string {
  return context.data.requestId ?? crypto.randomUUID();
}

function operationError(
  id: string,
  status: number,
  code: OperationErrorCode,
  message: string,
  allow?: string,
): Response {
  if (code === 'INTERNAL_ERROR') logServerError(id, 'build_plan_operations');
  return apiJson({ error: { code, message, requestId: id } }, status, {
    'X-Error-Code': code,
    'X-Request-Id': id,
    ...(allow ? { Allow: allow } : {}),
  });
}

function boundedOperationJson(id: string, value: unknown, status = 200, headers?: HeadersInit): Response {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return operationError(id, 500, 'INTERNAL_ERROR', 'Response could not be created.');
  }
  if (new TextEncoder().encode(serialized).byteLength > OPERATION_RESPONSE_LIMIT) {
    return operationError(id, 500, 'INTERNAL_ERROR', 'Response exceeded its safe size limit.');
  }
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Cache-Control', 'no-store');
  responseHeaders.set('Content-Type', 'application/json; charset=utf-8');
  responseHeaders.set('Cross-Origin-Resource-Policy', 'same-origin');
  responseHeaders.set('Referrer-Policy', 'no-referrer');
  responseHeaders.set('X-Content-Type-Options', 'nosniff');
  responseHeaders.set('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  responseHeaders.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  responseHeaders.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  responseHeaders.set('Vary', 'Authorization, Cookie');
  responseHeaders.set('X-Request-Id', id);
  return new Response(serialized, { status, headers: responseHeaders });
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function money(value: number | null): string {
  return value === null ? 'Not available' : `$${value.toLocaleString('en-US', { maximumFractionDigits: 6 })}`;
}

function safeHttpsHref(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function priceBasisLabel(basis: 'catalog_list' | 'contract' | 'user_supplied'): string {
  if (basis === 'catalog_list') return 'Catalog list price';
  if (basis === 'contract') return 'User-entered contract rate';
  return 'User-entered custom rate';
}

function sharedPlanHtml(resource: Awaited<ReturnType<typeof getPublicSharedBuildPlan>>, downloadPath: string): string {
  if (!resource) throw new Error('Shared plan is missing.');
  const roleRows = resource.quote.roles.map((role) => `
          <tr>
            <td>${escapeHtml(role.label)}</td>
            <td>${escapeHtml(role.kind)}</td>
            <td>${escapeHtml(role.modelName)}</td>
            <td>${escapeHtml(role.expectedInvocations)}</td>
            <td>${escapeHtml(money(role.costPerBuildAttemptUsd))}</td>
          </tr>`).join('');
  const priceProvenance = resource.quote.roles.map((role) => {
    const source = safeHttpsHref(role.priceSourceUrl);
    const evidence = source && role.priceLastVerified
      ? `<a href="${escapeHtml(source)}" rel="noopener noreferrer">Price source</a> · verified ${escapeHtml(role.priceLastVerified)}`
      : role.priceBasis === 'catalog_list'
        ? 'No external price source or verification date is available in this stored quote.'
        : 'No external source or verification date; this rate was entered by the plan owner.';
    return `<li><strong>${escapeHtml(role.label)} · ${escapeHtml(role.modelName)}</strong><br>${escapeHtml(priceBasisLabel(role.priceBasis))} · ${evidence}</li>`;
  }).join('');
  const harnessSource = safeHttpsHref(resource.plan.harness.sourceUrl);
  const harnessEvidence = harnessSource && resource.plan.harness.lastVerified
    ? `<a href="${escapeHtml(harnessSource)}" rel="noopener noreferrer">Harness source</a> · verified ${escapeHtml(resource.plan.harness.lastVerified)}`
    : 'User-entered or template harness configuration and fixed costs; no external source or verification date is attached.';
  const exportLink = resource.policy.allowQuoteExport
    ? `<a class="button" href="${escapeHtml(downloadPath)}">Download plan and quote JSON</a>`
    : '<p class="muted">The owner disabled quote export for this link.</p>';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>${escapeHtml(resource.plan.name)} · shared Solvency build plan</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; background: #10100f; color: #f0eee8; }
    main { width: min(70rem, calc(100% - 2rem)); margin: 3rem auto; }
    .eyebrow { color: #d4a64a; font: 700 .75rem ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
    h1 { font-size: clamp(2rem, 6vw, 4rem); margin: .5rem 0; overflow-wrap: anywhere; }
    .muted { color: #b7b3aa; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: 1px; background: #484641; margin: 2rem 0; }
    .metric { background: #191918; padding: 1rem; }
    .metric strong { display: block; font-size: 1.4rem; margin-top: .35rem; overflow-wrap: anywhere; }
    .table-wrap { overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; min-width: 44rem; }
    th, td { border-bottom: 1px solid #484641; padding: .8rem; text-align: left; overflow-wrap: anywhere; }
    th { color: #b7b3aa; font-size: .75rem; text-transform: uppercase; }
    .button { display: inline-block; margin-top: 1.5rem; padding: .75rem 1rem; background: #d4a64a; color: #10100f; font-weight: 700; text-decoration: none; }
    .provenance li { margin: .8rem 0; }
    a { color: #e6be6b; }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">Unlisted · view only · immutable quote</p>
    <h1>${escapeHtml(resource.plan.name)}</h1>
    <p class="muted">Harness: ${escapeHtml(resource.plan.harness.name)}${resource.plan.harness.version ? ` · ${escapeHtml(resource.plan.harness.version)}` : ''}. Quoted ${escapeHtml(resource.quote.quotedAt)} with ${escapeHtml(resource.quote.engineVersion)}.</p>
    <section class="grid" aria-label="Quote totals">
      <div class="metric"><span class="muted">Per build attempt</span><strong>${escapeHtml(money(resource.quote.buildAttemptCostUsd))}</strong></div>
      <div class="metric"><span class="muted">Per completed build</span><strong>${escapeHtml(money(resource.quote.variableCostPerSuccessfulBuildUsd))}</strong></div>
      <div class="metric"><span class="muted">Monthly</span><strong>${escapeHtml(money(resource.quote.monthlyCostUsd))}</strong></div>
      <div class="metric"><span class="muted">Builds / month</span><strong>${escapeHtml(resource.plan.workload.buildsPerMonth)}</strong></div>
    </section>
    <p class="muted">Totals sum the immutable role-rate ledger below and the plan's harness fixed costs using the assumptions quoted at ${escapeHtml(resource.quote.quotedAt)}. Assumptions and list or user-entered rates can differ from actual usage, discounts, taxes and spend.</p>
    <h2>Model roles</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Role</th><th>Kind</th><th>Model</th><th>Calls / attempt</th><th>Cost / attempt</th></tr></thead>
        <tbody>${roleRows}</tbody>
      </table>
    </div>
    <section class="provenance" aria-labelledby="provenance-title">
      <h2 id="provenance-title">Price and assumption provenance</h2>
      <ul>${priceProvenance}</ul>
      <p><strong>Harness · ${escapeHtml(resource.plan.harness.name)}</strong><br>${harnessEvidence}</p>
    </section>
    ${exportLink}
  </main>
</body>
</html>`;
}

function sharedPlanHtmlResponse(id: string, html: string): Response {
  if (new TextEncoder().encode(html).byteLength > OPERATION_RESPONSE_LIMIT) {
    return operationError(id, 500, 'INTERNAL_ERROR', 'Response exceeded its safe size limit.');
  }
  return new Response(html, {
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'Referrer-Policy': 'no-referrer',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'X-Content-Type-Options': 'nosniff',
      'X-Request-Id': id,
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
    },
  });
}

function routeParam(context: PagesContextLike, name: string, pattern: RegExp): string | null {
  const value = context.params[name];
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

function ownerAndPlan(context: PagesContextLike): { ownerUserId: string; planId: string } | null {
  const ownerUserId = context.data.ownerUserId;
  const planId = routeParam(context, 'planId', PLAN_ID);
  return ownerUserId && planId ? { ownerUserId, planId } : null;
}

function idempotencyKey(request: Request): string | null {
  const value = request.headers.get('idempotency-key');
  return value && IDEMPOTENCY_KEY.test(value) ? value : null;
}

/**
 * Gates a mutating account-plan-operation endpoint (share creation,
 * alert-settings save) behind an active Pro entitlement. Read (list) and
 * delete/revoke handlers must never call this — a lapsed subscriber keeps
 * read and delete access to data they already own.
 */
async function requireProForMutation(
  context: PagesContextLike,
  requestIdValue: string,
  ownerUserId: string,
): Promise<Response | null> {
  const active = await ownerHasActivePro(context.env.DB, ownerUserId, context.env);
  return active
    ? null
    : operationError(requestIdValue, 403, 'PRO_REQUIRED', 'An active Pro subscription is required for this action.');
}

function noQueryParameters(request: Request): boolean {
  return [...new URL(request.url).searchParams.keys()].length === 0;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length <= allowed.length && keys.every((key) => allowed.includes(key));
}

function validVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 100;
}

async function readOperationJson(
  request: Request,
  id: string,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return { ok: false, response: operationError(id, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.') };
  }
  const encoding = request.headers.get('content-encoding')?.trim().toLowerCase();
  if (encoding && encoding !== 'identity') {
    return { ok: false, response: operationError(id, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Compressed request bodies are not accepted.') };
  }
  const lengthText = request.headers.get('content-length');
  if (lengthText !== null && !/^(0|[1-9]\d*)$/.test(lengthText)) {
    return { ok: false, response: operationError(id, 400, 'INVALID_REQUEST', 'Content-Length is invalid.') };
  }
  const declaredLength = lengthText === null ? null : Number(lengthText);
  if (declaredLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength > OPERATION_BODY_LIMIT)) {
    return { ok: false, response: operationError(id, 413, 'BODY_TOO_LARGE', 'Request body is too large.') };
  }
  if (!request.body) return { ok: false, response: operationError(id, 400, 'INVALID_JSON', 'A JSON object is required.') };

  const buffer = new Uint8Array(OPERATION_BODY_LIMIT);
  const reader = request.body.getReader();
  let offset = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array) || part.value.byteLength > OPERATION_BODY_LIMIT - offset) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, response: operationError(id, 413, 'BODY_TOO_LARGE', 'Request body is too large.') };
      }
      buffer.set(part.value, offset);
      offset += part.value.byteLength;
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, response: operationError(id, 400, 'INVALID_REQUEST', 'Request body could not be read.') };
  } finally {
    reader.releaseLock();
  }
  if (declaredLength !== null && declaredLength !== offset) {
    return { ok: false, response: operationError(id, 400, 'INVALID_REQUEST', 'Content-Length does not match the request body.') };
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: operationError(id, 400, 'INVALID_JSON', 'Request body must be valid UTF-8 JSON.') };
  }
}

function parseShareBody(value: unknown): ShareBody | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (!exactKeys(body, ['version', 'expiresInDays', 'allowQuoteExport'])
    || !Object.hasOwn(body, 'version') || !Object.hasOwn(body, 'expiresInDays')
    || !Object.hasOwn(body, 'allowQuoteExport') || !validVersion(body.version)
    || ![7, 30, null].includes(body.expiresInDays as never)
    || typeof body.allowQuoteExport !== 'boolean') return null;
  return {
    version: body.version,
    expiresInDays: body.expiresInDays as 7 | 30 | null,
    allowQuoteExport: body.allowQuoteExport,
  };
}

function parseAlertBody(value: unknown): AlertBody | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (!exactKeys(body, ['version', 'trigger', 'threshold', 'baselineVersion'])
    || !Object.hasOwn(body, 'version') || !Object.hasOwn(body, 'trigger')
    || !validVersion(body.version) || typeof body.trigger !== 'string'
    || !ALERT_TRIGGERS.has(body.trigger as BuildAlertTrigger)) return null;

  const trigger = body.trigger as BuildAlertTrigger;
  const threshold = Object.hasOwn(body, 'threshold') ? body.threshold : null;
  const baselineVersion = Object.hasOwn(body, 'baselineVersion') ? body.baselineVersion : null;
  if (trigger === 'model_price_change') {
    if (threshold !== null || baselineVersion !== null) return null;
  } else if (typeof threshold !== 'number' || !Number.isFinite(threshold)
    || Object.is(threshold, -0) || threshold <= 0 || threshold > 1_000_000_000) {
    return null;
  }
  if (trigger === 'baseline_delta_percent') {
    if (!validVersion(baselineVersion) || baselineVersion === body.version) return null;
  } else if (baselineVersion !== null) {
    return null;
  }
  return {
    version: body.version,
    trigger,
    threshold: trigger === 'model_price_change' ? null : threshold as number,
    baselineVersion: trigger === 'baseline_delta_percent' ? baselineVersion as number : null,
  };
}

function mutationFailure(id: string, reason: OperationFailureReason): Response {
  if (reason === 'not_found') {
    return operationError(id, 404, 'RESOURCE_NOT_FOUND', 'The owned plan resource was not found.');
  }
  if (reason === 'idempotency_conflict') {
    return operationError(id, 409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for different content.');
  }
  if (reason === 'duplicate') {
    return operationError(id, 409, 'DUPLICATE_RESOURCE', 'An equivalent setting already exists.');
  }
  if (reason === 'share_limit') {
    return operationError(id, 409, 'SHARE_LIMIT', 'Unlisted-link storage limit has been reached.');
  }
  if (reason === 'alert_limit') {
    return operationError(id, 409, 'ALERT_LIMIT', 'Inactive alert-settings storage limit has been reached.');
  }
  if (reason === 'operation_limit') {
    return operationError(id, 409, 'OPERATION_LIMIT', 'Account operation storage limit has been reached.');
  }
  return operationError(id, 409, 'RESOURCE_STATE_CHANGED', 'The resource changed after the original request.');
}

function mutationResponse<T>(
  id: string,
  result: OperationMutationResult<T>,
  transform: (value: T) => unknown = (value) => value,
): Response {
  if (!result.ok) return mutationFailure(id, result.reason);
  return boundedOperationJson(id, { data: transform(result.resource) }, result.replayed ? 200 : 201, {
    'Idempotency-Replayed': result.replayed ? 'true' : 'false',
  });
}

function deleteResponse(id: string, result: OperationDeleteResult, data: unknown): Response {
  if (!result.ok) return mutationFailure(id, result.reason);
  return boundedOperationJson(id, { data }, 200, {
    'Idempotency-Replayed': result.replayed ? 'true' : 'false',
  });
}

export function validBuildPlanShareSecret(value: unknown): value is string {
  return typeof value === 'string' && SHARE_SECRET.test(value);
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** Deterministic per idempotency key so a timed-out create can return the same
 * strong bearer token without ever storing its plaintext in D1. */
export async function deriveBuildPlanShareToken(
  secret: string,
  input: { ownerUserId: string; planId: string; version: number; idempotencyKey: string },
): Promise<string> {
  if (!validBuildPlanShareSecret(secret)) throw new Error('Share token secret is invalid.');
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC', key,
    new TextEncoder().encode(`solvency-share-v1\n${input.ownerUserId}\n${input.planId}\n${input.version}\n${input.idempotencyKey}`),
  );
  return `sv1_${base64Url(new Uint8Array(signature))}`;
}

export async function handleBuildPlanShareCollection(context: PagesContextLike): Promise<Response> {
  const id = requestId(context);
  const owned = ownerAndPlan(context);
  if (!owned || !context.env.DB) {
    return operationError(id, 503, 'SERVICE_UNAVAILABLE', 'Account plan operations are unavailable.');
  }
  if (!noQueryParameters(context.request)) {
    return operationError(id, 400, 'INVALID_REQUEST', 'Query parameters are not accepted.');
  }
  const now = new Date().toISOString();
  if (context.request.method === 'GET') {
    try {
      const shares = await listOwnedBuildPlanShares(context.env.DB, owned.ownerUserId, owned.planId, now);
      return shares === null
        ? operationError(id, 404, 'RESOURCE_NOT_FOUND', 'Build plan was not found.')
        : boundedOperationJson(id, { data: shares });
    } catch {
      return operationError(id, 500, 'INTERNAL_ERROR', 'Unlisted links could not be loaded.');
    }
  }
  if (context.request.method !== 'POST') {
    return operationError(id, 405, 'METHOD_NOT_ALLOWED', 'Method is not allowed.', 'GET, POST');
  }
  const proFailure = await requireProForMutation(context, id, owned.ownerUserId);
  if (proFailure) return proFailure;
  const key = idempotencyKey(context.request);
  if (!key) return operationError(id, 400, 'INVALID_REQUEST', 'A valid Idempotency-Key header is required.');
  const parsed = await readOperationJson(context.request, id);
  if (!parsed.ok) return parsed.response;
  const body = parseShareBody(parsed.value);
  if (!body) return operationError(id, 422, 'INVALID_REQUEST', 'Unlisted-link settings are invalid.');
  const secret = context.env.BUILD_SHARE_TOKEN_SECRET;
  if (!validBuildPlanShareSecret(secret)) {
    return operationError(id, 503, 'SERVICE_UNAVAILABLE', 'Unlisted-link creation is unavailable.');
  }
  const expiresAt = body.expiresInDays === null
    ? null
    : new Date(Date.parse(now) + body.expiresInDays * 86_400_000).toISOString();
  const token = await deriveBuildPlanShareToken(secret, {
    ...owned, version: body.version, idempotencyKey: key,
  });
  const requestHash = await sha256Hex(JSON.stringify({ ...owned, ...body }));
  try {
    const result = await createOwnedBuildPlanShare(context.env.DB, {
      ...owned,
      version: body.version,
      shareId: `share_${crypto.randomUUID()}`,
      tokenHash: await sha256Hex(token),
      allowQuoteExport: body.allowQuoteExport,
      expiresAt,
      idempotencyKey: key,
      requestHash,
      now,
    });
    if (result.ok) await recordServerConfirmedProductIntent(context, 'share_created');
    return mutationResponse(id, result, (share) => ({
      ...share,
      token,
      path: `/shared-build-plans/${token}`,
    }));
  } catch {
    return operationError(id, 500, 'INTERNAL_ERROR', 'Unlisted link could not be created.');
  }
}

export async function handleBuildPlanShareResource(context: PagesContextLike): Promise<Response> {
  const id = requestId(context);
  const owned = ownerAndPlan(context);
  const shareId = routeParam(context, 'shareId', SHARE_ID);
  if (!owned || !shareId || !context.env.DB) {
    return operationError(id, 404, 'RESOURCE_NOT_FOUND', 'Unlisted link was not found.');
  }
  if (context.request.method !== 'DELETE') {
    return operationError(id, 405, 'METHOD_NOT_ALLOWED', 'Method is not allowed.', 'DELETE');
  }
  if (!noQueryParameters(context.request)) {
    return operationError(id, 400, 'INVALID_REQUEST', 'Query parameters are not accepted.');
  }
  const key = idempotencyKey(context.request);
  if (!key) return operationError(id, 400, 'INVALID_REQUEST', 'A valid Idempotency-Key header is required.');
  const requestHash = await sha256Hex(`share.revoke\n${owned.planId}\n${shareId}`);
  try {
    return deleteResponse(id, await revokeOwnedBuildPlanShare(context.env.DB, {
      ...owned, shareId, idempotencyKey: key, requestHash, now: new Date().toISOString(),
    }), { revoked: true, shareId });
  } catch {
    return operationError(id, 500, 'INTERNAL_ERROR', 'Unlisted link could not be revoked.');
  }
}

export async function handlePublicBuildPlanShare(context: PagesContextLike): Promise<Response> {
  const id = requestId(context);
  if (context.request.method !== 'GET') {
    return operationError(id, 405, 'METHOD_NOT_ALLOWED', 'Method is not allowed.', 'GET');
  }
  if (context.env.ACCOUNT_PLANS_ENABLED !== 'true' || !context.env.DB) {
    return operationError(id, 503, 'SERVICE_UNAVAILABLE', 'Unlisted links are unavailable.');
  }
  const url = new URL(context.request.url);
  const download = url.searchParams.get('download');
  if ([...url.searchParams.keys()].some((key) => key !== 'download')
    || (download !== null && download !== 'json')) {
    return operationError(id, 400, 'INVALID_REQUEST', 'Query parameters are not accepted.');
  }
  const token = routeParam(context, 'token', SHARE_TOKEN);
  if (!token) return operationError(id, 404, 'RESOURCE_NOT_FOUND', 'Unlisted link was not found.');
  try {
    const resource = await getPublicSharedBuildPlan(
      context.env.DB, await sha256Hex(token), new Date().toISOString(),
    );
    if (!resource) return operationError(id, 404, 'RESOURCE_NOT_FOUND', 'Unlisted link was not found.');
    if (download === 'json') {
      if (!resource.policy.allowQuoteExport) {
        return operationError(id, 403, 'EXPORT_FORBIDDEN', 'Quote export is disabled for this link.');
      }
      return boundedOperationJson(id, { data: resource }, 200, {
        'Content-Disposition': 'attachment; filename="solvency-shared-build-plan.json"',
      });
    }
    return sharedPlanHtmlResponse(
      id,
      sharedPlanHtml(resource, `${url.pathname}?download=json`),
    );
  } catch {
    return operationError(id, 500, 'INTERNAL_ERROR', 'Unlisted link could not be loaded.');
  }
}

export async function handleBuildPlanAlertCollection(context: PagesContextLike): Promise<Response> {
  const id = requestId(context);
  const owned = ownerAndPlan(context);
  if (!owned || !context.env.DB) {
    return operationError(id, 503, 'SERVICE_UNAVAILABLE', 'Account plan operations are unavailable.');
  }
  if (!noQueryParameters(context.request)) {
    return operationError(id, 400, 'INVALID_REQUEST', 'Query parameters are not accepted.');
  }
  if (context.request.method === 'GET') {
    try {
      const alerts = await listOwnedBuildPlanAlerts(context.env.DB, owned.ownerUserId, owned.planId);
      return alerts === null
        ? operationError(id, 404, 'RESOURCE_NOT_FOUND', 'Build plan was not found.')
        : boundedOperationJson(id, { data: alerts });
    } catch {
      return operationError(id, 500, 'INTERNAL_ERROR', 'Inactive alert settings could not be loaded.');
    }
  }
  if (context.request.method !== 'POST') {
    return operationError(id, 405, 'METHOD_NOT_ALLOWED', 'Method is not allowed.', 'GET, POST');
  }
  const proFailure = await requireProForMutation(context, id, owned.ownerUserId);
  if (proFailure) return proFailure;
  const key = idempotencyKey(context.request);
  if (!key) return operationError(id, 400, 'INVALID_REQUEST', 'A valid Idempotency-Key header is required.');
  const parsed = await readOperationJson(context.request, id);
  if (!parsed.ok) return parsed.response;
  const body = parseAlertBody(parsed.value);
  if (!body) return operationError(id, 422, 'INVALID_REQUEST', 'Inactive alert settings are invalid.');
  const requestHash = await sha256Hex(JSON.stringify({ ...owned, ...body }));
  try {
    const result = await createOwnedBuildPlanAlert(context.env.DB, {
      ...owned,
      alertId: `alert_${crypto.randomUUID()}`,
      ...body,
      idempotencyKey: key,
      requestHash,
      now: new Date().toISOString(),
    });
    if (result.ok) await recordServerConfirmedProductIntent(context, 'alert_setting_saved');
    return mutationResponse(id, result);
  } catch {
    return operationError(id, 500, 'INTERNAL_ERROR', 'Inactive alert settings could not be created.');
  }
}

export async function handleBuildPlanAlertResource(context: PagesContextLike): Promise<Response> {
  const id = requestId(context);
  const owned = ownerAndPlan(context);
  const alertId = routeParam(context, 'alertId', ALERT_ID);
  if (!owned || !alertId || !context.env.DB) {
    return operationError(id, 404, 'RESOURCE_NOT_FOUND', 'Inactive alert setting was not found.');
  }
  if (!noQueryParameters(context.request)) {
    return operationError(id, 400, 'INVALID_REQUEST', 'Query parameters are not accepted.');
  }
  const key = idempotencyKey(context.request);
  if (!key) return operationError(id, 400, 'INVALID_REQUEST', 'A valid Idempotency-Key header is required.');
  const now = new Date().toISOString();
  if (context.request.method === 'DELETE') {
    const requestHash = await sha256Hex(`alert.delete\n${owned.planId}\n${alertId}`);
    try {
      return deleteResponse(id, await deleteOwnedBuildPlanAlert(context.env.DB, {
        ...owned, alertId, idempotencyKey: key, requestHash, now,
      }), { deleted: true, alertId });
    } catch {
      return operationError(id, 500, 'INTERNAL_ERROR', 'Inactive alert setting could not be deleted.');
    }
  }
  if (context.request.method !== 'POST') {
    return operationError(id, 405, 'METHOD_NOT_ALLOWED', 'Method is not allowed.', 'POST, DELETE');
  }
  const proFailure = await requireProForMutation(context, id, owned.ownerUserId);
  if (proFailure) return proFailure;
  const parsed = await readOperationJson(context.request, id);
  if (!parsed.ok) return parsed.response;
  const body = parseAlertBody(parsed.value);
  if (!body) return operationError(id, 422, 'INVALID_REQUEST', 'Inactive alert settings are invalid.');
  const requestHash = await sha256Hex(JSON.stringify({ ...owned, alertId, ...body }));
  try {
    const result = await updateOwnedBuildPlanAlert(context.env.DB, {
      ...owned, alertId, ...body, idempotencyKey: key, requestHash, now,
    });
    if (result.ok) await recordServerConfirmedProductIntent(context, 'alert_setting_saved');
    return mutationResponse(id, result);
  } catch {
    return operationError(id, 500, 'INTERNAL_ERROR', 'Inactive alert setting could not be updated.');
  }
}
