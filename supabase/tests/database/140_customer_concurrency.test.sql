-- Two first orders at the same free table at the same moment open exactly one
-- session (spec §18 Concurrency, §8.5 one open session per table).
--
-- pgTAP runs inside a single transaction, so the two competing transactions
-- run on their own dblink connections against committed fixtures. The fixture
-- restaurant has a random code and is deleted again at the end (a failed run
-- can leave it behind until the next `pnpm db:reset`).
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
select 'race-' || substr(md5(random()::text), 1, 10) as slug \gset
select 'RACE' || upper(substr(md5(random()::text), 1, 12)) as token \gset
\set d1 '11111111-1111-4111-8111-111111111111'
\set d2 '22222222-2222-4222-8222-222222222222'

select extensions.dblink_connect('setup', :'conn');
select extensions.dblink_connect('race_a', :'conn');
select extensions.dblink_connect('race_b', :'conn');

-- ─── Committed fixture ──────────────────────────────────────────────────────
select id as rest from extensions.dblink(
  'setup', format('select tests.create_restaurant(%L)', :'slug')
) as t(id uuid) \gset
select fx from extensions.dblink(
  'setup', format('select tests.create_ordering_fixture(%L, %L)', :'rest', :'token')
) as t(fx jsonb) \gset
select jsonb_build_array(tests.line((:'fx'::jsonb ->> 'simple')::uuid)) as items \gset

-- ─── The race ───────────────────────────────────────────────────────────────
-- A places the first order and keeps its transaction open, holding the lock.
select extensions.dblink_exec('race_a', 'begin');
select result as order_a from extensions.dblink(
  'race_a',
  format(
    'select public.customer_place_order(%L, %L, %L, %L::jsonb)',
    :'token', :'d1', 'race-order-a', :'items'
  )
) as t(result jsonb) \gset

-- B places a first order at the same free table meanwhile.
select extensions.dblink_send_query(
  'race_b',
  format(
    'select public.customer_place_order(%L, %L, %L, %L::jsonb)',
    :'token', :'d2', 'race-order-b', :'items'
  )
);

-- Wait (up to 5 s) until B is blocked on A's table lock.
create function pg_temp.wait_for_lock_wait(p_marker text)
returns boolean
language plpgsql
as $$
begin
  for i in 1..50 loop
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

select ok(
  pg_temp.wait_for_lock_wait('race-order-b'),
  'the second first order waits for the table lock'
);

select extensions.dblink_exec('race_a', 'commit');
select result as order_b from extensions.dblink_get_result('race_b') as t(result jsonb) \gset
select * from extensions.dblink_get_result('race_b') as t(result jsonb);

-- ─── One session, two rounds ────────────────────────────────────────────────
select is(
  (select count(*) from public.table_sessions where restaurant_id = :'rest'),
  1::bigint,
  'exactly one session is opened'
);
select results_eq(
  format(
    $f$ select round_number, client_device_id from public.orders
        where restaurant_id = %L order by round_number $f$,
    :'rest'
  ),
  format($f$ values (1, %L), (2, %L) $f$, :'d1', :'d2'),
  'the waiting order joins that session as round 2'
);
select is(
  (:'order_b'::jsonb ->> 'status'),
  'pending_approval',
  'both orders wait for approval in the same unapproved session'
);

-- ─── Clean up the committed fixture ─────────────────────────────────────────
select extensions.dblink_exec('setup', format($f$
  begin;
  delete from public.order_items where restaurant_id = %1$L;
  delete from public.orders where restaurant_id = %1$L;
  delete from public.table_sessions where restaurant_id = %1$L;
  delete from public.menu_items where restaurant_id = %1$L;
  delete from public.menu_categories where restaurant_id = %1$L;
  delete from public.dining_tables where restaurant_id = %1$L;
  delete from public.restaurant_subscriptions where restaurant_id = %1$L;
  delete from public.restaurants where id = %1$L;
  commit;
$f$, :'rest'));

select is(
  (select count(*) from public.restaurants where slug = :'slug'),
  0::bigint,
  'the committed fixture is removed'
);

select extensions.dblink_disconnect('setup');
select extensions.dblink_disconnect('race_a');
select extensions.dblink_disconnect('race_b');

select * from finish();

rollback;
