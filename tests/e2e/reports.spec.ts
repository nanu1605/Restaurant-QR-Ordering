import { expect, test } from '@playwright/test';

import { logInWithCode, TEST_PASSWORD } from './helpers';
import { createLiveRestaurant, expectLive, openLiveScreen } from './live-fixtures';
import { billTable, ownerClient, seatTable } from './report-fixtures';

/**
 * Dashboard and reports (spec §13.3, §19 Phase 6): today's numbers, the report
 * tabs, the waiter report's handover rule, CSV downloads and the Starter limits.
 *
 * Reports has a loading screen, so Next streams each page into a hidden block
 * outside <main> before swapping it in; text and label lookups stay inside
 * <main> so they never see that copy.
 */

test.describe('dashboard', () => {
  test('shows today, what needs attention and new bills as they happen', async ({
    browser,
    baseURL,
  }) => {
    const restaurant = await createLiveRestaurant({ maxTablesPerWaiter: 3 });
    const owner = await ownerClient(restaurant);
    const first = await billTable(owner, restaurant, { table: '3' });
    await billTable(owner, restaurant, { table: '4', payment: { mode: 'upi' } });
    // Table 5 is still eating, and its first order needs approval.
    await seatTable(owner, restaurant, { table: '5', quantity: 1 });

    const { context, page } = await openLiveScreen(
      browser,
      restaurant,
      'owner',
      '/admin',
      baseURL!,
    );

    const today = page.getByRole('main').getByLabel('Today');
    await expect(today).toContainText('Bills2');
    await expect(today).toContainText('Open tables1');
    await expect(today).toContainText('Dishes in progress1');
    await expect(page.getByRole('main').getByText('Sales today')).toBeVisible();

    // Table 5's waiter was assigned with its order, so nothing is unassigned.
    await expect(page.getByRole('heading', { name: 'Tables' })).toBeVisible();
    await expect(
      page.getByRole('main').locator('[data-table="5"][data-state="in_progress"]'),
    ).toBeVisible();
    await expect(page.getByRole('main').locator('li[data-waiter="Ravi Kumar"]')).toBeVisible();

    // A third bill arrives while the page is open.
    const before = await today.textContent();
    await billTable(owner, restaurant, { table: '5', quantity: 1, payment: { mode: 'card' } });
    await expect(today).toContainText('Bills3', { timeout: 20_000 });
    expect(before).not.toContain('Bills3');
    await expect(today).toContainText('Open tables0');

    await page.getByRole('link', { name: 'Reports' }).click();
    await expect(page.getByRole('heading', { name: 'Reports', level: 1 })).toBeVisible();
    await expect(page.getByRole('main').getByLabel('Summary')).toContainText('Bills3');
    expect(first.invoiceNumber).toMatch(/\/00001$/);
    await context.close();
  });
});

test.describe('reports', () => {
  test('sales, dishes, tables and activity, with CSV downloads', async ({ browser, baseURL }) => {
    const restaurant = await createLiveRestaurant({
      maxTablesPerWaiter: 3,
      staffCanRemoveServedItems: true,
    });
    const owner = await ownerClient(restaurant);
    const discounted = await billTable(owner, restaurant, {
      table: '3',
      discountBps: 1000,
      discountReason: 'Regular guest',
    });
    await billTable(owner, restaurant, { table: '4', payment: { mode: 'upi' } });

    // A dish sent back, a whole round deleted and a voided bill: the activity log.
    const open = await seatTable(owner, restaurant, { table: '5', quantity: 3 });
    await owner
      .rpc('staff_remove_item', {
        p_order_item_id: open.itemId,
        p_quantity: 1,
        p_reason: 'Spilled',
      })
      .throwOnError();
    await owner
      .rpc('admin_remove_order', { p_order_id: open.orderId, p_reason: 'Kitchen ran out' })
      .throwOnError();
    await owner
      .rpc('admin_void_bill', {
        p_bill_id: discounted.billId,
        p_reason: 'Wrong table',
        p_reopen: false,
      })
      .throwOnError();

    const { context, page } = await openLiveScreen(
      browser,
      restaurant,
      'owner',
      '/admin/reports',
      baseURL!,
    );
    const tabs = page.getByRole('navigation', { name: 'Reports' });

    // Sales: the voided bill is out of the summary.
    const summary = page.getByRole('main').getByLabel('Summary');
    await expect(summary).toContainText('Bills1');
    await expect(page.getByRole('heading', { name: 'How it was paid' })).toBeVisible();
    await expect(page.getByRole('row', { name: /^UPI/ })).toContainText('₹560.00');

    // Dishes.
    await tabs.getByRole('link', { name: 'Dishes' }).click();
    const dishes = page.getByRole('row', { name: /Paneer Tikka/ });
    await expect(dishes).toContainText('2');
    await expect(dishes).toContainText('₹560.00');
    await expect(page.getByRole('img', { name: /Sales per category/ })).toBeVisible();

    // Tables.
    await tabs.getByRole('link', { name: 'Tables' }).click();
    await expect(page.getByRole('main').getByLabel('Turnover')).toContainText('Tables billed1');
    await expect(page.getByRole('row', { name: /^Table 4/ })).toContainText('₹560.00');

    // Activity: the void, the discount and the removed dish, with who and why.
    await tabs.getByRole('link', { name: 'Activity' }).click();
    const voids = page.getByRole('row', { name: new RegExp(discounted.invoiceNumber) });
    await expect(voids.first()).toContainText('Test Owner');
    await expect(page.getByRole('main').getByText('Wrong table')).toBeVisible();
    await expect(page.getByRole('main').getByText('Regular guest')).toBeVisible();

    await page.getByRole('link', { name: 'Removed dishes' }).click();
    await expect(page).toHaveURL(/kind=removed_items/);
    const removed = page.getByRole('row', { name: /Spilled/ });
    await expect(removed).toContainText('Paneer Tikka');
    await expect(removed).toContainText('₹280.00');

    await page.getByRole('link', { name: 'Deleted orders' }).click();
    await expect(page).toHaveURL(/kind=deleted_orders/);
    const deleted = page.getByRole('row', { name: /Kitchen ran out/ });
    await expect(deleted).toContainText('Table 5');
    await expect(deleted).toContainText('Paneer Tikka × 2');
    await expect(deleted).toContainText('₹560.00');

    // A range the database would refuse is a plain 400, not a server error.
    const reversed = await page.request.get(
      '/admin/reports/export?report=sales&from=2026-09-10&to=2026-09-01',
    );
    expect(reversed.status()).toBe(400);

    // A CSV download.
    await tabs.getByRole('link', { name: 'Dishes' }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Dishes CSV' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^dishes-\d{4}-\d{2}-\d{2}\.csv$/);
    const stream = await file.createReadStream();
    const csv = (await stream.toArray()).map(String).join('');
    expect(csv).toContain('Dish,Variant,Category,Food type,Quantity,Sales');
    expect(csv).toContain('Paneer Tikka,,Starters,veg,2,560.00');
    await context.close();
  });

  test('the waiter report counts a handed-over table for whoever billed it', async ({
    browser,
    baseURL,
  }) => {
    const restaurant = await createLiveRestaurant({ maxTablesPerWaiter: 3 });
    const owner = await ownerClient(restaurant);
    const seated = await seatTable(owner, restaurant, { table: '3' });
    // Ravi started the table; Suresh takes over and bills it.
    await owner
      .rpc('admin_assign_waiter', {
        p_session_id: seated.sessionId,
        p_waiter_id: restaurant.waiters.suresh,
        p_force: true,
      })
      .throwOnError();
    await owner.rpc('staff_mark_order_served', { p_order_id: seated.orderId }).throwOnError();
    await owner
      .rpc('admin_generate_bill', {
        p_session_id: seated.sessionId,
        p_discount_type: 'none',
        p_discount_value: 0,
        p_discount_reason: '',
        p_apply_service_charge: false,
      })
      .throwOnError();

    const { context, page } = await openLiveScreen(
      browser,
      restaurant,
      'owner',
      '/admin/reports?report=waiters',
      baseURL!,
    );

    const suresh = page.getByRole('main').locator('tr[data-waiter="Suresh Patel"]');
    const ravi = page.getByRole('main').locator('tr[data-waiter="Ravi Kumar"]');
    await expect(suresh).toContainText('₹560.00');
    await expect(suresh.locator('td').first()).toHaveText('1');
    await expect(ravi.locator('td').first()).toHaveText('0');

    // Sorting by name puts Ravi first, and says so to screen readers.
    await page.getByRole('button', { name: 'Waiter' }).click();
    const header = page.getByRole('columnheader', { name: 'Waiter' });
    await expect(header).toHaveAttribute('aria-sort', 'ascending');
    await expect(page.getByRole('main').locator('tbody tr').first()).toHaveAttribute(
      'data-waiter',
      'Ravi Kumar',
    );
    await context.close();
  });

  test('Starter sees the daily summary only', async ({ browser, baseURL }) => {
    const restaurant = await createLiveRestaurant({ plan: 'starter', maxTablesPerWaiter: 3 });
    const owner = await ownerClient(restaurant);
    await billTable(owner, restaurant, { table: '3' });

    const { context, page } = await openLiveScreen(
      browser,
      restaurant,
      'owner',
      '/admin/reports',
      baseURL!,
    );

    await expect(page.getByRole('main').getByLabel('Summary')).toContainText('Bills1');
    // Today and yesterday only, no custom dates, no payment modes, no CSV.
    const presets = page.getByRole('group', { name: 'Date presets' });
    await expect(presets.getByRole('link')).toHaveCount(2);
    await expect(page.getByRole('heading', { name: 'How it was paid' })).toBeHidden();
    await expect(page.getByRole('link', { name: 'Sales CSV' })).toBeHidden();
    await expect(page.getByRole('main').getByText('Available on Growth')).toBeVisible();

    // A locked tab says so, opens to the upgrade hint and shows no waiter numbers.
    const waitersTab = page
      .getByRole('navigation', { name: 'Reports' })
      .getByRole('link', { name: 'Waiters (Growth plan)' });
    await waitersTab.click();
    await expect(page).toHaveURL(/report=waiters/);
    await expect(waitersTab).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('main').getByText('Waiters report')).toBeVisible();
    await expect(
      page.getByRole('main').getByText('Upgrade to Growth on the Subscription page'),
    ).toBeVisible();
    await expect(page.getByRole('main').locator('tr[data-waiter]')).toHaveCount(0);
    await page.goto('/admin/reports?from=2026-01-01&to=2026-01-31');
    await expect(
      page.getByRole('main').getByText('Your plan shows today and yesterday, so today is shown.'),
    ).toBeVisible();

    // The export URL is refused even when typed in.
    const response = await page.request.get('/admin/reports/export?report=sales');
    expect(response.status()).toBe(403);
    await context.close();
  });
});

test.describe('reports on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the summary and tabs fit a phone', async ({ browser, baseURL }) => {
    const restaurant = await createLiveRestaurant({ maxTablesPerWaiter: 3 });
    const owner = await ownerClient(restaurant);
    await billTable(owner, restaurant, { table: '3' });

    const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    await page.goto('/login');
    await logInWithCode(page, restaurant.slug, 'owner', TEST_PASSWORD);
    await page.waitForURL(/\/admin$/);
    await page.goto('/admin/reports');
    await expectLive(page);

    await expect(page.getByRole('main').getByLabel('Summary')).toContainText('Bills1');
    const width = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(width).toBeLessThanOrEqual(1);
    await context.close();
  });
});
