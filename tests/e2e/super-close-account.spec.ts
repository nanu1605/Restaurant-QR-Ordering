import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import { readZip } from '../read-zip';

import {
  adminClient,
  CRON_HEADERS,
  createTestRestaurant,
  logInAsOwner,
  logInWithCode,
  logInWithEmail,
  runJobs,
  TEST_PASSWORD,
} from './helpers';
import { createLiveRestaurant, type LiveRestaurant } from './live-fixtures';
import {
  createPlatformAdmin,
  hasRestaurantAction,
  logInAsPlatformAdmin,
} from './platform-fixtures';
import { billTable, ownerClient } from './report-fixtures';

// Closing an account (docs/SUPER_ADMIN_PLAN.md 14e; docs/DECISIONS.md SA-93+):
// the export's contents, a closed restaurant can't sign in, and what stays
// after the removal.

const MOCK = 'http://127.0.0.1:3190';
const RAZORPAY_AUTH = `Basic ${Buffer.from('rzp_test_e2e:e2e-razorpay-secret').toString('base64')}`;
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Waits for the card's link, then downloads the ZIP behind it. */
async function downloadReadyExport(card: Locator, request: APIRequestContext) {
  const link = card.getByRole('link', { name: /Download ZIP/ });
  await expect(link).toBeVisible({ timeout: 60_000 });
  await expect(card.getByRole('status')).toHaveText('The download is ready.');
  const url = (await link.getAttribute('href'))!;
  const download = await request.get(url);
  expect(download.status()).toBe(200);
  return { url, download, files: readZip(await download.body()) };
}

async function downloadExport(page: Page, request: APIRequestContext, region: string) {
  const card = page.getByRole('region', { name: region });
  await card.getByRole('button', { name: 'Prepare a download' }).click();
  await expect(card.getByRole('status')).toContainText('Preparing the download');
  // The button is gone: focus stays in the card.
  await expect(card.getByRole('heading')).toBeFocused();
  return downloadReadyExport(card, request);
}

async function closeFromAccountTab(page: Page, restaurant: LiveRestaurant) {
  await page.goto(`/super/restaurants/${restaurant.restaurantId}/account`);
  await page
    .getByRole('region', { name: 'Close account' })
    .getByRole('button', { name: 'Close account…' })
    .click();
  const dialog = page.getByRole('dialog', { name: /^Close / });
  await dialog.getByLabel('Reason').fill('Owner asked to leave');
  await dialog.getByLabel('Restaurant code').fill(restaurant.slug);
  await dialog.getByRole('button', { name: 'Close account' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Personal data is removed after')).toBeVisible();
}

test('an owner downloads a ZIP of their data, without secrets', async ({ page, request }) => {
  const restaurant = await createLiveRestaurant();
  const db = adminClient();
  const owner = await ownerClient(restaurant.restaurant);
  const bill = await billTable(owner, restaurant, {
    table: '3',
    payment: { mode: 'upi', reference: 'UPI-E2E-1' },
  });
  await db
    .from('waiters')
    .update({ phone: '9876543210', notes: '=formula' })
    .eq('id', restaurant.waiters.suresh)
    .throwOnError();

  await logInAsOwner(page, restaurant.restaurant);
  await page.goto('/admin/settings');
  const { download, files } = await downloadExport(page, request, 'Download my data');
  expect(download.headers()['content-type']).toContain('zip');
  expect(download.headers()['content-disposition']).toContain(`menumesh-${restaurant.slug}-`);

  expect(JSON.parse(files['profile.json']!).name).toBe(restaurant.restaurant.name);
  expect(JSON.parse(files['profile.json']!).subscription.plans.name).toBeTruthy();
  const menu = JSON.parse(files['menu.json']!);
  expect(menu.dishes.map((dish: { name: string }) => dish.name)).toContain('Paneer Tikka');
  expect(files['tables.csv']).toContain('\r\n3,');
  expect(files['staff.csv']).toContain('ravi');
  expect(files['waiters.csv']).toContain('Suresh Patel,9876543210');
  expect(files['waiters.csv']).toContain(`'=formula`);
  expect(files['order_items.csv']).toContain('Paneer Tikka');
  expect(files['bills.csv']).toContain(bill.invoiceNumber);
  expect(JSON.parse(files['bills.json']!)[0].line_items.length).toBeGreaterThan(0);
  expect(files['bill_payments.csv']).toContain(`${bill.invoiceNumber},upi,`);
  expect(files['bill_payments.csv']).toContain('UPI-E2E-1');

  const everything = Object.values(files).join('');
  expect(everything).not.toContain(restaurant.tables['3']!.token);
  expect(everything).not.toContain(restaurant.restaurant.ownerUserId);
  expect(everything).not.toContain(restaurant.logins.ravi.userId);
  expect(everything).not.toContain('.staff.');

  // Refreshing keeps the link, and it is in the audit log.
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Download my data' }).getByRole('link', { name: /Download/ }),
  ).toBeVisible();
  const { data: audit } = await db
    .from('audit_logs')
    .select('actor_label')
    .eq('restaurant_id', restaurant.restaurantId)
    .eq('action', 'restaurant.data_exported')
    .throwOnError();
  expect(audit).toEqual([{ actor_label: 'Test Owner' }]);
});

// The exports wait in one queue that builds one at a time, and the minute job builds what a run
// left (docs/DECISIONS.md VPS-25, VPS-26, VPS-29). A tick works the whole platform, so each one
// is kept to its kind.

test('the minute job answers only with the secret, and only to kinds it has', async ({
  request,
}) => {
  expect((await request.get('/api/cron/jobs')).status()).toBe(401);
  expect(
    (await request.get('/api/cron/jobs', { headers: { Authorization: 'Bearer wrong' } })).status(),
  ).toBe(401);
  const unknown = await request.get('/api/cron/jobs?kinds=nope', { headers: CRON_HEADERS });
  test.skip(
    unknown.status() === 401,
    'The running server has no CRON_SECRET for E2E (reuse of a dev server without the E2E env).',
  );
  expect(unknown.status()).toBe(400);
});

test('the minute job builds an export that waits in the queue', async ({ page, request }) => {
  test.slow();
  const restaurant = await createTestRestaurant({ prefix: 'queued' });
  // As a request leaves it, but with no run started for it: only a tick builds this one.
  await adminClient()
    .from('restaurant_exports')
    .insert({ restaurant_id: restaurant.restaurantId })
    .throwOnError();

  // The page is open while it waits, and shows the link once the tick has built it.
  await logInAsOwner(page, restaurant);
  await page.goto('/admin/settings');
  const card = page.getByRole('region', { name: 'Download my data' });

  const tick = await runJobs(request, 'data_exports');
  test.skip(
    tick.status() === 401,
    'The running server has no CRON_SECRET for E2E (reuse of a dev server without the E2E env).',
  );
  expect(tick.status()).toBe(200);
  const { download, files } = await downloadReadyExport(card, request);
  expect(download.headers()['content-type']).toContain('zip');
  expect(JSON.parse(files['profile.json']!).name).toBe(restaurant.name);
});

test('an owner and the team asking at once for two restaurants both get a link', async ({
  page,
  browser,
  request,
  baseURL,
}) => {
  test.slow();
  const owned = await createTestRestaurant({ prefix: 'both-owner' });
  const asked = await createTestRestaurant({ prefix: 'both-team' });

  const ownerContext = await browser.newContext({ baseURL });
  const ownerPage = await ownerContext.newPage();
  await logInAsOwner(ownerPage, owned);
  await ownerPage.goto('/admin/settings');
  await logInAsPlatformAdmin(page, await createPlatformAdmin('e2e-export-both'));
  await page.goto(`/super/restaurants/${asked.restaurantId}/account`);

  // No tick: each request starts a run, one build goes at a time on the platform, and the one
  // that comes second is built by the run that is going or by one it goes on to.
  const ownerCard = ownerPage.getByRole('region', { name: 'Download my data' });
  const teamCard = page.getByRole('region', { name: 'Data export' });
  await Promise.all([
    ownerCard.getByRole('button', { name: 'Prepare a download' }).click(),
    teamCard.getByRole('button', { name: 'Prepare a download' }).click(),
  ]);
  const [ownerCopy, teamCopy] = await Promise.all([
    downloadReadyExport(ownerCard, request),
    downloadReadyExport(teamCard, request),
  ]);
  expect(JSON.parse(ownerCopy.files['profile.json']!).name).toBe(owned.name);
  expect(JSON.parse(teamCopy.files['profile.json']!).name).toBe(asked.name);
  await ownerContext.close();
});

test('closing stops logins, autopay and QR codes; reopening brings logins and QR codes back', async ({
  page,
  browser,
  request,
  baseURL,
}) => {
  test.slow();
  const restaurant = await createLiveRestaurant();
  const db = adminClient();
  const email = `close-${unique()}@e2e.test`;
  await db.auth.admin
    .updateUserById(restaurant.restaurant.ownerUserId, { email, email_confirm: true })
    .then(({ error }) => expect(error).toBeNull());
  // Autopay is on.
  const created = await request.post(`${MOCK}/razorpay/v1/subscriptions`, {
    headers: { Authorization: RAZORPAY_AUTH },
    data: {
      plan_id: 'plan_E2EGrowthMonth',
      total_count: 120,
      notes: {
        restaurant_id: restaurant.restaurantId,
        plan_code: 'growth',
        billing_cycle: 'monthly',
      },
    },
  });
  await db
    .rpc('razorpay_save_subscription', {
      p_restaurant_id: restaurant.restaurantId,
      p_entity: { ...(await created.json()), status: 'authenticated' },
    })
    .throwOnError();
  const razorpayStatus = async () =>
    (
      await db
        .from('restaurant_subscriptions')
        .select('razorpay_status')
        .eq('restaurant_id', restaurant.restaurantId)
        .single()
        .throwOnError()
    ).data!.razorpay_status;

  // The owner is signed in when it closes.
  const ownerContext = await browser.newContext({ baseURL });
  const ownerPage = await ownerContext.newPage();
  await logInAsOwner(ownerPage, restaurant.restaurant);

  await logInAsPlatformAdmin(page, await createPlatformAdmin('e2e-close'));
  await page.goto(`/super/restaurants/${restaurant.restaurantId}/account`);

  // The wrong code closes nothing and leaves autopay on.
  await page
    .getByRole('region', { name: 'Close account' })
    .getByRole('button', { name: 'Close account…' })
    .click();
  const dialog = page.getByRole('dialog', { name: /^Close / });
  await dialog.getByRole('button', { name: 'Close account' }).click();
  await expect(dialog).toContainText('Say why');
  await dialog.getByLabel('Reason').fill('Owner asked to leave');
  await dialog.getByLabel('Restaurant code').fill('not-its-code');
  await dialog.getByRole('button', { name: 'Close account' }).click();
  await expect(dialog).toContainText('That isn’t this restaurant’s code');
  expect(await razorpayStatus()).toBe('authenticated');

  await dialog.getByLabel('Restaurant code').fill(restaurant.slug.toUpperCase());
  await dialog.getByRole('button', { name: 'Close account' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Personal data is removed after')).toBeVisible();
  await expect(page.getByText(`${restaurant.restaurant.name} is closed`)).toBeVisible();
  // The button that opened the dialog has gone: focus moves to what replaced it.
  await expect(page.getByRole('heading', { name: 'Closed account' })).toBeFocused();
  expect(await razorpayStatus()).toBe('cancelled');
  expect(await hasRestaurantAction(page, 'Suspend')).toBe(false);
  expect(await hasRestaurantAction(page, 'Unsuspend')).toBe(false);

  // The owner hears, and can't get back in.
  await expect
    .poll(async () => {
      const inbox = await request.get(`${MOCK}/resend/inbox?to=${encodeURIComponent(email)}`);
      return ((await inbox.json()) as { emails: { subject: string }[] }).emails.map(
        (sent) => sent.subject,
      );
    })
    .toContainEqual(expect.stringContaining('account is closed'));
  await ownerPage.goto('/admin');
  await expect(ownerPage).toHaveURL(/\/login/);
  await logInWithEmail(ownerPage, email, TEST_PASSWORD);
  // Like a wrong password: it would otherwise tell anyone the address is off.
  await expect(ownerPage.getByText('Wrong email or password')).toBeVisible();
  await ownerPage.goto('/login');
  await logInWithCode(ownerPage, restaurant.slug, 'ravi', TEST_PASSWORD);
  await expect(ownerPage.getByText('Wrong restaurant code')).toBeVisible();
  await ownerPage.goto(restaurant.url);
  await expect(
    ownerPage.getByRole('heading', { name: 'This QR code isn’t working' }),
  ).toBeVisible();

  // The team can find it.
  await page.goto(`/super/restaurants?state=closed&q=${restaurant.slug}`);
  await expect(
    page.getByRole('main').getByRole('link', { name: restaurant.restaurant.name }),
  ).toBeVisible();
  await expect(
    page.getByRole('main').getByRole('row').filter({ hasText: restaurant.restaurant.name }),
  ).toContainText('Closed');

  // Reopening: logins and QR codes come back; autopay doesn't.
  await page.goto(`/super/restaurants/${restaurant.restaurantId}/account`);
  await page.getByRole('button', { name: 'Reopen account' }).click();
  await page
    .getByRole('alertdialog', { name: /^Reopen / })
    .getByRole('button', { name: 'Reopen' })
    .click();
  await expect(page.getByText('Personal data is removed after')).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Close account' })).toBeFocused();
  await expect(
    page
      .getByRole('region', { name: 'Close account' })
      .getByRole('button', { name: 'Close account…' }),
  ).toBeVisible();
  expect(await razorpayStatus()).toBe('cancelled');

  await ownerContext.clearCookies();
  await logInAsOwner(ownerPage, restaurant.restaurant);
  await ownerPage.goto(restaurant.url);
  await expect(ownerPage.getByText('Paneer Tikka').first()).toBeVisible();
  await ownerContext.close();
});

test('a mandate that could still charge goes first, or nothing closes', async ({
  page,
  request,
}) => {
  const restaurant = await createLiveRestaurant();
  const db = adminClient();
  const setMandate = (id: string) =>
    db
      .from('restaurant_subscriptions')
      .update({ razorpay_subscription_id: id, razorpay_status: 'pending' })
      .eq('restaurant_id', restaurant.restaurantId)
      .throwOnError();
  const restaurantStatus = async () =>
    (
      await db
        .from('restaurants')
        .select('status')
        .eq('id', restaurant.restaurantId)
        .single()
        .throwOnError()
    ).data!.status;

  // Razorpay is retrying a failed charge, and refuses this cancel.
  await setMandate('sub_E2EUnknownToRazorpay');
  await logInAsPlatformAdmin(page, await createPlatformAdmin('e2e-close-mandate'));
  await page.goto(`/super/restaurants/${restaurant.restaurantId}/account`);
  await page
    .getByRole('region', { name: 'Close account' })
    .getByRole('button', { name: 'Close account…' })
    .click();
  const dialog = page.getByRole('dialog', { name: /^Close / });
  await dialog.getByLabel('Reason').fill('Owner asked to leave');
  await dialog.getByLabel('Restaurant code').fill(restaurant.slug);
  await dialog.getByRole('button', { name: 'Close account' }).click();
  await expect(dialog).toContainText('Autopay couldn’t be cancelled. Not closed.');
  expect(await restaurantStatus()).toBe('active');

  // A retry Razorpay does cancel. No address on file: the team hears nobody was told.
  const created = await request.post(`${MOCK}/razorpay/v1/subscriptions`, {
    headers: { Authorization: RAZORPAY_AUTH },
    data: {
      plan_id: 'plan_E2EGrowthMonth',
      total_count: 120,
      notes: {
        restaurant_id: restaurant.restaurantId,
        plan_code: 'growth',
        billing_cycle: 'monthly',
      },
    },
  });
  const { id } = (await created.json()) as { id: string };
  await setMandate(id);
  await dialog.getByRole('button', { name: 'Close account' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('no email went out')).toBeVisible();
  expect(await restaurantStatus()).toBe('closed');
  const { data: after } = await db
    .from('restaurant_subscriptions')
    .select('razorpay_status')
    .eq('restaurant_id', restaurant.restaurantId)
    .single()
    .throwOnError();
  expect(after!.razorpay_status).toBe('cancelled');
});

test('the export card says when a build failed or its link ended', async ({ page }) => {
  const restaurant = await createLiveRestaurant();
  const db = adminClient();
  const { data: row } = await db
    .from('restaurant_exports')
    .insert({
      restaurant_id: restaurant.restaurantId,
      status: 'failed',
      finished_at: new Date().toISOString(),
    })
    .select('id')
    .single()
    .throwOnError();

  await logInAsPlatformAdmin(page, await createPlatformAdmin('e2e-close-cards'));
  await page.goto(`/super/restaurants/${restaurant.restaurantId}/account`);
  const card = page.getByRole('region', { name: 'Data export' });
  await expect(card.getByRole('status')).toHaveText(
    'The last download couldn’t be prepared. Try again.',
  );
  await expect(card.getByRole('button', { name: 'Prepare a download' })).toBeVisible();

  await db
    .from('restaurant_exports')
    .update({
      status: 'ready',
      size_bytes: 10,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    })
    .eq('id', row!.id)
    .throwOnError();
  await page.reload();
  await expect(card.getByRole('status')).toHaveText('The last link has ended.');
  await expect(card.getByRole('link', { name: /Download ZIP/ })).toBeHidden();

  // A page left open past the link's end stops offering it.
  await db.storage
    .from('restaurant-exports')
    .upload(`${restaurant.restaurantId}/${row!.id}.zip`, Buffer.from('zip'), {
      contentType: 'application/zip',
    })
    .then(({ error }) => expect(error).toBeNull());
  const setEnd = (at: number) =>
    db
      .from('restaurant_exports')
      .update({ expires_at: new Date(at).toISOString() })
      .eq('id', row!.id)
      .throwOnError();
  await setEnd(Date.now() + 3_600_000);
  await page.clock.install();
  await page.reload();
  await expect(card.getByRole('link', { name: /Download ZIP/ })).toBeVisible();
  await setEnd(Date.now() - 60_000);
  await page.clock.fastForward('01:01:00');
  await expect(card.getByRole('status')).toHaveText('The last link has ended.');
  await expect(card.getByRole('link', { name: /Download ZIP/ })).toBeHidden();
});

test('only Admin gets the Account tab; other roles read a closed restaurant', async ({
  page,
  browser,
  baseURL,
}) => {
  test.slow();
  const restaurant = await createLiveRestaurant();
  await logInAsPlatformAdmin(page, await createPlatformAdmin('e2e-close-admin'));
  await closeFromAccountTab(page, restaurant);
  const base = `/super/restaurants/${restaurant.restaurantId}`;

  for (const role of ['finance', 'sales', 'support'] as const) {
    const context = await browser.newContext({ baseURL });
    const member = await context.newPage();
    await logInAsPlatformAdmin(member, await createPlatformAdmin(`e2e-close-${role}`, role));
    await member.goto(`${base}/account`);
    await expect(member).toHaveURL(/\/super\?denied=1$/);

    await member.goto(base);
    await expect(member.getByText('Personal data is removed after')).toBeVisible();
    await expect(
      member
        .getByRole('navigation', { name: 'Restaurant sections' })
        .getByRole('link', { name: 'Account', exact: true }),
    ).toBeHidden();
    // Money can still arrive; nothing else is left to do.
    if (role === 'finance') {
      expect(await hasRestaurantAction(member, 'Record payment')).toBe(true);
    } else {
      await expect(member.getByRole('main').getByRole('button', { name: 'Actions' })).toBeHidden();
    }
    await context.close();
  }
});

test('after the hold its personal data goes, and its bills stay', async ({ page, request }) => {
  // The whole nightly job runs.
  test.setTimeout(180_000);
  const restaurant = await createLiveRestaurant();
  const db = adminClient();
  const owner = await ownerClient(restaurant.restaurant);
  const bill = await billTable(owner, restaurant, { table: '3', payment: { mode: 'cash' } });
  const { data: before } = await db
    .from('bills')
    .select('*')
    .eq('id', bill.billId)
    .single()
    .throwOnError();

  await logInAsPlatformAdmin(page, await createPlatformAdmin('e2e-close-removal'));
  // A copy made before the removal goes with it.
  await page.goto(`/super/restaurants/${restaurant.restaurantId}/account`);
  const { url: oldLink } = await downloadExport(page, request, 'Data export');
  await closeFromAccountTab(page, restaurant);
  await db
    .from('restaurant_closures')
    .update({ removal_due_at: new Date(Date.now() - 60_000).toISOString() })
    .eq('restaurant_id', restaurant.restaurantId)
    .throwOnError();

  // The nightly job does it (another test may be running it too).
  const cron = await request.get('/api/cron/daily', {
    headers: { Authorization: 'Bearer e2e-cron-secret' },
  });
  expect(cron.status()).toBe(200);
  expect((await cron.json()) as { closedAccounts: { removed: number } | null }).toHaveProperty(
    'closedAccounts.removed',
  );
  await expect
    .poll(
      async () =>
        (
          await db
            .from('restaurant_closures')
            .select('removed_at')
            .eq('restaurant_id', restaurant.restaurantId)
            .single()
            .throwOnError()
        ).data!.removed_at,
    )
    .not.toBeNull();

  const { data: after } = await db
    .from('bills')
    .select('*')
    .eq('id', bill.billId)
    .single()
    .throwOnError();
  expect(after).toEqual(before);
  const { data: login } = await db.auth.admin.getUserById(restaurant.restaurant.ownerUserId);
  expect(login.user).toBeNull();
  const { data: members } = await db
    .from('restaurant_members')
    .select('id')
    .eq('restaurant_id', restaurant.restaurantId)
    .throwOnError();
  expect(members).toEqual([]);
  await expect.poll(async () => (await request.get(oldLink)).status()).not.toBe(200);

  // Its pages still read.
  await page.goto(`/super/restaurants/${restaurant.restaurantId}`);
  await expect(page.getByText('Personal data removed on')).toBeVisible();
  await expect(page.getByText('Reason:')).toBeHidden();
  await expect(page.getByText('Owner: none')).toBeVisible();
  await page.goto(`/super/restaurants/${restaurant.restaurantId}/billing`);
  await expect(
    page.getByRole('heading', { level: 1, name: restaurant.restaurant.name }),
  ).toBeVisible();
  await page.goto(`/super/restaurants/${restaurant.restaurantId}/account`);
  await expect(page.getByRole('region', { name: 'Closed account' })).toContainText(
    'can’t be reopened',
  );
  await expect(page.getByRole('button', { name: 'Reopen account' })).toBeHidden();
  await page.goto(`/super/restaurants/${restaurant.restaurantId}/notes`);
  await expect(page.getByRole('heading', { name: 'Notes' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Add a note' })).toBeHidden();
  await page.goto(`/super/restaurants/${restaurant.restaurantId}/account`);

  // A copy for the accountant still has the bills, not the people.
  const { files } = await downloadExport(page, request, 'Data export');
  expect(files['bills.csv']).toContain(bill.invoiceNumber);
  expect(files['waiters.csv']).not.toContain('Ravi Kumar');
  expect(files['waiters.csv']).toContain('Waiter 1');
  expect(files['staff.csv']).not.toContain('ravi');
});
