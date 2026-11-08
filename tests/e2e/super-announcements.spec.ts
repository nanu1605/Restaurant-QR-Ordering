import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { adminClient, createTestRestaurant, logInAsOwner, runJobs } from './helpers';
import { createPlatformAdmin, logInAsPlatformAdmin } from './platform-fixtures';

// Announcements (docs/SUPER_ADMIN_PLAN.md 14c; docs/DECISIONS.md SA-82+). Each
// is for a fresh restaurant only, so other tests' panels never show it.

const MOCK = 'http://127.0.0.1:3190';

const nav = (page: Page) => page.getByRole('navigation', { name: 'Platform sections' }).first();

/** The emails the Resend stand-in holds for one address. */
async function inbox(request: APIRequestContext, address: string) {
  const response = await request.get(`${MOCK}/resend/inbox?to=${encodeURIComponent(address)}`);
  return ((await response.json()) as { emails: { subject: string }[] }).emails;
}

/**
 * A moment later today in India (UTC+5:30), where an announcement's first day ends at midnight
 * and the daily run sends its email: halfway to midnight, and two hours ahead at most.
 */
function laterToday() {
  const now = Date.now();
  const india = 330 * 60_000;
  const midnight = (Math.floor((now + india) / 86_400_000) + 1) * 86_400_000 - india;
  return now + Math.min(2 * 60 * 60_000, (midnight - now) / 2);
}

test('an Admin announces to one restaurant; its owner sees it in both panels and hides it', async ({
  browser,
  page,
}) => {
  const restaurant = await createTestRestaurant({ prefix: 'e2e-news' });
  const title = `Menu update ${Date.now().toString(36)}`;
  await logInAsPlatformAdmin(page, await createPlatformAdmin('e2e-news'));
  await nav(page).getByRole('link', { name: 'Announcements' }).click();
  await expect(page.getByRole('heading', { name: 'Announcements', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'New announcement' }).click();
  const form = page.getByRole('dialog', { name: 'New announcement' });
  await form.getByLabel('Title', { exact: true }).fill(title);
  await form.getByLabel('Text', { exact: true }).fill('Prices change on Monday.');
  await form.getByText('Hindi (optional)').click();
  await form.getByLabel('Hindi title').fill('मेन्यू में बदलाव');
  await form.getByLabel('Hindi text').fill('सोमवार से दाम बदलेंगे।');
  await form.getByRole('checkbox', { name: 'Worker panel' }).check();
  await form.getByRole('radio', { name: 'Chosen restaurants' }).check();
  // Nobody chosen yet: refused.
  await form.getByRole('button', { name: 'Create announcement' }).click();
  await expect(form).toContainText('Choose at least one restaurant.');
  await form.getByLabel('Add a restaurant').fill(restaurant.name);
  await form.getByRole('button', { name: `Add ${restaurant.name}` }).click();
  await expect(form.getByRole('list', { name: 'Chosen restaurants' })).toContainText(
    restaurant.name,
  );
  const preview = form.getByRole('region', { name: 'Preview' });
  await expect(preview).toContainText(title);
  await expect(preview).toContainText('मेन्यू में बदलाव');
  await form.getByRole('button', { name: 'Create announcement' }).click();
  await expect(form).toBeHidden();

  const row = page.getByRole('row').filter({ hasText: title });
  await expect(row).toContainText(`1 restaurant: ${restaurant.name}`);
  await expect(row).toContainText('Admin panel, Worker panel · Hindi too');
  await expect(row).toContainText('Live');

  // The owner, using Hindi: English in the admin panel, Hindi in the worker panel.
  await adminClient()
    .from('restaurant_members')
    .update({ ui_lang: 'hi' })
    .eq('restaurant_id', restaurant.restaurantId)
    .eq('role', 'owner')
    .throwOnError();
  const context = await browser.newContext();
  const owner = await context.newPage();
  await logInAsOwner(owner, restaurant);
  await expect(owner.getByRole('status').filter({ hasText: title })).toContainText(
    'Prices change on Monday.',
  );
  await owner.goto('/staff');
  const hindi = owner.getByRole('status').filter({ hasText: 'मेन्यू में बदलाव' });
  await expect(hindi).toContainText('सोमवार से दाम बदलेंगे।');
  await hindi.getByRole('button', { name: 'छिपाएँ' }).click();
  await expect(hindi).toBeHidden();
  await owner.goto('/admin');
  await expect(owner.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(owner.getByText(title)).toHaveCount(0);
  await context.close();

  await page.reload();
  // Hidden by one login.
  await expect(row.getByRole('cell').nth(3)).toHaveText('1');
  await row.getByRole('button', { name: `Actions for ${title}` }).click();
  await page.getByRole('menuitem', { name: 'End now' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'End now' }).click();
  await expect(row).toContainText('Ended');

  const { data: audit } = await adminClient()
    .from('audit_logs')
    .select('action')
    .in('action', ['announcement.created', 'announcement.ended'])
    .eq('after->>title', title);
  expect(audit?.map((entry) => entry.action).sort()).toEqual([
    'announcement.created',
    'announcement.ended',
  ]);
});

test('Sales has no Announcements page', async ({ page }) => {
  await logInAsPlatformAdmin(page, await createPlatformAdmin('e2e-news-sales', 'sales'));
  await expect(nav(page).getByRole('link', { name: 'Announcements' })).toHaveCount(0);
  await page.goto('/super/settings/announcements');
  await expect(page).toHaveURL(/\/super\?denied=1$/);
});

// The minute job emails an announcement's owners once it has started (docs/DECISIONS.md SA-83,
// VPS-28, VPS-29); one that starts later today is the daily run's to send first. Both are made
// with the service role, so no save sends anything: only a tick can.
test('the minute job emails a started announcement once, and starts nothing for a later one', async ({
  request,
}) => {
  test.slow();
  const db = adminClient();
  const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const address = `news-${unique}@e2e.test`;
  const live = await createTestRestaurant({ prefix: 'e2e-mail', ownerEmail: address });
  // With an owner to email, so that it would be due if the minute job took it.
  const waiting = await createTestRestaurant({
    prefix: 'e2e-wait',
    ownerEmail: `later-${unique}@e2e.test`,
  });

  const made: string[] = [];
  const announce = async (restaurantId: string, title: string, startsAt: number) => {
    const { data } = await db
      .from('announcements')
      .insert({
        title,
        body: 'Prices change on Monday.',
        panels: ['admin'],
        restaurant_ids: [restaurantId],
        email: true,
        starts_at: new Date(startsAt).toISOString(),
      })
      .select('id')
      .single()
      .throwOnError();
    made.push(data.id);
    return data.id;
  };

  try {
    const title = `Menu update ${unique}`;
    const announcementId = await announce(live.restaurantId, title, Date.now() - 60_000);
    const first = await runJobs(request, 'announcement_emails');
    test.skip(
      first.status() === 401,
      'The running server has no CRON_SECRET for E2E (reuse of a dev server without the E2E env).',
    );
    expect(first.status()).toBe(200);

    // The tick answered at once; the email goes after.
    await expect.poll(async () => inbox(request, address), { timeout: 30_000 }).toHaveLength(1);
    expect((await inbox(request, address))[0]!.subject).toContain(title);
    await expect
      .poll(
        async () =>
          (
            await db
              .from('announcement_emails')
              .select('restaurant_id')
              .eq('announcement_id', announcementId)
              .throwOnError()
          ).data,
        { timeout: 30_000 },
      )
      .toEqual([{ restaurant_id: live.restaurantId }]);

    // Sent and recorded: nothing waits any more, so a second tick starts no run.
    const second = await runJobs(request, 'announcement_emails');
    expect(await second.json()).toEqual({ ok: true, started: [] });
    expect(await inbox(request, address)).toHaveLength(1);

    // Not started yet, but due on its first day: the daily run sends it first, and the minute job
    // waits until it starts. The tick's answer shows that, not the inbox: other specs run the
    // daily job, which may send this email meanwhile.
    await announce(waiting.restaurantId, `Later ${unique}`, laterToday());
    const third = await runJobs(request, 'announcement_emails');
    expect(await third.json()).toEqual({ ok: true, started: [] });
  } finally {
    await db
      .from('announcements')
      .update({ ended_at: new Date().toISOString() })
      .in('id', made)
      .throwOnError();
  }
});
