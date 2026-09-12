-- Menu management functions (spec §13.3 Menu, docs/DECISIONS.md P2-3, P2-8, P2-9).
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

select tests.create_restaurant('alpha') as rest_a \gset
select tests.create_restaurant('bravo') as rest_b \gset
select tests.add_member(:'rest_a', 'manager', 'a_manager') as a_manager \gset
select tests.add_member(:'rest_a', 'waiter', 'a_waiter') as a_waiter \gset
select tests.add_member(:'rest_a', 'kitchen', 'a_kitchen') as a_kitchen \gset

insert into public.menu_categories (restaurant_id, name) values (:'rest_b', 'Bravo Specials')
  returning id as b_cat \gset
insert into public.menu_items (restaurant_id, category_id, name, price_paise, food_type)
  values (:'rest_b', :'b_cat', 'Bravo Burger', 19900, 'non_veg')
  returning id as b_item \gset

select tests.authenticate_as(:'a_manager');

-- ─── Categories ─────────────────────────────────────────────────────────────
select public.admin_create_category('Starters') as starters \gset
select public.admin_create_category('  Jain   Special ') as jain \gset

select is(
  (select name from public.menu_categories where id = :'jain'),
  'Jain Special',
  'category names are trimmed and single-spaced'
);
select is(
  (select sort_order from public.menu_categories where id = :'jain'),
  2,
  'a new category goes to the end'
);
select throws_ok(
  $$ select public.admin_create_category('jain SPECIAL') $$,
  'P0001', 'CATEGORY_NAME_TAKEN',
  'category names are unique ignoring case and spacing'
);
select throws_ok(
  $$ select public.admin_create_category('   ') $$,
  'P0001', 'INVALID_CATEGORY_NAME',
  'a blank category name is rejected'
);

-- Suggested categories (a default set) skip names that already exist.
select is(
  public.admin_add_categories(array['Soups', 'STARTERS', 'Desserts', 'soups ']),
  2,
  'adding a suggested set adds only the missing names'
);
select results_eq(
  $$ select name, source::text from public.menu_categories order by sort_order $$,
  $$ values ('Starters', 'manual'), ('Jain Special', 'manual'), ('Soups', 'default'), ('Desserts', 'default') $$,
  'suggested categories are appended in set order and marked default'
);

select lives_ok(
  format($f$ select public.admin_update_category(%L, '{"is_active": false}') $f$, :'jain'),
  'a category can be hidden'
);
select is((select is_active from public.menu_categories where id = :'jain'), false, 'hidden');
select lives_ok(
  format($f$ select public.admin_update_category(%L, '{"is_active": true, "name": "Jain Specials"}') $f$, :'jain'),
  'shown again and renamed'
);
select throws_ok(
  format($f$ select public.admin_update_category(%L, '{"name": "soups"}') $f$, :'jain'),
  'P0001', 'CATEGORY_NAME_TAKEN',
  'renaming into an existing name is rejected'
);
select throws_ok(
  format($f$ select public.admin_update_category(%L, '{"colour": "red"}') $f$, :'jain'),
  'P0001', 'INVALID_INPUT',
  'unknown keys are rejected'
);
select throws_ok(
  format($f$ select public.admin_update_category(%L, '{"is_active": "no"}') $f$, :'jain'),
  'P0001', 'INVALID_INPUT',
  'wrong types are rejected'
);
select throws_ok(
  format($f$ select public.admin_update_category(%L, '{"name": "Mine now"}') $f$, :'b_cat'),
  'P0001', 'NOT_FOUND',
  'another restaurant''s category is not found'
);

-- ─── Items and variants ─────────────────────────────────────────────────────
select public.admin_save_menu_item(jsonb_build_object(
  'category_id', :'jain', 'name', ' Jain  Pav Bhaji ', 'food_type', 'veg',
  'price_paise', 15000, 'description', '  No onion or garlic  '
)) as pav \gset

select results_eq(
  format(
    $f$ select name, price_paise, description, is_available, is_active, sort_order
        from public.menu_items where id = %L $f$,
    :'pav'
  ),
  $$ values ('Jain Pav Bhaji', 15000::bigint, 'No onion or garlic', true, true, 1) $$,
  'an item is created with tidied text'
);

select public.admin_save_menu_item(jsonb_build_object(
  'id', '11111111-1111-4111-8111-111111111111',
  'category_id', :'jain', 'name', 'Thali', 'food_type', 'veg',
  'image_path', :'rest_a' || '/11111111-1111-4111-8111-111111111111.webp',
  'variants', jsonb_build_array(
    jsonb_build_object('name', 'Half', 'price_paise', 20000),
    jsonb_build_object('name', 'Full', 'price_paise', 30000)
  )
)) as thali \gset

select is(
  :'thali'::uuid,
  '11111111-1111-4111-8111-111111111111'::uuid,
  'a new item can use the id the browser picked'
);
select is(
  (select price_paise from public.menu_items where id = :'thali'),
  20000::bigint,
  'with variants the item price is the lowest variant price'
);
select results_eq(
  format(
    $f$ select name, price_paise, sort_order, is_active from public.menu_item_variants
        where menu_item_id = %L order by sort_order $f$,
    :'thali'
  ),
  $$ values ('Half', 20000::bigint, 1, true), ('Full', 30000::bigint, 2, true) $$,
  'variants are stored in the given order'
);

select id as full_variant from public.menu_item_variants where menu_item_id = :'thali' and name = 'Full' \gset

select lives_ok(
  format(
    $f$ select public.admin_save_menu_item(%L::jsonb) $f$,
    jsonb_build_object(
      'id', :'thali', 'category_id', :'jain', 'name', 'Thali', 'food_type', 'veg',
      'image_path', :'rest_a' || '/11111111-1111-4111-8111-111111111111.webp',
      'variants', jsonb_build_array(
        jsonb_build_object('id', :'full_variant', 'name', 'Large', 'price_paise', 35000),
        jsonb_build_object('name', 'Regular', 'price_paise', 25000)
      )
    )
  ),
  'variants can be renamed, added and removed in one save'
);
select results_eq(
  format(
    $f$ select name, price_paise, is_active from public.menu_item_variants
        where menu_item_id = %L order by is_active desc, sort_order $f$,
    :'thali'
  ),
  $$ values ('Large', 35000::bigint, true), ('Regular', 25000::bigint, true), ('Half', 20000::bigint, false) $$,
  'a removed variant is kept but deactivated (order history may point at it)'
);
select is(
  (select price_paise from public.menu_items where id = :'thali'),
  25000::bigint,
  'the item price follows the cheapest active variant'
);

select throws_ok(
  format($f$ select public.admin_save_menu_item(%L::jsonb) $f$, jsonb_build_object(
    'category_id', :'jain', 'name', 'Dosa', 'food_type', 'veg',
    'variants', jsonb_build_array(
      jsonb_build_object('name', 'Half', 'price_paise', 100),
      jsonb_build_object('name', ' half ', 'price_paise', 200)
    )
  )),
  'P0001', 'VARIANT_NAME_DUPLICATE',
  'variant names are unique within an item'
);
select throws_ok(
  format($f$ select public.admin_save_menu_item(%L::jsonb) $f$, jsonb_build_object(
    'category_id', :'jain', 'name', 'Free lunch', 'food_type', 'veg', 'price_paise', -1
  )),
  'P0001', 'INVALID_PRICE',
  'negative prices are rejected'
);
select throws_ok(
  format($f$ select public.admin_save_menu_item(%L::jsonb) $f$, jsonb_build_object(
    'category_id', :'jain', 'name', 'Half rupee', 'food_type', 'veg', 'price_paise', 10.5
  )),
  'P0001', 'INVALID_INPUT',
  'prices must be whole paise'
);
select throws_ok(
  format($f$ select public.admin_save_menu_item(%L::jsonb) $f$, jsonb_build_object(
    'category_id', :'jain', 'name', 'Tofu', 'food_type', 'vegan', 'price_paise', 100
  )),
  'P0001', 'INVALID_INPUT',
  'unknown food types are rejected'
);
select throws_ok(
  format($f$ select public.admin_save_menu_item(%L::jsonb) $f$, jsonb_build_object(
    'category_id', :'b_cat', 'name', 'Sneaky', 'food_type', 'veg', 'price_paise', 100
  )),
  'P0001', 'NOT_FOUND',
  'items cannot be put in another restaurant''s category'
);
select throws_ok(
  format($f$ select public.admin_save_menu_item(%L::jsonb) $f$, jsonb_build_object(
    'id', :'b_item', 'category_id', :'jain', 'name', 'Stolen', 'food_type', 'veg', 'price_paise', 100
  )),
  'P0001', 'NOT_FOUND',
  'another restaurant''s item cannot be overwritten'
);
select throws_ok(
  format($f$ select public.admin_save_menu_item(%L::jsonb) $f$, jsonb_build_object(
    'category_id', :'jain', 'name', 'Pic', 'food_type', 'veg', 'price_paise', 100,
    'image_path', :'rest_b' || '/pic.webp'
  )),
  'P0001', 'INVALID_IMAGE_PATH',
  'image paths must be inside the restaurant''s own folder'
);

-- Quick edits.
select throws_ok(
  format($f$ select public.admin_update_menu_item(%L, '{"price_paise": 100}') $f$, :'thali'),
  'P0001', 'ITEM_HAS_VARIANTS',
  'items with variants are priced through their variants'
);
select lives_ok(
  format($f$ select public.admin_update_menu_item(%L, '{"price_paise": 16000}') $f$, :'pav'),
  'quick price edit'
);
select lives_ok(
  format($f$ select public.admin_update_menu_item(%L, '{"is_active": false}') $f$, :'pav'),
  'hide (soft delete) an item'
);
select results_eq(
  format($f$ select price_paise, is_active from public.menu_items where id = %L $f$, :'pav'),
  $$ values (16000::bigint, false) $$,
  'quick edits are saved'
);
select lives_ok(
  format($f$ select public.admin_update_menu_item(%L, '{"image_path": null}') $f$, :'thali'),
  'an image can be removed'
);
select is((select image_path from public.menu_items where id = :'thali'), null, 'image path cleared');

-- ─── Ordering ───────────────────────────────────────────────────────────────
select public.admin_save_menu_item(jsonb_build_object(
  'category_id', :'jain', 'name', 'Sabudana Khichdi', 'food_type', 'veg', 'price_paise', 12000
)) as khichdi \gset

select lives_ok(
  format($f$ select public.admin_reorder('items', array[%L, %L]::uuid[], %L) $f$, :'khichdi', :'thali', :'jain'),
  'items can be reordered within a category'
);
select results_eq(
  format($f$ select name from public.menu_items where category_id = %L order by sort_order $f$, :'jain'),
  $$ values ('Sabudana Khichdi'), ('Thali'), ('Jain Pav Bhaji') $$,
  'the given items come first, the rest keep their order'
);
select throws_ok(
  format($f$ select public.admin_reorder('items', array[%L, %L]::uuid[], %L) $f$, :'khichdi', :'b_item', :'jain'),
  'P0001', 'NOT_FOUND',
  'another restaurant''s items cannot be reordered'
);
select throws_ok(
  format($f$ select public.admin_reorder('items', array[%L, %L]::uuid[], %L) $f$, :'khichdi', :'khichdi', :'jain'),
  'P0001', 'INVALID_INPUT',
  'repeated ids are rejected'
);
select id as desserts from public.menu_categories where name = 'Desserts' \gset
select lives_ok(
  format($f$ select public.admin_reorder('categories', array[%L, %L]::uuid[]) $f$, :'desserts', :'starters'),
  'categories can be reordered'
);
select results_eq(
  $$ select name from public.menu_categories order by sort_order $$,
  $$ values ('Desserts'), ('Starters'), ('Jain Specials'), ('Soups') $$,
  'category order saved'
);

-- ─── Deleting categories ────────────────────────────────────────────────────
select throws_ok(
  format($f$ select public.admin_delete_category(%L) $f$, :'jain'),
  'P0001', 'CATEGORY_NOT_EMPTY',
  'a category with items needs somewhere to move them'
);
select is(
  public.admin_delete_category(:'jain', :'starters'),
  3,
  'items (hidden ones included) move to the chosen category'
);
select is(
  (select count(*) from public.menu_items where category_id = :'starters'),
  3::bigint,
  'moved items are in the target category'
);
select is(
  (select count(*) from public.menu_categories where id = :'jain'),
  0::bigint,
  'the category is gone'
);
select is(public.admin_delete_category(:'desserts'), 0, 'an empty category is deleted outright');
select throws_ok(
  format($f$ select public.admin_delete_category(%L) $f$, :'b_cat'),
  'P0001', 'NOT_FOUND',
  'another restaurant''s category cannot be deleted'
);

-- ─── Roles ──────────────────────────────────────────────────────────────────
select tests.authenticate_as(:'a_kitchen');
select lives_ok(
  format($f$ select public.staff_set_item_availability(%L, false) $f$, :'thali'),
  'kitchen staff toggle availability'
);
select is((select is_available from public.menu_items where id = :'thali'), false, 'marked unavailable');
select throws_ok(
  format($f$ select public.staff_set_item_availability(%L, false) $f$, :'b_item'),
  'P0001', 'NOT_FOUND',
  'availability of another restaurant''s item cannot be changed'
);
select throws_ok(
  $$ select public.admin_create_category('Kitchen menu') $$,
  'P0001', 'FORBIDDEN',
  'kitchen staff cannot manage the menu'
);

select tests.authenticate_as(:'a_waiter');
select throws_ok(
  format($f$ select public.admin_update_menu_item(%L, '{"is_active": false}') $f$, :'thali'),
  'P0001', 'FORBIDDEN',
  'waiters cannot manage the menu'
);

-- ─── Read-only restaurants (docs/DECISIONS.md P2-1) ─────────────────────────
select tests.clear_auth();
select tests.suspend(:'rest_a');
select tests.authenticate_as(:'a_manager');

select throws_ok(
  $$ select public.admin_create_category('After hours') $$,
  'P0001', 'RESTAURANT_READ_ONLY',
  'read-only restaurants cannot change the menu'
);
select lives_ok(
  format($f$ select public.staff_set_item_availability(%L, true) $f$, :'thali'),
  'availability can still be toggled while read-only'
);

select * from finish();

rollback;
