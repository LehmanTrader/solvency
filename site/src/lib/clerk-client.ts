/**
 * Browser-side Clerk helpers shared by the calculator, the compare page and
 * the header. clerk-js is loaded from a <script> in Base.astro only when a
 * publishable key was set at build time, so every call here is a no-op in an
 * ungated build. The modal is themed from the page's own tokens at open time,
 * so it matches whichever theme the visitor is in.
 */
const clerk = () => (window as any).Clerk;
export const signedIn = (): boolean => Boolean(clerk()?.user);

/** Runs cb once Clerk has loaded and again on every auth change. */
export function onClerk(cb: () => void): void {
  const ready = () => { cb(); clerk()?.addListener?.(cb); };
  if (clerk()?.loaded) ready(); else document.addEventListener('clerk:ready', ready, { once: true });
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

/** Gates open sign-UP: a first-time visitor is asked to create the free account, not to "welcome back". */
export const openSignUp = () => clerk()?.openSignUp?.({ ...urls(), appearance: clerkAppearance() });
export const openSignIn = () => clerk()?.openSignIn?.({ ...urls(), appearance: clerkAppearance() });

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
export function wireSave(btn: HTMLButtonElement | null, idle = 'Save scenario'): void {
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!signedIn()) { openSignUp(); return; }
    btn.setAttribute('aria-busy', 'true');
    btn.textContent = 'Saving…';
    try { await saveScenario(location.href); btn.textContent = 'Saved ✓'; }
    catch { btn.textContent = 'Could not save'; }
    btn.removeAttribute('aria-busy');
    setTimeout(() => (btn.textContent = idle), 1800);
  });
}
