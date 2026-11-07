-- Closing an account (docs/SUPER_ADMIN_PLAN.md 14e, docs/DECISIONS.md SA-93+):
-- what a close turns off, what a reopen puts back, and what the removal after
-- the hold deletes while bills and payments stay as they are.
begin;
select no_plan();

-- ─── Fixtures ───────────────────────────────────────────────────────────────
select tests.create_platform_admin('sa680-admin@example.test') as admin \gset
select tests.create_restaurant('sa680-cafe') as cafe \gset
select tests.create_restaurant('sa680-other') as other \gset
select tests.add_member(:'cafe', 'owner', 'sa680owner') as owner \gset
select tests.add_member(:'cafe', 'manager', 'sa680mgr') as manager \gset
select tests.add_member(:'cafe', 'waiter', 'sa680off') as off_staff \gset
update public.restaurant_members set is_active = false where user_id = :'off_staff';
-- A person with another restaurant too keeps their login (hand-written SQL only).
select tests.add_member(:'cafe', 'manager', 'sa680both') as both \gset
insert into public.restaurant_members (restaurant_id, user_id, role, display_name, username)
values (:'other', :'both', 'manager', 'Both', 'sa680both');
-- And a team member who also has a membership.
select tests.create_platform_admin('sa680-staff-admin@example.test') as staff_admin \gset
insert into public.restaurant_members (restaurant_id, user_id, role, display_name, username)
values (:'cafe', :'staff_admin', 'manager', 'Staff Admin', 'sa680sa');

update public.restaurants set
  phone = '9876500680', email = 'cafe@sa680.test', legal_name = 'Sa680 Foods',
  address_line = '1 Mall Road', gstin = '22AAAAA0000A1Z5', fssai_license = '12345678900680',
  upi_vpa = 'cafe@upi', upi_payee_name = 'Sa680', show_upi_qr_on_bill = true,
  bill_footer_text = 'Call Ravi', storefront_photo_path = 'signups/00000000-0000-4000-8000-000000000680.jpg'
where id = :'cafe';

select tests.create_full_fixture(:'cafe');
select id as table_id, qr_token from public.dining_tables where restaurant_id = :'cafe' \gset
update public.bills set
  waiter_name_snapshot = 'Fixture Waiter',
  restaurant_snapshot = '{"phone": "9876500680", "gstin": "22AAAAA0000A1Z5"}'
where restaurant_id = :'cafe';
insert into public.waiters (restaurant_id, full_name, phone, employee_code, joined_on, notes)
values (:'cafe', 'Ravi Kumar', '9876500681', 'E1', '2026-01-01', 'Night shift');

insert into public.audit_logs (restaurant_id, actor_type, actor_user_id, actor_role, actor_label,
  action, before, after, reason) values
  (:'cafe', 'staff', :'owner', 'owner', 'Sa680owner', 'waiter.created', null,
   '{"full_name": "Ravi Kumar", "phone": "9876500681", "employee_code": "E1"}', null),
  (:'cafe', 'staff', :'owner', 'owner', 'Sa680owner', 'settings.updated',
   '{"phone": "111", "gstin": "OLD"}', '{"phone": "9876500680", "gstin": "22AAAAA0000A1Z5"}', null),
  (:'cafe', 'staff', :'owner', 'owner', 'Sa680owner', 'bill.generated', null,
   '{"grand_total_paise": 32000, "invoice_number": "INV/2026-27/00001"}', null);
insert into public.audit_logs (restaurant_id, actor_type, actor_user_id, actor_label, action, after)
values (:'cafe', 'platform_admin', :'admin', 'sa680-admin@example.test',
  'restaurant.account_manager_changed', '{"email": "sa680-admin@example.test"}');

insert into public.audit_logs (restaurant_id, actor_type, actor_user_id, actor_label, action,
  before, after, reason)
values (:'cafe', 'platform_admin', :'admin', 'Platform admin', 'restaurant.suspended',
  '{"status": "active", "suspended_reason": null}',
  '{"status": "suspended", "suspended_reason": "Ravi did not pay"}', 'Ravi did not pay');

-- What a person did, and what the service role did to them (the zero id, with
-- the address in its traits: how Supabase logs an admin creating a user).
insert into auth.audit_log_entries (id, payload) values
  (gen_random_uuid(), json_build_object('actor_id', :'owner', 'action', 'login')),
  (gen_random_uuid(), json_build_object('actor_id', '00000000-0000-0000-0000-000000000000',
    'action', 'user_signedup',
    'traits', json_build_object('user_id', :'owner', 'user_email', 'sa680owner@sa680-cafe.test'))),
  (gen_random_uuid(), json_build_object('actor_id', '00000000-0000-0000-0000-000000000000',
    'action', 'user_signedup',
    'traits', json_build_object('user_id', :'both', 'user_email', 'sa680both@sa680-cafe.test')));

insert into public.support_requests (restaurant_id, created_by_name, created_by_role, topic,
  message, contact_method, contact, screenshot_path)
values (:'cafe', 'Sa680owner', 'owner', 'other', 'Help', 'call', '9876500680', 'x/y.png');
insert into public.restaurant_notes (restaurant_id, body) values (:'cafe', 'Owner is Ravi');
insert into public.site_leads (name, restaurant_name, city, phone, email, message, channel, stage, restaurant_id)
values ('Ravi', 'Sa680 Cafe', 'Indore', '9876500680', 'ravi@sa680.test', 'Call me', 'phone', 'won', :'cafe')
returning id as lead \gset
insert into public.lead_events (lead_id, kind, body) values (:'lead', 'note', 'Ravi called');
insert into public.lead_events (lead_id, kind, from_value, to_value) values (:'lead', 'stage', 'new', 'won');
insert into public.trial_claims (kind, value, restaurant_id) values
  ('phone', '9876500680', :'cafe'), ('gstin', '22AAAAA0000A1Z5', :'cafe');
update public.restaurant_subscriptions set cancel_reason_detail = 'Ravi is moving away'
where restaurant_id = :'cafe';
insert into public.standees (restaurant_id, quantity, notes) values (:'cafe', 2, 'Ring Ravi');
insert into public.webhook_events (provider, event_id, event_type, payload) values
  ('razorpay', 'evt_sa680_mine', 'payment.captured', jsonb_build_object('payload', jsonb_build_object(
    'payment', jsonb_build_object('entity', jsonb_build_object(
      'id', 'pay_sa680', 'amount', 106082, 'email', 'ravi@sa680.test', 'contact', '+919876500680',
      'vpa', 'ravi@upi', 'upi', jsonb_build_object('vpa', 'ravi@upi', 'flow', 'collect'),
      'notes', jsonb_build_object('restaurant_id', :'cafe')))))),
  ('razorpay', 'evt_sa680_theirs', 'payment.captured', jsonb_build_object('payload', jsonb_build_object(
    'payment', jsonb_build_object('entity', jsonb_build_object(
      'email', 'them@sa680.test', 'notes', jsonb_build_object('restaurant_id', :'other'))))));

-- An open support window, and an active login session.
insert into public.support_sessions (restaurant_id, consent, granted_by, ends_at)
values (:'cafe', 'owner', :'owner', now() + interval '1 hour');
insert into auth.sessions (id, user_id) values (gen_random_uuid(), :'owner');
select id as owner_member from public.restaurant_members
  where restaurant_id = :'cafe' and user_id = :'owner' \gset

create function pg_temp.financial(p_restaurant uuid) returns text language sql as $$
  select md5(concat_ws('|',
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.bills x where x.restaurant_id = p_restaurant),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.bill_payments x where x.restaurant_id = p_restaurant),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.orders x where x.restaurant_id = p_restaurant),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.order_items x where x.restaurant_id = p_restaurant),
    (select string_agg(to_jsonb(x)::text, ',' order by x.id) from public.subscription_payments x where x.restaurant_id = p_restaurant),
    (select string_agg(to_jsonb(x)::text, ',') from public.invoice_counters x where x.restaurant_id = p_restaurant)
  ));
$$;
select pg_temp.financial(:'cafe') as financial_before \gset
select count(*) as audit_rows_before from public.audit_logs where restaurant_id = :'cafe' \gset

-- ─── Closing ────────────────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select throws_ok(
  format('select public.platform_close_restaurant(%L, %L, %L)', :'cafe', 'not-the-code', 'Asked to'),
  'P0001', 'CLOSE_CODE_MISMATCH', 'the wrong code closes nothing'
);
select throws_ok(
  format('select public.platform_close_restaurant(%L, %L, %L)', :'cafe', 'sa680-cafe', '   '),
  'P0001', 'REASON_REQUIRED', 'closing needs a reason'
);
select throws_ok(
  format('select public.platform_close_restaurant(%L, %L, %L)', gen_random_uuid(), 'x', 'Asked to'),
  'P0001', 'RESTAURANT_NOT_FOUND', 'an unknown restaurant'
);

select tests.authenticate_as_platform_admin(:'admin', 'aal1');
select throws_ok(
  format('select public.platform_close_restaurant(%L, %L, %L)', :'cafe', 'sa680-cafe', 'Asked to'),
  'P0001', 'MFA_REQUIRED', 'closing needs the second factor'
);
select tests.authenticate_as(:'owner');
select throws_ok(
  format('select public.platform_close_restaurant(%L, %L, %L)', :'cafe', 'sa680-cafe', 'Asked to'),
  'P0001', 'FORBIDDEN', 'the owner can''t close through the team''s function (SA-93)'
);

-- Autopay set up after the action cancelled what it saw (the owner subscribing
-- meanwhile) closes nothing, so the retry cancels it too (SA-94).
select tests.clear_auth();
create temp table sa680_sub as
  select razorpay_subscription_id, razorpay_status, cancel_at_period_end
  from public.restaurant_subscriptions where restaurant_id = :'cafe';
update public.restaurant_subscriptions
  set razorpay_subscription_id = 'sub_SA680late', razorpay_status = 'created'
  where restaurant_id = :'cafe';
select tests.authenticate_as_platform_admin(:'admin');
select throws_ok(
  format('select public.platform_close_restaurant(%L, %L, %L)', :'cafe', 'sa680-cafe', 'Asked to'),
  'P0001', 'AUTOPAY_CAN_CHARGE', 'a checkout opened meanwhile closes nothing'
);
select tests.clear_auth();
update public.restaurant_subscriptions set razorpay_status = 'active' where restaurant_id = :'cafe';
select tests.authenticate_as_platform_admin(:'admin');
select throws_ok(
  format('select public.platform_close_restaurant(%L, %L, %L)', :'cafe', 'sa680-cafe', 'Asked to'),
  'P0001', 'AUTOPAY_CAN_CHARGE', 'nor autopay that is on'
);
-- A late save of the old one doesn't hide it: ended, it changes nothing; the team's is refused.
select tests.as_service_role();
select is(
  public.razorpay_save_subscription(:'cafe', jsonb_build_object('id', 'sub_SA680old', 'status', 'cancelled',
    'notes', jsonb_build_object('restaurant_id', :'cafe'))) ->> 'result',
  'not_current', 'a subscription that has ended isn''t saved over the one tracked');
select throws_ok(
  format($f$select public.razorpay_save_subscription(%L, %L::jsonb, %L)$f$, :'cafe',
    jsonb_build_object('id', 'sub_SA680old', 'status', 'halted', 'notes', jsonb_build_object(
      'restaurant_id', :'cafe')), :'admin'),
  'P0001', 'RAZORPAY_SUBSCRIPTION_CHANGED', 'nor is the team''s late sync of an old one');
select tests.clear_auth();
select is(
  (select razorpay_subscription_id from public.restaurant_subscriptions where restaurant_id = :'cafe'),
  'sub_SA680late', 'which stays');
-- One set to end with its paid period won't charge again: it closes.
update public.restaurant_subscriptions set cancel_at_period_end = true where restaurant_id = :'cafe';

select tests.authenticate_as_platform_admin(:'admin');
select public.platform_close_restaurant(:'cafe', ' SA680-CAFE ', 'Owner asked to leave') as closed \gset
select ok((:'closed'::jsonb ->> 'removal_due_at')::timestamptz between now() + interval '30 days'
    and now() + interval '31 days', 'a hold of 30 days');
select is(((:'closed'::jsonb ->> 'removal_due_at')::timestamptz at time zone 'Asia/Kolkata')::time,
  '23:59:59'::time, 'to the end of that day in India: the owner is told the date');
select is(:'closed'::jsonb -> 'recipients',
  '["cafe@sa680.test", "sa680owner@sa680-cafe.test"]'::jsonb,
  'who to tell: the owner and the restaurant');
select throws_ok(
  format('select public.platform_close_restaurant(%L, %L, %L)', :'cafe', 'sa680-cafe', 'Again'),
  'P0001', 'RESTAURANT_CLOSED', 'closing twice is refused'
);
select throws_ok(
  format('select public.platform_set_restaurant_status(%L, %L, %L)', :'cafe', 'active', ''),
  'P0001', 'RESTAURANT_CLOSED', 'Unsuspend can''t get around a close'
);
select throws_ok(
  format('select public.platform_set_restaurant_status(%L, %L, %L)', :'cafe', 'suspended', 'x'),
  'P0001', 'RESTAURANT_CLOSED', 'nor can Suspend'
);
-- A tab left open can't do what the page no longer offers (SA-94).
select throws_ok(format('select public.platform_extend_trial(%L, 7)', :'cafe'),
  'P0001', 'RESTAURANT_CLOSED', 'no extending its trial');
select throws_ok(format($$select public.platform_change_plan(%L, 'growth')$$, :'cafe'),
  'P0001', 'RESTAURANT_CLOSED', 'no changing its plan');
select throws_ok(format('select public.platform_reset_owner_password(%L)', :'owner_member'),
  'P0001', 'RESTAURANT_CLOSED', 'no new password for its owner');
select throws_ok(format($$select public.platform_set_deal(%L, '{}')$$, :'cafe'),
  'P0001', 'RESTAURANT_CLOSED', 'no special price');
select throws_ok(format($$select public.platform_set_override(%L, '{}')$$, :'cafe'),
  'P0001', 'RESTAURANT_CLOSED', 'no override');
select throws_ok(format($$select public.platform_save_standees(%L, '{"quantity": 2}')$$, :'cafe'),
  'P0001', 'RESTAURANT_CLOSED', 'no standees');
select throws_ok(format($$select public.platform_onboarding_support_session(%L, 'Asha')$$, :'cafe'),
  'P0001', 'RESTAURANT_CLOSED', 'no onboarding session');
select tests.authenticate_as_platform_admin(:'admin');
select lives_ok(format($$select public.platform_add_note(%L, 'Owner may come back')$$, :'cafe'),
  'the team can still note what the owner says');
select is(public.platform_closure(:'cafe') ->> 'reason', 'Owner asked to leave', 'the page shows why');
select is(public.platform_closure(:'cafe') ->> 'closed_by', 'sa680-admin@example.test', 'and who');
select is(public.platform_closure(:'other'), null, 'nothing about an open restaurant');
select is(
  (select jsonb_agg(r ->> 'restaurant_id') from jsonb_array_elements(
    public.platform_list_restaurants('{"state": "closed", "q": "sa680"}') -> 'rows') as r),
  jsonb_build_array(:'cafe'), 'the Closed filter finds it');
select tests.clear_auth();

select is(
  (select status::text from public.restaurants where id = :'cafe'), 'closed', 'status is closed');
select is(
  (select count(*)::int from public.restaurant_members where restaurant_id = :'cafe' and is_active),
  0, 'every member is off');
select ok(
  (select banned_until > now() + interval '99 years' from auth.users where id = :'owner'),
  'the owner''s login is banned');
select is((select count(*)::int from auth.sessions where user_id = :'owner'), 0, 'their sessions are gone');
update public.restaurant_subscriptions s
  set (razorpay_subscription_id, razorpay_status, cancel_at_period_end) =
    (select x.razorpay_subscription_id, x.razorpay_status, x.cancel_at_period_end from sa680_sub x)
  where s.restaurant_id = :'cafe';

-- No reset code for the banned login, and one sent just before sets no password (SA-95).
insert into public.password_resets (email, user_id, code_hash)
values ('sa680owner@sa680-cafe.test', :'owner', repeat('c', 64))
returning id as early_reset \gset
select tests.as_service_role();
select is(public.auth_password_reset_start('sa680owner@sa680-cafe.test', repeat('d', 64)) ->> 'send',
  'false', 'a banned login gets no reset code');
select is(public.auth_password_reset_verify(:'early_reset', repeat('c', 64)) ->> 'status', 'gone',
  'and one sent before the close no longer works');
-- A closed restaurant takes no new autopay.
select throws_ok(
  format($f$select public.razorpay_save_subscription(%L, %L::jsonb)$f$, :'cafe',
    jsonb_build_object('id', 'sub_SA680new', 'status', 'created', 'notes', jsonb_build_object(
      'restaurant_id', :'cafe', 'plan_code', 'starter', 'billing_cycle', 'monthly'))),
  'P0001', 'RESTAURANT_CLOSED', 'a closed restaurant takes no new subscription');
select tests.clear_auth();
select is(
  (select banned_until from auth.users where id = :'both'), null,
  'a person with another restaurant keeps their login');
select is(
  (select banned_until from auth.users where id = :'staff_admin'), null, 'as does a team member');
select ok(
  (select is_active from public.restaurant_members where restaurant_id = :'other' and user_id = :'both'),
  'and their other restaurant');
select is(
  (select count(*)::int from public.support_sessions where restaurant_id = :'cafe' and ended_at is null),
  0, 'support windows are ended');
select is(public.auth_staff_login_email('sa680-cafe', 'sa680owner'), null, 'no username login');
select is(
  (select a.state || '/' || a.reason from private.restaurant_access(:'cafe') as a),
  'read_only/closed', 'read-only, because it is closed');
select is(private.subscription_state('closed', 'read_only', 'active', 'razorpay'), 'closed',
  'its state is Closed, whatever its subscription says');
select lives_ok(
  format($$insert into public.metrics_subscription_daily (day, restaurant_id, state)
    values ('2001-01-02', %L, 'closed')$$, :'cafe'),
  'the nightly snapshot can store it');

select tests.authenticate_as(:'owner');
select is((select count(*)::int from private.my_restaurant_ids()), 0, 'an owner''s token reads nothing');
select is(public.member_role(:'cafe'::uuid)::text, null, 'and has no role');
select throws_ok('select public.admin_data_export()', 'P0001', 'FORBIDDEN', 'and calls nothing');
select tests.clear_auth();

select tests.as_service_role();
select throws_ok(format('select public.customer_get_table(%L)', :'qr_token'),
  'P0001', 'TABLE_NOT_FOUND', 'its QR codes stop working');
select throws_ok(format('select public.customer_get_session(%L)', :'qr_token'),
  'P0001', 'TABLE_NOT_FOUND', 'for the session page');
select throws_ok(format($$select public.customer_create_service_request(%L, '00000000-0000-4000-8000-000000000680', 'call_waiter')$$, :'qr_token'),
  'P0001', 'TABLE_NOT_FOUND', 'and for calling a waiter');
select tests.clear_auth();

-- ─── Reopening ──────────────────────────────────────────────────────────────
select tests.authenticate_as(:'owner');
select throws_ok(format('select public.platform_reopen_restaurant(%L)', :'cafe'),
  'P0001', 'FORBIDDEN', 'only the team reopens');
select tests.authenticate_as_platform_admin(:'admin');
select throws_ok(format('select public.platform_reopen_restaurant(%L)', :'other'),
  'P0001', 'RESTAURANT_NOT_CLOSED', 'an open restaurant can''t be reopened');
select lives_ok(format('select public.platform_reopen_restaurant(%L)', :'cafe'), 'it reopens');
select tests.clear_auth();

select is((select status::text from public.restaurants where id = :'cafe'), 'active', 'active again');
select is((select suspended_reason from public.restaurants where id = :'cafe'), null, 'no reason left');
select is(
  (select array_agg(user_id order by user_id) from public.restaurant_members
    where restaurant_id = :'cafe' and is_active),
  (select array_agg(u order by u) from unnest(array[:'owner', :'manager', :'both', :'staff_admin']::uuid[]) as u),
  'the logins that were on are on; the one that was off stays off');
select is((select banned_until from auth.users where id = :'owner'), null, 'the ban is lifted');
select is(public.auth_staff_login_email('sa680-cafe', 'sa680owner'), 'sa680owner@sa680-cafe.test', 'they can log in');
select is((select count(*)::int from public.restaurant_closures where restaurant_id = :'cafe'), 0, 'no closure left');
select is(
  (select array_agg(action order by action) from public.audit_logs
    where restaurant_id = :'cafe' and action in ('restaurant.closed', 'restaurant.reopened')),
  array['restaurant.closed', 'restaurant.reopened'], 'both are in the audit log');
select tests.as_service_role();
select ok(public.customer_get_table(:'qr_token') is not null, 'the same QR codes work again');
select tests.clear_auth();

-- A suspended restaurant comes back suspended, with its reason.
select tests.suspend(:'cafe');
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_close_restaurant(:'cafe', 'sa680-cafe', 'Second close') as second \gset
select public.platform_reopen_restaurant(:'cafe');
select tests.clear_auth();
select is(
  (select status::text || '/' || suspended_reason from public.restaurants where id = :'cafe'),
  'suspended/Test suspension', 'reopening puts a suspension back');
update public.restaurants set status = 'active', suspended_reason = null where id = :'cafe';

-- ─── Removal after the hold ─────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_close_restaurant(:'cafe', 'sa680-cafe', 'Third close') as third \gset
select tests.clear_auth();

select tests.as_service_role();
select throws_ok(format('select public.closed_restaurant_remove_personal_data(%L)', :'cafe'),
  'P0001', 'HOLD_NOT_OVER', 'nothing goes during the hold');
select throws_ok(format('select public.closed_restaurant_remove_personal_data(%L)', :'other'),
  'P0001', 'RESTAURANT_NOT_CLOSED', 'nothing goes from an open restaurant');
select ok(not (:'cafe' = any (array(select public.closed_restaurants_due()::text))), 'not due yet');
select tests.clear_auth();

select tests.authenticate_as(:'owner');
select throws_ok(format('select public.closed_restaurant_remove_personal_data(%L)', :'cafe'),
  '42501', null, 'removal is the cron''s');
select throws_ok('select public.closed_restaurants_due()', '42501', null, 'as is its list');
select tests.clear_auth();

-- A copy made before the removal, and a file that lands after it.
insert into public.restaurant_exports (restaurant_id, status, size_bytes, finished_at, expires_at)
values (:'cafe', 'ready', 10, now(), now() + interval '20 hours');
insert into storage.objects (bucket_id, name, created_at) values
  ('restaurant-exports', :'cafe' || '/before.zip', now() - interval '1 hour'),
  ('restaurant-exports', :'cafe' || '/after.zip', now() + interval '1 minute');

update public.restaurant_closures set removal_due_at = now() - interval '1 minute' where restaurant_id = :'cafe';
select tests.as_service_role();
select ok(:'cafe' = any (array(select public.closed_restaurants_due()::text)), 'due after the hold');
select is(public.closed_restaurant_remove_personal_data(:'cafe') ->> 'removed', 'true', 'it runs');
select is(public.closed_restaurant_remove_personal_data(:'cafe') ->> 'removed', 'false', 'and only once');
select ok(not (:'cafe' = any (array(select public.closed_restaurants_due()::text))), 'no longer due');
select tests.clear_auth();

-- Stays.
select is(pg_temp.financial(:'cafe'), :'financial_before', 'bills, payments and orders are byte for byte the same');
select is(
  (select restaurant_snapshot ->> 'phone' from public.bills where restaurant_id = :'cafe'),
  '9876500680', 'a bill keeps the details it was issued with');
select is(
  (select waiter_name_snapshot from public.bills where restaurant_id = :'cafe'),
  'Fixture Waiter', 'and the waiter''s name printed on it');
select is(
  (select name || '/' || slug || '/' || legal_name || '/' || gstin || '/' || fssai_license || '/' || address_line
    from public.restaurants where id = :'cafe'),
  'Sa680-Cafe/sa680-cafe/Sa680 Foods/22AAAAA0000A1Z5/12345678900680/1 Mall Road',
  'the business''s identity stays with its financial records');
select ok(
  (select count(*) > 0 from public.dining_tables where restaurant_id = :'cafe')
  and (select count(*) > 0 from public.menu_items where restaurant_id = :'cafe'),
  'the menu and tables stay');
select is((select status::text from public.restaurants where id = :'cafe'), 'closed', 'still closed');
select ok(
  (select count(*) > :'audit_rows_before' from public.audit_logs where restaurant_id = :'cafe'),
  'no audit row is deleted');

-- Goes.
select is(
  (select row(phone, email, upi_vpa, upi_payee_name, bill_footer_text, storefront_photo_path)::text
    from public.restaurants where id = :'cafe'),
  '(,,,,,)', 'the restaurant''s phone, email, UPI, footer and photo');
select ok(
  not (select show_upi_qr_on_bill from public.restaurants where id = :'cafe'), 'its UPI QR is off');
select is(
  (select count(*)::int from auth.users where id in (:'owner', :'manager', :'off_staff')), 0,
  'the logins, including one that was already off');
select is(
  (select count(*)::int from public.restaurant_members where restaurant_id = :'cafe'), 0, 'every member row');
select is(
  (select count(*)::int from auth.audit_log_entries where payload::text like '%' || :'owner' || '%'),
  0, 'their auth log, by them and about them');
select is(
  (select count(*)::int from auth.audit_log_entries where payload::text like '%' || :'both' || '%'),
  1, 'but not about a login that stays');
select is(
  (select count(*)::int from auth.users where id in (:'both', :'staff_admin')), 2,
  'but not a login that leads elsewhere');
select is(
  (select count(*)::int from public.restaurant_members where user_id = :'both'), 1,
  'with its other membership');
select is(
  (select jsonb_agg(row(full_name, phone, employee_code, joined_on, notes, is_active)::text order by full_name)
    from public.waiters where restaurant_id = :'cafe'),
  '["(\"Waiter 1\",,,,,f)", "(\"Waiter 2\",,,,,f)"]'::jsonb,
  'waiters stay, numbered, without their details');
select is(
  (select count(*)::int from public.audit_logs where restaurant_id = :'cafe' and actor_label ilike 'sa680owner'),
  0, 'the audit log no longer names staff');
select is(
  (select after from public.audit_logs where restaurant_id = :'cafe' and action = 'waiter.created'),
  '{}'::jsonb, 'a waiter''s details are out of the audit log');
select is(
  (select before || after from public.audit_logs where restaurant_id = :'cafe' and action = 'settings.updated'),
  '{"gstin": "22AAAAA0000A1Z5"}'::jsonb, 'a settings change keeps only what isn''t personal');
select is(
  (select after ->> 'invoice_number' from public.audit_logs where restaurant_id = :'cafe' and action = 'bill.generated'),
  'INV/2026-27/00001', 'a bill''s audit row is untouched');
select is(
  (select after ->> 'email' from public.audit_logs where restaurant_id = :'cafe' and action = 'restaurant.account_manager_changed'),
  'sa680-admin@example.test', 'a team member''s email stays');
select is(
  (select actor_label from public.audit_logs where restaurant_id = :'cafe' and action = 'restaurant.closed' limit 1),
  'Platform admin', 'and the team''s label on its close');
select is((select count(*)::int from public.support_requests where restaurant_id = :'cafe'), 0, 'support requests');
select is((select count(*)::int from public.restaurant_notes where restaurant_id = :'cafe'), 0, 'team notes');
select is(
  (select row(name, phone, email, message)::text from public.site_leads where id = :'lead'),
  '(Removed,0000000000,,)', 'the lead''s person');
select is(
  (select array_agg(kind) from public.lead_events where lead_id = :'lead'),
  array['stage'], 'with its notes, but not its stage for the funnel');
select is(
  (select array_agg(kind) from public.trial_claims where restaurant_id = :'cafe'),
  array['gstin'], 'the phone''s trial claim; GSTIN still stops a second trial');
select is(
  (select cancel_reason_detail from public.restaurant_subscriptions where restaurant_id = :'cafe'),
  null, 'the owner''s words on cancelling');
select is((select notes from public.standees where restaurant_id = :'cafe'), null, 'standee notes');
select is(
  (select suspended_reason from public.restaurants where id = :'cafe'),
  'Account closed', 'the reason typed for closing');
select is(
  (select prior_reason from public.restaurant_closures where restaurant_id = :'cafe'),
  null, 'and the one from before it');
select is(
  (select count(*)::int from public.audit_logs where restaurant_id = :'cafe'
    and action in ('restaurant.closed', 'restaurant.suspended')
    and (reason is not null or before ? 'suspended_reason' or after ? 'suspended_reason')),
  0, 'and the audit log''s copies');
select is(
  (select count(*)::int from public.restaurant_exports where restaurant_id = :'cafe'),
  0, 'a data export made before it gives no more links');
select tests.as_service_role();
select ok((:'cafe' || '/before.zip') = any (array(select public.restaurant_exports_to_remove(1000))),
  'and its file goes the same night');
select ok(not (:'cafe' || '/after.zip') = any (array(select public.restaurant_exports_to_remove(1000))),
  'but not a copy made after it, of what is left');
select tests.clear_auth();
select is(
  (select payload #> '{payload,payment,entity}' from public.webhook_events where event_id = 'evt_sa680_mine'),
  jsonb_build_object('id', 'pay_sa680', 'amount', 106082, 'notes', jsonb_build_object('restaurant_id', :'cafe')),
  'Razorpay events lose the payer''s details and keep the payment');
select is(
  (select payload #>> '{payload,payment,entity,email}' from public.webhook_events where event_id = 'evt_sa680_theirs'),
  'them@sa680.test', 'another restaurant''s events are untouched');

select is(
  (select after from public.audit_logs where restaurant_id = :'cafe' and action = 'restaurant.personal_data_removed'),
  '{"logins": 3, "waiters": 2}'::jsonb, 'the removal is in the audit log, with counts only');

select tests.authenticate_as_platform_admin(:'admin');
select throws_ok(format('select public.platform_reopen_restaurant(%L)', :'cafe'),
  'P0001', 'PERSONAL_DATA_REMOVED', 'there is no reopening after the removal');
select ok(public.platform_closure(:'cafe') ->> 'removed_at' is not null, 'the page says so');
select is(public.platform_closure(:'cafe') ->> 'reason', null, 'and shows no reason');
select throws_ok(format($$select public.platform_add_note(%L, 'Too late')$$, :'cafe'),
  'P0001', 'PERSONAL_DATA_REMOVED', 'a note written now would stay for good');
select ok(
  (public.platform_get_restaurant(:'cafe') -> 'owners') = '[]'::jsonb,
  'the restaurant''s page still reads, with no owners');
select tests.clear_auth();

-- A payment link can be paid after the removal.
select tests.as_service_role();
select public.razorpay_record_webhook('evt_sa680_late', jsonb_build_object('event', 'payment_link.paid',
  'payload', jsonb_build_object(
    'payment', jsonb_build_object('entity', jsonb_build_object(
      'id', 'pay_sa680_late', 'email', 'late@sa680.test', 'contact', '+919876500680',
      'upi', jsonb_build_object('vpa', 'late@upi'),
      'notes', jsonb_build_object('restaurant_id', :'cafe'))),
    'payment_link', jsonb_build_object('entity', jsonb_build_object(
      'customer', jsonb_build_object('name', 'Ravi'),
      'notes', jsonb_build_object('restaurant_id', :'cafe'))))));
select public.razorpay_record_webhook('evt_sa680_late_other', jsonb_build_object('event', 'payment_link.paid',
  'payload', jsonb_build_object('payment', jsonb_build_object('entity', jsonb_build_object(
    'email', 'them@sa680.test', 'notes', jsonb_build_object('restaurant_id', :'other'))))));
select tests.clear_auth();
select is(
  (select payload -> 'payload' from public.webhook_events where event_id = 'evt_sa680_late'),
  jsonb_build_object(
    'payment', jsonb_build_object('entity', jsonb_build_object(
      'id', 'pay_sa680_late', 'notes', jsonb_build_object('restaurant_id', :'cafe'))),
    'payment_link', jsonb_build_object('entity', jsonb_build_object(
      'notes', jsonb_build_object('restaurant_id', :'cafe')))),
  'a Razorpay event after the removal stores no payer');
select is(
  (select payload #>> '{payload,payment,entity,email}' from public.webhook_events where event_id = 'evt_sa680_late_other'),
  'them@sa680.test', 'another restaurant''s still does');

-- Removed leads all carry the same stand-in phone: not duplicates of each other.
insert into public.site_leads (name, restaurant_name, city, phone, channel, stage)
values ('Removed', 'Elsewhere', 'Indore', '0000000000', 'phone', 'won');
select is(private.lead_matches('0000000000', :'lead') -> 'leads', '[]'::jsonb, 'removed leads don''t match');

-- ─── The reports ────────────────────────────────────────────────────────────
update public.restaurants set city = 'Sa680ville' where id = :'cafe';
update public.restaurant_closures set closed_at = now() - interval '10 days' where restaurant_id = :'cafe';
insert into public.subscription_deals (restaurant_id, plan_id, billing_cycle, list_price_paise, price_paise, reason, used_at)
select s.restaurant_id, s.plan_id, 'monthly', 100000, 50000, 'Test', now()
from public.restaurant_subscriptions s where s.restaurant_id = :'cafe'
returning id as deal \gset
update public.restaurant_subscriptions set deal_id = :'deal', status = 'active', source = 'manual',
  billing_cycle = 'monthly', current_period_end = now() + interval '20 days'
where restaurant_id = :'cafe';

select tests.authenticate_as_platform_admin(:'admin');
select ok(public.platform_usage_report((current_date - 20)::date, current_date) -> 'by_city' @> '[{"name": "Sa680ville"}]',
  'usage counts a restaurant closed during its dates');
select ok(not public.platform_usage_report((current_date - 3)::date, current_date) -> 'by_city' @> '[{"name": "Sa680ville"}]',
  'but not one closed before them');
select (public.platform_list_standees('open') ->> 'total')::int as standees_closed \gset
select (public.platform_revenue_report(current_date, current_date) #>> '{discounts,on_deal_now}')::int as deals_closed \gset
select tests.clear_auth();
update public.restaurants set status = 'active', suspended_reason = null where id = :'cafe';
select tests.authenticate_as_platform_admin(:'admin');
select is((public.platform_list_standees('open') ->> 'total')::int, :standees_closed + 1,
  'a closed restaurant leaves the standee queues');
select is((public.platform_revenue_report(current_date, current_date) #>> '{discounts,on_deal_now}')::int, :deals_closed + 1,
  'and Revenue''s count of special prices');
select tests.clear_auth();
update public.restaurants set status = 'closed', suspended_reason = 'Account closed' where id = :'cafe';

-- ─── The data export ────────────────────────────────────────────────────────
select tests.create_restaurant('sa680-export') as shop \gset
select tests.add_member(:'shop', 'owner', 'sa680expowner') as shop_owner \gset
select tests.add_member(:'shop', 'manager', 'sa680expmgr') as shop_manager \gset

select tests.authenticate_as(:'shop_manager');
select throws_ok('select public.admin_request_data_export()', 'P0001', 'FORBIDDEN', 'a manager can''t export');
select tests.authenticate_as(:'owner');
select throws_ok('select public.admin_request_data_export()', 'P0001', 'FORBIDDEN', 'nor a closed restaurant''s owner');

select tests.authenticate_as(:'shop_owner');
select is(public.admin_data_export(), null, 'no export yet');
select public.admin_request_data_export() as first_export \gset
select is(public.admin_data_export() ->> 'status', 'building', 'it builds');
select is(public.admin_data_export() ->> 'path', :'shop' || '/' || :'first_export' || '.zip', 'at its path');
select throws_ok('select public.admin_request_data_export()', 'P0001', 'EXPORT_TOO_SOON', 'one at a time');
select tests.clear_auth();
select is(
  (select actor_label || '/' || (after ->> 'export_id') from public.audit_logs
    where restaurant_id = :'shop' and action = 'restaurant.data_exported'),
  'Sa680expowner/' || :'first_export', 'it is audited, with who asked');

select tests.as_service_role();
select public.restaurant_export_finish(:'first_export', 2048);
select tests.authenticate_as(:'shop_owner');
select is(public.admin_data_export() ->> 'status', 'ready', 'then it is ready');
select ok(
  (public.admin_data_export() ->> 'expires_at')::timestamptz between now() + interval '23 hours' and now() + interval '25 hours',
  'for 24 hours');
select throws_ok('select public.admin_request_data_export()', 'P0001', 'EXPORT_TOO_SOON', 'and at most one an hour');
select tests.clear_auth();

-- A failed build can be tried again at once; a dead one reads as failed.
update public.restaurant_exports
  set status = 'failed', expires_at = null, created_at = now() - interval '1 minute'
  where id = :'first_export';
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_request_data_export(:'shop') as second_export \gset
select is(public.platform_data_export(:'shop') ->> 'status', 'building', 'the team can export too');
select tests.clear_auth();
select is(
  (select actor_label from public.audit_logs where restaurant_id = :'shop' and action = 'restaurant.data_exported'
    and actor_type = 'platform_admin'),
  'Platform admin', 'also audited');
update public.restaurant_exports set created_at = now() - interval '16 minutes' where id = :'second_export';
select tests.authenticate_as_platform_admin(:'admin');
select is(public.platform_data_export(:'shop') ->> 'status', 'failed', 'a build stuck for 15 minutes has failed');
select public.platform_request_data_export(:'shop') as third_export \gset
select is(public.platform_data_export(:'shop') ->> 'status', 'building', 'and can be tried again');
select tests.as_service_role();
select public.restaurant_export_finish(:'third_export');
select tests.authenticate_as_platform_admin(:'admin');
select is(public.platform_data_export(:'shop') ->> 'status', 'failed', 'a build that reports no size has failed');
select is(public.platform_data_export(:'shop') ->> 'expires_at', null, 'with no end for a link');
select tests.clear_auth();

-- Cleanup: old files and rows.
insert into storage.objects (bucket_id, name, created_at) values
  ('restaurant-exports', 'sa680/old.zip', now() - interval '26 hours'),
  ('restaurant-exports', 'sa680/new.zip', now() - interval '2 hours');
update public.restaurant_exports set created_at = now() - interval '3 days' where id = :'first_export';
select tests.authenticate_as(:'shop_owner');
select throws_ok('select public.restaurant_exports_to_remove()', '42501', null, 'cleanup is the cron''s');
select throws_ok(format('select public.restaurant_export_finish(%L, 1)', :'first_export'), '42501', null, 'as is finishing');
select tests.as_service_role();
select ok('sa680/old.zip' = any (array(select public.restaurant_exports_to_remove(1000))), 'a file past its 24 hours goes');
select ok(not 'sa680/new.zip' = any (array(select public.restaurant_exports_to_remove(1000))), 'a newer one stays');
select tests.clear_auth();
select is((select count(*)::int from public.restaurant_exports where id = :'first_export'), 0, 'and old rows go');

select is(
  (select public from storage.buckets where id = 'restaurant-exports'), false, 'the bucket is private');
select is(
  (select count(*)::int from pg_policies where schemaname = 'storage' and tablename = 'objects'
    and (qual like '%restaurant-exports%' or with_check like '%restaurant-exports%')),
  0, 'with no storage policies');
select tests.authenticate_as(:'shop_owner');
select throws_ok('select count(*) from public.restaurant_exports', '42501', null, 'no one reads the table directly');
select throws_ok('select count(*) from public.restaurant_closures', '42501', null, 'nor closures');
select tests.clear_auth();

select * from finish();
rollback;
