import { expect, test } from '@playwright/test';

import { adminClient, createTestRestaurant, logInAsOwner } from './helpers';
import { createPlatformAdmin, logInAsPlatformAdmin } from './platform-fixtures';
import {
  razorpayId,
  razorpayReady,
  sendWebhook,
  stubCheckout,
  subscriptionEvent,
} from './razorpay-fixtures';

/**
 * Paying for MenuMesh through Razorpay (spec §14.3–14.4, §19 Phase 8,
 * docs/DECISIONS.md P8-3 … P8-10), against the mock Razorpay API in
 * tests/e2e/mock-apis.mjs and a stubbed Checkout.
 */

// Plans are shared: the Razorpay plan ids set here are put back afterwards.
test.describe.configure({ mode: 'serial' });

const DAY = 24 * 60 * 60 * 1000;
let savedPlanIds: { code: string; monthly: string | null; yearly: string | null }[] = [];

test.beforeAll(async () => {
  const admin = adminClient();
  const { data } = await admin
    .from('plans')
    .select('code, razorpay_plan_id_monthly, razorpay_plan_id_yearly')
    .in('code', ['growth', 'starter']);
  savedPlanIds = (data ?? []).map((plan) => ({
    code: plan.code,
    monthly: plan.razorpay_plan_id_monthly,
    yearly: plan.razorpay_plan_id_yearly,
  }));
  await admin
    .from('plans')
    .update({ razorpay_plan_id_monthly: 'plan_E2EGrowthMonth', razorpay_plan_id_yearly: null })
    .eq('code', 'growth');
});

test.afterAll(async () => {
  const admin = adminClient();
  for (const plan of savedPlanIds) {
    await admin
      .from('plans')
      .update({ razorpay_plan_id_monthly: plan.monthly, razorpay_plan_id_yearly: plan.yearly })
      .eq('code', plan.code);
  }
});

test.beforeEach(async ({ request }) => {
  test.skip(
    !(await razorpayReady(request)),
    'The running server has no Razorpay test keys (reuse of a dev server without the E2E env).',
  );
});

async function subscriptionRow(restaurantId: string) {
  const { data, error } = await adminClient()
    .from('restaurant_subscriptions')
    .select(
      'status, razorpay_subscription_id, razorpay_status, cancel_at_period_end, current_period_end, grace_until',
    )
    .eq('restaurant_id', restaurantId)
    .single();
  if (error) throw error;
  return data;
}

test('an owner sets up autopay, and webhooks move the subscription through its states', async ({
  page,
  request,
}) => {
  const restaurant = await createTestRestaurant({ prefix: 'e2e-pay' });
  await stubCheckout(page);
  await logInAsOwner(page, restaurant);
  await page.goto('/admin/subscription');

  // Growth has a monthly Razorpay plan only.
  const plans = page.getByRole('list', { name: 'Plans' });
  const growth = plans.getByRole('listitem', { name: 'Growth' });
  await expect(
    page.getByText(/The first payment is on .*, when your free trial ends\./),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Yearly' }).click();
  await expect(growth.getByRole('button', { name: 'Not available yearly' })).toBeDisabled();
  await page.getByRole('button', { name: 'Monthly' }).click();
  await growth.getByRole('button', { name: 'Subscribe to Growth' }).click();

  await expect(page.getByText('Autopay is set up', { exact: true })).toBeVisible();
  await expect(
    page.getByText(/Autopay is set up for Growth, monthly; the first payment is on/),
  ).toBeVisible();
  await expect(page.getByTestId('subscription-status')).toHaveText('Free trial');
  const row = await subscriptionRow(restaurant.restaurantId);
  expect(row).toMatchObject({ status: 'trialing', razorpay_status: 'authenticated' });
  const subscriptionId = row.razorpay_subscription_id!;

  // The first charge: paid, with the payment listed.
  const period = { start: new Date(), end: new Date(Date.now() + 30 * DAY) };
  const payment = { id: razorpayId('pay'), amount: 89900 };
  const charged = subscriptionEvent(
    'charged',
    { id: subscriptionId, status: 'active', period },
    payment,
  );
  const eventId = razorpayId('evt');
  const first = await sendWebhook(request, charged, { eventId });
  expect(await first.json()).toMatchObject({ ok: true, result: 'applied' });
  // Razorpay delivers again: same event id, then the same payment under a new id.
  expect(await (await sendWebhook(request, charged, { eventId })).json()).toMatchObject({
    result: 'duplicate',
  });
  await sendWebhook(request, charged);

  await page.reload();
  await expect(page.getByTestId('subscription-status')).toHaveText('Paid');
  await expect(page.getByText(/It renews automatically\./)).toBeVisible();
  const payments = page.getByRole('table', { name: 'Payments' });
  await expect(payments.getByRole('row')).toHaveCount(2); // header + one payment
  await expect(payments).toContainText('Online (Razorpay)');
  await expect(payments).toContainText('₹899.00');

  // The renewal fails: full access during grace, with a warning.
  await sendWebhook(
    request,
    subscriptionEvent('pending', { id: subscriptionId, status: 'pending' }),
  );
  await page.reload();
  await expect(page.getByTestId('subscription-status')).toHaveText('Payment failed');
  await expect(
    page.getByRole('status').filter({ hasText: 'Payment failed. Update payment by' }),
  ).toBeVisible();
  expect((await subscriptionRow(restaurant.restaurantId)).grace_until).not.toBeNull();

  // Razorpay retries and succeeds.
  await sendWebhook(
    request,
    subscriptionEvent(
      'charged',
      {
        id: subscriptionId,
        status: 'active',
        period: { start: period.end, end: new Date(period.end.getTime() + 30 * DAY) },
      },
      { id: razorpayId('pay'), amount: 89900 },
    ),
  );
  await page.reload();
  await expect(page.getByTestId('subscription-status')).toHaveText('Paid');
  await expect(page.getByRole('status').filter({ hasText: 'Payment failed' })).toHaveCount(0);

  // Cancel at the end of the paid period.
  await page.getByRole('button', { name: 'Cancel at period end' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Cancel autopay?' });
  await expect(dialog).toContainText('Nothing more will be charged.');
  await dialog.getByRole('button', { name: 'Cancel autopay' }).click();
  await expect(page.getByText('It will not renew after that.', { exact: false })).toBeVisible();
  expect(await subscriptionRow(restaurant.restaurantId)).toMatchObject({
    status: 'active',
    cancel_at_period_end: true,
  });

  // At the end of the period Razorpay cancels it; access runs to the period end.
  await sendWebhook(
    request,
    subscriptionEvent('cancelled', { id: subscriptionId, status: 'cancelled' }),
  );
  await page.reload();
  await expect(page.getByTestId('subscription-status')).toHaveText('Cancelled');
  // Plans can be chosen again, starting when the paid period ends.
  await expect(
    page.getByText(/The first payment is on .*, when your paid period ends\./),
  ).toBeVisible();
});

test('autopay set up during a trial can be cancelled straight away', async ({ page }) => {
  const restaurant = await createTestRestaurant({ prefix: 'e2e-payx' });
  await stubCheckout(page);
  await logInAsOwner(page, restaurant);
  await page.goto('/admin/subscription');
  await page
    .getByRole('list', { name: 'Plans' })
    .getByRole('listitem', { name: 'Growth' })
    .getByRole('button', { name: 'Subscribe to Growth' })
    .click();
  await expect(page.getByText('Autopay is on.')).toBeVisible();

  await page.getByRole('button', { name: 'Cancel autopay' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Cancel autopay?' });
  await expect(dialog).toContainText('Your free trial still runs until');
  await dialog.getByRole('button', { name: 'Cancel autopay' }).click();
  await expect(page.getByRole('button', { name: 'Subscribe to Growth' })).toBeVisible();
  expect(await subscriptionRow(restaurant.restaurantId)).toMatchObject({
    status: 'trialing',
    razorpay_status: 'cancelled',
  });
});

test('webhooks with a bad signature are refused and not stored', async ({ request }) => {
  const eventId = razorpayId('evt');
  const response = await sendWebhook(
    request,
    subscriptionEvent('charged', { id: razorpayId('sub'), status: 'active' }),
    { eventId, secret: 'not-the-secret' },
  );
  expect(response.status()).toBe(400);
  const { count } = await adminClient()
    .from('webhook_events')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', eventId);
  expect(count).toBe(0);
});

test('a platform admin creates a missing Razorpay plan from the plans page', async ({ page }) => {
  // Starter's yearly Razorpay plan is removed for the test and put back after.
  await adminClient().from('plans').update({ razorpay_plan_id_yearly: null }).eq('code', 'starter');
  const admin = await createPlatformAdmin('e2e-plans');
  await logInAsPlatformAdmin(page, admin);
  await page.goto('/super/plans');

  const starter = page.locator('form[data-plan="starter"]');
  await starter.getByRole('button', { name: 'Create yearly plan in Razorpay' }).click();
  await expect(page.getByText('Starter yearly plan created in Razorpay')).toBeVisible();
  await expect(starter.getByLabel('Razorpay plan id (yearly)')).toHaveValue(/^plan_E2E/);
  await expect(starter.getByRole('button', { name: 'Create yearly plan in Razorpay' })).toHaveCount(
    0,
  );
});
