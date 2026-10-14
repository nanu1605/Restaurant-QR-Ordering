-- The payments ledger, dues and subscription states (docs/SUPER_ADMIN_PLAN.md
-- 12c; docs/DECISIONS.md SA-17 to SA-19). Restaurants here are named sa550-*
-- and every list is searched for that, so other data doesn't matter.
begin;
select no_plan();

select tests.create_platform_admin('platform550@admin.test') as admin \gset
select id as growth from public.plans where code = 'growth' \gset
select id as starter from public.plans where code = 'starter' \gset

-- ─── Dues fixtures: one restaurant per case ─────────────────────────────────
select tests.create_restaurant('sa550-failed') as failed \gset
select tests.create_restaurant('sa550-lapsed') as lapsed \gset
select tests.create_restaurant('sa550-trial') as trial \gset
select tests.create_restaurant('sa550-trial-autopay') as trial_autopay \gset
select tests.create_restaurant('sa550-trial-far') as trial_far \gset
select tests.create_restaurant('sa550-renew-auto') as renew_auto \gset
select tests.create_restaurant('sa550-renew-manual') as renew_manual \gset
select tests.create_restaurant('sa550-renew-ending') as renew_ending \gset
select tests.create_restaurant('sa550-paid-far') as paid_far \gset
select tests.create_restaurant('sa550-suspended') as suspended \gset
select tests.add_member(:'failed', 'owner', 'f_owner') as f_owner \gset

update public.restaurant_subscriptions set status = 'past_due', source = 'razorpay',
  razorpay_subscription_id = 'sub_SA550failed', razorpay_status = 'pending',
  billing_cycle = 'monthly', current_period_end = now() - interval '1 day',
  grace_until = now() + interval '3 days', trial_ends_at = null
  where restaurant_id = :'failed';
update public.restaurant_subscriptions set trial_ends_at = now() - interval '3 days'
  where restaurant_id = :'lapsed';
update public.restaurant_subscriptions set trial_ends_at = now() + interval '2 days'
  where restaurant_id = :'trial';
update public.restaurant_subscriptions set trial_ends_at = now() + interval '2 days',
  razorpay_subscription_id = 'sub_SA550trial', razorpay_status = 'authenticated'
  where restaurant_id = :'trial_autopay';
update public.restaurant_subscriptions set trial_ends_at = now() + interval '10 days'
  where restaurant_id = :'trial_far';
update public.restaurant_subscriptions set status = 'active', source = 'razorpay',
  razorpay_subscription_id = 'sub_SA550auto', razorpay_status = 'active',
  billing_cycle = 'monthly', current_period_start = now() - interval '25 days',
  current_period_end = now() + interval '5 days', trial_ends_at = null
  where restaurant_id = :'renew_auto';
update public.restaurant_subscriptions set status = 'active', source = 'manual',
  billing_cycle = 'yearly', current_period_start = now() - interval '345 days',
  current_period_end = now() + interval '20 days', trial_ends_at = null
  where restaurant_id = :'renew_manual';
update public.restaurant_subscriptions set status = 'active', source = 'razorpay',
  razorpay_subscription_id = 'sub_SA550ending', razorpay_status = 'active',
  cancel_at_period_end = true, billing_cycle = 'monthly',
  current_period_start = now() - interval '27 days',
  current_period_end = now() + interval '3 days', trial_ends_at = null
  where restaurant_id = :'renew_ending';
update public.restaurant_subscriptions set status = 'active', source = 'manual',
  billing_cycle = 'monthly', current_period_end = now() + interval '60 days',
  trial_ends_at = null
  where restaurant_id = :'paid_far';
update public.restaurant_subscriptions set status = 'past_due', source = 'razorpay',
  grace_until = now() + interval '3 days', current_period_end = now() - interval '1 day'
  where restaurant_id = :'suspended';
select tests.suspend(:'suspended');
insert into public.subscription_reminders (restaurant_id, kind, due_key, sent_at)
values (:'failed', 'payment_failed', current_date - 1, now() - interval '1 day'),
       (:'failed', 'payment_failed', current_date, now() - interval '1 hour');

create function pg_temp.dues(p_bucket text, p_days int default 30)
returns jsonb language sql as $$
  select public.platform_list_dues(
    jsonb_build_object('bucket', p_bucket, 'days', p_days, 'q', 'sa550-')
  );
$$;
create function pg_temp.slugs(p_list jsonb)
returns text[] language sql as $$
  select coalesce(array_agg(r ->> 'slug' order by r ->> 'slug'), '{}')
  from jsonb_array_elements(p_list -> 'rows') as r;
$$;

select tests.authenticate_as_platform_admin(:'admin');
select pg_temp.dues('payment_failed') as d_failed \gset
select pg_temp.dues('lapsed') as d_lapsed \gset
select pg_temp.dues('trial_ending') as d_trial \gset
select pg_temp.dues('renewal_due') as d_renew \gset
select pg_temp.dues('renewal_due', 7) as d_renew7 \gset
select tests.clear_auth();

select is(pg_temp.slugs(:'d_failed'), array['sa550-failed'], 'payment failed: Razorpay retrying, in grace');
select is(pg_temp.slugs(:'d_lapsed'), array['sa550-lapsed'], 'lapsed: read-only, not suspended');
select is(pg_temp.slugs(:'d_trial'), array['sa550-trial'],
  'trial ending: within 3 days and no autopay (a mandate or a later end is left out)');
select is(pg_temp.slugs(:'d_renew'),
  array['sa550-renew-auto', 'sa550-renew-ending', 'sa550-renew-manual'],
  'renewal due within 30 days');
select is(pg_temp.slugs(:'d_renew7'), array['sa550-renew-auto', 'sa550-renew-ending'],
  'within 7 days');
select is(
  (select count(*)::int from unnest(
    pg_temp.slugs(:'d_failed') || pg_temp.slugs(:'d_lapsed') || pg_temp.slugs(:'d_trial')
    || pg_temp.slugs(:'d_renew')) as s),
  (select count(distinct s)::int from unnest(
    pg_temp.slugs(:'d_failed') || pg_temp.slugs(:'d_lapsed') || pg_temp.slugs(:'d_trial')
    || pg_temp.slugs(:'d_renew')) as s),
  'no restaurant is in two buckets'
);
select is(
  (:'d_renew'::jsonb) -> 'counts',
  '{"payment_failed": 1, "lapsed": 1, "trial_ending": 1, "renewal_due": 3}'::jsonb,
  'the tab counts'
);
select is(((:'d_renew7'::jsonb) -> 'counts' ->> 'renewal_due')::int, 2, 'the renewal count follows the window');

select is(
  (select jsonb_object_agg(r ->> 'slug', r ->> 'renewal_kind')
   from jsonb_array_elements((:'d_renew'::jsonb) -> 'rows') as r),
  '{"sa550-renew-auto": "autopay", "sa550-renew-manual": "needs_payment",
    "sa550-renew-ending": "ending"}'::jsonb,
  'renewals: on autopay, needs a payment, ending'
);
select is(
  (:'d_renew'::jsonb) -> 'expected',
  jsonb_build_object(
    'autopay_paise', private.fee_with_gst((select price_monthly_paise from public.plans where code = 'growth')),
    'autopay_count', 1,
    'needs_payment_paise', private.fee_with_gst((select price_yearly_paise from public.plans where code = 'growth')),
    'needs_payment_count', 1
  ),
  'expected collections: autopay and by hand apart, at the cycle price with GST; ending left out'
);
select is(
  (:'d_failed'::jsonb) #>> '{rows,0,due_paise}',
  (select (price_monthly_paise + round(price_monthly_paise * 0.18))::bigint::text
   from public.plans where code = 'growth'),
  'the amount due is the monthly price with 18% GST'
);
select is(
  (:'d_failed'::jsonb) #>> '{rows,0,last_reminder_at}' is not null
    and (:'d_failed'::jsonb) #>> '{rows,0,last_reminder_kind}' = 'payment_failed'
    and ((:'d_failed'::jsonb) #>> '{rows,0,last_reminder_at}')::timestamptz > now() - interval '2 hours',
  true,
  'the latest reminder email is shown'
);
select is(
  (:'d_lapsed'::jsonb) #>> '{rows,0,access_reason}', 'trial_ended', 'why it lapsed'
);
select is(
  (:'d_failed'::jsonb) #>> '{rows,0,state}', 'payment_failed', 'each row has its state'
);

select tests.authenticate_as_platform_admin(:'admin');
select throws_ok($$select public.platform_list_dues('{"bucket": "overdue"}')$$,
  'P0001', 'INVALID_INPUT', 'an unknown bucket');
select throws_ok($$select public.platform_list_dues('{"days": 14}')$$,
  'P0001', 'INVALID_INPUT', '7 or 30 days only');
select tests.authenticate_as_platform_admin(:'admin', 'aal1');
select throws_ok($$select public.platform_list_dues('{}')$$,
  'P0001', 'MFA_REQUIRED', 'dues need the second factor');
select tests.authenticate_as(:'f_owner');
select throws_ok($$select public.platform_list_dues('{}')$$,
  'P0001', 'FORBIDDEN', 'a restaurant owner cannot see dues');
select tests.as_anon();
select throws_ok($$select public.platform_list_dues('{}')$$, '42501', null, 'anon cannot');
select tests.clear_auth();

-- ─── Payments: what each paid for ───────────────────────────────────────────
select tests.create_restaurant('sa550-pay') as pay \gset
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_record_manual_payment(:'pay', jsonb_build_object(
  'amount_paise', 470820, 'mode', 'bank_transfer', 'billing_cycle', 'yearly',
  'period_start', current_date, 'period_end', current_date + 364, 'notes', 'UTR 550'
)) ->> 'payment_id' as yearly_id \gset
select public.platform_record_setup_fee(:'pay', '{
  "amount_paise": 58882, "mode": "cash", "list_price_paise": 99900, "discount_paise": 50000
}') ->> 'payment_id' as fee_id \gset
select tests.clear_auth();
-- A Razorpay charge for the plan the mandate was set up with.
update public.restaurant_subscriptions set next_plan_id = :'starter', next_billing_cycle = 'monthly'
  where restaurant_id = :'pay';
insert into public.subscription_payments (
  restaurant_id, source, amount_paise, razorpay_payment_id, period_start, period_end
)
values (:'pay', 'razorpay', 58882, 'pay_SA550charge', now(), now() + interval '30 days')
returning id as charge_id \gset

select is(
  (select row(plan_id, billing_cycle)::text from public.subscription_payments where id = :'yearly_id'),
  row(:'growth'::uuid, 'yearly'::public.billing_cycle)::text,
  'a manual payment for a year: the current plan, yearly'
);
select is(
  (select row(plan_id, billing_cycle)::text from public.subscription_payments where id = :'fee_id'),
  row(null::uuid, null::public.billing_cycle)::text,
  'a setup fee has no plan'
);
select is(
  (select row(plan_id, billing_cycle)::text from public.subscription_payments where id = :'charge_id'),
  row(:'starter'::uuid, 'monthly'::public.billing_cycle)::text,
  'a Razorpay charge: the plan its mandate was set up with'
);

select tests.authenticate_as_platform_admin(:'admin');
select public.platform_list_payments('{"q": "sa550-pay"}') as p_all \gset
select public.platform_list_payments('{"q": "sa550-pay", "purpose": "setup_fee"}') as p_fee \gset
select public.platform_list_payments('{"q": "sa550-pay", "method": "autopay"}') as p_auto \gset
select public.platform_list_payments('{"q": "sa550-pay", "plan": "starter"}') as p_starter \gset
select public.platform_list_payments(jsonb_build_object(
  'q', 'sa550-pay', 'from', (now() at time zone 'Asia/Kolkata')::date + 1
)) as p_tomorrow \gset
select public.platform_list_payments(jsonb_build_object(
  'q', 'sa550-pay', 'from', (now() at time zone 'Asia/Kolkata')::date,
  'to', (now() at time zone 'Asia/Kolkata')::date
)) as p_today \gset
select public.platform_list_payments('{"q": "sa550-pay", "export": true}') as p_export \gset
select tests.clear_auth();

select is(((:'p_all'::jsonb) ->> 'total')::int, 3, 'every payment of the restaurant');
select is(
  (:'p_all'::jsonb) -> 'totals',
  (select jsonb_build_object(
    'count', count(*),
    'base_paise', sum(base_paise),
    'gst_paise', sum(gst_paise),
    'amount_paise', sum(amount_paise),
    'subscription_base_paise', sum(base_paise) filter (where purpose = 'subscription'),
    'setup_fee_base_paise', sum(base_paise) filter (where purpose = 'setup_fee'))
   from public.subscription_payments where restaurant_id = :'pay'),
  'the totals are the sums of the matching rows, by purpose too'
);
select is(
  (select sum((r ->> 'amount_paise')::bigint) from jsonb_array_elements((:'p_all'::jsonb) -> 'rows') r),
  ((:'p_all'::jsonb) #>> '{totals,amount_paise}')::numeric,
  'the totals row equals the rows'
);
select is(
  (select jsonb_object_agg(r ->> 'payment_id', r ->> 'method')
   from jsonb_array_elements((:'p_all'::jsonb) -> 'rows') r),
  jsonb_build_object(:'yearly_id', 'bank_transfer', :'fee_id', 'cash', :'charge_id', 'autopay'),
  'how each arrived'
);
select is(
  (select r ->> 'recorded_by' from jsonb_array_elements((:'p_all'::jsonb) -> 'rows') r
   where r ->> 'payment_id' = :'yearly_id'),
  'platform550@admin.test',
  'who recorded a manual payment'
);
select is(pg_temp.slugs(:'p_fee'), array['sa550-pay'], 'filter: setup fees');
select is((:'p_fee'::jsonb) #>> '{rows,0,payment_id}', :'fee_id', 'only the setup fee');
select is((:'p_auto'::jsonb) #>> '{rows,0,payment_id}', :'charge_id', 'filter: autopay');
select is(((:'p_starter'::jsonb) ->> 'total')::int, 1, 'filter: plan');
select is(((:'p_tomorrow'::jsonb) ->> 'total')::int, 0, 'filter: from a date (India)');
select is(((:'p_today'::jsonb) ->> 'total')::int, 3, 'filter: today (India)');
select is(((:'p_export'::jsonb) ->> 'page_size')::int, 10000, 'an export is one long page');

select tests.authenticate_as_platform_admin(:'admin');
select throws_ok($$select public.platform_list_payments('{"method": "card"}')$$,
  'P0001', 'INVALID_INPUT', 'an unknown method');
select throws_ok($$select public.platform_list_payments('{"from": "2026-10-10", "to": "2026-10-01"}')$$,
  'P0001', 'INVALID_INPUT', 'the end before the start');
select throws_ok($$select public.platform_list_payments('{"restaurant": "x"}')$$,
  'P0001', 'INVALID_INPUT', 'an unknown key');
select tests.authenticate_as_platform_admin(:'admin', 'aal1');
select throws_ok($$select public.platform_list_payments('{}')$$,
  'P0001', 'MFA_REQUIRED', 'payments need the second factor');
select tests.authenticate_as(:'f_owner');
select throws_ok($$select public.platform_list_payments('{}')$$,
  'P0001', 'FORBIDDEN', 'a restaurant owner cannot see the ledger');
select tests.clear_auth();

-- ─── Subscriptions list: states ─────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_list_subscriptions('{"state": "payment_failed"}') as s_failed \gset
select (public.platform_list_subscriptions('{"state": "paid"}') ->> 'total')::int as paid_total \gset
select coalesce(jsonb_agg(r), '[]') as s_ending
from generate_series(1, ceil(:paid_total / 50.0)::int) as pg(n)
cross join lateral jsonb_array_elements(
  public.platform_list_subscriptions(jsonb_build_object('state', 'paid', 'page', pg.n)) -> 'rows'
) as r
where r ->> 'slug' in ('sa550-renew-ending', 'sa550-renew-auto') \gset
select tests.clear_auth();

select ok(
  not jsonb_path_exists(:'s_failed'::jsonb, '$.rows[*] ? (@.state != "payment_failed")'),
  'a state filter returns only that state'
);
select is(
  (select jsonb_object_agg(r ->> 'slug', r -> 'ending') from jsonb_array_elements(:'s_ending'::jsonb) r),
  '{"sa550-renew-ending": true, "sa550-renew-auto": false}'::jsonb,
  'a paid period set to end says so'
);
select tests.authenticate_as_platform_admin(:'admin');
select throws_ok($$select public.platform_list_subscriptions('{"state": "active"}')$$,
  'P0001', 'INVALID_INPUT', 'states, not Razorpay statuses');
select tests.clear_auth();

select * from finish();
rollback;
