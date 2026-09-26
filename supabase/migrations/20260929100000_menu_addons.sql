-- Menu add-ons (spec §8.4, §19 Phase 9; docs/DECISIONS.md P9-4): shared
-- groups of extras ("Toppings: up to 3", "Crust: choose 1") built once and
-- attached to many dishes. An order line keeps a snapshot of its add-ons and
-- their total is folded into unit_price_paise, so bills, totals and reports
-- work unchanged (add-on revenue counts towards the dish).
--
-- Error codes (P0001 message; DETAIL adds context):
--   ITEM_UNAVAILABLE             an add-on out of stock or not on the dish, or a
--                                group with too few or too many choices (DETAIL =
--                                the dish ids, as for dishes)
--   ADDON_GROUP_NAME_DUPLICATE   DETAIL = the name
--   ADDON_NAME_DUPLICATE         two options of a group share a name; DETAIL = it
--   INVALID_ADDON_GROUP_NAME, INVALID_ADDON_NAME, INVALID_PRICE
--   NOT_FOUND                    an id from another restaurant
--   INVALID_INPUT                DETAIL = the offending field

create table public.menu_addon_groups (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id),
  name text not null check (length(btrim(name)) between 1 and 60),
  -- How many options a customer picks; 0 makes the group optional.
  min_select int not null default 0,
  max_select int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (restaurant_id, id),
  constraint menu_addon_groups_select_range
    check (min_select between 0 and max_select and max_select between 1 and 20)
);

-- Same comparison as private.normalize_name, so admins can tell groups apart.
create unique index menu_addon_groups_name_key
  on public.menu_addon_groups (restaurant_id, lower(regexp_replace(btrim(name), '\s+', ' ', 'g')));

-- Deleted for real when removed: orders keep their own snapshot.
create table public.menu_addons (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id),
  group_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 40),
  price_paise bigint not null default 0 check (price_paise >= 0),
  is_available boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (restaurant_id, id),
  foreign key (restaurant_id, group_id)
    references public.menu_addon_groups (restaurant_id, id) on delete cascade
);

create index menu_addons_group_sort_idx on public.menu_addons (restaurant_id, group_id, sort_order);

-- Which groups a dish offers. A dish shows its groups in the order they were created.
create table public.menu_item_addon_groups (
  restaurant_id uuid not null references public.restaurants (id),
  menu_item_id uuid not null,
  group_id uuid not null,
  primary key (restaurant_id, menu_item_id, group_id),
  foreign key (restaurant_id, menu_item_id)
    references public.menu_items (restaurant_id, id) on delete cascade,
  foreign key (restaurant_id, group_id)
    references public.menu_addon_groups (restaurant_id, id) on delete cascade
);

create index menu_item_addon_groups_group_idx
  on public.menu_item_addon_groups (restaurant_id, group_id);

-- [{ id, group, name, price_paise }] as ordered, in the dish's group order.
alter table public.order_items
  add column addons_snapshot jsonb not null default '[]'::jsonb
    constraint order_items_addons_snapshot_array check (jsonb_typeof(addons_snapshot) = 'array');

create trigger set_updated_at before update on public.menu_addon_groups
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.menu_addons
  for each row execute function private.set_updated_at();

alter table public.menu_addon_groups enable row level security;
alter table public.menu_addons enable row level security;
alter table public.menu_item_addon_groups enable row level security;
revoke insert, update, delete on public.menu_addon_groups from authenticated;
revoke insert, update, delete on public.menu_addons from authenticated;
revoke insert, update, delete on public.menu_item_addon_groups from authenticated;
create policy "members read add-on groups" on public.menu_addon_groups
  for select to authenticated
  using (restaurant_id in (select private.my_restaurant_ids()));
create policy "members read add-ons" on public.menu_addons
  for select to authenticated
  using (restaurant_id in (select private.my_restaurant_ids()));
create policy "members read dish add-on groups" on public.menu_item_addon_groups
  for select to authenticated
  using (restaurant_id in (select private.my_restaurant_ids()));

-- ─── Helpers ────────────────────────────────────────────────────────────────
-- A JSON array of distinct uuid strings (null or missing = empty), at most
-- p_max long, in the given order; INVALID_INPUT with p_field otherwise.
create or replace function private.json_uuid_array(p_value jsonb, p_field text, p_max int)
returns uuid[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  if p_value is null or p_value = 'null'::jsonb then
    return '{}';
  end if;
  if jsonb_typeof(p_value) <> 'array' then
    perform private.fail('INVALID_INPUT', p_field);
  end if;
  if jsonb_array_length(p_value) > p_max or exists (
    select 1 from jsonb_array_elements(p_value) as e
    where jsonb_typeof(e) <> 'string'
      or (e #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    perform private.fail('INVALID_INPUT', p_field);
  end if;
  v_ids := array(
    select (e #>> '{}')::uuid from jsonb_array_elements(p_value) with ordinality as t(e, n) order by n
  );
  if (select count(distinct x) from unnest(v_ids) as x) <> cardinality(v_ids) then
    perform private.fail('INVALID_INPUT', p_field);
  end if;
  return v_ids;
end;
$$;

-- The option names of an add-on snapshot, in order: ["Extra cheese", "Olives"].
create or replace function private.addon_names(p_snapshot jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(a.value ->> 'name' order by a.ord), '[]'::jsonb)
  from jsonb_array_elements(p_snapshot) with ordinality as a(value, ord);
$$;

revoke execute on function private.json_uuid_array(jsonb, text, int) from public, anon, authenticated;
revoke execute on function private.addon_names(jsonb) from public, anon, authenticated;

-- ─── Order helpers, now with add-ons ────────────────────────────────────────
-- As before, plus addon_ids per line: up to 20 distinct ids, returned sorted
-- (always present, [] when none).
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
  v_addon_ids uuid[];
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
    perform private.assert_keys(
      v_line, array['menu_item_id', 'variant_id', 'quantity', 'note', 'addon_ids']
    );
    v_quantity := private.json_int(v_line, 'quantity');
    if v_quantity not between 1 and 20 then
      perform private.fail('INVALID_INPUT', 'quantity');
    end if;
    v_line_note := private.tidy_text(private.json_text(v_line, 'note'));
    if length(v_line_note) > 120 then
      perform private.fail('INVALID_INPUT', 'note');
    end if;
    v_addon_ids := private.json_uuid_array(v_line -> 'addon_ids', 'addon_ids', 20);
    v_lines := v_lines || jsonb_build_object(
      'menu_item_id', private.json_uuid(v_line, 'menu_item_id'),
      'variant_id', case
        when jsonb_typeof(v_line -> 'variant_id') is null or v_line -> 'variant_id' = 'null'::jsonb
          then null
        else private.json_uuid(v_line, 'variant_id')
      end,
      'quantity', v_quantity,
      'note', v_line_note,
      'addon_ids', coalesce((select jsonb_agg(x order by x) from unnest(v_addon_ids) as x), '[]'::jsonb)
    );
  end loop;
  return v_lines;
end;
$$;

-- As before, and the add-ons must fit the dish: every chosen option in stock
-- and in one of the dish's groups, and each of its groups chosen from between
-- min_select and max_select times. A mismatch reads as the dish being
-- unavailable (ITEM_UNAVAILABLE with its id), which the cart already handles.
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
  from jsonb_to_recordset(p_lines) as l(menu_item_id uuid, variant_id uuid, addon_ids uuid[])
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
  )
  or exists (
    select 1 from unnest(coalesce(l.addon_ids, '{}')) as x(id)
    where not exists (
      select 1
      from public.menu_addons a
      join public.menu_item_addon_groups g
        on g.restaurant_id = a.restaurant_id and g.group_id = a.group_id
      where a.restaurant_id = p_restaurant_id
        and a.id = x.id
        and a.is_available
        and g.menu_item_id = l.menu_item_id
    )
  )
  or exists (
    select 1
    from public.menu_item_addon_groups g
    join public.menu_addon_groups grp on grp.restaurant_id = g.restaurant_id and grp.id = g.group_id
    where g.restaurant_id = p_restaurant_id
      and g.menu_item_id = l.menu_item_id
      and (
        select count(*) from public.menu_addons a
        where a.restaurant_id = g.restaurant_id
          and a.group_id = g.group_id
          and a.id = any (coalesce(l.addon_ids, '{}'))
      ) not between grp.min_select and grp.max_select
  );
  if v_unavailable is not null then
    perform private.fail('ITEM_UNAVAILABLE', v_unavailable);
  end if;
end;
$$;

-- As before, plus the add-ons: their prices are added to the unit price and
-- their names, groups and prices kept in addons_snapshot, all from the
-- database (spec §5.1). Add-ons are deleted for real, so the chosen ones are
-- held (FOR KEY SHARE: price and stock edits still go through) until the
-- order commits, and one deleted since assert_orderable refuses the dish
-- instead of silently leaving the add-on out.
create or replace function private.insert_order_items(
  p_restaurant_id uuid,
  p_order_id uuid,
  p_session_id uuid,
  p_lines jsonb
)
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_gone text;
begin
  perform 1
  from public.menu_addons a
  where a.restaurant_id = p_restaurant_id
    and a.id in (
      select x::uuid
      from jsonb_array_elements(p_lines) as l, jsonb_array_elements_text(l -> 'addon_ids') as x
    )
  order by a.id
  for key share;

  select string_agg(distinct l.menu_item_id::text, ',')
  into v_gone
  from jsonb_to_recordset(p_lines) as l(menu_item_id uuid, addon_ids uuid[])
  where exists (
    select 1 from unnest(coalesce(l.addon_ids, '{}')) as x(id)
    where not exists (
      select 1 from public.menu_addons a where a.restaurant_id = p_restaurant_id and a.id = x.id
    )
  );
  if v_gone is not null then
    perform private.fail('ITEM_UNAVAILABLE', v_gone);
  end if;

  insert into public.order_items (
    restaurant_id, order_id, session_id, menu_item_id, variant_id,
    item_name_snapshot, variant_name_snapshot, food_type_snapshot,
    unit_price_paise, quantity, note, addons_snapshot
  )
  select
    p_restaurant_id, p_order_id, p_session_id, i.id, v.id,
    i.name, v.name, i.food_type,
    coalesce(v.price_paise, i.price_paise) + ad.total, l.quantity, l.note, ad.snapshot
  from jsonb_to_recordset(p_lines)
    as l(menu_item_id uuid, variant_id uuid, quantity int, note text, addon_ids uuid[])
  join public.menu_items i on i.restaurant_id = p_restaurant_id and i.id = l.menu_item_id
  left join public.menu_item_variants v
    on v.restaurant_id = i.restaurant_id and v.menu_item_id = i.id and v.id = l.variant_id
  cross join lateral (
    select
      coalesce(sum(a.price_paise), 0)::bigint as total,
      coalesce(jsonb_agg(
        jsonb_build_object('id', a.id, 'group', grp.name, 'name', a.name, 'price_paise', a.price_paise)
        order by grp.created_at, grp.id, a.sort_order, a.id
      ), '[]'::jsonb) as snapshot
    from public.menu_addons a
    join public.menu_addon_groups grp on grp.restaurant_id = a.restaurant_id and grp.id = a.group_id
    where a.restaurant_id = p_restaurant_id and a.id = any (coalesce(l.addon_ids, '{}'))
  ) as ad;
end;
$$;

-- ─── Managing add-on groups (owners and managers) ───────────────────────────
-- Creates or updates a group with its options in one transaction.
-- p_group: { id?, name, min_select, max_select,
--            addons: [{ id?, name, price_paise, is_available? }] } (1–30 options)
-- Options missing from the list are deleted; new ones are in stock unless
-- is_available says otherwise.
create or replace function public.admin_save_addon_group(p_group jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_id uuid;
  v_name text;
  v_min bigint;
  v_max bigint;
  v_addons jsonb;
  v_addon jsonb;
  v_ord bigint;
  v_names text[] := '{}';
  v_seen_ids uuid[] := '{}';
  v_keep_ids uuid[] := '{}';
  v_aname text;
  v_aprice bigint;
  v_aid uuid;
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  perform private.assert_keys(p_group, array['id', 'name', 'min_select', 'max_select', 'addons']);

  if jsonb_typeof(p_group -> 'id') = 'string' then
    v_id := private.json_uuid(p_group, 'id');
    perform 1 from public.menu_addon_groups g
      where g.id = v_id and g.restaurant_id = v_ctx.restaurant_id
      for update;
    if not found then
      perform private.fail('NOT_FOUND');
    end if;
  end if;

  v_name := private.tidy_text(private.json_text(p_group, 'name'));
  if v_name is null or length(v_name) > 60 then
    perform private.fail('INVALID_ADDON_GROUP_NAME');
  end if;

  v_addons := p_group -> 'addons';
  if jsonb_typeof(v_addons) is distinct from 'array' then
    perform private.fail('INVALID_INPUT', 'addons');
  end if;
  if jsonb_array_length(v_addons) not between 1 and 30 then
    perform private.fail('INVALID_INPUT', 'addons');
  end if;

  v_min := private.json_int(p_group, 'min_select');
  v_max := private.json_int(p_group, 'max_select');
  if v_max not between 1 and 20 then
    perform private.fail('INVALID_INPUT', 'max_select');
  end if;
  -- Customers must be able to make the required choices.
  if v_min not between 0 and least(v_max, jsonb_array_length(v_addons)) then
    perform private.fail('INVALID_INPUT', 'min_select');
  end if;

  -- Options (validated before anything is written).
  for v_addon in select value from jsonb_array_elements(v_addons) loop
    perform private.assert_keys(v_addon, array['id', 'name', 'price_paise', 'is_available']);
    v_aname := private.tidy_text(private.json_text(v_addon, 'name'));
    if v_aname is null or length(v_aname) > 40 then
      perform private.fail('INVALID_ADDON_NAME');
    end if;
    if private.normalize_name(v_aname) = any (v_names) then
      perform private.fail('ADDON_NAME_DUPLICATE', v_aname);
    end if;
    v_names := v_names || private.normalize_name(v_aname);
    perform private.assert_price(private.json_int(v_addon, 'price_paise'), 'addons');
    if v_addon ? 'is_available' then
      perform private.json_bool(v_addon, 'is_available');
    end if;
    if jsonb_typeof(v_addon -> 'id') = 'string' then
      v_aid := private.json_uuid(v_addon, 'id');
      -- Twice would save fewer options than the list (and min_select) counts.
      if v_aid = any (v_seen_ids) then
        perform private.fail('INVALID_INPUT', 'addons');
      end if;
      v_seen_ids := v_seen_ids || v_aid;
      if v_id is null or not exists (
        select 1 from public.menu_addons a
        where a.id = v_aid and a.group_id = v_id and a.restaurant_id = v_ctx.restaurant_id
      ) then
        perform private.fail('NOT_FOUND', 'addons');
      end if;
    end if;
  end loop;

  begin
    if v_id is null then
      insert into public.menu_addon_groups (restaurant_id, name, min_select, max_select)
      values (v_ctx.restaurant_id, v_name, v_min, v_max)
      returning id into v_id;
    else
      update public.menu_addon_groups g
        set name = v_name, min_select = v_min, max_select = v_max
        where g.id = v_id;
    end if;
  exception when unique_violation then
    perform private.fail('ADDON_GROUP_NAME_DUPLICATE', v_name);
  end;

  -- Sync options in the given order.
  for v_addon, v_ord in
    select value, ordinality from jsonb_array_elements(v_addons) with ordinality
  loop
    v_aname := private.tidy_text(v_addon ->> 'name');
    v_aprice := (v_addon ->> 'price_paise')::bigint;
    if jsonb_typeof(v_addon -> 'id') = 'string' then
      v_aid := (v_addon ->> 'id')::uuid;
      update public.menu_addons a
        set name = v_aname,
            price_paise = v_aprice,
            sort_order = v_ord,
            is_available = coalesce((v_addon ->> 'is_available')::boolean, a.is_available)
        where a.id = v_aid;
    else
      insert into public.menu_addons (restaurant_id, group_id, name, price_paise, is_available, sort_order)
      values (
        v_ctx.restaurant_id, v_id, v_aname, v_aprice,
        coalesce((v_addon ->> 'is_available')::boolean, true), v_ord
      )
      returning id into v_aid;
    end if;
    v_keep_ids := v_keep_ids || v_aid;
  end loop;

  delete from public.menu_addons a
    where a.restaurant_id = v_ctx.restaurant_id and a.group_id = v_id and a.id <> all (v_keep_ids);

  return v_id;
end;
$$;

-- Deletes a group with its options and takes it off every dish. Orders
-- already placed keep their snapshot.
create or replace function public.admin_delete_addon_group(p_group_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  delete from public.menu_addon_groups g
    where g.id = p_group_id and g.restaurant_id = v_ctx.restaurant_id;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
end;
$$;

-- "In stock" switch for one option, like staff_set_item_availability: any
-- staff role, allowed while read-only so service can go on.
create or replace function public.staff_set_addon_availability(p_addon_id uuid, p_available boolean)
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
  update public.menu_addons a
    set is_available = p_available
    where a.id = p_addon_id and a.restaurant_id = v_ctx.restaurant_id;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
end;
$$;

revoke execute on function public.admin_save_addon_group(jsonb) from public, anon;
revoke execute on function public.admin_delete_addon_group(uuid) from public, anon;
revoke execute on function public.staff_set_addon_availability(uuid, boolean) from public, anon;
grant execute on function public.admin_save_addon_group(jsonb) to authenticated;
grant execute on function public.admin_delete_addon_group(uuid) to authenticated;
grant execute on function public.staff_set_addon_availability(uuid, boolean) to authenticated;

-- A dish's add-on groups are set with the dish (addon_group_ids, optional).
-- Otherwise as in 20260912095809.
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
  v_group_ids uuid[];
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  perform private.assert_keys(p_item, array[
    'id', 'category_id', 'name', 'description', 'food_type', 'price_paise',
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

-- ─── Reads that show add-ons ────────────────────────────────────────────────

-- The customer menu: as in 20260912161905, plus addon_groups and each dish's

-- addon_group_ids.
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

-- The customer's orders page: as in 20260912161905, plus each dish's add-on names.
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

-- The live board and kitchen: as in 20260919100300, plus each dish's add-on names.
create or replace function private.board_json(
  p_restaurant_id uuid,
  p_role public.member_role,
  p_member_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_restaurant public.restaurants;
  v_kitchen boolean := p_role = 'kitchen';
  v_tables jsonb;
  v_waiters jsonb;
begin
  select * into v_restaurant from public.restaurants r where r.id = p_restaurant_id;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id', t.id,
             'label', t.label,
             'sort_order', t.sort_order,
             'session', (
               select jsonb_build_object(
                 'id', s.id,
                 'opened_at', s.opened_at,
                 'is_approved', s.is_approved,
                 'assigned_waiter_id', s.assigned_waiter_id,
                 'waiting_count', (
                   select count(*)
                   from public.orders o
                   where o.restaurant_id = s.restaurant_id and o.session_id = s.id
                     and private.is_waiting(o)
                 ),
                 'rounds', coalesce((
                   select jsonb_agg(
                            jsonb_build_object(
                              'id', o.id,
                              'round_number', o.round_number,
                              'status', o.status,
                              'placed_via', o.placed_via,
                              'created_at', o.created_at,
                              'accepted_at', case
                                when o.status = 'accepted' then coalesce(o.decided_at, o.created_at)
                              end,
                              'customer_note', o.customer_note,
                              'reject_reason', o.reject_reason,
                              'removed_reason', o.removed_reason,
                              'removed_by_name', om.display_name,
                              'is_waiting', private.is_waiting(o),
                              'items', coalesce((
                                select jsonb_agg(
                                         jsonb_build_object(
                                           'id', oi.id,
                                           'name', oi.item_name_snapshot,
                                           'variant', oi.variant_name_snapshot,
                                           'addons', private.addon_names(oi.addons_snapshot),
                                           'food_type', oi.food_type_snapshot,
                                           'quantity', oi.quantity,
                                           'note', oi.note,
                                           'status', oi.status,
                                           'removed_reason', oi.removed_reason,
                                           'removed_by_name', im.display_name
                                         )
                                         order by oi.created_at, oi.item_name_snapshot, oi.id
                                       )
                                from public.order_items oi
                                left join public.restaurant_members im
                                  on im.restaurant_id = oi.restaurant_id and im.user_id = oi.removed_by
                                where oi.restaurant_id = o.restaurant_id
                                  and oi.session_id = o.session_id
                                  and oi.order_id = o.id
                              ), '[]'::jsonb)
                            )
                            order by o.round_number
                          )
                   from public.orders o
                   left join public.restaurant_members om
                     on om.restaurant_id = o.restaurant_id and om.user_id = o.removed_by
                   where o.restaurant_id = s.restaurant_id
                     and o.session_id = s.id
                     and (not v_kitchen or o.status = 'accepted')
                 ), '[]'::jsonb)
               )
               from public.table_sessions s
               where s.restaurant_id = t.restaurant_id and s.dining_table_id = t.id and s.status = 'open'
             )
           )
           order by t.sort_order, t.label
         ), '[]'::jsonb)
  into v_tables
  from public.dining_tables t
  where t.restaurant_id = p_restaurant_id
    and (
      t.is_active
      or exists (
        select 1 from public.table_sessions s
        where s.restaurant_id = t.restaurant_id and s.dining_table_id = t.id and s.status = 'open'
      )
    );

  select coalesce(jsonb_agg(
           jsonb_build_object('id', w.id, 'name', w.full_name, 'on_duty', w.on_duty)
           order by w.full_name, w.id
         ), '[]'::jsonb)
  into v_waiters
  from public.waiters w
  where w.restaurant_id = p_restaurant_id and w.is_active;

  return jsonb_build_object(
    'now', now(),
    'timezone', v_restaurant.timezone,
    'role', p_role,
    'my_waiter_id', (
      select w.id from public.waiters w
      where w.restaurant_id = p_restaurant_id and w.member_id = p_member_id and w.is_active
    ),
    'access_state', (select a.state from public.restaurant_access(p_restaurant_id) a),
    'settings', jsonb_build_object(
      'require_first_order_approval', v_restaurant.require_first_order_approval,
      'max_tables_per_waiter', v_restaurant.max_tables_per_waiter,
      'staff_can_remove_served_items', v_restaurant.staff_can_remove_served_items
    ),
    'tables', v_tables,
    'waiters', v_waiters
  );
end;
$$;

-- Bill lines: as in 20260917100000, plus add-on names. A dish with different
-- add-ons is a separate line; the same add-on names (at the same price, which
-- includes them) merge, even if a group was renamed or an option re-made
-- between rounds.
create or replace function private.bill_lines(p_restaurant_id uuid, p_session_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'name', l.name,
        'variant', l.variant,
        'addons', l.addons,
        'qty', l.qty,
        'unit_price_paise', l.unit_price_paise,
        'line_total_paise', l.qty * l.unit_price_paise,
        'food_type', l.food_type
      )
      order by l.first_round, l.first_at, l.name, l.variant
    ),
    '[]'::jsonb
  )
  from (
    select
      oi.item_name_snapshot as name,
      oi.variant_name_snapshot as variant,
      private.addon_names(oi.addons_snapshot) as addons,
      oi.food_type_snapshot as food_type,
      oi.unit_price_paise,
      sum(oi.quantity)::bigint as qty,
      min(o.round_number) as first_round,
      min(oi.created_at) as first_at
    from public.order_items oi
    join public.orders o
      on o.restaurant_id = oi.restaurant_id and o.session_id = oi.session_id and o.id = oi.order_id
    where oi.restaurant_id = p_restaurant_id
      and oi.session_id = p_session_id
      and o.status = 'accepted'
      and oi.status in ('placed', 'preparing', 'ready', 'served')
    group by
      oi.menu_item_id, oi.variant_id, oi.unit_price_paise,
      oi.item_name_snapshot, oi.variant_name_snapshot, oi.food_type_snapshot,
      private.addon_names(oi.addons_snapshot)
  ) as l;
$$;
