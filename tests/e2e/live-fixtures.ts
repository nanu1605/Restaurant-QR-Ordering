import { randomUUID } from 'node:crypto';

import { type Browser, devices, expect, type Page } from '@playwright/test';

import { staffEmail } from '../../src/lib/auth/staff-email';
import { createOrderingTable, type OrderingTable } from './customer-fixtures';
import { adminClient, logInWithCode, TEST_PASSWORD } from './helpers';

/**
 * A restaurant for live board tests (spec §13.2–§13.3): tables 3, 4 and 5 with
 * the ordering fixture's menu, one table per waiter, a waiter login "ravi"
 * linked to the Ravi profile, a kitchen login, and a second waiter profile
 * (Suresh) without a login. The owner (a manager and more) uses the admin panel.
 */
export async function createLiveRestaurant({
  approval = true,
  maxTablesPerWaiter = 1,
  plan = 'growth',
  staffCanRemoveServedItems = false,
}: {
  approval?: boolean;
  maxTablesPerWaiter?: number;
  plan?: string;
  staffCanRemoveServedItems?: boolean;
} = {}) {
  const ordering = await createOrderingTable({
    approval,
    plan,
    prefix: 'live',
    labels: ['3', '4', '5'],
  });
  const db = adminClient();
  await db
    .from('restaurants')
    .update({
      max_tables_per_waiter: maxTablesPerWaiter,
      staff_can_remove_served_items: staffCanRemoveServedItems,
    })
    .eq('id', ordering.restaurantId)
    .throwOnError();

  const ravi = await createStaffLogin(ordering, 'ravi', 'waiter', 'Ravi Kumar');
  const kitchen = await createStaffLogin(ordering, 'kitchen', 'kitchen', 'Kavita Rao');

  const { data: waiters } = await db
    .from('waiters')
    .insert([
      { restaurant_id: ordering.restaurantId, full_name: 'Ravi Kumar', member_id: ravi.memberId },
      { restaurant_id: ordering.restaurantId, full_name: 'Suresh Patel', member_id: null },
    ])
    .select('id, full_name')
    .throwOnError();

  return {
    ...ordering,
    slug: ordering.restaurant.slug,
    logins: { ravi, kitchen },
    waiters: {
      ravi: waiters!.find((w) => w.full_name === 'Ravi Kumar')!.id,
      suresh: waiters!.find((w) => w.full_name === 'Suresh Patel')!.id,
    },
  };
}

export type LiveRestaurant = Awaited<ReturnType<typeof createLiveRestaurant>>;

/** A staff login the way the Staff logins page makes one (docs/DECISIONS.md P2-5). */
export async function createStaffLogin(
  ordering: Pick<OrderingTable, 'restaurant'>,
  username: string,
  role: 'waiter' | 'kitchen' | 'manager',
  displayName: string,
) {
  const db = adminClient();
  const { data: created, error } = await db.auth.admin.createUser({
    email: staffEmail(
      username,
      ordering.restaurant.slug,
      process.env.STAFF_EMAIL_DOMAIN || 'tableorder.test',
    ),
    password: TEST_PASSWORD,
    email_confirm: true,
    user_metadata: { display_name: displayName },
  });
  if (error || !created.user) throw new Error(`Could not create ${username}: ${error?.message}`);
  const { data: memberId } = await db
    .rpc('admin_create_staff', {
      p_actor_user_id: ordering.restaurant.ownerUserId,
      p_payload: { user_id: created.user.id, display_name: displayName, username, role },
    })
    .throwOnError();
  return { username, userId: created.user.id, memberId: memberId as string };
}

/**
 * Signs a user in on a fresh browser context and waits until the live channel
 * reports "Live", so Realtime assertions don't race the subscription.
 */
export async function openLiveScreen(
  browser: Browser,
  restaurant: LiveRestaurant,
  username: string,
  path: string,
  baseURL: string,
) {
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto('/login');
  await logInWithCode(page, restaurant.slug, username, TEST_PASSWORD);
  await page.waitForURL(/\/(staff|admin)/);
  await page.goto(path);
  await expectLive(page);
  return { context, page };
}

export async function expectLive(page: Page) {
  await expect(page.getByRole('banner').getByRole('status')).toHaveText('Live', {
    timeout: 15_000,
  });
}

/** A phone at the table (the customer panel is mobile-first). */
export async function openCustomerPhone(browser: Browser, url: string, baseURL: string) {
  const context = await browser.newContext({ ...devices['Pixel 7'], baseURL });
  const page = await context.newPage();
  await page.goto(url);
  return { context, page };
}

/** A customer order placed directly (no phone), e.g. to open a table. */
export async function placeCustomerOrder(
  token: string,
  lines: { menu_item_id: string; variant_id?: string | null; quantity: number }[],
) {
  const { data } = await adminClient()
    .rpc('customer_place_order', {
      p_qr_token: token,
      p_device_id: randomUUID(),
      p_idempotency_key: `e2e-${randomUUID()}`,
      p_items: lines,
    })
    .throwOnError();
  return data as { order_id: string; round_number: number; status: string };
}

/** The table card on a board, found by its big label. */
export function tableCard(page: Page, label: string) {
  return page.locator(`button[data-table="${label}"]`);
}
