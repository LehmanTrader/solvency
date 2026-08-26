# Usage pricing

`invoice(plan, usage)` -> `{ lines, subtotalCents, creditsAppliedCents, totalCents }`.
All money is integer cents; intermediate per-tier amounts round half-up
(`Math.round` on a nonnegative value) AFTER multiplying units by the per-unit price.

`plan`:
- `tiers`: `[{ upTo, centsPerUnit }, ...]` graduated (each tier prices only the units
  inside it), ascending `upTo`, last tier `upTo: null` (unbounded). Non-ascending or
  null before the end: throw Error `bad tiers`.
- `platformFeeCents` per full month, prorated by `daysActive / daysInMonth`
  (round half-up); both come from usage.
- `minimumCents`: if (usage charges + prorated fee) < minimum, add a line
  `{ kind: 'minimum-trueup', cents: gap }` bringing the subtotal to the minimum.
- `credits`: array of `{ id, cents }` applied AFTER the minimum, in array order, each
  capped at the remaining total; skip (do not list) credits once total hits 0.

`usage`: `{ units, daysActive, daysInMonth }` (units a nonnegative integer).

`lines` (in order): one `{ kind: 'tier', upTo, units, cents }` per tier that priced at
least one unit, then `{ kind: 'platform-fee', cents }` if the prorated fee is nonzero,
then the minimum true-up if any. `creditsAppliedCents` is the sum actually applied;
`totalCents = subtotalCents - creditsAppliedCents` (never negative).
