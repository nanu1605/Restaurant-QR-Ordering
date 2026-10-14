import { expect, test } from '@playwright/test';

import { adminClient, createTestRestaurant } from './helpers';
import { createPlatformAdmin, logInAsPlatformAdmin, restaurantAction } from './platform-fixtures';

/**
 * Platform settings (docs/SUPER_ADMIN_PLAN.md 12a, docs/DECISIONS.md SA-4 to
 * SA-6). This changes the one settings row that the pricing and payment-link
 * specs read, so it runs as its own project after every other one.
 */

const DAY = 24 * 60 * 60 * 1000;
const SETTINGS =
  'trial_days, grace_days, setup_fee_paise, setup_fee_discount_paise, setup_fee_discount_ends_at, support_phone, support_email';

test('ending the launch offer changes the pricing page and the next setup fee link', async ({
  page,
}) => {
  const { data: original } = await adminClient()
    .from('platform_settings')
    .select(SETTINGS)
    .eq('id', 1)
    .single()
    .throwOnError();
  const restaurant = await createTestRestaurant({ prefix: 'e2e-settings' });
  const admin = await createPlatformAdmin('e2e-settings');

  try {
    await logInAsPlatformAdmin(page, admin);
    await page
      .getByRole('navigation', { name: 'Platform sections' })
      .getByRole('link', { name: 'Platform settings' })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'Platform settings' })).toBeVisible();

    // The discount stays below the fee.
    const discount = page.getByLabel('Launch discount (₹)');
    await discount.fill('999');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Keep the discount below the fee.')).toBeVisible();

    // The offer's last day was yesterday in India: it has ended.
    const yesterday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
      new Date(Date.now() - DAY),
    );
    await discount.fill('500');
    await page.getByLabel('Last day of the offer').fill(yesterday);
    await page.getByLabel('Support phone').fill('+91 90000 12345');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Settings saved')).toBeVisible();
    await expect(page.getByText('The launch offer’s last day was')).toBeVisible();

    const { data: audit } = await adminClient()
      .from('audit_logs')
      .select('after')
      .eq('action', 'platform_settings.updated')
      .eq('actor_user_id', admin.userId)
      .throwOnError();
    expect(audit).toHaveLength(1);
    expect(audit![0]!.after).toMatchObject({ support_phone: '+91 90000 12345' });
    expect(audit![0]!.after).toHaveProperty('setup_fee_discount_ends_at');

    await page.goto('/pricing');
    const setupFee = page.getByText('Or we set up your menu');
    await expect(setupFee).toContainText('one-time ₹999');
    await expect(setupFee).not.toContainText('launch offer');

    // ₹999 with no discount, plus GST.
    await page.goto(`/super/restaurants/${restaurant.restaurantId}`);
    await restaurantAction(page, 'Send payment link');
    const dialog = page.getByRole('dialog', { name: 'Send payment link' });
    await dialog.getByLabel('For').selectOption('setup_fee');
    await expect(dialog.getByLabel('Amount (₹)')).toHaveValue('1178.82');
    await expect(dialog.getByLabel('Description')).toHaveValue('MenuMesh setup fee, with GST');
  } finally {
    await adminClient().from('platform_settings').update(original!).eq('id', 1).throwOnError();
  }
});
