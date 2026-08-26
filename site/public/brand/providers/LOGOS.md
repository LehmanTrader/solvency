# Provider marks — sources and license

Vendored SVG marks for the model providers in `data/models.json`. One file per
provider, saved locally (never hotlinked). Nominative use only: these marks
identify which lab trained a model, in a table cell or chart legend; nothing
here implies sponsorship or endorsement by the provider. Where a provider has
no clean asset under these terms, `LogoChip.astro` falls back to a generated
two-letter monogram chip instead of guessing at or redrawing a trademark.

| File | Provider (data/models.json) | Source | License | Retrieved |
|---|---|---|---|---|
| `anthropic.svg` | `anthropic` | Simple Icons — `icons/anthropic.svg` at `raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/anthropic.svg` | CC0 1.0 Universal | 2026-08-26 |
| `google.svg` | `google` | Simple Icons — `icons/googlegemini.svg` (title "Google Gemini") at `raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/googlegemini.svg` | CC0 1.0 Universal | 2026-08-26 |
| `mistral.svg` | `mistral` | Simple Icons — `icons/mistralai.svg` (title "Mistral AI") at `raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/mistralai.svg` | CC0 1.0 Universal | 2026-08-26 |
| `deepseek.svg` | `deepseek` | Simple Icons — `icons/deepseek.svg` at `raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/deepseek.svg` | CC0 1.0 Universal | 2026-08-26 |
| `openai.svg` | `openai` | OpenAI's icon mark (the interlocking-loop "knot"), isolated as its own path from the combined OpenAI horizontal lockup credited to `openai.com/brand/` and hosted at Wikimedia Commons: `upload.wikimedia.org/wikipedia/commons/d/d3/OpenAI_2017-22_logo.svg` (Commons file `File:OpenAI 2017-22 logo.svg`; Commons `Credit`/`Artist` fields point to OpenAI and `openai.com/brand/`). `openai.com/brand/` itself returned a bot-challenge page (Cloudflare) to every automated fetch attempted for this stage, so the mark was sourced from this Commons-hosted, OpenAI-credited copy of the same official asset rather than hand-redrawn. | Public domain (Commons "PD textlogo"); mark is trademarked — used here nominatively only, see note below | 2026-08-26 |
| `xai.png` | `xai` | xAI's own official app icon, `x.ai/icon.png` (linked from `x.ai/`'s own `<link rel="icon" sizes="512x512">`), tightly cropped to the mark's own pixels (transparent elsewhere) — a stylized angular "X" in the swept style shared with SpaceX, whose brand xAI now shares corporate ownership with; the page currently titles itself "SpaceXAI". A wide inline SVG of the same mark was also captured live from `x.ai/`'s nav (viewBox `0 0 759 290.2`, ~2.6:1) but was not used for the vendored file — see the note below on why the app-icon crop reads better at chip size. | Official mark, direct from the provider's own site — used here nominatively only, see note below | 2026-08-26 |

| `zai.svg` | `zai` | Simple Icons — `icons/zdotai.svg` (title "Z.ai", slug `zdotai`) at `raw.githubusercontent.com/simple-icons/simple-icons/develop/icons/zdotai.svg` | CC0 1.0 Universal | 2026-08-26 |

Simple Icons license: `raw.githubusercontent.com/simple-icons/simple-icons/develop/LICENSE.md`
("CC0 1.0 Universal", checked 2026-08-26).

These are served from `public/` as plain `<img>`/`<image>` sources (via
`LogoChip.astro` and the inline-SVG rows in `charts.ts`), and an externally
referenced SVG image cannot inherit the host page's `currentColor` — so
`chipMarkup()` (`site/src/lib/providers.ts`) puts every mark on its own
fixed near-white chip square (`#F4F3F1` background, a hairline border),
which reads correctly in both the light and dark app themes without the
mark itself needing to re-theme.

### Stage 1.2 (2026-08-26, Roy's note 1): marks in color, not black-and-white

Each vendored path's `fill` was changed from a flat near-black (`#1A1D20`)
to that provider's own **official brand hex**, taken from Simple Icons'
brand-color data (`data/simple-icons.json`, the `hex` field — the same
project the SVG paths themselves come from), retrieved 2026-08-26:

| File | Provider | Official hex | Source field |
|---|---|---|---|
| `anthropic.svg` | Anthropic | `#191919` | `simple-icons.json` → `icons[slug="anthropic"].hex` |
| `google.svg` | Google Gemini | `#8E75B2` | `simple-icons.json` → `icons[slug="googlegemini"].hex` |
| `mistral.svg` | Mistral AI | `#FA520F` | `simple-icons.json` → `icons[slug="mistralai"].hex` |
| `deepseek.svg` | DeepSeek | `#5786FE` | `simple-icons.json` → `icons[slug="deepseek"].hex` |
| `zai.svg` | Z.ai | `#2D2D2D` | `simple-icons.json` → `icons[slug="zdotai"].hex` |

These are Simple Icons' own recorded brand colors, not colors picked by
Solvency — same nominative-use basis as the marks themselves (§ above).

### Free-model coverage (2026-08-26): `zai` provider added

`data/models.json` gained two free-tier rows served directly by Z.ai
(`glm-4.7-flash-zai-free`, `glm-4.5-flash-zai-free`; `provider: "zai"`).
Simple Icons carries a "Z.ai" mark at slug `zdotai` (near-monochrome, official
hex `#2D2D2D`, same CC0 basis as every other mark above) — checked and
vendored the same way `anthropic`/`google`/`mistral`/`deepseek` were, no
monogram fallback needed. `PROVIDER_MARKS.zai` / `PROVIDER_LABEL.zai` in
`site/src/lib/providers.ts` point at this file.

### Stage 1.3 (2026-08-26, Roy's note 1): OpenAI and xAI get their real marks

Roy: "the grok logo is the spacex logo not just a red box with XA, the openai
logo needs to be the open ai logo not just a green box with OP." Both are
now vendored SVGs in `PROVIDER_MARKS` (`site/src/lib/providers.ts`), routed
through the same `chipMarkup()`/`LogoChip.astro` path every other provider
uses — same fixed near-white chip square (`#F4F3F1`), same theme-independent
legibility in light and dark (see the "served from `public/`" note above;
nothing provider-specific was needed for dark-theme contrast because that
square never changes with the site theme).

Both marks are **near-monochrome** in their own official use (OpenAI's knot
has no brand color, just black; xAI's mark uses `currentColor`, rendered
`rgb(10,10,10)` on `x.ai`'s own white background). `openai.svg` bakes in a
fixed `#000000` fill, matching the source file's own unset/default fill.
`xai.png` is a raster crop of xAI's own already-black-on-transparent app
icon — no fill to bake in, the pixels are already the mark's real color.
Because the chip square these marks sit on is always the same fixed
near-white (`#F4F3F1`) regardless of site theme, that dark-on-near-white
pairing is already the "white-on-dark" legibility case solved structurally
— no separate dark-theme fill variant was needed the way it would be if the
mark were ever drawn directly on the page background.

**Why `xai.png`, not the wide SVG lockup:** the mark captured live from
`x.ai/`'s nav is a genuinely wide, asymmetric sweep — its own tight bounding
box is `0 0 759 290.2`, ~2.6:1 — because that rendition is drawn for a
horizontal nav slot. Every other vendored mark here is close to square
(Simple Icons' `24x24` viewBox), and `chipMarkup()`'s `<image>` inset uses
one `size` for both width and height, so a 2.6:1 mark would be scaled to
fit width and letterboxed to a thin sliver vertically — technically correct
but small enough to undercut the point of Roy's note ("not just a red box
with XA" — a hard-to-read mark isn't much better than a monogram). xAI's own
`icon.png` (their `<link rel="icon" sizes="512x512">`, i.e. the app-icon
composition, not the nav lockup) uses noticeably tighter padding around the
same mark — its own pixel bounding box is ~1.9:1 — so cropping to just those
pixels (`xai.png` here, transparent elsewhere) renders visibly larger and
more legible inside the square chip than the SVG lockup would, while still
being the same official mark from the same official source, just the
icon-composition crop rather than the nav-lockup crop.

Both files are used **nominatively only**: they identify which lab trained a
model, in a table cell, chart marker, or share card; nothing here implies
sponsorship or endorsement by OpenAI or xAI, and neither mark is
redistributed as a downloadable asset — it is inlined into Solvency's own
UI only, the same basis every other mark in this file already stands on.

## No clean asset — monogram fallback (historical: stage 1–1.2 only)

**Superseded by Stage 1.3 above** — `openai` and `xai` both moved into
`PROVIDER_MARKS` with real vendored marks on 2026-08-26. This section stays
as the record of why they started as monograms and is the pattern to reuse
if a future provider ships with no clean asset yet.

| Provider (data/models.json) | Why | Fallback |
|---|---|---|
| `openai` | Checked Simple Icons 2026-08-26: no `openai` or `chatgpt` slug exists in the current icon set (removed/never added, likely over OpenAI's restrictive brand guidelines). No official press-kit SVG was vendored for stage 1 rather than risk an inaccurate or non-license-clean redraw. | Two-letter monogram chip, "OP" |
| `xai` | Checked Simple Icons 2026-08-26: no `xai` slug exists; the only `x`-titled icon is X Corp (Twitter), which is not xAI's mark and would misidentify the provider. | Two-letter monogram chip, "XA" |

Revisit both in a later stage once an official, redistributable brand-kit SVG
is sourced and reviewed (see direction doc §4: "official brand/press kits").

### Stage 1.2 (2026-08-26, Roy's note 1): monogram chip colors (historical, superseded — see Stage 1.3 above)

`openai` and `xai` still have no clean vendored mark, so their chip is a
colored square with a plain two-letter monogram rather than a logo image.
Roy's note asked for "a tasteful distinct chip color" for these — the colors
below are **Solvency's own chip-color assignment**, chosen for legibility and
to stay visually distinct from the vendored marks above and from the site's
own purple/amber accent system. They are explicitly NOT the provider's
official brand color (neither provider publishes one Simple Icons could
source), and must never be presented as such elsewhere in the codebase or
copy.

| Provider | Chip color | Contrast vs. white monogram text |
|---|---|---|
| `openai` | `#0F7A63` (deep teal-green) | 5.27:1 (WCAG AA) |
| `xai` | `#9C4A75` (deep plum-rose) | 5.75:1 (WCAG AA) |

Defined in `site/src/lib/providers.ts` as `MONOGRAM_COLORS`.
