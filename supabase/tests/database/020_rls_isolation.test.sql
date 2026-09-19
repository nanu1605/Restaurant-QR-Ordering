-- Cross-tenant isolation and role rules (spec §9.1, §18).
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ─── Fixtures (as postgres) ─────────────────────────────────────────────────
select tests.create_restaurant('alpha') as rest_a \gset
select tests.create_restaurant('bravo') as rest_b \gset
select tests.create_full_fixture(:'rest_a');
select tests.create_full_fixture(:'rest_b');

select tests.add_member(:'rest_a', 'owner', 'a_owner') as a_owner \gset
select tests.add_member(:'rest_a', 'manager', 'a_manager') as a_manager \gset
select tests.add_member(:'rest_a', 'waiter', 'a_waiter') as a_waiter \gset
select tests.add_member(:'rest_a', 'kitchen', 'a_kitchen') as a_kitchen \gset
select tests.add_member(:'rest_a', 'kitchen', 'a_former') as a_former \gset
update public.restaurant_members set is_active = false where user_id = :'a_former';

select tests.create_platform_admin('platform@admin.test') as platform_admin \gset

select id as a_table from public.dining_tables where restaurant_id = :'rest_a' \gset
select id as b_category from public.menu_categories where restaurant_id = :'rest_b' \gset
select id as a_category from public.menu_categories where restaurant_id = :'rest_a' \gset

-- ─── Every role of A is blind to B in every tenant table ────────────────────
select tests.authenticate_as(:'a_owner');
select tests.rls_isolation(t::regclass, :'rest_b')
from unnest(array[
  'public.restaurants', 'public.restaurant_members', 'public.waiters', 'public.dining_tables',
  'public.menu_categories', 'public.menu_items', 'public.menu_item_variants',
  'public.table_sessions', 'public.session_waiter_assignments', 'public.orders',
  'public.order_items', 'public.invoice_counters', 'public.bills', 'public.bill_payments',
  'public.audit_logs', 'public.restaurant_subscriptions', 'public.subscription_payments'
]) as t;

select tests.authenticate_as(:'a_manager');
select tests.rls_isolation(t::regclass, :'rest_b')
from unnest(array[
  'public.restaurants', 'public.restaurant_members', 'public.waiters', 'public.dining_tables',
  'public.menu_categories', 'public.menu_items', 'public.menu_item_variants',
  'public.table_sessions', 'public.session_waiter_assignments', 'public.orders',
  'public.order_items', 'public.invoice_counters', 'public.bills', 'public.bill_payments',
  'public.audit_logs', 'public.restaurant_subscriptions', 'public.subscription_payments'
]) as t;

select tests.authenticate_as(:'a_waiter');
select tests.rls_isolation(t::regclass, :'rest_b')
from unnest(array[
  'public.restaurants', 'public.restaurant_members', 'public.waiters', 'public.dining_tables',
  'public.menu_categories', 'public.menu_items', 'public.menu_item_variants',
  'public.table_sessions', 'public.orders', 'public.order_items', 'public.bills'
]) as t;

-- ─── Manager of A ───────────────────────────────────────────────────────────
select tests.authenticate_as(:'a_manager');

select is((select count(*) from public.restaurants), 1::bigint, 'manager sees only their restaurant');
select is((select count(*) from public.orders), 1::bigint, 'manager reads their orders');
select is((select count(*) from public.bills), 1::bigint, 'manager reads their bills');
select is((select count(*) from public.audit_logs), 1::bigint, 'manager reads their audit log');
select is(
  (select count(*) from public.restaurant_subscriptions), 0::bigint,
  'manager cannot read the subscription (owner only)'
);
select is((select count(*) from public.plans), 3::bigint, 'signed-in users read plans');
select is((select count(*) from public.webhook_events), 0::bigint, 'manager cannot read webhook events');

-- Menu and tables change only through admin_* functions (docs/DECISIONS.md P2-3).
select throws_ok(
  format(
    $f$insert into public.menu_categories (restaurant_id, name) values (%L, 'Jain Special')$f$,
    :'rest_a'
  ),
  '42501',
  null,
  'manager cannot insert categories directly'
);
select throws_ok(
  format($f$update public.menu_categories set name = 'Chaat' where id = %L$f$, :'a_category'),
  '42501',
  null,
  'manager cannot update categories directly'
);
select throws_ok(
  format(
    $f$
      insert into public.menu_items (restaurant_id, category_id, name, price_paise, food_type)
      values (%L, %L, 'Hack', 100, 'veg')
    $f$,
    :'rest_b', :'b_category'
  ),
  '42501',
  null,
  'manager cannot add an item to another restaurant'
);
select lives_ok(
  $$ select public.admin_create_category('Jain Special') $$,
  'manager adds a category through the function'
);
select lives_ok(
  format($f$select public.admin_update_category(%L, '{"name": "Chaat"}')$f$, :'a_category'),
  'manager renames their category through the function'
);
select throws_ok(
  format($f$select public.admin_update_category(%L, '{"name": "Hack"}')$f$, :'b_category'),
  'P0001',
  'NOT_FOUND',
  'another restaurant''s category is not found'
);

select throws_ok(
  format($f$update public.dining_tables set label = 'Terrace 1' where id = %L$f$, :'a_table'),
  '42501',
  null,
  'tables cannot be renamed directly'
);
select lives_ok(
  format($f$select public.admin_update_table(%L, '{"label": "Terrace 1"}')$f$, :'a_table'),
  'manager renames their table through the function'
);
select throws_ok(
  format($f$update public.dining_tables set qr_token = 'AAAAAAAAAAAAAAAA' where id = %L$f$, :'a_table'),
  '42501',
  null,
  'QR tokens cannot be set directly'
);
select throws_ok(
  format(
    $f$insert into public.dining_tables (restaurant_id, label, qr_token) values (%L, 'T9', 'BBBBBBBBBBBBBBBB')$f$,
    :'rest_a'
  ),
  '42501',
  null,
  'tables cannot be inserted directly (admin_create_tables enforces max_tables)'
);
select throws_ok(
  $$ update public.orders set status = 'removed' $$,
  '42501',
  null,
  'orders cannot be changed directly, even by a manager'
);
select is(
  tests.row_count($$ update public.plans set name = 'Free' $$), 0::bigint,
  'managers cannot edit plans'
);

-- ─── Owner of A ─────────────────────────────────────────────────────────────
select tests.authenticate_as(:'a_owner');
select is(
  (select count(*) from public.restaurant_subscriptions), 1::bigint,
  'owner reads their subscription'
);
select is(
  (select count(*) from public.subscription_payments), 1::bigint,
  'owner reads their subscription payments'
);

-- ─── Waiter and kitchen of A ────────────────────────────────────────────────
select tests.authenticate_as(:'a_waiter');
select is((select count(*) from public.orders), 1::bigint, 'waiter reads their orders');
select is((select count(*) from public.audit_logs), 0::bigint, 'waiter cannot read audit logs');
select is(
  (select count(*) from public.restaurant_subscriptions), 0::bigint,
  'waiter cannot read the subscription'
);
select throws_ok(
  format(
    $f$insert into public.menu_categories (restaurant_id, name) values (%L, 'Waiter menu')$f$,
    :'rest_a'
  ),
  '42501',
  null,
  'waiter cannot edit the menu'
);
select throws_ok(
  $$ select public.platform_create_restaurant('{}'::jsonb) $$,
  '42501',
  null,
  'waiter cannot call platform functions'
);
select throws_ok(
  $$ select public.auth_staff_login_email('alpha', 'a_owner') $$,
  '42501',
  null,
  'signed-in users cannot look up login emails'
);

select tests.authenticate_as(:'a_kitchen');
select is(
  (select count(*) from public.menu_items where is_available), 1::bigint,
  'kitchen reads the menu'
);
select throws_ok(
  $$ update public.menu_items set is_available = false $$,
  '42501',
  null,
  'kitchen cannot write menu items directly (availability goes through a function)'
);

-- ─── Deactivated member ─────────────────────────────────────────────────────
select tests.authenticate_as(:'a_former');
select is((select count(*) from public.restaurants), 0::bigint, 'inactive member sees no restaurant');
select is((select count(*) from public.orders), 0::bigint, 'inactive member sees no orders');

-- ─── Platform admin ─────────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'platform_admin');
select is(
  (select count(*) from public.restaurants where id in (:'rest_a', :'rest_b')), 2::bigint,
  'platform admin reads every restaurant'
);
select is(
  (select count(*) from public.orders), 0::bigint,
  'platform admin does not read tenant orders directly (support view uses the server)'
);
select is(
  (select count(*) from public.restaurant_subscriptions where restaurant_id in (:'rest_a', :'rest_b')),
  2::bigint,
  'platform admin reads subscriptions'
);
select is(
  tests.row_count($$ update public.plans set name = 'Starter' where code = 'starter' $$), 1::bigint,
  'platform admin edits plans'
);

-- ─── Anonymous ──────────────────────────────────────────────────────────────
select tests.as_anon();
select throws_ok(
  format('select count(*) from %s', t),
  '42501',
  null,
  'anon cannot read ' || t
)
from unnest(array[
  'public.restaurants', 'public.restaurant_members', 'public.waiters', 'public.dining_tables',
  'public.menu_categories', 'public.menu_items', 'public.menu_item_variants',
  'public.table_sessions', 'public.orders', 'public.order_items', 'public.bills',
  'public.bill_payments', 'public.audit_logs', 'public.plans', 'public.restaurant_subscriptions',
  'public.platform_admins', 'public.webhook_events'
]) as t;
select throws_ok(
  format($f$select * from public.restaurant_access(%L)$f$, :'rest_a'),
  '42501',
  null,
  'anon cannot read access state'
);

select tests.clear_auth();

select * from finish();

rollback;
