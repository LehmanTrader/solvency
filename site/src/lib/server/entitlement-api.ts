import { apiError, apiJson } from './api-http.ts';
import { getOwnerEntitlement } from './entitlement-store.ts';
import type { BuildPlansEnv, D1DatabaseLike, PagesContextLike } from './pages-types.ts';
import { logServerError } from './safe-server-log.ts';

/**
 * Server-authoritative Pro gate for mutating account-plan endpoints. Fails
 * CLOSED to free on any entitlement-lookup failure (malformed state, a D1
 * error, a network throw) so storage or provider trouble can never widen
 * access. Never call this for read or delete handlers — a lapsed subscriber
 * must keep read/export/delete access to data they already own.
 */
export async function ownerHasActivePro(
  db: D1DatabaseLike,
  ownerUserId: string,
  env: Pick<BuildPlansEnv, 'STRIPE_PRO_MONTHLY_PRICE_ID' | 'STRIPE_PRO_ANNUAL_PRICE_ID'>,
): Promise<boolean> {
  try {
    const entitlement = await getOwnerEntitlement(
      db,
      ownerUserId,
      Math.floor(Date.now() / 1000),
      {
        monthlyPriceId: env.STRIPE_PRO_MONTHLY_PRICE_ID,
        annualPriceId: env.STRIPE_PRO_ANNUAL_PRICE_ID,
      },
    );
    return entitlement.tier === 'pro' && entitlement.active;
  } catch {
    return false;
  }
}

export async function handleEntitlement(context: PagesContextLike): Promise<Response> {
  const requestId = context.data.requestId ?? crypto.randomUUID();
  const ownerUserId = context.data.ownerUserId;
  if (!ownerUserId || !context.env.DB) {
    return apiError(requestId, 503, 'SERVICE_UNAVAILABLE', 'Entitlement service is unavailable.');
  }
  if (context.request.method !== 'GET') {
    return apiError(requestId, 405, 'METHOD_NOT_ALLOWED', 'Method is not allowed.', { allow: 'GET' });
  }
  const url = new URL(context.request.url);
  if ([...url.searchParams.keys()].length > 0) {
    return apiError(requestId, 400, 'INVALID_REQUEST', 'Entitlement request is invalid.');
  }
  try {
    return apiJson({
      data: await getOwnerEntitlement(
        context.env.DB,
        ownerUserId,
        Math.floor(Date.now() / 1000),
        {
          monthlyPriceId: context.env.STRIPE_PRO_MONTHLY_PRICE_ID,
          annualPriceId: context.env.STRIPE_PRO_ANNUAL_PRICE_ID,
        },
      ),
    });
  } catch {
    logServerError(requestId, 'entitlement');
    return apiError(requestId, 503, 'SERVICE_UNAVAILABLE', 'Entitlement service is unavailable.');
  }
}
