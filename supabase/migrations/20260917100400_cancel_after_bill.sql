-- A customer cancel that waited for bill generation's dish locks must not
-- cancel a dish on the bill it just produced (spec §10.3 "nothing changes
-- after the session is billed"; docs/DECISIONS.md P5-4). Same function as
-- before, plus a fresh look at the session once the dish is locked.

create or replace function public.customer_cancel_item(
  p_qr_token text,
  p_device_id text,
  p_order_item_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_device text := private.customer_device(p_device_id);
  v_table public.dining_tables := private.customer_table(p_qr_token);
  v_item public.order_items;
  v_order public.orders;
  v_window int;
begin
  -- Lock the dish so a kitchen status change can't slip in between.
  select oi.* into v_item
  from public.order_items oi
  join public.table_sessions s on s.restaurant_id = oi.restaurant_id and s.id = oi.session_id
  where oi.id = p_order_item_id and s.dining_table_id = v_table.id and s.status = 'open'
  for update of oi;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  -- The bill may have been generated while this waited for the dish: bill
  -- generation locks the dishes without changing them, so look again.
  if (select s.status from public.table_sessions s where s.id = v_item.session_id) <> 'open' then
    perform private.fail('NOT_FOUND');
  end if;

  select * into v_order from public.orders o where o.id = v_item.order_id;
  if v_order.client_device_id is distinct from v_device then
    perform private.fail('NOT_YOUR_ITEM');
  end if;
  if v_item.status <> 'placed' or v_order.status not in ('pending_approval', 'accepted') then
    perform private.fail('ITEM_NOT_CANCELLABLE');
  end if;

  select r.customer_cancel_window_seconds into v_window
  from public.restaurants r where r.id = v_table.restaurant_id;
  if v_window = 0 or now() > v_order.created_at + make_interval(secs => v_window) then
    perform private.fail('CANCEL_WINDOW_EXPIRED');
  end if;

  update public.order_items
  set status = 'cancelled', cancelled_at = now(), status_changed_at = now(), status_changed_by = null
  where id = v_item.id;

  perform private.write_audit(
    v_table.restaurant_id, 'customer', null, null, private.device_label(v_device),
    'order_item.cancelled', 'order_item', v_item.id,
    jsonb_build_object('status', v_item.status),
    jsonb_build_object('status', 'cancelled')
  );

  return jsonb_build_object('order_item_id', v_item.id, 'status', 'cancelled');
end;
$$;

revoke execute on function public.customer_cancel_item(text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.customer_cancel_item(text, text, uuid) to service_role;
