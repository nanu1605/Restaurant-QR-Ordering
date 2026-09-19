-- Platform admins need an aal2 session (password + TOTP) before they see any
-- restaurant (docs/DECISIONS.md P7-1).
begin;
select no_plan();

select tests.create_restaurant('alpha') as rest_a \gset
select tests.add_member(:'rest_a', 'owner', 'a_owner') as a_owner \gset
select tests.create_platform_admin('platform@admin.test') as admin \gset
select tests.create_user('nobody@example.test') as nobody \gset

-- ─── Status ─────────────────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin', 'aal1');
select is(public.platform_admin_status(), 'mfa_required', 'password only: the code is still needed');
select is(public.is_platform_admin(), false, 'password only: not a platform admin yet');

select tests.authenticate_as_platform_admin(:'admin');
select is(public.platform_admin_status(), 'ok', 'with the code: ok');
select is(public.is_platform_admin(), true, 'with the code: a platform admin');

select tests.authenticate_as(:'a_owner');
select is(public.platform_admin_status(), 'none', 'an owner is not a platform admin');

-- A member with an aal2 session is still not a platform admin.
select tests.authenticate_as_platform_admin(:'a_owner');
select is(public.platform_admin_status(), 'none', 'aal2 alone does not make a platform admin');
select is(public.is_platform_admin(), false, 'aal2 member: is_platform_admin is false');

select tests.authenticate_as(:'nobody');
select is(public.platform_admin_status(), 'none', 'a user without a restaurant is not a platform admin');

-- ─── Password only sees nothing ─────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin', 'aal1');
select is((select count(*) from public.restaurants), 0::bigint, 'aal1: no restaurants');
select is(
  (select count(*) from public.restaurant_subscriptions), 0::bigint, 'aal1: no subscriptions'
);
select is((select count(*) from public.audit_logs), 0::bigint, 'aal1: no audit log');
select is((select count(*) from public.platform_settings), 0::bigint, 'aal1: no platform settings');
select throws_ok(
  format($f$select * from public.restaurant_access(%L)$f$, :'rest_a'),
  'P0001', 'FORBIDDEN',
  'aal1: no access state for a restaurant'
);

-- ─── With the code ──────────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select is(
  (select count(*) from public.restaurants where id = :'rest_a'), 1::bigint, 'aal2: reads restaurants'
);
select is(
  (select state from public.restaurant_access(:'rest_a')), 'full', 'aal2: reads access state'
);

-- ─── Members are unaffected ─────────────────────────────────────────────────
select tests.authenticate_as(:'a_owner');
select is(
  (select count(*) from public.restaurants where id = :'rest_a'), 1::bigint,
  'an owner at aal1 still reads their restaurant'
);

select tests.clear_auth();
select * from finish();
rollback;
