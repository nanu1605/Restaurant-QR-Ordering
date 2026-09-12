-- Staff logins (spec §13.3 Staff logins, §9.5; docs/DECISIONS.md P2-2, P2-5, P2-6).
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

select tests.create_restaurant('alpha') as rest_a \gset
select tests.create_restaurant('bravo') as rest_b \gset
select tests.add_member(:'rest_a', 'owner', 'a_owner') as a_owner \gset
select tests.add_member(:'rest_a', 'manager', 'a_manager') as a_manager \gset
select tests.add_member(:'rest_a', 'waiter', 'a_waiter') as a_waiter \gset
select tests.add_member(:'rest_a', 'kitchen', 'a_kitchen') as a_kitchen \gset
select tests.add_member(:'rest_b', 'waiter', 'b_waiter') as b_waiter \gset

select tests.member_id(:'a_owner') as m_owner \gset
select tests.member_id(:'a_manager') as m_manager \gset
select tests.member_id(:'a_waiter') as m_waiter \gset
select tests.member_id(:'a_kitchen') as m_kitchen \gset
select tests.member_id(:'b_waiter') as m_b_waiter \gset

insert into public.waiters (restaurant_id, full_name, member_id)
  values (:'rest_a', 'Ravi', :'m_waiter')
  returning id as ravi \gset

select tests.create_user('new1@alpha.test') as new1 \gset
select tests.create_user('new2@alpha.test') as new2 \gset
select tests.create_user('new3@alpha.test') as new3 \gset

-- ─── Creating logins (server path: service role + verified actor) ──────────
select ok(
  not has_function_privilege('authenticated', 'public.admin_create_staff(uuid, jsonb)', 'execute'),
  'signed-in users cannot call admin_create_staff directly'
);

select tests.as_service_role();

select lives_ok(
  format(
    $f$ select public.admin_create_staff(%L, %L::jsonb) $f$,
    :'a_manager',
    jsonb_build_object('user_id', :'new1', 'display_name', ' Sunil  K ', 'username', ' Sunil_1 ', 'role', 'waiter')
  ),
  'a manager adds a waiter login'
);
select results_eq(
  format(
    $f$ select display_name, username, role::text, is_active from public.restaurant_members where user_id = %L $f$,
    :'new1'
  ),
  $$ values ('Sunil K', 'sunil_1', 'waiter', true) $$,
  'the login is stored with a tidy name and lowercase username'
);
select is(
  (select count(*) from public.audit_logs where action = 'staff.created' and actor_user_id = :'a_manager'),
  1::bigint,
  'staff creation is audit logged as the manager'
);
select throws_ok(
  format(
    $f$ select public.admin_create_staff(%L, %L::jsonb) $f$,
    :'a_manager',
    jsonb_build_object('user_id', :'new2', 'display_name', 'Boss', 'username', 'boss', 'role', 'manager')
  ),
  'P0001', 'ROLE_NOT_ALLOWED',
  'a manager cannot add managers'
);
select lives_ok(
  format(
    $f$ select public.admin_create_staff(%L, %L::jsonb) $f$,
    :'a_owner',
    jsonb_build_object('user_id', :'new2', 'display_name', 'Deputy', 'username', 'deputy', 'role', 'manager')
  ),
  'the owner adds a manager'
);
select throws_ok(
  format(
    $f$ select public.admin_create_staff(%L, %L::jsonb) $f$,
    :'a_owner',
    jsonb_build_object('user_id', :'new3', 'display_name', 'Clash', 'username', 'SUNIL_1', 'role', 'kitchen')
  ),
  'P0001', 'USERNAME_TAKEN',
  'usernames are unique within a restaurant'
);
select throws_ok(
  format(
    $f$ select public.admin_create_staff(%L, %L::jsonb) $f$,
    :'a_owner',
    jsonb_build_object('user_id', :'new3', 'display_name', 'Bad', 'username', 'no spaces', 'role', 'kitchen')
  ),
  'P0001', 'INVALID_USERNAME',
  'usernames must be 3–30 lowercase letters, digits or underscores'
);
select throws_ok(
  format(
    $f$ select public.admin_create_staff(%L, %L::jsonb) $f$,
    :'a_owner',
    jsonb_build_object('user_id', :'new3', 'display_name', 'Co-owner', 'username', 'coowner', 'role', 'owner')
  ),
  'P0001', 'INVALID_INPUT',
  'owners cannot be added as staff'
);
select throws_ok(
  format(
    $f$ select public.admin_create_staff(%L, %L::jsonb) $f$,
    :'a_owner',
    jsonb_build_object('user_id', :'b_waiter', 'display_name', 'Poached', 'username', 'poached', 'role', 'waiter')
  ),
  'P0001', 'USER_ALREADY_MEMBER',
  'an account that belongs to a restaurant cannot be added again'
);
select throws_ok(
  format(
    $f$ select public.admin_create_staff(%L, %L::jsonb) $f$,
    :'a_owner',
    jsonb_build_object('user_id', gen_random_uuid(), 'display_name', 'Ghost', 'username', 'ghost', 'role', 'waiter')
  ),
  'P0001', 'USER_NOT_FOUND',
  'the auth user must exist'
);
select throws_ok(
  format(
    $f$ select public.admin_create_staff(%L, %L::jsonb) $f$,
    :'a_waiter',
    jsonb_build_object('user_id', :'new3', 'display_name', 'X', 'username', 'xyz', 'role', 'waiter')
  ),
  'P0001', 'FORBIDDEN',
  'a waiter cannot add logins'
);

-- ─── Staff limit (Starter: 3 logins besides the owner) ──────────────────────
select tests.clear_auth();
select tests.create_restaurant('small') as rest_s \gset
select tests.set_plan(:'rest_s', 'starter');
select tests.add_member(:'rest_s', 'owner', 's_owner') as s_owner \gset
select tests.create_user('s1@small.test') as s1 \gset
select tests.create_user('s2@small.test') as s2 \gset
select tests.create_user('s3@small.test') as s3 \gset
select tests.create_user('s4@small.test') as s4 \gset
select tests.as_service_role();

select lives_ok(
  format(
    $f$ select public.admin_create_staff(%L, %L::jsonb), public.admin_create_staff(%L, %L::jsonb),
               public.admin_create_staff(%L, %L::jsonb) $f$,
    :'s_owner', jsonb_build_object('user_id', :'s1', 'display_name', 'One', 'username', 'one', 'role', 'waiter'),
    :'s_owner', jsonb_build_object('user_id', :'s2', 'display_name', 'Two', 'username', 'two', 'role', 'kitchen'),
    :'s_owner', jsonb_build_object('user_id', :'s3', 'display_name', 'Three', 'username', 'three', 'role', 'manager')
  ),
  'a Starter restaurant adds 3 staff logins (the owner does not count)'
);
select throws_ok(
  format(
    $f$ select public.admin_create_staff(%L, %L::jsonb) $f$,
    :'s_owner', jsonb_build_object('user_id', :'s4', 'display_name', 'Four', 'username', 'four', 'role', 'waiter')
  ),
  'P0001', 'PLAN_LIMIT_STAFF',
  'the 4th staff login is blocked on Starter'
);

select tests.member_id(:'s1') as m_s1 \gset
select tests.authenticate_as(:'s_owner');
select lives_ok(
  format($f$ select public.admin_deactivate_staff(%L) $f$, :'m_s1'),
  'deactivating a login frees a slot'
);
select tests.as_service_role();
select lives_ok(
  format(
    $f$ select public.admin_create_staff(%L, %L::jsonb) $f$,
    :'s_owner', jsonb_build_object('user_id', :'s4', 'display_name', 'Four', 'username', 'four', 'role', 'waiter')
  ),
  'the freed slot can be used'
);
select tests.authenticate_as(:'s_owner');
select throws_ok(
  format($f$ select public.admin_reactivate_staff(%L) $f$, :'m_s1'),
  'P0001', 'PLAN_LIMIT_STAFF',
  'reactivating counts against the limit too'
);

-- ─── Editing (signed-in manager of alpha) ───────────────────────────────────
select tests.authenticate_as(:'a_manager');

select is(
  (select count(*) from public.admin_list_staff()),
  6::bigint,
  'the staff list shows every login of the restaurant'
);
select is(
  (select waiter_name from public.admin_list_staff() where username = 'a_waiter'),
  'Ravi',
  'the list shows the linked waiter profile'
);

select lives_ok(
  format($f$ select public.admin_update_staff(%L, '{"display_name": "Kavita R"}') $f$, :'m_kitchen'),
  'a manager renames a kitchen login'
);
select throws_ok(
  format($f$ select public.admin_update_staff(%L, '{"role": "manager"}') $f$, :'m_kitchen'),
  'P0001', 'ROLE_NOT_ALLOWED',
  'a manager cannot promote to manager'
);
select throws_ok(
  format($f$ select public.admin_update_staff(%L, '{"display_name": "Boss"}') $f$, :'m_owner'),
  'P0001', 'ROLE_NOT_ALLOWED',
  'a manager cannot edit the owner'
);
select throws_ok(
  format($f$ select public.admin_update_staff(%L, '{"display_name": "Me"}') $f$, :'m_manager'),
  'P0001', 'CANNOT_CHANGE_SELF',
  'nobody edits their own login here'
);
select throws_ok(
  format($f$ select public.admin_update_staff(%L, '{"display_name": "Poached"}') $f$, :'m_b_waiter'),
  'P0001', 'NOT_FOUND',
  'another restaurant''s login is not found'
);

select lives_ok(
  format($f$ select public.admin_update_staff(%L, '{"role": "kitchen"}') $f$, :'m_waiter'),
  'a waiter login is moved to kitchen'
);
select is(
  (select member_id from public.waiters where id = :'ravi'),
  null,
  'a login that is no longer a waiter is unlinked from its waiter profile'
);
select is(
  (select count(*) from public.audit_logs where action = 'staff.role_changed' and entity_id = :'m_waiter'),
  1::bigint,
  'role changes are audit logged'
);

select lives_ok(format($f$ select public.admin_deactivate_staff(%L) $f$, :'m_kitchen'), 'deactivate');
select lives_ok(format($f$ select public.admin_deactivate_staff(%L) $f$, :'m_kitchen'), 'deactivate again is a no-op');
select is(
  (select count(*) from public.audit_logs where action = 'staff.deactivated' and entity_id = :'m_kitchen'),
  1::bigint,
  'deactivation is logged once'
);
select lives_ok(format($f$ select public.admin_reactivate_staff(%L) $f$, :'m_kitchen'), 'reactivate');
select is((select is_active from public.restaurant_members where id = :'m_kitchen'), true, 'active again');

select is(
  public.admin_reset_staff_password(:'m_kitchen'),
  :'a_kitchen'::uuid,
  'a password reset returns the auth user to update'
);
select is(
  public.admin_reset_staff_password(:'m_manager'),
  :'a_manager'::uuid,
  'you can reset your own password'
);
select throws_ok(
  format($f$ select public.admin_reset_staff_password(%L) $f$, :'m_owner'),
  'P0001', 'ROLE_NOT_ALLOWED',
  'a manager cannot reset the owner''s password'
);
select is(
  (select count(*) from public.audit_logs where action = 'staff.password_reset'),
  2::bigint,
  'password resets are audit logged'
);

select tests.authenticate_as(:'a_owner');
select lives_ok(
  format($f$ select public.admin_update_staff(%L, '{"role": "manager"}') $f$, :'m_kitchen'),
  'the owner promotes kitchen staff to manager'
);

-- ─── Read-only ──────────────────────────────────────────────────────────────
select tests.clear_auth();
select tests.suspend(:'rest_a');
select tests.authenticate_as(:'a_owner');
select throws_ok(
  format($f$ select public.admin_update_staff(%L, '{"display_name": "Late"}') $f$, :'m_waiter'),
  'P0001', 'RESTAURANT_READ_ONLY',
  'read-only restaurants cannot edit logins'
);
select lives_ok(
  format($f$ select public.admin_deactivate_staff(%L) $f$, :'m_waiter'),
  'logins can still be deactivated while read-only'
);
select lives_ok(
  format($f$ select public.admin_reset_staff_password(%L) $f$, :'m_waiter'),
  'passwords can still be reset while read-only'
);
select throws_ok(
  format($f$ select public.admin_reactivate_staff(%L) $f$, :'m_waiter'),
  'P0001', 'RESTAURANT_READ_ONLY',
  'logins cannot be reactivated while read-only'
);

select tests.authenticate_as(:'b_waiter');
select throws_ok(
  $$ select * from public.admin_list_staff() $$,
  'P0001', 'FORBIDDEN',
  'waiters cannot see staff logins'
);

select * from finish();

rollback;
