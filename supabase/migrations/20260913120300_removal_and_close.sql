-- Removing dishes and whole rounds, and closing a table without a bill
-- (spec §9.3, §10.1, §10.8). Nothing is hard-deleted: removed dishes stay
-- visible struck through with who removed them and why, and every removal is
-- audited so the owner can spot misuse. Nothing changes once a session is
-- billed or closed (SESSION_NOT_OPEN). Allowed while read-only (spec §10.6).
--
-- Error codes (P0001 message; DETAIL adds context):
--   SESSION_NOT_OPEN   the table's session was billed or closed
--   ORDER_NOT_ACTIVE   the round was rejected or already removed
--   ITEM_NOT_ACTIVE    the dish was cancelled or already removed
--   REQUIRES_MANAGER   a served dish (unless the setting allows staff), or
--                      closing a table that has accepted dishes
--   REASON_REQUIRED    no reason given
--   INVALID_INPUT      DETAIL = the offending field

-- End the session's current waiter assignment (history row only; callers
-- decide what happens to the session's current-waiter columns). Returns the
-- waiter it ended, or null.
create or replace function private.end_assignment(
  p_session_id uuid,
  p_reason public.unassign_reason
)
returns uuid
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_waiter uuid;
begin
  update public.session_waiter_assignments
  set unassigned_at = now(), unassign_reason = p_reason
  where session_id = p_session_id and unassigned_at is null
  returning waiter_id into v_waiter;
  return v_waiter;
end;
$$;

revoke execute on function private.end_assignment(uuid, public.unassign_reason)
  from public, anon, authenticated;

-- ─── Remove a dish or reduce its quantity ───────────────────────────────────
-- Worker panel staff may remove dishes that aren't served yet; a served dish
-- needs a manager or owner unless staff_can_remove_served_items is on (spec
-- §10.8). A smaller quantity reduces the line in place; the whole quantity
-- marks the dish removed (docs/DECISIONS.md P4-8). Both are audited with the
-- before/after quantity and the reason.
create or replace function public.staff_remove_item(
  p_order_item_id uuid,
  p_quantity int,
  p_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member();
  v_reason text := private.reason(p_reason);
  v_item public.order_items;
  v_order public.orders;
  v_session public.table_sessions;
  v_staff_may_remove_served boolean;
  v_status public.order_item_status;
  v_quantity int;
begin
  if p_quantity is null or p_quantity < 1 then
    perform private.fail('INVALID_INPUT', 'quantity');
  end if;
  select * into v_item
  from public.order_items oi
  where oi.id = p_order_item_id and oi.restaurant_id = v_ctx.restaurant_id;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  v_session := private.locked_session(v_ctx, v_item.session_id);
  if v_session.status <> 'open' then
    perform private.fail('SESSION_NOT_OPEN');
  end if;
  select * into v_order from public.orders o where o.id = v_item.order_id;
  if v_order.status not in ('pending_approval', 'accepted') then
    perform private.fail('ORDER_NOT_ACTIVE');
  end if;
  select * into v_item from public.order_items oi where oi.id = p_order_item_id for update;
  if v_item.status in ('cancelled', 'removed') then
    perform private.fail('ITEM_NOT_ACTIVE');
  end if;
  if p_quantity > v_item.quantity then
    perform private.fail('INVALID_INPUT', 'quantity');
  end if;
  if v_item.status = 'served' and v_ctx.role not in ('owner', 'manager') then
    select r.staff_can_remove_served_items into v_staff_may_remove_served
    from public.restaurants r where r.id = v_ctx.restaurant_id;
    if not v_staff_may_remove_served then
      perform private.fail('REQUIRES_MANAGER');
    end if;
  end if;

  if p_quantity < v_item.quantity then
    v_status := v_item.status;
    v_quantity := v_item.quantity - p_quantity;
    update public.order_items set quantity = v_quantity where id = v_item.id;
  else
    v_status := 'removed';
    v_quantity := v_item.quantity;
    update public.order_items
    set status = 'removed', removed_at = now(), removed_by = v_ctx.user_id, removed_reason = v_reason,
        status_changed_at = now(), status_changed_by = v_ctx.user_id
    where id = v_item.id;
  end if;

  perform private.audit_as(
    v_ctx, 'order_item.removed', 'order_item', v_item.id,
    jsonb_build_object(
      'name', v_item.item_name_snapshot, 'variant', v_item.variant_name_snapshot,
      'status', v_item.status, 'quantity', v_item.quantity
    ),
    jsonb_build_object('status', v_status, 'quantity', v_quantity, 'removed_quantity', p_quantity),
    v_reason
  );
  return jsonb_build_object('order_item_id', v_item.id, 'status', v_status, 'quantity', v_quantity);
end;
$$;

-- ─── Delete a whole round (managers and owners) ─────────────────────────────
-- Every dish of the round that isn't already cancelled or removed is removed,
-- served ones included, and the round is marked removed (spec §9.3).
create or replace function public.admin_remove_order(p_order_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_reason text := private.reason(p_reason);
  v_order public.orders;
  v_session public.table_sessions;
  v_items jsonb;
  v_removed int;
begin
  select * into v_order
  from public.orders o
  where o.id = p_order_id and o.restaurant_id = v_ctx.restaurant_id;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  v_session := private.locked_session(v_ctx, v_order.session_id);
  if v_session.status <> 'open' then
    perform private.fail('SESSION_NOT_OPEN');
  end if;
  select * into v_order from public.orders o where o.id = p_order_id for update;
  if v_order.status not in ('pending_approval', 'accepted') then
    perform private.fail('ORDER_NOT_ACTIVE');
  end if;

  perform 1 from public.order_items oi
  where oi.restaurant_id = v_order.restaurant_id and oi.session_id = v_order.session_id
    and oi.order_id = v_order.id
  order by oi.id
  for update;
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id', oi.id, 'name', oi.item_name_snapshot, 'variant', oi.variant_name_snapshot,
             'quantity', oi.quantity, 'status', oi.status
           )
           order by oi.created_at, oi.item_name_snapshot, oi.id
         ), '[]'::jsonb)
  into v_items
  from public.order_items oi
  where oi.restaurant_id = v_order.restaurant_id and oi.session_id = v_order.session_id
    and oi.order_id = v_order.id and oi.status not in ('cancelled', 'removed');

  update public.order_items
  set status = 'removed', removed_at = now(), removed_by = v_ctx.user_id, removed_reason = v_reason,
      status_changed_at = now(), status_changed_by = v_ctx.user_id
  where restaurant_id = v_order.restaurant_id and session_id = v_order.session_id
    and order_id = v_order.id and status not in ('cancelled', 'removed');
  get diagnostics v_removed = row_count;
  update public.orders
  set status = 'removed', removed_by = v_ctx.user_id, removed_at = now(), removed_reason = v_reason
  where id = v_order.id;

  perform private.audit_as(
    v_ctx, 'order.removed', 'order', v_order.id,
    jsonb_build_object('status', v_order.status, 'round_number', v_order.round_number, 'items', v_items),
    jsonb_build_object('status', 'removed', 'removed_items', v_removed),
    v_reason
  );
  return jsonb_build_object('order_id', v_order.id, 'status', 'removed', 'removed_items', v_removed);
end;
$$;

-- ─── Close without a bill (spec §9.3, §10.1) ────────────────────────────────
-- Waiters can close a table that has no accepted dishes (a prank, or guests
-- who left before ordering anything real); anything else needs a manager.
-- Dishes still on their way are cancelled, served ones stay served, and the
-- waiter assignment ends so the waiter is free again. The dining table is
-- locked first so a customer order can't slip into the closing session.
create or replace function public.staff_close_session_unbilled(p_session_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager,waiter}');
  v_reason text := private.reason(p_reason);
  v_session public.table_sessions;
  v_cancelled int;
begin
  v_session := private.locked_session(v_ctx, p_session_id, true);
  if v_session.status <> 'open' then
    perform private.fail('SESSION_NOT_OPEN');
  end if;
  if v_ctx.role not in ('owner', 'manager') and exists (
    select 1
    from public.order_items oi
    join public.orders o on o.restaurant_id = oi.restaurant_id and o.id = oi.order_id
    where oi.restaurant_id = v_session.restaurant_id and oi.session_id = v_session.id
      and o.status = 'accepted'
      and oi.status in ('placed', 'preparing', 'ready', 'served')
  ) then
    perform private.fail('REQUIRES_MANAGER');
  end if;

  update public.order_items
  set status = 'cancelled', cancelled_at = now(),
      status_changed_at = now(), status_changed_by = v_ctx.user_id
  where restaurant_id = v_session.restaurant_id and session_id = v_session.id
    and status in ('placed', 'preparing', 'ready');
  get diagnostics v_cancelled = row_count;

  perform private.end_assignment(v_session.id, 'closed_unbilled');
  -- assigned_waiter_id stays as history; availability only counts open
  -- sessions (docs/DECISIONS.md P4-11).
  update public.table_sessions
  set status = 'closed_unbilled', closed_at = now(), closed_by = v_ctx.user_id, close_reason = v_reason
  where id = v_session.id;

  perform private.audit_as(
    v_ctx, 'session.closed_unbilled', 'table_session', v_session.id,
    jsonb_build_object(
      'status', v_session.status, 'table', v_session.table_label_snapshot,
      'assigned_waiter_id', v_session.assigned_waiter_id
    ),
    jsonb_build_object('status', 'closed_unbilled', 'cancelled_items', v_cancelled),
    v_reason
  );
  return jsonb_build_object(
    'session_id', v_session.id, 'status', 'closed_unbilled', 'cancelled_items', v_cancelled
  );
end;
$$;

revoke execute on function public.staff_remove_item(uuid, int, text) from public, anon;
revoke execute on function public.admin_remove_order(uuid, text) from public, anon;
revoke execute on function public.staff_close_session_unbilled(uuid, text) from public, anon;

grant execute on function public.staff_remove_item(uuid, int, text) to authenticated;
grant execute on function public.admin_remove_order(uuid, text) to authenticated;
grant execute on function public.staff_close_session_unbilled(uuid, text) to authenticated;
