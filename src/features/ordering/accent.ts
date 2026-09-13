/**
 * The restaurant's accent colour leads the customer menu (spec §16.1), but
 * restaurants can pick any colour, so the text on it is chosen for contrast
 * (≥ 4.5:1, spec §16.2): white, else ink, else the default brand colour is used.
 */

const WHITE = '#FFFFFF';
const INK = '#243040';
export const DEFAULT_ACCENT = '#3B4BA8';

const HEX = /^#[0-9a-f]{6}$/i;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

/** WCAG contrast ratio between two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

export type AccentColors = {
  accent: string;
  foreground: string;
  /** Focus rings need 3:1 against the white page. */
  ring: string;
};

/**
 * CSS for the customer pages. The accent variables go on :root so sheets and
 * dialogs, which render in portals outside the page wrapper, inherit them too;
 * focus shows as a full-strength outline in the ring colour (3:1 on white).
 * Only ever built from accentColors() output, so it contains nothing but hex values.
 */
export function customerThemeCss({ accent, foreground, ring }: AccentColors): string {
  return (
    `:root{--brand:${accent};--brand-foreground:${foreground};` +
    `--primary:${accent};--primary-foreground:${foreground};--ring:${ring}}` +
    ':focus-visible{outline:2px solid var(--ring);outline-offset:2px}'
  );
}

export function accentColors(hex: string): AccentColors {
  const accent = HEX.test(hex) ? hex.toUpperCase() : DEFAULT_ACCENT;
  const ring = contrastRatio(accent, WHITE) >= 3 ? accent : INK;
  if (contrastRatio(accent, WHITE) >= 4.5) return { accent, foreground: WHITE, ring };
  if (contrastRatio(accent, INK) >= 4.5) return { accent, foreground: INK, ring };
  return { accent: DEFAULT_ACCENT, foreground: WHITE, ring: DEFAULT_ACCENT };
}
