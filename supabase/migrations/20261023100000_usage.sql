-- Stop 13e: usage analytics (docs/SUPER_ADMIN_PLAN.md 13e, docs/DECISIONS.md SA-61+).
-- A day's usage has one definition, private.metrics_usage_rows: the nightly
-- rebuild stores it and the Usage page counts the days not stored yet with it.

-- ─── New counts ─────────────────────────────────────────────────────────────
-- The language of the menu a guest ordered from (null for staff orders and
-- orders from before 13e).
alter table public.orders
  add column guest_lang text check (guest_lang in ('en', 'hi'));

-- Per business day, for feature adoption: bills for a table with an assigned
-- waiter, bills paid in more than one payment, accepted orders with an add-on,
-- and accepted orders placed from the Hindi menu.
alter table public.metrics_usage_daily
  add column waiter_bills int not null default 0,
  add column split_bills int not null default 0,
  add column addon_orders int not null default 0,
  add column hindi_orders int not null default 0;

-- The live days look only at restaurants with something in the last 3 days.
create index bills_generated_idx on public.bills (generated_at);
create index service_requests_created_idx on public.service_requests (created_at);

-- ─── Guests' orders record the menu's language ──────────────────────────────
drop function public.customer_place_order(text, text, text, jsonb, text);
create function public.customer_place_order(
  p_qr_token text,
  p_device_id text,
  p_idempotency_key text,
  p_items jsonb,
  p_note text default null,
  p_lang text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device text := private.customer_device(p_device_id);
  v_note text := private.tidy_text(p_note);
  v_table public.dining_tables;
  v_restaurant public.restaurants;
  v_order public.orders;
  v_session public.table_sessions;
  v_lines jsonb;
  v_status public.order_status;
begin
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{8,100}$' then
    perform private.fail('INVALID_INPUT', 'idempotency_key');
  end if;
  if p_qr_token is null or p_qr_token !~ '^[A-Za-z0-9]{16}$' then
    perform private.fail('TABLE_NOT_FOUND');
  end if;

  -- The table row lock serialises every order for this table (customer and
  -- staff), so concurrent first orders open exactly one session and round
  -- numbers never clash.
  select * into v_table
  from public.dining_tables t
  where t.qr_token = p_qr_token and t.is_active
  for update;
  if not found then
    perform private.fail('TABLE_NOT_FOUND');
  end if;

  -- A retried submit gets back the order it already created (spec §9.3), even
  -- if the menu has changed since. The key only replays for the same device
  -- and table.
  select * into v_order
  from public.orders o
  where o.restaurant_id = v_table.restaurant_id and o.idempotency_key = p_idempotency_key;
  if found then
    if v_order.client_device_id is distinct from v_device
       or not exists (
         select 1 from public.table_sessions s
         where s.id = v_order.session_id and s.dining_table_id = v_table.id
       ) then
      perform private.fail('INVALID_INPUT', 'idempotency_key');
    end if;
    return jsonb_build_object(
      'order_id', v_order.id,
      'round_number', v_order.round_number,
      'status', v_order.status,
      'replayed', true
    );
  end if;

  if (select a.state from public.restaurant_access(v_table.restaurant_id) a) is distinct from 'full' then
    perform private.fail('ORDERING_UNAVAILABLE');
  end if;
  select * into v_restaurant from public.restaurants r where r.id = v_table.restaurant_id;

  v_lines := private.parse_order_lines(p_items, v_note);

  -- Rate limits (spec §9.4). Only customer orders count. The "3 waiting for
  -- approval" cap applies only when this order would wait too (approval on and
  -- the table's open session not yet approved).
  if (select count(*) from public.orders o
      where o.client_device_id = v_device and o.created_at > now() - interval '1 minute') >= 5
     or (select count(*) from public.orders o
         where o.client_device_id = v_device and o.created_at > now() - interval '1 hour') >= 30
     or (select count(*)
         from public.orders o
         join public.table_sessions s on s.restaurant_id = o.restaurant_id and s.id = o.session_id
         where o.restaurant_id = v_table.restaurant_id
           and o.placed_via = 'customer'
           and o.created_at > now() - interval '10 minutes'
           and s.dining_table_id = v_table.id) >= 10
     or v_restaurant.require_first_order_approval and (select count(*)
         from public.orders o
         join public.table_sessions s on s.restaurant_id = o.restaurant_id and s.id = o.session_id
         where s.dining_table_id = v_table.id
           and s.status = 'open'
           and not s.is_approved
           and private.is_waiting(o)) >= 3 then
    perform private.fail('RATE_LIMITED');
  end if;

  perform private.assert_orderable(v_table.restaurant_id, v_lines);

  -- Join the table's open session or open one (spec §10.1). Locked (after the
  -- table, docs/DECISIONS.md P4-10) so an approval or waiter assignment in
  -- flight finishes first and the round sees whether the session is approved.
  select * into v_session
  from public.table_sessions s
  where s.dining_table_id = v_table.id and s.status = 'open'
  for update;
  if not found then
    insert into public.table_sessions (
      restaurant_id, dining_table_id, table_label_snapshot, is_approved, approved_at
    )
    values (
      v_table.restaurant_id, v_table.id, v_table.label,
      not v_restaurant.require_first_order_approval,
      case when v_restaurant.require_first_order_approval then null else now() end
    )
    returning * into v_session;
  elsif not v_restaurant.require_first_order_approval and not v_session.is_approved then
    -- Approval was switched off while this session waited: new orders are
    -- accepted from now on (rounds already waiting stay with staff to decide).
    update public.table_sessions set is_approved = true, approved_at = now()
    where id = v_session.id
    returning * into v_session;
  end if;

  -- First-order approval (spec §10.2).
  v_status := case
    when v_restaurant.require_first_order_approval and not v_session.is_approved
      then 'pending_approval'
    else 'accepted'
  end;

  begin
    insert into public.orders (
      restaurant_id, session_id, round_number, status, placed_via,
      client_device_id, idempotency_key, customer_note, guest_lang
    )
    values (
      v_table.restaurant_id,
      v_session.id,
      (select coalesce(max(o.round_number), 0) + 1 from public.orders o where o.session_id = v_session.id),
      v_status,
      'customer',
      v_device,
      p_idempotency_key,
      v_note,
      -- Only for usage analytics (SA-64): anything else is not known.
      case when p_lang in ('en', 'hi') then p_lang end
    )
    returning * into v_order;
  exception when unique_violation then
    -- The same key already used at another table of this restaurant.
    perform private.fail('INVALID_INPUT', 'idempotency_key');
  end;

  perform private.insert_order_items(v_table.restaurant_id, v_order.id, v_session.id, v_lines);

  return jsonb_build_object(
    'order_id', v_order.id,
    'round_number', v_order.round_number,
    'status', v_order.status,
    'replayed', false
  );
end;
$$;

-- ─── A day's usage, one definition ──────────────────────────────────────────
-- The rows metrics_usage_rebuild stores, without storing them (SA-61). Not
-- live: each restaurant's days up to its last finished one, which the nightly
-- job stores. Live: only its last finished day and today, which reports count
-- as they happen (SA-35); only restaurants with an order, a bill or a request
-- in the last 3 days can have one.
create function private.metrics_usage_rows(
  p_from date,
  p_to date,
  p_restaurant_id uuid default null,
  p_live boolean default false
)
returns setof public.metrics_usage_daily
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  r record;
  v_today date;
  v_from date;
  v_to date;
  v_starts timestamptz;
  v_ends timestamptz;
begin
  for r in
    select x.id, x.timezone as tz, x.business_day_start_hour as h
    from public.restaurants x
    where (p_restaurant_id is null or x.id = p_restaurant_id)
      and (not p_live or x.id in (
        select o.restaurant_id from public.orders o where o.created_at >= now() - interval '3 days'
        union
        select b.restaurant_id from public.bills b where b.generated_at >= now() - interval '3 days'
        union
        select q.restaurant_id from public.service_requests q
        where q.created_at >= now() - interval '3 days'
      ))
  loop
    v_today := private.business_date(now(), r.tz, r.h);
    if p_live then
      v_from := greatest(p_from, v_today - 1);
      v_to := least(p_to, v_today);
    else
      v_from := p_from;
      v_to := least(p_to, v_today - 1);
    end if;
    continue when v_to < v_from;
    select b.starts_at, b.ends_at into v_starts, v_ends
    from private.business_day_bounds(v_from, v_to, r.tz, r.h) as b;

    return query
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
        sum(it.items)::int as items,
        (count(*) filter (where b.waiter_id is not null))::int as waiter_bills,
        (count(*) filter (where pay.n > 1))::int as split_bills
      from public.bills b
      join public.table_sessions s on s.id = b.session_id
      cross join lateral (
        select
          coalesce(sum(p.amount_paise) filter (where p.mode = 'cash'), 0) as cash,
          coalesce(sum(p.amount_paise) filter (where p.mode = 'upi'), 0) as upi,
          coalesce(sum(p.amount_paise) filter (where p.mode = 'card'), 0) as card,
          coalesce(sum(p.amount_paise) filter (where p.mode = 'other'), 0) as other,
          count(*) as n
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
        o.placed_via,
        o.guest_lang,
        exists (
          select 1 from public.order_items i
          where i.restaurant_id = r.id and i.session_id = o.session_id and i.order_id = o.id
            and i.addons_snapshot <> '[]'::jsonb
        ) as with_addons
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
        (count(*) filter (where pl.with_addons))::int as addon_orders,
        (count(*) filter (where pl.guest_lang = 'hi'))::int as hindi_orders,
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
      coalesce(bd.gmv, 0)::bigint, coalesce(bd.discount, 0)::bigint, coalesce(bd.tax, 0)::bigint,
      coalesce(bd.cash, 0)::bigint, coalesce(bd.upi, 0)::bigint, coalesce(bd.card, 0)::bigint,
      coalesce(bd.other, 0)::bigint,
      coalesce(rd.requests, 0), coalesce(od.hourly, array_fill(0, array[24])),
      coalesce(bd.waiter_bills, 0), coalesce(bd.split_bills, 0),
      coalesce(od.addon_orders, 0), coalesce(od.hindi_orders, 0)
    from days d
    left join bill_days bd on bd.day = d.day
    left join order_days od on od.day = d.day
    left join request_days rd on rd.day = d.day
    where d.day between v_from and v_to;
  end loop;
end;
$$;

-- Stores what metrics_usage_rows counts, one rebuild at a time: two at once
-- (the nightly job run twice) would both delete the same days, then both
-- insert them.
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
  v_rows int;
begin
  perform pg_advisory_xact_lock(hashtextextended('metrics_usage_rebuild', 0));
  delete from public.metrics_usage_daily m
  using public.restaurants x
  where (p_restaurant_id is null or x.id = p_restaurant_id)
    and m.restaurant_id = x.id
    and m.business_day between p_from
      and least(p_to, private.business_date(now(), x.timezone, x.business_day_start_hour) - 1);
  insert into public.metrics_usage_daily
  select * from private.metrics_usage_rows(p_from, p_to, p_restaurant_id, false);
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- ─── Features in use ────────────────────────────────────────────────────────
-- Which features a restaurant used in the dates (SA-63), from the period's
-- summed counts (`waiter_bills`, `split_bills`, `discount_paise`,
-- `service_requests`, `addon_orders`, `hindi_orders`), its menu imports, and
-- for the kitchen view, UPI QR and the Hindi worker panel, its setup now.
create function private.restaurant_features(
  p_restaurant_id uuid,
  p_from date,
  p_to date,
  p_counts jsonb
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'kitchen_view', private.has_feature(x.id, 'kds') and exists (
      select 1 from public.restaurant_members m
      where m.restaurant_id = x.id and m.role = 'kitchen' and m.is_active
    ),
    'waiter_assignment', coalesce((p_counts ->> 'waiter_bills')::bigint, 0) > 0,
    'upi_qr_on_bill', x.show_upi_qr_on_bill and x.upi_vpa is not null
      and private.has_feature(x.id, 'upi_qr_on_bill'),
    'hindi_staff', exists (
      select 1 from public.restaurant_members m
      where m.restaurant_id = x.id and m.is_active and m.ui_lang = 'hi'
    ),
    'hindi_menu', coalesce((p_counts ->> 'hindi_orders')::bigint, 0) > 0,
    'addons', coalesce((p_counts ->> 'addon_orders')::bigint, 0) > 0,
    'service_requests', coalesce((p_counts ->> 'service_requests')::bigint, 0) > 0,
    'discounts', coalesce((p_counts ->> 'discount_paise')::bigint, 0) > 0,
    'split_payments', coalesce((p_counts ->> 'split_bills')::bigint, 0) > 0,
    'menu_photo_import', exists (
      select 1
      from public.menu_imports i
      cross join private.business_day_bounds(p_from, p_to, x.timezone, x.business_day_start_hour) as b
      where i.restaurant_id = x.id
        and i.source = 'photo'
        and i.status = 'imported'
        and i.completed_at >= b.starts_at and i.completed_at < b.ends_at
        -- By the restaurant: not by the team (a support session or the wizard).
        and exists (
          select 1 from public.restaurant_members m
          where m.restaurant_id = x.id and m.user_id = i.created_by
        )
    )
  )
  from public.restaurants x
  where x.id = p_restaurant_id;
$$;

-- ─── The Usage page ─────────────────────────────────────────────────────────
-- Usage over business dates, each restaurant's own, summed like Home (SA-62):
-- stored days up to each restaurant's last finished day but one, then its last
-- finished day and today counted live, as private.platform_usage splits them.
-- With p_compare, the same number of days just before, for the key numbers.
create function public.platform_usage_report(
  p_from date,
  p_to date,
  p_compare boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
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
    cross join lateral public.restaurant_access(x.id) as a
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
$$;

-- ─── A restaurant's Usage tab: features in use ──────────────────────────────
-- Adds the features it used in its last 30 finished business days (SA-63).
create or replace function public.platform_restaurant_usage(p_restaurant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_to date;
  v_hour int;
  v_counts jsonb;
begin
  perform private.require_platform_permission('restaurants.view');
  select private.business_date(now(), r.timezone, r.business_day_start_hour) - 2,
    r.business_day_start_hour
  into v_to, v_hour
  from public.restaurants r where r.id = p_restaurant_id;
  if not found then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;

  -- The last 30 finished days: stored up to v_to, the last finished day live.
  select jsonb_build_object(
    'waiter_bills', coalesce(sum(u.waiter_bills), 0),
    'split_bills', coalesce(sum(u.split_bills), 0),
    'discount_paise', coalesce(sum(u.discount_paise), 0),
    'service_requests', coalesce(sum(u.service_requests), 0),
    'addon_orders', coalesce(sum(u.addon_orders), 0),
    'hindi_orders', coalesce(sum(u.hindi_orders), 0)
  )
  into v_counts
  from (
    select m.* from public.metrics_usage_daily m
    where m.restaurant_id = p_restaurant_id and m.business_day between v_to - 28 and v_to
    union all
    select l.* from private.metrics_usage_rows(v_to + 1, v_to + 1, p_restaurant_id, true) as l
  ) as u;

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
    ), '[]'::jsonb),
    'features_from', v_to - 28,
    'features_to', v_to + 1,
    'features', private.restaurant_features(p_restaurant_id, v_to - 28, v_to + 1, v_counts)
  );
end;
$$;

-- ─── Grants ─────────────────────────────────────────────────────────────────
revoke execute on function public.customer_place_order(text, text, text, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.customer_place_order(text, text, text, jsonb, text, text)
  to service_role;
revoke execute on function private.metrics_usage_rows(date, date, uuid, boolean)
  from public, anon, authenticated;
revoke execute on function private.restaurant_features(uuid, date, date, jsonb)
  from public, anon, authenticated;
revoke execute on function public.platform_usage_report(date, date, boolean) from public, anon;
grant execute on function public.platform_usage_report(date, date, boolean) to authenticated;
