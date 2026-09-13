-- Staff and customer orders racing for one table, and managers racing for one
-- waiter (spec §18 Concurrency, §8.5 one open session per table, §10.1,
-- §10.2, §10.7; docs/DECISIONS.md P4-10 lock order, P4-13 auto-assign).
--
-- pgTAP runs inside a single transaction, so each race runs on two dblink
-- connections against a committed fixture: A does its part and keeps its
-- transaction open, B is sent meanwhile and must wait for A's lock, then A
-- commits and B finishes. Staff connections sign in with
-- tests.authenticate_as inside their own transaction. The fixture restaurant
-- has a random code and is deleted again at the end (a failed run can leave
-- it behind until the next `pnpm db:reset`).
begin;

create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;

select no_plan();

-- dblink only lets a non-superuser connect with a password. 127.0.0.1 is
-- trusted by the local stack, so connect through the server's own network
-- address, which asks for one (local and CI stacks only).
select format(
  'host=%s port=5432 dbname=postgres user=postgres password=postgres',
  host(inet_server_addr())
) as conn \gset

-- Random code, QR tokens and idempotency keys, so parallel runs and leftovers
-- from a failed run never collide. Each raced call's key (or an id only it
-- carries) is how we spot it waiting in pg_stat_activity.
select substr(md5(random()::text), 1, 10) as tag \gset
select
  'p4-200-' || :'tag' as slug,
  'P4200' || upper(substr(:'tag', 1, 9)) as tok,
  :'tag' || '-staff-first' as key_staff_first,
  :'tag' || '-customer-second' as key_customer_second,
  :'tag' || '-customer-first' as key_customer_first,
  :'tag' || '-staff-second' as key_staff_second,
  :'tag' || '-suresh-order' as key_suresh
\gset

select extensions.dblink_connect('setup', :'conn');
select extensions.dblink_connect('race_a', :'conn');
select extensions.dblink_connect('race_b', :'conn');

-- ─── Helpers ────────────────────────────────────────────────────────────────
-- Runs p_sql on the setup connection (committed straight away) and returns
-- its single value.
create function pg_temp.setup(p_sql text)
returns text
language sql
as $$
  select value from extensions.dblink('setup', p_sql) as t(value text);
$$;

-- A customer's first order at the table with QR token p_token, committed. It
-- opens a session that waits for approval. Returns the order id.
create function pg_temp.first_order(p_token text, p_key text, p_items jsonb)
returns uuid
language sql
as $$
  select (pg_temp.setup(format(
    'select public.customer_place_order(%L, gen_random_uuid()::text, %L, %L::jsonb)',
    p_token, p_key, p_items
  ))::jsonb ->> 'order_id')::uuid;
$$;

-- Opens a transaction on p_conn, signed in as p_user until it ends.
create function pg_temp.begin_as(p_conn text, p_user uuid)
returns void
language plpgsql
as $$
begin
  perform extensions.dblink_exec(p_conn, 'begin');
  perform * from extensions.dblink(p_conn, format('select tests.authenticate_as(%L)', p_user))
    as t(done text);
end;
$$;

-- The error a remote call failed with, as {"error": "<SQLSTATE> <code>
-- <DETAIL>"}. dblink re-raises the remote error here with its SQLSTATE,
-- message and DETAIL.
create function pg_temp.error_json(p_state text, p_message text, p_detail text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'error', p_state || ' ' || p_message || coalesce(' ' || nullif(p_detail, ''), '')
  );
$$;

-- Runs p_sql on p_conn (inside its open transaction, if any) and returns the
-- jsonb it produced, or the error it failed with.
create function pg_temp.run_on(p_conn text, p_sql text)
returns jsonb
language plpgsql
as $$
declare
  v_result jsonb;
  v_detail text;
begin
  select result into v_result from extensions.dblink(p_conn, p_sql) as t(result jsonb);
  return v_result;
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  return pg_temp.error_json(sqlstate, sqlerrm, v_detail);
end;
$$;

-- What the query sent on p_conn with dblink_send_query returned once it
-- finished (this waits for it), or the error it failed with.
create function pg_temp.result_of(p_conn text)
returns jsonb
language plpgsql
as $$
declare
  v_result jsonb;
  v_detail text;
begin
  select result into v_result from extensions.dblink_get_result(p_conn) as t(result jsonb);
  -- An empty read marks the end of the query's results.
  perform * from extensions.dblink_get_result(p_conn) as t(result jsonb);
  return v_result;
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  perform * from extensions.dblink_get_result(p_conn) as t(result jsonb);
  return pg_temp.error_json(sqlstate, sqlerrm, v_detail);
end;
$$;

-- Wait (up to 5 s) until the query containing p_marker on another connection
-- is blocked on a lock.
create function pg_temp.wait_for_lock_wait(p_marker text)
returns boolean
language plpgsql
as $$
begin
  for i in 1..50 loop
    -- pg_stat_activity is captured once per transaction; take a fresh look.
    perform pg_stat_clear_snapshot();
    if exists (
      select 1 from pg_stat_activity
      where wait_event_type = 'Lock' and query like '%' || p_marker || '%'
        and pid <> pg_backend_pid()
    ) then
      return true;
    end if;
    perform pg_sleep(0.1);
  end loop;
  return false;
end;
$$;

-- ─── Committed fixture ──────────────────────────────────────────────────────
-- Approval on and one table per waiter (the defaults, spelt out here). Table 5
-- comes with the ordering fixture; 6 and 9 stay free for the order races; 3,
-- 4, 7 and 8 get a customer's first order, so their sessions wait for
-- approval. Ravi, Priya and Arjun are waiter profiles without a login; Suresh
-- is linked to the waiter login `suresh`.
select pg_temp.setup(format('select tests.create_restaurant(%L)', :'slug')) as rest \gset
select pg_temp.setup(format('select tests.create_ordering_fixture(%L, %L)', :'rest', :'tok' || 'T5'))
  as fx \gset
select jsonb_build_array(tests.line((:'fx'::jsonb ->> 'simple')::uuid)) as items \gset

select extensions.dblink_exec('setup', format(
  $f$
  update public.restaurants
    set require_first_order_approval = true, max_tables_per_waiter = 1
    where id = %1$L;
  insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
  values (%1$L, '3', %2$L, 3), (%1$L, '4', %3$L, 4), (%1$L, '6', %4$L, 6),
         (%1$L, '7', %5$L, 7), (%1$L, '8', %6$L, 8), (%1$L, '9', %7$L, 9);
  $f$,
  :'rest', :'tok' || 'T3', :'tok' || 'T4', :'tok' || 'T6', :'tok' || 'T7', :'tok' || 'T8',
  :'tok' || 'T9'
));

select
  pg_temp.setup(format('select tests.add_member(%L, %L, %L)', :'rest', 'manager', 'manager_one'))
    as manager_one,
  pg_temp.setup(format('select tests.add_member(%L, %L, %L)', :'rest', 'manager', 'manager_two'))
    as manager_two,
  pg_temp.setup(format('select tests.add_member(%L, %L, %L)', :'rest', 'waiter', 'suresh'))
    as suresh_login
\gset
select
  pg_temp.setup(format('select tests.add_waiter(%L, %L)', :'rest', 'Ravi')) as ravi,
  pg_temp.setup(format('select tests.add_waiter(%L, %L, %L)', :'rest', 'Suresh', :'suresh_login'))
    as suresh,
  pg_temp.setup(format('select tests.add_waiter(%L, %L)', :'rest', 'Priya')) as priya,
  pg_temp.setup(format('select tests.add_waiter(%L, %L)', :'rest', 'Arjun')) as arjun
\gset

select
  pg_temp.first_order(:'tok' || 'T3', :'tag' || '-open-3', :'items') as order3,
  pg_temp.first_order(:'tok' || 'T4', :'tag' || '-open-4', :'items') as order4,
  pg_temp.first_order(:'tok' || 'T7', :'tag' || '-open-7', :'items') as order7,
  pg_temp.first_order(:'tok' || 'T8', :'tag' || '-open-8', :'items') as order8
\gset

select
  :'fx'::jsonb ->> 'table' as t5,
  (select id from public.dining_tables where restaurant_id = :'rest' and label = '6') as t6,
  (select id from public.dining_tables where restaurant_id = :'rest' and label = '9') as t9,
  (select session_id from public.orders where id = :'order3') as s3,
  (select session_id from public.orders where id = :'order4') as s4,
  (select session_id from public.orders where id = :'order7') as s7,
  (select session_id from public.orders where id = :'order8') as s8
\gset

-- ─── Staff order first, customer first order waits (table 5) ────────────────
-- A: a manager places a staff order at free table 5 and keeps the transaction
-- open, holding the table lock.
select pg_temp.begin_as('race_a', :'manager_one');
select pg_temp.run_on('race_a', format(
  'select public.staff_place_order(%L, %L::jsonb, %L)', :'t5', :'items', :'key_staff_first'
)) as staff_first \gset

-- B: a customer at table 5 sends a first order meanwhile.
select extensions.dblink_send_query('race_b', format(
  'select public.customer_place_order(%L, gen_random_uuid()::text, %L, %L::jsonb)',
  :'tok' || 'T5', :'key_customer_second', :'items'
));

select ok(
  pg_temp.wait_for_lock_wait(:'key_customer_second'),
  'the customer order waits for the table lock the staff order holds'
);

select extensions.dblink_exec('race_a', 'commit');
select pg_temp.result_of('race_b') as customer_second \gset

select is(
  :'staff_first'::jsonb - 'order_id' - 'session_id',
  '{"round_number": 1, "status": "accepted", "replayed": false, "assigned_waiter_id": null}'::jsonb,
  'the staff order opens the session as round 1, accepted'
);
select is(
  :'customer_second'::jsonb - 'order_id',
  '{"round_number": 2, "status": "accepted", "replayed": false}'::jsonb,
  'the waiting customer order becomes round 2 and is accepted straight away'
);
select is(
  (select count(*) from public.table_sessions where dining_table_id = :'t5'),
  1::bigint,
  'table 5 has exactly one session'
);
select results_eq(
  format(
    $f$ select id, status::text, is_approved, approved_by
        from public.table_sessions where dining_table_id = %L $f$,
    :'t5'
  ),
  format(
    $f$ values (%L::uuid, 'open', true, %L::uuid) $f$,
    :'staff_first'::jsonb ->> 'session_id', :'manager_one'
  ),
  'it is the staff order''s session, open and approved by the manager'
);
select results_eq(
  format(
    $f$ select o.round_number, o.placed_via::text, o.status::text, o.placed_by_user_id
        from public.orders o
        join public.table_sessions s on s.restaurant_id = o.restaurant_id and s.id = o.session_id
        where s.dining_table_id = %L
        order by o.round_number $f$,
    :'t5'
  ),
  format(
    $f$ values (1, 'staff', 'accepted', %L::uuid), (2, 'customer', 'accepted', null) $f$,
    :'manager_one'
  ),
  'both rounds sit in that session: the manager''s staff order, then the customer''s'
);

-- ─── Customer first order first, staff order waits (table 6) ────────────────
-- A: a customer's first order at free table 6 (it will wait for approval),
-- in a transaction kept open, holding the table lock.
select extensions.dblink_exec('race_a', 'begin');
select pg_temp.run_on('race_a', format(
  'select public.customer_place_order(%L, gen_random_uuid()::text, %L, %L::jsonb)',
  :'tok' || 'T6', :'key_customer_first', :'items'
)) as customer_first \gset

-- B: a manager adds dishes at table 6 meanwhile.
select pg_temp.begin_as('race_b', :'manager_two');
select extensions.dblink_send_query('race_b', format(
  'select public.staff_place_order(%L, %L::jsonb, %L)', :'t6', :'items', :'key_staff_second'
));

select ok(
  pg_temp.wait_for_lock_wait(:'key_staff_second'),
  'the staff order waits for the table lock the customer order holds'
);

select extensions.dblink_exec('race_a', 'commit');
select pg_temp.result_of('race_b') as staff_second \gset
select extensions.dblink_exec('race_b', 'commit');

select is(
  :'customer_first'::jsonb - 'order_id',
  '{"round_number": 1, "status": "pending_approval", "replayed": false}'::jsonb,
  'the customer''s first order opens the session and waits for approval'
);
select is(
  :'staff_second'::jsonb - 'order_id' - 'session_id',
  '{"round_number": 2, "status": "accepted", "replayed": false, "assigned_waiter_id": null}'::jsonb,
  'the waiting staff order becomes round 2, accepted'
);
select results_eq(
  format(
    $f$ select id, status::text, is_approved, approved_by
        from public.table_sessions where dining_table_id = %L $f$,
    :'t6'
  ),
  format(
    $f$ values (%L::uuid, 'open', true, %L::uuid) $f$,
    :'staff_second'::jsonb ->> 'session_id', :'manager_two'
  ),
  'table 6 has one session, which the staff order joined and approved'
);
select results_eq(
  format(
    $f$ select o.round_number, o.placed_via::text, o.status::text
        from public.orders o
        join public.table_sessions s on s.restaurant_id = o.restaurant_id and s.id = o.session_id
        where s.dining_table_id = %L
        order by o.round_number $f$,
    :'t6'
  ),
  $$ values (1, 'customer', 'pending_approval'), (2, 'staff', 'accepted') $$,
  'the customer''s round stays waiting for staff to decide'
);

-- ─── Two managers give Ravi his only slot at once (tables 3 and 4) ──────────
-- A: manager one assigns Ravi to table 3 and keeps the transaction open,
-- holding Ravi's waiter row.
select pg_temp.begin_as('race_a', :'manager_one');
select pg_temp.run_on('race_a', format(
  'select public.admin_assign_waiter(%L, %L)', :'s3', :'ravi'
)) as assign_ravi_3 \gset

-- B: manager two assigns Ravi to table 4 meanwhile.
select pg_temp.begin_as('race_b', :'manager_two');
select extensions.dblink_send_query('race_b', format(
  'select public.admin_assign_waiter(%L, %L)', :'s4', :'ravi'
));

select ok(
  pg_temp.wait_for_lock_wait(:'s4'),
  'the second assignment waits for the waiter row lock'
);

select extensions.dblink_exec('race_a', 'commit');
select pg_temp.result_of('race_b') as assign_ravi_4 \gset
select extensions.dblink_exec('race_b', 'rollback');

select is(
  :'assign_ravi_3'::jsonb,
  jsonb_build_object(
    'session_id', :'s3', 'waiter_id', :'ravi', 'changed', true, 'approved_orders', 1
  ),
  'the first manager assigns Ravi to table 3, approving its waiting order'
);
select is(
  :'assign_ravi_4'::jsonb,
  '{"error": "P0001 WAITER_BUSY 3"}'::jsonb,
  'the second manager is told Ravi is already handling table 3'
);
select results_eq(
  format(
    $f$ select d.label
        from public.table_sessions s
        join public.dining_tables d on d.restaurant_id = s.restaurant_id and d.id = s.dining_table_id
        where s.assigned_waiter_id = %L and s.status = 'open' $f$,
    :'ravi'
  ),
  $$ values ('3') $$,
  'Ravi handles table 3 only'
);
select results_eq(
  format(
    $f$ select session_id, unassigned_at is null
        from public.session_waiter_assignments where waiter_id = %L $f$,
    :'ravi'
  ),
  format($f$ values (%L::uuid, true) $f$, :'s3'),
  'Ravi has a single assignment row, for table 3'
);
select results_eq(
  format(
    $f$ select s.assigned_waiter_id, s.is_approved, o.status::text
        from public.table_sessions s
        join public.orders o on o.restaurant_id = s.restaurant_id and o.session_id = s.id
        where s.id = %L $f$,
    :'s4'
  ),
  $$ values (null::uuid, false, 'pending_approval') $$,
  'table 4 stays unassigned, with its order still waiting for approval'
);
select is(
  (select count(*) from public.session_waiter_assignments where session_id = :'s4'),
  0::bigint,
  'the refused assignment leaves no history row'
);
select results_eq(
  format(
    $f$ select action, entity_id, count(*)
        from public.audit_logs
        where action in ('waiter.assigned', 'order.approved') and entity_id in (%L, %L, %L, %L)
        group by action, entity_id
        order by action desc $f$,
    :'s3', :'s4', :'order3', :'order4'
  ),
  format(
    $f$ values ('waiter.assigned', %L::uuid, 1::bigint), ('order.approved', %L::uuid, 1::bigint) $f$,
    :'s3', :'order3'
  ),
  'only the successful assignment and its approval are audited'
);

-- ─── Two managers assign different waiters to table 7 at once ───────────────
-- A: manager one assigns Priya to table 7 and keeps the transaction open,
-- holding the session row.
select pg_temp.begin_as('race_a', :'manager_one');
select pg_temp.run_on('race_a', format(
  'select public.admin_assign_waiter(%L, %L)', :'s7', :'priya'
)) as assign_priya \gset

-- B: manager two assigns Arjun to table 7 meanwhile.
select pg_temp.begin_as('race_b', :'manager_two');
select extensions.dblink_send_query('race_b', format(
  'select public.admin_assign_waiter(%L, %L)', :'s7', :'arjun'
));

select ok(
  pg_temp.wait_for_lock_wait(:'arjun'),
  'the second assignment waits for the session lock'
);

select extensions.dblink_exec('race_a', 'commit');
select pg_temp.result_of('race_b') as assign_arjun \gset
select extensions.dblink_exec('race_b', 'commit');

select is(
  :'assign_priya'::jsonb,
  jsonb_build_object(
    'session_id', :'s7', 'waiter_id', :'priya', 'changed', true, 'approved_orders', 1
  ),
  'the first manager assigns Priya, approving the waiting order'
);
select is(
  :'assign_arjun'::jsonb,
  jsonb_build_object(
    'session_id', :'s7', 'waiter_id', :'arjun', 'changed', true, 'approved_orders', 0
  ),
  'the second manager then hands the table to Arjun, with nothing left to approve'
);
select is(
  (select assigned_waiter_id from public.table_sessions where id = :'s7'),
  :'arjun'::uuid,
  'table 7 ends up with Arjun'
);
select results_eq(
  format(
    $f$ select waiter_id, unassign_reason::text
        from public.session_waiter_assignments where session_id = %L
        order by assigned_at $f$,
    :'s7'
  ),
  format($f$ values (%L::uuid, 'reassigned'), (%L::uuid, null) $f$, :'priya', :'arjun'),
  'the history shows Priya reassigned, then Arjun as the one current assignment'
);
select results_eq(
  format(
    $f$ select action, before ->> 'waiter_id'
        from public.audit_logs
        where action like 'waiter.%%' and entity_id = %L
        order by created_at, action $f$,
    :'s7'
  ),
  format($f$ values ('waiter.assigned', null), ('waiter.reassigned', %L) $f$, :'priya'),
  'the audit log shows the assignment, then the reassignment from Priya'
);
select is(
  (select count(*) from public.audit_logs where action = 'order.approved' and entity_id = :'order7'),
  1::bigint,
  'the waiting order is approved once'
);

-- ─── Suresh takes a free table while a manager assigns him (tables 8, 9) ────
-- A: manager one assigns Suresh to table 8 and keeps the transaction open,
-- holding Suresh's waiter row.
select pg_temp.begin_as('race_a', :'manager_one');
select pg_temp.run_on('race_a', format(
  'select public.admin_assign_waiter(%L, %L)', :'s8', :'suresh'
)) as assign_suresh \gset

-- B: Suresh, signed in with his linked waiter login, places an order at free
-- table 9 meanwhile. The auto-assign check waits for his waiter row.
select pg_temp.begin_as('race_b', :'suresh_login');
select extensions.dblink_send_query('race_b', format(
  'select public.staff_place_order(%L, %L::jsonb, %L)', :'t9', :'items', :'key_suresh'
));

select ok(
  pg_temp.wait_for_lock_wait(:'key_suresh'),
  'the auto-assign check waits for the waiter row lock'
);

select extensions.dblink_exec('race_a', 'commit');
select pg_temp.result_of('race_b') as suresh_order \gset
select extensions.dblink_exec('race_b', 'commit');

select is(
  (:'assign_suresh'::jsonb ->> 'changed')::boolean,
  true,
  'the manager assigns Suresh to table 8'
);
select is(
  :'suresh_order'::jsonb - 'order_id' - 'session_id',
  '{"round_number": 1, "status": "accepted", "replayed": false, "assigned_waiter_id": null}'::jsonb,
  'Suresh''s order is placed, but he is not auto-assigned: he is now busy'
);
select results_eq(
  format(
    $f$ select d.label
        from public.table_sessions s
        join public.dining_tables d on d.restaurant_id = s.restaurant_id and d.id = s.dining_table_id
        where s.assigned_waiter_id = %L and s.status = 'open' $f$,
    :'suresh'
  ),
  $$ values ('8') $$,
  'Suresh handles table 8 only'
);
select results_eq(
  format(
    $f$ select s.status::text, s.is_approved, s.assigned_waiter_id,
               (select count(*) from public.session_waiter_assignments a where a.session_id = s.id)
        from public.table_sessions s where s.dining_table_id = %L $f$,
    :'t9'
  ),
  $$ values ('open', true, null::uuid, 0::bigint) $$,
  'table 9 has one approved session, unassigned and with no assignment history'
);
select is(
  (select count(*) from public.audit_logs
   where action = 'waiter.assigned' and entity_id = (:'suresh_order'::jsonb ->> 'session_id')::uuid),
  0::bigint,
  'no auto-assignment is audited for table 9'
);

-- ─── Clean up the committed fixture ─────────────────────────────────────────
select extensions.dblink_exec('setup', format($f$
  begin;
  delete from public.audit_logs where restaurant_id = %1$L;
  delete from public.session_waiter_assignments where restaurant_id = %1$L;
  delete from public.order_items where restaurant_id = %1$L;
  delete from public.orders where restaurant_id = %1$L;
  delete from public.table_sessions where restaurant_id = %1$L;
  delete from public.waiters where restaurant_id = %1$L;
  delete from public.restaurant_members where restaurant_id = %1$L;
  delete from auth.users where email like %2$L;
  delete from public.menu_item_variants where restaurant_id = %1$L;
  delete from public.menu_items where restaurant_id = %1$L;
  delete from public.menu_categories where restaurant_id = %1$L;
  delete from public.dining_tables where restaurant_id = %1$L;
  delete from public.restaurant_subscriptions where restaurant_id = %1$L;
  delete from public.restaurants where id = %1$L;
  commit;
$f$, :'rest', '%@' || :'slug' || '.test'));

select is(
  (select count(*) from public.restaurants where slug = :'slug'),
  0::bigint,
  'the committed restaurant is removed'
);
select is(
  (select count(*) from auth.users where email like '%@' || :'slug' || '.test'),
  0::bigint,
  'the committed logins are removed'
);
select is(
  (select sum(n)::bigint from (
     select count(*) as n from public.audit_logs where restaurant_id = :'rest'
     union all select count(*) from public.session_waiter_assignments where restaurant_id = :'rest'
     union all select count(*) from public.order_items where restaurant_id = :'rest'
     union all select count(*) from public.orders where restaurant_id = :'rest'
     union all select count(*) from public.table_sessions where restaurant_id = :'rest'
     union all select count(*) from public.waiters where restaurant_id = :'rest'
     union all select count(*) from public.restaurant_members where restaurant_id = :'rest'
     union all select count(*) from public.menu_item_variants where restaurant_id = :'rest'
     union all select count(*) from public.menu_items where restaurant_id = :'rest'
     union all select count(*) from public.menu_categories where restaurant_id = :'rest'
     union all select count(*) from public.dining_tables where restaurant_id = :'rest'
     union all select count(*) from public.restaurant_subscriptions where restaurant_id = :'rest'
   ) as leftovers),
  0::bigint,
  'nothing else of the fixture is left behind'
);

select extensions.dblink_disconnect('setup');
select extensions.dblink_disconnect('race_a');
select extensions.dblink_disconnect('race_b');

select * from finish();

rollback;
