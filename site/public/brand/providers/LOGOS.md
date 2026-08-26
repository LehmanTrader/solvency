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

These are Simple Icons' own recorded brand colors, not colors picked by
Solvency — same nominative-use basis as the marks themselves (§ above).

## No clean asset — monogram fallback

| Provider (data/models.json) | Why | Fallback |
|---|---|---|
| `openai` | Checked Simple Icons 2026-08-26: no `openai` or `chatgpt` slug exists in the current icon set (removed/never added, likely over OpenAI's restrictive brand guidelines). No official press-kit SVG was vendored for stage 1 rather than risk an inaccurate or non-license-clean redraw. | Two-letter monogram chip, "OP" |
| `xai` | Checked Simple Icons 2026-08-26: no `xai` slug exists; the only `x`-titled icon is X Corp (Twitter), which is not xAI's mark and would misidentify the provider. | Two-letter monogram chip, "XA" |

Revisit both in a later stage once an official, redistributable brand-kit SVG
is sourced and reviewed (see direction doc §4: "official brand/press kits").

### Stage 1.2 (2026-08-26, Roy's note 1): monogram chip colors

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
