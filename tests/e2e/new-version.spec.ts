import { devices, expect, type Page, type Route, test } from '@playwright/test';

import { addDish, createOrderingTable, tableState } from './customer-fixtures';
import { adminClient, createTestRestaurant, logInAsOwner } from './helpers';
import {
  createLiveRestaurant,
  openLiveScreen,
  placeCustomerOrder,
  tableCard,
} from './live-fixtures';

// A page from an older build after a deploy (docs/DECISIONS.md VPS-7, VPS-8): the live screens
// refresh by themselves at the first tap that meets the new build, keep the guest's cart and the
// kitchen's dish moves, and never refresh in a loop; the other pages offer Refresh and keep
// what was typed. The newer build is faked: server actions get Next.js's "action not found"
// answer.

/** Answers the next `times` server actions as a newer build would; returns the undo. */
async function staleActions(page: Page, times = Infinity) {
  let left = times;
  const olderBuild = (route: Route) => {
    if (left === 0 || !route.request().headers()['next-action']) return route.continue();
    left--;
    return route.fulfill({
      status: 409,
      contentType: 'text/plain',
      headers: { 'x-nextjs-action-not-found': '1' },
      body: 'Server Action unavailable.',
    });
  };
  await page.route('**/*', olderBuild);
  return () => page.unroute('**/*', olderBuild);
}

/** Marks the page in memory, so a refresh shows as the mark being gone. */
async function mark(page: Page) {
  await page.evaluate(() => {
    (window as { e2eMark?: true }).e2eMark = true;
  });
}

const marked = (page: Page) => page.evaluate(() => 'e2eMark' in window);

/** The order's dish statuses, by name. */
async function statuses(orderId: string) {
  const { data } = await adminClient()
    .from('order_items')
    .select('item_name_snapshot, status')
    .eq('order_id', orderId)
    .order('item_name_snapshot')
    .throwOnError();
  return Object.fromEntries(data!.map((row) => [row.item_name_snapshot, row.status]));
}

/** The dish moves this login keeps on the device (offline-queue.ts). */
const keptMoves = (page: Page, memberId: string) =>
  page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? '[]') as unknown[],
    `tableorder:queue:${memberId}`,
  );

const toast = (page: Page, text: string) =>
  page.locator('[data-sonner-toast]').filter({ hasText: text });

// Longer than the 300 ms a page takes to refresh by itself.
const QUIET_MS = 3000;

/** A few seconds on, the page is as it was: not reloaded, not replaced by the error page. */
async function expectLeftAlone(page: Page) {
  await page.waitForTimeout(QUIET_MS);
  expect(await marked(page)).toBe(true);
  await expect(page.getByText('Refreshing…')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Something went wrong' })).toHaveCount(0);
}

test('a dish move from an older build refreshes the board and is sent from the new page', async ({
  browser,
  baseURL,
}) => {
  const r = await createLiveRestaurant({ approval: false });
  const { order_id: orderId } = await placeCustomerOrder(r.tables['3']!.token, [
    { menu_item_id: r.item.paneer, quantity: 1 },
    { menu_item_id: r.item.chicken65, quantity: 1 },
  ]);
  const { context, page } = await openLiveScreen(browser, r, 'ravi', '/staff', baseURL!);
  const drawer = page.getByRole('dialog', { name: /^Table 3/ });
  async function openTable() {
    await page.getByRole('button', { name: /^All \d/ }).click();
    await tableCard(page, '3').click();
  }
  const errors = page.locator('[data-sonner-toast][data-type="error"]');

  await openTable();
  await staleActions(page, 1);
  await mark(page);
  await drawer.getByRole('button', { name: 'Mark served Paneer Tikka' }).click();
  await expect(toast(page, 'Updated to the new version')).toBeVisible();
  expect(await marked(page)).toBe(false);
  // Sent by the refreshed page, from the move kept on the device.
  await expect
    .poll(() => statuses(orderId))
    .toEqual({ 'Chicken 65': 'placed', 'Paneer Tikka': 'served' });
  await expect(errors).toHaveCount(0);

  // Another such answer within two minutes: no second refresh. The page asks for one and
  // keeps the move on the device until then.
  const fresh = await staleActions(page);
  await mark(page);
  await openTable();
  await drawer.getByRole('button', { name: 'Mark served Chicken 65' }).click();
  const stuck = toast(page, 'The new version didn’t load');
  await expect(stuck).toBeVisible();
  expect(await marked(page)).toBe(true);
  expect(await keptMoves(page, r.logins.ravi.memberId)).toHaveLength(1);
  expect(await statuses(orderId)).toEqual({ 'Chicken 65': 'placed', 'Paneer Tikka': 'served' });
  await expect(errors).toHaveCount(0);

  await fresh();
  await stuck.getByRole('button', { name: 'Refresh' }).click();
  await expect
    .poll(() => statuses(orderId))
    .toEqual({ 'Chicken 65': 'served', 'Paneer Tikka': 'served' });
  await expect.poll(() => keptMoves(page, r.logins.ravi.memberId)).toEqual([]);
  await expect(errors).toHaveCount(0);

  await context.close();
});

test('placing an order from an older build keeps the cart, refreshes once and never loops', async ({
  browser,
  baseURL,
}) => {
  const table = await createOrderingTable({ approval: false });
  const context = await browser.newContext({ ...devices['Pixel 7'], baseURL });
  const page = await context.newPage();
  await page.goto(table.url);
  await addDish(page, 'Paneer Tikka');
  await page.getByRole('link', { name: /View cart/ }).click();
  await expect(page.getByRole('heading', { name: 'Your order' })).toBeVisible();
  const line = page.getByRole('listitem').filter({ hasText: 'Paneer Tikka' });

  const fresh = await staleActions(page);
  await mark(page);
  await page.getByRole('button', { name: 'Place order' }).click();
  const updated = toast(page, 'Updated to the new version');
  await expect(updated).toBeVisible();
  await expect(updated).toContainText('Your cart is saved.');
  expect(await marked(page)).toBe(false);
  await expect(page).toHaveURL(new RegExp(`/t/${table.token}/cart$`));
  await expect(line).toBeVisible();
  expect((await tableState(table.restaurantId)).orders).toEqual([]);

  // Another such answer within two minutes: no second refresh and no network error.
  await mark(page);
  await page.getByRole('button', { name: 'Place order' }).click();
  const stuck = toast(page, 'The new version didn’t load');
  await expect(stuck).toBeVisible();
  await expect(stuck).toContainText('Your cart is saved.');
  expect(await marked(page)).toBe(true);
  await expect(page.getByText('We couldn’t reach the restaurant')).toHaveCount(0);
  await expect(line).toBeVisible();

  await fresh();
  await Promise.all([
    page.waitForEvent('load'),
    stuck.getByRole('button', { name: 'Refresh' }).click(),
  ]);
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${table.token}/orders$`));
  expect((await tableState(table.restaurantId)).orders).toHaveLength(1);

  await context.close();
});

test('an older build’s answer in the admin panel keeps the dialog and what was typed in it', async ({
  page,
}) => {
  const restaurant = await createTestRestaurant({ prefix: 'skew' });
  await logInAsOwner(page, restaurant);
  await page.goto('/admin/menu');
  await page
    .getByRole('region')
    .filter({ has: page.locator('#items-heading') })
    .getByRole('button', { name: 'Add dish' })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: 'Add a dish' });
  await dialog.getByLabel('Dish name').fill('Jain Pav Bhaji');
  await dialog.getByLabel('Price', { exact: true }).fill('150');

  const fresh = await staleActions(page);
  await mark(page);
  await dialog.getByRole('button', { name: 'Add dish' }).click();
  // Nothing reloads by itself: the toast offers Refresh and the owner can copy the text first.
  const ready = toast(page, 'A new version is ready');
  await expect(ready).toBeVisible();
  await expect(ready).toContainText('Copy anything you’ve typed first.');
  await expectLeftAlone(page);
  await expect(dialog.getByLabel('Dish name')).toHaveValue('Jain Pav Bhaji');
  await expect(dialog.getByLabel('Price', { exact: true })).toHaveValue('150');
  const saved = () =>
    adminClient()
      .from('menu_items')
      .select('name')
      .eq('restaurant_id', restaurant.restaurantId)
      .eq('name', 'Jain Pav Bhaji')
      .throwOnError();
  expect((await saved()).data).toEqual([]);

  await fresh();
  await Promise.all([
    page.waitForEvent('load'),
    ready.getByRole('button', { name: 'Refresh' }).click(),
  ]);
  expect(await marked(page)).toBe(false);
  expect((await saved()).data).toEqual([]);
});

// A useTransition without a catch rethrows what its action throws into the nearest error page,
// which would have refreshed the tab and lost the review (docs/DECISIONS.md VPS-8).
test('an older build’s answer to a form action without a catch leaves the page and its typing alone', async ({
  page,
}) => {
  const restaurant = await createTestRestaurant({ prefix: 'skew' });
  await logInAsOwner(page, restaurant);
  await page.goto('/admin/menu/import');
  await page.getByLabel('Menu CSV file').setInputFiles({
    name: 'menu.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      [
        'category,name,description,food_type,price,variant_name,variant_price',
        'Starters,Paneer Tikka,,veg,280,,',
        'Tandoor,Water Bottle,,veg,2,,',
      ].join('\n'),
    ),
  });
  await expect(page).toHaveURL(/\/admin\/menu\/import\/[0-9a-f-]{36}$/);
  const price = page.locator('li[data-row="Water Bottle"]').getByLabel('Price of Water Bottle');
  await expect(price).toHaveValue('2');
  await price.fill('20');

  const fresh = await staleActions(page, 1);
  await mark(page);
  await page.getByRole('button', { name: 'Save draft and finish later' }).click();
  const ready = toast(page, 'A new version is ready');
  await expect(ready).toBeVisible();
  // Not closable: the action stays pending, so a closed toast could not come back.
  await expect(ready.getByRole('button', { name: 'Close toast' })).toHaveCount(0);
  await expectLeftAlone(page);
  await expect(page.getByTestId('review-counts')).toBeVisible();
  await expect(price).toHaveValue('20');

  // Refresh is the way on; the draft was never saved.
  await fresh();
  await Promise.all([
    page.waitForEvent('load'),
    ready.getByRole('button', { name: 'Refresh' }).click(),
  ]);
  await expect(price).toHaveValue('2');
});

test('a script missing after a deploy refreshes the page instead of breaking it', async ({
  browser,
  baseURL,
}) => {
  const table = await createOrderingTable({ approval: false });
  const context = await browser.newContext({ ...devices['Pixel 7'], baseURL });
  const page = await context.newPage();
  // Scripts the menu didn't load are gone, as after a deploy, until the page loads again.
  const loaded = new Set<string>();
  let firstLoad = true;
  let gone = false;
  page.on('request', (request) => {
    if (firstLoad) loaded.add(request.url());
    else if (request.isNavigationRequest() && request.frame() === page.mainFrame()) gone = false;
  });
  await page.goto(table.url, { waitUntil: 'networkidle' });
  firstLoad = false;
  gone = true;
  // Before the cart link appears, so its prefetch is covered too.
  await page.route(/\/_next\/static\/chunks\/.+\.js/, (route) =>
    gone && !loaded.has(route.request().url()) ? route.abort() : route.continue(),
  );

  await addDish(page, 'Paneer Tikka');
  await mark(page);
  await page.getByRole('link', { name: /View cart/ }).click();
  await expect(page.getByRole('button', { name: 'Place order' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/t/${table.token}/cart$`));
  expect(await marked(page)).toBe(false);
  // The customer error page refreshed it, and claimed no new version.
  const refresh = await page.evaluate(() => sessionStorage.getItem('tableorder:new-version'));
  expect(JSON.parse(refresh!)).toMatchObject({ cause: 'chunk' });
  await expect(page.getByText(/new version/i)).toHaveCount(0);

  await context.close();
});
