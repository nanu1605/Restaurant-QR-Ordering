import { expect, test } from '@playwright/test';

import { createTestRestaurant, DEMO_PASSWORD, logInAsOwner, logInWithCode } from './helpers';

// Spec §13.3: sidebar navigation on wide screens, a menu sheet on phones;
// Subscription is owner-only.

test('admin navigation works on this screen size', async ({ page, isMobile }) => {
  const restaurant = await createTestRestaurant({ prefix: 'nav' });
  await logInAsOwner(page, restaurant);

  if (isMobile) {
    await expect(page.getByRole('navigation', { name: 'Admin sections' })).toBeHidden();
    await page.getByRole('button', { name: 'Open menu' }).click();
  }
  const nav = page.getByRole('navigation', { name: 'Admin sections' });
  await expect(nav.getByRole('link', { name: 'Subscription' })).toBeVisible();
  await nav.getByRole('link', { name: 'Tables & QR' }).click();
  await expect(page).toHaveURL(/\/admin\/tables$/);
  await expect(page.getByRole('heading', { name: 'Tables & QR', level: 1 })).toBeVisible();

  if (isMobile) {
    // The sheet closes after choosing a section.
    await expect(page.getByRole('navigation', { name: 'Admin sections' })).toBeHidden();
    await page.getByRole('button', { name: 'Open menu' }).click();
  }
  await expect(
    page
      .getByRole('navigation', { name: 'Admin sections' })
      .getByRole('link', { name: 'Tables & QR' }),
  ).toHaveAttribute('aria-current', 'page');
});

test('the demo manager does not see the owner-only Subscription section', async ({
  page,
  isMobile,
}) => {
  await page.goto('/login');
  await logInWithCode(page, 'demo', 'manager', DEMO_PASSWORD);
  await expect(page).toHaveURL(/\/admin$/);

  if (isMobile) await page.getByRole('button', { name: 'Open menu' }).click();
  const nav = page.getByRole('navigation', { name: 'Admin sections' });
  await expect(nav.getByRole('link', { name: 'Settings' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Subscription' })).toHaveCount(0);

  await page.goto('/admin/subscription');
  await expect(page).toHaveURL(/\/admin$/);
});
