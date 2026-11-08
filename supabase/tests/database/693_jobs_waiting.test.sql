-- The minute job's first question (docs/DECISIONS.md VPS-29): which kinds of job have work
-- waiting, each by its own test, for the service role only. No call writes, whether or not it
-- finds work.
begin;
select no_plan();

-- ─── Fixtures ───────────────────────────────────────────────────────────────
select tests.create_restaurant('vps693-shop') as shop \gset
select tests.add_member(:'shop', 'owner', 'vps693owner') as owner \gset

-- A local database's own work, set aside until the rollback.
update public.restaurant_exports
  set status = 'failed', lease_until = null, finished_at = now()
  where status in ('queued', 'building');
update public.menu_categories set name_hi_auto_tried_at = now()
  where name_hi is null and name_hi_auto is null;
update public.menu_items set name_hi_auto_tried_at = now()
  where name_hi is null and name_hi_auto is null;
update public.announcements set ended_at = now() where ended_at is null;

-- The rows this transaction has written, read just before and just after each call: a function
-- behind jobs_waiting that writes shows there, whether or not it found work (review findings D1
-- and S2). pgTAP keeps its results in temporary tables, which are left out.
create function pg_temp.writes()
returns numeric
language sql as $$
  select coalesce(sum(t.n_tup_ins + t.n_tup_upd + t.n_tup_del), 0)
  from pg_stat_xact_user_tables t
  where t.schemaname !~ '^pg_temp';
$$;

-- ─── Each kind ──────────────────────────────────────────────────────────────
select pg_temp.writes() as writes \gset
select tests.as_service_role();
select is(
  public.jobs_waiting(),
  '{"data_exports": false, "hindi_names": false, "announcement_emails": false}'::jsonb,
  'nothing waits'
);
select tests.clear_auth();
select is(pg_temp.writes(), :writes::numeric, 'and asking writes nothing');

insert into public.restaurant_exports (restaurant_id) values (:'shop') returning id as export \gset
select pg_temp.writes() as writes \gset
select tests.as_service_role();
select is(
  public.jobs_waiting(),
  '{"data_exports": true, "hindi_names": false, "announcement_emails": false}'::jsonb,
  'a queued export'
);
select tests.clear_auth();
select is(pg_temp.writes(), :writes::numeric, 'found without a write');
update public.restaurant_exports set status = 'failed', finished_at = now() where id = :'export';

-- A build whose lease ran out: the next claim takes it back (VPS-26), not the question.
insert into public.restaurant_exports (restaurant_id, status, claim_id, lease_until)
values (:'shop', 'building', gen_random_uuid(), now() - interval '1 minute')
returning id as lapsed \gset
select pg_temp.writes() as writes \gset
select tests.as_service_role();
select is(
  public.jobs_waiting(),
  '{"data_exports": true, "hindi_names": false, "announcement_emails": false}'::jsonb,
  'a build whose lease ran out'
);
select tests.clear_auth();
select is(pg_temp.writes(), :writes::numeric, 'found without a write, the build left as it was');
update public.restaurant_exports set status = 'failed', lease_until = null, finished_at = now()
  where id = :'lapsed';

insert into public.menu_categories (restaurant_id, name) values (:'shop', 'Chaat')
  returning id as chaat \gset
select pg_temp.writes() as writes \gset
select tests.as_service_role();
select is(
  public.jobs_waiting(),
  '{"data_exports": false, "hindi_names": true, "announcement_emails": false}'::jsonb,
  'a name without Hindi'
);
select tests.clear_auth();
select is(pg_temp.writes(), :writes::numeric, 'found without a write, the name not leased');
update public.menu_categories set name_hi_auto_tried_at = now() where id = :'chaat';

insert into public.announcements (title, body, panels, restaurant_ids, starts_at, email)
values ('News', 'x', array['admin'], array[:'shop']::uuid[], now() - interval '1 minute', true)
returning id as news \gset
select pg_temp.writes() as writes \gset
select tests.as_service_role();
select is(
  public.jobs_waiting(),
  '{"data_exports": false, "hindi_names": false, "announcement_emails": true}'::jsonb,
  'an announcement email to send'
);
select tests.clear_auth();
select is(pg_temp.writes(), :writes::numeric, 'found without a write, the email not sent');
update public.announcements set ended_at = now() where id = :'news';

select pg_temp.writes() as writes \gset
select tests.as_service_role();
select is(
  public.jobs_waiting(),
  '{"data_exports": false, "hindi_names": false, "announcement_emails": false}'::jsonb,
  'and nothing once each is done'
);
select tests.clear_auth();
select is(pg_temp.writes(), :writes::numeric, 'and asking writes nothing again');

-- An idle minute writes nothing, whatever the tests behind it call: two calls in a row.
select pg_temp.writes() as writes \gset
select tests.as_service_role();
select public.jobs_waiting() as first_tick \gset
select public.jobs_waiting() as second_tick \gset
select tests.clear_auth();
select is(pg_temp.writes(), :writes::numeric, 'two idle calls write nothing');
select is(
  (select p.provolatile::text from pg_proc p where p.oid = 'public.jobs_waiting()'::regprocedure),
  's',
  'and it is stable'
);

-- ─── Grants ─────────────────────────────────────────────────────────────────
select tests.authenticate_as(:'owner');
select throws_ok('select public.jobs_waiting()', '42501', null, 'an owner can''t ask');
select tests.clear_auth();
select tests.as_anon();
select throws_ok('select public.jobs_waiting()', '42501', null, 'nor can anyone signed out');
select tests.clear_auth();

select * from finish();
rollback;
