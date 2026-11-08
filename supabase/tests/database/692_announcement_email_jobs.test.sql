-- Announcement emails in runs (docs/DECISIONS.md VPS-28): the next emails due, in the due list's
-- order; a pair Resend refused, set aside for 20 hours; and what the minute job takes (the
-- owner's answer, 2026-11-08): an announcement once it has started, or once one of its emails
-- went. And what the minute job's check reads to find that nothing waits, and that it needs no
-- temporary file (VPS-29).
begin;
select no_plan();

-- ─── Fixtures ───────────────────────────────────────────────────────────────
select tests.create_restaurant('vps692-amber') as amber \gset
select tests.create_restaurant('vps692-basil') as basil \gset
select tests.create_restaurant('vps692-cumin') as cumin \gset
select tests.create_restaurant('vps692-dill') as dill \gset
select tests.add_member(:'amber', 'owner', 'vps692amber') as amber_owner \gset
select tests.add_member(:'basil', 'owner', 'vps692basil') as basil_owner \gset
select tests.add_member(:'cumin', 'owner', 'vps692cumin') as cumin_owner \gset
update public.restaurants set email = 'Kitchen@Vps692-Amber.test' where id = :'amber';
-- No owner login: the restaurant's own address.
update public.restaurants set email = 'vps692-dill@example.test' where id = :'dill';
-- Others' announcements (a dev database) end here, inside this test only.
update public.announcements set ended_at = now() where ended_at is null;

select (now() at time zone 'Asia/Kolkata')::date as today \gset
select (:'today'::date + time '10:00') at time zone 'Asia/Kolkata' as morning \gset

create function pg_temp.announce(
  p_title text,
  p_starts_at timestamptz,
  p_restaurant_ids uuid[] default null,
  p_cities text[] default null
)
returns uuid
language sql as $$
  insert into public.announcements (title, body, panels, restaurant_ids, cities, starts_at, email)
  values (p_title, 'x', array['admin'], p_restaurant_ids, p_cities, p_starts_at, true)
  returning id;
$$;
-- The emails a call gives, in its order: the announcement's title and the restaurant's slug.
create function pg_temp.next(
  p_at timestamptz,
  p_limit int default 50,
  p_minute_job boolean default false
)
returns text[]
language sql as $$
  select coalesce(array_agg(x.title || ' ' || r.slug order by x.n), '{}')
  from public.announcement_emails_next(p_at, p_limit, p_minute_job)
    with ordinality as x(announcement_id, restaurant_id, title, body, recipients, n)
  join public.restaurants r on r.id = x.restaurant_id;
$$;
create function pg_temp.due(p_at timestamptz)
returns text[]
language sql as $$
  select coalesce(array_agg(x.title || ' ' || r.slug order by x.n), '{}')
  from public.announcement_emails_due(p_at)
    with ordinality as x(announcement_id, restaurant_id, title, body, recipients, n)
  join public.restaurants r on r.id = x.restaurant_id;
$$;
-- How often this transaction has read these tables: the scans begun, by sequence or by index.
create function pg_temp.reads(p_tables regclass[])
returns bigint
language sql as $$
  select coalesce(sum(t.seq_scan + coalesce(t.idx_scan, 0)), 0)::bigint
  from pg_stat_xact_user_tables t
  where t.relid = any (p_tables);
$$;

-- At 10:00 India today: one started at 09:00, one starts at 18:00, and one has run for two days,
-- its email sent then to the one restaurant in its city.
select pg_temp.announce('Started', (:'today'::date + time '09:00') at time zone 'Asia/Kolkata',
  array[:'amber', :'basil', :'cumin']::uuid[]) as started \gset
select pg_temp.announce('Evening', (:'today'::date + time '18:00') at time zone 'Asia/Kolkata',
  array[:'amber', :'basil']::uuid[]) as evening \gset
select pg_temp.announce('Standing', :'morning'::timestamptz - interval '2 days', null,
  array['Vps692pur']) as standing \gset
update public.restaurants set city = 'Vps692pur' where id = :'amber';
insert into public.announcement_emails (announcement_id, restaurant_id, sent_at)
values (:'standing', :'amber', :'morning'::timestamptz - interval '2 days');

-- ─── What is due ────────────────────────────────────────────────────────────
select tests.as_service_role();
select is(
  pg_temp.next(:'morning'),
  array['Started vps692-amber', 'Started vps692-basil', 'Started vps692-cumin',
    'Evening vps692-amber', 'Evening vps692-basil'],
  'a save and the daily run take every email due today, the one starting later too'
);
select is(pg_temp.next(:'morning'), pg_temp.due(:'morning'), 'in the due list''s order');
select is(
  (select x.recipients from public.announcement_emails_next(:'morning') x
   where x.announcement_id = :'started' and x.restaurant_id = :'amber'),
  array['kitchen@vps692-amber.test', 'vps692amber@vps692-amber.test'],
  'to the due list''s addresses: the owners and the restaurant''s own'
);
select is(pg_temp.next(:'morning', 2), array['Started vps692-amber', 'Started vps692-basil'],
  'p_limit at a time');
select is(cardinality(pg_temp.next(:'morning', 0)), 1, 'at least one');
select is(cardinality(pg_temp.next(:'morning', null)), 5, 'and 50 when none is given');

-- ─── The minute job ─────────────────────────────────────────────────────────
select is(
  pg_temp.next(:'morning', 50, true),
  array['Started vps692-amber', 'Started vps692-basil', 'Started vps692-cumin'],
  'the minute job takes one that has started, not one starting later today'
);
select public.announcement_email_sent(:'evening', :'amber');
select is(
  pg_temp.next(:'morning', 50, true),
  array['Started vps692-amber', 'Started vps692-basil', 'Started vps692-cumin',
    'Evening vps692-basil'],
  'until one of its emails went: then it takes the rest, as of a daily run cut off'
);
select tests.clear_auth();
-- Dill moves to the city of the one that has run for two days.
update public.restaurants set city = ' vps692PUR ' where id = :'dill';
select tests.as_service_role();
select is(
  (pg_temp.next(:'morning', 50, true))[1],
  'Standing vps692-dill',
  'a restaurant that joins a running one''s audience is the minute job''s, days after the others'
);
select is(
  (select x.recipients from public.announcement_emails_next(:'morning', 1, true) x),
  array['vps692-dill@example.test'],
  'to its own address'
);

-- ─── Refusals ───────────────────────────────────────────────────────────────
select public.announcement_email_failed(:'started', :'basil',
  'Resend answered 422: ' || repeat('x', 400));
select tests.clear_auth();
select is(
  (select array[f.tries::text, char_length(f.error)::text]
   from public.announcement_email_failures f
   where f.announcement_id = :'started' and f.restaurant_id = :'basil'),
  array['1', '300'],
  'a refusal is recorded, its answer cut to 300 characters'
);
update public.announcement_email_failures
  set failed_at = :'morning'::timestamptz - interval '19 hours 59 minutes';
select tests.as_service_role();
select ok(not ('Started vps692-basil' = any (pg_temp.next(:'morning'))),
  'the pair is set aside for 20 hours');
select ok(not ('Started vps692-basil' = any (pg_temp.next(:'morning', 50, true))),
  'from the minute job too');
select ok('Started vps692-amber' = any (pg_temp.next(:'morning')), 'the others still go');
select tests.clear_auth();
update public.announcement_email_failures
  set failed_at = :'morning'::timestamptz - interval '20 hours 1 minute';
select tests.as_service_role();
select ok('Started vps692-basil' = any (pg_temp.next(:'morning')), 'then it is tried again');
select ok('Started vps692-basil' = any (pg_temp.next(:'morning', 50, true)), 'by either');

select public.announcement_email_failed(:'started', :'basil', 'Resend answered 422: again');
select tests.clear_auth();
select is(
  (select array[f.tries::text, f.error, (f.failed_at = now())::text]
   from public.announcement_email_failures f
   where f.announcement_id = :'started' and f.restaurant_id = :'basil'),
  array['2', 'Resend answered 422: again', 'true'],
  'refused again: counted, with its new answer, set aside from now'
);
select tests.as_service_role();
select public.announcement_email_sent(:'started', :'basil');
select public.announcement_email_sent(:'started', :'basil');
select tests.clear_auth();
select ok(
  not exists (select 1 from public.announcement_email_failures f
    where f.announcement_id = :'started' and f.restaurant_id = :'basil'),
  'sent at last: no longer set aside'
);
select is(
  (select count(*)::int from public.announcement_emails e
   where e.announcement_id = :'started' and e.restaurant_id = :'basil'),
  1,
  'and recorded once, however often'
);

-- ─── What waits ─────────────────────────────────────────────────────────────
update public.announcements set ended_at = now() where ended_at is null;
select pg_temp.reads(array['public.restaurants', 'public.restaurant_members', 'auth.users'])
  as reads \gset
select ok(not private.announcement_emails_waiting(),
  'nothing waits without a running email announcement');
select is(pg_temp.reads(array['public.restaurants', 'public.restaurant_members', 'auth.users']),
  :reads::bigint, 'found without reading a restaurant or a login');
select ((now() at time zone 'Asia/Kolkata')::date + 1)::timestamp at time zone 'Asia/Kolkata'
  as day_end \gset
-- Later today, whatever the time now.
select pg_temp.announce('Soon', now() + (:'day_end'::timestamptz - now()) / 2,
  array[:'amber', :'basil']::uuid[]) as soon \gset
select ok(not private.announcement_emails_waiting(),
  'nor one starting later today: its emails are the daily run''s');
select public.announcement_email_sent(:'soon', :'amber');
select ok(private.announcement_emails_waiting(), 'until one of them went');
select public.announcement_email_sent(:'soon', :'basil');
select ok(not private.announcement_emails_waiting(), 'and none once they all went');
-- Finding that looks up no restaurant's owners: what it reads of the logins (the planner's own
-- look at them, each time) stays the same with more restaurants left out of the audience.
select pg_temp.reads(array['public.restaurant_members', 'auth.users']) as reads \gset
select private.announcement_emails_waiting() as waiting \gset
select pg_temp.reads(array['public.restaurant_members', 'auth.users']) - :reads as one_check \gset
select count(tests.add_member(tests.create_restaurant('vps692-more' || n), 'owner',
  'vps692more' || n)) as more from generate_series(1, 5) as n \gset
select pg_temp.reads(array['public.restaurant_members', 'auth.users']) as reads \gset
select private.announcement_emails_waiting() as waiting \gset
select is(pg_temp.reads(array['public.restaurant_members', 'auth.users']) - :reads,
  :one_check::bigint, 'nor reads more of the logins with five more restaurants left out');
select pg_temp.announce('Now', now() - interval '1 minute', array[:'cumin']::uuid[])
  as started_now \gset
select ok(private.announcement_emails_waiting(), 'one that has started waits');
select public.announcement_email_failed(:'started_now', :'cumin', 'Resend answered 422: x');
select ok(not private.announcement_emails_waiting(), 'but not with its one pair just refused');

-- First of all in order, a restaurant with no address of any kind: the limit counts emails only.
select tests.create_restaurant('vps692-aaa') as bare \gset
select pg_temp.announce('Bare', now() - interval '2 minutes', array[:'bare', :'cumin']::uuid[])
  as bare_news \gset
select is(pg_temp.next(now(), 1), array['Bare vps692-cumin'],
  'a restaurant with no address is passed over, and the limit counts the emails');
select is(pg_temp.next(now(), 1, true), array['Bare vps692-cumin'], 'by the minute job too');
select ok(private.announcement_emails_waiting(), 'which waits for it');

-- No temporary file, even at the smallest work_mem: between its steps the check holds the ids of
-- the pairs not sent and the order's keys, not an announcement's texts once for each restaurant
-- (review finding S1). Long texts, in Hindi too, for one restaurant among 150 more.
update public.announcements set ended_at = now() where ended_at is null;
create function pg_temp.temp_blocks(p_query text)
returns bigint
language plpgsql
set work_mem = '64kB'
as $$
declare
  v_plan json;
begin
  execute 'explain (analyze, buffers, format json) ' || p_query into v_plan;
  return coalesce((v_plan -> 0 -> 'Plan' ->> 'Temp Written Blocks')::bigint, 0);
end;
$$;
create function pg_temp.announce_long(p_restaurant_ids uuid[])
returns uuid
language sql as $$
  insert into public.announcements (title, body, title_hi, body_hi, panels, restaurant_ids,
    starts_at, email)
  values (left(repeat('Menu update ', 10), 120),
    left(repeat('Prices now show in rupees. ', 19), 500),
    left(repeat('मेनू अपडेट ', 12), 120),
    left(repeat('अब कीमतें रुपये में दिखती हैं। ', 17), 500),
    array['admin'], p_restaurant_ids, now() - interval '1 day', true)
  returning id;
$$;
select array_agg(tests.create_restaurant('vps692-many' || n) order by n) as many
  from generate_series(1, 150) as n \gset
update public.restaurants set email = slug || '@example.test' where id = any (:'many'::uuid[]);
select pg_temp.announce_long(array[(:'many'::uuid[])[1]]) as one \gset
select public.announcement_email_sent(:'one', (:'many'::uuid[])[1]);
select is(pg_temp.temp_blocks('select * from public.announcement_emails_next(now(), 1, true)'),
  0::bigint, 'one whose email went is checked without a temporary file');
update public.announcements set ended_at = now() where id = :'one';
select pg_temp.announce_long(:'many'::uuid[]) as all_many \gset
select is(pg_temp.temp_blocks('select * from public.announcement_emails_next(now(), 1, true)'),
  0::bigint, 'and so is one whose 150 emails wait');

-- ─── Grants ─────────────────────────────────────────────────────────────────
select ok(
  (select c.relrowsecurity from pg_class c
   where c.oid = 'public.announcement_email_failures'::regclass),
  'the refusals are behind RLS'
);
select tests.authenticate_as(:'amber_owner');
select throws_ok('select * from public.announcement_emails_next()', '42501', null,
  'an owner can''t list the emails');
select throws_ok(format('select public.announcement_email_failed(%L, %L, %L)', :'started',
  :'amber', 'x'), '42501', null, 'set one aside');
select throws_ok(format('select public.announcement_email_sent(%L, %L)', :'started', :'amber'),
  '42501', null, 'record one');
select throws_ok('select count(*) from public.announcement_email_failures', '42501', null,
  'or read the refusals');
select tests.clear_auth();
select tests.as_anon();
select throws_ok('select * from public.announcement_emails_next()', '42501', null,
  'nor can anyone signed out');
select throws_ok(format('select public.announcement_email_failed(%L, %L, %L)', :'started',
  :'amber', 'x'), '42501', null, 'set one aside');
select throws_ok('select count(*) from public.announcement_email_failures', '42501', null,
  'or read them');
select tests.clear_auth();

select * from finish();
rollback;
