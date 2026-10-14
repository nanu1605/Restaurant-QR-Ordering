-- Super-admin redesign, stop 12b (docs/SUPER_ADMIN_PLAN.md §4.1, §4.4, §5.1,
-- §5.2, §5.10; docs/DECISIONS.md SA-7, SA-9 to SA-11): daily snapshots of the
-- numbers the panel charts, and one definition of a restaurant's subscription
-- state and MRR. Subscription history can't be rebuilt later: it starts the
-- day this reaches production. Usage can be (from bills and orders).

-- ─── Shared definitions ─────────────────────────────────────────────────────
-- A restaurant's subscription state (plan §5.1), first match wins.
create function private.subscription_state(
  p_restaurant_status text,
  p_access_state text,
  p_status text,
  p_source text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_restaurant_status = 'suspended' then 'suspended'
    when p_access_state = 'read_only' then 'read_only'
    when p_status = 'trialing' then 'trial'
    when p_status in ('past_due', 'halted') then 'payment_failed'
    when p_status = 'active' and p_source is not null then 'paid'
    else 'cancelled'
  end;
$$;

-- A restaurant's part of MRR (plan §5.2): the plan's monthly price, or yearly ÷
-- 12, while Paid; before GST, setup fees and one-off links never count.
create function private.restaurant_mrr_paise(
  p_state text,
  p_plan public.plans,
  p_cycle public.billing_cycle
)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case when p_state = 'paid' then private.monthly_paise(p_plan, p_cycle) else 0 end;
$$;

revoke execute on function private.subscription_state(text, text, text, text)
  from public, anon, authenticated;
revoke execute on function private.restaurant_mrr_paise(text, public.plans, public.billing_cycle)
  from public, anon, authenticated;

-- ─── Snapshot tables ────────────────────────────────────────────────────────
-- Platform admins read them; only the functions below write them.

-- Each restaurant's subscription as it stood at the end of an India day.
create table public.metrics_subscription_daily (
  day date not null,
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  state text not null
    check (state in ('suspended', 'read_only', 'trial', 'payment_failed', 'paid', 'cancelled')),
  plan_id uuid references public.plans (id),
  billing_cycle public.billing_cycle,
  source public.subscription_source,
  mrr_paise bigint not null default 0,
  cancel_at_period_end boolean not null default false,
  autopay boolean not null default false,
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  grace_until timestamptz,
  -- Filled from stop 12d (plan §5.11).
  health text,
  primary key (day, restaurant_id)
);
create index metrics_subscription_daily_restaurant_idx
  on public.metrics_subscription_daily (restaurant_id, day);

-- Each restaurant's ordering and sales per business day, counted like its own
-- reports: bills, sales and payments by the day the bill was made, orders by
-- the day they were placed (SA-10).
create table public.metrics_usage_daily (
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  business_day date not null,
  orders int not null default 0,
  customer_orders int not null default 0,
  staff_orders int not null default 0,
  items int not null default 0,
  sessions_billed int not null default 0,
  avg_session_minutes int,
  bills int not null default 0,
  gmv_paise bigint not null default 0,
  discount_paise bigint not null default 0,
  tax_paise bigint not null default 0,
  paid_cash_paise bigint not null default 0,
  paid_upi_paise bigint not null default 0,
  paid_card_paise bigint not null default 0,
  paid_other_paise bigint not null default 0,
  service_requests int not null default 0,
  -- Accepted orders by the hour they were placed, 0 to 23, restaurant time.
  hourly_orders int[] not null default array_fill(0, array[24])
    check (cardinality(hourly_orders) = 24),
  primary key (restaurant_id, business_day)
);
create index metrics_usage_daily_day_idx on public.metrics_usage_daily (business_day);

-- Platform numbers per India day that would otherwise be lost: signups are
-- deleted after 7 days (SA-9).
create table public.metrics_platform_daily (
  day date primary key,
  signups_started int not null default 0,
  signups_completed int not null default 0,
  restaurants_onboarded int not null default 0,
  leads_created int not null default 0,
  -- From PostHog once its keys are set (stop 13d); null until then.
  website_visitors int,
  pricing_visitors int
);

-- Each step of the scheduled jobs, written by the cron route.
create table public.cron_runs (
  id bigint generated always as identity primary key,
  job text not null check (length(job) <= 40),
  step text not null check (length(step) <= 60),
  started_at timestamptz not null,
  finished_at timestamptz not null,
  ok boolean not null,
  detail text check (length(detail) <= 2000)
);
create index cron_runs_job_started_idx on public.cron_runs (job, started_at desc);

alter table public.metrics_subscription_daily enable row level security;
alter table public.metrics_usage_daily enable row level security;
alter table public.metrics_platform_daily enable row level security;
alter table public.cron_runs enable row level security;
revoke all on public.metrics_subscription_daily, public.metrics_usage_daily,
  public.metrics_platform_daily, public.cron_runs from anon, authenticated;
grant select on public.metrics_subscription_daily, public.metrics_usage_daily,
  public.metrics_platform_daily, public.cron_runs to authenticated;

create policy "platform admins read subscription snapshots" on public.metrics_subscription_daily
  for select to authenticated using ((select public.is_platform_admin()));
create policy "platform admins read usage snapshots" on public.metrics_usage_daily
  for select to authenticated using ((select public.is_platform_admin()));
create policy "platform admins read platform snapshots" on public.metrics_platform_daily
  for select to authenticated using ((select public.is_platform_admin()));
create policy "platform admins read cron runs" on public.cron_runs
  for select to authenticated using ((select public.is_platform_admin()));

-- Calls and requests per restaurant over time (usage snapshots).
create index service_requests_restaurant_created_idx
  on public.service_requests (restaurant_id, created_at);

-- ─── Usage ──────────────────────────────────────────────────────────────────
-- Recounts business days p_from..p_to for every restaurant (or one). A
-- restaurant's current business day is still open, so it is never stored.
-- Returns the rows written.
create function private.metrics_usage_rebuild(
  p_from date,
  p_to date,
  p_restaurant_id uuid default null
)
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  r record;
  v_to date;
  v_starts timestamptz;
  v_ends timestamptz;
  v_rows int := 0;
  v_count int;
begin
  for r in
    select x.id, x.timezone as tz, x.business_day_start_hour as h
    from public.restaurants x
    where p_restaurant_id is null or x.id = p_restaurant_id
  loop
    v_to := least(p_to, private.business_date(now(), r.tz, r.h) - 1);
    continue when v_to < p_from;
    select b.starts_at, b.ends_at into v_starts, v_ends
    from private.business_day_bounds(p_from, v_to, r.tz, r.h) as b;

    delete from public.metrics_usage_daily m
    where m.restaurant_id = r.id and m.business_day between p_from and v_to;

    insert into public.metrics_usage_daily (
      restaurant_id, business_day, orders, customer_orders, staff_orders, items,
      sessions_billed, avg_session_minutes, bills, gmv_paise, discount_paise, tax_paise,
      paid_cash_paise, paid_upi_paise, paid_card_paise, paid_other_paise,
      service_requests, hourly_orders
    )
    with bill_days as (
      select
        ((b.generated_at at time zone r.tz) - make_interval(hours => r.h))::date as day,
        count(*)::int as bills,
        sum(b.grand_total_paise) as gmv,
        sum(b.discount_paise) as discount,
        sum(b.total_tax_paise) as tax,
        round(avg(extract(epoch from b.generated_at - s.opened_at) / 60))::int as minutes,
        sum(pay.cash) as cash,
        sum(pay.upi) as upi,
        sum(pay.card) as card,
        sum(pay.other) as other,
        sum(it.items)::int as items
      from public.bills b
      join public.table_sessions s on s.id = b.session_id
      cross join lateral (
        select
          coalesce(sum(p.amount_paise) filter (where p.mode = 'cash'), 0) as cash,
          coalesce(sum(p.amount_paise) filter (where p.mode = 'upi'), 0) as upi,
          coalesce(sum(p.amount_paise) filter (where p.mode = 'card'), 0) as card,
          coalesce(sum(p.amount_paise) filter (where p.mode = 'other'), 0) as other
        from public.bill_payments p
        where p.bill_id = b.id and not p.is_void
      ) as pay
      cross join lateral (
        select coalesce(sum(i.quantity), 0) as items
        from public.order_items i
        join public.orders o on o.id = i.order_id
        where o.session_id = b.session_id
          and o.status = 'accepted'
          and i.status in ('placed', 'preparing', 'ready', 'served')
      ) as it
      where b.restaurant_id = r.id
        and b.status = 'active'
        and b.generated_at >= v_starts and b.generated_at < v_ends
      group by 1
    ),
    placed as (
      select
        ((o.created_at at time zone r.tz) - make_interval(hours => r.h))::date as day,
        extract(hour from o.created_at at time zone r.tz)::int as hour,
        o.placed_via
      from public.orders o
      where o.restaurant_id = r.id
        and o.status = 'accepted'
        and o.created_at >= v_starts and o.created_at < v_ends
    ),
    order_days as (
      select
        pl.day,
        count(*)::int as orders,
        (count(*) filter (where pl.placed_via = 'customer'))::int as customer_orders,
        (count(*) filter (where pl.placed_via = 'staff'))::int as staff_orders,
        array(
          select (select count(*) from placed x where x.day = pl.day and x.hour = g)::int
          from generate_series(0, 23) as g
          order by g
        ) as hourly
      from placed pl
      group by pl.day
    ),
    request_days as (
      select
        ((q.created_at at time zone r.tz) - make_interval(hours => r.h))::date as day,
        count(*)::int as requests
      from public.service_requests q
      where q.restaurant_id = r.id
        and q.created_at >= v_starts and q.created_at < v_ends
      group by 1
    ),
    days as (
      select day from bill_days
      union select day from order_days
      union select day from request_days
    )
    select
      r.id, d.day,
      coalesce(od.orders, 0), coalesce(od.customer_orders, 0), coalesce(od.staff_orders, 0),
      coalesce(bd.items, 0), coalesce(bd.bills, 0), bd.minutes, coalesce(bd.bills, 0),
      coalesce(bd.gmv, 0), coalesce(bd.discount, 0), coalesce(bd.tax, 0),
      coalesce(bd.cash, 0), coalesce(bd.upi, 0), coalesce(bd.card, 0), coalesce(bd.other, 0),
      coalesce(rd.requests, 0), coalesce(od.hourly, array_fill(0, array[24]))
    from days d
    left join bill_days bd on bd.day = d.day
    left join order_days od on od.day = d.day
    left join request_days rd on rd.day = d.day
    where d.day between p_from and v_to;

    get diagnostics v_count = row_count;
    v_rows := v_rows + v_count;
  end loop;
  return v_rows;
end;
$$;

revoke execute on function private.metrics_usage_rebuild(date, date, uuid)
  from public, anon, authenticated;

-- ─── Daily snapshot ─────────────────────────────────────────────────────────
-- Run by the daily cron at 03:00 India time, before signups are cleaned up:
-- the state then counts as the end of the previous India day (SA-9). Running
-- it again for a day changes nothing already stored; usage for the last few
-- business days is recounted (late payments, voids).
create function public.platform_metrics_snapshot(p_day date default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_day date := coalesce(p_day, v_today - 1);
  v_from timestamptz := v_day::timestamp at time zone 'Asia/Kolkata';
  v_to timestamptz := (v_day + 1)::timestamp at time zone 'Asia/Kolkata';
  v_subscriptions int;
  v_usage int;
begin
  insert into public.metrics_subscription_daily (
    day, restaurant_id, state, plan_id, billing_cycle, source, mrr_paise,
    cancel_at_period_end, autopay, trial_ends_at, current_period_end, grace_until
  )
  select
    v_day, r.id, st.state, s.plan_id, s.billing_cycle, s.source,
    private.restaurant_mrr_paise(st.state, p, s.billing_cycle),
    coalesce(s.cancel_at_period_end, false), coalesce(private.razorpay_managed(s), false),
    s.trial_ends_at, s.current_period_end, s.grace_until
  from public.restaurants r
  left join public.restaurant_subscriptions s on s.restaurant_id = r.id
  left join public.plans p on p.id = s.plan_id
  cross join lateral public.restaurant_access(r.id, least(now(), v_to)) as a
  cross join lateral (
    select private.subscription_state(r.status::text, a.state, s.status::text, s.source::text) as state
  ) as st
  where r.created_at < v_to
  on conflict (day, restaurant_id) do nothing;
  get diagnostics v_subscriptions = row_count;

  -- A restaurant made through signup has trial claims; the rest were onboarded
  -- by the team (SA-9).
  insert into public.metrics_platform_daily (
    day, signups_started, signups_completed, restaurants_onboarded, leads_created
  )
  select
    v_day,
    (select count(*) from public.site_signups x where x.created_at >= v_from and x.created_at < v_to),
    (select count(*) from public.restaurants x
     where x.created_at >= v_from and x.created_at < v_to
       and exists (select 1 from public.trial_claims c where c.restaurant_id = x.id)),
    (select count(*) from public.restaurants x
     where x.created_at >= v_from and x.created_at < v_to
       and not exists (select 1 from public.trial_claims c where c.restaurant_id = x.id)),
    (select count(*) from public.site_leads x where x.created_at >= v_from and x.created_at < v_to)
  on conflict (day) do nothing;

  v_usage := private.metrics_usage_rebuild(v_today - 4, v_today);

  return jsonb_build_object('day', v_day, 'subscriptions', v_subscriptions, 'usage_rows', v_usage);
end;
$$;

-- Usage for past business days, from a restaurant's first order: once per
-- environment after this migration (pnpm metrics:backfill, RUNBOOK).
create function public.platform_metrics_backfill_usage(p_from date, p_to date)
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    perform private.fail('INVALID_INPUT', 'range');
  end if;
  return private.metrics_usage_rebuild(p_from, p_to);
end;
$$;

revoke execute on function public.platform_metrics_snapshot(date) from public, anon, authenticated;
revoke execute on function public.platform_metrics_backfill_usage(date, date)
  from public, anon, authenticated;
grant execute on function public.platform_metrics_snapshot(date) to service_role;
grant execute on function public.platform_metrics_backfill_usage(date, date) to service_role;

-- ─── Overview ───────────────────────────────────────────────────────────────
-- Counts and MRR by the shared rules, and the day MRR history starts.
create or replace function public.platform_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.current_platform_admin();
  v_counts jsonb;
  v_mrr bigint;
  v_orders bigint;
  v_trials jsonb;
begin
  -- One state per restaurant and its MRR, by the shared rules (SA-7). The JSON
  -- keys stay as the overview page reads them: trialing = Trial, active =
  -- Paid, past_due = Payment failed.
  with states as (
    select st.state, private.restaurant_mrr_paise(st.state, p, s.billing_cycle) as mrr
    from public.restaurants r
    left join public.restaurant_subscriptions s on s.restaurant_id = r.id
    left join public.plans p on p.id = s.plan_id
    cross join lateral public.restaurant_access(r.id) as a
    cross join lateral (
      select private.subscription_state(r.status::text, a.state, s.status::text, s.source::text) as state
    ) as st
  )
  select
    jsonb_build_object(
      'total', count(*),
      'trialing', count(*) filter (where state = 'trial'),
      'active', count(*) filter (where state = 'paid'),
      'past_due', count(*) filter (where state = 'payment_failed'),
      'read_only', count(*) filter (where state = 'read_only'),
      'suspended', count(*) filter (where state = 'suspended')
    ),
    coalesce(sum(mrr), 0)
  into v_counts, v_mrr
  from states;

  select count(*) into v_orders
  from public.orders o
  where o.created_at >= now() - interval '24 hours';

  select coalesce(jsonb_agg(jsonb_build_object(
    'restaurant_id', r.id,
    'name', r.name,
    'slug', r.slug,
    'plan_name', p.name,
    'trial_ends_at', s.trial_ends_at
  ) order by s.trial_ends_at, r.name), '[]'::jsonb)
  into v_trials
  from public.restaurant_subscriptions s
  join public.restaurants r on r.id = s.restaurant_id
  join public.plans p on p.id = s.plan_id
  where s.status = 'trialing'
    and s.trial_ends_at >= now() and s.trial_ends_at < now() + interval '7 days';

  return jsonb_build_object(
    'restaurants', v_counts,
    'mrr_paise', v_mrr,
    'orders_24h', v_orders,
    'trials_ending', v_trials,
    'history_starts_on', (select min(m.day) from public.metrics_subscription_daily m)
  );
end;
$$;
