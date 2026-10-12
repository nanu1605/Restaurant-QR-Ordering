import { expect, test } from '@playwright/test';

import { addDish, createOrderingTable, placeOrderFromMenu, tableState } from './customer-fixtures';
import { adminClient } from './helpers';
import { ownerClient } from './report-fixtures';

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

test('after the bill the phone that ordered sees it, and the next order starts fresh', async ({
  page,
  browser,
}) => {
  const table = await createOrderingTable({ approval: false });
  await page.goto(table.url);
  await addDish(page, 'Paneer Tikka');
  await placeOrderFromMenu(page);

  // The counter serves and bills the table, as the app does.
  const owner = await ownerClient(table.restaurant);
  const db = adminClient();
  const { data: waiter } = await db
    .from('waiters')
    .insert({ restaurant_id: table.restaurantId, full_name: 'Ravi' })
    .select('id')
    .single()
    .throwOnError();
  const before = await tableState(table.restaurantId);
  await owner
    .rpc('admin_assign_waiter', {
      p_session_id: before.sessions[0]!.id,
      p_waiter_id: waiter!.id,
      p_force: true,
    })
    .throwOnError();
  await owner.rpc('staff_mark_order_served', { p_order_id: before.orders[0]!.id }).throwOnError();
  const { data } = await owner
    .rpc('admin_generate_bill', {
      p_session_id: before.sessions[0]!.id,
      p_discount_type: 'none',
      p_discount_value: 0,
      p_discount_reason: '',
      p_apply_service_charge: false,
    })
    .throwOnError();
  const bill = data as { bill_id: string; invoice_number: string; grand_total_paise: number };

  // docs/DECISIONS.md P11-1: the phone that ordered, still on its orders page, gets the
  // customer copy with the next poll (every 10 s).
  const yourBill = page.getByRole('region', { name: 'Your bill' });
  await expect(yourBill.getByText(bill.invoice_number, { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    page.getByRole('status').filter({
      hasText: 'Your bill has been generated. Please pay at the counter or to your server.',
    }),
  ).toBeAttached();
  await expect(yourBill.getByText('Paneer Tikka')).toBeVisible();

  // A phone that didn't order, such as the next party's, sees no bill.
  const next = await browser.newContext();
  const nextPage = await next.newPage();
  await nextPage.goto(`${table.url}/orders`);
  await expect(nextPage.getByText('No orders yet')).toBeVisible();
  await expect(nextPage.getByRole('region', { name: 'Your bill' })).toHaveCount(0);
  await next.close();

  // Paid at the counter: the next poll shows it.
  await owner
    .rpc('admin_record_payment', {
      p_bill_id: bill.bill_id,
      p_payments: [{ mode: 'cash', amount_paise: bill.grand_total_paise }],
    })
    .throwOnError();
  await expect(
    page.getByRole('status').filter({ hasText: 'Your bill is paid. Thank you for visiting!' }),
  ).toBeAttached({ timeout: 20_000 });
  await expect(yourBill.getByText(bill.invoice_number, { exact: true })).toBeVisible();

  await page.getByRole('link', { name: 'Start a new order' }).click();
  await expect(page.getByRole('link', { name: /Your table’s orders/ })).toHaveCount(0);
  await addDish(page, 'Chicken 65');
  await placeOrderFromMenu(page);
  await expect(page.getByRole('heading', { name: /^Round 1 · / })).toBeVisible();
  await expect(page.getByText('Your bill', { exact: false })).toHaveCount(0);

  const after = await tableState(table.restaurantId);
  expect(after.sessions.map((s) => s.status)).toEqual(['billed', 'open']);
});
