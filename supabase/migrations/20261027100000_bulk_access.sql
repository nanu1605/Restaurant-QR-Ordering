-- The rest of the functions that read every restaurant's access read it
-- without the caller check (docs/DECISIONS.md SA-76). Each checks the platform
-- member once before the read, or runs only as the service role (the digest,
-- the nightly snapshot and the reminders). Lead detail reads one restaurant and
-- keeps the public check. Same results as before.

-- ─── Changed definitions ────────────────────────────────────────────────────
-- private.restaurant_access in place of the public one.

CREATE OR REPLACE FUNCTION private.mrr_days(p_open date)
 RETURNS TABLE(day date, restaurant_id uuid, state text, plan_id uuid, billing_cycle public.billing_cycle, mrr_paise bigint, before_state text, before_plan_id uuid, before_paise bigint, movement text)
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
      private.restaurant_mrr_paise(st.state, p, s.billing_cycle)
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
      'mrr_paise', coalesce(sum(private.restaurant_mrr_paise(st.state, p, s.billing_cycle)), 0),
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
        private.restaurant_mrr_paise(st.state, pl, s.billing_cycle) as mrr
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

CREATE OR REPLACE FUNCTION public.platform_list_restaurants(p_filters jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_q text;
  v_state text;
  v_plan text;
  v_health text;
  v_city text;
  v_region text;
  v_channel text;
  v_tag uuid;
  v_manager text;
  v_manager_id uuid;
  v_onboarding text;
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
  v_money boolean;
begin
  perform private.require_platform_permission('restaurants.view');
  v_money := private.has_platform_permission('money.view');
  perform private.assert_keys(v_filters, array[
    'q', 'state', 'plan', 'health', 'city', 'region', 'channel', 'from', 'to', 'paid_from',
    'paid_to', 'sort', 'dir', 'page', 'export', 'tag', 'manager', 'onboarding'
  ]);
  v_q := nullif(btrim(coalesce(private.json_text(v_filters, 'q'), '')), '');
  v_state := private.json_text(v_filters, 'state');
  v_plan := private.json_text(v_filters, 'plan');
  v_health := private.json_text(v_filters, 'health');
  v_city := nullif(btrim(coalesce(private.json_text(v_filters, 'city'), '')), '');
  v_region := nullif(btrim(coalesce(private.json_text(v_filters, 'region'), '')), '');
  v_channel := private.json_text(v_filters, 'channel');
  if coalesce(jsonb_typeof(v_filters -> 'tag'), 'null') <> 'null' then
    v_tag := private.json_uuid(v_filters, 'tag');
  end if;
  -- An account manager: 'me', 'none' (no one) or a team member's user id.
  v_manager := private.json_text(v_filters, 'manager');
  if v_manager = 'me' then
    v_manager_id := auth.uid();
  elsif v_manager is not null and v_manager <> 'none' then
    v_manager_id := private.json_uuid(v_filters, 'manager');
  end if;
  v_onboarding := private.json_text(v_filters, 'onboarding');
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
  if v_onboarding is not null and v_onboarding not in ('open', 'stuck', 'done') then
    perform private.fail('INVALID_INPUT', 'onboarding');
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
      am.user_id as account_manager_user_id,
      p.code as plan_code, p.name as plan_name,
      s.status as subscription_status, s.billing_cycle, s.source, s.trial_ends_at,
      s.current_period_end,
      case when s.status = 'trialing' then s.trial_ends_at else s.current_period_end end
        as paid_till,
      -- Sorted by the day shown: a paid period's last day is the day before it ends.
      case when s.status = 'trialing' then s.trial_ends_at
        else s.current_period_end - interval '1 day' end as paid_last,
      s.cancel_at_period_end,
      case when v_state is not null then (
        select private.subscription_state(r.status::text, a.state, s.status::text, s.source::text)
        from private.restaurant_access(r.id) as a
      ) end as state
    from public.restaurants r
    left join public.restaurant_subscriptions s on s.restaurant_id = r.id
    left join public.plans p on p.id = s.plan_id
    left join public.restaurant_account_managers am on am.restaurant_id = r.id
    where (v_q is null
        or r.name ilike '%' || v_q || '%'
        or r.slug ilike '%' || v_q || '%'
        or r.city ilike '%' || v_q || '%')
      and (v_plan is null or p.code = v_plan)
      and (v_city is null or lower(r.city) = lower(v_city))
      and (v_region is null or lower(r.state) = lower(v_region))
      and (v_channel is null or coalesce(r.acquisition_channel, 'unknown') = v_channel)
      and (v_tag is null or exists (
        select 1 from public.restaurant_tags rt where rt.restaurant_id = r.id and rt.tag_id = v_tag
      ))
      and (v_manager is null
        or (v_manager = 'none' and am.user_id is null)
        or am.user_id = v_manager_id)
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
  -- Materialized: the onboarding is read three times below, worked out once.
  scored as materialized (
    select
      b.*,
      case when v_health is not null then private.restaurant_health(b.id, b.created_at) end
        as health,
      case when v_sort = 'last_active' then private.restaurant_last_active(b.id) end
        as last_active,
      case when v_sort = 'gmv' then (
        select u.gmv_30d_paise
        from private.restaurant_recent_usage(b.id, b.timezone, b.business_day_start_hour) as u
      ) end as gmv_30d,
      ob.onboarding
    from base b
    -- Only when filtering by it: the page's rows get theirs below.
    left join private.restaurants_onboarding(
      case when v_onboarding is not null then array(select x.id from base x) end
    ) as ob on ob.restaurant_id = b.id
    where v_state is null or b.state = v_state
  ),
  matching as (
    select sc.* from scored sc
    where (v_health is null or sc.health = v_health)
      and (v_onboarding is null
        or (v_onboarding = 'open' and sc.onboarding ->> 'next' is not null)
        or (v_onboarding = 'stuck' and (sc.onboarding ->> 'stuck')::boolean)
        or (v_onboarding = 'done' and sc.onboarding ->> 'next' is null))
  ),
  page as (
    select m.*
    from matching m
    order by
      case when v_sort = 'name' and v_dir = 'asc' then lower(m.name) end asc,
      case when v_sort = 'name' and v_dir = 'desc' then lower(m.name) end desc,
      case when v_sort = 'last_active' and v_dir = 'asc' then m.last_active end asc nulls first,
      case when v_sort = 'last_active' and v_dir = 'desc' then m.last_active end desc nulls last,
      case when v_sort = 'paid_till' and v_dir = 'asc' then m.paid_last end asc nulls last,
      case when v_sort = 'paid_till' and v_dir = 'desc' then m.paid_last end desc nulls last,
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
      u.orders_7d,
      u.gmv_30d_paise as recent_gmv,
      coalesce(pg.onboarding, pob.onboarding) as row_onboarding
    from page pg
    cross join lateral private.restaurant_access(pg.id) as a
    cross join lateral private.restaurant_recent_usage(
      pg.id, pg.timezone, pg.business_day_start_hour
    ) as u
    -- The page's rows at once (a CSV is up to 10,000 of them).
    left join private.restaurants_onboarding(array(select p.id from page p)) as pob
      on pob.restaurant_id = pg.id
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
        'ending', coalesce(x.cancel_at_period_end, false),
        'health', coalesce(x.health, private.restaurant_health(x.id, x.created_at)),
        'last_active', coalesce(x.last_active, private.restaurant_last_active(x.id)),
        'gmv_30d_paise', coalesce(x.gmv_30d, x.recent_gmv),
        'orders_7d', to_jsonb(x.orders_7d),
        'onboarding', x.row_onboarding - 'steps',
        'tags', coalesce((
          select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'colour', t.colour)
            order by lower(t.name))
          from public.restaurant_tags rt
          join public.platform_tags t on t.id = rt.tag_id
          where rt.restaurant_id = x.id
        ), '[]'::jsonb),
        'account_manager', (
          select u.email from auth.users u where u.id = x.account_manager_user_id
        ),
        'paid', case when v_money then (
          select jsonb_build_object(
            'subscription_paise', coalesce(sum(sp.base_paise) filter (where sp.purpose = 'subscription'), 0),
            'setup_fee_paise', coalesce(sum(sp.base_paise) filter (where sp.purpose = 'setup_fee'), 0),
            'gst_paise', coalesce(sum(sp.gst_paise), 0)
          )
          from public.subscription_payments sp
          where sp.restaurant_id = x.id
        ) end
      ) order by
        case when v_sort = 'name' and v_dir = 'asc' then lower(x.name) end asc,
        case when v_sort = 'name' and v_dir = 'desc' then lower(x.name) end desc,
        case when v_sort = 'last_active' and v_dir = 'asc' then x.last_active end asc nulls first,
        case when v_sort = 'last_active' and v_dir = 'desc' then x.last_active end desc nulls last,
        case when v_sort = 'paid_till' and v_dir = 'asc' then x.paid_last end asc nulls last,
        case when v_sort = 'paid_till' and v_dir = 'desc' then x.paid_last end desc nulls last,
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
$function$;

CREATE OR REPLACE FUNCTION public.platform_list_subscriptions(p_filters jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.view');
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_state text;
  v_page int;
  v_page_size constant int := 50;
  v_total bigint;
  v_rows jsonb;
begin
  perform private.assert_keys(v_filters, array['state', 'page']);
  v_state := private.json_text(v_filters, 'state');
  v_page := case
    when coalesce(jsonb_typeof(v_filters -> 'page'), 'null') = 'null' then 1
    else private.json_int(v_filters, 'page')
  end;
  if v_state is not null and v_state not in (
    'suspended', 'read_only', 'trial', 'payment_failed', 'paid', 'cancelled'
  ) then
    perform private.fail('INVALID_INPUT', 'state');
  end if;
  if v_page < 1 or v_page > 10000 then
    perform private.fail('INVALID_INPUT', 'page');
  end if;

  with matching as (
    select
      r.id, r.name, r.slug, r.status as restaurant_status,
      p.name as plan_name, p.code as plan_code,
      s.billing_cycle, s.status, s.source, s.trial_ends_at, s.current_period_end,
      s.grace_until, s.cancel_at_period_end, a.state as access_state, st.state,
      st.state = 'paid' and private.renewal_kind(s) = 'ending' as ending,
      case when s.status = 'trialing' then s.trial_ends_at else s.current_period_end end as next_date
    from public.restaurant_subscriptions s
    join public.restaurants r on r.id = s.restaurant_id
    join public.plans p on p.id = s.plan_id
    cross join lateral private.restaurant_access(r.id) as a
    cross join lateral (
      select private.subscription_state(r.status::text, a.state, s.status::text, s.source::text)
        as state
    ) as st
    where v_state is null or st.state = v_state
  ),
  page as (
    select m.*
    from matching m
    order by m.state = 'payment_failed' desc, m.next_date nulls last, m.name, m.id
    limit v_page_size offset (v_page - 1) * v_page_size
  )
  select
    (select count(*) from matching),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'restaurant_id', pg.id,
        'name', pg.name,
        'slug', pg.slug,
        'restaurant_status', pg.restaurant_status,
        'plan_code', pg.plan_code,
        'plan_name', pg.plan_name,
        'billing_cycle', pg.billing_cycle,
        'status', pg.status,
        'source', pg.source,
        'trial_ends_at', pg.trial_ends_at,
        'current_period_end', pg.current_period_end,
        'grace_until', pg.grace_until,
        'cancel_at_period_end', pg.cancel_at_period_end,
        'access_state', pg.access_state,
        'state', pg.state,
        'ending', pg.ending
      ) order by pg.state = 'payment_failed' desc, pg.next_date nulls last, pg.name, pg.id)
      from page pg
    ), '[]'::jsonb)
  into v_total, v_rows;

  return jsonb_build_object('page', v_page, 'page_size', v_page_size, 'total', v_total, 'rows', v_rows);
end;
$function$;

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
    private.restaurant_mrr_paise(st.state, p, s.billing_cycle),
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
      select r.id, r.name, r.slug, r.city, r.phone, pl.max_tables, pl.max_staff, st.state
      from public.restaurants r
      join public.restaurant_subscriptions s on s.restaurant_id = r.id
      join public.plans pl on pl.id = s.plan_id and pl.code = 'starter'
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

CREATE OR REPLACE FUNCTION public.platform_usage_report(p_from date, p_to date, p_compare boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_start date;
  v_live public.metrics_usage_daily[];
  v_result jsonb;
  v_days jsonb;
  v_hours jsonb;
begin
  perform private.require_platform_permission('insights.view');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    perform private.fail('INVALID_INPUT', 'dates');
  end if;
  v_start := case when p_compare then p_from - (p_to - p_from + 1) else p_from end;
  v_live := array(select l from private.metrics_usage_rows(v_start, p_to, null, true) as l);

  -- Materialized: each restaurant's today once, not once per stored day.
  with r as materialized (
    select
      x.id, x.name,
      nullif(btrim(x.city), '') as city,
      nullif(btrim(x.state), '') as region,
      p.code as plan_code, p.name as plan_name,
      private.business_date(now(), x.timezone, x.business_day_start_hour) as today,
      -- By business date, like the days counted: one opened at 1 am belongs to the day before.
      private.business_date(x.created_at, x.timezone, x.business_day_start_hour) <= p_to as counted
    from public.restaurants x
    left join public.restaurant_subscriptions s on s.restaurant_id = x.id
    left join public.plans p on p.id = s.plan_id
  ),
  days as (
    select m.*
    from public.metrics_usage_daily m
    join r on r.id = m.restaurant_id
    where m.business_day between v_start and p_to and m.business_day <= r.today - 2
    union all
    select l.* from unnest(v_live) as l
  ),
  per as (
    select
      d.restaurant_id,
      coalesce(sum(d.orders) filter (where d.business_day >= p_from), 0) as orders,
      coalesce(sum(d.customer_orders) filter (where d.business_day >= p_from), 0) as customer_orders,
      coalesce(sum(d.staff_orders) filter (where d.business_day >= p_from), 0) as staff_orders,
      coalesce(sum(d.items) filter (where d.business_day >= p_from), 0) as items,
      coalesce(sum(d.bills) filter (where d.business_day >= p_from), 0) as bills,
      coalesce(sum(d.gmv_paise) filter (where d.business_day >= p_from), 0) as gmv_paise,
      coalesce(sum(d.discount_paise) filter (where d.business_day >= p_from), 0) as discount_paise,
      coalesce(sum(d.paid_cash_paise) filter (where d.business_day >= p_from), 0) as cash,
      coalesce(sum(d.paid_upi_paise) filter (where d.business_day >= p_from), 0) as upi,
      coalesce(sum(d.paid_card_paise) filter (where d.business_day >= p_from), 0) as card,
      coalesce(sum(d.paid_other_paise) filter (where d.business_day >= p_from), 0) as other,
      -- Table time: each day's average weighted by its bills (SA-62).
      coalesce(sum(d.avg_session_minutes * d.sessions_billed)
        filter (where d.business_day >= p_from), 0) as table_minutes,
      coalesce(sum(d.sessions_billed)
        filter (where d.business_day >= p_from and d.avg_session_minutes is not null), 0)
        as timed_bills,
      coalesce(sum(d.service_requests) filter (where d.business_day >= p_from), 0)
        as service_requests,
      coalesce(sum(d.waiter_bills) filter (where d.business_day >= p_from), 0) as waiter_bills,
      coalesce(sum(d.split_bills) filter (where d.business_day >= p_from), 0) as split_bills,
      coalesce(sum(d.addon_orders) filter (where d.business_day >= p_from), 0) as addon_orders,
      coalesce(sum(d.hindi_orders) filter (where d.business_day >= p_from), 0) as hindi_orders,
      coalesce(sum(d.orders) filter (where d.business_day < p_from), 0) as prev_orders,
      coalesce(sum(d.customer_orders) filter (where d.business_day < p_from), 0)
        as prev_customer_orders,
      coalesce(sum(d.staff_orders) filter (where d.business_day < p_from), 0) as prev_staff_orders,
      coalesce(sum(d.items) filter (where d.business_day < p_from), 0) as prev_items,
      coalesce(sum(d.bills) filter (where d.business_day < p_from), 0) as prev_bills,
      coalesce(sum(d.gmv_paise) filter (where d.business_day < p_from), 0) as prev_gmv_paise
    from days d
    group by d.restaurant_id
  ),
  listed as (
    select r.*, coalesce(p.orders, 0) as orders, coalesce(p.gmv_paise, 0) as gmv_paise
    from r
    left join per p on p.restaurant_id = r.id
    where r.counted
  ),
  ranked as (
    select p.restaurant_id as id, r.name, r.city, p.orders, p.gmv_paise
    from per p
    join r on r.id = p.restaurant_id
    where p.orders > 0 or p.gmv_paise > 0
  ),
  paid as (
    -- Active Paid restaurants: paid now and an accepted order in the dates.
    select private.restaurant_features(p.restaurant_id, p_from, p_to, jsonb_build_object(
      'waiter_bills', p.waiter_bills, 'split_bills', p.split_bills,
      'discount_paise', p.discount_paise, 'service_requests', p.service_requests,
      'addon_orders', p.addon_orders, 'hindi_orders', p.hindi_orders
    )) as used
    from per p
    join public.restaurants x on x.id = p.restaurant_id
    left join public.restaurant_subscriptions s on s.restaurant_id = x.id
    cross join lateral private.restaurant_access(x.id) as a
    where p.orders > 0
      and private.subscription_state(x.status::text, a.state, s.status::text, s.source::text) = 'paid'
  )
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'previous_from', case when p_compare then v_start end,
    'previous_to', case when p_compare then p_from - 1 end,
    'totals', (
      select jsonb_build_object(
        'restaurants', (select count(*) from r where r.counted),
        'active', count(*) filter (where p.orders > 0),
        'orders', coalesce(sum(p.orders), 0),
        'customer_orders', coalesce(sum(p.customer_orders), 0),
        'staff_orders', coalesce(sum(p.staff_orders), 0),
        'items', coalesce(sum(p.items), 0),
        'bills', coalesce(sum(p.bills), 0),
        'gmv_paise', coalesce(sum(p.gmv_paise), 0),
        'discount_paise', coalesce(sum(p.discount_paise), 0),
        'collected', jsonb_build_object(
          'cash', coalesce(sum(p.cash), 0), 'upi', coalesce(sum(p.upi), 0),
          'card', coalesce(sum(p.card), 0), 'other', coalesce(sum(p.other), 0)
        ),
        'table_minutes', case when sum(p.timed_bills) > 0
          then round(sum(p.table_minutes) / sum(p.timed_bills)) end,
        'service_requests', coalesce(sum(p.service_requests), 0)
      )
      from per p
    ),
    'previous', case when p_compare then (
      select jsonb_build_object(
        'active', count(*) filter (where p.prev_orders > 0),
        'orders', coalesce(sum(p.prev_orders), 0),
        'customer_orders', coalesce(sum(p.prev_customer_orders), 0),
        'staff_orders', coalesce(sum(p.prev_staff_orders), 0),
        'items', coalesce(sum(p.prev_items), 0),
        'bills', coalesce(sum(p.prev_bills), 0),
        'gmv_paise', coalesce(sum(p.prev_gmv_paise), 0)
      )
      from per p
    ) end,
    'by_city', (
      select coalesce(jsonb_agg(g order by g.gmv_paise desc, g.restaurants desc), '[]'::jsonb)
      from (
        select
          mode() within group (order by l.city) as name, count(*) as restaurants,
          count(*) filter (where l.orders > 0) as active,
          sum(l.orders) as orders, sum(l.gmv_paise) as gmv_paise
        from listed l
        group by lower(l.city)
      ) as g
    ),
    'by_state', (
      select coalesce(jsonb_agg(g order by g.gmv_paise desc, g.restaurants desc), '[]'::jsonb)
      from (
        select
          mode() within group (order by l.region) as name, count(*) as restaurants,
          count(*) filter (where l.orders > 0) as active,
          sum(l.orders) as orders, sum(l.gmv_paise) as gmv_paise
        from listed l
        group by lower(l.region)
      ) as g
    ),
    'by_plan', (
      select coalesce(jsonb_agg(g order by g.gmv_paise desc, g.restaurants desc), '[]'::jsonb)
      from (
        select
          l.plan_code as code, l.plan_name as name, count(*) as restaurants,
          count(*) filter (where l.orders > 0) as active,
          sum(l.orders) as orders, sum(l.gmv_paise) as gmv_paise
        from listed l
        group by l.plan_code, l.plan_name
      ) as g
    ),
    'top_gmv', (
      select coalesce(jsonb_agg(t order by t.gmv_paise desc, t.name, t.id), '[]'::jsonb)
      from (
        select * from ranked where gmv_paise > 0 order by gmv_paise desc, name, id limit 10
      ) as t
    ),
    'bottom_gmv', (
      select coalesce(jsonb_agg(t order by t.gmv_paise, t.name, t.id), '[]'::jsonb)
      from (
        select * from ranked where orders > 0 order by gmv_paise, name, id limit 10
      ) as t
    ),
    'top_orders', (
      select coalesce(jsonb_agg(t order by t.orders desc, t.name, t.id), '[]'::jsonb)
      from (
        select * from ranked where orders > 0 order by orders desc, name, id limit 10
      ) as t
    ),
    'bottom_orders', (
      select coalesce(jsonb_agg(t order by t.orders, t.name, t.id), '[]'::jsonb)
      from (
        select * from ranked where orders > 0 order by orders, name, id limit 10
      ) as t
    ),
    'features', jsonb_build_object(
      'restaurants', (select count(*) from paid),
      'used', (
        select coalesce(jsonb_object_agg(f.key, f.n), '{}'::jsonb)
        from (
          select e.key, count(*) filter (where e.value = 'true'::jsonb) as n
          from paid
          cross join lateral jsonb_each(paid.used) as e
          group by e.key
        ) as f
      )
    )
  )
  into v_result;

  -- GMV and orders by business day.
  select coalesce(jsonb_agg(jsonb_build_object(
    'day', x.day, 'gmv_paise', x.gmv_paise, 'orders', x.orders
  ) order by x.day), '[]'::jsonb)
  into v_days
  from (
    with stored as materialized (
      select x.id,
        private.business_date(now(), x.timezone, x.business_day_start_hour) - 2 as last_day
      from public.restaurants x
    )
    select d.business_day as day, sum(d.gmv_paise) as gmv_paise, sum(d.orders) as orders
    from (
      select m.business_day, m.gmv_paise, m.orders
      from public.metrics_usage_daily m
      join stored on stored.id = m.restaurant_id
      where m.business_day between p_from and p_to and m.business_day <= stored.last_day
      union all
      select l.business_day, l.gmv_paise, l.orders
      from unnest(v_live) as l
      where l.business_day >= p_from
    ) as d
    group by d.business_day
  ) as x;

  -- Accepted orders by the business day's weekday and the restaurant's clock
  -- hour (SA-62).
  select coalesce(jsonb_agg(jsonb_build_object(
    'weekday', x.weekday, 'hour', x.hour, 'orders', x.orders
  ) order by x.weekday, x.hour), '[]'::jsonb)
  into v_hours
  from (
    with stored as materialized (
      select x.id,
        private.business_date(now(), x.timezone, x.business_day_start_hour) - 2 as last_day
      from public.restaurants x
    )
    select extract(isodow from d.business_day)::int as weekday, (h.idx - 1)::int as hour,
      sum(h.n)::int as orders
    from (
      select m.business_day, m.hourly_orders
      from public.metrics_usage_daily m
      join stored on stored.id = m.restaurant_id
      where m.business_day between p_from and p_to and m.orders > 0
        and m.business_day <= stored.last_day
      union all
      select l.business_day, l.hourly_orders
      from unnest(v_live) as l
      where l.business_day >= p_from and l.orders > 0
    ) as d
    cross join lateral unnest(d.hourly_orders) with ordinality as h(n, idx)
    where h.n > 0
    group by 1, 2
  ) as x;

  return v_result || jsonb_build_object('days', v_days, 'hours', v_hours);
end;
$function$;

CREATE OR REPLACE FUNCTION public.subscription_reminders_due(p_at timestamp with time zone DEFAULT now())
 RETURNS TABLE(restaurant_id uuid, restaurant_name text, timezone text, kind text, due_key date, recipients text[], plan_name text, trial_ends_at timestamp with time zone, restriction_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with subs as (
    select
      r.id, r.name, r.slug, r.email, r.timezone,
      s.status, s.trial_ends_at, p.name as plan_name,
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
  )
  select
    due.id, due.name, due.timezone, due.kind, due.due_key, rcpt.emails,
    due.plan_name, due.trial_ends_at, due.restriction_at
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
$function$;
