-- Optional Hindi names for dishes and categories (docs/DECISIONS.md, "Hindi
-- names"): set by owners and managers, tidied and checked, kept when a caller
-- doesn't send them, and returned to guests with the menu and their orders.
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ─── Fixtures ───────────────────────────────────────────────────────────────
select tests.create_restaurant('hi-430-a') as rest_a \gset
select tests.add_member(:'rest_a', 'manager', 'a_manager') as a_manager \gset
update public.restaurants set require_first_order_approval = false where id = :'rest_a';

select tests.create_ordering_fixture(:'rest_a', 'HI430A00000TABLE') as fx \gset
select
  :'fx'::jsonb ->> 'starters' as starters,
  :'fx'::jsonb ->> 'simple' as paneer,
  :'fx'::jsonb ->> 'variant_item' as butter_chicken
\gset
select gen_random_uuid() as new_dish \gset

-- ─── Dishes ─────────────────────────────────────────────────────────────────
select tests.authenticate_as(:'a_manager');

select lives_ok(
  format($f$select public.admin_save_menu_item(%L)$f$, jsonb_build_object(
    'id', :'new_dish', 'category_id', :'starters', 'name', 'Aloo Tikki',
    'name_hi', '  आलू   टिक्की ', 'food_type', 'veg', 'price_paise', 9000
  )),
  'a new dish takes a Hindi name'
);
select is(
  (select name_hi from public.menu_items where id = :'new_dish'),
  'आलू टिक्की', 'the Hindi name is tidied'
);

select public.admin_save_menu_item(jsonb_build_object(
  'id', :'new_dish', 'category_id', :'starters', 'name', 'Aloo Tikki Chaat',
  'food_type', 'veg', 'price_paise', 9500
));
select is(
  (select row(name, name_hi)::text from public.menu_items where id = :'new_dish'),
  row('Aloo Tikki Chaat', 'आलू टिक्की')::text,
  'a save without name_hi keeps it (older callers)'
);

select public.admin_save_menu_item(jsonb_build_object(
  'id', :'new_dish', 'category_id', :'starters', 'name', 'Aloo Tikki Chaat',
  'name_hi', '   ', 'food_type', 'veg', 'price_paise', 9500
));
select is(
  (select name_hi from public.menu_items where id = :'new_dish'), null,
  'a blank Hindi name clears it'
);

select public.admin_save_menu_item(jsonb_build_object(
  'id', :'paneer', 'category_id', :'starters', 'name', 'Paneer Tikka',
  'name_hi', 'पनीर टिक्का', 'food_type', 'veg', 'price_paise', 28000
));
select public.admin_save_menu_item(jsonb_build_object(
  'id', :'new_dish', 'category_id', :'starters', 'name', 'Aloo Tikki Chaat',
  'name_hi', 'आलू टिक्की चाट', 'food_type', 'veg', 'price_paise', 9500
));
select public.admin_save_menu_item(jsonb_build_object(
  'id', :'new_dish', 'category_id', :'starters', 'name', 'Aloo Tikki Chaat',
  'name_hi', null, 'food_type', 'veg', 'price_paise', 9500
));
select is(
  (select name_hi from public.menu_items where id = :'new_dish'), null,
  'a null Hindi name clears it'
);

select throws_ok(
  format($f$select public.admin_save_menu_item(%L)$f$, jsonb_build_object(
    'id', :'new_dish', 'category_id', :'starters', 'name', 'Aloo Tikki Chaat',
    'name_hi', repeat('क', 81), 'food_type', 'veg', 'price_paise', 9500
  )),
  'P0001', 'INVALID_INPUT', 'a Hindi name over 80 characters is refused'
);
select throws_ok(
  format($f$select public.admin_save_menu_item(%L)$f$, jsonb_build_object(
    'id', :'new_dish', 'category_id', :'starters', 'name', 'Aloo Tikki Chaat',
    'name_hi', 5, 'food_type', 'veg', 'price_paise', 9500
  )),
  'P0001', 'INVALID_INPUT', 'a Hindi name must be text'
);

-- ─── Categories ─────────────────────────────────────────────────────────────
select public.admin_update_category(:'starters', '{"name_hi": " स्टार्टर "}');
select is(
  (select row(name, name_hi)::text from public.menu_categories where id = :'starters'),
  row('Starters', 'स्टार्टर')::text,
  'a category takes a Hindi name, tidied, keeping its name'
);
select public.admin_update_category(:'starters', '{"name": "Snacks"}');
select is(
  (select row(name, name_hi)::text from public.menu_categories where id = :'starters'),
  row('Snacks', 'स्टार्टर')::text,
  'a rename keeps the Hindi name'
);
select public.admin_update_category(:'starters', '{"name_hi": null}');
select is(
  (select row(name, name_hi)::text from public.menu_categories where id = :'starters'),
  row('Snacks', null::text)::text,
  'a null category Hindi name clears it, keeping the name'
);
select public.admin_update_category(:'starters', '{"name_hi": "स्टार्टर"}');
select public.admin_update_category(:'starters', '{"name_hi": ""}');
select is(
  (select name_hi from public.menu_categories where id = :'starters'), null,
  'so does an empty one'
);
select public.admin_update_category(:'starters', '{"name_hi": "स्टार्टर"}');
select throws_ok(
  format($f$select public.admin_update_category(%L, %L)$f$, :'starters',
    jsonb_build_object('name_hi', repeat('क', 61))),
  'P0001', 'INVALID_INPUT', 'a category Hindi name over 60 characters is refused'
);
select throws_ok(
  format($f$select public.admin_update_category(%L, '{"colour": "red"}')$f$, :'starters'),
  'P0001', 'INVALID_INPUT', 'unknown keys are still refused'
);

-- ─── What guests get ────────────────────────────────────────────────────────
select tests.as_service_role();
select public.customer_get_table('HI430A00000TABLE') as menu \gset
select is(
  (select c ->> 'name_hi' from jsonb_array_elements(:'menu'::jsonb -> 'menu') c
   where c ->> 'id' = :'starters'),
  'स्टार्टर', 'the menu sends the category Hindi name'
);
select is(
  (select i ->> 'name_hi'
   from jsonb_array_elements(:'menu'::jsonb -> 'menu') c, jsonb_array_elements(c -> 'items') i
   where i ->> 'id' = :'paneer'),
  'पनीर टिक्का', 'and the dish Hindi name'
);
select is(
  (select (i -> 'name_hi') = 'null'::jsonb
   from jsonb_array_elements(:'menu'::jsonb -> 'menu') c, jsonb_array_elements(c -> 'items') i
   where i ->> 'id' = :'butter_chicken'),
  true, 'a dish without one sends null'
);

select public.customer_place_order(
  'HI430A00000TABLE', gen_random_uuid()::text, 'k' || replace(gen_random_uuid()::text, '-', ''),
  jsonb_build_array(tests.line(:'paneer'))
);
select is(
  (select jsonb_build_array(i ->> 'name', i ->> 'name_hi')
   from jsonb_array_elements(public.customer_get_session('HI430A00000TABLE') -> 'session' -> 'rounds') r,
        jsonb_array_elements(r -> 'items') i),
  '["Paneer Tikka", "पनीर टिक्का"]'::jsonb,
  'the orders page gets the typed name and the Hindi name'
);

select * from finish();
rollback;
