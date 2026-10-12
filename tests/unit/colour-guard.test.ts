import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, it } from 'vitest';

/**
 * Colours come from the theme tokens so they follow light and dark
 * (docs/DECISIONS.md B-3). A fixed colour is only allowed where it must not
 * change with the theme.
 */

const FIXED =
  /\b(?:bg|text|border|ring|fill|stroke|outline|divide|from|to|via|shadow|decoration|accent|caret|placeholder)-(?:white|black|(?:stone|gray|zinc|slate|neutral|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})(?:\/\d+)?\b|-\[#[0-9a-f]{3,8}\]/gi;

const ALLOWED: Record<string, string[]> = {
  // Paper: bills (printed and the guest's copy), QR sheets, the authenticator QR and the logo preview.
  'app/admin/(panel)/tables/print/page.tsx': ['bg-white'],
  'app/admin/(print)/layout.tsx': ['bg-white'],
  'features/billing/components/bill-document.tsx': ['bg-white', 'text-black', 'border-black'],
  'features/billing/components/printable-bill.tsx': ['bg-white'],
  'features/ordering/components/customer-bill.tsx': ['bg-white'],
  'features/platform/components/mfa-forms.tsx': ['bg-white'],
  'features/settings/components/settings-forms.tsx': ['bg-white'],
  // Scrims behind dialogs and sheets.
  'components/ui/alert-dialog.tsx': ['bg-black/10', 'bg-black/60'],
  'components/ui/dialog.tsx': ['bg-black/10', 'bg-black/60'],
  'components/ui/sheet.tsx': ['bg-black/10', 'bg-black/60'],
  // Drawn device hardware and shadows.
  'features/site/components/device-frames.tsx': [
    'bg-stone-300',
    'bg-stone-400',
    'bg-stone-900',
    'shadow-black/20',
    'shadow-black/25',
  ],
  'features/site/components/sections.tsx': ['shadow-black/5'],
};

it('uses theme tokens instead of fixed colours', () => {
  const found: string[] = [];
  for (const file of readdirSync('src', { recursive: true, encoding: 'utf8' })) {
    if (!/\.tsx?$/.test(file)) continue;
    const path = file.replaceAll('\\', '/');
    const allowed = ALLOWED[path] ?? [];
    for (const [match] of readFileSync(join('src', file), 'utf8').matchAll(FIXED)) {
      if (!allowed.includes(match)) found.push(`${path}: ${match}`);
    }
  }
  expect(found).toEqual([]);
});
