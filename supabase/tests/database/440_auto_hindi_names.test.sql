-- Automatic Hindi names (docs/DECISIONS.md HN-5 to HN-8): claimed while a dish
-- or category has no Hindi name of either kind (at most every 12 hours),
-- stored only for the name they were made from, cleared by a rename, and sent
-- to guests when the owner gave no Hindi name.
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ─── Fixtures ───────────────────────────────────────────────────────────────
select tests.create_restaurant('hi-440-a') as rest_a \gset
select tests.create_restaurant('hi-440-b') as rest_b \gset
select tests.add_member(:'rest_a', 'manager', 'a_manager') as a_manager \gset
update public.restaurants set require_first_order_approval = false where id = :'rest_a';

select tests.create_ordering_fixture(:'rest_a', 'HI440A00000TABLE') as fx \gset
select tests.create_ordering_fixture(:'rest_b', 'HI440B00000TABLE') as fx_b \gset
select
  :'fx'::jsonb ->> 'starters' as starters,
  :'fx'::jsonb ->> 'simple' as paneer,
  :'fx'::jsonb ->> 'variant_item' as butter_chicken,
  :'fx_b'::jsonb ->> 'simple' as b_paneer
\gset

-- ─── Who may call ───────────────────────────────────────────────────────────
select tests.authenticate_as(:'a_manager');
select throws_ok(
  format($f$select * from public.menu_hindi_names_claim(%L)$f$, :'rest_a'),
  '42501', null, 'staff cannot claim names'
);
select throws_ok(
  $f$select public.menu_set_hindi_names('[]')$f$,
  '42501', null, 'staff cannot store automatic names'
);
select tests.as_anon();
select throws_ok(
  $f$select public.menu_set_hindi_names('[]')$f$,
  '42501', null, 'nor can guests'
);

-- ─── Claiming ─────────────────────────────────────────────────────────────
select tests.as_service_role();
update public.menu_items set name_hi = 'बटर चिकन' where id = :'butter_chicken';

create temp table claimed on commit drop as
  select * from public.menu_hindi_names_claim(:'rest_a');
select is(
  (select count(*)::int from claimed),
  (select count(*)::int from public.menu_categories where restaurant_id = :'rest_a')
    + (select count(*)::int from public.menu_items where restaurant_id = :'rest_a') - 1,
  'every dish and category without a Hindi name is claimed'
);
select is(
  (select count(*)::int from claimed where restaurant_id <> :'rest_a'), 0,
  'only from the restaurant asked for'
);
select ok(
  not exists (select 1 from claimed where id = :'butter_chicken'),
  'not a dish with an owner Hindi name'
);
select is(
  (select row(restaurant_id, kind, name)::text from claimed where id = :'paneer'),
  row(:'rest_a'::uuid, 'item', 'Paneer Tikka')::text,
  'a row says whose it is, what it is and its name'
);
select is(
  (select count(*)::int from public.menu_items
   where restaurant_id = :'rest_a' and name_hi_auto_tried_at is null and name_hi is null),
  0, 'claiming stamps the rows'
);
select is(
  (select count(*)::int from public.menu_hindi_names_claim(:'rest_a')), 0,
  'so they are not claimed again straight away'
);

update public.menu_items set name_hi_auto_tried_at = now() - interval '13 hours'
where id = :'paneer';
select is(
  (select array_agg(id) from public.menu_hindi_names_claim(:'rest_a')),
  array[:'paneer'::uuid], 'a name tried over 12 hours ago is claimed again'
);

update public.menu_items set name_hi_auto_tried_at = now() - interval '13 hours'
where restaurant_id = :'rest_a';
update public.menu_items set name_hi_auto_tried_at = null where id = :'paneer';
select is(
  (select array_agg(id) from public.menu_hindi_names_claim(:'rest_a', 1)),
  array[:'paneer'::uuid], 'never-tried names come first, and the limit holds'
);
select ok(
  (select count(distinct restaurant_id) > 1 from public.menu_hindi_names_claim(null, 1000)),
  'every restaurant is claimed from when none is given'
);
update public.menu_items set name_hi_auto_tried_at = null where restaurant_id = :'rest_a';
update public.menu_categories set name_hi_auto_tried_at = null where restaurant_id = :'rest_a';

-- ─── Storing ────────────────────────────────────────────────────────────────
select is(
  public.menu_set_hindi_names(jsonb_build_array(
    jsonb_build_object('kind', 'item', 'id', :'paneer', 'name', 'Paneer Tikka', 'name_hi', ' पनीर टिक्का '),
    jsonb_build_object('kind', 'category', 'id', :'starters', 'name', 'Starters', 'name_hi', 'स्टार्टर्स')
  )),
  2, 'automatic names are stored'
);
select is(
  (select name_hi_auto from public.menu_items where id = :'paneer'),
  'पनीर टिक्का', 'trimmed'
);
select ok(
  not exists (select 1 from public.menu_hindi_names_claim(:'rest_a') where id in (:'paneer', :'starters')),
  'and no longer claimed'
);
select is(
  public.menu_set_hindi_names(jsonb_build_array(
    jsonb_build_object('kind', 'item', 'id', :'paneer', 'name', 'Paneer Tikka', 'name_hi', 'दूसरा')
  )),
  0, 'an automatic name is not replaced'
);
select is(
  public.menu_set_hindi_names(jsonb_build_array(
    jsonb_build_object('kind', 'item', 'id', :'b_paneer', 'name', 'Paneer Tikka Masala', 'name_hi', 'पनीर')
  )),
  0, 'a name made for an old dish name is dropped'
);
select is(
  public.menu_set_hindi_names(jsonb_build_array(
    jsonb_build_object('kind', 'item', 'id', :'b_paneer', 'name', 'Paneer Tikka', 'name_hi', repeat('क', 81)),
    jsonb_build_object('kind', 'item', 'id', :'b_paneer', 'name', 'Paneer Tikka', 'name_hi', '  ')
  )),
  0, 'an over-long or blank name is skipped'
);
select is(
  public.menu_set_hindi_names(jsonb_build_array(
    jsonb_build_object('kind', 'category', 'id', :'b_paneer', 'name', 'Paneer Tikka', 'name_hi', 'पनीर')
  )),
  0, 'the kind must match'
);
select throws_ok(
  $f$select public.menu_set_hindi_names('{}')$f$,
  'P0001', 'INVALID_INPUT', 'the names must be a list'
);

-- ─── Renames clear it ───────────────────────────────────────────────────────
select tests.authenticate_as(:'a_manager');
select public.admin_update_menu_item(:'paneer', '{"price_paise": 29000}');
select public.admin_update_category(:'starters', '{"is_active": true}');
select is(
  (select name_hi_auto from public.menu_items where id = :'paneer'),
  'पनीर टिक्का', 'a price change keeps the automatic name'
);
select is(
  (select name_hi_auto from public.menu_categories where id = :'starters'),
  'स्टार्टर्स', 'so does a visibility change'
);

select tests.as_service_role();
select public.customer_get_table('HI440A00000TABLE') as menu \gset
select is(
  (select c ->> 'name_hi' from jsonb_array_elements(:'menu'::jsonb -> 'menu') c
   where c ->> 'id' = :'starters'),
  'स्टार्टर्स', 'guests get the automatic category name'
);
select is(
  (select i ->> 'name_hi'
   from jsonb_array_elements(:'menu'::jsonb -> 'menu') c, jsonb_array_elements(c -> 'items') i
   where i ->> 'id' = :'paneer'),
  'पनीर टिक्का', 'and the automatic dish name'
);

update public.menu_items set name_hi_auto = 'बटर चिकन (ऑटो)' where id = :'butter_chicken';
select public.customer_get_table('HI440A00000TABLE') as menu \gset
select is(
  (select i ->> 'name_hi'
   from jsonb_array_elements(:'menu'::jsonb -> 'menu') c, jsonb_array_elements(c -> 'items') i
   where i ->> 'id' = :'butter_chicken'),
  'बटर चिकन', 'the owner''s Hindi name wins'
);

select public.customer_place_order(
  'HI440A00000TABLE', gen_random_uuid()::text, 'k' || replace(gen_random_uuid()::text, '-', ''),
  jsonb_build_array(tests.line(:'paneer'))
);
select is(
  (select i ->> 'name_hi'
   from jsonb_array_elements(public.customer_get_session('HI440A00000TABLE') -> 'session' -> 'rounds') r,
        jsonb_array_elements(r -> 'items') i),
  'पनीर टिक्का', 'the orders page gets the automatic name'
);

select tests.authenticate_as(:'a_manager');
select public.admin_save_menu_item(jsonb_build_object(
  'id', :'paneer', 'category_id', :'starters', 'name', 'Paneer Tikka Masala',
  'food_type', 'veg', 'price_paise', 29000
));
select public.admin_update_category(:'starters', '{"name": "Snacks"}');
select is(
  (select name_hi_auto_tried_at from public.menu_items where id = :'paneer'), null,
  'a renamed dish counts as never tried'
);
select is(
  (select name_hi_auto from public.menu_items where id = :'paneer'), null,
  'renaming a dish clears its automatic name'
);
select is(
  (select name_hi_auto from public.menu_categories where id = :'starters'), null,
  'and renaming a category'
);
select tests.as_service_role();
select ok(
  exists (select 1 from public.menu_hindi_names_claim(:'rest_a')
          where id = :'paneer' and name = 'Paneer Tikka Masala'),
  'so the new name is claimed again'
);

select * from finish();
rollback;
