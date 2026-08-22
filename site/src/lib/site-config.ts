/**
 * Cloudflare Web Analytics beacon token.
 *
 * This is NOT a secret — Cloudflare's beacon token is embedded in the page and
 * visible in the page source of every site that uses it. It is committed
 * deliberately so the analytics setup is reproducible from the repository
 * rather than living as invisible dashboard state.
 *
 * Get it from: Cloudflare dashboard -> Web Analytics -> Add a site ->
 * solvency.dev -> copy the `token` value out of the snippet they show.
 *
 * Leave empty to disable. Nothing is loaded and no request is made when unset.
 */
export const CF_BEACON_TOKEN = '';

/** Cookieless, no consent banner required, no personal data collected. */
export const ANALYTICS_NOTE =
  'Cloudflare Web Analytics: cookieless, no cross-site tracking, no personal data.';
