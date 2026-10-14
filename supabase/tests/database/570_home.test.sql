-- Home: key numbers, Needs attention and snoozes, the activity stream, alerts
-- and the digest's numbers (docs/SUPER_ADMIN_PLAN.md 12e; docs/DECISIONS.md
-- SA-27 to SA-31). Restaurants here are named sa570-*; lists that cover the
-- whole platform are filtered to them, so other data doesn't matter.
begin;
select no_plan();

select tests.create_platform_admin('platform570@admin.test') as admin \gset
select tests.create_platform_admin('platform570b@admin.test') as admin_b \gset
select (now() at time zone 'Asia/Kolkata')::date as today \gset

-- ─── Fixtures: one restaurant per Needs attention rule ──────────────────────
select tests.create_restaurant('sa570-failed') as failed \gset
select tests.create_restaurant('sa570-trial') as trial \gset
select tests.create_restaurant('sa570-manual') as manual \gset
select tests.create_restaurant('sa570-manual-far') as manual_far \gset
select tests.create_restaurant('sa570-idle') as idle \gset
select tests.create_restaurant('sa570-idle-lapsed') as idle_lapsed \gset
select tests.create_restaurant('sa570-slowing') as slowing \gset
select tests.create_restaurant('sa570-signup') as signup \gset
select tests.create_restaurant('sa570-twin') as twin \gset
select tests.create_restaurant('sa570-busy') as busy \gset
select tests.add_member(:'busy', 'owner', 'sa570_owner') as owner \gset

update public.restaurant_subscriptions set status = 'past_due', source = 'razorpay',
  razorpay_subscription_id = 'sub_SA570failed', razorpay_status = 'pending',
  billing_cycle = 'monthly', current_period_end = now() - interval '1 day',
  grace_until = now() + interval '3 days', trial_ends_at = null
  where restaurant_id = :'failed';
update public.restaurant_subscriptions set trial_ends_at = now() + interval '2 days'
  where restaurant_id = :'trial';
update public.restaurant_subscriptions set status = 'active', source = 'manual',
  billing_cycle = 'monthly', current_period_end = now() + interval '5 days', trial_ends_at = null
  where restaurant_id = :'manual';
update public.restaurant_subscriptions set status = 'active', source = 'manual',
  billing_cycle = 'monthly', current_period_end = now() + interval '20 days', trial_ends_at = null
  where restaurant_id = :'manual_far';
update public.restaurant_subscriptions set trial_ends_at = now() - interval '5 days'
  where restaurant_id = :'idle_lapsed';
update public.restaurants set created_at = now() - interval '60 days'
  where id in (:'idle', :'idle_lapsed', :'slowing');
update public.restaurants set created_at = now() - interval '30 days' where id = :'twin';
-- A signup that looks like an older restaurant: the same phone.
update public.restaurants set phone = '9876557001' where id in (:'signup', :'twin');
insert into public.trial_claims (kind, value, restaurant_id) values ('phone', '9876557001', :'signup');

-- p_n accepted orders at p_at, in a session of the restaurant's own.
create function pg_temp.orders(p_restaurant uuid, p_n int, p_at timestamptz)
returns void
language plpgsql
as $$
declare
  v_session uuid;
begin
  insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
  values (p_restaurant, 'T' || p_n, upper(substr(md5(p_restaurant::text || p_n), 1, 16)), p_n)
  returning id into v_session;
  insert into public.table_sessions (
    restaurant_id, dining_table_id, table_label_snapshot, status, is_approved, opened_at
  )
  values (p_restaurant, v_session, 'T' || p_n, 'open', true, p_at)
  returning id into v_session;
  insert into public.orders (
    restaurant_id, session_id, round_number, status, placed_via, idempotency_key, created_at
  )
  select p_restaurant, v_session, n, 'accepted', 'staff', 'sa570-' || gen_random_uuid(), p_at
  from generate_series(1, p_n) as n;
end;
$$;

select pg_temp.orders(:'idle', 3, now() - interval '10 days');
select pg_temp.orders(:'idle_lapsed', 3, now() - interval '10 days');
select pg_temp.orders(:'slowing', 20, now() - interval '14 days');
select pg_temp.orders(:'slowing', 2, now() - interval '2 days');
-- An accepted order and a bill of 32000 now, a payment, a reminder.
select tests.create_full_fixture(:'busy');

insert into public.site_leads (name, restaurant_name, city, phone)
values ('Sa570 Lead', 'Sa570 Cafe', 'Indore', '9876557002')
returning id as lead \gset
insert into public.webhook_events (provider, event_id, event_type, payload, processing_error)
values ('razorpay', 'evt_sa570', 'sa570.test', '{}', 'Could not apply it')
returning id as webhook \gset
insert into public.cron_runs (job, step, started_at, finished_at, ok, detail) values
  ('sa570', 'broken', now() - interval '1 hour', now() - interval '1 hour', false, 'boom'),
  ('sa570', 'fixed', now() - interval '2 hours', now() - interval '2 hours', false, 'boom'),
  ('sa570', 'fixed', now() - interval '1 hour', now() - interval '1 hour', true, null),
  ('sa570', 'old', now() - interval '3 days', now() - interval '3 days', false, 'boom');

-- ─── Needs attention ────────────────────────────────────────────────────────
-- Every item (no limit), with p_admin's snoozes.
create function pg_temp.attention(p_admin uuid default null)
returns jsonb language sql as $$
  select private.attention(p_admin, true, true, true, 10000);
$$;
-- This file's items in a group: restaurants by slug, the rest by what names them.
create function pg_temp.mine(p jsonb, p_group text)
returns text[] language sql as $$
  select coalesce(array_agg(x order by x), '{}')
  from (
    select lower(coalesce(
      i -> 'data' ->> 'slug', i -> 'data' ->> 'name', i -> 'data' ->> 'event_type',
      (i -> 'data' ->> 'job') || ':' || (i -> 'data' ->> 'step')
    )) as x
    from jsonb_array_elements(p -> 'groups') as g
    cross join jsonb_array_elements(g -> 'items') as i
    where g ->> 'group' = p_group
  ) as s
  where x like 'sa570%';
$$;
create function pg_temp.item(p jsonb, p_key text)
returns jsonb language sql as $$
  select i -> 'data'
  from jsonb_array_elements(p -> 'groups') as g
  cross join jsonb_array_elements(g -> 'items') as i
  where i ->> 'key' = p_key;
$$;

select pg_temp.attention() as att \gset

select is(pg_temp.mine(:'att', 'payment_failed'), array['sa570-failed'],
  'payment failed: retrying, in grace');
select is(pg_temp.mine(:'att', 'trial_ending'), array['sa570-trial'],
  'a trial ending within 3 days with no autopay');
select is(pg_temp.mine(:'att', 'needs_payment'), array['sa570-manual'],
  'a manual payer due within 7 days (not one due in 20)');
select is(pg_temp.mine(:'att', 'new_leads'), array['sa570 lead'], 'a lead from the last day');
select is(pg_temp.mine(:'att', 'inactive'), array['sa570-idle'],
  'inactive, with full access (a lapsed one is left to Dues)');
select is(pg_temp.mine(:'att', 'slowing'), array['sa570-slowing'], 'slowing');
select is(pg_temp.mine(:'att', 'duplicates'), array['sa570-signup'],
  'a signup of the last week that looks like another restaurant');
select is(pg_temp.mine(:'att', 'webhooks'), array['sa570.test'], 'a webhook that failed');
select is(pg_temp.mine(:'att', 'cron'), array['sa570:broken'],
  'a step whose latest run failed (not one that ran fine since, nor an old one)');
select is(
  (select array_agg(g ->> 'group' order by n) from jsonb_array_elements((:'att'::jsonb) -> 'groups')
     with ordinality as x(g, n)),
  (select array_agg(g order by n) from unnest(array['payment_failed', 'trial_ending',
     'needs_payment', 'new_leads', 'inactive', 'slowing', 'duplicates', 'webhooks', 'cron'])
     with ordinality as x(g, n)
   where g in (select e ->> 'group' from jsonb_array_elements((:'att'::jsonb) -> 'groups') as e)),
  'groups in the plan''s order'
);
select ok(
  (select bool_and((g ->> 'count')::int = jsonb_array_length(g -> 'items'))
   from jsonb_array_elements((:'att'::jsonb) -> 'groups') as g),
  'each group counts its items'
);
select is(((:'att'::jsonb) ->> 'total')::int,
  (select sum((g ->> 'count')::int)::int from jsonb_array_elements((:'att'::jsonb) -> 'groups') as g),
  'the total is the sum of the groups');
select is(pg_temp.item(:'att', 'cron:sa570:broken') ->> 'detail', 'boom', 'a failed step says why');
select is(
  jsonb_array_length(pg_temp.item(:'att', 'duplicates:' || :'signup') -> 'matches'), 1,
  'and a possible duplicate names what it looks like'
);

-- A money row reads like the Dues page's, so the same actions and messages work.
select tests.authenticate_as_platform_admin(:'admin');
select (public.platform_list_dues('{"bucket": "payment_failed", "q": "sa570-"}') -> 'rows' -> 0)
  - 'last_reminder_kind' - 'last_reminder_at' as dues_row \gset
select public.platform_needs_attention() as att_page \gset
select tests.clear_auth();
select is(
  pg_temp.item(:'att', 'payment_failed:' || :'failed')
    - 'last_reminder_kind' - 'last_reminder_at' - 'cancel_at_period_end',
  :'dues_row'::jsonb,
  'a payment failed item has the Dues row''s fields and values'
);
select ok(
  (select bool_and(jsonb_array_length(g -> 'items') <= 5)
   from jsonb_array_elements((:'att_page'::jsonb) -> 'groups') as g),
  'the page gets at most 5 items a group'
);
select is(((:'att_page'::jsonb) ->> 'total')::int, ((:'att'::jsonb) ->> 'total')::int,
  'with every item counted');

-- ─── Snoozes ────────────────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select ok(
  public.platform_snooze('payment_failed:' || :'failed', 1)
    between now() + interval '23 hours' and now() + interval '25 hours',
  'snoozed for a day'
);
select ok(public.platform_snooze('cron:sa570:broken', 7) > now() + interval '6 days',
  'or a week');
select throws_ok(format('select public.platform_snooze(%L, 2)', 'trial_ending:' || :'trial'),
  'P0001', 'INVALID_INPUT', '1, 3 or 7 days only');
select throws_ok($$select public.platform_snooze('orders:123', 1)$$,
  'P0001', 'INVALID_INPUT', 'only Needs attention items');
select throws_ok($$select public.platform_snooze(null, 1)$$,
  'P0001', 'INVALID_INPUT', 'an item is needed');
select is((select count(*)::int from public.platform_snoozes), 2, 'an admin reads their own snoozes');
select tests.authenticate_as_platform_admin(:'admin_b');
select is((select count(*)::int from public.platform_snoozes), 0, 'and nobody else''s');
select tests.clear_auth();

select is(pg_temp.mine(pg_temp.attention(:'admin'), 'payment_failed'), '{}'::text[],
  'a snoozed item is gone for whoever snoozed it');
select is(pg_temp.mine(pg_temp.attention(:'admin'), 'cron'), '{}'::text[], 'any kind of item');
select is(pg_temp.mine(pg_temp.attention(:'admin_b'), 'payment_failed'), array['sa570-failed'],
  'not for the rest of the team');
select is(pg_temp.mine(pg_temp.attention(), 'payment_failed'), array['sa570-failed'],
  'nor in the digest');
update public.platform_snoozes set until = now() - interval '1 second'
  where admin_id = :'admin' and item_key = 'payment_failed:' || :'failed';
select is(pg_temp.mine(pg_temp.attention(:'admin'), 'payment_failed'), array['sa570-failed'],
  'it comes back when the snooze ends');
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_snooze('payment_failed:' || :'failed', 3);
select tests.clear_auth();
select is(
  (select array_agg(item_key order by item_key) from public.platform_snoozes where admin_id = :'admin'),
  array['cron:sa570:broken', 'payment_failed:' || :'failed'],
  'snoozing again replaces the old snooze'
);

-- ─── Home: key numbers and charts ───────────────────────────────────────────
-- The month-ago snapshot MRR is compared with today's.
insert into public.metrics_subscription_daily (day, restaurant_id, state, mrr_paise)
values ((:'today'::date - interval '1 month')::date, :'busy', 'paid', 12345);
insert into public.subscription_payments (
  restaurant_id, source, amount_paise, manual_mode, purpose, recorded_by, created_at
)
values (:'busy', 'manual', 118000, 'upi', 'setup_fee', :'admin', now() - interval '1 minute');

select tests.authenticate_as_platform_admin(:'admin');
select public.platform_home('today') as h_today \gset
select public.platform_home('month') as h_month \gset
select public.platform_overview() as overview \gset
select throws_ok($$select public.platform_home('week')$$, 'P0001', 'INVALID_INPUT',
  'today or this month');
select tests.clear_auth();

select is(
  array[(:'h_today'::jsonb) -> 'restaurants' -> 'total', (:'h_today'::jsonb) -> 'restaurants' -> 'paid',
        (:'h_today'::jsonb) -> 'restaurants' -> 'trial',
        (:'h_today'::jsonb) -> 'restaurants' -> 'payment_failed', (:'h_today'::jsonb) -> 'mrr_paise'],
  array[(:'overview'::jsonb) -> 'restaurants' -> 'total', (:'overview'::jsonb) -> 'restaurants' -> 'active',
        (:'overview'::jsonb) -> 'restaurants' -> 'trialing',
        (:'overview'::jsonb) -> 'restaurants' -> 'past_due', (:'overview'::jsonb) -> 'mrr_paise'],
  'counts and MRR agree with the overview''s shared rules'
);
select is(((:'h_today'::jsonb) ->> 'mrr_month_ago_paise')::bigint,
  (select sum(mrr_paise)::bigint from public.metrics_subscription_daily
   where day = (:'today'::date - interval '1 month')::date),
  'MRR a month ago is that night''s snapshot');
select is((:'h_today'::jsonb) -> 'collected',
  (select jsonb_build_object('base_paise', coalesce(sum(base_paise), 0),
     'gst_paise', coalesce(sum(gst_paise), 0), 'count', count(*))
   from public.subscription_payments
   where created_at >= :'today'::date::timestamp at time zone 'Asia/Kolkata'),
  'collected today, before GST and the GST apart');
select is((:'h_month'::jsonb) -> 'collected',
  (select jsonb_build_object('base_paise', coalesce(sum(base_paise), 0),
     'gst_paise', coalesce(sum(gst_paise), 0), 'count', count(*))
   from public.subscription_payments
   where created_at >= date_trunc('month', :'today'::date)::timestamp at time zone 'Asia/Kolkata'),
  'and this month');
select is(((:'h_today'::jsonb) ->> 'open_tables')::int,
  (select count(*)::int from public.table_sessions s join public.restaurants r on r.id = s.restaurant_id
   where s.status = 'open' and r.status = 'active'),
  'open tables right now');
select ok(((:'h_today'::jsonb) ->> 'orders')::int >= 1 and ((:'h_today'::jsonb) ->> 'gmv_paise')::bigint >= 32000,
  'today''s orders and GMV include a bill made now');
select is(
  (select array[count(*), min((e ->> 'day')::date) - :'today'::date, max((e ->> 'day')::date) - :'today'::date]
   from jsonb_array_elements((:'h_today'::jsonb) -> 'charts' -> 'usage') as e),
  array[30::bigint, -30, -1],
  'the usage chart has the last 30 finished days'
);
select is(
  (select e from jsonb_array_elements((:'h_today'::jsonb) -> 'charts' -> 'mrr') as e
   order by e ->> 'day' desc limit 1),
  jsonb_build_object('day', :'today'::date, 'mrr_paise', (:'h_today'::jsonb) -> 'mrr_paise'),
  'the MRR chart ends with today''s MRR'
);
select is(
  (select (e ->> 'mrr_paise')::bigint from jsonb_array_elements((:'h_today'::jsonb) -> 'charts' -> 'mrr') as e
   where (e ->> 'day')::date = (:'today'::date - interval '1 month')::date),
  ((:'h_today'::jsonb) ->> 'mrr_month_ago_paise')::bigint,
  'and has each night''s'
);
select is(
  (select e from jsonb_array_elements((:'h_today'::jsonb) -> 'charts' -> 'new_restaurants') as e
   order by e ->> 'week' desc limit 1),
  (select jsonb_build_object(
     'week', date_trunc('week', :'today'::date)::date,
     'signup', count(*) filter (where exists (select 1 from public.trial_claims c where c.restaurant_id = r.id)),
     'team', count(*) filter (where not exists (select 1 from public.trial_claims c where c.restaurant_id = r.id)))
   from public.restaurants r
   where r.created_at >= date_trunc('week', :'today'::date::timestamp) at time zone 'Asia/Kolkata'),
  'new restaurants this week, signups and the team''s apart'
);
select is(jsonb_array_length((:'h_today'::jsonb) -> 'charts' -> 'new_restaurants'), 12, 'for 12 weeks');

-- Usage: stored days up to the day before the last finished one; that day and
-- today counted live, whatever was stored for them.
select private.business_date(now(), 'Asia/Kolkata', 4) as bd \gset
insert into public.metrics_usage_daily (restaurant_id, business_day, orders, gmv_paise) values
  (:'busy', :'bd'::date - 3, 5, 5000),
  (:'busy', :'bd'::date - 1, 99, 99900);
select is(
  (select jsonb_agg(jsonb_build_object('day', u.business_day, 'today', u.today,
     'orders', u.orders, 'gmv', u.gmv_paise) order by u.business_day)
   from private.platform_usage(:'bd'::date - 5, :'bd'::date) as u
   where u.restaurant_id = :'busy'),
  jsonb_build_array(
    jsonb_build_object('day', :'bd'::date - 3, 'today', false, 'orders', 5, 'gmv', 5000),
    jsonb_build_object('day', :'bd'::date - 1, 'today', false, 'orders', 0, 'gmv', 0),
    jsonb_build_object('day', :'bd'::date, 'today', true, 'orders', 1, 'gmv', 32000)
  ),
  'stored days, then the last finished day and today counted live'
);

-- ─── Activity ───────────────────────────────────────────────────────────────
insert into public.audit_logs (
  restaurant_id, actor_type, actor_label, action, entity_type, before, after, created_at
) values
  (:'failed', 'system', 'Razorpay', 'subscription.razorpay_updated', 'restaurant_subscription',
   '{"status": "active"}', '{"status": "past_due", "grace_until": "2026-10-20T00:00:00Z"}',
   now() - interval '2 minutes'),
  (:'failed', 'system', 'Razorpay', 'subscription.razorpay_updated', 'restaurant_subscription',
   '{"status": "past_due"}', '{"status": "past_due"}', now() - interval '1 minute');
insert into public.audit_logs (
  restaurant_id, actor_type, actor_user_id, actor_label, action, entity_type, reason, created_at
) values (:'trial', 'platform_admin', :'admin', 'Platform admin', 'subscription.trial_extended',
  'restaurant_subscription', 'Asked for a week', now() - interval '3 minutes');
insert into public.metrics_subscription_daily (day, restaurant_id, state) values
  (:'today'::date - 3, :'idle_lapsed', 'trial'),
  (:'today'::date - 2, :'idle_lapsed', 'read_only'),
  (:'today'::date - 1, :'idle_lapsed', 'read_only');
insert into public.menu_imports (restaurant_id, source, status, page_count, completed_at, imported_counts)
values (:'busy', 'csv', 'imported', 0, now() - interval '4 minutes', '{"items": 12}');

create function pg_temp.kinds(p jsonb)
returns text[] language sql as $$
  select coalesce(array_agg(distinct e ->> 'kind' order by e ->> 'kind'), '{}')
  from jsonb_array_elements(p -> 'items') as e;
$$;
create function pg_temp.keys(p jsonb)
returns text[] language sql as $$
  select coalesce(array_agg(e ->> 'key' order by n), '{}')
  from jsonb_array_elements(p -> 'items') with ordinality as x(e, n);
$$;

select tests.authenticate_as_platform_admin(:'admin');
select public.platform_activity(:'busy') as a_busy \gset
select public.platform_activity(:'busy', null, null, 2) as a_page1 \gset
select public.platform_activity(:'busy', null, (:'a_page1'::jsonb) ->> 'next', 2) as a_page2 \gset
select public.platform_activity(:'failed', array['payment_failed']) as a_failed \gset
select public.platform_activity(:'idle_lapsed', array['lapsed']) as a_lapsed \gset
select public.platform_activity(:'trial', array['team']) as a_team \gset
select public.platform_activity(null, array['lead', 'signup'], null, 100) as a_new \gset
select throws_ok($$select public.platform_activity(null, array['orders'])$$,
  'P0001', 'INVALID_INPUT', 'known kinds only');
select throws_ok($$select public.platform_activity(null, null, 'soon|x')$$,
  'P0001', 'INVALID_INPUT', 'a cursor from the page before');
select throws_ok($$select public.platform_activity(null, null, '2026-10-14T00:00:00Z')$$,
  'P0001', 'INVALID_INPUT', 'with its key');
select throws_ok($$select public.platform_activity(null, null, null, 101)$$,
  'P0001', 'INVALID_INPUT', 'up to 100 at a time');
select tests.clear_auth();

select is(pg_temp.kinds(:'a_busy'), array['menu_import', 'onboarded', 'payment', 'reminder'],
  'one restaurant''s stream: made by the team, payments, reminders, imports; no leads');
select is(
  (select e - 'key' - 'at' from jsonb_array_elements((:'a_busy'::jsonb) -> 'items') as e
   where e -> 'data' ->> 'purpose' = 'setup_fee'),
  jsonb_build_object('kind', 'payment', 'restaurant_id', :'busy', 'restaurant_name', 'Sa570-Busy',
    'actor', 'platform570@admin.test',
    'data', jsonb_build_object('purpose', 'setup_fee', 'method', 'upi',
      'base_paise', 100000, 'gst_paise', 18000)),
  'a payment says who recorded it, before GST and the GST apart'
);
select is(
  (select e -> 'data' from jsonb_array_elements((:'a_busy'::jsonb) -> 'items') as e
   where e ->> 'kind' = 'menu_import'),
  jsonb_build_object('import_id', (select id from public.menu_imports where restaurant_id = :'busy'
     and status = 'imported'), 'status', 'imported', 'source', 'csv', 'counts', '{"items": 12}'::jsonb),
  'a finished menu import (a discarded one is left out)'
);
select is(pg_temp.keys(:'a_page1') || pg_temp.keys(:'a_page2'), (pg_temp.keys(:'a_busy'))[1:4],
  'pages follow on from the cursor, ties broken by key');
select ok(
  (select bool_and(((e ->> 'at')::timestamptz, e ->> 'key') >= (lead_at, lead_key))
   from (
     select e, (lead(e ->> 'at') over (order by n))::timestamptz as lead_at,
       lead(e ->> 'key') over (order by n) as lead_key
     from jsonb_array_elements((:'a_busy'::jsonb) -> 'items') with ordinality as x(e, n)
   ) as s
   where lead_at is not null),
  'newest first'
);
select is(
  (select array_agg(e -> 'data' ->> 'grace_until') from jsonb_array_elements((:'a_failed'::jsonb) -> 'items') as e),
  array['2026-10-20T00:00:00Z'],
  'a payment failed when Razorpay moved it into retrying, once'
);
select is((:'a_lapsed'::jsonb) -> 'items' -> 0 -> 'data',
  jsonb_build_object('day', :'today'::date - 2, 'was', 'trial'),
  'lapsed from the snapshots');
select is(((:'a_lapsed'::jsonb) -> 'items' -> 0 ->> 'at')::timestamptz,
  (:'today'::date - 1)::timestamp at time zone 'Asia/Kolkata',
  'at the end of that India day');
select is(jsonb_array_length((:'a_lapsed'::jsonb) -> 'items'), 1, 'once');
select is((:'a_team'::jsonb) -> 'items' -> 0 -> 'data',
  '{"action": "subscription.trial_extended", "reason": "Asked for a week"}'::jsonb,
  'what the team did, with the reason');
select is((:'a_team'::jsonb) -> 'items' -> 0 ->> 'actor', 'platform570@admin.test', 'and who');
select ok(
  exists (select 1 from jsonb_array_elements((:'a_new'::jsonb) -> 'items') as e
    where e ->> 'kind' = 'lead' and e -> 'data' ->> 'name' = 'Sa570 Lead' and e -> 'restaurant_id' = 'null')
  and exists (select 1 from jsonb_array_elements((:'a_new'::jsonb) -> 'items') as e
    where e ->> 'kind' = 'signup' and e ->> 'restaurant_id' = :'signup'),
  'leads and signups across the platform'
);
select is(pg_temp.kinds(:'a_new'), array['lead', 'signup'], 'only the kinds asked for');

-- ─── Alerts ─────────────────────────────────────────────────────────────────
update public.platform_admins set alerts_seen_at = now() - interval '90 seconds'
  where user_id = :'admin';
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_alerts() as alerts \gset
select public.platform_activity(null, array['signup', 'payment', 'payment_failed', 'lead'], null, 100)
  as alert_kinds \gset
select public.platform_needs_attention() -> 'total' as attention_total \gset
select public.platform_mark_alerts_seen();
select public.platform_alerts() as alerts_after \gset
select tests.clear_auth();

select is(((:'alerts'::jsonb) ->> 'unread')::int,
  (select count(*)::int from jsonb_array_elements((:'alert_kinds'::jsonb) -> 'items') as e
   where (e ->> 'at')::timestamptz > now() - interval '90 seconds'),
  'unread: signups, payments, failed payments and leads since last seen');
select ok(((:'alerts'::jsonb) ->> 'unread')::int >= 3, 'this file''s signup, payments and lead');
select ok(
  (select bool_and(e ->> 'kind' in ('signup', 'payment', 'payment_failed', 'lead'))
     and count(*) <= 10
   from jsonb_array_elements((:'alerts'::jsonb) -> 'items') as e),
  'the latest 10, of those kinds'
);
select is((:'alerts'::jsonb) -> 'attention', :'attention_total'::jsonb,
  'with the Needs attention count for the sidebar');
select is(((:'alerts_after'::jsonb) ->> 'unread')::int, 0, 'opening them marks them seen');
select is(((:'alerts_after'::jsonb) ->> 'seen_at')::timestamptz, now(), 'now');

-- ─── Digest ─────────────────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select throws_ok($$select public.platform_digest()$$, '42501', null,
  'the digest is for the scheduled job only');
select tests.clear_auth();
select tests.as_service_role();
select public.platform_digest(:'today') as dg \gset
select public.platform_digest() ->> 'day' as dg_day \gset
select tests.clear_auth();

select is(:'dg_day'::date, :'today'::date - 1, 'yesterday by default');
select is((:'dg'::jsonb) -> 'collected',
  (select jsonb_build_object('base_paise', coalesce(sum(base_paise), 0),
     'gst_paise', coalesce(sum(gst_paise), 0), 'count', count(*))
   from public.subscription_payments
   where created_at >= :'today'::date::timestamp at time zone 'Asia/Kolkata'
     and created_at < (:'today'::date + 1)::timestamp at time zone 'Asia/Kolkata'),
  'collected that day');
select ok(((:'dg'::jsonb) ->> 'signups')::int >= 1 and ((:'dg'::jsonb) ->> 'leads')::int >= 1,
  'signups and leads that day');
select ok((:'dg'::jsonb) -> 'recipients' ? 'platform570@admin.test', 'sent to every platform admin');
select ok(
  exists (select 1 from jsonb_array_elements((:'dg'::jsonb) -> 'attention' -> 'groups') as g
    where g ->> 'group' = 'payment_failed' and (g ->> 'count')::int >= 1),
  'with today''s Needs attention counts, nobody''s snoozes'
);
select ok((:'dg'::jsonb) -> 'states' ?& array['mrr_paise', 'paid', 'trial', 'payment_failed']
  and (:'dg'::jsonb) -> 'usage' ?& array['gmv_paise', 'orders'], 'and the day''s key numbers');

-- ─── Resolved items go by themselves ────────────────────────────────────────
update public.restaurant_subscriptions set status = 'active', source = 'manual',
  grace_until = null, razorpay_status = null, razorpay_subscription_id = null,
  current_period_end = now() + interval '60 days'
  where restaurant_id = :'failed';
delete from public.webhook_events where id = :'webhook';
select pg_temp.attention(:'admin_b') as att_after \gset
select is(pg_temp.mine(:'att_after', 'payment_failed'), '{}'::text[], 'paid: no longer listed');
select is(pg_temp.mine(:'att_after', 'webhooks'), '{}'::text[], 'a webhook run again: gone');

-- ─── Who may ────────────────────────────────────────────────────────────────
select tests.authenticate_as(:'owner');
select throws_ok($$select public.platform_home()$$, 'P0001', 'FORBIDDEN', 'not a restaurant owner');
select throws_ok($$select public.platform_needs_attention()$$, 'P0001', 'FORBIDDEN', 'attention');
select throws_ok($$select public.platform_activity()$$, 'P0001', 'FORBIDDEN', 'activity');
select throws_ok($$select public.platform_alerts()$$, 'P0001', 'FORBIDDEN', 'alerts');
select throws_ok($$select public.platform_mark_alerts_seen()$$, 'P0001', 'FORBIDDEN', 'seen');
select throws_ok($$select public.platform_snooze('cron:x', 1)$$, 'P0001', 'FORBIDDEN', 'snooze');
select tests.authenticate_as_platform_admin(:'admin', 'aal1');
select throws_ok($$select public.platform_home()$$, 'P0001', 'MFA_REQUIRED', 'needs the second factor');
select throws_ok($$select public.platform_needs_attention()$$, 'P0001', 'MFA_REQUIRED', 'attention too');
select throws_ok($$select public.platform_activity()$$, 'P0001', 'MFA_REQUIRED', 'activity too');
select throws_ok($$select public.platform_alerts()$$, 'P0001', 'MFA_REQUIRED', 'alerts too');
select throws_ok($$select public.platform_snooze('cron:x', 1)$$, 'P0001', 'MFA_REQUIRED', 'snoozes too');
select tests.as_anon();
select throws_ok($$select public.platform_home()$$, '42501', null, 'never anonymous');
select throws_ok($$select public.platform_alerts()$$, '42501', null, 'alerts neither');
select tests.clear_auth();

select * from finish();
rollback;
