import { randomInt } from 'node:crypto';

import { expect, type Page } from '@playwright/test';

import { adminClient, createTestRestaurant } from './helpers';

const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const newToken = () => Array.from({ length: 16 }, () => TOKEN_ALPHABET[randomInt(62)]).join('');

/**
 * A fresh restaurant with tables (label "5" unless given) and a small menu, for
 * ordering tests (docs/DECISIONS.md P3-17):
 * - Starters: Paneer Tikka (veg, ₹280), Chicken 65 (non-veg, ₹320)
 * - Mains: Butter Chicken (Half ₹280 / Full ₹480), Malai Kofta (out of stock)
 * `token`, `tableId` and `url` are the first table's.
 */
export async function createOrderingTable({
  approval = true,
  cancelWindowSeconds = 120,
  prefix = 'order',
  plan = 'growth',
  labels = ['5'],
}: {
  approval?: boolean;
  cancelWindowSeconds?: number;
  prefix?: string;
  plan?: string;
  labels?: string[];
} = {}) {
  const restaurant = await createTestRestaurant({ prefix, plan, cuisine: 'blank' });
  const db = adminClient();
  const restaurantId = restaurant.restaurantId;

  await db
    .from('restaurants')
    .update({
      require_first_order_approval: approval,
      customer_cancel_window_seconds: cancelWindowSeconds,
    })
    .eq('id', restaurantId)
    .throwOnError();

  const { data: diningTables } = await db
    .from('dining_tables')
    .insert(
      labels.map((label, index) => ({
        restaurant_id: restaurantId,
        label,
        qr_token: newToken(),
        sort_order: index + 1,
      })),
    )
    .select('id, label, qr_token')
    .throwOnError();
  const tables = Object.fromEntries(
    diningTables!.map((t) => [t.label, { id: t.id, token: t.qr_token, url: `/t/${t.qr_token}` }]),
  );
  const first = tables[labels[0]!]!;

  const { data: categories } = await db
    .from('menu_categories')
    .insert([
      { restaurant_id: restaurantId, name: 'Starters', sort_order: 1 },
      { restaurant_id: restaurantId, name: 'Mains', sort_order: 2 },
    ])
    .select('id, name')
    .throwOnError();
  const categoryId = (name: string) => categories!.find((c) => c.name === name)!.id;

  // Bulk inserts send every key for every row, so each row sets is_available.
  const { data: items } = await db
    .from('menu_items')
    .insert([
      {
        restaurant_id: restaurantId,
        category_id: categoryId('Starters'),
        name: 'Paneer Tikka',
        food_type: 'veg' as const,
        price_paise: 28000,
        sort_order: 1,
        is_available: true,
      },
      {
        restaurant_id: restaurantId,
        category_id: categoryId('Starters'),
        name: 'Chicken 65',
        food_type: 'non_veg' as const,
        price_paise: 32000,
        sort_order: 2,
        is_available: true,
      },
      {
        restaurant_id: restaurantId,
        category_id: categoryId('Mains'),
        name: 'Butter Chicken',
        food_type: 'non_veg' as const,
        price_paise: 28000,
        sort_order: 1,
        is_available: true,
      },
      {
        restaurant_id: restaurantId,
        category_id: categoryId('Mains'),
        name: 'Malai Kofta',
        food_type: 'veg' as const,
        price_paise: 29000,
        sort_order: 2,
        is_available: false,
      },
    ])
    .select('id, name')
    .throwOnError();
  const itemId = (name: string) => items!.find((i) => i.name === name)!.id;

  const { data: variants } = await db
    .from('menu_item_variants')
    .insert([
      {
        restaurant_id: restaurantId,
        menu_item_id: itemId('Butter Chicken'),
        name: 'Half',
        price_paise: 28000,
        sort_order: 1,
      },
      {
        restaurant_id: restaurantId,
        menu_item_id: itemId('Butter Chicken'),
        name: 'Full',
        price_paise: 48000,
        sort_order: 2,
      },
    ])
    .select('id, name')
    .throwOnError();

  return {
    restaurantId,
    restaurant,
    token: first.token,
    tableId: first.id,
    url: first.url,
    tables,
    item: {
      paneer: itemId('Paneer Tikka'),
      chicken65: itemId('Chicken 65'),
      butterChicken: itemId('Butter Chicken'),
      kofta: itemId('Malai Kofta'),
    },
    variant: {
      half: variants!.find((v) => v.name === 'Half')!.id,
      full: variants!.find((v) => v.name === 'Full')!.id,
    },
  };
}

export type OrderingTable = Awaited<ReturnType<typeof createOrderingTable>>;

/** Rows the database holds for the restaurant, for assertions. */
export async function tableState(restaurantId: string) {
  const db = adminClient();
  const [{ data: sessions }, { data: orders }, { data: items }] = await Promise.all([
    db
      .from('table_sessions')
      .select('id, dining_table_id, status, is_approved')
      .eq('restaurant_id', restaurantId)
      .order('opened_at')
      .throwOnError(),
    db
      .from('orders')
      .select('id, session_id, round_number, status, client_device_id, created_at')
      .eq('restaurant_id', restaurantId)
      .order('created_at')
      .throwOnError(),
    db
      .from('order_items')
      .select(
        'id, order_id, item_name_snapshot, variant_name_snapshot, unit_price_paise, quantity, note, status',
      )
      .eq('restaurant_id', restaurantId)
      .order('item_name_snapshot')
      .throwOnError(),
  ]);
  return { sessions: sessions!, orders: orders!, items: items! };
}

/** Adds a dish without options from the menu page. */
export async function addDish(page: Page, name: string) {
  await page.getByRole('button', { name: `Add ${name}`, exact: true }).click();
}

/** Opens the cart from the sticky bar and places the order. */
export async function placeOrderFromMenu(page: Page) {
  await page.getByRole('link', { name: /View cart/ }).click();
  await expect(page.getByRole('heading', { name: 'Your order' })).toBeVisible();
  await page.getByRole('button', { name: 'Place order' }).click();
  await expect(page.getByRole('heading', { name: 'Your table’s orders' })).toBeVisible();
}
