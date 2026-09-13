-- Worker panel order functions (spec §9.3, §10.2, §10.3, §10.7, §10.8):
-- approve / reject a waiting order, move dishes forward, revert a step, and
-- place a staff order (a new round, or a full order that opens a session).
--
-- Every function works out the restaurant from the caller; ids from another
-- restaurant are NOT_FOUND (docs/DECISIONS.md P2-4). Lock order everywhere:
-- dining table → session → waiter → order → dishes (docs/DECISIONS.md P4-10).
-- All of these keep working while the restaurant is read-only except
-- staff_place_order: service carries on, but no new orders (spec §10.6).
--
-- Error codes (P0001 message; DETAIL adds context):
--   SESSION_NOT_OPEN       the table's session was billed or closed
--   ORDER_NOT_PENDING      approve/reject on an order that isn't waiting
--   ORDER_NOT_ACCEPTED     status changes on a waiting, rejected or removed order
--   ITEM_NOT_ACTIVE        the dish was cancelled or removed
--   INVALID_STATUS_CHANGE  moving a dish backwards (DETAIL = its current status)
--   REASON_REQUIRED        reject without a reason
--   ORDERING_UNAVAILABLE   staff order while read-only
--   ITEM_UNAVAILABLE       DETAIL = comma-separated menu_item ids
--   INVALID_INPUT          DETAIL = the offending field

-- ─── Helpers ────────────────────────────────────────────────────────────────
-- A reason for audit-relevant actions: 1–200 characters after tidying.
create or replace function private.reason(p_reason text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_reason text := private.tidy_text(p_reason);
begin
  if v_reason is null then
    perform private.fail('REASON_REQUIRED');
  end if;
  if length(v_reason) > 200 then
    perform private.fail('INVALID_INPUT', 'reason');
  end if;
  return v_reason;
end;
$$;

-- The caller's session p_session_id, locked. Functions that end a session pass
-- p_with_table so the dining table is locked first: a customer order (which
-- holds the table lock) can then never land in a session that is closing.
create or replace function private.locked_session(
  p_ctx private.member_context,
  p_session_id uuid,
  p_with_table boolean default false
)
returns public.table_sessions
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_session public.table_sessions;
begin
  select * into v_session
  from public.table_sessions s
  where s.id = p_session_id and s.restaurant_id = p_ctx.restaurant_id;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  if p_with_table then
    perform 1 from public.dining_tables t where t.id = v_session.dining_table_id for update;
  end if;
  select * into v_session from public.table_sessions s where s.id = p_session_id for update;
  return v_session;
end;
$$;

-- Labels of the open tables a waiter is handling (optionally leaving one
-- session out), in table order. Busy = at max_tables_per_waiter (spec §8.5).
create or replace function private.waiter_open_tables(
  p_restaurant_id uuid,
  p_waiter_id uuid,
  p_except_session uuid default null
)
returns text[]
language sql
stable
set search_path = ''
as $$
  select coalesce(array_agg(d.label order by d.sort_order, d.label), '{}')
  from public.table_sessions s
  join public.dining_tables d on d.restaurant_id = s.restaurant_id and d.id = s.dining_table_id
  where s.restaurant_id = p_restaurant_id
    and s.assigned_waiter_id = p_waiter_id
    and s.status = 'open'
    and s.id is distinct from p_except_session;
$$;

-- Start a waiter assignment: a history row plus the session's current-waiter
-- columns, always together (docs/DECISIONS.md P4-11).
create or replace function private.start_assignment(
  p_ctx private.member_context,
  p_session_id uuid,
  p_waiter_id uuid
)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  insert into public.session_waiter_assignments (restaurant_id, session_id, waiter_id, assigned_by)
  values (p_ctx.restaurant_id, p_session_id, p_waiter_id, p_ctx.user_id);
  update public.table_sessions
  set assigned_waiter_id = p_waiter_id, assigned_at = now(), assigned_by = p_ctx.user_id
  where id = p_session_id;
end;
$$;

-- Position of a dish status on the way to the table: placed 1 … served 4.
create or replace function private.item_step(p_status public.order_item_status)
returns int
language sql
immutable
set search_path = ''
as $$
  select array_position(
    array['placed', 'preparing', 'ready', 'served']::public.order_item_status[], p_status
  );
$$;

revoke execute on function private.reason(text) from public, anon, authenticated;
revoke execute on function private.locked_session(private.member_context, uuid, boolean)
  from public, anon, authenticated;
revoke execute on function private.waiter_open_tables(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function private.start_assignment(private.member_context, uuid, uuid)
  from public, anon, authenticated;
revoke execute on function private.item_step(public.order_item_status) from public, anon, authenticated;

-- ─── Approve / reject (spec §10.2) ──────────────────────────────────────────
-- Approving a waiting order accepts it and approves the session, so later
-- rounds from the table are accepted straight away. Approving twice is fine.
create or replace function public.staff_approve_order(p_order_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager,waiter}');
  v_order public.orders;
  v_session public.table_sessions;
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

  if v_order.status = 'accepted' then
    return jsonb_build_object('order_id', v_order.id, 'status', v_order.status, 'changed', false);
  end if;
  if v_order.status <> 'pending_approval' then
    perform private.fail('ORDER_NOT_PENDING');
  end if;

  update public.orders
  set status = 'accepted', decided_by = v_ctx.user_id, decided_at = now()
  where id = v_order.id;
  if not v_session.is_approved then
    update public.table_sessions
    set is_approved = true, approved_by = v_ctx.user_id, approved_at = now()
    where id = v_session.id;
  end if;

  perform private.audit_as(
    v_ctx, 'order.approved', 'order', v_order.id,
    jsonb_build_object('status', v_order.status),
    jsonb_build_object('status', 'accepted', 'round_number', v_order.round_number)
  );
  return jsonb_build_object('order_id', v_order.id, 'status', 'accepted', 'changed', true);
end;
$$;

-- Rejecting a waiting order cancels its dishes; the session stays unapproved,
-- so the table's next order waits for staff again (spec §10.2).
create or replace function public.staff_reject_order(p_order_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager,waiter}');
  v_reason text := private.reason(p_reason);
  v_order public.orders;
  v_session public.table_sessions;
  v_cancelled int;
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

  if v_order.status = 'rejected' then
    return jsonb_build_object('order_id', v_order.id, 'status', v_order.status, 'changed', false);
  end if;
  if v_order.status <> 'pending_approval' then
    perform private.fail('ORDER_NOT_PENDING');
  end if;

  update public.orders
  set status = 'rejected', decided_by = v_ctx.user_id, decided_at = now(), reject_reason = v_reason
  where id = v_order.id;
  update public.order_items
  set status = 'cancelled', cancelled_at = now(),
      status_changed_at = now(), status_changed_by = v_ctx.user_id
  where restaurant_id = v_order.restaurant_id and session_id = v_order.session_id
    and order_id = v_order.id and status = 'placed';
  get diagnostics v_cancelled = row_count;

  perform private.audit_as(
    v_ctx, 'order.rejected', 'order', v_order.id,
    jsonb_build_object('status', v_order.status),
    jsonb_build_object(
      'status', 'rejected', 'round_number', v_order.round_number, 'cancelled_items', v_cancelled
    ),
    v_reason
  );
  return jsonb_build_object('order_id', v_order.id, 'status', 'rejected', 'changed', true);
end;
$$;

-- ─── Dish status (spec §10.3) ───────────────────────────────────────────────
-- Forward only, skipping allowed (placed → served for drinks). Asking for the
-- status a dish already has is a no-op, so two devices tapping at once don't
-- see errors (docs/DECISIONS.md P4-7).
create or replace function public.staff_update_item_status(
  p_order_item_id uuid,
  p_status public.order_item_status
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member();
  v_item public.order_items;
  v_order public.orders;
  v_session public.table_sessions;
begin
  if p_status is null or p_status not in ('preparing', 'ready', 'served') then
    perform private.fail('INVALID_INPUT', 'status');
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
  if v_order.status <> 'accepted' then
    perform private.fail('ORDER_NOT_ACCEPTED');
  end if;
  select * into v_item from public.order_items oi where oi.id = p_order_item_id for update;
  if v_item.status in ('cancelled', 'removed') then
    perform private.fail('ITEM_NOT_ACTIVE');
  end if;

  if private.item_step(p_status) = private.item_step(v_item.status) then
    return jsonb_build_object('order_item_id', v_item.id, 'status', v_item.status, 'changed', false);
  end if;
  if private.item_step(p_status) < private.item_step(v_item.status) then
    perform private.fail('INVALID_STATUS_CHANGE', v_item.status::text);
  end if;

  update public.order_items
  set status = p_status,
      status_changed_at = now(),
      status_changed_by = v_ctx.user_id,
      served_at = case when p_status = 'served' then now() else served_at end,
      served_by = case when p_status = 'served' then v_ctx.user_id else served_by end
  where id = v_item.id;
  return jsonb_build_object('order_item_id', v_item.id, 'status', p_status, 'changed', true);
end;
$$;

-- "Mark all served" for one round: every dish still on its way becomes served.
create or replace function public.staff_mark_order_served(p_order_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member();
  v_order public.orders;
  v_session public.table_sessions;
  v_served int;
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
  if v_order.status <> 'accepted' then
    perform private.fail('ORDER_NOT_ACCEPTED');
  end if;

  perform 1 from public.order_items oi
  where oi.restaurant_id = v_order.restaurant_id and oi.session_id = v_order.session_id
    and oi.order_id = v_order.id and oi.status in ('placed', 'preparing', 'ready')
  order by oi.id
  for update;
  update public.order_items
  set status = 'served', served_at = now(), served_by = v_ctx.user_id,
      status_changed_at = now(), status_changed_by = v_ctx.user_id
  where restaurant_id = v_order.restaurant_id and session_id = v_order.session_id
    and order_id = v_order.id and status in ('placed', 'preparing', 'ready');
  get diagnostics v_served = row_count;

  return jsonb_build_object('order_id', v_order.id, 'served', v_served);
end;
$$;

-- One step back, managers and owners only (spec §10.3). Never from a
-- cancelled or removed dish; leaving `served` clears who served it.
create or replace function public.staff_revert_item_status(p_order_item_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_item public.order_items;
  v_order public.orders;
  v_session public.table_sessions;
  v_previous public.order_item_status;
begin
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
  if v_order.status <> 'accepted' then
    perform private.fail('ORDER_NOT_ACCEPTED');
  end if;
  select * into v_item from public.order_items oi where oi.id = p_order_item_id for update;
  if v_item.status in ('cancelled', 'removed') then
    perform private.fail('ITEM_NOT_ACTIVE');
  end if;
  if v_item.status = 'placed' then
    perform private.fail('INVALID_STATUS_CHANGE', v_item.status::text);
  end if;

  v_previous := case v_item.status
    when 'preparing' then 'placed'
    when 'ready' then 'preparing'
    else 'ready'
  end;
  update public.order_items
  set status = v_previous,
      status_changed_at = now(),
      status_changed_by = v_ctx.user_id,
      served_at = case when v_item.status = 'served' then null else served_at end,
      served_by = case when v_item.status = 'served' then null else served_by end
  where id = v_item.id;

  perform private.audit_as(
    v_ctx, 'order_item.status_reverted', 'order_item', v_item.id,
    jsonb_build_object('status', v_item.status),
    jsonb_build_object('status', v_previous)
  );
  return jsonb_build_object('order_item_id', v_item.id, 'status', v_previous);
end;
$$;

-- ─── Staff orders (spec §9.3, §10.8) ────────────────────────────────────────
-- Adds dishes to a table as a new round, or a full order for a free table
-- (which opens a session). Always accepted, and approves the session (spec
-- §10.2). If the caller's own waiter profile is on duty and free, an
-- unassigned table becomes theirs (spec §10.7, docs/DECISIONS.md P4-13).
-- The dining-table lock serialises this with customer orders at the same
-- table, so the two can never open two sessions.
create or replace function public.staff_place_order(
  p_dining_table_id uuid,
  p_items jsonb,
  p_idempotency_key text,
  p_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member();
  v_note text := private.tidy_text(p_note);
  v_table public.dining_tables;
  v_restaurant public.restaurants;
  v_order public.orders;
  v_session public.table_sessions;
  v_waiter public.waiters;
  v_lines jsonb;
  v_assigned uuid;
begin
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{8,100}$' then
    perform private.fail('INVALID_INPUT', 'idempotency_key');
  end if;

  select * into v_table
  from public.dining_tables t
  where t.id = p_dining_table_id and t.restaurant_id = v_ctx.restaurant_id and t.is_active
  for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;

  -- A retried submit gets back its round; the key only replays for the same
  -- staff member at the same table (docs/DECISIONS.md P4-15).
  select * into v_order
  from public.orders o
  where o.restaurant_id = v_table.restaurant_id and o.idempotency_key = p_idempotency_key;
  if found then
    select * into v_session from public.table_sessions s where s.id = v_order.session_id;
    if v_order.placed_via <> 'staff'
       or v_order.placed_by_user_id is distinct from v_ctx.user_id
       or v_session.dining_table_id <> v_table.id then
      perform private.fail('INVALID_INPUT', 'idempotency_key');
    end if;
    return jsonb_build_object(
      'order_id', v_order.id,
      'session_id', v_order.session_id,
      'round_number', v_order.round_number,
      'status', v_order.status,
      'replayed', true,
      'assigned_waiter_id', v_session.assigned_waiter_id
    );
  end if;

  if (select a.state from public.restaurant_access(v_table.restaurant_id) a) is distinct from 'full' then
    perform private.fail('ORDERING_UNAVAILABLE');
  end if;
  select * into v_restaurant from public.restaurants r where r.id = v_table.restaurant_id;

  v_lines := private.parse_order_lines(p_items, v_note);
  perform private.assert_orderable(v_table.restaurant_id, v_lines);

  select * into v_session
  from public.table_sessions s
  where s.dining_table_id = v_table.id and s.status = 'open'
  for update;
  if not found then
    insert into public.table_sessions (
      restaurant_id, dining_table_id, table_label_snapshot, is_approved, approved_by, approved_at
    )
    values (v_table.restaurant_id, v_table.id, v_table.label, true, v_ctx.user_id, now())
    returning * into v_session;
  elsif not v_session.is_approved then
    -- Staff at the table vouch for it; rounds already waiting stay with staff.
    update public.table_sessions
    set is_approved = true, approved_by = v_ctx.user_id, approved_at = now()
    where id = v_session.id
    returning * into v_session;
  end if;

  begin
    insert into public.orders (
      restaurant_id, session_id, round_number, status, placed_via,
      placed_by_user_id, idempotency_key, customer_note
    )
    values (
      v_table.restaurant_id,
      v_session.id,
      (select coalesce(max(o.round_number), 0) + 1 from public.orders o where o.session_id = v_session.id),
      'accepted',
      'staff',
      v_ctx.user_id,
      p_idempotency_key,
      v_note
    )
    returning * into v_order;
  exception when unique_violation then
    perform private.fail('INVALID_INPUT', 'idempotency_key');
  end;

  perform private.insert_order_items(v_table.restaurant_id, v_order.id, v_session.id, v_lines);

  v_assigned := v_session.assigned_waiter_id;
  if v_assigned is null then
    select * into v_waiter
    from public.waiters w
    where w.restaurant_id = v_table.restaurant_id
      and w.member_id = v_ctx.member_id
      and w.is_active and w.on_duty
    for update;
    if found
       and cardinality(private.waiter_open_tables(v_table.restaurant_id, v_waiter.id, v_session.id))
         < v_restaurant.max_tables_per_waiter then
      perform private.start_assignment(v_ctx, v_session.id, v_waiter.id);
      v_assigned := v_waiter.id;
      perform private.audit_as(
        v_ctx, 'waiter.assigned', 'table_session', v_session.id,
        null,
        jsonb_build_object(
          'waiter_id', v_waiter.id, 'waiter_name', v_waiter.full_name,
          'table', v_table.label, 'auto', true
        )
      );
    end if;
  end if;

  return jsonb_build_object(
    'order_id', v_order.id,
    'session_id', v_session.id,
    'round_number', v_order.round_number,
    'status', v_order.status,
    'replayed', false,
    'assigned_waiter_id', v_assigned
  );
end;
$$;

revoke execute on function public.staff_approve_order(uuid) from public, anon;
revoke execute on function public.staff_reject_order(uuid, text) from public, anon;
revoke execute on function public.staff_update_item_status(uuid, public.order_item_status) from public, anon;
revoke execute on function public.staff_mark_order_served(uuid) from public, anon;
revoke execute on function public.staff_revert_item_status(uuid) from public, anon;
revoke execute on function public.staff_place_order(uuid, jsonb, text, text) from public, anon;

grant execute on function public.staff_approve_order(uuid) to authenticated;
grant execute on function public.staff_reject_order(uuid, text) to authenticated;
grant execute on function public.staff_update_item_status(uuid, public.order_item_status) to authenticated;
grant execute on function public.staff_mark_order_served(uuid) to authenticated;
grant execute on function public.staff_revert_item_status(uuid) to authenticated;
grant execute on function public.staff_place_order(uuid, jsonb, text, text) to authenticated;
