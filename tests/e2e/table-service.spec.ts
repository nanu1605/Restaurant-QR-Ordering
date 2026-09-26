import { expect, test } from '@playwright/test';

import { adminClient } from './helpers';
import {
  createLiveRestaurant,
  openCustomerPhone,
  openLiveScreen,
  placeCustomerOrder,
  tableCard,
} from './live-fixtures';

// Table service (spec §8.7, §9.3; docs/DECISIONS.md P9-1…P9-3): customers call
// a waiter or ask for the bill, staff acknowledge and finish, and staff move a
// table's guests to a free table.

test('a customer calls a waiter and asks for the bill; staff handle both', async ({
  browser,
  baseURL,
}) => {
  const r = await createLiveRestaurant({ approval: false });
  const staff = await openLiveScreen(browser, r, 'ravi', '/staff', baseURL!);
  await staff.page.getByRole('button', { name: /^All \d/ }).click();
  const phone = await openCustomerPhone(browser, r.tables['3']!.url, baseURL!);

  // Before ordering: the call reaches the board of a free table.
  await phone.page.getByRole('button', { name: 'Call waiter' }).click();
  await expect(phone.page.getByRole('button', { name: 'Waiter called' })).toBeVisible();
  await expect(staff.page.getByText('Table 3 is calling a waiter')).toBeVisible();
  await expect(tableCard(staff.page, '3')).toContainText('Calling');

  await tableCard(staff.page, '3').click();
  const requests = staff.page
    .getByRole('dialog', { name: /^Table 3/ })
    .getByRole('region', { name: 'Customer requests' });
  await requests.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(requests).toContainText('acknowledged');
  await requests.getByRole('button', { name: /^Done/ }).click();
  await expect(requests).toBeHidden();
  await staff.page.keyboard.press('Escape');
  await expect(tableCard(staff.page, '3')).not.toContainText('Calling');

  // After an order: the bill request.
  await placeCustomerOrder(r.tables['3']!.token, [{ menu_item_id: r.item.paneer, quantity: 1 }]);
  await phone.page.goto(`${r.tables['3']!.url}/orders`);
  await phone.page.getByRole('button', { name: 'Request bill' }).click();
  await expect(phone.page.getByRole('button', { name: 'Bill requested' })).toBeVisible();
  await expect(staff.page.getByText('Table 3 asked for the bill')).toBeVisible();
  await expect(tableCard(staff.page, '3')).toContainText('Bill requested');

  const { data: rows } = await adminClient()
    .from('service_requests')
    .select('type, status, session_id')
    .eq('restaurant_id', r.restaurantId)
    .order('created_at')
    .throwOnError();
  expect(rows).toMatchObject([
    { type: 'call_waiter', status: 'resolved', session_id: null },
    { type: 'request_bill', status: 'open' },
  ]);
  expect(rows![1]!.session_id).not.toBeNull();

  await phone.context.close();
  await staff.context.close();
});

test('a waiter moves the guests to a free table', async ({ browser, baseURL }) => {
  const r = await createLiveRestaurant({ approval: false });
  await placeCustomerOrder(r.tables['3']!.token, [{ menu_item_id: r.item.paneer, quantity: 1 }]);
  const staff = await openLiveScreen(browser, r, 'ravi', '/staff', baseURL!);
  await staff.page.getByRole('button', { name: /^All \d/ }).click();

  await tableCard(staff.page, '3').click();
  await staff.page
    .getByRole('dialog', { name: /^Table 3/ })
    .getByRole('button', { name: 'Move table' })
    .click();
  const move = staff.page.getByRole('dialog', { name: 'Move Table 3' });
  await move
    .getByRole('list', { name: 'Free tables' })
    .getByRole('button', { name: 'Table 5' })
    .click();
  await expect(
    staff.page.getByText('Ask the guests to scan the QR code on Table 5.'),
  ).toBeVisible();
  await expect(tableCard(staff.page, '3')).toHaveAttribute('data-state', 'free');
  await expect(tableCard(staff.page, '5')).toHaveAttribute('data-state', 'in_progress');

  const { data: session } = await adminClient()
    .from('table_sessions')
    .select('dining_table_id, table_label_snapshot, status')
    .eq('restaurant_id', r.restaurantId)
    .single()
    .throwOnError();
  expect(session).toEqual({
    dining_table_id: r.tables['5']!.id,
    table_label_snapshot: '5',
    status: 'open',
  });

  // The order is on table 5's QR code now; table 3 starts afresh.
  const phone = await openCustomerPhone(browser, `${r.tables['5']!.url}/orders`, baseURL!);
  await expect(phone.page.getByText('Paneer Tikka')).toBeVisible();
  await phone.page.goto(`${r.tables['3']!.url}/orders`);
  await expect(phone.page.getByText('Paneer Tikka')).toBeHidden();

  await phone.context.close();
  await staff.context.close();
});
