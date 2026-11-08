-- The minute job's first question (docs/DECISIONS.md VPS-29): which kinds of job have work
-- waiting, each by its own test, for the service role only.
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

-- ─── Each kind ──────────────────────────────────────────────────────────────
select tests.as_service_role();
select is(
  public.jobs_waiting(),
  '{"data_exports": false, "hindi_names": false, "announcement_emails": false}'::jsonb,
  'nothing waits'
);
select tests.clear_auth();

insert into public.restaurant_exports (restaurant_id) values (:'shop') returning id as export \gset
select tests.as_service_role();
select is(
  public.jobs_waiting(),
  '{"data_exports": true, "hindi_names": false, "announcement_emails": false}'::jsonb,
  'a queued export'
);
select tests.clear_auth();
update public.restaurant_exports set status = 'failed', finished_at = now() where id = :'export';

insert into public.menu_categories (restaurant_id, name) values (:'shop', 'Chaat')
  returning id as chaat \gset
select tests.as_service_role();
select is(
  public.jobs_waiting(),
  '{"data_exports": false, "hindi_names": true, "announcement_emails": false}'::jsonb,
  'a name without Hindi'
);
select tests.clear_auth();
update public.menu_categories set name_hi_auto_tried_at = now() where id = :'chaat';

insert into public.announcements (title, body, panels, restaurant_ids, starts_at, email)
values ('News', 'x', array['admin'], array[:'shop']::uuid[], now() - interval '1 minute', true)
returning id as news \gset
select tests.as_service_role();
select is(
  public.jobs_waiting(),
  '{"data_exports": false, "hindi_names": false, "announcement_emails": true}'::jsonb,
  'an announcement email to send'
);
select tests.clear_auth();
update public.announcements set ended_at = now() where id = :'news';

select tests.as_service_role();
select is(
  public.jobs_waiting(),
  '{"data_exports": false, "hindi_names": false, "announcement_emails": false}'::jsonb,
  'and nothing once each is done'
);
select tests.clear_auth();
select is(
  (select p.provolatile::text from pg_proc p where p.oid = 'public.jobs_waiting()'::regprocedure),
  's',
  'stable: an idle minute writes nothing'
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
