/**
 * Light or dark (docs/DECISIONS.md B-3). The choice is the `theme` cookie on
 * this device; no cookie means follow the device's own setting.
 */

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_COOKIE = 'theme';

export function parseTheme(value: unknown): Theme {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export type ThemeLabels = Record<Theme, string> & { group: string };

export const THEME_LABELS: ThemeLabels = {
  group: 'Theme',
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};
