import { expect, test, type Page } from '@playwright/test';

import { adminClient, createTestRestaurant, logInAsOwner } from './helpers';
import { createPlatformAdmin, logInAsPlatformAdmin } from './platform-fixtures';

// Announcements (docs/SUPER_ADMIN_PLAN.md 14c; docs/DECISIONS.md SA-82+). Each
// is for a fresh restaurant only, so other tests' panels never show it.

const nav = (page: Page) => page.getByRole('navigation', { name: 'Platform sections' }).first();

test('an Admin announces to one restaurant; its owner sees it in both panels and hides it', async ({
  browser,
  page,
}) => {
  const restaurant = await createTestRestaurant({ prefix: 'e2e-news' });
  const title = `Menu update ${Date.now().toString(36)}`;
  await logInAsPlatformAdmin(page, await createPlatformAdmin('e2e-news'));
  await nav(page).getByRole('link', { name: 'Announcements' }).click();
  await expect(page.getByRole('heading', { name: 'Announcements', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'New announcement' }).click();
  const form = page.getByRole('dialog', { name: 'New announcement' });
  await form.getByLabel('Title', { exact: true }).fill(title);
  await form.getByLabel('Text', { exact: true }).fill('Prices change on Monday.');
  await form.getByText('Hindi (optional)').click();
  await form.getByLabel('Hindi title').fill('मेन्यू में बदलाव');
  await form.getByLabel('Hindi text').fill('सोमवार से दाम बदलेंगे।');
  await form.getByRole('checkbox', { name: 'Worker panel' }).check();
  await form.getByRole('radio', { name: 'Chosen restaurants' }).check();
  // Nobody chosen yet: refused.
  await form.getByRole('button', { name: 'Create announcement' }).click();
  await expect(form).toContainText('Choose at least one restaurant.');
  await form.getByLabel('Add a restaurant').fill(restaurant.name);
  await form.getByRole('button', { name: `Add ${restaurant.name}` }).click();
  await expect(form.getByRole('list', { name: 'Chosen restaurants' })).toContainText(
    restaurant.name,
  );
  const preview = form.getByRole('region', { name: 'Preview' });
  await expect(preview).toContainText(title);
  await expect(preview).toContainText('मेन्यू में बदलाव');
  await form.getByRole('button', { name: 'Create announcement' }).click();
  await expect(form).toBeHidden();

  const row = page.getByRole('row').filter({ hasText: title });
  await expect(row).toContainText(`1 restaurant: ${restaurant.name}`);
  await expect(row).toContainText('Admin panel, Worker panel · Hindi too');
  await expect(row).toContainText('Live');

  // The owner, using Hindi: English in the admin panel, Hindi in the worker panel.
  await adminClient()
    .from('restaurant_members')
    .update({ ui_lang: 'hi' })
    .eq('restaurant_id', restaurant.restaurantId)
    .eq('role', 'owner')
    .throwOnError();
  const context = await browser.newContext();
  const owner = await context.newPage();
  await logInAsOwner(owner, restaurant);
  await expect(owner.getByRole('status').filter({ hasText: title })).toContainText(
    'Prices change on Monday.',
  );
  await owner.goto('/staff');
  const hindi = owner.getByRole('status').filter({ hasText: 'मेन्यू में बदलाव' });
  await expect(hindi).toContainText('सोमवार से दाम बदलेंगे।');
  await hindi.getByRole('button', { name: 'छिपाएँ' }).click();
  await expect(hindi).toBeHidden();
  await owner.goto('/admin');
  await expect(owner.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(owner.getByText(title)).toHaveCount(0);
  await context.close();

  await page.reload();
  // Hidden by one login.
  await expect(row.getByRole('cell').nth(3)).toHaveText('1');
  await row.getByRole('button', { name: `Actions for ${title}` }).click();
  await page.getByRole('menuitem', { name: 'End now' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'End now' }).click();
  await expect(row).toContainText('Ended');

  const { data: audit } = await adminClient()
    .from('audit_logs')
    .select('action')
    .in('action', ['announcement.created', 'announcement.ended'])
    .eq('after->>title', title);
  expect(audit?.map((entry) => entry.action).sort()).toEqual([
    'announcement.created',
    'announcement.ended',
  ]);
});

test('Sales has no Announcements page', async ({ page }) => {
  await logInAsPlatformAdmin(page, await createPlatformAdmin('e2e-news-sales', 'sales'));
  await expect(nav(page).getByRole('link', { name: 'Announcements' })).toHaveCount(0);
  await page.goto('/super/settings/announcements');
  await expect(page).toHaveURL(/\/super\?denied=1$/);
});
