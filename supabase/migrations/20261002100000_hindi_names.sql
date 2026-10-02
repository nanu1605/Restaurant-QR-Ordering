-- Optional Hindi names for dishes and categories (docs/DECISIONS.md, "Hindi
-- names"). Guests see them when the customer menu is in Hindi; everything else
-- (staff screens, the kitchen, bills, reports, order snapshots) keeps the name
-- as typed. Additive: deployments that don't send name_hi keep working.

alter table public.menu_items
  add column name_hi text check (name_hi is null or length(btrim(name_hi)) between 1 and 80);
alter table public.menu_categories
  add column name_hi text check (name_hi is null or length(btrim(name_hi)) between 1 and 60);

-- ─── Categories ─────────────────────────────────────────────────────────────

-- p_patch: { name?, name_hi?, is_active? }. An empty or null name_hi clears it.
-- Otherwise as in 20260912095809.
create or replace function public.admin_update_category(p_category_id uuid, p_patch jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_name text;
  v_name_hi text;
  v_active boolean;
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  perform private.assert_keys(p_patch, array['name', 'name_hi', 'is_active']);

  if p_patch ? 'name' then
    v_name := private.tidy_text(private.json_text(p_patch, 'name'));
    if v_name is null or length(v_name) > 60 then
      perform private.fail('INVALID_CATEGORY_NAME');
    end if;
  end if;
  v_name_hi := private.tidy_text(private.json_text(p_patch, 'name_hi'));
  if length(v_name_hi) > 60 then
    perform private.fail('INVALID_INPUT', 'name_hi');
  end if;
  if p_patch ? 'is_active' then
    v_active := private.json_bool(p_patch, 'is_active');
  end if;

  begin
    update public.menu_categories c
      set name = coalesce(v_name, c.name),
          name_hi = case when p_patch ? 'name_hi' then v_name_hi else c.name_hi end,
          is_active = coalesce(v_active, c.is_active)
      where c.id = p_category_id and c.restaurant_id = v_ctx.restaurant_id;
  exception when unique_violation then
    perform private.fail('CATEGORY_NAME_TAKEN', v_name);
  end;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
end;
$$;

-- ─── Dishes ─────────────────────────────────────────────────────────────────

-- name_hi is optional and only changed when sent, like addon_group_ids, so
-- older callers leave it as it is. Otherwise as in 20260929100000.
create or replace function public.admin_save_menu_item(p_item jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_id uuid;
  v_existing public.menu_items%rowtype;
  v_is_new boolean;
  v_category_id uuid;
  v_name text;
  v_name_hi text;
  v_description text;
  v_food_type public.food_type;
  v_price bigint;
  v_available boolean := true;
  v_image text;
  v_variants jsonb;
  v_variant jsonb;
  v_ord bigint;
  v_variant_names text[] := '{}';
  v_variant_prices bigint[] := '{}';
  v_variant_ids uuid[] := '{}';
  v_keep_ids uuid[] := '{}';
  v_vname text;
  v_vprice bigint;
  v_vid uuid;
  v_group_ids uuid[];
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  perform private.assert_keys(p_item, array[
    'id', 'category_id', 'name', 'name_hi', 'description', 'food_type', 'price_paise',
    'is_available', 'image_path', 'variants', 'addon_group_ids'
  ]);

  -- Which item?
  if jsonb_typeof(p_item -> 'id') = 'string' then
    v_id := private.json_uuid(p_item, 'id');
    select * into v_existing from public.menu_items i where i.id = v_id for update;
    if found and v_existing.restaurant_id <> v_ctx.restaurant_id then
      perform private.fail('NOT_FOUND');
    end if;
    v_is_new := not found;
  else
    v_id := gen_random_uuid();
    v_is_new := true;
  end if;

  -- Fields.
  v_category_id := private.json_uuid(p_item, 'category_id');
  if not exists (
    select 1 from public.menu_categories c
    where c.id = v_category_id and c.restaurant_id = v_ctx.restaurant_id
  ) then
    perform private.fail('NOT_FOUND', 'category_id');
  end if;

  v_name := private.tidy_text(private.json_text(p_item, 'name'));
  if v_name is null or length(v_name) > 80 then
    perform private.fail('INVALID_ITEM_NAME');
  end if;

  v_name_hi := private.tidy_text(private.json_text(p_item, 'name_hi'));
  if length(v_name_hi) > 80 then
    perform private.fail('INVALID_INPUT', 'name_hi');
  end if;

  v_description := nullif(btrim(private.json_text(p_item, 'description')), '');
  if length(v_description) > 300 then
    perform private.fail('INVALID_INPUT', 'description');
  end if;

  if private.json_text(p_item, 'food_type') is null
     or not (p_item ->> 'food_type') = any (enum_range(null::public.food_type)::text[]) then
    perform private.fail('INVALID_INPUT', 'food_type');
  end if;
  v_food_type := (p_item ->> 'food_type')::public.food_type;

  if p_item ? 'is_available' then
    v_available := private.json_bool(p_item, 'is_available');
  end if;

  v_image := private.json_text(p_item, 'image_path');
  if v_image is not null
     and v_image !~ ('^' || v_ctx.restaurant_id::text || '/[A-Za-z0-9._-]{1,100}$') then
    perform private.fail('INVALID_IMAGE_PATH');
  end if;

  -- Variants (validated before anything is written).
  v_variants := coalesce(p_item -> 'variants', '[]'::jsonb);
  if jsonb_typeof(v_variants) <> 'array' or jsonb_array_length(v_variants) > 20 then
    perform private.fail('INVALID_INPUT', 'variants');
  end if;

  for v_variant in select value from jsonb_array_elements(v_variants) loop
    perform private.assert_keys(v_variant, array['id', 'name', 'price_paise']);
    v_vname := private.tidy_text(private.json_text(v_variant, 'name'));
    if v_vname is null or length(v_vname) > 40 then
      perform private.fail('INVALID_VARIANT_NAME');
    end if;
    if private.normalize_name(v_vname) = any (v_variant_names) then
      perform private.fail('VARIANT_NAME_DUPLICATE', v_vname);
    end if;
    v_vprice := private.json_int(v_variant, 'price_paise');
    perform private.assert_price(v_vprice, 'variants');
    v_variant_names := v_variant_names || private.normalize_name(v_vname);
    v_variant_prices := v_variant_prices || v_vprice;
    if jsonb_typeof(v_variant -> 'id') = 'string' then
      v_vid := private.json_uuid(v_variant, 'id');
      if v_is_new or not exists (
        select 1 from public.menu_item_variants mv
        where mv.id = v_vid and mv.menu_item_id = v_id and mv.restaurant_id = v_ctx.restaurant_id
      ) then
        perform private.fail('NOT_FOUND', 'variants');
      end if;
    end if;
  end loop;

  -- Add-on groups: only when given, so callers that don't know about them
  -- (quick edits, the menu import) leave the dish's groups as they are.
  if p_item ? 'addon_group_ids' then
    v_group_ids := private.json_uuid_array(p_item -> 'addon_group_ids', 'addon_group_ids', 10);
    if (select count(*) from public.menu_addon_groups g
        where g.restaurant_id = v_ctx.restaurant_id and g.id = any (v_group_ids))
       <> cardinality(v_group_ids) then
      perform private.fail('NOT_FOUND', 'addon_group_ids');
    end if;
  end if;

  if cardinality(v_variant_prices) > 0 then
    select min(x) into v_price from unnest(v_variant_prices) as x;
  else
    v_price := private.json_int(p_item, 'price_paise');
    perform private.assert_price(v_price, 'price_paise');
  end if;

  -- Write the item.
  if v_is_new then
    insert into public.menu_items (
      id, restaurant_id, category_id, name, name_hi, description, price_paise, food_type,
      image_path, is_available, sort_order
    )
    values (
      v_id, v_ctx.restaurant_id, v_category_id, v_name, v_name_hi, v_description, v_price,
      v_food_type, v_image, v_available,
      (select coalesce(max(i.sort_order), 0) + 1 from public.menu_items i
        where i.restaurant_id = v_ctx.restaurant_id and i.category_id = v_category_id)
    );
  else
    update public.menu_items i
      set category_id = v_category_id,
          name = v_name,
          name_hi = case when p_item ? 'name_hi' then v_name_hi else i.name_hi end,
          description = v_description,
          price_paise = v_price,
          food_type = v_food_type,
          image_path = v_image,
          is_available = v_available,
          sort_order = case
            when i.category_id = v_category_id then i.sort_order
            else (select coalesce(max(m.sort_order), 0) + 1 from public.menu_items m
                   where m.restaurant_id = v_ctx.restaurant_id and m.category_id = v_category_id)
          end
      where i.id = v_id;
  end if;

  -- Sync variants in the given order.
  for v_variant, v_ord in select value, ordinality from jsonb_array_elements(v_variants) with ordinality loop
    v_vname := private.tidy_text(v_variant ->> 'name');
    v_vprice := (v_variant ->> 'price_paise')::bigint;
    if jsonb_typeof(v_variant -> 'id') = 'string' then
      v_vid := (v_variant ->> 'id')::uuid;
      update public.menu_item_variants mv
        set name = v_vname, price_paise = v_vprice, sort_order = v_ord, is_active = true
        where mv.id = v_vid;
    else
      insert into public.menu_item_variants (restaurant_id, menu_item_id, name, price_paise, sort_order)
      values (v_ctx.restaurant_id, v_id, v_vname, v_vprice, v_ord)
      returning id into v_vid;
    end if;
    v_keep_ids := v_keep_ids || v_vid;
  end loop;

  update public.menu_item_variants mv
    set is_active = false
    where mv.restaurant_id = v_ctx.restaurant_id
      and mv.menu_item_id = v_id
      and mv.is_active
      and mv.id <> all (v_keep_ids);

  if v_group_ids is not null then
    delete from public.menu_item_addon_groups l
      where l.restaurant_id = v_ctx.restaurant_id
        and l.menu_item_id = v_id
        and l.group_id <> all (v_group_ids);
    insert into public.menu_item_addon_groups (restaurant_id, menu_item_id, group_id)
      select v_ctx.restaurant_id, v_id, g from unnest(v_group_ids) as g
      on conflict do nothing;
  end if;

  return v_id;
end;
$$;

-- ─── Guest reads ────────────────────────────────────────────────────────────

-- The customer menu: as in 20260929100000, plus name_hi on categories and dishes.
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
  v_addon_groups jsonb;
  v_session jsonb;
begin
  select * into v_restaurant from public.restaurants r where r.id = v_table.restaurant_id;

  -- Visible menu: active categories that have at least one active dish; active
  -- dishes (out-of-stock ones flagged, not hidden) and their active options.
  select coalesce(jsonb_agg(
           jsonb_build_object('id', c.id, 'name', c.name, 'name_hi', c.name_hi, 'items', c.items)
           order by c.sort_order, c.created_at
         ), '[]'::jsonb)
  into v_menu
  from (
    select
      cat.id, cat.name, cat.name_hi, cat.sort_order, cat.created_at,
      (
        select jsonb_agg(
                 jsonb_build_object(
                   'id', i.id,
                   'name', i.name,
                   'name_hi', i.name_hi,
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
                   ), '[]'::jsonb),
                   'addon_group_ids', coalesce((
                     select jsonb_agg(g.id order by g.created_at, g.id)
                     from public.menu_item_addon_groups l
                     join public.menu_addon_groups g
                       on g.restaurant_id = l.restaurant_id and g.id = l.group_id
                     where l.restaurant_id = i.restaurant_id and l.menu_item_id = i.id
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

  -- Add-on groups used by the menu's dishes, sent once (docs/DECISIONS.md
  -- P9-4). Out-of-stock options are flagged, not hidden.
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id', g.id,
             'name', g.name,
             'min_select', g.min_select,
             'max_select', g.max_select,
             'addons', coalesce((
               select jsonb_agg(
                        jsonb_build_object(
                          'id', a.id,
                          'name', a.name,
                          'price_paise', a.price_paise,
                          'is_available', a.is_available
                        )
                        order by a.sort_order, a.id
                      )
               from public.menu_addons a
               where a.restaurant_id = g.restaurant_id and a.group_id = g.id
             ), '[]'::jsonb)
           )
           order by g.created_at, g.id
         ), '[]'::jsonb)
  into v_addon_groups
  from public.menu_addon_groups g
  where g.restaurant_id = v_table.restaurant_id
    and exists (
      select 1
      from public.menu_item_addon_groups l
      join public.menu_items i on i.restaurant_id = l.restaurant_id and i.id = l.menu_item_id
      where l.restaurant_id = g.restaurant_id and l.group_id = g.id and i.is_active
    );

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
    'addon_groups', v_addon_groups,
    'session', v_session
  );
end;
$$;

-- The customer's orders page: as in 20260929100000, plus each dish's name_hi.
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
                            -- ponytail: the dish's current Hindi name, not a snapshot;
                            -- add order_items.item_name_hi_snapshot if renames mid-meal matter.
                            'name_hi', mi.name_hi,
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
