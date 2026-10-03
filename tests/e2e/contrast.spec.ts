import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

import { DEMO_PASSWORD, logInWithCode } from './helpers';
import { createPlatformAdmin, logInAsPlatformAdmin } from './platform-fixtures';

/**
 * Every screen reads in both themes (spec §16.2, docs/DECISIONS.md B-3): axe's
 * colour-contrast rule over the website, the customer menu and each panel.
 */

test.use({ reducedMotion: 'reduce' });

const THEMES = ['light', 'dark'] as const;

/** Visits each path in both themes; returns the contrast failures, if any. */
async function sweep(page: Page, paths: string[]) {
  const failures: string[] = [];
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme });
    for (const path of paths) {
      // The website keeps loading in the background (demo, analytics): 'load' is enough.
      await page.goto(path, { waitUntil: 'load' });
      const { violations } = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
      for (const node of violations.flatMap((v) => v.nodes)) {
        failures.push(`${theme} ${path} ${node.target.join(' ')}: ${node.any[0]?.message}`);
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
  const paths = ['/', '/features', '/pricing', '/demo', '/contact', '/signup', '/terms', '/login'];
  paths.push('/t/DEMO0000TABLE001', '/t/DEMO0000TABLE001/cart', '/t/DEMO0000TABLE001/orders');
  expect(await sweep(page, paths)).toEqual([]);
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
    // Paper inside a dark page (docs/DECISIONS.md B-4).
    '/admin/tables/print',
    '/admin/settings/test-print',
  ];
  expect(await sweep(page, paths)).toEqual([]);
});

test('platform admin panel', async ({ page }) => {
  await logInAsPlatformAdmin(page, await createPlatformAdmin('contrast'));
  const paths = ['/super', '/super/restaurants', '/super/leads', '/super/plans', '/super/audit'];
  expect(await sweep(page, paths)).toEqual([]);
});
