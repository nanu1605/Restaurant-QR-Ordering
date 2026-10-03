import { expect, type Page, test } from '@playwright/test';

import { DEMO_PASSWORD, logInWithCode } from './helpers';

// Light or dark (docs/DECISIONS.md B-3): the `theme` cookie, else the device.
const PAPER = { light: 'rgb(250, 248, 245)', dark: 'rgb(18, 17, 16)' };
const INK = { light: 'rgb(28, 25, 23)', dark: 'rgb(245, 242, 238)' };

const html = (page: Page) => page.locator('html');
const pageBackground = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const themeCookie = async (page: Page) =>
  (await page.context().cookies()).find((cookie) => cookie.name === 'theme')?.value;

async function chooseTheme(page: Page, baseURL: string | undefined, theme: 'light' | 'dark') {
  await page.context().addCookies([{ name: 'theme', value: theme, url: baseURL! }]);
}

test('follows the device until a theme is chosen', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(html(page)).toHaveAttribute('data-theme', 'system');
  expect(await pageBackground(page)).toBe(PAPER.dark);

  await page.emulateMedia({ colorScheme: 'light' });
  expect(await pageBackground(page)).toBe(PAPER.light);
});

test('the chosen theme is in the first HTML, with a matching colour scheme', async ({
  page,
  baseURL,
}) => {
  await chooseTheme(page, baseURL, 'dark');
  const response = await page.request.get('/pricing');
  const body = await response.text();
  expect(body).toContain('data-theme="dark"');
  expect(body).toMatch(/<meta name="color-scheme" content="dark"/);
  expect(body).toMatch(/<meta name="theme-color" content="#1C1A18"/);
});

test('the website switch repaints at once and is remembered', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/pricing');
  const footer = page.getByRole('contentinfo');

  await footer.getByRole('button', { name: 'Dark' }).click();
  await expect(html(page)).toHaveAttribute('data-theme', 'dark');
  await expect(footer.getByRole('button', { name: 'Dark' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect.poll(() => themeCookie(page)).toBe('dark');

  await page.reload();
  await expect(html(page)).toHaveAttribute('data-theme', 'dark');
  expect(await pageBackground(page)).toBe(PAPER.dark);

  // System forgets the choice.
  await page.getByRole('contentinfo').getByRole('button', { name: 'System' }).click();
  await expect.poll(() => themeCookie(page)).toBeUndefined();
});

test('the switch works before the page’s JavaScript', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('/pricing');
  await page.getByRole('contentinfo').getByRole('button', { name: 'Dark' }).click();
  await expect(html(page)).toHaveAttribute('data-theme', 'dark');
  await context.close();
});

test('prints light in the dark theme', async ({ page, baseURL }) => {
  await chooseTheme(page, baseURL, 'dark');
  await page.goto('/pricing');
  expect(await page.evaluate(() => getComputedStyle(document.body).color)).toBe(INK.dark);

  await page.emulateMedia({ media: 'print' });
  expect(await page.evaluate(() => getComputedStyle(document.body).color)).toBe(INK.light);
});

test('the panels switch from the account menu', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/login');
  await logInWithCode(page, 'demo', 'waiter1', DEMO_PASSWORD);
  await expect(page).toHaveURL(/\/staff$/);

  await page.getByRole('banner').getByRole('button', { name: 'Ravi Kumar' }).click();
  await page.getByRole('menuitemradio', { name: 'Dark' }).click();
  await expect(html(page)).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => themeCookie(page)).toBe('dark');

  await page.reload();
  expect(await pageBackground(page)).toBe(PAPER.dark);
});

test('the customer accent swaps its text and ring colours in the dark theme', async ({
  page,
  baseURL,
}) => {
  // The demo restaurant is on the MenuMesh orange: ink as text on the light
  // page, the orange itself on the dark one.
  const brand = () =>
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--brand'));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/t/DEMO0000TABLE001');
  expect(await brand()).toBe('#1C1917');

  await page.emulateMedia({ colorScheme: 'dark' });
  expect(await brand()).toBe('#FF6606');

  await chooseTheme(page, baseURL, 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload();
  expect(await brand()).toBe('#FF6606');
  await expect(page.getByRole('group', { name: 'Theme' })).toBeVisible();
});
