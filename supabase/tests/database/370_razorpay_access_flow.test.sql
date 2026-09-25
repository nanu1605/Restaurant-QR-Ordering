-- Access through a Razorpay subscription's life (spec §10.6, §19 Phase 8
-- tests, docs/DECISIONS.md P8-8): trial → autopay set up → charged → payment
-- failed → grace → read-only at the next business-day start → paid → full.
-- Asia/Kolkata, business day starts at 04:00.
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

select tests.create_restaurant('rzp-flow') as rest \gset

create function pg_temp.access_at(p_restaurant uuid, p_at text)
returns table (state text, reason text, restriction_at timestamptz, warning text)
language sql
as $$ select * from public.restaurant_access(p_restaurant, (p_at || '+05:30')::timestamptz) $$;

create function pg_temp.event(
  p_event text, p_status text, p_created text,
  p_start text default null, p_end text default null, p_payment_id text default null
)
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'event', p_event,
    'created_at', extract(epoch from (p_created || '+05:30')::timestamptz)::bigint,
    'payload', jsonb_build_object(
      'subscription', jsonb_build_object('entity', jsonb_strip_nulls(jsonb_build_object(
        'id', 'sub_Flow1', 'status', p_status,
        'current_start', extract(epoch from (p_start || '+05:30')::timestamptz)::bigint,
        'current_end', extract(epoch from (p_end || '+05:30')::timestamptz)::bigint
      )))
    ) || case when p_payment_id is not null then jsonb_build_object(
      'payment', jsonb_build_object('entity', jsonb_build_object('id', p_payment_id, 'amount', 89900))
    ) else '{}'::jsonb end
  );
$$;

update public.restaurant_subscriptions
  set trial_ends_at = '2026-10-10 15:00+05:30'
  where restaurant_id = :'rest';

select tests.as_service_role();

-- ─── Trial without autopay ──────────────────────────────────────────────────
select results_eq(
  format($f$select * from pg_temp.access_at(%L, '2026-10-08 12:00')$f$, :'rest'),
  $$ values ('full', null::text, '2026-10-11 04:00+05:30'::timestamptz, 'trial_ends_soon') $$,
  'a trial without autopay warns it ends soon'
);

-- ─── Autopay set up for the trial's end ─────────────────────────────────────
select public.razorpay_save_subscription(
  :'rest',
  jsonb_build_object('id', 'sub_Flow1', 'status', 'authenticated',
    'notes', jsonb_build_object('restaurant_id', :'rest', 'plan_code', 'growth', 'billing_cycle', 'monthly'))
);
select results_eq(
  format($f$select * from pg_temp.access_at(%L, '2026-10-08 12:00')$f$, :'rest'),
  $$ values ('full', null::text, '2026-10-13 04:00+05:30'::timestamptz, null::text) $$,
  'with autopay set up: no warning, and 2 days for the first charge to arrive'
);

-- ─── First charge at the trial's end ────────────────────────────────────────
select public.razorpay_record_webhook(
  'flow_1', pg_temp.event('subscription.charged', 'active', '2026-10-10 15:01',
                          '2026-10-10 15:00', '2026-11-10 15:00', 'pay_Flow1')
);
select results_eq(
  format($f$select * from pg_temp.access_at(%L, '2026-11-01 12:00')$f$, :'rest'),
  $$ values ('full', null::text, '2026-11-13 04:00+05:30'::timestamptz, null::text) $$,
  'paid: full access, renewing, no warning'
);

-- ─── Renewal fails: grace, then read-only at the next business-day start ────
select public.razorpay_record_webhook(
  'flow_2', pg_temp.event('subscription.pending', 'pending', '2026-11-10 15:05')
);
select results_eq(
  format($f$select * from pg_temp.access_at(%L, '2026-11-12 12:00')$f$, :'rest'),
  $$ values ('full', null::text, '2026-11-18 04:00+05:30'::timestamptz, 'payment_failed') $$,
  'payment failed: full access during grace, with a warning'
);
select public.razorpay_record_webhook(
  'flow_3', pg_temp.event('subscription.halted', 'halted', '2026-11-14 15:05')
);
select results_eq(
  format($f$select * from pg_temp.access_at(%L, '2026-11-18 03:59')$f$, :'rest'),
  $$ values ('full', null::text, '2026-11-18 04:00+05:30'::timestamptz, 'payment_failed') $$,
  'halted: still full through the night service'
);
select results_eq(
  format($f$select * from pg_temp.access_at(%L, '2026-11-18 04:00')$f$, :'rest'),
  $$ values ('read_only', 'payment_failed', '2026-11-18 04:00+05:30'::timestamptz, null::text) $$,
  'read-only from the next business-day start after grace'
);

-- ─── Paying restores full access ────────────────────────────────────────────
select public.razorpay_record_webhook(
  'flow_4', pg_temp.event('subscription.charged', 'active', '2026-11-19 10:00',
                          '2026-11-19 10:00', '2026-12-19 10:00', 'pay_Flow2')
);
select results_eq(
  format($f$select * from pg_temp.access_at(%L, '2026-11-19 12:00')$f$, :'rest'),
  $$ values ('full', null::text, '2026-12-22 04:00+05:30'::timestamptz, null::text) $$,
  'paid again: full access straight away'
);

-- ─── Cancelled at period end ────────────────────────────────────────────────
update public.restaurant_subscriptions set cancel_at_period_end = true where restaurant_id = :'rest';
select results_eq(
  format($f$select * from pg_temp.access_at(%L, '2026-12-20 12:00')$f$, :'rest'),
  $$ values ('full', null::text, '2026-12-22 04:00+05:30'::timestamptz, 'subscription_ends_soon') $$,
  'set to end: warns before the period ends'
);
select public.razorpay_record_webhook(
  'flow_5', pg_temp.event('subscription.cancelled', 'cancelled', '2026-12-19 10:00')
);
select results_eq(
  format($f$select * from pg_temp.access_at(%L, '2026-12-19 12:00')$f$, :'rest'),
  $$ values ('full', null::text, '2026-12-20 04:00+05:30'::timestamptz, 'subscription_ends_soon') $$,
  'cancelled: full until the paid period ends'
);
select results_eq(
  format($f$select * from pg_temp.access_at(%L, '2026-12-20 04:00')$f$, :'rest'),
  $$ values ('read_only', 'subscription_ended', '2026-12-20 04:00+05:30'::timestamptz, null::text) $$,
  'then read-only from the next business-day start'
);

select * from finish();
rollback;
