-- Activity logs (spec §19 Phase 6, §10.8): voids and discounts, removed
-- dishes and deleted orders, read from the audit log so they carry who did it,
-- their role at the time and why. Partial removals exist only there
-- (docs/DECISIONS.md P6-8).

-- Filters: from, to, kind (voids_discounts | removed_items | deleted_orders),
-- page (50 rows), export (every row). Rows are newest first.
create or replace function public.admin_report_activity(p_filters jsonb)
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
  v_kind text;
  v_actions text[];
  v_page bigint := 1;
  v_page_size int := 50;
  v_total bigint;
  v_rows jsonb;
begin
  perform private.assert_keys(v_filters, array['from', 'to', 'kind', 'page', 'export']);
  v_window := private.report_window(v_ctx, v_filters, 'advanced_reports');

  v_kind := coalesce(private.json_text(v_filters, 'kind'), 'voids_discounts');
  v_actions := case v_kind
    when 'voids_discounts' then array['bill.voided', 'discount.applied']
    when 'removed_items' then array['order_item.removed']
    when 'deleted_orders' then array['order.removed']
  end;
  if v_actions is null then
    perform private.fail('INVALID_INPUT', 'kind');
  end if;
  if coalesce(jsonb_typeof(v_filters -> 'page'), 'null') <> 'null' then
    v_page := private.json_int(v_filters, 'page');
    if v_page not between 1 and 10000 then
      perform private.fail('INVALID_INPUT', 'page');
    end if;
  end if;
  if v_window.export then
    v_page := 1;
    v_page_size := 1000000;
  end if;

  select count(*)
  into v_total
  from public.audit_logs a
  where a.restaurant_id = v_window.restaurant_id and a.action = any (v_actions)
    and a.created_at >= v_window.starts_at and a.created_at < v_window.ends_at;

  if v_kind = 'voids_discounts' then
    select coalesce(jsonb_agg(r.row order by r.created_at desc, r.id desc), '[]'::jsonb)
    into v_rows
    from (
      select a.created_at, a.id, jsonb_build_object(
        'at', a.created_at,
        'kind', case when a.action = 'bill.voided' then 'void' else 'discount' end,
        'bill_id', b.id,
        'invoice_number', b.invoice_number,
        'table_label', b.table_label_snapshot,
        'bill_status', b.status,
        'total_paise', b.grand_total_paise,
        'amount_paise', case
          when a.action = 'bill.voided' then b.grand_total_paise else b.discount_paise
        end,
        'discount_type', case when a.action = 'discount.applied' then b.discount_type end,
        'discount_value', case when a.action = 'discount.applied' then b.discount_value end,
        'reopened', case when a.action = 'bill.voided' then coalesce(a.after -> 'reopen', 'false') end,
        'actor_name', a.actor_label,
        'actor_role', a.actor_role,
        'reason', a.reason
      ) as row
      from public.audit_logs a
      join public.bills b on b.restaurant_id = a.restaurant_id and b.id = a.entity_id
      where a.restaurant_id = v_window.restaurant_id and a.action = any (v_actions)
        and a.created_at >= v_window.starts_at and a.created_at < v_window.ends_at
      order by a.created_at desc, a.id desc
      limit v_page_size offset (v_page - 1) * v_page_size
    ) as r;

  elsif v_kind = 'removed_items' then
    select coalesce(jsonb_agg(r.row order by r.created_at desc, r.id desc), '[]'::jsonb)
    into v_rows
    from (
      select a.created_at, a.id, jsonb_build_object(
        'at', a.created_at,
        'name', a.before ->> 'name',
        'variant', a.before ->> 'variant',
        'quantity', coalesce((a.after ->> 'removed_quantity')::bigint, (a.before ->> 'quantity')::bigint),
        'was_served', a.before ->> 'status' = 'served',
        'value_paise', coalesce(
          (a.after ->> 'removed_quantity')::bigint, (a.before ->> 'quantity')::bigint
        ) * coalesce(i.unit_price_paise, 0),
        'table_label', s.table_label_snapshot,
        'round_number', o.round_number,
        'actor_name', a.actor_label,
        'actor_role', a.actor_role,
        'reason', a.reason
      ) as row
      from public.audit_logs a
      left join public.order_items i on i.restaurant_id = a.restaurant_id and i.id = a.entity_id
      left join public.orders o on o.restaurant_id = i.restaurant_id and o.id = i.order_id
      left join public.table_sessions s on s.restaurant_id = i.restaurant_id and s.id = i.session_id
      where a.restaurant_id = v_window.restaurant_id and a.action = any (v_actions)
        and a.created_at >= v_window.starts_at and a.created_at < v_window.ends_at
      order by a.created_at desc, a.id desc
      limit v_page_size offset (v_page - 1) * v_page_size
    ) as r;

  else
    select coalesce(jsonb_agg(r.row order by r.created_at desc, r.id desc), '[]'::jsonb)
    into v_rows
    from (
      select a.created_at, a.id, jsonb_build_object(
        'at', a.created_at,
        'round_number', (a.before ->> 'round_number')::int,
        'table_label', s.table_label_snapshot,
        'items', coalesce(a.before -> 'items', '[]'::jsonb),
        'quantity', (
          select coalesce(sum((it ->> 'quantity')::bigint), 0)
          from jsonb_array_elements(coalesce(a.before -> 'items', '[]'::jsonb)) as it
        ),
        'value_paise', (
          select coalesce(sum((it ->> 'quantity')::bigint * i.unit_price_paise), 0)
          from jsonb_array_elements(coalesce(a.before -> 'items', '[]'::jsonb)) as it
          join public.order_items i
            on i.restaurant_id = a.restaurant_id and i.id = (it ->> 'id')::uuid
        ),
        'actor_name', a.actor_label,
        'actor_role', a.actor_role,
        'reason', a.reason
      ) as row
      from public.audit_logs a
      left join public.orders o on o.restaurant_id = a.restaurant_id and o.id = a.entity_id
      left join public.table_sessions s on s.restaurant_id = o.restaurant_id and s.id = o.session_id
      where a.restaurant_id = v_window.restaurant_id and a.action = any (v_actions)
        and a.created_at >= v_window.starts_at and a.created_at < v_window.ends_at
      order by a.created_at desc, a.id desc
      limit v_page_size offset (v_page - 1) * v_page_size
    ) as r;
  end if;

  return jsonb_build_object(
    'today', v_window.today,
    'from', v_window.from_date,
    'to', v_window.to_date,
    'kind', v_kind,
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'rows', v_rows
  );
end;
$$;

revoke execute on function public.admin_report_activity(jsonb) from public, anon;
grant execute on function public.admin_report_activity(jsonb) to authenticated;
