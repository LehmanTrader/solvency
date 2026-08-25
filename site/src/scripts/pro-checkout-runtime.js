// Production checkout runtime for Solvency Pro (site/src/components/ProCheckout.astro).
//
// This module is loaded only when ProCheckout.astro is actually rendered:
// pricing.astro instantiates it exclusively behind `{CHECKOUT_UI_ENABLED &&
// <ProCheckout />}`, and ProCheckout.astro inlines this file's *source text*
// via a `?raw` import into `<script is:inline type="module" set:html={...}>`
// — the same technique StripeSandbox.astro/stripe-sandbox-runtime.js use.
// That means a build with the checkout flag off never instantiates the
// component, so this text is never embedded in any page and Vite never
// treats it as a JS module to bundle into a standalone chunk. A dark build
// therefore contains neither this code nor the /api/checkout or
// /api/billing-portal strings it references (see
// scripts/verify-production-artifact-dark.mjs, which forbids exactly those
// strings anywhere in dist/).
//
// It is deliberately self-contained rather than importing clerk-client.ts:
// an inlined raw-text module script cannot resolve a relative `.ts` import
// specifier in the browser, so the small pieces this needs (an authenticated
// same-origin JSON fetch, Clerk auth observation, opening the sign-in modal)
// are reimplemented locally, mirroring the pattern already established by
// stripe-sandbox-runtime.js for the same reason.

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length
    && keys.every((key) => Object.hasOwn(value, key))
    && actual.every((key) => typeof key === 'string' && keys.includes(key));
}

/** Validates the exact `{ data: { url } }` envelope /api/checkout and /api/billing-portal return. */
export function checkoutRedirectUrl(value) {
  if (!exactObject(value, ['data']) || !exactObject(value.data, ['url'])
    || typeof value.data.url !== 'string' || value.data.url.length > 4096) return null;
  try {
    const url = new URL(value.data.url);
    if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export class ProCheckoutRequestError extends Error {
  constructor(code, status = null) {
    super(code);
    this.name = 'ProCheckoutRequestError';
    this.code = code;
    this.status = status;
  }
}

function safeJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => safeJsonValue(item, seen))
    : Object.getPrototypeOf(value) === Object.prototype
      && Reflect.ownKeys(value).every((key) => typeof key === 'string' && safeJsonValue(value[key], seen));
  seen.delete(value);
  return valid;
}

function statusCode(status) {
  if (status === 401) return 'AUTH_REQUIRED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 503) return 'UNAVAILABLE';
  if (status >= 500) return 'SERVER_ERROR';
  return 'REQUEST_FAILED';
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener('abort', abort); resolve(value); },
      (error) => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

export async function authenticatedJsonFetch(input, init = {}) {
  let url;
  try {
    url = new URL(input, location.href);
  } catch {
    throw new ProCheckoutRequestError('INVALID_URL');
  }
  if (url.origin !== location.origin || url.username || url.password) {
    throw new ProCheckoutRequestError('INVALID_URL');
  }
  const session = window.Clerk?.session;
  if (!session?.getToken) throw new ProCheckoutRequestError('AUTH_REQUIRED', 401);
  const sessionId = typeof session.id === 'string' ? session.id : null;
  const body = init.json === undefined
    ? undefined
    : safeJsonValue(init.json) ? JSON.stringify(init.json) : null;
  if (body === null) throw new ProCheckoutRequestError('INVALID_REQUEST');
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.min(60_000, Math.max(1, init.timeoutMs ?? 12_000)));
  const sessionIsCurrent = () => window.Clerk?.session === session
    || (sessionId !== null && window.Clerk?.session?.id === sessionId);
  const send = async (fresh) => {
    if (!sessionIsCurrent()) throw new ProCheckoutRequestError('SESSION_CHANGED');
    let bearer;
    try {
      bearer = await abortable(
        Promise.resolve(session.getToken(fresh ? { skipCache: true } : undefined)),
        controller.signal,
      );
    } catch {
      if (controller.signal.aborted) {
        throw new ProCheckoutRequestError(timedOut ? 'REQUEST_TIMEOUT' : 'REQUEST_ABORTED');
      }
      throw new ProCheckoutRequestError('TOKEN_UNAVAILABLE');
    }
    if (!bearer) throw new ProCheckoutRequestError('AUTH_REQUIRED', 401);
    if (!sessionIsCurrent()) throw new ProCheckoutRequestError('SESSION_CHANGED');
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    headers.set('Authorization', `Bearer ${bearer}`);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    try {
      return await fetch(url, {
        method: init.method ?? 'GET',
        headers,
        body,
        credentials: 'same-origin',
        redirect: 'error',
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) {
        throw new ProCheckoutRequestError(timedOut ? 'REQUEST_TIMEOUT' : 'REQUEST_ABORTED');
      }
      throw new ProCheckoutRequestError('NETWORK_ERROR');
    }
  };
  try {
    let response = await send(false);
    if (response.status === 401) response = await send(true);
    if (!response.ok) throw new ProCheckoutRequestError(statusCode(response.status), response.status);
    if (!sessionIsCurrent()) throw new ProCheckoutRequestError('SESSION_CHANGED');
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      throw new ProCheckoutRequestError('INVALID_RESPONSE', response.status);
    }
    try {
      const value = await response.json();
      if (!sessionIsCurrent()) throw new ProCheckoutRequestError('SESSION_CHANGED');
      return value;
    } catch (error) {
      if (error instanceof ProCheckoutRequestError) throw error;
      throw new ProCheckoutRequestError('INVALID_RESPONSE', response.status);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function randomIdempotencyKey(namespace) {
  return `solvency-${namespace}-v1-${crypto.randomUUID()}`;
}

/**
 * Deterministic per-session, per-cadence Idempotency-Key: matches
 * POST /api/checkout's `IDEMPOTENCY_KEY` shape and lets a retry (or a
 * "cancel" return from Stripe) safely resume the same open Checkout attempt
 * instead of creating a second one. Mirrors stripeCheckoutBrowserKey in
 * stripe-sandbox-runtime.js, namespaced separately for the production path.
 */
export async function checkoutBrowserKey(ownerUserId, sessionId, interval) {
  if (typeof ownerUserId !== 'string' || ownerUserId.length < 4 || ownerUserId.length > 128
    || typeof sessionId !== 'string' || sessionId.length < 4 || sessionId.length > 256
    || (interval !== 'month' && interval !== 'year')) {
    throw new ProCheckoutRequestError('INVALID_REQUEST');
  }
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`solvency-pro-checkout-browser-v1\n${ownerUserId}\n${sessionId}\n${interval}`),
  );
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `solvency-checkout-${interval}-v1-${hex}`;
}

async function createCheckout(interval) {
  const ownerUserId = window.Clerk?.user?.id;
  const sessionId = window.Clerk?.session?.id;
  const browserKey = await checkoutBrowserKey(ownerUserId, sessionId, interval);
  const response = await authenticatedJsonFetch('/api/checkout', {
    method: 'POST',
    headers: { 'Idempotency-Key': browserKey },
    json: { interval },
    timeoutMs: 15_000,
  });
  const url = checkoutRedirectUrl(response);
  if (!url) throw new ProCheckoutRequestError('INVALID_RESPONSE');
  return url;
}

async function createPortal() {
  const response = await authenticatedJsonFetch('/api/billing-portal', {
    method: 'POST',
    headers: { 'Idempotency-Key': randomIdempotencyKey('portal') },
    json: {},
    timeoutMs: 15_000,
  });
  const url = checkoutRedirectUrl(response);
  if (!url) throw new ProCheckoutRequestError('INVALID_RESPONSE');
  return url;
}

/**
 * Validates only the fields this card needs from GET /api/entitlement's
 * `{ data: OwnerEntitlement }` envelope (entitlement-store.ts). Unlike
 * checkoutRedirectUrl this does not require an exact key set on `data`:
 * OwnerEntitlement carries several more fields (source, status,
 * currentPeriodEnd, cancelAtPeriodEnd) this card never reads.
 */
export function entitlementSubscription(value) {
  if (!exactObject(value, ['data'])) return null;
  const data = value.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.tier !== 'free' && data.tier !== 'pro') return null;
  if (typeof data.active !== 'boolean') return null;
  if (data.billingInterval !== 'month' && data.billingInterval !== 'year' && data.billingInterval !== null) return null;
  return { tier: data.tier, active: data.active, billingInterval: data.billingInterval };
}

/**
 * Owner ask: once a signed-in user's Pro subscription is active, the buy
 * controls disappear and the card says so instead. Any lookup failure —
 * network, auth, a malformed payload — is treated as not-subscribed, never
 * as subscribed: a free visitor must never see the subscribed state, even
 * briefly.
 */
async function fetchSubscription() {
  try {
    return entitlementSubscription(await authenticatedJsonFetch('/api/entitlement', { timeoutMs: 10_000 }));
  } catch {
    return null;
  }
}

function currentAuthState() {
  const clerk = window.Clerk;
  if (!clerk?.loaded || document.documentElement.dataset.clerkUiReady !== 'true') {
    return { status: 'checking' };
  }
  if (!clerk.user) return { status: 'signed-out' };
  if (typeof clerk.user.id !== 'string' || clerk.user.id.length === 0) return { status: 'error' };
  return {
    status: 'signed-in',
    userId: clerk.user.id,
    sessionId: typeof clerk.session?.id === 'string' ? clerk.session.id : null,
  };
}

/** Mirrors observeClerkAuth's settled-state semantics from clerk-client.ts. */
function observeAuth(callback, enabled) {
  if (!enabled) {
    callback({ status: 'disabled' });
    return () => {};
  }
  let stopped = false;
  let unsubscribe;
  let timer;
  const emit = (state) => { if (!stopped) callback(state); };
  const attach = () => {
    if (stopped) return;
    clearTimeout(timer);
    document.removeEventListener('clerk:ready', ready);
    document.removeEventListener('clerk:error', failed);
    emit(currentAuthState());
    const stop = window.Clerk?.addListener?.(() => emit(currentAuthState()));
    if (typeof stop === 'function') unsubscribe = stop;
  };
  const ready = () => {
    document.documentElement.dataset.clerkUiReady = 'true';
    delete document.documentElement.dataset.clerkUiError;
    if (window.Clerk?.loaded) attach();
  };
  const failed = () => {
    clearTimeout(timer);
    emit({ status: 'error' });
  };
  if (window.Clerk?.loaded && document.documentElement.dataset.clerkUiReady === 'true') attach();
  else {
    emit({ status: 'checking' });
    document.addEventListener('clerk:ready', ready, { once: true });
    document.addEventListener('clerk:error', failed, { once: true });
    timer = setTimeout(() => emit({ status: 'error' }), 10_000);
  }
  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('clerk:ready', ready);
    document.removeEventListener('clerk:error', failed);
    unsubscribe?.();
  };
}

/**
 * Opens the same Clerk sign-in modal the header's #auth-signin button opens
 * (openSignIn in clerk-client.ts). Reimplemented locally for the reason
 * described at the top of this file.
 */
function triggerSignIn() {
  const clerk = window.Clerk;
  if (!clerk?.loaded || document.documentElement.dataset.clerkUiReady !== 'true'
    || typeof clerk.openSignIn !== 'function') return false;
  try {
    const result = clerk.openSignIn({ afterSignInUrl: location.href, afterSignUpUrl: location.href });
    if (result && typeof result.catch === 'function') void result.catch(() => {});
    return true;
  } catch {
    return false;
  }
}

function describeError(err) {
  if (err instanceof ProCheckoutRequestError) {
    // Route disabled/unavailable must read as unavailable, never as failure
    // that implies something was charged or reserved.
    if (err.status === 503 || err.code === 'UNAVAILABLE') return 'Checkout is not available right now.';
    if (err.code === 'CONFLICT') return 'An existing subscription must be managed from Manage billing below.';
    if (err.code === 'NOT_FOUND') return 'No billing account was found yet. Subscribe first, then manage billing here.';
    if (err.code === 'AUTH_REQUIRED') return 'Your session could not be verified. Sign in again, then retry.';
    if (err.code === 'RATE_LIMITED') return 'Too many attempts. Wait a moment, then retry.';
  }
  return 'Checkout is not available right now.';
}

export function bootProCheckout() {
  const root = document.getElementById('pro-checkout');
  if (!root) return;
  const month = document.getElementById('pro-checkout-month');
  const year = document.getElementById('pro-checkout-year');
  const portal = document.getElementById('pro-checkout-portal');
  const status = document.getElementById('pro-checkout-status');
  const error = document.getElementById('pro-checkout-error');
  const choice = document.getElementById('pro-checkout-choice');
  const subscribed = document.getElementById('pro-checkout-subscribed');
  const subscribedStatus = document.getElementById('pro-checkout-subscribed-status');
  if (![month, year, portal, status, error, choice, subscribed, subscribedStatus].every(Boolean)) return;
  const controls = [month, year, portal];
  let authState = { status: 'checking' };
  let busy = false;
  // Default is always today's buy state (choice shown, subscribed hidden);
  // this only ever moves free -> pro, never the reverse, so a free visitor
  // can never see a "subscribed" flash. See fetchSubscription's own doc.
  let subscription = null;
  let subscriptionRequestId = 0;

  const isSubscribed = () => subscription?.tier === 'pro' && subscription?.active === true;

  const renderControls = () => {
    const ready = (authState.status === 'signed-in' || authState.status === 'signed-out') && !busy;
    const pro = isSubscribed();
    month.disabled = !ready || pro;
    year.disabled = !ready || pro;
    portal.disabled = !ready;
    choice.hidden = pro;
    subscribed.hidden = !pro;
    if (pro) {
      const interval = subscription.billingInterval === 'month'
        ? ' Billed monthly.'
        : subscription.billingInterval === 'year'
          ? ' Billed yearly.'
          : '';
      subscribedStatus.textContent = `You're subscribed — Pro is active.${interval}`;
    }
    if (busy) return;
    status.textContent = authState.status === 'checking'
      ? 'Account controls are loading.'
      : authState.status === 'error' || authState.status === 'disabled'
        ? 'Account sign-in is unavailable right now. Please reload and try again.'
        : authState.status === 'signed-out'
          ? 'Sign in to subscribe to Solvency Pro.'
          : '';
  };

  const run = async (trigger, action) => {
    if (busy || trigger.disabled) return;
    if (authState.status === 'signed-out') { triggerSignIn(); return; }
    if (authState.status !== 'signed-in') return;
    busy = true;
    error.textContent = '';
    for (const control of controls) control.disabled = true;
    trigger.setAttribute('aria-busy', 'true');
    status.textContent = 'Starting Stripe Checkout…';
    try {
      const destination = await action();
      status.textContent = 'Redirecting to Stripe…';
      location.assign(destination);
    } catch (err) {
      error.textContent = describeError(err);
      status.textContent = '';
      busy = false;
      trigger.removeAttribute('aria-busy');
      renderControls();
      trigger.focus();
    }
  };

  month.addEventListener('click', () => { void run(month, () => createCheckout('month')); });
  year.addEventListener('click', () => { void run(year, () => createCheckout('year')); });
  portal.addEventListener('click', () => { void run(portal, createPortal); });

  const stop = observeAuth((state) => {
    const previousUserId = authState.status === 'signed-in' ? authState.userId : null;
    authState = state;
    if (state.status !== 'signed-in') {
      // Signed out (or never signed in): never show subscribed to a visitor
      // we cannot currently verify. Invalidate any in-flight lookup so a
      // late response cannot resurrect a stale subscribed state later.
      subscription = null;
      subscriptionRequestId += 1;
      renderControls();
      return;
    }
    if (state.userId === previousUserId) {
      // Same user re-emitted (e.g. a token refresh): keep whatever this
      // card already knows and just re-render.
      renderControls();
      return;
    }
    // A fresh sign-in (first load, or a different account taking over this
    // session): render today's buy state immediately, then confirm.
    subscription = null;
    renderControls();
    const requestId = ++subscriptionRequestId;
    void fetchSubscription().then((result) => {
      if (requestId !== subscriptionRequestId) return; // superseded by a later auth change
      subscription = result;
      renderControls();
    });
  }, root.dataset.clerkEnabled === 'true');
  addEventListener('pagehide', stop, { once: true });
}

if (typeof document !== 'undefined' && typeof location !== 'undefined') bootProCheckout();
