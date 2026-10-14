import { expect, test } from '@playwright/test';

import { adminClient, createTestRestaurant } from './helpers';
import { createPlatformAdmin, logInAsPlatformAdmin } from './platform-fixtures';

/**
 * Home (docs/SUPER_ADMIN_PLAN.md 12e; docs/DECISIONS.md SA-27 to SA-31): key
 * numbers, Needs attention and its snoozes, the alerts bell and the stream,
 * and the daily digest going out once.
 */

const MOCK = 'http://127.0.0.1:3190';
const HOUR = 3600 * 1000;

test('Home lists a failed payment, and a snooze puts it aside', async ({ page }) => {
  const restaurant = await createTestRestaurant({ prefix: 'home' });
  // Grace ends in an hour: first in its group.
  await adminClient()
    .from('restaurant_subscriptions')
    .update({
      status: 'past_due',
      source: 'razorpay',
      razorpay_status: 'pending',
      billing_cycle: 'monthly',
      trial_ends_at: null,
      current_period_end: new Date(Date.now() - 24 * HOUR).toISOString(),
      grace_until: new Date(Date.now() + HOUR).toISOString(),
    })
    .eq('restaurant_id', restaurant.restaurantId)
    .throwOnError();

  await logInAsPlatformAdmin(page, await createPlatformAdmin('home'));
  await expect(page.getByRole('heading', { name: 'Home', level: 1 })).toBeVisible();
  const numbers = page.getByRole('region', { name: 'Key numbers' });
  await expect(numbers.getByRole('link', { name: 'Collected today' })).toBeVisible();
  await numbers.getByRole('link', { name: 'This month' }).click();
  await expect(numbers.getByRole('link', { name: 'Collected this month' })).toBeVisible();
  await expect(page).toHaveURL(/period=month/);

  const failed = page.getByRole('region', { name: /^Payment failed \(\d+\)$/ });
  const row = failed.getByRole('listitem').filter({ hasText: restaurant.name });
  await expect(row).toContainText('₹1,060.82 with GST');
  await row.getByRole('button', { name: `Snooze ${restaurant.name}` }).click();
  await page.getByRole('menuitem', { name: 'For 1 day' }).click();
  await expect(page.getByText('Snoozed for 1 day')).toBeVisible();
  await expect(row).toHaveCount(0);

  // The charts load after the page, each with its numbers as a table.
  const usage = page.getByRole('region', { name: 'GMV and orders, 30 days' });
  await expect(
    usage
      .getByRole('img', { name: /^GMV and orders for the 30 days/ })
      .or(usage.getByText('No orders in the last 30 days.')),
  ).toBeVisible();
  await usage.getByText('Show as a table').click();
  await expect(usage.getByRole('columnheader', { name: 'Orders' })).toBeVisible();
});

test('a new payment raises an alert and shows in the activity', async ({ page }) => {
  const restaurant = await createTestRestaurant({ prefix: 'alert' });
  await logInAsPlatformAdmin(page, await createPlatformAdmin('alerts'));
  // The first look is quiet; it sets what counts as new.
  await page.waitForResponse((response) => response.url().endsWith('/super/alerts'));

  await adminClient()
    .from('subscription_payments')
    .insert({
      restaurant_id: restaurant.restaurantId,
      source: 'manual',
      amount_paise: 118000,
      manual_mode: 'upi',
      // The column's default reads a private function only the database's own functions may call.
      gst_bps: 1800,
    })
    .throwOnError();
  // Coming back to the tab looks again at once, instead of within the minute.
  const looked = page.waitForResponse((response) => response.url().endsWith('/super/alerts'));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await looked;
  await expect(page.getByText('Payment received').first()).toBeVisible();
  await expect(page.getByText(`${restaurant.name}, ₹1,180`).first()).toBeVisible();

  const bell = page.getByRole('button', { name: /^Alerts, \d+ new$/ });
  await bell.click();
  await expect(
    page.getByRole('menuitem').filter({ hasText: restaurant.name }).first(),
  ).toContainText('Payment received');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Alerts', exact: true })).toBeVisible();

  await page.goto('/super?kind=payment#activity');
  const activity = page.getByRole('region', { name: 'Activity' });
  await expect(activity.getByRole('link', { name: 'Payments', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(
    activity.getByRole('listitem').filter({ hasText: restaurant.name }).first(),
  ).toContainText('₹1,000 + GST ₹180');
});

test('the daily digest goes out once a day', async ({ request }) => {
  const secret = { Authorization: 'Bearer e2e-cron-secret' };
  expect((await request.get('/api/cron/digest')).status()).toBe(401);
  // Locally the digest may have gone out in an earlier run today.
  const db = adminClient();
  await db.from('cron_runs').delete().eq('job', 'digest').throwOnError();
  test.skip(
    (await request.get('/api/cron/digest', { headers: secret })).status() === 401,
    'The running server has no CRON_SECRET for E2E (reuse of a dev server without the E2E env).',
  );
  await db.from('cron_runs').delete().eq('job', 'digest').throwOnError();
  const admin = await createPlatformAdmin('digest');

  const first = await request.get('/api/cron/digest', { headers: secret });
  expect(first.status()).toBe(200);
  const body = (await first.json()) as { digest: { day: string; sent?: number } };
  expect(body.digest.sent).toBeGreaterThan(0);
  const again = await request.get('/api/cron/digest', { headers: secret });
  expect(((await again.json()) as { digest: { skipped?: string } }).digest.skipped).toBe(
    'already sent',
  );

  const inbox = (await (
    await fetch(`${MOCK}/resend/inbox?to=${encodeURIComponent(admin.email)}`)
  ).json()) as {
    emails: { subject: string; text: string }[];
  };
  const digests = inbox.emails.filter((email) => email.subject.startsWith('MenuMesh on '));
  expect(digests).toHaveLength(1);
  expect(digests[0]!.text).toContain('Needs attention today');
  expect(digests[0]!.text).toMatch(/Home: http.*\/super/);
  const runs = await db.from('cron_runs').select('ok, detail').eq('job', 'digest').throwOnError();
  expect(runs.data).toHaveLength(2);
  expect(runs.data!.every((run) => run.ok)).toBe(true);
});
