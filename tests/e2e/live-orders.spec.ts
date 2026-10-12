import { expect, test } from '@playwright/test';

import { addDish, placeOrderFromMenu, tableState } from './customer-fixtures';
import { adminClient } from './helpers';
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
// screens, and only a manager removes a served dish. The §18 full flow then
// ends with Phase 5: the manager deletes a round, bills the table with a
// discount, prints the bill, records a UPI payment and finds it in Total
// orders; Ravi is available again and the customer's next order starts a
// fresh session.

const LIVE = { timeout: 5_000 };

test('an order flows live between the customer, waiter, kitchen and manager', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(240_000);
  const r = await createLiveRestaurant();
  // GST-registered with a UPI QR on bills, so the print shows taxes and the QR.
  await adminClient()
    .from('restaurants')
    .update({
      gst_mode: 'regular',
      gst_rate_bps: 500,
      prices_include_tax: false,
      show_upi_qr_on_bill: true,
      upi_vpa: 'spiceroute@okicici',
      upi_payee_name: 'Spice Route',
    })
    .eq('id', r.restaurantId)
    .throwOnError();
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

  // 6. Table 3 closes without a bill, so Ravi has no other table.
  await owner.page.keyboard.press('Escape');
  await tableCard(owner.page, '3').click();
  const table3 = owner.page.getByRole('dialog', { name: /^Table 3/ });
  await table3.getByRole('button', { name: 'Close without bill' }).click();
  const close3 = owner.page.getByRole('dialog', { name: 'Close Table 3 without a bill' });
  await close3.getByRole('textbox', { name: 'Reason' }).fill('Guests left');
  await close3.getByRole('button', { name: 'Close table' }).click();
  await expect(tableCard(owner.page, '3')).toHaveAttribute('data-state', 'free');
  await owner.page.keyboard.press('Escape');

  // 7. The manager deletes round 2.
  await tableCard(owner.page, '5').click();
  await ownerDrawer.getByRole('button', { name: 'Delete order round 2' }).click();
  const deleteRound = owner.page.getByRole('dialog', { name: 'Delete round 2' });
  await deleteRound.getByRole('textbox', { name: 'Reason' }).fill('Duplicate order');
  await deleteRound.getByRole('button', { name: 'Delete order' }).click();
  await expect(deleteRound).toBeHidden();
  await owner.page.keyboard.press('Escape');

  // 8. Billing: assign Ravi, 10% discount, generate. Chicken 65 ₹320 − ₹32 = ₹288,
  // + 5% GST ₹14.40 = ₹302.40 → ₹302.
  await owner.page.goto('/admin/billing');
  await owner.page.getByRole('link', { name: 'Bill Table 5' }).click();
  await owner.page.getByRole('button', { name: 'Assign waiter' }).click();
  const assignForBill = owner.page.getByRole('dialog');
  await assignForBill
    .getByRole('region', { name: 'Available' })
    .getByRole('button', { name: /Ravi Kumar/ })
    .click();
  await expect(assignForBill).toBeHidden();
  await expect(owner.page.getByText('Waiter: Ravi Kumar')).toBeVisible(LIVE);
  await owner.page.getByRole('radio', { name: 'Percent (%)' }).click();
  await owner.page.getByRole('textbox', { name: 'Discount percentage' }).fill('10');
  await owner.page.getByRole('textbox', { name: 'Reason for the discount' }).fill('Regular guest');
  const billTotals = owner.page.getByRole('region', { name: 'Bill for Table 5' });
  await expect(billTotals).toContainText('Discount-₹32.00');
  await expect(billTotals).toContainText('Grand total₹302.00');
  await owner.page.getByRole('button', { name: 'Generate bill' }).click();
  const confirmBill = owner.page.getByRole('alertdialog');
  await expect(confirmBill).toContainText('Generate the bill for Table 5?');
  await confirmBill.getByRole('button', { name: 'Generate bill' }).click();
  await expect(
    owner.page.getByRole('heading', { name: /^Bill INV\/\d{4}-\d{2}\/00001$/ }),
  ).toBeVisible();
  const billUrl = owner.page.url();
  await expect(tableCard(ravi.page, '5')).toHaveAttribute('data-state', 'free', LIVE);

  // 9. The print page opens the print dialog once and shows the bill (spec §11.3, §15).
  await owner.context.addInitScript(() => {
    const counter = window as unknown as { __prints?: number };
    window.print = () => {
      counter.__prints = (counter.__prints ?? 0) + 1;
    };
  });
  await owner.page.goto(`${billUrl}/print`);
  const printed = owner.page.getByRole('article', { name: /^Tax Invoice INV\// });
  await expect(printed).toContainText(/Invoice no\.INV\/\d{4}-\d{2}\/00001/);
  await expect(printed).toContainText('Table5');
  await expect(printed).toContainText('Served byRavi Kumar');
  await expect(printed).toContainText('Chicken 65');
  await expect(printed).toContainText('Discount-₹32.00');
  await expect(printed).toContainText('CGST 2.5%₹7.20');
  await expect(printed).toContainText('SGST 2.5%₹7.20');
  await expect(printed).toContainText('Round off-₹0.40');
  await expect(printed).toContainText('Grand total₹302.00');
  await expect(printed).toContainText('Rupees Three Hundred Two Only');
  await expect(printed).toContainText('Scan to pay ₹302 to Spice Route');
  await expect(printed.locator('svg')).toHaveCount(1);
  // The customer copy doesn't show the discount reason.
  await expect(printed).not.toContainText('Regular guest');
  await expect
    .poll(() => owner.page.evaluate(() => (window as unknown as { __prints?: number }).__prints))
    .toBe(1);
  await expect
    .poll(async () => {
      const { data } = await adminClient()
        .from('bills')
        .select('print_count')
        .eq('restaurant_id', r.restaurantId)
        .single()
        .throwOnError();
      return data!.print_count;
    })
    .toBe(1);

  // 10. A UPI payment settles it.
  await owner.page.goto(billUrl);
  await owner.page.getByRole('button', { name: 'Record payment' }).click();
  const payment = owner.page.getByRole('dialog', { name: 'Record payment' });
  await payment.getByRole('button', { name: 'UPI' }).click();
  await expect(payment.getByRole('textbox', { name: 'Amount (₹)' })).toHaveValue('302.00');
  await payment.getByRole('textbox', { name: 'Reference (optional)' }).fill('UTR 4455');
  await payment.getByRole('button', { name: 'Record payment' }).click();
  await expect(payment).toBeHidden();
  await expect(owner.page.getByText('Paid', { exact: true })).toBeVisible();
  await expect(owner.page.getByRole('region', { name: 'Payments' })).toContainText(
    'UPI · UTR 4455',
  );

  // 11. Total orders lists the bill with its waiter and payment.
  await owner.page.goto('/admin/total-orders');
  const billRow = owner.page.getByRole('row', { name: /00001/ });
  await expect(billRow).toContainText('Ravi Kumar');
  await expect(billRow).toContainText('₹302.00');
  await expect(billRow).toContainText('PaidUPI');
  await expect(owner.page.getByLabel('Summary')).toContainText('Net collected₹302.00');

  // 12. Ravi is available again.
  await owner.page.goto('/admin/live');
  const raviAgain = owner.page.locator('li[data-waiter="Ravi Kumar"]');
  await expect(raviAgain).toHaveAttribute('data-status', 'free', LIVE);
  await expect(raviAgain).toContainText('Available');

  // 13. The customer sees the paid bill (P11-1), and the next order starts a fresh session.
  await phone.page.goto(`${r.tables['5']!.url}/orders`);
  await expect(
    phone.page
      .getByRole('status')
      .filter({ hasText: 'Your bill is paid. Thank you for visiting!' }),
  ).toBeAttached();
  const yourBill = phone.page.getByRole('region', { name: 'Your bill' });
  await expect(yourBill).toContainText('/00001');
  // The customer copy, as printed: "Served by" stays; no discount reason or UPI QR on screen.
  await expect(yourBill).toContainText('Served byRavi Kumar');
  await expect(yourBill).not.toContainText('Regular guest');
  await expect(yourBill).not.toContainText('Scan to pay');
  await phone.page.goto(r.tables['5']!.url);
  await addDish(phone.page, 'Paneer Tikka');
  await placeOrderFromMenu(phone.page);
  state = await tableState(r.restaurantId);
  const table5 = state.sessions.filter((s) => s.dining_table_id === r.tables['5']!.id);
  expect(table5.map((s) => s.status)).toEqual(['billed', 'open']);
  const fresh = table5.find((s) => s.status === 'open')!;
  expect(state.orders.filter((o) => o.session_id === fresh.id)).toMatchObject([
    { round_number: 1 },
  ]);

  for (const screen of [ravi, kitchen, owner, phone]) await screen.context.close();
});
