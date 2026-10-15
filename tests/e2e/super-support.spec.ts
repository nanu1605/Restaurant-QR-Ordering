import { expect, test } from '@playwright/test';

import { adminClient, createTestRestaurant, logInAsOwner, makePng } from './helpers';
import { createPlatformAdmin, logInAsPlatformAdmin } from './platform-fixtures';

// Get help, the support inbox and the onboarding checklist (docs/SUPER_ADMIN_PLAN.md
// 13b; docs/DECISIONS.md SA-41 to SA-45).

test('a request goes from the admin panel to the inbox to resolved, and the owner sees each status', async ({
  page,
  browser,
}) => {
  const restaurant = await createTestRestaurant({ prefix: 'e2e-help' });
  const admin = await createPlatformAdmin('e2e-help');
  const note = `Restarted the printer ${restaurant.slug}`;

  // The owner asks from the account menu, with a screenshot.
  await logInAsOwner(page, restaurant);
  await page.goto('/admin/billing');
  await page.getByRole('banner').getByRole('button', { name: 'Test Owner' }).click();
  await page.getByRole('menuitem', { name: 'Get help' }).click();
  await expect(page).toHaveURL(/\/admin\/help\?from=%2Fadmin%2Fbilling$/);
  await expect(page.getByRole('heading', { name: 'Get help', level: 1 })).toBeVisible();

  const form = page.getByRole('region', { name: 'New request' });
  await form.getByRole('button', { name: 'Send' }).click();
  await expect(form.getByText('Choose what it is about.')).toBeVisible();
  await expect(form.getByText('Say what you need help with.')).toBeVisible();

  await form.getByLabel('What is it about?').selectOption({ label: 'Printing' });
  await form.getByLabel('What do you need help with?').fill('The bill printer prints blank pages.');
  await form.getByLabel('Screenshot (optional)').setInputFiles({
    name: 'printer.png',
    mimeType: 'image/png',
    buffer: makePng(),
  });
  await expect(form.getByRole('img', { name: 'The screenshot to send' })).toBeVisible();
  await form.getByRole('radio', { name: 'WhatsApp' }).check();
  await form.getByLabel('Mobile number').fill('+91 98765 43210');
  await form.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Sent. The MenuMesh team will get back to you.')).toBeVisible();

  const requests = page.getByRole('region', { name: 'Your requests' });
  const mine = requests.getByRole('listitem').filter({ hasText: 'Printing' });
  await expect(mine).toContainText('Received');
  await expect(mine).toContainText('The bill printer prints blank pages.');
  await expect(mine).toContainText('Screenshot sent');

  // The team finds it in the inbox, with where it came from.
  const team = await browser.newContext();
  const adminPage = await team.newPage();
  await logInAsPlatformAdmin(adminPage, admin);
  await adminPage
    .getByRole('navigation', { name: 'Platform sections' })
    .getByRole('link', { name: 'Support inbox' })
    .click();
  await expect(adminPage.getByRole('heading', { name: 'Support inbox', level: 1 })).toBeVisible();
  // Its restaurant's requests: other runs' open ones could push it past the first page.
  await adminPage.goto(`/super/support?restaurant=${restaurant.restaurantId}`);
  await adminPage.getByRole('link', { name: `Printing from ${restaurant.name}` }).click();
  await expect(
    adminPage.getByRole('heading', { name: `Printing: ${restaurant.name}`, level: 1 }),
  ).toBeVisible();
  const from = adminPage.getByRole('region', { name: 'From' });
  await expect(from).toContainText('/admin/billing');
  await expect(from.getByRole('link', { name: '98765 43210' })).toHaveAttribute(
    'href',
    /^https:\/\/wa\.me\/919876543210/,
  );
  await expect(
    adminPage.getByRole('img', { name: /The screenshot sent with the request/ }),
  ).toBeVisible();

  // Working it: in progress, high priority, assigned, an internal note.
  await adminPage.getByRole('button', { name: 'Status: Open' }).click();
  await adminPage.getByRole('menuitemradio', { name: 'In progress' }).click();
  await expect(adminPage.getByRole('button', { name: 'Status: In progress' })).toBeVisible();
  await adminPage.getByRole('button', { name: 'Priority: Normal' }).click();
  await adminPage.getByRole('menuitemradio', { name: 'High' }).click();
  await expect(adminPage.getByRole('button', { name: 'Priority: High' })).toBeVisible();
  await adminPage.getByRole('button', { name: 'Assignee: No one' }).click();
  await adminPage.getByRole('menuitemradio', { name: admin.email }).click();
  await expect(adminPage.getByRole('button', { name: `Assignee: ${admin.email}` })).toBeVisible();
  const history = adminPage.getByRole('region', { name: 'Notes and history' });
  await history.getByLabel('Internal note').fill(note);
  await history.getByRole('button', { name: 'Add note' }).click();
  await expect(history).toContainText(note);
  await expect(history).toContainText('Status: Open to In progress');
  await expect(history).toContainText(`Assigned to ${admin.email}`);

  // The owner sees it being worked on, never the note.
  await page.reload();
  await expect(mine).toContainText('Being worked on');
  await expect(page.getByText(note)).toHaveCount(0);

  await adminPage.getByRole('button', { name: 'Status: In progress' }).click();
  await adminPage.getByRole('menuitemradio', { name: 'Resolved' }).click();
  await expect(adminPage.getByRole('button', { name: 'Status: Resolved' })).toBeVisible();
  await adminPage.goto(`/super/support?status=resolved&restaurant=${restaurant.restaurantId}`);
  await expect(
    adminPage.getByRole('link', { name: `Printing from ${restaurant.name}` }),
  ).toBeVisible();

  await page.reload();
  await expect(mine.getByText('Resolved', { exact: true })).toBeVisible();
  await expect(mine.getByRole('list', { name: 'Status changes' })).toContainText('Being worked on');
  await team.close();
});

test('a restaurant page shows its onboarding, and the list has an Onboarding view', async ({
  page,
}) => {
  const restaurant = await createTestRestaurant({ prefix: 'e2e-onb' });
  const admin = await createPlatformAdmin('e2e-onb');
  // QR codes printed: one step done besides any the onboarding made.
  await adminClient()
    .from('audit_logs')
    .insert({
      restaurant_id: restaurant.restaurantId,
      actor_type: 'staff',
      actor_label: 'Owner',
      action: 'table.qr_sheet_printed',
    })
    .throwOnError();

  await logInAsPlatformAdmin(page, admin);
  await page.goto(`/super/restaurants/${restaurant.restaurantId}`);
  const onboarding = page.getByRole('region', { name: 'Onboarding' });
  await expect(onboarding).toContainText(/\d of 7 done/);
  await expect(
    onboarding
      .getByRole('listitem')
      .filter({ hasText: 'QR codes downloaded, printed or delivered' }),
  ).toContainText('(done)');
  await expect(onboarding).toContainText('Next:');

  await page.goto('/super/restaurants');
  await page.getByRole('link', { name: 'Onboarding', exact: true }).click();
  await expect(page).toHaveURL(/onboarding=open/);
  await expect(page.getByRole('columnheader', { name: 'Onboarding' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Onboarding' })).toHaveValue('open');
});
