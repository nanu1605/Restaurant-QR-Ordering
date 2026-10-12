-- Guests see their bill on the orders page (spec §9.2, §13.1 Orders page;
-- docs/DECISIONS.md P11-1…P11-3): customer_get_session as in 20261002110000_auto_hindi_names,
-- plus the customer copy of the bill for a phone that ordered in the billed session.

create or replace function public.customer_get_session(p_qr_token text, p_device_id text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_table public.dining_tables := private.customer_table(p_qr_token);
  v_device text := case when p_device_id is null then null else private.customer_device(p_device_id) end;
  v_restaurant public.restaurants;
  v_window interval;
  v_session public.table_sessions;
  v_rounds jsonb;
  v_last public.table_sessions;
  v_bill public.bills;
begin
  select * into v_restaurant from public.restaurants r where r.id = v_table.restaurant_id;
  v_window := make_interval(secs => v_restaurant.customer_cancel_window_seconds);

  select * into v_session
  from public.table_sessions s
  where s.dining_table_id = v_table.id and s.status = 'open';

  if v_session.id is not null then
    select coalesce(jsonb_agg(
             jsonb_build_object(
               'id', o.id,
               'round_number', o.round_number,
               'status', o.status,
               'placed_at', o.created_at,
               'is_mine', coalesce(o.client_device_id = v_device, false),
               'customer_note', o.customer_note,
               'reject_reason', o.reject_reason,
               'removed_reason', o.removed_reason,
               'items', coalesce((
                 select jsonb_agg(
                          jsonb_build_object(
                            'id', oi.id,
                            'name', oi.item_name_snapshot,
                            -- ponytail: the dish's current Hindi name, not a snapshot;
                            -- add order_items.item_name_hi_snapshot if renames mid-meal matter.
                            'name_hi', coalesce(mi.name_hi, mi.name_hi_auto),
                            'variant', oi.variant_name_snapshot,
                            'addons', private.addon_names(oi.addons_snapshot),
                            'food_type', oi.food_type_snapshot,
                            'quantity', oi.quantity,
                            'unit_price_paise', oi.unit_price_paise,
                            'note', oi.note,
                            'status', oi.status,
                            'removed_reason', oi.removed_reason,
                            -- Set only while this device may still cancel it.
                            'cancellable_until', case
                              when o.client_device_id = v_device
                                and oi.status = 'placed'
                                and o.status in ('pending_approval', 'accepted')
                                and v_restaurant.customer_cancel_window_seconds > 0
                                and now() <= o.created_at + v_window
                                then o.created_at + v_window
                            end
                          )
                          order by oi.created_at, oi.item_name_snapshot, oi.id
                        )
                 from public.order_items oi
                 left join public.menu_items mi
                   on mi.restaurant_id = oi.restaurant_id and mi.id = oi.menu_item_id
                 where oi.restaurant_id = o.restaurant_id
                   and oi.session_id = o.session_id
                   and oi.order_id = o.id
               ), '[]'::jsonb)
             )
             order by o.round_number
           ), '[]'::jsonb)
    into v_rounds
    from public.orders o
    where o.restaurant_id = v_session.restaurant_id and o.session_id = v_session.id;
  end if;

  if v_device is not null then
    select s.* into v_last
    from public.orders o
    join public.table_sessions s on s.restaurant_id = o.restaurant_id and s.id = o.session_id
    where o.client_device_id = v_device and s.dining_table_id = v_table.id
    order by s.opened_at desc
    limit 1;
  end if;

  -- This phone's bill, while its last session here is billed within the hour (the same
  -- rule as last_session_billed), and only when one of its dishes is on it (as
  -- private.bill_lines counts them). A phone that didn't order, or whose order was rejected
  -- or removed (say, the next party's, sent into a session that was still open), gets none.
  if v_last.status = 'billed' and v_last.billed_at > now() - interval '60 minutes'
    and exists (
      select 1
      from public.orders o
      join public.order_items oi
        on oi.restaurant_id = o.restaurant_id and oi.session_id = o.session_id and oi.order_id = o.id
      where o.restaurant_id = v_last.restaurant_id and o.session_id = v_last.id
        and o.client_device_id = v_device
        and o.status = 'accepted'
        and oi.status in ('placed', 'preparing', 'ready', 'served')
    )
  then
    select * into v_bill
    from public.bills b
    where b.restaurant_id = v_last.restaurant_id and b.session_id = v_last.id
      and b.status <> 'void';
  end if;

  return jsonb_build_object(
    'now', now(),
    'timezone', v_restaurant.timezone,
    'cancel_window_seconds', v_restaurant.customer_cancel_window_seconds,
    'access_state', (select a.state from public.restaurant_access(v_table.restaurant_id) a),
    'last_session_billed', coalesce(
      v_last.status = 'billed' and v_last.billed_at > now() - interval '60 minutes', false
    ),
    -- The customer copy: no bill id, who generated or voided it, discount reason or print
    -- count (spec §9.2), and no UPI QR, since a phone can't scan its own screen. "Served by"
    -- stays as printed (print_waiter_on_bill).
    'bill', case
      when v_bill.id is null then null
      else jsonb_build_object(
        'bill', (private.bill_document(v_bill) - 'session_id') || jsonb_build_object(
          'id', null, 'generated_by_name', null, 'voided_by_name', null,
          'discount_reason', null, 'void_reason', null, 'print_count', 0
        ),
        'print', private.bill_print_settings(v_restaurant) || jsonb_build_object('upi', null)
      )
    end,
    'session', case
      when v_session.id is null then null
      else jsonb_build_object('opened_at', v_session.opened_at, 'rounds', v_rounds)
    end
  );
end;
$$;

revoke execute on function public.customer_get_session(text, text) from public, anon, authenticated;
grant execute on function public.customer_get_session(text, text) to service_role;
