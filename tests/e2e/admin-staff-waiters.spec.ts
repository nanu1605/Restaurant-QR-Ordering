import { expect, test, type Browser, type Page } from '@playwright/test';

import { createTestRestaurant, logInAsOwner, logInWithCode, TEST_PASSWORD } from './helpers';

// Spec §19 Phase 2 acceptance: add a waiter and a kitchen login who can log
// in; add three waiter profiles (one linked to a login), switch one off duty
// and delete one.

async function addStaff(page: Page, name: string, username: string, role: string) {
  await page.getByRole('button', { name: 'Add staff' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add staff' });
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByLabel('Username', { exact: true }).fill(username);
  await dialog.getByLabel('Role', { exact: true }).click();
  await page.getByRole('option', { name: role, exact: true }).click();
  await dialog.getByLabel('Password', { exact: true }).fill(TEST_PASSWORD);
  await dialog.getByRole('button', { name: 'Add staff' }).click();
  await expect(dialog).toBeHidden();
}

/** Logs in with restaurant code + username in a separate browser session. */
async function tryLogin(browser: Browser, slug: string, username: string, password: string) {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const page = await context.newPage();
  await page.goto('/login');
  await logInWithCode(page, slug, username, password);
  return { page, close: () => context.close() };
}

test('staff logins can log in; waiter profiles can be linked, taken off duty and deleted', async ({
  page,
  browser,
}) => {
  const restaurant = await createTestRestaurant({ prefix: 'staff' });
  await logInAsOwner(page, restaurant);

  // ─── Staff logins ─────────────────────────────────────────────────────────
  await page.goto('/admin/staff');
  await addStaff(page, 'Ravi Kumar', 'ravi', 'Waiter');
  await addStaff(page, 'Kavita Rao', 'Kavita', 'Kitchen');
  await expect(page.getByRole('row', { name: /Ravi Kumar/ })).toContainText('Waiter');
  await expect(page.getByRole('row', { name: /Kavita Rao/ })).toContainText('kavita');
  await expect(page.getByText('2 of 15 staff logins')).toBeVisible(); // Growth trial

  // The same username twice is refused.
  await page.getByRole('button', { name: 'Add staff' }).click();
  let dialog = page.getByRole('dialog', { name: 'Add staff' });
  await dialog.getByLabel('Name', { exact: true }).fill('Another Ravi');
  await dialog.getByLabel('Username', { exact: true }).fill('ravi');
  await dialog.getByLabel('Password', { exact: true }).fill(TEST_PASSWORD);
  await dialog.getByRole('button', { name: 'Add staff' }).click();
  await expect(dialog.getByText('The username “ravi” is already taken.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // Both new logins work.
  const waiter = await tryLogin(browser, restaurant.slug, 'ravi', TEST_PASSWORD);
  await expect(waiter.page).toHaveURL(/\/staff$/);
  await waiter.close();
  const kitchen = await tryLogin(browser, restaurant.slug, 'kavita', TEST_PASSWORD);
  await expect(kitchen.page).toHaveURL(/\/staff$/);
  await kitchen.close();

  // Reset a password: the new one works.
  await page.getByRole('button', { name: 'Actions for Kavita Rao' }).click();
  await page.getByRole('menuitem', { name: 'Reset password' }).click();
  dialog = page.getByRole('dialog', { name: 'Reset password for Kavita Rao' });
  await dialog.getByLabel('New password').fill('kitchen-Pass-2');
  await dialog.getByRole('button', { name: 'Set password' }).click();
  await expect(dialog).toBeHidden();
  const renewed = await tryLogin(browser, restaurant.slug, 'kavita', 'kitchen-Pass-2');
  await expect(renewed.page).toHaveURL(/\/staff$/);
  await renewed.close();

  // Deactivate: the login is refused (with the same message as a wrong password).
  await page.getByRole('button', { name: 'Actions for Kavita Rao' }).click();
  await page.getByRole('menuitem', { name: 'Deactivate' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Deactivate' }).click();
  await expect(page.getByRole('row', { name: /Kavita Rao/ })).toContainText('Deactivated');
  const refused = await tryLogin(browser, restaurant.slug, 'kavita', 'kitchen-Pass-2');
  await expect(
    refused.page
      .getByRole('alert')
      .filter({ hasText: 'Wrong restaurant code, username or password' }),
  ).toBeVisible();
  await refused.close();

  // ─── Waiter profiles ──────────────────────────────────────────────────────
  await page.goto('/admin/waiters');
  await expect(page.getByText('No waiters yet')).toBeVisible();

  // 1. Ravi, linked to his login.
  await page.getByRole('button', { name: 'Add waiter' }).click();
  dialog = page.getByRole('dialog', { name: 'Add waiter' });
  await dialog.getByLabel('Full name').fill('Ravi Kumar');
  await dialog.getByLabel('Phone (optional)').fill('+91 98765 43210');
  await dialog.getByRole('radio', { name: 'Link an existing waiter login' }).click();
  await dialog.getByRole('combobox', { name: 'Waiter login' }).click();
  await page.getByRole('option', { name: 'ravi (Ravi Kumar)' }).click();
  await dialog.getByRole('button', { name: 'Add waiter' }).click();
  await expect(dialog).toBeHidden();

  // 2. Suresh, no login.
  await page.getByRole('button', { name: 'Add waiter' }).click();
  dialog = page.getByRole('dialog', { name: 'Add waiter' });
  await dialog.getByLabel('Full name').fill('Suresh Patel');
  await dialog.getByLabel('Employee code (optional)').fill('E2');
  await dialog.getByRole('button', { name: 'Add waiter' }).click();
  await expect(dialog).toBeHidden();

  // 3. Anita, no login; a bad phone number is caught first.
  await page.getByRole('button', { name: 'Add waiter' }).click();
  dialog = page.getByRole('dialog', { name: 'Add waiter' });
  await dialog.getByLabel('Full name').fill('Anita Das');
  await dialog.getByLabel('Phone (optional)').fill('12345');
  await dialog.getByRole('button', { name: 'Add waiter' }).click();
  await expect(dialog.getByText('Enter a 10-digit mobile number.')).toBeVisible();
  await dialog.getByLabel('Phone (optional)').fill('');
  await dialog.getByRole('button', { name: 'Add waiter' }).click();
  await expect(dialog).toBeHidden();

  const rows = page.getByRole('region', { name: 'Waiters' }).getByRole('row');
  await expect(rows).toHaveCount(4); // header + 3
  const ravi = page.getByRole('row', { name: /Ravi Kumar/ });
  await expect(ravi).toContainText('9876543210');
  await expect(ravi).toContainText('ravi');
  await expect(ravi).toContainText('Available');

  // Suresh goes off duty.
  await page.getByRole('switch', { name: 'Suresh Patel on duty' }).click();
  await expect(page.getByRole('row', { name: /Suresh Patel/ })).toContainText('Off duty');

  // Anita is deleted.
  await page.getByRole('button', { name: 'Actions for Anita Das' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete waiter' }).click();
  await expect(page.getByRole('row', { name: /Anita Das/ })).toHaveCount(0);
  await expect(rows).toHaveCount(3);

  // The staff list shows the link.
  await page.goto('/admin/staff');
  await expect(page.getByRole('row', { name: /Ravi Kumar/ })).toContainText(
    'Waiter profile: Ravi Kumar',
  );
});
