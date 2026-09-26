-- Menu add-ons (spec §8.4, §19 Phase 9; docs/DECISIONS.md P9-4): shared
-- groups managed by owners and managers, stock switched by any staff, choices
-- checked and priced by the database when customers and staff order, kept as
-- a snapshot on the dish, shown on the board and the orders page, and billed
-- as separate lines when they differ.
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ─── Fixtures ───────────────────────────────────────────────────────────────
select tests.create_restaurant('p9-420-a') as rest_a \gset
select tests.create_restaurant('p9-420-b') as rest_b \gset
select tests.add_member(:'rest_a', 'manager', 'a_manager') as a_manager \gset
select tests.add_member(:'rest_a', 'waiter', 'a_waiter') as a_waiter \gset
select tests.add_member(:'rest_a', 'kitchen', 'a_kitchen') as a_kitchen \gset
select tests.add_member(:'rest_b', 'manager', 'b_manager') as b_manager \gset
update public.restaurants set require_first_order_approval = false where id in (:'rest_a', :'rest_b');

select tests.create_ordering_fixture(:'rest_a', 'P9420A0000TABLE5') as fx \gset
select tests.create_ordering_fixture(:'rest_b', 'P9420B0000TABLE5') as fx_b \gset
select
  :'fx'::jsonb ->> 'table' as t5,
  :'fx'::jsonb ->> 'starters' as starters,
  :'fx'::jsonb ->> 'simple' as paneer,
  :'fx_b'::jsonb ->> 'starters' as b_starters
\gset

create function pg_temp.order_as_customer(p_items jsonb)
returns jsonb
language sql
as $$
  select public.customer_place_order(
    'P9420A0000TABLE5', gen_random_uuid()::text, 'k' || replace(gen_random_uuid()::text, '-', ''), p_items
  );
$$;

create function pg_temp.addon(p_group uuid, p_name text)
returns uuid
language sql
stable
as $$
  select id from public.menu_addons where group_id = p_group and name = p_name;
$$;

create function pg_temp.pizza_line(p_addon_ids jsonb, p_quantity int default 1)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'menu_item_id', (select id from public.menu_items where name = 'Pizza' and restaurant_id = r.id),
    'variant_id', (
      select v.id from public.menu_item_variants v
      join public.menu_items i on i.id = v.menu_item_id
      where i.name = 'Pizza' and i.restaurant_id = r.id and v.name = 'Large'
    ),
    'quantity', p_quantity,
    'addon_ids', p_addon_ids
  )
  from public.restaurants r where r.slug = 'p9-420-a';
$$;

-- ─── Managing groups ────────────────────────────────────────────────────────
select tests.authenticate_as(:'a_manager');
select public.admin_save_addon_group(jsonb_build_object(
  'name', 'Crust', 'min_select', 1, 'max_select', 1,
  'addons', jsonb_build_array(
    jsonb_build_object('name', 'Thin', 'price_paise', 0),
    jsonb_build_object('name', 'Cheese burst', 'price_paise', 8000)
  )
)) as crust \gset
select public.admin_save_addon_group(jsonb_build_object(
  'name', ' Toppings ', 'min_select', 0, 'max_select', 2,
  'addons', jsonb_build_array(
    jsonb_build_object('name', 'Olives', 'price_paise', 3000),
    jsonb_build_object('name', 'Jalapeño', 'price_paise', 4000),
    jsonb_build_object('name', 'Mushroom', 'price_paise', 5000)
  )
)) as toppings \gset
-- One transaction gives both groups the same created_at; Crust came first.
select tests.clear_auth();
update public.menu_addon_groups set created_at = created_at - interval '1 minute' where id = :'crust';
select tests.authenticate_as(:'a_manager');
select pg_temp.addon(:'crust', 'Thin') as thin, pg_temp.addon(:'crust', 'Cheese burst') as burst,
       pg_temp.addon(:'toppings', 'Olives') as olives, pg_temp.addon(:'toppings', 'Jalapeño') as jalapeno,
       pg_temp.addon(:'toppings', 'Mushroom') as mushroom
\gset

select is(
  (select jsonb_agg(jsonb_build_array(g.name, g.min_select, g.max_select) order by g.created_at)
   from public.menu_addon_groups g where g.restaurant_id = :'rest_a'),
  '[["Crust", 1, 1], ["Toppings", 0, 2]]'::jsonb,
  'groups are saved with tidy names and their choice rules'
);
select is(
  (select jsonb_agg(jsonb_build_array(a.name, a.price_paise, a.is_available) order by a.sort_order)
   from public.menu_addons a where a.group_id = :'toppings'),
  '[["Olives", 3000, true], ["Jalapeño", 4000, true], ["Mushroom", 5000, true]]'::jsonb,
  'options are saved in order and in stock'
);

select throws_ok(
  $$select public.admin_save_addon_group('{"name":"crust","min_select":0,"max_select":1,"addons":[{"name":"A","price_paise":0}]}')$$,
  'P0001', 'ADDON_GROUP_NAME_DUPLICATE',
  'group names are unique, ignoring case and spacing'
);
select throws_ok(
  $$select public.admin_save_addon_group('{"name":"Dips","min_select":0,"max_select":1,"addons":[{"name":"Mint","price_paise":0},{"name":" mint ","price_paise":100}]}')$$,
  'P0001', 'ADDON_NAME_DUPLICATE',
  'option names are unique within a group'
);
select throws_ok(
  $$select public.admin_save_addon_group('{"name":"Dips","min_select":2,"max_select":2,"addons":[{"name":"Mint","price_paise":0}]}')$$,
  'P0001', 'INVALID_INPUT',
  'a group cannot require more choices than it has options'
);
select throws_ok(
  $$select public.admin_save_addon_group('{"name":"Dips","min_select":2,"max_select":1,"addons":[{"name":"Mint","price_paise":0},{"name":"Garlic","price_paise":0}]}')$$,
  'P0001', 'INVALID_INPUT',
  'min_select cannot exceed max_select'
);
select throws_ok(
  $$select public.admin_save_addon_group('{"name":"Dips","min_select":0,"max_select":0,"addons":[{"name":"Mint","price_paise":0}]}')$$,
  'P0001', 'INVALID_INPUT',
  'a group allows at least one choice'
);
select throws_ok(
  $$select public.admin_save_addon_group('{"name":"Dips","min_select":0,"max_select":1,"addons":[]}')$$,
  'P0001', 'INVALID_INPUT',
  'a group has at least one option'
);
select throws_ok(
  $$select public.admin_save_addon_group('{"name":"Dips","min_select":0,"max_select":1,"addons":[{"name":"Mint","price_paise":-1}]}')$$,
  'P0001', 'INVALID_PRICE',
  'option prices are checked'
);
select throws_ok(
  $$select public.admin_save_addon_group('{"name":"  ","min_select":0,"max_select":1,"addons":[{"name":"Mint","price_paise":0}]}')$$,
  'P0001', 'INVALID_ADDON_GROUP_NAME',
  'a group needs a name'
);

-- Editing: renames and reorders options, keeps ids, deletes the missing one.
select public.admin_save_addon_group(jsonb_build_object(
  'id', :'toppings', 'name', 'Toppings', 'min_select', 0, 'max_select', 2,
  'addons', jsonb_build_array(
    jsonb_build_object('id', :'jalapeno', 'name', 'Jalapeño', 'price_paise', 4000),
    jsonb_build_object('id', :'olives', 'name', 'Black olives', 'price_paise', 3000),
    jsonb_build_object('id', :'mushroom', 'name', 'Mushroom', 'price_paise', 5000),
    jsonb_build_object('name', 'Onion', 'price_paise', 2000)
  )
));
select is(
  (select jsonb_agg(a.name order by a.sort_order) from public.menu_addons a where a.group_id = :'toppings'),
  '["Jalapeño", "Black olives", "Mushroom", "Onion"]'::jsonb,
  'editing renames, reorders and adds options, keeping their ids'
);
select public.admin_save_addon_group(jsonb_build_object(
  'id', :'toppings', 'name', 'Toppings', 'min_select', 0, 'max_select', 2,
  'addons', jsonb_build_array(
    jsonb_build_object('id', :'olives', 'name', 'Olives', 'price_paise', 3000),
    jsonb_build_object('id', :'jalapeno', 'name', 'Jalapeño', 'price_paise', 4000),
    jsonb_build_object('id', :'mushroom', 'name', 'Mushroom', 'price_paise', 5000)
  )
));
select is(
  (select count(*)::int from public.menu_addons a where a.group_id = :'toppings'),
  3,
  'an option left out of the list is deleted'
);

-- Dishes: Pizza (Regular / Large) with both groups, Garlic Bread with toppings.
select public.admin_save_menu_item(jsonb_build_object(
  'category_id', :'starters', 'name', 'Pizza', 'food_type', 'veg',
  'variants', jsonb_build_array(
    jsonb_build_object('name', 'Regular', 'price_paise', 20000),
    jsonb_build_object('name', 'Large', 'price_paise', 30000)
  ),
  'addon_group_ids', jsonb_build_array(:'toppings', :'crust')
)) as pizza \gset
select public.admin_save_menu_item(jsonb_build_object(
  'category_id', :'starters', 'name', 'Garlic Bread', 'food_type', 'veg', 'price_paise', 12000,
  'addon_group_ids', jsonb_build_array(:'toppings')
)) as bread \gset
select id as large from public.menu_item_variants where menu_item_id = :'pizza' and name = 'Large' \gset
select id as regular from public.menu_item_variants where menu_item_id = :'pizza' and name = 'Regular' \gset

select is(
  (select array_agg(l.group_id order by l.group_id) from public.menu_item_addon_groups l
   where l.menu_item_id = :'pizza'),
  (select array_agg(x order by x) from unnest(array[:'crust', :'toppings']::uuid[]) as x),
  'a dish is saved with its add-on groups'
);

select public.admin_save_menu_item(jsonb_build_object(
  'id', :'bread', 'category_id', :'starters', 'name', 'Garlic Bread', 'food_type', 'veg',
  'price_paise', 13000
));
select is(
  (select count(*)::int from public.menu_item_addon_groups where menu_item_id = :'bread'),
  1,
  'saving a dish without addon_group_ids leaves its groups alone'
);
select public.admin_save_menu_item(jsonb_build_object(
  'id', :'bread', 'category_id', :'starters', 'name', 'Garlic Bread', 'food_type', 'veg',
  'price_paise', 12000, 'addon_group_ids', '[]'::jsonb
));
select is(
  (select count(*)::int from public.menu_item_addon_groups where menu_item_id = :'bread'),
  0,
  'an empty list takes every group off the dish'
);
select public.admin_save_menu_item(jsonb_build_object(
  'id', :'bread', 'category_id', :'starters', 'name', 'Garlic Bread', 'food_type', 'veg',
  'price_paise', 12000, 'addon_group_ids', jsonb_build_array(:'toppings')
));

-- The other restaurant's group can't be attached.
select tests.authenticate_as(:'b_manager');
select public.admin_save_addon_group(
  '{"name":"Sauces","min_select":0,"max_select":1,"addons":[{"name":"Mayo","price_paise":1000}]}'
) as b_group \gset
select id as b_mayo from public.menu_addons where group_id = :'b_group' \gset
select tests.authenticate_as(:'a_manager');
select throws_ok(
  format(
    $f$select public.admin_save_menu_item(jsonb_build_object(
      'id', %L, 'category_id', %L, 'name', 'Garlic Bread', 'food_type', 'veg',
      'price_paise', 12000, 'addon_group_ids', jsonb_build_array(%L)))$f$,
    :'bread', :'starters', :'b_group'
  ),
  'P0001', 'NOT_FOUND',
  'a dish cannot use another restaurant''s group'
);
select throws_ok(
  format(
    $f$select public.admin_save_addon_group(jsonb_build_object(
      'id', %L, 'name', 'Sauces', 'min_select', 0, 'max_select', 1,
      'addons', jsonb_build_array(jsonb_build_object('name', 'Mayo', 'price_paise', 0))))$f$,
    :'b_group'
  ),
  'P0001', 'NOT_FOUND',
  'nor edit it'
);
select throws_ok(
  format($f$select public.admin_delete_addon_group(%L)$f$, :'b_group'),
  'P0001', 'NOT_FOUND',
  'nor delete it'
);
select throws_ok(
  format(
    $f$select public.admin_save_addon_group(jsonb_build_object(
      'id', %L, 'name', 'Toppings', 'min_select', 0, 'max_select', 2,
      'addons', jsonb_build_array(jsonb_build_object('id', %L, 'name', 'Mayo', 'price_paise', 0))))$f$,
    :'toppings', :'b_mayo'
  ),
  'P0001', 'NOT_FOUND',
  'nor move its options into a group'
);
select throws_ok(
  format(
    $f$select public.admin_save_addon_group(jsonb_build_object(
      'id', %L, 'name', 'Crust', 'min_select', 2, 'max_select', 2,
      'addons', jsonb_build_array(
        jsonb_build_object('id', %L, 'name', 'Thin', 'price_paise', 0),
        jsonb_build_object('id', %L, 'name', 'Thin two', 'price_paise', 0))))$f$,
    :'crust', :'thin', :'thin'
  ),
  'P0001', 'INVALID_INPUT',
  'the same option cannot appear twice (it would leave fewer options than min_select)'
);

select tests.authenticate_as(:'a_waiter');
select throws_ok(
  $$select public.admin_save_addon_group('{"name":"Dips","min_select":0,"max_select":1,"addons":[{"name":"Mint","price_paise":0}]}')$$,
  'P0001', 'FORBIDDEN',
  'waiters cannot manage add-ons'
);

-- ─── The customer menu ──────────────────────────────────────────────────────
select tests.as_service_role();
select public.customer_get_table('P9420A0000TABLE5') as menu \gset
select is(
  (select jsonb_agg(g -> 'name') from jsonb_array_elements(:'menu'::jsonb -> 'addon_groups') g),
  '["Crust", "Toppings"]'::jsonb,
  'the menu sends the groups its dishes use, once, oldest first'
);
select is(
  (select jsonb_agg(jsonb_build_array(a ->> 'name', (a ->> 'price_paise')::int))
   from jsonb_array_elements(:'menu'::jsonb -> 'addon_groups' -> 0 -> 'addons') a),
  '[["Thin", 0], ["Cheese burst", 8000]]'::jsonb,
  'with their options in order'
);
select is(
  (select i -> 'addon_group_ids'
   from jsonb_array_elements(:'menu'::jsonb -> 'menu') c, jsonb_array_elements(c -> 'items') i
   where i ->> 'name' = 'Pizza'),
  jsonb_build_array(:'crust', :'toppings'),
  'each dish lists its groups in group order'
);
select is(
  (select i -> 'addon_group_ids'
   from jsonb_array_elements(:'menu'::jsonb -> 'menu') c, jsonb_array_elements(c -> 'items') i
   where i ->> 'name' = 'Paneer Tikka'),
  '[]'::jsonb,
  'dishes without add-ons list none'
);

-- ─── Ordering ───────────────────────────────────────────────────────────────
select pg_temp.order_as_customer(jsonb_build_array(
  pg_temp.pizza_line(jsonb_build_array(:'jalapeno', :'burst', :'olives'), 2)
)) ->> 'order_id' as order1 \gset
select is(
  (select jsonb_build_object('price', unit_price_paise, 'qty', quantity, 'addons', addons_snapshot)
   from public.order_items where order_id = :'order1'),
  jsonb_build_object(
    'price', 45000,
    'qty', 2,
    'addons', jsonb_build_array(
      jsonb_build_object('id', :'burst', 'group', 'Crust', 'name', 'Cheese burst', 'price_paise', 8000),
      jsonb_build_object('id', :'olives', 'group', 'Toppings', 'name', 'Olives', 'price_paise', 3000),
      jsonb_build_object('id', :'jalapeno', 'group', 'Toppings', 'name', 'Jalapeño', 'price_paise', 4000)
    )
  ),
  'the unit price adds the add-ons to the option price, snapshotted in group and option order'
);

select throws_ok(
  format($f$select pg_temp.order_as_customer(jsonb_build_array(pg_temp.pizza_line(jsonb_build_array(%L))))$f$, :'olives'),
  'P0001', 'ITEM_UNAVAILABLE',
  'a required group left out'
);
select throws_ok(
  format(
    $f$select pg_temp.order_as_customer(jsonb_build_array(pg_temp.pizza_line(jsonb_build_array(%L, %L))))$f$,
    :'thin', :'burst'
  ),
  'P0001', 'ITEM_UNAVAILABLE',
  'too many choices in a group'
);
select throws_ok(
  format(
    $f$select pg_temp.order_as_customer(jsonb_build_array(pg_temp.pizza_line(jsonb_build_array(%L, %L, %L, %L))))$f$,
    :'thin', :'olives', :'jalapeno', :'mushroom'
  ),
  'P0001', 'ITEM_UNAVAILABLE',
  'more toppings than the group allows'
);
select throws_ok(
  format(
    $f$select pg_temp.order_as_customer(jsonb_build_array(jsonb_build_object(
      'menu_item_id', %L, 'quantity', 1, 'addon_ids', jsonb_build_array(%L))))$f$,
    :'bread', :'thin'
  ),
  'P0001', 'ITEM_UNAVAILABLE',
  'an option from a group the dish doesn''t have'
);
select throws_ok(
  format(
    $f$select pg_temp.order_as_customer(jsonb_build_array(jsonb_build_object(
      'menu_item_id', %L, 'quantity', 1, 'addon_ids', jsonb_build_array(%L))))$f$,
    :'bread', :'b_mayo'
  ),
  'P0001', 'ITEM_UNAVAILABLE',
  'another restaurant''s option'
);
select throws_ok(
  format(
    $f$select pg_temp.order_as_customer(jsonb_build_array(jsonb_build_object(
      'menu_item_id', %L, 'quantity', 1, 'addon_ids', jsonb_build_array(%L))))$f$,
    :'paneer', :'olives'
  ),
  'P0001', 'ITEM_UNAVAILABLE',
  'add-ons on a dish that has none'
);
select throws_ok(
  format(
    $f$select pg_temp.order_as_customer(jsonb_build_array(pg_temp.pizza_line(jsonb_build_array(%L, %L))))$f$,
    :'thin', :'thin'
  ),
  'P0001', 'INVALID_INPUT',
  'the same option twice'
);
select throws_ok(
  $$select pg_temp.order_as_customer(jsonb_build_array(pg_temp.pizza_line('["thin"]')))$$,
  'P0001', 'INVALID_INPUT',
  'ids must be uuids'
);
select throws_ok(
  $$select pg_temp.order_as_customer(jsonb_build_array(pg_temp.pizza_line('{"a":1}')))$$,
  'P0001', 'INVALID_INPUT',
  'addon_ids must be a list'
);
select throws_ok(
  $$select pg_temp.order_as_customer(jsonb_build_array(pg_temp.pizza_line(
    (select jsonb_agg(gen_random_uuid()) from generate_series(1, 21)))))$$,
  'P0001', 'INVALID_INPUT',
  'at most 20 add-ons per dish'
);
select lives_ok(
  format(
    $f$select pg_temp.order_as_customer(jsonb_build_array(
      jsonb_build_object('menu_item_id', %L, 'quantity', 1),
      jsonb_build_object('menu_item_id', %L, 'quantity', 1, 'addon_ids', null)))$f$,
    :'bread', :'paneer'
  ),
  'optional groups can be skipped, and lines without addon_ids still work'
);

-- Out of stock: any staff role, while read-only too.
select tests.authenticate_as(:'a_kitchen');
select lives_ok(
  format($f$select public.staff_set_addon_availability(%L, false)$f$, :'mushroom'),
  'the kitchen switches an option out of stock'
);
select throws_ok(
  format($f$select public.staff_set_addon_availability(%L, false)$f$, :'b_mayo'),
  'P0001', 'NOT_FOUND',
  'but not another restaurant''s'
);
select tests.as_service_role();
select throws_ok(
  format(
    $f$select pg_temp.order_as_customer(jsonb_build_array(pg_temp.pizza_line(jsonb_build_array(%L, %L))))$f$,
    :'thin', :'mushroom'
  ),
  'P0001', 'ITEM_UNAVAILABLE',
  'an out-of-stock option cannot be ordered'
);
select is(
  (select a -> 'is_available'
   from jsonb_array_elements(public.customer_get_table('P9420A0000TABLE5') -> 'addon_groups') g,
        jsonb_array_elements(g -> 'addons') a
   where a ->> 'name' = 'Mushroom'),
  'false'::jsonb,
  'the menu flags it'
);

-- Staff orders follow the same rules.
select tests.authenticate_as(:'a_waiter');
select throws_ok(
  format(
    $f$select public.staff_place_order(%L, jsonb_build_array(pg_temp.pizza_line(jsonb_build_array(%L))), 'p9-420-staff-1')$f$,
    :'t5', :'olives'
  ),
  'P0001', 'ITEM_UNAVAILABLE',
  'staff must choose the required crust too'
);
select public.staff_place_order(
  :'t5', jsonb_build_array(pg_temp.pizza_line(jsonb_build_array(:'olives', :'burst', :'jalapeno'))),
  'p9-420-staff-2'
) ->> 'order_id' as order2 \gset
select public.staff_place_order(
  :'t5', jsonb_build_array(pg_temp.pizza_line(jsonb_build_array(:'thin'))), 'p9-420-staff-3'
) ->> 'order_id' as order3 \gset
select is(
  (select unit_price_paise from public.order_items where order_id = :'order3'),
  30000::bigint,
  'a free option adds nothing'
);

-- The crust group is renamed between rounds; the same pizza is ordered again.
select tests.authenticate_as(:'a_manager');
select public.admin_save_addon_group(jsonb_build_object(
  'id', :'crust', 'name', 'Base', 'min_select', 1, 'max_select', 1,
  'addons', jsonb_build_array(
    jsonb_build_object('id', :'thin', 'name', 'Thin', 'price_paise', 0),
    jsonb_build_object('id', :'burst', 'name', 'Cheese burst', 'price_paise', 8000)
  )
));
select tests.authenticate_as(:'a_waiter');
select public.staff_place_order(
  :'t5', jsonb_build_array(pg_temp.pizza_line(jsonb_build_array(:'burst', :'olives', :'jalapeno'))),
  'p9-420-staff-4'
) ->> 'order_id' as order4 \gset
select is(
  (select addons_snapshot -> 0 ->> 'group' from public.order_items where order_id = :'order4'),
  'Base',
  'the snapshot keeps the group name at order time'
);

-- ─── What staff and customers see ───────────────────────────────────────────
select is(
  (select i -> 'addons'
   from jsonb_array_elements(public.staff_get_board() -> 'tables') t,
        jsonb_array_elements(t -> 'session' -> 'rounds') r,
        jsonb_array_elements(r -> 'items') i
   where r ->> 'id' = :'order1'),
  '["Cheese burst", "Olives", "Jalapeño"]'::jsonb,
  'the board shows the add-on names'
);
select tests.as_service_role();
select is(
  (select i -> 'addons'
   from jsonb_array_elements(public.customer_get_session('P9420A0000TABLE5') -> 'session' -> 'rounds') r,
        jsonb_array_elements(r -> 'items') i
   where r ->> 'id' = :'order3'),
  '["Thin"]'::jsonb,
  'so does the customer''s orders page'
);

-- ─── Bills ──────────────────────────────────────────────────────────────────
select tests.clear_auth();
select id as session from public.table_sessions where dining_table_id = :'t5' and status = 'open' \gset
select is(
  (select jsonb_agg(jsonb_build_array(l -> 'addons', (l ->> 'qty')::int, (l ->> 'line_total_paise')::int))
   from jsonb_array_elements(private.bill_lines(:'rest_a', :'session')) l
   where l ->> 'name' = 'Pizza'),
  '[[["Cheese burst", "Olives", "Jalapeño"], 4, 180000], [["Thin"], 1, 30000]]'::jsonb,
  'the same add-ons merge across rounds (a renamed group too), different ones get their own line'
);

-- An option deleted after assert_orderable checked it: the dish is refused,
-- never saved without it.
select throws_ok(
  format(
    $f$select private.insert_order_items(%L, %L, %L, jsonb_build_array(jsonb_build_object(
      'menu_item_id', %L, 'variant_id', %L, 'quantity', 1, 'note', null,
      'addon_ids', jsonb_build_array(%L, gen_random_uuid()))))$f$,
    :'rest_a', :'order1', :'session', :'pizza', :'large', :'burst'
  ),
  'P0001', 'ITEM_UNAVAILABLE',
  'an add-on gone before the insert refuses the dish'
);

-- ─── Deleting a group ───────────────────────────────────────────────────────
select tests.authenticate_as(:'a_manager');
select public.admin_delete_addon_group(:'toppings');
select is(
  (select count(*)::int from public.menu_addons where group_id = :'toppings')
    + (select count(*)::int from public.menu_item_addon_groups where group_id = :'toppings'),
  0,
  'deleting a group removes its options and takes it off every dish'
);
select tests.clear_auth();
select is(
  (select jsonb_array_length(addons_snapshot) from public.order_items where order_id = :'order1'),
  3,
  'orders keep their add-ons'
);
select is(
  (select l -> 'addons'
   from jsonb_array_elements(private.bill_lines(:'rest_a', :'session')) l
   where (l ->> 'qty')::int = 4),
  '["Cheese burst", "Olives", "Jalapeño"]'::jsonb,
  'and the bill still names them'
);

-- ─── Read-only ──────────────────────────────────────────────────────────────
select tests.suspend(:'rest_a');
select tests.authenticate_as(:'a_manager');
select throws_ok(
  $$select public.admin_save_addon_group('{"name":"Dips","min_select":0,"max_select":1,"addons":[{"name":"Mint","price_paise":0}]}')$$,
  'P0001', 'RESTAURANT_READ_ONLY',
  'groups cannot change while read-only'
);
select throws_ok(
  format($f$select public.admin_delete_addon_group(%L)$f$, :'crust'),
  'P0001', 'RESTAURANT_READ_ONLY',
  'nor be deleted'
);
select lives_ok(
  format($f$select public.staff_set_addon_availability(%L, false)$f$, :'burst'),
  'stock can still be switched'
);

select * from finish();

rollback;
