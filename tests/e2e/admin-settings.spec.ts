import { expect, test, type Page } from '@playwright/test';

import { adminClient, createTestRestaurant, logInAsOwner } from './helpers';

// Spec §13.3 Settings: tabs save separately, formats are validated (GSTIN,
// pincode, UPI ID) and tax/bill changes are audit logged.

type Tab = 'Restaurant' | 'Tax & charges' | 'Bill' | 'Ordering';

// The previous panel stays mounted briefly after switching tabs, so scope
// the Save button to the panel in use.
const saveTab = (page: Page, tab: Tab) =>
  page
    .getByRole('tabpanel', { name: tab })
    .getByRole('button', { name: 'Save', exact: true })
    .click();

/** Saves and waits for the server to answer (toasts from earlier saves may still show). */
async function saveTabAndWait(page: Page, tab: Tab) {
  const response = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/admin/settings'),
  );
  await saveTab(page, tab);
  await response;
  await expect(page.getByText('Settings saved').last()).toBeVisible();
}

test('owner updates settings across tabs with validation', async ({ page }) => {
  const restaurant = await createTestRestaurant({ prefix: 'settings' });
  await logInAsOwner(page, restaurant);
  await page.goto('/admin/settings');
  // The header's sound button appears once the page has hydrated. Typing into
  // a filled field before that can land after its old value.
  await expect(page.getByRole('button', { name: 'Enable sound' })).toBeVisible();

  // Restaurant details.
  await page.getByLabel('Restaurant name').fill('Spice Route');
  await page.getByLabel('Pincode').fill('012345');
  await saveTab(page, 'Restaurant');
  await expect(page.getByText('Enter a 6-digit pincode.')).toBeVisible();
  await page.getByLabel('Pincode').fill('452001');
  await saveTabAndWait(page, 'Restaurant');
  await expect(page.getByRole('banner')).toContainText('Spice Route');

  // Tax: a malformed GSTIN is caught; a lowercase one is stored in capitals.
  await page.getByRole('tab', { name: 'Tax & charges' }).click();
  await page.getByRole('radio', { name: /Regular GST/ }).click();
  await page.getByLabel('GSTIN').fill('23AAACD1234E1Z');
  await saveTab(page, 'Tax & charges');
  await expect(page.getByText('A GSTIN has 15 characters, e.g. 23AAACD1234E1Z5.')).toBeVisible();
  await page.getByLabel('GSTIN').fill('23aaacd1234e1z5');
  await saveTabAndWait(page, 'Tax & charges');
  await page.reload();
  await page.getByRole('tab', { name: 'Tax & charges' }).click();
  await expect(page.getByLabel('GSTIN')).toHaveValue('23AAACD1234E1Z5');

  // Bill: the UPI QR needs a UPI ID; the preview appears once one is typed.
  await page.getByRole('tab', { name: 'Bill' }).click();
  await page.getByRole('switch', { name: /Print a UPI QR/ }).click();
  await saveTab(page, 'Bill');
  await expect(page.getByText('Enter your UPI ID to show a UPI QR on bills.')).toBeVisible();
  await page.getByLabel('UPI ID').fill('spiceroute@okicici');
  await expect(
    page.getByRole('img', { name: 'UPI QR preview for spiceroute@okicici' }),
  ).toBeVisible();
  await page.getByLabel('Invoice prefix').fill('SR');
  await saveTabAndWait(page, 'Bill');

  // Ordering: numbers are range-checked.
  await page.getByRole('tab', { name: 'Ordering' }).click();
  await page.getByLabel('Customer cancel window').fill('700');
  await saveTab(page, 'Ordering');
  await expect(page.getByText('Enter 0–600 seconds.')).toBeVisible();
  await page.getByLabel('Customer cancel window').fill('90');
  await saveTabAndWait(page, 'Ordering');

  const { data } = await adminClient()
    .from('restaurants')
    .select(
      'name, gst_mode, gstin, upi_vpa, show_upi_qr_on_bill, invoice_prefix, customer_cancel_window_seconds',
    )
    .eq('id', restaurant.restaurantId)
    .single();
  expect(data).toEqual({
    name: 'Spice Route',
    gst_mode: 'regular',
    gstin: '23AAACD1234E1Z5',
    upi_vpa: 'spiceroute@okicici',
    show_upi_qr_on_bill: true,
    invoice_prefix: 'SR',
    customer_cancel_window_seconds: 90,
  });

  const { count } = await adminClient()
    .from('audit_logs')
    .select('id', { count: 'exact', head: true })
    .eq('restaurant_id', restaurant.restaurantId)
    .eq('action', 'settings.updated');
  expect(count).toBe(4);
});

test('the UPI QR on bills is locked on the Starter plan', async ({ page }) => {
  const restaurant = await createTestRestaurant({ prefix: 'upi', plan: 'starter' });
  await logInAsOwner(page, restaurant);
  await page.goto('/admin/settings');
  await page.getByRole('tab', { name: 'Bill' }).click();
  await expect(page.getByRole('switch', { name: /Print a UPI QR/ })).toBeDisabled();
  await expect(page.getByText('Available on Growth')).toBeVisible();
});
