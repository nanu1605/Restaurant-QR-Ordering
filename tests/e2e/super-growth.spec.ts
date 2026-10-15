import { expect, test } from '@playwright/test';

import { adminClient, createTestRestaurant } from './helpers';
import { createPlatformAdmin, logInAsPlatformAdmin } from './platform-fixtures';

// The leads pipeline, unfinished signups, the funnel and "Found us"
// (docs/SUPER_ADMIN_PLAN.md 13d; docs/DECISIONS.md SA-53 to SA-60).

// A mobile no other run has: 9 and the clock's last 9 digits.
const mobile = (lead: string) => `${lead}${Date.now().toString().slice(-9)}`;

test('a lead added by hand: duplicate warning, linked, lost, followed up, noted', async ({
  page,
}) => {
  const admin = adminClient();
  const team = await createPlatformAdmin('e2e-growth');
  const restaurant = await createTestRestaurant({ prefix: 'e2e-growth' });
  const phone = mobile('9');
  await admin.from('restaurants').update({ phone }).eq('id', restaurant.restaurantId);
  const name = `Ravi ${restaurant.slug}`;

  try {
    await logInAsPlatformAdmin(page, team);
    await page
      .getByRole('navigation', { name: 'Platform sections' })
      .getByRole('link', { name: 'Leads' })
      .click();
    await expect(page.getByRole('heading', { name: 'Leads', level: 1 })).toBeVisible();
    await page.getByRole('link', { name: 'Add lead' }).click();
    await expect(page.getByRole('heading', { name: 'Add lead', level: 1 })).toBeVisible();

    await page.getByLabel('Their name').fill(name);
    await page.getByLabel('Restaurant', { exact: true }).fill('Ravi Dhaba');
    await page.getByLabel('City').fill('Bhopal');
    await page.getByLabel('Mobile number').fill(`+91 ${phone.slice(0, 5)} ${phone.slice(5)}`);
    await page.getByLabel('City').click();
    const known = page.getByRole('status').filter({ hasText: 'This mobile is already known' });
    await expect(known.getByRole('link', { name: restaurant.name })).toBeVisible();

    await page.getByRole('button', { name: 'Add lead' }).click();
    await expect(page.getByText('Choose how they came.')).toBeVisible();
    await page.getByLabel('How did they come?').selectOption({ label: 'Field visit' });
    await page.getByRole('button', { name: 'Add lead' }).click();
    await expect(
      page.getByRole('heading', { name: `${name}: Ravi Dhaba`, level: 1 }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/super\/leads\/[0-9a-f-]{36}$/);
    const leadUrl = page.url();
    await expect(page.getByRole('button', { name: 'Stage: Contacted' })).toBeVisible();
    await expect(page.getByRole('button', { name: `Assignee: ${team.email}` })).toBeVisible();

    // The restaurant with the same mobile: linked, and the lead moves on to Trial.
    const linked = page.getByRole('region', { name: 'Restaurant', exact: true });
    await linked.getByRole('button', { name: `Link to ${restaurant.name}` }).click();
    await expect(linked.getByRole('link', { name: restaurant.name })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stage: Trial' })).toBeVisible();
    await linked.getByRole('button', { name: `Unlink ${restaurant.name}` }).click();
    await expect(linked.getByText('Not linked.')).toBeVisible();

    // Lost, with why; then a follow-up and a note.
    await page.getByRole('button', { name: 'Stage: Trial' }).click();
    await page.getByRole('menuitemradio', { name: 'Lost: price' }).click();
    await expect(page.getByRole('button', { name: 'Stage: Lost: price' })).toBeVisible();
    const history = page.getByRole('region', { name: 'Notes and history' });
    await expect(history).toContainText(`Trial to Lost, by ${team.email}`);

    const next = page.getByRole('region', { name: 'Next steps' });
    await next.getByLabel(/Follow-up/).fill('2030-01-02T10:30');
    await next.getByRole('button', { name: 'Save' }).first().click();
    await expect(page.getByText('Follow-up saved')).toBeVisible();
    await expect(history).toContainText('Follow-up set for 2 Jan 2030');

    await history.getByLabel('Internal note').fill('Call after the festival.');
    await history.getByRole('button', { name: 'Add note' }).click();
    await expect(history.getByText('Call after the festival.')).toBeVisible();

    // In the list, and old links from search and alerts still land on it.
    await page.goto(`/super/leads?stage=all&q=${encodeURIComponent(restaurant.slug)}`);
    const row = page.getByRole('row').filter({ hasText: name });
    await expect(row).toContainText('Lost: price');
    await expect(row).toContainText('Field visit');
    await page.goto(`/super/leads?lead=${leadUrl.split('/').pop()}`);
    await expect(page).toHaveURL(leadUrl);
  } finally {
    await admin.from('site_leads').delete().eq('phone', phone);
  }
});

test('a website lead: Call or WhatsApp asks to mark it contacted; the board', async ({
  page,
  context,
}) => {
  const admin = adminClient();
  const team = await createPlatformAdmin('e2e-growth');
  const phone = mobile('8');
  const name = `Asha ${phone}`;
  const { data: lead } = await admin
    .from('site_leads')
    .insert({ name, restaurant_name: 'Asha Cafe', city: 'Pune', phone })
    .select('id')
    .single();
  // WhatsApp opens in a new tab; nothing leaves the test.
  await context.route('https://wa.me/**', (route) => route.abort());

  try {
    await logInAsPlatformAdmin(page, team);
    await page.goto(`/super/leads/${lead!.id}`);
    await expect(page.getByRole('button', { name: 'Stage: New' })).toBeVisible();
    const reach = page.getByRole('region', { name: 'Reach them' });
    const popup = page.waitForEvent('popup');
    await reach.getByRole('link', { name: 'WhatsApp' }).click();
    await (await popup).close();
    await reach.getByRole('button', { name: 'Mark as contacted' }).click();
    await expect(page.getByText('Marked as contacted')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stage: Contacted' })).toBeVisible();
    await expect(reach.getByRole('status')).toHaveCount(0);

    await page.goto(`/super/leads?view=board&q=${phone}`);
    const contacted = page.getByRole('region', { name: 'Contacted (1)' });
    await expect(contacted.getByRole('link', { name: new RegExp(name) })).toBeVisible();
    await expect(page.getByRole('region', { name: 'New (0)' })).toContainText('None');
  } finally {
    await admin.from('site_leads').delete().eq('phone', phone);
  }
});

test('unfinished signups, the funnel and upgrade opportunities, and Found us', async ({ page }) => {
  const admin = adminClient();
  const team = await createPlatformAdmin('e2e-growth');
  const restaurant = await createTestRestaurant({ prefix: 'e2e-funnel', plan: 'starter' });
  const email = `unfinished-${restaurant.slug}@signup.test`;
  await admin.from('site_signups').insert({
    email,
    details: {
      ownerName: 'Meena',
      phone: mobile('7'),
      restaurantName: 'Meena Cafe',
      city: 'Indore',
    },
    code_hash: '0'.repeat(64),
  });
  // More limit hits than any other restaurant, so it leads the list.
  await admin
    .from('plan_limit_events')
    .insert(
      Array.from({ length: 40 }, () => ({
        restaurant_id: restaurant.restaurantId,
        kind: 'tables',
      })),
    );

  try {
    await logInAsPlatformAdmin(page, team);
    await page.goto('/super/leads');
    await page.getByRole('link', { name: 'Unfinished signups' }).click();
    const signup = page.getByRole('row').filter({ hasText: email });
    await expect(signup).toContainText('Meena Cafe');
    await expect(signup).toContainText('Code sent, not entered');

    await page
      .getByRole('navigation', { name: 'Platform sections' })
      .getByRole('link', { name: 'Funnel' })
      .click();
    await expect(page.getByRole('heading', { name: 'Funnel', level: 1 })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Last 30 days' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const upgrades = page.getByRole('region', { name: 'Upgrade opportunities' });
    const opportunity = upgrades.getByRole('row').filter({ hasText: restaurant.name });
    await expect(opportunity).toContainText('More tables than the plan allows (40 times)');

    // Dates with nothing in them.
    await page.getByLabel('From').fill('2019-01-01');
    await page.getByLabel('To').fill('2019-01-31');
    await page.getByRole('button', { name: 'Show' }).click();
    await expect(page).toHaveURL(/from=2019-01-01&to=2019-01-31/);
    await expect(page.getByRole('region', { name: 'By channel' })).toContainText(
      'No leads or restaurants in these dates.',
    );
    await expect(page.getByRole('region', { name: 'Steps' })).toContainText(
      'Not counted for these dates',
    );

    // Found us, set on the restaurant's page.
    await page.goto(`/super/restaurants/${restaurant.restaurantId}/documents`);
    await page.getByRole('button', { name: 'Found us: Not known' }).click();
    await page.getByRole('menuitemradio', { name: 'Referral' }).click();
    await expect(page.getByRole('button', { name: 'Found us: Referral' })).toBeVisible();
  } finally {
    await admin.from('site_signups').delete().eq('email', email);
  }
});
