import { expect, test } from '@playwright/test';

import {
  adminClient,
  createTestRestaurant,
  fakeTurnstile,
  logInAsOwner,
  watchCspViolations,
} from './helpers';
import { createPlatformAdmin, logInAsPlatformAdmin } from './platform-fixtures';
import { withGst } from '../../src/features/subscriptions/gst';
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
const MOCK_RAZORPAY = 'http://127.0.0.1:3190/razorpay/v1';
const MOCK_RAZORPAY_AUTH = `Basic ${Buffer.from('rzp_test_e2e:e2e-razorpay-secret').toString('base64')}`;
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
  // Checkout's script is added by the page, so the nonce policy must let it run.
  const violations = await watchCspViolations(page.context());
  await logInAsOwner(page, restaurant);
  await page.goto('/admin/subscription');

  // Growth has a monthly Razorpay plan only.
  const plans = page.getByRole('list', { name: 'Plans' });
  const growth = plans.getByRole('listitem', { name: 'Growth' });
  await expect(
    page.getByText(/The first payment is on .*, when your free trial ends\./),
  ).toBeVisible();
  // Prices are before GST; each payment adds 18%.
  await expect(growth).toContainText('₹899.00 a month + GST');
  await expect(growth).toContainText('You pay ₹1,060.82 a month with 18% GST');
  await page.getByRole('button', { name: 'Yearly' }).click();
  await expect(growth.getByRole('button', { name: 'Not available yearly' })).toBeDisabled();
  await page.getByRole('button', { name: 'Monthly' }).click();
  await growth.getByRole('button', { name: 'Subscribe to Growth' }).click();

  await expect(page.getByText('Autopay is set up', { exact: true })).toBeVisible();
  await expect(
    page.getByText(/Autopay is set up for Growth, monthly; the first payment is on/),
  ).toBeVisible();
  await expect(page.getByTestId('subscription-status')).toHaveText('Free trial');
  expect(violations).toEqual([]);
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

  // Cancel at the end of the paid period. An earlier try reached Razorpay but
  // its reply was lost, so Razorpay refuses a second cancel: the app still
  // saves what Razorpay has.
  await request.post(`${MOCK_RAZORPAY}/subscriptions/${subscriptionId}/cancel`, {
    headers: { Authorization: MOCK_RAZORPAY_AUTH },
    data: { cancel_at_cycle_end: true },
  });
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

test('a visitor signs up from the pricing page and sets up autopay for the plan they chose', async ({
  page,
  request,
}) => {
  await fakeTurnstile(page.context());
  await stubCheckout(page);
  const violations = await watchCspViolations(page.context());
  const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const email = `signup-${unique}@e2e.test`;
  const inbox = async () => {
    const response = await request.get(`http://127.0.0.1:3190/resend/inbox?to=${email}`);
    return ((await response.json()) as { emails: { subject: string; text: string }[] }).emails;
  };

  await page.goto('/pricing');
  await page.getByRole('link', { name: 'Start free trial, then the Growth plan' }).click();
  await expect(page).toHaveURL(/\/signup\?plan=growth&cycle=monthly$/);
  await expect(
    page.getByText(/After the trial: the Growth plan at ₹899 a month \+ GST/),
  ).toBeVisible();

  const form = page.getByRole('form', { name: 'Start your free trial' });
  await form.getByLabel('Restaurant name').fill(`Signup Café ${unique}`);
  await form.getByLabel('City').fill('Pune');
  await form.getByLabel('Menu style').selectOption('cafe');
  await form.getByLabel('Your name').fill('Asha Rao');
  await form.getByLabel('Email').fill(email);
  await form.getByLabel('Mobile number').fill('98765 43210');
  // Without the terms ticked, nothing is sent.
  await form.getByRole('button', { name: 'Email me a code' }).click();
  await expect(form.getByText('Agree to the terms to continue.')).toBeVisible();
  await expect(form.getByLabel('Email')).toHaveValue(email);
  await form.getByRole('checkbox', { name: /I agree to the terms/ }).check();
  await form.getByRole('button', { name: 'Email me a code' }).click();

  await expect(page).toHaveURL(/\/signup\/verify$/);
  await expect(page.getByText(`We sent a 6-digit code to ${email}`)).toBeVisible();
  const [sent] = await inbox();
  const code = /^(\d{6}) is your MenuMesh code$/.exec(sent!.subject)![1]!;

  const verify = page.getByRole('form', { name: 'Create your restaurant' });
  await verify.getByLabel('6-digit code').fill(code === '000000' ? '111111' : '000000');
  await verify.getByLabel('Choose a password').fill('signup-pass-123');
  await verify.getByRole('button', { name: 'Create my restaurant' }).click();
  await expect(verify.getByText('That code isn’t right. 4 tries left.')).toBeVisible();
  await expect(verify.getByLabel('Choose a password')).toHaveValue('signup-pass-123');

  // A new code replaces the old one; the old error goes, the password stays.
  await page.getByRole('button', { name: 'Send a new code' }).click();
  await expect(page.getByText('We sent a new code. Use it instead of the old one.')).toBeVisible();
  await expect(verify.getByText('That code isn’t right. 4 tries left.')).toHaveCount(0);
  await expect(verify.getByLabel('Choose a password')).toHaveValue('signup-pass-123');
  const codeEmails = async () =>
    (await inbox()).filter((item) => item.subject.endsWith('is your MenuMesh code'));
  await expect.poll(async () => (await codeEmails()).length).toBe(2);
  const newCode = /^(\d{6})/.exec((await codeEmails())[1]!.subject)![1]!;
  if (newCode !== code) {
    await verify.getByLabel('6-digit code').fill(code);
    await verify.getByRole('button', { name: 'Create my restaurant' }).click();
    await expect(verify.getByText('That code isn’t right. 4 tries left.')).toBeVisible();
  }
  await verify.getByLabel('6-digit code').fill(newCode);
  await verify.getByRole('button', { name: 'Create my restaurant' }).click();

  // Signed in as the owner, on autopay with Growth monthly picked.
  await expect(page).toHaveURL(/\/admin\/subscription\?welcome=1&cycle=monthly&plan=growth$/);
  await expect(page.getByRole('heading', { name: 'Your restaurant is ready' })).toBeVisible();
  const growth = page
    .getByRole('list', { name: 'Plans' })
    .getByRole('listitem', { name: 'Growth' });
  await expect(growth.getByText('Your choice')).toBeVisible();
  await expect(page.getByTestId('subscription-status')).toHaveText('Free trial');
  await growth.getByRole('button', { name: 'Subscribe to Growth' }).click();
  await expect(page.getByText('Autopay is set up', { exact: true })).toBeVisible();

  // The welcome email names the restaurant code staff log in with.
  const { data: restaurant } = await adminClient()
    .from('restaurants')
    .select('slug, city, phone, email')
    .eq('name', `Signup Café ${unique}`)
    .single();
  expect(restaurant).toMatchObject({ city: 'Pune', phone: '+91 9876543210', email });
  expect(restaurant!.slug).toBe(`signup-cafe-${unique}`);
  await expect.poll(async () => (await inbox()).length).toBe(3);
  const welcome = (await inbox()).find((item) => item.subject.startsWith('Welcome to MenuMesh'));
  expect(welcome?.text).toContain(`Your restaurant code is ${restaurant!.slug}.`);

  // The dashboard lists what's left to set up; autopay is done.
  await page.getByRole('link', { name: 'Go to the dashboard' }).click();
  const steps = page.getByRole('region', { name: 'Set up your restaurant' });
  await expect(steps.getByText('1 of 5 done')).toBeVisible();
  await expect(steps.getByRole('link', { name: /Set up autopay \(done\)/ })).toBeVisible();
  await expect(steps.getByRole('link', { name: /Add your menu \(to do\)/ })).toBeVisible();
  expect(violations).toEqual([]);

  // The same email can't sign up twice.
  await page.context().clearCookies();
  await page.goto('/signup');
  await form.getByLabel('Restaurant name').fill('Second Café');
  await form.getByLabel('City').fill('Pune');
  await form.getByLabel('Your name').fill('Asha Rao');
  await form.getByLabel('Email').fill(email);
  await form.getByLabel('Mobile number').fill('9876543210');
  await form.getByRole('checkbox', { name: /I agree to the terms/ }).check();
  await form.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page).toHaveURL(/\/signup\/verify$/);
  await expect.poll(async () => (await codeEmails()).length).toBe(3);
  const thirdCode = /^(\d{6})/.exec((await codeEmails())[2]!.subject)![1]!;
  await verify.getByLabel('6-digit code').fill(thirdCode);
  await verify.getByLabel('Choose a password').fill('signup-pass-123');
  await verify.getByRole('button', { name: 'Create my restaurant' }).click();
  // Only the way forward is left.
  const taken = page.getByRole('alert').filter({ hasText: 'already has a MenuMesh account' });
  await expect(taken).toContainText('This email already has a MenuMesh account. Log in instead.');
  await expect(taken.getByRole('link', { name: 'Go to log in' })).toBeVisible();
  await expect(verify).toHaveCount(0);
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
  // The Razorpay plan charges the yearly price plus 18% GST.
  const planId = await starter.getByLabel('Razorpay plan id (yearly)').inputValue();
  const { data: price } = await adminClient()
    .from('plans')
    .select('price_yearly_paise')
    .eq('code', 'starter')
    .single();
  const created = await page.request.get(`${MOCK_RAZORPAY}/plans/${planId}`, {
    headers: { Authorization: MOCK_RAZORPAY_AUTH },
  });
  expect(((await created.json()) as { item: { amount: number } }).item.amount).toBe(
    withGst(price!.price_yearly_paise),
  );
  await expect(starter.getByRole('button', { name: 'Create yearly plan in Razorpay' })).toHaveCount(
    0,
  );
});
