-- Announcements and standees (docs/SUPER_ADMIN_PLAN.md 14c, docs/DECISIONS.md
-- SA-82+): who sees a banner and when, dismissing, emails once per
-- restaurant, the standee record by role, its dates and the QR step.
begin;
select no_plan();

-- ─── Fixtures ───────────────────────────────────────────────────────────────
select tests.create_platform_admin('sa660-admin@example.test') as admin \gset
select tests.create_platform_admin('sa660-sales@example.test') as sales \gset
select tests.create_platform_admin('sa660-finance@example.test') as finance \gset
update public.platform_admins set role = 'sales' where user_id = :'sales';
update public.platform_admins set role = 'finance' where user_id = :'finance';
select tests.create_restaurant('sa660-jaipur') as jaipur \gset
select tests.create_restaurant('sa660-pune') as pune \gset
select tests.create_restaurant('sa660-other') as other \gset
select tests.create_restaurant('sa660-shut') as shut \gset
update public.restaurants set city = 'Jaipur' where id = :'jaipur';
update public.restaurants set city = ' pune ' where id = :'pune';
update public.restaurants set email = 'sa660-shut@example.test' where id = :'shut';
select tests.set_plan(:'pune', 'starter');
select tests.suspend(:'shut');
select tests.add_member(:'jaipur', 'owner', 'sa660owner') as owner \gset
select tests.add_member(:'jaipur', 'waiter', 'sa660waiter') as waiter \gset
select tests.add_member(:'pune', 'owner', 'sa660puneowner') as pune_owner \gset
select tests.add_member(:'other', 'manager', 'sa660manager') as other_manager \gset
select (now() at time zone 'Asia/Kolkata')::date as today \gset
-- Others' announcements (a dev database) end here, inside this test only.
update public.announcements set ended_at = now() where ended_at is null;

-- The titles a login sees now in a panel of its restaurant.
create function pg_temp.seen(p_user uuid, p_restaurant uuid, p_panel text) returns text[]
language plpgsql as $$
declare
  v text[];
begin
  perform tests.authenticate_as(p_user);
  select coalesce(array_agg(x ->> 'title' order by x ->> 'title'), '{}') into v
  from jsonb_array_elements(public.member_announcements(p_restaurant, p_panel)) as x;
  perform tests.clear_auth();
  return v;
end;
$$;

create function pg_temp.save(p_announcement jsonb, p_id uuid default null) returns uuid
language sql as $$
  select (public.platform_save_announcement(p_announcement, p_id) ->> 'id')::uuid;
$$;

-- ─── Announcements: making them ─────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select is(
  public.platform_save_announcement('{"title": "  New   menu  ", "body": "Line one\nLine two ",
    "panels": ["worker", "admin", "admin"]}') - 'id',
  '{"email_due": false}'::jsonb,
  'a new one, without email'
);
select is(
  (select (x ->> 'starts_at')::timestamptz
   from jsonb_array_elements(public.platform_list_announcements() -> 'announcements') as x
   where x ->> 'title' = 'New menu'),
  date_trunc('minute', now()), 'a start left empty is this minute, as the form shows it'
);
select pg_temp.save('{"title": "Starter only", "body": "x", "panels": ["admin"],
  "plan_codes": ["starter"]}') as for_starter \gset
select pg_temp.save('{"title": "Jaipur only", "body": "x", "panels": ["admin", "worker"],
  "cities": ["JAIPUR"]}') as for_jaipur \gset
select pg_temp.save(jsonb_build_object('title', 'Chosen', 'body', 'x', 'panels', array['admin'],
  'restaurant_ids', array[:'other'])) as for_other \gset
select pg_temp.save('{"title": "Kitchen only", "body": "x", "panels": ["worker"],
  "title_hi": "रसोई", "body_hi": "सूचना", "dismissible": false}') as worker_only \gset
select pg_temp.save(jsonb_build_object('title', 'Tomorrow', 'body', 'x', 'panels', array['admin'],
  'restaurant_ids', array[:'jaipur', :'shut'], 'starts_at', now() + interval '1 day',
  'ends_at', now() + interval '2 days', 'email', true)) as tomorrow \gset
select pg_temp.save('{"title": "Ended early", "body": "x", "panels": ["admin"]}') as ended \gset
select pg_temp.save('{"ended": true}', :'ended');
select pg_temp.save('{"title": "Past", "body": "x", "panels": ["admin"]}') as past \gset
select tests.clear_auth();
update public.announcements set starts_at = now() - interval '2 days', ends_at = now() - interval '1 day'
where id = :'past';

select is(
  (select array[a.title, a.body, array_to_string(a.panels, ',')] from public.announcements a
   where a.title = 'New menu'),
  array['New menu', E'Line one\nLine two', 'admin,worker'],
  'the title is tidied, the text keeps its lines, panels once each'
);

select tests.authenticate_as_platform_admin(:'admin');
select throws_ok($$select pg_temp.save('{"body": "x", "panels": ["admin"]}')$$,
  'P0001', 'INVALID_INPUT', 'a title is needed');
select throws_ok($$select pg_temp.save('{"title": "x", "body": " ", "panels": ["admin"]}')$$,
  'P0001', 'INVALID_INPUT', 'and text');
select throws_ok($$select pg_temp.save('{"title": "x", "body": "x", "panels": ["kitchen"]}')$$,
  'P0001', 'INVALID_INPUT', 'panels are admin and worker');
select throws_ok($$select pg_temp.save('{"title": "x", "body": "x", "panels": []}')$$,
  'P0001', 'INVALID_INPUT', 'at least one panel');
select throws_ok($$select pg_temp.save('{"title": "x", "body": "x", "panels": ["admin"],
  "plan_codes": ["growth"], "cities": ["Pune"]}')$$,
  'P0001', 'INVALID_INPUT', 'one kind of audience');
select throws_ok($$select pg_temp.save('{"title": "x", "body": "x", "panels": ["admin"],
  "plan_codes": ["nope"]}')$$, 'P0001', 'INVALID_INPUT', 'plans that exist');
select throws_ok($$select pg_temp.save('{"title": "x", "body": "x", "panels": ["admin"],
  "restaurant_ids": ["00000000-0000-0000-0000-000000000000"]}')$$,
  'P0001', 'INVALID_INPUT', 'restaurants that exist');
select throws_ok($$select pg_temp.save('{"title": "x", "body": "x", "panels": ["admin"],
  "restaurant_ids": ["not-a-uuid"]}')$$, 'P0001', 'INVALID_INPUT', 'restaurant ids are ids');
select throws_ok($$select pg_temp.save('{"title": "x", "body": "x", "panels": ["admin"],
  "title_hi": "नया"}')$$, 'P0001', 'INVALID_INPUT', 'Hindi title and text together');
select throws_ok(format($$select pg_temp.save(jsonb_build_object('title', 'x', 'body', 'x',
  'panels', array['admin'], 'starts_at', %L::timestamptz, 'ends_at', %L::timestamptz))$$,
  now() + interval '1 day', now()), 'P0001', 'INVALID_INPUT', 'it ends after it starts');
select throws_ok($$select pg_temp.save('{"title": "x", "body": "x", "panels": ["admin"], "pinned": true}')$$,
  'P0001', 'INVALID_INPUT', 'unknown keys are refused');
select throws_ok(format($$select pg_temp.save('{"title": "Again"}', %L)$$, :'ended'),
  'P0001', 'ANNOUNCEMENT_ENDED', 'an ended one can''t change');
select throws_ok($$select pg_temp.save('{"title": "x", "body": "x", "panels": ["admin"], "ended": true}')$$,
  'P0001', 'INVALID_INPUT', 'a new one can''t start ended');
select tests.clear_auth();

-- ─── Who sees what, where, when ─────────────────────────────────────────────
select is(pg_temp.seen(:'owner', :'jaipur', 'admin'), array['Jaipur only', 'New menu'],
  'a Jaipur owner''s admin panel: everyone''s and the city''s (any case), nothing scheduled or past');
select is(pg_temp.seen(:'waiter', :'jaipur', 'worker'), array['Jaipur only', 'Kitchen only', 'New menu'],
  'the worker panel shows the worker panel''s');
select is(pg_temp.seen(:'waiter', :'jaipur', 'admin'), '{}'::text[],
  'a waiter has no admin panel');
select is(pg_temp.seen(:'pune_owner', :'pune', 'admin'), array['New menu', 'Starter only'],
  'a Starter restaurant gets the plan''s');
select is(pg_temp.seen(:'other_manager', :'other', 'admin'), array['Chosen', 'New menu'],
  'a chosen restaurant gets its own');
select is(pg_temp.seen(:'owner', :'pune', 'admin'), '{}'::text[],
  'nothing for another restaurant''s panel');
select tests.authenticate_as(:'waiter');
select is(
  (select x ->> 'title_hi' from jsonb_array_elements(public.member_announcements(:'jaipur', 'worker')) as x
   where x ->> 'title' = 'Kitchen only'),
  'रसोई', 'the Hindi text comes along for Hindi logins'
);
select tests.clear_auth();
update public.announcements set starts_at = now() - interval '1 minute' where id = :'tomorrow';
select ok('Tomorrow' = any (pg_temp.seen(:'owner', :'jaipur', 'admin')), 'once it starts, it shows');
update public.announcements set starts_at = now() + interval '1 day' where id = :'tomorrow';

-- ─── Dismissing ─────────────────────────────────────────────────────────────
select id as new_menu from public.announcements where title = 'New menu' \gset
select tests.authenticate_as(:'owner');
select public.member_dismiss_announcement(:'new_menu');
select public.member_dismiss_announcement(:'new_menu');
select throws_ok(format('select public.member_dismiss_announcement(%L)', :'worker_only'),
  'P0001', 'NOT_FOUND', 'one that can''t be dismissed stays');
select throws_ok(format('select public.member_dismiss_announcement(%L)', :'for_other'),
  'P0001', 'NOT_FOUND', 'nor can one for another restaurant be hidden');
select throws_ok(format('select public.member_dismiss_announcement(%L)', :'tomorrow'),
  'P0001', 'NOT_FOUND', 'or one not showing yet');
select tests.clear_auth();
select is(pg_temp.seen(:'owner', :'jaipur', 'admin'), array['Jaipur only'],
  'dismissed: gone for that login, in either panel');
select is(pg_temp.seen(:'waiter', :'jaipur', 'worker'), array['Jaipur only', 'Kitchen only', 'New menu'],
  'still there for the rest of the team');
select tests.authenticate_as_platform_admin(:'admin');
select pg_temp.save('{"dismissible": false}', :'new_menu');
select tests.clear_auth();
select is(pg_temp.seen(:'owner', :'jaipur', 'admin'), array['Jaipur only', 'New menu'],
  'made non-dismissible, it shows again');
select tests.authenticate_as_platform_admin(:'admin');
select pg_temp.save('{"dismissible": true}', :'new_menu');
select tests.clear_auth();

-- ─── Changing and the audit ─────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select pg_temp.save('{"title": "Jaipur and Pune", "cities": ["Jaipur", "Pune"]}', :'for_jaipur');
select is(
  (select jsonb_agg(x.title order by x.title)
   from jsonb_to_recordset(public.platform_list_announcements() -> 'announcements')
     as x(title text, created_by text)
   where x.created_by = 'sa660-admin@example.test'),
  '["Chosen", "Ended early", "Jaipur and Pune", "Kitchen only", "New menu", "Past", "Starter only", "Tomorrow"]'::jsonb,
  'the team''s list has them all'
);
select is(
  (select array[x ->> 'audience', x ->> 'dismissed', x -> 'cities' ->> 1]
   from jsonb_array_elements(public.platform_list_announcements() -> 'announcements') as x
   where x ->> 'title' = 'Jaipur and Pune'),
  array[(select count(*)::text from public.restaurants r
     where r.status = 'active' and lower(btrim(r.city)) in ('jaipur', 'pune')), '0', 'Pune'],
  'its audience counts active restaurants, with the cities as chosen'
);
select is(
  (select x ->> 'audience' from jsonb_array_elements(public.platform_list_announcements() -> 'announcements') as x
   where x ->> 'title' = 'Ended early'),
  null, 'an ended one''s audience isn''t counted'
);
select ok(public.platform_list_announcements() -> 'cities' @> '["Jaipur", "pune"]',
  'the cities to choose from, trimmed');
select tests.clear_auth();
select is(pg_temp.seen(:'pune_owner', :'pune', 'admin'), array['Jaipur and Pune', 'New menu', 'Starter only'],
  'a change of audience shows at once');
select is(
  (select array[a.before ->> 'title', a.after ->> 'title', (a.after ? 'cities')::text,
     (a.restaurant_id is null)::text]
   from public.audit_logs a where a.action = 'announcement.updated' and a.entity_id = :'for_jaipur'),
  array['Jaipur only', 'Jaipur and Pune', 'true', 'true'],
  'a change is audited with what changed, as the platform''s'
);
select is(
  (select count(*) from public.audit_logs a
   where a.action in ('announcement.created', 'announcement.ended') and a.entity_type = 'announcement'
     and a.entity_id in (:'for_starter', :'for_other', :'worker_only', :'tomorrow', :'ended', :'past')),
  7::bigint,
  'each one made, and the one ended, is audited'
);

-- ─── Emails ─────────────────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select is(
  public.platform_save_announcement('{"email": true}', :'for_starter') - 'id',
  '{"email_due": true}'::jsonb,
  'turning email on for a live one: to send now'
);
select tests.clear_auth();
select tests.as_service_role();
select is(
  (select array_agg(d.restaurant_id::text || ' ' || array_to_string(d.recipients, ','))
   from public.announcement_emails_due() d
   where d.restaurant_id in (:'jaipur', :'pune', :'other', :'shut')),
  array[:'pune' || ' sa660puneowner@sa660-pune.test'],
  'due: the plan''s restaurant, to its owner; nothing for one not started'
);
-- The daily run: 03:00 India.
select (((:'today'::date + 1)::timestamp + interval '3 hours') at time zone 'Asia/Kolkata')
  as tomorrow_run \gset
select is(
  (select count(*) from public.announcement_emails_due(
     (:'today'::date + time '23:59') at time zone 'Asia/Kolkata')
   where announcement_id = :'tomorrow'),
  0::bigint,
  'the scheduled one isn''t due the day before'
);
select is(
  (select count(*) from public.announcement_emails_due(:'tomorrow_run')
   where announcement_id = :'tomorrow'),
  1::bigint,
  'on its first day the run sends it, before it starts: its active restaurant'
);
select ok(
  not exists (select 1 from public.announcement_emails_due(:'tomorrow_run')
    where restaurant_id = :'shut'),
  'never a suspended restaurant'
);
select public.announcement_email_sent(:'for_starter', :'pune');
select public.announcement_email_sent(:'for_starter', :'pune');
select is((select count(*) from public.announcement_emails_due() where announcement_id = :'for_starter'),
  0::bigint, 'sent once, then not due again');
select tests.clear_auth();
select tests.authenticate_as_platform_admin(:'admin');
select is(
  (select x ->> 'emailed' from jsonb_array_elements(public.platform_list_announcements() -> 'announcements') as x
   where x ->> 'title' = 'Starter only'),
  '1', 'the list counts restaurants emailed'
);
select tests.clear_auth();
select tests.authenticate_as(:'owner');
select throws_ok('select * from public.announcement_emails_due()', '42501', null,
  'owners can''t list emails');
select tests.clear_auth();

-- ─── Standees: the record by role ───────────────────────────────────────────
insert into public.dining_tables (restaurant_id, label, qr_token)
select :'jaipur', 'T' || n, private.random_base62(16) from generate_series(1, 3) as n;
select tests.authenticate_as_platform_admin(:'sales');
select is(public.platform_save_standees(:'jaipur', '{}'), '{"status": "to_print"}'::jsonb,
  'Sales starts the record: to print');
select is((select (x -> 'standees' ->> 'quantity')::int from public.platform_get_standees(:'jaipur') as x), 3,
  'as many as its active tables');
select is(
  public.platform_save_standees(:'jaipur', jsonb_build_object('printed_on', :'today',
    'vendor', ' PrintCo ', 'quantity', 4)),
  '{"status": "printed"}'::jsonb,
  'a step''s day sets the status'
);
select throws_ok(format($$select public.platform_save_standees(%L, '{"cost_paise": 120000}')$$, :'jaipur'),
  'P0001', 'FORBIDDEN', 'Sales doesn''t set the cost');
select throws_ok(format($$select public.platform_save_standees(%L, '{"quantity": 2, "cost_paise": 1}')$$, :'jaipur'),
  'P0001', 'FORBIDDEN', 'not even with other changes');
select throws_ok(format($$select public.platform_save_standees(%L, jsonb_build_object('delivered_on', %L::date + 1))$$,
  :'jaipur', :'today'), 'P0001', 'INVALID_INPUT', 'no day ahead of today');
select throws_ok(format($$select public.platform_save_standees(%L, jsonb_build_object('dispatched_on', %L::date - 1))$$,
  :'jaipur', :'today'), 'P0001', 'INVALID_INPUT', 'no step before the one it follows');
select throws_ok(format($$select public.platform_save_standees(%L, '{"quantity": 0}')$$, :'jaipur'),
  'P0001', 'INVALID_INPUT', 'at least one');
select throws_ok(format($$select public.platform_save_standees(%L, '{"colour": "red"}')$$, :'jaipur'),
  'P0001', 'INVALID_INPUT', 'unknown keys are refused');
select throws_ok(format($$select public.platform_save_standees(%L, jsonb_build_object(
    'expected_status', 'to_print', 'printed_on', %L))$$, :'jaipur', :'today'),
  'P0001', 'STANDEE_CHANGED', 'a one-click step from a page that has since changed is refused');
select is(public.platform_save_standees(:'jaipur', '{"expected_status": "printed"}'),
  '{"status": "printed"}'::jsonb, 'and goes when it hasn''t');
select is(
  (select array[x -> 'standees' ->> 'vendor', coalesce(x -> 'standees' ->> 'cost_paise', '-'),
     x ->> 'tables_active', coalesce(x ->> 'setup_fee', '-')]
   from public.platform_get_standees(:'jaipur') as x),
  array['PrintCo', '-', '3', '-'],
  'Sales reads the record without a cost; no setup fee yet'
);
select tests.clear_auth();

select tests.authenticate_as_platform_admin(:'finance');
select is(public.platform_save_standees(:'jaipur', '{"cost_paise": 120000}'), '{"status": "printed"}'::jsonb,
  'Finance sets the cost');
select throws_ok(format($$select public.platform_save_standees(%L, '{"quantity": 5}')$$, :'jaipur'),
  'P0001', 'FORBIDDEN', 'but nothing else');
select throws_ok(format($$select public.platform_save_standees(%L, '{"cost_paise": 100}')$$, :'pune'),
  'P0001', 'FORBIDDEN', 'nor makes a record');
select is(
  (select x -> 'standees' ->> 'cost_paise' from public.platform_get_standees(:'jaipur') as x),
  '120000', 'money roles read the cost'
);
select tests.clear_auth();

-- ─── History, the QR step, the tracker ──────────────────────────────────────
select is(
  (select array_agg(a.after ->> 'status' order by a.after ->> 'status')
   from public.audit_logs a where a.entity_type = 'standee' and a.restaurant_id = :'jaipur'
     and a.after ? 'status'),
  array['printed', 'to_print'],
  'each status change is audited'
);
select is(
  (select array[a.before ->> 'cost_paise', a.after ->> 'cost_paise']
   from public.audit_logs a where a.action = 'standee.updated' and a.restaurant_id = :'jaipur'
     and a.after ? 'cost_paise'),
  array[null, '120000'],
  'and the cost, by itself'
);
select tests.authenticate_as(:'owner');
select is((select count(*) from public.audit_logs where entity_type = 'standee'), 0::bigint,
  'the restaurant''s owner doesn''t see them');
select tests.clear_auth();

create function pg_temp.qr(p_restaurant uuid) returns timestamptz
language sql as $$
  select (s ->> 'done_at')::timestamptz
  from jsonb_array_elements(private.restaurant_onboarding(p_restaurant) -> 'steps') as s
  where s ->> 'key' = 'qr';
$$;
select is(pg_temp.qr(:'jaipur'), null, 'printed standees don''t do the QR step');
-- A step as the admin, then the checklist as it reads.
create function pg_temp.step(p_patch jsonb) returns text
language plpgsql as $$
declare
  v text;
begin
  perform tests.authenticate_as_platform_admin(
    (select user_id from public.platform_admins a join auth.users u on u.id = a.user_id
     where u.email = 'sa660-admin@example.test'));
  v := public.platform_save_standees(
    (select id from public.restaurants where slug = 'sa660-jaipur'), p_patch) ->> 'status';
  perform tests.clear_auth();
  return v;
end;
$$;
select pg_temp.step(jsonb_build_object('delivered_on', :'today'));
select is(pg_temp.qr(:'jaipur'), (:'today'::date)::timestamp at time zone 'Asia/Kolkata',
  'delivered: the QR step is done that day');
select pg_temp.step(jsonb_build_object('installed_on', :'today'));
select is(pg_temp.qr(:'jaipur'), (:'today'::date)::timestamp at time zone 'Asia/Kolkata',
  'installed keeps it done');
select is(pg_temp.step('{"delivered_on": null, "installed_on": null}'), 'printed',
  'clearing days takes the status back');
select is(pg_temp.qr(:'jaipur'), null, 'and the QR step is to do again');

select tests.authenticate_as_platform_admin(:'admin');
select public.platform_record_setup_fee(:'pune', '{"amount_paise": 117882, "mode": "upi"}');
select tests.clear_auth();
-- Paid long ago: the longest waiting, first in its tab.
update public.subscription_payments set created_at = '2000-01-01'
where restaurant_id = :'pune' and purpose = 'setup_fee';
-- What the tracker should count, across this database.
select
  count(*) filter (where coalesce(s.status, '') <> 'installed') as open_count,
  count(*) filter (where s.restaurant_id is null) as not_started_count,
  count(*) filter (where s.status = 'printed') as printed_count
from public.restaurants r
left join public.standees s on s.restaurant_id = r.id
where s.restaurant_id is not null
  or (r.status = 'active'
    and exists (select 1 from public.subscription_payments p
      where p.restaurant_id = r.id and p.purpose = 'setup_fee')) \gset
select tests.authenticate_as_platform_admin(:'admin');
select is(
  (select array[x -> 'counts' ->> 'open', x -> 'counts' ->> 'not_started', x -> 'counts' ->> 'printed',
     x -> 'rows' -> 0 ->> 'name', x -> 'rows' -> 0 ->> 'quantity']
   from public.platform_list_standees('not_started') as x),
  array[:'open_count', :'not_started_count', :'printed_count', 'Sa660-Pune', '0'],
  'the tracker: a paid setup fee without standees is not started, with its active tables'
);
select ok(
  (select x -> 'rows' -> 0 ->> 'setup_fee_paid_at' is not null
   from public.platform_list_standees('not_started') as x),
  'with when the fee was paid'
);
select throws_ok($$select public.platform_list_standees('lost')$$, 'P0001', 'INVALID_INPUT',
  'only known tabs');
select tests.clear_auth();

select * from finish();
rollback;
