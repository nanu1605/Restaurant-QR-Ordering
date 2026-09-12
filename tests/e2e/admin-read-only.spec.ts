import { expect, test } from '@playwright/test';

import { adminClient, createTestRestaurant, logInAsOwner } from './helpers';

// Spec §10.6 + docs/DECISIONS.md P2-1: once a trial has lapsed the admin panel
// explains why, setup changes are paused, and service actions still work.

test('a lapsed trial pauses setup changes but not service actions', async ({ page }) => {
  const restaurant = await createTestRestaurant({ prefix: 'lapsed' });
  const admin = adminClient();

  const { data: category } = await admin
    .from('menu_categories')
    .select('id')
    .eq('restaurant_id', restaurant.restaurantId)
    .eq('name', 'Starters')
    .single();
  await admin.from('menu_items').insert({
    restaurant_id: restaurant.restaurantId,
    category_id: category!.id,
    name: 'Paneer Tikka',
    price_paise: 28000,
    food_type: 'veg',
  });
  // The trial ended two days ago, so the restriction has already started.
  await admin
    .from('restaurant_subscriptions')
    .update({ trial_ends_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() })
    .eq('restaurant_id', restaurant.restaurantId);

  await logInAsOwner(page, restaurant);
  const banner = page.getByRole('alert').filter({ hasText: 'Ordering is paused' });
  await expect(banner).toContainText('Setup changes are paused too.');
  await expect(banner.getByRole('link', { name: 'Choose a plan' })).toHaveAttribute(
    'href',
    '/admin/subscription',
  );

  // Menu: editing is off, the in-stock switch still works.
  await page.goto('/admin/menu');
  await expect(page.getByRole('textbox', { name: 'New category name' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add dish' }).first()).toBeDisabled();
  const saved = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/admin/menu'),
  );
  await page.getByRole('switch', { name: 'Paneer Tikka in stock' }).click();
  await expect(page.getByText('Sold out')).toBeVisible();
  await saved;
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Paneer Tikka in stock' })).not.toBeChecked();

  // Other setup pages are read-only too.
  await page.goto('/admin/tables');
  await expect(page.getByLabel('Table name or range')).toBeDisabled();
  await page.goto('/admin/staff');
  await expect(page.getByRole('button', { name: 'Add staff' })).toBeDisabled();
  await page.goto('/admin/settings');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
});
