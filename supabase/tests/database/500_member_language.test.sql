-- The worker panel's language, per login (docs/DECISIONS.md P11-15, P11-16):
-- the default, a login's own switch, the Staff page's edit and its rules, and
-- the Hindi dish names on the board.
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

select tests.create_restaurant('p11-500-alpha') as rest_a \gset
select tests.create_restaurant('p11-500-bravo') as rest_b \gset
select tests.add_member(:'rest_a', 'owner', 'owner') as a_owner \gset
select tests.add_member(:'rest_a', 'manager', 'meera') as a_manager \gset
select tests.add_member(:'rest_a', 'waiter', 'ravi') as a_waiter \gset
select tests.add_member(:'rest_a', 'kitchen', 'kavita') as a_kitchen \gset
select tests.add_member(:'rest_b', 'waiter', 'bravo_ravi') as b_waiter \gset
select tests.member_id(:'a_owner') as m_owner \gset
select tests.member_id(:'a_manager') as m_manager \gset
select tests.member_id(:'a_waiter') as m_waiter \gset
select tests.member_id(:'a_kitchen') as m_kitchen \gset
select tests.member_id(:'b_waiter') as m_b_waiter \gset

-- ─── Default and the column's check ────────────────────────────────────────
select is(
  (select array_agg(distinct ui_lang) from public.restaurant_members where restaurant_id = :'rest_a'),
  array['en'],
  'every login starts in English'
);
select throws_ok(
  format($f$ update public.restaurant_members set ui_lang = 'fr' where id = %L $f$, :'m_waiter'),
  '23514', null,
  'only English and Hindi are stored'
);

-- ─── A login's own switch ───────────────────────────────────────────────────
select ok(
  has_function_privilege('authenticated', 'public.member_set_ui_lang(text)', 'execute'),
  'signed-in users can set their own language'
);
select ok(
  not has_function_privilege('anon', 'public.member_set_ui_lang(text)', 'execute'),
  'anonymous visitors cannot'
);

select tests.authenticate_as(:'a_waiter');
select lives_ok($$ select public.member_set_ui_lang('hi') $$, 'a waiter switches to Hindi');
select tests.clear_auth();
select results_eq(
  format(
    $f$ select id, ui_lang from public.restaurant_members where restaurant_id = %L order by id $f$,
    :'rest_a'
  ),
  format(
    $f$ select id, case when id = %L then 'hi' else 'en' end from public.restaurant_members
        where restaurant_id = %L order by id $f$,
    :'m_waiter', :'rest_a'
  ),
  'only the caller''s own login changes'
);

select tests.authenticate_as(:'a_waiter');
select throws_ok(
  $$ select public.member_set_ui_lang('fr') $$,
  'P0001', 'INVALID_INPUT',
  'an unknown language is refused'
);
select throws_ok(
  $$ select public.member_set_ui_lang(null) $$,
  'P0001', 'INVALID_INPUT',
  'no language is refused'
);
select tests.clear_auth();

select tests.create_user('nobody@p11-500.test') as nobody \gset
select tests.authenticate_as(:'nobody');
select throws_ok(
  $$ select public.member_set_ui_lang('hi') $$,
  'P0001', 'FORBIDDEN',
  'a user with no login in any restaurant cannot'
);
select tests.clear_auth();

-- A preference: it still works while the restaurant is read-only.
select tests.suspend(:'rest_b');
select tests.authenticate_as(:'b_waiter');
select lives_ok($$ select public.member_set_ui_lang('hi') $$, 'switching works while read-only');
select tests.clear_auth();
select is(
  (select ui_lang from public.restaurant_members where id = :'m_b_waiter'),
  'hi',
  'and is saved'
);

-- ─── The Staff page ─────────────────────────────────────────────────────────
select tests.authenticate_as(:'a_manager');
select results_eq(
  format(
    $f$ select ui_lang from public.admin_list_staff() where member_id = %L $f$,
    :'m_waiter'
  ),
  $$ values ('hi'::text) $$,
  'the staff list shows each login''s language'
);
select lives_ok(
  format($f$ select public.admin_update_staff(%L, '{"ui_lang": "hi"}') $f$, :'m_kitchen'),
  'a manager sets a kitchen login to Hindi'
);
select is(
  (select ui_lang from public.restaurant_members where id = :'m_kitchen'),
  'hi',
  'the kitchen login is now Hindi'
);
select results_eq(
  format(
    $f$ select before, after from public.audit_logs
        where action = 'staff.updated' and entity_id = %L $f$,
    :'m_kitchen'
  ),
  $$ values ('{"ui_lang": "en"}'::jsonb, '{"ui_lang": "hi"}'::jsonb) $$,
  'the change is audit logged with the old and new language'
);
select lives_ok(
  format($f$ select public.admin_update_staff(%L, '{"ui_lang": "hi"}') $f$, :'m_kitchen'),
  'setting the same language again'
);
select is(
  (select count(*) from public.audit_logs where action = 'staff.updated' and entity_id = :'m_kitchen'),
  1::bigint,
  'is not logged again'
);
select throws_ok(
  format($f$ select public.admin_update_staff(%L, '{"ui_lang": "fr"}') $f$, :'m_kitchen'),
  'P0001', 'INVALID_INPUT',
  'an unknown language is refused'
);
select throws_ok(
  format($f$ select public.admin_update_staff(%L, '{"ui_lang": null}') $f$, :'m_kitchen'),
  'P0001', 'INVALID_INPUT',
  'no language is refused'
);
select throws_ok(
  format($f$ select public.admin_update_staff(%L, '{"ui_lang": "hi"}') $f$, :'m_owner'),
  'P0001', 'ROLE_NOT_ALLOWED',
  'a manager cannot set the owner''s language'
);
select throws_ok(
  format($f$ select public.admin_update_staff(%L, '{"ui_lang": "hi"}') $f$, :'m_manager'),
  'P0001', 'CANNOT_CHANGE_SELF',
  'nobody sets their own language here (the account menu does that)'
);
select throws_ok(
  format($f$ select public.admin_update_staff(%L, '{"ui_lang": "en"}') $f$, :'m_b_waiter'),
  'P0001', 'NOT_FOUND',
  'another restaurant''s login is not found'
);
select lives_ok(
  format(
    $f$ select public.admin_update_staff(%L, '{"display_name": "Ravi K", "ui_lang": "en"}') $f$,
    :'m_waiter'
  ),
  'a name and a language change together'
);
select results_eq(
  format(
    $f$ select display_name, ui_lang from public.restaurant_members where id = %L $f$,
    :'m_waiter'
  ),
  $$ values ('Ravi K'::text, 'en'::text) $$,
  'both are saved'
);
select tests.clear_auth();

select tests.authenticate_as(:'a_waiter');
select throws_ok(
  format($f$ select public.admin_update_staff(%L, '{"ui_lang": "hi"}') $f$, :'m_kitchen'),
  'P0001', 'FORBIDDEN',
  'a waiter cannot set another login''s language'
);
select tests.clear_auth();

-- ─── Hindi dish names on the board ──────────────────────────────────────────
select tests.create_ordering_fixture(:'rest_a', 'P11500ALPHATBL05') as fx \gset
select
  :'fx'::jsonb ->> 'table' as table5,
  :'fx'::jsonb ->> 'simple' as paneer,
  :'fx'::jsonb ->> 'variant_item' as chicken,
  :'fx'::jsonb ->> 'half' as half
\gset
-- Paneer Tikka has the owner's Hindi name and an automatic one; Butter
-- Chicken only the automatic one; a third dish has neither.
update public.menu_items set name_hi = 'पनीर टिक्का', name_hi_auto = 'पनीर टिका' where id = :'paneer';
update public.menu_items set name_hi_auto = 'बटर चिकन' where id = :'chicken';
insert into public.menu_items (restaurant_id, category_id, name, food_type, price_paise)
  values (:'rest_a', (:'fx'::jsonb ->> 'starters')::uuid, 'Jeera Rice', 'veg', 15000)
  returning id as rice \gset

select tests.authenticate_as(:'a_manager');
select public.staff_place_order(
  :'table5',
  jsonb_build_array(tests.line(:'paneer'), tests.line(:'chicken', 1, :'half'), tests.line(:'rice')),
  'p11-500-round-1'
);
select tests.clear_auth();

select tests.authenticate_as(:'a_kitchen');
select results_eq(
  $$
    select item ->> 'name', item ->> 'name_hi'
    from jsonb_array_elements(public.staff_get_board() -> 'tables') t,
         jsonb_array_elements(t -> 'session' -> 'rounds') r,
         jsonb_array_elements(r -> 'items') item
    order by item ->> 'name'
  $$,
  $$ values
       ('Butter Chicken'::text, 'बटर चिकन'::text),
       ('Jeera Rice', null),
       ('Paneer Tikka', 'पनीर टिक्का')
  $$,
  'board dishes carry the owner''s Hindi name, else the automatic one, else none'
);
select tests.clear_auth();

select * from finish();
rollback;
