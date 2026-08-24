import { apiError, enforceOwnerRateLimit, validateMutationBoundary, withApiHeaders } from '../../src/lib/server/api-http.ts';
import { authenticateOwner, clerkAuthConfiguration } from '../../src/lib/server/clerk-auth.ts';
import type { PagesHandler } from '../../src/lib/server/pages-types.ts';

export const onRequest: PagesHandler = async (context) => {
  const requestId = crypto.randomUUID();
  context.data.requestId = requestId;
  const finish = (response: Response) => withApiHeaders(response, requestId);

  const requestUrl = new URL(context.request.url);
  const pathname = requestUrl.pathname;
  // Stripe cannot present a Clerk session, browser Origin, or Cloudflare
  // Access service-token headers. The future exact webhook handler must cap and
  // verify the untouched raw body with Stripe-Signature before parsing it. Keep
  // this exception exact so adjacent API paths retain every account boundary.
  if (pathname === '/api/stripe-webhook') {
    if (context.env.STRIPE_WEBHOOK_ENABLED !== 'true') {
      return finish(apiError(requestId, 503, 'SERVICE_UNAVAILABLE', 'Stripe webhook service is unavailable.'));
    }
    if (context.request.method !== 'POST') {
      return finish(apiError(requestId, 405, 'METHOD_NOT_ALLOWED', 'Method is not allowed.', { allow: 'POST' }));
    }
    if (requestUrl.search !== '' || requestUrl.searchParams.size !== 0) {
      return finish(apiError(requestId, 400, 'INVALID_REQUEST', 'Webhook URL must not include a query string.'));
    }
    try {
      return finish(await context.next());
    } catch {
      return finish(apiError(requestId, 500, 'INTERNAL_ERROR', 'Webhook request could not be completed.', {
        logBoundary: 'stripe_webhook',
      }));
    }
  }

  if (!['GET', 'POST', 'DELETE'].includes(context.request.method)) {
    return finish(apiError(requestId, 405, 'METHOD_NOT_ALLOWED', 'Method is not allowed.', { allow: 'GET, POST, DELETE' }));
  }
  const accountPlansRoute = pathname === '/api/build-plans' || pathname.startsWith('/api/build-plans/');
  const entitlementRoute = pathname === '/api/entitlement';
  const productIntentRoute = pathname === '/api/intents';
  const previewAccountErasureRoute = pathname === '/api/preview-account-erasure';
  const stripeCheckoutRoute = pathname === '/api/checkout';
  const stripePortalRoute = pathname === '/api/billing-portal';
  const featureEnabled = accountPlansRoute
    ? context.env.ACCOUNT_PLANS_ENABLED === 'true'
    : entitlementRoute
      ? context.env.ENTITLEMENTS_ENABLED === 'true'
      : productIntentRoute
        ? context.env.PRODUCT_INTENTS_ENABLED === 'true'
        : stripeCheckoutRoute
          ? context.env.STRIPE_CHECKOUT_ENABLED === 'true'
          : stripePortalRoute
            ? context.env.STRIPE_PORTAL_ENABLED === 'true'
            : previewAccountErasureRoute
              && context.env.APP_ENV === 'preview'
              && context.env.PREVIEW_ACCOUNT_ERASURE_ENABLED === 'true'
              // The destructive Preview smoke route cannot coexist with any
              // provider-backed billing surface. A real account-deletion flow
              // needs a durable deletion tombstone and provider reconciliation
              // before its final D1 cascade.
              && context.env.STRIPE_CHECKOUT_ENABLED !== 'true'
              && context.env.STRIPE_PORTAL_ENABLED !== 'true'
              && context.env.STRIPE_WEBHOOK_ENABLED !== 'true';
  if (!featureEnabled) {
    return finish(apiError(requestId, 503, 'SERVICE_UNAVAILABLE', 'Account service is unavailable.'));
  }
  const configuration = clerkAuthConfiguration(context.env);
  if (!configuration || !context.env.DB) {
    return finish(apiError(requestId, 503, 'SERVICE_UNAVAILABLE', 'Account plan storage is unavailable.'));
  }
  const boundaryFailure = validateMutationBoundary(context.request, requestId, configuration.authorizedParties);
  if (boundaryFailure) return finish(boundaryFailure);

  const authentication = await authenticateOwner(context.request, configuration);
  if (!authentication.ok) {
    return finish(apiError(requestId, 401, 'AUTH_REQUIRED', 'Sign in is required.'));
  }
  context.data.ownerUserId = authentication.ownerUserId;
  const rateLimitFailure = await enforceOwnerRateLimit(
    context.env.DB,
    authentication.ownerUserId,
    requestId,
  );
  if (rateLimitFailure) return finish(rateLimitFailure);

  try {
    return finish(await context.next());
  } catch {
    return finish(apiError(requestId, 500, 'INTERNAL_ERROR', 'Request could not be completed.', {
      logBoundary: 'account_api',
    }));
  }
};
