-- Stop 13f: revenue analytics (docs/SUPER_ADMIN_PLAN.md 13f, docs/DECISIONS.md SA-65+).
-- A restaurant's MRR on a day has one source, private.mrr_days: the nightly
-- snapshots, and today as it stands, counted as Home counts it. Every revenue
-- figure and the movement lists read it, so the movements always add up to the
-- change in MRR (plan §5.3).

-- ─── A restaurant's MRR, day by day ─────────────────────────────────────────
-- Each stored night from the last one on or before p_open, plus today live.
-- A missing night uses the one before: the previous row is the restaurant's
-- previous stored night. `movement` follows plan §5.3; the caller counts it
-- only after the opening day (the history's first night has no change). A
-- restaurant that paid before history began (a paid period that had ended)
-- comes back as Reactivation, not New.
create function private.mrr_days(p_open date)
returns table (
  day date,
  restaurant_id uuid,
  state text,
  plan_id uuid,
  billing_cycle public.billing_cycle,
  mrr_paise bigint,
  before_state text,
  before_plan_id uuid,
  before_paise bigint,
  movement text
)
language sql
stable
security definer
set search_path = ''
as $$
  with stored as (
    select m.day, m.restaurant_id, m.state, m.plan_id, m.billing_cycle, m.mrr_paise
    from public.metrics_subscription_daily m
    where m.day >= coalesce(
        (select max(o.day) from public.metrics_subscription_daily o where o.day <= p_open),
        p_open)
      and m.day < (now() at time zone 'Asia/Kolkata')::date
    union all
    select
      (now() at time zone 'Asia/Kolkata')::date, r.id, st.state, s.plan_id, s.billing_cycle,
      private.restaurant_mrr_paise(st.state, p, s.billing_cycle)
    from public.restaurants r
    left join public.restaurant_subscriptions s on s.restaurant_id = r.id
    left join public.plans p on p.id = s.plan_id
    cross join lateral public.restaurant_access(r.id) as a
    cross join lateral (
      select private.subscription_state(r.status::text, a.state, s.status::text, s.source::text) as state
    ) as st
  ),
  lagged as (
    select
      x.day, x.restaurant_id, x.state, x.plan_id, x.billing_cycle, x.mrr_paise,
      lag(x.state) over w as before_state,
      lag(x.plan_id) over w as before_plan_id,
      coalesce(lag(x.mrr_paise) over w, 0) as before_paise
    from stored x
    window w as (partition by x.restaurant_id order by x.day)
  )
  select
    l.day, l.restaurant_id, l.state, l.plan_id, l.billing_cycle, l.mrr_paise,
    l.before_state, l.before_plan_id, l.before_paise,
    case
      when l.before_paise = 0 and l.mrr_paise > 0 then
        case when exists (
          select 1 from public.metrics_subscription_daily e
          where e.restaurant_id = l.restaurant_id and e.day < l.day and e.mrr_paise > 0
        ) or exists (
          select 1 from public.subscription_payments sp
          where sp.restaurant_id = l.restaurant_id and sp.purpose = 'subscription'
            and sp.period_end <= l.day::timestamp at time zone 'Asia/Kolkata'
        ) then 'reactivation' else 'new' end
      when l.before_paise > 0 and l.mrr_paise = 0 then 'churn'
      when l.mrr_paise > l.before_paise then 'expansion'
      when l.mrr_paise < l.before_paise then 'contraction'
    end
  from lagged l
$$;

-- The first day of the bar a day falls in: the day, its week (from Monday) or
-- its month, never before the first date shown.
create function private.revenue_bucket(p_day date, p_from date, p_by text)
returns date
language sql
immutable
set search_path = ''
as $$
  select greatest(
    case p_by
      when 'day' then p_day
      when 'week' then date_trunc('week', p_day::timestamp)::date
      else date_trunc('month', p_day::timestamp)::date
    end,
    p_from)
$$;

-- ─── The Revenue page ───────────────────────────────────────────────────────
-- MenuMesh money by India date. MRR figures need history: the opening is the
-- last night before the dates, or the history's first night when it starts
-- inside them; with no night before the end, they are null. The period
-- compared with needs a night before it, or its MRR figures are null too.
-- Churn rates count the restaurants Paid at the opening (plan §5.8), so they
-- stay a share of it over any length of dates.
create function public.platform_revenue_report(
  p_from date,
  p_to date,
  p_by text default 'month',
  p_compare boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_start date;
  v_hist date;
  v_result jsonb;
begin
  perform private.require_platform_permission('money.view');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    perform private.fail('INVALID_INPUT', 'dates');
  end if;
  if p_by is null or p_by not in ('day', 'week', 'month') then
    perform private.fail('INVALID_INPUT', 'by');
  end if;
  v_start := case when p_compare then p_from - (p_to - p_from + 1) else p_from end;
  select min(m.day) into v_hist from public.metrics_subscription_daily m;

  with d as materialized (
    select * from private.mrr_days(v_start - 1)
  ),
  -- MRR and Paid on each day with rows.
  nights as materialized (
    select d.day, sum(d.mrr_paise) as mrr, count(*) filter (where d.state = 'paid') as paid
    from d
    group by d.day
  ),
  moves as materialized (
    select d.day, d.restaurant_id, d.movement, d.mrr_paise - d.before_paise as change
    from d
    where d.movement is not null and d.day >= p_from - (p_to - p_from + 1) and d.day > v_hist
  ),
  -- Each change of state, with the state that followed it.
  changes as materialized (
    select c.day, c.state, lead(c.state) over (partition by c.restaurant_id order by c.day) as next_state
    from d as c
    where c.state is distinct from c.before_state
  ),
  paid_days as materialized (
    select
      (p.created_at at time zone 'Asia/Kolkata')::date as day,
      coalesce(sum(p.base_paise) filter (where p.purpose = 'subscription'), 0) as subscription,
      coalesce(sum(p.base_paise) filter (where p.purpose = 'setup_fee'), 0) as setup_fee,
      sum(p.gst_paise) as gst,
      count(*) as n
    from public.subscription_payments p
    where p.created_at >= v_start::timestamp at time zone 'Asia/Kolkata'
      and p.created_at < (p_to + 1)::timestamp at time zone 'Asia/Kolkata'
    group by 1
  ),
  -- Trial cohorts (plan §5.7): converted is a first subscription payment by the
  -- trial's end plus 30 days.
  cohort as materialized (
    select
      (r.created_at at time zone 'Asia/Kolkata')::date as day,
      r.created_at,
      fp.paid_at,
      coalesce(s.trial_ends_at, r.created_at) + interval '30 days' as deadline
    from public.restaurants r
    left join public.restaurant_subscriptions s on s.restaurant_id = r.id
    cross join lateral (
      select min(p.created_at) as paid_at
      from public.subscription_payments p
      where p.restaurant_id = r.id and p.purpose = 'subscription'
    ) as fp
    where r.created_at >= v_start::timestamp at time zone 'Asia/Kolkata'
      and r.created_at < (p_to + 1)::timestamp at time zone 'Asia/Kolkata'
  ),
  periods as (
    select 'now' as key, p_from as f, p_to as t
    union all
    select 'previous', v_start, p_from - 1 where p_compare
  ),
  bounds as (
    select
      pr.key, pr.f, pr.t,
      case when pr.key = 'now'
        then greatest((select max(n.day) from nights n where n.day < pr.f), v_hist)
        else (select max(n.day) from nights n where n.day < pr.f)
      end as open_day,
      (select max(n.day) from nights n where n.day <= pr.t) as end_day
    from periods pr
  ),
  totals as (
    select b.key, jsonb_build_object(
      'mrr_paise', te.mrr,
      'paid', te.paid,
      'opening_day', case when b.open_day <= b.t then b.open_day end,
      'opening_mrr_paise', case when b.open_day <= b.t then tob.mrr end,
      'opening_paid', case when b.open_day <= b.t then tob.paid end,
      'movements', mv.movements,
      'churned', lost.churned,
      'lost_paise', lost.paise,
      'collected', (
        select jsonb_build_object(
          'subscription_base_paise', coalesce(sum(x.subscription), 0),
          'setup_fee_base_paise', coalesce(sum(x.setup_fee), 0),
          'gst_paise', coalesce(sum(x.gst), 0),
          'count', coalesce(sum(x.n), 0))
        from paid_days x
        where x.day between b.f and b.t
      ),
      'conversion', (
        select jsonb_build_object(
          'created', count(*),
          'converted', count(*) filter (where c.paid_at <= c.deadline),
          'deciding', count(*) filter (where c.paid_at is null and now() < c.deadline),
          'average_days', round(avg(extract(epoch from c.paid_at - c.created_at) / 86400)
            filter (where c.paid_at <= c.deadline), 1))
        from cohort c
        where c.day between b.f and b.t
      ),
      'recovery', (
        select jsonb_build_object(
          'entered', count(*),
          'recovered', count(*) filter (where c.next_state = 'paid'),
          'still_failed', count(*) filter (where c.next_state is null))
        from changes c
        where c.state = 'payment_failed' and c.day between b.f and b.t and c.day > b.open_day
      )
    ) as body
    from bounds b
    left join nights te on te.day = b.end_day
    left join nights tob on tob.day = b.open_day
    cross join lateral (
      select jsonb_object_agg(k.kind, jsonb_build_object('count', k.n, 'paise', k.paise)) as movements
      from (
        select kinds.kind, count(m.day) as n, coalesce(sum(m.change), 0) as paise
        from unnest(array['new', 'reactivation', 'expansion', 'contraction', 'churn']) as kinds(kind)
        left join moves m
          on m.movement = kinds.kind and m.day between b.f and b.t and m.day > b.open_day
        group by kinds.kind
      ) as k
    ) as mv
    -- Of the restaurants Paid at the opening: those that churned, and the MRR
    -- they lost or gave up, never more than each one's opening MRR.
    cross join lateral (
      select
        count(*) filter (where x.churned) as churned,
        coalesce(sum(least(x.opening, x.lost)), 0) as paise
      from (
        select
          o.mrr_paise as opening,
          bool_or(m.movement = 'churn') as churned,
          coalesce(-sum(m.change) filter (where m.movement in ('churn', 'contraction')), 0) as lost
        from d as o
        join moves m
          on m.restaurant_id = o.restaurant_id and m.day between b.f and b.t and m.day > b.open_day
        where o.day = b.open_day and o.mrr_paise > 0
        group by o.restaurant_id, o.mrr_paise
      ) as x
    ) as lost
  ),
  buckets as (
    select private.revenue_bucket(g.day::date, p_from, p_by) as start, max(g.day::date) as finish
    from generate_series(p_from, p_to, interval '1 day') as g(day)
    group by 1
  ),
  series as (
    select jsonb_agg(jsonb_build_object(
      'start', b.start,
      'end', b.finish,
      'mrr_paise', te.mrr,
      'paid', te.paid,
      'movements', mv.movements,
      'subscription_base_paise', coalesce(pd.subscription, 0),
      'setup_fee_base_paise', coalesce(pd.setup_fee, 0),
      'gst_paise', coalesce(pd.gst, 0)
    ) order by b.start) as body
    from buckets b
    -- Bars after today have no MRR yet.
    left join lateral (
      select n.mrr, n.paid from nights n
      where n.day <= b.finish and b.start <= v_today
      order by n.day desc limit 1
    ) as te on true
    cross join lateral (
      select jsonb_object_agg(k.kind, jsonb_build_object('count', k.n, 'paise', k.paise)) as movements
      from (
        select kinds.kind, count(m.day) as n, coalesce(sum(m.change), 0) as paise
        from unnest(array['new', 'reactivation', 'expansion', 'contraction', 'churn']) as kinds(kind)
        left join moves m on m.movement = kinds.kind and m.day between b.start and b.finish
        group by kinds.kind
      ) as k
    ) as mv
    left join lateral (
      select sum(x.subscription) as subscription, sum(x.setup_fee) as setup_fee, sum(x.gst) as gst
      from paid_days x
      where x.day between b.start and b.finish
    ) as pd on true
  )
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'by', p_by,
    'previous_from', case when p_compare then v_start end,
    'previous_to', case when p_compare then p_from - 1 end,
    'history_starts_on', v_hist,
    'totals', (select t.body from totals t where t.key = 'now'),
    'previous', (select t.body from totals t where t.key = 'previous'),
    'series', (select s.body from series s),
    'plan_mix', coalesce((
      select jsonb_agg(jsonb_build_object(
        'plan_code', x.code, 'plan_name', x.name, 'billing_cycle', x.cycle,
        'restaurants', x.n, 'mrr_paise', x.mrr) order by x.sort_order, x.cycle)
      from (
        select p.code, p.name, p.sort_order, coalesce(d.billing_cycle, 'monthly') as cycle,
          count(*) as n, sum(d.mrr_paise) as mrr
        from d
        join public.plans p on p.id = d.plan_id
        where d.state = 'paid' and d.day = (select b.end_day from bounds b where b.key = 'now')
        group by p.code, p.name, p.sort_order, coalesce(d.billing_cycle, 'monthly')
      ) as x
    ), '[]'::jsonb),
    'cohorts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'start', x.start, 'created', x.created, 'converted', x.converted,
        'deciding', x.deciding, 'average_days', x.average_days) order by x.start)
      from (
        select
          private.revenue_bucket(c.day, p_from, 'month') as start,
          count(*) as created,
          count(*) filter (where c.paid_at <= c.deadline) as converted,
          count(*) filter (where c.paid_at is null and now() < c.deadline) as deciding,
          round(avg(extract(epoch from c.paid_at - c.created_at) / 86400)
            filter (where c.paid_at <= c.deadline), 1) as average_days
        from cohort c
        where c.day >= p_from
        group by 1
      ) as x
    ), '[]'::jsonb),
    'reasons', coalesce((
      select jsonb_agg(jsonb_build_object('reason', x.reason, 'count', x.n)
        order by x.n desc, x.reason)
      from (
        select a.after ->> 'reason' as reason, count(*) as n
        from public.audit_logs a
        where a.action = 'subscription.cancel_reason'
          and a.created_at >= p_from::timestamp at time zone 'Asia/Kolkata'
          and a.created_at < (p_to + 1)::timestamp at time zone 'Asia/Kolkata'
        group by 1
      ) as x
    ), '[]'::jsonb),
    'launch_offer', (
      select jsonb_build_object(
        'setup_fees', count(*),
        'with_offer', count(*) filter (where p.list_price_paise is not null and p.discount_paise > 0),
        'discount_paise', coalesce(sum(p.discount_paise)
          filter (where p.list_price_paise is not null and p.discount_paise > 0), 0),
        'full_price', count(*) filter (
          where p.list_price_paise is not null and coalesce(p.discount_paise, 0) = 0),
        'not_recorded', count(*) filter (where p.list_price_paise is null))
      from public.subscription_payments p
      where p.purpose = 'setup_fee'
        and p.created_at >= p_from::timestamp at time zone 'Asia/Kolkata'
        and p.created_at < (p_to + 1)::timestamp at time zone 'Asia/Kolkata'
    ),
    'expected', (
      select jsonb_build_object(
        'autopay_paise', coalesce(sum(x.due_paise) filter (where x.renewal_kind = 'autopay'), 0),
        'autopay_count', count(*) filter (where x.renewal_kind = 'autopay'),
        'needs_payment_paise', coalesce(sum(x.due_paise)
          filter (where x.renewal_kind = 'needs_payment'), 0),
        'needs_payment_count', count(*) filter (where x.renewal_kind = 'needs_payment'))
      from private.dues_rows() as x
      where x.bucket = 'renewal_due'
    )
  )
  into v_result;

  return v_result;
end;
$$;

-- The restaurants behind one movement bar: MRR and state before and after.
create function public.platform_revenue_movements(p_from date, p_to date, p_kind text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_hist date;
  v_result jsonb;
begin
  perform private.require_platform_permission('money.view');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    perform private.fail('INVALID_INPUT', 'dates');
  end if;
  if p_kind is null or p_kind not in ('new', 'reactivation', 'expansion', 'contraction', 'churn') then
    perform private.fail('INVALID_INPUT', 'kind');
  end if;
  select min(m.day) into v_hist from public.metrics_subscription_daily m;

  with m as materialized (
    select d.*
    from private.mrr_days(p_from - 1) as d
    where d.movement = p_kind and d.day between p_from and p_to and d.day > v_hist
  )
  select jsonb_build_object(
    'total', (select count(*) from m),
    'rows', coalesce((
      select jsonb_agg(x.row order by x.day desc, x.name, x.restaurant_id)
      from (
        select m.day, r.name, r.id as restaurant_id, jsonb_build_object(
          'day', m.day,
          'restaurant_id', r.id,
          'name', r.name,
          'city', nullif(btrim(r.city), ''),
          'state_before', m.before_state,
          'state_after', m.state,
          'plan_before', pb.name,
          'plan_after', pa.name,
          'before_paise', m.before_paise,
          'after_paise', m.mrr_paise
        ) as row
        from m
        join public.restaurants r on r.id = m.restaurant_id
        left join public.plans pb on pb.id = m.before_plan_id
        left join public.plans pa on pa.id = m.plan_id
        order by m.day desc, r.name, r.id
        limit 500
      ) as x
    ), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

-- ─── Grants ─────────────────────────────────────────────────────────────────
revoke execute on function private.mrr_days(date) from public, anon, authenticated;
revoke execute on function private.revenue_bucket(date, date, text)
  from public, anon, authenticated;
revoke execute on function public.platform_revenue_report(date, date, text, boolean)
  from public, anon;
grant execute on function public.platform_revenue_report(date, date, text, boolean)
  to authenticated;
revoke execute on function public.platform_revenue_movements(date, date, text) from public, anon;
grant execute on function public.platform_revenue_movements(date, date, text) to authenticated;
