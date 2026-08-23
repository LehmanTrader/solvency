/**
 * The sign-in gate, in one place (docs/landing-spec.md §3).
 *
 * Three classes of control:
 *   free  — the question itself: tier, volume, retry model, compare, copy link.
 *   soft  — the assumption controls (cache, takeover, frontier). They move
 *           modelled rows only. The first touch is let through so the visitor
 *           sees the rows move, then an inline card beneath them names the
 *           concrete delta and asks for the free account. "Keep exploring
 *           without it" reverts the change; from then on (once per session)
 *           touching an assumption opens the sign-up modal directly.
 *   hard  — Save scenario (later: export, alerts). Opens Clerk directly.
 *
 * GATE_MODE is the one switch. 'spec' is the table above; 'hard' gates every
 * control behind sign-in; 'free' gates nothing. When no Clerk key is set at
 * build time the site is always ungated regardless of this value.
 *
 * This gate is a conversion UX only. It must never protect paid data or APIs;
 * future paid entitlements belong in server-verified Clerk/Stripe state.
 */
export type GateMode = 'free' | 'spec' | 'hard';
export type GateClass = 'free' | 'soft' | 'hard';
export type Control = 'tier' | 'volume' | 'variant' | 'compare' | 'copy' | 'cache' | 'residual' | 'frontier' | 'save';

/** Flip to 'hard' to require sign-in for everything; 'free' to gate nothing. */
export const GATE_MODE: GateMode = 'spec';

const SPEC: Record<Control, GateClass> = {
  tier: 'free', volume: 'free', variant: 'free', compare: 'free', copy: 'free',
  cache: 'soft', residual: 'soft', frontier: 'soft',
  save: 'hard',
};

export function gateFor(control: Control, mode: GateMode = GATE_MODE): GateClass {
  if (mode === 'free') return 'free';
  if (mode === 'hard') return 'hard';
  return SPEC[control];
}

/** sessionStorage key: the demo card is shown once per session; after that the modal opens directly. */
export const GATE_SEEN_KEY = 'solvency.gate.seen';
