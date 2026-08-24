import { apiJson } from './api-http.ts';
import {
  recordProductIntent,
  validClientProductIntentName,
  validProductIntentEventId,
  validServerConfirmedProductIntentName,
  type ClientProductIntentName,
  type ServerConfirmedProductIntentName,
} from './product-intent-store.ts';
import type { PagesContextLike } from './pages-types.ts';

const BODY_LIMIT = 512;

type IntentErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_JSON'
  | 'METHOD_NOT_ALLOWED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INTENT_LIMIT'
  | 'BODY_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE';

function intentError(id: string, status: number, code: IntentErrorCode, allow?: string): Response {
  return apiJson({ error: { code, message: 'Product intent was not accepted.', requestId: id } }, status, {
    'X-Error-Code': code,
    'X-Request-Id': id,
    ...(allow ? { Allow: allow } : {}),
  });
}

async function readJson(request: Request, id: string): Promise<
  { ok: true; value: unknown } | { ok: false; response: Response }
> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return { ok: false, response: intentError(id, 415, 'UNSUPPORTED_MEDIA_TYPE') };
  }
  const encoding = request.headers.get('content-encoding')?.trim().toLowerCase();
  if (encoding && encoding !== 'identity') {
    return { ok: false, response: intentError(id, 415, 'UNSUPPORTED_MEDIA_TYPE') };
  }
  const lengthText = request.headers.get('content-length');
  if (lengthText !== null && !/^(0|[1-9]\d*)$/.test(lengthText)) {
    return { ok: false, response: intentError(id, 400, 'INVALID_REQUEST') };
  }
  const declared = lengthText === null ? null : Number(lengthText);
  if (declared !== null && (!Number.isSafeInteger(declared) || declared > BODY_LIMIT)) {
    return { ok: false, response: intentError(id, 413, 'BODY_TOO_LARGE') };
  }
  if (!request.body) return { ok: false, response: intentError(id, 400, 'INVALID_JSON') };

  const bytes = new Uint8Array(BODY_LIMIT);
  const reader = request.body.getReader();
  let offset = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array) || part.value.byteLength > BODY_LIMIT - offset) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, response: intentError(id, 413, 'BODY_TOO_LARGE') };
      }
      bytes.set(part.value, offset);
      offset += part.value.byteLength;
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, response: intentError(id, 400, 'INVALID_REQUEST') };
  } finally {
    reader.releaseLock();
  }
  if (declared !== null && declared !== offset) {
    return { ok: false, response: intentError(id, 400, 'INVALID_REQUEST') };
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: intentError(id, 400, 'INVALID_JSON') };
  }
}

function parseBody(value: unknown): { eventId: string; eventName: ClientProductIntentName } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(body);
  if (keys.length !== 2 || !keys.every((key) => typeof key === 'string' && ['eventId', 'name'].includes(key))
    || !Object.hasOwn(body, 'eventId') || !Object.hasOwn(body, 'name')
    || !validProductIntentEventId(body.eventId) || !validClientProductIntentName(body.name)) return null;
  return { eventId: body.eventId, eventName: body.name };
}

/** Records a durable-operation signal only after that operation succeeds.
 * Measurement is deliberately best-effort and can never change its response. */
export async function recordServerConfirmedProductIntent(
  context: PagesContextLike,
  eventName: ServerConfirmedProductIntentName,
): Promise<void> {
  try {
    const ownerUserId = context.data.ownerUserId;
    if (context.env.PRODUCT_INTENTS_ENABLED !== 'true' || !context.env.DB || !ownerUserId
      || !validServerConfirmedProductIntentName(eventName)) return;
    await recordProductIntent(context.env.DB, {
      ownerUserId,
      eventId: crypto.randomUUID(),
      eventName,
    });
  } catch {
    // A measurement outage must never turn a successful primary mutation into a failure.
  }
}

export async function handleProductIntent(
  context: PagesContextLike,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<Response> {
  const id = context.data.requestId ?? crypto.randomUUID();
  if (context.request.method !== 'POST') return intentError(id, 405, 'METHOD_NOT_ALLOWED', 'POST');
  if ([...new URL(context.request.url).searchParams.keys()].length > 0) {
    return intentError(id, 400, 'INVALID_REQUEST');
  }
  const ownerUserId = context.data.ownerUserId;
  if (!ownerUserId || !context.env.DB) return intentError(id, 503, 'SERVICE_UNAVAILABLE');
  const parsed = await readJson(context.request, id);
  if (!parsed.ok) return parsed.response;
  const body = parseBody(parsed.value);
  if (!body) return intentError(id, 422, 'INVALID_REQUEST');
  try {
    const result = await recordProductIntent(context.env.DB, { ownerUserId, ...body, nowSeconds });
    if (!result.ok) {
      if (result.reason === 'idempotency_conflict') return intentError(id, 409, 'IDEMPOTENCY_CONFLICT');
      if (result.reason === 'owner_limit') return intentError(id, 409, 'INTENT_LIMIT');
      return intentError(id, 422, 'INVALID_REQUEST');
    }
    return apiJson({ data: { accepted: true, replayed: result.replayed } }, result.replayed ? 200 : 201, {
      'Idempotency-Replayed': result.replayed ? 'true' : 'false',
      'X-Request-Id': id,
    });
  } catch {
    return intentError(id, 500, 'INTERNAL_ERROR');
  }
}
