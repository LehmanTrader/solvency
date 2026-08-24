export const SERVER_ERROR_BOUNDARIES = [
  'account_api',
  'api_handler',
  'build_plan_operations',
  'entitlement',
  'product_intents',
  'rate_limit',
  'stripe_webhook',
] as const;

export type ServerErrorBoundary = typeof SERVER_ERROR_BOUNDARIES[number];

const BOUNDARIES = new Set<string>(SERVER_ERROR_BOUNDARIES);
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface SafeServerErrorRecord {
  schema_version: 1;
  event: 'server_error';
  severity: 'error';
  boundary: ServerErrorBoundary | 'unknown';
  request_id: string | 'invalid';
}

/**
 * Emits the complete allowlisted server-error schema. It deliberately accepts
 * no exception, URL, identity, header or payload argument, so those values
 * cannot be serialized accidentally when an untrusted request fails.
 */
export function logServerError(
  requestId: unknown,
  boundary: unknown,
  sink: (serialized: string) => void = (serialized) => console.error(serialized),
): void {
  const record: SafeServerErrorRecord = {
    schema_version: 1,
    event: 'server_error',
    severity: 'error',
    boundary: typeof boundary === 'string' && BOUNDARIES.has(boundary)
      ? boundary as ServerErrorBoundary
      : 'unknown',
    request_id: typeof requestId === 'string' && REQUEST_ID.test(requestId)
      ? requestId
      : 'invalid',
  };
  try {
    sink(JSON.stringify(record));
  } catch {
    // Logging must not alter the already fail-closed response path.
  }
}
