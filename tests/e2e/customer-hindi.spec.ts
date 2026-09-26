import { expect, test } from '@playwright/test';

import { createOrderingTable, tableState } from './customer-fixtures';
import { adminClient } from './helpers';

// Hindi customer screens (spec §19 Phase 9, docs/DECISIONS.md P9-7): English
// first, a हिन्दी switch in the header that the phone remembers, and every
// customer screen and message in Hindi, from the menu to the orders.

test('a customer switches to Hindi, orders in Hindi and switches back', async ({ page }) => {
  const table = await createOrderingTable({ approval: false });
  await page.goto(table.url);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  await page.getByRole('button', { name: 'हिन्दी' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'hi');
  await expect(page.getByText('टेबल 5', { exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'मेन्यू की श्रेणियाँ' })).toBeVisible();
  // Dish names stay as the restaurant entered them.
  await page.getByRole('button', { name: 'Paneer Tikka जोड़ें' }).click();
  await page.getByRole('button', { name: 'Chicken 65 जोड़ें' }).click();
  await expect(page.getByRole('link', { name: /2 आइटम · ₹/ })).toBeVisible();

  // Remembered on this phone.
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'hi');
  await expect(page).toHaveTitle(/टेबल 5/);
  await page.getByRole('link', { name: /कार्ट देखें/ }).click();
  await expect(page.getByRole('heading', { name: 'आपका ऑर्डर' })).toBeVisible();
  await expect(page).toHaveTitle(/^आपका ऑर्डर · /);
  await expect(
    page.getByText('आप 2 मिनट के अंदर कोई आइटम रद्द कर सकते हैं', { exact: false }),
  ).toBeVisible();

  // A dish that ran out is named in Hindi.
  await adminClient()
    .from('menu_items')
    .update({ is_available: false })
    .eq('id', table.item.chicken65)
    .throwOnError();
  await page.getByRole('button', { name: 'ऑर्डर करें' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText(
    'Chicken 65 अब उपलब्ध नहीं है, इसलिए हमने इसे आपके कार्ट से हटा दिया है। अपना ऑर्डर जाँचें और फिर से करें।',
  );

  // The server's refusals come back in Hindi too.
  await adminClient()
    .from('restaurants')
    .update({ status: 'suspended', suspended_reason: 'E2E suspension' })
    .eq('id', table.restaurantId)
    .throwOnError();
  await page.getByRole('button', { name: 'ऑर्डर करें' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText(
    'अभी ऑनलाइन ऑर्डर बंद है। कृपया हमारे स्टाफ़ से ऑर्डर करें।',
  );
  await adminClient()
    .from('restaurants')
    .update({ status: 'active', suspended_reason: null })
    .eq('id', table.restaurantId)
    .throwOnError();

  await page.getByRole('button', { name: 'ऑर्डर करें' }).click();
  await expect(page).toHaveURL(/\/orders$/);
  await expect(page.getByRole('heading', { name: 'आपकी टेबल के ऑर्डर' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^राउंड 1 · / })).toBeVisible();
  await expect(page.getByText('ऑर्डर हुआ', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'बिल मँगाएँ' }).click();
  await expect(page.getByText('स्टाफ़ आपका बिल ले आएगा।')).toBeVisible();
  expect((await tableState(table.restaurantId)).orders).toHaveLength(1);

  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('heading', { name: 'Your table’s orders' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Bill requested' })).toBeVisible();
});

test('a QR code that does not work says so in Hindi once Hindi is chosen', async ({ page }) => {
  const table = await createOrderingTable();
  await page.goto(table.url);
  await page.getByRole('button', { name: 'हिन्दी' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'hi');

  const response = await page.goto('/t/ZZZZZZZZZZZZZZZZ');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'यह QR कोड काम नहीं कर रहा है' })).toBeVisible();
});

test('the staff panel stays in English on a phone that chose Hindi', async ({ page }) => {
  const table = await createOrderingTable();
  await page.goto(table.url);
  await page.getByRole('button', { name: 'हिन्दी' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'hi');

  await page.goto('/login');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});
