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

/** Why the modal opened. Stored on the user as unsafeMetadata.intent so intents are countable in Clerk's user list. */
export type Intent = 'gate' | 'save' | 'pro-notify' | 'pro-download';

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

/**
 * Gates open sign-UP: a first-time visitor is asked to create the free
 * account, not to "welcome back". `intent` tags the trigger in the user's
 * unsafeMetadata (with the scenario URL) and `context` is the strip's text.
 */
export const openSignUp = (intent: Intent = 'gate', context?: string) => {
  const c = clerk(); if (!c?.openSignUp) return;
  if (context) showContext(context);
  c.openSignUp({ ...urls(), appearance: clerkAppearance(), unsafeMetadata: { intent, scenario: location.href } });
};
export const openSignIn = () => clerk()?.openSignIn?.({ ...urls(), appearance: clerkAppearance() });

/**
 * Counts a data-analytics click as a custom event if an analytics beacon is
 * present (Cloudflare Zaraz `zaraz.track`, or a beacon exposing trackEvent).
 * Silent when neither is loaded.
 */
export function track(name: string, data?: Record<string, string>): void {
  const w = window as any;
  try {
    if (typeof w.zaraz?.track === 'function') w.zaraz.track(name, data);
    else if (typeof w.__cfBeacon?.trackEvent === 'function') w.__cfBeacon.trackEvent(name, data);
  } catch { /* analytics must never break the page */ }
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
