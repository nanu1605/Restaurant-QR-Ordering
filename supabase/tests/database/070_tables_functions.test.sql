-- Dining tables and QR codes (spec §13.3 Tables & QR, §14.2 max_tables).
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

select tests.create_restaurant('alpha') as rest_a \gset
select tests.create_restaurant('bravo') as rest_b \gset
select tests.create_restaurant('small') as rest_s \gset
select tests.set_plan(:'rest_s', 'starter');
select tests.add_member(:'rest_a', 'manager', 'a_manager') as a_manager \gset
select tests.add_member(:'rest_a', 'waiter', 'a_waiter') as a_waiter \gset
select tests.add_member(:'rest_s', 'owner', 's_owner') as s_owner \gset

insert into public.dining_tables (restaurant_id, label, qr_token)
  values (:'rest_b', 'B1', private.random_base62(16))
  returning id as b_table \gset

select tests.authenticate_as(:'a_manager');

-- ─── Creating ───────────────────────────────────────────────────────────────
select is(
  jsonb_array_length(public.admin_create_tables(array['1', '2', '  Terrace   3 '])),
  3,
  'tables are created in one call'
);
select results_eq(
  $$ select label, sort_order from public.dining_tables order by sort_order $$,
  $$ values ('1', 1), ('2', 2), ('Terrace 3', 3) $$,
  'labels are tidied and tables keep the given order'
);
select is(
  (select count(*) from public.dining_tables where qr_token ~ '^[A-Za-z0-9]{16}$'),
  3::bigint,
  'each table gets a 16-character QR token'
);
select is(
  (select count(distinct qr_token) from public.dining_tables),
  3::bigint,
  'QR tokens are unique'
);

select throws_ok(
  $$ select public.admin_create_tables(array['4', '4']) $$,
  'P0001', 'TABLE_LABEL_DUPLICATE',
  'the same label twice in one call is rejected'
);
select throws_ok(
  $$ select public.admin_create_tables(array['terrace 3']) $$,
  'P0001', 'TABLE_LABEL_TAKEN',
  'labels are unique among active tables, ignoring case and spacing'
);
select throws_ok(
  $$ select public.admin_create_tables(array['5', '  ']) $$,
  'P0001', 'INVALID_TABLE_LABEL',
  'blank labels are rejected'
);
select throws_ok(
  $$ select public.admin_create_tables(array(select g::text from generate_series(100, 200) as g)) $$,
  'P0001', 'INVALID_INPUT',
  'at most 100 tables per call'
);

-- ─── Editing ────────────────────────────────────────────────────────────────
select id as t1 from public.dining_tables where label = '1' \gset
select id as t2 from public.dining_tables where label = '2' \gset
select id as t3 from public.dining_tables where label = 'Terrace 3' \gset

select lives_ok(
  format($f$ select public.admin_update_table(%L, '{"label": "Window 1"}') $f$, :'t1'),
  'a table can be renamed'
);
select throws_ok(
  format($f$ select public.admin_update_table(%L, '{"label": "window 1"}') $f$, :'t2'),
  'P0001', 'TABLE_LABEL_TAKEN',
  'renaming onto another active label is rejected'
);
select lives_ok(
  format($f$ select public.admin_update_table(%L, '{"is_active": false}') $f$, :'t2'),
  'a table can be deactivated'
);
select lives_ok(
  $$ select public.admin_create_tables(array['2']) $$,
  'an inactive table''s label can be reused'
);
select throws_ok(
  format($f$ select public.admin_update_table(%L, '{"is_active": true}') $f$, :'t2'),
  'P0001', 'TABLE_LABEL_TAKEN',
  'reactivating a table whose label is now taken is rejected'
);
select throws_ok(
  format($f$ select public.admin_update_table(%L, '{"label": "Mine"}') $f$, :'b_table'),
  'P0001', 'NOT_FOUND',
  'another restaurant''s table is not found'
);

select tests.clear_auth();
insert into public.table_sessions (restaurant_id, dining_table_id, table_label_snapshot)
  values (:'rest_a', :'t3', 'Terrace 3');
select tests.authenticate_as(:'a_manager');
select throws_ok(
  format($f$ select public.admin_update_table(%L, '{"is_active": false}') $f$, :'t3'),
  'P0001', 'TABLE_HAS_OPEN_SESSION',
  'a table with an open session cannot be deactivated'
);

select lives_ok(
  format($f$ select public.admin_reorder('tables', array[%L, %L]::uuid[]) $f$, :'t3', :'t1'),
  'tables can be reordered'
);
select is(
  (select label from public.dining_tables where is_active order by sort_order limit 1),
  'Terrace 3',
  'table order saved'
);

-- ─── QR regeneration ────────────────────────────────────────────────────────
select qr_token as old_token from public.dining_tables where id = :'t1' \gset
select public.admin_regenerate_qr(:'t1') as new_token \gset
select isnt(:'new_token'::text, :'old_token'::text, 'regenerating gives a new QR token');
select is(
  (select qr_token from public.dining_tables where id = :'t1'),
  :'new_token',
  'the new token is stored'
);
select is(
  (select count(*) from public.audit_logs where action = 'table.qr_regenerated' and entity_id = :'t1'),
  1::bigint,
  'QR regeneration is audit logged'
);
select throws_ok(
  format($f$ select public.admin_regenerate_qr(%L) $f$, :'b_table'),
  'P0001', 'NOT_FOUND',
  'another restaurant''s QR cannot be regenerated'
);

select tests.authenticate_as(:'a_waiter');
select throws_ok(
  $$ select public.admin_create_tables(array['W1']) $$,
  'P0001', 'FORBIDDEN',
  'waiters cannot create tables'
);

-- ─── Starter plan: 8 tables (spec §19 Phase 2 acceptance) ───────────────────
select tests.authenticate_as(:'s_owner');
select lives_ok(
  $$ select public.admin_create_tables(array['1', '2', '3', '4', '5', '6', '7', '8']) $$,
  'a Starter restaurant creates its 8 tables'
);
select throws_ok(
  $$ select public.admin_create_tables(array['9']) $$,
  'P0001', 'PLAN_LIMIT_TABLES',
  'the 9th table is blocked on Starter'
);
select id as s1 from public.dining_tables where label = '1' \gset
select lives_ok(
  format($f$ select public.admin_update_table(%L, '{"is_active": false}') $f$, :'s1'),
  'deactivating frees a slot'
);
select lives_ok($$ select public.admin_create_tables(array['9']) $$, 'the freed slot can be used');
select throws_ok(
  format($f$ select public.admin_update_table(%L, '{"is_active": true}') $f$, :'s1'),
  'P0001', 'PLAN_LIMIT_TABLES',
  'reactivating counts against the limit too'
);

-- ─── Read-only ──────────────────────────────────────────────────────────────
select tests.clear_auth();
select tests.suspend(:'rest_a');
select tests.authenticate_as(:'a_manager');
select throws_ok(
  $$ select public.admin_create_tables(array['New']) $$,
  'P0001', 'RESTAURANT_READ_ONLY',
  'read-only restaurants cannot add tables'
);

select * from finish();

rollback;
