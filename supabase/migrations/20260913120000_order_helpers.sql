-- Order helpers shared by customer and staff ordering (spec §9.3, §10.2).
-- customer_place_order is recreated on top of them with the same behaviour;
-- staff_place_order uses the same payload rules, orderable check and price
-- snapshot, and the live board uses the same "waiting for approval" rule
-- (docs/DECISIONS.md P3-5, P4-5).

-- ─── Payload ────────────────────────────────────────────────────────────────
-- An order payload: 1–30 lines of { menu_item_id, variant_id?, quantity, note? }
-- plus the order note (already tidied, ≤ 200). Returns the lines normalised:
-- quantity 1–20, line notes tidied (≤ 120, empty → null), variant_id null when
-- absent. INVALID_INPUT with the offending field otherwise.
create or replace function private.parse_order_lines(p_items jsonb, p_note text)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_line jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_quantity bigint;
  v_line_note text;
begin
  if jsonb_typeof(p_items) is distinct from 'array' then
    perform private.fail('INVALID_INPUT', 'items');
  end if;
  if jsonb_array_length(p_items) not between 1 and 30 then
    perform private.fail('INVALID_INPUT', 'items');
  end if;
  if length(p_note) > 200 then
    perform private.fail('INVALID_INPUT', 'note');
  end if;
  for v_line in select value from jsonb_array_elements(p_items) loop
    perform private.assert_keys(v_line, array['menu_item_id', 'variant_id', 'quantity', 'note']);
    v_quantity := private.json_int(v_line, 'quantity');
    if v_quantity not between 1 and 20 then
      perform private.fail('INVALID_INPUT', 'quantity');
    end if;
    v_line_note := private.tidy_text(private.json_text(v_line, 'note'));
    if length(v_line_note) > 120 then
      perform private.fail('INVALID_INPUT', 'note');
    end if;
    v_lines := v_lines || jsonb_build_object(
      'menu_item_id', private.json_uuid(v_line, 'menu_item_id'),
      'variant_id', case
        when jsonb_typeof(v_line -> 'variant_id') is null or v_line -> 'variant_id' = 'null'::jsonb
          then null
        else private.json_uuid(v_line, 'variant_id')
      end,
      'quantity', v_quantity,
      'note', v_line_note
    );
  end loop;
  return v_lines;
end;
$$;

-- Every line must be orderable right now. Unknown, hidden, out-of-stock and
-- other restaurants' dishes look the same, as do option mismatches (the dish
-- gained or lost options, or the chosen option was removed): ITEM_UNAVAILABLE
-- with the affected menu_item ids (comma-separated) so the UI can name them.
create or replace function private.assert_orderable(p_restaurant_id uuid, p_lines jsonb)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare
  v_unavailable text;
begin
  select string_agg(distinct l.menu_item_id::text, ',')
  into v_unavailable
  from jsonb_to_recordset(p_lines) as l(menu_item_id uuid, variant_id uuid)
  where not exists (
    select 1
    from public.menu_items i
    join public.menu_categories c on c.restaurant_id = i.restaurant_id and c.id = i.category_id
    where i.restaurant_id = p_restaurant_id
      and i.id = l.menu_item_id
      and i.is_active and i.is_available and c.is_active
      and case
        when l.variant_id is null then not exists (
          select 1 from public.menu_item_variants v
          where v.restaurant_id = i.restaurant_id and v.menu_item_id = i.id and v.is_active
        )
        else exists (
          select 1 from public.menu_item_variants v
          where v.restaurant_id = i.restaurant_id and v.menu_item_id = i.id
            and v.id = l.variant_id and v.is_active
        )
      end
  );
  if v_unavailable is not null then
    perform private.fail('ITEM_UNAVAILABLE', v_unavailable);
  end if;
end;
$$;

-- The round's dishes with names, option names, food types and prices
-- snapshotted from the database (spec §5.1), never from the client.
create or replace function private.insert_order_items(
  p_restaurant_id uuid,
  p_order_id uuid,
  p_session_id uuid,
  p_lines jsonb
)
returns void
language sql
volatile
set search_path = ''
as $$
  insert into public.order_items (
    restaurant_id, order_id, session_id, menu_item_id, variant_id,
    item_name_snapshot, variant_name_snapshot, food_type_snapshot,
    unit_price_paise, quantity, note
  )
  select
    p_restaurant_id, p_order_id, p_session_id, i.id, v.id,
    i.name, v.name, i.food_type,
    coalesce(v.price_paise, i.price_paise), l.quantity, l.note
  from jsonb_to_recordset(p_lines) as l(menu_item_id uuid, variant_id uuid, quantity int, note text)
  join public.menu_items i on i.restaurant_id = p_restaurant_id and i.id = l.menu_item_id
  left join public.menu_item_variants v
    on v.restaurant_id = i.restaurant_id and v.menu_item_id = i.id and v.id = l.variant_id;
$$;

-- "Waiting for approval": a pending order that still has a dish nobody has
-- cancelled. A pending order whose dishes the customer all cancelled needs no
-- decision (docs/DECISIONS.md P3-5): it doesn't count towards the waiting cap,
-- doesn't show as "Needs approval" and won't block billing.
create or replace function private.is_waiting(p_order public.orders)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_order.status = 'pending_approval'
    and exists (
      select 1 from public.order_items oi
      where oi.restaurant_id = p_order.restaurant_id
        and oi.session_id = p_order.session_id
        and oi.order_id = p_order.id
        and oi.status = 'placed'
    );
$$;

revoke execute on function private.parse_order_lines(jsonb, text) from public, anon, authenticated;
revoke execute on function private.assert_orderable(uuid, jsonb) from public, anon, authenticated;
revoke execute on function private.insert_order_items(uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
revoke execute on function private.is_waiting(public.orders) from public, anon, authenticated;

-- ─── customer_place_order, on the shared helpers ───────────────────────────
-- Same contract and checks, in the same order, as before.
create or replace function public.customer_place_order(
  p_qr_token text,
  p_device_id text,
  p_idempotency_key text,
  p_items jsonb,
  p_note text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_device text := private.customer_device(p_device_id);
  v_note text := private.tidy_text(p_note);
  v_table public.dining_tables;
  v_restaurant public.restaurants;
  v_order public.orders;
  v_session public.table_sessions;
  v_lines jsonb;
  v_status public.order_status;
begin
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{8,100}$' then
    perform private.fail('INVALID_INPUT', 'idempotency_key');
  end if;
  if p_qr_token is null or p_qr_token !~ '^[A-Za-z0-9]{16}$' then
    perform private.fail('TABLE_NOT_FOUND');
  end if;

  -- The table row lock serialises every order for this table (customer and
  -- staff), so concurrent first orders open exactly one session and round
  -- numbers never clash.
  select * into v_table
  from public.dining_tables t
  where t.qr_token = p_qr_token and t.is_active
  for update;
  if not found then
    perform private.fail('TABLE_NOT_FOUND');
  end if;

  -- A retried submit gets back the order it already created (spec §9.3), even
  -- if the menu has changed since. The key only replays for the same device
  -- and table.
  select * into v_order
  from public.orders o
  where o.restaurant_id = v_table.restaurant_id and o.idempotency_key = p_idempotency_key;
  if found then
    if v_order.client_device_id is distinct from v_device
       or not exists (
         select 1 from public.table_sessions s
         where s.id = v_order.session_id and s.dining_table_id = v_table.id
       ) then
      perform private.fail('INVALID_INPUT', 'idempotency_key');
    end if;
    return jsonb_build_object(
      'order_id', v_order.id,
      'round_number', v_order.round_number,
      'status', v_order.status,
      'replayed', true
    );
  end if;

  if (select a.state from public.restaurant_access(v_table.restaurant_id) a) is distinct from 'full' then
    perform private.fail('ORDERING_UNAVAILABLE');
  end if;
  select * into v_restaurant from public.restaurants r where r.id = v_table.restaurant_id;

  v_lines := private.parse_order_lines(p_items, v_note);

  -- Rate limits (spec §9.4). Only customer orders count. The "3 waiting for
  -- approval" cap applies only when this order would wait too (approval on and
  -- the table's open session not yet approved).
  if (select count(*) from public.orders o
      where o.client_device_id = v_device and o.created_at > now() - interval '1 minute') >= 5
     or (select count(*) from public.orders o
         where o.client_device_id = v_device and o.created_at > now() - interval '1 hour') >= 30
     or (select count(*)
         from public.orders o
         join public.table_sessions s on s.restaurant_id = o.restaurant_id and s.id = o.session_id
         where o.restaurant_id = v_table.restaurant_id
           and o.placed_via = 'customer'
           and o.created_at > now() - interval '10 minutes'
           and s.dining_table_id = v_table.id) >= 10
     or v_restaurant.require_first_order_approval and (select count(*)
         from public.orders o
         join public.table_sessions s on s.restaurant_id = o.restaurant_id and s.id = o.session_id
         where s.dining_table_id = v_table.id
           and s.status = 'open'
           and not s.is_approved
           and private.is_waiting(o)) >= 3 then
    perform private.fail('RATE_LIMITED');
  end if;

  perform private.assert_orderable(v_table.restaurant_id, v_lines);

  -- Join the table's open session or open one (spec §10.1). Locked (after the
  -- table, docs/DECISIONS.md P4-10) so an approval or waiter assignment in
  -- flight finishes first and the round sees whether the session is approved.
  select * into v_session
  from public.table_sessions s
  where s.dining_table_id = v_table.id and s.status = 'open'
  for update;
  if not found then
    insert into public.table_sessions (
      restaurant_id, dining_table_id, table_label_snapshot, is_approved, approved_at
    )
    values (
      v_table.restaurant_id, v_table.id, v_table.label,
      not v_restaurant.require_first_order_approval,
      case when v_restaurant.require_first_order_approval then null else now() end
    )
    returning * into v_session;
  elsif not v_restaurant.require_first_order_approval and not v_session.is_approved then
    -- Approval was switched off while this session waited: new orders are
    -- accepted from now on (rounds already waiting stay with staff to decide).
    update public.table_sessions set is_approved = true, approved_at = now()
    where id = v_session.id
    returning * into v_session;
  end if;

  -- First-order approval (spec §10.2).
  v_status := case
    when v_restaurant.require_first_order_approval and not v_session.is_approved
      then 'pending_approval'
    else 'accepted'
  end;

  begin
    insert into public.orders (
      restaurant_id, session_id, round_number, status, placed_via,
      client_device_id, idempotency_key, customer_note
    )
    values (
      v_table.restaurant_id,
      v_session.id,
      (select coalesce(max(o.round_number), 0) + 1 from public.orders o where o.session_id = v_session.id),
      v_status,
      'customer',
      v_device,
      p_idempotency_key,
      v_note
    )
    returning * into v_order;
  exception when unique_violation then
    -- The same key already used at another table of this restaurant.
    perform private.fail('INVALID_INPUT', 'idempotency_key');
  end;

  perform private.insert_order_items(v_table.restaurant_id, v_order.id, v_session.id, v_lines);

  return jsonb_build_object(
    'order_id', v_order.id,
    'round_number', v_order.round_number,
    'status', v_order.status,
    'replayed', false
  );
end;
$$;

revoke execute on function public.customer_place_order(text, text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.customer_place_order(text, text, text, jsonb, text) to service_role;
