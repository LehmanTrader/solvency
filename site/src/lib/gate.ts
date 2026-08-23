/**
 * The sign-in gate, in one place (docs/landing-spec.md §3).
 *
 * Three classes of control:
 *   free  — the question itself: tier, volume, retry model, compare, copy link.
 *   soft  — the assumption controls (cache, takeover, frontier). They move
 *           modelled rows only. First touch shows an inline sign-in card with a
 *           "keep exploring" escape; decline and they stay usable, but the
 *           scenario cannot be saved.
 *   hard  — Save scenario (later: export, alerts). Opens Clerk directly.
 *
 * GATE_MODE is the one switch. 'spec' is the table above; 'hard' gates every
 * control behind sign-in; 'free' gates nothing. When no Clerk key is set at
 * build time the site is always ungated regardless of this value.
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

/** sessionStorage keys: the card is shown once per session; a decline is remembered. */
export const GATE_SEEN_KEY = 'solvency.gate.seen';
export const GATE_DECLINED_KEY = 'solvency.gate.declined';
