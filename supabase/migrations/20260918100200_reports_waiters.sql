-- Waiter report (spec §19 Phase 6, plan feature waiter_reports): the tables
-- each waiter attended in a range, where a table counts for the waiter it was
-- assigned to when it was billed, so a reassigned table counts once, for
-- whoever finished it (docs/DECISIONS.md P6-7).

-- Filters: from, to, export. Returns a row per waiter (active ones, plus
-- deleted waiters who billed tables in range) and tables per waiter per
-- business date for the chart.
create or replace function public.admin_report_waiters(p_filters jsonb)
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
  v_waiters jsonb;
  v_days jsonb;
begin
  perform private.assert_keys(v_filters, array['from', 'to', 'export']);
  v_window := private.report_window(v_ctx, v_filters, 'waiter_reports');

  with billed as (
    select
      b.waiter_id,
      b.session_id,
      b.grand_total_paise,
      extract(epoch from b.generated_at - s.opened_at) / 60 as minutes,
      private.business_date(b.generated_at, v_window.timezone, v_window.start_hour) as day
    from public.bills b
    join public.table_sessions s on s.restaurant_id = b.restaurant_id and s.id = b.session_id
    where b.restaurant_id = v_window.restaurant_id and b.status = 'active'
      and b.waiter_id is not null
      and b.generated_at >= v_window.starts_at and b.generated_at < v_window.ends_at
  ),
  rounds as (
    select o.session_id, count(*) as rounds
    from public.orders o
    where o.restaurant_id = v_window.restaurant_id and o.status = 'accepted'
      and o.session_id in (select session_id from billed)
    group by o.session_id
  ),
  dishes as (
    select i.session_id, sum(i.quantity) as items
    from public.order_items i
    join public.orders o on o.restaurant_id = i.restaurant_id and o.id = i.order_id
    where i.restaurant_id = v_window.restaurant_id and o.status = 'accepted'
      and i.status in ('placed', 'preparing', 'ready', 'served')
      and i.session_id in (select session_id from billed)
    group by i.session_id
  ),
  totals as (
    select
      b.waiter_id,
      count(*) as tables,
      sum(b.grand_total_paise) as sales_paise,
      round(avg(b.minutes))::int as minutes,
      coalesce(sum(r.rounds), 0) as rounds,
      coalesce(sum(d.items), 0) as items
    from billed b
    left join rounds r on r.session_id = b.session_id
    left join dishes d on d.session_id = b.session_id
    group by b.waiter_id
  ),
  open_tables as (
    select s.assigned_waiter_id as waiter_id, count(*) as tables
    from public.table_sessions s
    where s.restaurant_id = v_window.restaurant_id and s.status = 'open'
      and s.assigned_waiter_id is not null
    group by s.assigned_waiter_id
  ),
  waiters as (
    select coalesce(jsonb_agg(w.row order by w.tables desc, w.name), '[]'::jsonb) as json
    from (
      select
        w.full_name as name,
        coalesce(t.tables, 0) as tables,
        jsonb_build_object(
          'waiter_id', w.id,
          'name', w.full_name,
          'is_active', w.is_active,
          'on_duty', w.on_duty,
          'tables', coalesce(t.tables, 0),
          'sales_paise', coalesce(t.sales_paise, 0),
          'minutes', coalesce(t.minutes, 0),
          'rounds', coalesce(t.rounds, 0),
          'items', coalesce(t.items, 0),
          'open_tables', coalesce(o.tables, 0)
        ) as row
      from public.waiters w
      left join totals t on t.waiter_id = w.id
      left join open_tables o on o.waiter_id = w.id
      where w.restaurant_id = v_window.restaurant_id and (w.is_active or t.waiter_id is not null)
    ) as w
  ),
  days as (
    select coalesce(jsonb_agg(d.row order by d.day, d.waiter_id), '[]'::jsonb) as json
    from (
      select b.day, b.waiter_id, jsonb_build_object(
        'date', b.day, 'waiter_id', b.waiter_id, 'tables', count(*)
      ) as row
      from billed b
      group by b.day, b.waiter_id
    ) as d
  )
  select waiters.json, days.json
  into v_waiters, v_days
  from waiters, days;

  return jsonb_build_object(
    'today', v_window.today,
    'from', v_window.from_date,
    'to', v_window.to_date,
    'waiters', v_waiters,
    'days', v_days
  );
end;
$$;

revoke execute on function public.admin_report_waiters(jsonb) from public, anon;
grant execute on function public.admin_report_waiters(jsonb) to authenticated;
