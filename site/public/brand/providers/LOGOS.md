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

Each vendored path was given a fixed `fill="#1A1D20"` (the upstream files
ship with no fill, defaulting to SVG's initial black). These are served from
`public/` as plain `<img>` sources (via `LogoChip.astro`), and an externally
referenced SVG image cannot inherit the host page's `currentColor` — so
`LogoChip` instead puts every mark on its own fixed near-white chip square
(`#F4F3F1` background, a hairline border), which reads correctly in both the
light and dark app themes without the mark itself needing to re-theme.

## No clean asset — monogram fallback

| Provider (data/models.json) | Why | Fallback |
|---|---|---|
| `openai` | Checked Simple Icons 2026-08-26: no `openai` or `chatgpt` slug exists in the current icon set (removed/never added, likely over OpenAI's restrictive brand guidelines). No official press-kit SVG was vendored for stage 1 rather than risk an inaccurate or non-license-clean redraw. | Two-letter monogram chip, "OP" |
| `xai` | Checked Simple Icons 2026-08-26: no `xai` slug exists; the only `x`-titled icon is X Corp (Twitter), which is not xAI's mark and would misidentify the provider. | Two-letter monogram chip, "XA" |

Revisit both in a later stage once an official, redistributable brand-kit SVG
is sourced and reviewed (see direction doc §4: "official brand/press kits").
