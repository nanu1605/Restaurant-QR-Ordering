import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  accentColors,
  contrastRatio,
  DEFAULT_ACCENT,
  THEME_PAGES,
} from '@/features/ordering/accent';
import { THEME_COLOR, THEME_COLOR_DARK } from '@/lib/config';

/**
 * The palette in globals.css meets spec §16.2's contrast rules in both themes
 * (docs/DECISIONS.md B-2, B-3): 4.5:1 for text, 3:1 for focus rings, control
 * borders, status edges and chart marks.
 */

const css = readFileSync('src/app/globals.css', 'utf8');

/** The text inside the braces that open at `start`. */
function body(start: number): string {
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) return css.slice(css.indexOf('{', start) + 1, i);
  }
  throw new Error('unbalanced braces');
}

const declarations = (block: string) =>
  Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value!.trim()]),
  );

/** Each theme's tokens, with var() references resolved in that theme. */
function themes(): Record<'light' | 'dark', Record<string, string>> {
  const block = body(css.indexOf(':root,\n.theme-light {'));
  const dark = body(css.indexOf('@variant dark {', css.indexOf(':root,\n.theme-light {')));
  const light = declarations(block.replace(dark, ''));
  const resolveAll = (raw: Record<string, string>) => {
    const resolve = (value: string): string => {
      const reference = /^var\(--([\w-]+)\)$/.exec(value);
      return reference ? resolve(raw[reference[1]!]!) : value.toUpperCase();
    };
    return Object.fromEntries(Object.entries(raw).map(([name, value]) => [name, resolve(value)]));
  };
  return { light: resolveAll(light), dark: resolveAll({ ...light, ...declarations(dark) }) };
}

/** `color` at `alpha` over `background`, as the browser blends bg-x/90. */
function over(color: string, alpha: number, background: string): string {
  const channels = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const [a, b] = [channels(color), channels(background)];
  return `#${a
    .map((v, i) =>
      Math.round(v * alpha + b[i]! * (1 - alpha))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

const all = themes();

describe.each(['light', 'dark'] as const)('%s palette contrast (spec §16.2)', (theme) => {
  const t = all[theme];
  const backgrounds = ['paper', 'surface', 'muted', 'accent'];

  it.each(['ink', 'ink-muted', 'brand', 'status-served', 'status-void', 'attention'])(
    '%s reads as text on every background',
    (text) => {
      for (const background of backgrounds) {
        expect(
          contrastRatio(t[text]!, t[background]!),
          `${text} on ${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it.each([
    ['primary', 'primary-foreground'],
    ['status-placed-fill', 'status-placed-foreground'],
    ['status-preparing-fill', 'status-preparing-foreground'],
    ['status-ready-fill', 'status-ready-foreground'],
    ['status-served-fill', 'status-served-foreground'],
    ['status-void-fill', 'status-void-foreground'],
    ['attention', 'attention-foreground'],
  ])('%s carries %s text', (fill, text) => {
    expect(contrastRatio(t[fill]!, t[text]!)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps button text readable on hover', () => {
    for (const background of ['paper', 'surface']) {
      const hover = over(t.primary!, 0.9, t[background]!);
      expect(contrastRatio(hover, t['primary-foreground']!)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each([
    'input',
    'ring',
    'status-placed',
    'status-preparing',
    'status-ready',
    'status-served',
    'status-void',
    'attention',
    'chart-1',
    'chart-2',
    'chart-3',
    'chart-4',
    'chart-5',
  ])('%s stands out from the page (3:1)', (edge) => {
    for (const background of ['paper', 'surface']) {
      expect(
        contrastRatio(t[edge]!, t[background]!),
        `${edge} on ${background}`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  // Drawn on a white tile in both themes.
  it.each(['food-veg', 'food-non-veg', 'food-egg'])('%s mark reads on white', (mark) => {
    expect(contrastRatio(t[mark]!, '#FFFFFF')).toBeGreaterThanOrEqual(3);
  });
});

describe('colours outside the stylesheet match it', () => {
  const { light, dark } = all;

  it('the default restaurant accent is the primary orange, with the same text', () => {
    expect(DEFAULT_ACCENT).toBe(light.primary);
    expect(dark.primary).toBe(light.primary);
    const colors = accentColors(DEFAULT_ACCENT);
    expect(colors.foreground).toBe(light['primary-foreground']);
    expect(colors.text).toBe(light.ink);
  });

  it('the customer accent is checked against each theme’s page and ink', () => {
    for (const [theme, t] of Object.entries(all)) {
      const pages = THEME_PAGES[theme as keyof typeof THEME_PAGES];
      expect(pages.page).toEqual([t.surface, t.paper]);
      expect(pages.ink).toBe(t.ink);
    }
  });

  it('the browser bar matches the header surface', () => {
    expect(THEME_COLOR).toBe(light.surface);
    expect(THEME_COLOR_DARK).toBe(dark.surface);
  });
});
