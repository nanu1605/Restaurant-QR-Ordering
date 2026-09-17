-- Billing races (spec §18 Concurrency, §10.1, §10.3 nothing changes after
-- billing, §11.2 consecutive invoice numbers; docs/DECISIONS.md P4-10 lock
-- order, P5-4, P5-5, P5-7). Same dblink pattern as 200_staff_concurrency: A
-- holds its locks in an open transaction, B is sent meanwhile and must wait,
-- then A commits and B finishes. The committed fixture is deleted at the end.
begin;

create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;

select no_plan();

select format(
  'host=%s port=5432 dbname=postgres user=postgres password=postgres',
  host(inet_server_addr())
) as conn \gset

select substr(md5(random()::text), 1, 10) as tag \gset
select 'p5-250-' || :'tag' as slug, 'P5250' || upper(substr(:'tag', 1, 9)) as tok \gset
-- Customer device ids (one phone per table, two at tables 6 and 8).
select
  gen_random_uuid() as phone3,
  gen_random_uuid() as phone4,
  gen_random_uuid() as phone5,
  gen_random_uuid() as phone6,
  gen_random_uuid() as phone6b,
  gen_random_uuid() as phone7,
  gen_random_uuid() as phone8,
  gen_random_uuid() as phone8b
\gset

select extensions.dblink_connect('setup', :'conn');
select extensions.dblink_connect('race_a', :'conn');
select extensions.dblink_connect('race_b', :'conn');

-- ─── Helpers ────────────────────────────────────────────────────────────────
create function pg_temp.setup(p_sql text)
returns text
language sql
as $$
  select value from extensions.dblink('setup', p_sql) as t(value text);
$$;

-- A committed customer order at the table with QR token p_token from device
-- p_device. Returns the order id.
create function pg_temp.customer_order(p_token text, p_device text, p_items jsonb)
returns uuid
language sql
as $$
  select (pg_temp.setup(format(
    'select public.customer_place_order(%L, %L, gen_random_uuid()::text, %L::jsonb)',
    p_token, p_device, p_items
  ))::jsonb ->> 'order_id')::uuid;
$$;

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

create function pg_temp.error_json(p_message text, p_detail text)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object('error', p_message || coalesce(' ' || nullif(p_detail, ''), ''));
$$;

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
  return pg_temp.error_json(sqlerrm, v_detail);
end;
$$;

create function pg_temp.result_of(p_conn text)
returns jsonb
language plpgsql
as $$
declare
  v_result jsonb;
  v_detail text;
begin
  select result into v_result from extensions.dblink_get_result(p_conn) as t(result jsonb);
  perform * from extensions.dblink_get_result(p_conn) as t(result jsonb);
  return v_result;
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  perform * from extensions.dblink_get_result(p_conn) as t(result jsonb);
  return pg_temp.error_json(sqlerrm, v_detail);
end;
$$;

create function pg_temp.wait_for_lock_wait(p_marker text)
returns boolean
language plpgsql
as $$
begin
  for i in 1..50 loop
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

-- A generate call; p_marker only tags the SQL text (a reason with no discount
-- is ignored) so the waiting call can be found.
create function pg_temp.generate_sql(p_session uuid, p_marker text)
returns text
language sql
immutable
as $$
  select format(
    'select public.admin_generate_bill(%L, ''none'', 0, %L, false)', p_session, p_marker
  );
$$;

-- ─── Committed fixture ──────────────────────────────────────────────────────
-- No approval (customer orders are accepted straight away), no waiter
-- profiles (bills don't need a waiter), two managers, tables 3–8.
select pg_temp.setup(format('select tests.create_restaurant(%L)', :'slug')) as rest \gset
select pg_temp.setup(format('select tests.create_ordering_fixture(%L, %L)', :'rest', :'tok' || 'T5'))
  as fx \gset
select
  jsonb_build_array(tests.line((:'fx'::jsonb ->> 'simple')::uuid)) as items,
  jsonb_build_array(tests.line((:'fx'::jsonb ->> 'simple')::uuid, 2)) as items_two
\gset

select extensions.dblink_exec('setup', format(
  $f$
  update public.restaurants set require_first_order_approval = false where id = %1$L;
  insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
  values (%1$L, '3', %2$L, 3), (%1$L, '4', %3$L, 4), (%1$L, '6', %4$L, 6),
         (%1$L, '7', %5$L, 7), (%1$L, '8', %6$L, 8);
  $f$,
  :'rest', :'tok' || 'T3', :'tok' || 'T4', :'tok' || 'T6', :'tok' || 'T7', :'tok' || 'T8'
));

select
  pg_temp.setup(format('select tests.add_member(%L, %L, %L)', :'rest', 'manager', 'manager_one'))
    as manager_one,
  pg_temp.setup(format('select tests.add_member(%L, %L, %L)', :'rest', 'manager', 'manager_two'))
    as manager_two
\gset

select
  pg_temp.customer_order(:'tok' || 'T3', :'phone3', :'items') as order3,
  pg_temp.customer_order(:'tok' || 'T4', :'phone4', :'items') as order4,
  pg_temp.customer_order(:'tok' || 'T5', :'phone5', :'items') as order5,
  pg_temp.customer_order(:'tok' || 'T6', :'phone6', :'items') as order6,
  pg_temp.customer_order(:'tok' || 'T7', :'phone7', :'items') as order7,
  pg_temp.customer_order(:'tok' || 'T8', :'phone8', :'items') as order8
\gset
select
  (select session_id from public.orders where id = :'order3') as s3,
  (select session_id from public.orders where id = :'order4') as s4,
  (select session_id from public.orders where id = :'order5') as s5,
  (select session_id from public.orders where id = :'order6') as s6,
  (select session_id from public.orders where id = :'order7') as s7,
  (select session_id from public.orders where id = :'order8') as s8,
  (select id from public.order_items where order_id = :'order6') as dish6,
  (select id from public.order_items where order_id = :'order8') as dish8
\gset

-- ─── Two managers generate the same bill (table 3) ──────────────────────────
select pg_temp.begin_as('race_a', :'manager_one');
select pg_temp.run_on('race_a', pg_temp.generate_sql(:'s3', :'tag' || '-gen-first')) as gen_first \gset
select pg_temp.begin_as('race_b', :'manager_two');
select extensions.dblink_send_query('race_b', pg_temp.generate_sql(:'s3', :'tag' || '-gen-second'));
select ok(pg_temp.wait_for_lock_wait(:'tag' || '-gen-second'), 'the second generate waits for the first');
select extensions.dblink_exec('race_a', 'commit');
select pg_temp.result_of('race_b') as gen_second \gset
select extensions.dblink_exec('race_b', 'rollback');

select is(
  :'gen_second'::jsonb,
  jsonb_build_object('error', 'ALREADY_BILLED ' || (:'gen_first'::jsonb ->> 'bill_id')),
  'the second manager is pointed at the first manager''s bill'
);
select is(
  (select count(*) from public.bills where session_id = :'s3'), 1::bigint,
  'table 3 has exactly one bill'
);

-- ─── Bill first, customer orders meanwhile (table 4) ────────────────────────
select pg_temp.begin_as('race_a', :'manager_one');
select pg_temp.run_on('race_a', pg_temp.generate_sql(:'s4', :'tag' || '-gen-4')) as gen4 \gset
select extensions.dblink_send_query('race_b', format(
  'select public.customer_place_order(%L, %L, %L, %L::jsonb)',
  :'tok' || 'T4', :'phone4', :'tag' || '-late-order-4', :'items_two'
));
select ok(pg_temp.wait_for_lock_wait(:'tag' || '-late-order-4'), 'the customer order waits for bill generation');
select extensions.dblink_exec('race_a', 'commit');
select pg_temp.result_of('race_b') as late4 \gset

select is(
  (select jsonb_build_array(b.line_items -> 0 -> 'qty', o.session_id <> :'s4'::uuid, o.round_number, o.status)
   from public.bills b, public.orders o
   where b.id = (:'gen4'::jsonb ->> 'bill_id')::uuid and o.id = (:'late4'::jsonb ->> 'order_id')::uuid),
  '[1, true, 1, "accepted"]'::jsonb,
  'the bill has only the dish ordered before it; the late order starts the next session'
);

-- ─── Customer orders first, bill meanwhile (table 5) ────────────────────────
select extensions.dblink_exec('race_a', 'begin');
select pg_temp.run_on('race_a', format(
  'select public.customer_place_order(%L, %L, %L, %L::jsonb)',
  :'tok' || 'T5', :'phone5', :'tag' || '-round-2-5', :'items_two'
)) as round2_5 \gset
select pg_temp.begin_as('race_b', :'manager_two');
select extensions.dblink_send_query('race_b', pg_temp.generate_sql(:'s5', :'tag' || '-gen-5'));
select ok(pg_temp.wait_for_lock_wait(:'tag' || '-gen-5'), 'bill generation waits for the customer order');
select extensions.dblink_exec('race_a', 'commit');
select pg_temp.result_of('race_b') as gen5 \gset
select extensions.dblink_exec('race_b', 'commit');

select is(
  (select jsonb_build_array(o.session_id = :'s5'::uuid, o.round_number, b.line_items -> 0 -> 'qty', b.subtotal_paise)
   from public.bills b, public.orders o
   where b.id = (:'gen5'::jsonb ->> 'bill_id')::uuid and o.id = (:'round2_5'::jsonb ->> 'order_id')::uuid),
  '[true, 2, 3, 84000]'::jsonb,
  'the order that got in first is round 2 and is on the bill'
);

-- ─── A customer cancel waits for the bill (table 6) ─────────────────────────
select pg_temp.begin_as('race_a', :'manager_one');
select pg_temp.run_on('race_a', pg_temp.generate_sql(:'s6', :'tag' || '-gen-6')) as gen6 \gset
select extensions.dblink_send_query('race_b', format(
  'select public.customer_cancel_item(%L, %L, %L) as %I',
  :'tok' || 'T6', :'phone6', :'dish6', :'tag' || '-cancel-6'
));
select ok(pg_temp.wait_for_lock_wait(:'tag' || '-cancel-6'), 'the cancel waits for the dish lock bill generation holds');
select extensions.dblink_exec('race_a', 'commit');
select pg_temp.result_of('race_b') as cancel6 \gset

select is(:'cancel6'::jsonb, '{"error": "NOT_FOUND"}'::jsonb, 'a dish on the bill can no longer be cancelled');
select is(
  (select status::text from public.order_items where id = :'dish6'), 'placed',
  'the billed dish keeps its status'
);

-- ─── Bill generation waits for a customer cancel (table 8) ──────────────────
select extensions.dblink_exec('race_a', 'begin');
select pg_temp.run_on('race_a', format(
  'select public.customer_cancel_item(%L, %L, %L)', :'tok' || 'T8', :'phone8', :'dish8'
)) as cancel8 \gset
-- Table 8 needs something else on the bill.
select pg_temp.customer_order(:'tok' || 'T8', :'phone8b', :'items_two');
select pg_temp.begin_as('race_b', :'manager_two');
select extensions.dblink_send_query('race_b', pg_temp.generate_sql(:'s8', :'tag' || '-gen-8'));
select ok(pg_temp.wait_for_lock_wait(:'tag' || '-gen-8'), 'bill generation waits for the dish the customer is cancelling');
select extensions.dblink_exec('race_a', 'commit');
select pg_temp.result_of('race_b') as gen8 \gset
select extensions.dblink_exec('race_b', 'commit');

select is(
  (select jsonb_build_array(b.line_items -> 0 -> 'qty', b.subtotal_paise)
   from public.bills b where b.id = (:'gen8'::jsonb ->> 'bill_id')::uuid),
  '[2, 56000]'::jsonb,
  'the cancelled dish is left off the bill'
);

-- ─── Two tables billed at once (tables 7 and 6) ─────────────────────────────
-- A: generate table 7 and hold the invoice counter. B: bill table 6's next
-- session meanwhile; the counter row makes B wait, and the numbers come out
-- consecutive.
select pg_temp.customer_order(:'tok' || 'T6', :'phone6b', :'items') as order6b \gset
select (select session_id from public.orders where id = :'order6b') as s6b \gset

select pg_temp.begin_as('race_a', :'manager_one');
select pg_temp.run_on('race_a', pg_temp.generate_sql(:'s7', :'tag' || '-gen-7')) as gen7 \gset
select pg_temp.begin_as('race_b', :'manager_two');
select extensions.dblink_send_query('race_b', pg_temp.generate_sql(:'s6b', :'tag' || '-gen-6b'));
select ok(pg_temp.wait_for_lock_wait(:'tag' || '-gen-6b'), 'another table''s bill waits for the invoice counter');
select extensions.dblink_exec('race_a', 'commit');
select pg_temp.result_of('race_b') as gen6b \gset
select extensions.dblink_exec('race_b', 'commit');

select is(
  (select jsonb_agg(invoice_seq order by invoice_seq) from public.bills where restaurant_id = :'rest'),
  '[1, 2, 3, 4, 5, 6, 7]'::jsonb,
  'every bill has its own consecutive number'
);

-- ─── A reopen and a customer order at the same table (table 5) ──────────────
select pg_temp.begin_as('race_a', :'manager_one');
select pg_temp.run_on('race_a', format(
  'select public.admin_void_bill(%L, %L, true)', :'gen5'::jsonb ->> 'bill_id', 'Add dessert'
)) as reopen5 \gset
select extensions.dblink_send_query('race_b', format(
  'select public.customer_place_order(%L, %L, %L, %L::jsonb)',
  :'tok' || 'T5', :'phone5', :'tag' || '-dessert-5', :'items'
));
select ok(pg_temp.wait_for_lock_wait(:'tag' || '-dessert-5'), 'the customer order waits for the reopen');
select extensions.dblink_exec('race_a', 'commit');
select pg_temp.result_of('race_b') as dessert5 \gset

select is(
  (select jsonb_build_array(o.session_id = :'s5'::uuid, o.round_number, s.status)
   from public.orders o join public.table_sessions s on s.id = o.session_id
   where o.id = (:'dessert5'::jsonb ->> 'order_id')::uuid),
  '[true, 3, "open"]'::jsonb,
  'the order joins the reopened session as round 3'
);
select is(
  (select count(*) from public.table_sessions where restaurant_id = :'rest' and dining_table_id = (
     select dining_table_id from public.table_sessions where id = :'s5') and status = 'open'),
  1::bigint,
  'table 5 still has one open session'
);

-- ─── Clean up the committed fixture ─────────────────────────────────────────
select extensions.dblink_exec('setup', format($f$
  begin;
  delete from public.audit_logs where restaurant_id = %1$L;
  delete from public.bill_payments where restaurant_id = %1$L;
  delete from public.bills where restaurant_id = %1$L;
  delete from public.invoice_counters where restaurant_id = %1$L;
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
  (select count(*) from public.restaurants where slug = :'slug'), 0::bigint,
  'the committed restaurant is removed'
);
select is(
  (select sum(n)::bigint from (
     select count(*) as n from public.bills where restaurant_id = :'rest'
     union all select count(*) from public.invoice_counters where restaurant_id = :'rest'
     union all select count(*) from public.table_sessions where restaurant_id = :'rest'
     union all select count(*) from public.orders where restaurant_id = :'rest'
     union all select count(*) from auth.users where email like '%@' || :'slug' || '.test'
   ) as leftovers),
  0::bigint,
  'nothing else of the fixture is left behind'
);

select extensions.dblink_disconnect('setup');
select extensions.dblink_disconnect('race_a');
select extensions.dblink_disconnect('race_b');

select * from finish();

rollback;
