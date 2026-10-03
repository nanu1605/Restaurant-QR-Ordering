import { randomUUID } from 'node:crypto';

import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test';

import { adminClient, createTestRestaurant, logInWithCode, TEST_PASSWORD } from '../e2e/helpers';
import { createStaffLogin, expectLive, placeCustomerOrder } from '../e2e/live-fixtures';
import { ownerClient } from '../e2e/report-fixtures';

/**
 * Screenshots of the real app for the website's features page
 * (docs/DECISIONS.md W-7), taken from a fresh sample restaurant on the local
 * stack: `pnpm site:shots` while `pnpm dev` runs (or SHOTS_BASE_URL is set).
 * Never run against staging or production: it creates a restaurant.
 */

const OUT = 'src/features/site/shots';

const MENU = [
  {
    category: 'Starters',
    categoryHi: 'स्टार्टर्स',
    items: [
      ['Paneer Tikka', 'पनीर टिक्का', 'veg', 28000, 'Cottage cheese and peppers from the tandoor'],
      ['Chicken 65', 'चिकन 65', 'non_veg', 32000, 'Spicy fried chicken with curry leaves'],
      ['Hara Bhara Kebab', 'हरा भरा कबाब', 'veg', 22000, 'Spinach and green pea patties'],
    ],
  },
  {
    category: 'Main course',
    categoryHi: 'मेन कोर्स',
    items: [
      ['Dal Makhani', 'दाल मखनी', 'veg', 24000, 'Black lentils slow-cooked with butter'],
      ['Butter Chicken', 'बटर चिकन', 'non_veg', 34000, 'Tandoori chicken in a tomato gravy'],
      ['Paneer Butter Masala', 'पनीर बटर मसाला', 'veg', 30000, 'Paneer in a rich tomato gravy'],
      ['Egg Curry', 'अंडा करी', 'egg', 20000, 'Boiled eggs in onion-tomato masala'],
    ],
  },
  {
    category: 'Breads',
    categoryHi: 'रोटियाँ',
    items: [
      ['Butter Naan', 'बटर नान', 'veg', 6000, null],
      ['Garlic Naan', 'गार्लिक नान', 'veg', 8000, null],
    ],
  },
  {
    category: 'Drinks',
    categoryHi: 'ड्रिंक्स',
    items: [
      ['Masala Chai', 'मसाला चाय', 'veg', 4000, null],
      ['Sweet Lassi', 'मीठी लस्सी', 'veg', 8000, null],
    ],
  },
] as const;

async function createSampleRestaurant() {
  const restaurant = await createTestRestaurant({ prefix: 'shots', cuisine: 'blank' });
  const db = adminClient();
  const id = restaurant.restaurantId;
  await db
    .from('restaurants')
    .update({
      name: 'Spice Route',
      address_line: '14 FC Road, Shivajinagar',
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '411005',
      gst_mode: 'regular',
      gst_rate_bps: 500,
      prices_include_tax: false,
      bill_footer_text: 'Thank you, visit again!',
      max_tables_per_waiter: 10,
      require_first_order_approval: false,
    })
    .eq('id', id)
    .throwOnError();

  const items: Record<string, string> = {};
  for (const [index, section] of MENU.entries()) {
    const { data: category } = await db
      .from('menu_categories')
      .insert({
        restaurant_id: id,
        name: section.category,
        name_hi: section.categoryHi,
        sort_order: index + 1,
      })
      .select('id')
      .single()
      .throwOnError();
    const { data: rows } = await db
      .from('menu_items')
      .insert(
        section.items.map(([name, nameHi, foodType, pricePaise, description], order) => ({
          restaurant_id: id,
          category_id: category!.id,
          name,
          name_hi: nameHi,
          food_type: foodType,
          price_paise: pricePaise,
          description,
          sort_order: order + 1,
          is_available: true,
        })),
      )
      .select('id, name')
      .throwOnError();
    for (const row of rows!) items[row.name] = row.id;
  }

  const { data: tables } = await db
    .from('dining_tables')
    .insert(
      Array.from({ length: 8 }, (_, index) => ({
        restaurant_id: id,
        label: String(index + 1),
        qr_token: randomUUID().replaceAll('-', '').slice(0, 16),
        sort_order: index + 1,
      })),
    )
    .select('id, label, qr_token')
    .throwOnError();
  const table = (label: string) => tables!.find((row) => row.label === label)!;

  await db
    .from('restaurant_members')
    .update({ display_name: 'Asha Verma' })
    .eq('user_id', restaurant.ownerUserId)
    .throwOnError();
  const ravi = await createStaffLogin({ restaurant }, 'ravi', 'waiter', 'Ravi Kumar');
  await createStaffLogin({ restaurant }, 'kitchen', 'kitchen', 'Kavita Rao');
  const { data: waiters } = await db
    .from('waiters')
    .insert([
      { restaurant_id: id, full_name: 'Ravi Kumar', member_id: ravi.memberId },
      { restaurant_id: id, full_name: 'Anita Das', member_id: null },
    ])
    .select('id, full_name')
    .throwOnError();
  const waiter = (name: string) => waiters!.find((row) => row.full_name.startsWith(name))!.id;

  return { restaurant, items, table, waiter };
}

type Sample = Awaited<ReturnType<typeof createSampleRestaurant>>;

/** A table with one round, its waiter, and each dish moved on to the given status. */
async function seat(
  sample: Sample,
  label: string,
  dishes: Array<
    [name: string, quantity: number, status: 'placed' | 'preparing' | 'ready' | 'served']
  >,
  waiter = 'Ravi',
) {
  const owner = await ownerClient({ slug: sample.restaurant.slug });
  const db = adminClient();
  const { token, id } = { token: sample.table(label).qr_token, id: sample.table(label).id };
  const order = await placeCustomerOrder(
    token,
    dishes.map(([name, quantity]) => ({ menu_item_id: sample.items[name]!, quantity })),
  );
  const { data: session } = await db
    .from('table_sessions')
    .select('id')
    .eq('dining_table_id', id)
    .eq('status', 'open')
    .single()
    .throwOnError();
  await owner
    .rpc('admin_assign_waiter', {
      p_session_id: session!.id,
      p_waiter_id: sample.waiter(waiter),
      p_force: true,
    })
    .throwOnError();
  const { data: rows } = await db
    .from('order_items')
    .select('id, menu_item_id')
    .eq('order_id', order.order_id)
    .throwOnError();
  const steps = ['preparing', 'ready', 'served'] as const;
  for (const [name, , status] of dishes) {
    const row = rows!.find((item) => item.menu_item_id === sample.items[name])!;
    for (const step of steps.slice(0, steps.indexOf(status as never) + 1)) {
      await owner
        .rpc('staff_update_item_status', { p_order_item_id: row.id, p_status: step })
        .throwOnError();
    }
  }
  return { owner, sessionId: session!.id, token };
}

/** Bills a served table and records its payment, as the counter would. */
async function payBill(
  owner: Awaited<ReturnType<typeof ownerClient>>,
  sessionId: string,
  mode: 'cash' | 'upi' | 'card',
) {
  const { data } = await owner
    .rpc('admin_generate_bill', {
      p_session_id: sessionId,
      p_discount_type: 'none',
      p_discount_value: 0,
      p_discount_reason: '',
      p_apply_service_charge: false,
    })
    .throwOnError();
  const bill = data as { bill_id: string; grand_total_paise: number };
  await owner
    .rpc('admin_record_payment', {
      p_bill_id: bill.bill_id,
      p_payments: [{ mode, amount_paise: bill.grand_total_paise, reference: null }],
    })
    .throwOnError();
  return bill.bill_id;
}

async function shoot(page: Page, name: string) {
  // Hides Next's dev badge.
  await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/${name}.jpg`, type: 'jpeg', quality: 82 });
}

async function staffScreen(
  browser: Browser,
  sample: Sample,
  username: string,
  path: string,
  viewport: { width: number; height: number },
): Promise<[BrowserContext, Page]> {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.goto('/login');
  await logInWithCode(page, sample.restaurant.slug, username, TEST_PASSWORD);
  await page.waitForURL(/\/(staff|admin)/);
  await page.goto(path);
  return [context, page];
}

test('website screenshots', async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  const sample = await createSampleRestaurant();

  // A busy floor: dishes at every stage, a guest calling, a table waiting for its bill.
  await seat(sample, '2', [
    ['Chicken 65', 1, 'served'],
    ['Butter Chicken', 1, 'ready'],
    ['Garlic Naan', 3, 'preparing'],
  ]);
  const four = await seat(sample, '4', [
    ['Hara Bhara Kebab', 1, 'served'],
    ['Paneer Butter Masala', 1, 'preparing'],
    ['Butter Naan', 2, 'placed'],
  ]);
  await adminClient()
    .rpc('customer_create_service_request', {
      p_qr_token: four.token,
      p_device_id: randomUUID(),
      p_type: 'call_waiter',
    })
    .throwOnError();
  await seat(
    sample,
    '6',
    [
      ['Egg Curry', 1, 'served'],
      ['Sweet Lassi', 2, 'served'],
    ],
    'Anita',
  );
  // Earlier tables, billed and paid, for the report.
  for (const [label, dishes, mode] of [
    [
      '1',
      [
        ['Butter Chicken', 1, 'served'],
        ['Garlic Naan', 2, 'served'],
      ],
      'cash',
    ],
    [
      '3',
      [
        ['Chicken 65', 2, 'served'],
        ['Sweet Lassi', 2, 'served'],
      ],
      'card',
    ],
    [
      '8',
      [
        ['Paneer Butter Masala', 1, 'served'],
        ['Butter Naan', 3, 'served'],
      ],
      'upi',
    ],
  ] as const) {
    const done = await seat(
      sample,
      label,
      dishes.map((dish) => [...dish]),
      'Anita',
    );
    await payBill(done.owner, done.sessionId, mode);
  }
  const seven = await seat(sample, '7', [
    ['Paneer Tikka', 1, 'served'],
    ['Dal Makhani', 1, 'served'],
    ['Butter Naan', 2, 'served'],
    ['Masala Chai', 2, 'served'],
  ]);
  const billId = await payBill(seven.owner, seven.sessionId, 'upi');

  // The guest at table 5 orders from their phone, in English and in Hindi.
  const phone = await browser.newContext({
    viewport: { width: 390, height: 823 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const guest = await phone.newPage();
  await guest.goto(`/t/${sample.table('5').qr_token}`);
  await expect(guest.getByRole('heading', { name: 'Starters' })).toBeVisible();
  await guest.getByRole('button', { name: 'Add Paneer Tikka', exact: true }).click();
  await guest.getByRole('button', { name: 'Add Butter Naan', exact: true }).click();
  await guest.getByRole('button', { name: 'Add Dal Makhani', exact: true }).click();
  await shoot(guest, 'guest-menu');
  await phone.addCookies([{ name: 'lang', value: 'hi', url: baseURL! }]);
  await guest.reload();
  await expect(guest.getByRole('heading', { name: 'स्टार्टर्स' })).toBeVisible();
  await shoot(guest, 'guest-menu-hindi');
  await phone.clearCookies({ name: 'lang' });
  await guest.reload();
  await guest.getByRole('link', { name: /View cart/ }).click();
  await guest.getByRole('button', { name: 'Place order' }).click();
  await expect(guest.getByRole('heading', { name: 'Your table’s orders' })).toBeVisible();
  const owner = await ownerClient({ slug: sample.restaurant.slug });
  const { data: session } = await adminClient()
    .from('table_sessions')
    .select('id')
    .eq('dining_table_id', sample.table('5').id)
    .eq('status', 'open')
    .single()
    .throwOnError();
  await owner
    .rpc('admin_assign_waiter', {
      p_session_id: session!.id,
      p_waiter_id: sample.waiter('Ravi'),
      p_force: true,
    })
    .throwOnError();
  const { data: fiveItems } = await adminClient()
    .from('order_items')
    .select('id, item_name_snapshot')
    .eq('session_id', session!.id)
    .throwOnError();
  const moves: Record<string, Array<'preparing' | 'ready'>> = {
    'Paneer Tikka': ['preparing', 'ready'],
    'Dal Makhani': ['preparing'],
  };
  for (const item of fiveItems!) {
    for (const step of moves[item.item_name_snapshot] ?? []) {
      await owner
        .rpc('staff_update_item_status', { p_order_item_id: item.id, p_status: step })
        .throwOnError();
    }
  }
  await guest.reload();
  await expect(guest.getByText('Ready')).toBeVisible();
  await shoot(guest, 'guest-orders');
  await phone.close();

  // The waiter's live board and the kitchen view, on tablets.
  const [boardContext, board] = await staffScreen(browser, sample, 'ravi', '/staff', {
    width: 1024,
    height: 768,
  });
  await expectLive(board);
  await board.getByRole('button', { name: /^All \d/ }).click();
  await shoot(board, 'staff-board');
  await boardContext.close();

  const [kitchenContext, kitchen] = await staffScreen(
    browser,
    sample,
    'kitchen',
    '/staff/kitchen',
    {
      width: 1024,
      height: 768,
    },
  );
  await expectLive(kitchen);
  await shoot(kitchen, 'kitchen');
  await kitchenContext.close();

  // The owner's bill and today's report, on a laptop.
  const [laptopContext, laptop] = await staffScreen(
    browser,
    sample,
    'owner',
    `/admin/bills/${billId}`,
    {
      width: 1280,
      height: 800,
    },
  );
  await expect(laptop.getByText('Thank you, visit again!')).toBeVisible();
  await shoot(laptop, 'bill');
  await laptop.goto('/admin/reports');
  await shoot(laptop, 'reports');
  await laptopContext.close();
});
