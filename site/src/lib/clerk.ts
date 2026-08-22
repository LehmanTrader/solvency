/**
 * Clerk sign-in for the calculator gate.
 *
 * The publishable key is public by design (it ships in page source) and comes
 * from PUBLIC_CLERK_PUBLISHABLE_KEY at build time. When it is unset, no Clerk
 * script is loaded and the calculator is ungated — local builds and previews
 * keep working with no account.
 *
 * The key encodes the frontend API host as base64 after the second underscore,
 * with a trailing "$". That host serves the clerk-js bundle.
 */
export const CLERK_PUBLISHABLE_KEY: string = import.meta.env.PUBLIC_CLERK_PUBLISHABLE_KEY ?? '';

export function clerkFrontendApi(key: string): string | null {
  const m = /^pk_(test|live)_(.+)$/.exec(key);
  if (!m) return null;
  try {
    const host = atob(m[2]).replace(/\$$/, '');
    return /^[a-z0-9.-]+$/i.test(host) ? host : null;
  } catch { return null; }
}

export const CLERK_FRONTEND_API = clerkFrontendApi(CLERK_PUBLISHABLE_KEY);
export const CLERK_ENABLED = Boolean(CLERK_FRONTEND_API);
