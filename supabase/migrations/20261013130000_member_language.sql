-- Stop 11e: the worker panel in Hindi (docs/DECISIONS.md P11-15 to P11-18).
-- Each login keeps the language of its worker panel (/staff); the admin and
-- platform panels and bills stay English.

alter table public.restaurant_members
  add column ui_lang text not null default 'en' check (ui_lang in ('en', 'hi'));

-- ─── Staff logins ───────────────────────────────────────────────────────────
-- As in 20260912095810, plus each login's panel language.
drop function public.admin_list_staff();
create function public.admin_list_staff()
returns table (
  member_id uuid,
  display_name text,
  username text,
  role public.member_role,
  is_active boolean,
  last_sign_in_at timestamptz,
  created_at timestamptz,
  waiter_id uuid,
  waiter_name text,
  ui_lang text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
begin
  return query
    select m.id, m.display_name, m.username, m.role, m.is_active, u.last_sign_in_at, m.created_at,
           w.id, w.full_name, m.ui_lang
    from public.restaurant_members m
    join auth.users u on u.id = m.user_id
    left join public.waiters w on w.member_id = m.id and w.is_active
    where m.restaurant_id = v_ctx.restaurant_id
    order by m.is_active desc,
             array_position(array['owner', 'manager', 'waiter', 'kitchen'], m.role::text),
             m.display_name;
end;
$$;

-- p_patch: { display_name?, role?, ui_lang? }. As in 20260912095810, plus the
-- panel language. A login moved off the waiter role is unlinked from its
-- waiter profile.
create or replace function public.admin_update_staff(p_member_id uuid, p_patch jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_member public.restaurant_members%rowtype;
  v_name text;
  v_role public.member_role;
  v_lang text;
  v_before jsonb := '{}';
  v_after jsonb := '{}';
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  perform private.assert_keys(p_patch, array['display_name', 'role', 'ui_lang']);
  v_member := private.managed_member(v_ctx, p_member_id);

  v_name := v_member.display_name;
  if p_patch ? 'display_name' then
    v_name := private.tidy_text(private.json_text(p_patch, 'display_name'));
    if v_name is null or length(v_name) > 80 then
      perform private.fail('INVALID_DISPLAY_NAME');
    end if;
  end if;
  v_role := v_member.role;
  if p_patch ? 'role' then
    v_role := private.parse_staff_role(private.json_text(p_patch, 'role'));
    if not private.can_manage_role(v_ctx.role, v_role) then
      perform private.fail('ROLE_NOT_ALLOWED');
    end if;
  end if;
  v_lang := v_member.ui_lang;
  if p_patch ? 'ui_lang' then
    v_lang := private.json_text(p_patch, 'ui_lang');
    if v_lang is null or v_lang not in ('en', 'hi') then
      perform private.fail('INVALID_INPUT', 'ui_lang');
    end if;
  end if;

  if v_name is distinct from v_member.display_name then
    v_before := v_before || jsonb_build_object('display_name', v_member.display_name);
    v_after := v_after || jsonb_build_object('display_name', v_name);
  end if;
  if v_role is distinct from v_member.role then
    v_before := v_before || jsonb_build_object('role', v_member.role);
    v_after := v_after || jsonb_build_object('role', v_role);
  end if;
  if v_lang is distinct from v_member.ui_lang then
    v_before := v_before || jsonb_build_object('ui_lang', v_member.ui_lang);
    v_after := v_after || jsonb_build_object('ui_lang', v_lang);
  end if;
  if v_after = '{}' then
    return;
  end if;

  update public.restaurant_members m
    set display_name = v_name, role = v_role, ui_lang = v_lang
    where m.id = v_member.id;

  if v_member.role = 'waiter' and v_role <> 'waiter' then
    update public.waiters w set member_id = null where w.member_id = v_member.id;
  end if;

  perform private.audit_as(
    v_ctx,
    case when v_after ? 'role' then 'staff.role_changed' else 'staff.updated' end,
    'restaurant_member', v_member.id, v_before, v_after
  );
end;
$$;

-- The signed-in login's own panel language, from its account menu. A
-- preference, so it works while the restaurant is read-only and isn't audited.
create or replace function public.member_set_ui_lang(p_lang text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member();
begin
  if p_lang is null or p_lang not in ('en', 'hi') then
    perform private.fail('INVALID_INPUT', 'ui_lang');
  end if;
  update public.restaurant_members m set ui_lang = p_lang where m.id = v_ctx.member_id;
end;
$$;

-- ─── The live board and kitchen ─────────────────────────────────────────────
-- As in 20260929100000, plus each dish's Hindi name (the owner's, else the
-- automatic one) for a worker panel in Hindi.
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
                                           -- ponytail: the dish's current Hindi name, not a
                                           -- snapshot (P11-16); none once the dish has been
                                           -- renamed, so the kitchen never reads another dish.
                                           'name_hi', case
                                             when mi.name = oi.item_name_snapshot
                                               then coalesce(mi.name_hi, mi.name_hi_auto)
                                           end,
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
                                left join public.menu_items mi
                                  on mi.restaurant_id = oi.restaurant_id and mi.id = oi.menu_item_id
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

revoke execute on function public.admin_list_staff() from public, anon;
revoke execute on function public.admin_update_staff(uuid, jsonb) from public, anon;
revoke execute on function public.member_set_ui_lang(text) from public, anon;
grant execute on function public.admin_list_staff() to authenticated;
grant execute on function public.admin_update_staff(uuid, jsonb) to authenticated;
grant execute on function public.member_set_ui_lang(text) to authenticated;
