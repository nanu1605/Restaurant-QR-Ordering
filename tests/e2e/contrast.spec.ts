import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import { DEMO_PASSWORD, logInWithCode } from './helpers';
import {
  createPlatformAdmin,
  growthPaths,
  logInAsPlatformAdmin,
  restaurantPagePaths,
  supportRequestPaths,
  supportSessionPaths,
} from './platform-fixtures';

/**
 * Every screen reads in both themes (spec §16.2, docs/DECISIONS.md B-3): axe's
 * colour-contrast rule over each panel, and all of WCAG 2.2 A and AA over the website
 * and the customer menu (W-14).
 */

test.use({ reducedMotion: 'reduce' });

const THEMES = ['light', 'dark'] as const;
const WCAG_22_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** Visits each path in both themes; returns axe's failures, if any. */
async function sweep(page: Page, paths: string[], { wcag = false } = {}) {
  const failures: string[] = [];
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme });
    for (const path of paths) {
      // The website keeps loading in the background (demo, analytics): 'load' is enough.
      await page.goto(path, { waitUntil: 'load' });
      const axe = new AxeBuilder({ page });
      const { violations } = await (
        wcag ? axe.withTags(WCAG_22_AA) : axe.withRules(['color-contrast'])
      ).analyze();
      for (const violation of violations) {
        for (const node of violation.nodes) {
          const why = node.any[0]?.message ?? violation.help;
          failures.push(`${theme} ${path} ${violation.id} ${node.target.join(' ')}: ${why}`);
        }
      }
    }
  }
  return failures;
}

async function logIn(page: Page, username: string) {
  await page.goto('/login');
  await logInWithCode(page, 'demo', username, DEMO_PASSWORD);
  await expect(page).not.toHaveURL(/\/login/);
}

test('website and customer menu', async ({ page }) => {
  test.slow();
  const paths = [
    '/',
    '/features',
    '/pricing',
    '/demo',
    '/contact',
    '/signup',
    '/login',
    '/login/forgot',
  ];
  paths.push('/terms', '/privacy', '/refund', '/shipping');
  paths.push('/hi', '/hi/features', '/hi/pricing', '/hi/demo', '/hi/contact', '/hi/signup');
  paths.push('/t/DEMO0000TABLE001', '/t/DEMO0000TABLE001/cart', '/t/DEMO0000TABLE001/orders');
  expect(await sweep(page, paths, { wcag: true })).toEqual([]);
});

test('worker panel', async ({ page }) => {
  await logIn(page, 'waiter1');
  expect(await sweep(page, ['/staff', '/staff/kitchen', '/staff/availability'])).toEqual([]);
});

test('admin panel', async ({ page }) => {
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
    '/admin/help',
    // Paper inside a dark page (docs/DECISIONS.md B-4).
    '/admin/tables/print',
    '/admin/settings/test-print',
  ];
  expect(await sweep(page, paths)).toEqual([]);
});

test('platform admin panel', async ({ page }) => {
  test.slow();
  const admin = await createPlatformAdmin('contrast');
  await logInAsPlatformAdmin(page, admin);
  const paths = [
    '/super',
    '/super/restaurants',
    // The Growth pages (13d).
    ...(await growthPaths('contrast')),
    // Usage, compared, by week (13e).
    '/super/usage?compare=1&by=week',
    '/super/plans',
    '/super/audit',
    '/super/settings',
    '/super/money/payments',
    '/super/money/dues',
    '/super/money/subscriptions',
    // A restaurant's page, every tab (13a).
    ...(await restaurantPagePaths('contrast')),
    // The support inbox and a request (13b).
    ...(await supportRequestPaths('contrast')),
    // A support session's admin panel, with its banner (13c).
    ...(await supportSessionPaths('contrast', admin)),
  ];
  expect(await sweep(page, paths)).toEqual([]);
});
