-- Automatic Hindi names (docs/DECISIONS.md HN-5 to HN-8). The app writes each
-- dish and category name in Devanagari, sounded out, into name_hi_auto; guests
-- on the Hindi menu see name_hi, then name_hi_auto, then the name as typed.
-- Additive: older deployments neither read nor write the new column.

alter table public.menu_items
  add column name_hi_auto text
    check (name_hi_auto is null or length(btrim(name_hi_auto)) between 1 and 80),
  add column name_hi_auto_tried_at timestamptz;
alter table public.menu_categories
  add column name_hi_auto text
    check (name_hi_auto is null or length(btrim(name_hi_auto)) between 1 and 60),
  add column name_hi_auto_tried_at timestamptz;

-- A renamed dish or category loses its automatic name, whichever path renamed
-- it, and counts as never tried; the next fill writes one for the new name.
create or replace function private.clear_auto_hindi_name()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.name_hi_auto := null;
  new.name_hi_auto_tried_at := null;
  return new;
end;
$$;

create trigger clear_auto_hindi_name before update of name on public.menu_items
  for each row when (old.name is distinct from new.name)
  execute function private.clear_auto_hindi_name();
create trigger clear_auto_hindi_name before update of name on public.menu_categories
  for each row when (old.name is distinct from new.name)
  execute function private.clear_auto_hindi_name();

revoke execute on function private.clear_auto_hindi_name() from public, anon, authenticated;

-- ─── Fill (service role: after menu edits and the daily cron) ───────────────

-- Claims up to p_limit names with no Hindi name of either kind that were not
-- tried in the last 12 hours: never tried first, then oldest; one restaurant,
-- or every restaurant when p_restaurant_id is null. Claiming stamps
-- name_hi_auto_tried_at, so repeated menu edits and overlapping fills don't
-- send the same names again, and a name the model can't write waits for the
-- daily cron instead of holding the front of the list (HN-8).
create or replace function public.menu_hindi_names_claim(
  p_restaurant_id uuid default null,
  p_limit int default 300
)
returns table (restaurant_id uuid, kind text, id uuid, name text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  with picked as (
    select m.restaurant_id, m.kind, m.id, m.name
    from (
      select c.restaurant_id, 'category'::text as kind, c.id, c.name,
             c.name_hi_auto_tried_at as tried_at, c.created_at
      from public.menu_categories c
      where c.name_hi is null and c.name_hi_auto is null
        and (p_restaurant_id is null or c.restaurant_id = p_restaurant_id)
      union all
      select i.restaurant_id, 'item', i.id, i.name, i.name_hi_auto_tried_at, i.created_at
      from public.menu_items i
      where i.name_hi is null and i.name_hi_auto is null
        and (p_restaurant_id is null or i.restaurant_id = p_restaurant_id)
    ) m
    where m.tried_at is null or m.tried_at < now() - interval '12 hours'
    order by m.tried_at asc nulls first, m.created_at, m.id
    limit least(greatest(coalesce(p_limit, 300), 1), 1000)
  ),
  stamped_categories as (
    update public.menu_categories c
      set name_hi_auto_tried_at = now()
    from picked p
    where p.kind = 'category' and c.id = p.id
  ),
  stamped_items as (
    update public.menu_items i
      set name_hi_auto_tried_at = now()
    from picked p
    where p.kind = 'item' and i.id = p.id
  )
  select p.restaurant_id, p.kind, p.id, p.name from picked p;
end;
$$;

-- p_names: [{ kind: 'item'|'category', id, name, name_hi }]. Each is stored
-- only while the row still has that name and no automatic name, so a rename
-- during the conversion drops the stale result and a repeat changes nothing.
-- Returns how many were stored.
create or replace function public.menu_set_hindi_names(p_names jsonb)
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_categories int;
  v_items int;
begin
  if jsonb_typeof(p_names) is distinct from 'array' then
    perform private.fail('INVALID_INPUT', 'names');
  end if;

  update public.menu_categories c
    set name_hi_auto = btrim(g.name_hi)
  from jsonb_to_recordset(p_names) as g(kind text, id uuid, name text, name_hi text)
  where g.kind = 'category' and c.id = g.id and c.name = g.name
    and c.name_hi_auto is null
    and length(btrim(g.name_hi)) between 1 and 60;
  get diagnostics v_categories = row_count;

  update public.menu_items i
    set name_hi_auto = btrim(g.name_hi)
  from jsonb_to_recordset(p_names) as g(kind text, id uuid, name text, name_hi text)
  where g.kind = 'item' and i.id = g.id and i.name = g.name
    and i.name_hi_auto is null
    and length(btrim(g.name_hi)) between 1 and 80;
  get diagnostics v_items = row_count;

  return v_categories + v_items;
end;
$$;

revoke execute on function public.menu_hindi_names_claim(uuid, int) from public, anon, authenticated;
revoke execute on function public.menu_set_hindi_names(jsonb) from public, anon, authenticated;
grant execute on function public.menu_hindi_names_claim(uuid, int) to service_role;
grant execute on function public.menu_set_hindi_names(jsonb) to service_role;


-- ─── Guest reads ────────────────────────────────────────────────────────────

-- The customer menu: as in 20261002100000, with name_hi falling back to name_hi_auto.
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
      cat.id, cat.name, coalesce(cat.name_hi, cat.name_hi_auto) as name_hi, cat.sort_order, cat.created_at,
      (
        select jsonb_agg(
                 jsonb_build_object(
                   'id', i.id,
                   'name', i.name,
                   'name_hi', coalesce(i.name_hi, i.name_hi_auto),
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

-- The customer's orders page: as in 20261002100000, with name_hi falling back to name_hi_auto.
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
                            'name_hi', coalesce(mi.name_hi, mi.name_hi_auto),
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
