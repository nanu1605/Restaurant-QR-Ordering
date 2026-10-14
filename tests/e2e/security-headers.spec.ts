import { expect, type Page, test } from '@playwright/test';

import { addDish, placeOrderFromMenu } from './customer-fixtures';
import { watchCspViolations } from './helpers';
import {
  createLiveRestaurant,
  openCustomerPhone,
  openLiveScreen,
  placeCustomerOrder,
  tableCard,
} from './live-fixtures';
import {
  createPlatformAdmin,
  logInAsPlatformAdmin,
  restaurantPagePaths,
} from './platform-fixtures';

// Security hardening (spec §19 Phase 9, docs/DECISIONS.md P9-9): every page
// runs under a nonce-based Content-Security-Policy without being blocked, and
// carries the static security headers.

async function visit(page: Page, path: string) {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
}

test('every panel runs under the content security policy without violations', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const r = await createLiveRestaurant({ approval: false });
  await placeCustomerOrder(r.tables['3']!.token, [{ menu_item_id: r.item.paneer, quantity: 1 }]);

  // A phone orders: menu, options sheet, cart and orders.
  const phone = await openCustomerPhone(browser, r.tables['4']!.url, baseURL!);
  const phoneViolations = await watchCspViolations(phone.context);
  await phone.page.reload();
  await phone.page.getByRole('button', { name: 'Add Butter Chicken' }).click();
  await phone.page
    .getByRole('dialog')
    .getByRole('button', { name: /^Add to cart/ })
    .click();
  await addDish(phone.page, 'Paneer Tikka');
  await placeOrderFromMenu(phone.page);
  await phone.page.waitForLoadState('networkidle');

  // The waiter's board and the kitchen.
  const staff = await openLiveScreen(browser, r, 'ravi', '/staff', baseURL!);
  const staffViolations = await watchCspViolations(staff.context);
  await visit(staff.page, '/staff');
  await staff.page.getByRole('button', { name: /^All \d/ }).click();
  await tableCard(staff.page, '3').click();
  await expect(staff.page.getByRole('dialog', { name: /^Table 3/ })).toBeVisible();
  await visit(staff.page, '/staff/availability');
  const kitchen = await openLiveScreen(browser, r, 'kitchen', '/staff/kitchen', baseURL!);
  const kitchenViolations = await watchCspViolations(kitchen.context);
  await visit(kitchen.page, '/staff/kitchen');

  // Every admin page (subscription.spec.ts checks Razorpay Checkout).
  const owner = await openLiveScreen(browser, r, 'owner', '/admin/live', baseURL!);
  const ownerViolations = await watchCspViolations(owner.context);
  for (const path of [
    '/admin',
    '/admin/live',
    '/admin/menu',
    '/admin/menu/import',
    '/admin/tables',
    '/admin/tables/print',
    '/admin/staff',
    '/admin/waiters',
    '/admin/billing',
    '/admin/total-orders',
    '/admin/reports',
    '/admin/settings',
    '/admin/settings/test-print',
    '/admin/subscription',
  ]) {
    await visit(owner.page, path);
  }

  expect([
    ...phoneViolations,
    ...staffViolations,
    ...kitchenViolations,
    ...ownerViolations,
  ]).toEqual([]);

  for (const context of [phone.context, staff.context, kitchen.context, owner.context]) {
    await context.close();
  }
});

test('the platform admin pages run under the policy without violations', async ({ page }) => {
  // Nine pages to the network going quiet, Home's charts and alerts after it, beside the suite.
  test.slow();
  const violations = await watchCspViolations(page.context());
  await logInAsPlatformAdmin(page, await createPlatformAdmin('csp'));
  for (const path of [
    '/super',
    '/super/restaurants',
    '/super/leads',
    '/super/plans',
    '/super/money/payments',
    '/super/money/dues',
    '/super/money/subscriptions',
    '/super/webhooks',
    '/super/audit',
    // A restaurant's Overview (its chart) and Billing.
    ...(await restaurantPagePaths('csp')).slice(0, 2),
  ]) {
    await visit(page, path);
  }
  expect(violations).toEqual([]);
});

test('pages carry the security headers and a new script nonce on every request', async ({
  request,
}) => {
  const nonces = new Set<string>();
  for (const path of ['/login', '/login', '/t/DEMO0000TABLE001']) {
    const response = await request.get(path);
    const headers = response.headers();
    const csp = headers['content-security-policy']!;
    expect(csp, path).toContain("frame-ancestors 'none'");
    expect(csp, path).toContain("object-src 'none'");
    expect(csp, path).toContain("'strict-dynamic'");
    // A reused local `next dev` server allows eval for React's overlays; CI runs `next start`.
    if (process.env.CI) expect(csp, path).not.toContain('unsafe-eval');
    const nonce = /'nonce-([^']+)'/.exec(csp)![1]!;
    nonces.add(nonce);
    // Next.js puts the nonce on its scripts.
    expect(await response.text(), path).toContain(`nonce="${nonce}"`);

    expect(headers).toMatchObject({
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      'strict-transport-security': 'max-age=63072000',
    });
    expect(headers['x-powered-by'], path).toBeUndefined();
  }
  expect(nonces.size).toBe(3);
});
