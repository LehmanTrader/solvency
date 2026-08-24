export type ClerkPublishableKeyConfiguration = {
  environment: 'test' | 'live';
  frontendHost: string;
  frontendOrigin: string;
};

const PRODUCTION_FRONTEND_HOST = 'clerk.solvency.dev';
const DEVELOPMENT_FRONTEND_SUFFIX = '.clerk.accounts.dev';

function decodeCanonicalBase64(value: string): string | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const unpadded = value.replace(/=+$/, '');
  const suppliedPadding = value.length - unpadded.length;
  if (unpadded.length % 4 === 1) return null;
  const requiredPadding = (4 - (unpadded.length % 4)) % 4;
  // Clerk normally emits unpadded payloads. If padding is supplied, admit only
  // the one canonical amount for this payload length.
  if (suppliedPadding !== 0 && suppliedPadding !== requiredPadding) return null;
  try {
    const padded = `${unpadded}${'='.repeat(requiredPadding)}`;
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const roundTrip = btoa(String.fromCharCode(...bytes)).replace(/=+$/, '');
    return roundTrip === unpadded ? decoded : null;
  } catch {
    return null;
  }
}

function validDnsHost(value: string): boolean {
  if (value.length < 4 || value.length > 253 || value !== value.toLowerCase()
    || value.includes('*') || value.includes('..') || !value.includes('.')) return false;
  const labels = value.split('.');
  if (!labels.every((label) => label.length >= 1 && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return false;
  try {
    const url = new URL(`https://${value}`);
    return url.origin === `https://${value}` && url.hostname === value
      && !url.username && !url.password && url.port === ''
      && url.pathname === '/' && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/**
 * Decode only the two Clerk frontend-host shapes this project operates. The
 * result is safe to place in a CSP source expression without a wildcard.
 */
export function clerkPublishableKeyConfiguration(
  value: unknown,
): ClerkPublishableKeyConfiguration | null {
  if (typeof value !== 'string' || value.trim() !== value) return null;
  const match = /^pk_(test|live)_([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return null;
  const decoded = decodeCanonicalBase64(match[2]);
  if (!decoded?.endsWith('$') || decoded.indexOf('$') !== decoded.length - 1) return null;
  const frontendHost = decoded.slice(0, -1);
  if (!validDnsHost(frontendHost)) return null;
  if (match[1] === 'live' && frontendHost !== PRODUCTION_FRONTEND_HOST) return null;
  if (match[1] === 'test' && (!frontendHost.endsWith(DEVELOPMENT_FRONTEND_SUFFIX)
    || frontendHost === DEVELOPMENT_FRONTEND_SUFFIX.slice(1))) return null;
  return {
    environment: match[1] as 'test' | 'live',
    frontendHost,
    frontendOrigin: `https://${frontendHost}`,
  };
}
