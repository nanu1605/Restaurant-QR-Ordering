-- Super-admin redesign, stop 13a (docs/SUPER_ADMIN_PLAN.md 13a; docs/DECISIONS.md
-- SA-33 to SA-40): a restaurant's page with tabs, notes, tags and an account
-- manager, the facts each tab reads, notes in the activity stream, and tags and
-- account managers on the Restaurants list.

-- ─── Account manager, tags, notes ───────────────────────────────────────────
-- The MenuMesh team member who looks after a restaurant (SA-39), in a table of
-- its own: a column on restaurants would be read by the restaurant's staff.
create table public.restaurant_account_managers (
  restaurant_id uuid primary key references public.restaurants (id) on delete cascade,
  user_id uuid not null references public.platform_admins (user_id) on delete cascade,
  created_at timestamptz not null default now()
);
create index restaurant_account_managers_user_idx on public.restaurant_account_managers (user_id);

-- Tags the team puts on restaurants, each in one of a fixed set of colours
-- the page draws as a swatch beside ink text (SA-39).
create table public.platform_tags (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 30 and name = btrim(name)),
  colour text not null check (colour in ('orange', 'teal', 'amber', 'green', 'red', 'slate')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index platform_tags_name_idx on public.platform_tags (lower(name));

create table public.restaurant_tags (
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  tag_id uuid not null references public.platform_tags (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (restaurant_id, tag_id)
);
create index restaurant_tags_tag_idx on public.restaurant_tags (tag_id);

-- The team's notes on a restaurant. The restaurant never sees them (SA-38).
create table public.restaurant_notes (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  author_id uuid references auth.users (id) on delete set null,
  body text not null check (length(body) between 1 and 2000),
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  edited_at timestamptz
);
create index restaurant_notes_restaurant_idx on public.restaurant_notes (restaurant_id, created_at desc);
create index restaurant_notes_created_idx on public.restaurant_notes (created_at desc);

alter table public.platform_tags enable row level security;
alter table public.restaurant_tags enable row level security;
alter table public.restaurant_notes enable row level security;
alter table public.restaurant_account_managers enable row level security;
revoke all on public.platform_tags, public.restaurant_tags, public.restaurant_notes,
  public.restaurant_account_managers from anon, authenticated;
grant select on public.platform_tags, public.restaurant_tags, public.restaurant_notes,
  public.restaurant_account_managers to authenticated;
create policy "platform admins read tags" on public.platform_tags
  for select to authenticated using ((select public.is_platform_admin()));
create policy "platform admins read restaurant tags" on public.restaurant_tags
  for select to authenticated using ((select public.is_platform_admin()));
create policy "platform admins read restaurant notes" on public.restaurant_notes
  for select to authenticated using ((select public.is_platform_admin()));
create policy "platform admins read account managers" on public.restaurant_account_managers
  for select to authenticated using ((select public.is_platform_admin()));

-- The audit rows of notes, tags and account managers name the restaurant, so
-- the team finds them by restaurant; its owner and managers, who read their
-- restaurant's audit log, don't see them (SA-40).
drop policy "managers and platform admins read audit logs" on public.audit_logs;
create policy "managers and platform admins read audit logs" on public.audit_logs
  for select to authenticated
  using (
    (restaurant_id in (select private.my_restaurant_ids('{owner,manager}'))
      and coalesce(entity_type, '') not in ('restaurant_note', 'restaurant_tags', 'account_manager'))
    or (select public.is_platform_admin())
  );

-- ─── Usage, one restaurant or all ───────────────────────────────────────────
-- private.platform_usage (12e) gains a restaurant and the counts a restaurant's
-- page shows; the live last finished day and today are still counted here only
-- (SA-35).
drop function private.platform_usage(date, date);
create function private.platform_usage(
  p_from date,
  p_to date,
  p_restaurant_id uuid default null
)
returns table (
  restaurant_id uuid,
  business_day date,
  today boolean,
  orders bigint,
  customer_orders bigint,
  staff_orders bigint,
  bills bigint,
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
    where p_restaurant_id is null or x.id = p_restaurant_id
  )
  select
    m.restaurant_id, m.business_day, false, m.orders::bigint, m.customer_orders::bigint,
    m.staff_orders::bigint, m.bills::bigint, m.gmv_paise
  from public.metrics_usage_daily m
  join r on r.id = m.restaurant_id
  where m.business_day between p_from and p_to
    and m.business_day <= r.today - 2
  union all
  select
    r.id, d.day::date, d.day::date = r.today, lo.orders, lo.customer_orders, lo.staff_orders,
    lb.bills, lb.gmv
  from r
  cross join lateral generate_series(
    greatest(p_from, r.today - 1), least(p_to, r.today), interval '1 day'
  ) as d(day)
  cross join lateral private.business_day_bounds(d.day::date, d.day::date, r.tz, r.h) as b
  cross join lateral (
    select
      count(*) as orders,
      count(*) filter (where o.placed_via = 'customer') as customer_orders,
      count(*) filter (where o.placed_via = 'staff') as staff_orders
    from public.orders o
    where o.restaurant_id = r.id and o.status = 'accepted'
      and o.created_at >= b.starts_at and o.created_at < b.ends_at
  ) as lo
  cross join lateral (
    select count(*) as bills, coalesce(sum(bl.grand_total_paise), 0)::bigint as gmv
    from public.bills bl
    where bl.restaurant_id = r.id and bl.status = 'active'
      and bl.generated_at >= b.starts_at and bl.generated_at < b.ends_at
  ) as lb;
$$;

revoke execute on function private.platform_usage(date, date, uuid)
  from public, anon, authenticated;

-- ─── Usage rebuild, one at a time ───────────────────────────────────────────
create or replace function private.metrics_usage_rebuild(
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
  -- One rebuild at a time: two at once (the nightly job run twice) would both
  -- delete the same days, then both insert them.
  perform pg_advisory_xact_lock(hashtextextended('metrics_usage_rebuild', 0));
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
        where p.restaurant_id = r.id and p.bill_id = b.id and not p.is_void
      ) as pay
      cross join lateral (
        select coalesce(sum(i.quantity), 0) as items
        from public.order_items i
        join public.orders o on o.restaurant_id = i.restaurant_id and o.id = i.order_id
        where i.restaurant_id = r.id
          and i.session_id = b.session_id
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
    placed_hours as (
      select pl.day, pl.hour, count(*)::int as n from placed pl group by pl.day, pl.hour
    ),
    order_days as (
      select
        pl.day,
        count(*)::int as orders,
        (count(*) filter (where pl.placed_via = 'customer'))::int as customer_orders,
        (count(*) filter (where pl.placed_via = 'staff'))::int as staff_orders,
        array(
          select coalesce((select h.n from placed_hours h where h.day = pl.day and h.hour = g), 0)
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

-- ─── The restaurant ─────────────────────────────────────────────────────────
-- The header and the facts every tab shares (SA-34): the list's state, health,
-- paid till and last active, tags, account manager, plan limits and the
-- cancellation reason. Payments carry the GST split, for money.view only.
-- Orders and bills over time come from platform_restaurant_overview, by
-- business day (SA-37).
create or replace function public.platform_get_restaurant(p_restaurant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
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
      'max_tables', p.max_tables,
      'max_staff', p.max_staff
    )
  into v_subscription
  from public.restaurant_subscriptions s
  join public.plans p on p.id = s.plan_id
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
    'money', v_money,
    'payments', v_payments,
    'access', v_access,
    'usage', v_usage
  );
end;
$$;

-- ─── Overview ───────────────────────────────────────────────────────────────
-- The last 90 business days the restaurant has finished, and the totals of
-- the last 30 (the same days as the list's GMV; SA-35). GMV is what diners
-- paid, taxes included.
create function public.platform_restaurant_overview(p_restaurant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_last date;
  v_result jsonb;
begin
  perform private.require_platform_permission('restaurants.view');
  select private.business_date(now(), r.timezone, r.business_day_start_hour) - 1
  into v_last
  from public.restaurants r where r.id = p_restaurant_id;
  if not found then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;

  with u as (
    select * from private.platform_usage(v_last - 89, v_last, p_restaurant_id)
  )
  select jsonb_build_object(
    'last_day', v_last,
    'days', (
      select jsonb_agg(jsonb_build_object(
        'day', g.day::date,
        'orders', coalesce(u.orders, 0),
        'gmv_paise', coalesce(u.gmv_paise, 0)
      ) order by g.day)
      from generate_series(v_last - 89, v_last, interval '1 day') as g(day)
      left join u on u.business_day = g.day::date
    ),
    'last_30', (
      select jsonb_build_object(
        'orders', coalesce(sum(u.orders), 0),
        'customer_orders', coalesce(sum(u.customer_orders), 0),
        'staff_orders', coalesce(sum(u.staff_orders), 0),
        'bills', coalesce(sum(u.bills), 0),
        'gmv_paise', coalesce(sum(u.gmv_paise), 0)
      )
      from u where u.business_day > v_last - 30
    )
  )
  into v_result;
  return v_result;
end;
$$;

-- ─── Billing ────────────────────────────────────────────────────────────────
-- Where the restaurant stands in Dues (the same rule as the Dues page),
-- reminders emailed, payment links sent (and whether each was paid) and the
-- subscription's history from the audit log (SA-36). Amounts need money.view.
create function public.platform_restaurant_billing(p_restaurant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
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
        'after', x.after,
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
            'restaurant.suspended', 'restaurant.unsuspended'
          )
        order by a.created_at desc limit 50
      ) as x
    ), '[]'::jsonb)
  );
end;
$$;

-- ─── Usage ──────────────────────────────────────────────────────────────────
-- Accepted orders by weekday and hour over the last 12 weeks of stored days
-- (the weekday of the business day, the hour on the clock, as the sales
-- heatmap), and the plan limits the restaurant ran into in 90 days (SA-37).
create function public.platform_restaurant_usage(p_restaurant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_to date;
  v_hour int;
begin
  perform private.require_platform_permission('restaurants.view');
  select private.business_date(now(), r.timezone, r.business_day_start_hour) - 2,
    r.business_day_start_hour
  into v_to, v_hour
  from public.restaurants r where r.id = p_restaurant_id;
  if not found then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;

  return jsonb_build_object(
    'from', v_to - 83,
    'to', v_to,
    'start_hour', v_hour,
    'hours', coalesce((
      select jsonb_agg(jsonb_build_object('weekday', x.weekday, 'hour', x.hour, 'orders', x.orders)
        order by x.weekday, x.hour)
      from (
        select extract(isodow from m.business_day)::int as weekday, (h.idx - 1)::int as hour,
          sum(h.n)::int as orders
        from public.metrics_usage_daily m
        cross join lateral unnest(m.hourly_orders) with ordinality as h(n, idx)
        where m.restaurant_id = p_restaurant_id
          and m.business_day between v_to - 83 and v_to
          and h.n > 0
        group by 1, 2
      ) as x
    ), '[]'::jsonb),
    'limit_hits', coalesce((
      select jsonb_agg(jsonb_build_object(
        'kind', x.kind, 'feature', x.feature, 'count', x.n, 'last_at', x.last_at
      ) order by x.last_at desc)
      from (
        select e.kind, e.feature, count(*) as n, max(e.created_at) as last_at
        from public.plan_limit_events e
        where e.restaurant_id = p_restaurant_id and e.created_at >= now() - interval '90 days'
        group by e.kind, e.feature
      ) as x
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.platform_restaurant_overview(uuid) from public, anon;
revoke execute on function public.platform_restaurant_billing(uuid) from public, anon;
revoke execute on function public.platform_restaurant_usage(uuid) from public, anon;
grant execute on function public.platform_restaurant_overview(uuid) to authenticated;
grant execute on function public.platform_restaurant_billing(uuid) to authenticated;
grant execute on function public.platform_restaurant_usage(uuid) to authenticated;

-- ─── Notes ──────────────────────────────────────────────────────────────────
-- Anyone who manages restaurants writes and pins notes; only the author edits
-- one, within 15 minutes of writing it (SA-38). Every change is audited.
create function private.note_body(p_body text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_body text := btrim(coalesce(p_body, ''));
begin
  if length(v_body) not between 1 and 2000 then
    perform private.fail('INVALID_INPUT', 'body');
  end if;
  return v_body;
end;
$$;

revoke execute on function private.note_body(text) from public, anon, authenticated;

-- Pinned ones first, then the newest, 200 in all.
create function public.platform_list_notes(p_restaurant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.view');
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', n.id,
      'body', n.body,
      'pinned', n.pinned,
      'author', u.email,
      'created_at', n.created_at,
      'edited_at', n.edited_at,
      'editable_until', case when n.author_id = v_admin.user_id
        and n.created_at + interval '15 minutes' > now()
        then n.created_at + interval '15 minutes' end
    ) order by n.pinned desc, n.created_at desc, n.id desc)
    from (
      select * from public.restaurant_notes x
      where x.restaurant_id = p_restaurant_id
      order by x.pinned desc, x.created_at desc, x.id desc limit 200
    ) as n
    left join auth.users u on u.id = n.author_id
  ), '[]'::jsonb);
end;
$$;

create function public.platform_add_note(
  p_restaurant_id uuid,
  p_body text,
  p_pinned boolean default false
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.manage');
  v_body text := private.note_body(p_body);
  v_id uuid;
begin
  if not exists (select 1 from public.restaurants r where r.id = p_restaurant_id) then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;
  insert into public.restaurant_notes (restaurant_id, author_id, body, pinned)
  values (p_restaurant_id, v_admin.user_id, v_body, coalesce(p_pinned, false))
  returning id into v_id;
  perform private.audit_platform(
    v_admin, p_restaurant_id, 'restaurant.note_added', 'restaurant_note', v_id,
    null, jsonb_build_object('body', v_body, 'pinned', coalesce(p_pinned, false))
  );
  return v_id;
end;
$$;

create function public.platform_edit_note(p_note_id uuid, p_body text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.manage');
  v_body text := private.note_body(p_body);
  v_note public.restaurant_notes;
begin
  select * into v_note from public.restaurant_notes n where n.id = p_note_id for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  if v_note.author_id is distinct from v_admin.user_id
    or v_note.created_at + interval '15 minutes' <= now() then
    perform private.fail('NOTE_LOCKED');
  end if;
  if v_note.body = v_body then
    return;
  end if;
  update public.restaurant_notes set body = v_body, edited_at = now() where id = p_note_id;
  perform private.audit_platform(
    v_admin, v_note.restaurant_id, 'restaurant.note_edited', 'restaurant_note', p_note_id,
    jsonb_build_object('body', v_note.body), jsonb_build_object('body', v_body)
  );
end;
$$;

create function public.platform_pin_note(p_note_id uuid, p_pinned boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.manage');
  v_note public.restaurant_notes;
begin
  if p_pinned is null then
    perform private.fail('INVALID_INPUT', 'pinned');
  end if;
  select * into v_note from public.restaurant_notes n where n.id = p_note_id for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  if v_note.pinned = p_pinned then
    return;
  end if;
  update public.restaurant_notes set pinned = p_pinned where id = p_note_id;
  perform private.audit_platform(
    v_admin, v_note.restaurant_id,
    case when p_pinned then 'restaurant.note_pinned' else 'restaurant.note_unpinned' end,
    'restaurant_note', p_note_id
  );
end;
$$;

revoke execute on function public.platform_list_notes(uuid) from public, anon;
revoke execute on function public.platform_add_note(uuid, text, boolean) from public, anon;
revoke execute on function public.platform_edit_note(uuid, text) from public, anon;
revoke execute on function public.platform_pin_note(uuid, boolean) from public, anon;
grant execute on function public.platform_list_notes(uuid) to authenticated;
grant execute on function public.platform_add_note(uuid, text, boolean) to authenticated;
grant execute on function public.platform_edit_note(uuid, text) to authenticated;
grant execute on function public.platform_pin_note(uuid, boolean) to authenticated;

-- ─── Tags ───────────────────────────────────────────────────────────────────
create function public.platform_create_tag(p_name text, p_colour text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.manage');
  v_name text := btrim(coalesce(p_name, ''));
  v_id uuid;
begin
  if length(v_name) not between 1 and 30 then
    perform private.fail('INVALID_INPUT', 'name');
  end if;
  if p_colour is null or p_colour not in ('orange', 'teal', 'amber', 'green', 'red', 'slate') then
    perform private.fail('INVALID_INPUT', 'colour');
  end if;
  begin
    insert into public.platform_tags (name, colour, created_by)
    values (v_name, p_colour, v_admin.user_id)
    returning id into v_id;
  exception when unique_violation then
    perform private.fail('TAG_EXISTS');
  end;
  perform private.audit_platform(
    v_admin, null, 'platform_tag.created', 'platform_tag', v_id,
    null, jsonb_build_object('name', v_name, 'colour', p_colour)
  );
  return v_id;
end;
$$;

-- Removes the tag from every restaurant too.
create function public.platform_delete_tag(p_tag_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.manage');
  v_tag public.platform_tags;
  v_count int;
begin
  select * into v_tag from public.platform_tags t where t.id = p_tag_id for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  select count(*) into v_count from public.restaurant_tags rt where rt.tag_id = p_tag_id;
  delete from public.platform_tags where id = p_tag_id;
  perform private.audit_platform(
    v_admin, null, 'platform_tag.deleted', 'platform_tag', p_tag_id,
    jsonb_build_object('name', v_tag.name, 'colour', v_tag.colour, 'restaurants', v_count)
  );
end;
$$;

-- The restaurant's tags become exactly p_tag_ids (at most 10).
create function public.platform_set_restaurant_tags(p_restaurant_id uuid, p_tag_ids uuid[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.manage');
  v_ids uuid[] := array(select distinct x from unnest(coalesce(p_tag_ids, '{}')) as x);
  v_before jsonb;
  v_after jsonb;
begin
  perform 1 from public.restaurants r where r.id = p_restaurant_id for update;
  if not found then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;
  if cardinality(v_ids) > 10 then
    perform private.fail('INVALID_INPUT', 'tags');
  end if;
  if (select count(*) from public.platform_tags t where t.id = any(v_ids)) <> cardinality(v_ids) then
    perform private.fail('NOT_FOUND');
  end if;

  select coalesce(jsonb_agg(t.name order by lower(t.name)), '[]'::jsonb) into v_before
  from public.restaurant_tags rt join public.platform_tags t on t.id = rt.tag_id
  where rt.restaurant_id = p_restaurant_id;

  delete from public.restaurant_tags rt
  where rt.restaurant_id = p_restaurant_id and rt.tag_id <> all(v_ids);
  insert into public.restaurant_tags (restaurant_id, tag_id, created_by)
  select p_restaurant_id, x, v_admin.user_id from unnest(v_ids) as x
  on conflict do nothing;

  select coalesce(jsonb_agg(t.name order by lower(t.name)), '[]'::jsonb) into v_after
  from public.restaurant_tags rt join public.platform_tags t on t.id = rt.tag_id
  where rt.restaurant_id = p_restaurant_id;
  if v_after <> v_before then
    perform private.audit_platform(
      v_admin, p_restaurant_id, 'restaurant.tags_changed', 'restaurant_tags', p_restaurant_id,
      jsonb_build_object('tags', v_before), jsonb_build_object('tags', v_after)
    );
  end if;
end;
$$;

revoke execute on function public.platform_create_tag(text, text) from public, anon;
revoke execute on function public.platform_delete_tag(uuid) from public, anon;
revoke execute on function public.platform_set_restaurant_tags(uuid, uuid[]) from public, anon;
grant execute on function public.platform_create_tag(text, text) to authenticated;
grant execute on function public.platform_delete_tag(uuid) to authenticated;
grant execute on function public.platform_set_restaurant_tags(uuid, uuid[]) to authenticated;

-- ─── Team and account manager ───────────────────────────────────────────────
-- Platform admins by email (names and roles arrive in 13g).
create function public.platform_team()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_permission('restaurants.view');
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', a.user_id, 'email', u.email)
      order by lower(u.email))
    from public.platform_admins a
    join auth.users u on u.id = a.user_id
  ), '[]'::jsonb);
end;
$$;

create function public.platform_set_account_manager(p_restaurant_id uuid, p_user_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.manage');
  v_before uuid;
begin
  perform 1 from public.restaurants r where r.id = p_restaurant_id for update;
  if not found then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;
  select am.user_id into v_before
  from public.restaurant_account_managers am where am.restaurant_id = p_restaurant_id;
  if p_user_id is not null
    and not exists (select 1 from public.platform_admins a where a.user_id = p_user_id) then
    perform private.fail('ADMIN_NOT_FOUND');
  end if;
  if v_before is not distinct from p_user_id then
    return;
  end if;
  if p_user_id is null then
    delete from public.restaurant_account_managers where restaurant_id = p_restaurant_id;
  else
    insert into public.restaurant_account_managers (restaurant_id, user_id)
    values (p_restaurant_id, p_user_id)
    on conflict (restaurant_id) do update set user_id = excluded.user_id, created_at = now();
  end if;
  perform private.audit_platform(
    v_admin, p_restaurant_id, 'restaurant.account_manager_changed', 'account_manager',
    p_restaurant_id,
    jsonb_build_object('email', (select u.email from auth.users u where u.id = v_before)),
    jsonb_build_object('email', (select u.email from auth.users u where u.id = p_user_id))
  );
end;
$$;

revoke execute on function public.platform_team() from public, anon;
revoke execute on function public.platform_set_account_manager(uuid, uuid) from public, anon;
grant execute on function public.platform_team() to authenticated;
grant execute on function public.platform_set_account_manager(uuid, uuid) to authenticated;

-- ─── Activity: notes ────────────────────────────────────────────────────────
create or replace function private.activity(
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
      -- The newest snapshot day a lapse below the cursor can be on.
      coalesce((p_before_at at time zone 'Asia/Kolkata')::date,
        (now() at time zone 'Asia/Kolkata')::date) as lapse_to
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
    -- that India day. Read-only days are walked newest first
    -- (metrics_subscription_daily_read_only_idx), each checked against the day
    -- before.
    (select 'lapsed', (m.day + 1)::timestamp at time zone 'Asia/Kolkata',
      'lapsed:' || m.restaurant_id || ':' || m.day, m.restaurant_id, null::uuid,
      jsonb_build_object('day', m.day, 'was', p.state)
    from public.metrics_subscription_daily m
    join public.metrics_subscription_daily p
      on p.restaurant_id = m.restaurant_id and p.day = m.day - 1
    cross join params pr
    where 'lapsed' = any(p_kinds)
      and m.state = 'read_only' and p.state <> 'read_only'
      and m.day <= pr.lapse_to
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
      and a.action not in ('subscription.payment_recorded', 'restaurant.created', 'menu.imported')
      and coalesce(a.entity_type, '') <> 'restaurant_note'
      and (p_restaurant_id is null or a.restaurant_id = p_restaurant_id)
      and a.created_at <= pr.before_at
      and (a.created_at, 'audit:' || a.id) < (pr.before_at, pr.before_key)
    order by a.created_at desc, 'audit:' || a.id desc
    limit p_limit)
    union all
    -- The team's notes on a restaurant (SA-38): a note is itself the item,
    -- so its audit rows aren't team items too.
    (select 'note', n.created_at, 'note:' || n.id, n.restaurant_id, n.author_id,
      jsonb_build_object('note_id', n.id, 'body', left(n.body, 200), 'more', length(n.body) > 200,
        'pinned', n.pinned)
    from public.restaurant_notes n, params pr
    where 'note' = any(p_kinds)
      and (p_restaurant_id is null or n.restaurant_id = p_restaurant_id)
      and n.created_at <= pr.before_at
      and (n.created_at, 'note:' || n.id) < (pr.before_at, pr.before_key)
    order by n.created_at desc, 'note:' || n.id desc
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

create or replace function private.activity_kinds(p_kinds text[])
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_all constant text[] := array['signup', 'onboarded', 'payment', 'payment_failed', 'lapsed',
    'reminder', 'lead', 'menu_import', 'team', 'note'];
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

-- ─── Restaurants list: tags and account manager ─────────────────────────────
-- Adds tag (a tag's id) and manager ('me', 'none' or a team member) to the
-- filters, and each row's tags and account manager (SA-39).
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
  v_tag uuid;
  v_manager text;
  v_manager_id uuid;
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
    'paid_to', 'sort', 'dir', 'page', 'export', 'tag', 'manager'
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
        from public.restaurant_access(r.id) as a
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
  scored as (
    select
      b.*,
      case when v_health is not null then private.restaurant_health(b.id, b.created_at) end
        as health,
      case when v_sort = 'last_active' then private.restaurant_last_active(b.id) end
        as last_active,
      case when v_sort = 'gmv' then (
        select u.gmv_30d_paise
        from private.restaurant_recent_usage(b.id, b.timezone, b.business_day_start_hour) as u
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
      u.gmv_30d_paise as recent_gmv
    from page pg
    cross join lateral public.restaurant_access(pg.id) as a
    cross join lateral private.restaurant_recent_usage(
      pg.id, pg.timezone, pg.business_day_start_hour
    ) as u
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
$$;
