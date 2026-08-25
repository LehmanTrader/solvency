const SUBSCRIPTION_STATUSES = new Set([
  'trialing', 'active', 'past_due', 'paused', 'unpaid',
  'incomplete', 'incomplete_expired', 'canceled',
]);

const STATUS_LABELS = {
  trialing: 'trialing',
  active: 'active',
  past_due: 'past due',
  paused: 'paused',
  unpaid: 'unpaid',
  incomplete: 'incomplete',
  incomplete_expired: 'incomplete expired',
  canceled: 'canceled',
};

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length
    && keys.every((key) => Object.hasOwn(value, key))
    && actual.every((key) => typeof key === 'string' && keys.includes(key));
}

export function stripeSandboxRedirectUrl(value, destination) {
  if (!exactObject(value, ['data']) || !exactObject(value.data, ['url'])
    || typeof value.data.url !== 'string' || value.data.url.length > 4096) return null;
  try {
    const url = new URL(value.data.url);
    if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return null;
    if (destination === 'checkout') {
      return url.search === '' && url.hostname === 'checkout.stripe.com'
        && /^\/(?:c\/)?pay\/cs_test_[A-Za-z0-9_-]+(?:\/.*)?$/.test(url.pathname)
        ? url.href
        : null;
    }
    if (destination !== 'portal') return null;
    if (url.hostname !== 'billing.stripe.com' || url.hash !== '') return null;
    if (url.search === '' && /^\/p\/session\/test_[A-Za-z0-9_-]{8,2048}$/.test(url.pathname)) {
      return url.href;
    }
    if (url.pathname !== '/p/session') return null;
    const secretEntries = [...url.searchParams.entries()];
    return secretEntries.length === 1 && secretEntries[0][0] === 'secret'
      && /^test_[A-Za-z0-9_-]{8,2048}$/.test(secretEntries[0][1])
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function billingReturnMarker(url) {
  if (!(url instanceof URL) || url.hash !== '') return null;
  const entries = [...url.searchParams.entries()];
  if (entries.length !== 1) return null;
  const [key, value] = entries[0];
  if (key === 'checkout' && value === 'success') return 'checkout-success';
  if (key === 'checkout' && value === 'canceled') return 'checkout-canceled';
  if (key === 'billing' && value === 'portal-return') return 'portal-return';
  return null;
}

function exactIsoTimestamp(value) {
  if (typeof value !== 'string' || value.length < 20 || value.length > 32) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

export function stripeSandboxEntitlement(value) {
  if (!exactObject(value, ['data']) || !exactObject(value.data, [
    'tier', 'active', 'source', 'status', 'billingInterval', 'currentPeriodEnd', 'cancelAtPeriodEnd',
  ])) return null;
  const data = value.data;
  if ((data.tier !== 'free' && data.tier !== 'pro') || typeof data.active !== 'boolean'
    || (data.source !== 'none' && data.source !== 'stripe') || typeof data.status !== 'string'
    || (data.billingInterval !== null && data.billingInterval !== 'month' && data.billingInterval !== 'year')
    || typeof data.cancelAtPeriodEnd !== 'boolean') return null;
  if (data.source === 'none') {
    if (data.tier !== 'free' || data.active || data.status !== 'none'
      || data.billingInterval !== null || data.currentPeriodEnd !== null || data.cancelAtPeriodEnd) return null;
  } else if (!SUBSCRIPTION_STATUSES.has(data.status) || !exactIsoTimestamp(data.currentPeriodEnd)
    || data.active !== (data.tier === 'pro')
    || (data.active && !['active', 'trialing'].includes(data.status))
    || (data.active && data.billingInterval === null)) return null;
  return {
    tier: data.tier,
    active: data.active,
    source: data.source,
    status: data.status,
    billingInterval: data.billingInterval,
    currentPeriodEnd: data.currentPeriodEnd,
    cancelAtPeriodEnd: data.cancelAtPeriodEnd,
  };
}

export function stripeSandboxEntitlementMessage(entitlement) {
  if (entitlement.active) {
    return `Verified Preview access: Pro. Stripe status: ${STATUS_LABELS[entitlement.status]}. Cadence: ${entitlement.billingInterval === 'year' ? 'annual' : 'monthly'}. Current test period ends ${entitlement.currentPeriodEnd}. Period-end cancellation: ${entitlement.cancelAtPeriodEnd ? 'scheduled' : 'not scheduled'}.`;
  }
  if (entitlement.source === 'none' || entitlement.status === 'none') {
    return 'Verified Preview access: Free. Stripe status: none. Test Checkout is available for this identity.';
  }
  const terminal = entitlement.status === 'canceled' || entitlement.status === 'incomplete_expired';
  return `Verified Preview entitlement: Free. Stripe status: ${STATUS_LABELS[entitlement.status]}.${terminal ? ' Another test Checkout is permitted.' : ' Manage this existing test subscription in the billing portal.'}`;
}

export class StripeSandboxRequestError extends Error {
  constructor(code, status = null) {
    super(code);
    this.name = 'StripeSandboxRequestError';
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
  if (status >= 500) return 'SERVER_ERROR';
  return 'REQUEST_FAILED';
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

export async function authenticatedJsonFetch(input, init = {}) {
  let url;
  try {
    url = new URL(input, location.href);
  } catch {
    throw new StripeSandboxRequestError('INVALID_URL');
  }
  if (url.origin !== location.origin || url.username || url.password) {
    throw new StripeSandboxRequestError('INVALID_URL');
  }
  const session = window.Clerk?.session;
  if (!session?.getToken) throw new StripeSandboxRequestError('AUTH_REQUIRED', 401);
  const sessionId = typeof session.id === 'string' ? session.id : null;
  const body = init.json === undefined
    ? undefined
    : safeJsonValue(init.json) ? JSON.stringify(init.json) : null;
  if (body === null) throw new StripeSandboxRequestError('INVALID_REQUEST');
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.min(60_000, Math.max(1, init.timeoutMs ?? 12_000)));
  const sessionIsCurrent = () => window.Clerk?.session === session
    || (sessionId !== null && window.Clerk?.session?.id === sessionId);
  const send = async (fresh) => {
    if (!sessionIsCurrent()) throw new StripeSandboxRequestError('SESSION_CHANGED');
    let bearer;
    try {
      bearer = await abortable(
        Promise.resolve(session.getToken(fresh ? { skipCache: true } : undefined)),
        controller.signal,
      );
    } catch {
      if (controller.signal.aborted) {
        throw new StripeSandboxRequestError(timedOut ? 'REQUEST_TIMEOUT' : 'REQUEST_ABORTED');
      }
      throw new StripeSandboxRequestError('TOKEN_UNAVAILABLE');
    }
    if (!bearer) throw new StripeSandboxRequestError('AUTH_REQUIRED', 401);
    if (!sessionIsCurrent()) throw new StripeSandboxRequestError('SESSION_CHANGED');
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
        throw new StripeSandboxRequestError(timedOut ? 'REQUEST_TIMEOUT' : 'REQUEST_ABORTED');
      }
      throw new StripeSandboxRequestError('NETWORK_ERROR');
    }
  };
  try {
    let response = await send(false);
    if (response.status === 401) response = await send(true);
    if (!response.ok) throw new StripeSandboxRequestError(statusCode(response.status), response.status);
    if (!sessionIsCurrent()) throw new StripeSandboxRequestError('SESSION_CHANGED');
    if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      throw new StripeSandboxRequestError('INVALID_RESPONSE', response.status);
    }
    try {
      const value = await response.json();
      if (!sessionIsCurrent()) throw new StripeSandboxRequestError('SESSION_CHANGED');
      return value;
    } catch (error) {
      if (error instanceof StripeSandboxRequestError) throw error;
      throw new StripeSandboxRequestError('INVALID_RESPONSE', response.status);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function idempotencyKey(namespace) {
  return `solvency-${namespace}-v1-${crypto.randomUUID()}`;
}

export async function stripeCheckoutBrowserKey(ownerUserId, sessionId, interval) {
  if (typeof ownerUserId !== 'string' || ownerUserId.length < 4 || ownerUserId.length > 128
    || typeof sessionId !== 'string' || sessionId.length < 4 || sessionId.length > 256
    || (interval !== 'month' && interval !== 'year')) {
    throw new StripeSandboxRequestError('INVALID_REQUEST');
  }
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`solvency-checkout-browser-v1\n${ownerUserId}\n${sessionId}\n${interval}`),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `solvency-checkout-${interval}-v1-${hex}`;
}

async function createCheckout(interval) {
  const ownerUserId = window.Clerk?.user?.id;
  const sessionId = window.Clerk?.session?.id;
  const browserKey = await stripeCheckoutBrowserKey(ownerUserId, sessionId, interval);
  const response = await authenticatedJsonFetch('/api/checkout', {
    method: 'POST',
    // The same signed-in Preview session/cadence deterministically replays an
    // open hosted Checkout after its cancel return without browser storage.
    headers: { 'Idempotency-Key': browserKey },
    json: { interval },
    timeoutMs: 15_000,
  });
  const url = stripeSandboxRedirectUrl(response, 'checkout');
  if (!url) throw new StripeSandboxRequestError('INVALID_RESPONSE');
  return url;
}

async function getEntitlement() {
  const response = await authenticatedJsonFetch('/api/entitlement', { method: 'GET' });
  const entitlement = stripeSandboxEntitlement(response);
  if (!entitlement) throw new StripeSandboxRequestError('INVALID_RESPONSE');
  return entitlement;
}

async function createPortal() {
  const response = await authenticatedJsonFetch('/api/billing-portal', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey('portal') },
    json: {},
    timeoutMs: 15_000,
  });
  const url = stripeSandboxRedirectUrl(response, 'portal');
  if (!url) throw new StripeSandboxRequestError('INVALID_RESPONSE');
  return url;
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

export function bootStripeSandbox() {
  const sandbox = document.getElementById('stripe-sandbox-console');
  if (!sandbox) return;
  const previewOrigin = sandbox.dataset.previewOrigin;
  if (previewOrigin !== 'https://d1-functions-preview.solvency-ru5.pages.dev'
    || location.origin !== previewOrigin) {
    sandbox.remove();
    return;
  }
  sandbox.hidden = false;
  const month = document.getElementById('stripe-sandbox-month');
  const year = document.getElementById('stripe-sandbox-year');
  const portal = document.getElementById('stripe-sandbox-portal');
  const refresh = document.getElementById('stripe-sandbox-refresh');
  const sandboxStatus = document.getElementById('stripe-sandbox-status');
  const sandboxError = document.getElementById('stripe-sandbox-error');
  const returnPanel = document.getElementById('stripe-sandbox-return');
  const returnTitle = document.getElementById('stripe-sandbox-return-title');
  const returnCopy = document.getElementById('stripe-sandbox-return-copy');
  const summary = document.getElementById('stripe-sandbox-summary');
  const identityValue = document.getElementById('stripe-sandbox-identity');
  const accessValue = document.getElementById('stripe-sandbox-access');
  const subscriptionStatusValue = document.getElementById('stripe-sandbox-subscription-status');
  const cadenceValue = document.getElementById('stripe-sandbox-cadence');
  const periodEndValue = document.getElementById('stripe-sandbox-period-end');
  const cancellationValue = document.getElementById('stripe-sandbox-cancellation');
  const checkedValue = document.getElementById('stripe-sandbox-checked');
  if (![month, year, portal, refresh, sandboxStatus, sandboxError, returnPanel, returnTitle, returnCopy,
    summary, identityValue, accessValue, subscriptionStatusValue, cadenceValue, periodEndValue,
    cancellationValue, checkedValue].every(Boolean)) {
    sandbox.remove();
    return;
  }
  const controls = [month, year, portal, refresh];
  let authState = { status: 'checking' };
  let authIdentity = '';
  let busy = false;
  let entitlementChecked = false;
  let checkoutBlocked = true;
  let portalAvailable = false;

  const marker = billingReturnMarker(new URL(location.href));
  if (marker) {
    const content = marker === 'checkout-success'
      ? ['Returned from Stripe Checkout', 'This return URL is not proof of payment or Pro access. Solvency grants test Pro only after a valid Stripe subscription webhook is verified and stored.']
      : marker === 'checkout-canceled'
        ? ['Test Checkout canceled', 'You returned without completing this test Checkout. This message does not delete an earlier test subscription or prove that no Stripe record exists. Retry the same cadence to resume the still-open hosted session, or check verified status.']
        : ['Returned from the Stripe billing portal', 'This return URL does not prove that a subscription changed. Refresh the verified Preview status after Stripe\u2019s webhook is processed.'];
    returnTitle.textContent = content[0];
    returnCopy.textContent = content[1];
    returnPanel.hidden = false;
    requestAnimationFrame(() => returnPanel.focus());
    const clean = new URL(location.href);
    clean.search = '';
    history.replaceState(history.state, '', `${clean.pathname}${clean.hash}`);
  }

  const renderControls = () => {
    const ready = authState.status === 'signed-in' && entitlementChecked && !busy;
    month.disabled = !ready || checkoutBlocked;
    year.disabled = !ready || checkoutBlocked;
    portal.disabled = !ready || !portalAvailable;
    refresh.disabled = authState.status !== 'signed-in' || busy;
    if (busy) return;
    if (authState.status === 'signed-out') {
      sandboxStatus.textContent = 'Sign in above with an isolated Preview account to use the Stripe sandbox.';
    } else if (authState.status === 'checking') {
      sandboxStatus.textContent = 'Preview account controls are loading.';
    } else if (authState.status !== 'signed-in') {
      sandboxStatus.textContent = 'Preview account controls are unavailable. No billing action was started.';
    }
  };

  const clearSummary = () => {
    summary.hidden = true;
    for (const value of [identityValue, accessValue, subscriptionStatusValue, cadenceValue,
      periodEndValue, cancellationValue, checkedValue]) value.textContent = '';
  };

  const renderSummary = (entitlement) => {
    identityValue.textContent = authState.userId;
    accessValue.textContent = entitlement.active ? 'Pro' : 'Free';
    subscriptionStatusValue.textContent = STATUS_LABELS[entitlement.status] ?? 'none';
    cadenceValue.textContent = entitlement.billingInterval === 'month'
      ? 'Monthly' : entitlement.billingInterval === 'year' ? 'Annual' : 'Not applicable';
    periodEndValue.textContent = entitlement.currentPeriodEnd ?? 'Not applicable';
    cancellationValue.textContent = entitlement.cancelAtPeriodEnd ? 'Scheduled' : 'Not scheduled';
    checkedValue.textContent = new Date().toISOString();
    summary.hidden = false;
  };

  const checkEntitlement = async (trigger) => {
    if (busy || authState.status !== 'signed-in') return;
    busy = true;
    sandboxError.textContent = '';
    trigger?.setAttribute('aria-busy', 'true');
    renderControls();
    sandboxStatus.textContent = 'Refreshing verified Preview entitlement\u2026';
    try {
      const entitlement = await getEntitlement();
      entitlementChecked = true;
      checkoutBlocked = entitlement.source === 'stripe'
        && !['canceled', 'incomplete_expired'].includes(entitlement.status);
      portalAvailable = entitlement.source === 'stripe';
      renderSummary(entitlement);
      sandboxStatus.textContent = stripeSandboxEntitlementMessage(entitlement);
    } catch {
      entitlementChecked = false;
      checkoutBlocked = true;
      portalAvailable = false;
      clearSummary();
      sandboxStatus.textContent = 'Verified Preview status failed to load. Billing controls remain disabled.';
      sandboxError.textContent = 'Verified Preview status could not be loaded. Billing controls remain disabled.';
    } finally {
      busy = false;
      trigger?.removeAttribute('aria-busy');
      renderControls();
      if (trigger?.isConnected && !trigger.disabled) trigger.focus();
    }
  };

  const run = async (trigger, action) => {
    if (busy || authState.status !== 'signed-in' || !entitlementChecked || trigger.disabled) return;
    busy = true;
    sandboxError.textContent = '';
    for (const control of controls) control.disabled = true;
    trigger.setAttribute('aria-busy', 'true');
    sandboxStatus.textContent = 'Creating a Stripe test-mode destination\u2026';
    try {
      const destination = await action();
      sandboxStatus.textContent = 'Opening Stripe test mode\u2026';
      location.assign(destination);
    } catch (error) {
      if (error instanceof StripeSandboxRequestError && error.code === 'AUTH_REQUIRED') {
        sandboxError.textContent = 'Your Preview session could not be verified. Sign in again, then retry.';
      } else if (error instanceof StripeSandboxRequestError && error.code === 'NOT_FOUND') {
        sandboxError.textContent = 'No Stripe test customer is linked to this Preview account. Complete a test Checkout first.';
      } else if (error instanceof StripeSandboxRequestError && error.code === 'CONFLICT') {
        sandboxError.textContent = 'A test Checkout or subscription already exists for this account. Wait a few seconds, then retry the same cadence to resume it, or open the test billing portal.';
      } else {
        sandboxError.textContent = 'The Stripe sandbox action could not be confirmed. No navigation occurred. Stop and inspect the Preview billing logs before starting another Checkout.';
      }
      sandboxStatus.textContent = '';
      busy = false;
      trigger.removeAttribute('aria-busy');
      renderControls();
      trigger.focus();
    }
  };

  month.addEventListener('click', () => { void run(month, () => createCheckout('month')); });
  year.addEventListener('click', () => { void run(year, () => createCheckout('year')); });
  portal.addEventListener('click', () => { void run(portal, createPortal); });
  refresh.addEventListener('click', () => { void checkEntitlement(refresh); });
  const stop = observeAuth((state) => {
    const identity = state.status === 'signed-in'
      ? `${state.userId}:${state.sessionId ?? ''}`
      : state.status;
    if (identity === authIdentity) return;
    authIdentity = identity;
    authState = state;
    entitlementChecked = false;
    checkoutBlocked = true;
    portalAvailable = false;
    clearSummary();
    renderControls();
    if (state.status === 'signed-in') void checkEntitlement();
  }, sandbox.dataset.clerkEnabled === 'true');
  addEventListener('pagehide', stop, { once: true });
}

if (typeof document !== 'undefined' && typeof location !== 'undefined') bootStripeSandbox();
