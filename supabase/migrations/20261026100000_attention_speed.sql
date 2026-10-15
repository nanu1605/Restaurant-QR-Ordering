-- Needs attention, the alerts bell and Home's key numbers, fast at thousands of
-- restaurants (docs/DECISIONS.md SA-76). They read every restaurant's access,
-- and the caller check in public.restaurant_access cost six times the access
-- itself on each call. Same results as before.

-- ─── Access without the caller check ────────────────────────────────────────
-- For functions that have checked the platform member once and then ask about
-- every restaurant. public.restaurant_access is this, after its check.
CREATE FUNCTION private.restaurant_access(p_restaurant_id uuid, p_at timestamp with time zone DEFAULT now())
 RETURNS TABLE(state text, reason text, restriction_at timestamp with time zone, warning text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_restaurant public.restaurants%rowtype;
  v_sub public.restaurant_subscriptions%rowtype;
  v_lapse timestamptz;
  v_reason text;
  v_restriction timestamptz;
  v_warning text;
  v_autopay_trial boolean;
begin
  select * into v_restaurant from public.restaurants where id = p_restaurant_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'RESTAURANT_NOT_FOUND';
  end if;

  if v_restaurant.status = 'suspended' then
    return query select 'read_only'::text, 'suspended'::text, null::timestamptz, null::text;
    return;
  end if;

  select * into v_sub from public.restaurant_subscriptions where restaurant_id = p_restaurant_id;
  if not found then
    return query select 'read_only'::text, 'no_subscription'::text, null::timestamptz, null::text;
    return;
  end if;

  v_autopay_trial := v_sub.status = 'trialing' and v_sub.razorpay_status = 'authenticated';

  -- 1. When does access lapse?
  case v_sub.status
    when 'trialing' then
      v_lapse := case
        when v_autopay_trial then v_sub.trial_ends_at + interval '2 days'
        else v_sub.trial_ends_at
      end;
      v_reason := 'trial_ended';
    when 'active' then
      -- Buffer for delayed renewal webhooks.
      v_lapse := v_sub.current_period_end + interval '2 days';
      v_reason := 'subscription_lapsed';
    when 'past_due', 'halted' then
      v_lapse := coalesce(v_sub.grace_until, v_sub.current_period_end + interval '2 days');
      v_reason := 'payment_failed';
    else -- cancelled, expired
      v_lapse := coalesce(v_sub.current_period_end, v_sub.trial_ends_at);
      v_reason := 'subscription_ended';
  end case;

  if v_lapse is null then
    if v_sub.status in ('cancelled', 'expired') then
      return query select 'read_only'::text, v_reason, null::timestamptz, null::text;
    else
      -- e.g. an active subscription without a period end: nothing to enforce.
      return query select 'full'::text, null::text, null::timestamptz, null::text;
    end if;
    return;
  end if;

  -- 2. Never lock a restaurant mid-service: restrict from the next business-day start.
  v_restriction := private.next_business_day_start(
    v_lapse, v_restaurant.timezone, v_restaurant.business_day_start_hour
  );

  if p_at < v_restriction then
    v_warning := case
      when v_sub.status in ('past_due', 'halted') then 'payment_failed'
      when v_restriction - p_at > interval '3 days' then null
      -- Autopay is set up: the first charge renews it.
      when v_autopay_trial then null
      when v_sub.status = 'trialing' then 'trial_ends_soon'
      -- Auto-renewing subscriptions only warn when they are set to end.
      when v_sub.status = 'active' and not v_sub.cancel_at_period_end then null
      else 'subscription_ends_soon'
    end;
    return query select 'full'::text, null::text, v_restriction, v_warning;
  else
    return query select 'read_only'::text, v_reason, v_restriction, null::text;
  end if;
end;
$function$;

revoke execute on function private.restaurant_access(uuid, timestamptz)
  from public, anon, authenticated;

-- A plain call in the check, not a sub-select: PL/pgSQL then keeps the
-- check's plan from one call to the next.
create or replace function public.restaurant_access(
  p_restaurant_id uuid,
  p_at timestamptz default now()
)
returns table (state text, reason text, restriction_at timestamptz, warning text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- Service role (no signed-in user), platform admins and members only.
  if auth.uid() is not null
     and not public.is_platform_admin()
     and public.member_role(p_restaurant_id) is null then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  return query select * from private.restaurant_access(p_restaurant_id, p_at);
end;
$$;

-- ─── Changed definitions ────────────────────────────────────────────────────
-- private.restaurant_access in place of the public one. In Needs attention, the
-- duplicates' lookalikes are worked out once a signup, not again for the item.

CREATE OR REPLACE FUNCTION private.dues_rows(p_q text DEFAULT NULL::text)
 RETURNS TABLE(restaurant_id uuid, name text, slug text, city text, phone text, status public.subscription_status, source public.subscription_source, billing_cycle public.billing_cycle, trial_ends_at timestamp with time zone, current_period_end timestamp with time zone, grace_until timestamp with time zone, cancel_at_period_end boolean, razorpay_status text, autopay boolean, renewal_kind text, plan_code text, plan_name text, due_paise bigint, access_state text, access_reason text, restriction_at timestamp with time zone, bucket text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    r.id, r.name, r.slug, r.city, r.phone,
    s.status, s.source, s.billing_cycle, s.trial_ends_at, s.current_period_end,
    s.grace_until, s.cancel_at_period_end, s.razorpay_status,
    private.razorpay_managed(s),
    private.renewal_kind(s),
    pl.code, pl.name,
    private.fee_with_gst(private.cycle_price_paise(pl, coalesce(
      case when m.live then s.next_billing_cycle end, s.billing_cycle, 'monthly'
    ))),
    a.state, a.reason, a.restriction_at,
    b.bucket
  from public.restaurants r
  join public.restaurant_subscriptions s on s.restaurant_id = r.id
  -- A mandate Razorpay charges or retries; one not yet paid for has its plan
  -- waiting in next_plan_id.
  cross join lateral (
    select coalesce(s.razorpay_status in ('authenticated', 'active', 'pending', 'halted'), false)
      as live
  ) as m
  join public.plans pl on pl.id = coalesce(case when m.live then s.next_plan_id end, s.plan_id)
  cross join lateral private.restaurant_access(r.id) as a
  cross join lateral (
    select case
      when a.state = 'full' and s.status in ('past_due', 'halted') then 'payment_failed'
      when a.state = 'read_only' then 'lapsed'
      when s.status = 'trialing' and not private.razorpay_managed(s)
        and s.trial_ends_at <= now() + interval '3 days'
        then 'trial_ending'
      when s.status = 'active' and s.source is not null
        and s.current_period_end <= now() + interval '30 days'
        then 'renewal_due'
    end as bucket
  ) as b
  where r.status = 'active'
    and b.bucket is not null
    and (p_q is null or r.name ilike '%' || p_q || '%' or r.slug ilike '%' || p_q || '%');
$function$;

CREATE OR REPLACE FUNCTION private.attention(p_admin uuid, p_money boolean, p_growth boolean, p_system boolean, p_limit integer DEFAULT 5)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with dues as (
    select d.* from private.dues_rows() d where p_money
  ),
  items as (
    select 'payment_failed' as grp, d.restaurant_id::text as id,
      extract(epoch from coalesce(d.grace_until, d.current_period_end)) as ord,
      to_jsonb(d) - 'bucket' - 'access_state' || jsonb_build_object(
        'state', private.subscription_state('active', d.access_state, d.status::text, d.source::text),
        'last_reminder_kind', null, 'last_reminder_at', null
      ) as data
    from dues d where d.bucket = 'payment_failed'
    union all
    select 'trial_ending', d.restaurant_id::text, extract(epoch from d.trial_ends_at),
      to_jsonb(d) - 'bucket' - 'access_state' || jsonb_build_object(
        'state', private.subscription_state('active', d.access_state, d.status::text, d.source::text),
        'last_reminder_kind', null, 'last_reminder_at', null
      )
    from dues d where d.bucket = 'trial_ending'
    union all
    -- Manual and payment-link restaurants never renew on their own.
    select 'needs_payment', d.restaurant_id::text, extract(epoch from d.current_period_end),
      to_jsonb(d) - 'bucket' - 'access_state' || jsonb_build_object(
        'state', private.subscription_state('active', d.access_state, d.status::text, d.source::text),
        'last_reminder_kind', null, 'last_reminder_at', null
      )
    from dues d
    where d.bucket = 'renewal_due' and d.renewal_kind = 'needs_payment'
      and d.current_period_end <= now() + interval '7 days'
    union all
    -- Leads no one has contacted 24 hours after they came in, oldest first (SA-56).
    select 'new_leads', l.id::text, extract(epoch from l.created_at),
      jsonb_build_object(
        'lead_id', l.id, 'name', l.name, 'restaurant_name', l.restaurant_name,
        'city', l.city, 'phone', l.phone, 'created_at', l.created_at
      )
    from public.site_leads l
    where p_growth and l.stage = 'new' and l.created_at <= now() - interval '24 hours'
    union all
    -- Quiet restaurants that still have full access: a lapsed or suspended one
    -- is quiet for a reason Dues or the team already knows.
    select h.health, h.id::text, 0,
      jsonb_build_object(
        'restaurant_id', h.id, 'name', h.name, 'slug', h.slug, 'city', h.city,
        'phone', h.phone, 'health', h.health
      )
    from (
      select r.id, r.name, r.slug, r.city, r.phone,
        private.restaurant_health(r.id, r.created_at) as health
      from public.restaurants r
      where r.status = 'active'
    ) as h
    cross join lateral private.restaurant_access(h.id) as a
    where h.health in ('inactive', 'slowing') and a.state = 'full'
    union all
    select 'stuck_onboarding', o.id::text, extract(epoch from (o.ob ->> 'since')::timestamptz),
      jsonb_build_object(
        'restaurant_id', o.id, 'name', o.name, 'slug', o.slug, 'city', o.city,
        'phone', o.phone, 'next', o.ob ->> 'next', 'since', o.ob -> 'since'
      )
    from (
      select r.id, r.name, r.slug, r.city, r.phone, x.onboarding as ob
      from private.restaurants_onboarding(array(
        select r.id from public.restaurants r
        where r.status = 'active' and r.created_at >= now() - interval '60 days'
      )) as x
      join public.restaurants r on r.id = x.restaurant_id
      where (x.onboarding ->> 'stuck')::boolean and x.onboarding ->> 'next' <> 'paid'
      offset 0 -- access only for the stuck ones
    ) as o
    cross join lateral private.restaurant_access(o.id) as a
    where a.state = 'full'
    union all
    select 'support_open', q.id::text, extract(epoch from q.created_at),
      jsonb_build_object(
        'request_id', q.id, 'restaurant_id', q.restaurant_id, 'name', r.name,
        'topic', q.topic, 'status', q.status, 'created_at', q.created_at
      )
    from public.support_requests q
    join public.restaurants r on r.id = q.restaurant_id
    where q.status in ('open', 'in_progress') and q.created_at < now() - interval '24 hours'
      -- The digest (no admin) lists them all.
      and (p_admin is null or private.has_platform_permission('restaurants.support'))
    union all
    -- Signups of the last week that look like another restaurant (P11-13).
    select 'duplicates', r.id::text, -extract(epoch from r.created_at),
      jsonb_build_object(
        'restaurant_id', r.id, 'name', r.name, 'slug', r.slug, 'city', r.city,
        'created_at', r.created_at, 'matches', lk.matches
      )
    from public.restaurants r
    cross join lateral (
      select private.restaurant_lookalikes(r.id) as matches
      offset 0 -- once a signup, not again for the item
    ) as lk
    where r.created_at >= now() - interval '7 days' and r.status = 'active'
      and exists (select 1 from public.trial_claims c where c.restaurant_id = r.id)
      and jsonb_array_length(lk.matches) > 0
    union all
    select 'webhooks', w.id::text, -extract(epoch from w.received_at),
      jsonb_build_object(
        'id', w.id, 'event_type', w.event_type, 'received_at', w.received_at,
        'error', w.processing_error
      )
    from public.webhook_events w
    where p_system and w.processing_error is not null
    union all
    -- Each scheduled step's latest run of the last two days, when it failed.
    select 'cron', c.job || ':' || c.step, -extract(epoch from c.started_at),
      jsonb_build_object(
        'job', c.job, 'step', c.step, 'started_at', c.started_at, 'detail', c.detail
      )
    from (
      select distinct on (x.job, x.step) x.*
      from public.cron_runs x
      where x.started_at >= now() - interval '2 days'
      order by x.job, x.step, x.started_at desc
    ) as c
    where p_system and not c.ok
  ),
  open_items as (
    select i.*, i.grp || ':' || i.id as key,
      row_number() over (partition by i.grp order by i.ord, i.data ->> 'name', i.id) as n,
      count(*) over (partition by i.grp) as total
    from items i
    where p_admin is null or not exists (
      select 1 from public.platform_snoozes z
      where z.admin_id = p_admin and z.item_key = i.grp || ':' || i.id and z.until > now()
    )
  ),
  groups as (
    select o.grp, max(o.total) as total,
      jsonb_agg(jsonb_build_object('key', o.key, 'data', o.data) order by o.n)
        filter (where o.n <= p_limit) as items
    from open_items o
    group by o.grp
  )
  select jsonb_build_object(
    'total', coalesce((select sum(g.total) from groups g), 0),
    'inactive_days', (select s.health_inactive_days from public.platform_settings s where s.id = 1),
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object('group', g.grp, 'count', g.total, 'items', g.items)
        order by array_position(array['payment_failed', 'trial_ending', 'needs_payment',
          'new_leads', 'support_open', 'stuck_onboarding', 'inactive', 'slowing', 'duplicates',
          'webhooks', 'cron'], g.grp))
      from groups g
    ), '[]'::jsonb)
  );
$function$;

CREATE OR REPLACE FUNCTION public.platform_home(p_period text DEFAULT 'today'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_money boolean;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_from date;
  v_counts jsonb;
  v_mrr bigint;
  v_mrr_before bigint;
  v_collected jsonb;
  v_gmv bigint;
  v_orders bigint;
  v_open bigint;
  v_mrr_series jsonb;
  v_usage_series jsonb;
  v_new_series jsonb;
  v_last date;
begin
  perform private.require_platform_permission('restaurants.view');
  v_money := private.has_platform_permission('money.view');
  if p_period is null or p_period not in ('today', 'month') then
    perform private.fail('INVALID_INPUT', 'period');
  end if;
  v_from := case when p_period = 'today' then v_today else date_trunc('month', v_today)::date end;

  with states as (
    select st.state, private.restaurant_mrr_paise(st.state, p, s.billing_cycle) as mrr
    from public.restaurants r
    left join public.restaurant_subscriptions s on s.restaurant_id = r.id
    left join public.plans p on p.id = s.plan_id
    cross join lateral private.restaurant_access(r.id) as a
    cross join lateral (
      select private.subscription_state(r.status::text, a.state, s.status::text, s.source::text) as state
    ) as st
  )
  select
    jsonb_build_object(
      'total', count(*),
      'paid', count(*) filter (where state = 'paid'),
      'trial', count(*) filter (where state = 'trial'),
      'payment_failed', count(*) filter (where state = 'payment_failed'),
      'read_only', count(*) filter (where state = 'read_only'),
      'suspended', count(*) filter (where state = 'suspended'),
      'cancelled', count(*) filter (where state = 'cancelled')
    ),
    coalesce(sum(mrr), 0)
  into v_counts, v_mrr
  from states;

  -- The same India date a month ago, from that night's snapshot.
  select sum(m.mrr_paise) into v_mrr_before
  from public.metrics_subscription_daily m
  where m.day = (v_today - interval '1 month')::date;

  select jsonb_build_object(
    'base_paise', coalesce(sum(p.base_paise), 0),
    'gst_paise', coalesce(sum(p.gst_paise), 0),
    'count', count(*)
  )
  into v_collected
  from public.subscription_payments p
  where p.created_at >= v_from::timestamp at time zone 'Asia/Kolkata'
    and p.created_at < (v_today + 1)::timestamp at time zone 'Asia/Kolkata';

  -- Today is each restaurant's current business day, as its own dashboard
  -- shows it; This month is the business days in this India month. The chart
  -- has the last 30 days every restaurant has finished: before 04:00 India
  -- time yesterday is still open for most.
  select coalesce(min(private.business_date(now(), r.timezone, r.business_day_start_hour)), v_today) - 1
  into v_last
  from public.restaurants r;
  with u as (
    select * from private.platform_usage(least(v_from, v_last - 29), v_today)
  ),
  numbers as (
    select coalesce(sum(u.gmv_paise), 0) as gmv, coalesce(sum(u.orders), 0) as orders
    from u
    where case when p_period = 'today' then u.today else u.business_day >= v_from end
  ),
  days as (
    select u.business_day as day, sum(u.gmv_paise) as gmv, sum(u.orders) as orders
    from u
    where not u.today and u.business_day between v_last - 29 and v_last
    group by u.business_day
  )
  select
    n.gmv, n.orders,
    (select jsonb_agg(jsonb_build_object(
       'day', g.day::date,
       'gmv_paise', coalesce(d.gmv, 0),
       'orders', coalesce(d.orders, 0)
     ) order by g.day)
     from generate_series(v_last - 29, v_last, interval '1 day') as g(day)
     left join days d on d.day = g.day::date)
  into v_gmv, v_orders, v_usage_series
  from numbers n;

  select count(*) into v_open
  from public.table_sessions ts
  join public.restaurants r on r.id = ts.restaurant_id
  where ts.status = 'open' and r.status = 'active';

  -- Each night's MRR for the last 12 months, and today's as it stands.
  select jsonb_agg(jsonb_build_object('day', x.day, 'mrr_paise', x.mrr) order by x.day)
  into v_mrr_series
  from (
    select m.day, sum(m.mrr_paise) as mrr
    from public.metrics_subscription_daily m
    where m.day >= v_today - 365 and m.day < v_today
    group by m.day
    union all
    select v_today, v_mrr
  ) as x;

  -- New restaurants by India week (Monday first): signups and the team's.
  select jsonb_agg(jsonb_build_object('week', c.week, 'signup', c.signup, 'team', c.team)
    order by c.week)
  into v_new_series
  from (
    select
      w.week::date as week,
      count(x.id) filter (where x.signup) as signup,
      count(x.id) filter (where not x.signup) as team
    from generate_series(
      date_trunc('week', v_today::timestamp) - interval '11 weeks',
      date_trunc('week', v_today::timestamp),
      interval '1 week'
    ) as w(week)
    left join lateral (
      select r.id, exists (select 1 from public.trial_claims t where t.restaurant_id = r.id) as signup
      from public.restaurants r
      where r.created_at >= w.week at time zone 'Asia/Kolkata'
        and r.created_at < (w.week + interval '1 week') at time zone 'Asia/Kolkata'
    ) as x on true
    group by w.week
  ) as c;

  return jsonb_build_object(
    'period', p_period,
    'money', v_money,
    'restaurants', v_counts,
    'mrr_paise', case when v_money then v_mrr end,
    'mrr_month_ago_paise', case when v_money then v_mrr_before end,
    'collected', case when v_money then v_collected end,
    'gmv_paise', v_gmv,
    'orders', v_orders,
    'open_tables', v_open,
    'history_starts_on', (select min(m.day) from public.metrics_subscription_daily m),
    'charts', jsonb_build_object(
      'mrr', case when v_money then v_mrr_series end,
      'usage', coalesce(v_usage_series, '[]'::jsonb),
      'new_restaurants', coalesce(v_new_series, '[]'::jsonb)
    )
  );
end;
$function$;
