import { expect, test } from '@playwright/test';

import { adminClient } from './helpers';
import {
  createLiveRestaurant,
  openCustomerPhone,
  openLiveScreen,
  tableCard,
} from './live-fixtures';

// Menu add-ons (spec §19 Phase 9; docs/DECISIONS.md P9-4): the owner builds a
// shared group and attaches it to a dish, the customer picks add-ons, and the
// waiter, kitchen and bill all show them at the right price. Staff orders obey
// the same rules, and stock is switched per option.

test('an owner sets up add-ons, a customer orders them, staff and the bill show them', async ({
  browser,
  baseURL,
}) => {
  const r = await createLiveRestaurant({ approval: false });
  const owner = await openLiveScreen(browser, r, 'owner', '/admin/menu', baseURL!);

  // 1. A shared group, attached from the dish form.
  const addons = owner.page.getByRole('region', { name: 'Add-ons' });
  await addons.getByRole('button', { name: 'New add-on group' }).click();
  const groupDialog = owner.page.getByRole('dialog', { name: 'New add-on group' });
  await groupDialog.getByLabel('Group name').fill('Extra toppings');
  await groupDialog.getByLabel('Customers must choose at least').fill('0');
  await groupDialog.getByLabel('And at most').fill('2');
  await groupDialog.getByLabel('Add-on 1 name').fill('Extra cheese');
  await groupDialog.getByLabel('Add-on 1 price in rupees').fill('40');
  await groupDialog.getByLabel('Add-on 2 name').fill('Olives');
  await groupDialog.getByLabel('Add-on 2 price in rupees').fill('30');
  await groupDialog.getByRole('button', { name: 'Add group' }).click();
  await expect(groupDialog).toBeHidden();
  await expect(addons).toContainText('Extra toppings · Optional, up to 2 · on 0 dishes');

  await owner.page.getByRole('button', { name: 'Edit Paneer Tikka' }).click();
  const dishDialog = owner.page.getByRole('dialog', { name: 'Edit Paneer Tikka' });
  await dishDialog.getByRole('checkbox', { name: /^Extra toppings/ }).check();
  await dishDialog.getByRole('button', { name: 'Save dish' }).click();
  await expect(dishDialog).toBeHidden();
  await expect(addons).toContainText('on 1 dish');

  // 2. The customer picks both add-ons: ₹280 + ₹40 + ₹30.
  const phone = await openCustomerPhone(browser, r.tables['3']!.url, baseURL!);
  await phone.page.getByRole('button', { name: 'Add Paneer Tikka' }).click();
  const sheet = phone.page.getByRole('dialog', { name: 'Paneer Tikka' });
  await expect(
    sheet.getByRole('group', { name: /^Extra toppings · Optional, up to 2/ }),
  ).toBeVisible();
  await sheet.getByRole('checkbox', { name: /Extra cheese/ }).check();
  await sheet.getByRole('checkbox', { name: /Olives/ }).check();
  await sheet.getByRole('button', { name: 'Add to cart · ₹350' }).click();
  await expect(sheet).toBeHidden();
  await phone.page.getByRole('link', { name: /View cart/ }).click();
  await expect(phone.page.getByText('+ Extra cheese, Olives')).toBeVisible();
  await phone.page.getByRole('button', { name: 'Place order' }).click();
  await expect(phone.page.getByText('1 × Paneer Tikka + Extra cheese, Olives')).toBeVisible();

  const { data: items } = await adminClient()
    .from('order_items')
    .select('unit_price_paise, addons_snapshot')
    .eq('restaurant_id', r.restaurantId)
    .throwOnError();
  expect(items).toMatchObject([
    {
      unit_price_paise: 35000,
      addons_snapshot: [
        { group: 'Extra toppings', name: 'Extra cheese', price_paise: 4000 },
        { group: 'Extra toppings', name: 'Olives', price_paise: 3000 },
      ],
    },
  ]);

  // 3. The waiter, the kitchen and the bill.
  const ravi = await openLiveScreen(browser, r, 'ravi', '/staff', baseURL!);
  await ravi.page.getByRole('button', { name: /^All \d/ }).click();
  await tableCard(ravi.page, '3').click();
  await expect(ravi.page.getByRole('dialog', { name: /^Table 3/ })).toContainText(
    '+ Extra cheese, Olives',
  );
  const kitchen = await openLiveScreen(browser, r, 'kitchen', '/staff/kitchen', baseURL!);
  await expect(kitchen.page.getByRole('article', { name: 'Table 3, round 1' })).toContainText(
    '1 × Paneer Tikka+ Extra cheese, Olives',
  );

  await owner.page.goto('/admin/billing');
  await owner.page.getByRole('link', { name: 'Bill Table 3' }).click();
  const bill = owner.page.getByRole('region', { name: 'Bill for Table 3' });
  await expect(owner.page.getByRole('main')).toContainText('Paneer Tikka + Extra cheese, Olives');
  await expect(bill).toContainText('Grand total₹350.00');

  await Promise.all([phone, ravi, kitchen, owner].map((s) => s.context.close()));
});

test('staff choose a required add-on, and stock is switched per option', async ({
  browser,
  baseURL,
}) => {
  const r = await createLiveRestaurant({ approval: false });
  const db = adminClient();
  const { data: group } = await db
    .from('menu_addon_groups')
    .insert({ restaurant_id: r.restaurantId, name: 'Crust', min_select: 1, max_select: 1 })
    .select('id')
    .single()
    .throwOnError();
  await db
    .from('menu_addons')
    .insert([
      {
        restaurant_id: r.restaurantId,
        group_id: group!.id,
        name: 'Thin',
        price_paise: 0,
        sort_order: 1,
      },
      {
        restaurant_id: r.restaurantId,
        group_id: group!.id,
        name: 'Cheese burst',
        price_paise: 8000,
        sort_order: 2,
      },
    ])
    .throwOnError();
  await db
    .from('menu_item_addon_groups')
    .insert({ restaurant_id: r.restaurantId, menu_item_id: r.item.paneer, group_id: group!.id })
    .throwOnError();

  const ravi = await openLiveScreen(browser, r, 'ravi', '/staff', baseURL!);
  await ravi.page.getByRole('button', { name: /^All \d/ }).click();
  await tableCard(ravi.page, '4').click();
  await ravi.page
    .getByRole('dialog', { name: /^Table 4/ })
    .getByRole('button', { name: 'Add order' })
    .click();
  const picker = ravi.page.getByRole('dialog', { name: 'Add order · Table 4' });
  await picker.getByRole('button', { name: 'Choose Paneer Tikka' }).click();
  const sheet = ravi.page.getByRole('dialog', { name: 'Paneer Tikka' });
  await expect(sheet.getByText('Choose 1 from Crust.')).toBeVisible();
  await expect(sheet.getByRole('button', { name: /^Add to round/ })).toBeDisabled();
  await sheet.getByRole('radio', { name: /Cheese burst/ }).check();
  await sheet.getByRole('button', { name: 'Add to round · ₹360' }).click();
  await expect(sheet).toBeHidden();
  await expect(picker.getByRole('list', { name: 'This round' })).toContainText(
    'Paneer Tikka + Cheese burst',
  );
  await picker.getByRole('button', { name: 'Place order' }).click();
  await expect(picker).toBeHidden();

  const { data: items } = await db
    .from('order_items')
    .select('unit_price_paise')
    .eq('restaurant_id', r.restaurantId)
    .throwOnError();
  expect(items).toEqual([{ unit_price_paise: 36000 }]);

  // A customer has a thin and a cheese burst Paneer Tikka in the cart when the
  // kitchen runs out of thin crust: only that line leaves the cart.
  const phone = await openCustomerPhone(browser, r.tables['3']!.url, baseURL!);
  for (const crust of ['Thin', 'Cheese burst']) {
    await phone.page.getByRole('button', { name: 'Add Paneer Tikka' }).click();
    const options = phone.page.getByRole('dialog', { name: 'Paneer Tikka' });
    await options.getByRole('radio', { name: new RegExp(crust) }).check();
    await options.getByRole('button', { name: /^Add to cart/ }).click();
    await expect(options).toBeHidden();
  }
  await phone.page.getByRole('link', { name: /View cart/ }).click();

  const kitchen = await openLiveScreen(browser, r, 'kitchen', '/staff/availability', baseURL!);
  await kitchen.page.getByRole('switch', { name: 'Thin in stock' }).click();
  await expect(kitchen.page.getByText('Thin is out of stock')).toBeVisible();

  await phone.page.getByRole('button', { name: 'Place order' }).click();
  await expect(
    phone.page.getByText(
      'Paneer Tikka + Thin is no longer available, so we removed it from your cart.',
    ),
  ).toBeVisible();
  await expect(phone.page.getByText('+ Cheese burst', { exact: true })).toBeVisible();
  await expect(phone.page.getByText('+ Thin', { exact: true })).toBeHidden();
  await phone.page.goto(r.tables['3']!.url);
  await phone.page.getByRole('button', { name: 'Add Paneer Tikka' }).click();
  await expect(phone.page.getByRole('radio', { name: /Thin · Not available/ })).toBeDisabled();

  await Promise.all([phone, ravi, kitchen].map((s) => s.context.close()));
});
