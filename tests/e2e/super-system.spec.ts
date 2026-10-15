import { createHmac } from 'node:crypto';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { adminClient, createTestRestaurant, fakeTurnstile } from './helpers';
import { createPlatformAdmin, logInAsPlatformAdmin } from './platform-fixtures';

// System health (docs/SUPER_ADMIN_PLAN.md 14d; docs/DECISIONS.md SA-86+): a
// failed step and a missed run on Home and System, an email's log and its
// bounce, Sentry, versions, space and menu imports.

const nav = (page: Page) => page.getByRole('navigation', { name: 'Platform sections' }).first();
const unique = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
// playwright.config.ts's RESEND_WEBHOOK_SECRET: whsec_ and this, in base64.
const WEBHOOK_KEY = Buffer.from('e2e-resend-webhook-secret-32bytes');

// Local runs all ask from one network, which may ask 10 times a day (P11-6).
const octet = () => Math.floor(Math.random() * 256);
test.use({ extraHTTPHeaders: { 'x-real-ip': `10.${octet()}.${octet()}.${octet()}` } });

async function openSystem(page: Page) {
  await nav(page).getByRole('link', { name: 'Health' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'System health' })).toBeVisible();
}

test('a failed step and a missed run show on Home and on System', async ({ page }) => {
  const job = `e2esys-${unique()}`;
  const late = `${job}-late`;
  const db = adminClient();
  try {
    await db
      .from('cron_runs')
      .insert([
        { job, step: 'fine', started_at: hoursAgo(1), finished_at: hoursAgo(1), ok: true },
        {
          job,
          step: 'broken',
          started_at: hoursAgo(1),
          finished_at: hoursAgo(1),
          ok: false,
          detail: 'e2e boom',
        },
        { job, step: 'killed', started_at: hoursAgo(25), finished_at: hoursAgo(25), ok: true },
        { job: late, step: 'only', started_at: hoursAgo(27), finished_at: hoursAgo(27), ok: true },
      ])
      .throwOnError();
    await logInAsPlatformAdmin(page, await createPlatformAdmin('e2e-system'));

    const group = page.getByRole('region', { name: /^Scheduled jobs that failed or missed a run/ });
    await expect(group.getByRole('listitem').filter({ hasText: `${job}: broken` })).toContainText(
      'e2e boom',
    );
    await expect(group.getByRole('listitem').filter({ hasText: `${job}: killed` })).toContainText(
      'Didn’t finish',
    );
    await expect(
      group.getByRole('listitem').filter({ hasText: new RegExp(`^${late}Missed its run`) }),
    ).toBeVisible();

    await openSystem(page);
    const steps = page.getByRole('region', { name: 'Steps' });
    await expect(
      steps.getByRole('row').filter({ hasText: job }).filter({ hasText: 'broken' }),
    ).toContainText('Failed: e2e boom');
    await expect(
      steps.getByRole('row').filter({ hasText: job }).filter({ hasText: 'killed' }),
    ).toContainText('Didn’t finish in the latest run');
    await expect(
      steps.getByRole('row').filter({ hasText: job }).filter({ hasText: 'fine' }),
    ).toContainText('Done');
    const jobs = page.getByRole('region', { name: 'Scheduled jobs' });
    await expect(jobs.getByRole('listitem').filter({ hasText: late })).toContainText(
      'Missed its run',
    );
    await expect(
      jobs.getByRole('listitem').filter({ hasText: new RegExp(`^${job}Last`) }),
    ).toContainText('1 of 3 steps failed, 1 didn’t finish');
  } finally {
    await db.from('cron_runs').delete().in('job', [job, late]);
  }
});

function signed(body: string, id = `msg_${unique()}`) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', WEBHOOK_KEY)
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');
  return {
    'content-type': 'application/json',
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': `v1,${signature}`,
  };
}

async function sentTo(request: APIRequestContext, to: string) {
  const response = await request.get(`http://127.0.0.1:3190/resend/inbox?to=${to}`);
  return ((await response.json()) as { emails: { id: string; subject: string }[] }).emails;
}

test("an email's send is logged, found by its address, and Resend's bounce marks it", async ({
  page,
  context,
  request,
}) => {
  const email = `system-${unique()}@e2e.test`;
  await createTestRestaurant({ prefix: 'e2e-sys', ownerEmail: email });
  const health = page.getByRole('region', { name: 'Email' });
  test.skip(
    (await request.post('/api/webhooks/resend', { data: '{}' })).status() === 503,
    'The running server has no Resend webhook secret (reuse of a dev server without the E2E env).',
  );

  // A password reset code, sent in the background.
  await fakeTurnstile(context);
  await page.goto('/login/forgot');
  await page.getByRole('textbox', { name: 'Email' }).fill(email);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect.poll(async () => (await sentTo(request, email)).length).toBe(1);
  const [sent] = await sentTo(request, email);

  try {
    await logInAsPlatformAdmin(page, await createPlatformAdmin('e2e-system-mail'));
    await openSystem(page);
    const lookup = health.getByLabel('Emails to one address');
    await lookup.fill(email.toUpperCase());
    await health.getByRole('button', { name: 'Look up' }).click();
    const found = page.getByRole('region', { name: `Emails to ${email.toUpperCase()}` });
    await expect(found.getByRole('row').nth(1)).toContainText('Password resets');
    await expect(found.getByRole('row').nth(1)).toContainText('Sent');
    await expect(found.getByRole('row').nth(1)).toContainText(sent!.id);

    // Resend reports the bounce; a forged report is refused.
    const body = JSON.stringify({ type: 'email.bounced', data: { email_id: sent!.id } });
    const forged = await request.post('/api/webhooks/resend', {
      headers: { ...signed(body), 'svix-signature': 'v1,Zm9yZ2Vk' },
      data: body,
    });
    expect(forged.status()).toBe(400);
    const report = await request.post('/api/webhooks/resend', {
      headers: signed(body),
      data: body,
    });
    expect(report.status()).toBe(200);
    expect(await report.json()).toEqual({ ok: true, updated: 1 });

    await health.getByRole('button', { name: 'Look up' }).click();
    await expect(found.getByRole('row').nth(1)).toContainText('Bounced');
    await page.goto('/super');
    await expect(
      page
        .getByRole('region', { name: /^Emails that failed or bounced/ })
        .getByRole('listitem')
        .filter({ hasText: 'Password resets' }),
    ).toContainText('bounced');
  } finally {
    await adminClient().from('email_log').delete().eq('provider_id', sent!.id);
  }
});

test('Sentry, versions, space against the plan limits, and menu imports', async ({ page }) => {
  const db = adminClient();
  // The shared settings row: no limits for this test, then as it was.
  const { data: stored } = await db
    .from('platform_settings')
    .select('db_limit_mb, storage_limit_mb')
    .eq('id', 1)
    .single()
    .throwOnError();
  try {
    await db
      .from('platform_settings')
      .update({ db_limit_mb: null, storage_limit_mb: null })
      .eq('id', 1)
      .throwOnError();
    await logInAsPlatformAdmin(page, await createPlatformAdmin('e2e-system-space'));
    await openSystem(page);

    const errors = page.getByRole('region', { name: 'Errors' });
    await expect(errors).not.toContainText('Checking');
    test.skip(
      (await errors.textContent())?.includes('Not set up') ?? false,
      'The running server has no Sentry token (reuse of a dev server without the E2E env).',
    );
    await expect(errors).toContainText('2 issues');
    await expect(errors.getByRole('link', { name: 'TypeError: e2e issue one' })).toHaveAttribute(
      'href',
      'https://sentry.example/issues/1001/',
    );
    await expect(errors).toContainText('MENUMESH-1, 42 events');

    const versions = page.getByRole('region', { name: 'Versions' });
    await expect(versions.getByRole('definition').nth(1)).toHaveText('abc1234');
    await expect(versions).toContainText('Unhealthy: its database check failed');

    await expect(page.getByRole('region', { name: 'Menu imports this month' })).toContainText(
      'AI cost',
    );
    const space = page.getByRole('region', { name: 'Space' });
    await expect(space).toContainText('Enter the plan’s limits');

    // A database past 80% of its limit warns here and on Home.
    await db.from('platform_settings').update({ db_limit_mb: 1 }).eq('id', 1).throwOnError();
    await page.reload();
    await expect(space).toContainText('Over 80% of the plan’s limit');
    await page.goto('/super');
    await expect(
      page
        .getByRole('region', { name: /^Running out of space/ })
        .getByRole('listitem')
        .filter({ hasText: 'Database' }),
    ).toContainText('Move to a bigger plan or clear space');
  } finally {
    await db.from('platform_settings').update(stored).eq('id', 1);
  }
});
