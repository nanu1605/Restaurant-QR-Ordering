-- Staff login lookup and restaurant onboarding.
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ─── auth_staff_login_email ─────────────────────────────────────────────────
select tests.create_restaurant('alpha') as rest_a \gset
select tests.add_member(:'rest_a', 'waiter', 'waiter1') as waiter1 \gset
select tests.add_member(:'rest_a', 'kitchen', 'gone') as gone \gset
update public.restaurant_members set is_active = false where user_id = :'gone';

select tests.as_service_role();

select is(
  public.auth_staff_login_email('alpha', 'waiter1'),
  'waiter1@alpha.test',
  'resolves the stored email for restaurant code + username'
);
select is(
  public.auth_staff_login_email('  ALPHA ', ' Waiter1 '),
  'waiter1@alpha.test',
  'restaurant code and username are case- and space-insensitive'
);
select is(public.auth_staff_login_email('bravo', 'waiter1'), null, 'wrong restaurant code → null');
select is(public.auth_staff_login_email('alpha', 'nobody'), null, 'unknown username → null');
select is(public.auth_staff_login_email('alpha', 'gone'), null, 'inactive member → null');

select tests.clear_auth();

select ok(
  not has_function_privilege('authenticated', 'public.auth_staff_login_email(text, text)', 'execute')
  and not has_function_privilege('anon', 'public.auth_staff_login_email(text, text)', 'execute'),
  'only the server (service_role) can look up login emails'
);

-- ─── platform_create_restaurant ─────────────────────────────────────────────
select tests.create_user('newowner@example.test') as new_owner \gset

select tests.as_service_role();

select public.platform_create_restaurant(
  jsonb_build_object(
    'name', 'Sharma Dhaba',
    'slug', 'sharma-dhaba',
    'city', 'Jaipur',
    'owner', jsonb_build_object(
      'user_id', :'new_owner', 'display_name', 'Vikram Sharma', 'username', 'Vikram'
    )
  )
) ->> 'restaurant_id' as new_rest \gset

select tests.clear_auth();

select results_eq(
  format(
    $f$select name, slug, city, gst_mode::text, timezone from public.restaurants where id = %L$f$,
    :'new_rest'
  ),
  $$ values ('Sharma Dhaba', 'sharma-dhaba', 'Jaipur', 'none', 'Asia/Kolkata') $$,
  'restaurant created with defaults (GST none, IST)'
);
select results_eq(
  format(
    $f$select role::text, username, display_name, is_active from public.restaurant_members where restaurant_id = %L$f$,
    :'new_rest'
  ),
  $$ values ('owner', 'vikram', 'Vikram Sharma', true) $$,
  'owner membership created with a lowercased username'
);
select results_eq(
  format(
    $f$
      select s.status::text, p.code, s.trial_ends_at = now() + interval '14 days'
      from public.restaurant_subscriptions s join public.plans p on p.id = s.plan_id
      where s.restaurant_id = %L
    $f$,
    :'new_rest'
  ),
  $$ values ('trialing', 'growth', true) $$,
  '14-day Growth trial from platform settings'
);
select is(
  (select count(*) from public.audit_logs where restaurant_id = :'new_rest' and action = 'restaurant.created'),
  1::bigint,
  'onboarding is audit logged'
);

select tests.as_service_role();

select throws_ok(
  format(
    $f$select public.platform_create_restaurant('{"name": "Copy", "slug": "sharma-dhaba", "owner": {"user_id": %s, "display_name": "X", "username": "xyz"}}')$f$,
    to_json(:'new_owner'::text)
  ),
  'P0001',
  'SLUG_TAKEN',
  'duplicate restaurant code is rejected'
);
select throws_ok(
  format(
    $f$select public.platform_create_restaurant('{"name": "Second", "slug": "second-place", "owner": {"user_id": %s, "display_name": "X", "username": "xyz"}}')$f$,
    to_json(:'new_owner'::text)
  ),
  'P0001',
  'USER_ALREADY_MEMBER',
  'an account belongs to at most one restaurant'
);
select throws_ok(
  $$ select public.platform_create_restaurant('{"name": "Bad", "slug": "Bad Slug!", "owner": {}}') $$,
  'P0001',
  'INVALID_SLUG',
  'invalid restaurant code is rejected'
);
select throws_ok(
  $$
    select public.platform_create_restaurant(
      '{"name": "Ghost", "slug": "ghost-kitchen",
        "owner": {"user_id": "00000000-0000-4000-8000-00000000dead", "display_name": "G", "username": "ghost"}}'
    )
  $$,
  'P0001',
  'OWNER_USER_NOT_FOUND',
  'owner must be an existing auth user'
);

select tests.clear_auth();

select ok(
  not has_function_privilege('authenticated', 'public.platform_create_restaurant(jsonb)', 'execute'),
  'signed-in users cannot onboard restaurants directly'
);

select * from finish();

rollback;
