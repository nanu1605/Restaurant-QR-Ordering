-- Restartable automatic Hindi names (docs/DECISIONS.md VPS-27): a fill leases the names that wait
-- for it, one restaurant at a time, and settles each batch when it answers. A settled name is
-- stored for the name it was made from, counts as tried whether it was written or not, and is no
-- longer leased; a lease that runs out frees its names; a rename starts a name again. The owner's
-- own Hindi name is never written, and the previous build's claim leaves leased names alone.
begin;
select no_plan();

-- A local database's own names, set aside until the rollback.
update public.menu_categories set name_hi_auto_tried_at = now()
  where name_hi is null and name_hi_auto is null;
update public.menu_items set name_hi_auto_tried_at = now()
  where name_hi is null and name_hi_auto is null;

-- ─── Fixtures ───────────────────────────────────────────────────────────────
select tests.create_restaurant('hi-691-a') as rest_a \gset
select tests.create_restaurant('hi-691-b') as rest_b \gset
select tests.create_restaurant('hi-691-c') as rest_c \gset
select tests.add_member(:'rest_a', 'manager', 'a_manager') as a_manager \gset

select tests.create_ordering_fixture(:'rest_a', 'HI691A00000TABLE') as fx \gset
select tests.create_ordering_fixture(:'rest_b', 'HI691B00000TABLE') as fx_b \gset
select
  :'fx'::jsonb ->> 'starters' as starters,
  :'fx'::jsonb ->> 'hidden_category' as soups,
  :'fx'::jsonb ->> 'empty_category' as accompaniments,
  :'fx'::jsonb ->> 'simple' as paneer,
  :'fx'::jsonb ->> 'variant_item' as butter_chicken,
  :'fx'::jsonb ->> 'unavailable' as kofta,
  :'fx'::jsonb ->> 'hidden_item' as old_dish,
  :'fx'::jsonb ->> 'in_hidden_category' as tomato_soup,
  :'fx_b'::jsonb ->> 'simple' as b_paneer
\gset

create function pg_temp.item(p_id uuid) returns public.menu_items
language sql as $$
  select * from public.menu_items i where i.id = p_id;
$$;
create function pg_temp.category(p_id uuid) returns public.menu_categories
language sql as $$
  select * from public.menu_categories c where c.id = p_id;
$$;
-- Every name of the restaurant free again, as when the leases have run out.
create function pg_temp.free(p_restaurant_id uuid) returns void
language sql as $$
  update public.menu_categories set name_hi_auto_lease_until = null
    where restaurant_id = p_restaurant_id;
  update public.menu_items set name_hi_auto_lease_until = null
    where restaurant_id = p_restaurant_id;
$$;

-- ─── Who may call ───────────────────────────────────────────────────────────
select tests.authenticate_as(:'a_manager');
select throws_ok(
  format($f$select * from public.menu_hindi_names_lease(%L)$f$, :'rest_a'),
  '42501', null, 'staff cannot lease names'
);
select throws_ok(
  $f$select public.menu_hindi_names_settle('[]')$f$,
  '42501', null, 'staff cannot settle them'
);
select tests.as_anon();
select throws_ok(
  $f$select * from public.menu_hindi_names_lease()$f$,
  '42501', null, 'nor can guests lease'
);
select throws_ok(
  $f$select public.menu_hindi_names_settle('[]')$f$,
  '42501', null, 'or settle'
);

select tests.as_service_role();
select throws_ok(
  $f$select public.menu_hindi_names_settle('{}')$f$,
  'P0001', 'INVALID_INPUT', 'the names to settle must be a list'
);
select throws_ok(
  $f$select public.menu_hindi_names_settle(null)$f$,
  'P0001', 'INVALID_INPUT', 'a list'
);

-- ─── Leasing ────────────────────────────────────────────────────────────────
update public.menu_items set name_hi = 'बटर चिकन' where id = :'butter_chicken';

create temp table leased on commit drop as
  select * from public.menu_hindi_names_lease(:'rest_a');
select is(
  (select count(*)::int from leased),
  (select count(*)::int from public.menu_categories where restaurant_id = :'rest_a')
    + (select count(*)::int from public.menu_items where restaurant_id = :'rest_a') - 1,
  'every dish and category without a Hindi name is leased'
);
select is(
  (select count(*)::int from leased where restaurant_id <> :'rest_a'), 0,
  'only from the restaurant asked for'
);
select ok(
  not exists (select 1 from leased where id = :'butter_chicken'),
  'not a dish with an owner Hindi name'
);
select is(
  (select row(restaurant_id, kind, name)::text from leased where id = :'paneer'),
  row(:'rest_a'::uuid, 'item', 'Paneer Tikka')::text,
  'a row says whose it is, what it is and its name'
);
select is(
  (select count(*)::int from public.menu_items
   where restaurant_id = :'rest_a' and name_hi_auto_lease_until = now() + interval '300 seconds'),
  (select count(*)::int from leased where kind = 'item'),
  'the dishes are leased for 5 minutes'
);
select is(
  (select count(*)::int from public.menu_categories
   where restaurant_id = :'rest_a' and name_hi_auto_lease_until = now() + interval '300 seconds'),
  (select count(*)::int from leased where kind = 'category'),
  'and the categories'
);
select is(
  (select count(*)::int from public.menu_items
   where restaurant_id = :'rest_a' and name_hi_auto_tried_at is not null),
  0, 'leasing leaves the time of the last try alone'
);
select is(
  (select count(*)::int from public.menu_hindi_names_lease(:'rest_a')), 0,
  'so they are not leased again straight away'
);

update public.menu_items set name_hi_auto_lease_until = now() - interval '1 second'
  where id = :'paneer';
select is(
  (select array_agg(id) from public.menu_hindi_names_lease(:'rest_a')),
  array[:'paneer'::uuid], 'a name whose lease has run out is leased again'
);

-- ─── How many, and for how long ─────────────────────────────────────────────
select pg_temp.free(:'rest_a');
select id as short_lease from public.menu_hindi_names_lease(:'rest_a', 0, 5) \gset
select is(
  (select name_hi_auto_lease_until from public.menu_categories where id = :'short_lease'),
  now() + interval '60 seconds', 'a limit of none gives one name, leased 60 seconds at least'
);
select pg_temp.free(:'rest_a');
select id as long_lease from public.menu_hindi_names_lease(:'rest_a', 1, 100000) \gset
select is(
  (select name_hi_auto_lease_until from public.menu_categories where id = :'long_lease'),
  now() + interval '15 minutes', 'and 15 minutes at most'
);
select pg_temp.free(:'rest_a');
select count(*)::int + 1 as one_more from public.menu_categories where restaurant_id = :'rest_a' \gset
create temp table limited on commit drop as
  select * from public.menu_hindi_names_lease(:'rest_a', :one_more);
select is((select count(*)::int from limited), :one_more, 'the limit holds');
select is(
  (select count(*)::int from limited where kind = 'category'), :one_more - 1,
  'and the categories come before the dishes'
);

-- ─── One restaurant at a time ───────────────────────────────────────────────
select pg_temp.free(:'rest_a');
update public.menu_categories set name_hi_auto_tried_at = now() - interval '13 hours'
  where restaurant_id = :'rest_a';
update public.menu_items set name_hi_auto_tried_at = now() - interval '13 hours'
  where restaurant_id = :'rest_a';
create temp table leased_any on commit drop as
  select * from public.menu_hindi_names_lease(null);
select is(
  (select array_agg(distinct restaurant_id) from leased_any), array[:'rest_b'::uuid],
  'with none asked for, names never tried come first, and only that restaurant''s'
);
select is(
  (select count(*)::int from leased_any),
  (select count(*)::int from public.menu_categories where restaurant_id = :'rest_b')
    + (select count(*)::int from public.menu_items where restaurant_id = :'rest_b'),
  'all of them'
);
select is(
  (select array_agg(distinct restaurant_id) from public.menu_hindi_names_lease(null)),
  array[:'rest_a'::uuid], 'then another restaurant''s, and only its names'
);
select is(
  (select count(*)::int from public.menu_hindi_names_lease(null)), 0,
  'then none are left'
);
select pg_temp.free(:'rest_a');
select is(
  (select count(*)::int from public.menu_hindi_names_lease(:'rest_c')), 0,
  'a restaurant with no names waiting gets none, not another''s'
);

-- ─── Which names ────────────────────────────────────────────────────────────
select pg_temp.free(:'rest_a');
update public.menu_categories set name_hi_auto_tried_at = now() where restaurant_id = :'rest_a';
update public.menu_items set name_hi_auto_tried_at = null where restaurant_id = :'rest_a';
update public.menu_items set name_hi_auto_tried_at = now() - interval '11 hours'
  where id = :'paneer';
update public.menu_items set name_hi_auto = 'मलाई कोफ्ता' where id = :'kofta';
update public.menu_items set name_hi_auto_lease_until = now() + interval '1 minute'
  where id = :'old_dish';
select is(
  (select array_agg(id) from public.menu_hindi_names_lease(:'rest_a')),
  array[:'tomato_soup'::uuid],
  'names with a Hindi name of either kind, tried in the last 12 hours, or leased are passed over'
);
update public.menu_items set name_hi_auto_tried_at = now() - interval '13 hours'
  where id = :'paneer';
select is(
  (select array_agg(id) from public.menu_hindi_names_lease(:'rest_a')),
  array[:'paneer'::uuid], 'one tried over 12 hours ago is leased'
);

-- ─── Settling ───────────────────────────────────────────────────────────────
update public.menu_items
  set name_hi_auto = null, name_hi_auto_tried_at = null, name_hi_auto_lease_until = null
  where restaurant_id = :'rest_a' and name_hi is null;
update public.menu_categories set name_hi_auto_tried_at = null where restaurant_id = :'rest_a';
select count(*) from public.menu_hindi_names_lease(:'rest_a');

select is(
  public.menu_hindi_names_settle(jsonb_build_array(
    jsonb_build_object('kind', 'item', 'id', :'paneer', 'name', 'Paneer Tikka', 'name_hi', ' पनीर टिक्का '),
    jsonb_build_object('kind', 'category', 'id', :'starters', 'name', 'Starters', 'name_hi', 'स्टार्टर्स'),
    jsonb_build_object('kind', 'item', 'id', :'kofta', 'name', 'Malai Kofta')
  )),
  2, 'the names of a batch are stored, and counted'
);
select is((pg_temp.item(:'paneer')).name_hi_auto, 'पनीर टिक्का', 'tidied');
select is((pg_temp.category(:'starters')).name_hi_auto, 'स्टार्टर्स', 'a category''s too');
select is((pg_temp.item(:'paneer')).name_hi_auto_tried_at, now(), 'it counts as tried');
select is((pg_temp.item(:'paneer')).name_hi_auto_lease_until, null, 'and is not leased');
select is((pg_temp.item(:'kofta')).name_hi_auto, null, 'a name the model did not write has none');
select is((pg_temp.item(:'kofta')).name_hi_auto_tried_at, now(), 'but counts as tried');
select is((pg_temp.item(:'kofta')).name_hi_auto_lease_until, null, 'and is not leased');
select is(
  (pg_temp.item(:'old_dish')).name_hi_auto_lease_until, now() + interval '300 seconds',
  'a name that is not in the batch stays leased'
);
select ok(
  not exists (select 1 from public.menu_hindi_names_lease(:'rest_a') where id = :'kofta'),
  'a name that counts as tried is not leased again for 12 hours'
);

select is(
  public.menu_hindi_names_settle(jsonb_build_array(
    jsonb_build_object('kind', 'item', 'id', :'paneer', 'name', 'Paneer Tikka', 'name_hi', 'दूसरा')
  )),
  0, 'an automatic name is not replaced'
);
select is((pg_temp.item(:'paneer')).name_hi_auto, 'पनीर टिक्का', 'a repeat changes nothing');
select is(
  public.menu_hindi_names_settle(jsonb_build_array(
    jsonb_build_object('kind', 'item', 'id', :'old_dish', 'name', 'Older Dish', 'name_hi', 'पुराना')
  )),
  0, 'a name made for an old dish name is dropped'
);
select is(
  (select row(name_hi_auto, name_hi_auto_tried_at, name_hi_auto_lease_until)::text
   from public.menu_items where id = :'old_dish'),
  row(null, null, now() + interval '300 seconds')::text, 'and its dish is left as it was'
);
select is(
  public.menu_hindi_names_settle(jsonb_build_array(
    jsonb_build_object('kind', 'category', 'id', :'old_dish', 'name', 'Old Dish', 'name_hi', 'पुराना')
  )),
  0, 'the kind must match'
);
select is(
  public.menu_hindi_names_settle(jsonb_build_array(
    jsonb_build_object('kind', 'item', 'id', :'old_dish', 'name', 'Old Dish', 'name_hi', repeat('क', 81)),
    jsonb_build_object('kind', 'category', 'id', :'soups', 'name', 'Soups', 'name_hi', repeat('क', 61)),
    jsonb_build_object('kind', 'item', 'id', :'tomato_soup', 'name', 'Tomato Soup', 'name_hi', '   ')
  )),
  0, 'an over-long or blank name is not stored'
);
select is(
  (select row(name_hi_auto, name_hi_auto_tried_at, name_hi_auto_lease_until)::text
   from public.menu_items where id = :'old_dish'),
  row(null, now(), null)::text, 'though its dish counts as tried'
);
select is(
  public.menu_hindi_names_settle(jsonb_build_array(
    jsonb_build_object('kind', 'item', 'id', :'tomato_soup', 'name', 'Tomato Soup', 'name_hi', repeat('क', 80)),
    jsonb_build_object('kind', 'category', 'id', :'accompaniments', 'name', 'Accompaniments', 'name_hi', repeat('क', 60))
  )),
  2, 'but 80 characters fit a dish and 60 a category'
);

-- ─── Renames ────────────────────────────────────────────────────────────────
update public.menu_items set name_hi_auto_lease_until = now() + interval '5 minutes'
  where id = :'paneer';
update public.menu_categories set name_hi_auto_lease_until = now() + interval '5 minutes'
  where id = :'starters';
select tests.authenticate_as(:'a_manager');
select public.admin_save_menu_item(jsonb_build_object(
  'id', :'paneer', 'category_id', :'starters', 'name', 'Paneer Tikka Masala',
  'food_type', 'veg', 'price_paise', 29000
));
select public.admin_update_category(:'starters', '{"name": "Snacks"}');
select tests.as_service_role();
select is(
  (select row(name_hi_auto, name_hi_auto_tried_at, name_hi_auto_lease_until)::text
   from public.menu_items where id = :'paneer'),
  row(null, null, null)::text, 'renaming a dish clears its automatic name, its last try and its lease'
);
select is(
  (select row(name_hi_auto, name_hi_auto_tried_at, name_hi_auto_lease_until)::text
   from public.menu_categories where id = :'starters'),
  row(null, null, null)::text, 'and renaming a category'
);
select ok(
  exists (select 1 from public.menu_hindi_names_lease(:'rest_a')
          where id = :'paneer' and name = 'Paneer Tikka Masala'),
  'so the new name is leased at once'
);
select is(
  public.menu_hindi_names_settle(jsonb_build_array(
    jsonb_build_object('kind', 'item', 'id', :'paneer', 'name', 'Paneer Tikka', 'name_hi', 'पनीर टिक्का')
  )),
  0, 'and a fill still working on the old name stores nothing'
);
select is(
  (pg_temp.item(:'paneer')).name_hi_auto_lease_until, now() + interval '300 seconds',
  'nor ends the new name''s lease'
);

-- ─── The owner's own name ───────────────────────────────────────────────────
select pg_temp.free(:'rest_b');
select count(*) from public.menu_hindi_names_lease(:'rest_b');
update public.menu_items set name_hi = 'पनीर टिक्का (मालिक)' where id = :'b_paneer';
select is(
  public.menu_hindi_names_settle(jsonb_build_array(
    jsonb_build_object('kind', 'item', 'id', :'b_paneer', 'name', 'Paneer Tikka', 'name_hi', 'पनीर')
  )),
  1, 'a name the owner typed after the lease: the automatic one is stored behind it'
);
select is(
  (select row(name_hi, name_hi_auto)::text from public.menu_items where id = :'b_paneer'),
  row('पनीर टिक्का (मालिक)', 'पनीर')::text, 'and the owner''s own is never written'
);
select public.customer_get_table('HI691B00000TABLE') as menu \gset
select is(
  (select i ->> 'name_hi'
   from jsonb_array_elements(:'menu'::jsonb -> 'menu') c, jsonb_array_elements(c -> 'items') i
   where i ->> 'id' = :'b_paneer'),
  'पनीर टिक्का (मालिक)', 'guests get it'
);

-- ─── The previous build's claim ─────────────────────────────────────────────
select pg_temp.free(:'rest_b');
update public.menu_categories set name_hi_auto_tried_at = now() where restaurant_id = :'rest_b';
update public.menu_items set name_hi_auto = null, name_hi_auto_tried_at = null
  where restaurant_id = :'rest_b' and name_hi is null;
select id as held from public.menu_hindi_names_lease(:'rest_b', 1) \gset
select ok(
  not exists (select 1 from public.menu_hindi_names_claim(:'rest_b') where id = :'held'),
  'the previous build''s claim passes over a leased name'
);
select is(
  (pg_temp.item(:'held')).name_hi_auto_tried_at, null, 'and does not stamp it'
);
update public.menu_items set name_hi_auto_lease_until = now() - interval '1 second'
  where id = :'held';
select ok(
  exists (select 1 from public.menu_hindi_names_claim(:'rest_b') where id = :'held'),
  'but takes it once the lease has run out'
);
select is((pg_temp.item(:'held')).name_hi_auto_tried_at, now(), 'stamping it, as it did');

-- ─── What waits ─────────────────────────────────────────────────────────────
select tests.clear_auth();
update public.menu_categories set name_hi_auto_tried_at = now()
  where name_hi is null and name_hi_auto is null;
update public.menu_items set name_hi_auto_tried_at = now()
  where name_hi is null and name_hi_auto is null;
select ok(not private.hindi_names_waiting(), 'nothing waits when every name was tried or has a Hindi name');

insert into public.menu_categories (restaurant_id, name) values (:'rest_c', 'Chaat')
  returning id as chaat \gset
insert into public.menu_items (restaurant_id, category_id, name, food_type, price_paise)
  values (:'rest_c', :'chaat', 'Papdi Chaat', 'veg', 9000)
  returning id as papdi \gset
select ok(private.hindi_names_waiting(), 'a new name waits');

select tests.as_service_role();
select count(*) from public.menu_hindi_names_lease(:'rest_c');
select tests.clear_auth();
select ok(not private.hindi_names_waiting(), 'not while it is leased');
update public.menu_items set name_hi_auto_lease_until = now() - interval '1 second' where id = :'papdi';
select ok(private.hindi_names_waiting(), 'but once the lease has run out');
update public.menu_items set name_hi_auto_lease_until = null,
  name_hi_auto_tried_at = now() - interval '11 hours' where id = :'papdi';
select ok(not private.hindi_names_waiting(), 'not when it was tried in the last 12 hours');
update public.menu_items set name_hi_auto_tried_at = now() - interval '13 hours' where id = :'papdi';
select ok(private.hindi_names_waiting(), 'but when it was tried over 12 hours ago');
update public.menu_items set name_hi_auto = 'पापड़ी चाट' where id = :'papdi';
select ok(not private.hindi_names_waiting(), 'not with an automatic name');
update public.menu_items set name_hi_auto = null, name_hi = 'पापड़ी चाट' where id = :'papdi';
select ok(not private.hindi_names_waiting(), 'nor the owner''s');
-- The category was leased with the dish, and is still.
update public.menu_categories set name_hi_auto_lease_until = now() - interval '1 second'
  where id = :'chaat';
select ok(private.hindi_names_waiting(), 'a category waits as a dish does');
update public.menu_categories set name_hi_auto_lease_until = null, name_hi_auto_tried_at = now()
  where id = :'chaat';
select ok(not private.hindi_names_waiting(), 'until it has been tried');

select * from finish();
rollback;
