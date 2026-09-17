-- Bill maths and the bill draft shared by preview, generation and the sample
-- bill (spec §10.5, §11, §11.2; docs/DECISIONS.md P5-1…P5-3, P5-17). Money is
-- integer paise; rounding is round half up on non-negative numeric values.

-- ─── Financial year ─────────────────────────────────────────────────────────
-- April to March in the restaurant's timezone: 2026-04-01 → '2026-27',
-- 2027-03-31 23:59 → '2026-27'.
create or replace function private.financial_year(p_at timestamptz, p_tz text)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when extract(month from l.local_at) >= 4
      then to_char(l.local_at, 'YYYY') || '-' || to_char(l.local_at + interval '1 year', 'YY')
    else to_char(l.local_at - interval '1 year', 'YYYY') || '-' || to_char(l.local_at, 'YY')
  end
  from (select p_at at time zone p_tz as local_at) as l;
$$;

-- ─── Totals (spec §11) ──────────────────────────────────────────────────────
-- Pure: the same inputs always give the same totals. Percent discounts are in
-- basis points (max 100%); flat discounts are capped at the subtotal. Service
-- charge is part of the taxable value. Grand total is rounded to the rupee.
create or replace function private.calc_bill_totals(
  p_subtotal_paise bigint,
  p_discount_type public.discount_type,
  p_discount_value bigint,
  p_apply_service_charge boolean,
  p_service_charge_bps int,
  p_gst_mode public.gst_mode,
  p_gst_rate_bps int,
  p_prices_include_tax boolean
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_discount bigint;
  v_after_discount bigint;
  v_service_charge bigint;
  v_gross bigint;
  v_taxable bigint;
  v_tax bigint;
  v_pre_round bigint;
  v_cgst bigint;
  v_grand bigint;
begin
  if p_subtotal_paise is null or p_subtotal_paise < 0 then
    perform private.fail('INVALID_INPUT', 'subtotal');
  end if;
  if p_discount_type is null
    or p_discount_value is null
    or p_discount_value < 0
    or (p_discount_type = 'percent' and p_discount_value > 10000)
  then
    perform private.fail('INVALID_INPUT', 'discount_value');
  end if;
  if p_service_charge_bps is null or p_service_charge_bps not between 0 and 10000 then
    perform private.fail('INVALID_INPUT', 'service_charge_bps');
  end if;
  if p_gst_mode is null or p_gst_rate_bps is null or p_gst_rate_bps not between 0 and 2800 then
    perform private.fail('INVALID_INPUT', 'gst');
  end if;

  v_discount := case p_discount_type
    when 'none' then 0
    when 'flat' then least(p_discount_value, p_subtotal_paise)
    else round(p_subtotal_paise::numeric * p_discount_value / 10000)::bigint
  end;
  v_after_discount := p_subtotal_paise - v_discount;
  v_service_charge := case
    when coalesce(p_apply_service_charge, false)
      then round(v_after_discount::numeric * p_service_charge_bps / 10000)::bigint
    else 0
  end;
  v_gross := v_after_discount + v_service_charge;

  if p_gst_mode = 'regular' then
    if coalesce(p_prices_include_tax, false) then
      v_taxable := round(v_gross::numeric * 10000 / (10000 + p_gst_rate_bps))::bigint;
      v_tax := v_gross - v_taxable;
      v_pre_round := v_gross;
    else
      v_taxable := v_gross;
      v_tax := round(v_taxable::numeric * p_gst_rate_bps / 10000)::bigint;
      v_pre_round := v_taxable + v_tax;
    end if;
    v_cgst := v_tax / 2;
  else
    v_taxable := v_gross;
    v_tax := 0;
    v_pre_round := v_gross;
    v_cgst := 0;
  end if;

  v_grand := round(v_pre_round::numeric / 100)::bigint * 100;

  return jsonb_build_object(
    'subtotal_paise', p_subtotal_paise,
    'discount_paise', v_discount,
    'service_charge_paise', v_service_charge,
    'taxable_paise', v_taxable,
    'cgst_paise', v_cgst,
    'sgst_paise', v_tax - v_cgst,
    'total_tax_paise', v_tax,
    'pre_round_paise', v_pre_round,
    'round_off_paise', v_grand - v_pre_round,
    'grand_total_paise', v_grand
  );
end;
$$;

-- ─── Lines ──────────────────────────────────────────────────────────────────
-- What a session bills: dishes still on their way or served on accepted
-- rounds. Removed, cancelled and rejected dishes are left out, and so is a
-- waiting round (billing refuses while one is waiting). The same dish, option
-- and price across rounds is one line, in the order it was first ordered
-- (docs/DECISIONS.md P5-2, P5-3).
create or replace function private.bill_lines(p_restaurant_id uuid, p_session_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'name', l.name,
        'variant', l.variant,
        'qty', l.qty,
        'unit_price_paise', l.unit_price_paise,
        'line_total_paise', l.qty * l.unit_price_paise,
        'food_type', l.food_type
      )
      order by l.first_round, l.first_at, l.name, l.variant
    ),
    '[]'::jsonb
  )
  from (
    select
      oi.item_name_snapshot as name,
      oi.variant_name_snapshot as variant,
      oi.food_type_snapshot as food_type,
      oi.unit_price_paise,
      sum(oi.quantity)::bigint as qty,
      min(o.round_number) as first_round,
      min(oi.created_at) as first_at
    from public.order_items oi
    join public.orders o
      on o.restaurant_id = oi.restaurant_id and o.session_id = oi.session_id and o.id = oi.order_id
    where oi.restaurant_id = p_restaurant_id
      and oi.session_id = p_session_id
      and o.status = 'accepted'
      and oi.status in ('placed', 'preparing', 'ready', 'served')
    group by
      oi.menu_item_id, oi.variant_id, oi.unit_price_paise,
      oi.item_name_snapshot, oi.variant_name_snapshot, oi.food_type_snapshot
  ) as l;
$$;

-- ─── Pricing ────────────────────────────────────────────────────────────────
-- Lines priced with the restaurant's current settings. Checks the discount:
-- INVALID_INPUT for bad values, FEATURE_NOT_IN_PLAN without `discounts`.
-- Service charge applies only when it is switched on in settings.
create or replace function private.bill_pricing(
  p_restaurant public.restaurants,
  p_lines jsonb,
  p_discount_type public.discount_type,
  p_discount_value bigint,
  p_apply_service_charge boolean
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_discount_value bigint := case when p_discount_type = 'none' then 0 else p_discount_value end;
  v_apply boolean := coalesce(p_apply_service_charge, false) and p_restaurant.service_charge_enabled;
  v_discounts boolean := private.has_feature(p_restaurant.id, 'discounts');
  v_subtotal bigint;
begin
  if p_discount_type is null then
    perform private.fail('INVALID_INPUT', 'discount_type');
  end if;
  if p_discount_type <> 'none' and not v_discounts then
    perform private.fail('FEATURE_NOT_IN_PLAN', 'discounts');
  end if;

  select coalesce(sum((l ->> 'line_total_paise')::bigint), 0)
    into v_subtotal
    from jsonb_array_elements(p_lines) as l;

  return jsonb_build_object(
    'lines', p_lines,
    'document_type', case p_restaurant.gst_mode
      when 'regular' then 'tax_invoice'
      when 'composition' then 'bill_of_supply'
      else 'bill'
    end,
    'discount_type', p_discount_type,
    'discount_value', v_discount_value,
    'apply_service_charge', v_apply,
    'service_charge_bps', case when v_apply then p_restaurant.service_charge_bps else 0 end,
    'settings', jsonb_build_object(
      'gst_mode', p_restaurant.gst_mode,
      'gst_rate_bps', p_restaurant.gst_rate_bps,
      'prices_include_tax', p_restaurant.prices_include_tax,
      'service_charge_enabled', p_restaurant.service_charge_enabled,
      'service_charge_bps', p_restaurant.service_charge_bps,
      'discounts', v_discounts
    ),
    'totals', private.calc_bill_totals(
      v_subtotal,
      p_discount_type,
      v_discount_value,
      v_apply,
      p_restaurant.service_charge_bps,
      p_restaurant.gst_mode,
      p_restaurant.gst_rate_bps,
      p_restaurant.prices_include_tax
    )
  );
end;
$$;

-- ─── Draft ──────────────────────────────────────────────────────────────────
-- Everything the bill builder shows and bill generation checks, for an open
-- session: pricing, the dishes not served yet, waiting rounds, and whether a
-- waiter must be assigned first (the restaurant has an active waiter profile
-- and the table has none, spec §10.7).
create or replace function private.bill_draft(
  p_session public.table_sessions,
  p_discount_type public.discount_type,
  p_discount_value bigint,
  p_apply_service_charge boolean
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_restaurant public.restaurants;
  v_waiter public.waiters;
begin
  select * into v_restaurant from public.restaurants r where r.id = p_session.restaurant_id;
  if p_session.assigned_waiter_id is not null then
    select * into v_waiter
      from public.waiters w
      where w.restaurant_id = p_session.restaurant_id and w.id = p_session.assigned_waiter_id;
  end if;

  return private.bill_pricing(
    v_restaurant,
    private.bill_lines(p_session.restaurant_id, p_session.id),
    p_discount_type,
    p_discount_value,
    p_apply_service_charge
  ) || jsonb_build_object(
    'session', jsonb_build_object(
      'id', p_session.id,
      'table_label', p_session.table_label_snapshot,
      'opened_at', p_session.opened_at,
      'status', p_session.status
    ),
    'waiter', case
      when v_waiter.id is null then null
      else jsonb_build_object('id', v_waiter.id, 'name', v_waiter.full_name)
    end,
    'waiter_required', p_session.assigned_waiter_id is null and exists (
      select 1 from public.waiters w
      where w.restaurant_id = p_session.restaurant_id and w.is_active
    ),
    'waiting_count', (
      select count(*)::int
      from public.orders o
      where o.restaurant_id = p_session.restaurant_id
        and o.session_id = p_session.id
        and private.is_waiting(o)
    ),
    'unserved', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'name', oi.item_name_snapshot,
            'variant', oi.variant_name_snapshot,
            'quantity', oi.quantity,
            'status', oi.status
          )
          order by o.round_number, oi.created_at, oi.item_name_snapshot
        ),
        '[]'::jsonb
      )
      from public.order_items oi
      join public.orders o
        on o.restaurant_id = oi.restaurant_id and o.session_id = oi.session_id and o.id = oi.order_id
      where oi.restaurant_id = p_session.restaurant_id
        and oi.session_id = p_session.id
        and o.status = 'accepted'
        and oi.status in ('placed', 'preparing', 'ready')
    )
  );
end;
$$;

revoke execute on function private.financial_year(timestamptz, text) from public, anon, authenticated;
revoke execute on function private.calc_bill_totals(
  bigint, public.discount_type, bigint, boolean, int, public.gst_mode, int, boolean
) from public, anon, authenticated;
revoke execute on function private.bill_lines(uuid, uuid) from public, anon, authenticated;
revoke execute on function private.bill_pricing(
  public.restaurants, jsonb, public.discount_type, bigint, boolean
) from public, anon, authenticated;
revoke execute on function private.bill_draft(
  public.table_sessions, public.discount_type, bigint, boolean
) from public, anon, authenticated;
