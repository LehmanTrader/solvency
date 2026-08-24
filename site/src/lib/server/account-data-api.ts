import { apiError, apiJson } from './api-http.ts';
import { deleteOwnedAccountData } from './account-data-store.ts';
import type { PagesContextLike } from './pages-types.ts';

export const PREVIEW_ACCOUNT_ERASURE_PATH = '/api/preview-account-erasure';
export const PREVIEW_ACCOUNT_ERASURE_ORIGIN = 'https://d1-functions-preview.solvency-ru5.pages.dev';
export const PREVIEW_ACCOUNT_ERASURE_CONFIRMATION = 'DELETE_MY_ISOLATED_PREVIEW_DATA';

export async function handlePreviewAccountErasure(context: PagesContextLike): Promise<Response> {
  const requestId = context.data.requestId ?? crypto.randomUUID();
  if (context.env.APP_ENV !== 'preview'
    || context.env.PREVIEW_ACCOUNT_ERASURE_ENABLED !== 'true') {
    return apiError(requestId, 503, 'SERVICE_UNAVAILABLE', 'Preview account erasure is unavailable.');
  }
  if (context.request.method !== 'DELETE') {
    return apiError(requestId, 405, 'METHOD_NOT_ALLOWED', 'Method is not allowed.', { allow: 'DELETE' });
  }
  const url = new URL(context.request.url);
  if (url.origin !== PREVIEW_ACCOUNT_ERASURE_ORIGIN
    || url.pathname !== PREVIEW_ACCOUNT_ERASURE_PATH || url.search !== '') {
    return apiError(requestId, 400, 'INVALID_REQUEST', 'Preview account erasure request is invalid.');
  }
  if (context.request.headers.get('x-preview-erasure-confirm') !== PREVIEW_ACCOUNT_ERASURE_CONFIRMATION) {
    return apiError(requestId, 400, 'INVALID_REQUEST', 'Preview account erasure confirmation is required.');
  }
  const contentLength = context.request.headers.get('content-length');
  if ((contentLength !== null && contentLength !== '0') || context.request.body !== null) {
    return apiError(requestId, 400, 'INVALID_REQUEST', 'Preview account erasure does not accept a request body.');
  }
  const ownerUserId = context.data.ownerUserId;
  if (!ownerUserId || !context.env.DB) {
    return apiError(requestId, 503, 'SERVICE_UNAVAILABLE', 'Preview account erasure is unavailable.');
  }
  try {
    await deleteOwnedAccountData(context.env.DB, ownerUserId);
    return apiJson({ data: { erased: true } });
  } catch {
    return apiError(requestId, 500, 'INTERNAL_ERROR', 'Preview account data could not be erased.');
  }
}
