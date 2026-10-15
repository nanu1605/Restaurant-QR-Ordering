-- Stop 14b: offers, custom prices, per-restaurant overrides and beta flags
-- (docs/SUPER_ADMIN_PLAN.md 14b, docs/DECISIONS.md SA-77+).
--
-- A discounted price is a Razorpay plan of its own (owner's choice,
-- 2026-10-15): Razorpay can't change a subscription's price, so an offer for
-- N cycles is a subscription of N charges, and the owner sets up autopay at
-- full price when it ends.

-- ─── Offers ─────────────────────────────────────────────────────────────────
create table public.offers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z0-9]{3,20}$'),
  description text check (char_length(description) between 1 and 200),
  discount_kind text not null check (discount_kind in ('percent', 'flat')),
  -- A whole percentage, or whole rupees off each charge, in paise.
  discount_value bigint not null check (discount_value > 0),
  -- Null: every plan, both cycles.
  plan_ids uuid[] check (cardinality(plan_ids) > 0),
  cycles public.billing_cycle[] check (cardinality(cycles) > 0),
  -- Null: for as long as that autopay runs.
  duration_cycles int check (duration_cycles between 1 and 120),
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  max_redemptions int check (max_redemptions > 0),
  -- Only restaurants that have never paid a subscription.
  new_only boolean not null default false,
  ended_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (discount_kind <> 'percent' or discount_value between 1 and 99),
  check (discount_kind <> 'flat' or discount_value % 100 = 0),
  check (valid_until is null or valid_until > valid_from)
);
alter table public.offers enable row level security;
create policy "platform admins read offers" on public.offers
  for select to authenticated using ((select public.platform_can('settings.manage')));

-- ─── Deals: one restaurant's price ──────────────────────────────────────────
-- From an offer code, or a custom price the team agreed. A deal is open until
-- it ends; its restaurant's next autopay on that plan and cycle uses it, and a
-- restaurant not on autopay pays it at once. Single use: it ends when the
-- subscription moves off it or the autopay carrying it ends.
create table public.subscription_deals (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  offer_id uuid references public.offers (id),
  plan_id uuid not null references public.plans (id),
  billing_cycle public.billing_cycle not null,
  -- Before GST, per charge.
  list_price_paise bigint not null check (list_price_paise > 0),
  price_paise bigint not null check (price_paise >= 100 and price_paise <= list_price_paise),
  -- Charges at this price; null: for as long as that autopay runs.
  cycles int check (cycles between 1 and 120),
  reason text check (char_length(reason) between 1 and 500),
  razorpay_plan_id text check (razorpay_plan_id ~ '^plan_[A-Za-z0-9]{1,40}$'),
  -- Null: the owner, with an offer code.
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  ended_at timestamptz,
  check (offer_id is not null or reason is not null)
);
create unique index subscription_deals_open_idx on public.subscription_deals (restaurant_id)
  where ended_at is null;
create index subscription_deals_restaurant_idx on public.subscription_deals (restaurant_id, created_at desc);
create index subscription_deals_offer_idx on public.subscription_deals (offer_id)
  where offer_id is not null;
-- The same price on the same plan reuses its Razorpay plan.
create index subscription_deals_price_idx
  on public.subscription_deals (plan_id, billing_cycle, price_paise)
  where razorpay_plan_id is not null;
alter table public.subscription_deals enable row level security;
create policy "platform admins read deals" on public.subscription_deals
  for select to authenticated using ((select public.platform_can('money.view')));

alter table public.restaurant_subscriptions
  add column deal_id uuid references public.subscription_deals (id),
  add column next_deal_id uuid references public.subscription_deals (id),
  -- The deal's price a month; null: the plan's list price.
  add column effective_monthly_paise bigint check (effective_monthly_paise >= 0);
alter table public.subscription_payments
  add column deal_id uuid references public.subscription_deals (id);
comment on column public.subscription_payments.list_price_paise is
  'Before GST: the setup fee''s full price, or a subscription charge''s list price when a deal applied.';
create index restaurant_subscriptions_deal_idx on public.restaurant_subscriptions (deal_id)
  where deal_id is not null;
create index restaurant_subscriptions_next_deal_idx on public.restaurant_subscriptions (next_deal_id)
  where next_deal_id is not null;
create index subscription_payments_deal_idx on public.subscription_payments (deal_id)
  where deal_id is not null;

-- A deal a month.
create function private.deal_monthly_paise(p_deal public.subscription_deals)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case when p_deal.billing_cycle = 'yearly' then round(p_deal.price_paise::numeric / 12)::bigint
    else p_deal.price_paise end
$$;

-- A deal for the panel; prices only with money.view.
create function private.deal_json(p_deal_id uuid, p_money boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', d.id,
    'offer_code', o.code,
    'plan_code', p.code,
    'plan_name', p.name,
    'billing_cycle', d.billing_cycle,
    'list_price_paise', case when p_money then d.list_price_paise end,
    'price_paise', case when p_money then d.price_paise end,
    'cycles', d.cycles,
    'reason', d.reason,
    'by_owner', d.created_by is null,
    'created_by', u.email,
    'created_at', d.created_at,
    'used_at', d.used_at,
    'ended_at', d.ended_at
  )
  from public.subscription_deals d
  join public.plans p on p.id = d.plan_id
  left join public.offers o on o.id = d.offer_id
  left join auth.users u on u.id = d.created_by
  where d.id = p_deal_id
$$;

-- Keeps the price in step with the deal: a plan or cycle the deal isn't for
-- drops it; the deal in use is stamped used, the one left behind ends.
create function private.sync_subscription_deal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deal public.subscription_deals;
begin
  if new.deal_id is not null then
    select * into v_deal from public.subscription_deals d where d.id = new.deal_id;
    if v_deal.plan_id <> new.plan_id or v_deal.billing_cycle <> new.billing_cycle then
      new.deal_id := null;
    end if;
  end if;
  new.effective_monthly_paise := case
    when new.deal_id is not null then private.deal_monthly_paise(v_deal)
  end;
  if tg_op = 'UPDATE' and new.deal_id is distinct from old.deal_id then
    if new.deal_id is not null then
      update public.subscription_deals d set used_at = coalesce(d.used_at, now())
      where d.id = new.deal_id;
    end if;
    if old.deal_id is not null then
      update public.subscription_deals d set ended_at = coalesce(d.ended_at, now())
      where d.id = old.deal_id;
    end if;
  end if;
  return new;
end;
$$;
create trigger sync_subscription_deal
  before insert or update of deal_id, plan_id, billing_cycle on public.restaurant_subscriptions
  for each row execute function private.sync_subscription_deal();

-- ─── Overrides and beta flags ───────────────────────────────────────────────
-- A feature the plan lacks, or more tables or staff, for one restaurant; a
-- feature key in no plan is a beta flag.
create table public.restaurant_overrides (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  kind text not null check (kind in ('feature', 'max_tables', 'max_staff')),
  feature text check (feature ~ '^[a-z_]{1,40}$'),
  -- For a limit; null: unlimited.
  value int check (value between 1 and 10000),
  expires_at timestamptz,
  reason text not null check (char_length(reason) between 1 and 500),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'feature') = (feature is not null)),
  check (kind <> 'feature' or value is null)
);
create unique index restaurant_overrides_key_idx
  on public.restaurant_overrides (restaurant_id, kind, coalesce(feature, ''));
alter table public.restaurant_overrides enable row level security;
create policy "platform admins read overrides" on public.restaurant_overrides
  for select to authenticated using ((select public.is_platform_admin()));

revoke all on public.offers, public.subscription_deals, public.restaurant_overrides
  from anon, authenticated;
grant select on public.offers, public.subscription_deals, public.restaurant_overrides
  to authenticated;

-- The plan with the restaurant's unexpired overrides: features added, a limit
-- raised (an override without a value lifts it).
create function private.effective_plan(p_restaurant_id uuid)
returns table (plan_code text, plan_name text, max_tables integer, max_staff integer, features jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  select p.code, p.name,
    case
      when p.max_tables is null then null
      when t.id is not null then case when t.value is null then null else greatest(p.max_tables, t.value) end
      else p.max_tables
    end,
    case
      when p.max_staff is null then null
      when st.id is not null then case when st.value is null then null else greatest(p.max_staff, st.value) end
      else p.max_staff
    end,
    p.features || coalesce((
      select jsonb_object_agg(o.feature, true)
      from public.restaurant_overrides o
      where o.restaurant_id = p_restaurant_id and o.kind = 'feature'
        and (o.expires_at is null or o.expires_at > now())
    ), '{}'::jsonb)
  from public.restaurant_subscriptions s
  join public.plans p on p.id = s.plan_id
  left join public.restaurant_overrides t on t.restaurant_id = p_restaurant_id
    and t.kind = 'max_tables' and (t.expires_at is null or t.expires_at > now())
  left join public.restaurant_overrides st on st.restaurant_id = p_restaurant_id
    and st.kind = 'max_staff' and (st.expires_at is null or st.expires_at > now())
  where s.restaurant_id = p_restaurant_id
$$;

create or replace function public.restaurant_plan(p_restaurant_id uuid)
returns table (plan_code text, plan_name text, max_tables integer, max_staff integer, features jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null
     and not public.is_platform_admin()
     and public.member_role(p_restaurant_id) is null then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;

  return query select * from private.effective_plan(p_restaurant_id);
end;
$$;

create or replace function private.has_feature(p_restaurant_id uuid, p_feature text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select (e.features ->> p_feature)::boolean from private.effective_plan(p_restaurant_id) e),
    false
  );
$$;

create or replace function private.plan_limits(
  p_restaurant_id uuid, out max_tables integer, out max_staff integer
)
returns record
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  select e.max_tables, e.max_staff
    into max_tables, max_staff
    from private.effective_plan(p_restaurant_id) e;
  if not found then
    raise exception using errcode = 'P0001', message = 'PLAN_NOT_FOUND';
  end if;
end;
$$;

-- ─── MRR at the deal's price ────────────────────────────────────────────────
-- Dropped, not replaced, so a caller left on the list price fails loudly.
drop function private.restaurant_mrr_paise(text, public.plans, public.billing_cycle);
create function private.restaurant_mrr_paise(
  p_state text, p_plan public.plans, p_cycle public.billing_cycle, p_effective bigint
)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case when p_state = 'paid' then coalesce(p_effective, private.monthly_paise(p_plan, p_cycle))
    else 0 end;
$$;

-- ─── Reminders when an autopay finishes ─────────────────────────────────────
alter table public.subscription_reminders drop constraint subscription_reminders_kind_check;
alter table public.subscription_reminders add constraint subscription_reminders_kind_check
  check (kind in ('trial_ends_3d', 'trial_ends_1d', 'payment_failed', 'access_restricted',
    'autopay_ends_7d', 'autopay_ends_1d'));

-- ─── Audit: deals and overrides are the team's ──────────────────────────────
alter policy "managers and platform admins read audit logs" on public.audit_logs
  using (
    (restaurant_id in (select private.my_restaurant_ids('{owner,manager}'::public.member_role[]))
      and coalesce(entity_type, '') <> all (
        array['restaurant_note', 'restaurant_tags', 'account_manager', 'subscription_deal',
          'restaurant_override']))
    or (select public.platform_can('audit.view'))
  );

-- ─── Redefined from their live definitions (docs/DECISIONS.md SA-77+) ───────

-- private.mrr_days
CREATE OR REPLACE FUNCTION private.mrr_days(p_open date)
 RETURNS TABLE(day date, restaurant_id uuid, state text, plan_id uuid, billing_cycle billing_cycle, mrr_paise bigint, before_state text, before_plan_id uuid, before_paise bigint, movement text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      private.restaurant_mrr_paise(st.state, p, s.billing_cycle, s.effective_monthly_paise)
    from public.restaurants r
    left join public.restaurant_subscriptions s on s.restaurant_id = r.id
    left join public.plans p on p.id = s.plan_id
    cross join lateral private.restaurant_access(r.id) as a
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
$function$;

-- public.platform_digest
CREATE OR REPLACE FUNCTION public.platform_digest(p_day date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
      'mrr_paise', coalesce(sum(private.restaurant_mrr_paise(st.state, p, s.billing_cycle, s.effective_monthly_paise)), 0),
      'paid', count(*) filter (where st.state = 'paid'),
      'trial', count(*) filter (where st.state = 'trial'),
      'payment_failed', count(*) filter (where st.state = 'payment_failed')
    )
    into v_states
    from public.restaurants r
    left join public.restaurant_subscriptions s on s.restaurant_id = r.id
    left join public.plans p on p.id = s.plan_id
    cross join lateral private.restaurant_access(r.id) as a
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
      'inactive_days', v_attention -> 'inactive_days',
      'groups', coalesce((
        select jsonb_agg(jsonb_build_object('group', g ->> 'group', 'count', g -> 'count'))
        from jsonb_array_elements(v_attention -> 'groups') as g
      ), '[]'::jsonb)
    ),
    'recipients', coalesce((
      select jsonb_agg(u.email order by u.email)
      from public.platform_admins a
      join auth.users u on u.id = a.user_id
      where u.email is not null and a.digest
        and a.joined_at is not null and a.disabled_at is null
        and 'money.view' = any (private.role_permissions(a.role))
    ), '[]'::jsonb)
  );
end;
$function$;

-- public.platform_funnel
CREATE OR REPLACE FUNCTION public.platform_funnel(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('growth.manage');
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_start timestamptz;
  v_end timestamptz;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    perform private.fail('INVALID_INPUT', 'range');
  end if;
  v_start := p_from::timestamp at time zone 'Asia/Kolkata';
  v_end := (p_to + 1)::timestamp at time zone 'Asia/Kolkata';

  return (
    with days as (
      select d::date as day
      from generate_series(p_from, least(p_to, v_today), interval '1 day') d
    ),
    started as (
      select d.day, coalesce(m.signups_started, case when d.day >= v_today - 6 then (
        select count(distinct s.email)::int from public.site_signups s
        where s.created_at >= d.day::timestamp at time zone 'Asia/Kolkata'
          and s.created_at < (d.day + 1)::timestamp at time zone 'Asia/Kolkata'
      ) end) as n
      from days d
      left join public.metrics_platform_daily m on m.day = d.day
    ),
    cohort as (
      select
        r.id,
        coalesce(r.acquisition_channel, 'unknown') as channel,
        r.signup_source,
        exists (select 1 from public.trial_claims c where c.restaurant_id = r.id) as signup,
        exists (
          select 1 from public.orders o where o.restaurant_id = r.id and o.status = 'accepted'
        ) as ordered,
        exists (
          select 1 from public.subscription_payments p
          where p.restaurant_id = r.id and p.purpose = 'subscription'
        ) as paid_once,
        st.state,
        private.restaurant_mrr_paise(st.state, pl, s.billing_cycle, s.effective_monthly_paise) as mrr
      from public.restaurants r
      left join public.restaurant_subscriptions s on s.restaurant_id = r.id
      left join public.plans pl on pl.id = s.plan_id
      cross join lateral private.restaurant_access(r.id) a
      cross join lateral (
        select private.subscription_state(r.status::text, a.state, s.status::text, s.source::text) as state
      ) st
      where r.created_at >= v_start and r.created_at < v_end
    ),
    leads as (
      select l.channel, l.source
      from public.site_leads l
      where l.created_at >= v_start and l.created_at < v_end
    ),
    channels as (
      select c.channel, c.n
      from unnest(array['website', 'website_lead', 'field_visit', 'referral', 'phone', 'whatsapp',
        'social', 'other', 'unknown']) with ordinality as c(channel, n)
    ),
    arrivals as (
      select l.source, 1 as demo_requests, 0 as signups, 0 as paying
      from leads l
      where l.channel = 'website_lead'
      union all
      select c.signup_source, 0, 1, (c.state = 'paid')::int
      from cohort c
      where c.signup
    ),
    sources as (
      select
        coalesce(a.source ->> 'utm_source', '') as utm_source,
        case when a.source ->> 'utm_source' is null then coalesce(a.source ->> 'referrer', '')
          else '' end as referrer,
        sum(a.demo_requests)::int as demo_requests,
        sum(a.signups)::int as signups,
        sum(a.paying)::int as paying
      from arrivals a
      group by 1, 2
    ),
    ranked as (
      select s.*, row_number() over (
        order by s.demo_requests + s.signups desc, s.utm_source, s.referrer
      ) as n
      from sources s
    )
    select jsonb_build_object(
      'from', p_from,
      'to', p_to,
      'demo_requests', (select count(*) from leads l where l.channel = 'website_lead'),
      'signups_started', (select sum(s.n) from started s),
      'signups_counted_from', (
        select min(s.day) from started s where s.n is not null
          and exists (select 1 from started u where u.n is null)
      ),
      'cohort', (
        select jsonb_agg(jsonb_build_object(
          'kind', k.kind,
          'created', (select count(*) from cohort c where c.signup = k.signup),
          'first_order', (select count(*) from cohort c where c.signup = k.signup and c.ordered),
          'first_payment', (select count(*) from cohort c where c.signup = k.signup and c.paid_once)
        ) order by k.n)
        from (values ('signup', true, 1), ('team', false, 2)) as k(kind, signup, n)
      ),
      'channels', (
        select jsonb_agg(jsonb_build_object(
          'channel', ch.channel,
          'leads', (select count(*) from leads l where l.channel = ch.channel),
          'restaurants', (select count(*) from cohort c where c.channel = ch.channel),
          'paying', (select count(*) from cohort c where c.channel = ch.channel and c.state = 'paid'),
          'mrr_paise', (select coalesce(sum(c.mrr), 0) from cohort c where c.channel = ch.channel)
        ) order by ch.n)
        from channels ch
      ),
      'sources', coalesce((
        select jsonb_agg(jsonb_build_object(
          'utm_source', nullif(r.utm_source, ''),
          'referrer', nullif(r.referrer, ''),
          'demo_requests', r.demo_requests,
          'signups', r.signups,
          'paying', r.paying
        ) order by r.n)
        from ranked r
        where r.n <= 20
      ), '[]'::jsonb),
      'other_sources', (
        select jsonb_build_object(
          'count', count(*),
          'demo_requests', sum(r.demo_requests),
          'signups', sum(r.signups),
          'paying', sum(r.paying)
        )
        from ranked r
        where r.n > 20
        having count(*) > 0
      )
    )
  );
end;
$function$;

-- public.platform_home
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
    select st.state, private.restaurant_mrr_paise(st.state, p, s.billing_cycle, s.effective_monthly_paise) as mrr
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

-- public.platform_metrics_snapshot
CREATE OR REPLACE FUNCTION public.platform_metrics_snapshot(p_day date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_day date := coalesce(p_day, v_today - 1);
  v_from timestamptz := v_day::timestamp at time zone 'Asia/Kolkata';
  v_to timestamptz := (v_day + 1)::timestamp at time zone 'Asia/Kolkata';
  v_subscriptions int;
begin
  insert into public.metrics_subscription_daily (
    day, restaurant_id, state, plan_id, billing_cycle, source, mrr_paise,
    cancel_at_period_end, autopay, trial_ends_at, current_period_end, grace_until, health
  )
  select
    v_day, r.id, st.state, s.plan_id, s.billing_cycle, s.source,
    private.restaurant_mrr_paise(st.state, p, s.billing_cycle, s.effective_monthly_paise),
    coalesce(s.cancel_at_period_end, false), coalesce(private.razorpay_managed(s), false),
    s.trial_ends_at, s.current_period_end, s.grace_until,
    private.restaurant_health(r.id, r.created_at, least(now(), v_to))
  from public.restaurants r
  left join public.restaurant_subscriptions s on s.restaurant_id = r.id
  left join public.plans p on p.id = s.plan_id
  cross join lateral private.restaurant_access(r.id, least(now(), v_to)) as a
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
    -- People, not attempts: a signup restarted with the same email counts once.
    (select count(distinct lower(x.email)) from public.site_signups x
     where x.created_at >= v_from and x.created_at < v_to),
    (select count(*) from public.restaurants x
     where x.created_at >= v_from and x.created_at < v_to
       and exists (select 1 from public.trial_claims c where c.restaurant_id = x.id)),
    (select count(*) from public.restaurants x
     where x.created_at >= v_from and x.created_at < v_to
       and not exists (select 1 from public.trial_claims c where c.restaurant_id = x.id)),
    (select count(*) from public.site_leads x where x.created_at >= v_from and x.created_at < v_to)
  on conflict (day) do nothing;

  return jsonb_build_object('day', v_day, 'subscriptions', v_subscriptions);
end;
$function$;

-- public.platform_overview
CREATE OR REPLACE FUNCTION public.platform_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('money.view');
  v_counts jsonb;
  v_mrr bigint;
  v_orders bigint;
  v_trials jsonb;
begin
  -- One state per restaurant and its MRR, by the shared rules (SA-7). The JSON
  -- keys stay as the overview page reads them: trialing = Trial, active =
  -- Paid, past_due = Payment failed.
  with states as (
    select st.state, private.restaurant_mrr_paise(st.state, p, s.billing_cycle, s.effective_monthly_paise) as mrr
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
$function$;

-- private.dues_rows
CREATE OR REPLACE FUNCTION private.dues_rows(p_q text DEFAULT NULL::text)
 RETURNS TABLE(restaurant_id uuid, name text, slug text, city text, phone text, status subscription_status, source subscription_source, billing_cycle billing_cycle, trial_ends_at timestamp with time zone, current_period_end timestamp with time zone, grace_until timestamp with time zone, cancel_at_period_end boolean, razorpay_status text, autopay boolean, renewal_kind text, plan_code text, plan_name text, due_paise bigint, access_state text, access_reason text, restriction_at timestamp with time zone, bucket text)
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
    private.fee_with_gst(coalesce(dd.price_paise, private.cycle_price_paise(pl, coalesce(
      case when m.live then s.next_billing_cycle end, s.billing_cycle, 'monthly'
    )))),
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
  left join public.subscription_deals dd on dd.id = case
    when m.live and s.next_plan_id is not null then s.next_deal_id
    when s.razorpay_status = 'completed' then null
    else s.deal_id
  end
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

-- private.apply_razorpay_subscription
CREATE OR REPLACE FUNCTION private.apply_razorpay_subscription(p_restaurant_id uuid, p_entity jsonb, p_payment jsonb, p_event_at timestamp with time zone)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id text;
  v_status text;
  v_start timestamptz;
  v_end timestamptz;
  v_customer text;
  v_sub public.restaurant_subscriptions;
  v_after public.restaurant_subscriptions;
  v_grace_days int;
  v_payment_id text;
  v_amount bigint;
  v_payment_row uuid;
begin
  if jsonb_typeof(p_entity) is distinct from 'object' then
    perform private.fail('INVALID_INPUT', 'subscription');
  end if;
  v_id := private.json_text(p_entity, 'id');
  v_status := private.json_text(p_entity, 'status');
  if v_id is null or v_id !~ '^sub_[A-Za-z0-9]{1,40}$' then
    perform private.fail('INVALID_INPUT', 'subscription.id');
  end if;
  if v_status is null or v_status not in (
    'created', 'authenticated', 'active', 'pending', 'halted', 'cancelled', 'completed',
    'expired', 'paused'
  ) then
    perform private.fail('INVALID_INPUT', 'subscription.status');
  end if;
  v_start := private.json_unix(p_entity, 'current_start');
  v_end := private.json_unix(p_entity, 'current_end');
  v_customer := private.json_text(p_entity, 'customer_id');

  select * into v_sub
  from public.restaurant_subscriptions s
  where s.restaurant_id = p_restaurant_id
  for update;
  if not found then
    perform private.fail('SUBSCRIPTION_NOT_FOUND');
  end if;

  -- Money is recorded whatever happens to the status.
  if p_payment is not null then
    if jsonb_typeof(p_payment) is distinct from 'object' then
      perform private.fail('INVALID_INPUT', 'payment');
    end if;
    v_payment_id := private.json_text(p_payment, 'id');
    if v_payment_id is null or v_payment_id !~ '^pay_[A-Za-z0-9]{1,40}$' then
      perform private.fail('INVALID_INPUT', 'payment.id');
    end if;
    v_amount := private.json_int(p_payment, 'amount');
    if v_amount < 1 or v_amount > 100000000 then
      perform private.fail('INVALID_INPUT', 'payment.amount');
    end if;
    insert into public.subscription_payments (
      restaurant_id, source, amount_paise, razorpay_payment_id, period_start, period_end
    )
    values (
      p_restaurant_id, 'razorpay', v_amount, v_payment_id,
      v_start, case when v_end > v_start then v_end end
    )
    on conflict (razorpay_payment_id) do nothing
    returning id into v_payment_row;
    if v_payment_row is not null then
      perform private.write_audit(
        p_restaurant_id, 'system', null, null, 'Razorpay',
        'subscription.payment_received', 'subscription_payment', v_payment_row, null,
        jsonb_build_object(
          'amount_paise', v_amount, 'razorpay_payment_id', v_payment_id,
          'razorpay_subscription_id', v_id, 'period_start', v_start, 'period_end', v_end
        )
      );
    end if;
  end if;

  if v_sub.razorpay_subscription_id is distinct from v_id then
    return 'not_current';
  end if;
  if (p_event_at is not null and p_event_at < v_sub.razorpay_event_at)
     or private.razorpay_status_rank(v_status) < private.razorpay_status_rank(v_sub.razorpay_status)
  then
    return 'stale';
  end if;

  select ps.grace_days into v_grace_days from public.platform_settings ps where ps.id = 1;

  update public.restaurant_subscriptions s
    set razorpay_status = v_status,
        razorpay_event_at = greatest(s.razorpay_event_at, p_event_at),
        razorpay_customer_id = coalesce(v_customer, s.razorpay_customer_id)
    where s.id = v_sub.id;

  case v_status
    when 'active' then
      update public.restaurant_subscriptions s
        set status = 'active',
            source = 'razorpay',
            plan_id = coalesce(s.next_plan_id, s.plan_id),
            billing_cycle = coalesce(s.next_billing_cycle, s.billing_cycle),
            -- Back to the list price too, when the new autopay has no deal.
            deal_id = case when s.next_plan_id is not null then s.next_deal_id else s.deal_id end,
            next_plan_id = null,
            next_billing_cycle = null,
            next_deal_id = null,
            current_period_start = case
              when v_end is not null and (s.current_period_end is null or v_end > s.current_period_end)
                then coalesce(v_start, s.current_period_start)
              else s.current_period_start
            end,
            current_period_end = greatest(s.current_period_end, v_end),
            grace_until = null,
            -- A charge means it renews; a new subscription starting replaces
            -- one that was set to end.
            cancel_at_period_end = case
              when p_payment is not null or s.next_plan_id is not null then false
              else s.cancel_at_period_end
            end
        where s.id = v_sub.id;
    when 'authenticated' then
      -- A new subscription, just set up, carries on after one that was set to end.
      update public.restaurant_subscriptions s
        set cancel_at_period_end = false
        where s.id = v_sub.id and s.next_plan_id is not null
          and private.razorpay_status_rank(v_sub.razorpay_status) < 1;
    when 'pending', 'halted' then
      -- A failed charge never shortens a longer period paid another way.
      update public.restaurant_subscriptions s
        set status = case when v_status = 'pending' then 'past_due' else 'halted' end::public.subscription_status,
            grace_until = coalesce(
              s.grace_until,
              coalesce(p_event_at, now()) + make_interval(days => coalesce(v_grace_days, 7))
            )
        where s.id = v_sub.id
          and not (s.source = 'manual' and s.current_period_end > coalesce(p_event_at, now()));
    when 'cancelled', 'completed', 'expired' then
      -- Razorpay only ends what Razorpay started and charged for: cancelling a
      -- trial's mandate, a halted subscription or a replacement that never
      -- charged doesn't cut a trial, grace or paid period short.
      -- An autopay that finished its charges (an offer's cycles) runs to the
      -- end of the paid period, while the owner sets up the next (SA-78).
      update public.restaurant_subscriptions s
        set status = case
              when s.status = 'active' and s.source = 'razorpay' and s.next_plan_id is null
                   and v_status = 'cancelled' then 'cancelled'
              else s.status
            end,
            cancel_at_period_end = s.cancel_at_period_end or (
              s.status = 'active' and s.source = 'razorpay' and s.next_plan_id is null
              and v_status = 'completed'
            ),
            next_plan_id = null,
            next_billing_cycle = null,
            next_deal_id = null
        where s.id = v_sub.id;
      -- The deal this autopay charged is spent.
      if v_sub.next_plan_id is null and v_sub.deal_id is not null then
        update public.subscription_deals d set ended_at = coalesce(d.ended_at, now())
        where d.id = v_sub.deal_id;
      end if;
    else
      -- created, paused: nothing beyond razorpay_status.
      null;
  end case;

  select * into v_after from public.restaurant_subscriptions s where s.id = v_sub.id;
  if (v_sub.status, v_sub.plan_id, v_sub.current_period_end, v_sub.grace_until,
      v_sub.cancel_at_period_end, v_sub.razorpay_status)
     is distinct from
     (v_after.status, v_after.plan_id, v_after.current_period_end, v_after.grace_until,
      v_after.cancel_at_period_end, v_after.razorpay_status)
  then
    perform private.write_audit(
      p_restaurant_id, 'system', null, null, 'Razorpay',
      'subscription.razorpay_updated', 'restaurant_subscription', v_sub.id,
      jsonb_build_object(
        'status', v_sub.status, 'plan_id', v_sub.plan_id,
        'current_period_end', v_sub.current_period_end, 'grace_until', v_sub.grace_until,
        'cancel_at_period_end', v_sub.cancel_at_period_end, 'razorpay_status', v_sub.razorpay_status
      ),
      jsonb_build_object(
        'status', v_after.status, 'plan_id', v_after.plan_id,
        'current_period_end', v_after.current_period_end, 'grace_until', v_after.grace_until,
        'cancel_at_period_end', v_after.cancel_at_period_end,
        'razorpay_status', v_after.razorpay_status, 'razorpay_subscription_id', v_id
      )
    );
  end if;
  return 'applied';
end;
$function$;

-- public.razorpay_save_subscription
CREATE OR REPLACE FUNCTION public.razorpay_save_subscription(p_restaurant_id uuid, p_entity jsonb, p_actor_user_id uuid DEFAULT NULL::uuid, p_cancel_scheduled boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_restaurant public.restaurants;
  v_sub public.restaurant_subscriptions;
  v_id text;
  v_notes jsonb;
  v_plan public.plans;
  v_cycle text;
  v_actor_type public.actor_type := 'system';
  v_actor_role public.member_role;
  v_actor_label text := 'Razorpay';
  v_result text;
  v_deal public.subscription_deals;
begin
  if jsonb_typeof(p_entity) is distinct from 'object' then
    perform private.fail('INVALID_INPUT', 'subscription');
  end if;
  v_id := private.json_text(p_entity, 'id');
  if v_id is null or v_id !~ '^sub_[A-Za-z0-9]{1,40}$' then
    perform private.fail('INVALID_INPUT', 'subscription.id');
  end if;
  v_notes := coalesce(p_entity -> 'notes', '{}'::jsonb);
  if jsonb_typeof(v_notes) <> 'object'
     or (v_notes ->> 'restaurant_id') is distinct from p_restaurant_id::text then
    perform private.fail('INVALID_INPUT', 'notes.restaurant_id');
  end if;

  if p_actor_user_id is not null then
    if exists (select 1 from public.platform_admins a where a.user_id = p_actor_user_id) then
      v_actor_type := 'platform_admin';
      v_actor_label := 'Platform admin';
    else
      select 'staff', m.role, m.display_name
      into v_actor_type, v_actor_role, v_actor_label
      from public.restaurant_members m
      where m.user_id = p_actor_user_id and m.restaurant_id = p_restaurant_id
        and m.is_active and m.role = 'owner';
      if v_actor_role is null then
        perform private.fail('FORBIDDEN');
      end if;
    end if;
  end if;

  select * into v_restaurant from public.restaurants r where r.id = p_restaurant_id;
  if not found then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;
  select * into v_sub
  from public.restaurant_subscriptions s
  where s.restaurant_id = p_restaurant_id
  for update;
  if not found then
    perform private.fail('SUBSCRIPTION_NOT_FOUND');
  end if;

  if v_sub.razorpay_subscription_id is distinct from v_id then
    -- A new Razorpay subscription for this restaurant.
    if v_restaurant.status = 'suspended' then
      perform private.fail('RESTAURANT_SUSPENDED');
    end if;
    if v_sub.razorpay_status in ('authenticated', 'active') and not v_sub.cancel_at_period_end then
      perform private.fail('RAZORPAY_SUBSCRIPTION_LIVE');
    end if;
    select * into v_plan from public.plans p where p.code = v_notes ->> 'plan_code';
    if not found then
      perform private.fail('PLAN_NOT_FOUND');
    end if;
    if not v_plan.is_active then
      perform private.fail('PLAN_INACTIVE');
    end if;
    v_cycle := v_notes ->> 'billing_cycle';
    if v_cycle is null or v_cycle not in ('monthly', 'yearly') then
      perform private.fail('INVALID_INPUT', 'notes.billing_cycle');
    end if;
    if v_notes ? 'deal_id' then
      if coalesce(v_notes ->> 'deal_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        perform private.fail('INVALID_INPUT', 'notes.deal_id');
      end if;
      select * into v_deal from public.subscription_deals d
      where d.id = (v_notes ->> 'deal_id')::uuid
      for update;
      if v_deal.id is null or v_deal.restaurant_id <> p_restaurant_id
         or v_deal.ended_at is not null
         or v_deal.plan_id <> v_plan.id or v_deal.billing_cycle::text <> v_cycle
         or v_deal.razorpay_plan_id is distinct from private.json_text(p_entity, 'plan_id')
      then
        perform private.fail('INVALID_INPUT', 'notes.deal_id');
      end if;
    end if;

    update public.restaurant_subscriptions s
      set razorpay_subscription_id = v_id,
          razorpay_status = null,
          razorpay_event_at = null,
          next_plan_id = v_plan.id,
          next_billing_cycle = v_cycle::public.billing_cycle,
          next_deal_id = v_deal.id
      where s.id = v_sub.id;
    perform private.write_audit(
      p_restaurant_id, v_actor_type, p_actor_user_id, v_actor_role, v_actor_label,
      'subscription.autopay_started', 'restaurant_subscription', v_sub.id,
      jsonb_build_object('razorpay_subscription_id', v_sub.razorpay_subscription_id),
      jsonb_build_object(
        'razorpay_subscription_id', v_id, 'plan_code', v_plan.code, 'billing_cycle', v_cycle
      ) || case when v_deal.id is null then '{}'::jsonb else jsonb_build_object(
        'deal_id', v_deal.id, 'price_paise', v_deal.price_paise, 'cycles', v_deal.cycles
      ) end
    );
  end if;

  if p_cancel_scheduled and not v_sub.cancel_at_period_end then
    update public.restaurant_subscriptions s set cancel_at_period_end = true where s.id = v_sub.id;
    perform private.write_audit(
      p_restaurant_id, v_actor_type, p_actor_user_id, v_actor_role, v_actor_label,
      'subscription.cancel_scheduled', 'restaurant_subscription', v_sub.id,
      jsonb_build_object('cancel_at_period_end', false),
      jsonb_build_object('cancel_at_period_end', true, 'razorpay_subscription_id', v_id)
    );
  end if;

  v_result := private.apply_razorpay_subscription(p_restaurant_id, p_entity, null, null);

  select * into v_sub from public.restaurant_subscriptions s where s.id = v_sub.id;
  return jsonb_build_object(
    'result', v_result,
    'status', v_sub.status,
    'razorpay_status', v_sub.razorpay_status,
    'cancel_at_period_end', v_sub.cancel_at_period_end,
    'current_period_end', v_sub.current_period_end
  );
end;
$function$;

-- private.stamp_payment_plan
CREATE OR REPLACE FUNCTION private.stamp_payment_plan()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_sub public.restaurant_subscriptions;
  v_deal public.subscription_deals;
begin
  if new.purpose <> 'subscription' or new.plan_id is not null then
    return new;
  end if;
  select * into v_sub
  from public.restaurant_subscriptions s
  where s.restaurant_id = new.restaurant_id;
  if not found then
    return new;
  end if;
  if new.source = 'razorpay' then
    new.plan_id := coalesce(v_sub.next_plan_id, v_sub.plan_id);
  else
    new.plan_id := v_sub.plan_id;
  end if;
  new.billing_cycle := coalesce(
    new.billing_cycle,
    case
      when new.period_end - new.period_start >= interval '360 days' then 'yearly'
      when new.period_end > new.period_start then 'monthly'
    end::public.billing_cycle,
    case when new.source = 'razorpay' then v_sub.next_billing_cycle end,
    v_sub.billing_cycle
  );
  if new.list_price_paise is null then
    select * into v_deal from public.subscription_deals d
    where d.id = case when new.source = 'razorpay' and v_sub.next_plan_id is not null
      then v_sub.next_deal_id else v_sub.deal_id end;
    if v_deal.plan_id = new.plan_id and v_deal.billing_cycle = new.billing_cycle then
      new.deal_id := v_deal.id;
      new.list_price_paise := v_deal.list_price_paise;
      new.discount_paise := v_deal.list_price_paise - v_deal.price_paise;
    end if;
  end if;
  return new;
end;
$function$;

-- public.platform_get_restaurant
CREATE OR REPLACE FUNCTION public.platform_get_restaurant(p_restaurant_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_restaurant public.restaurants;
  v_money boolean;
  v_owners jsonb;
  v_subscription jsonb;
  v_payments jsonb;
  v_access jsonb;
  v_usage jsonb;
  v_state text;
begin
  perform private.require_platform_permission('restaurants.view');
  v_money := private.has_platform_permission('money.view');
  select * into v_restaurant from public.restaurants r where r.id = p_restaurant_id;
  if not found then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'member_id', m.id,
    'display_name', m.display_name,
    'username', m.username,
    'is_active', m.is_active,
    'email', u.email,
    'email_is_real', u.email is not null
      and split_part(u.email, '@', 2) not like v_restaurant.slug || '.staff.%',
    'last_sign_in_at', u.last_sign_in_at
  ) order by m.created_at), '[]'::jsonb)
  into v_owners
  from public.restaurant_members m
  left join auth.users u on u.id = m.user_id
  where m.restaurant_id = p_restaurant_id and m.role = 'owner';

  select jsonb_build_object(
      'plan_id', p.id,
      'plan_code', p.code,
      'plan_name', p.name,
      'billing_cycle', s.billing_cycle,
      'status', s.status,
      'source', s.source,
      'trial_ends_at', s.trial_ends_at,
      'current_period_start', s.current_period_start,
      'current_period_end', s.current_period_end,
      'grace_until', s.grace_until,
      'cancel_at_period_end', s.cancel_at_period_end,
      'razorpay_subscription_id', s.razorpay_subscription_id,
      'razorpay_status', s.razorpay_status,
      'next_plan_name', np.name,
      'next_billing_cycle', s.next_billing_cycle,
      'cancel_reason', s.cancel_reason,
      'cancel_reason_detail', s.cancel_reason_detail,
      'max_tables', e.max_tables,
      'max_staff', e.max_staff,
      'plan_max_tables', p.max_tables,
      'plan_max_staff', p.max_staff,
      'effective_monthly_paise', case when v_money then s.effective_monthly_paise end,
      'deal', private.deal_json(s.deal_id, v_money),
      'next_deal', private.deal_json(s.next_deal_id, v_money)
    )
  into v_subscription
  from public.restaurant_subscriptions s
  join public.plans p on p.id = s.plan_id
  cross join lateral private.effective_plan(s.restaurant_id) e
  left join public.plans np on np.id = s.next_plan_id
  where s.restaurant_id = p_restaurant_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'payment_id', sp.id,
    'source', sp.source,
    'purpose', sp.purpose,
    'amount_paise', sp.amount_paise,
    'base_paise', sp.base_paise,
    'gst_paise', sp.gst_paise,
    'manual_mode', sp.manual_mode,
    'plan_name', pl.name,
    'billing_cycle', sp.billing_cycle,
    'razorpay_payment_id', sp.razorpay_payment_id,
    'recorded_by', u.email,
    'period_start', sp.period_start,
    'period_end', sp.period_end,
    'notes', sp.notes,
    'created_at', sp.created_at
  ) order by sp.created_at desc), '[]'::jsonb)
  into v_payments
  from public.subscription_payments sp
  left join public.plans pl on pl.id = sp.plan_id
  left join auth.users u on u.id = sp.recorded_by
  where sp.restaurant_id = p_restaurant_id and v_money;

  select
    jsonb_build_object(
      'state', a.state, 'reason', a.reason, 'restriction_at', a.restriction_at, 'warning', a.warning
    ),
    private.subscription_state(v_restaurant.status::text, a.state, s.status::text, s.source::text)
  into v_access, v_state
  from public.restaurant_access(p_restaurant_id) as a
  left join public.restaurant_subscriptions s on s.restaurant_id = p_restaurant_id;

  select jsonb_build_object(
    'tables_active', (
      select count(*) from public.dining_tables t
      where t.restaurant_id = p_restaurant_id and t.is_active
    ),
    'staff_logins', (
      select count(*) from public.restaurant_members m
      where m.restaurant_id = p_restaurant_id and m.is_active and m.role <> 'owner'
    ),
    'waiters', (
      select count(*) from public.waiters w
      where w.restaurant_id = p_restaurant_id and w.is_active
    ),
    'last_order_at', (
      select max(o.created_at) from public.orders o where o.restaurant_id = p_restaurant_id
    ),
    'bills', (
      select count(*) from public.bills b
      where b.restaurant_id = p_restaurant_id and b.status = 'active'
    )
  )
  into v_usage;

  return jsonb_build_object(
    'restaurant', jsonb_build_object(
      'id', v_restaurant.id,
      'name', v_restaurant.name,
      'slug', v_restaurant.slug,
      'legal_name', v_restaurant.legal_name,
      'address_line', v_restaurant.address_line,
      'city', v_restaurant.city,
      'state', v_restaurant.state,
      'pincode', v_restaurant.pincode,
      'phone', v_restaurant.phone,
      'email', v_restaurant.email,
      'gstin', v_restaurant.gstin,
      'gst_mode', v_restaurant.gst_mode,
      'timezone', v_restaurant.timezone,
      'business_day_start_hour', v_restaurant.business_day_start_hour,
      'status', v_restaurant.status,
      'suspended_reason', v_restaurant.suspended_reason,
      'acquisition_channel', v_restaurant.acquisition_channel,
      'created_at', v_restaurant.created_at
    ),
    'state', v_state,
    'health', private.restaurant_health(v_restaurant.id, v_restaurant.created_at),
    'last_active', private.restaurant_last_active(v_restaurant.id),
    'account_manager', (
      select jsonb_build_object('user_id', u.id, 'email', u.email)
      from public.restaurant_account_managers am
      join auth.users u on u.id = am.user_id
      where am.restaurant_id = v_restaurant.id
    ),
    'tags', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'colour', t.colour)
        order by lower(t.name))
      from public.restaurant_tags rt
      join public.platform_tags t on t.id = rt.tag_id
      where rt.restaurant_id = v_restaurant.id
    ), '[]'::jsonb),
    'owners', v_owners,
    'subscription', v_subscription,
    -- Waiting for the restaurant's next autopay, or not yet in use.
    'open_deal', (
      select private.deal_json(d.id, v_money)
      from public.subscription_deals d
      join public.restaurant_subscriptions s on s.restaurant_id = d.restaurant_id
      where d.restaurant_id = v_restaurant.id and d.ended_at is null
        and d.id is distinct from s.deal_id
    ),
    'overrides', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', o.id, 'kind', o.kind, 'feature', o.feature, 'value', o.value,
        'expires_at', o.expires_at, 'expired', o.expires_at <= now(), 'reason', o.reason,
        'created_by', u.email, 'created_at', o.created_at
      ) order by o.kind, o.feature)
      from public.restaurant_overrides o
      left join auth.users u on u.id = o.created_by
      where o.restaurant_id = v_restaurant.id
    ), '[]'::jsonb),
    'money', v_money,
    'payments', v_payments,
    'access', v_access,
    'usage', v_usage
  );
end;
$function$;

-- public.platform_restaurant_billing
CREATE OR REPLACE FUNCTION public.platform_restaurant_billing(p_restaurant_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_money boolean;
  v_slug text;
  v_dues jsonb;
begin
  perform private.require_platform_permission('restaurants.view');
  v_money := private.has_platform_permission('money.view');
  select r.slug into v_slug from public.restaurants r where r.id = p_restaurant_id;
  if not found then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;

  -- The slug narrows dues_rows to (about) this restaurant before its access is
  -- worked out.
  select jsonb_build_object(
    'bucket', d.bucket,
    'renewal_kind', d.renewal_kind,
    'due_paise', case when v_money then d.due_paise end,
    'grace_until', d.grace_until,
    'trial_ends_at', d.trial_ends_at,
    'current_period_end', d.current_period_end,
    'restriction_at', d.restriction_at
  )
  into v_dues
  from private.dues_rows(v_slug) d
  where d.restaurant_id = p_restaurant_id;

  return jsonb_build_object(
    'dues', v_dues,
    'reminders', coalesce((
      select jsonb_agg(jsonb_build_object('kind', x.kind, 'sent_at', x.sent_at)
        order by x.sent_at desc)
      from (
        select sr.kind, sr.sent_at from public.subscription_reminders sr
        where sr.restaurant_id = p_restaurant_id
        order by sr.sent_at desc limit 50
      ) as x
    ), '[]'::jsonb),
    'links', coalesce((
      select jsonb_agg(jsonb_build_object(
        'at', x.created_at,
        'actor', x.actor,
        'purpose', x.after ->> 'purpose',
        'months', x.after -> 'months',
        'amount_paise', case when v_money then x.after -> 'amount_paise' end,
        'short_url', x.after ->> 'short_url',
        'paid_at', x.paid_at
      ) order by x.created_at desc)
      from (
        select a.created_at, a.after, u.email as actor, (
          select min(p.created_at) from public.audit_logs p
          where p.restaurant_id = p_restaurant_id
            and p.action = 'subscription.payment_received'
            and p.after ->> 'payment_link_id' = a.after ->> 'payment_link_id'
        ) as paid_at
        from public.audit_logs a
        left join auth.users u on u.id = a.actor_user_id
        where a.restaurant_id = p_restaurant_id and a.action = 'subscription.payment_link_sent'
        order by a.created_at desc limit 50
      ) as x
    ), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'at', x.created_at,
        'action', x.action,
        'actor', x.actor,
        'before', x.before,
        'after', case when v_money then x.after
          else x.after - 'price_paise' - 'list_price_paise' end,
        'reason', x.reason
      ) order by x.created_at desc)
      from (
        select a.created_at, a.action, a.before, a.after, a.reason,
          coalesce(u.email, a.actor_label) as actor
        from public.audit_logs a
        left join auth.users u on u.id = a.actor_user_id
        where a.restaurant_id = p_restaurant_id
          and a.action in (
            'subscription.plan_changed', 'subscription.trial_extended',
            'subscription.autopay_started', 'subscription.cancel_scheduled',
            'subscription.cancel_reason', 'subscription.razorpay_updated',
            'restaurant.suspended', 'restaurant.unsuspended',
            'subscription.deal_set', 'subscription.deal_ended'
          )
        order by a.created_at desc limit 50
      ) as x
    ), '[]'::jsonb)
  );
end;
$function$;

-- public.platform_revenue_report
CREATE OR REPLACE FUNCTION public.platform_revenue_report(p_from date, p_to date, p_by text DEFAULT 'month'::text, p_compare boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    'discounts', (
      select jsonb_build_object(
        'payments', count(*),
        'restaurants', count(distinct p.restaurant_id),
        'discount_paise', coalesce(sum(p.discount_paise), 0),
        'on_deal_now', (
          select count(*) from public.restaurant_subscriptions s
          where s.deal_id is not null and s.status = 'active' and s.source is not null
        ),
        'monthly_discount_now_paise', (
          select coalesce(sum(private.monthly_paise(pl, s.billing_cycle) - s.effective_monthly_paise), 0)
          from public.restaurant_subscriptions s
          join public.plans pl on pl.id = s.plan_id
          where s.deal_id is not null and s.status = 'active' and s.source is not null
        ))
      from public.subscription_payments p
      where p.purpose = 'subscription' and p.deal_id is not null and p.discount_paise > 0
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
$function$;

-- public.platform_upgrade_opportunities
CREATE OR REPLACE FUNCTION public.platform_upgrade_opportunities()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('growth.manage');
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  -- ponytail: a fixed bar for "busy"; a platform setting if the team wants to tune it.
  v_busy int := 600;
begin
  return (
    with starter as (
      select r.id, r.name, r.slug, r.city, r.phone, e.max_tables, e.max_staff, st.state
      from public.restaurants r
      join public.restaurant_subscriptions s on s.restaurant_id = r.id
      join public.plans pl on pl.id = s.plan_id and pl.code = 'starter'
      cross join lateral private.effective_plan(r.id) e
      cross join lateral private.restaurant_access(r.id) a
      cross join lateral (
        select private.subscription_state(r.status::text, a.state, s.status::text, s.source::text) as state
      ) st
      where st.state in ('trial', 'paid', 'payment_failed')
    ),
    usage as (
      select u.restaurant_id, sum(u.orders)::int as orders
      from private.platform_usage(v_today - 29, v_today) u
      where u.restaurant_id in (select s.id from starter s)
      group by u.restaurant_id
    ),
    facts as (
      select
        s.*,
        (select count(*) from public.dining_tables d
          where d.restaurant_id = s.id and d.is_active)::int as tables,
        (select count(*) from public.restaurant_members m
          where m.restaurant_id = s.id and m.is_active and m.role <> 'owner')::int as staff,
        coalesce(u.orders, 0) as orders,
        (select count(*) from public.plan_limit_events e
          where e.restaurant_id = s.id and e.created_at >= now() - interval '30 days')::int as hit_count,
        (select coalesce(jsonb_agg(jsonb_build_object(
            'kind', h.kind, 'feature', h.feature, 'count', h.n
          ) order by h.n desc, h.kind, h.feature), '[]'::jsonb)
          from (
            select e.kind, e.feature, count(*)::int as n
            from public.plan_limit_events e
            where e.restaurant_id = s.id and e.created_at >= now() - interval '30 days'
            group by e.kind, e.feature
          ) h) as hits
      from starter s
      left join usage u on u.restaurant_id = s.id
    ),
    chosen as (
      select f.*
      from facts f
      where f.hit_count > 0 or f.tables >= f.max_tables or f.staff >= f.max_staff
        or f.orders >= v_busy
      order by f.hit_count desc, f.orders desc, f.name, f.id
      limit 100
    )
    select jsonb_build_object(
      'busy_orders', v_busy,
      'rows', coalesce(jsonb_agg(jsonb_build_object(
        'restaurant_id', c.id,
        'name', c.name,
        'slug', c.slug,
        'city', c.city,
        'phone', c.phone,
        'state', c.state,
        'tables', c.tables,
        'max_tables', c.max_tables,
        'staff', c.staff,
        'max_staff', c.max_staff,
        'orders', c.orders,
        'hits', c.hits
      ) order by c.hit_count desc, c.orders desc, c.name, c.id), '[]'::jsonb)
    )
    from chosen c
  );
end;
$function$;

-- private.restaurant_access
CREATE OR REPLACE FUNCTION private.restaurant_access(p_restaurant_id uuid, p_at timestamp with time zone DEFAULT now())
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
      when v_restriction - p_at > case when v_sub.razorpay_status = 'completed'
        then interval '7 days' else interval '3 days' end then null
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

-- ─── Offer rules ────────────────────────────────────────────────────────────
-- Why a restaurant can't use an offer now, or null when it can.
create function private.offer_refusal(p_offer public.offers, p_restaurant_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when p_offer.ended_at is not null or now() < p_offer.valid_from
      or now() >= coalesce(p_offer.valid_until, 'infinity'::timestamptz) then 'OFFER_EXPIRED'
    when exists (
      select 1 from public.subscription_deals d
      where d.offer_id = p_offer.id and d.restaurant_id = p_restaurant_id and d.used_at is not null
    ) then 'OFFER_ALREADY_USED'
    -- New: never paid a subscription (owner's choice, 2026-10-15).
    when p_offer.new_only and exists (
      select 1 from public.subscription_payments sp
      where sp.restaurant_id = p_restaurant_id and sp.purpose = 'subscription'
    ) then 'OFFER_NEW_ONLY'
    -- A checkout started in the last day holds its place.
    when p_offer.max_redemptions is not null and (
      select count(*) from public.subscription_deals d
      where d.offer_id = p_offer.id and d.restaurant_id <> p_restaurant_id
        and (d.used_at is not null
          or (d.ended_at is null and d.created_at > now() - interval '24 hours'))
    ) >= p_offer.max_redemptions then 'OFFER_USED_UP'
  end
$$;

-- An offer's price for a plan and cycle, in whole rupees before GST; null when
-- it isn't for them or leaves nothing to pay. A flat discount comes off each
-- charge, yearly ones too (owner's choice, 2026-10-15).
create function private.offer_price_paise(
  p_offer public.offers, p_plan public.plans, p_cycle public.billing_cycle
)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case
    when p_offer.plan_ids is not null and not (p_plan.id = any (p_offer.plan_ids)) then null
    when p_offer.cycles is not null and not (p_cycle = any (p_offer.cycles)) then null
    when v.price >= 100 and v.price < v.list then v.price
  end
  from (
    select l.list, (round(case when p_offer.discount_kind = 'percent'
        then l.list * (100 - p_offer.discount_value) / 100.0
        else (l.list - p_offer.discount_value)::numeric
      end / 100) * 100)::bigint as price
    from (select private.cycle_price_paise(p_plan, p_cycle) as list) as l
  ) as v
$$;

-- ─── Offers (Settings, settings.manage) ─────────────────────────────────────
create function public.platform_list_offers()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('settings.manage');
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', o.id,
      'code', o.code,
      'description', o.description,
      'discount_kind', o.discount_kind,
      'discount_value', o.discount_value,
      'plan_codes', (
        select jsonb_agg(p.code order by p.sort_order) from public.plans p where p.id = any (o.plan_ids)
      ),
      'cycles', to_jsonb(o.cycles),
      'duration_cycles', o.duration_cycles,
      'valid_from', o.valid_from,
      'valid_until', o.valid_until,
      'max_redemptions', o.max_redemptions,
      'new_only', o.new_only,
      'ended_at', o.ended_at,
      'used', (
        select count(*) from public.subscription_deals d
        where d.offer_id = o.id and d.used_at is not null
      ),
      'discount_paise', (
        select coalesce(sum(sp.discount_paise), 0)
        from public.subscription_payments sp
        join public.subscription_deals d on d.id = sp.deal_id
        where d.offer_id = o.id
      ),
      'created_by', u.email,
      'created_at', o.created_at
    ) order by o.ended_at is not null, o.created_at desc)
    from public.offers o
    left join auth.users u on u.id = o.created_by
  ), '[]'::jsonb);
end;
$$;

-- A new offer, or an existing one's description, end date or maximum, or
-- ending it. Its terms don't change once made: end it and make another.
create function public.platform_save_offer(p_offer jsonb, p_offer_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('settings.manage');
  v_patch jsonb := coalesce(p_offer, '{}'::jsonb);
  v_old public.offers;
  v_new public.offers;
  v_codes text[];
  v_key text;
  v_before jsonb := '{}'::jsonb;
  v_after jsonb := '{}'::jsonb;
begin
  if p_offer_id is null then
    perform private.assert_keys(v_patch, array['code', 'description', 'discount_kind',
      'discount_value', 'plan_codes', 'cycles', 'duration_cycles', 'valid_from', 'valid_until',
      'max_redemptions', 'new_only']);
    v_new.code := upper(btrim(coalesce(private.json_text(v_patch, 'code'), '')));
    if v_new.code !~ '^[A-Z0-9]{3,20}$' then
      perform private.fail('INVALID_INPUT', 'code');
    end if;
    if exists (select 1 from public.offers o where o.code = v_new.code) then
      perform private.fail('OFFER_CODE_TAKEN');
    end if;
    v_new.discount_kind := private.json_text(v_patch, 'discount_kind');
    v_new.discount_value := private.json_int(v_patch, 'discount_value');
    if v_new.discount_kind is null or v_new.discount_kind not in ('percent', 'flat')
       or v_new.discount_value is null
       or (v_new.discount_kind = 'percent' and v_new.discount_value not between 1 and 99)
       or (v_new.discount_kind = 'flat'
         and (v_new.discount_value not between 100 and 100000000 or v_new.discount_value % 100 <> 0))
    then
      perform private.fail('INVALID_INPUT', 'discount_value');
    end if;
    if coalesce(jsonb_typeof(v_patch -> 'plan_codes'), 'null') <> 'null' then
      if jsonb_typeof(v_patch -> 'plan_codes') <> 'array' then
        perform private.fail('INVALID_INPUT', 'plan_codes');
      end if;
      select array_agg(x) into v_codes from jsonb_array_elements_text(v_patch -> 'plan_codes') as x;
      select array_agg(p.id) into v_new.plan_ids from public.plans p where p.code = any (v_codes);
      if coalesce(cardinality(v_codes), 0) = 0
         or coalesce(cardinality(v_new.plan_ids), 0) <> cardinality(array(select distinct unnest(v_codes))) then
        perform private.fail('INVALID_INPUT', 'plan_codes');
      end if;
    end if;
    if coalesce(jsonb_typeof(v_patch -> 'cycles'), 'null') <> 'null' then
      if jsonb_typeof(v_patch -> 'cycles') <> 'array'
         or jsonb_array_length(v_patch -> 'cycles') = 0
         or exists (
           select 1 from jsonb_array_elements_text(v_patch -> 'cycles') as c
           where c not in ('monthly', 'yearly')
         ) then
        perform private.fail('INVALID_INPUT', 'cycles');
      end if;
      select array_agg(distinct c::public.billing_cycle) into v_new.cycles
      from jsonb_array_elements_text(v_patch -> 'cycles') as c;
    end if;
    if v_patch ? 'duration_cycles' and jsonb_typeof(v_patch -> 'duration_cycles') <> 'null' then
      v_new.duration_cycles := private.json_int(v_patch, 'duration_cycles');
      if v_new.duration_cycles not between 1 and 120 then
        perform private.fail('INVALID_INPUT', 'duration_cycles');
      end if;
    end if;
    v_new.valid_from := coalesce(private.json_time(v_patch, 'valid_from'), now());
    v_new.new_only := v_patch ? 'new_only' and private.json_bool(v_patch, 'new_only');
  else
    perform private.assert_keys(v_patch, array['description', 'valid_until', 'max_redemptions', 'ended']);
    select * into v_old from public.offers o where o.id = p_offer_id for update;
    if v_old.id is null then
      perform private.fail('OFFER_NOT_FOUND');
    end if;
    v_new := v_old;
  end if;

  if v_patch ? 'description' then
    v_new.description := private.tidy_text(private.json_text(v_patch, 'description'));
    if char_length(v_new.description) > 200 then
      perform private.fail('INVALID_INPUT', 'description');
    end if;
  end if;
  if v_patch ? 'valid_until' then
    v_new.valid_until := private.json_time(v_patch, 'valid_until');
    if v_new.valid_until <= v_new.valid_from then
      perform private.fail('INVALID_INPUT', 'valid_until');
    end if;
  end if;
  if v_patch ? 'max_redemptions' then
    v_new.max_redemptions := case when jsonb_typeof(v_patch -> 'max_redemptions') <> 'null'
      then private.json_int(v_patch, 'max_redemptions') end;
    if v_new.max_redemptions not between 1 and 100000 then
      perform private.fail('INVALID_INPUT', 'max_redemptions');
    end if;
  end if;
  if v_patch ? 'ended' then
    if jsonb_typeof(v_patch -> 'ended') <> 'boolean' or not (v_patch ->> 'ended')::boolean then
      perform private.fail('INVALID_INPUT', 'ended');
    end if;
    v_new.ended_at := coalesce(v_old.ended_at, now());
  end if;

  if p_offer_id is null then
    insert into public.offers (code, description, discount_kind, discount_value, plan_ids, cycles,
      duration_cycles, valid_from, valid_until, max_redemptions, new_only, created_by)
    values (v_new.code, v_new.description, v_new.discount_kind, v_new.discount_value,
      v_new.plan_ids, v_new.cycles, v_new.duration_cycles, v_new.valid_from, v_new.valid_until,
      v_new.max_redemptions, v_new.new_only, v_admin.user_id)
    returning * into v_new;
    perform private.audit_platform(v_admin, null, 'offer.created', 'offer', v_new.id, null,
      jsonb_build_object('code', v_new.code, 'discount_kind', v_new.discount_kind,
        'discount_value', v_new.discount_value, 'plan_ids', v_new.plan_ids, 'cycles', v_new.cycles,
        'duration_cycles', v_new.duration_cycles, 'valid_from', v_new.valid_from,
        'valid_until', v_new.valid_until, 'max_redemptions', v_new.max_redemptions,
        'new_only', v_new.new_only));
  else
    update public.offers o set
      description = v_new.description,
      valid_until = v_new.valid_until,
      max_redemptions = v_new.max_redemptions,
      ended_at = v_new.ended_at,
      updated_at = now()
    where o.id = p_offer_id;
    foreach v_key in array array['description', 'valid_until', 'max_redemptions'] loop
      if to_jsonb(v_old) -> v_key is distinct from to_jsonb(v_new) -> v_key then
        v_before := v_before || jsonb_build_object(v_key, to_jsonb(v_old) -> v_key);
        v_after := v_after || jsonb_build_object(v_key, to_jsonb(v_new) -> v_key);
      end if;
    end loop;
    if v_before <> '{}'::jsonb then
      perform private.audit_platform(v_admin, null, 'offer.updated', 'offer', v_new.id,
        v_before || jsonb_build_object('code', v_new.code), v_after);
    end if;
    if v_old.ended_at is null and v_new.ended_at is not null then
      perform private.audit_platform(v_admin, null, 'offer.ended', 'offer', v_new.id, null,
        jsonb_build_object('code', v_new.code));
    end if;
  end if;
  return jsonb_build_object('id', v_new.id, 'code', v_new.code);
end;
$$;

-- ─── One restaurant's price (money.record) ──────────────────────────────────
-- An offer code or a custom price with a reason, for a plan and cycle; or
-- {"end": true}. Not on autopay: the restaurant pays it from now on.
-- On autopay: from its next autopay, since Razorpay can't change the price.
create function public.platform_set_deal(p_restaurant_id uuid, p_deal jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('money.record');
  v_input jsonb := coalesce(p_deal, '{}'::jsonb);
  v_sub public.restaurant_subscriptions;
  v_open public.subscription_deals;
  v_plan public.plans;
  v_cycle public.billing_cycle;
  v_offer public.offers;
  v_list bigint;
  v_price bigint;
  v_cycles int;
  v_reason text;
  v_refusal text;
  v_autopay boolean;
  v_deal public.subscription_deals;
begin
  perform private.assert_keys(v_input,
    array['plan_code', 'billing_cycle', 'offer_code', 'price_paise', 'cycles', 'reason', 'end']);
  select * into v_sub from public.restaurant_subscriptions s
  where s.restaurant_id = p_restaurant_id
  for update;
  if v_sub.id is null then
    if not exists (select 1 from public.restaurants r where r.id = p_restaurant_id) then
      perform private.fail('RESTAURANT_NOT_FOUND');
    end if;
    perform private.fail('SUBSCRIPTION_NOT_FOUND');
  end if;
  -- A mandate that will charge again keeps its price.
  v_autopay := coalesce(v_sub.razorpay_status in ('authenticated', 'active', 'pending', 'halted'), false)
    and not v_sub.cancel_at_period_end;
  select * into v_open from public.subscription_deals d
  where d.restaurant_id = p_restaurant_id and d.ended_at is null;
  v_reason := private.tidy_text(private.json_text(v_input, 'reason'));
  if char_length(v_reason) > 500 then
    perform private.fail('INVALID_INPUT', 'reason');
  end if;

  if v_input ? 'end' then
    if v_input <> jsonb_build_object('end', true) and v_input - 'reason' <> jsonb_build_object('end', true) then
      perform private.fail('INVALID_INPUT', 'end');
    end if;
    if v_open.id is null then
      perform private.fail('DEAL_NOT_FOUND');
    end if;
    update public.subscription_deals d set ended_at = now() where d.id = v_open.id;
    if v_sub.deal_id = v_open.id and not v_autopay then
      update public.restaurant_subscriptions s set deal_id = null where s.id = v_sub.id;
    end if;
    perform private.audit_platform(v_admin, p_restaurant_id, 'subscription.deal_ended',
      'subscription_deal', v_open.id, null,
      jsonb_build_object('price_paise', v_open.price_paise, 'list_price_paise', v_open.list_price_paise,
        'still_charged', v_sub.deal_id = v_open.id and v_autopay),
      v_reason);
    return jsonb_build_object('ended', true, 'still_charged', v_sub.deal_id = v_open.id and v_autopay);
  end if;

  select * into v_plan from public.plans p where p.code = private.json_text(v_input, 'plan_code');
  if v_plan.id is null then
    perform private.fail('PLAN_NOT_FOUND');
  end if;
  if not v_plan.is_active then
    perform private.fail('PLAN_INACTIVE');
  end if;
  if private.json_text(v_input, 'billing_cycle') is null
     or private.json_text(v_input, 'billing_cycle') not in ('monthly', 'yearly') then
    perform private.fail('INVALID_INPUT', 'billing_cycle');
  end if;
  v_cycle := private.json_text(v_input, 'billing_cycle')::public.billing_cycle;
  v_list := private.cycle_price_paise(v_plan, v_cycle);
  if v_list < 100 then
    perform private.fail('INVALID_INPUT', 'plan_code');
  end if;

  if (v_input ? 'offer_code') = (v_input ? 'price_paise') then
    perform private.fail('INVALID_INPUT', 'offer_code');
  end if;
  if v_input ? 'offer_code' then
    if v_input ? 'cycles' then
      perform private.fail('INVALID_INPUT', 'cycles');
    end if;
    select * into v_offer from public.offers o
    where o.code = upper(btrim(coalesce(private.json_text(v_input, 'offer_code'), '')))
    for update;
    if v_offer.id is null then
      perform private.fail('OFFER_NOT_FOUND');
    end if;
    v_refusal := private.offer_refusal(v_offer, p_restaurant_id);
    if v_refusal is not null then
      perform private.fail(v_refusal);
    end if;
    v_price := private.offer_price_paise(v_offer, v_plan, v_cycle);
    if v_price is null then
      perform private.fail('OFFER_NOT_FOR_PLAN');
    end if;
    v_cycles := v_offer.duration_cycles;
  else
    v_price := private.json_int(v_input, 'price_paise');
    if v_price is null or v_price < 100 or v_price >= v_list or v_price % 100 <> 0 then
      perform private.fail('INVALID_INPUT', 'price_paise');
    end if;
    if v_reason is null then
      perform private.fail('INVALID_INPUT', 'reason');
    end if;
    if v_input ? 'cycles' and jsonb_typeof(v_input -> 'cycles') <> 'null' then
      v_cycles := private.json_int(v_input, 'cycles');
      if v_cycles not between 1 and 120 then
        perform private.fail('INVALID_INPUT', 'cycles');
      end if;
    end if;
  end if;

  if v_open.id is not null then
    update public.subscription_deals d set ended_at = now() where d.id = v_open.id;
  end if;
  insert into public.subscription_deals (restaurant_id, offer_id, plan_id, billing_cycle,
    list_price_paise, price_paise, cycles, reason, razorpay_plan_id, created_by)
  values (p_restaurant_id, v_offer.id, v_plan.id, v_cycle, v_list, v_price, v_cycles, v_reason,
    (select d.razorpay_plan_id from public.subscription_deals d
     where d.plan_id = v_plan.id and d.billing_cycle = v_cycle and d.price_paise = v_price
       and d.razorpay_plan_id is not null
     limit 1),
    v_admin.user_id)
  returning * into v_deal;
  -- Not on autopay: the new price from now on, or the list price when the
  -- deal it replaced was in use and this one is for another plan or cycle.
  if not v_autopay and (
    (v_sub.plan_id = v_plan.id and v_sub.billing_cycle = v_cycle) or v_sub.deal_id = v_open.id
  ) then
    update public.restaurant_subscriptions s
      set deal_id = case when v_sub.plan_id = v_plan.id and v_sub.billing_cycle = v_cycle
        then v_deal.id end
      where s.id = v_sub.id;
  end if;
  perform private.audit_platform(v_admin, p_restaurant_id, 'subscription.deal_set',
    'subscription_deal', v_deal.id, null,
    jsonb_build_object('offer_code', v_offer.code, 'plan_code', v_plan.code,
      'billing_cycle', v_cycle, 'list_price_paise', v_list, 'price_paise', v_price,
      'cycles', v_cycles,
      'applied_now', not v_autopay and v_sub.plan_id = v_plan.id and v_sub.billing_cycle = v_cycle),
    v_reason);
  return private.deal_json(v_deal.id, true) || jsonb_build_object(
    'applied_now', not v_autopay and v_sub.plan_id = v_plan.id and v_sub.billing_cycle = v_cycle
  );
end;
$$;

-- ─── Overrides and beta flags (restaurants.manage) ──────────────────────────
-- Sets one, replacing the restaurant's override of the same kind and feature.
create function public.platform_set_override(p_restaurant_id uuid, p_override jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.manage');
  v_input jsonb := coalesce(p_override, '{}'::jsonb);
  v_kind text;
  v_feature text;
  v_value int;
  v_expires timestamptz;
  v_reason text;
  v_old public.restaurant_overrides;
  v_row public.restaurant_overrides;
begin
  perform private.assert_keys(v_input, array['kind', 'feature', 'value', 'expires_at', 'reason']);
  if not exists (select 1 from public.restaurants r where r.id = p_restaurant_id) then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;
  v_kind := private.json_text(v_input, 'kind');
  if v_kind is null or v_kind not in ('feature', 'max_tables', 'max_staff') then
    perform private.fail('INVALID_INPUT', 'kind');
  end if;
  if v_kind = 'feature' then
    v_feature := private.json_text(v_input, 'feature');
    if v_feature is null or v_feature !~ '^[a-z_]{1,40}$' then
      perform private.fail('INVALID_INPUT', 'feature');
    end if;
    if v_input ? 'value' and jsonb_typeof(v_input -> 'value') <> 'null' then
      perform private.fail('INVALID_INPUT', 'value');
    end if;
  else
    if v_input ? 'feature' and jsonb_typeof(v_input -> 'feature') <> 'null' then
      perform private.fail('INVALID_INPUT', 'feature');
    end if;
    if v_input ? 'value' and jsonb_typeof(v_input -> 'value') <> 'null' then
      v_value := private.json_int(v_input, 'value');
      if v_value not between 1 and 10000 then
        perform private.fail('INVALID_INPUT', 'value');
      end if;
    end if;
  end if;
  v_expires := private.json_time(v_input, 'expires_at');
  if v_expires <= now() then
    perform private.fail('INVALID_INPUT', 'expires_at');
  end if;
  v_reason := private.tidy_text(private.json_text(v_input, 'reason'));
  if v_reason is null or char_length(v_reason) > 500 then
    perform private.fail('INVALID_INPUT', 'reason');
  end if;

  select * into v_old from public.restaurant_overrides o
  where o.restaurant_id = p_restaurant_id and o.kind = v_kind
    and coalesce(o.feature, '') = coalesce(v_feature, '')
  for update;
  insert into public.restaurant_overrides (restaurant_id, kind, feature, value, expires_at, reason,
    created_by)
  values (p_restaurant_id, v_kind, v_feature, v_value, v_expires, v_reason, v_admin.user_id)
  on conflict (restaurant_id, kind, (coalesce(feature, ''))) do update
    set value = excluded.value, expires_at = excluded.expires_at, reason = excluded.reason,
      created_by = excluded.created_by, updated_at = now()
  returning * into v_row;
  perform private.audit_platform(v_admin, p_restaurant_id, 'restaurant.override_set',
    'restaurant_override', v_row.id,
    case when v_old.id is not null then jsonb_build_object('value', v_old.value, 'expires_at', v_old.expires_at) end,
    jsonb_build_object('kind', v_kind, 'feature', v_feature, 'value', v_value, 'expires_at', v_expires),
    v_reason);
  return jsonb_build_object('id', v_row.id);
end;
$$;

create function public.platform_remove_override(p_override_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.manage');
  v_row public.restaurant_overrides;
begin
  delete from public.restaurant_overrides o where o.id = p_override_id returning * into v_row;
  if v_row.id is null then
    perform private.fail('OVERRIDE_NOT_FOUND');
  end if;
  perform private.audit_platform(v_admin, v_row.restaurant_id, 'restaurant.override_removed',
    'restaurant_override', v_row.id,
    jsonb_build_object('kind', v_row.kind, 'feature', v_row.feature, 'value', v_row.value,
      'expires_at', v_row.expires_at),
    null);
end;
$$;

-- ─── The owner's checkout (service role: the Subscription page) ─────────────
-- The team's deal waiting for this restaurant (with the deal prices it pays
-- now and next), or an offer code's prices for each plan and cycle. A deal from the team stands: codes are for everyone else.
create function public.subscription_offer_preview(p_restaurant_id uuid, p_code text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_team public.subscription_deals;
  v_offer public.offers;
  v_refusal text;
begin
  select * into v_team from public.subscription_deals d
  where d.restaurant_id = p_restaurant_id and d.ended_at is null and d.created_by is not null;
  if p_code is null then
    -- Also the deal prices the restaurant pays now and its next autopay will.
    return jsonb_build_object(
      'deal', case when v_team.id is not null then jsonb_build_object(
        'plan_code', (select p.code from public.plans p where p.id = v_team.plan_id),
        'billing_cycle', v_team.billing_cycle,
        'list_price_paise', v_team.list_price_paise,
        'price_paise', v_team.price_paise,
        'cycles', v_team.cycles
      ) end,
      'current_price_paise', (
        select d.price_paise from public.restaurant_subscriptions s
        join public.subscription_deals d on d.id = s.deal_id
        where s.restaurant_id = p_restaurant_id
      ),
      'next_price_paise', (
        select d.price_paise from public.restaurant_subscriptions s
        join public.subscription_deals d on d.id = s.next_deal_id
        where s.restaurant_id = p_restaurant_id
      )
    );
  end if;
  if v_team.id is not null then
    perform private.fail('DEAL_SET_BY_TEAM');
  end if;
  select * into v_offer from public.offers o where o.code = upper(btrim(p_code));
  if v_offer.id is null then
    perform private.fail('OFFER_NOT_FOUND');
  end if;
  v_refusal := private.offer_refusal(v_offer, p_restaurant_id);
  if v_refusal is not null then
    perform private.fail(v_refusal);
  end if;
  return jsonb_build_object(
    'code', v_offer.code,
    'description', v_offer.description,
    'cycles', v_offer.duration_cycles,
    'prices', coalesce((
      select jsonb_agg(jsonb_build_object('plan_code', p.code, 'billing_cycle', c.cycle,
        'price_paise', x.price) order by p.sort_order, c.cycle)
      from public.plans p
      cross join unnest(array['monthly', 'yearly']::public.billing_cycle[]) as c (cycle)
      cross join lateral (select private.offer_price_paise(v_offer, p, c.cycle) as price) as x
      where p.is_active and x.price is not null
    ), '[]'::jsonb)
  );
end;
$$;

-- The deal a checkout uses: the team's for this plan and cycle, or one made
-- now from an offer code (holding its place for a day). Null: the list price.
create function public.subscription_checkout_deal(
  p_restaurant_id uuid, p_plan_code text, p_cycle text, p_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan public.plans;
  v_cycle public.billing_cycle;
  v_open public.subscription_deals;
  v_offer public.offers;
  v_refusal text;
  v_price bigint;
  v_deal public.subscription_deals;
begin
  select * into v_plan from public.plans p where p.code = p_plan_code;
  if v_plan.id is null then
    perform private.fail('PLAN_NOT_FOUND');
  end if;
  if p_cycle is null or p_cycle not in ('monthly', 'yearly') then
    perform private.fail('INVALID_INPUT', 'billing_cycle');
  end if;
  v_cycle := p_cycle::public.billing_cycle;
  -- One checkout at a time per restaurant.
  perform 1 from public.restaurant_subscriptions s where s.restaurant_id = p_restaurant_id for update;
  if not found then
    perform private.fail('SUBSCRIPTION_NOT_FOUND');
  end if;
  select * into v_open from public.subscription_deals d
  where d.restaurant_id = p_restaurant_id and d.ended_at is null;

  if v_open.created_by is not null then
    if p_code is not null then
      perform private.fail('DEAL_SET_BY_TEAM');
    end if;
    if v_open.plan_id = v_plan.id and v_open.billing_cycle = v_cycle then
      v_deal := v_open;
    end if;
  elsif p_code is not null then
    -- Locked, so two checkouts can't both take the last place.
    select * into v_offer from public.offers o where o.code = upper(btrim(p_code)) for update;
    if v_offer.id is null then
      perform private.fail('OFFER_NOT_FOUND');
    end if;
    v_refusal := private.offer_refusal(v_offer, p_restaurant_id);
    if v_refusal is not null then
      perform private.fail(v_refusal);
    end if;
    v_price := private.offer_price_paise(v_offer, v_plan, v_cycle);
    if v_price is null then
      perform private.fail('OFFER_NOT_FOR_PLAN');
    end if;
    if v_open.id is not null and v_open.offer_id = v_offer.id and v_open.plan_id = v_plan.id
       and v_open.billing_cycle = v_cycle and v_open.price_paise = v_price then
      v_deal := v_open;
    else
      update public.subscription_deals d set ended_at = now() where d.id = v_open.id;
      insert into public.subscription_deals (restaurant_id, offer_id, plan_id, billing_cycle,
        list_price_paise, price_paise, cycles, razorpay_plan_id)
      values (p_restaurant_id, v_offer.id, v_plan.id, v_cycle,
        private.cycle_price_paise(v_plan, v_cycle), v_price, v_offer.duration_cycles,
        (select d.razorpay_plan_id from public.subscription_deals d
         where d.plan_id = v_plan.id and d.billing_cycle = v_cycle and d.price_paise = v_price
           and d.razorpay_plan_id is not null
         limit 1))
      returning * into v_deal;
    end if;
  end if;

  if v_deal.id is null then
    return null;
  end if;
  return jsonb_build_object(
    'deal_id', v_deal.id,
    'price_paise', v_deal.price_paise,
    'list_price_paise', v_deal.list_price_paise,
    'cycles', v_deal.cycles,
    'razorpay_plan_id', v_deal.razorpay_plan_id
  );
end;
$$;

-- The Razorpay plan made for a deal's price.
create function public.subscription_deal_plan(p_deal_id uuid, p_razorpay_plan_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_razorpay_plan_id is null or p_razorpay_plan_id !~ '^plan_[A-Za-z0-9]{1,40}$' then
    perform private.fail('INVALID_INPUT', 'razorpay_plan_id');
  end if;
  update public.subscription_deals d set razorpay_plan_id = p_razorpay_plan_id
  where d.id = p_deal_id and d.razorpay_plan_id is null;
end;
$$;

-- ─── Reminders: an autopay that finished its charges ────────────────────────
-- An offer's cycles end: a week and a day before the paid period does, the
-- owner is asked to set up autopay at the full price (SA-78).
drop function public.subscription_reminders_due(timestamptz);
create function public.subscription_reminders_due(p_at timestamptz default now())
returns table (
  restaurant_id uuid, restaurant_name text, timezone text, kind text, due_key date,
  recipients text[], plan_name text, trial_ends_at timestamptz, restriction_at timestamptz,
  ends_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  with subs as (
    select
      r.id, r.name, r.slug, r.email, r.timezone,
      s.status, s.trial_ends_at, s.razorpay_status, s.cancel_at_period_end, s.current_period_end,
      p.name as plan_name,
      private.razorpay_managed(s) as autopay,
      a.state, a.restriction_at
    from public.restaurants r
    join public.restaurant_subscriptions s on s.restaurant_id = r.id
    join public.plans p on p.id = s.plan_id
    cross join lateral private.restaurant_access(r.id, p_at) as a
    where r.status = 'active'
  ),
  due as (
    select subs.*, 'trial_ends_3d'::text as kind, (subs.trial_ends_at at time zone subs.timezone)::date as due_key
    from subs
    where subs.status = 'trialing' and not subs.autopay
      and subs.trial_ends_at > p_at + interval '26 hours'
      and subs.trial_ends_at <= p_at + interval '3 days'
    union all
    select subs.*, 'trial_ends_1d', (subs.trial_ends_at at time zone subs.timezone)::date
    from subs
    where subs.status = 'trialing' and not subs.autopay
      and subs.trial_ends_at > p_at
      and subs.trial_ends_at <= p_at + interval '26 hours'
    union all
    select subs.*, 'payment_failed', (p_at at time zone subs.timezone)::date
    from subs
    where subs.status in ('past_due', 'halted') and subs.state = 'full'
    union all
    select subs.*, 'access_restricted', (subs.restriction_at at time zone subs.timezone)::date
    from subs
    where subs.state = 'read_only'
      and subs.restriction_at <= p_at
      and subs.restriction_at > p_at - interval '2 days'
    union all
    select subs.*, 'autopay_ends_7d', (subs.current_period_end at time zone subs.timezone)::date
    from subs
    where subs.status = 'active' and subs.razorpay_status = 'completed' and subs.cancel_at_period_end
      and subs.current_period_end > p_at + interval '26 hours'
      and subs.current_period_end <= p_at + interval '7 days'
    union all
    select subs.*, 'autopay_ends_1d', (subs.current_period_end at time zone subs.timezone)::date
    from subs
    where subs.status = 'active' and subs.razorpay_status = 'completed' and subs.cancel_at_period_end
      and subs.current_period_end > p_at
      and subs.current_period_end <= p_at + interval '26 hours'
  )
  select
    due.id, due.name, due.timezone, due.kind, due.due_key, rcpt.emails,
    due.plan_name, due.trial_ends_at, due.restriction_at, due.current_period_end
  from due
  cross join lateral (
    select array_agg(distinct lower(e.email) order by lower(e.email)) as emails
    from (
      select u.email
      from public.restaurant_members m
      join auth.users u on u.id = m.user_id
      where m.restaurant_id = due.id and m.role = 'owner' and m.is_active
        and split_part(u.email, '@', 2) not like due.slug || '.staff.%'
      union all
      select due.email
    ) as e
    where nullif(btrim(e.email), '') is not null
  ) as rcpt
  where rcpt.emails is not null
    and not exists (
      select 1 from public.subscription_reminders sr
      where sr.restaurant_id = due.id and sr.kind = due.kind and sr.due_key = due.due_key
    )
  order by due.name, due.kind;
$$;

-- ─── Grants ─────────────────────────────────────────────────────────────────
revoke execute on function private.deal_monthly_paise(public.subscription_deals) from public, anon, authenticated;
revoke execute on function private.deal_json(uuid, boolean) from public, anon, authenticated;
revoke execute on function private.sync_subscription_deal() from public, anon, authenticated;
revoke execute on function private.effective_plan(uuid) from public, anon, authenticated;
revoke execute on function private.restaurant_mrr_paise(text, public.plans, public.billing_cycle, bigint)
  from public, anon, authenticated;
revoke execute on function private.offer_refusal(public.offers, uuid) from public, anon, authenticated;
revoke execute on function private.offer_price_paise(public.offers, public.plans, public.billing_cycle)
  from public, anon, authenticated;
revoke execute on function public.platform_list_offers() from public, anon;
grant execute on function public.platform_list_offers() to authenticated;
revoke execute on function public.platform_save_offer(jsonb, uuid) from public, anon;
grant execute on function public.platform_save_offer(jsonb, uuid) to authenticated;
revoke execute on function public.platform_set_deal(uuid, jsonb) from public, anon;
grant execute on function public.platform_set_deal(uuid, jsonb) to authenticated;
revoke execute on function public.platform_set_override(uuid, jsonb) from public, anon;
grant execute on function public.platform_set_override(uuid, jsonb) to authenticated;
revoke execute on function public.platform_remove_override(uuid) from public, anon;
grant execute on function public.platform_remove_override(uuid) to authenticated;
revoke execute on function public.subscription_offer_preview(uuid, text) from public, anon, authenticated;
grant execute on function public.subscription_offer_preview(uuid, text) to service_role;
revoke execute on function public.subscription_checkout_deal(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.subscription_checkout_deal(uuid, text, text, text) to service_role;
revoke execute on function public.subscription_deal_plan(uuid, text) from public, anon, authenticated;
grant execute on function public.subscription_deal_plan(uuid, text) to service_role;
revoke execute on function public.subscription_reminders_due(timestamptz) from public, anon, authenticated;
grant execute on function public.subscription_reminders_due(timestamptz) to service_role;
