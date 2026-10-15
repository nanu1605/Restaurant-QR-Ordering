import { expect, test, type Page } from '@playwright/test';

import { adminClient, createTestRestaurant } from './helpers';
import { createPlatformAdmin, logInAsPlatformAdmin } from './platform-fixtures';

// The standee tracker (docs/SUPER_ADMIN_PLAN.md 14c; docs/DECISIONS.md SA-84,
// SA-85): Sales moves standees along, Finance adds what they cost.

const nav = (page: Page) => page.getByRole('navigation', { name: 'Platform sections' }).first();
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format();

test('Sales takes standees to delivered, which does the QR step; Finance adds the cost', async ({
  browser,
  page,
}) => {
  const restaurant = await createTestRestaurant({ prefix: 'e2e-standee' });
  const path = `/super/restaurants/${restaurant.restaurantId}`;
  await logInAsPlatformAdmin(page, await createPlatformAdmin('e2e-standee', 'sales'));
  await page.goto(path);

  const section = page.getByRole('region', { name: 'Standees' });
  await expect(section).toContainText('Not started');
  await section.getByRole('button', { name: 'Start: to print' }).click();
  await expect(section).toContainText('To print');
  await section.getByRole('button', { name: 'Mark printed today' }).click();
  await expect(section.getByRole('button', { name: 'Mark dispatched today' })).toBeVisible();

  await section.getByRole('button', { name: 'Change' }).click();
  const dialog = page.getByRole('dialog', { name: 'Standees' });
  await expect(dialog.getByLabel('Cost in rupees (optional)')).toHaveCount(0);
  await dialog.getByLabel('How many').fill('6');
  await dialog.getByLabel('Delivered on').fill(today());
  await dialog.getByLabel('Vendor (optional)').fill('PrintCo');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(section.getByRole('button', { name: 'Mark installed today' })).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: 'Onboarding' })
      .getByRole('listitem')
      .filter({ hasText: 'QR codes downloaded, printed or delivered' }),
  ).toContainText('(done)');

  // The tracker, without a cost for Sales; installed from there, it leaves Delivered.
  await nav(page).getByRole('link', { name: 'Standees' }).click();
  await page.getByRole('link', { name: /^Delivered \(/ }).click();
  const row = page.getByRole('row').filter({ hasText: restaurant.name });
  await expect(row).toContainText('PrintCo');
  await expect(row.getByRole('cell').nth(2)).toHaveText('6');
  await expect(page.getByRole('columnheader', { name: 'Cost' })).toHaveCount(0);
  await row.getByRole('button', { name: `Mark installed today: ${restaurant.name}` }).click();
  await expect(row).toBeHidden();

  // Finance sets only the cost.
  const context = await browser.newContext();
  const finance = await context.newPage();
  await logInAsPlatformAdmin(finance, await createPlatformAdmin('e2e-standee-fin', 'finance'));
  await finance.goto(path);
  const financeSection = finance.getByRole('region', { name: 'Standees' });
  await expect(financeSection).toContainText('Installed');
  await financeSection.getByRole('button', { name: 'Change' }).click();
  const costDialog = finance.getByRole('dialog', { name: 'Standees' });
  await expect(costDialog.getByLabel('How many')).toHaveCount(0);
  await costDialog.getByLabel('Cost in rupees (optional)').fill('1200');
  await costDialog.getByRole('button', { name: 'Save' }).click();
  await expect(costDialog).toBeHidden();
  await expect(financeSection).toContainText('₹1,200');
  await context.close();

  const { data: audit } = await adminClient()
    .from('audit_logs')
    .select('action')
    .eq('restaurant_id', restaurant.restaurantId)
    .eq('entity_type', 'standee');
  expect(audit?.map((entry) => entry.action).sort()).toEqual([
    'standee.created',
    'standee.updated',
    'standee.updated',
    'standee.updated',
    'standee.updated',
  ]);
});
