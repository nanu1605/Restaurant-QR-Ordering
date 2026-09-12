-- Structural guards: every future migration must keep these true.
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ─── RLS and privileges ─────────────────────────────────────────────────────
select is_empty(
  $$
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
  $$,
  'RLS is enabled on every public table'
);

select is_empty(
  $$
    select table_name || ':' || privilege_type
    from information_schema.role_table_grants
    where grantee = 'anon' and table_schema = 'public'
  $$,
  'anon has no privileges on any public table'
);

select is_empty(
  $$
    select table_name || ':' || privilege_type
    from information_schema.role_table_grants
    where grantee = 'authenticated'
      and table_schema = 'public'
      and privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER')
  $$,
  'authenticated never gets TRUNCATE, REFERENCES or TRIGGER'
);

-- Only the menu (plain CRUD, spec §9.1) and plans (platform admins, via RLS)
-- accept direct writes; everything else changes through business functions.
select is_empty(
  $$
    select table_name || ':' || privilege_type
    from information_schema.role_table_grants
    where grantee = 'authenticated'
      and table_schema = 'public'
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
      and table_name not in ('menu_categories', 'menu_items', 'menu_item_variants', 'plans')
  $$,
  'state tables accept no direct writes from authenticated users'
);

select set_eq(
  $$
    select column_name::text
    from information_schema.column_privileges
    where grantee = 'authenticated'
      and table_schema = 'public'
      and table_name = 'dining_tables'
      and privilege_type = 'UPDATE'
  $$,
  $$ values ('label'), ('sort_order'), ('is_active') $$,
  'dining_tables: only label, sort_order and is_active are directly updatable'
);

select is_empty(
  $$
    select n.nspname || '.' || p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and has_function_privilege('anon', p.oid, 'execute')
  $$,
  'anon cannot execute any public or private function'
);

-- Every function callable by signed-in users must be listed here on purpose.
select set_eq(
  $$
    select n.nspname || '.' || p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and has_function_privilege('authenticated', p.oid, 'execute')
  $$,
  $$
    values
      ('public.is_platform_admin'),
      ('public.member_role'),
      ('public.has_role'),
      ('public.restaurant_access'),
      ('private.my_restaurant_ids'),
      ('private.is_valid_timezone')
  $$,
  'authenticated can execute only the allowlisted functions'
);

select set_eq(
  $$
    select n.nspname || '.' || p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and not exists (
        select 1 from unnest(p.proconfig) as c where c like 'search_path=%'
      )
  $$,
  $$ select null::text where false $$,
  'every security definer function pins its search_path'
);

-- ─── Tenant tables ──────────────────────────────────────────────────────────
select col_not_null('public', t, 'restaurant_id', t || '.restaurant_id is not null')
from unnest(array[
  'restaurant_members', 'waiters', 'dining_tables', 'menu_categories', 'menu_items',
  'menu_item_variants', 'table_sessions', 'session_waiter_assignments', 'orders',
  'order_items', 'invoice_counters', 'bills', 'bill_payments',
  'restaurant_subscriptions', 'subscription_payments'
]) as t;

select is_empty(
  $$
    select t
    from unnest(array[
      'restaurant_members', 'waiters', 'dining_tables', 'menu_categories', 'menu_items',
      'menu_item_variants', 'table_sessions', 'session_waiter_assignments', 'orders',
      'order_items', 'invoice_counters', 'bills', 'bill_payments', 'audit_logs',
      'restaurant_subscriptions', 'subscription_payments'
    ]) as t
    where not exists (
      select 1
      from pg_index i
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
      where i.indrelid = ('public.' || t)::regclass and a.attname = 'restaurant_id'
    )
  $$,
  'every tenant table has an index leading with restaurant_id'
);

-- ─── Realtime ───────────────────────────────────────────────────────────────
select set_eq(
  $$
    select tablename::text from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
  $$,
  $$
    values ('orders'), ('order_items'), ('table_sessions'), ('bills'), ('menu_items'), ('waiters')
  $$,
  'realtime publishes exactly the live-board tables (spec §8.11)'
);

-- ─── Integrity constraints ──────────────────────────────────────────────────
select tests.create_restaurant('guards') as rest \gset
select tests.create_full_fixture(:'rest');

select throws_ok(
  format(
    $f$
      insert into public.table_sessions (restaurant_id, dining_table_id, table_label_snapshot)
      select %L, id, label from public.dining_tables where restaurant_id = %L
    $f$,
    :'rest', :'rest'
  ),
  '23505',
  null,
  'a table cannot have two open sessions'
);

select tests.create_restaurant('other') as other_rest \gset
select tests.create_full_fixture(:'other_rest');

select throws_ok(
  format(
    $f$
      insert into public.menu_items (restaurant_id, category_id, name, price_paise, food_type)
      select %L, id, 'Cross', 100, 'veg' from public.menu_categories where restaurant_id = %L
    $f$,
    :'rest', :'other_rest'
  ),
  '23503',
  null,
  'an item cannot point at another restaurant''s category'
);

select * from finish();

rollback;
