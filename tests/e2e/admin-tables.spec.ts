import { readFile } from 'node:fs/promises';

import { expect, test, type Page } from '@playwright/test';

import { adminClient, createTestRestaurant, logInAsOwner } from './helpers';

// Spec §19 Phase 2 acceptance: create 10 tables and print QR cards; the
// Starter plan is blocked at the 9th table with an upgrade hint.

const tablesList = (page: Page) => page.getByRole('region', { name: 'Tables' });
const tableRow = (page: Page, label: string) =>
  tablesList(page)
    .getByRole('listitem')
    .filter({ has: page.getByRole('switch', { name: `Table ${label} active`, exact: true }) });

async function addTables(page: Page, input: string) {
  await page.getByLabel('Table name or range').fill(input);
  await page
    .getByRole('region', { name: 'Add tables' })
    .getByRole('button', { name: 'Add' })
    .click();
}

test('owner adds 10 tables, downloads a QR code and prints the cards', async ({ page }) => {
  const restaurant = await createTestRestaurant({ prefix: 'tables' });
  await logInAsOwner(page, restaurant);
  await page.goto('/admin/tables');
  await expect(page.getByText('No tables yet')).toBeVisible();

  await page.getByLabel('Table name or range').fill('1-10');
  await expect(page.getByText('Adds 10 tables: 1, 2, 3 … 10')).toBeVisible();
  await page
    .getByRole('region', { name: 'Add tables' })
    .getByRole('button', { name: 'Add' })
    .click();
  await expect(page.getByText('10 tables added')).toBeVisible();
  await expect(tablesList(page).getByRole('listitem')).toHaveCount(10);
  await expect(page.getByText('10 active tables')).toBeVisible();

  // Labels must stay unique among active tables.
  await addTables(page, '5');
  await expect(
    page.getByRole('alert').filter({ hasText: 'There is already a table called “5”.' }),
  ).toBeVisible();

  // Download one QR code as a PNG.
  const downloadPromise = page.waitForEvent('download');
  await tableRow(page, '1').getByRole('link', { name: 'Download QR code for table 1' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('table-1-qr.png');
  const png = await readFile(await download.path());
  expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');

  // Rename and turn off.
  await tableRow(page, '2').getByRole('button', { name: 'More for table 2' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const rename = tablesList(page).getByRole('textbox', { name: 'Rename table 2' });
  await rename.fill('Window 2');
  await rename.press('Enter');
  await expect(tableRow(page, 'Window 2')).toBeVisible();

  await tableRow(page, '3').getByRole('switch', { name: 'Table 3 active' }).click();
  await expect(tablesList(page).getByText('Turned off (1)')).toBeVisible();

  // Regenerate a QR code: the token changes.
  const admin = adminClient();
  const tokenOf = async (label: string) =>
    (
      await admin
        .from('dining_tables')
        .select('qr_token')
        .eq('restaurant_id', restaurant.restaurantId)
        .eq('label', label)
        .single()
    ).data?.qr_token;
  const before = await tokenOf('1');
  await tableRow(page, '1').getByRole('button', { name: 'More for table 1' }).click();
  await page.getByRole('menuitem', { name: 'Regenerate QR code' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Regenerate the QR code for table 1?' });
  await confirm.getByRole('button', { name: 'Regenerate' }).click();
  await expect(page.getByText(/New QR code for table 1/)).toBeVisible();
  expect(await tokenOf('1')).not.toBe(before);

  // Printable sheet: 9 active tables → 2 A4 pages of cards.
  await tablesList(page).getByRole('link', { name: 'Print QR cards' }).click();
  await expect(page).toHaveURL(/\/admin\/tables\/print$/);
  await expect(page.getByRole('article')).toHaveCount(9);
  await expect(page.getByRole('region', { name: /^Page \d$/ })).toHaveCount(2);
  const card = page.getByRole('article', { name: 'Table Window 2' });
  await expect(card.getByText('Scan to order')).toBeVisible();
  await expect(card.getByText('No app needed')).toBeVisible();
  await expect(card.getByText(restaurant.name)).toBeVisible();
  await expect(
    card.getByRole('img', { name: 'QR code for table Window 2' }).locator('svg'),
  ).toBeVisible();

  // The download and the printed sheet are recorded for super-admin (SA-14).
  await page.evaluate(() => {
    window.print = () => {};
  });
  await page.getByRole('button', { name: 'Print' }).click();
  await expect
    .poll(async () => {
      const { data } = await admin
        .from('audit_logs')
        .select('action')
        .eq('restaurant_id', restaurant.restaurantId)
        .like('action', 'table.qr_%')
        .order('action');
      return data?.map((row) => row.action);
    })
    .toEqual(['table.qr_downloaded', 'table.qr_regenerated', 'table.qr_sheet_printed']);
});

test('a Starter restaurant is blocked at the 9th table with an upgrade hint', async ({ page }) => {
  const restaurant = await createTestRestaurant({ prefix: 'starter', plan: 'starter' });
  await logInAsOwner(page, restaurant);
  await page.goto('/admin/tables');

  // Asking for more than the plan allows is refused by the database.
  await addTables(page, '1-9');
  await expect(
    page.getByRole('alert').filter({ hasText: 'Your plan allows up to 8 tables.' }),
  ).toBeVisible();
  // The refusal is recorded as an upgrade opportunity (SA-13).
  const { data: hits } = await adminClient()
    .from('plan_limit_events')
    .select('kind')
    .eq('restaurant_id', restaurant.restaurantId)
    .throwOnError();
  expect(hits).toEqual([{ kind: 'tables' }]);

  await addTables(page, '1-8');
  await expect(page.getByText('8 tables added')).toBeVisible();
  await expect(page.getByText('8 of 8 tables on your plan')).toBeVisible();
  await expect(
    page.getByText(
      /You're using all 8 tables on your plan\. Upgrade to Growth for unlimited tables/,
    ),
  ).toBeVisible();
  await expect(page.getByLabel('Table name or range')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'See plans' })).toBeVisible();
});
