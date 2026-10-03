-- Two "Book a demo" requests for one phone at the same moment can't both slip
-- under the limit of 3 a day (docs/DECISIONS.md W-6).
--
-- pgTAP runs inside a single transaction, so the competing requests run on
-- their own dblink connections and commit; the leads are deleted at the end.
begin;

create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;

select no_plan();

-- See 140_customer_concurrency: dblink connects with a password through the
-- server's own address (local and CI stacks only).
select format(
  'host=%s port=5432 dbname=postgres user=postgres password=postgres',
  host(inet_server_addr())
) as conn \gset
select '8' || lpad((floor(random() * 1e9))::bigint::text, 9, '0') as phone \gset
select format('{"name": "Race", "restaurant_name": "R", "city": "C", "phone": "%s"}', :'phone') as lead \gset

select extensions.dblink_connect('setup', :'conn');
select extensions.dblink_connect('race_a', :'conn');
select extensions.dblink_connect('race_b', :'conn');

-- Two leads already today; one more is allowed.
select count(*) from extensions.dblink(
  'setup',
  format('select public.site_create_lead(%L) from generate_series(1, 2)', :'lead')
) as t(id uuid);

-- A sends the third and keeps its transaction open.
select extensions.dblink_exec('race_a', 'begin');
select count(*) from extensions.dblink(
  'race_a', format('select public.site_create_lead(%L)', :'lead')
) as t(id uuid);

-- B sends a fourth meanwhile.
select extensions.dblink_send_query(
  'race_b', format('select public.site_create_lead(%L) /* race-lead-b */', :'lead')
);

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

select ok(pg_temp.wait_for_lock_wait('race-lead-b'), 'the fourth request waits for the third');

select extensions.dblink_exec('race_a', 'commit');
select count(*) from extensions.dblink_get_result('race_b', false) as t(id uuid);
select matches(
  extensions.dblink_error_message('race_b'),
  'RATE_LIMITED',
  'then it is refused: the phone already has three'
);
select is(
  (select count(*) from public.site_leads where phone = :'phone'),
  3::bigint,
  'exactly three leads are stored'
);

select extensions.dblink_exec('setup', format('delete from public.site_leads where phone = %L', :'phone'));
select extensions.dblink_disconnect('setup');
select extensions.dblink_disconnect('race_a');
select extensions.dblink_disconnect('race_b');

select * from finish();
rollback;
