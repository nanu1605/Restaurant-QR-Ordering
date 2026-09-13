-- Live board data for the worker panel and the admin Live orders page
-- (spec §12, §13.2, §13.3). One read per refresh: every table, its open
-- session's rounds and dishes, the waiters, and the settings the screens need.
-- Realtime events only trigger a refetch of this; nothing is patched from event
-- payloads (spec §12, docs/DECISIONS.md P4-3).
--
-- Kitchen users never receive pending-approval or rejected rounds (spec §10.2),
-- only how many rounds are waiting (docs/DECISIONS.md P4-4). No prices: the
-- board is for service, billing comes later.
create or replace function public.staff_get_board()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member();
  v_restaurant public.restaurants;
  v_kitchen boolean := v_ctx.role = 'kitchen';
  v_tables jsonb;
  v_waiters jsonb;
begin
  select * into v_restaurant from public.restaurants r where r.id = v_ctx.restaurant_id;

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
                     and (not v_kitchen or o.status in ('accepted', 'removed'))
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
  where t.restaurant_id = v_ctx.restaurant_id
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
  where w.restaurant_id = v_ctx.restaurant_id and w.is_active;

  return jsonb_build_object(
    'now', now(),
    'timezone', v_restaurant.timezone,
    'role', v_ctx.role,
    'my_waiter_id', (
      select w.id from public.waiters w
      where w.restaurant_id = v_ctx.restaurant_id and w.member_id = v_ctx.member_id and w.is_active
    ),
    'access_state', (select a.state from public.restaurant_access(v_ctx.restaurant_id) a),
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

revoke execute on function public.staff_get_board() from public, anon;
grant execute on function public.staff_get_board() to authenticated;
