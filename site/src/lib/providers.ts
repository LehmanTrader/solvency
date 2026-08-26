/**
 * Provider logo chips (direction doc §4, docs/redesign-2026-08/direction.md).
 *
 * One small system, shared by every place a model's provider is drawn: the
 * Astro <LogoChip> component (regular HTML contexts) and the inline-SVG
 * ranked-bar rows in charts.ts (which cannot import an .astro component).
 * Both call chipMarkup() below so the chip looks identical everywhere.
 *
 * Vendored marks (site/public/brand/providers/*.svg, see LOGOS.md there) are
 * used only for providers with a license-clean asset. Every other provider —
 * currently openai and xai, neither of which has a usable Simple Icons entry
 * or a vendored press-kit asset yet — gets a neutral two-letter monogram
 * chip instead: never a scraped, hotlinked, or hand-redrawn trademark.
 *
 * The vendored SVGs are served from /public as plain <img>/<image> sources.
 * An externally-referenced SVG image cannot inherit the host page's
 * currentColor (cross-document isolation), so each vendored file bakes in a
 * fixed near-black fill (#1A1D20) and every chip sits on its own fixed
 * near-white square — that reads correctly in both the light and dark app
 * themes without the mark itself needing to re-theme.
 */

export interface ProviderMark { file: string; alt: string; }

/** Providers with a vendored, license-clean SVG mark. Keys match data/models.json's `provider`. */
export const PROVIDER_MARKS: Record<string, ProviderMark> = {
  anthropic: { file: '/brand/providers/anthropic.svg', alt: 'Anthropic' },
  google: { file: '/brand/providers/google.svg', alt: 'Google Gemini' },
  mistral: { file: '/brand/providers/mistral.svg', alt: 'Mistral AI' },
  deepseek: { file: '/brand/providers/deepseek.svg', alt: 'DeepSeek' },
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
 * The chip's inner markup at a 0,0 origin, `size` square: a rounded near-white
 * square, plus either the vendored mark (inset, image element) or the
 * monogram (centered text). Callers wrap this in their own <svg>/<g>.
 */
export function chipMarkup(provider: string, size: number): string {
  const r = Math.max(2, Math.round(size * 0.22));
  const mark = PROVIDER_MARKS[provider];
  const bg = `<rect width="${size}" height="${size}" rx="${r}" fill="${CHIP_BG}" stroke="${CHIP_BORDER}" stroke-width="1"/>`;
  if (mark) {
    const inset = Math.round(size * 0.22);
    const inner = size - inset * 2;
    return `${bg}<image href="${mark.file}" x="${inset}" y="${inset}" width="${inner}" height="${inner}" aria-hidden="true"/>`;
  }
  const fs = Math.round(size * 0.4);
  return `${bg}<text x="${size / 2}" y="${size / 2 + fs * 0.36}" text-anchor="middle" font-family="'JetBrains Mono',monospace" font-weight="700" font-size="${fs}" fill="${CHIP_INK}" aria-hidden="true">${providerMonogram(provider)}</text>`;
}
