import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { adminClient, createTestRestaurant } from './helpers';
import { createPlatformAdmin, logInAsPlatformAdmin } from './platform-fixtures';

/**
 * Money pages (docs/SUPER_ADMIN_PLAN.md 12c; docs/DECISIONS.md SA-17 to
 * SA-20): a failed payment shows in Dues with a way to call, message and
 * take payment; the payment then shows in the ledger and its CSV.
 */

test('a failed payment is chased from Dues and lands in the ledger and its CSV', async ({
  page,
}) => {
  const restaurant = await createTestRestaurant({ prefix: 'dues' });
  const db = adminClient();
  await db
    .from('restaurants')
    .update({ phone: '+91 98765-00550', city: 'Indore' })
    .eq('id', restaurant.restaurantId)
    .throwOnError();
  await db
    .from('restaurant_subscriptions')
    .update({
      status: 'past_due',
      source: 'razorpay',
      razorpay_status: 'pending',
      billing_cycle: 'monthly',
      trial_ends_at: null,
      current_period_end: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      grace_until: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
    })
    .eq('restaurant_id', restaurant.restaurantId)
    .throwOnError();

  const admin = await createPlatformAdmin('money');
  await logInAsPlatformAdmin(page, admin);
  const nav = page.getByRole('navigation', { name: 'Platform sections' });
  await nav.getByRole('link', { name: 'Dues' }).click();
  await expect(page.getByRole('heading', { name: 'Dues', level: 1 })).toBeVisible();
  const main = page.getByRole('main');
  await expect(main.getByRole('link', { name: /^Payment failed \(\d+\)$/ })).toHaveAttribute(
    'aria-current',
    'page',
  );

  await main.getByRole('search', { name: 'Dues' }).getByLabel('Restaurant').fill(restaurant.slug);
  await main.getByRole('button', { name: 'Search' }).click();
  const row = main.getByRole('listitem', { name: restaurant.name });
  await expect(row).toContainText('Payment failed');
  await expect(row).toContainText('3 days left');
  await expect(row).toContainText('Razorpay is retrying the charge');
  await expect(row).toContainText('₹1,060.82');
  // The phone is stored as typed; the row reads out the mobile number.
  await expect(row).toContainText('98765 00550');
  await expect(row.getByRole('link', { name: `Call ${restaurant.name}` })).toHaveAttribute(
    'href',
    'tel:+919876500550',
  );

  // The message starts from the bucket's template, in English or Hindi.
  await row.getByRole('button', { name: `WhatsApp ${restaurant.name}` }).click();
  const dialog = page.getByRole('dialog');
  const message = dialog.getByLabel('Message');
  await expect(message).toHaveValue(/didn't go through/);
  await expect(message).toHaveValue(new RegExp(restaurant.name));
  await dialog.getByLabel('हिन्दी').check();
  await expect(message).toHaveValue(/भुगतान/);
  await message.fill('Hello & thanks');
  await expect(dialog.getByRole('link', { name: 'Open WhatsApp' })).toHaveAttribute(
    'href',
    'https://wa.me/919876500550?text=Hello%20%26%20thanks',
  );
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // On a phone the row stacks, every action in reach, nothing sideways.
  await page.setViewportSize({ width: 360, height: 740 });
  for (const action of [
    row.getByRole('link', { name: `Call ${restaurant.name}` }),
    row.getByRole('button', { name: `WhatsApp ${restaurant.name}` }),
    row.getByRole('button', { name: 'Record payment' }),
  ]) {
    await action.scrollIntoViewIfNeeded();
    await expect(action).toBeInViewport({ ratio: 1 });
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });

  // Taking the payment here moves the restaurant out of the bucket.
  await row.getByRole('button', { name: 'Record payment' }).click();
  await expect(
    dialog.getByRole('heading', { name: `Record payment for ${restaurant.name}` }),
  ).toBeVisible();
  await dialog.getByLabel('Amount received, with GST (₹)').fill('1060.82');
  await dialog.getByLabel('Paid by').selectOption({ label: 'UPI' });
  await dialog.getByLabel('Notes').fill('UTR 550550');
  await dialog.getByRole('button', { name: 'Record payment' }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toBeHidden();

  // The ledger: this month by default, the GST beside the amount.
  await nav.getByRole('link', { name: 'Payments' }).click();
  await expect(page.getByRole('heading', { name: 'Payments', level: 1 })).toBeVisible();
  await expect(main.getByRole('link', { name: 'This month' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await main
    .getByRole('search', { name: 'Payments' })
    .getByLabel('Restaurant')
    .fill(restaurant.slug);
  await main.getByRole('button', { name: 'Apply' }).click();
  await expect(page).toHaveURL(new RegExp(`q=${restaurant.slug}`));
  const table = main.getByRole('table', { name: 'Payments' });
  const paymentRow = table.getByRole('row').filter({ hasText: 'UTR 550550' });
  await expect(paymentRow).toContainText('Growth, monthly');
  await expect(paymentRow).toContainText('₹899.00');
  await expect(paymentRow).toContainText('₹161.82');
  await expect(paymentRow).toContainText('₹1,060.82');
  await expect(paymentRow).toContainText('UPI');
  await expect(paymentRow).toContainText(admin.email);
  await expect(main.getByTestId('payments-collected')).toHaveText(
    'Collected ₹899.00 + GST ₹161.82 = ₹1,060.82',
  );
  await expect(table.locator('tfoot')).toContainText('Total, 1 payment');

  // On a phone each payment is a card, its total marked as including GST.
  await page.setViewportSize({ width: 360, height: 740 });
  await expect(table).toBeHidden();
  const card = main.getByRole('list', { name: 'Payments' }).getByRole('listitem');
  await expect(card).toContainText(/₹1,060\.82\s*incl\. GST/);
  await expect(card).toContainText('UTR 550550');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });

  // The CSV holds the same rows as the screen.
  const download = page.waitForEvent('download');
  await main.getByRole('link', { name: 'Export CSV' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(
    /^payments-\d{4}-\d{2}-\d{2}(-to-\d{4}-\d{2}-\d{2})?\.csv$/,
  );
  const csv = (await readFile((await file.path())!, 'utf8')).replace(/^﻿/, '');
  const lines = csv.trim().split('\r\n');
  expect(lines).toHaveLength(1 + (await table.locator('tbody tr').count()));
  expect(lines[1]).toContain(
    `${restaurant.slug},Subscription,Growth,Monthly,899.00,161.82,1060.82,UPI,,`,
  );
  expect(lines[1]).toContain(`,${admin.email},UTR 550550`);

  // A row leads to the restaurant's payments.
  await paymentRow.getByRole('link', { name: restaurant.name }).click();
  await expect(page).toHaveURL(
    new RegExp(`/super/restaurants/${restaurant.restaurantId}/billing#section-payments$`),
  );
  await expect(page.getByRole('heading', { name: restaurant.name, level: 1 })).toBeVisible();
});

test('the subscriptions list moved into Money and shows states', async ({ page }) => {
  await createTestRestaurant({ prefix: 'subs' });
  await logInAsPlatformAdmin(page, await createPlatformAdmin('subs'));
  await page.goto('/super/subscriptions?state=trial');
  await expect(page).toHaveURL(/\/super\/money\/subscriptions\?state=trial$/);
  const main = page.getByRole('main');
  await expect(main.getByRole('link', { name: 'Trial', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const states = main.getByRole('table', { name: 'Subscriptions' }).locator('[data-state]');
  await expect(states.first()).toHaveText('Trial');
  expect(new Set(await states.evaluateAll((els) => els.map((el) => el.dataset.state)))).toEqual(
    new Set(['trial']),
  );
});
