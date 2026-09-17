import { expect, test } from '@playwright/test';

import { tableState } from './customer-fixtures';
import { adminClient } from './helpers';
import {
  createLiveRestaurant,
  expectLive,
  openLiveScreen,
  placeCustomerOrder,
  tableCard,
} from './live-fixtures';

// Worker panel (spec §13.2): add dishes, reject and close without bill,
// read-only behaviour, the kds plan feature, availability and reconnecting.

test('a waiter opens a free table with an order and becomes its waiter', async ({
  browser,
  baseURL,
}) => {
  const r = await createLiveRestaurant();
  const { context, page } = await openLiveScreen(browser, r, 'ravi', '/staff', baseURL!);
  await page.getByRole('button', { name: /^All \d/ }).click();

  await tableCard(page, '4').click();
  const drawer = page.getByRole('dialog', { name: /^Table 4/ });
  await drawer.getByRole('button', { name: 'Add order' }).click();
  const picker = page.getByRole('dialog', { name: 'Add order · Table 4' });
  await picker.getByRole('button', { name: 'Add Paneer Tikka' }).click();
  await picker
    .getByRole('list', { name: 'This round' })
    .getByRole('button', { name: 'One more Paneer Tikka' })
    .click();
  await picker.getByRole('button', { name: 'Add Butter Chicken (Half)' }).click();
  await expect(picker.getByText('3 items · ₹840')).toBeVisible();
  await picker.getByRole('button', { name: 'Place order' }).click();
  await expect(picker).toBeHidden();
  // The drawer stays open on the new round.
  await expect(
    drawer.getByRole('heading', { name: /^Round 1 · .* · Added by staff$/ }),
  ).toBeVisible();
  await expect(drawer).toContainText('Waiter: Ravi Kumar');
  await page.keyboard.press('Escape');

  await expect(tableCard(page, '4')).toHaveAttribute('data-state', 'in_progress');
  await expect(tableCard(page, '4')).toContainText('Ravi Kumar');
  await page.getByRole('button', { name: /^My tables/ }).click();
  await expect(tableCard(page, '4')).toBeVisible();

  const state = await tableState(r.restaurantId);
  expect(state.sessions).toMatchObject([{ status: 'open', is_approved: true }]);
  expect(state.orders).toMatchObject([{ round_number: 1, status: 'accepted' }]);
  const { data: session } = await adminClient()
    .from('table_sessions')
    .select('assigned_waiter_id')
    .eq('id', state.sessions[0]!.id)
    .single()
    .throwOnError();
  expect(session!.assigned_waiter_id).toBe(r.waiters.ravi);
  await context.close();
});

test('a waiter rejects a prank order and closes the table without a bill', async ({
  browser,
  baseURL,
}) => {
  const r = await createLiveRestaurant();
  await placeCustomerOrder(r.tables['5']!.token, [{ menu_item_id: r.item.paneer, quantity: 2 }]);
  const { context, page } = await openLiveScreen(browser, r, 'ravi', '/staff', baseURL!);
  await page.getByRole('button', { name: /^All \d/ }).click();

  await tableCard(page, '5').click();
  const drawer = page.getByRole('dialog', { name: /^Table 5/ });
  await drawer.getByRole('button', { name: 'Reject round 1' }).click();
  const reject = page.getByRole('dialog', { name: 'Reject round 1' });
  await reject.getByRole('button', { name: 'Reject order' }).click();
  await expect(reject.getByText('Choose or type a reason.')).toBeVisible();
  await reject.getByRole('radio', { name: 'Prank / not seated' }).click();
  await reject.getByRole('button', { name: 'Reject order' }).click();
  await expect(reject).toBeHidden();
  await expect(tableCard(page, '5')).toHaveAttribute('data-state', 'idle');
  await expect(drawer.getByText('Rejected: Prank / not seated')).toBeVisible();

  await drawer.getByRole('button', { name: 'Close without bill' }).click();
  const close = page.getByRole('dialog', { name: 'Close Table 5 without a bill' });
  await close.getByRole('textbox', { name: 'Reason' }).fill('Nobody at the table');
  await close.getByRole('button', { name: 'Close table' }).click();
  await expect(tableCard(page, '5')).toHaveAttribute('data-state', 'free');

  const state = await tableState(r.restaurantId);
  expect(state.sessions).toMatchObject([{ status: 'closed_unbilled' }]);
  expect(state.orders).toMatchObject([{ status: 'rejected' }]);
  expect(state.items).toMatchObject([{ status: 'cancelled' }]);
  await context.close();
});

test('in read-only mode dishes still move but no new orders can be added', async ({
  browser,
  baseURL,
}) => {
  const r = await createLiveRestaurant({ approval: false });
  await placeCustomerOrder(r.tables['5']!.token, [{ menu_item_id: r.item.paneer, quantity: 1 }]);
  await adminClient()
    .from('restaurants')
    .update({ status: 'suspended', suspended_reason: 'E2E suspension' })
    .eq('id', r.restaurantId)
    .throwOnError();

  const { context, page } = await openLiveScreen(browser, r, 'ravi', '/staff', baseURL!);
  await page.getByRole('button', { name: /^All \d/ }).click();
  await tableCard(page, '5').click();
  const drawer = page.getByRole('dialog', { name: /^Table 5/ });
  await expect(drawer.getByRole('button', { name: 'Add dishes' })).toBeDisabled();
  await expect(
    drawer.getByText(/New orders are paused while the restaurant is read-only/),
  ).toBeVisible();

  await drawer.getByRole('button', { name: 'Start preparing Paneer Tikka' }).click();
  await expect(drawer.locator('[data-status="preparing"]')).toBeVisible();
  await expect
    .poll(async () => (await tableState(r.restaurantId)).items[0]!.status)
    .toBe('preparing');

  await page.keyboard.press('Escape');
  await tableCard(page, '3').click();
  await expect(
    page.getByRole('dialog', { name: /^Table 3/ }).getByRole('button', { name: 'Add order' }),
  ).toBeDisabled();
  await context.close();
});

test('the kitchen view needs a plan with the kitchen display', async ({ browser, baseURL }) => {
  const r = await createLiveRestaurant({ plan: 'starter' });
  const { context, page } = await openLiveScreen(browser, r, 'kitchen', '/staff', baseURL!);
  const nav = page.getByRole('navigation', { name: 'Worker panel sections' });
  await expect(nav.getByRole('link', { name: 'Board' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Kitchen' })).toHaveCount(0);

  await page.goto('/staff/kitchen');
  await expect(page.getByText('The kitchen view isn’t in your plan')).toBeVisible();
  await expect(
    page.getByText('Available on Growth. The board still shows every order.'),
  ).toBeVisible();
  await context.close();
});

test('staff switch a dish out of stock on the availability page', async ({ browser, baseURL }) => {
  const r = await createLiveRestaurant();
  const { context, page } = await openLiveScreen(
    browser,
    r,
    'kitchen',
    '/staff/availability',
    baseURL!,
  );
  const inStock = page.getByRole('switch', { name: 'Chicken 65 in stock' });
  await expect(inStock).toBeChecked();
  await inStock.click();
  await expect(page.getByText('Chicken 65 is out of stock')).toBeVisible();
  await expect(inStock).not.toBeChecked();

  const { data: item } = await adminClient()
    .from('menu_items')
    .select('is_available')
    .eq('id', r.item.chicken65)
    .single()
    .throwOnError();
  expect(item!.is_available).toBe(false);

  await page.getByRole('searchbox', { name: 'Search dishes' }).fill('kofta');
  await expect(page.getByRole('switch', { name: 'Malai Kofta in stock' })).not.toBeChecked();
  await expect(page.getByRole('switch', { name: 'Chicken 65 in stock' })).toHaveCount(0);
  await context.close();
});

test('the board catches up after the connection drops', async ({ browser, baseURL }) => {
  const r = await createLiveRestaurant();
  const { context, page } = await openLiveScreen(browser, r, 'ravi', '/staff', baseURL!);
  await page.getByRole('button', { name: /^All \d/ }).click();
  const indicator = page.getByRole('banner').getByRole('status');

  await context.setOffline(true);
  await expect(indicator).toHaveText('Offline');
  await placeCustomerOrder(r.tables['5']!.token, [{ menu_item_id: r.item.paneer, quantity: 1 }]);
  await expect(tableCard(page, '5')).toHaveAttribute('data-state', 'free');

  await context.setOffline(false);
  await expectLive(page);
  await expect(tableCard(page, '5')).toHaveAttribute('data-state', 'needs_approval', {
    timeout: 10_000,
  });
  await context.close();
});
