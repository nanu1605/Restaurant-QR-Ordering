-- restaurant_access(): every branch of spec §10.6, evaluated at fixed instants.
-- Restaurant timezone Asia/Kolkata, business day starts at 04:00.
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

select tests.create_restaurant('access') as rest \gset

create temp table access_result (state text, reason text, restriction_at timestamptz, warning text);

-- Returns (state, reason, restriction_at, warning) at p_at as a row for results_eq.
create function pg_temp.access_at(p_restaurant uuid, p_at timestamptz)
returns table (state text, reason text, restriction_at timestamptz, warning text)
language sql
as $$ select * from public.restaurant_access(p_restaurant, p_at) $$;

-- ─── Business-day helpers ───────────────────────────────────────────────────
select is(
  private.business_day_start('2026-09-12 01:30+05:30', 'Asia/Kolkata', 4),
  '2026-09-11 04:00+05:30'::timestamptz,
  '01:30 belongs to the previous business day'
);
select is(
  private.business_day_start('2026-09-12 04:00+05:30', 'Asia/Kolkata', 4),
  '2026-09-12 04:00+05:30'::timestamptz,
  '04:00 starts a new business day'
);
select is(
  private.next_business_day_start('2026-09-15 23:00+05:30', 'Asia/Kolkata', 4),
  '2026-09-16 04:00+05:30'::timestamptz,
  'next day start after a late-night lapse'
);
select is(
  private.next_business_day_start('2026-09-16 02:00+05:30', 'Asia/Kolkata', 4),
  '2026-09-16 04:00+05:30'::timestamptz,
  'lapse before 04:00 restricts from 04:00 the same morning'
);
select is(
  private.next_business_day_start('2026-09-16 04:00+05:30', 'Asia/Kolkata', 4),
  '2026-09-16 04:00+05:30'::timestamptz,
  'lapse exactly at day start restricts immediately'
);

-- ─── Trialing: trial ends 15 Sep 23:00 → restricted from 16 Sep 04:00 ───────
update public.restaurant_subscriptions
set status = 'trialing', trial_ends_at = '2026-09-15 23:00+05:30'
where restaurant_id = :'rest';

select results_eq(
  format($f$select * from pg_temp.access_at(%L, '2026-09-10 12:00+05:30')$f$, :'rest'),
  $$ values ('full', null::text, '2026-09-16 04:00+05:30'::timestamptz, null::text) $$,
  'trial far from ending: full access, no warning'
);
select results_eq(
  format($f$select * from pg_temp.access_at(%L, '2026-09-14 12:00+05:30')$f$, :'rest'),
  $$ values ('full', null::text, '2026-09-16 04:00+05:30'::timestamptz, 'trial_ends_soon') $$,
  'trial within 3 days of restriction: warning'
);
select results_eq(
  format($f$select * from pg_temp.access_at(%L, '2026-09-16 01:00+05:30')$f$, :'rest'),
  $$ values ('full', null::text, '2026-09-16 04:00+05:30'::timestamptz, 'trial_ends_soon') $$,
  'trial ended at 23:00 but service continues until the 04:00 day start'
);
select results_eq(
  format($f$select * from pg_temp.access_at(%L, '2026-09-16 04:00+05:30')$f$, :'rest'),
  $$ values ('read_only', 'trial_ended', '2026-09-16 04:00+05:30'::timestamptz, null::text) $$,
  'trial lapsed: read-only from the next business-day start'
);

-- ─── Active: period ends 20 Sep 10:00, +2 days buffer → restricted 23 Sep 04:00
update public.restaurant_subscriptions
set status = 'active', trial_ends_at = null, source = 'razorpay', billing_cycle = 'monthly',
    current_period_start = '2026-08-20 10:00+05:30', current_period_end = '2026-09-20 10:00+05:30'
where restaurant_id = :'rest';

select results_eq(
  format($f$select * from pg_temp.access_at(%L, '2026-09-21 12:00+05:30')$f$, :'rest'),
  $$ values ('full', null::text, '2026-09-23 04:00+05:30'::timestamptz, null::text) $$,
  'active auto-renewing subscription: no warning inside the webhook buffer'
);
select results_eq(
  format($f$select * from pg_temp.access_at(%L, '2026-09-23 04:00+05:30')$f$, :'rest'),
  $$ values ('read_only', 'subscription_lapsed', '2026-09-23 04:00+05:30'::timestamptz, null::text) $$,
  'active subscription never renewed: read-only after buffer and day start'
);

update public.restaurant_subscriptions set cancel_at_period_end = true where restaurant_id = :'rest';
select results_eq(
  format($f$select * from pg_temp.access_at(%L, '2026-09-21 12:00+05:30')$f$, :'rest'),
  $$ values ('full', null::text, '2026-09-23 04:00+05:30'::timestamptz, 'subscription_ends_soon') $$,
  'subscription set to cancel at period end: warning'
);

-- ─── Past due / halted: grace until 25 Sep 12:00 → restricted 26 Sep 04:00 ──
update public.restaurant_subscriptions
set status = 'past_due', cancel_at_period_end = false, grace_until = '2026-09-25 12:00+05:30'
where restaurant_id = :'rest';

select results_eq(
  format($f$select * from pg_temp.access_at(%L, '2026-09-21 12:00+05:30')$f$, :'rest'),
  $$ values ('full', null::text, '2026-09-26 04:00+05:30'::timestamptz, 'payment_failed') $$,
  'past due in grace: full access with payment warning'
);
select results_eq(
  format($f$select * from pg_temp.access_at(%L, '2026-09-26 05:00+05:30')$f$, :'rest'),
  $$ values ('read_only', 'payment_failed', '2026-09-26 04:00+05:30'::timestamptz, null::text) $$,
  'past due after grace: read-only'
);

update public.restaurant_subscriptions set status = 'halted' where restaurant_id = :'rest';
select results_eq(
  format($f$select * from pg_temp.access_at(%L, '2026-09-24 12:00+05:30')$f$, :'rest'),
  $$ values ('full', null::text, '2026-09-26 04:00+05:30'::timestamptz, 'payment_failed') $$,
  'halted keeps the existing grace period'
);

-- ─── Cancelled / expired ────────────────────────────────────────────────────
update public.restaurant_subscriptions set status = 'cancelled', grace_until = null
where restaurant_id = :'rest';
select results_eq(
  format($f$select * from pg_temp.access_at(%L, '2026-09-19 12:00+05:30')$f$, :'rest'),
  $$ values ('full', null::text, '2026-09-21 04:00+05:30'::timestamptz, 'subscription_ends_soon') $$,
  'cancelled: access until the paid period ends (no buffer)'
);
select results_eq(
  format($f$select * from pg_temp.access_at(%L, '2026-09-21 04:00+05:30')$f$, :'rest'),
  $$ values ('read_only', 'subscription_ended', '2026-09-21 04:00+05:30'::timestamptz, null::text) $$,
  'cancelled: read-only after the period'
);

update public.restaurant_subscriptions
set status = 'expired', current_period_start = null, current_period_end = null,
    trial_ends_at = '2026-09-01 12:00+05:30'
where restaurant_id = :'rest';
select results_eq(
  format($f$select * from pg_temp.access_at(%L, '2026-09-10 12:00+05:30')$f$, :'rest'),
  $$ values ('read_only', 'subscription_ended', '2026-09-02 04:00+05:30'::timestamptz, null::text) $$,
  'expired without ever paying: falls back to the trial end'
);

-- ─── Suspended and missing subscription ─────────────────────────────────────
update public.restaurant_subscriptions
set status = 'trialing', trial_ends_at = '2026-12-31 12:00+05:30'
where restaurant_id = :'rest';
update public.restaurants set status = 'suspended', suspended_reason = 'Fraud check'
where id = :'rest';
select results_eq(
  format($f$select * from pg_temp.access_at(%L, '2026-09-10 12:00+05:30')$f$, :'rest'),
  $$ values ('read_only', 'suspended', null::timestamptz, null::text) $$,
  'suspended restaurant is read-only regardless of subscription'
);

update public.restaurants set status = 'active', suspended_reason = null where id = :'rest';
delete from public.restaurant_subscriptions where restaurant_id = :'rest';
select results_eq(
  format($f$select * from pg_temp.access_at(%L, '2026-09-10 12:00+05:30')$f$, :'rest'),
  $$ values ('read_only', 'no_subscription', null::timestamptz, null::text) $$,
  'restaurant without a subscription is read-only'
);

-- ─── Who may ask ────────────────────────────────────────────────────────────
select tests.create_restaurant('elsewhere') as other \gset
select tests.add_member(:'rest', 'waiter', 'own_waiter') as own_waiter \gset
select tests.add_member(:'other', 'manager', 'other_manager') as other_manager \gset

select tests.authenticate_as(:'own_waiter');
select lives_ok(
  format($f$select * from public.restaurant_access(%L)$f$, :'rest'),
  'members can read their restaurant''s access state'
);

select tests.authenticate_as(:'other_manager');
select throws_ok(
  format($f$select * from public.restaurant_access(%L)$f$, :'rest'),
  'P0001',
  'FORBIDDEN',
  'members of another restaurant cannot'
);

select tests.clear_auth();

select * from finish();

rollback;
