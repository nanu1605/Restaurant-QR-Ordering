import { expect, test } from '@playwright/test';

// Terms and privacy (spec §17, docs/DECISIONS.md P10-5): placeholder pages,
// linked from the login page and the customer menu.

test('the login page links to the terms and the privacy policy', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Terms' }).click();
  await expect(page.getByRole('heading', { name: 'Terms of service', level: 1 })).toBeVisible();
  await expect(page.getByRole('note')).toContainText('Placeholder');

  await page.goto('/login');
  await page.getByRole('link', { name: 'Privacy' }).click();
  await expect(page.getByRole('heading', { name: 'Privacy policy', level: 1 })).toBeVisible();
});

test('the customer menu links to them, in Hindi too', async ({ page }) => {
  // Only viewed: the demo seed stays untouched (P3-17).
  await page.goto('/t/DEMO0000TABLE001');
  await expect(page.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy');
  await page.getByRole('button', { name: 'हिन्दी' }).click();
  await expect(page.getByRole('link', { name: 'गोपनीयता नीति' })).toHaveAttribute(
    'href',
    '/privacy',
  );
  await page.getByRole('link', { name: 'नियम और शर्तें' }).click();
  await expect(page.getByRole('heading', { name: 'Terms of service', level: 1 })).toBeVisible();
});
