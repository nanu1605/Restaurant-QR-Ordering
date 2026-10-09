import { expect, test } from '@playwright/test';

// Prices don't pull in Noto Sans's latin-ext file (168 KB): every ₹ is drawn in the
// system font (docs/DECISIONS.md W-14). The latin-ext face is the one covering U+100-2BA.

for (const path of ['/', '/pricing', '/t/DEMO0000TABLE001']) {
  test(`${path} shows prices without the latin-ext font`, async ({ page }) => {
    await page.goto(path, { waitUntil: 'load' });
    await expect(page.getByText('₹').first()).toBeVisible();
    const faces = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts]
        .filter((face) => face.unicodeRange.includes('U+100-2BA'))
        .map((face) => face.status);
    });
    expect(faces.length).toBeGreaterThan(0);
    expect(faces).not.toContain('loaded');
    expect(faces).not.toContain('loading');
  });
}
