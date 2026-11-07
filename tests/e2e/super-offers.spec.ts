import { expect, test, type Page } from '@playwright/test';

import { adminClient, createTestRestaurant } from './helpers';
import { createPlatformAdmin, logInAsPlatformAdmin } from './platform-fixtures';

// Offers, a restaurant's price and overrides (docs/SUPER_ADMIN_PLAN.md 14b;
// docs/DECISIONS.md SA-77+).

const nav = (page: Page) => page.getByRole('navigation', { name: 'Platform sections' }).first();

test('an Admin makes an offer, changes how often it can be used, and ends it', async ({ page }) => {
  const code = `E2E${Date.now().toString(36).toUpperCase()}`;
  await logInAsPlatformAdmin(page, await createPlatformAdmin('e2e-offers'));
  await nav(page).getByRole('link', { name: 'Offers' }).click();
  await expect(page.getByRole('heading', { name: 'Offers', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'New offer' }).click();
  const form = page.getByRole('dialog', { name: 'New offer' });
  await form.getByLabel('Code').fill(code.toLowerCase());
  await form.getByLabel('Discount').selectOption('flat');
  await form.getByLabel('Rupees').fill('100');
  await form.getByRole('checkbox', { name: 'Growth' }).check();
  await form.getByLabel('For the first charges (optional)').fill('2');
  await form.getByLabel('Most uses (optional)').fill('5');
  await form.getByRole('button', { name: 'Create offer' }).click();
  await expect(form).toBeHidden();

  const row = page.getByRole('row').filter({ hasText: code });
  await expect(row).toContainText('₹100 off');
  await expect(row).toContainText('Growth, monthly or yearly · first 2 charges');
  await expect(row).toContainText('0 of 5');
  await expect(row).toContainText('Live');

  // The same code again is refused.
  await page.getByRole('button', { name: 'New offer' }).click();
  await form.getByLabel('Code').fill(code);
  await form.getByLabel('Percent').fill('10');
  await form.getByRole('button', { name: 'Create offer' }).click();
  await expect(form.getByRole('alert')).toContainText('An offer already uses that code');
  await page.keyboard.press('Escape');

  await row.getByRole('button', { name: `Actions for ${code}` }).click();
  await page.getByRole('menuitem', { name: 'Change' }).click();
  const edit = page.getByRole('dialog', { name: `Change ${code}` });
  await edit.getByLabel('Most uses (optional)').fill('10');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(row).toContainText('0 of 10');

  await row.getByRole('button', { name: `Actions for ${code}` }).click();
  await page.getByRole('menuitem', { name: 'End offer' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'End offer' }).click();
  await expect(row).toContainText('Ended');
  const { data: audit } = await adminClient()
    .from('audit_logs')
    .select('action')
    .in('action', ['offer.created', 'offer.updated', 'offer.ended'])
    .eq('after->>code', code);
  expect(audit?.map((entry) => entry.action).sort()).toEqual(['offer.created', 'offer.ended']);
});

test('a restaurant gets an agreed price and an override, then both go back', async ({ page }) => {
  const restaurant = await createTestRestaurant({ prefix: 'e2e-deal' });
  await logInAsPlatformAdmin(page, await createPlatformAdmin('e2e-deal'));
  const base = `/super/restaurants/${restaurant.restaurantId}`;

  // Billing: a price we agreed, on its trial's plan, applies at once.
  await page.goto(`${base}/billing`);
  const price = page.getByRole('region', { name: 'Price' });
  await expect(price).toContainText('The list price');
  await price.getByRole('button', { name: 'Set a price' }).click();
  const deal = page.getByRole('dialog', { name: 'Set a price' });
  await deal.getByRole('radio', { name: 'A price we agreed' }).check();
  await expect(deal).toContainText('List price ₹899 a month + GST.');
  await deal.getByLabel('Price before GST, in rupees').fill('699');
  await deal.getByLabel('Why').fill('A chain of three, agreed in person');
  await deal.getByRole('button', { name: 'Set the price' }).click();
  await expect(deal).toBeHidden();
  await expect(price).toContainText(
    '₹699 a month + GST · agreed price · A chain of three, agreed in person',
  );
  const history = page.getByRole('region', { name: 'Plan and subscription history' });
  await expect(history).toContainText('Price set: ₹699 a month on Growth');

  await price.getByRole('button', { name: 'Back to the list price' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'End the price' }).click();
  await expect(price).toContainText('The list price');

  // Usage: more staff logins than Growth's 15, then back to the plan.
  await page.goto(`${base}/usage`);
  const overrides = page.getByRole('region', { name: 'Overrides and beta flags' });
  await expect(overrides).toContainText('None: the plan as it is.');
  await overrides.getByRole('button', { name: 'Add an override' }).click();
  const add = page.getByRole('dialog', { name: 'Add an override' });
  await add.getByLabel('What').selectOption('max_staff');
  await add.getByLabel('Staff logins').fill('20');
  await add.getByLabel('Why').fill('A big kitchen team');
  await add.getByRole('button', { name: 'Add override' }).click();
  await expect(overrides).toContainText('Staff logins: 20');
  await expect(page.getByRole('region', { name: 'Usage' })).toContainText('of 20');

  await overrides.getByRole('button', { name: 'Remove Staff logins: 20' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
  await expect(overrides).toContainText('None: the plan as it is.');
});
