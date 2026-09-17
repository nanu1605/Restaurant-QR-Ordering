-- Waiter assignment (spec §9.3, §10.7): managers and owners assign, reassign
-- and unassign the waiter responsible for a table session. Every change keeps
-- the session's current-waiter columns and the history rows in step
-- (docs/DECISIONS.md P4-11) and is audited. Allowed while read-only: it only
-- organises service for tables that are already open (spec §10.6).
--
-- Error codes (P0001 message; DETAIL adds context):
--   SESSION_NOT_OPEN       the table's session was billed or closed
--   WAITER_NOT_AVAILABLE   the waiter is off duty or deleted (DETAIL = name)
--   WAITER_BUSY            at max_tables_per_waiter (DETAIL = their tables);
--                          the UI confirms and retries with p_force

-- Assign (or reassign) a waiter. If the session has orders waiting for
-- approval, assigning approves them too, so approval and assignment take one
-- tap (spec §10.7, docs/DECISIONS.md P4-12). A pending round whose dishes were
-- all cancelled isn't waiting (P3-5): it approves nothing, so the table's next
-- order still waits for staff. The waiter row is locked, so two
-- managers can't both give a waiter their last free slot.
create or replace function public.admin_assign_waiter(
  p_session_id uuid,
  p_waiter_id uuid,
  p_force boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_session public.table_sessions;
  v_waiter public.waiters;
  v_previous public.waiters;
  v_busy text[];
  v_max int;
  v_order public.orders;
  v_approved int := 0;
begin
  v_session := private.locked_session(v_ctx, p_session_id);
  if v_session.status <> 'open' then
    perform private.fail('SESSION_NOT_OPEN');
  end if;
  select * into v_waiter
  from public.waiters w
  where w.id = p_waiter_id and w.restaurant_id = v_ctx.restaurant_id
  for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  if not v_waiter.is_active or not v_waiter.on_duty then
    perform private.fail('WAITER_NOT_AVAILABLE', v_waiter.full_name);
  end if;
  if v_session.assigned_waiter_id = v_waiter.id then
    return jsonb_build_object(
      'session_id', v_session.id, 'waiter_id', v_waiter.id, 'changed', false, 'approved_orders', 0
    );
  end if;

  select r.max_tables_per_waiter into v_max from public.restaurants r where r.id = v_ctx.restaurant_id;
  v_busy := private.waiter_open_tables(v_ctx.restaurant_id, v_waiter.id, v_session.id);
  if cardinality(v_busy) >= v_max and not coalesce(p_force, false) then
    perform private.fail('WAITER_BUSY', array_to_string(v_busy, ', '));
  end if;

  if v_session.assigned_waiter_id is not null then
    select * into v_previous from public.waiters w where w.id = v_session.assigned_waiter_id;
    perform private.end_assignment(v_session.id, 'reassigned');
  end if;
  perform private.start_assignment(v_ctx, v_session.id, v_waiter.id);

  for v_order in
    select * from public.orders o
    where o.restaurant_id = v_session.restaurant_id and o.session_id = v_session.id
      and private.is_waiting(o)
    order by o.round_number
    for update
  loop
    update public.orders
    set status = 'accepted', decided_by = v_ctx.user_id, decided_at = now()
    where id = v_order.id;
    perform private.audit_as(
      v_ctx, 'order.approved', 'order', v_order.id,
      jsonb_build_object('status', v_order.status),
      jsonb_build_object('status', 'accepted', 'round_number', v_order.round_number, 'via', 'assignment')
    );
    v_approved := v_approved + 1;
  end loop;
  if v_approved > 0 and not v_session.is_approved then
    update public.table_sessions
    set is_approved = true, approved_by = v_ctx.user_id, approved_at = now()
    where id = v_session.id;
  end if;

  perform private.audit_as(
    v_ctx,
    case when v_previous.id is null then 'waiter.assigned' else 'waiter.reassigned' end,
    'table_session', v_session.id,
    case when v_previous.id is null then null
      else jsonb_build_object('waiter_id', v_previous.id, 'waiter_name', v_previous.full_name)
    end,
    jsonb_build_object(
      'waiter_id', v_waiter.id, 'waiter_name', v_waiter.full_name,
      'table', v_session.table_label_snapshot,
      'forced', cardinality(v_busy) >= v_max
    )
  );
  return jsonb_build_object(
    'session_id', v_session.id, 'waiter_id', v_waiter.id, 'changed', true,
    'approved_orders', v_approved
  );
end;
$$;

-- Back to Unassigned (spec §10.7).
create or replace function public.admin_unassign_waiter(p_session_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_session public.table_sessions;
  v_waiter public.waiters;
begin
  v_session := private.locked_session(v_ctx, p_session_id);
  if v_session.status <> 'open' then
    perform private.fail('SESSION_NOT_OPEN');
  end if;
  if v_session.assigned_waiter_id is null then
    return jsonb_build_object('session_id', v_session.id, 'changed', false);
  end if;

  select * into v_waiter from public.waiters w where w.id = v_session.assigned_waiter_id;
  perform private.end_assignment(v_session.id, 'manual');
  update public.table_sessions
  set assigned_waiter_id = null, assigned_at = null, assigned_by = null
  where id = v_session.id;

  perform private.audit_as(
    v_ctx, 'waiter.unassigned', 'table_session', v_session.id,
    jsonb_build_object('waiter_id', v_waiter.id, 'waiter_name', v_waiter.full_name),
    jsonb_build_object('waiter_id', null, 'table', v_session.table_label_snapshot)
  );
  return jsonb_build_object('session_id', v_session.id, 'changed', true);
end;
$$;

revoke execute on function public.admin_assign_waiter(uuid, uuid, boolean) from public, anon;
revoke execute on function public.admin_unassign_waiter(uuid) from public, anon;

grant execute on function public.admin_assign_waiter(uuid, uuid, boolean) to authenticated;
grant execute on function public.admin_unassign_waiter(uuid) to authenticated;
