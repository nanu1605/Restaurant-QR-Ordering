import { expect, test } from '@playwright/test';

import { adminClient, createTestRestaurant, logInAsOwner } from './helpers';
import { razorpayReady } from './razorpay-fixtures';

// A new support request emails the platform's support address (docs/DECISIONS.md
// SA-42), through the Resend mock in tests/e2e/mock-apis.mjs. It sets that address
// in the one settings row, so it runs after the platform-settings project.

const MOCK = 'http://127.0.0.1:3190';
const SUPPORT_EMAIL = 'help@menumesh.test';

test.beforeEach(async ({ request }) => {
  test.skip(
    !(await razorpayReady(request)),
    'The running server lacks the E2E env (a reused dev server would email for real).',
  );
});

test('a new request emails the support address', async ({ page, request }) => {
  const admin = adminClient();
  const restaurant = await createTestRestaurant({ prefix: 'e2e-helpmail' });
  const { data: settings } = await admin
    .from('platform_settings')
    .select('support_email')
    .eq('id', 1)
    .single();
  await admin.from('platform_settings').update({ support_email: SUPPORT_EMAIL }).eq('id', 1);

  try {
    await logInAsOwner(page, restaurant);
    await page.goto('/admin/help');
    const form = page.getByRole('region', { name: 'New request' });
    await form.getByLabel('What is it about?').selectOption({ label: 'Billing' });
    await form.getByLabel('What do you need help with?').fill(`Invoice for ${restaurant.slug}`);
    await form.getByRole('radio', { name: 'Call' }).check();
    await form.getByLabel('Mobile number').fill('9876543210');
    await form.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Sent. The MenuMesh team will get back to you.')).toBeVisible();

    await expect(async () => {
      const inbox = await request.get(`${MOCK}/resend/inbox?to=${SUPPORT_EMAIL}`);
      const { emails } = (await inbox.json()) as {
        emails: { subject: string; text: string }[];
      };
      const email = emails.find((e) => e.text.includes(`Invoice for ${restaurant.slug}`));
      expect(email?.subject).toBe(`Support request: ${restaurant.name}, Billing`);
      expect(email?.text).toContain('Reach them: Call: +91 9876543210');
      expect(email?.text).toMatch(/Open it: http.*\/super\/support\/[0-9a-f-]{36}/);
    }).toPass();
  } finally {
    await admin
      .from('platform_settings')
      .update({ support_email: settings?.support_email ?? null })
      .eq('id', 1);
    // Out of the inbox's open work, which other tests page through.
    await admin
      .from('support_requests')
      .update({ status: 'resolved', resolved_at: new Date().toISOString() })
      .eq('restaurant_id', restaurant.restaurantId);
  }
});
