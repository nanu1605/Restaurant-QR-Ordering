-- "Forgot password" (spec §9.5, docs/DECISIONS.md P11-6 to P11-9): only the
-- server starts, verifies and finishes resets; a code is sent only to accounts
-- with a real address; an email without one answers like any other; one email
-- or network can't flood the table; a code allows five wrong tries; a used
-- code stops working; each reset is in the audit log.
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

select tests.create_restaurant('reset-one') as rest_one \gset
select tests.create_restaurant('reset-two') as rest_two \gset
select tests.create_user('Owner@Reset.test') as owner \gset
insert into public.restaurant_members (restaurant_id, user_id, role, display_name, username)
values (:'rest_one', :'owner', 'owner', 'Asha', 'owner'),
       (:'rest_two', :'owner', 'owner', 'Asha', 'owner');
select tests.create_user('waiter@reset-one.staff.menumesh.in') as waiter \gset
insert into public.restaurant_members (restaurant_id, user_id, role, display_name, username)
values (:'rest_one', :'waiter', 'waiter', 'Ravi', 'waiter');
select tests.create_platform_admin('admin@reset.test') as admin \gset

\set ip '''aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'''
\set net '''cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'''
\set right '''1111111111111111111111111111111111111111111111111111111111111111'''
\set wrong '''2222222222222222222222222222222222222222222222222222222222222222'''

-- ─── Grants ─────────────────────────────────────────────────────────────────
select ok(
  has_function_privilege('service_role', 'public.auth_password_reset_start(text, text, text)', 'execute')
    and has_function_privilege('service_role', 'public.auth_password_reset_verify(uuid, text)', 'execute')
    and has_function_privilege('service_role', 'public.auth_password_reset_finish(uuid)', 'execute')
    and has_function_privilege('service_role', 'public.password_resets_cleanup()', 'execute'),
  'the server starts, verifies, finishes and cleans up resets'
);
select ok(
  not has_function_privilege('anon', 'public.auth_password_reset_start(text, text, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.auth_password_reset_start(text, text, text)', 'execute')
    and not has_function_privilege('anon', 'public.auth_password_reset_verify(uuid, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.auth_password_reset_verify(uuid, text)', 'execute')
    and not has_function_privilege('anon', 'public.auth_password_reset_finish(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.auth_password_reset_finish(uuid)', 'execute')
    and not has_function_privilege('anon', 'public.password_resets_cleanup()', 'execute')
    and not has_function_privilege('authenticated', 'public.password_resets_cleanup()', 'execute'),
  'nobody else can'
);

select tests.as_anon();
select throws_ok(
  $$select public.auth_password_reset_start('owner@reset.test', repeat('a', 64))$$,
  '42501', null, 'visitors cannot start a reset directly'
);
select throws_ok($$select * from public.password_resets$$, '42501', null, 'visitors cannot read resets');
select tests.authenticate_as(:'owner');
select throws_ok(
  $$select public.auth_password_reset_verify(gen_random_uuid(), repeat('a', 64))$$,
  '42501', null, 'signed-in users cannot check a code directly'
);
select throws_ok($$select * from public.password_resets$$, '42501', null, 'signed-in users cannot read resets');
select tests.clear_auth();

-- ─── Starting ───────────────────────────────────────────────────────────────
select tests.as_service_role();

select public.auth_password_reset_start('  OWNER@reset.TEST ', :right, :ip) as owner_reset \gset
select is((:'owner_reset'::jsonb) ->> 'send', 'true', 'an owner with a real address gets a code');
select is(
  (select user_id from public.password_resets where id = ((:'owner_reset'::jsonb) ->> 'id')::uuid),
  :'owner'::uuid,
  'the request is for that account, whatever the case and spaces typed'
);

select public.auth_password_reset_start('waiter@reset-one.staff.menumesh.in', :right, :net) as waiter_reset \gset
select is((:'waiter_reset'::jsonb) ->> 'send', 'false', 'a staff login''s made-up address gets nothing');
select public.auth_password_reset_start('nobody@reset.test', :right, :net) as nobody_reset \gset
select is((:'nobody_reset'::jsonb) ->> 'send', 'false', 'an email without an account gets nothing');
select is(
  (select count(*)::int from public.password_resets where id in (
    ((:'waiter_reset'::jsonb) ->> 'id')::uuid, ((:'nobody_reset'::jsonb) ->> 'id')::uuid)),
  2,
  'but every request is stored, so the answers and limits look the same'
);

select throws_ok(
  $$select public.auth_password_reset_start('not-an-email', repeat('a', 64))$$,
  'P0001', 'INVALID_INPUT', 'a malformed email is refused'
);
select throws_ok(
  $$select public.auth_password_reset_start('owner@reset.test', 'abc')$$,
  'P0001', 'INVALID_INPUT', 'so is a malformed hash'
);

-- Three requests an hour for one email, account or not.
select public.auth_password_reset_start('nobody@reset.test', :right);
select public.auth_password_reset_start('nobody@reset.test', :right);
select throws_ok(
  $$select public.auth_password_reset_start('nobody@reset.test', repeat('1', 64))$$,
  'P0001', 'RATE_LIMITED', 'a fourth request within the hour is refused'
);
select public.auth_password_reset_start('owner@reset.test', :right);
select public.auth_password_reset_start('owner@reset.test', :right);
select throws_ok(
  $$select public.auth_password_reset_start('owner@reset.test', repeat('1', 64))$$,
  'P0001', 'RATE_LIMITED', 'the same limit for an email with an account'
);
select tests.clear_auth();
update public.password_resets set created_at = now() - interval '61 minutes'
where email in ('nobody@reset.test', 'owner@reset.test');
select tests.as_service_role();
select lives_ok(
  $$select public.auth_password_reset_start('nobody@reset.test', repeat('1', 64))$$,
  'an hour later the email can ask again'
);

-- Ten a day from one network, whatever the emails.
select public.auth_password_reset_start('net' || n || '@reset.test', :right, :net)
from generate_series(1, 8) n;
select throws_ok(
  format('select public.auth_password_reset_start(%L, repeat(%L, 64), %L)', 'net9@reset.test', '1', :net),
  'P0001', 'RATE_LIMITED', 'an eleventh request from one network within the day is refused'
);
select lives_ok(
  format('select public.auth_password_reset_start(%L, repeat(%L, 64), %L)', 'net9@reset.test', '1', :ip),
  'another network still can'
);

-- ─── Checking a code ────────────────────────────────────────────────────────
select public.auth_password_reset_start('admin@reset.test', :right) as admin_reset \gset

select is(
  public.auth_password_reset_verify((:'admin_reset'::jsonb ->> 'id')::uuid, :wrong),
  '{"status": "wrong", "tries_left": 4}'::jsonb,
  'a wrong code says how many tries are left'
);
select is(
  public.auth_password_reset_verify((:'admin_reset'::jsonb ->> 'id')::uuid, :right),
  jsonb_build_object('status', 'ok', 'user_id', :'admin'::uuid, 'email', 'admin@reset.test'),
  'the right code names the account'
);
select is(
  public.auth_password_reset_verify((:'admin_reset'::jsonb ->> 'id')::uuid, :right) ->> 'status',
  'ok',
  'and still works until the new password is saved'
);

select is(
  public.auth_password_reset_verify((:'nobody_reset'::jsonb ->> 'id')::uuid, :right),
  '{"status": "wrong", "tries_left": 4}'::jsonb,
  'an email without an account answers like a wrong code, even with the stored code'
);
select is(
  public.auth_password_reset_verify((:'waiter_reset'::jsonb ->> 'id')::uuid, :right),
  '{"status": "wrong", "tries_left": 4}'::jsonb,
  'so does a staff login'
);

select is(
  array_agg(public.auth_password_reset_verify((:'nobody_reset'::jsonb ->> 'id')::uuid, :wrong) ->> 'status'),
  array['wrong', 'wrong', 'wrong', 'locked'],
  'the fifth wrong try locks the code'
) from generate_series(1, 4);
select is(
  public.auth_password_reset_verify((:'nobody_reset'::jsonb ->> 'id')::uuid, :right),
  '{"status": "locked"}'::jsonb,
  'and it stays locked'
);

select public.auth_password_reset_start('Owner@reset.test', :right) as late_reset \gset
select tests.clear_auth();
update public.password_resets set expires_at = now() - interval '1 second'
where id = (:'late_reset'::jsonb ->> 'id')::uuid;
select tests.as_service_role();
select is(
  public.auth_password_reset_verify((:'late_reset'::jsonb ->> 'id')::uuid, :right),
  '{"status": "expired"}'::jsonb,
  'a code works for 15 minutes'
);
select is(
  public.auth_password_reset_verify(gen_random_uuid(), :right),
  '{"status": "gone"}'::jsonb,
  'an unknown request is gone'
);

-- ─── Finishing ──────────────────────────────────────────────────────────────
select public.auth_password_reset_finish((:'owner_reset'::jsonb ->> 'id')::uuid);
select is(
  public.auth_password_reset_verify((:'owner_reset'::jsonb ->> 'id')::uuid, :right),
  '{"status": "gone"}'::jsonb,
  'once the password is saved, the code stops working'
);
select results_eq(
  format(
    $$select restaurant_id, actor_type::text, actor_user_id, actor_role::text, actor_label, action, reason
      from public.audit_logs where action = 'staff.password_reset' and actor_user_id = %L
      order by restaurant_id$$,
    :'owner'
  ),
  format(
    $$values (%L::uuid, 'staff', %L::uuid, 'owner', 'Asha', 'staff.password_reset', 'Reset with an emailed code'),
             (%L::uuid, 'staff', %L::uuid, 'owner', 'Asha', 'staff.password_reset', 'Reset with an emailed code')
      order by 1$$,
    :'rest_one', :'owner', :'rest_two', :'owner'
  ),
  'the reset is in the audit log of each restaurant the owner works in'
);
select public.auth_password_reset_finish((:'owner_reset'::jsonb ->> 'id')::uuid);
select is(
  (select count(*)::int from public.audit_logs where action = 'staff.password_reset' and actor_user_id = :'owner'),
  2,
  'finishing twice records it once'
);

select public.auth_password_reset_finish((:'admin_reset'::jsonb ->> 'id')::uuid);
select results_eq(
  format(
    $$select restaurant_id, actor_type::text, actor_label, action from public.audit_logs
      where actor_user_id = %L$$, :'admin'
  ),
  $$values (null::uuid, 'platform_admin', 'Platform admin', 'platform_admin.password_reset')$$,
  'a platform admin''s reset is in the platform''s audit log'
);

select public.auth_password_reset_finish((:'waiter_reset'::jsonb ->> 'id')::uuid);
select ok(
  (select used_at is null from public.password_resets where id = (:'waiter_reset'::jsonb ->> 'id')::uuid),
  'a request without an account can''t be finished'
);
select is(
  (select count(*)::int from public.audit_logs where actor_user_id = :'waiter'),
  0,
  'and records nothing'
);

-- ─── Cleanup ────────────────────────────────────────────────────────────────
select tests.clear_auth();
update public.password_resets set created_at = now() - interval '25 hours'
where id = (:'owner_reset'::jsonb ->> 'id')::uuid;
select tests.as_service_role();
select is(public.password_resets_cleanup(), 1, 'requests are deleted after a day');

select tests.clear_auth();
select tests.create_user('gone@reset.test') as gone \gset
select tests.as_service_role();
select public.auth_password_reset_start('gone@reset.test', :right) as gone_reset \gset
select tests.clear_auth();
delete from auth.users where id = :'gone';
select is(
  (select count(*)::int from public.password_resets where id = (:'gone_reset'::jsonb ->> 'id')::uuid),
  0,
  'a deleted account takes its requests with it'
);

select * from finish();
rollback;
