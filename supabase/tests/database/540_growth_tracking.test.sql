-- Acquisition channel, plan-limit hits, QR code use and cancellation reasons
-- (docs/SUPER_ADMIN_PLAN.md §4.3; docs/DECISIONS.md SA-12 to SA-15).
begin;
select no_plan();

select tests.create_platform_admin('platform@admin.test') as admin \gset

-- ─── Acquisition channel ────────────────────────────────────────────────────
select tests.create_user('wizard@example.test') as wizard_owner \gset
select tests.create_user('self-a@example.test') as self_a \gset
select tests.create_user('self-b@example.test') as self_b \gset
select tests.create_user('typo@example.test') as typo_owner \gset
insert into public.site_leads (name, restaurant_name, city, phone)
values ('Ravi', 'Ravi Dhaba', 'Indore', '9000000540');

select tests.as_service_role();
select public.platform_create_restaurant(jsonb_build_object(
  'name', 'Wizard Cafe', 'slug', 'sa-540-wizard', 'actor_user_id', :'admin',
  'acquisition_channel', 'field_visit',
  'owner', jsonb_build_object('user_id', :'wizard_owner', 'display_name', 'Asha', 'username', 'owner')
)) ->> 'restaurant_id' as wizard \gset
select throws_ok(
  format($f$select public.platform_create_restaurant(%L)$f$, jsonb_build_object(
    'name', 'Typo Cafe', 'slug', 'sa-540-typo', 'acquisition_channel', 'television',
    'owner', jsonb_build_object('user_id', :'typo_owner', 'display_name', 'T', 'username', 'owner'))),
  'P0001', 'INVALID_INPUT', 'only known channels'
);
select public.site_signup_create_restaurant(jsonb_build_object(
  'name', 'Lead Cafe', 'slug', 'sa-540-lead', 'phone', '+91 90000 00540',
  'fssai_license', '29999999999541', 'storefront_photo_path', 'signups/' || gen_random_uuid() || '.jpg',
  'owner', jsonb_build_object('user_id', :'self_a', 'display_name', 'Ravi', 'username', 'owner')
)) ->> 'restaurant_id' as from_lead \gset
select public.site_signup_create_restaurant(jsonb_build_object(
  'name', 'Walk-in Cafe', 'slug', 'sa-540-web', 'phone', '+91 90000 00549',
  'fssai_license', '29999999999542', 'storefront_photo_path', 'signups/' || gen_random_uuid() || '.jpg',
  'acquisition_channel', 'referral',
  'owner', jsonb_build_object('user_id', :'self_b', 'display_name', 'Meena', 'username', 'owner')
)) ->> 'restaurant_id' as from_web \gset
select tests.clear_auth();

select is(
  array(select acquisition_channel from public.restaurants
        where id in (:'wizard', :'from_lead', :'from_web') order by slug),
  array['website_lead', 'website', 'field_visit'],
  'the wizard''s answer; signup is website, or website_lead when a demo request has the mobile'
);
select is(
  (select after ->> 'acquisition_channel' from public.audit_logs
   where action = 'restaurant.created' and restaurant_id = :'wizard'),
  'field_visit',
  'and it is in the audit row'
);

-- ─── Plan-limit hits ────────────────────────────────────────────────────────
select tests.create_restaurant('sa-540-a') as rest_a \gset
select tests.create_restaurant('sa-540-b') as rest_b \gset
select tests.add_member(:'rest_a', 'owner', 'a_owner') as a_owner \gset
select tests.add_member(:'rest_a', 'manager', 'a_manager') as a_manager \gset
select tests.add_member(:'rest_a', 'waiter', 'a_waiter') as a_waiter \gset
select tests.add_member(:'rest_b', 'owner', 'b_owner') as b_owner \gset

select tests.authenticate_as(:'a_manager');
select public.member_record_plan_limit('PLAN_LIMIT_TABLES', '8');
select public.member_record_plan_limit('FEATURE_NOT_IN_PLAN', 'discounts');
select throws_ok($$ select public.member_record_plan_limit('SOMETHING_ELSE') $$,
  'P0001', 'INVALID_INPUT', 'only plan refusals');
select throws_ok($$ select public.member_record_plan_limit('FEATURE_NOT_IN_PLAN', 'Bad Key!') $$,
  'P0001', 'INVALID_INPUT', 'a feature is a feature key');
select is((select count(*) from public.plan_limit_events), 0::bigint, 'restaurants can''t read them');
select tests.clear_auth();
select is(
  (select array_agg(row(kind, feature, user_id = :'a_manager')::text order by id)
   from public.plan_limit_events where restaurant_id = :'rest_a'),
  array[row('tables', null::text, true)::text, row('feature', 'discounts', true)::text],
  'each hit: the restaurant, what it hit, who'
);
set local role anon;
select throws_ok($$ select public.member_record_plan_limit('PLAN_LIMIT_STAFF') $$,
  '42501', null, 'visitors cannot record hits');
reset role;

-- ─── QR codes ───────────────────────────────────────────────────────────────
insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
values (:'rest_a', '1', 'SA540A0000TABLE1', 1), (:'rest_a', '2', 'SA540A0000TABLE2', 2),
       (:'rest_b', '1', 'SA540B0000TABLE1', 1);
select
  (select id from public.dining_tables where qr_token = 'SA540A0000TABLE1') as a1,
  (select id from public.dining_tables where qr_token = 'SA540A0000TABLE2') as a2,
  (select id from public.dining_tables where qr_token = 'SA540B0000TABLE1') as b1
\gset
select tests.suspend(:'rest_a');
select tests.authenticate_as(:'a_owner');
select lives_ok(format('select public.admin_record_qr_use(%L, array[%L]::uuid[])', 'downloaded', :'a1'),
  'a download is recorded even while read-only');
select lives_ok(format('select public.admin_record_qr_use(%L, array[%L, %L]::uuid[])', 'sheet_printed', :'a1', :'a2'),
  'and the printed sheet');
select throws_ok(format('select public.admin_record_qr_use(%L, array[%L, %L]::uuid[])', 'downloaded', :'a1', :'a2'),
  'P0001', 'INVALID_INPUT', 'a download is one table');
select throws_ok(format('select public.admin_record_qr_use(%L, array[%L]::uuid[])', 'downloaded', :'b1'),
  'P0001', 'NOT_FOUND', 'only the restaurant''s own tables');
select tests.authenticate_as(:'a_waiter');
select throws_ok(format('select public.admin_record_qr_use(%L, array[%L]::uuid[])', 'downloaded', :'a1'),
  'P0001', 'FORBIDDEN', 'owners and managers only');
select tests.clear_auth();
select is(
  (select array_agg(row(action, entity_id = :'a1', after)::text order by action)
   from public.audit_logs where restaurant_id = :'rest_a' and action like 'table.qr\_%'),
  array[
    row('table.qr_downloaded', true, '{"label": "1"}'::jsonb)::text,
    row('table.qr_sheet_printed', null::boolean, '{"labels": ["1", "2"], "tables": 2}'::jsonb)::text
  ],
  'both are in the audit log'
);

-- ─── Cancellation reason ────────────────────────────────────────────────────
select tests.authenticate_as(:'b_owner');
select public.admin_record_cancel_reason('too_expensive', '  Costs more than   our POS ');
select throws_ok($$ select public.admin_record_cancel_reason('other') $$,
  'P0001', 'INVALID_INPUT', '"Other" needs a few words');
select throws_ok($$ select public.admin_record_cancel_reason('bored') $$,
  'P0001', 'INVALID_INPUT', 'only the listed reasons');
select tests.authenticate_as(:'a_manager');
select throws_ok($$ select public.admin_record_cancel_reason('closing') $$,
  'P0001', 'FORBIDDEN', 'only the owner turns autopay off');
select tests.clear_auth();
select is(
  (select row(cancel_reason, cancel_reason_detail)::text
   from public.restaurant_subscriptions where restaurant_id = :'rest_b'),
  row('too_expensive', 'Costs more than our POS')::text,
  'the latest reason is on the subscription'
);
select is(
  (select after from public.audit_logs
   where restaurant_id = :'rest_b' and action = 'subscription.cancel_reason'),
  '{"reason": "too_expensive", "detail": "Costs more than our POS"}'::jsonb,
  'and in the audit log'
);

select * from finish();
rollback;
