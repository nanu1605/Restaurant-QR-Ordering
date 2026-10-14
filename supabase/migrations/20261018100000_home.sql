-- Super-admin redesign, stop 12e (docs/SUPER_ADMIN_PLAN.md 12e, §4.5;
-- docs/DECISIONS.md SA-27 to SA-32): Home's key numbers and charts, Needs
-- attention with per-admin snoozes, the activity stream, live alerts and the
-- daily digest's numbers.

-- ─── Dues, one rule ─────────────────────────────────────────────────────────
-- Every restaurant that owes or soon will, in the first Dues bucket that fits
-- (plan §5.6, SA-19): the Dues page and Needs attention both read it.
create function private.dues_rows(p_q text default null)
returns table (
  restaurant_id uuid,
  name text,
  slug text,
  city text,
  phone text,
  status public.subscription_status,
  source public.subscription_source,
  billing_cycle public.billing_cycle,
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  grace_until timestamptz,
  cancel_at_period_end boolean,
  razorpay_status text,
  autopay boolean,
  renewal_kind text,
  plan_code text,
  plan_name text,
  due_paise bigint,
  access_state text,
  access_reason text,
  restriction_at timestamptz,
  bucket text
)
language sql
stable
security definer
set search_path = ''
as $$
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
  cross join lateral public.restaurant_access(r.id) as a
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
$$;

revoke execute on function private.dues_rows(text) from public, anon, authenticated;

-- The Dues page, now reading the shared rule (unchanged results).
create or replace function public.platform_list_dues(p_filters jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_bucket text;
  v_days int;
  v_q text;
  v_page int;
  v_page_size constant int := 50;
  v_counts jsonb;
  v_expected jsonb;
  v_kinds jsonb;
  v_total bigint;
  v_rows jsonb;
begin
  perform private.require_platform_permission('money.view');
  perform private.assert_keys(v_filters, array['bucket', 'days', 'q', 'page']);
  v_bucket := coalesce(private.json_text(v_filters, 'bucket'), 'payment_failed');
  if v_bucket not in ('payment_failed', 'lapsed', 'trial_ending', 'renewal_due') then
    perform private.fail('INVALID_INPUT', 'bucket');
  end if;
  v_days := case
    when coalesce(jsonb_typeof(v_filters -> 'days'), 'null') = 'null' then 30
    else private.json_int(v_filters, 'days')
  end;
  if v_days not in (7, 30) then
    perform private.fail('INVALID_INPUT', 'days');
  end if;
  v_q := nullif(btrim(coalesce(private.json_text(v_filters, 'q'), '')), '');
  if length(v_q) > 80 then
    perform private.fail('INVALID_INPUT', 'q');
  end if;
  v_page := case
    when coalesce(jsonb_typeof(v_filters -> 'page'), 'null') = 'null' then 1
    else private.json_int(v_filters, 'page')
  end;
  if v_page < 1 or v_page > 10000 then
    perform private.fail('INVALID_INPUT', 'page');
  end if;

  with dues as (
    select d.*, d.bucket = v_bucket and (
        v_bucket <> 'renewal_due'
        or d.current_period_end <= now() + make_interval(days => v_days)
      ) as chosen,
      case v_bucket
        when 'payment_failed' then coalesce(d.grace_until, d.current_period_end)
        when 'lapsed' then d.restriction_at
        when 'trial_ending' then d.trial_ends_at
        else d.current_period_end
      end as sort_at
    from private.dues_rows(v_q) d
  ),
  page as (
    select d.*
    from dues d
    where d.chosen
    -- Renewals by kind; lapsed: most recent first; the rest: soonest first.
    order by
      case when v_bucket = 'renewal_due'
        then array_position(array['autopay', 'needs_payment', 'ending'], d.renewal_kind) end,
      case when v_bucket <> 'lapsed' then d.sort_at end asc nulls last,
      case when v_bucket = 'lapsed' then d.sort_at end desc nulls last,
      d.name, d.restaurant_id
    limit v_page_size offset (v_page - 1) * v_page_size
  )
  select
    jsonb_build_object(
      'payment_failed', count(*) filter (where d.bucket = 'payment_failed'),
      'lapsed', count(*) filter (where d.bucket = 'lapsed'),
      'trial_ending', count(*) filter (where d.bucket = 'trial_ending'),
      'renewal_due', count(*) filter (
        where d.bucket = 'renewal_due'
          and d.current_period_end <= now() + make_interval(days => v_days)
      )
    ),
    jsonb_build_object(
      'autopay_paise', coalesce(sum(d.due_paise) filter (
        where d.bucket = 'renewal_due' and d.renewal_kind = 'autopay'), 0),
      'autopay_count', count(*) filter (
        where d.bucket = 'renewal_due' and d.renewal_kind = 'autopay'),
      'needs_payment_paise', coalesce(sum(d.due_paise) filter (
        where d.bucket = 'renewal_due' and d.renewal_kind = 'needs_payment'), 0),
      'needs_payment_count', count(*) filter (
        where d.bucket = 'renewal_due' and d.renewal_kind = 'needs_payment')
    ),
    jsonb_build_object(
      'autopay', count(*) filter (where d.chosen and d.renewal_kind = 'autopay'),
      'needs_payment', count(*) filter (where d.chosen and d.renewal_kind = 'needs_payment'),
      'ending', count(*) filter (where d.chosen and d.renewal_kind = 'ending')
    ),
    count(*) filter (where d.chosen),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'restaurant_id', pg.restaurant_id,
        'name', pg.name,
        'slug', pg.slug,
        'city', pg.city,
        'phone', pg.phone,
        'plan_code', pg.plan_code,
        'plan_name', pg.plan_name,
        'billing_cycle', pg.billing_cycle,
        'status', pg.status,
        'source', pg.source,
        'state', private.subscription_state(
          'active', pg.access_state, pg.status::text, pg.source::text
        ),
        'trial_ends_at', pg.trial_ends_at,
        'current_period_end', pg.current_period_end,
        'grace_until', pg.grace_until,
        'restriction_at', pg.restriction_at,
        'access_reason', pg.access_reason,
        'razorpay_status', pg.razorpay_status,
        'autopay', pg.autopay,
        'renewal_kind', pg.renewal_kind,
        'due_paise', pg.due_paise,
        'last_reminder_kind', rem.kind,
        'last_reminder_at', rem.sent_at
      ) order by
        case when v_bucket = 'renewal_due'
          then array_position(array['autopay', 'needs_payment', 'ending'], pg.renewal_kind) end,
        case when v_bucket <> 'lapsed' then pg.sort_at end asc nulls last,
        case when v_bucket = 'lapsed' then pg.sort_at end desc nulls last,
        pg.name, pg.restaurant_id)
      from page pg
      left join lateral (
        select sr.kind, sr.sent_at
        from public.subscription_reminders sr
        where sr.restaurant_id = pg.restaurant_id
        order by sr.sent_at desc
        limit 1
      ) as rem on true
    ), '[]'::jsonb)
  into v_counts, v_expected, v_kinds, v_total, v_rows
  from dues d;

  return jsonb_build_object(
    'bucket', v_bucket,
    'days', v_days,
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'counts', v_counts,
    'expected', v_expected,
    'kinds', v_kinds,
    'rows', v_rows
  );
end;
$$;

-- ─── Usage across the platform ──────────────────────────────────────────────
-- Accepted orders and GMV per restaurant and business day from p_from to
-- p_to: stored days from metrics_usage_daily, and each restaurant's last
-- finished day and current day counted live (the 03:00 usage step can't store
-- a day that ends at 04:00; SA-23). `today` marks the restaurant's current,
-- unfinished business day.
create function private.platform_usage(p_from date, p_to date)
returns table (
  restaurant_id uuid,
  business_day date,
  today boolean,
  orders bigint,
  gmv_paise bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with r as (
    select
      x.id, x.timezone as tz, x.business_day_start_hour as h,
      private.business_date(now(), x.timezone, x.business_day_start_hour) as today
    from public.restaurants x
  )
  select m.restaurant_id, m.business_day, false, m.orders::bigint, m.gmv_paise
  from public.metrics_usage_daily m
  join r on r.id = m.restaurant_id
  where m.business_day between p_from and p_to
    and m.business_day <= r.today - 2
  union all
  select r.id, d.day::date, d.day::date = r.today, live.orders, live.gmv
  from r
  cross join lateral generate_series(
    greatest(p_from, r.today - 1), least(p_to, r.today), interval '1 day'
  ) as d(day)
  cross join lateral private.business_day_bounds(d.day::date, d.day::date, r.tz, r.h) as b
  cross join lateral (
    select
      (select count(*) from public.orders o
       where o.restaurant_id = r.id and o.status = 'accepted'
         and o.created_at >= b.starts_at and o.created_at < b.ends_at) as orders,
      (select coalesce(sum(bl.grand_total_paise), 0)::bigint from public.bills bl
       where bl.restaurant_id = r.id and bl.status = 'active'
         and bl.generated_at >= b.starts_at and bl.generated_at < b.ends_at) as gmv
  ) as live;
$$;

revoke execute on function private.platform_usage(date, date) from public, anon, authenticated;

-- ─── Home ───────────────────────────────────────────────────────────────────
-- Key numbers for Today or This month and the three charts (plan 12e, SA-27).
-- MenuMesh money (MRR, collected) needs money.view; GMV is the restaurants'
-- sales, taxes included, never mixed with it.
create function public.platform_home(p_period text default 'today')
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
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
    cross join lateral public.restaurant_access(r.id) as a
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
  -- has the last 30 finished days.
  with u as (
    select * from private.platform_usage(v_today - 30, v_today)
  ),
  numbers as (
    select coalesce(sum(u.gmv_paise), 0) as gmv, coalesce(sum(u.orders), 0) as orders
    from u
    where case when p_period = 'today' then u.today else u.business_day >= v_from end
  ),
  days as (
    select u.business_day as day, sum(u.gmv_paise) as gmv, sum(u.orders) as orders
    from u
    where not u.today and u.business_day < v_today
    group by u.business_day
  )
  select
    n.gmv, n.orders,
    (select jsonb_agg(jsonb_build_object(
       'day', g.day::date,
       'gmv_paise', coalesce(d.gmv, 0),
       'orders', coalesce(d.orders, 0)
     ) order by g.day)
     from generate_series(v_today - 30, v_today - 1, interval '1 day') as g(day)
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
$$;

revoke execute on function public.platform_home(text) from public, anon;
grant execute on function public.platform_home(text) to authenticated;

-- ─── Needs attention ────────────────────────────────────────────────────────
-- Each platform admin can put an item aside for a while (SA-28); it comes
-- back when the snooze ends, and an item that is resolved simply stops being
-- listed.
create table public.platform_snoozes (
  admin_id uuid not null references auth.users (id) on delete cascade,
  item_key text not null check (length(item_key) <= 120),
  until timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (admin_id, item_key)
);

alter table public.platform_snoozes enable row level security;
revoke all on public.platform_snoozes from anon, authenticated;
grant select on public.platform_snoozes to authenticated;
create policy "platform admins read their snoozes" on public.platform_snoozes
  for select to authenticated
  using ((select public.is_platform_admin()) and admin_id = (select auth.uid()));

-- The groups of plan 12e, in order, each with its count and first p_limit
-- items: a key (group:id) and the data its row shows. Snoozes are p_admin's
-- (none for the digest). Groups the caller may not see are left out.
create function private.attention(
  p_admin uuid,
  p_money boolean,
  p_growth boolean,
  p_system boolean,
  p_limit int default 5
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
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
    -- ponytail: leads received in the last day until leads get a status (13d).
    select 'new_leads', l.id::text, -extract(epoch from l.created_at),
      jsonb_build_object(
        'lead_id', l.id, 'name', l.name, 'restaurant_name', l.restaurant_name,
        'city', l.city, 'phone', l.phone, 'created_at', l.created_at
      )
    from public.site_leads l
    where p_growth and l.created_at >= now() - interval '24 hours'
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
    cross join lateral public.restaurant_access(h.id) as a
    where h.health in ('inactive', 'slowing') and a.state = 'full'
    union all
    -- Signups of the last week that look like another restaurant (P11-13).
    select 'duplicates', r.id::text, -extract(epoch from r.created_at),
      jsonb_build_object(
        'restaurant_id', r.id, 'name', r.name, 'slug', r.slug, 'city', r.city,
        'created_at', r.created_at, 'matches', lk.matches
      )
    from public.restaurants r
    cross join lateral (select private.restaurant_lookalikes(r.id) as matches) as lk
    where r.created_at >= now() - interval '7 days'
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
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object('group', g.grp, 'count', g.total, 'items', g.items)
        order by array_position(array['payment_failed', 'trial_ending', 'needs_payment',
          'new_leads', 'inactive', 'slowing', 'duplicates', 'webhooks', 'cron'], g.grp))
      from groups g
    ), '[]'::jsonb)
  );
$$;

revoke execute on function private.attention(uuid, boolean, boolean, boolean, int)
  from public, anon, authenticated;

create function public.platform_needs_attention()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.view');
begin
  return private.attention(
    v_admin.user_id,
    private.has_platform_permission('money.view'),
    private.has_platform_permission('growth.manage'),
    private.has_platform_permission('system.view')
  );
end;
$$;

-- Puts an item aside for 1, 3 or 7 days; returns when it comes back.
create function public.platform_snooze(p_key text, p_days int)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.view');
  v_until timestamptz;
begin
  if p_days is null or p_days not in (1, 3, 7) then
    perform private.fail('INVALID_INPUT', 'days');
  end if;
  if p_key is null or p_key !~ ('^(payment_failed|trial_ending|needs_payment|new_leads|inactive'
      || '|slowing|duplicates|webhooks|cron):[A-Za-z0-9 _.:-]{1,100}$') then
    perform private.fail('INVALID_INPUT', 'key');
  end if;
  delete from public.platform_snoozes z where z.admin_id = v_admin.user_id and z.until <= now();
  insert into public.platform_snoozes (admin_id, item_key, until)
  values (v_admin.user_id, p_key, now() + make_interval(days => p_days))
  on conflict (admin_id, item_key) do update set until = excluded.until, created_at = now()
  returning until into v_until;
  return v_until;
end;
$$;

revoke execute on function public.platform_needs_attention() from public, anon;
revoke execute on function public.platform_snooze(text, int) from public, anon;
grant execute on function public.platform_needs_attention() to authenticated;
grant execute on function public.platform_snooze(text, int) to authenticated;

-- ─── Activity ───────────────────────────────────────────────────────────────
-- One stream, newest first (plan §4.5, SA-29), from where each event already
-- lives. Items are {key, kind, at, restaurant_id, restaurant_name, actor,
-- data}; the page words them. Paged by (at, key) below p_before_at/key.
-- Amounts are null without money.
create function private.activity(
  p_restaurant_id uuid,
  p_kinds text[],
  p_before_at timestamptz,
  p_before_key text,
  p_limit int,
  p_money boolean
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with params as (
    select
      coalesce(p_before_at, 'infinity'::timestamptz) as before_at,
      coalesce(p_before_key, '') as before_key,
      -- The lapses window: snapshots are compared day by day.
      coalesce((p_before_at at time zone 'Asia/Kolkata')::date,
        (now() at time zone 'Asia/Kolkata')::date) - 90 as lapse_from
  ),
  items as (
    (select k.kind, r.created_at as at, 'restaurant:' || r.id as key, r.id as restaurant_id,
      null::uuid as actor_id,
      jsonb_build_object('city', r.city, 'channel', r.acquisition_channel) as data
    from public.restaurants r
    cross join params pr
    cross join lateral (
      select case when exists (select 1 from public.trial_claims c where c.restaurant_id = r.id)
        then 'signup' else 'onboarded' end as kind
    ) as k
    where k.kind = any(p_kinds)
      and (p_restaurant_id is null or r.id = p_restaurant_id)
      and r.created_at <= pr.before_at
      and (r.created_at, 'restaurant:' || r.id) < (pr.before_at, pr.before_key)
    order by r.created_at desc, 'restaurant:' || r.id desc
    limit p_limit)
    union all
    (select 'payment', p.created_at, 'payment:' || p.id, p.restaurant_id, p.recorded_by,
      jsonb_build_object(
        'purpose', p.purpose,
        'method', case p.source
          when 'razorpay' then 'autopay'
          when 'payment_link' then 'payment_link'
          else p.manual_mode::text
        end,
        'base_paise', case when p_money then p.base_paise end,
        'gst_paise', case when p_money then p.gst_paise end
      )
    from public.subscription_payments p, params pr
    where 'payment' = any(p_kinds)
      and (p_restaurant_id is null or p.restaurant_id = p_restaurant_id)
      and p.created_at <= pr.before_at
      and (p.created_at, 'payment:' || p.id) < (pr.before_at, pr.before_key)
    order by p.created_at desc, 'payment:' || p.id desc
    limit p_limit)
    union all
    -- A Razorpay charge that failed: the webhook moved the subscription into
    -- retrying.
    (select 'payment_failed', a.created_at, 'audit:' || a.id, a.restaurant_id, null::uuid,
      jsonb_build_object('grace_until', a.after -> 'grace_until')
    from public.audit_logs a, params pr
    where 'payment_failed' = any(p_kinds)
      and a.action = 'subscription.razorpay_updated'
      and a.after ->> 'status' in ('past_due', 'halted')
      and coalesce(a.before ->> 'status', '') not in ('past_due', 'halted')
      and (p_restaurant_id is null or a.restaurant_id = p_restaurant_id)
      and a.created_at <= pr.before_at
      and (a.created_at, 'audit:' || a.id) < (pr.before_at, pr.before_key)
    order by a.created_at desc, 'audit:' || a.id desc
    limit p_limit)
    union all
    -- Became read-only for not paying, by the night's snapshot: at the end of
    -- that India day.
    -- ponytail: compared over 90 days below the cursor; a stored transition
    -- table if the stream needs older lapses.
    (select 'lapsed', (m.day + 1)::timestamp at time zone 'Asia/Kolkata',
      'lapsed:' || m.restaurant_id || ':' || m.day, m.restaurant_id, null::uuid,
      jsonb_build_object('day', m.day, 'was', p.state)
    from public.metrics_subscription_daily m
    join public.metrics_subscription_daily p
      on p.restaurant_id = m.restaurant_id and p.day = m.day - 1
    cross join params pr
    where 'lapsed' = any(p_kinds)
      and m.state = 'read_only' and p.state <> 'read_only'
      and m.day >= pr.lapse_from
      and (p_restaurant_id is null or m.restaurant_id = p_restaurant_id)
      and ((m.day + 1)::timestamp at time zone 'Asia/Kolkata', 'lapsed:' || m.restaurant_id || ':' || m.day)
        < (pr.before_at, pr.before_key)
    order by m.day desc, m.restaurant_id desc
    limit p_limit)
    union all
    (select 'reminder', sr.sent_at, 'reminder:' || sr.id, sr.restaurant_id, null::uuid,
      jsonb_build_object('reminder', sr.kind)
    from public.subscription_reminders sr, params pr
    where 'reminder' = any(p_kinds)
      and (p_restaurant_id is null or sr.restaurant_id = p_restaurant_id)
      and sr.sent_at <= pr.before_at
      and (sr.sent_at, 'reminder:' || sr.id) < (pr.before_at, pr.before_key)
    order by sr.sent_at desc, 'reminder:' || sr.id desc
    limit p_limit)
    union all
    (select 'lead', l.created_at, 'lead:' || l.id, null::uuid, null::uuid,
      jsonb_build_object(
        'lead_id', l.id, 'name', l.name, 'restaurant_name', l.restaurant_name, 'city', l.city
      )
    from public.site_leads l, params pr
    where 'lead' = any(p_kinds) and p_restaurant_id is null
      and l.created_at <= pr.before_at
      and (l.created_at, 'lead:' || l.id) < (pr.before_at, pr.before_key)
    order by l.created_at desc, 'lead:' || l.id desc
    limit p_limit)
    union all
    (select 'menu_import', mi.completed_at, 'import:' || mi.id, mi.restaurant_id, mi.created_by,
      jsonb_build_object(
        'import_id', mi.id, 'status', mi.status, 'source', mi.source,
        'counts', mi.imported_counts
      )
    from public.menu_imports mi, params pr
    where 'menu_import' = any(p_kinds)
      and mi.status in ('imported', 'failed') and mi.completed_at is not null
      and (p_restaurant_id is null or mi.restaurant_id = p_restaurant_id)
      and mi.completed_at <= pr.before_at
      and (mi.completed_at, 'import:' || mi.id) < (pr.before_at, pr.before_key)
    order by mi.completed_at desc, 'import:' || mi.id desc
    limit p_limit)
    union all
    -- What the team did, less what the other kinds already show.
    (select 'team', a.created_at, 'audit:' || a.id, a.restaurant_id, a.actor_user_id,
      jsonb_build_object('action', a.action, 'reason', a.reason)
    from public.audit_logs a, params pr
    where 'team' = any(p_kinds)
      and a.actor_type = 'platform_admin'
      and a.action not in ('subscription.payment_recorded', 'restaurant.created')
      and (p_restaurant_id is null or a.restaurant_id = p_restaurant_id)
      and a.created_at <= pr.before_at
      and (a.created_at, 'audit:' || a.id) < (pr.before_at, pr.before_key)
    order by a.created_at desc, 'audit:' || a.id desc
    limit p_limit)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', t.key,
    'kind', t.kind,
    'at', t.at,
    'restaurant_id', t.restaurant_id,
    'restaurant_name', r.name,
    'actor', u.email,
    'data', t.data
  ) order by t.at desc, t.key desc), '[]'::jsonb)
  from (select * from items i order by i.at desc, i.key desc limit p_limit) as t
  left join public.restaurants r on r.id = t.restaurant_id
  left join auth.users u on u.id = t.actor_id;
$$;

revoke execute on function private.activity(uuid, text[], timestamptz, text, int, boolean)
  from public, anon, authenticated;

-- The kinds this admin may see.
create function private.activity_kinds(p_kinds text[])
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_all constant text[] := array['signup', 'onboarded', 'payment', 'payment_failed', 'lapsed',
    'reminder', 'lead', 'menu_import', 'team'];
  v_kinds text[] := coalesce(p_kinds, v_all);
begin
  if not v_kinds <@ v_all then
    perform private.fail('INVALID_INPUT', 'kinds');
  end if;
  if not private.has_platform_permission('money.view') then
    v_kinds := array_remove(array_remove(v_kinds, 'payment'), 'payment_failed');
  end if;
  if not private.has_platform_permission('growth.manage') then
    v_kinds := array_remove(v_kinds, 'lead');
  end if;
  if not private.has_platform_permission('audit.view') then
    v_kinds := array_remove(v_kinds, 'team');
  end if;
  return v_kinds;
end;
$$;

revoke execute on function private.activity_kinds(text[]) from public, anon, authenticated;

-- The stream for Home (every restaurant) or one restaurant's page (13a).
-- p_before is the `next` of the page before: '<at>|<key>'.
create function public.platform_activity(
  p_restaurant_id uuid default null,
  p_kinds text[] default null,
  p_before text default null,
  p_limit int default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_before_at timestamptz;
  v_before_key text;
  v_items jsonb;
  v_kinds text[];
begin
  perform private.require_platform_permission('restaurants.view');
  v_kinds := private.activity_kinds(p_kinds);
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    perform private.fail('INVALID_INPUT', 'limit');
  end if;
  if p_before is not null then
    begin
      v_before_at := split_part(p_before, '|', 1)::timestamptz;
    exception when others then
      perform private.fail('INVALID_INPUT', 'before');
    end;
    v_before_key := split_part(p_before, '|', 2);
    if v_before_key = '' or length(p_before) > 200 then
      perform private.fail('INVALID_INPUT', 'before');
    end if;
  end if;

  v_items := private.activity(
    p_restaurant_id, v_kinds, v_before_at, v_before_key, p_limit + 1,
    private.has_platform_permission('money.view')
  );
  return jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(e order by n) from jsonb_array_elements(v_items) with ordinality as x(e, n)
      where n <= p_limit
    ), '[]'::jsonb),
    'next', case when jsonb_array_length(v_items) > p_limit
      then (v_items -> (p_limit - 1) ->> 'at') || '|' || (v_items -> (p_limit - 1) ->> 'key') end
  );
end;
$$;

revoke execute on function public.platform_activity(uuid, text[], text, int) from public, anon;
grant execute on function public.platform_activity(uuid, text[], text, int) to authenticated;

-- ─── Live alerts ────────────────────────────────────────────────────────────
-- What a platform admin hasn't seen yet (SA-30): new signups, payments,
-- failed payments and leads since they last opened the alerts.
alter table public.platform_admins add column alerts_seen_at timestamptz;

create function public.platform_alerts()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.view');
  v_money boolean := private.has_platform_permission('money.view');
  v_seen timestamptz;
  v_items jsonb;
begin
  select coalesce(a.alerts_seen_at, a.created_at) into v_seen
  from public.platform_admins a
  where a.user_id = v_admin.user_id;

  -- Signups only: restaurants the team made are no news to it.
  v_items := private.activity(
    null,
    private.activity_kinds(array['signup', 'payment', 'payment_failed', 'lead']),
    null, null, 50, v_money
  );
  return jsonb_build_object(
    'seen_at', v_seen,
    'unread', (
      select count(*) from jsonb_array_elements(v_items) as e where (e ->> 'at')::timestamptz > v_seen
    ),
    'items', coalesce((
      select jsonb_agg(e order by n) from jsonb_array_elements(v_items) with ordinality as x(e, n)
      where n <= 10
    ), '[]'::jsonb),
    'attention', private.attention(
      v_admin.user_id, v_money,
      private.has_platform_permission('growth.manage'),
      private.has_platform_permission('system.view')
    ) -> 'total'
  );
end;
$$;

create function public.platform_mark_alerts_seen()
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.view');
begin
  update public.platform_admins a set alerts_seen_at = now() where a.user_id = v_admin.user_id;
  return now();
end;
$$;

revoke execute on function public.platform_alerts() from public, anon;
revoke execute on function public.platform_mark_alerts_seen() from public, anon;
grant execute on function public.platform_alerts() to authenticated;
grant execute on function public.platform_mark_alerts_seen() to authenticated;

-- ─── Daily digest ───────────────────────────────────────────────────────────
-- Yesterday's numbers and today's Needs attention counts for the 08:45 email
-- (SA-31), and who gets it: every platform admin until 13g.
create function public.platform_digest(p_day date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_day date := coalesce(p_day, (now() at time zone 'Asia/Kolkata')::date - 1);
  v_from timestamptz := v_day::timestamp at time zone 'Asia/Kolkata';
  v_to timestamptz := (v_day + 1)::timestamp at time zone 'Asia/Kolkata';
  v_states jsonb;
  v_attention jsonb;
begin
  -- The state at the end of the day, from that night's snapshot, or now.
  select jsonb_build_object(
    'mrr_paise', coalesce(sum(m.mrr_paise), 0),
    'paid', count(*) filter (where m.state = 'paid'),
    'trial', count(*) filter (where m.state = 'trial'),
    'payment_failed', count(*) filter (where m.state = 'payment_failed')
  )
  into v_states
  from public.metrics_subscription_daily m
  where m.day = v_day
  having count(*) > 0;

  if v_states is null then
    select jsonb_build_object(
      'mrr_paise', coalesce(sum(private.restaurant_mrr_paise(st.state, p, s.billing_cycle)), 0),
      'paid', count(*) filter (where st.state = 'paid'),
      'trial', count(*) filter (where st.state = 'trial'),
      'payment_failed', count(*) filter (where st.state = 'payment_failed')
    )
    into v_states
    from public.restaurants r
    left join public.restaurant_subscriptions s on s.restaurant_id = r.id
    left join public.plans p on p.id = s.plan_id
    cross join lateral public.restaurant_access(r.id) as a
    cross join lateral (
      select private.subscription_state(r.status::text, a.state, s.status::text, s.source::text) as state
    ) as st;
  end if;

  v_attention := private.attention(null, true, true, true);

  return jsonb_build_object(
    'day', v_day,
    'states', v_states,
    'collected', (
      select jsonb_build_object(
        'base_paise', coalesce(sum(p.base_paise), 0),
        'gst_paise', coalesce(sum(p.gst_paise), 0),
        'count', count(*)
      )
      from public.subscription_payments p
      where p.created_at >= v_from and p.created_at < v_to
    ),
    'signups', (
      select count(*) from public.restaurants r
      where r.created_at >= v_from and r.created_at < v_to
        and exists (select 1 from public.trial_claims c where c.restaurant_id = r.id)
    ),
    'onboarded', (
      select count(*) from public.restaurants r
      where r.created_at >= v_from and r.created_at < v_to
        and not exists (select 1 from public.trial_claims c where c.restaurant_id = r.id)
    ),
    'leads', (
      select count(*) from public.site_leads l where l.created_at >= v_from and l.created_at < v_to
    ),
    'usage', (
      select jsonb_build_object(
        'gmv_paise', coalesce(sum(u.gmv_paise), 0),
        'orders', coalesce(sum(u.orders), 0)
      )
      from private.platform_usage(v_day, v_day) u
    ),
    'attention', jsonb_build_object(
      'total', v_attention -> 'total',
      'groups', coalesce((
        select jsonb_agg(jsonb_build_object('group', g ->> 'group', 'count', g -> 'count'))
        from jsonb_array_elements(v_attention -> 'groups') as g
      ), '[]'::jsonb)
    ),
    'recipients', coalesce((
      select jsonb_agg(u.email order by u.email)
      from public.platform_admins a
      join auth.users u on u.id = a.user_id
      where u.email is not null
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.platform_digest(date) from public, anon, authenticated;
grant execute on function public.platform_digest(date) to service_role;

-- ─── Indexes for the stream and the checks ──────────────────────────────────
create index restaurants_created_idx on public.restaurants (created_at desc);
create index subscription_reminders_sent_idx on public.subscription_reminders (sent_at desc);
create index menu_imports_completed_idx on public.menu_imports (completed_at desc)
  where completed_at is not null;
create index webhook_events_failed_idx on public.webhook_events (received_at desc)
  where processing_error is not null;
create index audit_logs_action_created_idx on public.audit_logs (action, created_at desc);
create index audit_logs_platform_created_idx on public.audit_logs (created_at desc)
  where actor_type = 'platform_admin';
