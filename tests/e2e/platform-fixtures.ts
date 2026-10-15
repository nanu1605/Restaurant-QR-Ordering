import { createHmac } from 'node:crypto';

import { expect, type Page } from '@playwright/test';

import { adminClient, createTestRestaurant, logInWithEmail, TEST_PASSWORD } from './helpers';

/**
 * Platform admins for E2E. Each test makes its own, because a platform admin's
 * authenticator is part of its state; the seeded super@local.test is left for
 * people to enrol by hand (docs/DECISIONS.md P7-2).
 */
export type PlatformAdmin = { email: string; userId: string; secret?: string };

export async function createPlatformAdmin(
  prefix = 'admin',
  role: 'admin' | 'finance' | 'sales' | 'support' = 'admin',
): Promise<PlatformAdmin> {
  const admin = adminClient();
  const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const email = `${prefix}-${unique}@platform.test`;
  const created = await admin.auth.admin.createUser({
    email,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (created.error) throw created.error;
  const userId = created.data.user.id;
  const inserted = await admin.from('platform_admins').insert({ user_id: userId, role });
  if (inserted.error) throw inserted.error;
  return { email, userId };
}

/** The current TOTP code for a base32 secret (RFC 6238: SHA-1, 30 s, 6 digits). */
export function totpCode(secret: string, at = Date.now()) {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const value = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(value % 1_000_000).padStart(6, '0');
}

function base32Decode(text: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of text.replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index === -1) throw new Error(`Not base32: ${char}`);
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/**
 * Logs a platform admin in and passes the second factor: enrols an
 * authenticator on the first login (keeping the secret on `admin`), then
 * enters the current code. Ends on the super-admin Home.
 */
export async function logInAsPlatformAdmin(page: Page, admin: PlatformAdmin) {
  await page.goto('/login');
  await logInWithEmail(page, admin.email, TEST_PASSWORD);
  await passSecondFactor(page, admin);
}

/** From /super/mfa: enrols an authenticator the first time, enters a code, ends on Home. */
export async function passSecondFactor(page: Page, admin: PlatformAdmin) {
  await expect(page).toHaveURL(/\/super\/mfa$/);

  const main = page.getByRole('main');
  if (!admin.secret) {
    await main.getByRole('button', { name: 'Set up authenticator app' }).click();
    admin.secret = (await main.getByTestId('totp-secret').textContent())?.trim() ?? '';
    expect(admin.secret).toMatch(/^[A-Z2-7]+=*$/);
  }
  await main.getByLabel('6-digit code').fill(totpCode(admin.secret));
  await main.getByRole('button', { name: 'Verify' }).click();
  try {
    await expect(page).toHaveURL(/\/super$/, { timeout: 10_000 });
  } catch {
    // Under load a code can run out on its way: try once more with the next one,
    // unless Home was only slow to arrive.
    await page.waitForTimeout(30_000 - (Date.now() % 30_000) + 500);
    if (new URL(page.url()).pathname === '/super') return;
    await main.getByLabel('6-digit code').fill(totpCode(admin.secret));
    await main.getByRole('button', { name: 'Verify' }).click();
    await expect(page).toHaveURL(/\/super$/);
  }
}

/** Picks one of a restaurant page's Actions (docs/DECISIONS.md SA-34). */
export async function restaurantAction(page: Page, name: string) {
  await page.getByRole('main').getByRole('button', { name: 'Actions' }).click();
  await page.getByRole('menuitem', { name }).click();
}

/** Whether the restaurant page's Actions menu offers an action. */
export async function hasRestaurantAction(page: Page, name: string) {
  await page.getByRole('main').getByRole('button', { name: 'Actions' }).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const count = await menu.getByRole('menuitem', { name }).count();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  return count > 0;
}

/** Opens one of a restaurant page's tabs. */
export async function restaurantTab(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: 'Restaurant sections' })
    .getByRole('link', { name, exact: true })
    .click();
}

/**
 * A resolved support request with an internal note, and the inbox's paths:
 * the list and the request (13b), for the sweeps over every super-admin page.
 * Resolved, so the open ones of other tests stay on the inbox's first page.
 */
export async function supportRequestPaths(prefix: string) {
  const restaurant = await createTestRestaurant({ prefix });
  const admin = adminClient();
  const { data } = await admin
    .from('support_requests')
    .insert({
      restaurant_id: restaurant.restaurantId,
      created_by_name: 'Test Owner',
      created_by_role: 'owner',
      topic: 'printing',
      message: 'The bill printer prints blank pages.',
      contact_method: 'whatsapp',
      contact: '9876543210',
      context: { page: '/admin/billing', browser: 'Chrome' },
      status: 'resolved',
      resolved_at: new Date().toISOString(),
    })
    .select('id')
    .single()
    .throwOnError();
  await admin
    .from('support_request_events')
    .insert({
      request_id: data.id,
      restaurant_id: restaurant.restaurantId,
      kind: 'note',
      body: 'Asked them to restart the printer.',
    })
    .throwOnError();
  return ['/super/support', `/super/support/${data.id}`];
}

/**
 * A contacted lead with an overdue follow-up and a note, and the Growth pages
 * (13d): the pipeline as a table and a board, adding a lead, the lead,
 * unfinished signups and the funnel, for the sweeps over every super-admin page.
 */
export async function growthPaths(prefix: string) {
  const admin = adminClient();
  const name = `Sweep ${prefix}`;
  // Two sweeps can start at once: the oldest of the same name.
  const found = await admin
    .from('site_leads')
    .select('id')
    .eq('name', name)
    .order('created_at')
    .limit(1)
    .maybeSingle();
  const id = found.data?.id ?? (await sweepLead(name));
  return [
    '/super/leads',
    '/super/leads?view=board',
    '/super/leads/new',
    `/super/leads/${id}`,
    '/super/leads/signups',
    '/super/funnel',
  ];
}

async function sweepLead(name: string) {
  const admin = adminClient();
  const { data } = await admin
    .from('site_leads')
    .insert({
      name,
      restaurant_name: 'Sweep Cafe',
      city: 'Indore',
      phone: `9${Date.now().toString().slice(-9)}`,
      message: 'Twelve tables, two floors.',
      stage: 'contacted',
      follow_up_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    })
    .select('id')
    .single()
    .throwOnError();
  await admin
    .from('lead_events')
    .insert([
      { lead_id: data.id, kind: 'stage', from_value: 'new', to_value: 'contacted' },
      { lead_id: data.id, kind: 'note', body: 'Wants a demo on Monday.' },
    ])
    .throwOnError();
  return data.id;
}

/**
 * A restaurant with a pinned note and a tag, and the paths of its page's tabs,
 * for the sweeps over every super-admin page.
 */
export async function restaurantPagePaths(prefix: string) {
  const restaurant = await createTestRestaurant({ prefix });
  const admin = adminClient();
  await admin
    .from('restaurant_notes')
    .insert({
      restaurant_id: restaurant.restaurantId,
      body: 'Prefers calls after 4 pm',
      pinned: true,
    })
    .throwOnError();
  // One tag for every sweep: made by the first, found by the rest.
  const name = `Sweep ${prefix}`;
  const found = await admin.from('platform_tags').select('id').eq('name', name).maybeSingle();
  const tag =
    found.data ??
    (await admin.from('platform_tags').insert({ name, colour: 'teal' }).select('id').single()).data;
  if (tag) {
    await admin
      .from('restaurant_tags')
      .insert({ restaurant_id: restaurant.restaurantId, tag_id: tag.id })
      .throwOnError();
  }
  const base = `/super/restaurants/${restaurant.restaurantId}`;
  return [
    '',
    '/billing',
    '/usage',
    '/activity',
    '/notes',
    '/documents',
    '/support/menu',
    '/menu-import',
  ].map((tab) => `${base}${tab}`);
}

/**
 * A support session of `admin` in a fresh restaurant (13c), and admin pages
 * that show its banner, for the sweeps. The session's admin panel is the
 * restaurant's, so these come after the /super paths.
 */
export async function supportSessionPaths(prefix: string, admin: PlatformAdmin) {
  const restaurant = await createTestRestaurant({ prefix });
  const now = Date.now();
  await adminClient()
    .from('support_sessions')
    .insert({
      restaurant_id: restaurant.restaurantId,
      consent: 'owner',
      granted_by: restaurant.ownerUserId,
      ends_at: new Date(now + 3600_000).toISOString(),
      user_id: admin.userId,
      staff_name: 'Priya',
      started_at: new Date(now).toISOString(),
    })
    .throwOnError();
  return ['/admin', '/admin/settings'];
}
