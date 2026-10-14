-- Stop 12d (docs/SUPER_ADMIN_PLAN.md 12d, docs/DECISIONS.md SA-22 to SA-26):
-- restaurant health, the restaurants list rebuilt, saved views and search.

-- ─── Health (plan §5.11) ────────────────────────────────────────────────────
alter table public.platform_settings
  add column health_setup_days int not null default 14
    check (health_setup_days between 1 and 90),
  add column health_inactive_days int not null default 7
    check (health_inactive_days between 1 and 60),
  add column health_slowing_percent int not null default 50
    check (health_slowing_percent between 1 and 99),
  add column health_slowing_min_orders int not null default 10
    check (health_slowing_min_orders between 1 and 10000);

-- A restaurant's health at p_at, first match wins, from accepted orders:
-- setting_up (new, no order yet), never_started (no order after the setup
-- days), inactive (no order in the inactive days), slowing (the last 7 days
-- below a share of the weekly average of the 4 weeks before, when those had
-- enough orders), active. Thresholds are platform settings (SA-22).
create function private.restaurant_health(
  p_restaurant_id uuid,
  p_created_at timestamptz,
  p_at timestamptz default now()
)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when not exists (
      select 1 from public.orders x
      where x.restaurant_id = p_restaurant_id and x.status = 'accepted' and x.created_at < p_at
    ) then
      case when p_created_at > p_at - make_interval(days => s.health_setup_days)
        then 'setting_up' else 'never_started' end
    when not exists (
      select 1 from public.orders x
      where x.restaurant_id = p_restaurant_id and x.status = 'accepted'
        and x.created_at >= p_at - make_interval(days => s.health_inactive_days)
        and x.created_at < p_at
    ) then 'inactive'
    when c.prior >= s.health_slowing_min_orders
      and c.last7 * 4 * 100 < c.prior * s.health_slowing_percent then 'slowing'
    else 'active'
  end
  from public.platform_settings s
  cross join lateral (
    select
      count(*) filter (where x.created_at >= p_at - interval '7 days') as last7,
      count(*) filter (where x.created_at < p_at - interval '7 days') as prior
    from public.orders x
    where x.restaurant_id = p_restaurant_id and x.status = 'accepted'
      and x.created_at >= p_at - interval '35 days' and x.created_at < p_at
  ) as c
  where s.id = 1;
$$;
revoke execute on function private.restaurant_health(uuid, timestamptz, timestamptz)
  from public, anon, authenticated;

-- The latest sign of life (plan §5.12): an accepted order, a bill, or a
-- sign-in by any of the restaurant's logins.
create function private.restaurant_last_active(p_restaurant_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(
    (select max(o.created_at) from public.orders o
     where o.restaurant_id = p_restaurant_id and o.status = 'accepted'),
    (select max(b.generated_at) from public.bills b where b.restaurant_id = p_restaurant_id),
    (select max(u.last_sign_in_at) from public.restaurant_members m
     join auth.users u on u.id = m.user_id
     where m.restaurant_id = p_restaurant_id)
  );
$$;
revoke execute on function private.restaurant_last_active(uuid) from public, anon, authenticated;

create or replace function public.platform_update_settings(p_patch jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('settings.manage');
  v_patch jsonb := coalesce(p_patch, '{}'::jsonb);
  v_old public.platform_settings;
  v_new public.platform_settings;
  v_key text;
  v_before jsonb := '{}'::jsonb;
  v_after jsonb := '{}'::jsonb;
begin
  perform private.assert_keys(v_patch, array[
    'trial_days', 'grace_days', 'setup_fee_paise', 'setup_fee_discount_paise',
    'setup_fee_discount_ends_at', 'support_phone', 'support_email', 'health_setup_days',
    'health_inactive_days', 'health_slowing_percent', 'health_slowing_min_orders'
  ]);

  select * into v_old from public.platform_settings s where s.id = 1 for update;
  v_new := v_old;

  if v_patch ? 'trial_days' then
    v_new.trial_days := private.json_int(v_patch, 'trial_days');
    if v_new.trial_days not between 1 and 365 then
      perform private.fail('INVALID_INPUT', 'trial_days');
    end if;
  end if;
  if v_patch ? 'grace_days' then
    v_new.grace_days := private.json_int(v_patch, 'grace_days');
    if v_new.grace_days not between 0 and 90 then
      perform private.fail('INVALID_INPUT', 'grace_days');
    end if;
  end if;
  if v_patch ? 'setup_fee_paise' then
    v_new.setup_fee_paise := private.json_int(v_patch, 'setup_fee_paise');
    if v_new.setup_fee_paise not between 100 and 100000000 then
      perform private.fail('INVALID_INPUT', 'setup_fee_paise');
    end if;
  end if;
  if v_patch ? 'setup_fee_discount_paise' then
    v_new.setup_fee_discount_paise := private.json_int(v_patch, 'setup_fee_discount_paise');
  end if;
  -- On the merged row, so lowering only the fee can't leave the discount above it.
  if v_new.setup_fee_discount_paise < 0 or v_new.setup_fee_discount_paise >= v_new.setup_fee_paise then
    perform private.fail('INVALID_INPUT', 'setup_fee_discount_paise');
  end if;
  if v_patch ? 'setup_fee_discount_ends_at' then
    -- A past time is allowed: it ends the offer now (SA-5).
    begin
      v_new.setup_fee_discount_ends_at := private.json_text(v_patch, 'setup_fee_discount_ends_at')::timestamptz;
    exception when data_exception then
      perform private.fail('INVALID_INPUT', 'setup_fee_discount_ends_at');
    end;
    -- Not 'infinity' or a far-off year, which the screen could not show.
    if v_new.setup_fee_discount_ends_at not between '2000-01-01T00:00:00Z' and '2100-01-01T00:00:00Z' then
      perform private.fail('INVALID_INPUT', 'setup_fee_discount_ends_at');
    end if;
  end if;
  if v_patch ? 'support_phone' then
    v_new.support_phone := private.tidy_text(private.json_text(v_patch, 'support_phone'));
    if length(v_new.support_phone) > 20 then
      perform private.fail('INVALID_INPUT', 'support_phone');
    end if;
  end if;
  if v_patch ? 'support_email' then
    v_new.support_email := private.tidy_text(private.json_text(v_patch, 'support_email'));
    if length(v_new.support_email) > 254 or v_new.support_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      perform private.fail('INVALID_INPUT', 'support_email');
    end if;
  end if;

  if v_patch ? 'health_setup_days' then
    v_new.health_setup_days := private.json_int(v_patch, 'health_setup_days');
    if v_new.health_setup_days not between 1 and 90 then
      perform private.fail('INVALID_INPUT', 'health_setup_days');
    end if;
  end if;
  if v_patch ? 'health_inactive_days' then
    v_new.health_inactive_days := private.json_int(v_patch, 'health_inactive_days');
    if v_new.health_inactive_days not between 1 and 60 then
      perform private.fail('INVALID_INPUT', 'health_inactive_days');
    end if;
  end if;
  if v_patch ? 'health_slowing_percent' then
    v_new.health_slowing_percent := private.json_int(v_patch, 'health_slowing_percent');
    if v_new.health_slowing_percent not between 1 and 99 then
      perform private.fail('INVALID_INPUT', 'health_slowing_percent');
    end if;
  end if;
  if v_patch ? 'health_slowing_min_orders' then
    v_new.health_slowing_min_orders := private.json_int(v_patch, 'health_slowing_min_orders');
    if v_new.health_slowing_min_orders not between 1 and 10000 then
      perform private.fail('INVALID_INPUT', 'health_slowing_min_orders');
    end if;
  end if;

  update public.platform_settings s
    set trial_days = v_new.trial_days,
        grace_days = v_new.grace_days,
        setup_fee_paise = v_new.setup_fee_paise,
        setup_fee_discount_paise = v_new.setup_fee_discount_paise,
        setup_fee_discount_ends_at = v_new.setup_fee_discount_ends_at,
        support_phone = v_new.support_phone,
        support_email = v_new.support_email,
        health_setup_days = v_new.health_setup_days,
        health_inactive_days = v_new.health_inactive_days,
        health_slowing_percent = v_new.health_slowing_percent,
        health_slowing_min_orders = v_new.health_slowing_min_orders
    where s.id = 1
    returning * into v_new;

  -- Audit only what changed.
  for v_key in select jsonb_object_keys(v_patch) loop
    if (to_jsonb(v_old) -> v_key) is distinct from (to_jsonb(v_new) -> v_key) then
      v_before := v_before || jsonb_build_object(v_key, to_jsonb(v_old) -> v_key);
      v_after := v_after || jsonb_build_object(v_key, to_jsonb(v_new) -> v_key);
    end if;
  end loop;
  if v_after <> '{}'::jsonb then
    perform private.audit_platform(
      v_admin, null, 'platform_settings.updated', 'platform_settings', null, v_before, v_after
    );
  end if;

  return to_jsonb(v_new) - 'id' - 'created_at' - 'updated_at';
end;
$$;

create or replace function public.platform_metrics_snapshot(p_day date default null)
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
begin
  insert into public.metrics_subscription_daily (
    day, restaurant_id, state, plan_id, billing_cycle, source, mrr_paise,
    cancel_at_period_end, autopay, trial_ends_at, current_period_end, grace_until, health
  )
  select
    v_day, r.id, st.state, s.plan_id, s.billing_cycle, s.source,
    private.restaurant_mrr_paise(st.state, p, s.billing_cycle),
    coalesce(s.cancel_at_period_end, false), coalesce(private.razorpay_managed(s), false),
    s.trial_ends_at, s.current_period_end, s.grace_until,
    private.restaurant_health(r.id, r.created_at, least(now(), v_to))
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
$$;

-- ─── Restaurants list (plan 12d) ────────────────────────────────────────────
-- Filters: q (name, code or city), state (plan §5.1), plan (code), health,
-- city, region (Indian state), channel (acquisition channel, or 'unknown'),
-- from/to (created, India dates), paid_from/paid_to (paid or trial till,
-- India dates), sort (created | name | last_active | paid_till | gmv), dir
-- (asc | desc), page; export: true returns up to 10,000 rows on one page.
-- Health, last active and GMV are worked out for every match only when a
-- filter or the sort needs them, otherwise for the page's rows.
create or replace function public.platform_list_restaurants(p_filters jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_q text;
  v_state text;
  v_plan text;
  v_health text;
  v_city text;
  v_region text;
  v_channel text;
  v_from date;
  v_to date;
  v_paid_from date;
  v_paid_to date;
  v_sort text;
  v_dir text;
  v_page int;
  v_page_size int := 50;
  v_total bigint;
  v_rows jsonb;
  v_cities jsonb;
  v_regions jsonb;
begin
  perform private.require_platform_permission('restaurants.view');
  perform private.assert_keys(v_filters, array[
    'q', 'state', 'plan', 'health', 'city', 'region', 'channel', 'from', 'to', 'paid_from',
    'paid_to', 'sort', 'dir', 'page', 'export'
  ]);
  v_q := nullif(btrim(coalesce(private.json_text(v_filters, 'q'), '')), '');
  v_state := private.json_text(v_filters, 'state');
  v_plan := private.json_text(v_filters, 'plan');
  v_health := private.json_text(v_filters, 'health');
  v_city := nullif(btrim(coalesce(private.json_text(v_filters, 'city'), '')), '');
  v_region := nullif(btrim(coalesce(private.json_text(v_filters, 'region'), '')), '');
  v_channel := private.json_text(v_filters, 'channel');
  v_from := private.json_date(v_filters, 'from');
  v_to := private.json_date(v_filters, 'to');
  v_paid_from := private.json_date(v_filters, 'paid_from');
  v_paid_to := private.json_date(v_filters, 'paid_to');
  v_sort := coalesce(private.json_text(v_filters, 'sort'), 'created');
  v_dir := coalesce(private.json_text(v_filters, 'dir'),
    case when v_sort = 'name' then 'asc' else 'desc' end);
  v_page := case
    when coalesce(jsonb_typeof(v_filters -> 'page'), 'null') = 'null' then 1
    else private.json_int(v_filters, 'page')
  end;

  if length(v_q) > 80 then
    perform private.fail('INVALID_INPUT', 'q');
  end if;
  if v_state is not null and v_state not in (
    'suspended', 'read_only', 'trial', 'payment_failed', 'paid', 'cancelled'
  ) then
    perform private.fail('INVALID_INPUT', 'state');
  end if;
  if v_health is not null and v_health not in (
    'setting_up', 'never_started', 'inactive', 'slowing', 'active'
  ) then
    perform private.fail('INVALID_INPUT', 'health');
  end if;
  if v_channel is not null and v_channel not in (
    'website', 'website_lead', 'field_visit', 'referral', 'phone', 'whatsapp', 'social', 'other',
    'unknown'
  ) then
    perform private.fail('INVALID_INPUT', 'channel');
  end if;
  if v_sort not in ('created', 'name', 'last_active', 'paid_till', 'gmv') then
    perform private.fail('INVALID_INPUT', 'sort');
  end if;
  if v_dir not in ('asc', 'desc') then
    perform private.fail('INVALID_INPUT', 'dir');
  end if;
  if v_page < 1 or v_page > 10000 then
    perform private.fail('INVALID_INPUT', 'page');
  end if;
  if v_from is not null and v_to is not null and v_to < v_from then
    perform private.fail('INVALID_INPUT', 'to');
  end if;
  if v_paid_from is not null and v_paid_to is not null and v_paid_to < v_paid_from then
    perform private.fail('INVALID_INPUT', 'paid_to');
  end if;
  if v_filters ? 'export' and private.json_bool(v_filters, 'export') then
    v_page := 1;
    v_page_size := 10000;
  end if;

  with base as (
    select
      r.id, r.name, r.slug, r.city, r.state as region, r.phone, r.status, r.created_at,
      r.acquisition_channel, r.timezone, r.business_day_start_hour,
      p.code as plan_code, p.name as plan_name,
      s.status as subscription_status, s.billing_cycle, s.source, s.trial_ends_at,
      s.current_period_end,
      case when s.status = 'trialing' then s.trial_ends_at else s.current_period_end end
        as paid_till,
      case when v_state is not null then (
        select private.subscription_state(r.status::text, a.state, s.status::text, s.source::text)
        from public.restaurant_access(r.id) as a
      ) end as state
    from public.restaurants r
    left join public.restaurant_subscriptions s on s.restaurant_id = r.id
    left join public.plans p on p.id = s.plan_id
    where (v_q is null
        or r.name ilike '%' || v_q || '%'
        or r.slug ilike '%' || v_q || '%'
        or r.city ilike '%' || v_q || '%')
      and (v_plan is null or p.code = v_plan)
      and (v_city is null or lower(r.city) = lower(v_city))
      and (v_region is null or lower(r.state) = lower(v_region))
      and (v_channel is null or coalesce(r.acquisition_channel, 'unknown') = v_channel)
      and (v_from is null or r.created_at >= v_from::timestamp at time zone 'Asia/Kolkata')
      and (v_to is null or r.created_at < (v_to + 1)::timestamp at time zone 'Asia/Kolkata')
      -- A paid period ends at the start of the day after its last day, so its
      -- last day is a day earlier (the list shows that day too).
      and (v_paid_from is null
        or (case when s.status = 'trialing' then s.trial_ends_at
            else s.current_period_end - interval '1 day' end)
          >= v_paid_from::timestamp at time zone 'Asia/Kolkata')
      and (v_paid_to is null
        or (case when s.status = 'trialing' then s.trial_ends_at
            else s.current_period_end - interval '1 day' end)
          < (v_paid_to + 1)::timestamp at time zone 'Asia/Kolkata')
  ),
  scored as (
    select
      b.*,
      case when v_health is not null then private.restaurant_health(b.id, b.created_at) end
        as health,
      case when v_sort = 'last_active' then private.restaurant_last_active(b.id) end
        as last_active,
      case when v_sort = 'gmv' then (
        select coalesce(sum(m.gmv_paise), 0)
        from public.metrics_usage_daily m
        where m.restaurant_id = b.id
          and m.business_day >= private.business_date(now(), b.timezone, b.business_day_start_hour) - 30
      ) end as gmv_30d
    from base b
    where v_state is null or b.state = v_state
  ),
  matching as (
    select sc.* from scored sc where v_health is null or sc.health = v_health
  ),
  page as (
    select m.*
    from matching m
    order by
      case when v_sort = 'name' and v_dir = 'asc' then lower(m.name) end asc,
      case when v_sort = 'name' and v_dir = 'desc' then lower(m.name) end desc,
      case when v_sort = 'last_active' and v_dir = 'asc' then m.last_active end asc nulls first,
      case when v_sort = 'last_active' and v_dir = 'desc' then m.last_active end desc nulls last,
      case when v_sort = 'paid_till' and v_dir = 'asc' then m.paid_till end asc nulls last,
      case when v_sort = 'paid_till' and v_dir = 'desc' then m.paid_till end desc nulls last,
      case when v_sort = 'gmv' and v_dir = 'asc' then m.gmv_30d end asc,
      case when v_sort = 'gmv' and v_dir = 'desc' then m.gmv_30d end desc,
      case when v_sort = 'created' and v_dir = 'asc' then m.created_at end asc,
      m.created_at desc,
      m.id
    limit v_page_size offset (v_page - 1) * v_page_size
  ),
  rows as (
    select
      pg.*,
      private.subscription_state(pg.status::text, a.state, pg.subscription_status::text,
        pg.source::text) as row_state,
      a.state as access_state,
      private.business_date(now(), pg.timezone, pg.business_day_start_hour) as today
    from page pg
    cross join lateral public.restaurant_access(pg.id) as a
  )
  select
    (select count(*) from matching),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'restaurant_id', x.id,
        'name', x.name,
        'slug', x.slug,
        'city', x.city,
        'region', x.region,
        'phone', x.phone,
        'status', x.status,
        'created_at', x.created_at,
        'acquisition_channel', x.acquisition_channel,
        'plan_code', x.plan_code,
        'plan_name', x.plan_name,
        'billing_cycle', x.billing_cycle,
        'subscription_status', x.subscription_status,
        'state', x.row_state,
        'access_state', x.access_state,
        'paid_till', x.paid_till,
        'health', coalesce(x.health, private.restaurant_health(x.id, x.created_at)),
        'last_active', coalesce(x.last_active, private.restaurant_last_active(x.id)),
        'gmv_30d_paise', coalesce(x.gmv_30d, (
          select coalesce(sum(m.gmv_paise), 0) from public.metrics_usage_daily m
          where m.restaurant_id = x.id and m.business_day >= x.today - 30
        )),
        'orders_7d', (
          select array_agg(coalesce(m.orders, 0) order by d.day)
          from generate_series(x.today - 7, x.today - 1, interval '1 day') as d(day)
          left join public.metrics_usage_daily m
            on m.restaurant_id = x.id and m.business_day = d.day::date
        ),
        'paid', (
          select jsonb_build_object(
            'subscription_paise', coalesce(sum(sp.base_paise) filter (where sp.purpose = 'subscription'), 0),
            'setup_fee_paise', coalesce(sum(sp.base_paise) filter (where sp.purpose = 'setup_fee'), 0),
            'gst_paise', coalesce(sum(sp.gst_paise), 0)
          )
          from public.subscription_payments sp
          where sp.restaurant_id = x.id
        )
      ) order by
        case when v_sort = 'name' and v_dir = 'asc' then lower(x.name) end asc,
        case when v_sort = 'name' and v_dir = 'desc' then lower(x.name) end desc,
        case when v_sort = 'last_active' and v_dir = 'asc' then x.last_active end asc nulls first,
        case when v_sort = 'last_active' and v_dir = 'desc' then x.last_active end desc nulls last,
        case when v_sort = 'paid_till' and v_dir = 'asc' then x.paid_till end asc nulls last,
        case when v_sort = 'paid_till' and v_dir = 'desc' then x.paid_till end desc nulls last,
        case when v_sort = 'gmv' and v_dir = 'asc' then x.gmv_30d end asc,
        case when v_sort = 'gmv' and v_dir = 'desc' then x.gmv_30d end desc,
        case when v_sort = 'created' and v_dir = 'asc' then x.created_at end asc,
        x.created_at desc,
        x.id)
      from rows x
    ), '[]'::jsonb)
  into v_total, v_rows;

  select
    coalesce((select jsonb_agg(c.city order by c.city) from (
      select distinct r.city from public.restaurants r where nullif(btrim(r.city), '') is not null
    ) as c), '[]'::jsonb),
    coalesce((select jsonb_agg(c.state order by c.state) from (
      select distinct r.state from public.restaurants r where nullif(btrim(r.state), '') is not null
    ) as c), '[]'::jsonb)
  into v_cities, v_regions;

  return jsonb_build_object(
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'rows', v_rows,
    'cities', v_cities,
    'regions', v_regions
  );
end;
$$;

-- ─── Saved views (plan 12d) ─────────────────────────────────────────────────
-- A named page query, the admin's own or shared with the team.
create table public.platform_saved_views (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  page text not null check (page in ('restaurants')),
  name text not null check (length(btrim(name)) between 1 and 60),
  -- A URL query without '?': key=value pairs as URLSearchParams writes them.
  query text not null
    check (length(query) <= 1000 and query ~ '^([a-z_]+=[^&#]*(&[a-z_]+=[^&#]*)*)?$'),
  shared boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index platform_saved_views_name_idx
  on public.platform_saved_views (owner_id, page, lower(name));

alter table public.platform_saved_views enable row level security;
revoke all on public.platform_saved_views from anon, authenticated;
grant select on public.platform_saved_views to authenticated;
create policy "platform admins read their own and shared views" on public.platform_saved_views
  for select to authenticated
  using ((select public.is_platform_admin()) and (owner_id = (select auth.uid()) or shared));

-- Saves a view under a name; the same name again replaces it.
create function public.platform_save_view(
  p_page text,
  p_name text,
  p_query text,
  p_shared boolean
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.view');
  v_name text := private.tidy_text(p_name);
  v_id uuid;
begin
  if p_page is null or p_page not in ('restaurants') then
    perform private.fail('INVALID_INPUT', 'page');
  end if;
  if v_name is null or length(v_name) > 60 then
    perform private.fail('INVALID_INPUT', 'name');
  end if;
  if p_query is null or length(p_query) > 1000
    or p_query !~ '^([a-z_]+=[^&#]*(&[a-z_]+=[^&#]*)*)?$' then
    perform private.fail('INVALID_INPUT', 'query');
  end if;
  insert into public.platform_saved_views (owner_id, page, name, query, shared)
  values (v_admin.user_id, p_page, v_name, p_query, coalesce(p_shared, false))
  on conflict (owner_id, page, lower(name)) do update
    set name = excluded.name, query = excluded.query, shared = excluded.shared
  returning id into v_id;
  return v_id;
end;
$$;

-- Deletes one of the admin's own views.
create function public.platform_delete_view(p_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.view');
begin
  delete from public.platform_saved_views v where v.id = p_id and v.owner_id = v_admin.user_id;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
end;
$$;

-- ─── Search (plan 12d) ──────────────────────────────────────────────────────
create index restaurants_name_trgm_idx
  on public.restaurants using gin (name extensions.gin_trgm_ops);

-- Restaurants by name, code, city, phone (any part of the digits, when the
-- text is a number: a GSTIN's digits aren't a phone), GSTIN, FSSAI number or
-- an owner's email; payments by Razorpay payment or
-- subscription ID; leads by name, phone or restaurant. Up to 8 restaurants
-- and 5 of the others, best matches first.
create function public.platform_search(p_q text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.view');
  v_q text := btrim(coalesce(p_q, ''));
  v_escaped text;
  v_like text;
  v_digits text;
  v_restaurants jsonb;
  v_payments jsonb;
  v_leads jsonb;
begin
  if length(v_q) < 2 or length(v_q) > 80 then
    return jsonb_build_object('restaurants', '[]'::jsonb, 'payments', '[]'::jsonb,
      'leads', '[]'::jsonb);
  end if;
  -- Typed text, not a pattern: % and _ match themselves.
  v_escaped := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');
  v_like := '%' || v_escaped || '%';
  v_digits := case
    when v_q ~ '^[0-9 +().-]+$' then nullif(regexp_replace(v_q, '\D', '', 'g'), '')
  end;
  if length(v_digits) < 3 then
    v_digits := null;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'restaurant_id', x.id, 'name', x.name, 'slug', x.slug, 'city', x.city, 'match', x.match
    ) order by x.rank, x.score desc, x.name), '[]'::jsonb)
  into v_restaurants
  from (
    select r.id, r.name, r.slug, r.city,
      case
        when r.name ilike v_like then null
        when r.slug ilike v_like then 'Code ' || r.slug
        when r.city ilike v_like then null
        when v_digits is not null and r.phone like '%' || v_digits || '%' then 'Phone ' || r.phone
        when r.gstin ilike v_like then 'GSTIN ' || r.gstin
        when v_digits is not null and r.fssai_license like '%' || v_digits || '%'
          then 'FSSAI ' || r.fssai_license
        else 'Owner ' || (
          select u.email from public.restaurant_members m
          join auth.users u on u.id = m.user_id
          where m.restaurant_id = r.id and m.role = 'owner' and u.email ilike v_like
          limit 1)
      end as match,
      case when lower(r.name) = lower(v_q) or lower(r.slug) = lower(v_q) then 0
        when r.name ilike v_escaped || '%' then 1 else 2 end as rank,
      extensions.similarity(r.name, v_q) as score
    from public.restaurants r
    where r.name ilike v_like or r.slug ilike v_like or r.city ilike v_like
      or r.gstin ilike v_like
      or (v_digits is not null and (r.phone like '%' || v_digits || '%'
        or r.fssai_license like '%' || v_digits || '%'))
      or exists (
        select 1 from public.restaurant_members m
        join auth.users u on u.id = m.user_id
        where m.restaurant_id = r.id and m.role = 'owner' and u.email ilike v_like
      )
    order by rank, score desc, r.name
    limit 8
  ) as x;

  select coalesce(jsonb_agg(jsonb_build_object(
      'restaurant_id', x.restaurant_id, 'name', x.name, 'kind', x.kind, 'ref', x.ref
    )), '[]'::jsonb)
  into v_payments
  from (
    select * from (
      select sp.restaurant_id, r.name, 'payment' as kind, sp.razorpay_payment_id as ref
      from public.subscription_payments sp
      join public.restaurants r on r.id = sp.restaurant_id
      where length(v_q) >= 4 and sp.razorpay_payment_id ilike v_like
      union all
      select s.restaurant_id, r.name, 'subscription', s.razorpay_subscription_id
      from public.restaurant_subscriptions s
      join public.restaurants r on r.id = s.restaurant_id
      where length(v_q) >= 4 and s.razorpay_subscription_id ilike v_like
    ) as y
    order by y.ref
    limit 5
  ) as x;

  select coalesce(jsonb_agg(jsonb_build_object(
      'lead_id', x.id, 'name', x.name, 'restaurant_name', x.restaurant_name, 'phone', x.phone,
      'created_at', x.created_at
    ) order by x.created_at desc), '[]'::jsonb)
  into v_leads
  from (
    select l.id, l.name, l.restaurant_name, l.phone, l.created_at
    from public.site_leads l
    where l.name ilike v_like or l.restaurant_name ilike v_like
      or (v_digits is not null and l.phone like '%' || v_digits || '%')
    order by l.created_at desc
    limit 5
  ) as x;

  return jsonb_build_object('restaurants', v_restaurants, 'payments', v_payments,
    'leads', v_leads);
end;
$$;

revoke execute on function public.platform_save_view(text, text, text, boolean) from public, anon;
revoke execute on function public.platform_delete_view(uuid) from public, anon;
revoke execute on function public.platform_search(text) from public, anon;
grant execute on function public.platform_save_view(text, text, text, boolean) to authenticated;
grant execute on function public.platform_delete_view(uuid) to authenticated;
grant execute on function public.platform_search(text) to authenticated;
