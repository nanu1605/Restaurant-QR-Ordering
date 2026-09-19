import { expect, test } from '@playwright/test';

import { adminClient, createTestRestaurant, logInWithCode } from './helpers';
import { createLiveRestaurant } from './live-fixtures';
import { createPlatformAdmin, logInAsPlatformAdmin } from './platform-fixtures';
import { billTable, ownerClient, seatTable } from './report-fixtures';

/**
 * Super-admin panel (spec §13.4, §18 "Super-admin: onboard restaurant, record
 * manual payment, suspend → customer ordering disabled", §19 Phase 7). Each
 * test signs in its own platform admin with a second factor.
 */

const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

test('onboards a restaurant, hands over the login, and the owner logs in', async ({
  page,
  browser,
  baseURL,
}) => {
  await logInAsPlatformAdmin(page, await createPlatformAdmin());
  const main = page.getByRole('main');
  await main.getByRole('link', { name: 'Onboard restaurant' }).click();
  await expect(page.getByRole('heading', { name: 'Onboard restaurant', level: 1 })).toBeVisible();

  // Each step checks its own fields before moving on.
  await main.getByRole('button', { name: 'Next' }).click();
  await expect(main.getByText('Enter the restaurant name.')).toBeVisible();

  const id = unique();
  const name = `Wizard Dhaba ${id}`;
  const slug = `wiz-${id}`;
  await main.getByLabel('Restaurant name').fill(name);
  await expect(main.getByLabel('Restaurant code')).toHaveValue(`wizard-dhaba-${id}`);
  await main.getByLabel('Restaurant code').fill(slug);
  await main.getByLabel('City (optional)').fill('Indore');
  await main.getByRole('button', { name: 'Next' }).click();

  await expect(main.getByRole('heading', { name: 'Owner login' })).toBeFocused();
  await main.getByLabel("Owner's name").fill('Meera Shah');
  await main.getByLabel('Username').fill('meera');
  await main.getByLabel('Temporary password').fill('Handover-Pass-1');
  await main.getByRole('button', { name: 'Next' }).click();

  await main.getByLabel('GST', { exact: true }).selectOption('regular');
  await main.getByLabel('GST rate').selectOption({ label: '5%' });
  await main.getByRole('button', { name: 'Next' }).click();

  await main.getByLabel('Plan to trial').selectOption({ label: 'Growth' });
  await main.getByLabel('Trial days').fill('30');
  await expect(main.getByLabel('Summary')).toContainText(`${name} (${slug})`);
  await main.getByRole('button', { name: 'Create restaurant' }).click();

  const handover = main.getByLabel('Owner login');
  await expect(handover).toContainText(slug);
  await expect(handover).toContainText('meera');
  await expect(handover).toContainText('Handover-Pass-1');

  // The owner logs in with the handed-over details.
  const ownerContext = await browser.newContext({ baseURL });
  const ownerPage = await ownerContext.newPage();
  await ownerPage.goto('/login');
  await logInWithCode(ownerPage, slug, 'meera', 'Handover-Pass-1');
  await expect(ownerPage).toHaveURL(/\/admin$/);
  await ownerContext.close();

  // The restaurant page shows the trial.
  await main.getByRole('link', { name: 'Open restaurant' }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
  await expect(main.getByText('Trial ends')).toBeVisible();

  // A second restaurant with the same code is sent back to the first step.
  await page.goto('/super/restaurants/new');
  await main.getByLabel('Restaurant name').fill(`Copy ${id}`);
  await main.getByLabel('Restaurant code').fill(slug);
  await main.getByRole('button', { name: 'Next' }).click();
  await main.getByLabel("Owner's name").fill('Someone Else');
  await main.getByRole('button', { name: 'Next' }).click();
  await main.getByRole('button', { name: 'Next' }).click();
  await main.getByRole('button', { name: 'Create restaurant' }).click();
  await expect(main.getByRole('heading', { name: 'Restaurant', exact: true })).toBeVisible();
  await expect(main.getByText('That restaurant code is taken. Choose another.')).toBeVisible();
});

test('extends a trial, changes the plan and records a manual payment', async ({ page }) => {
  const restaurant = await createTestRestaurant({ prefix: 'sup' });
  const db = adminClient();
  const trialBefore = async () =>
    (
      await db
        .from('restaurant_subscriptions')
        .select('trial_ends_at')
        .eq('restaurant_id', restaurant.restaurantId)
        .single()
        .throwOnError()
    ).data!.trial_ends_at!;
  const before = await trialBefore();

  await logInAsPlatformAdmin(page, await createPlatformAdmin());
  await page.goto('/super/restaurants');
  await page
    .getByRole('search', { name: 'Restaurants' })
    .getByLabel('Search')
    .fill(restaurant.slug);
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.getByRole('link', { name: restaurant.name }).click();
  await expect(page.getByRole('heading', { name: restaurant.name, level: 1 })).toBeVisible();
  const main = page.getByRole('main');
  const dialog = page.getByRole('dialog');

  await main.getByRole('button', { name: 'Extend trial' }).click();
  await dialog.getByLabel('Days to add').fill('10');
  await dialog.getByRole('button', { name: 'Extend trial' }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(async () => Date.parse(await trialBefore()) - Date.parse(before))
    .toBe(10 * 24 * 60 * 60 * 1000);

  await main.getByRole('button', { name: 'Change plan' }).click();
  await dialog.getByLabel('Plan').selectOption({ label: 'Starter' });
  await dialog.getByRole('button', { name: 'Change plan' }).click();
  await expect(dialog).toBeHidden();
  await expect(main.getByRole('region', { name: 'Subscription' })).toContainText('Starter');

  await main.getByRole('button', { name: 'Record payment' }).click();
  await dialog.getByLabel('Amount (₹)').fill('399');
  await dialog.getByLabel('Paid by').selectOption({ label: 'UPI' });
  await dialog.getByLabel('Notes').fill('UTR 998877');
  await dialog.getByRole('button', { name: 'Record payment' }).click();
  await expect(dialog).toBeHidden();
  await expect(main.getByRole('table', { name: 'Payments' })).toContainText('₹399.00');
  await expect(main.getByRole('table', { name: 'Payments' })).toContainText('UTR 998877');
  // Paid now: the trial is over and the subscription is active.
  await expect(main.getByRole('button', { name: 'Extend trial' })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 }).locator('..')).toContainText('Active');

  // The actions are in the audit log.
  await main.getByRole('link', { name: 'Audit log' }).click();
  await expect(page.locator('tr[data-action="subscription.payment_recorded"]')).toHaveCount(1);
  await expect(page.locator('tr[data-action="subscription.plan_changed"]')).toHaveCount(1);
  await expect(page.locator('tr[data-action="subscription.trial_extended"]')).toHaveCount(1);
});

test('suspending stops customer ordering but the open table can still be billed', async ({
  page,
  browser,
  baseURL,
}) => {
  const restaurant = await createLiveRestaurant({ maxTablesPerWaiter: 3 });
  const owner = await ownerClient(restaurant);
  const seated = await seatTable(owner, restaurant, { table: '3' });

  await logInAsPlatformAdmin(page, await createPlatformAdmin());
  await page.goto(`/super/restaurants/${restaurant.restaurantId}`);
  const main = page.getByRole('main');
  const dialog = page.getByRole('dialog');
  await main.getByRole('button', { name: 'Suspend' }).click();
  await dialog.getByLabel('Reason').fill('Setup fee not paid');
  await dialog.getByRole('button', { name: 'Suspend' }).click();
  await expect(main.getByText('Suspended: Setup fee not paid')).toBeVisible();

  // A customer at another table can read the menu but not order.
  const phone = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 } });
  const customer = await phone.newPage();
  await customer.goto(restaurant.tables['4']!.url);
  await expect(
    customer.getByText('Online ordering is unavailable right now. Please order with our staff.'),
  ).toBeVisible();

  // Table 3 was already eating: it can still be served and billed.
  await owner.rpc('staff_mark_order_served', { p_order_id: seated.orderId }).throwOnError();
  const { data: bill } = await owner
    .rpc('admin_generate_bill', {
      p_session_id: seated.sessionId,
      p_discount_type: 'none',
      p_discount_value: 0,
      p_discount_reason: '',
      p_apply_service_charge: false,
    })
    .throwOnError();
  expect((bill as { bill_id: string }).bill_id).toBeTruthy();

  await main.getByRole('button', { name: 'Unsuspend' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Unsuspend' }).click();
  await expect(main.getByRole('button', { name: 'Suspend' })).toBeVisible();
  await customer.reload();
  await expect(customer.getByText('Online ordering is unavailable right now.')).toHaveCount(0);
  await phone.close();
});

test('the support view is read-only and every look is logged', async ({ page }) => {
  const restaurant = await createLiveRestaurant({ maxTablesPerWaiter: 3 });
  const owner = await ownerClient(restaurant);
  await seatTable(owner, restaurant, { table: '3' });
  const billed = await billTable(owner, restaurant, { table: '4' });

  await logInAsPlatformAdmin(page, await createPlatformAdmin());
  await page.goto(`/super/restaurants/${restaurant.restaurantId}`);
  const main = page.getByRole('main');
  await main
    .getByRole('navigation', { name: 'Support view' })
    .getByRole('link', { name: 'Menu' })
    .click();
  await expect(page).toHaveURL(/\/support\/menu$/);
  await expect(main.getByRole('region', { name: 'Starters' })).toContainText('Paneer Tikka');
  // Nothing to press: only links between the sections.
  await expect(main.getByRole('button')).toHaveCount(0);

  const sections = main.getByRole('navigation', { name: 'Support sections' });
  await sections.getByRole('link', { name: 'Tables' }).click();
  await expect(main.getByRole('row', { name: /^3 Occupied/ })).toBeVisible();
  await expect(main.getByRole('button')).toHaveCount(0);

  await sections.getByRole('link', { name: 'Live board' }).click();
  await expect(main.locator('[data-table="3"][data-state="in_progress"]')).toBeVisible();
  await expect(main.locator('a[data-table]')).toHaveCount(0);
  await expect(main.getByRole('button')).toHaveCount(0);

  await sections.getByRole('link', { name: 'Total orders' }).click();
  await expect(main.getByText(billed.invoiceNumber)).toBeVisible();
  await expect(main.getByRole('link', { name: billed.invoiceNumber })).toHaveCount(0);

  await page.goto(`/super/audit?restaurant=${restaurant.restaurantId}&action=support.viewed`);
  await expect(page.locator('tr[data-action="support.viewed"]')).toHaveCount(4);
});

test('a plan edit is saved and audited', async ({ page }) => {
  await logInAsPlatformAdmin(page, await createPlatformAdmin());
  await page.goto('/super/plans');
  const pro = page.locator('form[data-plan="pro"]');
  const field = pro.getByLabel('Razorpay plan id (monthly)');
  const original = await field.inputValue();
  const value = `plan_E2E${unique()}`;

  try {
    await field.fill(value);
    await pro.getByRole('button', { name: 'Save Pro' }).click();
    await expect(pro.getByRole('button', { name: 'Save Pro' })).toBeDisabled();
    await page.reload();
    await expect(pro.getByLabel('Razorpay plan id (monthly)')).toHaveValue(value);

    await page.goto('/super/audit?action=plan.updated');
    await expect(page.locator('tr[data-action="plan.updated"]').first()).toContainText(value);
  } finally {
    await page.goto('/super/plans');
    await pro.getByLabel('Razorpay plan id (monthly)').fill(original);
    await pro.getByRole('button', { name: 'Save Pro' }).click();
    await expect(pro.getByRole('button', { name: 'Save Pro' })).toBeDisabled();
  }
});
