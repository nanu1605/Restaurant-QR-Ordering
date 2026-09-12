-- Customer ordering from a table QR (spec §9.2–§9.4, §10.1–§10.3, §13.1).
-- Customers never talk to the database directly: server actions call these
-- functions with the service role, so EXECUTE goes to service_role only
-- (spec §5.1). Possession of a table's qr_token is the customer's credential;
-- the device id comes from the signed `cid` cookie.
--
-- Error codes (P0001 message; DETAIL adds context):
--   TABLE_NOT_FOUND        unknown token, or the table is switched off
--   ORDERING_UNAVAILABLE   restaurant is read-only (spec §10.6)
--   ITEM_UNAVAILABLE       DETAIL = comma-separated menu_item ids to drop from the cart
--   RATE_LIMITED           spec §9.4
--   NOT_FOUND / NOT_YOUR_ITEM / ITEM_NOT_CANCELLABLE / CANCEL_WINDOW_EXPIRED   cancellation
--   INVALID_INPUT          DETAIL = the offending field

-- ─── Indexes for the rate limits (spec §9.4) ────────────────────────────────
create index orders_device_recent_idx
  on public.orders (client_device_id, created_at) where client_device_id is not null;
create index orders_customer_recent_idx
  on public.orders (restaurant_id, created_at) where placed_via = 'customer';

-- ─── Helpers ────────────────────────────────────────────────────────────────
-- The device id from the `cid` cookie: a uuid, stored lower-case.
create or replace function private.customer_device(p_device_id text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_device_id is null
     or p_device_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    perform private.fail('INVALID_INPUT', 'device_id');
  end if;
  return lower(p_device_id);
end;
$$;

-- Audit label for a customer: "Customer (device …abcd)" (spec §8.8).
create or replace function private.device_label(p_device_id text)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'Customer (device …' || right(p_device_id, 4) || ')';
$$;

-- The active table behind a QR token, or TABLE_NOT_FOUND. Regenerated tokens
-- and switched-off tables stop working at once.
create or replace function private.customer_table(p_qr_token text)
returns public.dining_tables
language plpgsql
stable
set search_path = ''
as $$
declare
  v_table public.dining_tables;
begin
  if p_qr_token is null or p_qr_token !~ '^[A-Za-z0-9]{16}$' then
    perform private.fail('TABLE_NOT_FOUND');
  end if;
  select * into v_table from public.dining_tables t where t.qr_token = p_qr_token and t.is_active;
  if not found then
    perform private.fail('TABLE_NOT_FOUND');
  end if;
  return v_table;
end;
$$;

revoke execute on function private.customer_device(text) from public, anon, authenticated;
revoke execute on function private.device_label(text) from public, anon, authenticated;
revoke execute on function private.customer_table(text) from public, anon, authenticated;

-- ─── customer_get_table ─────────────────────────────────────────────────────
-- Everything the menu page needs in one round trip: public restaurant details,
-- the table label, access state, ordering settings, the visible menu and a
-- summary of the table's open session. No staff data.
create or replace function public.customer_get_table(p_qr_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_table public.dining_tables := private.customer_table(p_qr_token);
  v_restaurant public.restaurants;
  v_menu jsonb;
  v_session jsonb;
begin
  select * into v_restaurant from public.restaurants r where r.id = v_table.restaurant_id;

  -- Visible menu: active categories that have at least one active dish; active
  -- dishes (out-of-stock ones flagged, not hidden) and their active options.
  select coalesce(jsonb_agg(
           jsonb_build_object('id', c.id, 'name', c.name, 'items', c.items)
           order by c.sort_order, c.created_at
         ), '[]'::jsonb)
  into v_menu
  from (
    select
      cat.id, cat.name, cat.sort_order, cat.created_at,
      (
        select jsonb_agg(
                 jsonb_build_object(
                   'id', i.id,
                   'name', i.name,
                   'description', i.description,
                   'food_type', i.food_type,
                   'price_paise', i.price_paise,
                   'image_path', i.image_path,
                   'image_version', i.updated_at,
                   'is_available', i.is_available,
                   'variants', coalesce((
                     select jsonb_agg(
                              jsonb_build_object('id', v.id, 'name', v.name, 'price_paise', v.price_paise)
                              order by v.sort_order, v.created_at
                            )
                     from public.menu_item_variants v
                     where v.restaurant_id = i.restaurant_id and v.menu_item_id = i.id and v.is_active
                   ), '[]'::jsonb)
                 )
                 order by i.sort_order, i.created_at
               )
        from public.menu_items i
        where i.restaurant_id = cat.restaurant_id and i.category_id = cat.id and i.is_active
      ) as items
    from public.menu_categories cat
    where cat.restaurant_id = v_table.restaurant_id and cat.is_active
  ) c
  where c.items is not null;

  select jsonb_build_object('order_count', count(o.id))
  into v_session
  from public.table_sessions s
  left join public.orders o on o.restaurant_id = s.restaurant_id and o.session_id = s.id
  where s.dining_table_id = v_table.id and s.status = 'open'
  group by s.id;

  return jsonb_build_object(
    'restaurant', jsonb_build_object(
      'name', v_restaurant.name,
      'logo_path', v_restaurant.logo_path,
      'logo_version', v_restaurant.updated_at,
      'accent_color', v_restaurant.accent_color,
      'timezone', v_restaurant.timezone
    ),
    'table', jsonb_build_object('label', v_table.label),
    'access_state', (select a.state from public.restaurant_access(v_table.restaurant_id) a),
    'ordering', jsonb_build_object(
      'require_first_order_approval', v_restaurant.require_first_order_approval,
      'cancel_window_seconds', v_restaurant.customer_cancel_window_seconds
    ),
    'menu', v_menu,
    'session', v_session
  );
end;
$$;

-- ─── customer_place_order ───────────────────────────────────────────────────
-- p_items: [{ menu_item_id, variant_id?, quantity, note? }], 1–30 lines. Prices,
-- names and food types are snapshotted from the database, never the client.
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
  v_line jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_quantity bigint;
  v_line_note text;
  v_unavailable text;
  v_status public.order_status;
begin
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{8,100}$' then
    perform private.fail('INVALID_INPUT', 'idempotency_key');
  end if;
  if p_qr_token is null or p_qr_token !~ '^[A-Za-z0-9]{16}$' then
    perform private.fail('TABLE_NOT_FOUND');
  end if;

  -- The table row lock serialises every order for this table, so concurrent
  -- first orders open exactly one session and round numbers never clash.
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

  -- Payload.
  if jsonb_typeof(p_items) is distinct from 'array' then
    perform private.fail('INVALID_INPUT', 'items');
  end if;
  if jsonb_array_length(p_items) not between 1 and 30 then
    perform private.fail('INVALID_INPUT', 'items');
  end if;
  if length(v_note) > 200 then
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

  -- Rate limits (spec §9.4). Only customer orders count; a pending order whose
  -- dishes were all cancelled no longer counts as waiting.
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
     or (select count(*)
         from public.orders o
         join public.table_sessions s on s.restaurant_id = o.restaurant_id and s.id = o.session_id
         where s.dining_table_id = v_table.id
           and s.status = 'open'
           and o.status = 'pending_approval'
           and exists (
             select 1 from public.order_items oi
             where oi.restaurant_id = o.restaurant_id and oi.session_id = o.session_id
               and oi.order_id = o.id and oi.status = 'placed'
           )) >= 3 then
    perform private.fail('RATE_LIMITED');
  end if;

  -- Every line must be orderable right now. Unknown, hidden, out-of-stock and
  -- other restaurants' dishes look the same, as do option mismatches (the dish
  -- gained or lost options, or the chosen option was removed): the cart drops
  -- them and names them.
  select string_agg(distinct l.menu_item_id::text, ',')
  into v_unavailable
  from jsonb_to_recordset(v_lines) as l(menu_item_id uuid, variant_id uuid)
  where not exists (
    select 1
    from public.menu_items i
    join public.menu_categories c on c.restaurant_id = i.restaurant_id and c.id = i.category_id
    where i.restaurant_id = v_table.restaurant_id
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

  -- Join the table's open session or open one (spec §10.1).
  select * into v_session
  from public.table_sessions s
  where s.dining_table_id = v_table.id and s.status = 'open';
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
    -- Approval was switched off while this session waited: nothing to confirm now.
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

  insert into public.order_items (
    restaurant_id, order_id, session_id, menu_item_id, variant_id,
    item_name_snapshot, variant_name_snapshot, food_type_snapshot,
    unit_price_paise, quantity, note
  )
  select
    v_table.restaurant_id, v_order.id, v_session.id, i.id, v.id,
    i.name, v.name, i.food_type,
    coalesce(v.price_paise, i.price_paise), l.quantity, l.note
  from jsonb_to_recordset(v_lines) as l(menu_item_id uuid, variant_id uuid, quantity int, note text)
  join public.menu_items i on i.restaurant_id = v_table.restaurant_id and i.id = l.menu_item_id
  left join public.menu_item_variants v
    on v.restaurant_id = i.restaurant_id and v.menu_item_id = i.id and v.id = l.variant_id;

  return jsonb_build_object(
    'order_id', v_order.id,
    'round_number', v_order.round_number,
    'status', v_order.status,
    'replayed', false
  );
end;
$$;

-- ─── customer_get_session ───────────────────────────────────────────────────
-- The table's open session for the orders page (polled every 10 s). Every
-- device at the table sees every round; nothing from earlier sessions except
-- `last_session_billed`: this device's latest session here was billed within
-- the last hour (spec §9.3, §13.1).
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
                            'variant', oi.variant_name_snapshot,
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

  return jsonb_build_object(
    'now', now(),
    'timezone', v_restaurant.timezone,
    'cancel_window_seconds', v_restaurant.customer_cancel_window_seconds,
    'access_state', (select a.state from public.restaurant_access(v_table.restaurant_id) a),
    'last_session_billed', coalesce(
      v_last.status = 'billed' and v_last.billed_at > now() - interval '60 minutes', false
    ),
    'session', case
      when v_session.id is null then null
      else jsonb_build_object('opened_at', v_session.opened_at, 'rounds', v_rounds)
    end
  );
end;
$$;

-- ─── customer_cancel_item ───────────────────────────────────────────────────
-- A customer cancels one of their own dishes: only from the device that
-- ordered it, while it is still `placed`, within the restaurant's cancel window
-- (spec §9.3, §10.3). Allowed in read-only too: it only takes work away.
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

revoke execute on function public.customer_get_table(text) from public, anon, authenticated;
revoke execute on function public.customer_place_order(text, text, text, jsonb, text)
  from public, anon, authenticated;
revoke execute on function public.customer_get_session(text, text) from public, anon, authenticated;
revoke execute on function public.customer_cancel_item(text, text, uuid)
  from public, anon, authenticated;

grant execute on function public.customer_get_table(text) to service_role;
grant execute on function public.customer_place_order(text, text, text, jsonb, text) to service_role;
grant execute on function public.customer_get_session(text, text) to service_role;
grant execute on function public.customer_cancel_item(text, text, uuid) to service_role;
