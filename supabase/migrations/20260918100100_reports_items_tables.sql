-- Item, category and table reports (spec §19 Phase 6). Dishes come from the
-- billed rounds of sessions with an active bill in range, at menu prices
-- before bill discounts; categories are the dish's current category
-- (docs/DECISIONS.md P6-3, P6-6).

-- Item-wise and category sales. Filters: from, to, export.
create or replace function public.admin_report_items(p_filters jsonb)
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
  v_items jsonb;
  v_categories jsonb;
begin
  perform private.assert_keys(v_filters, array['from', 'to', 'export']);
  v_window := private.report_window(v_ctx, v_filters, 'advanced_reports');

  with lines as (
    -- One row per dish and variant, with the current name (a renamed dish
    -- keeps one row) and the snapshot as a fallback.
    select
      i.menu_item_id,
      i.variant_id,
      coalesce(m.name, max(i.item_name_snapshot)) as name,
      coalesce(v.name, max(i.variant_name_snapshot)) as variant,
      coalesce(m.food_type, max(i.food_type_snapshot)) as food_type,
      m.category_id,
      c.name as category,
      sum(i.quantity) as qty,
      sum(i.quantity * i.unit_price_paise) as revenue_paise
    from public.order_items i
    join public.orders o on o.restaurant_id = i.restaurant_id and o.id = i.order_id
    join public.bills b on b.restaurant_id = i.restaurant_id and b.session_id = i.session_id
    left join public.menu_items m on m.restaurant_id = i.restaurant_id and m.id = i.menu_item_id
    left join public.menu_item_variants v on v.restaurant_id = i.restaurant_id and v.id = i.variant_id
    left join public.menu_categories c on c.restaurant_id = i.restaurant_id and c.id = m.category_id
    where i.restaurant_id = v_window.restaurant_id
      and b.status = 'active'
      and b.generated_at >= v_window.starts_at and b.generated_at < v_window.ends_at
      and o.status = 'accepted'
      and i.status in ('placed', 'preparing', 'ready', 'served')
    group by i.menu_item_id, i.variant_id, m.name, v.name, m.food_type, m.category_id, c.name
  ),
  items as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'menu_item_id', l.menu_item_id,
        'variant_id', l.variant_id,
        'name', l.name,
        'variant', l.variant,
        'food_type', l.food_type,
        'category', l.category,
        'qty', l.qty,
        'revenue_paise', l.revenue_paise
      )
      order by l.revenue_paise desc, l.qty desc, l.name, l.variant nulls first
    ), '[]'::jsonb) as json
    from lines l
  ),
  categories as (
    select coalesce(jsonb_agg(c.row order by c.revenue_paise desc, c.name), '[]'::jsonb) as json
    from (
      select
        l.category as name,
        sum(l.revenue_paise) as revenue_paise,
        jsonb_build_object(
          'category_id', l.category_id,
          'name', l.category,
          'qty', sum(l.qty),
          'revenue_paise', sum(l.revenue_paise),
          'dishes', count(distinct l.menu_item_id)
        ) as row
      from lines l
      group by l.category_id, l.category
    ) as c
  )
  select items.json, categories.json
  into v_items, v_categories
  from items, categories;

  return jsonb_build_object(
    'today', v_window.today,
    'from', v_window.from_date,
    'to', v_window.to_date,
    'items', v_items,
    'categories', v_categories
  );
end;
$$;

-- Table turnover: billed sessions, average table time (opened until billed,
-- so a reopened table counts its whole stay) and sales per table. Tables with
-- no sessions in range are listed too. Filters: from, to, export.
create or replace function public.admin_report_tables(p_filters jsonb)
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
  v_rows jsonb;
  v_overall jsonb;
begin
  perform private.assert_keys(v_filters, array['from', 'to', 'export']);
  v_window := private.report_window(v_ctx, v_filters, 'advanced_reports');

  with visits as (
    select
      s.dining_table_id,
      extract(epoch from b.generated_at - s.opened_at) / 60 as minutes,
      b.grand_total_paise
    from public.bills b
    join public.table_sessions s on s.restaurant_id = b.restaurant_id and s.id = b.session_id
    where b.restaurant_id = v_window.restaurant_id and b.status = 'active'
      and b.generated_at >= v_window.starts_at and b.generated_at < v_window.ends_at
  ),
  per_table as (
    select
      t.sort_order,
      t.label,
      count(v.dining_table_id) as sessions,
      jsonb_build_object(
        'table_id', t.id,
        'label', t.label,
        'is_active', t.is_active,
        'sessions', count(v.dining_table_id),
        'minutes', coalesce(round(avg(v.minutes)), 0)::int,
        'total_paise', coalesce(sum(v.grand_total_paise), 0),
        'average_paise', case
          when count(v.dining_table_id) = 0 then 0
          else round(sum(v.grand_total_paise)::numeric / count(v.dining_table_id))::bigint
        end
      ) as row
    from public.dining_tables t
    left join visits v on v.dining_table_id = t.id
    where t.restaurant_id = v_window.restaurant_id
      and (t.is_active or exists (select 1 from visits x where x.dining_table_id = t.id))
    group by t.id, t.label, t.is_active, t.sort_order
  ),
  rows as (
    select
      coalesce(jsonb_agg(p.row order by p.sessions desc, p.sort_order, p.label), '[]'::jsonb) as json,
      count(*) as tables
    from per_table p
  ),
  overall as (
    select
      count(*) as sessions,
      coalesce(round(avg(v.minutes)), 0)::int as minutes,
      coalesce(sum(v.grand_total_paise), 0) as total_paise
    from visits v
  )
  select
    rows.json,
    jsonb_build_object(
      'sessions', overall.sessions,
      'minutes', overall.minutes,
      'total_paise', overall.total_paise,
      'tables', rows.tables,
      'per_table', case
        when rows.tables = 0 then 0
        else round(overall.sessions::numeric / rows.tables, 2)
      end
    )
  into v_rows, v_overall
  from rows, overall;

  return jsonb_build_object(
    'today', v_window.today,
    'from', v_window.from_date,
    'to', v_window.to_date,
    'overall', v_overall,
    'tables', v_rows
  );
end;
$$;

revoke execute on function public.admin_report_items(jsonb) from public, anon;
grant execute on function public.admin_report_items(jsonb) to authenticated;
revoke execute on function public.admin_report_tables(jsonb) from public, anon;
grant execute on function public.admin_report_tables(jsonb) to authenticated;
