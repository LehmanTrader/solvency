/**
 * Browser-side Clerk helpers shared by the calculator, the compare page and
 * the header. clerk-js is loaded from a <script> in Base.astro only when a
 * publishable key was set at build time, so every call here is a no-op in an
 * ungated build. The modal is themed from the page's own tokens at open time,
 * so it matches whichever theme the visitor is in.
 */
const clerk = () => (window as any).Clerk;
export const signedIn = (): boolean => Boolean(clerk()?.user);

export type ClerkAuthState =
  | { status: 'checking' }
  | { status: 'disabled' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; userId: string; sessionId: string | null }
  | { status: 'error'; code: 'clerk_unavailable' };

export interface ObserveClerkAuthOptions {
  /** Override auto-detection. Pass the server-rendered Clerk flag when available. */
  enabled?: boolean;
  /** How long an enabled-but-unloaded Clerk instance may remain in `checking`. */
  timeoutMs?: number;
}

const clerkScriptConfigured = (): boolean => typeof document !== 'undefined'
  && Boolean(document.querySelector('script[data-clerk-publishable-key]'));

/**
 * `Clerk.loaded` can become true before Clerk's modal components are ready.
 * Base.astro stamps this marker immediately before `clerk:ready`; listeners
 * also stamp it when they receive that event so synthetic/late integrations
 * retain the same invariant.
 */
const clerkUiReady = (): boolean => typeof document !== 'undefined'
  && document.documentElement?.dataset.clerkUiReady === 'true';

const clerkUiFailed = (): boolean => typeof document !== 'undefined'
  && document.documentElement?.dataset.clerkUiError === 'true';

const markClerkUiReady = (): void => {
  if (typeof document === 'undefined' || !document.documentElement?.dataset) return;
  document.documentElement.dataset.clerkUiReady = 'true';
  delete document.documentElement.dataset.clerkUiError;
};

const currentAuthState = (): ClerkAuthState => {
  const c = clerk();
  if (!c?.loaded || !clerkUiReady()) return { status: 'checking' };
  if (!c.user) return { status: 'signed-out' };
  if (typeof c.user.id !== 'string' || !c.user.id) return { status: 'error', code: 'clerk_unavailable' };
  return {
    status: 'signed-in',
    userId: c.user.id,
    sessionId: typeof c.session?.id === 'string' ? c.session.id : null,
  };
};

/**
 * Observe Clerk as a settled state machine. Unlike `onClerk`, this reports an
 * auth-disabled build immediately and turns a failed enabled load into a safe
 * error state instead of leaving account UI in an indefinite loading state.
 */
export function observeClerkAuth(
  callback: (state: ClerkAuthState) => void,
  options: ObserveClerkAuthOptions = {},
): () => void {
  const enabled = options.enabled ?? (Boolean(clerk()) || clerkScriptConfigured());
  if (!enabled) {
    callback({ status: 'disabled' });
    return () => {};
  }

  let stopped = false;
  let removeClerkListener: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const emit = (state: ClerkAuthState) => { if (!stopped) callback(state); };
  const change = () => emit(currentAuthState());
  const attach = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    document.removeEventListener('clerk:ready', ready);
    document.removeEventListener('clerk:error', failed);
    change();
    const unsubscribe = clerk()?.addListener?.(change);
    if (typeof unsubscribe === 'function') removeClerkListener = unsubscribe;
  };
  const ready = () => {
    markClerkUiReady();
    if (clerk()?.loaded) attach();
  };
  const failed = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    emit({ status: 'error', code: 'clerk_unavailable' });
    // Keep the one-shot ready listener: a later successful load can recover.
  };

  if (clerk()?.loaded && clerkUiReady()) attach();
  else {
    emit({ status: 'checking' });
    document.addEventListener('clerk:ready', ready, { once: true });
    document.addEventListener('clerk:error', failed, { once: true });
    const timeoutMs = Math.max(0, options.timeoutMs ?? 10_000);
    timer = setTimeout(() => {
      timer = undefined;
      emit({ status: 'error', code: 'clerk_unavailable' });
      // Keep the one-shot ready listener: a late Clerk load can recover the UI.
    }, timeoutMs);
    if (clerkUiFailed()) failed();
  }

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    document.removeEventListener('clerk:ready', ready);
    document.removeEventListener('clerk:error', failed);
    removeClerkListener?.();
  };
}

/** Runs cb once Clerk has loaded and again on every auth change. */
export function onClerk(cb: () => void): void {
  const ready = () => {
    markClerkUiReady();
    if (!clerk()?.loaded) return;
    cb();
    clerk()?.addListener?.(cb);
  };
  if (clerk()?.loaded && clerkUiReady()) ready();
  else document.addEventListener('clerk:ready', ready, { once: true });
}

export type AuthenticatedJsonErrorCode =
  | 'INVALID_URL'
  | 'AUTH_REQUIRED'
  | 'SESSION_CHANGED'
  | 'TOKEN_UNAVAILABLE'
  | 'REQUEST_ABORTED'
  | 'REQUEST_TIMEOUT'
  | 'NETWORK_ERROR'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PLAN_LIMIT'
  | 'VERSION_LIMIT'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'DUPLICATE_RESOURCE'
  | 'SHARE_LIMIT'
  | 'ALERT_LIMIT'
  | 'OPERATION_LIMIT'
  | 'RESOURCE_STATE_CHANGED'
  | 'REQUEST_TOO_LARGE'
  | 'INVALID_REQUEST'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'REQUEST_FAILED'
  | 'INVALID_RESPONSE';

const authenticatedJsonErrorMessages: Record<AuthenticatedJsonErrorCode, string> = {
  INVALID_URL: 'The account request must use a same-origin URL.',
  AUTH_REQUIRED: 'Sign in again to continue.',
  SESSION_CHANGED: 'Your account session changed. Please try again.',
  TOKEN_UNAVAILABLE: 'Your account session could not be verified. Please try again.',
  REQUEST_ABORTED: 'The account request was cancelled.',
  REQUEST_TIMEOUT: 'The account request timed out. Please try again.',
  NETWORK_ERROR: 'The account service could not be reached. Please try again.',
  FORBIDDEN: 'You do not have access to this resource.',
  NOT_FOUND: 'The requested resource was not found.',
  CONFLICT: 'This account resource could not be changed because its state is out of date. Refresh it before retrying.',
  PLAN_LIMIT: 'This account has reached the preview limit of 20 plans. Refresh account plans, then delete an unneeded plan or keep this draft in the tab. Higher limits are planned for Pro, but upgrades are not available yet.',
  VERSION_LIMIT: 'This account plan has reached the preview limit of 100 versions. Save the draft as a new account plan or keep it in the tab. Higher limits are planned for Pro, but upgrades are not available yet.',
  VERSION_CONFLICT: 'This account plan changed since it was loaded. Refresh and reload its version history before retrying.',
  IDEMPOTENCY_CONFLICT: 'This account change could not be safely matched to its earlier attempt. Change the settings or refresh before retrying.',
  DUPLICATE_RESOURCE: 'Equivalent settings already exist for this account plan. Refresh the saved settings before retrying.',
  SHARE_LIMIT: 'This account plan has reached its unlisted-link storage limit. Revoke an unneeded link before creating another.',
  ALERT_LIMIT: 'This account plan has reached its inactive alert-settings limit. Delete an unneeded setting before creating another.',
  OPERATION_LIMIT: 'This account has reached its temporary operation-replay limit. Please try again after older replay records expire.',
  RESOURCE_STATE_CHANGED: 'This saved setting changed after the original request. Refresh the selected account plan before retrying.',
  REQUEST_TOO_LARGE: 'The plan is too large to save.',
  INVALID_REQUEST: 'The account request contains fields that could not be accepted. Review the current plan or settings.',
  RATE_LIMITED: 'Too many account requests. Please try again later.',
  SERVER_ERROR: 'The account service could not complete the request. Please try again.',
  REQUEST_FAILED: 'The account request could not be completed.',
  INVALID_RESPONSE: 'The account service returned an invalid response.',
};

export class AuthenticatedJsonError extends Error {
  readonly code: AuthenticatedJsonErrorCode;
  readonly status: number | null;
  readonly requestId: string | null;

  constructor(code: AuthenticatedJsonErrorCode, status: number | null = null, requestId: string | null = null) {
    super(authenticatedJsonErrorMessages[code]);
    this.name = 'AuthenticatedJsonError';
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

export interface AuthenticatedJsonRequestInit
  extends Omit<RequestInit, 'body' | 'credentials' | 'redirect' | 'signal'> {
  /** A JSON-serializable request body. It is stringified exactly once for retries. */
  json?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const trustedConflictCodes = new Set<AuthenticatedJsonErrorCode>([
  'PLAN_LIMIT', 'VERSION_LIMIT', 'VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT',
  'DUPLICATE_RESOURCE', 'SHARE_LIMIT', 'ALERT_LIMIT', 'OPERATION_LIMIT', 'RESOURCE_STATE_CHANGED',
]);

const statusErrorCode = (status: number, errorCodeHeader: string | null): AuthenticatedJsonErrorCode => {
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) {
    return errorCodeHeader && trustedConflictCodes.has(errorCodeHeader as AuthenticatedJsonErrorCode)
      ? errorCodeHeader as AuthenticatedJsonErrorCode
      : 'CONFLICT';
  }
  if (status === 413) return 'REQUEST_TOO_LARGE';
  if (status === 422) return 'INVALID_REQUEST';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SERVER_ERROR';
  return 'REQUEST_FAILED';
};

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error) => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

/**
 * Fetch a same-origin JSON endpoint with the active Clerk session token.
 * A 401 gets one token-cache bypass and one retry; response bodies from failed
 * requests are deliberately never read or surfaced.
 */
export async function authenticatedJsonFetch<T = unknown>(
  input: string | URL,
  init: AuthenticatedJsonRequestInit = {},
): Promise<T> {
  let url: URL;
  try {
    url = new URL(input, location.href);
  } catch {
    throw new AuthenticatedJsonError('INVALID_URL');
  }
  if (url.origin !== location.origin || url.username || url.password) {
    throw new AuthenticatedJsonError('INVALID_URL');
  }

  const session = clerk()?.session;
  if (!session?.getToken) throw new AuthenticatedJsonError('AUTH_REQUIRED', 401);
  const sessionId = typeof session.id === 'string' ? session.id : null;
  const controller = new AbortController();
  let timedOut = false;
  const outerAbort = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) outerAbort();
  else init.signal?.addEventListener('abort', outerAbort, { once: true });
  const timeoutMs = Math.min(60_000, Math.max(1, init.timeoutMs ?? 12_000));
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const { json, signal: _signal, timeoutMs: _timeoutMs, headers: inputHeaders, ...requestInit } = init;
  let body: string | undefined;
  try {
    if (json !== undefined) {
      if (!safeJsonValue(json)) throw new Error('not JSON-safe');
      body = JSON.stringify(json);
    }
  } catch {
    clearTimeout(timeout);
    init.signal?.removeEventListener('abort', outerAbort);
    throw new AuthenticatedJsonError('INVALID_REQUEST');
  }

  const getToken = async (fresh: boolean): Promise<string> => {
    try {
      const value = await abortable(Promise.resolve(session.getToken(fresh ? { skipCache: true } : undefined)), controller.signal);
      if (!value) throw new AuthenticatedJsonError('AUTH_REQUIRED', 401);
      return value;
    } catch (error) {
      if (error instanceof AuthenticatedJsonError) throw error;
      if (controller.signal.aborted) throw new AuthenticatedJsonError(timedOut ? 'REQUEST_TIMEOUT' : 'REQUEST_ABORTED');
      throw new AuthenticatedJsonError('TOKEN_UNAVAILABLE');
    }
  };
  const sessionIsCurrent = () => clerk()?.session === session
    || (sessionId !== null && clerk()?.session?.id === sessionId);
  const send = async (fresh: boolean): Promise<Response> => {
    if (!sessionIsCurrent()) throw new AuthenticatedJsonError('SESSION_CHANGED');
    const bearer = await getToken(fresh);
    if (!sessionIsCurrent()) throw new AuthenticatedJsonError('SESSION_CHANGED');
    const headers = new Headers(inputHeaders);
    headers.set('Accept', 'application/json');
    headers.set('Authorization', `Bearer ${bearer}`);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    try {
      return await fetch(url, {
        ...requestInit,
        body,
        headers,
        credentials: 'same-origin',
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) throw new AuthenticatedJsonError(timedOut ? 'REQUEST_TIMEOUT' : 'REQUEST_ABORTED');
      throw new AuthenticatedJsonError('NETWORK_ERROR');
    }
  };

  try {
    let response = await send(false);
    if (response.status === 401) response = await send(true);
    if (!response.ok) {
      throw new AuthenticatedJsonError(
        statusErrorCode(response.status, response.headers.get('x-error-code')),
        response.status,
        response.headers.get('x-request-id'),
      );
    }
    if (!sessionIsCurrent()) throw new AuthenticatedJsonError('SESSION_CHANGED');
    if (response.status === 204) return undefined as T;
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('application/json')) throw new AuthenticatedJsonError('INVALID_RESPONSE', response.status);
    try {
      const value = await response.json() as T;
      if (!sessionIsCurrent()) throw new AuthenticatedJsonError('SESSION_CHANGED');
      return value;
    } catch (error) {
      if (error instanceof AuthenticatedJsonError) throw error;
      if (controller.signal.aborted) throw new AuthenticatedJsonError(timedOut ? 'REQUEST_TIMEOUT' : 'REQUEST_ABORTED');
      throw new AuthenticatedJsonError('INVALID_RESPONSE', response.status);
    }
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener('abort', outerAbort);
  }
}

export const COMPOSER_AUTH_DRAFT_MAX_BYTES = 64 * 1024;
export const COMPOSER_AUTH_DRAFT_MAX_AGE_MS = 30 * 60 * 1000;
const COMPOSER_AUTH_DRAFT_KEY = 'solvency:composer-auth-draft:v1';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
interface ComposerAuthDraftEnvelope { version: 1; savedAt: number; draft: JsonValue }

function safeJsonValue(value: unknown, seen = new Set<object>(), depth = 0): value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth > 32 || seen.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => safeJsonValue(item, seen, depth + 1))
    : Object.entries(value).every(([key, item]) => key.length <= 256 && safeJsonValue(item, seen, depth + 1));
  seen.delete(value);
  return valid;
}

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

/** Preserve one canonical, JSON-safe Composer draft for an auth redirect. */
export function preserveComposerDraftForAuth(canonicalDraft: unknown): boolean {
  try {
    if (!safeJsonValue(canonicalDraft) || canonicalDraft === null || Array.isArray(canonicalDraft)) return false;
    const envelope: ComposerAuthDraftEnvelope = { version: 1, savedAt: Date.now(), draft: canonicalDraft };
    const serialized = JSON.stringify(envelope);
    if (utf8Bytes(serialized) > COMPOSER_AUTH_DRAFT_MAX_BYTES) return false;
    sessionStorage.setItem(COMPOSER_AUTH_DRAFT_KEY, serialized);
    return true;
  } catch {
    return false;
  }
}

/** Consume and remove the redirect draft. Expired, corrupt or oversized data is discarded. */
export function consumeComposerDraftAfterAuth<T = unknown>(): T | null {
  let serialized: string | null = null;
  try {
    serialized = sessionStorage.getItem(COMPOSER_AUTH_DRAFT_KEY);
    sessionStorage.removeItem(COMPOSER_AUTH_DRAFT_KEY);
    if (!serialized || serialized.length > COMPOSER_AUTH_DRAFT_MAX_BYTES
      || utf8Bytes(serialized) > COMPOSER_AUTH_DRAFT_MAX_BYTES) return null;
    const envelope = JSON.parse(serialized) as Partial<ComposerAuthDraftEnvelope>;
    if (envelope.version !== 1 || typeof envelope.savedAt !== 'number'
      || !Number.isFinite(envelope.savedAt) || envelope.savedAt > Date.now() + 60_000
      || Date.now() - envelope.savedAt > COMPOSER_AUTH_DRAFT_MAX_AGE_MS
      || !safeJsonValue(envelope.draft) || envelope.draft === null || Array.isArray(envelope.draft)) return null;
    return envelope.draft as T;
  } catch {
    return null;
  }
}

export function clearComposerDraftForAuth(): void {
  try { sessionStorage.removeItem(COMPOSER_AUTH_DRAFT_KEY); } catch { /* storage may be unavailable */ }
}

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Clerk `appearance` built from the live CSS tokens (dark or light). */
export function clerkAppearance() {
  return {
    variables: {
      colorBackground: token('--color-panel'),
      colorText: token('--color-ink'),
      colorTextSecondary: token('--color-body'),
      colorInputBackground: token('--color-bg'),
      colorInputText: token('--color-ink'),
      colorNeutral: token('--color-ink'),
      colorPrimary: token('--color-accent'),
      colorTextOnPrimaryBackground: token('--color-on-accent'),
      colorDanger: token('--color-worse'),
      colorSuccess: token('--color-better'),
      borderRadius: '6px',
      fontFamily: token('--font-sans'),
      fontFamilyButtons: token('--font-mono'),
    },
    elements: {
      card: { border: `1px solid ${token('--color-rule')}`, boxShadow: 'none' },
      formButtonPrimary: { fontFamily: token('--font-mono'), fontWeight: 700, textTransform: 'none' },
      footer: { background: token('--color-panel-2') },
    },
  };
}

const urls = () => ({ afterSignInUrl: location.href, afterSignUpUrl: location.href });

/**
 * Why the modal opened. Stored on the user as unsafeMetadata.intent so intents
 * are countable in Clerk's user list. Never use unsafeMetadata for authorization:
 * it is client-writable conversion analytics, not an entitlement source.
 */
export type Intent = 'gate' | 'save' | 'pro-notify' | 'pro-download' | 'build-pro-price-interest';

export type AuthModalOpenResult = 'opened' | 'queued' | 'unavailable';

type AuthModalRequest =
  | { kind: 'sign-in' }
  | { kind: 'sign-up'; intent: Intent; context?: string };

let queuedAuthModal: AuthModalRequest | null = null;
let authModalReadyListenerInstalled = false;
let authModalListenerDocument: Document | null = null;

/**
 * Where the strip goes: hard against Clerk's card, above it when the viewport
 * has room and below it otherwise. It must never cover the card's own title,
 * so the card is measured rather than guessed at.
 */
function placeContext(el: HTMLElement): void {
  const card = document.querySelector('.cl-modalContent, .cl-card');
  const r = card?.getBoundingClientRect();
  const h = el.offsetHeight, M = 12;
  let top: number;
  if (!r || !r.height) top = Math.max(M, innerHeight / 2 - 304);
  else if (r.top - h - M >= M) top = r.top - h - M;
  else if (r.bottom + M + h <= innerHeight - M) top = r.bottom + M;
  else top = Math.max(M, innerHeight - h - M);
  el.style.top = `${Math.round(top)}px`;
}

/**
 * One line of OUR copy beside Clerk's modal. clerk-js takes its own copy only
 * at load(), so the entry point's context is rendered by the page: a fixed
 * strip themed like the card, shown while the modal is in the DOM.
 */
function showContext(text: string): void {
  // On small screens Clerk already fills most of the viewport. A fixed strip
  // would cover the modal footer or duplicate its subtitle; the triggering
  // gate/button provides the context immediately before the modal opens.
  if (matchMedia('(max-width: 639px)').matches) return;
  let el = document.getElementById('auth-context');
  if (!el) {
    el = document.createElement('p');
    el.id = 'auth-context';
    el.className = 'auth-context';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.setAttribute('data-show', '1');
  placeContext(el);
  const reposition = () => placeContext(el!);
  // hide when Clerk's modal leaves the DOM (close, Escape, or sign-up completes)
  let seen = false;
  const stop = () => { el!.removeAttribute('data-show'); mo.disconnect(); removeEventListener('resize', reposition); };
  const mo = new MutationObserver(() => {
    const open = document.querySelector('.cl-modalBackdrop, .cl-modalContent');
    if (open) { seen = true; reposition(); return; }
    if (!seen) return;
    stop();
  });
  mo.observe(document.body, { childList: true, subtree: true });
  addEventListener('resize', reposition);
  // Clerk animates its card in and grows it as steps change; re-measure after
  for (const t of [120, 400, 900]) setTimeout(reposition, t);
  setTimeout(() => { if (!seen) stop(); }, 4000);
}

function invokeAuthModal(request: AuthModalRequest): AuthModalOpenResult {
  const c = clerk();
  if (!c?.loaded || !clerkUiReady()) return 'unavailable';
  try {
    if (request.kind === 'sign-in') {
      if (typeof c.openSignIn !== 'function') return 'unavailable';
      const result = c.openSignIn({ ...urls(), appearance: clerkAppearance() });
      if (result && typeof result.catch === 'function') void result.catch(() => {});
      return 'opened';
    }
    if (typeof c.openSignUp !== 'function') return 'unavailable';
    const result = c.openSignUp({
      ...urls(), appearance: clerkAppearance(),
      unsafeMetadata: { intent: request.intent, scenario: location.href },
    });
    if (result && typeof result.catch === 'function') void result.catch(() => {});
    if (request.context) showContext(request.context);
    return 'opened';
  } catch {
    // Clerk can expose its modal methods before their UI components are ready.
    // A failed modal open must leave the page usable and never escape the click.
    return 'unavailable';
  }
}

function removeAuthModalReadinessListeners(): void {
  authModalListenerDocument?.removeEventListener('clerk:ready', flushQueuedAuthModal);
  authModalListenerDocument?.removeEventListener('clerk:error', failQueuedAuthModal);
  authModalReadyListenerInstalled = false;
  authModalListenerDocument = null;
}

function flushQueuedAuthModal(): void {
  markClerkUiReady();
  removeAuthModalReadinessListeners();
  const request = queuedAuthModal;
  queuedAuthModal = null;
  if (request) invokeAuthModal(request);
}

function failQueuedAuthModal(): void {
  removeAuthModalReadinessListeners();
  // Never retain a click across a settled load failure. A later user action
  // can queue again if Clerk is reloaded successfully.
  queuedAuthModal = null;
}

function requestAuthModal(request: AuthModalRequest): AuthModalOpenResult {
  if (clerk()?.loaded && clerkUiReady()) return invokeAuthModal(request);
  if (!clerk() && !clerkScriptConfigured()) return 'unavailable';
  if (clerkUiFailed()) return 'unavailable';

  // Keep only the visitor's latest intent. Repeated early taps must open at
  // most one modal when Clerk settles, never a stack of sign-in/up dialogs.
  queuedAuthModal = request;
  if (authModalReadyListenerInstalled && authModalListenerDocument !== document) {
    removeAuthModalReadinessListeners();
  }
  if (!authModalReadyListenerInstalled) {
    authModalReadyListenerInstalled = true;
    authModalListenerDocument = document;
    document.addEventListener('clerk:ready', flushQueuedAuthModal, { once: true });
    document.addEventListener('clerk:error', failQueuedAuthModal, { once: true });
  }
  return 'queued';
}

/**
 * Gates open sign-UP: a first-time visitor is asked to create the free
 * account, not to "welcome back". `intent` tags the trigger in the user's
 * unsafeMetadata (with the scenario URL) and `context` is the strip's text.
 * Calls made during Clerk startup are coalesced and opened after `clerk:ready`.
 */
export const openSignUp = (
  intent: Intent = 'gate',
  context?: string,
): AuthModalOpenResult => requestAuthModal({ kind: 'sign-up', intent, ...(context ? { context } : {}) });

export const openSignIn = (): AuthModalOpenResult => requestAuthModal({ kind: 'sign-in' });

/**
 * Counts a data-analytics click as a custom event if an analytics beacon is
 * present (Cloudflare Zaraz `zaraz.track`, or a beacon exposing trackEvent).
 * Silent when neither is loaded.
 */
export type ProductIntentName =
  | 'planner_started'
  | 'valid_quote_created'
  | 'export_downloaded'
  | 'pro_price_interest';

const PRODUCT_INTENT_BY_ANALYTICS_EVENT: Readonly<Record<string, ProductIntentName>> = {
  build_planner_view: 'planner_started',
  build_quote_first_edit_valid: 'valid_quote_created',
  build_export: 'export_downloaded',
  build_pro_price_interest: 'pro_price_interest',
};

export function productIntentNameForAnalyticsEvent(name: string): ProductIntentName | null {
  return Object.hasOwn(PRODUCT_INTENT_BY_ANALYTICS_EVENT, name)
    ? PRODUCT_INTENT_BY_ANALYTICS_EVENT[name]!
    : null;
}

const productIntentsEnabled = (): boolean => typeof document !== 'undefined'
  && document.documentElement?.dataset.productIntentsEnabled === 'true';

function productIntentResponse(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  if (Reflect.ownKeys(envelope).length !== 1 || !Object.hasOwn(envelope, 'data')
    || !envelope.data || typeof envelope.data !== 'object' || Array.isArray(envelope.data)) return false;
  const data = envelope.data as Record<string, unknown>;
  return Reflect.ownKeys(data).length === 2
    && data.accepted === true && typeof data.replayed === 'boolean';
}

/**
 * Best-effort, untrusted directional measurement for signed-in users. Only a
 * client-allowed coarse name and opaque UUID leave the browser; analytics
 * detail is never forwarded. An ambiguous transport failure retries once with
 * the same UUID. Durable-operation signals are emitted by the server instead.
 */
export async function recordProductIntentSignal(
  name: ProductIntentName,
  eventId = crypto.randomUUID(),
): Promise<boolean> {
  if (!productIntentsEnabled() || !signedIn()
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(eventId)) return false;
  const request = () => authenticatedJsonFetch<unknown>('/api/intents', {
    method: 'POST', json: { eventId, name }, timeoutMs: 3_000,
  });
  try {
    return productIntentResponse(await request());
  } catch (cause) {
    if (!(cause instanceof AuthenticatedJsonError)
      || !['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'REQUEST_FAILED'].includes(cause.code)) return false;
    try { return productIntentResponse(await request()); } catch { return false; }
  }
}

function dispatchProductIntentSignal(name: ProductIntentName): void {
  if (!productIntentsEnabled()) return;
  if (signedIn()) {
    void recordProductIntentSignal(name);
    return;
  }
  // A returning user's session may settle after the page module runs. Queue
  // this one attempt only while Clerk itself is still loading; an already
  // settled signed-out visitor never creates a first-party owner event.
  if (!clerkUiReady() && clerkScriptConfigured()) {
    document.addEventListener('clerk:ready', () => {
      markClerkUiReady();
      if (signedIn()) void recordProductIntentSignal(name);
    }, { once: true });
  }
}

export function track(name: string, data?: Record<string, string>): boolean {
  const w = window as any;
  const productIntent = productIntentNameForAnalyticsEvent(name);
  if (productIntent) dispatchProductIntentSignal(productIntent);
  try {
    if (typeof w.zaraz?.track === 'function') { w.zaraz.track(name, data); return true; }
    if (typeof w.__cfBeacon?.trackEvent === 'function') { w.__cfBeacon.trackEvent(name, data); return true; }
  } catch { /* analytics must never break the page */ }
  return false;
}
export function wireAnalytics(): void {
  document.addEventListener('click', (e) => {
    const el = (e.target as Element).closest<HTMLElement>('[data-analytics]');
    if (el) track(el.dataset.analytics!, { path: location.pathname });
  });
}

/** Stores the current scenario URL on the user; returns false if not signed in. */
export async function saveScenario(url: string): Promise<boolean> {
  const u = clerk()?.user;
  if (!u) return false;
  const prev: string[] = Array.isArray(u.unsafeMetadata?.scenarios) ? u.unsafeMetadata.scenarios : [];
  const list = [url, ...prev.filter((x: string) => x !== url)].slice(0, 20);
  await u.update({ unsafeMetadata: { ...u.unsafeMetadata, scenarios: list } });
  return true;
}

/**
 * Wires a hard-gated Save button: signed out → sign-up modal; signed in →
 * save the current URL and confirm on the button itself.
 */
export function wireSave(btn: HTMLButtonElement | null, idle = 'Save scenario', scenario?: () => string): void {
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!signedIn()) { openSignUp('save', `Save ${scenario ? `“${scenario()}”` : 'this scenario'} to your account — free.`); return; }
    btn.setAttribute('aria-busy', 'true');
    btn.textContent = 'Saving…';
    try { await saveScenario(location.href); btn.textContent = 'Saved ✓'; }
    catch { btn.textContent = 'Could not save'; }
    btn.removeAttribute('aria-busy');
    setTimeout(() => (btn.textContent = idle), 1800);
  });
}
