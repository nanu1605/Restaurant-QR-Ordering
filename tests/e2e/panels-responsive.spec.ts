import { expect, type Page, test } from '@playwright/test';

import { createOrderingTable } from './customer-fixtures';
import { DEMO_PASSWORD, logInWithCode } from './helpers';
import { createLiveRestaurant, openLiveScreen, placeCustomerOrder } from './live-fixtures';
import { createPlatformAdmin, logInAsPlatformAdmin } from './platform-fixtures';

/**
 * Every panel works from a 360 px phone to a laptop (spec §16.3,
 * docs/DECISIONS.md B-6): nothing scrolls the page sideways, and the header's
 * controls are at least 44 px.
 */

const SIZES = [
  { width: 360, height: 740 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
];

test.use({ reducedMotion: 'reduce' });

/** Visits each path at each size; returns what doesn't fit, if anything. */
async function sweep(page: Page, paths: string[], sizes = SIZES) {
  const problems: string[] = [];
  for (const size of sizes) {
    await page.setViewportSize(size);
    for (const path of paths) {
      await page.goto(path, { waitUntil: 'load' });
      const at = `${path} at ${size.width}px`;
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (overflow > 0) problems.push(`${at} scrolls sideways by ${overflow}px`);
      const controls = await page
        .getByRole('banner')
        .locator('a, button')
        .evaluateAll((elements) =>
          elements.flatMap((element) => {
            const { width, height } = element.getBoundingClientRect();
            const name = element.getAttribute('aria-label') ?? element.textContent?.trim();
            return width > 0 && (width < 44 || height < 44)
              ? [`${name} ${Math.round(width)}x${Math.round(height)}`]
              : [];
          }),
        );
      problems.push(...controls.map((control) => `${at}: ${control}`));
    }
  }
  return problems;
}

async function logIn(page: Page, username: string) {
  await page.goto('/login');
  await logInWithCode(page, 'demo', username, DEMO_PASSWORD);
  await expect(page).not.toHaveURL(/\/login/);
}

test('the worker panel fits every screen', async ({ page }) => {
  await logIn(page, 'manager');
  expect(await sweep(page, ['/staff', '/staff/kitchen', '/staff/availability'])).toEqual([]);
});

test('the admin panel fits every screen', async ({ page }) => {
  test.slow();
  await logIn(page, 'owner');
  const paths = [
    '/admin',
    '/admin/live',
    '/admin/billing',
    '/admin/total-orders',
    '/admin/reports',
    '/admin/menu',
    '/admin/tables',
    '/admin/waiters',
    '/admin/staff',
    '/admin/settings',
    '/admin/subscription',
  ];
  expect(await sweep(page, paths)).toEqual([]);
});

test('the platform admin panel fits every screen', async ({ page }) => {
  test.slow();
  await logInAsPlatformAdmin(page, await createPlatformAdmin('responsive'));
  const paths = [
    '/super',
    '/super/restaurants',
    '/super/leads',
    '/super/subscriptions',
    '/super/plans',
    '/super/webhooks',
    '/super/audit',
  ];
  expect(await sweep(page, paths)).toEqual([]);
});

test('the customer menu fits a phone', async ({ page }) => {
  const table = '/t/DEMO0000TABLE001';
  const phone = [{ width: 360, height: 740 }];
  expect(await sweep(page, [table, `${table}/cart`, `${table}/orders`], phone)).toEqual([]);
});

test('calling a waiter keeps the menu header as it was, at a two-digit table', async ({ page }) => {
  const ordering = await createOrderingTable({ prefix: 'header', labels: ['12'] });
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(ordering.tables['12']!.url);
  const header = page.getByRole('banner');
  const height = (await header.boundingBox())!.height;

  await header.getByRole('button', { name: 'Call waiter' }).click();
  await expect(header.getByRole('button', { name: 'Waiter called' })).toBeVisible();
  expect((await header.boundingBox())!.height).toBe(height);
});

test('admin sections are in a menu sheet below laptop width', async ({ page }) => {
  await logIn(page, 'owner');
  const nav = page.getByRole('navigation', { name: 'Admin sections' });
  const openMenu = page.getByRole('button', { name: 'Open menu' });

  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(nav).toBeHidden();
  await openMenu.click();
  await nav.getByRole('link', { name: 'Reports' }).click();
  await expect(page).toHaveURL(/\/admin\/reports$/);

  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(openMenu).toBeHidden();
  await expect(nav.getByRole('link', { name: 'Reports' })).toHaveAttribute('aria-current', 'page');
});

test('on a phone the kitchen shows one column at a time, a tap away', async ({
  browser,
  baseURL,
}) => {
  const r = await createLiveRestaurant({ approval: false });
  const labels = ['3', '4', '5'];
  for (const label of labels) {
    await placeCustomerOrder(r.tables[label]!.token, [
      { menu_item_id: r.item.paneer, quantity: 2 },
      { menu_item_id: r.item.chicken65, quantity: 1 },
    ]);
  }
  const { context, page } = await openLiveScreen(browser, r, 'kitchen', '/staff/kitchen', baseURL!);
  // Three tickets make the Preparing column taller than a phone screen.
  for (const label of labels) {
    await page.getByRole('button', { name: new RegExp(`^Start all for Table ${label}`) }).click();
  }
  await page.setViewportSize({ width: 360, height: 740 });
  const column = (name: RegExp) => page.getByRole('heading', { name, level: 2 });
  const jump = page.getByRole('group', { name: 'Go to column' });
  await expect(jump.getByRole('button', { name: 'Preparing 3' })).toBeVisible();
  // The next column peeks in from the side.
  await expect(column(/^Preparing/)).not.toBeInViewport({ ratio: 1 });

  // Only the columns move, not the page, and focus goes to the column.
  await jump.getByRole('button', { name: /^Preparing/ }).click();
  await expect(column(/^Preparing/)).toBeInViewport({ ratio: 1 });
  await expect(column(/^Preparing/)).toBeFocused();
  await expect(column(/^New/)).not.toBeInViewport();
  expect(await page.evaluate(() => [window.scrollX, window.scrollY])).toEqual([0, 0]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(360);

  await jump.getByRole('button', { name: /^Ready/ }).click();
  await expect(column(/^Ready/)).toBeInViewport({ ratio: 1 });
  await expect(column(/^Ready/)).toBeFocused();

  // Tablets and up show the three columns side by side.
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(jump).toBeHidden();
  for (const name of [/^New/, /^Preparing/, /^Ready/]) {
    await expect(column(name)).toBeInViewport();
  }
  await context.close();
});
