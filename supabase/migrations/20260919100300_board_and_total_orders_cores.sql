-- The live board and Total orders were tied to the signed-in member. Their
-- bodies move unchanged into private cores that take the restaurant (and, for
-- the board, the viewer's role and member), and the member functions become
-- thin wrappers with the same output. The platform support view reuses the
-- cores (docs/DECISIONS.md P7-6).

-- The live board for a restaurant, as seen by a member with p_role (kitchen
-- sees accepted rounds only). p_member_id finds the viewer's waiter profile.
create or replace function private.board_json(
  p_restaurant_id uuid,
  p_role public.member_role,
  p_member_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_restaurant public.restaurants;
  v_kitchen boolean := p_role = 'kitchen';
  v_tables jsonb;
  v_waiters jsonb;
begin
  select * into v_restaurant from public.restaurants r where r.id = p_restaurant_id;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id', t.id,
             'label', t.label,
             'sort_order', t.sort_order,
             'session', (
               select jsonb_build_object(
                 'id', s.id,
                 'opened_at', s.opened_at,
                 'is_approved', s.is_approved,
                 'assigned_waiter_id', s.assigned_waiter_id,
                 'waiting_count', (
                   select count(*)
                   from public.orders o
                   where o.restaurant_id = s.restaurant_id and o.session_id = s.id
                     and private.is_waiting(o)
                 ),
                 'rounds', coalesce((
                   select jsonb_agg(
                            jsonb_build_object(
                              'id', o.id,
                              'round_number', o.round_number,
                              'status', o.status,
                              'placed_via', o.placed_via,
                              'created_at', o.created_at,
                              'accepted_at', case
                                when o.status = 'accepted' then coalesce(o.decided_at, o.created_at)
                              end,
                              'customer_note', o.customer_note,
                              'reject_reason', o.reject_reason,
                              'removed_reason', o.removed_reason,
                              'removed_by_name', om.display_name,
                              'is_waiting', private.is_waiting(o),
                              'items', coalesce((
                                select jsonb_agg(
                                         jsonb_build_object(
                                           'id', oi.id,
                                           'name', oi.item_name_snapshot,
                                           'variant', oi.variant_name_snapshot,
                                           'food_type', oi.food_type_snapshot,
                                           'quantity', oi.quantity,
                                           'note', oi.note,
                                           'status', oi.status,
                                           'removed_reason', oi.removed_reason,
                                           'removed_by_name', im.display_name
                                         )
                                         order by oi.created_at, oi.item_name_snapshot, oi.id
                                       )
                                from public.order_items oi
                                left join public.restaurant_members im
                                  on im.restaurant_id = oi.restaurant_id and im.user_id = oi.removed_by
                                where oi.restaurant_id = o.restaurant_id
                                  and oi.session_id = o.session_id
                                  and oi.order_id = o.id
                              ), '[]'::jsonb)
                            )
                            order by o.round_number
                          )
                   from public.orders o
                   left join public.restaurant_members om
                     on om.restaurant_id = o.restaurant_id and om.user_id = o.removed_by
                   where o.restaurant_id = s.restaurant_id
                     and o.session_id = s.id
                     and (not v_kitchen or o.status = 'accepted')
                 ), '[]'::jsonb)
               )
               from public.table_sessions s
               where s.restaurant_id = t.restaurant_id and s.dining_table_id = t.id and s.status = 'open'
             )
           )
           order by t.sort_order, t.label
         ), '[]'::jsonb)
  into v_tables
  from public.dining_tables t
  where t.restaurant_id = p_restaurant_id
    and (
      t.is_active
      or exists (
        select 1 from public.table_sessions s
        where s.restaurant_id = t.restaurant_id and s.dining_table_id = t.id and s.status = 'open'
      )
    );

  select coalesce(jsonb_agg(
           jsonb_build_object('id', w.id, 'name', w.full_name, 'on_duty', w.on_duty)
           order by w.full_name, w.id
         ), '[]'::jsonb)
  into v_waiters
  from public.waiters w
  where w.restaurant_id = p_restaurant_id and w.is_active;

  return jsonb_build_object(
    'now', now(),
    'timezone', v_restaurant.timezone,
    'role', p_role,
    'my_waiter_id', (
      select w.id from public.waiters w
      where w.restaurant_id = p_restaurant_id and w.member_id = p_member_id and w.is_active
    ),
    'access_state', (select a.state from public.restaurant_access(p_restaurant_id) a),
    'settings', jsonb_build_object(
      'require_first_order_approval', v_restaurant.require_first_order_approval,
      'max_tables_per_waiter', v_restaurant.max_tables_per_waiter,
      'staff_can_remove_served_items', v_restaurant.staff_can_remove_served_items
    ),
    'tables', v_tables,
    'waiters', v_waiters
  );
end;
$$;

-- Total orders for a restaurant (filters as admin_total_orders).
create or replace function private.total_orders_json(p_restaurant_id uuid, p_filters jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_restaurant public.restaurants;
  v_today date;
  v_from date;
  v_to date;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_table_id uuid;
  v_waiter_id uuid;
  v_payment_status text;
  v_payment_mode text;
  v_invoice text;
  v_show_void boolean := true;
  v_view text;
  v_page bigint := 1;
  v_page_size constant int := 50;
  v_summary jsonb;
  v_rows jsonb;
  v_total bigint;
  v_ids uuid[];
begin
  perform private.assert_keys(
    v_filters,
    array['from', 'to', 'table_id', 'waiter_id', 'payment_status', 'payment_mode', 'invoice',
          'show_void', 'view', 'page']
  );
  select * into v_restaurant from public.restaurants r where r.id = p_restaurant_id;

  v_today := (
    private.business_day_start(now(), v_restaurant.timezone, v_restaurant.business_day_start_hour)
      at time zone v_restaurant.timezone
  )::date;
  v_from := coalesce(private.json_date(v_filters, 'from'), v_today);
  v_to := coalesce(private.json_date(v_filters, 'to'), v_from);
  if v_to < v_from or v_to - v_from > 366 then
    perform private.fail('INVALID_INPUT', 'to');
  end if;
  select b.starts_at, b.ends_at into v_starts_at, v_ends_at
  from private.business_day_bounds(
    v_from, v_to, v_restaurant.timezone, v_restaurant.business_day_start_hour
  ) as b;

  if coalesce(jsonb_typeof(v_filters -> 'table_id'), 'null') <> 'null' then
    v_table_id := private.json_uuid(v_filters, 'table_id');
  end if;
  if coalesce(jsonb_typeof(v_filters -> 'waiter_id'), 'null') <> 'null' then
    v_waiter_id := private.json_uuid(v_filters, 'waiter_id');
  end if;
  v_payment_status := private.json_text(v_filters, 'payment_status');
  if v_payment_status is not null and v_payment_status not in ('paid', 'unpaid') then
    perform private.fail('INVALID_INPUT', 'payment_status');
  end if;
  v_payment_mode := private.json_text(v_filters, 'payment_mode');
  if v_payment_mode is not null and v_payment_mode not in ('cash', 'upi', 'card', 'other') then
    perform private.fail('INVALID_INPUT', 'payment_mode');
  end if;
  v_invoice := private.tidy_text(private.json_text(v_filters, 'invoice'));
  if length(v_invoice) > 40 then
    perform private.fail('INVALID_INPUT', 'invoice');
  end if;
  if coalesce(jsonb_typeof(v_filters -> 'show_void'), 'null') <> 'null' then
    v_show_void := private.json_bool(v_filters, 'show_void');
  end if;
  v_view := coalesce(private.json_text(v_filters, 'view'), 'bills');
  if v_view not in ('bills', 'closed_unbilled') then
    perform private.fail('INVALID_INPUT', 'view');
  end if;
  if coalesce(jsonb_typeof(v_filters -> 'page'), 'null') <> 'null' then
    v_page := private.json_int(v_filters, 'page');
    if v_page not between 1 and 10000 then
      perform private.fail('INVALID_INPUT', 'page');
    end if;
  end if;

  -- Ids of the bills in range matching the filters, void ones included; each
  -- use below decides whether they count.
  select coalesce(array_agg(b.id), '{}')
  into v_ids
  from public.bills b
  join public.table_sessions s on s.restaurant_id = b.restaurant_id and s.id = b.session_id
  where b.restaurant_id = v_restaurant.id
    and b.generated_at >= v_starts_at and b.generated_at < v_ends_at
    and (v_table_id is null or s.dining_table_id = v_table_id)
    and (v_waiter_id is null or b.waiter_id = v_waiter_id)
    and (v_payment_status is null or b.payment_status::text = v_payment_status)
    and (
      v_payment_mode is null
      or exists (
        select 1 from public.bill_payments p
        where p.restaurant_id = b.restaurant_id and p.bill_id = b.id and p.mode::text = v_payment_mode
      )
    )
    and (
      v_invoice is null
      or strpos(lower(b.invoice_number), lower(v_invoice)) > 0
    );

  select jsonb_build_object(
    'bills', count(*),
    'orders', coalesce(sum((
      select count(*) from public.orders o
      where o.restaurant_id = b.restaurant_id and o.session_id = b.session_id and o.status = 'accepted'
    )), 0),
    'items', coalesce(sum((
      select coalesce(sum((l ->> 'qty')::bigint), 0) from jsonb_array_elements(b.line_items) as l
    )), 0),
    'gross_paise', coalesce(sum(b.subtotal_paise), 0),
    'discount_paise', coalesce(sum(b.discount_paise), 0),
    'tax_paise', coalesce(sum(b.total_tax_paise), 0),
    'total_paise', coalesce(sum(b.grand_total_paise), 0),
    'collected_paise', coalesce(sum((
      select coalesce(sum(p.amount_paise), 0) from public.bill_payments p
      where p.restaurant_id = b.restaurant_id and p.bill_id = b.id and not p.is_void
        and (v_payment_mode is null or p.mode::text = v_payment_mode)
    )), 0),
    'unpaid_bills', count(*) filter (where b.payment_status = 'unpaid'),
    'void_bills', (
      select count(*) from public.bills v
      where v.restaurant_id = v_restaurant.id and v.id = any (v_ids) and v.status = 'void'
    ),
    'closed_unbilled', (
      select count(*) from public.table_sessions s
      where s.restaurant_id = v_restaurant.id and s.status = 'closed_unbilled'
        and s.closed_at >= v_starts_at and s.closed_at < v_ends_at
        and (v_table_id is null or s.dining_table_id = v_table_id)
        and (v_waiter_id is null or s.assigned_waiter_id = v_waiter_id)
    )
  )
  into v_summary
  from public.bills b
  where b.restaurant_id = v_restaurant.id and b.id = any (v_ids) and b.status = 'active';

  if v_view = 'bills' then
    select count(*) into v_total
    from public.bills b
    where b.restaurant_id = v_restaurant.id and b.id = any (v_ids)
      and (v_show_void or b.status = 'active');

    select coalesce(jsonb_agg(r.row order by r.generated_at desc, r.invoice_seq desc), '[]'::jsonb)
    into v_rows
    from (
      select b.generated_at, b.invoice_seq, jsonb_build_object(
        'id', b.id,
        'invoice_number', b.invoice_number,
        'status', b.status,
        'payment_status', b.payment_status,
        'table_label', b.table_label_snapshot,
        'waiter_name', b.waiter_name_snapshot,
        'opened_at', s.opened_at,
        'generated_at', b.generated_at,
        'minutes', floor(extract(epoch from b.generated_at - s.opened_at) / 60)::int,
        'items', (
          select coalesce(sum((l ->> 'qty')::bigint), 0) from jsonb_array_elements(b.line_items) as l
        ),
        'grand_total_paise', b.grand_total_paise,
        'modes', coalesce((
          select jsonb_agg(distinct p.mode)
          from public.bill_payments p
          where p.restaurant_id = b.restaurant_id and p.bill_id = b.id
        ), '[]'::jsonb),
        'generated_by_name', (
          select m.display_name from public.restaurant_members m
          where m.restaurant_id = b.restaurant_id and m.user_id = b.generated_by
        )
      ) as row
      from public.bills b
      join public.table_sessions s on s.restaurant_id = b.restaurant_id and s.id = b.session_id
      where b.restaurant_id = v_restaurant.id and b.id = any (v_ids)
        and (v_show_void or b.status = 'active')
      order by b.generated_at desc, b.invoice_seq desc
      limit v_page_size offset (v_page - 1) * v_page_size
    ) as r;
  else
    select count(*) into v_total
    from public.table_sessions s
    where s.restaurant_id = v_restaurant.id and s.status = 'closed_unbilled'
      and s.closed_at >= v_starts_at and s.closed_at < v_ends_at
      and (v_table_id is null or s.dining_table_id = v_table_id)
      and (v_waiter_id is null or s.assigned_waiter_id = v_waiter_id);

    select coalesce(jsonb_agg(r.row order by r.closed_at desc, r.id), '[]'::jsonb)
    into v_rows
    from (
      select s.closed_at, s.id, jsonb_build_object(
        'session_id', s.id,
        'table_label', s.table_label_snapshot,
        'waiter_name', w.full_name,
        'opened_at', s.opened_at,
        'closed_at', s.closed_at,
        'closed_by_name', (
          select m.display_name from public.restaurant_members m
          where m.restaurant_id = s.restaurant_id and m.user_id = s.closed_by
        ),
        'reason', s.close_reason
      ) as row
      from public.table_sessions s
      left join public.waiters w on w.restaurant_id = s.restaurant_id and w.id = s.assigned_waiter_id
      where s.restaurant_id = v_restaurant.id and s.status = 'closed_unbilled'
        and s.closed_at >= v_starts_at and s.closed_at < v_ends_at
        and (v_table_id is null or s.dining_table_id = v_table_id)
        and (v_waiter_id is null or s.assigned_waiter_id = v_waiter_id)
      order by s.closed_at desc, s.id
      limit v_page_size offset (v_page - 1) * v_page_size
    ) as r;
  end if;

  return jsonb_build_object(
    'today', v_today,
    'from', v_from,
    'to', v_to,
    'view', v_view,
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'summary', v_summary,
    'rows', v_rows,
    'tables', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'label', t.label) order by t.sort_order, t.label)
      from public.dining_tables t
      where t.restaurant_id = v_restaurant.id
    ), '[]'::jsonb),
    'waiters', coalesce((
      select jsonb_agg(
        jsonb_build_object('id', w.id, 'name', w.full_name, 'is_active', w.is_active)
        order by w.is_active desc, w.full_name
      )
      from public.waiters w
      where w.restaurant_id = v_restaurant.id
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.staff_get_board()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member();
begin
  return private.board_json(v_ctx.restaurant_id, v_ctx.role, v_ctx.member_id);
end;
$$;

create or replace function public.admin_total_orders(p_filters jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
begin
  return private.total_orders_json(v_ctx.restaurant_id, p_filters);
end;
$$;

revoke execute on function private.board_json(uuid, public.member_role, uuid)
  from public, anon, authenticated;
revoke execute on function private.total_orders_json(uuid, jsonb) from public, anon, authenticated;
