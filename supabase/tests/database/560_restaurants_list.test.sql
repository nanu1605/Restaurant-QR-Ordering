-- Restaurant health, the restaurants list, saved views and search
-- (docs/SUPER_ADMIN_PLAN.md 12d; docs/DECISIONS.md SA-22 to SA-25).
-- Restaurants here are named sa560-* and lists are searched for that.
begin;
select no_plan();

select tests.create_platform_admin('platform560@admin.test') as admin \gset
select tests.create_platform_admin('platform560b@admin.test') as admin_b \gset

-- ─── Health fixtures, one per rule (defaults: 14 setup days, 7 inactive,
-- slowing under 50% of the weekly average when the 4 weeks before had 10+) ──
select tests.create_restaurant('sa560-new') as new \gset
select tests.create_restaurant('sa560-never') as never \gset
select tests.create_restaurant('sa560-idle') as idle \gset
select tests.create_restaurant('sa560-slowing') as slowing \gset
select tests.create_restaurant('sa560-busy') as busy \gset
select tests.create_restaurant('sa560-small') as small \gset
update public.restaurants set created_at = now() - interval '20 days' where id = :'never';
update public.restaurants set created_at = now() - interval '60 days'
  where id in (:'idle', :'slowing', :'busy', :'small');

-- p_n orders of one status at p_at, in a session of the restaurant's own.
create function pg_temp.orders(
  p_restaurant uuid, p_n int, p_at timestamptz,
  p_status public.order_status default 'accepted'
)
returns void
language plpgsql
as $$
declare
  v_session uuid;
  v_round int;
begin
  select s.id into v_session from public.table_sessions s where s.restaurant_id = p_restaurant;
  if v_session is null then
    insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
    values (p_restaurant, '1', upper(substr(md5(p_restaurant::text), 1, 16)), 1);
    insert into public.table_sessions (
      restaurant_id, dining_table_id, table_label_snapshot, status, is_approved, opened_at
    )
    select p_restaurant, t.id, t.label, 'open', true, now() - interval '60 days'
    from public.dining_tables t where t.restaurant_id = p_restaurant
    returning id into v_session;
  end if;
  select coalesce(max(o.round_number), 0) into v_round
  from public.orders o where o.session_id = v_session;
  insert into public.orders (
    restaurant_id, session_id, round_number, status, placed_via, idempotency_key, created_at
  )
  select p_restaurant, v_session, v_round + n, p_status, 'staff', 'sa560-' || gen_random_uuid(), p_at
  from generate_series(1, p_n) as n;
end;
$$;

select pg_temp.orders(:'never', 2, now() - interval '2 days', 'rejected');
select pg_temp.orders(:'idle', 3, now() - interval '10 days');
select pg_temp.orders(:'slowing', 20, now() - interval '14 days');
select pg_temp.orders(:'slowing', 2, now() - interval '2 days');
select pg_temp.orders(:'busy', 20, now() - interval '14 days');
select pg_temp.orders(:'busy', 4, now() - interval '2 days');
select pg_temp.orders(:'small', 4, now() - interval '14 days');
select pg_temp.orders(:'small', 1, now() - interval '1 day');

create function pg_temp.health(p_restaurant uuid, p_at timestamptz default now())
returns text language sql as $$
  select private.restaurant_health(r.id, r.created_at, p_at)
  from public.restaurants r where r.id = p_restaurant;
$$;

select is(
  array[pg_temp.health(:'new'), pg_temp.health(:'never'), pg_temp.health(:'idle'),
        pg_temp.health(:'slowing'), pg_temp.health(:'busy'), pg_temp.health(:'small')],
  array['setting_up', 'never_started', 'inactive', 'slowing', 'active', 'active'],
  'health: setting up, never started (rejected orders don''t count), inactive, slowing, active; '
    || 'too few orders before is never slowing'
);
select is(pg_temp.health(:'new', now() + interval '15 days'), 'never_started',
  'a new restaurant with no order after the setup days has never started');
select is(pg_temp.health(:'busy', now() - interval '20 days'), 'never_started',
  'health at a past moment counts only the orders before it');

update public.platform_settings set health_inactive_days = 12, health_slowing_percent = 30 where id = 1;
select is(array[pg_temp.health(:'idle'), pg_temp.health(:'slowing')], array['active', 'active'],
  'the thresholds are platform settings');
update public.platform_settings set health_slowing_min_orders = 25, health_slowing_percent = 50
  where id = 1;
select is(pg_temp.health(:'slowing'), 'active', 'too few orders before to call it slowing');
update public.platform_settings
  set health_inactive_days = 7, health_slowing_percent = 50, health_slowing_min_orders = 10
  where id = 1;

-- ─── Last active: an accepted order, a bill or a sign-in ────────────────────
select tests.add_member(:'new', 'owner', 'n_owner') as n_owner \gset
update auth.users set last_sign_in_at = now() - interval '1 hour' where id = :'n_owner';
select is(private.restaurant_last_active(:'new'), now() - interval '1 hour', 'a sign-in counts');
select is(private.restaurant_last_active(:'busy'), now() - interval '2 days',
  'the latest accepted order counts');
select is(private.restaurant_last_active(:'never'), null, 'rejected orders don''t count');
select tests.create_restaurant('sa560-billed') as billed \gset
select tests.create_full_fixture(:'billed');
-- Its order turned down, so the bill is all it has done.
update public.orders set status = 'rejected' where restaurant_id = :'billed';
update public.bills set generated_at = now() - interval '1 day' where restaurant_id = :'billed';
select is(private.restaurant_last_active(:'billed'), now() - interval '1 day', 'a bill counts');

-- ─── List fixtures ──────────────────────────────────────────────────────────
update public.restaurants set city = 'Indore', state = 'Madhya Pradesh' where id = :'idle';
update public.restaurants set acquisition_channel = 'referral' where id = :'never';
update public.restaurants set phone = '+91 98765-56001', gstin = '23ABCDE1234F1Z5',
  fssai_license = '12345678901234' where id = :'busy';
update public.restaurant_subscriptions set status = 'active', source = 'manual',
  billing_cycle = 'monthly', trial_ends_at = null,
  current_period_end = '2030-01-01T00:00:00+05:30', razorpay_subscription_id = 'sub_SA560find'
  where restaurant_id = :'busy';
update public.restaurant_subscriptions set status = 'past_due', source = 'razorpay',
  razorpay_status = 'pending', billing_cycle = 'monthly', trial_ends_at = null,
  current_period_end = now() - interval '1 day', grace_until = now() + interval '3 days'
  where restaurant_id = :'slowing';
select tests.set_plan(:'small', 'starter');
insert into public.subscription_payments (
  restaurant_id, source, amount_paise, razorpay_payment_id, period_start, period_end
)
values (:'busy', 'razorpay', 106082, 'pay_SA560find', now() - interval '20 days',
        now() + interval '10 days');
insert into public.metrics_usage_daily (restaurant_id, business_day, orders, gmv_paise)
select r.id, private.business_date(now(), r.timezone, r.business_day_start_hour) - d.ago, d.orders,
       d.gmv
from public.restaurants r
join (values (:'busy'::uuid, 2, 5, 50000), (:'idle'::uuid, 3, 1, 20000),
             (:'idle'::uuid, 40, 9, 70000)) as d(id, ago, orders, gmv) on d.id = r.id;

create function pg_temp.list(p_filters jsonb default '{}')
returns jsonb language sql as $$
  select public.platform_list_restaurants(jsonb_build_object('q', 'sa560-') || p_filters);
$$;
create function pg_temp.slugs(p_list jsonb)
returns text[] language sql as $$
  select coalesce(array_agg(r ->> 'slug' order by n), '{}')
  from jsonb_array_elements(p_list -> 'rows') with ordinality as x(r, n);
$$;
create function pg_temp.sorted(p_list jsonb)
returns text[] language sql as $$
  select coalesce(array_agg(s order by s), '{}') from unnest(pg_temp.slugs(p_list)) as s;
$$;

select tests.authenticate_as_platform_admin(:'admin');
select pg_temp.list() as l_all \gset
select pg_temp.list('{"health": "slowing"}') as l_slowing \gset
select pg_temp.list('{"health": "inactive"}') as l_inactive \gset
select pg_temp.list('{"health": "setting_up"}') as l_setting_up \gset
select pg_temp.list('{"state": "payment_failed"}') as l_failed \gset
select pg_temp.list('{"state": "paid"}') as l_paid \gset
select pg_temp.list('{"plan": "starter"}') as l_starter \gset
select pg_temp.list('{"city": "indore"}') as l_city \gset
select pg_temp.list('{"region": "madhya pradesh"}') as l_region \gset
select pg_temp.list('{"channel": "referral"}') as l_referral \gset
select pg_temp.list('{"channel": "unknown"}') as l_unknown \gset
select pg_temp.list(jsonb_build_object('from', (now() at time zone 'Asia/Kolkata')::date)) as l_today \gset
select pg_temp.list('{"paid_from": "2029-12-31", "paid_to": "2029-12-31"}') as l_paid_till \gset
select pg_temp.list('{"paid_from": "2030-01-01"}') as l_paid_after \gset
select pg_temp.list('{"sort": "name"}') as l_name \gset
select pg_temp.list('{"sort": "name", "dir": "desc"}') as l_name_desc \gset
select pg_temp.list('{"sort": "gmv"}') as l_gmv \gset
select pg_temp.list('{"sort": "last_active"}') as l_active_desc \gset
select pg_temp.list('{"sort": "last_active", "dir": "asc"}') as l_active_asc \gset
select pg_temp.list('{"sort": "paid_till"}') as l_paid_desc \gset
select pg_temp.list('{"export": true}') as l_export \gset
select tests.clear_auth();

select is((:'l_all'::jsonb) ->> 'total', '7', 'the search finds the seven');
select is(pg_temp.slugs(:'l_slowing'), array['sa560-slowing'], 'a health filter');
select is(pg_temp.slugs(:'l_inactive'), array['sa560-idle'], 'inactive');
-- Both made in this transaction, so they share a created_at: compared in any order.
select is(pg_temp.sorted(:'l_setting_up'), array['sa560-billed', 'sa560-new'], 'setting up');
select is(pg_temp.slugs(:'l_failed'), array['sa560-slowing'], 'a state filter');
select is(pg_temp.slugs(:'l_paid'), array['sa560-busy'], 'paid');
select is(pg_temp.slugs(:'l_starter'), array['sa560-small'], 'a plan filter');
select is(pg_temp.slugs(:'l_city'), array['sa560-idle'], 'a city, whatever the case');
select is(pg_temp.slugs(:'l_region'), array['sa560-idle'], 'an Indian state, whatever the case');
select ok((:'l_all'::jsonb) -> 'cities' ? 'Indore' and (:'l_all'::jsonb) -> 'regions' ? 'Madhya Pradesh',
  'the cities and states to choose from');
select is(pg_temp.slugs(:'l_referral'), array['sa560-never'], 'how they found us');
select is(cardinality(pg_temp.slugs(:'l_unknown')), 6, 'not known');
select is(pg_temp.sorted(:'l_today'), array['sa560-billed', 'sa560-new'], 'created from a day (India)');
select is(pg_temp.slugs(:'l_paid_till'), array['sa560-busy'],
  'paid till its last day: the period ends at the start of the next');
select is(pg_temp.slugs(:'l_paid_after'), '{}'::text[], 'not paid past its last day');
select is(pg_temp.slugs(:'l_name'), pg_temp.sorted(:'l_all'), 'by name');
select is(pg_temp.slugs(:'l_name_desc'),
  (select array_agg(s order by s desc) from unnest(pg_temp.slugs(:'l_all')) as s), 'by name, Z to A');
select is((pg_temp.slugs(:'l_gmv'))[1:3], array['sa560-busy', 'sa560-billed', 'sa560-idle'],
  'by GMV over the last 30 days, highest first');
select is((pg_temp.slugs(:'l_active_desc'))[1], 'sa560-new', 'most recently active first');
select is((pg_temp.slugs(:'l_active_asc'))[1], 'sa560-never', 'never active first, going up');
select is((pg_temp.slugs(:'l_paid_desc'))[1], 'sa560-busy', 'paid furthest ahead first');
select is((:'l_export'::jsonb) ->> 'page_size', '10000', 'an export is one long page');

select is(
  (select r - 'created_at' - 'paid_till' - 'last_active' - 'restaurant_id' - 'access_state'
   from jsonb_array_elements((:'l_all'::jsonb) -> 'rows') as r where r ->> 'slug' = 'sa560-busy'),
  jsonb_build_object(
    'name', 'Sa560-Busy', 'slug', 'sa560-busy', 'city', null, 'region', null,
    'phone', '+91 98765-56001', 'status', 'active', 'acquisition_channel', null,
    'plan_code', 'growth', 'plan_name', (select name from public.plans where code = 'growth'),
    'billing_cycle', 'monthly', 'subscription_status', 'active', 'state', 'paid', 'ending', false,
    'health', 'active', 'gmv_30d_paise', 50000, 'orders_7d', jsonb_build_array(0, 0, 0, 0, 0, 5, 0),
    'paid', jsonb_build_object('subscription_paise', 89900, 'setup_fee_paise', 0, 'gst_paise', 16182)
  ),
  'a row: state, plan, health, 30-day GMV, orders on each of the last 7 days, money paid before GST'
);
select is(
  (select (r ->> 'paid_till')::timestamptz from jsonb_array_elements((:'l_all'::jsonb) -> 'rows') as r
   where r ->> 'slug' = 'sa560-busy'),
  '2030-01-01T00:00:00+05:30'::timestamptz,
  'paid till is the end of the paid period'
);
select is(
  (select r -> 'orders_7d' -> 6 from jsonb_array_elements((:'l_all'::jsonb) -> 'rows') as r
   where r ->> 'slug' = 'sa560-small'),
  '1'::jsonb,
  'the latest finished day is counted live, before the nightly usage step stores it'
);
select is(
  (select (r ->> 'gmv_30d_paise')::bigint from jsonb_array_elements((:'l_all'::jsonb) -> 'rows') as r
   where r ->> 'slug' = 'sa560-billed'),
  32000::bigint,
  'and its bills count toward GMV'
);

select tests.authenticate_as_platform_admin(:'admin');
select throws_ok($$select public.platform_list_restaurants('{"state": "active"}')$$,
  'P0001', 'INVALID_INPUT', 'states, not statuses');
select throws_ok($$select public.platform_list_restaurants('{"health": "sleepy"}')$$,
  'P0001', 'INVALID_INPUT', 'an unknown health');
select throws_ok($$select public.platform_list_restaurants('{"sort": "phone"}')$$,
  'P0001', 'INVALID_INPUT', 'an unknown sort');
select throws_ok($$select public.platform_list_restaurants('{"dir": "up"}')$$,
  'P0001', 'INVALID_INPUT', 'an unknown direction');
select throws_ok($$select public.platform_list_restaurants('{"channel": "tv"}')$$,
  'P0001', 'INVALID_INPUT', 'an unknown channel');
select throws_ok($$select public.platform_list_restaurants('{"status": "active"}')$$,
  'P0001', 'INVALID_INPUT', 'the old status filter is gone');
select throws_ok(
  $$select public.platform_list_restaurants('{"paid_from": "2026-10-10", "paid_to": "2026-10-01"}')$$,
  'P0001', 'INVALID_INPUT', 'paid till: the end before the start');
select tests.authenticate_as_platform_admin(:'admin', 'aal1');
select throws_ok($$select public.platform_list_restaurants('{}')$$,
  'P0001', 'MFA_REQUIRED', 'the list needs the second factor');
select throws_ok($$select public.platform_save_view('restaurants', 'Mine', 'state=paid', false)$$,
  'P0001', 'MFA_REQUIRED', 'so does saving a view');
select throws_ok(format('select public.platform_delete_view(%L)', gen_random_uuid()),
  'P0001', 'MFA_REQUIRED', 'deleting one');
select throws_ok($$select public.platform_search('sa560')$$,
  'P0001', 'MFA_REQUIRED', 'and searching');
select tests.authenticate_as(:'n_owner');
select throws_ok($$select public.platform_list_restaurants('{}')$$,
  'P0001', 'FORBIDDEN', 'a restaurant owner cannot list restaurants');
select tests.as_anon();
select throws_ok($$select public.platform_list_restaurants('{}')$$, '42501', null, 'anon cannot');
select tests.clear_auth();

-- ─── Saved views ────────────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_save_view('restaurants', ' Failed ', 'state=payment_failed', false) as v_mine \gset
select is(
  public.platform_save_view('restaurants', 'failed', 'state=paid&cols=state,phone', false),
  :'v_mine'::uuid,
  'the same name again replaces the view'
);
select public.platform_save_view('restaurants', 'Team', 'health=inactive', true) as v_team \gset
select throws_ok($$select public.platform_save_view('restaurants', 'Bad', '?state=paid', false)$$,
  'P0001', 'INVALID_INPUT', 'a query is key=value pairs');
select throws_ok($$select public.platform_save_view('restaurants', 'Bad', 'state=paid#x', false)$$,
  'P0001', 'INVALID_INPUT', 'no fragment');
select throws_ok($$select public.platform_save_view('restaurants', '  ', 'state=paid', false)$$,
  'P0001', 'INVALID_INPUT', 'a name is needed');
select throws_ok(
  format($$select public.platform_save_view('restaurants', %L, 'state=paid', false)$$, repeat('x', 61)),
  'P0001', 'INVALID_INPUT', 'a name of 60 characters at most');
select throws_ok($$select public.platform_save_view('leads', 'Mine', 'state=paid', false)$$,
  'P0001', 'INVALID_INPUT', 'restaurants views only, for now');
select throws_ok(
  $$insert into public.platform_saved_views (owner_id, page, name, query) values (auth.uid(), 'restaurants', 'Direct', '')$$,
  '42501', null, 'views are saved only through the function');
select is(
  (select array_agg(row(name, query, shared)::text order by name) from public.platform_saved_views
   where owner_id = :'admin'),
  array['(failed,"state=paid&cols=state,phone",f)', '(Team,health=inactive,t)'],
  'an admin sees their own views'
);
select tests.authenticate_as_platform_admin(:'admin_b');
select is((select array_agg(name) from public.platform_saved_views where owner_id = :'admin'),
  array['Team'], 'another admin sees only the shared ones');
select is((select count(*)::int from public.platform_saved_views where not shared and owner_id <> auth.uid()),
  0, 'and nobody else''s unshared ones');
select throws_ok(format('select public.platform_delete_view(%L)', :'v_team'),
  'P0001', 'NOT_FOUND', 'and cannot delete them');
select tests.authenticate_as(:'n_owner');
select is((select count(*)::int from public.platform_saved_views), 0, 'a restaurant owner sees none');
select throws_ok($$select public.platform_save_view('restaurants', 'Mine', 'state=paid', false)$$,
  'P0001', 'FORBIDDEN', 'nor saves one');
select tests.as_anon();
select throws_ok($$select public.platform_save_view('restaurants', 'Mine', 'state=paid', false)$$,
  '42501', null, 'anon cannot save');
select tests.authenticate_as_platform_admin(:'admin');
select lives_ok(format('select public.platform_delete_view(%L)', :'v_mine'), 'the owner deletes a view');
select is((select array_agg(name) from public.platform_saved_views where owner_id = :'admin'),
  array['Team'], 'and it is gone');
select tests.clear_auth();

-- ─── Search ─────────────────────────────────────────────────────────────────
insert into public.site_leads (name, restaurant_name, city, phone)
values ('Sa560 Lead', 'Sa560 Cafe', 'Pune', '9876556099');
select tests.add_member(:'idle', 'owner', 'idle_boss') as idle_boss \gset

create function pg_temp.found(p_q text, p_group text default 'restaurants')
returns jsonb language sql as $$
  select coalesce(jsonb_agg(r - 'restaurant_id' - 'lead_id' - 'created_at'), '[]')
  from jsonb_array_elements(public.platform_search(p_q) -> p_group) as r;
$$;

select tests.authenticate_as_platform_admin(:'admin');
select pg_temp.found('56001') as s_phone \gset
select pg_temp.found('98765 56001') as s_spaced \gset
select pg_temp.found('+91 98765 56001') as s_country \gset
select pg_temp.found('6556') as s_dash \gset
select pg_temp.found('abcde1234') as s_gstin \gset
select pg_temp.found('5678901') as s_fssai \gset
select pg_temp.found('idle_boss@sa560') as s_owner \gset
select pg_temp.found('sa560-sl') as s_slug \gset
select pg_temp.found('SA560find', 'payments') as s_pay \gset
select pg_temp.found('56099', 'leads') as s_lead \gset
select public.platform_search('x') as s_short \gset
select pg_temp.found('%%') as s_percent \gset
select tests.clear_auth();

-- Other local restaurants may match too: look for these.
create function pg_temp.match(p_found jsonb, p_slug text)
returns text language sql as $$
  select r ->> 'match' from jsonb_array_elements(p_found) as r where r ->> 'slug' = p_slug;
$$;
select is(pg_temp.match(:'s_phone', 'sa560-busy'), 'Phone +91 98765-56001',
  'a restaurant by part of its phone, stored as typed');
select is(pg_temp.match(:'s_spaced', 'sa560-busy'), 'Phone +91 98765-56001',
  'spaces in a typed phone are ignored');
select is(pg_temp.match(:'s_country', 'sa560-busy'), 'Phone +91 98765-56001',
  'and +91 in front');
select is(pg_temp.match(:'s_dash', 'sa560-busy'), 'Phone +91 98765-56001',
  'digits either side of a stored dash');
select is(pg_temp.match(:'s_gstin', 'sa560-busy'), 'GSTIN 23ABCDE1234F1Z5', 'by part of the GSTIN, any case');
select ok(not jsonb_path_exists(:'s_gstin'::jsonb, '$[*] ? (@.match starts with "Phone")'),
  'the digits in a GSTIN are not a phone');
select is(pg_temp.match(:'s_fssai', 'sa560-busy'), 'FSSAI 12345678901234', 'by part of the FSSAI number');
select is(pg_temp.match(:'s_owner', 'sa560-idle'), 'Owner idle_boss@sa560-idle.test', 'by the owner''s email');
select is(:'s_slug'::jsonb -> 0 ->> 'slug', 'sa560-slowing', 'by name or code');
select is(:'s_pay'::jsonb,
  '[{"name": "Sa560-Busy", "kind": "payment", "ref": "pay_SA560find"},
    {"name": "Sa560-Busy", "kind": "subscription", "ref": "sub_SA560find"}]',
  'payments by Razorpay payment or subscription ID');
select is(:'s_lead'::jsonb,
  '[{"name": "Sa560 Lead", "restaurant_name": "Sa560 Cafe", "phone": "9876556099"}]',
  'leads by phone');
select is(:'s_short'::jsonb, '{"restaurants": [], "payments": [], "leads": []}',
  'one character finds nothing');
select is(:'s_percent'::jsonb, '[]', 'typed % is text, not a pattern');

select tests.authenticate_as(:'n_owner');
select throws_ok($$select public.platform_search('sa560')$$, 'P0001', 'FORBIDDEN',
  'a restaurant owner cannot search the platform');
select tests.as_anon();
select throws_ok($$select public.platform_search('sa560')$$, '42501', null, 'anon cannot');
select tests.clear_auth();

-- ─── Health in the daily snapshot ───────────────────────────────────────────
select public.platform_metrics_snapshot((now() at time zone 'Asia/Kolkata')::date - 1);
select is(
  (select jsonb_object_agg(r.slug, m.health)
   from public.metrics_subscription_daily m
   join public.restaurants r on r.id = m.restaurant_id
   where m.day = (now() at time zone 'Asia/Kolkata')::date - 1
     and r.slug in ('sa560-never', 'sa560-idle', 'sa560-slowing', 'sa560-busy', 'sa560-small')),
  '{"sa560-never": "never_started", "sa560-idle": "inactive", "sa560-slowing": "slowing",
    "sa560-busy": "active", "sa560-small": "active"}'::jsonb,
  'the snapshot stores each restaurant''s health at the end of the day'
);

-- ─── Permissions that only show or hide ─────────────────────────────────────
-- The signed-in user's claims, run as postgres: private functions aren't callable directly.
select tests.authenticate_as_platform_admin(:'admin');
select set_config('role', 'none', true);
select is(private.has_platform_permission('money.view'), true, 'an admin holds money.view (until 13g)');
select throws_ok($$select private.has_platform_permission('money.veiw')$$,
  'P0001', null, 'a misspelt permission still fails');
select tests.authenticate_as(:'n_owner');
select set_config('role', 'none', true);
select is(private.has_platform_permission('money.view'), false, 'a restaurant owner does not');
select tests.clear_auth();

-- ─── Health settings ────────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_update_settings('{"health_inactive_days": 10, "health_slowing_min_orders": 20}')
  as settings \gset
select throws_ok($$select public.platform_update_settings('{"health_slowing_percent": 100}')$$,
  'P0001', 'INVALID_INPUT', 'slowing is under 100%');
select throws_ok($$select public.platform_update_settings('{"health_setup_days": 0}')$$,
  'P0001', 'INVALID_INPUT', 'at least one setup day');
select throws_ok($$select public.platform_update_settings('{"health_inactive_days": 61}')$$,
  'P0001', 'INVALID_INPUT', 'up to 60 inactive days');
select tests.clear_auth();
select is(
  array[(:'settings'::jsonb ->> 'health_inactive_days')::int,
        (:'settings'::jsonb ->> 'health_slowing_min_orders')::int],
  array[10, 20],
  'the health settings save'
);
select is(
  (select row(before, after)::text from public.audit_logs
   where action = 'platform_settings.updated' and created_at = now()),
  row('{"health_inactive_days": 7, "health_slowing_min_orders": 10}'::jsonb,
      '{"health_inactive_days": 10, "health_slowing_min_orders": 20}'::jsonb)::text,
  'and are audited'
);

select * from finish();
rollback;
