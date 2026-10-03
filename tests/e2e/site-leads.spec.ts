import { expect, test } from '@playwright/test';

import { adminClient, fakeTurnstile } from './helpers';
import { createPlatformAdmin, logInAsPlatformAdmin } from './platform-fixtures';
import { razorpayReady } from './razorpay-fixtures';

// "Book a demo" (docs/DECISIONS.md W-6): from a plan on /pricing to a lead in
// /super/leads and an email to the platform's support address, through the
// Turnstile and Resend mocks in tests/e2e/mock-apis.mjs.

const MOCK = 'http://127.0.0.1:3190';
const SUPPORT_EMAIL = 'leads@menumesh.test';

test.beforeEach(async ({ request }) => {
  test.skip(
    !(await razorpayReady(request)),
    'The running server lacks the E2E env (a reused dev server would email for real).',
  );
});

test('a demo request reaches the platform team', async ({ page, context, request }) => {
  await fakeTurnstile(context);
  const admin = adminClient();
  const unique = Date.now().toString().slice(-9);
  const phone = `9${unique}`;
  const restaurant = `E2E Lead ${unique}`;
  const { data: settings } = await admin
    .from('platform_settings')
    .select('support_email')
    .eq('id', 1)
    .single();
  await admin.from('platform_settings').update({ support_email: SUPPORT_EMAIL }).eq('id', 1);

  try {
    await page.goto('/pricing');
    await page.getByRole('link', { name: 'Book a demo for the Growth plan' }).click();
    await expect(page).toHaveURL(/\/contact\?plan=growth$/);
    const form = page.getByRole('form', { name: 'Book a demo' });
    await expect(form.getByLabel('Plan you’re interested in')).toHaveValue('growth');

    await form.getByLabel('Your name').fill('Asha Rao');
    await form.getByLabel('Restaurant name').fill(restaurant);
    await form.getByLabel('City').fill('Pune');
    await form.getByLabel('Mobile number').fill('12345');
    await form.getByLabel('Anything we should know? (optional)').fill('Twelve tables.\nOpen late.');
    await form.getByRole('button', { name: 'Book a demo' }).click();
    await expect(form.getByText('Enter a 10-digit mobile number.')).toBeVisible();
    await expect(form.getByLabel('Mobile number')).toBeFocused();
    // What was typed stays, and a fresh check runs before the next try.
    await expect(form.getByLabel('Restaurant name')).toHaveValue(restaurant);

    await form.getByLabel('Mobile number').fill(`+91 ${phone.slice(0, 5)} ${phone.slice(5)}`);
    await form.getByRole('button', { name: 'Book a demo' }).click();
    await expect(
      page.getByRole('heading', { name: 'Thank you, we’ve got your request' }),
    ).toBeFocused();

    await expect(async () => {
      const inbox = await request.get(`${MOCK}/resend/inbox?to=${SUPPORT_EMAIL}`);
      const { emails } = (await inbox.json()) as { emails: { subject: string; text: string }[] };
      const email = emails.find((item) => item.subject === `Demo request: ${restaurant}, Pune`);
      expect(email?.text).toContain(`Phone: +91 ${phone}`);
      expect(email?.text).toContain('Plan: Growth');
    }).toPass();

    await logInAsPlatformAdmin(page, await createPlatformAdmin('e2e-leads'));
    await page.getByRole('link', { name: 'Leads' }).first().click();
    await expect(page.getByRole('heading', { name: 'Leads', level: 1 })).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: restaurant });
    await expect(row).toContainText('Asha Rao');
    await expect(row).toContainText(`+91 ${phone}`);
    await expect(row).toContainText('growth');
    await expect(row).toContainText('Twelve tables.');
  } finally {
    await admin
      .from('platform_settings')
      .update({ support_email: settings?.support_email ?? null })
      .eq('id', 1);
    // Keeps the per-network rate limit clear for the next run.
    await admin.from('site_leads').delete().eq('phone', phone);
  }
});
