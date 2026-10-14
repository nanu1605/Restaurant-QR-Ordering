-- Local load data for the super-admin pages (docs/SUPER_ADMIN_PLAN.md §4.6,
-- docs/DECISIONS.md SA-26): 300 restaurants named load-001 to load-300 with
-- subscriptions in every state, their payments, up to 18 months of daily
-- usage, the last 35 days of accepted orders, a year of nightly snapshots and
-- 100 leads. The same seed gives the same data. Run by `pnpm seed:platform-load`,
-- which queries the local stack only and removes the previous load first.
do $$
begin
  perform setseed(0.42);

  -- One row per restaurant: its state (n % 10) and its usage profile (n % 5).
  create temp table load_r on commit drop as
  select
    x.*,
    case
      when x.kind = 'trial' then now() - make_interval(days => 1 + x.n % 13)
      else now() - make_interval(days => 40 + floor(random() * 500)::int)
    end as created_at,
    -- Accepted orders on an ordinary day.
    4 + floor(random() * 12)::int as daily
  from (
    select
      n,
      gen_random_uuid() as id,
      'load-' || lpad(n::text, 3, '0') as slug,
      case n % 10
        when 0 then 'paid_manual' when 1 then 'paid_manual' when 2 then 'paid_razorpay'
        when 3 then 'paid_razorpay' when 4 then 'paid_yearly' when 5 then 'trial'
        when 6 then 'trial' when 7 then 'payment_failed' when 8 then 'lapsed' else 'cancelled'
      end as kind,
      case
        when n % 10 in (5, 6) and n % 3 = 0 then 'never'
        else (array['never', 'inactive', 'slowing', 'active', 'active'])[1 + n % 5]
      end as profile,
      1 + n % 8 as place,
      (array['starter', 'growth', 'pro'])[1 + n % 3] as plan_code
    from generate_series(1, 300) as n
  ) as x;

  insert into public.restaurants (
    id, name, slug, city, state, phone, acquisition_channel, created_at
  )
  select
    r.id,
    'Load Kitchen ' || lpad(r.n::text, 3, '0'),
    r.slug,
    (array['Indore', 'Bhopal', 'Pune', 'Jaipur', 'Lucknow', 'Surat', 'Nagpur', 'Kochi'])[r.place],
    (array['Madhya Pradesh', 'Madhya Pradesh', 'Maharashtra', 'Rajasthan', 'Uttar Pradesh',
           'Gujarat', 'Maharashtra', 'Kerala'])[r.place],
    (array['9', '8', '7', '6'])[1 + r.n % 4] || lpad((r.n * 7919 % 1000000000)::text, 9, '0'),
    (array['website', 'website_lead', 'field_visit', 'referral', 'phone', 'whatsapp', 'social',
           'other', null])[1 + r.n % 9],
    r.created_at
  from load_r r;

  insert into public.restaurant_subscriptions (
    restaurant_id, plan_id, status, source, billing_cycle, trial_ends_at, current_period_start,
    current_period_end, grace_until, cancel_at_period_end, razorpay_subscription_id, razorpay_status
  )
  select
    r.id, p.id,
    case r.kind
      when 'trial' then 'trialing' when 'lapsed' then 'trialing'
      when 'payment_failed' then 'past_due' when 'cancelled' then 'cancelled' else 'active'
    end::public.subscription_status,
    case
      when r.kind in ('paid_razorpay', 'payment_failed') then 'razorpay'
      when r.kind in ('paid_manual', 'paid_yearly', 'cancelled') then 'manual'
    end::public.subscription_source,
    case
      when r.kind = 'paid_yearly' then 'yearly'
      when r.kind in ('trial', 'lapsed') then null
      else 'monthly'
    end::public.billing_cycle,
    case
      when r.kind = 'trial' then now() + make_interval(days => 1 + r.n % 14)
      when r.kind = 'lapsed' then now() - make_interval(days => 3 + r.n % 60)
    end,
    case when r.kind like 'paid%' then now() - make_interval(days => r.n % 28) end,
    case
      when r.kind = 'paid_yearly' then now() + make_interval(days => 365 - r.n % 300)
      when r.kind like 'paid%' then now() + make_interval(days => 30 - r.n % 28)
      when r.kind = 'payment_failed' then now() - make_interval(days => 1 + r.n % 3)
      when r.kind = 'cancelled' then now() - make_interval(days => 10 + r.n % 90)
    end,
    case when r.kind = 'payment_failed' then now() + make_interval(days => 1 + r.n % 6) end,
    false,
    case when r.kind in ('paid_razorpay', 'payment_failed') then 'sub_load' || r.n end,
    case r.kind when 'paid_razorpay' then 'active' when 'payment_failed' then 'pending' end
  from load_r r
  join public.plans p on p.code = r.plan_code;

  -- Monthly (or yearly) payments from two weeks after joining, and a setup fee
  -- from every other paying restaurant.
  insert into public.subscription_payments (
    restaurant_id, source, amount_paise, razorpay_payment_id, manual_mode, period_start,
    period_end, created_at
  )
  select
    r.id,
    case when r.kind in ('paid_razorpay', 'payment_failed') then 'razorpay' else 'manual' end
      ::public.subscription_payment_source,
    private.fee_with_gst(case when r.kind = 'paid_yearly' then p.price_yearly_paise
      else p.price_monthly_paise end),
    case when r.kind in ('paid_razorpay', 'payment_failed')
      then 'pay_load' || r.n || '_' || k end,
    case when r.kind not in ('paid_razorpay', 'payment_failed')
      then 'upi' end::public.manual_payment_mode,
    s.start,
    s.start + case when r.kind = 'paid_yearly' then interval '365 days' else interval '30 days' end,
    s.start
  from load_r r
  join public.plans p on p.code = r.plan_code
  cross join lateral (
    select row_number() over () as k, g as start
    from generate_series(
      r.created_at + interval '14 days',
      case when r.kind = 'cancelled' then now() - interval '40 days' else now() end,
      case when r.kind = 'paid_yearly' then interval '365 days' else interval '30 days' end
    ) as g
  ) as s
  where r.kind like 'paid%' or r.kind in ('payment_failed', 'cancelled');

  insert into public.subscription_payments (
    restaurant_id, source, amount_paise, manual_mode, purpose, created_at
  )
  select r.id, 'manual', private.fee_with_gst(50000), 'upi', 'setup_fee',
         r.created_at + interval '14 days'
  from load_r r
  where r.n % 2 = 0 and (r.kind like 'paid%' or r.kind in ('payment_failed', 'cancelled'));

  -- Daily usage since joining, shaped by the profile: never started has none,
  -- inactive stopped 12 days ago, slowing dropped in the last week.
  insert into public.metrics_usage_daily (
    restaurant_id, business_day, orders, customer_orders, staff_orders, items, bills, gmv_paise,
    hourly_orders
  )
  select
    u.id, u.day, u.orders, u.orders * 2 / 3, u.orders - u.orders * 2 / 3, u.orders * 3,
    u.orders / 2, u.orders * (25000 + floor(random() * 35000)::bigint),
    -- A third at lunch (1 pm), the rest at dinner (8 pm).
    array_fill(0, array[13]) || (u.orders / 3) || array_fill(0, array[6])
      || (u.orders - u.orders / 3) || array_fill(0, array[3])
  from (
    select
      r.id, d.day::date as day,
      case
        when r.profile = 'never' then 0
        when r.profile = 'inactive' and d.day >= current_date - 12 then 0
        when r.profile = 'slowing' and d.day >= current_date - 7 then floor(random() * 2)::int
        else floor(random() * r.daily * 2)::int
      end as orders
    from load_r r
    cross join lateral generate_series(r.created_at::date, current_date - 1, interval '1 day') as d(day)
  ) as u
  where u.orders > 0;

  -- The last 35 days of usage as accepted orders, at midday India time, in one
  -- session per restaurant.
  insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
  select r.id, '1', 'LOAD' || lpad(r.n::text, 12, '0'), 1 from load_r r;
  insert into public.table_sessions (
    restaurant_id, dining_table_id, table_label_snapshot, status, is_approved, opened_at
  )
  select t.restaurant_id, t.id, t.label, 'open', true, now() - interval '36 days'
  from public.dining_tables t
  join load_r r on r.id = t.restaurant_id;
  insert into public.orders (
    restaurant_id, session_id, round_number, status, placed_via, idempotency_key, created_at
  )
  select
    m.restaurant_id, s.id,
    row_number() over (partition by s.id order by m.business_day, g),
    'accepted', 'customer', 'load-' || gen_random_uuid(),
    (m.business_day + time '12:00') at time zone 'Asia/Kolkata'
      + make_interval(mins => floor(random() * 600)::int)
  from public.metrics_usage_daily m
  join load_r r on r.id = m.restaurant_id
  join public.table_sessions s on s.restaurant_id = m.restaurant_id
  cross join generate_series(1, m.orders) as g
  where m.business_day >= current_date - 35;

  -- A year of nightly snapshots for Home's MRR chart and the lapses in the
  -- activity: a 14-day trial, then each kind's path.
  insert into public.metrics_subscription_daily (
    day, restaurant_id, state, plan_id, billing_cycle, source, mrr_paise
  )
  select
    d.day, r.id, st.state, p.id,
    case when st.state in ('paid', 'payment_failed') then
      (case when r.kind = 'paid_yearly' then 'yearly' else 'monthly' end)::public.billing_cycle end,
    case when st.state in ('paid', 'payment_failed') then
      (case when r.kind in ('paid_razorpay', 'payment_failed') then 'razorpay' else 'manual' end)
        ::public.subscription_source end,
    case when st.state = 'paid' then
      case when r.kind = 'paid_yearly' then round(p.price_yearly_paise / 12.0)::bigint
        else p.price_monthly_paise end
    else 0 end
  from load_r r
  join public.plans p on p.code = r.plan_code
  cross join lateral generate_series(
    greatest(r.created_at::date, current_date - 365), current_date - 1, interval '1 day'
  ) as g(day)
  cross join lateral (select g.day::date as day) as d
  cross join lateral (
    select case
      when r.kind = 'lapsed' and d.day >= current_date - (3 + r.n % 60) then 'read_only'
      when d.day < r.created_at::date + 14 or r.kind in ('trial', 'lapsed') then 'trial'
      when r.kind = 'cancelled' and d.day >= current_date - 40 then 'cancelled'
      when r.kind = 'payment_failed' and d.day >= current_date - 3 then 'payment_failed'
      else 'paid'
    end as state
  ) as st
  on conflict (day, restaurant_id) do nothing;

  insert into public.site_leads (name, restaurant_name, city, phone, created_at)
  select 'Load lead ' || n, 'Load Cafe ' || n,
         (array['Indore', 'Pune', 'Jaipur', 'Kochi'])[1 + n % 4],
         '9' || lpad((n * 104729 % 1000000000)::text, 9, '0'),
         now() - make_interval(days => n % 200)
  from generate_series(1, 100) as n;

  -- Tags on a third of them, and notes on some (13a).
  insert into public.platform_tags (name, colour) values
    ('Load pilot', 'orange'), ('Load Indore', 'teal'), ('Load VIP', 'green')
  on conflict do nothing;
  insert into public.restaurant_tags (restaurant_id, tag_id)
  select r.id, t.id
  from load_r r
  join public.platform_tags t
    on t.name = (array['Load pilot', 'Load Indore', 'Load VIP'])[1 + r.n % 3]
  where r.n % 3 = 0;
  insert into public.restaurant_notes (restaurant_id, body, pinned, created_at)
  select r.id, 'Load note ' || k || ' on ' || r.slug, k = 1,
         now() - make_interval(days => k * 7 + r.n % 7)
  from load_r r
  cross join generate_series(1, 5) as k
  where r.n % 5 = 3;
end
$$;
