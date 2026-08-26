/**
 * Provider logo chips (direction doc §4, docs/redesign-2026-08/direction.md).
 *
 * One small system, shared by every place a model's provider is drawn: the
 * Astro <LogoChip> component (regular HTML contexts) and the inline-SVG
 * ranked-bar rows in charts.ts (which cannot import an .astro component).
 * Both call chipMarkup() below so the chip looks identical everywhere.
 *
 * Vendored marks (site/public/brand/providers/*.svg, see LOGOS.md there) are
 * used only for providers with a license-clean asset. As of stage 1.3, every
 * tracked provider (including openai and xai, added that stage — see
 * LOGOS.md) has one. Any future provider with no clean asset yet falls back
 * to a colored two-letter monogram chip instead: never a scraped, hotlinked,
 * or hand-redrawn trademark.
 *
 * Stage 1.2 (Roy's note 1, 2026-08-26): "the logos next to the model names
 * should be in color not in black and white." Each Simple-Icons-sourced mark
 * bakes in that provider's official Simple Icons brand hex (see LOGOS.md for
 * the source + retrieval date per file) instead of a flat near-black fill.
 * Stage 1.3 added openai and xai as real vendored marks too (see LOGOS.md);
 * both are near-monochrome in official use, so their fill is a fixed dark
 * neutral rather than an invented brand hex — legible either way because the
 * chip square beneath every mark is always the same fixed near-white.
 *
 * The vendored SVGs are served from /public as plain <img>/<image> sources.
 * An externally-referenced SVG image cannot inherit the host page's
 * currentColor (cross-document isolation), so every mark chip sits on its
 * own fixed near-white square (CHIP_BG) — that reads correctly in both the
 * light and dark app themes without the mark itself needing to re-theme.
 * Monogram chips use their own fixed colored background instead (see
 * MONOGRAM_COLORS) for the same reason: theme-independent, always legible.
 */

export interface ProviderMark { file: string; alt: string; }

/** Providers with a vendored, license-clean SVG mark. Keys match data/models.json's `provider`. */
export const PROVIDER_MARKS: Record<string, ProviderMark> = {
  anthropic: { file: '/brand/providers/anthropic.svg', alt: 'Anthropic' },
  google: { file: '/brand/providers/google.svg', alt: 'Google Gemini' },
  mistral: { file: '/brand/providers/mistral.svg', alt: 'Mistral AI' },
  deepseek: { file: '/brand/providers/deepseek.svg', alt: 'DeepSeek' },
  // Stage 1.3 (Roy's note 1, 2026-08-26): "the grok logo is the spacex logo
  // not just a red box with XA, the openai logo needs to be the open ai logo
  // not just a green box with OP." Both marks below are vendored from
  // official sources (see LOGOS.md) rather than the monogram fallback.
  openai: { file: '/brand/providers/openai.svg', alt: 'OpenAI' },
  xai: { file: '/brand/providers/xai.svg', alt: 'xAI' },
};

/** Display label for every provider id in data/models.json, including monogram-only ones. */
export const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', mistral: 'Mistral AI', deepseek: 'DeepSeek', xai: 'xAI',
};

export const providerLabel = (id: string): string => PROVIDER_LABEL[id] ?? id;

/** A plain, non-stylized two-letter monogram — never an attempt at the provider's own wordmark or logotype. */
export const providerMonogram = (id: string): string => id.slice(0, 2).toUpperCase();

export const CHIP_BG = '#F4F3F1';
export const CHIP_BORDER = '#CFCCC6';
export const CHIP_INK = '#1A1D20';

/**
 * Solvency-assigned chip colors for providers with no clean vendored mark.
 * Stage 1.3: openai and xai now have vendored official marks (above), so
 * this map is empty — kept as the fallback path for any future provider
 * that ships with no clean asset (see LOGOS.md "No clean asset — monogram
 * fallback" for the record of intent behind the two colors that used to
 * live here).
 */
export const MONOGRAM_COLORS: Record<string, string> = {};
const MONOGRAM_TEXT = '#FFFFFF';

/**
 * The chip's inner markup at a 0,0 origin, `size` square: a rounded square
 * (near-white for a vendored mark, Solvency-assigned color for a monogram),
 * plus either the mark (inset, image element) or the monogram (centered
 * text). Callers wrap this in their own <svg>/<g>.
 */
export function chipMarkup(provider: string, size: number): string {
  const r = Math.max(2, Math.round(size * 0.22));
  const mark = PROVIDER_MARKS[provider];
  if (mark) {
    const bg = `<rect width="${size}" height="${size}" rx="${r}" fill="${CHIP_BG}" stroke="${CHIP_BORDER}" stroke-width="1"/>`;
    const inset = Math.round(size * 0.22);
    const inner = size - inset * 2;
    return `${bg}<image href="${mark.file}" x="${inset}" y="${inset}" width="${inner}" height="${inner}" aria-hidden="true"/>`;
  }
  const chipColor = MONOGRAM_COLORS[provider] ?? CHIP_BG;
  const textColor = MONOGRAM_COLORS[provider] ? MONOGRAM_TEXT : CHIP_INK;
  const bg = `<rect width="${size}" height="${size}" rx="${r}" fill="${chipColor}"/>`;
  const fs = Math.round(size * 0.4);
  return `${bg}<text x="${size / 2}" y="${size / 2 + fs * 0.36}" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-weight="700" font-size="${fs}" fill="${textColor}" aria-hidden="true">${providerMonogram(provider)}</text>`;
}
