-- Super-admin reads (spec §13.4, docs/DECISIONS.md P7-7, P7-8): the platform
-- overview, the restaurants and subscriptions lists and one restaurant's
-- detail. Platform admins only (aal2, P7-1); read-only.

-- Orders per restaurant by time (last order, orders in 7/30 days) and across
-- the platform (orders in the last 24 hours). The existing index only covers
-- customer orders.
create index orders_restaurant_created_idx on public.orders (restaurant_id, created_at);
create index orders_created_idx on public.orders (created_at);
-- The platform audit log reads newest first across restaurants.
create index audit_logs_created_idx on public.audit_logs (created_at desc);

-- Monthly-equivalent price of a subscription's plan: yearly ÷ 12 (§13.4).
create or replace function private.monthly_paise(
  p_plan public.plans,
  p_cycle public.billing_cycle
)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select case
    when p_cycle = 'yearly' then round(p_plan.price_yearly_paise::numeric / 12)::bigint
    else p_plan.price_monthly_paise
  end;
$$;

revoke execute on function private.monthly_paise(public.plans, public.billing_cycle)
  from public, anon, authenticated;

-- Overview: restaurants by state, MRR, orders in the last 24 hours and trials
-- ending in the next 7 days. The states don't overlap: suspended first, then
-- read-only (lapsed), then the subscription status of restaurants with full
-- access.
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
  with states as (
    select
      case
        when r.status = 'suspended' then 'suspended'
        when a.state = 'read_only' then 'read_only'
        when s.status = 'trialing' then 'trialing'
        when s.status = 'active' then 'active'
        when s.status in ('past_due', 'halted') then 'past_due'
        else 'other'
      end as state
    from public.restaurants r
    left join public.restaurant_subscriptions s on s.restaurant_id = r.id
    cross join lateral public.restaurant_access(r.id) as a
  )
  select jsonb_build_object(
    'total', count(*),
    'trialing', count(*) filter (where state = 'trialing'),
    'active', count(*) filter (where state = 'active'),
    'past_due', count(*) filter (where state = 'past_due'),
    'read_only', count(*) filter (where state = 'read_only'),
    'suspended', count(*) filter (where state = 'suspended')
  )
  into v_counts
  from states;

  select coalesce(sum(private.monthly_paise(p, s.billing_cycle)), 0)
  into v_mrr
  from public.restaurant_subscriptions s
  join public.plans p on p.id = s.plan_id
  where s.status = 'active' and s.source is not null;

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
    'trials_ending', v_trials
  );
end;
$$;

-- Restaurants list. Filters: q (name, code or city), status, plan (code),
-- subscription (status), city, from/to (created, India time), sort
-- (created | name | last_order), page. 50 per page.
create or replace function public.platform_list_restaurants(p_filters jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.current_platform_admin();
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_q text;
  v_status text;
  v_plan text;
  v_subscription text;
  v_city text;
  v_from date;
  v_to date;
  v_sort text;
  v_page int;
  v_page_size constant int := 50;
  v_total bigint;
  v_rows jsonb;
  v_cities jsonb;
begin
  perform private.assert_keys(
    v_filters, array['q', 'status', 'plan', 'subscription', 'city', 'from', 'to', 'sort', 'page']
  );
  v_q := nullif(btrim(coalesce(private.json_text(v_filters, 'q'), '')), '');
  v_status := private.json_text(v_filters, 'status');
  v_plan := private.json_text(v_filters, 'plan');
  v_subscription := private.json_text(v_filters, 'subscription');
  v_city := nullif(btrim(coalesce(private.json_text(v_filters, 'city'), '')), '');
  v_from := private.json_date(v_filters, 'from');
  v_to := private.json_date(v_filters, 'to');
  v_sort := coalesce(private.json_text(v_filters, 'sort'), 'created');
  v_page := case
    when coalesce(jsonb_typeof(v_filters -> 'page'), 'null') = 'null' then 1
    else private.json_int(v_filters, 'page')
  end;

  if v_status is not null and v_status not in ('active', 'suspended') then
    perform private.fail('INVALID_INPUT', 'status');
  end if;
  if v_subscription is not null
    and v_subscription not in ('trialing', 'active', 'past_due', 'halted', 'cancelled', 'expired')
  then
    perform private.fail('INVALID_INPUT', 'subscription');
  end if;
  if v_sort not in ('created', 'name', 'last_order') then
    perform private.fail('INVALID_INPUT', 'sort');
  end if;
  if v_page < 1 or v_page > 10000 then
    perform private.fail('INVALID_INPUT', 'page');
  end if;
  if v_from is not null and v_to is not null and v_to < v_from then
    perform private.fail('INVALID_INPUT', 'to');
  end if;

  with matching as (
    select
      r.id, r.name, r.slug, r.city, r.status, r.created_at,
      p.code as plan_code, p.name as plan_name,
      s.status as subscription_status, s.trial_ends_at, s.current_period_end,
      (select max(o.created_at) from public.orders o where o.restaurant_id = r.id) as last_order_at
    from public.restaurants r
    left join public.restaurant_subscriptions s on s.restaurant_id = r.id
    left join public.plans p on p.id = s.plan_id
    where (v_q is null
        or r.name ilike '%' || v_q || '%'
        or r.slug ilike '%' || v_q || '%'
        or r.city ilike '%' || v_q || '%')
      and (v_status is null or r.status::text = v_status)
      and (v_plan is null or p.code = v_plan)
      and (v_subscription is null or s.status::text = v_subscription)
      and (v_city is null or lower(r.city) = lower(v_city))
      and (v_from is null or (r.created_at at time zone 'Asia/Kolkata')::date >= v_from)
      and (v_to is null or (r.created_at at time zone 'Asia/Kolkata')::date <= v_to)
  ),
  page as (
    select m.*
    from matching m
    order by
      case when v_sort = 'name' then lower(m.name) end,
      case when v_sort = 'last_order' then m.last_order_at end desc nulls last,
      m.created_at desc,
      m.id
    limit v_page_size offset (v_page - 1) * v_page_size
  )
  select
    (select count(*) from matching),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'restaurant_id', pg.id,
        'name', pg.name,
        'slug', pg.slug,
        'city', pg.city,
        'status', pg.status,
        'created_at', pg.created_at,
        'plan_code', pg.plan_code,
        'plan_name', pg.plan_name,
        'subscription_status', pg.subscription_status,
        'trial_ends_at', pg.trial_ends_at,
        'current_period_end', pg.current_period_end,
        'access_state', a.state,
        'last_order_at', pg.last_order_at
      ) order by
        case when v_sort = 'name' then lower(pg.name) end,
        case when v_sort = 'last_order' then pg.last_order_at end desc nulls last,
        pg.created_at desc,
        pg.id)
      from page pg
      cross join lateral public.restaurant_access(pg.id) as a
    ), '[]'::jsonb)
  into v_total, v_rows;

  select coalesce(jsonb_agg(c.city order by c.city), '[]'::jsonb)
  into v_cities
  from (
    select distinct r.city from public.restaurants r where nullif(btrim(r.city), '') is not null
  ) as c;

  return jsonb_build_object(
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'rows', v_rows,
    'cities', v_cities
  );
end;
$$;

-- Subscriptions list: payment problems first (past due, halted), then by the
-- date that matters next. Filters: status, page. 50 per page.
create or replace function public.platform_list_subscriptions(p_filters jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.current_platform_admin();
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_status text;
  v_page int;
  v_page_size constant int := 50;
  v_total bigint;
  v_rows jsonb;
begin
  perform private.assert_keys(v_filters, array['status', 'page']);
  v_status := private.json_text(v_filters, 'status');
  v_page := case
    when coalesce(jsonb_typeof(v_filters -> 'page'), 'null') = 'null' then 1
    else private.json_int(v_filters, 'page')
  end;
  if v_status is not null
    and v_status not in ('trialing', 'active', 'past_due', 'halted', 'cancelled', 'expired')
  then
    perform private.fail('INVALID_INPUT', 'status');
  end if;
  if v_page < 1 or v_page > 10000 then
    perform private.fail('INVALID_INPUT', 'page');
  end if;

  with matching as (
    select
      r.id, r.name, r.slug, r.status as restaurant_status,
      p.name as plan_name, p.code as plan_code,
      s.billing_cycle, s.status, s.source, s.trial_ends_at, s.current_period_end,
      s.grace_until, s.cancel_at_period_end,
      case when s.status = 'trialing' then s.trial_ends_at else s.current_period_end end as next_date
    from public.restaurant_subscriptions s
    join public.restaurants r on r.id = s.restaurant_id
    join public.plans p on p.id = s.plan_id
    where v_status is null or s.status::text = v_status
  ),
  page as (
    select m.*
    from matching m
    order by (m.status in ('past_due', 'halted')) desc, m.next_date nulls last, m.name, m.id
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
        'access_state', a.state
      ) order by (pg.status in ('past_due', 'halted')) desc, pg.next_date nulls last, pg.name, pg.id)
      from page pg
      cross join lateral public.restaurant_access(pg.id) as a
    ), '[]'::jsonb)
  into v_total, v_rows;

  return jsonb_build_object('page', v_page, 'page_size', v_page_size, 'total', v_total, 'rows', v_rows);
end;
$$;

-- One restaurant: profile, owner logins, subscription and payments, access
-- state and usage (§13.4). Owner emails come from auth: a synthetic staff
-- address (<username>@<slug>.staff.<domain>) is flagged so the page doesn't
-- offer it as a contact.
create or replace function public.platform_get_restaurant(p_restaurant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.current_platform_admin();
  v_restaurant public.restaurants;
  v_owners jsonb;
  v_subscription jsonb;
  v_payments jsonb;
  v_access jsonb;
  v_usage jsonb;
begin
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
    'razorpay_subscription_id', s.razorpay_subscription_id
  )
  into v_subscription
  from public.restaurant_subscriptions s
  join public.plans p on p.id = s.plan_id
  where s.restaurant_id = p_restaurant_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'payment_id', sp.id,
    'source', sp.source,
    'amount_paise', sp.amount_paise,
    'manual_mode', sp.manual_mode,
    'period_start', sp.period_start,
    'period_end', sp.period_end,
    'notes', sp.notes,
    'created_at', sp.created_at
  ) order by sp.created_at desc), '[]'::jsonb)
  into v_payments
  from public.subscription_payments sp
  where sp.restaurant_id = p_restaurant_id;

  select jsonb_build_object(
    'state', a.state, 'reason', a.reason, 'restriction_at', a.restriction_at, 'warning', a.warning
  )
  into v_access
  from public.restaurant_access(p_restaurant_id) as a;

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
    'orders_7d', (
      select count(*) from public.orders o
      where o.restaurant_id = p_restaurant_id and o.created_at >= now() - interval '7 days'
    ),
    'orders_30d', (
      select count(*) from public.orders o
      where o.restaurant_id = p_restaurant_id and o.created_at >= now() - interval '30 days'
    ),
    'last_order_at', (
      select max(o.created_at) from public.orders o where o.restaurant_id = p_restaurant_id
    ),
    'bills', (
      select count(*) from public.bills b
      where b.restaurant_id = p_restaurant_id and b.status = 'active'
    ),
    'bills_30d', (
      select count(*) from public.bills b
      where b.restaurant_id = p_restaurant_id and b.status = 'active'
        and b.generated_at >= now() - interval '30 days'
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
      'status', v_restaurant.status,
      'suspended_reason', v_restaurant.suspended_reason,
      'created_at', v_restaurant.created_at
    ),
    'owners', v_owners,
    'subscription', v_subscription,
    'payments', v_payments,
    'access', v_access,
    'usage', v_usage
  );
end;
$$;

revoke execute on function public.platform_overview() from public, anon;
revoke execute on function public.platform_list_restaurants(jsonb) from public, anon;
revoke execute on function public.platform_list_subscriptions(jsonb) from public, anon;
revoke execute on function public.platform_get_restaurant(uuid) from public, anon;
grant execute on function public.platform_overview() to authenticated;
grant execute on function public.platform_list_restaurants(jsonb) to authenticated;
grant execute on function public.platform_list_subscriptions(jsonb) to authenticated;
grant execute on function public.platform_get_restaurant(uuid) to authenticated;
