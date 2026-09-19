-- Read-only support view for platform admins (spec §13.4, docs/DECISIONS.md
-- P7-6): a restaurant's menu, tables, live board and Total orders, audited.

-- The menu as the Menu page shows it, hidden categories and dishes included.
create or replace function private.support_menu_json(p_restaurant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('categories', coalesce(jsonb_agg(
    jsonb_build_object(
      'id', c.id,
      'name', c.name,
      'is_active', c.is_active,
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', i.id,
          'name', i.name,
          'description', i.description,
          'food_type', i.food_type,
          'price_paise', i.price_paise,
          'is_available', i.is_available,
          'is_active', i.is_active,
          'variants', coalesce((
            select jsonb_agg(jsonb_build_object(
              'name', v.name, 'price_paise', v.price_paise
            ) order by v.sort_order, v.name)
            from public.menu_item_variants v
            where v.restaurant_id = i.restaurant_id and v.menu_item_id = i.id and v.is_active
          ), '[]'::jsonb)
        ) order by i.sort_order, i.name)
        from public.menu_items i
        where i.restaurant_id = c.restaurant_id and i.category_id = c.id
      ), '[]'::jsonb)
    ) order by c.sort_order, c.name
  ), '[]'::jsonb))
  from public.menu_categories c
  where c.restaurant_id = p_restaurant_id;
$$;

-- Tables with whether someone is sitting there. QR tokens are left out: they
-- are what lets a phone order at the table (spec §9.2).
create or replace function private.support_tables_json(p_restaurant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('tables', coalesce(jsonb_agg(
    jsonb_build_object(
      'id', t.id,
      'label', t.label,
      'is_active', t.is_active,
      'opened_at', (
        select s.opened_at from public.table_sessions s
        where s.restaurant_id = t.restaurant_id and s.dining_table_id = t.id and s.status = 'open'
      )
    ) order by t.sort_order, t.label
  ), '[]'::jsonb))
  from public.dining_tables t
  where t.restaurant_id = p_restaurant_id;
$$;

revoke execute on function private.support_menu_json(uuid) from public, anon, authenticated;
revoke execute on function private.support_tables_json(uuid) from public, anon, authenticated;

-- A platform admin's read-only look at one section of a restaurant: menu,
-- tables, board (as a manager would see it) or total_orders (p_filters as
-- admin_total_orders). Each look is audited as support.viewed, once per admin,
-- restaurant and section per 10 minutes, because the board refreshes itself.
create or replace function public.platform_support_view(
  p_restaurant_id uuid,
  p_section text,
  p_filters jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.current_platform_admin();
  v_restaurant public.restaurants;
  v_data jsonb;
begin
  if p_section is null or p_section not in ('menu', 'tables', 'board', 'total_orders') then
    perform private.fail('INVALID_INPUT', 'section');
  end if;
  if p_section <> 'total_orders' and coalesce(p_filters, '{}'::jsonb) <> '{}'::jsonb then
    perform private.fail('INVALID_INPUT', 'filters');
  end if;

  select * into v_restaurant from public.restaurants r where r.id = p_restaurant_id;
  if not found then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;

  v_data := case p_section
    when 'menu' then private.support_menu_json(p_restaurant_id)
    when 'tables' then private.support_tables_json(p_restaurant_id)
    when 'board' then private.board_json(p_restaurant_id, 'manager', null)
    else private.total_orders_json(p_restaurant_id, p_filters)
  end;

  if not exists (
    select 1 from public.audit_logs a
    where a.restaurant_id = p_restaurant_id
      and a.created_at > now() - interval '10 minutes'
      and a.action = 'support.viewed'
      and a.actor_user_id = v_admin.user_id
      and a.after ->> 'section' = p_section
  ) then
    perform private.audit_platform(
      v_admin, p_restaurant_id, 'support.viewed', 'restaurant', p_restaurant_id,
      null, jsonb_build_object('section', p_section)
    );
  end if;

  return jsonb_build_object(
    'restaurant', jsonb_build_object(
      'id', v_restaurant.id,
      'name', v_restaurant.name,
      'slug', v_restaurant.slug,
      'timezone', v_restaurant.timezone,
      'status', v_restaurant.status
    ),
    'section', p_section,
    'data', v_data
  );
end;
$$;

revoke execute on function public.platform_support_view(uuid, text, jsonb) from public, anon;
grant execute on function public.platform_support_view(uuid, text, jsonb) to authenticated;
