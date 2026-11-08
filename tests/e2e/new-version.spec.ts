import { devices, expect, type Page, type Route, test } from '@playwright/test';

import { addDish, createOrderingTable, tableState } from './customer-fixtures';
import { adminClient, createTestRestaurant, logInAsOwner } from './helpers';
import {
  createLiveRestaurant,
  openLiveScreen,
  placeCustomerOrder,
  tableCard,
} from './live-fixtures';
import { createPlatformAdmin, logInAsPlatformAdmin } from './platform-fixtures';

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

/**
 * Lets the next server action reach the server, then drops its answer, as a lost connection
 * would; returns the undo.
 */
async function loseNextAnswer(page: Page) {
  let lost = false;
  const lose = async (route: Route) => {
    if (lost || !route.request().headers()['next-action']) return route.continue();
    lost = true;
    await route.fetch();
    return route.abort();
  };
  await page.route('**/*', lose);
  return () => page.unroute('**/*', lose);
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

/** What the toast adds where the answer is kept back (VPS-8). */
const NOT_SAVED = 'What you just changed wasn’t saved, and nothing will be until you refresh.';

// Longer than the 300 ms a page takes to refresh by itself.
const QUIET_MS = 3000;

/** A few seconds on, the page is as it was: not reloaded, not replaced by the error page. */
async function expectLeftAlone(page: Page) {
  await page.waitForTimeout(QUIET_MS);
  expect(await marked(page)).toBe(true);
  await expect(page.getByText('Refreshing…')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Something went wrong' })).toHaveCount(0);
}

/**
 * A new restaurant's owner on the review screen of a menu import (a CSV of two dishes). Returns
 * the price field of the second dish, which reads 2.
 */
async function openImportReview(page: Page) {
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
  return price;
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

// The refresh onto a new build must not make the guest's second tap a second order (spec §9.3,
// docs/DECISIONS.md VPS-8): the cart keeps the key its order was sent with.
test('an order whose answer was lost is placed once, though the page refreshes before the retry', async ({
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

  // The order reaches the restaurant, but its answer never gets back to the phone.
  const answered = await loseNextAnswer(page);
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page.getByText('We couldn’t reach the restaurant')).toBeVisible();
  await answered();
  expect((await tableState(table.restaurantId)).orders).toHaveLength(1);

  // A new build is live by the retry: the page refreshes by itself, and its cart is back.
  const fresh = await staleActions(page, 1);
  await mark(page);
  await page.getByRole('button', { name: 'Place order' }).click();
  const updated = toast(page, 'Updated to the new version');
  await expect(updated).toBeVisible();
  expect(await marked(page)).toBe(false);
  await expect(page.getByRole('listitem').filter({ hasText: 'Paneer Tikka' })).toBeVisible();
  await fresh();

  // The toast says to place it again: the server hands back the order it has.
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${table.token}/orders$`));
  expect((await tableState(table.restaurantId)).orders).toHaveLength(1);
  const stored = (key: string) => page.evaluate((k) => localStorage.getItem(k), key);
  expect(await stored(`tableorder:cart:${table.token}`)).toBeNull();
  expect(await stored(`tableorder:order-key:${table.token}`)).toBeNull();

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
  const price = await openImportReview(page);
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

  // So is a link. Next.js's own navigation would wait for that action to end, so the page loads
  // the link's address in full, and Back loads the review again.
  await staleActions(page, 1);
  await mark(page);
  await price.fill('20');
  await page.getByRole('button', { name: 'Save draft and finish later' }).click();
  await expect(ready).toBeVisible();
  await expectLeftAlone(page);
  await Promise.all([
    page.waitForEvent('load'),
    page
      .getByRole('navigation', { name: 'Admin sections' })
      .getByRole('link', { name: 'Tables & QR' })
      .click(),
  ]);
  await expect(page).toHaveURL(/\/admin\/tables$/);
  await expect(page.getByRole('heading', { name: 'Tables & QR', level: 1 })).toBeVisible();
  expect(await marked(page)).toBe(false);

  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/menu\/import\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('review-counts')).toBeVisible();
  await expect(price).toHaveValue('2');
  expect(await marked(page)).toBe(false);
});

// Next.js's own Back and Forward wait behind that action as well: the address changes and the
// page stays, so the page reloads the address the browser moved to (docs/DECISIONS.md VPS-8).
test('Back after an older build’s answer to a form action loads the page the browser moved to', async ({
  page,
}) => {
  const price = await openImportReview(page);
  await price.fill('20');
  await staleActions(page, 1);
  await mark(page);
  await page.getByRole('button', { name: 'Save draft and finish later' }).click();
  await expect(toast(page, 'A new version is ready')).toBeVisible();
  expect(await marked(page)).toBe(true);

  // The import page the review was reached from: this page's own history, not a new load.
  const loaded = page.waitForEvent('load');
  await page.goBack();
  await loaded;
  await expect(page).toHaveURL(/\/admin\/menu\/import$/);
  await expect(page.getByRole('heading', { name: 'Import menu', level: 1 })).toBeVisible();
  expect(await marked(page)).toBe(false);

  // And Forward is the review again, its draft never saved.
  await page.goForward();
  await expect(page).toHaveURL(/\/admin\/menu\/import\/[0-9a-f-]{36}$/);
  await expect(price).toHaveValue('2');
});

// A switch goes on showing its change as made behind a kept answer (its optimistic value only
// reverts when the action ends), and the taps after it queue and are never sent: the toast says
// nothing was saved, and the stylesheet stops taps on the controls that would look applied
// (docs/DECISIONS.md VPS-8).
test('behind a kept answer the toast says nothing was saved, and other switches stop taking taps', async ({
  page,
}) => {
  const table = await createOrderingTable({ approval: false });
  await logInAsOwner(page, table.restaurant);
  await page.goto('/admin/menu');
  const paneer = page.getByRole('switch', { name: 'Paneer Tikka in stock' });
  const chicken = page.getByRole('switch', { name: 'Chicken 65 in stock' });
  const grip = page.getByRole('button', { name: 'Move Chicken 65' });
  const search = page.getByLabel('Search dishes');
  await expect(paneer).toBeChecked();
  // Until an answer is kept back the page is as it always was.
  await expect(page.locator('html')).not.toHaveAttribute('data-new-version', /./);
  await expect(chicken).toHaveCSS('pointer-events', 'auto');
  await expect(chicken).toHaveCSS('opacity', '1');

  const sent: string[] = [];
  page.on('request', (request) => {
    if (request.headers()['next-action']) sent.push(request.url());
  });
  const fresh = await staleActions(page);
  await mark(page);
  await paneer.click();
  const ready = toast(page, 'A new version is ready');
  await expect(ready).toBeVisible();
  await expect(ready).toContainText(NOT_SAVED);
  await expect(ready).toContainText('Copy anything you’ve typed first.');
  await expect(page.locator('html')).toHaveAttribute('data-new-version', 'kept');
  expect(sent).toHaveLength(1);

  // The other switch and the drag handle are frozen and dimmed, so a tap on them does nothing:
  // it used to flip the switch and wait behind the first action, never sent.
  for (const control of [paneer, chicken, grip]) {
    await expect(control).toHaveCSS('pointer-events', 'none');
    await expect(control).toHaveCSS('opacity', '0.6');
  }
  const { x, y, width, height } = (await chicken.boundingBox())!;
  await page.mouse.click(x + width / 2, y + height / 2);
  await expectLeftAlone(page);
  await expect(chicken).toBeChecked();
  expect(sent).toHaveLength(1);

  // A text field still takes the pointer and the keys, so typed text can be selected and copied.
  await expect(search).toHaveCSS('pointer-events', 'auto');
  await search.click();
  await page.keyboard.type('Chicken');
  await expect(search).toHaveValue('Chicken');

  // A button that only opens a menu still does (on a phone the panel's navigation is such a
  // sheet), and what the menu holds that acts stays frozen; its links load in full.
  const account = page.getByRole('banner').getByRole('button', { name: /Owner/ });
  await expect(account).toHaveCSS('pointer-events', 'auto');
  await account.click();
  const logOut = page.getByRole('menuitem', { name: 'Log out' });
  await expect(logOut).toBeVisible();
  await expect(logOut).toHaveCSS('pointer-events', 'none');
  await page.keyboard.press('Escape');
  await expect(logOut).toBeHidden();
  expect(sent).toHaveLength(1);

  const stored = async () => {
    const { data } = await adminClient()
      .from('menu_items')
      .select('name, is_available')
      .eq('restaurant_id', table.restaurantId)
      .in('name', ['Chicken 65', 'Paneer Tikka'])
      .throwOnError();
    return Object.fromEntries(data!.map((row) => [row.name, row.is_available]));
  };
  expect(await stored()).toEqual({ 'Chicken 65': true, 'Paneer Tikka': true });

  // Refresh, in the toast, still works: the page shows what the server has.
  await fresh();
  await Promise.all([
    page.waitForEvent('load'),
    ready.getByRole('button', { name: 'Refresh' }).click(),
  ]);
  expect(await marked(page)).toBe(false);
  await expect(page.locator('html')).not.toHaveAttribute('data-new-version', /./);
  await expect(paneer).toBeChecked();
  await expect(chicken).toHaveCSS('pointer-events', 'auto');
});

// Next.js's own move to a place on this page waits behind the action as well, so the page follows
// such a link itself (docs/DECISIONS.md VPS-8): the alerts bell's All activity, a link to
// /super#activity, on a page that is on /super already.
test('behind a kept answer a link to a place on the same page still goes there', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 500 });
  const restaurant = await createTestRestaurant({ prefix: 'hash' });
  const firstLook = page.waitForResponse((response) => response.url().endsWith('/super/alerts'));
  await logInAsPlatformAdmin(page, await createPlatformAdmin('hash'));
  await firstLook;
  // A payment after the first look is new to the bell: opening it marks the alerts seen, an
  // action in a transition.
  await adminClient()
    .from('subscription_payments')
    .insert({
      restaurant_id: restaurant.restaurantId,
      source: 'manual',
      amount_paise: 118000,
      manual_mode: 'upi',
      period_start: new Date().toISOString(),
      period_end: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      gst_bps: 1800,
    })
    .throwOnError();
  const looked = page.waitForResponse((response) => response.url().endsWith('/super/alerts'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await looked;

  await staleActions(page);
  await mark(page);
  await page.getByRole('button', { name: /^Alerts, \d+ new$/ }).click();
  await expect(toast(page, 'A new version is ready')).toBeVisible();
  const activity = page.locator('#activity');
  await expect(activity).not.toBeInViewport();

  await page.getByRole('menuitem', { name: 'All activity' }).click();
  await expect(page).toHaveURL(/\/super#activity$/);
  await expect(page.getByRole('heading', { name: 'Activity', level: 2 })).toBeInViewport();
  expect(await marked(page)).toBe(true);

  // The place is a history entry of this page: Back leaves the page where it is.
  await page.goBack();
  await expect(page).toHaveURL(/\/super$/);
  await expectLeftAlone(page);
});

// The rule's reach, in the browser that matters: buttons and the other controls are frozen, a
// select's trigger too, and links, text fields, tabs, the buttons that only open a menu or a
// dialog, what is marked to stay live and the toaster's own buttons are not.
test('behind a kept answer taps stop on the controls, and not on links, fields, tabs or what only opens', async ({
  page,
}) => {
  await page.goto('/login');
  const reach = await page.evaluate(() => {
    document.documentElement.dataset.newVersion = 'kept';
    const probe = (html: string, find: string) => {
      const box = document.createElement('div');
      box.innerHTML = html;
      document.body.append(box);
      return getComputedStyle(box.querySelector(find)!).pointerEvents;
    };
    const frozen = {
      'a button': '<button>Save</button>',
      'a role button': '<div role="button">Save</div>',
      'a switch': '<span role="switch"></span>',
      'a role checkbox': '<span role="checkbox"></span>',
      'a role radio': '<span role="radio"></span>',
      'a menu item': '<div role="menuitem">Edit</div>',
      'a menu checkbox item': '<div role="menuitemcheckbox">Sound</div>',
      'a menu radio item': '<div role="menuitemradio">English</div>',
      'an option': '<div role="option">Half</div>',
      'a slider': '<div role="slider"></div>',
      'a sortable handle': '<div aria-roledescription="sortable"></div>',
      'a select': '<select><option>One</option></select>',
      'a file input': '<input type="file">',
      'a submit input': '<input type="submit">',
      'a button input': '<input type="button">',
      'a checkbox': '<input type="checkbox">',
      'a radio': '<input type="radio">',
      'a range': '<input type="range">',
      // It opens a list of choices, which is there to change a value.
      'a select trigger': '<button aria-haspopup="listbox">Category</button>',
    };
    const open = {
      'a link': '<a href="/admin">Admin</a>',
      'a link that is a menu item': '<a href="/super#activity" role="menuitem">All activity</a>',
      'a text field': '<input type="text">',
      'a search field': '<input type="search">',
      'a text area': '<textarea></textarea>',
      'a tab': '<button role="tab">Email</button>',
      'a tab that is no button': '<div role="tab">Email</div>',
      'a sheet trigger': '<button aria-haspopup="dialog" aria-expanded="false">Open menu</button>',
      'a menu trigger': '<button aria-haspopup="menu">Account</button>',
      'a button that sends nothing': '<button data-live-when-kept>Pause</button>',
      'a button in the toaster': '<ol data-sonner-toaster><li><button>Refresh</button></li></ol>',
    };
    const read = (kinds: Record<string, string>) =>
      Object.entries(kinds).map(([name, html]) => [
        name,
        probe(html, html.startsWith('<ol') ? 'button' : ':scope > *'),
      ]);
    return { frozen: read(frozen), open: read(open) };
  });
  expect(reach.frozen.filter(([, events]) => events !== 'none')).toEqual([]);
  expect(reach.open.filter(([, events]) => events !== 'auto')).toEqual([]);
  expect(reach.frozen.length + reach.open.length).toBe(30);
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
