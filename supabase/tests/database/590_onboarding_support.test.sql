-- The onboarding checklist, Get help and the support inbox, and both in Needs
-- attention, the activity stream and the alerts (docs/SUPER_ADMIN_PLAN.md 13b;
-- docs/DECISIONS.md SA-41 to SA-45). Restaurants here are named sa590-*.
begin;
select no_plan();

select tests.create_platform_admin('platform590@admin.test') as admin \gset
select tests.create_platform_admin('platform590b@admin.test') as admin_b \gset
select tests.create_user('plain590@user.test') as plain \gset

select tests.create_restaurant('sa590-new') as new \gset
select tests.create_restaurant('sa590-other') as other \gset
select tests.create_restaurant('sa590-busy') as busy \gset
select tests.add_member(:'new', 'owner', 'sa590_owner') as owner \gset
select tests.add_member(:'new', 'manager', 'sa590_manager') as manager \gset
select tests.add_member(:'new', 'waiter', 'sa590_waiter') as waiter_login \gset
select tests.add_member(:'other', 'owner', 'sa590_other') as other_owner \gset
select tests.add_member(:'busy', 'owner', 'sa590_busy') as busy_owner \gset

-- ─── Onboarding: nothing done yet ───────────────────────────────────────────
-- The staff logins above are team: take them away until the team step.
update public.restaurant_members set is_active = false
where restaurant_id = :'new' and role <> 'owner';

select private.restaurant_onboarding(:'new') as ob \gset
select is((:'ob'::jsonb) ->> 'done', '0', 'nothing done');
select is((:'ob'::jsonb) ->> 'next', 'menu', 'the menu first');
select is((:'ob'::jsonb) ->> 'stuck', 'false', 'not stuck in its first 3 days');
select is(
  (select array_agg(s ->> 'key' order by n) from jsonb_array_elements((:'ob'::jsonb) -> 'steps')
     with ordinality as x(s, n)),
  array['menu', 'tables', 'qr', 'team', 'first_order', 'first_bill', 'paid'],
  'the seven steps in order'
);
select is(private.restaurant_onboarding(gen_random_uuid()), null, 'no restaurant, no steps');

update public.restaurants set created_at = now() - interval '10 days' where id = :'new';
select is(private.restaurant_onboarding(:'new') ->> 'stuck', 'true',
  'stuck: nothing done in 3 days since it was created');

create temp table step_at as
select null::text as key, null::timestamptz as at where false;
create function pg_temp.step(p_restaurant uuid, p_key text) returns timestamptz
language sql as $$
  select (s ->> 'done_at')::timestamptz
  from jsonb_array_elements(private.restaurant_onboarding(p_restaurant) -> 'steps') as s
  where s ->> 'key' = p_key;
$$;

-- ─── Menu: 5 active dishes ──────────────────────────────────────────────────
insert into public.menu_categories (restaurant_id, name) values (:'new', 'Mains')
returning id as category \gset
insert into public.menu_items (restaurant_id, category_id, name, price_paise, food_type, created_at)
select :'new', :'category', 'Dish ' || n, 10000, 'veg', now() - interval '9 days' + make_interval(hours => n)
from generate_series(1, 4) as n;
insert into public.menu_items (restaurant_id, category_id, name, price_paise, food_type, is_active, created_at)
values (:'new', :'category', 'Turned off', 10000, 'veg', false, now() - interval '9 days');
select is(pg_temp.step(:'new', 'menu'), null, 'four dishes (and one turned off) are not a menu');
insert into public.menu_items (restaurant_id, category_id, name, price_paise, food_type, created_at)
values (:'new', :'category', 'Dish 5', 10000, 'veg', now() - interval '8 days');
select is(pg_temp.step(:'new', 'menu'), now() - interval '8 days', 'done when the fifth came');
select is(private.restaurant_onboarding(:'new') ->> 'next', 'tables', 'then the tables');
select is(private.restaurant_onboarding(:'new') ->> 'stuck', 'true',
  'still stuck: the menu was done 8 days ago');

-- ─── Tables, QR codes, team ─────────────────────────────────────────────────
insert into public.dining_tables (restaurant_id, label, qr_token, created_at)
values (:'new', 'T1', private.random_base62(16), now() - interval '7 days')
returning id as table_id \gset
select is(pg_temp.step(:'new', 'tables'), now() - interval '7 days', 'a table');

insert into public.audit_logs (restaurant_id, actor_type, actor_label, action, created_at)
values (:'new', 'staff', 'Owner', 'table.qr_sheet_printed', now() - interval '6 days');
select is(pg_temp.step(:'new', 'qr'), now() - interval '6 days', 'the QR sheet printed');

select is(pg_temp.step(:'new', 'team'), null, 'the owner alone is not a team');
insert into public.waiters (restaurant_id, full_name, created_at)
values (:'new', 'Ravi', now() - interval '5 days');
select is(pg_temp.step(:'new', 'team'), now() - interval '5 days', 'a waiter profile is a team');
update public.restaurant_members set is_active = true, created_at = now() - interval '6 days'
where restaurant_id = :'new' and role = 'manager';
select is(pg_temp.step(:'new', 'team'), now() - interval '6 days',
  'or a staff login, whichever came first');

-- ─── First QR order, first bill ─────────────────────────────────────────────
insert into public.table_sessions (restaurant_id, dining_table_id, table_label_snapshot)
values (:'new', :'table_id', 'T1') returning id as session \gset
insert into public.orders (restaurant_id, session_id, round_number, status, placed_via, idempotency_key, created_at)
values (:'new', :'session', 1, 'accepted', 'staff', 'sa590-staff', now() - interval '5 days');
insert into public.orders (restaurant_id, session_id, round_number, status, placed_via, idempotency_key, created_at)
values (:'new', :'session', 2, 'rejected', 'customer', 'sa590-rejected', now() - interval '5 days');
select is(pg_temp.step(:'new', 'first_order'), null,
  'a staff order or a rejected one is not a QR order');
insert into public.orders (restaurant_id, session_id, round_number, status, placed_via, idempotency_key, created_at)
values (:'new', :'session', 3, 'accepted', 'customer', 'sa590-qr', now() - interval '4 days');
select is(pg_temp.step(:'new', 'first_order'), now() - interval '4 days', 'an accepted QR order');

insert into public.bills (
  restaurant_id, session_id, invoice_number, financial_year, invoice_seq, document_type,
  table_label_snapshot, line_items, restaurant_snapshot, gst_mode, gst_rate_bps,
  prices_include_tax, subtotal_paise, taxable_paise, grand_total_paise, generated_at
)
values (
  :'new', :'session', 'INV/2026-27/00590', '2026-27', 590, 'bill', 'T1', '[]', '{}', 'none', 0,
  false, 32000, 32000, 32000, now() - interval '2 days'
);
select is(pg_temp.step(:'new', 'first_bill'), now() - interval '2 days', 'a bill');
select is(private.restaurant_onboarding(:'new') ->> 'next', 'paid', 'only paying is left');
select is(private.restaurant_onboarding(:'new') ->> 'stuck', 'false',
  'not stuck: the bill was 2 days ago');
select is(private.restaurant_onboarding(:'new') ->> 'done', '6', 'six of seven');

-- ─── Paid, or autopay ───────────────────────────────────────────────────────
insert into public.subscription_payments (restaurant_id, source, purpose, amount_paise, manual_mode, created_at)
values (:'new', 'manual', 'setup_fee', 50000, 'upi', now() - interval '1 day');
select is(pg_temp.step(:'new', 'paid'), null, 'a setup fee is not a subscription payment');
update public.restaurant_subscriptions set razorpay_status = 'active', cancel_at_period_end = true
where restaurant_id = :'new';
select is(pg_temp.step(:'new', 'paid'), null, 'autopay that is ending is not set up');
update public.restaurant_subscriptions set cancel_at_period_end = false where restaurant_id = :'new';
insert into public.audit_logs (restaurant_id, actor_type, actor_label, action, after, created_at)
values (:'new', 'system', 'Razorpay', 'subscription.razorpay_updated',
  '{"razorpay_status": "authenticated"}', now() - interval '20 hours');
select is(pg_temp.step(:'new', 'paid'), now() - interval '20 hours',
  'autopay on: since Razorpay first said so');
select is(private.restaurant_onboarding(:'new') ->> 'next', null, 'all done');
select is(private.restaurant_onboarding(:'new') ->> 'stuck', 'false', 'done is never stuck');

-- A QR order shows the codes are out, even before QR use was recorded.
select tests.create_full_fixture(:'other');
update public.orders set placed_via = 'customer' where restaurant_id = :'other';
select is(pg_temp.step(:'other', 'qr'), pg_temp.step(:'other', 'first_order'),
  'QR codes: done with the first QR order');

-- ─── The owner's card ───────────────────────────────────────────────────────
select tests.authenticate_as(:'owner');
select public.admin_onboarding() as mine \gset
select tests.clear_auth();
select is(:'mine'::jsonb, private.restaurant_onboarding(:'new'), 'the owner reads the same steps');
select tests.authenticate_as(:'manager');
select throws_ok('select public.admin_onboarding()', 'P0001', 'FORBIDDEN', 'the owner''s only');
select tests.clear_auth();

-- ─── Restaurant page and list ───────────────────────────────────────────────
select private.restaurant_onboarding(:'new') as new_ob \gset
select tests.authenticate_as_platform_admin(:'admin');
select is(public.platform_restaurant_overview(:'new') -> 'onboarding', :'new_ob'::jsonb,
  'the Overview has the checklist');
select public.platform_list_restaurants('{"q": "sa590", "onboarding": "done"}') as done_list \gset
select public.platform_list_restaurants('{"q": "sa590", "onboarding": "open"}') as open_list \gset
select throws_ok($$select public.platform_list_restaurants('{"onboarding": "late"}')$$,
  'P0001', 'INVALID_INPUT', 'an unknown onboarding filter');
select tests.clear_auth();
select is(
  (select array_agg(r ->> 'slug') from jsonb_array_elements((:'done_list'::jsonb) -> 'rows') as r),
  array['sa590-new'], 'done');
select is(
  (select array_agg(r ->> 'slug' order by r ->> 'slug')
   from jsonb_array_elements((:'open_list'::jsonb) -> 'rows') as r),
  array['sa590-busy', 'sa590-other'], 'not finished');
select is(
  (select r -> 'onboarding' from jsonb_array_elements((:'done_list'::jsonb) -> 'rows') as r),
  private.restaurant_onboarding(:'new') - 'steps', 'each row says where it stands');

-- Stuck in Needs attention: of the last 60 days, with full access, before paying.
update public.restaurants set created_at = now() - interval '10 days' where id = :'busy';
update public.restaurants set created_at = now() - interval '10 days' where id = :'other';
update public.dining_tables set created_at = now() - interval '9 days' where restaurant_id = :'other';
update public.bills set generated_at = now() - interval '9 days' where restaurant_id = :'other';
update public.orders set created_at = now() - interval '9 days' where restaurant_id = :'other';
update public.waiters set created_at = now() - interval '9 days' where restaurant_id = :'other';
update public.subscription_payments set created_at = now() - interval '9 days'
where restaurant_id = :'other';
update public.restaurant_members set created_at = now() - interval '9 days'
where restaurant_id = :'other';
select is(private.restaurant_onboarding(:'other') ->> 'stuck', 'true', 'other is stuck');
select is(private.restaurant_onboarding(:'busy') ->> 'stuck', 'true', 'busy is stuck');

-- ─── Support: the bucket ────────────────────────────────────────────────────
select is((select public from storage.buckets where id = 'support-screenshots'), false,
  'screenshots are private');
select is((select file_size_limit from storage.buckets where id = 'support-screenshots'),
  5242880::bigint, 'up to 5 MB');
select is((select allowed_mime_types from storage.buckets where id = 'support-screenshots'),
  array['image/png', 'image/jpeg', 'image/webp'], 'images only');
select is_empty(
  $$
    select policyname from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and (qual like '%support-screenshots%' or with_check like '%support-screenshots%')
  $$,
  'no storage policy mentions the screenshots bucket'
);

-- ─── Screenshot uploads: a name in the restaurant's folder, 20 an hour ───────
insert into public.support_screenshot_uploads (restaurant_id, path, created_at)
values (:'new', :'new' || '/old.png', now() - interval '2 days');
select tests.authenticate_as(:'owner');
select public.admin_start_screenshot_upload('png') as shot_path \gset
select throws_ok($$select public.admin_start_screenshot_upload('gif')$$, 'P0001', 'INVALID_INPUT',
  'an image type the bucket takes');
select tests.clear_auth();
select ok(:'shot_path' ~ ('^' || :'new' || '/[0-9a-f-]{36}\.png$'), 'in the restaurant''s folder');
select tests.authenticate_as(:'waiter_login');
select throws_ok($$select public.admin_start_screenshot_upload('png')$$, 'P0001', 'FORBIDDEN',
  'not a waiter''s login');
select tests.clear_auth();
insert into public.support_screenshot_uploads (restaurant_id, path, created_at)
select :'busy', :'busy' || '/' || gen_random_uuid() || '.png', now() - interval '10 minutes'
from generate_series(1, 20);
select tests.authenticate_as(:'busy_owner');
select throws_ok($$select public.admin_start_screenshot_upload('jpg')$$, 'P0001', 'RATE_LIMITED',
  'the 21st in an hour');
select tests.clear_auth();
select is((select count(*)::int from public.support_screenshot_uploads where path = :'new' || '/old.png'),
  0, 'one a day old is forgotten');

-- ─── Get help ───────────────────────────────────────────────────────────────
insert into storage.objects (bucket_id, name)
values ('support-screenshots', :'new' || '/00000000-0000-4000-8000-000000000590.png'),
  ('support-screenshots', :'other' || '/00000000-0000-4000-8000-000000000591.png');

select tests.authenticate_as(:'owner');
select public.admin_create_support_request(jsonb_build_object(
  'topic', 'printing', 'message', '  The bill printer prints blank.  ', 'contact_method', 'call',
  'contact', '9876543210',
  'screenshot_path', :'new' || '/00000000-0000-4000-8000-000000000590.png',
  'context', jsonb_build_object('page', '/admin/bills', 'app_version', 'abc123', 'browser', 'Chrome')
)) as req \gset
select throws_ok(format('select public.admin_create_support_request(%L)', jsonb_build_object(
  'topic', 'menu', 'message', 'Hi', 'contact_method', 'call', 'contact', '9876543210',
  'screenshot_path', :'other' || '/00000000-0000-4000-8000-000000000591.png')),
  'P0001', 'INVALID_INPUT', 'not another restaurant''s screenshot');
select throws_ok(format('select public.admin_create_support_request(%L)', jsonb_build_object(
  'topic', 'menu', 'message', 'Hi', 'contact_method', 'call', 'contact', '9876543210',
  'screenshot_path', :'new' || '/00000000-0000-4000-8000-000000000999.png')),
  'P0001', 'INVALID_INPUT', 'not a screenshot that was never uploaded');
select throws_ok($$select public.admin_create_support_request('{"topic": "food", "message": "Hi",
  "contact_method": "call", "contact": "9876543210"}')$$, 'P0001', 'INVALID_INPUT', 'a topic');
select throws_ok($$select public.admin_create_support_request('{"topic": "menu", "message": " ",
  "contact_method": "call", "contact": "9876543210"}')$$, 'P0001', 'INVALID_INPUT', 'a message');
select throws_ok($$select public.admin_create_support_request('{"topic": "menu", "message": "Hi",
  "contact_method": "call", "contact": "98765"}')$$, 'P0001', 'INVALID_INPUT', 'a 10-digit number');
select throws_ok($$select public.admin_create_support_request('{"topic": "menu", "message": "Hi",
  "contact_method": "email", "contact": "owner"}')$$, 'P0001', 'INVALID_INPUT', 'an email address');
select throws_ok($$select public.admin_create_support_request('{"topic": "menu", "message": "Hi",
  "contact_method": "email", "contact": "me@x.co?bcc=a%40b.co"}')$$, 'P0001', 'INVALID_INPUT',
  'a plain address, nothing more for a mailto link');
select throws_ok($$select public.admin_create_support_request('{"topic": "menu", "message": "Hi",
  "contact_method": "call", "contact": "9876543210", "priority": "high"}')$$,
  'P0001', 'INVALID_INPUT', 'no priority from the restaurant');
select throws_ok($$select public.admin_create_support_request('{"topic": "menu", "message": "Hi",
  "contact_method": "call", "contact": "9876543210", "context": {"ip": "1.2.3.4"}}')$$,
  'P0001', 'INVALID_INPUT', 'only the known context');
select tests.clear_auth();

select is(
  (select jsonb_build_object('restaurant', q.restaurant_id, 'by', q.created_by,
     'name', q.created_by_name, 'role', q.created_by_role, 'message', q.message,
     'status', q.status, 'priority', q.priority, 'context', q.context)
   from public.support_requests q where q.id = :'req'),
  jsonb_build_object('restaurant', :'new', 'by', :'owner', 'name', 'Sa590_owner', 'role', 'owner',
    'message', 'The bill printer prints blank.', 'status', 'open', 'priority', 'normal',
    'context', jsonb_build_object('page', '/admin/bills', 'app_version', 'abc123',
      'browser', 'Chrome')),
  'saved, open, with who asked and from where'
);

select tests.authenticate_as(:'manager');
select public.admin_create_support_request('{"topic": "billing", "message": "Where is my invoice?",
  "contact_method": "email", "contact": "manager@example.com"}') as req_m \gset
select tests.clear_auth();
select tests.authenticate_as(:'waiter_login');
select throws_ok($$select public.admin_create_support_request('{"topic": "menu", "message": "Hi",
  "contact_method": "call", "contact": "9876543210"}')$$, 'P0001', 'FORBIDDEN',
  'not a waiter''s login');
select tests.clear_auth();
select tests.authenticate_as(:'plain');
select throws_ok('select public.admin_list_support_requests()', 'P0001', 'FORBIDDEN',
  'not someone with no restaurant');
select tests.clear_auth();

-- 10 an hour for a restaurant.
insert into public.support_requests (restaurant_id, created_by_name, created_by_role, topic,
  message, contact_method, contact)
select :'busy', 'Busy', 'owner', 'other', 'Request ' || n, 'call', '9876543210'
from generate_series(1, 10) as n;
select tests.authenticate_as(:'busy_owner');
select throws_ok($$select public.admin_create_support_request('{"topic": "menu", "message": "Hi",
  "contact_method": "call", "contact": "9876543210"}')$$, 'P0001', 'RATE_LIMITED',
  'the eleventh in an hour');
select tests.clear_auth();
update public.support_requests set created_at = now() - interval '2 hours' where restaurant_id = :'busy';
select tests.authenticate_as(:'busy_owner');
select lives_ok($$select public.admin_create_support_request('{"topic": "menu", "message": "Hi",
  "contact_method": "call", "contact": "9876543210"}')$$, 'an hour later');
select tests.clear_auth();

-- ─── The inbox ──────────────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_list_support_requests(jsonb_build_object('restaurant', :'new')) as inbox \gset
select is((:'inbox'::jsonb) ->> 'total', '2', 'both of the restaurant''s requests');
select is((:'inbox'::jsonb) -> 'counts',
  '{"active": 2, "open": 2, "in_progress": 0, "waiting": 0, "resolved": 0}'::jsonb, 'by status');

select public.platform_update_support_request(:'req',
  jsonb_build_object('status', 'in_progress', 'priority', 'high', 'assignee', :'admin_b'));
select public.platform_update_support_request(:'req', '{"priority": "high"}');
select public.platform_add_support_note(:'req', '  Asked them to restart the printer.  ');
select throws_ok(format('select public.platform_add_support_note(%L, %L)', :'req', ' '),
  'P0001', 'INVALID_INPUT', 'a note says something');
select throws_ok(format('select public.platform_update_support_request(%L, %L)', :'req',
  jsonb_build_object('assignee', :'plain')), 'P0001', 'ADMIN_NOT_FOUND', 'someone on the team');
select throws_ok(format('select public.platform_update_support_request(%L, %L)', :'req',
  '{"status": "closed"}'), 'P0001', 'INVALID_INPUT', 'a status');
select throws_ok(format('select public.platform_update_support_request(%L, %L)', gen_random_uuid(),
  '{"status": "resolved"}'), 'P0001', 'NOT_FOUND', 'a request');

select public.platform_list_support_requests(jsonb_build_object('restaurant', :'new')) as inbox \gset
select is(
  (select array_agg(r ->> 'id') from jsonb_array_elements((:'inbox'::jsonb) -> 'rows') as r),
  array[:'req', :'req_m'], 'high priority first');
select is((:'inbox'::jsonb) -> 'rows' -> 0 ->> 'assignee', 'platform590b@admin.test', 'assigned');
select is(
  (public.platform_list_support_requests('{"assignee": "none", "status": "open"}') -> 'rows')
    @> jsonb_build_array(jsonb_build_object('id', :'req_m')),
  true, 'no one on the manager''s');
select is(
  public.platform_list_support_requests('{"assignee": "me"}') ->> 'total', '0',
  'none assigned to me');
select throws_ok($$select public.platform_list_support_requests('{"status": "late"}')$$,
  'P0001', 'INVALID_INPUT', 'an unknown status');

select public.platform_get_support_request(:'req') as one \gset
select is(
  (select jsonb_agg(jsonb_build_object('kind', e ->> 'kind', 'from', e ->> 'from', 'to', e ->> 'to',
     'body', e ->> 'body', 'actor', e ->> 'actor') order by n)
   from jsonb_array_elements((:'one'::jsonb) -> 'events') with ordinality as x(e, n)),
  (select jsonb_agg(v order by n) from unnest(array[
    jsonb_build_object('kind', 'status', 'from', 'open', 'to', 'in_progress', 'body', null,
      'actor', 'platform590@admin.test'),
    jsonb_build_object('kind', 'priority', 'from', 'normal', 'to', 'high', 'body', null,
      'actor', 'platform590@admin.test'),
    jsonb_build_object('kind', 'assignee', 'from', null, 'to', 'platform590b@admin.test',
      'body', null, 'actor', 'platform590@admin.test'),
    jsonb_build_object('kind', 'note', 'from', null, 'to', null,
      'body', 'Asked them to restart the printer.', 'actor', 'platform590@admin.test')
  ]) with ordinality as x(v, n)),
  'each change once (an unchanged priority is no change), then the note'
);
select is((:'one'::jsonb) ->> 'created_by_email', 'sa590_owner@sa590-new.test', 'who asked');
select is((:'one'::jsonb) ->> 'screenshot_path',
  :'new' || '/00000000-0000-4000-8000-000000000590.png', 'the screenshot');
select throws_ok(format('select public.platform_get_support_request(%L)', gen_random_uuid()),
  'P0001', 'NOT_FOUND', 'no such request');

select public.platform_update_support_request(:'req', '{"status": "resolved"}');
select tests.clear_auth();
select isnt((select resolved_at from public.support_requests where id = :'req'), null,
  'resolved when');
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_update_support_request(:'req', '{"status": "waiting"}');
select tests.clear_auth();
select is((select resolved_at from public.support_requests where id = :'req'), null,
  'opened again');

-- ─── What the restaurant sees ───────────────────────────────────────────────
select tests.authenticate_as(:'owner');
select public.admin_list_support_requests() as own \gset
select is((select count(*)::int from public.support_requests), 0,
  'the table itself is the team''s');
select is((select count(*)::int from public.support_request_events), 0, 'and its events');
select tests.clear_auth();
select is(jsonb_array_length(:'own'::jsonb), 2, 'its two requests');
select jsonb_path_query_first(:'own'::jsonb, '$[*] ? (@.id == $id)',
  jsonb_build_object('id', :'req')) as own_req \gset
select is(
  (select array_agg(k order by k) from jsonb_object_keys(:'own_req'::jsonb) as k),
  array['contact', 'contact_method', 'created_at', 'created_by_name', 'has_screenshot', 'history',
    'id', 'message', 'resolved_at', 'status', 'topic'],
  'no priority, assignee or notes'
);
select is(
  (select jsonb_agg(h ->> 'status' order by n)
   from jsonb_array_elements((:'own_req'::jsonb) -> 'history') with ordinality as x(h, n)),
  '["in_progress", "resolved", "waiting"]'::jsonb,
  'each status it went through'
);
select tests.authenticate_as(:'other_owner');
select is(public.admin_list_support_requests(), '[]'::jsonb, 'another restaurant sees none');
select tests.clear_auth();

-- ─── Activity, alerts, Needs attention ──────────────────────────────────────
update public.support_requests set created_at = now() - interval '2 days' where id = :'req_m';
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_activity(:'new', array['support']) as act \gset
select public.platform_alerts() as alerts \gset
select ok(public.platform_snooze('support_open:' || :'req_m', 1) > now(), 'a request can be snoozed');
select ok(public.platform_snooze('stuck_onboarding:' || :'other', 1) > now(),
  'and a stuck restaurant');
select tests.clear_auth();
-- All of them: a dev database has more than a page of stuck restaurants.
select private.attention(null, true, true, true, 10000) as att \gset

select is(
  (select array_agg(i -> 'data' ->> 'request_id' order by n)
   from jsonb_array_elements((:'act'::jsonb) -> 'items') with ordinality as x(i, n)),
  array[:'req', :'req_m'], 'requests are in the restaurant''s activity');
select is((:'act'::jsonb) -> 'items' -> 0 -> 'data' ->> 'topic', 'printing', 'with the topic');
select ok(
  (:'alerts'::jsonb) -> 'items' @> jsonb_build_array(jsonb_build_object('kind', 'support',
    'key', 'support:' || :'req')),
  'a new request is an alert');

create function pg_temp.ids(p_att jsonb, p_group text) returns text[]
language sql as $$
  select coalesce(array_agg(i ->> 'key' order by i ->> 'key'), '{}')
  from jsonb_array_elements(p_att -> 'groups') as g, jsonb_array_elements(g -> 'items') as i
  where g ->> 'group' = p_group;
$$;
select ok('support_open:' || :'req_m' = any(pg_temp.ids(:'att', 'support_open')),
  'open more than a day');
select ok(not ('support_open:' || :'req' = any(pg_temp.ids(:'att', 'support_open'))),
  'not one waiting on the restaurant');
select ok('stuck_onboarding:' || :'other' = any(pg_temp.ids(:'att', 'stuck_onboarding')),
  'stuck before paying');
select ok(not ('stuck_onboarding:' || :'new' = any(pg_temp.ids(:'att', 'stuck_onboarding'))),
  'not one that is done');
update public.restaurants set created_at = now() - interval '61 days' where id = :'other';
select ok(not ('stuck_onboarding:' || :'other' =
    any(pg_temp.ids(private.attention(null, true, true, true, 50), 'stuck_onboarding'))),
  'not one older than 60 days');

-- ─── Screenshots left behind ────────────────────────────────────────────────
update storage.objects set created_at = now() - interval '2 days'
where bucket_id = 'support-screenshots' and (name like :'new' || '/%' or name like :'other' || '/%');
select tests.as_service_role();
select array(select public.support_screenshots_to_remove(1000)) as to_remove \gset
select tests.clear_auth();
select ok(:'other' || '/00000000-0000-4000-8000-000000000591.png' = any(:'to_remove'::text[]),
  'a day old and in no request');
select ok(not (:'new' || '/00000000-0000-4000-8000-000000000590.png' = any(:'to_remove'::text[])),
  'not one a request uses');
select tests.authenticate_as(:'owner');
select throws_ok('select public.support_screenshots_to_remove()', '42501', null,
  'the server''s only');
select tests.clear_auth();

-- ─── Who may ────────────────────────────────────────────────────────────────
select tests.authenticate_as(:'owner');
select throws_ok($$select public.platform_list_support_requests('{}')$$, 'P0001', 'FORBIDDEN',
  'not a restaurant owner');
select throws_ok(format('select public.platform_get_support_request(%L)', :'req'), 'P0001',
  'FORBIDDEN', 'not a restaurant owner');
select tests.clear_auth();
select tests.authenticate_as_platform_admin(:'admin', 'aal1');
select throws_ok(format('select public.platform_update_support_request(%L, %L)', :'req',
  '{"status": "open"}'), 'P0001', 'MFA_REQUIRED', 'two-step sign-in first');
select tests.clear_auth();
select tests.as_anon();
select throws_ok('select public.admin_list_support_requests()', '42501', null, 'not anon');
select throws_ok(format('select public.platform_add_support_note(%L, %L)', :'req', 'Hi'),
  '42501', null, 'not anon');
select tests.clear_auth();

select * from finish();
rollback;
