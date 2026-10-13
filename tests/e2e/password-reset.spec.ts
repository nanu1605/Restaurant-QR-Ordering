import { createClient } from '@supabase/supabase-js';
import { expect, type APIRequestContext, type Page, test } from '@playwright/test';

import type { Database } from '../../src/types/database';
import {
  adminClient,
  createTestRestaurant,
  fakeTurnstile,
  TEST_PASSWORD,
  watchCspViolations,
} from './helpers';

// "Forgot password" on /login (docs/DECISIONS.md P11-6 to P11-9): an emailed
// code and a new password, the same answer for any email, other devices
// signed out, and staff sent to their owner.

const NEW_PASSWORD = 'new-Password-2';

// Local runs all ask from one network, which may ask 10 times a day (P11-6): each worker asks
// from an address of its own.
const octet = () => Math.floor(Math.random() * 256);
test.use({ extraHTTPHeaders: { 'x-real-ip': `10.${octet()}.${octet()}.${octet()}` } });
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function inbox(request: APIRequestContext, to: string) {
  const response = await request.get(`http://127.0.0.1:3190/resend/inbox?to=${to}`);
  return ((await response.json()) as { emails: { subject: string }[] }).emails;
}

function signedOutClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('E2E needs the Supabase URL and publishable key');
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** From the login page's Email tab to the code step, for an email. */
async function askForCode(page: Page, email: string) {
  await page.goto('/login');
  await page.getByRole('tab', { name: 'Email' }).click();
  await page
    .getByRole('tabpanel', { name: 'Email' })
    .getByRole('link', { name: 'Forgot password?' })
    .click();
  await expect(page).toHaveURL(/\/login\/forgot$/);
  await expect(page.getByRole('heading', { name: 'Reset your password' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  const send = page.getByRole('button', { name: 'Email me a code' });
  await expect(send).toBeEnabled();
  await send.click();
  // The step changes on the same address: focus moves to the code field, which reads the intro.
  await expect(page.getByRole('textbox', { name: 'Code from the email' })).toBeFocused();
  await expect(
    page.getByText(
      `If ${email.trim().toLowerCase()} has a MenuMesh account, we’ve emailed it a 6-digit code.`,
      {
        exact: false,
      },
    ),
  ).toBeVisible();
}

async function submitCode(page: Page, code: string, password: string, confirm = password) {
  const form = page.getByRole('form', { name: 'New password' });
  await form.getByRole('textbox', { name: 'Code from the email' }).fill(code);
  await form.getByLabel('New password', { exact: true }).fill(password);
  await form.getByLabel('New password again').fill(confirm);
  await form.getByRole('button', { name: 'Set new password' }).click();
}

test('an owner resets a forgotten password by email, and other devices are signed out', async ({
  page,
  context,
  request,
}) => {
  const email = `reset-${unique()}@e2e.test`;
  const restaurant = await createTestRestaurant({ prefix: 'reset', ownerEmail: email });
  // Another device, signed in before the reset.
  const other = signedOutClient();
  const before = await other.auth.signInWithPassword({ email, password: TEST_PASSWORD });
  expect(before.error).toBeNull();

  const violations = await watchCspViolations(context);
  await fakeTurnstile(context);
  await askForCode(page, ` ${email.toUpperCase()} `);

  await expect.poll(async () => (await inbox(request, email)).length).toBe(1);
  const [sent] = await inbox(request, email);
  const code = /^(\d{6}) is your MenuMesh password reset code$/.exec(sent!.subject)![1]!;

  await submitCode(page, code === '000000' ? '111111' : '000000', NEW_PASSWORD);
  await expect(page.getByText('That code isn’t right. 4 tries left.')).toBeVisible();
  await submitCode(page, code, NEW_PASSWORD, 'not-the-same-1');
  await expect(
    page.getByText('The passwords don’t match. Type the new password again.'),
  ).toBeVisible();

  await submitCode(page, code, NEW_PASSWORD);
  // Signed in with the new password, and on to the owner's panel.
  await expect(page).toHaveURL(/\/admin$/);

  // The other device can't renew its session (Supabase Auth ends every session when the Admin API
  // sets a password), and only the new password works.
  const renewed = await other.auth.refreshSession();
  expect(renewed.error).not.toBeNull();
  const old = await signedOutClient().auth.signInWithPassword({ email, password: TEST_PASSWORD });
  expect(old.error?.code).toBe('invalid_credentials');
  const fresh = await signedOutClient().auth.signInWithPassword({ email, password: NEW_PASSWORD });
  expect(fresh.error).toBeNull();

  // The code is used up, and the reset is in the restaurant's audit log.
  await page.goto('/login/forgot');
  await expect(page.getByRole('button', { name: 'Email me a code' })).toBeVisible();
  const audit = await adminClient()
    .from('audit_logs')
    .select('actor_label, reason')
    .eq('restaurant_id', restaurant.restaurantId)
    .eq('action', 'staff.password_reset');
  expect(audit.data).toEqual([{ actor_label: 'Test Owner', reason: 'Reset with an emailed code' }]);
  expect(violations).toEqual([]);
});

test('an email without an account gets the same answer and no email', async ({
  page,
  context,
  request,
}) => {
  const email = `nobody-${unique()}@e2e.test`;
  await fakeTurnstile(context);
  await askForCode(page, email);

  await submitCode(page, '123456', NEW_PASSWORD);
  await expect(page.getByText('That code isn’t right. 4 tries left.')).toBeVisible();
  expect(await inbox(request, email)).toEqual([]);

  // Back to the first step, for another email or a new code.
  await page.getByRole('button', { name: 'Get a new code, or use another email' }).click();
  await expect(page.getByRole('textbox', { name: 'Email' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Email me a code' })).toBeVisible();
});

test('staff are told to ask their owner or manager', async ({ page }) => {
  await page.goto('/login');
  await expect(
    page
      .getByRole('tabpanel', { name: 'Restaurant code' })
      .getByText(/^Forgot your password\? Staff: ask your owner or manager to reset it\./),
  ).toBeVisible();
});
