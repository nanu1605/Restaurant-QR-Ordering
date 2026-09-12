-- Menu and dining-table management (spec §9.3, §13.3). Managers and owners
-- change these only through the functions below (docs/DECISIONS.md P2-3).
--
-- Error convention: raise P0001 with a CODE message; DETAIL carries context
-- such as the clashing label. The UI maps codes to human messages.

-- ─── Shared helpers ─────────────────────────────────────────────────────────
create or replace function private.fail(p_code text, p_detail text default null)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = p_code, detail = coalesce(p_detail, '');
end;
$$;

-- INVALID_INPUT unless p_obj is an object whose keys are all in p_allowed.
create or replace function private.assert_keys(p_obj jsonb, p_allowed text[])
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key text;
begin
  if jsonb_typeof(p_obj) is distinct from 'object' then
    perform private.fail('INVALID_INPUT');
  end if;
  select k into v_key from jsonb_object_keys(p_obj) as k where not k = any (p_allowed) limit 1;
  if v_key is not null then
    perform private.fail('INVALID_INPUT', v_key);
  end if;
end;
$$;

create or replace function private.json_bool(p_obj jsonb, p_key text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if jsonb_typeof(p_obj -> p_key) is distinct from 'boolean' then
    perform private.fail('INVALID_INPUT', p_key);
  end if;
  return (p_obj ->> p_key)::boolean;
end;
$$;

-- A whole number (JSON number without a fraction).
create or replace function private.json_int(p_obj jsonb, p_key text)
returns bigint
language plpgsql
immutable
set search_path = ''
as $$
begin
  if jsonb_typeof(p_obj -> p_key) is distinct from 'number'
     or (p_obj ->> p_key) !~ '^-?[0-9]{1,15}$' then
    perform private.fail('INVALID_INPUT', p_key);
  end if;
  return (p_obj ->> p_key)::bigint;
end;
$$;

-- A string or null (missing keys read as null).
create or replace function private.json_text(p_obj jsonb, p_key text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if jsonb_typeof(p_obj -> p_key) not in ('string', 'null') then
    perform private.fail('INVALID_INPUT', p_key);
  end if;
  return p_obj ->> p_key;
end;
$$;

create or replace function private.json_uuid(p_obj jsonb, p_key text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  if jsonb_typeof(p_obj -> p_key) is distinct from 'string'
     or (p_obj ->> p_key) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    perform private.fail('INVALID_INPUT', p_key);
  end if;
  return (p_obj ->> p_key)::uuid;
end;
$$;

-- Audit entry written as the calling staff member.
create or replace function private.audit_as(
  p_ctx private.member_context,
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_before jsonb default null,
  p_after jsonb default null,
  p_reason text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.write_audit(
    p_ctx.restaurant_id, 'staff', p_ctx.user_id, p_ctx.role, p_ctx.display_name,
    p_action, p_entity_type, p_entity_id, p_before, p_after, p_reason
  );
end;
$$;

-- Money limit for a single price: ₹10,00,000.
create or replace function private.assert_price(p_paise bigint, p_field text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_paise is null or p_paise < 0 or p_paise > 100000000 then
    perform private.fail('INVALID_PRICE', p_field);
  end if;
end;
$$;

revoke execute on function private.fail(text, text) from public, anon, authenticated;
revoke execute on function private.assert_keys(jsonb, text[]) from public, anon, authenticated;
revoke execute on function private.json_bool(jsonb, text) from public, anon, authenticated;
revoke execute on function private.json_int(jsonb, text) from public, anon, authenticated;
revoke execute on function private.json_text(jsonb, text) from public, anon, authenticated;
revoke execute on function private.json_uuid(jsonb, text) from public, anon, authenticated;
revoke execute on function private.audit_as(
  private.member_context, text, text, uuid, jsonb, jsonb, text
) from public, anon, authenticated;
revoke execute on function private.assert_price(bigint, text) from public, anon, authenticated;

-- ─── Categories ─────────────────────────────────────────────────────────────
create or replace function public.admin_create_category(p_name text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_name text := private.tidy_text(p_name);
  v_id uuid;
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  if v_name is null or length(v_name) > 60 then
    perform private.fail('INVALID_CATEGORY_NAME');
  end if;

  begin
    insert into public.menu_categories (restaurant_id, name, sort_order, source)
    values (
      v_ctx.restaurant_id,
      v_name,
      (select coalesce(max(c.sort_order), 0) + 1
         from public.menu_categories c where c.restaurant_id = v_ctx.restaurant_id),
      'manual'
    )
    returning id into v_id;
  exception when unique_violation then
    perform private.fail('CATEGORY_NAME_TAKEN', v_name);
  end;
  return v_id;
end;
$$;

-- p_patch: { name?, is_active? } — rename, hide or show.
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
  v_active boolean;
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  perform private.assert_keys(p_patch, array['name', 'is_active']);

  if p_patch ? 'name' then
    v_name := private.tidy_text(private.json_text(p_patch, 'name'));
    if v_name is null or length(v_name) > 60 then
      perform private.fail('INVALID_CATEGORY_NAME');
    end if;
  end if;
  if p_patch ? 'is_active' then
    v_active := private.json_bool(p_patch, 'is_active');
  end if;

  begin
    update public.menu_categories c
      set name = coalesce(v_name, c.name),
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

-- Deletes a category. One that still has items (hidden ones included) needs
-- p_move_to: its items move there first (spec §8.4). Returns items moved.
create or replace function public.admin_delete_category(
  p_category_id uuid,
  p_move_to uuid default null
)
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_base int;
  v_moved int := 0;
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  perform 1 from public.menu_categories c
    where c.id = p_category_id and c.restaurant_id = v_ctx.restaurant_id
    for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;

  if exists (
    select 1 from public.menu_items i
    where i.restaurant_id = v_ctx.restaurant_id and i.category_id = p_category_id
  ) then
    if p_move_to is null then
      perform private.fail('CATEGORY_NOT_EMPTY');
    end if;
    if p_move_to = p_category_id or not exists (
      select 1 from public.menu_categories c
      where c.id = p_move_to and c.restaurant_id = v_ctx.restaurant_id
    ) then
      perform private.fail('NOT_FOUND', 'move_to');
    end if;

    select coalesce(max(i.sort_order), 0) into v_base
      from public.menu_items i
      where i.restaurant_id = v_ctx.restaurant_id and i.category_id = p_move_to;

    update public.menu_items i
      set category_id = p_move_to, sort_order = v_base + s.rn
      from (
        select m.id, row_number() over (order by m.sort_order, m.created_at) as rn
        from public.menu_items m
        where m.restaurant_id = v_ctx.restaurant_id and m.category_id = p_category_id
      ) as s
      where i.id = s.id;
    get diagnostics v_moved = row_count;
  end if;

  delete from public.menu_categories c where c.id = p_category_id;
  return v_moved;
end;
$$;

-- Appends suggested categories (a default set), skipping names that already
-- exist, compared case- and spacing-insensitively. Returns how many were added.
create or replace function public.admin_add_categories(p_names text[])
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_base int;
  v_added int;
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  if p_names is null or cardinality(p_names) > 50 then
    perform private.fail('INVALID_INPUT');
  end if;

  select coalesce(max(c.sort_order), 0) into v_base
    from public.menu_categories c where c.restaurant_id = v_ctx.restaurant_id;

  begin
    insert into public.menu_categories (restaurant_id, name, sort_order, source)
    select v_ctx.restaurant_id, n.name, v_base + row_number() over (order by n.ord), 'default'
    from (
      select distinct on (private.normalize_name(t.name)) private.tidy_text(t.name) as name, t.ord
      from unnest(p_names) with ordinality as t(name, ord)
      where private.tidy_text(t.name) is not null and length(private.tidy_text(t.name)) <= 60
      order by private.normalize_name(t.name), t.ord
    ) as n
    where not exists (
      select 1 from public.menu_categories c
      where c.restaurant_id = v_ctx.restaurant_id
        and private.normalize_name(c.name) = private.normalize_name(n.name)
    );
    get diagnostics v_added = row_count;
  exception when unique_violation then
    perform private.fail('CATEGORY_NAME_TAKEN');
  end;
  return v_added;
end;
$$;

-- ─── Ordering (drag and drop) ───────────────────────────────────────────────
-- p_kind: 'categories' | 'items' (within p_category_id) | 'tables'. The given
-- ids take positions 1..n; the rest of the scope follows in its old order.
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

-- ─── Menu items ─────────────────────────────────────────────────────────────
-- Creates or updates an item with its variants in one transaction.
-- p_item: { id?, category_id, name, description?, food_type, price_paise?,
--           is_available?, image_path?, variants?: [{ id?, name, price_paise }] }
-- A given id that doesn't exist yet creates the item with that id (the browser
-- picks it so the image can be uploaded under the item's own path).
-- With variants, price_paise becomes the lowest variant price ("from ₹X");
-- variants missing from the list are deactivated (order history keeps them).
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
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  perform private.assert_keys(p_item, array[
    'id', 'category_id', 'name', 'description', 'food_type', 'price_paise',
    'is_available', 'image_path', 'variants'
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

  if cardinality(v_variant_prices) > 0 then
    select min(x) into v_price from unnest(v_variant_prices) as x;
  else
    v_price := private.json_int(p_item, 'price_paise');
    perform private.assert_price(v_price, 'price_paise');
  end if;

  -- Write the item.
  if v_is_new then
    insert into public.menu_items (
      id, restaurant_id, category_id, name, description, price_paise, food_type,
      image_path, is_available, sort_order
    )
    values (
      v_id, v_ctx.restaurant_id, v_category_id, v_name, v_description, v_price, v_food_type,
      v_image, v_available,
      (select coalesce(max(i.sort_order), 0) + 1 from public.menu_items i
        where i.restaurant_id = v_ctx.restaurant_id and i.category_id = v_category_id)
    );
  else
    update public.menu_items i
      set category_id = v_category_id,
          name = v_name,
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

  return v_id;
end;
$$;

-- Quick edits from the item list. p_patch: { price_paise?, is_active?, image_path? }
-- is_active = false hides the item (soft delete, docs/DECISIONS.md P2-8).
create or replace function public.admin_update_menu_item(p_item_id uuid, p_patch jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_price bigint;
  v_active boolean;
  v_image text;
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  perform private.assert_keys(p_patch, array['price_paise', 'is_active', 'image_path']);

  perform 1 from public.menu_items i
    where i.id = p_item_id and i.restaurant_id = v_ctx.restaurant_id
    for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;

  if p_patch ? 'price_paise' then
    v_price := private.json_int(p_patch, 'price_paise');
    perform private.assert_price(v_price, 'price_paise');
    if exists (
      select 1 from public.menu_item_variants mv
      where mv.menu_item_id = p_item_id and mv.is_active
    ) then
      perform private.fail('ITEM_HAS_VARIANTS');
    end if;
  end if;
  if p_patch ? 'is_active' then
    v_active := private.json_bool(p_patch, 'is_active');
  end if;
  if p_patch ? 'image_path' then
    v_image := private.json_text(p_patch, 'image_path');
    if v_image is not null
       and v_image !~ ('^' || v_ctx.restaurant_id::text || '/[A-Za-z0-9._-]{1,100}$') then
      perform private.fail('INVALID_IMAGE_PATH');
    end if;
  end if;

  update public.menu_items i
    set price_paise = coalesce(v_price, i.price_paise),
        is_active = coalesce(v_active, i.is_active),
        image_path = case when p_patch ? 'image_path' then v_image else i.image_path end
    where i.id = p_item_id;
end;
$$;

-- "In stock" switch (spec §9.3). Any staff role; allowed while read-only so
-- service can go on.
create or replace function public.staff_set_item_availability(p_item_id uuid, p_available boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member();
begin
  if p_available is null then
    perform private.fail('INVALID_INPUT', 'available');
  end if;
  update public.menu_items i
    set is_available = p_available
    where i.id = p_item_id and i.restaurant_id = v_ctx.restaurant_id;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
end;
$$;

-- ─── Dining tables ──────────────────────────────────────────────────────────
-- Creates tables with fresh QR tokens, enforcing the plan's max_tables
-- (active tables only). Returns [{ id, label }].
create or replace function public.admin_create_tables(p_labels text[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_n int := coalesce(cardinality(p_labels), 0);
  v_labels text[];
  v_taken text;
  v_max_tables int;
  v_max_staff int;
  v_active int;
  v_base int;
  v_result jsonb;
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  if v_n = 0 or v_n > 100 then
    perform private.fail('INVALID_INPUT', 'labels');
  end if;

  -- Serialise limit checks for this restaurant.
  perform 1 from public.restaurants r where r.id = v_ctx.restaurant_id for update;

  select array_agg(private.tidy_text(t.label) order by t.ord)
    into v_labels
    from unnest(p_labels) with ordinality as t(label, ord);
  if exists (select 1 from unnest(v_labels) as l where l is null or length(l) > 30) then
    perform private.fail('INVALID_TABLE_LABEL');
  end if;
  if (select count(distinct lower(l)) from unnest(v_labels) as l) <> v_n then
    perform private.fail('TABLE_LABEL_DUPLICATE');
  end if;

  select d.label into v_taken
    from public.dining_tables d
    where d.restaurant_id = v_ctx.restaurant_id
      and d.is_active
      and lower(btrim(d.label)) in (select lower(l) from unnest(v_labels) as l)
    order by d.sort_order
    limit 1;
  if v_taken is not null then
    perform private.fail('TABLE_LABEL_TAKEN', v_taken);
  end if;

  select l.max_tables, l.max_staff into v_max_tables, v_max_staff
    from private.plan_limits(v_ctx.restaurant_id) as l;
  select count(*) into v_active
    from public.dining_tables d
    where d.restaurant_id = v_ctx.restaurant_id and d.is_active;
  if v_max_tables is not null and v_active + v_n > v_max_tables then
    perform private.fail('PLAN_LIMIT_TABLES', v_max_tables::text);
  end if;

  select coalesce(max(d.sort_order), 0) into v_base
    from public.dining_tables d where d.restaurant_id = v_ctx.restaurant_id;

  with inserted as (
    insert into public.dining_tables (restaurant_id, label, sort_order, qr_token)
    select v_ctx.restaurant_id, t.label, v_base + t.ord::int, private.random_base62(16)
    from unnest(v_labels) with ordinality as t(label, ord)
    returning id, label, sort_order
  )
  select jsonb_agg(jsonb_build_object('id', i.id, 'label', i.label) order by i.sort_order)
    into v_result
    from inserted as i;

  return v_result;
end;
$$;

-- p_patch: { label?, is_active? }. Reactivating counts against max_tables;
-- a table with an open session can't be deactivated.
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
  perform 1 from public.restaurants r where r.id = v_ctx.restaurant_id for update;

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
end;
$$;

-- New QR token; stickers with the old code stop working. Returns the token.
create or replace function public.admin_regenerate_qr(p_table_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_label text;
  v_token text := private.random_base62(16);
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  update public.dining_tables d
    set qr_token = v_token
    where d.id = p_table_id and d.restaurant_id = v_ctx.restaurant_id
    returning d.label into v_label;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;

  perform private.audit_as(
    v_ctx, 'table.qr_regenerated', 'dining_table', p_table_id,
    null, jsonb_build_object('label', v_label)
  );
  return v_token;
end;
$$;

-- ─── Privileges ─────────────────────────────────────────────────────────────
revoke execute on function public.admin_create_category(text) from public, anon;
revoke execute on function public.admin_update_category(uuid, jsonb) from public, anon;
revoke execute on function public.admin_delete_category(uuid, uuid) from public, anon;
revoke execute on function public.admin_add_categories(text[]) from public, anon;
revoke execute on function public.admin_reorder(text, uuid[], uuid) from public, anon;
revoke execute on function public.admin_save_menu_item(jsonb) from public, anon;
revoke execute on function public.admin_update_menu_item(uuid, jsonb) from public, anon;
revoke execute on function public.staff_set_item_availability(uuid, boolean) from public, anon;
revoke execute on function public.admin_create_tables(text[]) from public, anon;
revoke execute on function public.admin_update_table(uuid, jsonb) from public, anon;
revoke execute on function public.admin_regenerate_qr(uuid) from public, anon;

grant execute on function public.admin_create_category(text) to authenticated;
grant execute on function public.admin_update_category(uuid, jsonb) to authenticated;
grant execute on function public.admin_delete_category(uuid, uuid) to authenticated;
grant execute on function public.admin_add_categories(text[]) to authenticated;
grant execute on function public.admin_reorder(text, uuid[], uuid) to authenticated;
grant execute on function public.admin_save_menu_item(jsonb) to authenticated;
grant execute on function public.admin_update_menu_item(uuid, jsonb) to authenticated;
grant execute on function public.staff_set_item_availability(uuid, boolean) to authenticated;
grant execute on function public.admin_create_tables(text[]) to authenticated;
grant execute on function public.admin_update_table(uuid, jsonb) to authenticated;
grant execute on function public.admin_regenerate_qr(uuid) to authenticated;
