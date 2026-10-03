/**
 * The restaurant's accent colour leads the customer menu (spec §16.1), but
 * restaurants can pick any colour, so the text on it is chosen for contrast
 * (≥ 4.5:1, spec §16.2): white, else ink, else the default accent is used.
 * As text and focus rings on the page the accent must stand out from the
 * page itself; where it doesn't, ink takes its place.
 */

const WHITE = '#FFFFFF';
const INK = '#1C1917';
/** The MenuMesh orange (docs/DECISIONS.md B-1); new restaurants start with it. */
export const DEFAULT_ACCENT = '#FF6606';
/** The customer page's backgrounds (globals.css --surface, --paper). */
const PAGE = [WHITE, '#FAF8F5'];

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

const onPage = (color: string, ratio: number) =>
  PAGE.every((background) => contrastRatio(color, background) >= ratio);

export type AccentColors = {
  accent: string;
  /** Text on the accent fill. */
  foreground: string;
  /** The accent as text on the page (4.5:1), else ink. */
  text: string;
  /** Focus rings need 3:1 against the page. */
  ring: string;
};

/**
 * CSS for the customer pages. The accent variables go on :root so sheets and
 * dialogs, which render in portals outside the page wrapper, inherit them too;
 * focus shows as a full-strength outline in the ring colour (3:1 on the page).
 * Only ever built from accentColors() output, so it contains nothing but hex values.
 */
export function customerThemeCss({ accent, foreground, text, ring }: AccentColors): string {
  return (
    `:root{--brand:${text};--primary:${accent};--primary-foreground:${foreground};--ring:${ring}}` +
    ':focus-visible{outline:2px solid var(--ring);outline-offset:2px}'
  );
}

function foregroundOn(accent: string): string | null {
  if (contrastRatio(accent, WHITE) >= 4.5) return WHITE;
  if (contrastRatio(accent, INK) >= 4.5) return INK;
  return null;
}

export function accentColors(hex: string): AccentColors {
  const chosen = HEX.test(hex) ? hex.toUpperCase() : DEFAULT_ACCENT;
  const foreground = foregroundOn(chosen);
  // Neither text colour reads on it: fall back to the MenuMesh orange, which takes ink.
  const accent = foreground ? chosen : DEFAULT_ACCENT;
  const text = onPage(accent, 4.5) ? accent : INK;
  return { accent, foreground: foreground ?? INK, text, ring: onPage(accent, 3) ? accent : text };
}
