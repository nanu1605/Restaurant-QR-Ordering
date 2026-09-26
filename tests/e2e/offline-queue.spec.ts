import { expect, type Page, type Route, test } from '@playwright/test';

import { adminClient } from './helpers';
import {
  createLiveRestaurant,
  openCustomerPhone,
  openLiveScreen,
  placeCustomerOrder,
  tableCard,
} from './live-fixtures';

// Offline status queue and the installable staff app (spec §19 Phase 9,
// docs/DECISIONS.md P9-5, P9-6): dish moves made without a network reach the
// server once it is back, in order and once each; everything else waits.

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

/** The banner in the table drawer (the modal drawer hides the page's). */
function offlineBanner(page: Page) {
  return page
    .getByRole('dialog', { name: /^Table 3/ })
    .getByRole('status')
    .filter({ hasText: /^(Offline|Can’t reach)/ });
}

// The Phase 9 acceptance check keeps the tablet offline for a minute:
// OFFLINE_MS=60000 pnpm e2e offline-queue
const OFFLINE_MS = Number(process.env.OFFLINE_MS ?? 2_000);

test('dish moves made offline sync on reconnect, once each', async ({ browser, baseURL }) => {
  test.setTimeout(OFFLINE_MS + 60_000);
  const r = await createLiveRestaurant({ approval: false });
  const { order_id: orderId } = await placeCustomerOrder(r.tables['3']!.token, [
    { menu_item_id: r.item.paneer, quantity: 1 },
    { menu_item_id: r.item.chicken65, quantity: 1 },
    { menu_item_id: r.item.butterChicken, variant_id: r.variant.full, quantity: 1 },
  ]);
  const { context, page } = await openLiveScreen(browser, r, 'ravi', '/staff', baseURL!);
  await page.getByRole('button', { name: /^All \d/ }).click();
  await tableCard(page, '3').click();
  const drawer = page.getByRole('dialog', { name: /^Table 3/ });

  await context.setOffline(true);
  await expect(page.getByRole('banner').getByRole('status')).toHaveText('Offline');
  await expect(offlineBanner(page)).toContainText('Dish status changes are kept on this device');
  // Everything but dish moves needs the network.
  await expect(drawer.getByRole('button', { name: 'Add dishes' })).toBeDisabled();
  await expect(drawer.getByRole('button', { name: 'Move table' })).toBeDisabled();
  await expect(drawer.getByRole('button', { name: 'Remove Paneer Tikka' })).toBeDisabled();

  await drawer.getByRole('button', { name: 'Mark served Paneer Tikka' }).click();
  await drawer.getByRole('button', { name: 'Start preparing Chicken 65' }).click();
  await drawer.getByRole('button', { name: 'Mark all served in round 1' }).click();
  await expect(offlineBanner(page)).toContainText('3 changes kept on this device');
  // The board shows them at once; the server has none yet.
  await expect(drawer.getByText('Served', { exact: true })).toHaveCount(3);
  await page.waitForTimeout(OFFLINE_MS);
  expect(await statuses(orderId)).toEqual({
    'Chicken 65': 'placed',
    'Butter Chicken': 'placed',
    'Paneer Tikka': 'placed',
  });

  await context.setOffline(false);
  await expect(offlineBanner(page)).toHaveCount(0);
  await expect
    .poll(() => statuses(orderId))
    .toEqual({ 'Chicken 65': 'served', 'Butter Chicken': 'served', 'Paneer Tikka': 'served' });
  // Realtime rejoins on its own back-off (up to ~10 s after a long outage).
  await expect(page.getByRole('banner').getByRole('status')).toHaveText('Live', {
    timeout: 30_000,
  });
  await expect(drawer.getByText('Served', { exact: true })).toHaveCount(3);
  await expect(drawer.getByRole('button', { name: 'Add dishes' })).toBeEnabled();
  await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith('tableorder:queue:')),
    ),
  ).toEqual([]);

  await context.close();
});

test('a dish move made offline is sent after the tab is closed and reopened', async ({
  browser,
  baseURL,
}) => {
  const r = await createLiveRestaurant({ approval: false });
  const { order_id: orderId } = await placeCustomerOrder(r.tables['3']!.token, [
    { menu_item_id: r.item.paneer, quantity: 1 },
    { menu_item_id: r.item.butterChicken, variant_id: r.variant.full, quantity: 1 },
  ]);
  const { context, page } = await openLiveScreen(browser, r, 'ravi', '/staff', baseURL!);
  await page.getByRole('button', { name: /^All \d/ }).click();
  await tableCard(page, '3').click();

  await context.setOffline(true);
  await page
    .getByRole('dialog', { name: /^Table 3/ })
    .getByRole('button', { name: 'Mark served Paneer Tikka' })
    .click();
  await expect(offlineBanner(page)).toContainText('1 change kept on this device');
  await page.close();

  await context.setOffline(false);
  const again = await context.newPage();
  await again.goto('/staff');
  await expect
    .poll(() => statuses(orderId))
    .toEqual({ 'Butter Chicken': 'placed', 'Paneer Tikka': 'served' });
  await expect(again.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0);

  await context.close();
});

test('another open tab sends a closed tab’s offline move when the network is back', async ({
  browser,
  baseURL,
}) => {
  const r = await createLiveRestaurant({ approval: false });
  const { order_id: orderId } = await placeCustomerOrder(r.tables['3']!.token, [
    { menu_item_id: r.item.paneer, quantity: 1 },
  ]);
  const { context, page } = await openLiveScreen(
    browser,
    r,
    'ravi',
    '/staff/availability',
    baseURL!,
  );
  const board = await context.newPage();
  await board.goto('/staff');
  await board.getByRole('button', { name: /^All \d/ }).click();
  await tableCard(board, '3').click();

  await context.setOffline(true);
  await board
    .getByRole('dialog', { name: /^Table 3/ })
    .getByRole('button', { name: 'Mark served Paneer Tikka' })
    .click();
  await expect(offlineBanner(board)).toContainText('1 change kept on this device');
  await board.close();

  await context.setOffline(false);
  await expect.poll(() => statuses(orderId)).toEqual({ 'Paneer Tikka': 'served' });
  await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0);

  await context.close();
});

test('a dish move is retried while the server can’t be reached, then sent', async ({
  browser,
  baseURL,
}) => {
  const r = await createLiveRestaurant({ approval: false });
  const { order_id: orderId } = await placeCustomerOrder(r.tables['3']!.token, [
    { menu_item_id: r.item.paneer, quantity: 1 },
  ]);
  const { context, page } = await openLiveScreen(browser, r, 'ravi', '/staff', baseURL!);
  await page.getByRole('button', { name: /^All \d/ }).click();
  await tableCard(page, '3').click();

  // Wi-Fi up but the server unreachable: server action requests fail.
  const unreachable = (route: Route) =>
    route.request().headers()['next-action'] ? route.abort() : route.continue();
  await page.route('**/*', unreachable);
  await page
    .getByRole('dialog', { name: /^Table 3/ })
    .getByRole('button', { name: 'Mark served Paneer Tikka' })
    .click();
  await expect(offlineBanner(page)).toContainText(
    '1 change kept on this device, sent as soon as it answers',
  );
  expect(await statuses(orderId)).toEqual({ 'Paneer Tikka': 'placed' });

  await page.unroute('**/*', unreachable);
  await expect
    .poll(() => statuses(orderId), { timeout: 40_000 })
    .toEqual({ 'Paneer Tikka': 'served' });
  await expect(offlineBanner(page)).toHaveCount(0);
  await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0);

  await context.close();
});

test('the staff panel is installable and shows an offline page; customer pages are not', async ({
  browser,
  baseURL,
  request,
}) => {
  const r = await createLiveRestaurant();
  const { context, page } = await openLiveScreen(browser, r, 'ravi', '/staff', baseURL!);

  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/app.webmanifest');
  const manifest = await (await request.get('/app.webmanifest')).json();
  expect(manifest).toMatchObject({ start_url: '/login', display: 'standalone' });
  for (const icon of manifest.icons as { src: string }[]) {
    const response = await request.get(icon.src);
    expect(response.headers()['content-type'], icon.src).toBe('image/png');
  }
  expect(
    await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL),
  ).toMatch(/\/sw\.js$/);
  // Chrome's own check, the one behind its Install app button.
  const cdp = await context.newCDPSession(page);
  expect((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors).toEqual([]);

  // A reload without a network shows the offline page, not the browser's error.
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'You’re offline' })).toBeVisible();
  await context.setOffline(false);
  await page.getByRole('link', { name: 'Try again' }).click();
  await expect(page.getByRole('button', { name: /^All \d/ })).toBeVisible();

  const phone = await openCustomerPhone(browser, r.tables['3']!.url, baseURL!);
  await expect(phone.page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(phone.page.locator('link[rel="manifest"]')).toHaveCount(0);

  await phone.context.close();
  await context.close();
});
