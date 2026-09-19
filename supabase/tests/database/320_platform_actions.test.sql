-- Platform actions: suspend and unsuspend, extend trial, change plan, manual
-- payment, owner password reset (spec §9.3, §13.4, §14.5, docs/DECISIONS.md
-- P7-4), and the onboarding input checks (P7-9).
begin;
select no_plan();

select tests.create_platform_admin('platform@admin.test') as admin \gset
select tests.create_restaurant('alpha') as rest_a \gset
select tests.create_restaurant('beta') as rest_b \gset
select tests.add_member(:'rest_a', 'owner', 'a_owner') as a_owner \gset
select tests.add_member(:'rest_a', 'manager', 'a_manager') as a_manager \gset
update public.restaurants set require_first_order_approval = false where id = :'rest_a';
select tests.create_ordering_fixture(:'rest_a', 'ALPHA0000TABLE05') as fx \gset
select tests.member_id(:'a_owner') as a_owner_member \gset
select tests.member_id(:'a_manager') as a_manager_member \gset

-- A table eating when the restaurant is suspended.
select tests.as_service_role();
select public.customer_place_order(
  'ALPHA0000TABLE05', gen_random_uuid()::text, 'before-suspension-1',
  jsonb_build_array(tests.line((:'fx'::jsonb ->> 'simple')::uuid))
) ->> 'order_id' as order_1 \gset
select tests.clear_auth();
select session_id as session_1 from public.orders where id = :'order_1' \gset

-- ─── Suspend and unsuspend ──────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select throws_ok(
  format($f$select public.platform_set_restaurant_status(%L, 'suspended', '  ')$f$, :'rest_a'),
  'P0001', 'REASON_REQUIRED', 'suspending needs a reason'
);
select is(
  public.platform_set_restaurant_status(:'rest_a', 'suspended', '  Unpaid  setup fee '),
  '{"status": "suspended", "suspended_reason": "Unpaid setup fee"}'::jsonb,
  'suspended, with the reason tidied'
);
select is(
  (select state || '/' || reason from public.restaurant_access(:'rest_a')),
  'read_only/suspended', 'a suspended restaurant is read-only'
);

select tests.clear_auth();
select tests.as_service_role();
select throws_ok(
  format(
    $f$select public.customer_place_order('ALPHA0000TABLE05', gen_random_uuid()::text, 'after-suspension-1', %L::jsonb)$f$,
    jsonb_build_array(tests.line((:'fx'::jsonb ->> 'simple')::uuid))
  ),
  'P0001', 'ORDERING_UNAVAILABLE', 'customers can no longer order'
);
select tests.clear_auth();

select tests.authenticate_as(:'a_owner');
select ok(
  (public.admin_generate_bill(:'session_1', 'none', 0, null, false) ->> 'bill_id') is not null,
  'the table already eating can still be billed'
);

select tests.authenticate_as_platform_admin(:'admin');
select is(
  public.platform_set_restaurant_status(:'rest_a', 'active', null),
  '{"status": "active", "suspended_reason": null}'::jsonb,
  'unsuspended'
);
select is(
  (select state from public.restaurant_access(:'rest_a')), 'full', 'full access again'
);
select is(
  public.platform_set_restaurant_status(:'rest_a', 'active', null),
  '{"status": "active", "suspended_reason": null}'::jsonb,
  'bringing back an active restaurant changes nothing'
);
select is(
  (select array_agg(action order by created_at, action) from public.audit_logs
   where restaurant_id = :'rest_a' and action like 'restaurant.%suspended'),
  array['restaurant.suspended', 'restaurant.unsuspended'],
  'suspend and unsuspend are audited once each'
);
select is(
  (select actor_type::text || '/' || actor_label || '/' || reason from public.audit_logs
   where restaurant_id = :'rest_a' and action = 'restaurant.suspended'),
  'platform_admin/Platform admin/Unpaid setup fee',
  'audited as the platform admin, with the reason'
);
select throws_ok(
  format($f$select public.platform_set_restaurant_status(%L, 'closed', null)$f$, :'rest_a'),
  'P0001', 'INVALID_INPUT', 'unknown status'
);

-- ─── Extend trial ───────────────────────────────────────────────────────────
select trial_ends_at as trial_before from public.restaurant_subscriptions
  where restaurant_id = :'rest_a' \gset
select is(
  (public.platform_extend_trial(:'rest_a', 7) ->> 'trial_ends_at')::timestamptz,
  :'trial_before'::timestamptz + interval '7 days',
  'a running trial is extended from its end'
);
select tests.clear_auth();
update public.restaurant_subscriptions set trial_ends_at = now() - interval '5 days'
  where restaurant_id = :'rest_b';
select tests.authenticate_as_platform_admin(:'admin');
select is(
  (public.platform_extend_trial(:'rest_b', 10) ->> 'trial_ends_at')::timestamptz,
  now() + interval '10 days',
  'an ended trial is extended from now'
);
select is(
  (select state from public.restaurant_access(:'rest_b')), 'full', 'which restores full access'
);
select throws_ok(
  format('select public.platform_extend_trial(%L, 0)', :'rest_a'),
  'P0001', 'INVALID_INPUT', 'at least one day'
);
select throws_ok(
  format('select public.platform_extend_trial(%L, 91)', :'rest_a'),
  'P0001', 'INVALID_INPUT', 'at most 90 days'
);

-- ─── Change plan ────────────────────────────────────────────────────────────
select tests.clear_auth();
insert into public.dining_tables (restaurant_id, label, qr_token)
select :'rest_a', 'Extra ' || n, 'ALPHAEXTRA' || lpad(n::text, 6, '0') from generate_series(1, 9) as n;
select tests.authenticate_as_platform_admin(:'admin');
select is(
  public.platform_change_plan(:'rest_a', 'starter'),
  '{"plan_code": "starter", "plan_name": "Starter"}'::jsonb,
  'moved to Starter'
);
select tests.clear_auth();
select is(
  (select count(*) from public.dining_tables where restaurant_id = :'rest_a' and is_active),
  10::bigint, 'tables over the new limit stay active'
);
select tests.authenticate_as_platform_admin(:'admin');
select is(
  (select plan_code from public.restaurant_plan(:'rest_a')), 'starter', 'the plan changed'
);
select is(
  (select after ->> 'plan_code' from public.audit_logs
   where restaurant_id = :'rest_a' and action = 'subscription.plan_changed'),
  'starter', 'plan change audited'
);
select throws_ok(
  format($f$select public.platform_change_plan(%L, 'gold')$f$, :'rest_a'),
  'P0001', 'PLAN_NOT_FOUND', 'unknown plan'
);
select tests.clear_auth();
update public.plans set is_active = false where code = 'pro';
select tests.authenticate_as_platform_admin(:'admin');
select throws_ok(
  format($f$select public.platform_change_plan(%L, 'pro')$f$, :'rest_a'),
  'P0001', 'PLAN_INACTIVE', 'inactive plans are not offered'
);

-- ─── Manual payment ─────────────────────────────────────────────────────────
-- beta's payment failed and it is in grace.
select tests.clear_auth();
update public.restaurant_subscriptions
  set status = 'past_due', source = 'manual', billing_cycle = 'monthly',
      current_period_start = '2026-08-01 04:00+05:30', current_period_end = '2026-09-01 04:00+05:30',
      grace_until = now() + interval '3 days'
  where restaurant_id = :'rest_b';
select tests.authenticate_as_platform_admin(:'admin');

select public.platform_record_manual_payment(:'rest_b', '{
  "amount_paise": 89900, "mode": "upi", "billing_cycle": "monthly",
  "period_start": "2026-09-01", "period_end": "2026-09-30", "notes": "UTR 1234"
}') as paid \gset
select is(:'paid'::jsonb ->> 'status', 'active', 'the subscription is active again');
select is(:'paid'::jsonb ->> 'extended', 'true', 'the payment moved the period forward');
select is(
  (:'paid'::jsonb ->> 'current_period_end')::timestamptz,
  '2026-10-01 04:00+05:30'::timestamptz,
  'paid until the business day after the end date starts (end date inclusive)'
);
select is(
  (select row(source, billing_cycle, grace_until, cancel_at_period_end, current_period_start)::text
   from public.restaurant_subscriptions where restaurant_id = :'rest_b'),
  row('manual', 'monthly', null::timestamptz, false, '2026-09-01 04:00+05:30'::timestamptz)::text,
  'manual source, cycle kept, grace cleared'
);
select is(
  (select row(source, amount_paise, manual_mode, period_start, period_end, notes, recorded_by)::text
   from public.subscription_payments where id = (:'paid'::jsonb ->> 'payment_id')::uuid),
  row('manual', 89900, 'upi', '2026-09-01 04:00+05:30'::timestamptz,
      '2026-10-01 04:00+05:30'::timestamptz, 'UTR 1234', :'admin'::uuid)::text,
  'the payment row'
);

-- An older period doesn't shorten access.
select is(
  (public.platform_record_manual_payment(:'rest_b', '{
    "amount_paise": 89900, "mode": "cash", "billing_cycle": "monthly",
    "period_start": "2026-08-01", "period_end": "2026-08-31"
  }') ->> 'current_period_end')::timestamptz,
  '2026-10-01 04:00+05:30'::timestamptz,
  'a payment for an earlier period keeps the later end'
);

-- A month paid inside a long trial doesn't cut the trial short.
select tests.clear_auth();
select tests.create_restaurant('kappa') as rest_k \gset
update public.restaurant_subscriptions set trial_ends_at = now() + interval '60 days'
  where restaurant_id = :'rest_k';
select tests.authenticate_as_platform_admin(:'admin');
select is(
  public.platform_record_manual_payment(:'rest_k', jsonb_build_object(
    'amount_paise', 89900, 'mode', 'upi', 'billing_cycle', 'monthly',
    'period_start', current_date::text, 'period_end', (current_date + 29)::text
  )) ->> 'extended',
  'false', 'a month inside a 60-day trial extends nothing'
);
select tests.clear_auth();
select is(
  (select row(status, trial_ends_at, source, billing_cycle)::text
   from public.restaurant_subscriptions where restaurant_id = :'rest_k'),
  row('trialing', now() + interval '60 days', null::text, null::text)::text,
  'the trial runs on unchanged'
);
select is(
  (select count(*) from public.subscription_payments where restaurant_id = :'rest_k'),
  1::bigint, 'the payment is still recorded'
);

-- Arrears paid during grace keep the grace period.
select tests.create_restaurant('lambda') as rest_l \gset
update public.restaurant_subscriptions
  set status = 'past_due', source = 'manual', billing_cycle = 'monthly',
      current_period_start = now() - interval '35 days', current_period_end = now() - interval '5 days',
      grace_until = now() + interval '3 days'
  where restaurant_id = :'rest_l';
select tests.authenticate_as_platform_admin(:'admin');
select is(
  public.platform_record_manual_payment(:'rest_l', jsonb_build_object(
    'amount_paise', 89900, 'mode', 'cash', 'billing_cycle', 'monthly',
    'period_start', (current_date - 70)::text, 'period_end', (current_date - 41)::text
  )) ->> 'extended',
  'false', 'an arrears payment for an old month extends nothing'
);
select is(
  (select state from public.restaurant_access(:'rest_l')), 'full',
  'still open during grace'
);
select tests.clear_auth();
select is(
  (select row(status, grace_until)::text from public.restaurant_subscriptions where restaurant_id = :'rest_l'),
  row('past_due', now() + interval '3 days')::text,
  'still past due, grace kept'
);
select tests.authenticate_as_platform_admin(:'admin');

-- A yearly payment on a trial.
select is(
  public.platform_record_manual_payment(:'rest_a', jsonb_build_object(
    'amount_paise', 399000, 'mode', 'bank_transfer', 'billing_cycle', 'yearly',
    'period_start', current_date::text, 'period_end', (current_date + 364)::text
  )) ->> 'status',
  'active', 'a trial becomes a paid subscription'
);
select is(
  (select billing_cycle::text from public.restaurant_subscriptions where restaurant_id = :'rest_a'),
  'yearly', 'yearly cycle'
);
select is(
  (select count(*) from public.audit_logs
   where restaurant_id in (:'rest_a', :'rest_b') and action = 'subscription.payment_recorded'),
  3::bigint, 'each payment is audited'
);

select throws_ok(
  format($f$select public.platform_record_manual_payment(%L, '{
    "amount_paise": 89900, "mode": "upi", "billing_cycle": "monthly",
    "period_start": "2026-09-30", "period_end": "2026-09-01"}')$f$, :'rest_b'),
  'P0001', 'INVALID_PERIOD', 'the end must not be before the start'
);
select throws_ok(
  format($f$select public.platform_record_manual_payment(%L, '{
    "amount_paise": 0, "mode": "upi", "billing_cycle": "monthly",
    "period_start": "2026-09-01", "period_end": "2026-09-30"}')$f$, :'rest_b'),
  'P0001', 'INVALID_INPUT', 'the amount must be positive'
);
select throws_ok(
  format($f$select public.platform_record_manual_payment(%L, '{
    "amount_paise": 100, "mode": "crypto", "billing_cycle": "monthly",
    "period_start": "2026-09-01", "period_end": "2026-09-30"}')$f$, :'rest_b'),
  'P0001', 'INVALID_INPUT', 'unknown payment mode'
);
select throws_ok(
  format($f$select public.platform_record_manual_payment(%L, '{
    "amount_paise": 100, "mode": "upi", "billing_cycle": "monthly",
    "period_start": "2026-09-01", "period_end": "2026-09-30", "extra": 1}')$f$, :'rest_b'),
  'P0001', 'INVALID_INPUT', 'unknown keys'
);

-- A suspended restaurant stays suspended after paying.
select public.platform_set_restaurant_status(:'rest_b', 'suspended', 'Fraud check');
select public.platform_record_manual_payment(:'rest_b', '{
  "amount_paise": 89900, "mode": "upi", "billing_cycle": "monthly",
  "period_start": "2026-10-01", "period_end": "2026-10-31"}');
select is(
  (select status::text from public.restaurants where id = :'rest_b'), 'suspended',
  'paying does not lift a suspension'
);

-- ─── Owner password reset ───────────────────────────────────────────────────
select is(
  public.platform_reset_owner_password(:'a_owner_member'), :'a_owner'::uuid,
  'returns the owner login to update'
);
select is(
  (select actor_type::text from public.audit_logs
   where restaurant_id = :'rest_a' and action = 'staff.password_reset'),
  'platform_admin', 'password reset audited'
);
select throws_ok(
  format('select public.platform_reset_owner_password(%L)', :'a_manager_member'),
  'P0001', 'MEMBER_NOT_FOUND', 'only owners, from here'
);

-- ─── Who may act ────────────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin', 'aal1');
select throws_ok(
  format($f$select public.platform_set_restaurant_status(%L, 'suspended', 'x')$f$, :'rest_a'),
  'P0001', 'MFA_REQUIRED', 'password only: no actions'
);
select tests.authenticate_as(:'a_owner');
select throws_ok(
  format('select public.platform_extend_trial(%L, 7)', :'rest_a'),
  'P0001', 'FORBIDDEN', 'owners cannot extend their own trial'
);
select throws_ok(
  format($f$select public.platform_change_plan(%L, 'growth')$f$, :'rest_a'),
  'P0001', 'FORBIDDEN', 'owners cannot change their own plan'
);

-- ─── Onboarding input checks ────────────────────────────────────────────────
select tests.clear_auth();
select tests.create_user('new-owner@example.test') as new_owner \gset
select tests.as_service_role();
select throws_ok(
  format($f$select public.platform_create_restaurant(%L::jsonb)$f$, jsonb_build_object(
    'name', 'Gamma', 'slug', 'gamma', 'trial_days', -3,
    'owner', jsonb_build_object('user_id', :'new_owner', 'display_name', 'Gia', 'username', 'gia')
  )),
  'P0001', 'INVALID_INPUT', 'a negative trial is refused'
);
select throws_ok(
  format($f$select public.platform_create_restaurant(%L::jsonb)$f$, jsonb_build_object(
    'name', 'Gamma', 'slug', 'gamma', 'trial_days', '14',
    'owner', jsonb_build_object('user_id', :'new_owner', 'display_name', 'Gia', 'username', 'gia')
  )),
  'P0001', 'INVALID_INPUT', 'trial days must be a number'
);
select throws_ok(
  format($f$select public.platform_create_restaurant(%L::jsonb)$f$, jsonb_build_object(
    'name', 'Gamma', 'slug', 'gamma', 'gst_mode', 'vat',
    'owner', jsonb_build_object('user_id', :'new_owner', 'display_name', 'Gia', 'username', 'gia')
  )),
  'P0001', 'INVALID_INPUT', 'unknown GST mode'
);
select public.platform_create_restaurant(jsonb_build_object(
  'name', 'Gamma', 'slug', 'gamma', 'trial_days', 30, 'gst_mode', 'regular', 'gst_rate_bps', 500,
  'prices_include_tax', true,
  'owner', jsonb_build_object('user_id', :'new_owner', 'display_name', 'Gia', 'username', 'gia')
)) ->> 'restaurant_id' as rest_g \gset
select is(
  (select trial_ends_at from public.restaurant_subscriptions where restaurant_id = :'rest_g'),
  now() + interval '30 days',
  'the wizard''s trial length is used'
);

select tests.clear_auth();
select * from finish();
rollback;
