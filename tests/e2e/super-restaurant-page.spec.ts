import { expect, test } from '@playwright/test';

import { adminClient, createTestRestaurant } from './helpers';
import {
  createPlatformAdmin,
  logInAsPlatformAdmin,
  restaurantAction,
  restaurantTab,
} from './platform-fixtures';

// A restaurant's page (docs/SUPER_ADMIN_PLAN.md 13a; DECISIONS SA-33 to SA-40):
// the header, tabs, notes, tags, the account manager and the timeline.

test('the team notes, tags and looks after a restaurant, and its timeline shows it all', async ({
  page,
}) => {
  const restaurant = await createTestRestaurant({ prefix: 'e2e-page' });
  const admin = await createPlatformAdmin('e2e-page');
  const tagName = `E2E ${restaurant.slug.slice(-8)}`;
  // A reminder the daily cron emailed, for the timeline.
  await adminClient()
    .from('subscription_reminders')
    .insert({
      restaurant_id: restaurant.restaurantId,
      kind: 'trial_ends_3d',
      due_key: new Date().toISOString().slice(0, 10),
    })
    .throwOnError();

  await logInAsPlatformAdmin(page, admin);
  await page.goto(`/super/restaurants/${restaurant.restaurantId}`);
  const main = page.getByRole('main');
  const dialog = page.getByRole('dialog');
  await expect(page.getByRole('heading', { name: restaurant.name, level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 }).locator('..')).toContainText('Trial');
  await expect(main.getByText('Trial till')).toBeVisible();
  const tabs = page.getByRole('navigation', { name: 'Restaurant sections' });
  await expect(tabs.getByRole('link', { name: 'Overview' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  // A note from Actions shows on the Overview.
  await restaurantAction(page, 'Add note');
  await dialog.getByLabel('Note').fill('Prefers calls after 4 pm');
  await dialog.getByRole('button', { name: 'Save note' }).click();
  await expect(dialog).toBeHidden();
  const notes = main.getByRole('region', { name: 'Notes' });
  await expect(notes).toContainText('Prefers calls after 4 pm');
  await expect(notes).toContainText(admin.email);

  // A new tag, ticked and saved, is on the header.
  await main.getByRole('button', { name: 'Add tags' }).click();
  await dialog.getByLabel('Name').fill(tagName);
  await dialog.getByRole('radio', { name: 'Teal' }).check();
  await dialog.getByRole('button', { name: 'Add tag' }).click();
  await expect(dialog.getByRole('checkbox', { name: tagName })).toBeChecked();
  await dialog.getByRole('button', { name: 'Save tags' }).click();
  await expect(dialog).toBeHidden();
  await expect(main.getByRole('list', { name: 'Tags' })).toContainText(tagName);

  // This admin looks after it.
  await main.getByRole('button', { name: /^Account manager: none/ }).click();
  await page.getByRole('menuitemradio', { name: admin.email }).click();
  await expect(main.getByRole('button', { name: `Account manager: ${admin.email}` })).toBeVisible();

  // Team actions and a payment, for the timeline.
  await restaurantAction(page, 'Extend trial');
  await dialog.getByLabel('Days to add').fill('5');
  await dialog.getByRole('button', { name: 'Extend trial' }).click();
  await expect(dialog).toBeHidden();
  await restaurantAction(page, 'Record payment');
  await dialog.getByLabel('Amount received, with GST (₹)').fill('399');
  await dialog.getByLabel('Paid by').selectOption({ label: 'UPI' });
  await dialog.getByRole('button', { name: 'Record payment' }).click();
  await expect(dialog).toBeHidden();

  // Notes: pinned, then edited while it may be.
  await restaurantTab(page, 'Notes');
  const note = main.getByRole('region', { name: 'Notes' }).getByRole('listitem').first();
  await note.getByRole('button', { name: 'Pin' }).click();
  await expect(note).toContainText('Pinned');
  await note.getByRole('button', { name: 'Edit' }).click();
  await note.getByLabel('Edit note').fill('Prefers calls after 5 pm');
  await note.getByRole('button', { name: 'Save' }).click();
  await expect(note).toContainText('Prefers calls after 5 pm');
  await expect(note).toContainText('(edited)');

  // The timeline merges every kind, newest first, and filters by one.
  await restaurantTab(page, 'Activity');
  const timeline = main.getByRole('region', { name: 'Timeline' });
  for (const title of [
    'Pinned note',
    'Payment received',
    'Trial extended',
    'Reminder emailed',
    'Onboarded by the team',
  ]) {
    await expect(timeline.getByText(title, { exact: true })).toBeVisible();
  }
  await expect(timeline.getByText('Tags changed', { exact: true })).toBeVisible();
  await expect(timeline.getByText('Account manager changed', { exact: true })).toBeVisible();
  // No restaurant name on each item: they are all this one's.
  await expect(timeline.getByRole('listitem').first()).not.toContainText(restaurant.name);
  await timeline
    .getByRole('navigation', { name: 'Activity kinds' })
    .getByRole('link', { name: 'Notes' })
    .click();
  await expect(timeline.getByRole('listitem')).toHaveCount(1);
  await expect(timeline.getByRole('listitem')).toContainText('Prefers calls after 5 pm');

  // Billing has the payment with its GST, Documents the profile.
  await restaurantTab(page, 'Billing');
  const payments = main.getByRole('table', { name: 'Payments' });
  await expect(payments).toContainText('₹338.14');
  await expect(payments).toContainText('₹60.86');
  await expect(payments).toContainText('₹399.00');
  await expect(main.getByRole('region', { name: 'Plan and subscription history' })).toContainText(
    'Trial extended by 5 days',
  );
  await restaurantTab(page, 'Documents');
  await expect(main.getByRole('region', { name: 'Profile' })).toBeVisible();

  // On the list: My restaurants, and the tag as a filter and a column.
  await page.goto('/super/restaurants');
  await page
    .getByRole('navigation', { name: 'Views' })
    .getByRole('link', { name: 'My restaurants' })
    .click();
  await expect(page.getByRole('row').filter({ hasText: restaurant.name })).toBeVisible();
  const { data: tag } = await adminClient()
    .from('platform_tags')
    .select('id')
    .eq('name', tagName)
    .single()
    .throwOnError();
  await page.goto(`/super/restaurants?tag=${tag!.id}`);
  const rows = page.getByRole('table', { name: 'Restaurants' }).getByRole('row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1).locator('[data-col="tags"]')).toContainText(tagName);

  await adminClient().from('platform_tags').delete().eq('id', tag!.id).throwOnError();
});
