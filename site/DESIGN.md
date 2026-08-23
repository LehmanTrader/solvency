# Solvency site — design brief (design/calculator-first)

Spec: `docs/landing-spec.md` (2026-08-22). Tokens: `docs/brand-review.md` §4.
Baseline replaced: the AA-style hero → leaderboard → highlights → calculator → findings page.

## The page is the calculator

One question, two controls, the ranked answer. Nothing else above the fold.

- `/` — `Calculator.astro`: h1, the control sentence (`I build [tier] tasks, about [n] a
  month`), a log-scale volume slider, then the result card: the `calloutHtml` sentence,
  **Measured** bars, **Modelled** bars (own scale, own header — never interleaved), `Stale` and
  `Not shown` behind `<details>`, the AA attribution string verbatim + verified date, `Copy
  link`, `Save scenario`, and an `Assumptions (4)` disclosure (retry model, cache rate,
  takeover cost, frontier toggle). Below the fold: one proof line from `headline()`, the
  cost-vs-pass-rate scatter with the measured-only Pareto frontier, and a three-tile "how it
  is computed" strip. Every row links to its model page and carries a `compare ›` action to
  `/compare/[a]-vs-[b]?tier=&volume=`.
- URL query is the single source of truth (`?tier=&volume=&variant=&cache=&residual=&frontier=&highlight=`);
  every value is validated before it reaches the engine.

## Charts — `src/lib/charts.ts`

Pure functions `rows → SVG string`, rendered at build (wide and narrow layouts; CSS shows one)
and again by the island. No library, no `<img>` of a report figure on product pages.

| Chart | Function | Where |
|---|---|---|
| A — ranked bars | `rankedBars()` + `patchRanked()` | home result card. Re-sorts in place: rows are `<g class="row">` moved with a 220 ms `transform` transition; bar widths transition too. |
| B — scatter + Pareto | `scatterPareto()` / `paretoFrontier()` | home, below the fold. Frontier on measured points only; modelled hollow; stale hidden behind `Show stale`. Labels placed greedily so none overlap. |
| C — $/month vs volume | `volumeLines()` | `/compare/[pair]`. Max 6 series, categorical ramp; dash carries basis (solid measured, dashed modelled, dotted stale). Drag the marker to set volume. |

Rules: measured = solid `--color-measured`; modelled = hatched `<pattern>` in
`--color-modelled`; stale = dashed hatch in `--color-stale`; the word is always printed.
`<title>` + `<desc>` on every SVG, rows are `role="listitem"` with sentence `aria-label`s,
JetBrains Mono numerals, colors only via CSS variables so one SVG serves light and dark.
`test/charts.test.ts` asserts the measured SVG contains no modelled row.

## The gate — `src/lib/gate.ts`

```ts
export const GATE_MODE: GateMode = 'spec';   // 'free' | 'spec' | 'hard'
```

That line is the whole policy. `'spec'` is the table in the landing spec §3: tier, volume,
retry, compare and copy-link are free; the three assumption controls soft-gate (first touch
shows an inline card once per session with *Keep exploring without it*; declining keeps the
controls usable but the scenario cannot be saved); `Save scenario` hard-gates into
`Clerk.openSignIn`. **Set it to `'hard'` to require sign-in for every control**, `'free'` to
gate nothing. With no `PUBLIC_CLERK_PUBLISHABLE_KEY` at build time the site is ungated
regardless. The header shows `Sign in` (the single amber button in the chrome) or Clerk's
user button when signed in; `Save scenario` writes the scenario URL to the user's
`unsafeMetadata.scenarios`.

## Color — five meanings, nothing else

Amber is measured data as text/fill and "click here to commit" as a filled button. Periwinkle
is modelled, coral is stale, green/coral-red are better/worse deltas, green is a fresh verified
stamp (≤ 30 days). Eyebrows, nav, rules, list markers, focus rings and inline code are neutral.
`$/month` is neutral; only `$/solved` carries the basis color. Light and dark ship from the
same tokens in `global.css` (`#FFB000` never appears on a light ground). Categorical ramp
`--color-s1…s6` for Chart C only.

## Page map

Nav: Calculator · Models · Compare · Methodology · Research · Sign in. Footer: Data (CC-BY),
Embed, Changelog, Source, Privacy, Terms. `/reports*` → `/research*` (Astro `redirects` +
`public/_redirects` 301s for Cloudflare). `/compare` is a two-picker index onto the 300 static
pair pages. `/methodology#sources` absorbed the home page's sources table. Model pages link
to `/?highlight=id`, which outlines that row.

## Kept from the previous brief

Source Serif 4 display / IBM Plex Sans body / JetBrains Mono numerals; tabular numerals,
hairline rules over boxes; the verified-date stamp on every page; `Provenance` line under
every table and chart; AA attribution byte-for-byte; measured vs modelled never ranked against
each other; missing printed as a word. No `scroll-behavior: smooth` — Chrome was observed
never starting the scroll on in-page links.
