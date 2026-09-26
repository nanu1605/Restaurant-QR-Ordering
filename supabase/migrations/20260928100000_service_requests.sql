-- Table service (spec §8.7, §9.3, §19 Phase 9; docs/DECISIONS.md P9-1…P9-3):
-- customers call a waiter or ask for the bill from their phone, staff see it on
-- the board and acknowledge or finish it, and staff can move a table's guests
-- to a free table.
--
-- Error codes (P0001 message; DETAIL adds context):
--   TABLE_NOT_FOUND   the QR code is unknown or its table is switched off
--   NOTHING_TO_BILL   a bill request before the table has an accepted order
--   RATE_LIMITED      more than 10 requests from one table within an hour
--   TABLE_BUSY        moving to a table that already has guests (or the same one)
--   SESSION_NOT_OPEN  the session was billed, closed or moved meanwhile
--   NOT_FOUND         an id from another restaurant, or an inactive target table
--   INVALID_INPUT     DETAIL = the offending field

create type public.service_request_type as enum ('call_waiter', 'request_bill');
create type public.service_request_status as enum ('open', 'acknowledged', 'resolved');

create table public.service_requests (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id),
  dining_table_id uuid not null,
  -- The table's open session when the request was made; a call before the
  -- first order has none.
  session_id uuid,
  type public.service_request_type not null,
  status public.service_request_status not null default 'open',
  client_device_id text,
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (restaurant_id, id),
  foreign key (restaurant_id, dining_table_id) references public.dining_tables (restaurant_id, id),
  foreign key (restaurant_id, session_id) references public.table_sessions (restaurant_id, id),
  constraint service_requests_resolved_at_matches_status
    check ((status = 'resolved') = (resolved_at is not null))
);

-- One active call and one active bill request per table: tapping again from
-- any phone returns the same request.
create unique index service_requests_one_active
  on public.service_requests (dining_table_id, type) where status <> 'resolved';
create index service_requests_table_created_idx
  on public.service_requests (restaurant_id, dining_table_id, created_at);

create trigger set_updated_at before update on public.service_requests
  for each row execute function private.set_updated_at();

alter table public.service_requests enable row level security;
revoke insert, update, delete on public.service_requests from authenticated;
create policy "members read service requests" on public.service_requests
  for select to authenticated
  using (restaurant_id in (select private.my_restaurant_ids()));

-- Staff screens refetch when a request arrives or changes (spec §12).
alter publication supabase_realtime add table public.service_requests;

-- ─── Ending a session finishes its table's requests ─────────────────────────
-- Same as before, plus: a billed or closed table is free again, so its calls
-- and bill requests are done, including a call made before the first order.
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

  if p_reason in ('billed', 'closed_unbilled') then
    update public.service_requests r
    set status = 'resolved', resolved_at = now(), resolved_by = (select auth.uid())
    from public.table_sessions s
    where s.id = p_session_id
      and r.restaurant_id = s.restaurant_id
      and r.dining_table_id = s.dining_table_id
      and r.status <> 'resolved';
  end if;
  return v_waiter;
end;
$$;

revoke execute on function private.end_assignment(uuid, public.unassign_reason)
  from public, anon, authenticated;

-- ─── Customer: call a waiter or ask for the bill ────────────────────────────
-- A call works any time, even before ordering; a bill request needs an
-- accepted order at the table. Both work while the restaurant is read-only, so
-- a customer is never stuck. At most 10 per table per hour, so a photo of the
-- QR code can't keep every tablet chiming.
create or replace function public.customer_create_service_request(
  p_qr_token text,
  p_device_id text,
  p_type text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_device text := private.customer_device(p_device_id);
  v_type public.service_request_type;
  v_table public.dining_tables;
  v_session_id uuid;
  v_request public.service_requests;
begin
  if p_type is null or p_type not in ('call_waiter', 'request_bill') then
    perform private.fail('INVALID_INPUT', 'type');
  end if;
  v_type := p_type::public.service_request_type;
  if p_qr_token is null or p_qr_token !~ '^[A-Za-z0-9]{16}$' then
    perform private.fail('TABLE_NOT_FOUND');
  end if;

  -- The table lock serialises taps from every phone at the table, and a
  -- session opening or closing meanwhile.
  select * into v_table
  from public.dining_tables t
  where t.qr_token = p_qr_token and t.is_active
  for update;
  if not found then
    perform private.fail('TABLE_NOT_FOUND');
  end if;

  select s.id into v_session_id
  from public.table_sessions s
  where s.dining_table_id = v_table.id and s.status = 'open';

  if v_type = 'request_bill' and not exists (
    select 1 from public.orders o
    where o.restaurant_id = v_table.restaurant_id
      and o.session_id = v_session_id
      and o.status = 'accepted'
  ) then
    perform private.fail('NOTHING_TO_BILL');
  end if;

  select * into v_request
  from public.service_requests r
  where r.dining_table_id = v_table.id and r.type = v_type and r.status <> 'resolved';
  if not found then
    if (select count(*) from public.service_requests r
        where r.restaurant_id = v_table.restaurant_id
          and r.dining_table_id = v_table.id
          and r.created_at > now() - interval '1 hour') >= 10 then
      perform private.fail('RATE_LIMITED');
    end if;
    insert into public.service_requests (
      restaurant_id, dining_table_id, session_id, type, client_device_id
    )
    values (v_table.restaurant_id, v_table.id, v_session_id, v_type, v_device)
    returning * into v_request;
  end if;

  return jsonb_build_object('id', v_request.id, 'type', v_request.type, 'status', v_request.status);
end;
$$;

revoke execute on function public.customer_create_service_request(text, text, text)
  from public, anon, authenticated;
grant execute on function public.customer_create_service_request(text, text, text) to service_role;

-- ─── Staff: acknowledge or finish a request ─────────────────────────────────
-- Floor staff only (the kitchen doesn't see requests). Forward only; a second
-- tap from another tablet changes nothing. Not audited: it's a notification.
create or replace function public.staff_update_service_request(
  p_request_id uuid,
  p_status text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager,waiter}');
  v_status public.service_request_status;
  v_request public.service_requests;
begin
  if p_status is null or p_status not in ('acknowledged', 'resolved') then
    perform private.fail('INVALID_INPUT', 'status');
  end if;
  v_status := p_status::public.service_request_status;

  select * into v_request
  from public.service_requests r
  where r.id = p_request_id and r.restaurant_id = v_ctx.restaurant_id
  for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  if v_request.status = 'resolved' or v_request.status = v_status then
    return jsonb_build_object('id', v_request.id, 'status', v_request.status, 'changed', false);
  end if;

  update public.service_requests r
  set status = v_status,
      acknowledged_by = case when v_status = 'acknowledged' then v_ctx.user_id else r.acknowledged_by end,
      acknowledged_at = case when v_status = 'acknowledged' then now() else r.acknowledged_at end,
      resolved_by = case when v_status = 'resolved' then v_ctx.user_id end,
      resolved_at = case when v_status = 'resolved' then now() end
  where r.id = v_request.id
  returning * into v_request;

  return jsonb_build_object('id', v_request.id, 'status', v_request.status, 'changed', true);
end;
$$;

revoke execute on function public.staff_update_service_request(uuid, text)
  from public, anon, authenticated;
grant execute on function public.staff_update_service_request(uuid, text) to authenticated;

-- ─── Staff: move a table's guests to a free table ───────────────────────────
-- Both tables are locked in id order (deadlock-free), then the session, which
-- must still be open at the table it was read from. The guests' requests
-- follow them; one the new table already has is finished instead. Allowed
-- while read-only (no new session starts). Orders keep their session, so the
-- bill shows the new table.
create or replace function public.staff_move_session(
  p_session_id uuid,
  p_target_table_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager,waiter}');
  v_source uuid;
  v_target public.dining_tables;
  v_session public.table_sessions;
begin
  select s.dining_table_id into v_source
  from public.table_sessions s
  where s.id = p_session_id and s.restaurant_id = v_ctx.restaurant_id;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;

  perform 1
  from public.dining_tables t
  where t.restaurant_id = v_ctx.restaurant_id and t.id in (v_source, p_target_table_id)
  order by t.id
  for update;

  select * into v_target
  from public.dining_tables t
  where t.id = p_target_table_id and t.restaurant_id = v_ctx.restaurant_id and t.is_active;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;

  select * into v_session from public.table_sessions s where s.id = p_session_id for update;
  if v_session.status <> 'open' or v_session.dining_table_id <> v_source then
    perform private.fail('SESSION_NOT_OPEN');
  end if;
  if v_target.id = v_source or exists (
    select 1 from public.table_sessions s
    where s.dining_table_id = v_target.id and s.status = 'open'
  ) then
    perform private.fail('TABLE_BUSY', v_target.label);
  end if;

  update public.table_sessions
  set dining_table_id = v_target.id, table_label_snapshot = v_target.label
  where id = v_session.id;

  update public.service_requests r
  set status = 'resolved', resolved_at = now(), resolved_by = v_ctx.user_id
  where r.dining_table_id = v_source
    and r.status <> 'resolved'
    and exists (
      select 1 from public.service_requests t
      where t.dining_table_id = v_target.id and t.type = r.type and t.status <> 'resolved'
    );
  update public.service_requests r
  set dining_table_id = v_target.id
  where r.dining_table_id = v_source and r.status <> 'resolved';

  perform private.audit_as(
    v_ctx, 'session.moved', 'table_session', v_session.id,
    jsonb_build_object('table', v_session.table_label_snapshot, 'dining_table_id', v_source),
    jsonb_build_object('table', v_target.label, 'dining_table_id', v_target.id)
  );

  return jsonb_build_object('session_id', v_session.id, 'table_id', v_target.id, 'table', v_target.label);
end;
$$;

revoke execute on function public.staff_move_session(uuid, uuid) from public, anon, authenticated;
grant execute on function public.staff_move_session(uuid, uuid) to authenticated;

-- ─── The board carries the active requests ──────────────────────────────────
-- Same board, plus the tables' active requests (none for the kitchen).
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
  return private.board_json(v_ctx.restaurant_id, v_ctx.role, v_ctx.member_id)
    || jsonb_build_object('requests', case when v_ctx.role = 'kitchen' then '[]'::jsonb else coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', r.id, 'table_id', r.dining_table_id, 'type', r.type, 'status', r.status,
          'created_at', r.created_at
        )
        order by r.created_at
      )
      from public.service_requests r
      where r.restaurant_id = v_ctx.restaurant_id and r.status <> 'resolved'
    ), '[]'::jsonb) end);
end;
$$;

-- ─── Switching a table off finishes its requests ────────────────────────────
-- Same as before (20260913120500), plus the requests of a table switched off.
create or replace function public.admin_update_table(p_table_id uuid, p_patch jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_table public.dining_tables%rowtype;
  v_label text;
  v_active boolean;
  v_max_tables int;
  v_max_staff int;
  v_count int;
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  perform private.assert_keys(p_patch, array['label', 'is_active']);
  perform 1 from public.restaurants r where r.id = v_ctx.restaurant_id for no key update;

  select * into v_table from public.dining_tables d
    where d.id = p_table_id and d.restaurant_id = v_ctx.restaurant_id
    for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;

  if p_patch ? 'label' then
    v_label := private.tidy_text(private.json_text(p_patch, 'label'));
    if v_label is null or length(v_label) > 30 then
      perform private.fail('INVALID_TABLE_LABEL');
    end if;
  end if;
  if p_patch ? 'is_active' then
    v_active := private.json_bool(p_patch, 'is_active');
  end if;

  if v_active is false and v_table.is_active and exists (
    select 1 from public.table_sessions s
    where s.dining_table_id = p_table_id and s.status = 'open'
  ) then
    perform private.fail('TABLE_HAS_OPEN_SESSION');
  end if;

  if v_active is true and not v_table.is_active then
    select l.max_tables, l.max_staff into v_max_tables, v_max_staff
      from private.plan_limits(v_ctx.restaurant_id) as l;
    select count(*) into v_count
      from public.dining_tables d
      where d.restaurant_id = v_ctx.restaurant_id and d.is_active;
    if v_max_tables is not null and v_count + 1 > v_max_tables then
      perform private.fail('PLAN_LIMIT_TABLES', v_max_tables::text);
    end if;
  end if;

  begin
    update public.dining_tables d
      set label = coalesce(v_label, d.label),
          is_active = coalesce(v_active, d.is_active)
      where d.id = p_table_id;
  exception when unique_violation then
    perform private.fail('TABLE_LABEL_TAKEN', coalesce(v_label, v_table.label));
  end;
  -- A switched-off table leaves the board: its calls are finished rather than
  -- left waiting unseen (P9-1).
  if v_active is false and v_table.is_active then
    update public.service_requests r
    set status = 'resolved', resolved_at = now(), resolved_by = v_ctx.user_id
    where r.dining_table_id = p_table_id and r.status <> 'resolved';
  end if;
end;
$$;

revoke execute on function public.admin_update_table(uuid, jsonb) from public, anon;
grant execute on function public.admin_update_table(uuid, jsonb) to authenticated;

-- ─── Reordering tables locks them in id order ───────────────────────────────
-- Same as before (20260912095809), plus the lock order a move uses.
create or replace function public.admin_reorder(
  p_kind text,
  p_ids uuid[],
  p_category_id uuid default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_n int := coalesce(cardinality(p_ids), 0);
  v_found int;
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  if v_n = 0 or v_n > 500 or (select count(distinct x) from unnest(p_ids) as x) <> v_n then
    perform private.fail('INVALID_INPUT');
  end if;

  case p_kind
    when 'categories' then
      select count(*) into v_found from public.menu_categories c
        where c.restaurant_id = v_ctx.restaurant_id and c.id = any (p_ids);
      if v_found <> v_n then
        perform private.fail('NOT_FOUND');
      end if;
      update public.menu_categories c
        set sort_order = o.ord
        from (
          select t.id, t.ord::int as ord from unnest(p_ids) with ordinality as t(id, ord)
          union all
          select r.id, (v_n + row_number() over (order by r.sort_order, r.created_at))::int
          from public.menu_categories r
          where r.restaurant_id = v_ctx.restaurant_id and r.id <> all (p_ids)
        ) as o
        where c.id = o.id and c.sort_order is distinct from o.ord;

    when 'items' then
      if p_category_id is null then
        perform private.fail('INVALID_INPUT', 'category_id');
      end if;
      select count(*) into v_found from public.menu_items i
        where i.restaurant_id = v_ctx.restaurant_id
          and i.category_id = p_category_id
          and i.id = any (p_ids);
      if v_found <> v_n then
        perform private.fail('NOT_FOUND');
      end if;
      update public.menu_items i
        set sort_order = o.ord
        from (
          select t.id, t.ord::int as ord from unnest(p_ids) with ordinality as t(id, ord)
          union all
          select r.id, (v_n + row_number() over (order by r.sort_order, r.created_at))::int
          from public.menu_items r
          where r.restaurant_id = v_ctx.restaurant_id
            and r.category_id = p_category_id
            and r.id <> all (p_ids)
        ) as o
        where i.id = o.id and i.sort_order is distinct from o.ord;

    when 'tables' then
      -- Table locks in id order, like staff_move_session, so the two never deadlock.
      perform 1 from public.dining_tables d
        where d.restaurant_id = v_ctx.restaurant_id
        order by d.id
        for update;
      select count(*) into v_found from public.dining_tables d
        where d.restaurant_id = v_ctx.restaurant_id and d.id = any (p_ids);
      if v_found <> v_n then
        perform private.fail('NOT_FOUND');
      end if;
      update public.dining_tables d
        set sort_order = o.ord
        from (
          select t.id, t.ord::int as ord from unnest(p_ids) with ordinality as t(id, ord)
          union all
          select r.id, (v_n + row_number() over (order by r.sort_order, r.created_at))::int
          from public.dining_tables r
          where r.restaurant_id = v_ctx.restaurant_id and r.id <> all (p_ids)
        ) as o
        where d.id = o.id and d.sort_order is distinct from o.ord;

    else
      perform private.fail('INVALID_INPUT', 'kind');
  end case;
end;
$$;
