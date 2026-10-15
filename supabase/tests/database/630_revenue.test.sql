-- Revenue analytics (docs/SUPER_ADMIN_PLAN.md 13f, docs/DECISIONS.md SA-65+):
-- MRR movement from the nightly snapshots and today live, churn, recovery,
-- cash collected, trial cohorts, cancellation reasons and the launch offer.
begin;
select no_plan();

select tests.create_user('sa630-owner@example.test') as owner_user \gset
select tests.create_platform_admin('sa630-platform@example.test') as admin \gset

-- ─── Fixtures: March 2020, before any other night ───────────────────────────
-- A new; B churns, comes back and churns again; C expands on the 18th, a
-- night that is missing; D contracts; E fails a charge and pays again; F fails
-- and goes read-only; G fails and is still failing; H paid before history and
-- comes back; I is new, leaves and comes back.
select tests.create_restaurant('sa630-a') as a \gset
select tests.create_restaurant('sa630-b') as b \gset
select tests.create_restaurant('sa630-c') as c \gset
select tests.create_restaurant('sa630-d') as d \gset
select tests.create_restaurant('sa630-e') as e \gset
select tests.create_restaurant('sa630-f') as f \gset
select tests.create_restaurant('sa630-g') as g \gset
select tests.create_restaurant('sa630-h') as h \gset
select tests.create_restaurant('sa630-i') as i \gset

insert into public.metrics_subscription_daily (
  day, restaurant_id, state, plan_id, billing_cycle, mrr_paise
)
select s.day::date, x.rid, x.state, p.id, x.cycle::public.billing_cycle, x.mrr
from (values
  (:'a'::uuid, date '2020-03-01', date '2020-03-04', 'trial', 'growth', null, 0),
  (:'a'::uuid, date '2020-03-05', date '2020-03-31', 'paid', 'growth', 'monthly', 89900),
  (:'b'::uuid, date '2020-03-01', date '2020-03-09', 'paid', 'starter', 'monthly', 39900),
  (:'b'::uuid, date '2020-03-10', date '2020-03-19', 'cancelled', 'starter', null, 0),
  (:'b'::uuid, date '2020-03-20', date '2020-03-27', 'paid', 'starter', 'monthly', 39900),
  (:'b'::uuid, date '2020-03-28', date '2020-03-31', 'cancelled', 'starter', null, 0),
  (:'c'::uuid, date '2020-03-01', date '2020-03-17', 'paid', 'starter', 'monthly', 39900),
  (:'c'::uuid, date '2020-03-18', date '2020-03-31', 'paid', 'growth', 'monthly', 89900),
  (:'d'::uuid, date '2020-03-01', date '2020-03-19', 'paid', 'pro', 'monthly', 179900),
  (:'d'::uuid, date '2020-03-20', date '2020-03-31', 'paid', 'growth', 'monthly', 89900),
  (:'e'::uuid, date '2020-03-01', date '2020-03-07', 'paid', 'growth', 'yearly', 89900),
  (:'e'::uuid, date '2020-03-08', date '2020-03-10', 'payment_failed', 'growth', 'yearly', 0),
  (:'e'::uuid, date '2020-03-11', date '2020-03-31', 'paid', 'growth', 'yearly', 89900),
  (:'f'::uuid, date '2020-03-01', date '2020-03-11', 'paid', 'starter', 'monthly', 39900),
  (:'f'::uuid, date '2020-03-12', date '2020-03-15', 'payment_failed', 'starter', 'monthly', 0),
  (:'f'::uuid, date '2020-03-16', date '2020-03-31', 'read_only', 'starter', null, 0),
  (:'g'::uuid, date '2020-03-01', date '2020-03-24', 'paid', 'starter', 'monthly', 39900),
  (:'g'::uuid, date '2020-03-25', date '2020-03-31', 'payment_failed', 'starter', 'monthly', 0),
  (:'h'::uuid, date '2020-03-01', date '2020-03-04', 'cancelled', 'starter', null, 0),
  (:'h'::uuid, date '2020-03-05', date '2020-03-31', 'paid', 'starter', 'monthly', 39900),
  (:'i'::uuid, date '2020-03-01', date '2020-03-05', 'trial', 'starter', null, 0),
  (:'i'::uuid, date '2020-03-06', date '2020-03-09', 'paid', 'starter', 'monthly', 39900),
  (:'i'::uuid, date '2020-03-10', date '2020-03-19', 'cancelled', 'starter', null, 0),
  (:'i'::uuid, date '2020-03-20', date '2020-03-31', 'paid', 'starter', 'monthly', 39900)
) as x(rid, first_day, last_day, state, plan, cycle, mrr)
join public.plans p on p.code = x.plan
cross join generate_series(x.first_day, x.last_day, interval '1 day') as s(day)
where s.day::date <> '2020-03-18';

-- G is still failing today; the others' today doesn't touch March.
update public.restaurant_subscriptions set
  status = 'past_due', source = 'razorpay', razorpay_subscription_id = 'sub_SA630g',
  razorpay_status = 'pending', billing_cycle = 'monthly',
  current_period_end = now() - interval '1 day', grace_until = now() + interval '3 days',
  trial_ends_at = null
where restaurant_id = :'g';

-- Trial cohorts: A and I paid two days in; J never paid; K paid after the
-- trial plus 30 days; L's trial was extended and it is still deciding.
select tests.create_restaurant('sa630-j') as j \gset
select tests.create_restaurant('sa630-k') as k \gset
select tests.create_restaurant('sa630-l') as l \gset
update public.restaurants r set created_at = x.at
from (values
  (:'a'::uuid, timestamptz '2020-03-03 10:00+05:30'),
  (:'i'::uuid, timestamptz '2020-03-04 10:00+05:30'),
  (:'j'::uuid, timestamptz '2020-03-20 10:00+05:30'),
  (:'k'::uuid, timestamptz '2020-03-25 10:00+05:30'),
  (:'l'::uuid, timestamptz '2020-03-28 10:00+05:30')
) as x(id, at)
where r.id = x.id;
update public.restaurant_subscriptions s set trial_ends_at = x.ends
from (values
  (:'a'::uuid, timestamptz '2020-03-17 10:00+05:30'),
  (:'i'::uuid, timestamptz '2020-03-18 10:00+05:30'),
  (:'j'::uuid, timestamptz '2020-04-03 10:00+05:30'),
  (:'k'::uuid, timestamptz '2020-04-08 10:00+05:30'),
  (:'l'::uuid, now() + interval '5 days')
) as x(id, ends)
where s.restaurant_id = x.id;

-- Payments by India date: three subscriptions and three setup fees in March
-- (with the offer, at the full fee, not recorded), and four outside it.
insert into public.subscription_payments (
  restaurant_id, source, manual_mode, amount_paise, purpose, list_price_paise, discount_paise,
  period_start, period_end, created_at
) values
  (:'a', 'manual', 'upi', private.fee_with_gst(89900), 'subscription', null, null,
   '2020-03-05 10:00+05:30', '2020-04-04 10:00+05:30', '2020-03-05 10:00+05:30'),
  (:'i', 'manual', 'upi', private.fee_with_gst(39900), 'subscription', null, null,
   '2020-03-06 10:00+05:30', '2020-04-05 10:00+05:30', '2020-03-06 10:00+05:30'),
  (:'k', 'manual', 'upi', private.fee_with_gst(89900), 'subscription', null, null,
   '2020-05-10 10:00+05:30', '2020-06-09 10:00+05:30', '2020-05-10 10:00+05:30'),
  (:'a', 'manual', 'upi', private.fee_with_gst(49900), 'setup_fee', 99900, 50000,
   null, null, '2020-03-05 11:00+05:30'),
  (:'c', 'manual', 'upi', private.fee_with_gst(99900), 'setup_fee', 99900, 0,
   null, null, '2020-03-01 00:10+05:30'),
  (:'d', 'manual', 'upi', private.fee_with_gst(50000), 'setup_fee', null, null,
   null, null, '2020-03-12 09:00+05:30'),
  (:'d', 'manual', 'upi', private.fee_with_gst(50000), 'setup_fee', null, null,
   null, null, '2020-02-29 23:50+05:30'),
  (:'h', 'manual', 'upi', private.fee_with_gst(39900), 'subscription', null, null,
   '2020-01-21 10:00+05:30', '2020-02-20 10:00+05:30', '2020-01-21 10:00+05:30');
insert into public.subscription_payments (
  restaurant_id, source, manual_mode, amount_paise, period_start, period_end, created_at
) values (:'i', 'manual', 'upi', private.fee_with_gst(39900), '2020-04-05 10:00+05:30',
  '2020-05-05 10:00+05:30', '2020-03-31 23:30+05:30'),
  (:'i', 'manual', 'upi', private.fee_with_gst(39900), '2020-05-05 10:00+05:30',
  '2020-06-04 10:00+05:30', '2020-04-01 00:10+05:30');

-- Why restaurants turned autopay off: three answers in March, one in April.
insert into public.audit_logs (restaurant_id, actor_type, actor_label, action, entity_type, after, created_at)
values
  (:'b', 'staff', 'Owner', 'subscription.cancel_reason', 'restaurant_subscription',
   '{"reason": "too_expensive"}', '2020-03-09 12:00+05:30'),
  (:'i', 'staff', 'Owner', 'subscription.cancel_reason', 'restaurant_subscription',
   '{"reason": "too_expensive"}', '2020-03-09 13:00+05:30'),
  (:'f', 'staff', 'Owner', 'subscription.cancel_reason', 'restaurant_subscription',
   '{"reason": "other", "detail": "Closing for repairs"}', '2020-03-31 23:59+05:30'),
  (:'g', 'staff', 'Owner', 'subscription.cancel_reason', 'restaurant_subscription',
   '{"reason": "closing"}', '2020-04-01 00:01+05:30');

-- ─── The bars' days ─────────────────────────────────────────────────────────
select is(
  array[
    private.revenue_bucket('2020-03-18', '2020-03-01', 'day'),
    private.revenue_bucket('2020-03-18', '2020-03-01', 'week'),
    private.revenue_bucket('2020-03-18', '2020-03-01', 'month'),
    private.revenue_bucket('2020-03-02', '2020-03-04', 'week'),
    private.revenue_bucket('2020-03-31', '2020-03-15', 'month')
  ],
  array['2020-03-18', '2020-03-16', '2020-03-01', '2020-03-04', '2020-03-15']::date[],
  'a day, its Monday or its month, never before the first date'
);

-- ─── March, by month ────────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_revenue_report('2020-03-01', '2020-03-31', 'month')::text as r \gset
select tests.clear_auth();

select is(:'r'::jsonb ->> 'history_starts_on', '2020-03-01', 'history starts with the first night');
select is(
  array[
    :'r'::jsonb #>> '{totals,opening_day}',
    :'r'::jsonb #>> '{totals,opening_mrr_paise}',
    :'r'::jsonb #>> '{totals,opening_paid}',
    :'r'::jsonb #>> '{totals,mrr_paise}',
    :'r'::jsonb #>> '{totals,paid}'
  ],
  array['2020-03-01', '429400', '6', '439400', '6'],
  'opening on the history''s first night; MRR and Paid at the end'
);
select is(
  :'r'::jsonb #> '{totals,movements}',
  '{"new": {"count": 2, "paise": 129800}, "reactivation": {"count": 4, "paise": 209600},
    "expansion": {"count": 1, "paise": 50000}, "contraction": {"count": 1, "paise": -90000},
    "churn": {"count": 6, "paise": -289400}}'::jsonb,
  'each movement: a failed charge is churn, paying again is reactivation, I is new once, H paid before history'
);
select is(
  (select sum((m.value ->> 'paise')::bigint) from jsonb_each(:'r'::jsonb #> '{totals,movements}') as m),
  439400::numeric - 429400,
  'the movements add up to the change in MRR'
);
select is(
  array[:'r'::jsonb #>> '{totals,churned}', :'r'::jsonb #>> '{totals,lost_paise}'],
  array['4', '299600'],
  'of the six Paid at the start, four churned (B once though twice); each lost at most its opening MRR'
);
select is(
  :'r'::jsonb #> '{totals,recovery}',
  '{"entered": 3, "recovered": 1, "still_failed": 1}'::jsonb,
  'of three failed charges, E paid again, F went read-only, G is still failing'
);
select is(
  :'r'::jsonb #> '{totals,collected}',
  jsonb_build_object(
    'subscription_base_paise', 89900 + 39900 + 39900,
    'setup_fee_base_paise', 49900 + 99900 + 50000,
    'gst_paise', (select sum(gst_paise) from public.subscription_payments
                  where restaurant_id in (:'a', :'c', :'d', :'i')
                    and created_at >= '2020-03-01 00:00+05:30'
                    and created_at < '2020-04-01 00:00+05:30'),
    'count', 6),
  'payments by India date, before GST, setup fees apart'
);
select is(
  :'r'::jsonb #> '{totals,conversion}',
  '{"created": 5, "converted": 2, "deciding": 1, "average_days": 2.0}'::jsonb,
  'A and I converted in two days; J never, K too late; L still deciding'
);
select is(
  :'r'::jsonb -> 'cohorts',
  '[{"start": "2020-03-01", "created": 5, "converted": 2, "deciding": 1, "average_days": 2.0}]'::jsonb,
  'one cohort for March'
);
select is(
  :'r'::jsonb -> 'reasons',
  '[{"reason": "too_expensive", "count": 2}, {"reason": "other", "count": 1}]'::jsonb,
  'cancellation reasons in the dates, most given first'
);
select is(
  :'r'::jsonb -> 'launch_offer',
  '{"setup_fees": 3, "with_offer": 1, "discount_paise": 50000, "full_price": 1, "not_recorded": 1}'::jsonb,
  'launch-offer use among March''s setup fees'
);
select is(
  :'r'::jsonb -> 'plan_mix',
  '[{"plan_code": "starter", "plan_name": "Starter", "billing_cycle": "monthly", "restaurants": 2, "mrr_paise": 79800},
    {"plan_code": "growth", "plan_name": "Growth", "billing_cycle": "monthly", "restaurants": 3, "mrr_paise": 269700},
    {"plan_code": "growth", "plan_name": "Growth", "billing_cycle": "yearly", "restaurants": 1, "mrr_paise": 89900}]'::jsonb,
  'Paid restaurants at the end by plan and cycle'
);
select is(:'r'::jsonb -> 'previous', 'null'::jsonb, 'no comparison unless asked');

-- ─── By day and by week ─────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_revenue_report('2020-03-01', '2020-03-31', 'day')::text as by_day \gset
select public.platform_revenue_report('2020-03-01', '2020-03-31', 'week')::text as by_week \gset
select tests.clear_auth();
select is(
  (select array[e ->> 'mrr_paise', e #>> '{movements,expansion,count}']
   from jsonb_array_elements(:'by_day'::jsonb -> 'series') as e where e ->> 'start' = '2020-03-18'),
  array['479400', '0'],
  'the missing 18th keeps the 17th''s MRR'
);
select is(
  (select e #>> '{movements,expansion,paise}'
   from jsonb_array_elements(:'by_day'::jsonb -> 'series') as e where e ->> 'start' = '2020-03-19'),
  '50000',
  'C''s upgrade counts on the next night there is'
);
select is(
  (select array_agg(e ->> 'start' order by e ->> 'start')
   from jsonb_array_elements(:'by_week'::jsonb -> 'series') as e),
  array['2020-03-01', '2020-03-02', '2020-03-09', '2020-03-16', '2020-03-23', '2020-03-30'],
  'weeks from Monday, the first from the first date'
);
select is(
  (select count(*)::int from (
     select (e ->> 'mrr_paise')::bigint - coalesce(
         lag((e ->> 'mrr_paise')::bigint) over (order by e ->> 'start'), 429400) as change,
       (select sum((m.value ->> 'paise')::bigint) from jsonb_each(e -> 'movements') as m) as moved
     from jsonb_array_elements(:'by_week'::jsonb -> 'series') as e
   ) as x where x.change <> x.moved),
  0,
  'every week''s movements add up to its change in MRR'
);

-- ─── Comparing, and history starting inside the dates ───────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_revenue_report('2020-03-17', '2020-03-31', 'week', true)::text as cmp \gset
select public.platform_revenue_report('2020-03-16', '2020-03-31', 'week', true)::text as cut \gset
select public.platform_revenue_report('2020-02-01', '2020-03-31', 'month')::text as early \gset
select tests.clear_auth();
select is(
  array[
    :'cmp'::jsonb ->> 'previous_from', :'cmp'::jsonb ->> 'previous_to',
    :'cmp'::jsonb #>> '{totals,opening_day}', :'cmp'::jsonb #>> '{previous,opening_day}',
    :'cmp'::jsonb #>> '{previous,mrr_paise}', :'cmp'::jsonb #>> '{totals,opening_mrr_paise}'
  ],
  array['2020-03-02', '2020-03-16', '2020-03-16', '2020-03-01', '479400', '479400'],
  'the same number of days before; it ends where this period opens'
);
select is(
  (select sum((m.value ->> 'paise')::bigint) from jsonb_each(:'cmp'::jsonb #> '{previous,movements}') as m)
    + (select sum((m.value ->> 'paise')::bigint) from jsonb_each(:'cmp'::jsonb #> '{totals,movements}') as m),
  439400::numeric - 429400,
  'the two periods'' movements make up the month'
);
select is(
  array[
    :'cut'::jsonb ->> 'previous_from', :'cut'::jsonb #>> '{previous,opening_day}',
    :'cut'::jsonb #>> '{previous,movements,churn,count}', :'cut'::jsonb #>> '{previous,churned}',
    :'cut'::jsonb #>> '{previous,recovery,entered}', :'cut'::jsonb #>> '{totals,opening_day}'
  ],
  array['2020-02-29', null, '0', '0', '0', '2020-03-15'],
  'a period before it that history doesn''t cover has no MRR figures to compare'
);
select is(
  array[
    (select e ->> 'mrr_paise' from jsonb_array_elements(:'early'::jsonb -> 'series') as e
     where e ->> 'start' = '2020-02-01'),
    :'early'::jsonb #>> '{totals,opening_day}'
  ],
  array[null, '2020-03-01'],
  'before history a bar has no MRR, and the opening is the first night'
);

-- ─── The restaurants behind a bar ───────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_revenue_movements('2020-03-01', '2020-03-31', 'churn')::text as churn \gset
select public.platform_revenue_movements('2020-03-19', '2020-03-19', 'expansion')::text as up \gset
select public.platform_revenue_movements('2020-03-11', '2020-03-31', 'churn')::text as late \gset
select public.platform_revenue_movements('2020-03-01', '2020-03-31', 'reactivation')::text as back \gset
select tests.clear_auth();
select is(
  (select array_agg(x.n order by x.n) from (
     select r ->> 'name' as n from jsonb_array_elements(:'churn'::jsonb -> 'rows') as r) as x),
  array['Sa630-B', 'Sa630-B', 'Sa630-E', 'Sa630-F', 'Sa630-G', 'Sa630-I'],
  'the month''s six churns, B twice'
);
select is(
  (select array_agg(x.n order by x.n) from (
     select r ->> 'name' || ' from ' || (r ->> 'state_before') as n
     from jsonb_array_elements(:'back'::jsonb -> 'rows') as r) as x),
  array['Sa630-B from cancelled', 'Sa630-E from payment_failed', 'Sa630-H from cancelled',
    'Sa630-I from cancelled'],
  'reactivations, H''s from a paid period before history'
);
select is(
  (select r - 'restaurant_id' - 'city' from jsonb_array_elements(:'churn'::jsonb -> 'rows') as r
   where r ->> 'name' = 'Sa630-E'),
  '{"day": "2020-03-08", "name": "Sa630-E", "state_before": "paid", "state_after": "payment_failed",
    "plan_before": "Growth", "plan_after": "Growth", "before_paise": 89900, "after_paise": 0}'::jsonb,
  'MRR and state before and after'
);
select is(
  (select array[r ->> 'plan_before', r ->> 'plan_after', r ->> 'before_paise', r ->> 'after_paise']
   from jsonb_array_elements(:'up'::jsonb -> 'rows') as r),
  array['Starter', 'Growth', '39900', '89900'],
  'one day''s bar: C''s upgrade from Starter'
);
select is((:'late'::jsonb ->> 'total')::int, 3, 'a later first day leaves out the earlier churn');

-- ─── Today: the live row is Home's ──────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_revenue_report(
  (now() at time zone 'Asia/Kolkata')::date, (now() at time zone 'Asia/Kolkata')::date, 'day'
)::text as today \gset
select public.platform_home()::text as home \gset
select public.platform_list_dues('{}')::text as dues \gset
select tests.clear_auth();
select is(
  array[:'today'::jsonb #>> '{totals,mrr_paise}', :'today'::jsonb #>> '{totals,paid}'],
  array[:'home'::jsonb ->> 'mrr_paise', :'home'::jsonb #>> '{restaurants,paid}'],
  'today''s MRR and Paid are Home''s'
);
select is(:'today'::jsonb -> 'expected', :'dues'::jsonb -> 'expected',
  'expected in 30 days is the Dues page''s');

-- ─── The movements hold on all the data there is ────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_revenue_report(
  (now() at time zone 'Asia/Kolkata')::date - 364, (now() at time zone 'Asia/Kolkata')::date, 'month'
)::text as year \gset
select tests.clear_auth();
select is(
  (select count(*)::int from (
     select (e ->> 'mrr_paise')::bigint - coalesce(
         lag((e ->> 'mrr_paise')::bigint) over (order by e ->> 'start'),
         (:'year'::jsonb #>> '{totals,opening_mrr_paise}')::bigint) as change,
       (select sum((m.value ->> 'paise')::bigint) from jsonb_each(e -> 'movements') as m) as moved
     from jsonb_array_elements(:'year'::jsonb -> 'series') as e
   ) as x where x.change <> x.moved),
  0,
  'every month of the last year: the movements add up to the change in MRR'
);

-- ─── No history at all ──────────────────────────────────────────────────────
delete from public.metrics_subscription_daily;
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_revenue_report('2020-03-01', '2020-03-31', 'month')::text as none \gset
select tests.clear_auth();
select is(
  array[
    :'none'::jsonb ->> 'history_starts_on', :'none'::jsonb #>> '{totals,mrr_paise}',
    :'none'::jsonb #>> '{totals,opening_day}', :'none'::jsonb #>> '{totals,movements,churn,count}',
    :'none'::jsonb #>> '{totals,collected,count}'
  ],
  array[null, null, null, '0', '6'],
  'without nights, no MRR figures; payments still count'
);

-- ─── Who may, and the dates ─────────────────────────────────────────────────
select tests.authenticate_as(:'owner_user');
select throws_ok($$select public.platform_revenue_report('2020-03-01', '2020-03-31')$$,
  'P0001', 'FORBIDDEN', 'not a platform admin');
select throws_ok($$select public.platform_revenue_movements('2020-03-01', '2020-03-31', 'new')$$,
  'P0001', 'FORBIDDEN', 'not a platform admin, for the list either');
select tests.authenticate_as_platform_admin(:'admin', 'aal1');
select throws_ok($$select public.platform_revenue_report('2020-03-01', '2020-03-31')$$,
  'P0001', 'MFA_REQUIRED', 'needs the second factor');
select tests.authenticate_as_platform_admin(:'admin');
select throws_ok($$select public.platform_revenue_report('2020-03-10', '2020-03-01')$$,
  'P0001', 'INVALID_INPUT', 'the end before the start');
select throws_ok($$select public.platform_revenue_report('2019-01-01', '2020-01-03')$$,
  'P0001', 'INVALID_INPUT', 'more than the pages'' 366 days');
select lives_ok($$select public.platform_revenue_report('2019-01-01', '2020-01-02', 'month', true)$$,
  'the longest range a page sends, compared with the one before');
select throws_ok($$select public.platform_revenue_report('2020-03-01', '2020-03-31', 'year')$$,
  'P0001', 'INVALID_INPUT', 'days, weeks or months only');
select throws_ok($$select public.platform_revenue_movements('2020-03-01', '2020-03-31', 'lost')$$,
  'P0001', 'INVALID_INPUT', 'the five movements only');
select tests.as_anon();
select throws_ok($$select public.platform_revenue_report('2020-03-01', '2020-03-31')$$,
  '42501', null, 'anon may not');
select tests.clear_auth();
select ok(
  not has_function_privilege('authenticated', 'private.mrr_days(date)', 'execute')
    and not has_function_privilege('authenticated', 'private.revenue_bucket(date, date, text)', 'execute'),
  'the helpers are private'
);

select * from finish();
rollback;
