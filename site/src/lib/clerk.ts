import { clerkPublishableKeyConfiguration } from './clerk-key.ts';

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
  return clerkPublishableKeyConfiguration(key)?.frontendHost ?? null;
}

export const CLERK_FRONTEND_API = clerkFrontendApi(CLERK_PUBLISHABLE_KEY);
if (CLERK_PUBLISHABLE_KEY && !CLERK_FRONTEND_API) {
  throw new Error('PUBLIC_CLERK_PUBLISHABLE_KEY does not encode an allowed exact Clerk frontend host.');
}
export const CLERK_ENABLED = Boolean(CLERK_FRONTEND_API);
