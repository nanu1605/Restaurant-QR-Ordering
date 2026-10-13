import { expect, type Browser, type Page, test } from '@playwright/test';

import { adminClient, logInAsOwner, logInWithCode, TEST_PASSWORD } from './helpers';
import {
  createLiveRestaurant,
  type LiveRestaurant,
  placeCustomerOrder,
  tableCard,
} from './live-fixtures';

// The worker panel in Hindi (docs/DECISIONS.md P11-15 to P11-18): each login
// keeps its own language, the board, kitchen and availability screens follow
// it with the dishes' Hindi names, refusals are said in Hindi, and the admin
// panel stays English.

/** Hindi names for two dishes: the owner's for one, the automatic one for the other. */
async function nameDishes(r: LiveRestaurant) {
  const db = adminClient();
  await db
    .from('menu_items')
    .update({ name_hi: 'पनीर टिक्का' })
    .eq('id', r.item.paneer)
    .throwOnError();
  await db
    .from('menu_items')
    .update({ name_hi_auto: 'बटर चिकन' })
    .eq('id', r.item.butterChicken)
    .throwOnError();
}

async function setLanguage(memberId: string, lang: 'en' | 'hi') {
  await adminClient()
    .from('restaurant_members')
    .update({ ui_lang: lang })
    .eq('id', memberId)
    .throwOnError();
}

/** Signs in on a fresh context and waits for the live channel, in Hindi. */
async function openInHindi(browser: Browser, r: LiveRestaurant, username: string, path: string) {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  await page.goto('/login');
  await logInWithCode(page, r.slug, username, TEST_PASSWORD);
  await page.waitForURL(/\/staff/);
  await page.goto(path);
  await expect(page.getByRole('banner').getByRole('status')).toHaveText('लाइव', {
    timeout: 15_000,
  });
  return { context, page };
}

const token = (r: LiveRestaurant, label: string) => r.tables[label]!.token;

const toast = (page: Page, text: string) =>
  page.locator('[data-sonner-toast]').filter({ hasText: text });

test('a waiter set to Hindi works the board, a table and new dishes in Hindi', async ({
  browser,
}) => {
  const r = await createLiveRestaurant({ maxTablesPerWaiter: 3 });
  await nameDishes(r);
  await setLanguage(r.logins.ravi.memberId, 'hi');
  await placeCustomerOrder(token(r, '3'), [{ menu_item_id: r.item.paneer, quantity: 1 }]);

  const { context, page } = await openInHindi(browser, r, 'ravi', '/staff');
  await expect(page.locator('html')).toHaveAttribute('lang', 'hi');
  await expect(page.getByRole('banner')).toContainText('वर्कर पैनल');
  const nav = page.getByRole('navigation', { name: 'वर्कर पैनल के हिस्से' });
  await expect(nav.getByRole('link', { name: 'बोर्ड' })).toHaveAttribute('aria-current', 'page');
  await expect(page).toHaveTitle(/^बोर्ड · /);

  await page.getByRole('button', { name: /^सभी \d/ }).click();
  await expect(tableCard(page, '3')).toContainText('मंज़ूरी बाकी');
  await expect(tableCard(page, '4')).toContainText('खाली');

  // The waiting order, approved in Hindi; its dish by the owner's Hindi name.
  await tableCard(page, '3').click();
  const drawer = page.getByRole('dialog', { name: /^टेबल 3/ });
  const waiting = drawer.getByRole('region', { name: 'राउंड 1, मंज़ूरी का इंतज़ार' });
  await expect(waiting).toContainText('पनीर टिक्का');
  await waiting.getByRole('button', { name: 'मंज़ूर करें राउंड 1' }).click();
  await expect(toast(page, 'ऑर्डर मंज़ूर हुआ')).toBeVisible();
  await drawer.getByRole('button', { name: 'बनाना शुरू करें पनीर टिक्का' }).click();
  await expect(drawer.getByRole('region', { name: 'राउंड 1' })).toContainText('बन रहा है');

  // New dishes: found by either name, sent as a new round.
  await drawer.getByRole('button', { name: 'डिश जोड़ें' }).click();
  const picker = page.getByRole('dialog', { name: 'डिश जोड़ें · टेबल 3' });
  const search = picker.getByRole('searchbox', { name: 'डिश खोजें' });
  await search.fill('butter');
  await expect(picker.getByText('बटर चिकन', { exact: true })).toBeVisible();
  await expect(picker.getByText('पनीर टिक्का', { exact: true })).toBeHidden();
  await search.fill('बटर');
  await picker.getByRole('button', { name: 'Half · ₹280 · बटर चिकन जोड़ें' }).click();
  await expect(picker.getByText('1 आइटम · ₹280')).toBeVisible();
  await picker.getByRole('button', { name: 'ऑर्डर भेजें' }).click();
  await expect(toast(page, 'राउंड 2 किचन को भेजा गया · टेबल 3')).toBeVisible();
  await expect(drawer.getByRole('region', { name: 'राउंड 2' })).toContainText('स्टाफ़ ने जोड़ा');

  // A refusal from the database, in Hindi: table 4 fills while the move dialog
  // still shows it free (the board is held back so it can't update first).
  await drawer.getByRole('button', { name: 'टेबल बदलें' }).click();
  const move = page.getByRole('dialog', { name: 'टेबल 3 बदलें' });
  await expect(move.getByRole('button', { name: 'टेबल 4' })).toBeVisible();
  await page.route('**/rest/v1/rpc/staff_get_board', (route) => route.abort());
  await placeCustomerOrder(token(r, '4'), [{ menu_item_id: r.item.chicken65, quantity: 1 }]);
  await move.getByRole('button', { name: 'टेबल 4' }).click();
  await expect(toast(page, 'टेबल 4 पर अभी मेहमान हैं। कोई दूसरी टेबल चुनें।')).toBeVisible();
  await page.unroute('**/rest/v1/rpc/staff_get_board');
  await context.close();
});

test('a worker switches language from the account menu, and it stays', async ({ browser }) => {
  const r = await createLiveRestaurant();
  await setLanguage(r.logins.ravi.memberId, 'hi');
  const { context, page } = await openInHindi(browser, r, 'ravi', '/staff');

  await page
    .getByRole('banner')
    .getByRole('button', { name: /Ravi Kumar/ })
    .click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('group', { name: 'भाषा' })).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name: 'हिन्दी' })).toBeChecked();
  await expect(menu.getByRole('menuitem', { name: 'लॉग आउट' })).toBeVisible();
  await menu.getByRole('menuitemradio', { name: 'English' }).click();

  await expect(page.getByRole('link', { name: 'Board' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.reload();
  await expect(page.getByRole('banner').getByRole('status')).toHaveText('Live', {
    timeout: 15_000,
  });
  await expect(page.getByRole('navigation', { name: 'Worker panel sections' })).toBeVisible();
  const { data } = await adminClient()
    .from('restaurant_members')
    .select('ui_lang')
    .eq('id', r.logins.ravi.memberId)
    .single()
    .throwOnError();
  expect(data!.ui_lang).toBe('en');
  await context.close();
});

test('the kitchen and availability screens in Hindi', async ({ browser }) => {
  const r = await createLiveRestaurant({ approval: false });
  await nameDishes(r);
  await setLanguage(r.logins.kitchen.memberId, 'hi');
  await placeCustomerOrder(token(r, '5'), [
    { menu_item_id: r.item.paneer, quantity: 2 },
    { menu_item_id: r.item.chicken65, quantity: 1 },
  ]);

  const { context, page } = await openInHindi(browser, r, 'kitchen', '/staff/kitchen');
  await expect(page).toHaveTitle(/^किचन · /);
  const fresh = page.getByRole('region', { name: /^नए/ });
  const ticket = fresh.getByRole('article', { name: 'टेबल 5, राउंड 1' });
  // The owner's Hindi name; a dish without one keeps its name.
  await expect(ticket).toContainText('2 × पनीर टिक्का');
  await expect(ticket).toContainText('1 × Chicken 65');
  await ticket.getByRole('button', { name: 'सब बनाना शुरू करें — टेबल 5, राउंड 1' }).click();
  await expect(
    page.getByRole('region', { name: /^बन रहे/ }).getByRole('article', { name: 'टेबल 5, राउंड 1' }),
  ).toBeVisible();
  await expect(fresh).toContainText('कोई नया ऑर्डर नहीं');

  await page.getByRole('link', { name: 'उपलब्धता' }).click();
  await expect(page.getByRole('heading', { name: 'उपलब्धता' })).toBeVisible();
  await page.getByRole('switch', { name: 'पनीर टिक्का स्टॉक में' }).click();
  await expect(toast(page, 'पनीर टिक्का स्टॉक में नहीं है')).toBeVisible();
  await context.close();
});

test('an owner in Hindi keeps the admin panel in English, and sets a waiter’s language', async ({
  page,
}) => {
  const r = await createLiveRestaurant();
  const { data: owner } = await adminClient()
    .from('restaurant_members')
    .select('id')
    .eq('restaurant_id', r.restaurantId)
    .eq('role', 'owner')
    .single()
    .throwOnError();
  await setLanguage(owner!.id, 'hi');
  await logInAsOwner(page, { slug: r.slug, password: r.restaurant.password });

  await page.goto('/admin/live');
  await expect(page.getByRole('heading', { name: 'Live orders' })).toBeVisible();
  await expect(page.getByRole('banner').getByRole('status')).toHaveText('Live', {
    timeout: 15_000,
  });
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  await page.goto('/staff');
  await expect(page.getByRole('link', { name: 'बोर्ड' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'hi');
  await page.getByRole('banner').getByRole('button', { name: /मालिक/ }).click();
  await page.getByRole('menuitem', { name: 'एडमिन पैनल' }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  // The Staff page sets a worker's panel language.
  await page.goto('/admin/staff');
  await page.getByRole('button', { name: 'Actions for Ravi Kumar' }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit Ravi Kumar' });
  await dialog.getByLabel('Panel language').click();
  await page.getByRole('option', { name: 'हिन्दी' }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('row', { name: /Ravi Kumar/ })).toContainText('हिन्दी');
  const { data } = await adminClient()
    .from('restaurant_members')
    .select('ui_lang')
    .eq('id', r.logins.ravi.memberId)
    .single()
    .throwOnError();
  expect(data!.ui_lang).toBe('hi');
});
