# Solvency site — design brief (design/calculator-first)

Spec: `docs/landing-spec.md` (2026-08-22). Tokens: `docs/brand-review.md` §4. Judge reports
(`docs/judges/conversion.md`, `visual.md`, `ux-a11y.md`) drove round 2; every numbered item is
either fixed or listed under *Deliberately not done* below.
Baseline replaced: the AA-style hero → leaderboard → highlights → calculator → findings page.

## The page is the calculator

One question, two controls, the ranked answer. Nothing else above the fold.

- `/` — `Calculator.astro`: h1, the control sentence (`I build [tier] tasks, about [n] a
  month`; content-sized underline controls, a deliberate break after `tasks,` under 640px), a
  log-scale volume slider, then the result card: the `calloutHtml` sentence (names neutral
  bold, the verdict carried by `▼ Nx cheaper` in `--color-better`, same as the compare page),
  a `Find a model` search at the right of the **Measured** header (expands the right group and
  pins the row via `?highlight=`), **Measured** bars, **Modelled** bars (own scale, own header —
  never interleaved), the gate card slot, `Stale` and `Not shown` behind `<details>`, the AA
  attribution string verbatim + verified date, a one-line `Pro (soon): export CSV/JSON ·
  price-change alerts · your own prices → Notify me` (`data-analytics="pro-notify"`), `Copy
  link`, `Save scenario` with its reason line (*Permalink with your name, re-priced when prices
  change.*), and an `Assumptions (4)` disclosure (retry model, cache rate, takeover cost,
  frontier toggle; one 36px control row, labels on one baseline). Below the fold: one proof line from `headline()`, the
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
| A — ranked bars | `rankedBars()` + `patchRanked()` | home result card **and the model page's peer chart** (same component, pinned on the model). Re-sorts in place: rows are `<g class="row">` moved with a 220 ms `transform` transition; bar widths transition too. Every row link carries a full-row-height transparent `rect.hit` so targets are ≥ 44 px in the compact layout. Lead rail is full row height. |
| B — scatter + Pareto | `scatterPareto()` / `paretoFrontier()` | home, below the fold. Frontier on measured points only; modelled hollow; stale hidden behind `Show stale`. 6 px points; labels placed greedily, right-hand slots first, so none overlap; extreme ticks anchor inward; legend and the y caption sit above the frame (no rotated axis title). Points carry `data-*` for the designed tooltip in `index.astro` (`.tip`). Mobile: labels only on frontier + cheapest + dearest. |
| C — $/month vs volume | `volumeLines()` | `/compare/[pair]`. Max 6 series; with ≤ 2 series the cheaper line is amber (the verdict) and the other ink, so the ramp never competes with the provenance rule; 3–6 use the ramp. Dash carries basis (solid measured, dashed modelled, dotted stale). Marker label sits above the frame. Monthly figures via `moneyMonth`. Drag the marker to set volume. |

Rules: measured = solid `--color-measured`; modelled = hatched `<pattern>` in
`--color-modelled`; stale = dashed outline in `--color-stale` (no hatch); the word is always
printed. Chart type uses two sizes only, 10.5 and 12.8 px.
`<title>` + `<desc>` on every SVG, rows are `role="listitem"` with sentence `aria-label`s,
JetBrains Mono numerals, colors only via CSS variables so one SVG serves light and dark.
`test/charts.test.ts` asserts the measured SVG contains no modelled row.

## The gate — `src/lib/gate.ts`

```ts
export const GATE_MODE: GateMode = 'spec';   // 'free' | 'spec' | 'hard'
```

That line is the whole policy. `'spec'` is the table in the landing spec §3: tier, volume,
retry, compare and copy-link are free; the three assumption controls soft-gate; `Save scenario`,
`Download table` (compare) and `Notify me` hard-gate. **Set it to `'hard'` to require sign-in
for every control**, `'free'` to gate nothing. With no `PUBLIC_CLERK_PUBLISHABLE_KEY` at build
time the site is ungated regardless.

The soft gate demos before it asks (conversion judge #1). The first assumption touch in a
session is *applied*: modelled rows move, then the gate card renders beneath them with the
concrete delta from `gateDelta()` — *Cache 50% moves GPT-5.4 from $1.86 to $1.42 a task. Sign in
to keep assumptions and save this scenario — free.* Further assumption touches while the card
is open keep updating the delta. *Keep exploring without it* (or Escape) reverts to the values
before the touch and returns focus to the control that triggered it. After that, once per
session (`sessionStorage`), any assumption touch restores the control and opens the modal
directly. Gates call `Clerk.openSignUp` (not sign-in: a first-time visitor should not be told
"welcome back"), themed from the live CSS tokens (`clerkAppearance()` in `src/lib/clerk-client.ts`)
so the modal matches light or dark, with the title *Create your free Solvency account*. The
header `Sign in` uses `openSignIn` with the same appearance. `Save scenario` writes the scenario
URL to `unsafeMetadata.scenarios`; the compare page has the same Copy link / Save scenario pair
plus `Download table · Pro`, all with `data-analytics` attributes so clicks can be counted.

## Color — five meanings, nothing else

Amber is measured data as text/fill and "click here to commit" as a filled button. Periwinkle
is modelled, coral is stale, green/coral-red are better/worse deltas, green is a fresh verified
stamp (≤ 30 days) — in the source line under a figure only; the header and footer stamps are
neutral. The wordmark is ink with an amber `S`. Eyebrows, nav, rules, list markers, focus rings,
selection (ink at 18%) and inline code are neutral. `$/month` is neutral; only `$/solved`
carries the basis color. Provenance pills are text in the basis color with no box; status is
a neutral word. Light and dark ship from the same tokens in `global.css` (`#FFB000` never
appears on a light ground). Form-control boundaries use `--color-control-border` (≥ 3:1 on the
panel in both themes). Categorical ramp `--color-s1…s6` for Chart C with 3+ series only.

## Type and layout

One container width site-wide: `.wrap` at 72rem. Nine type steps (px): 10.5 · 11.5 · 12.8 ·
14 · 16 · 17.6 · 22.4 · 30.4 · 48 — `.label`/`.eyebrow`/`.pill`/table headers at 10.5,
`.small`/nav/disclosures at 11.5, `.btn`/`.tbl`/tile titles at 12.8, captions 14, body 16, lede
17.6, `.h-section` 22.4, `.h-page` and the sentence 30.4, `.h-display` 48 at ≥ 1200. Radii:
controls 6, cards 8, pills 4. Interactive elements transition color/background/border over
120 ms; disclosure chevrons rotate over 180 ms; reduced motion zeroes all of it. Sections use
one pattern (`Section.astro`: eyebrow + title + caption + rule).

## Fonts

Self-hosted latin subsets in `public/fonts` (variable weight axes, from the Google Fonts CDN
build of each OFL family): IBM Plex Sans 400–700, JetBrains Mono 400–800, Source Serif 4
200–900, each `font-display: swap`. `Base.astro` preloads the serif and the mono (the two
above-the-fold faces). No third-party font request; the privacy page says so.

## Accessibility notes

`#c-callout` and the compare verdict are `aria-live="polite" aria-atomic="true"`; the chart is
not live. Escape closes the gate card. Touch targets at ≤ 639px: chart rows 48px with hit
rects, scatter points 44px hit circles, checkboxes 24px inside 44px rows, theme button 44px,
compare header links padded. `Copy link` shows `Copying…`/`aria-busy` and races the clipboard
against a 1.5 s timeout (`src/lib/copy.ts`). Out-of-range URL values keep the default rather
than clamping. Tables carry a visually-hidden `<caption>` and `th[scope]`. The theme toggle
exposes `aria-pressed` (true = light). A skip link after the callout jumps past the ranked rows.

## Deliberately not done

- Clerk modal subtitle with the live scenario (*Save "heavy · 2,000/mo"*): clerk-js sets copy
  at `load()` via `localization`, not per call; the static subtitle names the benefit instead.
- Visual #4's "theme toggle snaps": only body color/background transition (120 ms); animating
  every token on theme change was judged worse than the snap.
- Visual "mobile variant changes geometry" (Chart A): the compact layout is the designed
  narrow form (month under the name), kept.
- Best-practices Lighthouse < 100 on the gated build: Clerk's dev-key console warning and
  its third-party cookie; not present on the production key.



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
