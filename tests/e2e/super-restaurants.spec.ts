import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { adminClient, createTestRestaurant } from './helpers';
import { createPlatformAdmin, logInAsPlatformAdmin } from './platform-fixtures';

/**
 * The restaurants list and search (docs/SUPER_ADMIN_PLAN.md 12d;
 * docs/DECISIONS.md SA-22 to SA-25): filters, sorting, columns, saved views,
 * the CSV, and Ctrl+K by part of a phone or a GSTIN.
 */

const digits = (length: number) =>
  Array.from({ length }, () => Math.floor(Math.random() * 10)).join('');

test('filters, sorts, columns, saved views and the CSV', async ({ page }) => {
  const failed = await createTestRestaurant({ prefix: 'list' });
  const trial = await createTestRestaurant({ prefix: 'list' });
  const city = `E2E ${failed.slug}`;
  const phone = `98${digits(8)}`;
  const db = adminClient();
  await db
    .from('restaurants')
    .update({ city, phone: `+91 ${phone.slice(0, 5)}-${phone.slice(5)}` })
    .eq('id', failed.restaurantId)
    .throwOnError();
  await db.from('restaurants').update({ city }).eq('id', trial.restaurantId).throwOnError();
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
    .eq('restaurant_id', failed.restaurantId)
    .throwOnError();

  await logInAsPlatformAdmin(page, await createPlatformAdmin('list'));
  await page.goto('/super/restaurants');
  const main = page.getByRole('main');
  const filters = main.getByRole('search', { name: 'Restaurants' });
  const table = main.getByRole('table', { name: 'Restaurants' });
  const row = (slug: string) => table.locator(`tr[data-slug="${slug}"]`);

  // Filters live in the URL.
  await filters.getByRole('combobox', { name: 'City' }).selectOption({ label: city });
  await filters
    .getByRole('combobox', { name: 'State', exact: true })
    .selectOption({ label: 'Payment failed' });
  await filters.getByRole('button', { name: 'Apply' }).click();
  await expect(page).toHaveURL(/state=payment_failed/);
  await expect(row(failed.slug)).toBeVisible();
  await expect(row(trial.slug)).toBeHidden();
  await expect(row(failed.slug)).toContainText('Payment failed');
  await expect(row(failed.slug)).toContainText(`${phone.slice(0, 5)} ${phone.slice(5)}`);
  await expect(row(failed.slug).getByRole('link', { name: `Call ${failed.name}` })).toHaveAttribute(
    'href',
    `tel:+91${phone}`,
  );

  // Columns: hide one, show another.
  await filters.getByText('Columns', { exact: true }).click();
  await filters.getByRole('checkbox', { name: 'Lifetime paid' }).uncheck();
  await filters.getByRole('checkbox', { name: 'Found us' }).check();
  await filters.getByRole('button', { name: 'Apply' }).click();
  await expect(page).toHaveURL(/cols=/);
  await expect(table.getByRole('columnheader', { name: 'Lifetime paid' })).toHaveCount(0);
  await expect(row(failed.slug).locator('[data-col="channel"]')).toHaveText('Not known');

  // Sorting by a column says so.
  await table.getByRole('link', { name: 'Restaurant' }).click();
  await expect(page).toHaveURL(/sort=name/);
  await expect(table.getByRole('columnheader', { name: 'Restaurant' })).toHaveAttribute(
    'aria-sort',
    'ascending',
  );

  // The CSV holds the filtered rows.
  const download = page.waitForEvent('download');
  await main.getByRole('link', { name: 'Export CSV' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^restaurants-\d{4}-\d{2}-\d{2}\.csv$/);
  const lines = (await readFile((await file.path())!, 'utf8'))
    .replace(/^﻿/, '')
    .trim()
    .split('\r\n');
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain(`${failed.slug},${city},,`);
  expect(lines[1]).toContain(',Payment failed,Growth,Monthly,');

  // A saved view keeps the filters, sort and columns.
  const name = `Failed ${failed.slug}`;
  await main.getByRole('button', { name: 'Save view' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Share with the team').check();
  await dialog.getByRole('button', { name: 'Save view' }).click();
  await expect(dialog).toBeHidden();
  const views = main.getByRole('navigation', { name: 'Views' });
  await expect(views.getByRole('link', { name })).toHaveAttribute('aria-current', 'page');

  await main.getByRole('link', { name: 'Clear' }).click();
  await expect(page).toHaveURL(/\/super\/restaurants$/);
  await views.getByRole('link', { name }).click();
  await expect(page).toHaveURL(/state=payment_failed/);
  await expect(row(failed.slug)).toBeVisible();
  await expect(row(trial.slug)).toBeHidden();
  await expect(table.getByRole('columnheader', { name: 'Found us' })).toBeVisible();

  await views.getByRole('button', { name: `Delete view ${name}` }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('goes for the whole team too');
  await confirm.getByRole('button', { name: 'Delete view' }).click();
  await expect(confirm).toBeHidden();
  await expect(views.getByRole('link', { name })).toHaveCount(0);

  // A built-in view.
  await views.getByRole('link', { name: 'Payment failed' }).click();
  await expect(page).toHaveURL(/\/super\/restaurants\?state=payment_failed$/);
  await expect(views.getByRole('link', { name: 'Payment failed' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('Ctrl+K finds a restaurant by part of its phone or its GSTIN', async ({ page }) => {
  const restaurant = await createTestRestaurant({ prefix: 'find' });
  const phone = `97${digits(8)}`;
  const letters = Array.from({ length: 5 }, () =>
    String.fromCharCode(65 + Math.floor(Math.random() * 26)),
  ).join('');
  const gstin = `27${letters}${digits(4)}F1Z5`;
  await adminClient()
    .from('restaurants')
    // Stored as typed: search still finds it by its digits.
    .update({ phone: `+91 ${phone.slice(0, 5)} ${phone.slice(5)}`, gstin })
    .eq('id', restaurant.restaurantId)
    .throwOnError();

  await logInAsPlatformAdmin(page, await createPlatformAdmin('find'));
  await page.goto('/super');
  const dialog = page.getByRole('dialog');
  // The shortcut works once the page has loaded its scripts.
  await expect(async () => {
    await page.keyboard.press('ControlOrMeta+k');
    await expect(dialog).toBeVisible({ timeout: 1000 });
  }).toPass();
  const search = dialog.getByRole('combobox', { name: 'Search' });
  await search.fill(phone.slice(3));
  const byPhone = dialog.getByRole('option', { name: new RegExp(restaurant.name) });
  await expect(byPhone).toContainText(`Phone +91 ${phone.slice(0, 5)} ${phone.slice(5)}`);
  await search.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/super/restaurants/${restaurant.restaurantId}$`));
  await expect(page.getByRole('heading', { name: restaurant.name, level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Search restaurants, phones and payments' }).click();
  // The last pick is offered before typing.
  await expect(dialog.getByRole('option', { name: new RegExp(restaurant.name) })).toBeVisible();
  await search.fill(gstin.slice(2, 11).toLowerCase());
  const byGstin = dialog.getByRole('option', { name: new RegExp(restaurant.name) });
  await expect(byGstin).toContainText(`GSTIN ${gstin}`);
  await byGstin.click();
  await expect(page).toHaveURL(new RegExp(`/super/restaurants/${restaurant.restaurantId}$`));
});
