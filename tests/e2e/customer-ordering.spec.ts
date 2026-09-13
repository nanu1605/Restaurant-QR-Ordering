import { devices, expect, test } from '@playwright/test';

import { addDish, createOrderingTable, placeOrderFromMenu, tableState } from './customer-fixtures';
import { adminClient } from './helpers';

// Spec §19 Phase 3 acceptance: a customer orders from a table QR on a phone,
// prices come from the database, a second phone joins the same session, a
// double tap places one order, and cancelling works only for your own dishes
// within the window.

test('scanning a seeded table shows its menu', async ({ page }) => {
  // Only viewed, never ordered from: the demo seed stays untouched (P3-17).
  await page.goto('/t/DEMO0000TABLE001');
  await expect(page.getByText('Demo Kitchen', { exact: true })).toBeVisible();
  await expect(page.getByText('Table 1', { exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Menu categories' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Paneer Tikka' })).toBeVisible();
  await expect(
    page.getByRole('listitem').filter({ hasText: 'Malai Kofta' }).getByText('Not available'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Malai Kofta' })).toHaveCount(0);
});

test('a customer orders and a second phone joins the same session', async ({ page, browser }) => {
  const table = await createOrderingTable();
  await page.goto(table.url);
  await expect(page.getByText('Table 5', { exact: true })).toBeVisible();

  // Simple dish: Add, then the stepper.
  await addDish(page, 'Paneer Tikka');
  await page.getByRole('button', { name: 'One more Paneer Tikka' }).click();

  // Dish with options: the bottom sheet.
  await page.getByRole('button', { name: 'Add Butter Chicken' }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('radio', { name: /Full/ }).click();
  await sheet.getByRole('textbox', { name: /Note for the kitchen/ }).fill('less spicy');
  await sheet.getByRole('button', { name: 'Add to cart · ₹480' }).click();
  await expect(sheet).toBeHidden();

  await expect(page.getByRole('link', { name: /3 items · ₹1,040/ })).toBeVisible();

  // The cart survives a refresh (localStorage per QR token).
  await page.reload();
  await expect(page.getByRole('link', { name: /3 items · ₹1,040/ })).toBeVisible();

  await page.getByRole('link', { name: /View cart/ }).click();
  await expect(page.getByText('Estimated total')).toBeVisible();
  await expect(page.getByText('₹1,040').first()).toBeVisible();
  await expect(
    page.getByText(/You can cancel an item within 2 minutes if the kitchen hasn’t started it./),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Place order' }).click();

  await expect(page).toHaveURL(new RegExp(`/t/${table.token}/orders$`));
  await expect(page.getByText('Waiting for staff to confirm your order.')).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Round 1 · / })).toBeVisible();

  let state = await tableState(table.restaurantId);
  expect(state.sessions).toMatchObject([{ status: 'open', is_approved: false }]);
  expect(state.orders).toMatchObject([{ round_number: 1, status: 'pending_approval' }]);
  expect(
    state.items.map((i) => [
      i.item_name_snapshot,
      i.variant_name_snapshot,
      i.unit_price_paise,
      i.quantity,
      i.note,
    ]),
  ).toEqual([
    ['Butter Chicken', 'Full', 48000, 1, 'less spicy'],
    ['Paneer Tikka', null, 28000, 2, null],
  ]);

  // A second phone at the same table.
  const other = await browser.newContext({
    ...devices['Pixel 7'],
    baseURL: new URL(page.url()).origin,
  });
  const phone2 = await other.newPage();
  await phone2.goto(`${table.url}/orders`);
  await expect(phone2.getByRole('heading', { name: /^Round 1 · / })).toBeVisible();
  await expect(phone2.getByText('From this phone')).toHaveCount(0);
  await expect(phone2.getByRole('button', { name: /^Cancel / })).toHaveCount(0);

  await phone2.goto(table.url);
  await expect(phone2.getByRole('link', { name: /Your table’s orders \(1\)/ })).toBeVisible();
  await addDish(phone2, 'Chicken 65');
  await placeOrderFromMenu(phone2);
  await expect(phone2.getByRole('heading', { name: /^Round 2 · / })).toBeVisible();
  await other.close();

  state = await tableState(table.restaurantId);
  expect(state.sessions).toHaveLength(1);
  expect(state.orders.map((o) => [o.round_number, o.session_id])).toEqual([
    [1, state.sessions[0]!.id],
    [2, state.sessions[0]!.id],
  ]);
  expect(state.orders[0]!.client_device_id).not.toBe(state.orders[1]!.client_device_id);

  // The first phone sees round 2 after its next refresh; its own dishes keep their Cancel.
  await page.reload();
  await expect(page.getByRole('heading', { name: /^Round 2 · / })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel Paneer Tikka' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel Chicken 65' })).toHaveCount(0);
});

test('double-tapping Place order creates one order', async ({ page }) => {
  const table = await createOrderingTable({ approval: false });
  await page.goto(table.url);
  await addDish(page, 'Paneer Tikka');
  await page.getByRole('link', { name: /View cart/ }).click();
  await page.getByRole('button', { name: 'Place order' }).dblclick();
  await expect(page).toHaveURL(/\/orders$/);
  await expect(page.getByRole('heading', { name: /^Round 1 · / })).toBeVisible();

  const state = await tableState(table.restaurantId);
  expect(state.orders).toHaveLength(1);
  expect(state.orders[0]!.status).toBe('accepted');
});

test('a phone cancels its own dish within the window, and not after it', async ({ page }) => {
  const table = await createOrderingTable({ approval: false });
  await page.goto(table.url);
  await addDish(page, 'Paneer Tikka');
  await addDish(page, 'Chicken 65');
  await placeOrderFromMenu(page);
  await expect(page.getByText('Waiting for staff to confirm your order.')).toHaveCount(0);

  await page.getByRole('button', { name: 'Cancel Paneer Tikka' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel dish' }).click();
  await expect(page.getByText('Paneer Tikka cancelled.')).toBeVisible();
  const paneerRow = page.getByRole('listitem').filter({ hasText: 'Paneer Tikka' });
  await expect(paneerRow.getByText('Cancelled', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel Paneer Tikka' })).toHaveCount(0);

  const { data: audit } = await adminClient()
    .from('audit_logs')
    .select('actor_type, action')
    .eq('restaurant_id', table.restaurantId)
    .eq('action', 'order_item.cancelled');
  expect(audit).toEqual([{ actor_type: 'customer', action: 'order_item.cancelled' }]);

  // Three minutes later the window (2 minutes) has closed.
  const state = await tableState(table.restaurantId);
  await adminClient()
    .from('orders')
    .update({ created_at: new Date(Date.now() - 3 * 60_000).toISOString() })
    .eq('id', state.orders[0]!.id)
    .throwOnError();
  await page.reload();
  await expect(page.getByRole('heading', { name: /^Round 1 · / })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel Chicken 65' })).toHaveCount(0);
});

test('a dish that runs out before ordering is named and taken out of the cart', async ({
  page,
}) => {
  const table = await createOrderingTable({ approval: false });
  await page.goto(table.url);
  await addDish(page, 'Paneer Tikka');
  await addDish(page, 'Chicken 65');
  await page.getByRole('link', { name: /View cart/ }).click();
  await expect(page.getByRole('heading', { name: 'Your order' })).toBeVisible();

  await adminClient()
    .from('menu_items')
    .update({ is_available: false })
    .eq('id', table.item.chicken65)
    .throwOnError();

  await page.getByRole('button', { name: 'Place order' }).click();
  // Scoped to main: Next.js' route announcer is also role="alert".
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'Chicken 65 is no longer available, so we removed it from your cart.',
  );
  await expect(page.getByText('Chicken 65', { exact: true })).toHaveCount(0);
  expect((await tableState(table.restaurantId)).orders).toHaveLength(0);

  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page).toHaveURL(/\/orders$/);
  const state = await tableState(table.restaurantId);
  expect(state.items.map((i) => i.item_name_snapshot)).toEqual(['Paneer Tikka']);
});
