import { createClerkClient } from '@clerk/backend';
import type { BuildPlansEnv } from './pages-types.ts';

export type AuthConfiguration = {
  secretKey: string;
  jwtKey: string;
  publishableKey: string;
  authorizedParties: string[];
};

export type OwnerAuthentication =
  | { ok: true; ownerUserId: string }
  | { ok: false; reason: 'configuration' | 'unauthenticated' };

function exactOrigin(value: string, allowLocalhost: boolean): string | null {
  if (!value || value.includes('*')) return null;
  try {
    const url = new URL(value);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.origin !== value || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    if (url.protocol !== 'https:' && !(allowLocalhost && local && url.protocol === 'http:')) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function clerkAuthConfiguration(env: BuildPlansEnv): AuthConfiguration | null {
  const secretKey = env.CLERK_SECRET_KEY?.trim();
  const jwtKey = env.CLERK_JWT_KEY?.trim().replaceAll('\\n', '\n');
  const publishableKey = env.CLERK_PUBLISHABLE_KEY?.trim();
  const rawParties = env.CLERK_AUTHORIZED_PARTIES?.split(',').map((part) => part.trim()).filter(Boolean) ?? [];
  if (!secretKey || !jwtKey || !publishableKey || rawParties.length < 1 || rawParties.length > 4) return null;
  const allowLocalhost = env.APP_ENV === 'development';
  const authorizedParties = rawParties.map((party) => exactOrigin(party, allowLocalhost));
  if (authorizedParties.some((party) => party === null)) return null;
  const exact = authorizedParties as string[];
  if (new Set(exact).size !== exact.length) return null;
  if (env.APP_ENV === 'production' && (exact.length !== 1 || exact[0] !== 'https://solvency.dev')) return null;
  return { secretKey, jwtKey, publishableKey, authorizedParties: exact };
}

export async function authenticateOwner(
  request: Request,
  configuration: AuthConfiguration,
): Promise<OwnerAuthentication> {
  try {
    const client = createClerkClient({
      secretKey: configuration.secretKey,
      jwtKey: configuration.jwtKey,
      publishableKey: configuration.publishableKey,
      telemetry: { disabled: true },
    });
    const state = await client.authenticateRequest(request, {
      acceptsToken: 'session_token',
      jwtKey: configuration.jwtKey,
      authorizedParties: configuration.authorizedParties,
    });
    if (!state.isAuthenticated) return { ok: false, reason: 'unauthenticated' };
    const auth = state.toAuth({ treatPendingAsSignedOut: true });
    if (!auth.isAuthenticated || auth.sessionStatus !== 'active' || !auth.userId) {
      return { ok: false, reason: 'unauthenticated' };
    }
    return { ok: true, ownerUserId: auth.userId };
  } catch {
    return { ok: false, reason: 'unauthenticated' };
  }
}
