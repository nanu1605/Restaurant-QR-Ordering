import { expect, test } from '@playwright/test';

import { createPlatformAdmin, logInAsPlatformAdmin } from './platform-fixtures';

// Opt-in, against a production build with the local load data:
//   pnpm seed:platform-load && PERF=1 pnpm e2e super-perf --project=desktop
// Each super-admin page answers within 1.5 s (docs/SUPER_ADMIN_PLAN.md §1, SA-26).
test.skip(!process.env.PERF, 'Set PERF=1 to time the super-admin pages with the load data.');
test.skip(({ isMobile }) => isMobile, 'Server time is the same on any screen.');

const PATHS = [
  '/super',
  '/super?period=month',
  '/super/restaurants',
  '/super/restaurants?sort=gmv',
  '/super/restaurants?health=slowing',
  '/super/money/payments',
  '/super/money/dues',
  '/super/money/subscriptions',
  '/super/leads',
];

test('each super-admin page answers within 1.5 s', async ({ page }) => {
  test.setTimeout(PATHS.length * 15_000);
  await logInAsPlatformAdmin(page, await createPlatformAdmin('perf'));
  const slow: string[] = [];
  for (const path of PATHS) {
    // The second visit, so the first compile or cold cache doesn't count.
    await page.goto(path);
    const response = await page.goto(path);
    const timing = response!.request().timing();
    const ms = Math.round(timing.responseEnd - timing.requestStart);
    console.log(`${path}: ${ms} ms`);
    if (ms > 1500) slow.push(`${path} took ${ms} ms`);
  }
  expect(slow).toEqual([]);
});
