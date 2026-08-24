import { apiError, enforceOwnerRateLimit, validateMutationBoundary, withApiHeaders } from '../../src/lib/server/api-http.ts';
import { authenticateOwner, clerkAuthConfiguration } from '../../src/lib/server/clerk-auth.ts';
import type { PagesHandler } from '../../src/lib/server/pages-types.ts';

export const onRequest: PagesHandler = async (context) => {
  const requestId = crypto.randomUUID();
  context.data.requestId = requestId;
  const finish = (response: Response) => withApiHeaders(response, requestId);

  if (!['GET', 'POST', 'DELETE'].includes(context.request.method)) {
    return finish(apiError(requestId, 405, 'METHOD_NOT_ALLOWED', 'Method is not allowed.', { allow: 'GET, POST, DELETE' }));
  }
  if (context.env.ACCOUNT_PLANS_ENABLED !== 'true') {
    return finish(apiError(requestId, 503, 'SERVICE_UNAVAILABLE', 'Account plan storage is unavailable.'));
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
    return finish(apiError(requestId, 500, 'INTERNAL_ERROR', 'Request could not be completed.'));
  }
};
