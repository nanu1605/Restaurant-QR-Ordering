import { expect, test, type Page } from '@playwright/test';

import {
  DEMO_PASSWORD,
  logInWithCode as logInWithCodeAs,
  logInWithEmail as logInWithEmailAs,
} from './helpers';

// Seeded local accounts (supabase/seed.sql) all use DEMO_PASSWORD.
const logInWithCode = (page: Page, code: string, username: string, password = DEMO_PASSWORD) =>
  logInWithCodeAs(page, code, username, password);
const logInWithEmail = (page: Page, email: string, password = DEMO_PASSWORD) =>
  logInWithEmailAs(page, email, password);

// Tab panels are labelled by their tab, so target the inputs by role.
const field = (page: Page, name: string) => page.getByRole('textbox', { name, exact: true });
// Next.js' route announcer is also role="alert" and repeats the page title,
// so scope text checks to the panel header or the form error.
const header = (page: Page) => page.getByRole('banner');
const loginError = (page: Page) =>
  page.getByRole('alert').filter({ hasText: /Wrong restaurant code, username or password/ });

test('waiter logs in with restaurant code and cannot open the admin panel', async ({ page }) => {
  await page.goto('/login');
  await logInWithCode(page, 'demo', 'waiter1');

  await expect(page).toHaveURL(/\/staff$/);
  await expect(header(page).getByText('Worker panel')).toBeVisible();
  await expect(header(page).getByText('Demo Kitchen')).toBeVisible();
  await expect(header(page).getByRole('link', { name: 'Admin panel' })).toHaveCount(0);

  await page.goto('/admin');
  await expect(page).toHaveURL(/\/staff$/);
});

test('kitchen login is case-insensitive and lands on the worker panel', async ({ page }) => {
  await page.goto('/login');
  await logInWithCode(page, ' DEMO ', 'Kitchen1');
  await expect(page).toHaveURL(/\/staff$/);
});

test('manager lands on the admin panel and cannot open super-admin', async ({ page }) => {
  await page.goto('/login');
  await logInWithCode(page, 'demo', 'manager');

  await expect(page).toHaveURL(/\/admin$/);
  await expect(header(page).getByText('Admin panel')).toBeVisible();

  // Managers may use the worker panel too.
  await header(page).getByRole('link', { name: 'Worker panel' }).click();
  await expect(page).toHaveURL(/\/staff$/);

  await page.goto('/super');
  await expect(page).toHaveURL(/\/admin$/);
});

test('owner logs in with their email', async ({ page }) => {
  await page.goto('/login');
  await logInWithEmail(page, 'owner@local.test');
  await expect(page).toHaveURL(/\/admin$/);
});

test('platform admin lands on super-admin and has no restaurant panel', async ({ page }) => {
  await page.goto('/login');
  await logInWithEmail(page, 'super@local.test');

  await expect(page).toHaveURL(/\/super$/);
  await expect(header(page).getByText('Platform admin').first()).toBeVisible();

  await page.goto('/admin');
  await expect(page).toHaveURL(/\/super$/);
});

test('a signed-out visit returns to the requested page after login', async ({ page }) => {
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/login\?next=%2Fadmin$/);

  await logInWithCode(page, 'demo', 'manager');
  await expect(page).toHaveURL(/\/admin$/);
});

test('wrong password shows an error and keeps the typed details', async ({ page }) => {
  await page.goto('/login');
  await logInWithCode(page, 'demo', 'waiter1', 'not-the-password');

  await expect(loginError(page)).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
  await expect(field(page, 'Restaurant code')).toHaveValue('demo');
  await expect(field(page, 'Username')).toHaveValue('waiter1');
});

test('unknown restaurant code gives the same generic error', async ({ page }) => {
  await page.goto('/login');
  await logInWithCode(page, 'nowhere', 'waiter1');
  await expect(loginError(page)).toBeVisible();
});

test('log out ends the session on this device', async ({ page }) => {
  await page.goto('/login');
  await logInWithCode(page, 'demo', 'waiter1');
  await expect(page).toHaveURL(/\/staff$/);

  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.goto('/staff');
  await expect(page).toHaveURL(/\/login\?next=%2Fstaff$/);
});

test('an already signed-in user skips the login page', async ({ page }) => {
  await page.goto('/login');
  await logInWithCode(page, 'demo', 'manager');
  await expect(page).toHaveURL(/\/admin$/);

  await page.goto('/login');
  await expect(page).toHaveURL(/\/admin$/);
});
