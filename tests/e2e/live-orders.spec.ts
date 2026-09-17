import { expect, test } from '@playwright/test';

import { addDish, placeOrderFromMenu, tableState } from './customer-fixtures';
import {
  createLiveRestaurant,
  openCustomerPhone,
  openLiveScreen,
  placeCustomerOrder,
  tableCard,
} from './live-fixtures';

// Spec §19 Phase 4 acceptance, with customer, waiter, kitchen and manager
// screens open side by side: a new order reaches staff and admin screens live,
// the kitchen never sees it while it waits, a busy waiter needs confirmation,
// served shows everywhere, removals show their reason on staff and customer
// screens, and only a manager removes a served dish.

const LIVE = { timeout: 5_000 };

test('an order flows live between the customer, waiter, kitchen and manager', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const r = await createLiveRestaurant();
  const ravi = await openLiveScreen(browser, r, 'ravi', '/staff', baseURL!);
  const kitchen = await openLiveScreen(browser, r, 'kitchen', '/staff', baseURL!);
  const owner = await openLiveScreen(browser, r, 'owner', '/admin/live', baseURL!);
  const phone = await openCustomerPhone(browser, r.tables['5']!.url, baseURL!);

  // Ravi's login is linked to his waiter profile, so he starts on "My tables".
  await expect(ravi.page.getByRole('button', { name: /^My tables/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await ravi.page.getByRole('button', { name: /^All \d/ }).click();

  // 1. The customer orders; it needs approval on the waiter's and manager's boards.
  await addDish(phone.page, 'Paneer Tikka');
  await addDish(phone.page, 'Chicken 65');
  await phone.page.getByRole('link', { name: /View cart/ }).click();
  await expect(phone.page.getByRole('heading', { name: 'Your order' })).toBeVisible();
  const placedAt = Date.now();
  await phone.page.getByRole('button', { name: 'Place order' }).click();
  await Promise.all([
    expect(tableCard(ravi.page, '5')).toHaveAttribute('data-state', 'needs_approval', LIVE),
    expect(tableCard(owner.page, '5')).toHaveAttribute('data-state', 'needs_approval', LIVE),
  ]);
  const latency = `${Date.now() - placedAt} ms from tapping Place order to both boards`;
  test.info().annotations.push({ type: 'live update', description: latency });
  console.log(`Live update: ${latency}`);
  await expect(phone.page.getByRole('heading', { name: 'Your table’s orders' })).toBeVisible();

  // The kitchen learns a table is waiting, but never sees the dishes (spec §10.2).
  await expect(tableCard(kitchen.page, '5')).toHaveAttribute('data-state', 'needs_approval', LIVE);
  await tableCard(kitchen.page, '5').click();
  const kitchenDrawer = kitchen.page.getByRole('dialog', { name: /^Table 5/ });
  await expect(kitchenDrawer).toContainText('waiting for a waiter to approve');
  await expect(kitchenDrawer.getByText('Paneer Tikka')).toHaveCount(0);
  await kitchen.page.keyboard.press('Escape');
  await kitchen.page
    .getByRole('navigation', { name: 'Worker panel sections' })
    .getByRole('link', { name: 'Kitchen' })
    .click();
  await expect(kitchen.page.getByRole('heading', { name: /^New/ })).toBeVisible();
  await expect(kitchen.page.getByRole('article')).toHaveCount(0);

  // 2. The manager assigns Ravi to Table 3; with a limit of one table he is now busy,
  // and giving him Table 4 asks for confirmation.
  await placeCustomerOrder(r.tables['3']!.token, [{ menu_item_id: r.item.paneer, quantity: 1 }]);
  await placeCustomerOrder(r.tables['4']!.token, [{ menu_item_id: r.item.chicken65, quantity: 1 }]);
  const queue = owner.page.getByRole('region', { name: /^Unassigned tables/ });
  await expect(queue.getByRole('button', { name: 'Assign waiter to Table 4' })).toBeVisible(LIVE);

  await queue.getByRole('button', { name: 'Assign waiter to Table 3' }).click();
  const assign = owner.page.getByRole('dialog');
  await assign
    .getByRole('region', { name: 'Available' })
    .getByRole('button', { name: /Ravi Kumar/ })
    .click();
  await expect(assign).toBeHidden();
  const raviChip = owner.page.locator('li[data-waiter="Ravi Kumar"]');
  await expect(raviChip).toHaveAttribute('data-status', 'busy', LIVE);
  await expect(raviChip).toContainText('Busy — Table 3');

  await queue.getByRole('button', { name: 'Assign waiter to Table 4' }).click();
  await expect(assign.getByRole('region', { name: 'Available' })).not.toContainText('Ravi Kumar');
  await assign
    .getByRole('region', { name: 'Busy' })
    .getByRole('button', { name: /Ravi Kumar/ })
    .click();
  await expect(
    assign.getByText('Ravi Kumar is already handling Table 3. Assign anyway?'),
  ).toBeVisible();
  await assign.getByRole('button', { name: 'Back' }).click();
  await assign.getByRole('button', { name: /Suresh Patel/ }).click();
  await expect(assign).toBeHidden();

  let state = await tableState(r.restaurantId);
  expect(state.orders.filter((o) => o.status === 'accepted')).toHaveLength(2); // tables 3 and 4

  // 3. Ravi approves Table 5; the kitchen prepares it; Ravi serves it.
  await tableCard(ravi.page, '5').click();
  const raviDrawer = ravi.page.getByRole('dialog', { name: /^Table 5/ });
  await raviDrawer.getByRole('button', { name: 'Approve round 1' }).click();
  await expect(
    raviDrawer.getByRole('button', { name: 'Start preparing Paneer Tikka' }),
  ).toBeVisible();

  const ticket = kitchen.page.getByRole('article', { name: 'Table 5, round 1' });
  await expect(ticket).toBeVisible(LIVE);
  await ticket.getByRole('button', { name: 'Start all for Table 5, round 1' }).click();
  await expect(
    kitchen.page
      .getByRole('region', { name: /^Preparing/ })
      .getByRole('article', { name: 'Table 5, round 1' }),
  ).toBeVisible();
  await kitchen.page
    .getByRole('region', { name: /^Preparing/ })
    .getByRole('button', { name: 'Mark all ready for Table 5, round 1' })
    .click();
  await expect(
    kitchen.page
      .getByRole('region', { name: /^Ready/ })
      .getByRole('article', { name: 'Table 5, round 1' }),
  ).toBeVisible();

  await expect(raviDrawer.getByRole('button', { name: 'Mark served Paneer Tikka' })).toBeVisible(
    LIVE,
  );
  await raviDrawer.getByRole('button', { name: 'Mark all served in round 1' }).click();
  await expect(raviDrawer.locator('[data-status="served"]')).toHaveCount(2);
  await expect(tableCard(owner.page, '5')).toHaveAttribute('data-state', 'all_served', LIVE);
  await expect(tableCard(ravi.page, '5')).toHaveAttribute('data-state', 'all_served');
  await expect(kitchen.page.getByRole('article', { name: 'Table 5, round 1' })).toHaveCount(
    0,
    LIVE,
  );
  await phone.page.reload();
  await expect(phone.page.locator('[data-status="served"]')).toHaveCount(2);

  // 4. Round 2 from the phone; Ravi removes a dish, and the reason shows everywhere.
  await phone.page.goto(r.tables['5']!.url);
  await addDish(phone.page, 'Chicken 65');
  await placeOrderFromMenu(phone.page);
  const round2 = raviDrawer.getByRole('region', { name: 'Round 2' });
  await expect(round2).toBeVisible(LIVE);
  await round2.getByRole('button', { name: 'Remove Chicken 65' }).click();
  const removeDialog = ravi.page.getByRole('dialog', { name: 'Remove Chicken 65' });
  await removeDialog.getByRole('radio', { name: 'Out of stock' }).click();
  await removeDialog.getByRole('button', { name: 'Remove dish' }).click();
  await expect(round2.getByText('Removed by Ravi Kumar: Out of stock')).toBeVisible();
  await expect(round2.locator('[data-status="removed"]')).toBeVisible();
  await expect(phone.page.getByText('Removed by staff: Out of stock')).toBeVisible({
    timeout: 15_000,
  });

  // 5. A served dish: the kitchen can't remove it, the manager can.
  await kitchen.page
    .getByRole('navigation', { name: 'Worker panel sections' })
    .getByRole('link', { name: 'Board' })
    .click();
  await tableCard(kitchen.page, '5').click();
  await expect(
    kitchen.page
      .getByRole('dialog', { name: /^Table 5/ })
      .getByRole('button', { name: 'Ask manager to remove Paneer Tikka' }),
  ).toBeDisabled();

  await tableCard(owner.page, '5').click();
  const ownerDrawer = owner.page.getByRole('dialog', { name: /^Table 5/ });
  await ownerDrawer.getByRole('button', { name: 'Remove Paneer Tikka' }).click();
  const ownerRemove = owner.page.getByRole('dialog', { name: 'Remove Paneer Tikka' });
  await ownerRemove.getByRole('radio', { name: 'Quality complaint' }).click();
  await ownerRemove.getByRole('button', { name: 'Remove dish' }).click();
  await expect(ownerDrawer.getByText('Removed by Test Owner: Quality complaint')).toBeVisible();

  state = await tableState(r.restaurantId);
  expect(
    state.items
      .filter((i) => i.status === 'removed')
      .map((i) => i.item_name_snapshot)
      .sort(),
  ).toEqual(['Chicken 65', 'Paneer Tikka']);

  for (const screen of [ravi, kitchen, owner, phone]) await screen.context.close();
});
