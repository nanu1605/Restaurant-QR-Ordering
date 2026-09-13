import { expect, test } from '@playwright/test';

import { addDish, createOrderingTable, placeOrderFromMenu, tableState } from './customer-fixtures';
import { adminClient } from './helpers';

// Spec §13.1 states: invalid QR, read-only, rejected, billed, and orders
// accepted straight away when first-order approval is off.

test('a QR code that does not work gets a friendly page', async ({ page }) => {
  const response = await page.goto('/t/ZZZZZZZZZZZZZZZZ');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'This QR code isn’t working' })).toBeVisible();
  await expect(page.getByText('Please ask the staff for help')).toBeVisible();
});

test('a read-only restaurant shows its menu without ordering', async ({ page }) => {
  const table = await createOrderingTable();
  await adminClient()
    .from('restaurants')
    .update({ status: 'suspended', suspended_reason: 'E2E suspension' })
    .eq('id', table.restaurantId)
    .throwOnError();

  await page.goto(table.url);
  await expect(
    page.getByText('Online ordering is unavailable right now. Please order with our staff.'),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Paneer Tikka' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Add / })).toHaveCount(0);
});

test('without first-order approval an order is accepted straight away', async ({ page }) => {
  const table = await createOrderingTable({ approval: false });
  await page.goto(table.url);
  await addDish(page, 'Paneer Tikka');
  await placeOrderFromMenu(page);
  await expect(page.getByText('Order placed.', { exact: true })).toBeVisible();
  await expect(page.getByText('Waiting for staff to confirm your order.')).toHaveCount(0);
  const state = await tableState(table.restaurantId);
  expect(state.orders).toMatchObject([{ status: 'accepted' }]);
  expect(state.sessions).toMatchObject([{ is_approved: true }]);
});

test('a rejected order shows the reason', async ({ page }) => {
  const table = await createOrderingTable();
  await page.goto(table.url);
  await addDish(page, 'Paneer Tikka');
  await placeOrderFromMenu(page);
  await expect(page.getByText('Waiting for staff to confirm your order.')).toBeVisible();

  // Staff reject it (Phase 4 does this through staff_reject_order).
  const state = await tableState(table.restaurantId);
  const db = adminClient();
  await db
    .from('orders')
    .update({ status: 'rejected', reject_reason: 'Kitchen is closing' })
    .eq('id', state.orders[0]!.id)
    .throwOnError();
  await db
    .from('order_items')
    .update({ status: 'cancelled' })
    .eq('order_id', state.orders[0]!.id)
    .throwOnError();

  await page.reload();
  await expect(
    page.getByText('Staff couldn’t confirm this order: Kitchen is closing'),
  ).toBeVisible();
  await expect(page.getByText('Waiting for staff to confirm your order.')).toHaveCount(0);
});

test('after the bill the phone sees a thank-you and the next order starts fresh', async ({
  page,
}) => {
  const table = await createOrderingTable({ approval: false });
  await page.goto(table.url);
  await addDish(page, 'Paneer Tikka');
  await placeOrderFromMenu(page);

  // The bill is generated (Phase 5 does this through admin_generate_bill).
  const before = await tableState(table.restaurantId);
  await adminClient()
    .from('table_sessions')
    .update({ status: 'billed', billed_at: new Date().toISOString() })
    .eq('id', before.sessions[0]!.id)
    .throwOnError();

  await page.reload();
  await expect(
    page.getByText(
      'Your bill has been generated. Please pay at the counter or to your server. Thank you!',
    ),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Start a new order' }).click();

  await expect(page.getByRole('link', { name: /Your table’s orders/ })).toHaveCount(0);
  await addDish(page, 'Chicken 65');
  await placeOrderFromMenu(page);
  await expect(page.getByRole('heading', { name: /^Round 1 · / })).toBeVisible();
  await expect(page.getByText('Your bill has been generated.', { exact: false })).toHaveCount(0);

  const after = await tableState(table.restaurantId);
  expect(after.sessions.map((s) => s.status)).toEqual(['billed', 'open']);
});
