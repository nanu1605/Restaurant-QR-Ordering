import { expect, test } from '@playwright/test';

import { adminClient, createTestRestaurant } from './helpers';
import { createPlatformAdmin, logInAsPlatformAdmin } from './platform-fixtures';
import {
  paymentLinkEvent,
  razorpayId,
  razorpayReady,
  sendWebhook,
  subscriptionEvent,
} from './razorpay-fixtures';

/**
 * MenuMesh's Razorpay tools and reminder emails (spec §13.4, §14.5–14.6,
 * docs/DECISIONS.md P8-11, P8-12), against the mock Razorpay and Resend in
 * tests/e2e/mock-apis.mjs.
 */

const MOCK = 'http://127.0.0.1:3190';
const RAZORPAY_AUTH = `Basic ${Buffer.from('rzp_test_e2e:e2e-razorpay-secret').toString('base64')}`;
const DAY = 24 * 60 * 60 * 1000;

test.beforeEach(async ({ request }) => {
  test.skip(
    !(await razorpayReady(request)),
    'The running server has no Razorpay test keys (reuse of a dev server without the E2E env).',
  );
});

type MockLink = { id: string; amount: number; notes: Record<string, string> };

async function linksFor(
  request: import('@playwright/test').APIRequestContext,
  restaurantId: string,
) {
  const response = await request.get(`${MOCK}/razorpay/v1/payment_links`, {
    headers: { Authorization: RAZORPAY_AUTH },
  });
  const { payment_links } = (await response.json()) as { payment_links: MockLink[] };
  return payment_links.filter((link) => link.notes.restaurant_id === restaurantId);
}

async function subscriptionRow(restaurantId: string) {
  const { data } = await adminClient()
    .from('restaurant_subscriptions')
    .select('status, source, razorpay_status, current_period_end')
    .eq('restaurant_id', restaurantId)
    .single()
    .throwOnError();
  return data!;
}

test('MenuMesh sends a subscription link and a setup fee link; a paid link extends access', async ({
  page,
  request,
}) => {
  const restaurant = await createTestRestaurant({ prefix: 'e2e-link' });
  await logInAsPlatformAdmin(page, await createPlatformAdmin('e2e-link'));
  await page.goto(`/super/restaurants/${restaurant.restaurantId}`);

  // Three months of Growth: the amount and description follow the months.
  await page.getByRole('button', { name: 'Send payment link' }).click();
  const dialog = page.getByRole('dialog', { name: 'Send payment link' });
  await dialog.getByLabel('Months').fill('3');
  await expect(dialog.getByLabel('Amount (₹)')).toHaveValue('2697');
  await expect(dialog.getByLabel('Description')).toHaveValue('MenuMesh Growth, 3 months');
  await dialog.getByRole('button', { name: 'Send link' }).click();
  await expect(dialog.getByRole('textbox', { name: 'Payment link' })).toHaveValue(
    /^https:\/\/rzp\.io\/l\/plink_E2E/,
  );
  await dialog.getByRole('button', { name: 'Done' }).click();

  const [link] = await linksFor(request, restaurant.restaurantId);
  expect(link).toMatchObject({
    amount: 269700,
    notes: { restaurant_id: restaurant.restaurantId, purpose: 'subscription', months: '3' },
  });

  // The setup fee comes from the platform setting and has no months.
  await page.getByRole('button', { name: 'Send payment link' }).click();
  await dialog.getByLabel('For').selectOption('setup_fee');
  await expect(dialog.getByLabel('Months')).toHaveCount(0);
  await expect(dialog.getByLabel('Amount (₹)')).toHaveValue('1499');
  await dialog.getByRole('button', { name: 'Send link' }).click();
  await expect(dialog.getByRole('textbox', { name: 'Payment link' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  const links = await linksFor(request, restaurant.restaurantId);
  expect(links[1]).toMatchObject({
    amount: 149900,
    notes: { restaurant_id: restaurant.restaurantId, purpose: 'setup_fee' },
  });
  expect(links[1]!.notes).not.toHaveProperty('months');

  // The restaurant pays the subscription link.
  const paid = await sendWebhook(
    request,
    paymentLinkEvent(link!.notes, { id: razorpayId('pay'), amount: 269700 }),
  );
  expect(await paid.json()).toMatchObject({ ok: true, result: 'applied' });
  await page.reload();
  const payments = page.getByRole('table', { name: 'Payments' });
  await expect(payments).toContainText('Payment link');
  await expect(payments).toContainText('₹2,697.00');
  const row = await subscriptionRow(restaurant.restaurantId);
  expect(row).toMatchObject({ status: 'active', source: 'manual' });
  expect(Date.parse(row.current_period_end!)).toBeGreaterThan(Date.now() + 90 * DAY);

  const { count } = await adminClient()
    .from('audit_logs')
    .select('id', { count: 'exact', head: true })
    .eq('restaurant_id', restaurant.restaurantId)
    .eq('action', 'subscription.payment_link_sent');
  expect(count).toBe(2);
});

test('MenuMesh syncs autopay, refuses a second way to pay for it, and cancels it', async ({
  page,
  request,
}) => {
  const restaurant = await createTestRestaurant({ prefix: 'e2e-sync' });
  // The owner started checkout: a subscription Razorpay knows about.
  const created = await request.post(`${MOCK}/razorpay/v1/subscriptions`, {
    headers: { Authorization: RAZORPAY_AUTH },
    data: {
      plan_id: 'plan_E2EGrowthMonth',
      total_count: 120,
      notes: {
        restaurant_id: restaurant.restaurantId,
        plan_code: 'growth',
        billing_cycle: 'monthly',
      },
    },
  });
  const entity = await created.json();
  const { error } = await adminClient().rpc('razorpay_save_subscription', {
    p_restaurant_id: restaurant.restaurantId,
    p_entity: entity,
  });
  expect(error).toBeNull();

  await logInAsPlatformAdmin(page, await createPlatformAdmin('e2e-sync'));
  await page.goto(`/super/restaurants/${restaurant.restaurantId}`);
  await expect(page.getByRole('button', { name: 'Cancel autopay' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sync with Razorpay' }).click();
  await expect(page.getByText('Saved what Razorpay says')).toBeVisible();
  await expect(page.getByText('On (first payment for Growth, monthly)')).toBeVisible();

  await page.getByRole('button', { name: 'Send payment link' }).click();
  const dialog = page.getByRole('dialog', { name: 'Send payment link' });
  await dialog.getByRole('button', { name: 'Send link' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Autopay is on');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // Set up during the trial, so it is cancelled at once and the trial carries on.
  await page.getByRole('button', { name: 'Cancel autopay' }).click();
  const confirm = page.getByRole('alertdialog', { name: /Cancel autopay for/ });
  await confirm.getByRole('button', { name: 'Cancel autopay' }).click();
  await expect(page.getByText('Autopay cancelled')).toBeVisible();
  expect(await subscriptionRow(restaurant.restaurantId)).toMatchObject({
    status: 'trialing',
    razorpay_status: 'cancelled',
  });
});

test('a webhook that failed can be reprocessed from the webhooks page', async ({
  page,
  request,
}) => {
  const restaurant = await createTestRestaurant({ prefix: 'e2e-hook' });
  const subscriptionId = razorpayId('sub');
  const eventId = razorpayId('evt');
  // The charge arrives before the subscription is saved: it fails and is kept.
  const charged = subscriptionEvent(
    'charged',
    {
      id: subscriptionId,
      status: 'active',
      period: { start: new Date(), end: new Date(Date.now() + 30 * DAY) },
    },
    { id: razorpayId('pay'), amount: 89900 },
  );
  expect(await (await sendWebhook(request, charged, { eventId })).json()).toMatchObject({
    result: 'failed',
  });
  const { error } = await adminClient().rpc('razorpay_save_subscription', {
    p_restaurant_id: restaurant.restaurantId,
    p_entity: {
      id: subscriptionId,
      status: 'created',
      notes: {
        restaurant_id: restaurant.restaurantId,
        plan_code: 'growth',
        billing_cycle: 'monthly',
      },
    },
  });
  expect(error).toBeNull();

  await logInAsPlatformAdmin(page, await createPlatformAdmin('e2e-hook'));
  await page.goto('/super');
  await page.getByRole('link', { name: 'Webhooks' }).click();
  await expect(page.getByRole('heading', { name: 'Webhooks', level: 1 })).toBeVisible();
  const filter = page.getByRole('navigation', { name: 'Webhook filter' });
  await filter.getByRole('link', { name: 'Failed' }).click();
  await expect(page).toHaveURL(/status=failed/);
  const row = page.locator(`tr[data-event-id="${eventId}"]`);
  await expect(row).toContainText('RESTAURANT_NOT_FOUND');
  await row.getByRole('button', { name: 'Reprocess' }).click();
  await expect(page.getByText('Reprocessed: applied')).toBeVisible();
  await filter.getByRole('link', { name: 'All' }).click();
  await expect(page.locator(`tr[data-event-id="${eventId}"]`)).toContainText('Processed');
  expect(await subscriptionRow(restaurant.restaurantId)).toMatchObject({
    status: 'active',
    source: 'razorpay',
  });
});

test('the daily cron emails a trial reminder once', async ({ request }) => {
  const restaurant = await createTestRestaurant({ prefix: 'e2e-mail' });
  const email = `${restaurant.slug}@example.test`;
  const db = adminClient();
  await db.from('restaurants').update({ email }).eq('id', restaurant.restaurantId).throwOnError();
  await db
    .from('restaurant_subscriptions')
    .update({ trial_ends_at: new Date(Date.now() + 2 * DAY).toISOString() })
    .eq('restaurant_id', restaurant.restaurantId)
    .throwOnError();

  const cron = { headers: { Authorization: 'Bearer e2e-cron-secret' } };
  // Run twice (another test may run it at the same time too): one email.
  expect((await request.get('/api/cron/daily', cron)).status()).toBe(200);
  expect((await request.get('/api/cron/daily', cron)).status()).toBe(200);

  const inbox = await request.get(`${MOCK}/resend/inbox?to=${encodeURIComponent(email)}`);
  const { emails } = (await inbox.json()) as {
    emails: { subject: string; text: string; from: string }[];
  };
  expect(emails).toHaveLength(1);
  expect(emails[0]).toMatchObject({
    from: 'MenuMesh <billing@menumesh.test>',
    subject: expect.stringMatching(/^Your MenuMesh free trial ends on /),
  });
  expect(emails[0]!.text).toContain('/admin/subscription');
  const { count } = await db
    .from('subscription_reminders')
    .select('id', { count: 'exact', head: true })
    .eq('restaurant_id', restaurant.restaurantId);
  expect(count).toBe(1);
});
