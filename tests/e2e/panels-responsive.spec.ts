import { expect, type Page, test } from '@playwright/test';

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
  for (const label of ['3', '4']) {
    await placeCustomerOrder(r.tables[label]!.token, [
      { menu_item_id: r.item.paneer, quantity: 2 },
    ]);
  }
  const { context, page } = await openLiveScreen(browser, r, 'kitchen', '/staff/kitchen', baseURL!);
  await page.getByRole('button', { name: /^Start all for Table 3/ }).click();
  await page.setViewportSize({ width: 360, height: 740 });
  const column = (name: RegExp) => page.getByRole('heading', { name, level: 2 });
  const jump = page.getByRole('group', { name: 'Go to column' });
  await expect(jump.getByRole('button', { name: 'Preparing 1' })).toBeVisible();
  await expect(column(/^Ready/)).not.toBeInViewport();

  await jump.getByRole('button', { name: /^Ready/ }).click();
  await expect(column(/^Ready/)).toBeInViewport();
  await expect(column(/^New/)).not.toBeInViewport();
  // The page itself stays put: only the columns move.
  expect(await page.evaluate(() => [window.scrollX, document.documentElement.scrollWidth])).toEqual(
    [0, 360],
  );

  // Tablets and up show the three columns side by side.
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(jump).toBeHidden();
  for (const name of [/^New/, /^Preparing/, /^Ready/]) {
    await expect(column(name)).toBeInViewport();
  }
  await context.close();
});
