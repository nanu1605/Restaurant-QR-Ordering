-- Waiter profiles (spec §8.2 waiters, §13.3 Waiters; docs/DECISIONS.md P2-12).
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

select tests.create_restaurant('alpha') as rest_a \gset
select tests.create_restaurant('bravo') as rest_b \gset
select tests.add_member(:'rest_a', 'manager', 'a_manager') as a_manager \gset
select tests.add_member(:'rest_a', 'waiter', 'a_waiter1') as a_waiter1 \gset
select tests.add_member(:'rest_a', 'kitchen', 'a_kitchen') as a_kitchen \gset
select tests.add_member(:'rest_b', 'waiter', 'b_waiter') as b_waiter \gset
select tests.member_id(:'a_waiter1') as m_waiter1 \gset
select tests.member_id(:'a_kitchen') as m_kitchen \gset
select tests.member_id(:'b_waiter') as m_b_waiter \gset

insert into public.waiters (restaurant_id, full_name) values (:'rest_b', 'Bravo Waiter')
  returning id as b_profile \gset
insert into public.dining_tables (restaurant_id, label, qr_token)
  values (:'rest_a', '3', private.random_base62(16))
  returning id as table3 \gset

select tests.authenticate_as(:'a_manager');

-- ─── Creating and editing ───────────────────────────────────────────────────
select public.admin_upsert_waiter(jsonb_build_object(
  'full_name', '  Ravi   Kumar ', 'phone', '98765 43210', 'employee_code', 'E1',
  'joined_on', '2026-08-01', 'notes', 'Evening shift', 'member_id', :'m_waiter1'
)) as ravi \gset

select results_eq(
  format(
    $f$ select full_name, phone, employee_code, joined_on, notes, member_id, on_duty, is_active
        from public.waiters where id = %L $f$,
    :'ravi'
  ),
  format(
    $f$ values ('Ravi Kumar', '9876543210', 'E1', '2026-08-01'::date, 'Evening shift', %L::uuid, true, true) $f$,
    :'m_waiter1'
  ),
  'a waiter profile is created on duty, linked to a waiter login'
);
select is(
  (select count(*) from public.audit_logs where action = 'waiter.created' and entity_id = :'ravi'),
  1::bigint,
  'creation is audit logged'
);

select public.admin_upsert_waiter('{"full_name": "Suresh"}') as suresh \gset
select public.admin_upsert_waiter('{"full_name": "Anita", "employee_code": "E3"}') as anita \gset

select throws_ok(
  $$ select public.admin_upsert_waiter('{"full_name": "Dup", "employee_code": "e1"}') $$,
  'P0001', 'WAITER_CODE_TAKEN',
  'employee codes are unique among active waiters, ignoring case'
);
select throws_ok(
  $$ select public.admin_upsert_waiter('{"full_name": "Bad phone", "phone": "12345"}') $$,
  'P0001', 'INVALID_PHONE',
  'phone numbers must be 10-digit Indian mobiles'
);
select throws_ok(
  $$ select public.admin_upsert_waiter('{"full_name": ""}') $$,
  'P0001', 'INVALID_WAITER_NAME',
  'a name is required'
);
select throws_ok(
  $$ select public.admin_upsert_waiter('{"full_name": "Date", "joined_on": "2026-13-40"}') $$,
  'P0001', 'INVALID_INPUT',
  'invalid dates are rejected'
);
select throws_ok(
  format(
    $f$ select public.admin_upsert_waiter(%L::jsonb) $f$,
    jsonb_build_object('id', :'suresh', 'full_name', 'Suresh', 'member_id', :'m_waiter1')
  ),
  'P0001', 'LOGIN_ALREADY_LINKED',
  'a login links to one waiter profile only'
);
select throws_ok(
  format(
    $f$ select public.admin_upsert_waiter(%L::jsonb) $f$,
    jsonb_build_object('id', :'suresh', 'full_name', 'Suresh', 'member_id', :'m_kitchen')
  ),
  'P0001', 'LOGIN_NOT_WAITER',
  'only waiter logins can be linked'
);
select throws_ok(
  format(
    $f$ select public.admin_upsert_waiter(%L::jsonb) $f$,
    jsonb_build_object('id', :'suresh', 'full_name', 'Suresh', 'member_id', :'m_b_waiter')
  ),
  'P0001', 'LOGIN_NOT_WAITER',
  'another restaurant''s login cannot be linked'
);
select throws_ok(
  format(
    $f$ select public.admin_upsert_waiter(%L::jsonb) $f$,
    jsonb_build_object('id', :'b_profile', 'full_name', 'Mine now')
  ),
  'P0001', 'NOT_FOUND',
  'another restaurant''s profile is not found'
);

select lives_ok(
  format(
    $f$ select public.admin_upsert_waiter(%L::jsonb) $f$,
    jsonb_build_object('id', :'suresh', 'full_name', 'Suresh Patel', 'notes', 'Weekends')
  ),
  'a profile can be edited'
);
select results_eq(
  format(
    $f$ select before ->> 'full_name', after ->> 'full_name', after ->> 'notes'
        from public.audit_logs where action = 'waiter.updated' and entity_id = %L $f$,
    :'suresh'
  ),
  $$ values ('Suresh', 'Suresh Patel', 'Weekends') $$,
  'edits are audit logged with before and after'
);

-- ─── On duty ────────────────────────────────────────────────────────────────
select lives_ok(format($f$ select public.admin_set_waiter_on_duty(%L, false) $f$, :'suresh'), 'off duty');
select lives_ok(format($f$ select public.admin_set_waiter_on_duty(%L, false) $f$, :'suresh'), 'off duty again is a no-op');
select is(
  (select count(*) from public.audit_logs where action = 'waiter.on_duty_changed' and entity_id = :'suresh'),
  1::bigint,
  'on-duty changes are logged once'
);
select throws_ok(
  format($f$ select public.admin_set_waiter_on_duty(%L, false) $f$, :'b_profile'),
  'P0001', 'NOT_FOUND',
  'another restaurant''s waiter cannot be switched'
);

-- ─── Overview ───────────────────────────────────────────────────────────────
select tests.clear_auth();
insert into public.table_sessions (restaurant_id, dining_table_id, table_label_snapshot, assigned_waiter_id)
  values (:'rest_a', :'table3', '3', :'anita')
  returning id as session3 \gset
insert into public.session_waiter_assignments (restaurant_id, session_id, waiter_id)
  values (:'rest_a', :'session3', :'anita');
select tests.authenticate_as(:'a_manager');

select results_eq(
  $$ select full_name, on_duty, member_username, open_tables, tables_today
     from public.admin_waiters_overview() order by full_name $$,
  $$ values
       ('Anita', true, null::text, array['3'], 1),
       ('Ravi Kumar', true, 'a_waiter1', '{}'::text[], 0),
       ('Suresh Patel', false, null::text, '{}'::text[], 0) $$,
  'the overview shows status, linked login, open tables and tables attended today'
);

-- ─── Deleting ───────────────────────────────────────────────────────────────
select throws_ok(
  format($f$ select public.admin_delete_waiter(%L) $f$, :'anita'),
  'P0001', 'WAITER_HAS_OPEN_TABLES',
  'a waiter with open tables cannot be deleted (reassign first)'
);

select lives_ok(format($f$ select public.admin_delete_waiter(%L) $f$, :'ravi'), 'a waiter is deleted');
select results_eq(
  format(
    $f$ select is_active, on_duty, member_id, deleted_by from public.waiters where id = %L $f$,
    :'ravi'
  ),
  format($f$ values (false, false, null::uuid, %L::uuid) $f$, :'a_manager'),
  'deletion is soft, unlinks the login and records who did it'
);
select is(
  (select count(*) from public.audit_logs where action = 'waiter.deleted' and entity_id = :'ravi'),
  1::bigint,
  'deletion is audit logged'
);
select lives_ok(
  format(
    $f$ select public.admin_upsert_waiter(%L::jsonb) $f$,
    jsonb_build_object('full_name', 'Ravi Again', 'employee_code', 'E1', 'member_id', :'m_waiter1')
  ),
  'a deleted waiter''s code and login can be reused'
);
select throws_ok(
  format($f$ select public.admin_set_waiter_on_duty(%L, true) $f$, :'ravi'),
  'P0001', 'NOT_FOUND',
  'deleted waiters are gone from the section'
);

select tests.authenticate_as(:'a_waiter1');
select throws_ok(
  $$ select public.admin_upsert_waiter('{"full_name": "Self-made"}') $$,
  'P0001', 'FORBIDDEN',
  'waiters cannot manage waiter profiles'
);

-- ─── Read-only ──────────────────────────────────────────────────────────────
select tests.clear_auth();
select tests.suspend(:'rest_a');
select tests.authenticate_as(:'a_manager');
select throws_ok(
  $$ select public.admin_upsert_waiter('{"full_name": "Late hire"}') $$,
  'P0001', 'RESTAURANT_READ_ONLY',
  'read-only restaurants cannot add waiters'
);
select lives_ok(
  format($f$ select public.admin_set_waiter_on_duty(%L, true) $f$, :'suresh'),
  'on-duty switches still work while read-only'
);

select * from finish();

rollback;
