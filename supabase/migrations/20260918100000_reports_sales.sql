-- Reports (spec §19 Phase 6): the shared report window and the sales report.
-- Sales count active (non-void) bills by the time they were generated, over
-- business days in the restaurant's timezone, the same rule as Total orders
-- (docs/DECISIONS.md P6-1, P6-2, P6-9, P6-10).

-- The business date a moment belongs to: 1:30 am on the 12th is the 11th's
-- business day when days start at 04:00.
create or replace function private.business_date(p_at timestamptz, p_tz text, p_start_hour int)
returns date
language sql
stable
set search_path = ''
as $$
  select (private.business_day_start(p_at, p_tz, p_start_hour) at time zone p_tz)::date;
$$;

-- What a report covers: the restaurant, its current business date, the
-- chosen business dates and the times they span. `basic` marks a restaurant
-- without the report's feature that may still see a single day, today or
-- yesterday (the Starter sales summary). `export` marks a CSV download.
create type private.report_scope as (
  restaurant_id uuid,
  today date,
  from_date date,
  to_date date,
  starts_at timestamptz,
  ends_at timestamptz,
  timezone text,
  start_hour int,
  basic boolean,
  export boolean
);

-- Reads `from`, `to` (business dates, default today, at most 366 days apart)
-- and `export` from the filters and checks the plan: exports need
-- csv_export; the report needs p_feature, except for a basic single day when
-- p_basic_allowed.
create or replace function private.report_window(
  p_ctx private.member_context,
  p_filters jsonb,
  p_feature text,
  p_basic_allowed boolean default false
)
returns private.report_scope
language plpgsql
stable
set search_path = ''
as $$
declare
  v_restaurant public.restaurants;
  v_window private.report_scope;
begin
  select * into v_restaurant from public.restaurants r where r.id = p_ctx.restaurant_id;
  v_window.restaurant_id := v_restaurant.id;
  v_window.timezone := v_restaurant.timezone;
  v_window.start_hour := v_restaurant.business_day_start_hour;
  v_window.today := private.business_date(now(), v_window.timezone, v_window.start_hour);
  v_window.from_date := coalesce(private.json_date(p_filters, 'from'), v_window.today);
  v_window.to_date := coalesce(private.json_date(p_filters, 'to'), v_window.from_date);
  if v_window.to_date < v_window.from_date or v_window.to_date - v_window.from_date > 366 then
    perform private.fail('INVALID_INPUT', 'to');
  end if;

  v_window.export := false;
  if coalesce(jsonb_typeof(p_filters -> 'export'), 'null') <> 'null' then
    v_window.export := private.json_bool(p_filters, 'export');
  end if;
  if v_window.export and not private.has_feature(v_restaurant.id, 'csv_export') then
    perform private.fail('FEATURE_NOT_IN_PLAN', 'csv_export');
  end if;

  v_window.basic := false;
  if not private.has_feature(v_restaurant.id, p_feature) then
    if p_basic_allowed
      and v_window.from_date = v_window.to_date
      and v_window.from_date between v_window.today - 1 and v_window.today
    then
      v_window.basic := true;
    else
      perform private.fail('FEATURE_NOT_IN_PLAN', p_feature);
    end if;
  end if;

  select b.starts_at, b.ends_at
  into v_window.starts_at, v_window.ends_at
  from private.business_day_bounds(
    v_window.from_date, v_window.to_date, v_window.timezone, v_window.start_hour
  ) as b;
  return v_window;
end;
$$;

-- Money and counts for a set of active bills (P6-2). Net sales is the taxable
-- value: after discounts, with service charge, without GST. Collected is the
-- non-void payments on those bills, by mode.
create or replace function private.sales_totals(p_restaurant_id uuid, p_bill_ids uuid[])
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'bills', count(*),
    'gross_paise', coalesce(sum(b.subtotal_paise), 0),
    'discount_paise', coalesce(sum(b.discount_paise), 0),
    'service_charge_paise', coalesce(sum(b.service_charge_paise), 0),
    'tax_paise', coalesce(sum(b.total_tax_paise), 0),
    'round_off_paise', coalesce(sum(b.round_off_paise), 0),
    'net_paise', coalesce(sum(b.taxable_paise), 0),
    'total_paise', coalesce(sum(b.grand_total_paise), 0),
    'average_paise', case
      when count(*) = 0 then 0
      else round(sum(b.grand_total_paise)::numeric / count(*))::bigint
    end,
    'unpaid_bills', count(*) filter (where b.payment_status = 'unpaid'),
    'unpaid_paise', coalesce(sum(b.grand_total_paise) filter (where b.payment_status = 'unpaid'), 0),
    'collected', (
      select jsonb_build_object(
        'cash', coalesce(sum(p.amount_paise) filter (where p.mode = 'cash'), 0),
        'upi', coalesce(sum(p.amount_paise) filter (where p.mode = 'upi'), 0),
        'card', coalesce(sum(p.amount_paise) filter (where p.mode = 'card'), 0),
        'other', coalesce(sum(p.amount_paise) filter (where p.mode = 'other'), 0)
      )
      from public.bill_payments p
      where p.restaurant_id = p_restaurant_id and p.bill_id = any (p_bill_ids) and not p.is_void
    )
  )
  from public.bills b
  where b.restaurant_id = p_restaurant_id and b.id = any (p_bill_ids);
$$;

revoke execute on function private.business_date(timestamptz, text, int)
  from public, anon, authenticated;
revoke execute on function private.report_window(private.member_context, jsonb, text, boolean)
  from public, anon, authenticated;
revoke execute on function private.sales_totals(uuid, uuid[]) from public, anon, authenticated;

-- Sales report. Filters: from, to, export. Returns the summary, one row per
-- business date (zero days included) and bills by weekday × hour, where the
-- weekday is the business day's (P6-4, P6-5). A basic (Starter) window gets
-- the summary only: no payment modes, days or hours.
create or replace function public.admin_report_sales(p_filters jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_window private.report_scope;
  v_ids uuid[];
  v_summary jsonb;
  v_days jsonb;
  v_hours jsonb;
begin
  perform private.assert_keys(v_filters, array['from', 'to', 'export']);
  v_window := private.report_window(v_ctx, v_filters, 'advanced_reports', true);

  select coalesce(array_agg(b.id), '{}')
  into v_ids
  from public.bills b
  where b.restaurant_id = v_window.restaurant_id and b.status = 'active'
    and b.generated_at >= v_window.starts_at and b.generated_at < v_window.ends_at;

  v_summary := private.sales_totals(v_window.restaurant_id, v_ids);

  if v_window.basic then
    v_summary := v_summary || jsonb_build_object('collected', null);
  else
    select jsonb_agg(
      jsonb_build_object('date', g.day::date) || private.sales_totals(v_window.restaurant_id, d.ids)
      order by g.day
    )
    into v_days
    from generate_series(v_window.from_date, v_window.to_date, interval '1 day') as g(day)
    cross join lateral private.business_day_bounds(
      g.day::date, g.day::date, v_window.timezone, v_window.start_hour
    ) as w
    cross join lateral (
      select coalesce(array_agg(b.id), '{}') as ids
      from public.bills b
      where b.restaurant_id = v_window.restaurant_id and b.status = 'active'
        and b.generated_at >= w.starts_at and b.generated_at < w.ends_at
    ) as d;

    select coalesce(jsonb_agg(
      jsonb_build_object(
        'weekday', h.weekday, 'hour', h.hour, 'bills', h.bills, 'total_paise', h.total_paise
      )
      order by h.weekday, h.hour
    ), '[]'::jsonb)
    into v_hours
    from (
      -- The business date written out (private.business_date's answer) so it
      -- is computed inline: a function call per bill made a year's range 5x slower.
      select
        extract(isodow from (
          (b.generated_at at time zone v_window.timezone)
          - make_interval(hours => v_window.start_hour)
        )::date)::int as weekday,
        extract(hour from b.generated_at at time zone v_window.timezone)::int as hour,
        count(*) as bills,
        sum(b.grand_total_paise) as total_paise
      from public.bills b
      where b.restaurant_id = v_window.restaurant_id and b.status = 'active'
        and b.generated_at >= v_window.starts_at and b.generated_at < v_window.ends_at
      group by 1, 2
    ) as h;
  end if;

  return jsonb_build_object(
    'today', v_window.today,
    'from', v_window.from_date,
    'to', v_window.to_date,
    'start_hour', v_window.start_hour,
    'basic', v_window.basic,
    'summary', v_summary,
    'days', v_days,
    'hours', v_hours
  );
end;
$$;

revoke execute on function public.admin_report_sales(jsonb) from public, anon;
grant execute on function public.admin_report_sales(jsonb) to authenticated;
