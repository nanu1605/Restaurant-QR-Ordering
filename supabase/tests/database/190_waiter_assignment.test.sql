-- Waiter assignment (spec §9.3 admin_assign_waiter, admin_unassign_waiter,
-- admin_delete_waiter, admin_waiters_overview; §8.5 waiter availability;
-- §10.2 and §10.7 assigning approves waiting orders; §10.6 read-only keeps
-- service going; §8.8 audit; docs/DECISIONS.md P4-11, P4-12).
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ─── Fixtures ───────────────────────────────────────────────────────────────
-- Restaurant A: one login per role, seven waiter profiles (Mohan off duty)
-- and tables 3–12, one story per table. Restaurant B: a waiter and an open
-- session that must stay out of A's reach.
select tests.create_restaurant('p4-190-a') as rest_a \gset
select tests.create_restaurant('p4-190-b') as rest_b \gset
select tests.add_member(:'rest_a', 'owner', 'a_owner') as a_owner \gset
select tests.add_member(:'rest_a', 'manager', 'a_manager') as a_manager \gset
select tests.add_member(:'rest_a', 'waiter', 'a_waiter') as a_waiter \gset
select tests.add_member(:'rest_a', 'kitchen', 'a_kitchen') as a_kitchen \gset
select tests.create_user('outsider@p4-190-a.test') as outsider \gset

select tests.add_waiter(:'rest_a', 'Ravi') as w_ravi \gset
select tests.add_waiter(:'rest_a', 'Suresh') as w_suresh \gset
select tests.add_waiter(:'rest_a', 'Anita') as w_anita \gset
select tests.add_waiter(:'rest_a', 'Priya') as w_priya \gset
select tests.add_waiter(:'rest_a', 'Kiran') as w_kiran \gset
select tests.add_waiter(:'rest_a', 'Deepa') as w_deepa \gset
select tests.add_waiter(:'rest_a', 'Mohan', null, false) as w_mohan \gset
select tests.add_waiter(:'rest_b', 'Bravo Waiter') as w_bravo \gset

-- Table 5 (sort order 1) and the menu come from the ordering fixture.
select tests.create_ordering_fixture(:'rest_a', 'P4190A0000TABLE5') as fx \gset
select :'fx'::jsonb ->> 'simple' as simple \gset

insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
  values (:'rest_a', '3', 'P4190A0000TABLE3', 3) returning id as table3 \gset
insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
  values (:'rest_a', '4', 'P4190A0000TABLE4', 4) returning id as table4 \gset
insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
  values (:'rest_a', '6', 'P4190A0000TABLE6', 6) returning id as table6 \gset
insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
  values (:'rest_a', '7', 'P4190A0000TABLE7', 7) returning id as table7 \gset
insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
  values (:'rest_a', '8', 'P4190A0000TABLE8', 8) returning id as table8 \gset
insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
  values (:'rest_a', '9', 'P4190A0000TABLE9', 9) returning id as table9 \gset
insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
  values (:'rest_a', '10', 'P4190A000TABLE10', 10) returning id as table10 \gset
insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
  values (:'rest_a', '11', 'P4190A000TABLE11', 11) returning id as table11 \gset
insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
  values (:'rest_a', '12', 'P4190A000TABLE12', 12) returning id as table12 \gset
insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
  values (:'rest_b', '3', 'P4190B0000TABLE3', 3) returning id as b_table3 \gset

-- An open session at a table, approved an hour ago. Returns its id.
create function pg_temp.open_session(p_table uuid)
returns uuid
language sql
as $$
  insert into public.table_sessions (
    restaurant_id, dining_table_id, table_label_snapshot, is_approved, approved_at
  )
  select t.restaurant_id, t.id, t.label, true, now() - interval '1 hour'
  from public.dining_tables t
  where t.id = p_table
  returning id;
$$;

-- A customer order placed as the server, from a new phone each time so no
-- rate limit trips. Returns the order id.
create function pg_temp.customer_order(p_token text, p_key text, variadic p_lines jsonb[])
returns uuid
language sql
as $$
  select (
    public.customer_place_order(p_token, gen_random_uuid()::text, p_key, to_jsonb(p_lines))
      ->> 'order_id'
  )::uuid;
$$;

-- The error code plus DETAIL a statement raises, or 'no error'.
create function pg_temp.error_of(p_sql text)
returns text
language plpgsql
as $$
declare
  v_detail text;
begin
  execute p_sql;
  return 'no error';
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  return sqlerrm || coalesce(' ' || nullif(v_detail, ''), '');
end;
$$;

-- Audit rows for one action on one entity.
create function pg_temp.audits(p_action text, p_entity uuid)
returns bigint
language sql
as $$
  select count(*) from public.audit_logs where action = p_action and entity_id = p_entity;
$$;

-- Tables 3, 4, 6, 9, 10 and 11: open, approved, nobody assigned yet.
select pg_temp.open_session(:'table3') as s3 \gset
select pg_temp.open_session(:'table4') as s4 \gset
select pg_temp.open_session(:'table6') as s6 \gset
select pg_temp.open_session(:'table9') as s9 \gset
select pg_temp.open_session(:'table10') as s10 \gset
select pg_temp.open_session(:'table11') as s11 \gset

-- Table 5: rounds 1 and 3 wait for approval; round 2 was already rejected.
select pg_temp.customer_order('P4190A0000TABLE5', 'p4190-t5-round-1', tests.line(:'simple')) as t5_r1 \gset
select pg_temp.customer_order('P4190A0000TABLE5', 'p4190-t5-round-2', tests.line(:'simple')) as t5_r2 \gset
select pg_temp.customer_order('P4190A0000TABLE5', 'p4190-t5-round-3', tests.line(:'simple', 2)) as t5_r3 \gset
select session_id as s5 from public.orders where id = :'t5_r1' \gset
update public.orders
  set status = 'rejected', reject_reason = 'Wrong table', decided_by = :'a_waiter',
      decided_at = now() - interval '5 minutes'
  where id = :'t5_r2';
update public.order_items set status = 'cancelled', cancelled_at = now() - interval '5 minutes'
  where order_id = :'t5_r2';

-- Table 12: two rounds waiting; a waiter approves round 1 later on.
select pg_temp.customer_order('P4190A000TABLE12', 'p4190-t12-round-1', tests.line(:'simple')) as t12_r1 \gset
select pg_temp.customer_order('P4190A000TABLE12', 'p4190-t12-round-2', tests.line(:'simple')) as t12_r2 \gset
select session_id as s12 from public.orders where id = :'t12_r1' \gset

-- Table 7: billed an hour ago; Anita served it and her assignment ended then.
insert into public.table_sessions (
  restaurant_id, dining_table_id, table_label_snapshot, status, billed_at,
  is_approved, approved_at, assigned_waiter_id, assigned_at
)
values (
  :'rest_a', :'table7', '7', 'billed', now() - interval '1 hour',
  true, now() - interval '3 hours', :'w_anita', now() - interval '3 hours'
)
returning id as s7 \gset
insert into public.session_waiter_assignments (
  restaurant_id, session_id, waiter_id, assigned_at, unassigned_at, unassign_reason
)
values (:'rest_a', :'s7', :'w_anita', now() - interval '3 hours', now() - interval '1 hour', 'billed');

-- Table 8: closed without a bill.
insert into public.table_sessions (
  restaurant_id, dining_table_id, table_label_snapshot, status, closed_at, close_reason
)
values (:'rest_a', :'table8', '8', 'closed_unbilled', now() - interval '1 hour', 'Guests left')
returning id as s8 \gset

-- Restaurant B: an open session with nobody assigned.
select pg_temp.open_session(:'b_table3') as sb \gset

select is(
  (select max_tables_per_waiter from public.restaurants where id = :'rest_a'), 1,
  'a restaurant starts with a limit of one table per waiter'
);

-- ─── Who may call them ──────────────────────────────────────────────────────
select ok(
  (
    select bool_and(
      has_function_privilege('authenticated', f, 'execute')
      and not has_function_privilege('anon', f, 'execute')
    )
    from unnest(array[
      'public.admin_assign_waiter(uuid, uuid, boolean)',
      'public.admin_unassign_waiter(uuid)'
    ]) as f
  ),
  'signed-in staff can call the assignment functions, anonymous visitors cannot'
);

select tests.authenticate_as(:'a_waiter');
select throws_ok(
  format($f$ select public.admin_assign_waiter(%L, %L) $f$, :'s3', :'w_ravi'),
  'P0001', 'FORBIDDEN', 'a waiter cannot assign waiters'
);
select throws_ok(
  format($f$ select public.admin_unassign_waiter(%L) $f$, :'s3'),
  'P0001', 'FORBIDDEN', 'a waiter cannot unassign waiters'
);

select tests.authenticate_as(:'a_kitchen');
select throws_ok(
  format($f$ select public.admin_assign_waiter(%L, %L) $f$, :'s3', :'w_ravi'),
  'P0001', 'FORBIDDEN', 'the kitchen cannot assign waiters'
);
select throws_ok(
  format($f$ select public.admin_unassign_waiter(%L) $f$, :'s3'),
  'P0001', 'FORBIDDEN', 'the kitchen cannot unassign waiters'
);

select tests.authenticate_as(:'outsider');
select throws_ok(
  format($f$ select public.admin_assign_waiter(%L, %L) $f$, :'s3', :'w_ravi'),
  'P0001', 'FORBIDDEN', 'a login without a membership cannot assign waiters'
);

select tests.clear_auth();
select is(
  (select count(*) from public.session_waiter_assignments where restaurant_id = :'rest_a' and session_id <> :'s7'),
  0::bigint,
  'the refused calls assigned nobody'
);

-- ─── Assign (table 3, Ravi) ─────────────────────────────────────────────────
select tests.authenticate_as(:'a_manager');
select is(
  public.admin_assign_waiter(:'s3', :'w_ravi'),
  jsonb_build_object('session_id', :'s3', 'waiter_id', :'w_ravi', 'changed', true, 'approved_orders', 0),
  'a manager assigns Ravi to table 3'
);

select tests.clear_auth();
select results_eq(
  format(
    $f$ select assigned_waiter_id, assigned_by, assigned_at = now() from public.table_sessions where id = %L $f$,
    :'s3'
  ),
  format($f$ values (%L::uuid, %L::uuid, true) $f$, :'w_ravi', :'a_manager'),
  'the session records its waiter, who assigned them and when'
);
select results_eq(
  format(
    $f$ select restaurant_id, waiter_id, assigned_by, assigned_at = now(), unassigned_at, unassign_reason::text
        from public.session_waiter_assignments where session_id = %L $f$,
    :'s3'
  ),
  format(
    $f$ values (%L::uuid, %L::uuid, %L::uuid, true, null::timestamptz, null::text) $f$,
    :'rest_a', :'w_ravi', :'a_manager'
  ),
  'and one open history row says the same'
);
select results_eq(
  format(
    $f$ select actor_user_id, actor_role::text, entity_type, before, after
        from public.audit_logs where action = 'waiter.assigned' and entity_id = %L $f$,
    :'s3'
  ),
  format(
    $f$ values (%L::uuid, 'manager', 'table_session', null::jsonb, %L::jsonb) $f$,
    :'a_manager',
    jsonb_build_object('waiter_id', :'w_ravi', 'waiter_name', 'Ravi', 'table', '3', 'forced', false)
  ),
  'the assignment is audit logged with the waiter and the table'
);
select results_eq(
  format($f$ select is_approved, approved_by, approved_at from public.table_sessions where id = %L $f$, :'s3'),
  $$ values (true, null::uuid, now() - interval '1 hour') $$,
  'with nothing waiting, the session''s approval is left alone'
);

-- Owners can assign too; the same waiter again is a no-op.
select tests.authenticate_as(:'a_owner');
select is(
  public.admin_assign_waiter(:'s3', :'w_ravi'),
  jsonb_build_object('session_id', :'s3', 'waiter_id', :'w_ravi', 'changed', false, 'approved_orders', 0),
  'assigning the same waiter again changes nothing'
);

select tests.clear_auth();
select results_eq(
  format(
    $f$ select (select count(*) from public.session_waiter_assignments where session_id = %1$L),
               (select count(*) from public.audit_logs where entity_id = %1$L),
               (select assigned_by from public.table_sessions where id = %1$L) $f$,
    :'s3'
  ),
  format($f$ values (1::bigint, 1::bigint, %L::uuid) $f$, :'a_manager'),
  'no new history row, no new audit entry, and the first assigner is kept'
);

-- ─── The table limit (1 by default) ─────────────────────────────────────────
select tests.authenticate_as(:'a_manager');
select is(
  pg_temp.error_of(format($f$ select public.admin_assign_waiter(%L, %L) $f$, :'s4', :'w_ravi')),
  'WAITER_BUSY 3',
  'a waiter at the limit is busy; the detail names the table they handle'
);

select tests.clear_auth();
select results_eq(
  format(
    $f$ select (select assigned_waiter_id from public.table_sessions where id = %1$L),
               (select count(*) from public.session_waiter_assignments where session_id = %1$L),
               (select count(*) from public.audit_logs where entity_id = %1$L) $f$,
    :'s4'
  ),
  $$ values (null::uuid, 0::bigint, 0::bigint) $$,
  'and table 4 stays unassigned, with nothing logged'
);

select tests.authenticate_as(:'a_manager');
select is(
  public.admin_assign_waiter(:'s10', :'w_ravi', true),
  jsonb_build_object('session_id', :'s10', 'waiter_id', :'w_ravi', 'changed', true, 'approved_orders', 0),
  'after confirming, a manager can assign a busy waiter anyway'
);

select tests.clear_auth();
select results_eq(
  format(
    $f$ select after ->> 'table', (after -> 'forced')::boolean
        from public.audit_logs where action = 'waiter.assigned' and entity_id = %L $f$,
    :'s10'
  ),
  $$ values ('10', true) $$,
  'the audit entry records that the limit was overridden'
);
select results_eq(
  format(
    $f$ select waiter_id, assigned_by, unassigned_at from public.session_waiter_assignments where session_id = %L $f$,
    :'s10'
  ),
  format($f$ values (%L::uuid, %L::uuid, null::timestamptz) $f$, :'w_ravi', :'a_manager'),
  'Ravi now also handles table 10'
);

select tests.authenticate_as(:'a_manager');
select is(
  pg_temp.error_of(format($f$ select public.admin_assign_waiter(%L, %L) $f$, :'s4', :'w_ravi')),
  'WAITER_BUSY 3, 10',
  'the detail lists every table they handle, in table order'
);
select is(
  pg_temp.error_of(format($f$ select public.admin_assign_waiter(%L, %L, null) $f$, :'s4', :'w_ravi')),
  'WAITER_BUSY 3, 10',
  'a missing confirmation counts as not confirmed'
);

-- Only open tables count: Anita's table 7 was billed.
select is(
  public.admin_assign_waiter(:'s4', :'w_anita'),
  jsonb_build_object('session_id', :'s4', 'waiter_id', :'w_anita', 'changed', true, 'approved_orders', 0),
  'a waiter whose last table was billed is free again'
);

-- ─── A limit of 2 ───────────────────────────────────────────────────────────
select tests.clear_auth();
update public.restaurants set max_tables_per_waiter = 2 where id = :'rest_a';

select tests.authenticate_as(:'a_manager');
select is(public.admin_assign_waiter(:'s6', :'w_suresh') ->> 'changed', 'true', 'Suresh takes table 6');
select is(
  public.admin_assign_waiter(:'s9', :'w_suresh') ->> 'changed', 'true',
  'with a limit of 2, a second table needs no confirmation'
);
select is(
  pg_temp.error_of(format($f$ select public.admin_assign_waiter(%L, %L) $f$, :'s4', :'w_suresh')),
  'WAITER_BUSY 6, 9',
  'a third table makes him busy, even as a reassignment'
);

select tests.clear_auth();
select is(
  (select (after -> 'forced')::boolean from public.audit_logs where action = 'waiter.assigned' and entity_id = :'s9'),
  false,
  'the second table was not forced'
);
select results_eq(
  format(
    $f$ select (select assigned_waiter_id from public.table_sessions where id = %1$L),
               (select count(*) from public.session_waiter_assignments where session_id = %1$L and unassigned_at is null),
               (select count(*) from public.session_waiter_assignments where session_id = %1$L and unassigned_at is not null),
               (select count(*) from public.audit_logs where action = 'waiter.reassigned' and entity_id = %1$L) $f$,
    :'s4'
  ),
  format($f$ values (%L::uuid, 1::bigint, 0::bigint, 0::bigint) $f$, :'w_anita'),
  'the refused reassignment leaves table 4 with Anita'
);
update public.restaurants set max_tables_per_waiter = 1 where id = :'rest_a';

-- ─── Reassign (table 10, Ravi → Priya) ──────────────────────────────────────
select tests.authenticate_as(:'a_owner');
select is(
  public.admin_assign_waiter(:'s10', :'w_priya'),
  jsonb_build_object('session_id', :'s10', 'waiter_id', :'w_priya', 'changed', true, 'approved_orders', 0),
  'an owner reassigns table 10 from Ravi to Priya'
);

select tests.clear_auth();
select results_eq(
  format(
    $f$ select waiter_id, assigned_by, unassigned_at = now(), unassign_reason::text
        from public.session_waiter_assignments where session_id = %L
        order by unassigned_at nulls last $f$,
    :'s10'
  ),
  format(
    $f$ values (%L::uuid, %L::uuid, true, 'reassigned'), (%L::uuid, %L::uuid, null::boolean, null::text) $f$,
    :'w_ravi', :'a_manager', :'w_priya', :'a_owner'
  ),
  'Ravi''s history row ends as reassigned and Priya''s row opens'
);
select results_eq(
  format(
    $f$ select assigned_waiter_id, assigned_by, assigned_at = now() from public.table_sessions where id = %L $f$,
    :'s10'
  ),
  format($f$ values (%L::uuid, %L::uuid, true) $f$, :'w_priya', :'a_owner'),
  'the session now names Priya and who moved the table'
);
select results_eq(
  format(
    $f$ select actor_user_id, actor_role::text, entity_type, before, after
        from public.audit_logs where action = 'waiter.reassigned' and entity_id = %L $f$,
    :'s10'
  ),
  format(
    $f$ values (%L::uuid, 'owner', 'table_session', %L::jsonb, %L::jsonb) $f$,
    :'a_owner',
    jsonb_build_object('waiter_id', :'w_ravi', 'waiter_name', 'Ravi'),
    jsonb_build_object('waiter_id', :'w_priya', 'waiter_name', 'Priya', 'table', '10', 'forced', false)
  ),
  'the reassignment is audit logged with the previous waiter'
);
select is(pg_temp.audits('waiter.assigned', :'s10'), 1::bigint, 'and is not logged as a new assignment');

-- ─── Waiters page while Ravi holds table 3 ─────────────────────────────────
select tests.authenticate_as(:'a_manager');
select is(
  pg_temp.error_of(format($f$ select public.admin_delete_waiter(%L) $f$, :'w_ravi')),
  'WAITER_HAS_OPEN_TABLES 3',
  'a waiter holding a table cannot be deleted'
);
select results_eq(
  $$ select full_name, open_tables, tables_today from public.admin_waiters_overview()
     where full_name in ('Priya', 'Ravi') order by full_name $$,
  $$ values ('Priya', array['10'], 1), ('Ravi', array['3'], 2) $$,
  'the overview shows open tables, and Ravi''s day still counts the table he was moved off'
);

-- ─── Unassign (table 3) ─────────────────────────────────────────────────────
select is(
  public.admin_unassign_waiter(:'s3'),
  jsonb_build_object('session_id', :'s3', 'changed', true),
  'a manager takes Ravi off table 3'
);

select tests.clear_auth();
select results_eq(
  format(
    $f$ select waiter_id, unassigned_at = now(), unassign_reason::text
        from public.session_waiter_assignments where session_id = %L $f$,
    :'s3'
  ),
  format($f$ values (%L::uuid, true, 'manual') $f$, :'w_ravi'),
  'his history row ends with the reason manual'
);
select results_eq(
  format(
    $f$ select assigned_waiter_id, assigned_at, assigned_by from public.table_sessions where id = %L $f$,
    :'s3'
  ),
  $$ values (null::uuid, null::timestamptz, null::uuid) $$,
  'the table is back to Unassigned'
);
select results_eq(
  format(
    $f$ select actor_user_id, actor_role::text, entity_type, before, after
        from public.audit_logs where action = 'waiter.unassigned' and entity_id = %L $f$,
    :'s3'
  ),
  format(
    $f$ values (%L::uuid, 'manager', 'table_session', %L::jsonb, '{"waiter_id": null, "table": "3"}'::jsonb) $f$,
    :'a_manager',
    jsonb_build_object('waiter_id', :'w_ravi', 'waiter_name', 'Ravi')
  ),
  'the unassignment is audit logged'
);

select tests.authenticate_as(:'a_manager');
select is(
  public.admin_unassign_waiter(:'s3'),
  jsonb_build_object('session_id', :'s3', 'changed', false),
  'unassigning an unassigned table changes nothing'
);
select is(
  public.admin_unassign_waiter(:'s11'),
  jsonb_build_object('session_id', :'s11', 'changed', false),
  'nor does unassigning a table that never had a waiter'
);
select results_eq(
  $$ select open_tables, tables_today from public.admin_waiters_overview() where full_name = 'Ravi' $$,
  $$ values ('{}'::text[], 2) $$,
  'Ravi has no open tables left; today''s count keeps both tables'
);
select lives_ok(
  format($f$ select public.admin_delete_waiter(%L) $f$, :'w_ravi'),
  'with his tables handed on, Ravi can be deleted'
);

select tests.clear_auth();
select is(pg_temp.audits('waiter.unassigned', :'s3'), 1::bigint, 'the repeat is not logged again');
select is(
  (select count(*) from public.session_waiter_assignments where session_id = :'s3'), 1::bigint,
  'and adds no history row'
);

-- ─── Who and what can't be assigned ─────────────────────────────────────────
select tests.authenticate_as(:'a_manager');
select is(
  pg_temp.error_of(format($f$ select public.admin_assign_waiter(%L, %L) $f$, :'s11', :'w_mohan')),
  'WAITER_NOT_AVAILABLE Mohan',
  'an off-duty waiter is not available (the detail is their name)'
);
select is(
  pg_temp.error_of(format($f$ select public.admin_assign_waiter(%L, %L, true) $f$, :'s11', :'w_mohan')),
  'WAITER_NOT_AVAILABLE Mohan',
  'confirming does not override that'
);
select is(
  pg_temp.error_of(format($f$ select public.admin_assign_waiter(%L, %L) $f$, :'s11', :'w_ravi')),
  'WAITER_NOT_AVAILABLE Ravi',
  'a deleted waiter is not available'
);
select throws_ok(
  format($f$ select public.admin_assign_waiter(%L, %L) $f$, :'s11', :'w_bravo'),
  'P0001', 'NOT_FOUND', 'another restaurant''s waiter is not found'
);
select throws_ok(
  format($f$ select public.admin_assign_waiter(%L, %L) $f$, :'s11', gen_random_uuid()),
  'P0001', 'NOT_FOUND', 'an unknown waiter is not found'
);
select throws_ok(
  format($f$ select public.admin_assign_waiter(%L, %L) $f$, :'sb', :'w_kiran'),
  'P0001', 'NOT_FOUND', 'another restaurant''s table cannot get our waiter'
);
select throws_ok(
  format($f$ select public.admin_assign_waiter(%L, %L) $f$, :'sb', :'w_bravo'),
  'P0001', 'NOT_FOUND', 'nor its own waiter'
);
select throws_ok(
  format($f$ select public.admin_unassign_waiter(%L) $f$, :'sb'),
  'P0001', 'NOT_FOUND', 'another restaurant''s table cannot be unassigned'
);
select throws_ok(
  format($f$ select public.admin_assign_waiter(%L, %L) $f$, gen_random_uuid(), :'w_kiran'),
  'P0001', 'NOT_FOUND', 'an unknown session is not found'
);
select throws_ok(
  format($f$ select public.admin_assign_waiter(%L, %L) $f$, :'s7', :'w_kiran'),
  'P0001', 'SESSION_NOT_OPEN', 'a billed table cannot get a waiter'
);
select throws_ok(
  format($f$ select public.admin_assign_waiter(%L, %L) $f$, :'s8', :'w_kiran'),
  'P0001', 'SESSION_NOT_OPEN', 'nor a table closed without a bill'
);
select throws_ok(
  format($f$ select public.admin_unassign_waiter(%L) $f$, :'s7'),
  'P0001', 'SESSION_NOT_OPEN', 'a billed table cannot be unassigned'
);
select throws_ok(
  format($f$ select public.admin_unassign_waiter(%L) $f$, :'s8'),
  'P0001', 'SESSION_NOT_OPEN', 'nor a table closed without a bill'
);

select tests.clear_auth();
select results_eq(
  format(
    $f$ select (select assigned_waiter_id from public.table_sessions where id = %1$L),
               (select count(*) from public.session_waiter_assignments where session_id = %1$L),
               (select count(*) from public.audit_logs where entity_id = %1$L) $f$,
    :'s11'
  ),
  $$ values (null::uuid, 0::bigint, 0::bigint) $$,
  'the refused calls leave table 11 unassigned, with nothing logged'
);
select results_eq(
  format(
    $f$ select s.assigned_waiter_id, a.unassign_reason::text
        from public.table_sessions s
        join public.session_waiter_assignments a on a.session_id = s.id
        where s.id = %L $f$,
    :'s7'
  ),
  format($f$ values (%L::uuid, 'billed') $f$, :'w_anita'),
  'the billed table keeps Anita as its last waiter'
);
select results_eq(
  format(
    $f$ select (select assigned_waiter_id from public.table_sessions where id = %1$L),
               (select count(*) from public.session_waiter_assignments where session_id = %1$L) $f$,
    :'sb'
  ),
  $$ values (null::uuid, 0::bigint) $$,
  'and restaurant B''s table is untouched'
);

-- ─── Assigning approves waiting orders (table 5) ────────────────────────────
select is(
  (select is_approved from public.table_sessions where id = :'s5'), false,
  'table 5''s session is waiting for approval'
);

select tests.authenticate_as(:'a_manager');
select is(
  public.admin_assign_waiter(:'s5', :'w_kiran'),
  jsonb_build_object('session_id', :'s5', 'waiter_id', :'w_kiran', 'changed', true, 'approved_orders', 2),
  'assigning Kiran approves both waiting rounds in the same tap'
);

select tests.clear_auth();
select results_eq(
  format(
    $f$ select round_number, status::text, decided_by, decided_at = now()
        from public.orders where session_id = %L order by round_number $f$,
    :'s5'
  ),
  format(
    $f$ values (1, 'accepted', %1$L::uuid, true),
               (2, 'rejected', %2$L::uuid, false),
               (3, 'accepted', %1$L::uuid, true) $f$,
    :'a_manager', :'a_waiter'
  ),
  'the waiting rounds are accepted by the manager; the rejected round stays rejected'
);
select results_eq(
  format(
    $f$ select is_approved, approved_by, approved_at = now() from public.table_sessions where id = %L $f$,
    :'s5'
  ),
  format($f$ values (true, %L::uuid, true) $f$, :'a_manager'),
  'and the session is approved by the manager'
);
select set_eq(
  format(
    $f$ select entity_id, actor_user_id, actor_role::text, before, after
        from public.audit_logs
        where action = 'order.approved'
          and entity_id in (select id from public.orders where session_id = %L) $f$,
    :'s5'
  ),
  format(
    $f$ values
      (%1$L::uuid, %3$L::uuid, 'manager', '{"status": "pending_approval"}'::jsonb,
       '{"status": "accepted", "round_number": 1, "via": "assignment"}'::jsonb),
      (%2$L::uuid, %3$L::uuid, 'manager', '{"status": "pending_approval"}'::jsonb,
       '{"status": "accepted", "round_number": 3, "via": "assignment"}'::jsonb) $f$,
    :'t5_r1', :'t5_r3', :'a_manager'
  ),
  'each approval is audit logged as coming from the assignment'
);
select is(pg_temp.audits('waiter.assigned', :'s5'), 1::bigint, 'the assignment itself is logged too');
select results_eq(
  format(
    $f$ select waiter_id, assigned_by, unassigned_at from public.session_waiter_assignments where session_id = %L $f$,
    :'s5'
  ),
  format($f$ values (%L::uuid, %L::uuid, null::timestamptz) $f$, :'w_kiran', :'a_manager'),
  'Kiran''s history row is open'
);
select is(
  (select count(*) from public.order_items where order_id in (:'t5_r1', :'t5_r3') and status = 'placed'),
  2::bigint,
  'the approved dishes now wait for the kitchen'
);

select pg_temp.customer_order('P4190A0000TABLE5', 'p4190-t5-round-4', tests.line(:'simple')) as t5_r4 \gset
select results_eq(
  format($f$ select session_id, status::text from public.orders where id = %L $f$, :'t5_r4'),
  format($f$ values (%L::uuid, 'accepted') $f$, :'s5'),
  'the table''s next order joins the session and is accepted straight away'
);

-- ─── A session a waiter already approved (table 12) ─────────────────────────
-- Round 2 was placed before the waiter approved round 1, so it still waits.
select tests.authenticate_as(:'a_waiter');
select is(
  public.staff_approve_order(:'t12_r1') ->> 'changed', 'true',
  'a waiter approves table 12''s first round on their own'
);

select tests.authenticate_as(:'a_manager');
select is(
  public.admin_assign_waiter(:'s12', :'w_deepa'),
  jsonb_build_object('session_id', :'s12', 'waiter_id', :'w_deepa', 'changed', true, 'approved_orders', 1),
  'assigning Deepa approves the round still waiting'
);

select tests.clear_auth();
select results_eq(
  format(
    $f$ select round_number, status::text, decided_by from public.orders where session_id = %L order by round_number $f$,
    :'s12'
  ),
  format($f$ values (1, 'accepted', %L::uuid), (2, 'accepted', %L::uuid) $f$, :'a_waiter', :'a_manager'),
  'each round keeps who approved it'
);
select is(
  (select approved_by from public.table_sessions where id = :'s12'), :'a_waiter'::uuid,
  'and the session keeps its first approver'
);
select is(
  (select after ->> 'via' from public.audit_logs where action = 'order.approved' and entity_id = :'t12_r2'),
  'assignment',
  'the round approved by the assignment is logged as such'
);

-- ─── Read-only restaurants keep service going (spec §10.6) ──────────────────
select tests.suspend(:'rest_a');
select is(
  (select state from public.restaurant_access(:'rest_a')), 'read_only',
  'restaurant A is now read-only'
);

select tests.authenticate_as(:'a_manager');
select is(
  public.admin_unassign_waiter(:'s4') ->> 'changed', 'true',
  'a manager can still unassign while read-only'
);
select is(
  public.admin_assign_waiter(:'s11', :'w_anita') ->> 'changed', 'true',
  'and assign'
);

select tests.clear_auth();
select results_eq(
  format(
    $f$ select id, assigned_waiter_id from public.table_sessions
        where id in (%L, %L) order by table_label_snapshot::int $f$,
    :'s4', :'s11'
  ),
  format($f$ values (%L::uuid, null::uuid), (%L::uuid, %L::uuid) $f$, :'s4', :'s11', :'w_anita'),
  'the changes made while read-only are saved'
);
select is(
  pg_temp.audits('waiter.unassigned', :'s4') + pg_temp.audits('waiter.assigned', :'s11'),
  2::bigint,
  'and audit logged'
);

select * from finish();

rollback;
