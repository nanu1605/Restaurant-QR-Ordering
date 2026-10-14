-- Super-admin overview, lists and restaurant detail (spec §13.4,
-- docs/DECISIONS.md P7-7, P7-8). The demo seed also has a restaurant, so the
-- overview is checked as the change from a baseline.
begin;
select no_plan();

-- Restaurants left by other runs (E2E) are unsuspended, and their paid
-- subscriptions cancelled, so the filters below only find this file's within
-- the first page; the transaction is rolled back at the end.
update public.restaurants set status = 'active', suspended_reason = null where status = 'suspended';
update public.restaurant_subscriptions set status = 'cancelled' where status = 'active';

select tests.create_platform_admin('platform@admin.test') as admin \gset
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_overview() as before \gset
select tests.clear_auth();

-- alpha: trial with data; beta: paid monthly Growth; gamma: paid yearly Pro;
-- delta: suspended; epsilon: trial ended (read-only); zeta: payment failed,
-- still in grace; eta: trial ending in 3 days; theta: paid manually, but the
-- period ended long ago (still 'active', since nothing renews it); iota: paid
-- and suspended.
select tests.create_restaurant('alpha') as rest_a \gset
select tests.create_restaurant('beta') as rest_b \gset
select tests.create_restaurant('gamma') as rest_c \gset
select tests.create_restaurant('delta') as rest_d \gset
select tests.create_restaurant('epsilon') as rest_e \gset
select tests.create_restaurant('zeta') as rest_f \gset
select tests.create_restaurant('eta') as rest_g \gset
select tests.create_restaurant('theta') as rest_h \gset
select tests.create_restaurant('iota') as rest_i \gset

update public.restaurants set city = 'Testpur' where id in (:'rest_a', :'rest_b');
update public.restaurants set city = 'Bhopal' where id = :'rest_c';
update public.restaurant_subscriptions
  set status = 'active', source = 'manual', billing_cycle = 'monthly',
      current_period_start = now() - interval '10 days', current_period_end = now() + interval '20 days'
  where restaurant_id = :'rest_b';
select tests.set_plan(:'rest_c', 'pro');
update public.restaurant_subscriptions
  set status = 'active', source = 'manual', billing_cycle = 'yearly',
      current_period_start = now() - interval '10 days', current_period_end = now() + interval '355 days'
  where restaurant_id = :'rest_c';
select tests.suspend(:'rest_d');
update public.restaurant_subscriptions set trial_ends_at = now() - interval '3 days'
  where restaurant_id = :'rest_e';
update public.restaurant_subscriptions
  set status = 'past_due', source = 'manual', billing_cycle = 'monthly',
      current_period_start = now() - interval '35 days', current_period_end = now() - interval '5 days',
      grace_until = now() + interval '2 days'
  where restaurant_id = :'rest_f';
update public.restaurant_subscriptions set trial_ends_at = now() + interval '3 days'
  where restaurant_id = :'rest_g';
update public.restaurant_subscriptions
  set status = 'active', source = 'manual', billing_cycle = 'monthly',
      current_period_start = now() - interval '230 days', current_period_end = now() - interval '200 days'
  where restaurant_id = :'rest_h';
update public.restaurant_subscriptions
  set status = 'active', source = 'manual', billing_cycle = 'monthly',
      current_period_start = now() - interval '10 days', current_period_end = now() + interval '20 days'
  where restaurant_id = :'rest_i';
select tests.suspend(:'rest_i');

-- alpha's usage: one table, a bill and an order now, plus orders 8 and 40
-- days ago; an owner with a real email and one with a staff login.
select tests.create_full_fixture(:'rest_a');
insert into public.orders (restaurant_id, session_id, round_number, status, placed_via, idempotency_key, created_at)
select o.restaurant_id, o.session_id, n + 1, 'accepted', 'staff', 'old-order-' || n, now() - make_interval(days => d)
from public.orders o, (values (1, 8), (2, 40)) as v(n, d)
where o.restaurant_id = :'rest_a';
select tests.add_member(:'rest_a', 'owner', 'anita') as a_owner \gset
select tests.add_member(:'rest_a', 'waiter', 'ravi') as a_waiter \gset
select tests.create_user('boss@alpha.staff.tableorder.test') as a_boss \gset
insert into public.restaurant_members (restaurant_id, user_id, role, display_name, username)
values (:'rest_a', :'a_boss', 'owner', 'Boss', 'boss');

-- 52 restaurants for paging.
select tests.create_restaurant('pagetest-' || n) from generate_series(1, 52) as n;

-- ─── Overview ───────────────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_overview() as after \gset

select is(
  (:'after'::jsonb #>> '{restaurants,total}')::int - (:'before'::jsonb #>> '{restaurants,total}')::int,
  61, 'total counts every new restaurant'
);
select is(
  (:'after'::jsonb #>> '{restaurants,trialing}')::int - (:'before'::jsonb #>> '{restaurants,trialing}')::int,
  54, 'trialing: alpha, eta and the 52 paging restaurants'
);
select is(
  (:'after'::jsonb #>> '{restaurants,active}')::int - (:'before'::jsonb #>> '{restaurants,active}')::int,
  2, 'active: beta and gamma'
);
select is(
  (:'after'::jsonb #>> '{restaurants,past_due}')::int - (:'before'::jsonb #>> '{restaurants,past_due}')::int,
  1, 'past due: zeta, still in grace'
);
select is(
  (:'after'::jsonb #>> '{restaurants,read_only}')::int - (:'before'::jsonb #>> '{restaurants,read_only}')::int,
  2, 'read-only: epsilon, whose trial ended, and theta, whose paid period ended'
);
select is(
  (:'after'::jsonb #>> '{restaurants,suspended}')::int - (:'before'::jsonb #>> '{restaurants,suspended}')::int,
  2, 'suspended: delta and iota'
);
select is(
  (:'after'::jsonb ->> 'mrr_paise')::bigint - (:'before'::jsonb ->> 'mrr_paise')::bigint,
  89900::bigint + round(1799000 / 12.0)::bigint,
  'MRR: Growth monthly plus Pro yearly ÷ 12; trials, past due, lapsed and suspended left out'
);
select is(
  (:'after'::jsonb ->> 'orders_24h')::int - (:'before'::jsonb ->> 'orders_24h')::int,
  1, 'orders in the last 24 hours'
);
select ok(
  exists (
    select 1 from jsonb_array_elements(:'after'::jsonb -> 'trials_ending') as t
    where t ->> 'slug' = 'eta'
  ) and not exists (
    select 1 from jsonb_array_elements(:'after'::jsonb -> 'trials_ending') as t
    where t ->> 'slug' in ('alpha', 'epsilon')
  ),
  'trials ending in 7 days: eta, not alpha (14 days) or epsilon (already ended)'
);

-- ─── Restaurants list ───────────────────────────────────────────────────────
-- This file's restaurants in a list's rows (local data may add others).
create function pg_temp.mine(p_list jsonb)
returns jsonb language sql as $$
  select coalesce(jsonb_agg(r ->> 'slug'), '[]') from jsonb_array_elements(p_list -> 'rows') as r
  where r ->> 'slug' in ('alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota');
$$;
select is(
  (select jsonb_agg(r ->> 'slug') from jsonb_array_elements(
    public.platform_list_restaurants('{"q": "gamm"}') -> 'rows') as r),
  '["gamma"]'::jsonb,
  'search by name or code'
);
select is(
  (public.platform_list_restaurants('{"city": "testpur", "sort": "name"}') -> 'rows')
    @> '[{"slug": "alpha"}, {"slug": "beta"}]'::jsonb
  and (public.platform_list_restaurants('{"city": "testpur"}') ->> 'total')::int = 2,
  true,
  'city filter ignores case'
);
select is(
  pg_temp.mine(public.platform_list_restaurants('{"state": "suspended", "sort": "name"}')),
  '["delta", "iota"]'::jsonb,
  'state filter'
);
select is(pg_temp.mine(public.platform_list_restaurants('{"plan": "pro"}')), '["gamma"]'::jsonb,
  'plan filter');
select is(
  pg_temp.mine(public.platform_list_restaurants('{"state": "payment_failed"}')),
  '["zeta"]'::jsonb,
  'payment failed: in grace'
);
select is(
  (select r from jsonb_array_elements(
    public.platform_list_restaurants('{"q": "epsilon"}') -> 'rows') as r) ->> 'access_state',
  'read_only',
  'rows carry the access state'
);
select is(
  public.platform_list_restaurants('{"sort": "last_active"}') #>> '{rows,0,slug}',
  'alpha',
  'sorted by last active: alpha has the newest order'
);
select is(
  (select jsonb_array_length(public.platform_list_restaurants('{"q": "pagetest"}') -> 'rows')),
  50, 'page 1 has 50 rows'
);
select is(
  (select jsonb_array_length(public.platform_list_restaurants('{"q": "pagetest", "page": 2}') -> 'rows')),
  2, 'page 2 has the rest'
);
select is(
  (public.platform_list_restaurants('{"q": "pagetest", "page": 2}') ->> 'total')::int,
  52, 'total counts every match'
);
select ok(
  public.platform_list_restaurants('{}') -> 'cities' @> '["Bhopal", "Testpur"]'::jsonb,
  'cities for the filter'
);
select throws_ok(
  $$ select public.platform_list_restaurants('{"colour": "red"}') $$,
  'P0001', 'INVALID_INPUT', 'unknown filter keys are refused'
);
select throws_ok(
  $$ select public.platform_list_restaurants('{"sort": "random"}') $$,
  'P0001', 'INVALID_INPUT', 'unknown sort is refused'
);

-- ─── Subscriptions list ─────────────────────────────────────────────────────
select ok(
  not exists (
    select 1
    from jsonb_array_elements(public.platform_list_subscriptions('{}') -> 'rows')
      with ordinality as a(r, i)
    join jsonb_array_elements(public.platform_list_subscriptions('{}') -> 'rows')
      with ordinality as b(r, i) on b.i > a.i
    where a.r ->> 'state' <> 'payment_failed' and b.r ->> 'state' = 'payment_failed'
  ),
  'payment problems come first'
);
select is(
  pg_temp.mine(public.platform_list_subscriptions('{"state": "payment_failed"}')),
  '["zeta"]'::jsonb,
  'a state filter'
);
select is(
  (select jsonb_agg(r ->> 'slug' order by r ->> 'slug') from jsonb_array_elements(
    public.platform_list_subscriptions('{"state": "paid"}') -> 'rows') as r
   where r ->> 'slug' in ('beta', 'gamma')),
  '["beta", "gamma"]'::jsonb,
  'paid'
);

-- ─── Restaurant detail ──────────────────────────────────────────────────────
select public.platform_get_restaurant(:'rest_a') as detail \gset
select is(:'detail'::jsonb #>> '{restaurant,slug}', 'alpha', 'profile');
select is(:'detail'::jsonb #>> '{subscription,plan_code}', 'growth', 'plan');
select is(:'detail'::jsonb #>> '{subscription,status}', 'trialing', 'subscription status');
select is(:'detail'::jsonb #>> '{access,state}', 'full', 'access state');
select is(
  :'detail'::jsonb -> 'usage',
  jsonb_build_object(
    'tables_active', 1, 'staff_logins', 1, 'waiters', 1,
    'last_order_at', :'detail'::jsonb #> '{usage,last_order_at}', 'bills', 1
  ),
  'usage: tables, staff logins, waiters, the last order, bills'
);
select is(
  -- Both owners are created in this transaction, so they share a created_at.
  (select jsonb_agg(
     jsonb_build_object('username', o ->> 'username', 'real', o -> 'email_is_real')
     order by o ->> 'username')
   from jsonb_array_elements(:'detail'::jsonb -> 'owners') as o),
  '[{"username": "anita", "real": true}, {"username": "boss", "real": false}]'::jsonb,
  'owners, with staff login addresses flagged as not real'
);
select is(
  jsonb_array_length(:'detail'::jsonb -> 'payments'), 1, 'payment history'
);
select throws_ok(
  format('select public.platform_get_restaurant(%L)', gen_random_uuid()),
  'P0001', 'RESTAURANT_NOT_FOUND', 'unknown restaurant'
);

-- ─── Who may read ───────────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin', 'aal1');
select throws_ok(
  $$ select public.platform_overview() $$, 'P0001', 'MFA_REQUIRED', 'password only: MFA_REQUIRED'
);
select throws_ok(
  format('select public.platform_get_restaurant(%L)', :'rest_a'),
  'P0001', 'MFA_REQUIRED', 'password only: no detail'
);
select tests.authenticate_as(:'a_owner');
select throws_ok(
  $$ select public.platform_list_restaurants('{}') $$, 'P0001', 'FORBIDDEN', 'an owner is refused'
);
select throws_ok(
  $$ select public.platform_list_subscriptions('{}') $$, 'P0001', 'FORBIDDEN', 'an owner is refused'
);

select tests.clear_auth();
select * from finish();
rollback;
