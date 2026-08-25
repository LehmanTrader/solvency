// "Manage billing" custom menu item for Clerk's UserButton
// (site/src/layouts/Base.astro), owner request: billing management belongs
// in the account menu, not as a standing button on the public site.
//
// Rendered only inside `{CHECKOUT_UI_ENABLED && (<script is:inline ...>)}` in
// Base.astro, the same `?raw` + `set:html` technique ProCheckout.astro and
// StripeSandbox.astro use for their own runtimes: Astro statically resolves
// PUBLIC_STRIPE_CHECKOUT_ENABLED at build time, so when the flag is 'false'
// this literal script tag — and every string in it, including
// '/api/billing-portal' — is never rendered into the page and never present
// in dist (see scripts/verify-production-artifact-dark.mjs). It is
// deliberately self-contained rather than importing clerk-client.ts for the
// same reason documented at the top of pro-checkout-runtime.js: an inlined
// raw-text module script cannot resolve a relative `.ts` import specifier in
// the browser.
//
// This file does not mount the UserButton itself — Base.astro's always-present
// auth script does that (mountUserButtonThemed in clerk-client.ts), so the
// menu item survives a theme-toggle re-mount. It only registers the extra
// mount option that script reads, via a window global, and implements the
// menu item's click handler.

/**
 * Same Idempotency-Key + bearer pattern as authenticatedJsonFetch/createPortal
 * in pro-checkout-runtime.js, duplicated (not imported, per the header note
 * above) and reduced to exactly what one menu click needs.
 */
async function openBillingPortal() {
  try {
    const session = window.Clerk?.session;
    if (!session?.getToken) { location.assign('/pricing#pro'); return; }
    const bearer = await session.getToken();
    if (!bearer) { location.assign('/pricing#pro'); return; }
    const response = await fetch('/api/billing-portal', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearer}`,
        'Idempotency-Key': `solvency-portal-menu-v1-${crypto.randomUUID()}`,
      },
      body: '{}',
      credentials: 'same-origin',
      redirect: 'error',
    });
    if (!response.ok || !response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
      location.assign('/pricing#pro');
      return;
    }
    const value = await response.json();
    const url = value && typeof value === 'object' && value.data && typeof value.data.url === 'string'
      ? value.data.url
      : null;
    if (!url) { location.assign('/pricing#pro'); return; }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      location.assign('/pricing#pro');
      return;
    }
    if (parsed.protocol !== 'https:' || parsed.port !== '' || parsed.username || parsed.password) {
      location.assign('/pricing#pro');
      return;
    }
    location.assign(parsed.href);
  } catch {
    // Network failure, aborted request, malformed JSON: land somewhere the
    // account's billing status is visible rather than showing nothing.
    location.assign('/pricing#pro');
  }
}

window.__solvencyUserButtonMountExtras = () => ({
  customMenuItems: [{ label: 'Manage billing', onClick: () => { void openBillingPortal(); } }],
});
