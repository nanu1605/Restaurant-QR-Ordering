import { expect, test, type Page } from '@playwright/test';

import { adminClient, createTestRestaurant, logInAsOwner } from './helpers';
import { createPlatformAdmin, logInAsPlatformAdmin, restaurantAction } from './platform-fixtures';

/**
 * Support sessions (docs/SUPER_ADMIN_PLAN.md 13c; docs/DECISIONS.md SA-46 to
 * SA-52): the owner lets MenuMesh support in, a team member works in /admin as
 * a manager, what stays the owner's is refused, and the owner sees the changes.
 */

const saveTab = async (page: Page, tab: 'Restaurant' | 'Bill') => {
  const response = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/admin/settings'),
  );
  await page
    .getByRole('tabpanel', { name: tab })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await response;
};

test('the owner lets support in and sees every change it made', async ({ page, browser }) => {
  const restaurant = await createTestRestaurant({ prefix: 'e2e-session' });
  await logInAsOwner(page, restaurant);
  await page.goto('/admin/settings');
  await expect(page.getByRole('button', { name: 'Enable sound' })).toBeVisible();
  const card = page.getByRole('region', { name: 'MenuMesh support access' });
  await card.getByRole('radio', { name: '4 hours', exact: true }).click();
  await card.getByRole('button', { name: 'Allow access' }).click();
  await expect(card.getByRole('status')).toContainText('No one has signed in yet.');

  const context = await browser.newContext();
  const team = await context.newPage();
  try {
    await logInAsPlatformAdmin(team, await createPlatformAdmin('session'));
    await team.goto(`/super/restaurants/${restaurant.restaurantId}`);
    await expect(team.getByRole('main')).toContainText(/Support access\s*Allowed, until/);
    await restaurantAction(team, 'Start support session');
    const dialog = team.getByRole('dialog');
    await dialog.getByLabel('Your name').fill('Priya');
    await dialog.getByRole('button', { name: 'Start session' }).click();
    await expect(team).toHaveURL(/\/admin$/);
    await expect(team.getByRole('status').filter({ hasText: 'Support session in' })).toContainText(
      `Support session in ${restaurant.name}. Ends at`,
    );

    // Restaurant details are allowed; the invoice numbering is the owner's.
    await team.goto('/admin/settings');
    await expect(team.getByRole('button', { name: 'Enable sound' })).toBeVisible();
    await expect(team.getByRole('region', { name: 'MenuMesh support access' })).toHaveCount(0);
    await team.getByLabel('Restaurant name').fill(`${restaurant.name} Cafe`);
    await saveTab(team, 'Restaurant');
    await expect(team.getByText('Settings saved').last()).toBeVisible();
    await team.getByRole('tab', { name: 'Bill' }).click();
    await team.getByLabel('Invoice prefix').fill('SUP');
    await saveTab(team, 'Bill');
    await expect(
      team.getByText("MenuMesh support can't do this. Ask the restaurant owner.").first(),
    ).toBeVisible();

    // The subscription and live service are the restaurant's own.
    await team.goto('/admin/subscription');
    await expect(team).toHaveURL(/\/admin$/);
    await team.goto('/staff');
    await expect(team).toHaveURL(/\/admin$/);
    await team.goto('/admin/help');
    await expect(team).toHaveURL(/\/admin$/);

    await team.getByRole('button', { name: 'End session' }).click();
    await expect(team).toHaveURL(new RegExp(`/super/restaurants/${restaurant.restaurantId}$`));
    await expect(team.getByRole('main')).toContainText(/Support access\s*Not allowed/);
  } finally {
    await context.close();
  }

  await page.reload();
  await expect(card.getByRole('button', { name: 'Allow access' })).toBeVisible();
  const changes = card.getByRole('list', { name: 'Changes made by MenuMesh support' });
  await expect(changes).toContainText('Priya');
  await expect(changes).toContainText('Changed the restaurant settings');
});

test('without consent the team stays out, and a session ends on time', async ({ page }) => {
  const restaurant = await createTestRestaurant({ prefix: 'e2e-nosession' });
  await logInAsPlatformAdmin(page, await createPlatformAdmin('nosession'));
  await page.goto(`/super/restaurants/${restaurant.restaurantId}`);
  await expect(page.getByRole('main')).toContainText(/Support access\s*Not allowed/);
  await page.getByRole('main').getByRole('button', { name: 'Actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Start support session' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/super$/);

  // The owner allows it (as Settings does), and the team member starts.
  const db = adminClient();
  const { data: window } = await db
    .from('support_sessions')
    .insert({
      restaurant_id: restaurant.restaurantId,
      consent: 'owner',
      granted_by: restaurant.ownerUserId,
      ends_at: new Date(Date.now() + 3600_000).toISOString(),
    })
    .select('id')
    .single()
    .throwOnError();
  await page.goto(`/super/restaurants/${restaurant.restaurantId}`);
  await restaurantAction(page, 'Start support session');
  await page.getByRole('dialog').getByLabel('Your name').fill('Asha');
  await page.getByRole('dialog').getByRole('button', { name: 'Start session' }).click();
  await expect(page).toHaveURL(/\/admin$/);

  // Its time runs out: the next page is back in /super.
  await db
    .from('support_sessions')
    .update({
      created_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
      ends_at: new Date(Date.now() - 60_000).toISOString(),
    })
    .eq('id', window.id)
    .throwOnError();
  await page.goto('/admin/menu');
  await expect(page).toHaveURL(/\/super$/);
});

test('in person, onboarding starts a 24-hour setup session', async ({ page }) => {
  await logInAsPlatformAdmin(page, await createPlatformAdmin('setup'));
  await page.goto('/super/restaurants/new');
  const main = page.getByRole('main');
  // A first Next checks the empty step, so the form has hydrated before typing.
  await main.getByRole('button', { name: 'Next' }).click();
  await expect(main.getByText('Enter the restaurant name.')).toBeVisible();
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  await main.getByLabel('Restaurant name').fill(`Setup Dhaba ${id}`);
  await main.getByLabel('How did they find MenuMesh?').selectOption({ label: 'Field visit' });
  await main.getByRole('button', { name: 'Next' }).click();
  await main.getByLabel("Owner's name").fill('Meera Shah');
  await main.getByRole('button', { name: 'Next' }).click();
  await main.getByRole('button', { name: 'Next' }).click();

  await main
    .getByRole('checkbox', { name: /The owner agrees that MenuMesh may set up the restaurant/ })
    .check();
  await main.getByRole('button', { name: 'Create restaurant' }).click();
  await expect(main.getByText('Enter your name, as the restaurant will see it.')).toBeVisible();
  await main.getByLabel('Your name').fill('Asha');
  await main.getByRole('button', { name: 'Create restaurant' }).click();

  await main.getByRole('link', { name: 'Set up in admin panel' }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('status').filter({ hasText: 'Support session in' })).toContainText(
    `Support session in Setup Dhaba ${id}. Ends at`,
  );
  // 24 hours from now.
  await expect(page.getByRole('status').filter({ hasText: 'Support session in' })).toContainText(
    'tomorrow',
  );
});
