-- Removing dishes and whole rounds, and closing a table without a bill
-- (spec §9.3 staff_remove_item, admin_remove_order, staff_close_session_unbilled;
-- §10.1 sessions; §10.3 and §10.8 removals; §10.6 read-only keeps service
-- going; §10.7 and §8.5 the assignment ends and the waiter is free again;
-- §8.8 audit; docs/DECISIONS.md P4-8, P4-11).
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ─── Fixtures ───────────────────────────────────────────────────────────────
-- Restaurant A: one login per role, waiter profiles Ravi (limit 1 table) and
-- Anita, and tables 5–14 with one story each. Restaurant B: a round whose ids
-- must stay out of A's reach.
select tests.create_restaurant('p4-180-a') as rest_a \gset
select tests.create_restaurant('p4-180-b') as rest_b \gset
select tests.add_member(:'rest_a', 'owner', 'a_owner') as a_owner \gset
select tests.add_member(:'rest_a', 'manager', 'a_manager') as a_manager \gset
select tests.add_member(:'rest_a', 'waiter', 'a_waiter') as a_waiter \gset
select tests.add_member(:'rest_a', 'kitchen', 'a_kitchen') as a_kitchen \gset
select tests.create_user('outsider@p4-180-a.test') as outsider \gset
select tests.add_waiter(:'rest_a', 'Ravi', :'a_waiter') as w_ravi \gset
select tests.add_waiter(:'rest_a', 'Anita') as w_anita \gset

select tests.create_ordering_fixture(:'rest_a', 'P4180A0000TABLE5') as fx \gset
select tests.create_ordering_fixture(:'rest_b', 'P4180B0000TABLE5') as fx_b \gset
select
  :'fx'::jsonb ->> 'simple' as simple,
  :'fx'::jsonb ->> 'variant_item' as variant_item,
  :'fx'::jsonb ->> 'full' as full,
  :'fx_b'::jsonb ->> 'simple' as b_simple
\gset

insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
values
  (:'rest_a', '6', 'P4180A0000TABLE6', 6),
  (:'rest_a', '7', 'P4180A0000TABLE7', 7),
  (:'rest_a', '8', 'P4180A0000TABLE8', 8),
  (:'rest_a', '9', 'P4180A0000TABLE9', 9),
  (:'rest_a', '10', 'P4180A000TABLE10', 10),
  (:'rest_a', '11', 'P4180A000TABLE11', 11),
  (:'rest_a', '12', 'P4180A000TABLE12', 12),
  (:'rest_a', '13', 'P4180A000TABLE13', 13),
  (:'rest_a', '14', 'P4180A000TABLE14', 14);

-- An approved open session at the table with this QR token, so customer
-- rounds there are accepted straight away. Returns the session id.
create function pg_temp.approved_session(p_token text)
returns uuid
language sql
as $$
  insert into public.table_sessions (
    restaurant_id, dining_table_id, table_label_snapshot, is_approved, approved_at
  )
  select t.restaurant_id, t.id, t.label, true, now() - interval '1 hour'
  from public.dining_tables t
  where t.qr_token = p_token
  returning id;
$$;

-- A customer order placed as the server, from a new phone each time so no
-- rate limit trips. Returns the order id.
create function pg_temp.customer_order(p_token text, p_key text, variadic p_lines jsonb[])
returns uuid
language sql
as $$
  select (
    public.customer_place_order(p_token, gen_random_uuid()::text, p_key, to_jsonb(p_lines))
      ->> 'order_id'
  )::uuid;
$$;

-- The dish of an order that carries the given note.
create function pg_temp.dish(p_order uuid, p_note text)
returns uuid
language sql
as $$
  select id from public.order_items where order_id = p_order and note = p_note;
$$;

-- The error code plus DETAIL a statement raises, or 'no error'.
create function pg_temp.error_of(p_sql text)
returns text
language plpgsql
as $$
declare
  v_detail text;
begin
  execute p_sql;
  return 'no error';
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  return sqlerrm || coalesce(' ' || nullif(v_detail, ''), '');
end;
$$;

-- Audit rows for one action on one entity.
create function pg_temp.audits(p_action text, p_entity uuid)
returns bigint
language sql
as $$
  select count(*) from public.audit_logs where action = p_action and entity_id = p_entity;
$$;

-- Table 5: single dishes of an accepted round, in every state removal cares about.
select pg_temp.approved_session('P4180A0000TABLE5') as t5_session \gset
select pg_temp.customer_order(
  'P4180A0000TABLE5', 'p4180-t5-round-1',
  tests.line(:'simple', 3, null, 'partial'),
  tests.line(:'variant_item', 2, :'full', 'whole'),
  tests.line(:'simple', 2, null, 'served staff'),
  tests.line(:'simple', 2, null, 'served mgr'),
  tests.line(:'simple', 1, null, 'served owner'),
  tests.line(:'simple', 1, null, 'cancelled')
) as t5_r1 \gset
update public.order_items set status = 'preparing' where order_id = :'t5_r1' and note = 'whole';
update public.order_items
  set status = 'served', served_at = now() - interval '20 minutes', served_by = :'a_waiter'
  where order_id = :'t5_r1' and note in ('served staff', 'served mgr', 'served owner');
update public.order_items set status = 'cancelled', cancelled_at = now() - interval '10 minutes'
  where order_id = :'t5_r1' and note = 'cancelled';

-- Table 6: an unapproved session with two waiting rounds and a rejected one.
select pg_temp.customer_order(
  'P4180A0000TABLE6', 'p4180-t6-round-1',
  tests.line(:'simple', 1, null, 'p keep'),
  tests.line(:'simple', 2, null, 'p remove')
) as t6_r1 \gset
select pg_temp.customer_order(
  'P4180A0000TABLE6', 'p4180-t6-round-2',
  tests.line(:'simple', 1, null, 'w one'),
  tests.line(:'variant_item', 1, :'full', 'w two')
) as t6_r2 \gset
select pg_temp.customer_order(
  'P4180A0000TABLE6', 'p4180-t6-round-3', tests.line(:'simple', 1, null, 'rejected')
) as t6_r3 \gset
update public.orders set status = 'rejected', decided_at = now(), reject_reason = 'Prank order'
  where id = :'t6_r3';
update public.order_items set status = 'cancelled', cancelled_at = now() where order_id = :'t6_r3';
-- …and a waiting round whose only dish the customer cancelled.
select pg_temp.customer_order(
  'P4180A0000TABLE6', 'p4180-t6-round-4', tests.line(:'simple', 1, null, 'all cancelled')
) as t6_r4 \gset
update public.order_items set status = 'cancelled', cancelled_at = now() - interval '10 minutes'
  where order_id = :'t6_r4';

-- Table 7: the only round was rejected.
select pg_temp.customer_order('P4180A0000TABLE7', 'p4180-t7-round-1', tests.line(:'simple')) as t7_r1 \gset
select session_id as t7_session from public.orders where id = :'t7_r1' \gset
update public.orders set status = 'rejected', decided_at = now(), reject_reason = 'Nobody at the table'
  where id = :'t7_r1';
update public.order_items set status = 'cancelled', cancelled_at = now() where order_id = :'t7_r1';

-- Table 8: the only round is still waiting for approval.
select pg_temp.customer_order(
  'P4180A0000TABLE8', 'p4180-t8-round-1', tests.line(:'simple', 1, null, 'waiting')
) as t8_r1 \gset
select session_id as t8_session from public.orders where id = :'t8_r1' \gset

-- Table 9: an accepted round with a dish in every state. Anita handled the
-- table first, then Ravi took over.
select pg_temp.approved_session('P4180A0000TABLE9') as t9_session \gset
select pg_temp.customer_order(
  'P4180A0000TABLE9', 'p4180-t9-round-1',
  tests.line(:'simple', 1, null, 'c placed'),
  tests.line(:'simple', 1, null, 'c preparing'),
  tests.line(:'simple', 1, null, 'c ready'),
  tests.line(:'simple', 1, null, 'c served'),
  tests.line(:'simple', 1, null, 'c cancelled'),
  tests.line(:'simple', 1, null, 'c removed')
) as t9_r1 \gset
update public.order_items set status = 'preparing' where order_id = :'t9_r1' and note = 'c preparing';
update public.order_items set status = 'ready' where order_id = :'t9_r1' and note = 'c ready';
update public.order_items
  set status = 'served', served_at = now() - interval '20 minutes', served_by = :'a_waiter'
  where order_id = :'t9_r1' and note = 'c served';
update public.order_items set status = 'cancelled', cancelled_at = now() - interval '10 minutes'
  where order_id = :'t9_r1' and note = 'c cancelled';
update public.order_items
  set status = 'removed', removed_at = now() - interval '5 minutes', removed_by = :'a_owner',
      removed_reason = 'Spilled'
  where order_id = :'t9_r1' and note = 'c removed';
insert into public.session_waiter_assignments (
  restaurant_id, session_id, waiter_id, assigned_at, assigned_by, unassigned_at, unassign_reason
)
values
  (:'rest_a', :'t9_session', :'w_anita', now() - interval '50 minutes', :'a_manager',
   now() - interval '30 minutes', 'reassigned'),
  (:'rest_a', :'t9_session', :'w_ravi', now() - interval '30 minutes', :'a_manager', null, null);
update public.table_sessions
  set assigned_waiter_id = :'w_ravi', assigned_at = now() - interval '30 minutes', assigned_by = :'a_manager'
  where id = :'t9_session';

-- Table 10: an open table waiting for a waiter.
select pg_temp.approved_session('P4180A000TABLE10') as t10_session \gset

-- Table 11: an accepted round with one dish, moved through every status.
select pg_temp.approved_session('P4180A000TABLE11') as t11_session \gset
select pg_temp.customer_order(
  'P4180A000TABLE11', 'p4180-t11-round-1', tests.line(:'simple', 1, null, 'only')
) as t11_r1 \gset

-- Table 12: a billed session.
select pg_temp.approved_session('P4180A000TABLE12') as t12_session \gset
select pg_temp.customer_order(
  'P4180A000TABLE12', 'p4180-t12-round-1', tests.line(:'simple', 2, null, 'billed')
) as t12_r1 \gset
update public.order_items set status = 'served', served_at = now() - interval '20 minutes'
  where order_id = :'t12_r1';
select tests.bill_session(:'t12_session');

-- Table 13: a round to delete whole, with a dish in every state, and a
-- second round that must be left alone.
select pg_temp.approved_session('P4180A000TABLE13') as t13_session \gset
select pg_temp.customer_order(
  'P4180A000TABLE13', 'p4180-t13-round-1',
  tests.line(:'simple', 2, null, 'd placed'),
  tests.line(:'variant_item', 1, :'full', 'd preparing'),
  tests.line(:'simple', 1, null, 'd ready'),
  tests.line(:'simple', 1, null, 'd served'),
  tests.line(:'simple', 1, null, 'd cancelled'),
  tests.line(:'simple', 1, null, 'd removed')
) as t13_r1 \gset
select pg_temp.customer_order(
  'P4180A000TABLE13', 'p4180-t13-round-2', tests.line(:'simple', 1, null, 'd other round')
) as t13_r2 \gset
update public.order_items set status = 'preparing' where order_id = :'t13_r1' and note = 'd preparing';
update public.order_items set status = 'ready' where order_id = :'t13_r1' and note = 'd ready';
update public.order_items
  set status = 'served', served_at = now() - interval '20 minutes', served_by = :'a_waiter'
  where order_id = :'t13_r1' and note = 'd served';
update public.order_items set status = 'cancelled', cancelled_at = now() - interval '10 minutes'
  where order_id = :'t13_r1' and note = 'd cancelled';
update public.order_items
  set status = 'removed', removed_at = now() - interval '5 minutes', removed_by = :'a_owner',
      removed_reason = 'Spilled'
  where order_id = :'t13_r1' and note = 'd removed';

-- Table 14: two accepted rounds, handled at the end while read-only.
select pg_temp.approved_session('P4180A000TABLE14') as t14_session \gset
select pg_temp.customer_order(
  'P4180A000TABLE14', 'p4180-t14-round-1',
  tests.line(:'simple', 2, null, 'ro partial'),
  tests.line(:'simple', 1, null, 'ro served')
) as t14_r1 \gset
select pg_temp.customer_order(
  'P4180A000TABLE14', 'p4180-t14-round-2', tests.line(:'simple', 1, null, 'ro round')
) as t14_r2 \gset
update public.order_items
  set status = 'served', served_at = now() - interval '20 minutes', served_by = :'a_waiter'
  where order_id = :'t14_r1' and note = 'ro served';

-- Restaurant B: one waiting round.
select pg_temp.customer_order(
  'P4180B0000TABLE5', 'p4180-b-round-1', tests.line(:'b_simple', 1, null, 'other')
) as b_r1 \gset
select session_id as b_session from public.orders where id = :'b_r1' \gset

-- Every dish of A last changed an hour ago, so "changed now, by whom" shows.
update public.order_items set status_changed_at = now() - interval '1 hour' where restaurant_id = :'rest_a';

select
  pg_temp.dish(:'t5_r1', 'partial') as i_partial,
  pg_temp.dish(:'t5_r1', 'whole') as i_whole,
  pg_temp.dish(:'t5_r1', 'served staff') as i_served_staff,
  pg_temp.dish(:'t5_r1', 'served mgr') as i_served_mgr,
  pg_temp.dish(:'t5_r1', 'served owner') as i_served_owner,
  pg_temp.dish(:'t5_r1', 'cancelled') as i_cancelled,
  pg_temp.dish(:'t6_r1', 'p remove') as i_p_remove,
  pg_temp.dish(:'t6_r2', 'w one') as i_w_one,
  pg_temp.dish(:'t6_r3', 'rejected') as i_rejected,
  pg_temp.dish(:'t9_r1', 'c served') as i_c_served,
  pg_temp.dish(:'t11_r1', 'only') as i_only,
  pg_temp.dish(:'t12_r1', 'billed') as i_billed,
  pg_temp.dish(:'t14_r1', 'ro partial') as i_ro_partial,
  pg_temp.dish(:'t14_r1', 'ro served') as i_ro_served,
  pg_temp.dish(:'b_r1', 'other') as i_other
\gset

-- ─── Who may call them ──────────────────────────────────────────────────────
select ok(
  (
    select bool_and(
      has_function_privilege('authenticated', f, 'execute')
      and not has_function_privilege('anon', f, 'execute')
    )
    from unnest(array[
      'public.staff_remove_item(uuid, int, text)',
      'public.admin_remove_order(uuid, text)',
      'public.staff_close_session_unbilled(uuid, text)'
    ]) as f
  ),
  'signed-in staff can call these functions, anonymous visitors cannot'
);
select ok(
  not has_function_privilege(
    'authenticated', 'private.end_assignment(uuid, public.unassign_reason)', 'execute'
  ),
  'the end-assignment helper is not callable directly'
);

select tests.authenticate_as(:'outsider');
select throws_ok(
  format($f$ select public.staff_remove_item(%L, 1, 'Complaint') $f$, :'i_partial'),
  'P0001', 'FORBIDDEN', 'a login without a membership cannot remove dishes'
);
select throws_ok(
  format($f$ select public.admin_remove_order(%L, 'Wrong table') $f$, :'t13_r1'),
  'P0001', 'FORBIDDEN', 'or delete rounds'
);
select throws_ok(
  format($f$ select public.staff_close_session_unbilled(%L, 'Guests left') $f$, :'t8_session'),
  'P0001', 'FORBIDDEN', 'or close tables'
);

-- ─── Remove a dish: reason and quantity (table 5) ───────────────────────────
select tests.authenticate_as(:'a_kitchen');
select throws_ok(
  format($f$ select public.staff_remove_item(%L, 1, null) $f$, :'i_partial'),
  'P0001', 'REASON_REQUIRED', 'removing a dish needs a reason'
);
select throws_ok(
  format($f$ select public.staff_remove_item(%L, 1, '   ') $f$, :'i_partial'),
  'P0001', 'REASON_REQUIRED', 'a blank reason is no reason'
);
select is(
  pg_temp.error_of(format($f$ select public.staff_remove_item(%L, 1, %L) $f$, :'i_partial', repeat('x', 201))),
  'INVALID_INPUT reason',
  'a reason is at most 200 characters'
);
select is(
  pg_temp.error_of(format($f$ select public.staff_remove_item(%L, 0, 'Out of paneer') $f$, :'i_partial')),
  'INVALID_INPUT quantity',
  'at least one must be removed'
);
select is(
  pg_temp.error_of(format($f$ select public.staff_remove_item(%L, -1, 'Out of paneer') $f$, :'i_partial')),
  'INVALID_INPUT quantity',
  'a negative quantity is refused'
);
select is(
  pg_temp.error_of(format($f$ select public.staff_remove_item(%L, null, 'Out of paneer') $f$, :'i_partial')),
  'INVALID_INPUT quantity',
  'a quantity is required'
);
select is(
  pg_temp.error_of(format($f$ select public.staff_remove_item(%L, 4, 'Out of paneer') $f$, :'i_partial')),
  'INVALID_INPUT quantity',
  'no more can be removed than the line holds'
);
select tests.clear_auth();
select results_eq(
  format($f$ select quantity, status::text from public.order_items where id = %L $f$, :'i_partial'),
  $$ values (3, 'placed') $$,
  'refused removals leave the dish as it was'
);
select is(pg_temp.audits('order_item.removed', :'i_partial'), 0::bigint, 'and are not logged');

-- ─── Partial and full removal (table 5) ─────────────────────────────────────
select tests.authenticate_as(:'a_kitchen');
select is(
  public.staff_remove_item(:'i_partial', 1, '  Out of   paneer '),
  jsonb_build_object('order_item_id', :'i_partial', 'status', 'placed', 'quantity', 2),
  'the kitchen removes one of three: the line now holds two'
);
select tests.clear_auth();
select results_eq(
  format(
    $f$ select quantity, status::text, status_changed_by, removed_at, removed_by, removed_reason
        from public.order_items where id = %L $f$,
    :'i_partial'
  ),
  $$ values (2, 'placed', null::uuid, null::timestamptz, null::uuid, null::text) $$,
  'a partial removal lowers the quantity in place: same status, nothing marked removed'
);
select results_eq(
  format(
    $f$ select actor_user_id, actor_role::text, entity_type, before, after, reason
        from public.audit_logs where action = 'order_item.removed' and entity_id = %L $f$,
    :'i_partial'
  ),
  format(
    $f$ values (%L::uuid, 'kitchen', 'order_item',
                '{"name": "Paneer Tikka", "variant": null, "status": "placed", "quantity": 3}'::jsonb,
                '{"status": "placed", "quantity": 2, "removed_quantity": 1}'::jsonb,
                'Out of paneer') $f$,
    :'a_kitchen'
  ),
  'the partial removal is audit logged with the quantity before and after, and the tidied reason'
);

select tests.authenticate_as(:'a_kitchen');
select is(
  public.staff_remove_item(:'i_partial', 2, 'Guest changed their mind'),
  jsonb_build_object('order_item_id', :'i_partial', 'status', 'removed', 'quantity', 2),
  'removing the rest marks the dish removed'
);
select tests.clear_auth();
select results_eq(
  format(
    $f$ select quantity, status::text, removed_at = now(), removed_by, removed_reason,
               status_changed_by, status_changed_at = now()
        from public.order_items where id = %L $f$,
    :'i_partial'
  ),
  format(
    $f$ values (2, 'removed', true, %1$L::uuid, 'Guest changed their mind', %1$L::uuid, true) $f$,
    :'a_kitchen'
  ),
  'a removed dish keeps its quantity and records who removed it, when and why'
);
select is(pg_temp.audits('order_item.removed', :'i_partial'), 2::bigint, 'each removal is logged');
select results_eq(
  format(
    $f$ select before, after, reason from public.audit_logs
        where action = 'order_item.removed' and entity_id = %L and after ->> 'status' = 'removed' $f$,
    :'i_partial'
  ),
  $$ values ('{"name": "Paneer Tikka", "variant": null, "status": "placed", "quantity": 2}'::jsonb,
             '{"status": "removed", "quantity": 2, "removed_quantity": 2}'::jsonb,
             'Guest changed their mind') $$,
  'the full removal is logged with the status change and the reason'
);

select tests.authenticate_as(:'a_waiter');
select is(
  public.staff_remove_item(:'i_whole', 2, 'Took too long'),
  jsonb_build_object('order_item_id', :'i_whole', 'status', 'removed', 'quantity', 2),
  'a waiter removes a dish the kitchen is still preparing'
);
select tests.clear_auth();
select results_eq(
  format(
    $f$ select status::text, removed_by, removed_reason from public.order_items where id = %L $f$,
    :'i_whole'
  ),
  format($f$ values ('removed', %L::uuid, 'Took too long') $f$, :'a_waiter'),
  'the dish is removed by that waiter'
);
select results_eq(
  format(
    $f$ select actor_role::text, before ->> 'name', before ->> 'variant', before ->> 'status'
        from public.audit_logs where action = 'order_item.removed' and entity_id = %L $f$,
    :'i_whole'
  ),
  $$ values ('waiter', 'Butter Chicken', 'Full', 'preparing') $$,
  'the log names the dish, its option and the status it had'
);

select tests.authenticate_as(:'a_manager');
select throws_ok(
  format($f$ select public.staff_remove_item(%L, 1, 'Again') $f$, :'i_partial'),
  'P0001', 'ITEM_NOT_ACTIVE', 'a removed dish cannot be removed again'
);
select throws_ok(
  format($f$ select public.staff_remove_item(%L, 1, 'Complaint') $f$, :'i_cancelled'),
  'P0001', 'ITEM_NOT_ACTIVE', 'a dish the customer cancelled cannot be removed'
);
select throws_ok(
  format($f$ select public.staff_remove_item(%L, 1, 'Complaint') $f$, gen_random_uuid()),
  'P0001', 'NOT_FOUND', 'an unknown dish is not found'
);

-- ─── Served dishes (table 5) ────────────────────────────────────────────────
select tests.authenticate_as(:'a_kitchen');
select throws_ok(
  format($f$ select public.staff_remove_item(%L, 2, 'Complaint') $f$, :'i_served_staff'),
  'P0001', 'REQUIRES_MANAGER', 'the kitchen cannot remove a served dish'
);
select throws_ok(
  format($f$ select public.staff_remove_item(%L, 1, 'Complaint') $f$, :'i_served_staff'),
  'P0001', 'REQUIRES_MANAGER', 'nor reduce its quantity'
);
select tests.authenticate_as(:'a_waiter');
select throws_ok(
  format($f$ select public.staff_remove_item(%L, 2, 'Complaint') $f$, :'i_served_staff'),
  'P0001', 'REQUIRES_MANAGER', 'a waiter cannot remove a served dish either'
);
select throws_ok(
  format($f$ select public.staff_remove_item(%L, 1, 'Complaint') $f$, :'i_served_staff'),
  'P0001', 'REQUIRES_MANAGER', 'nor reduce it'
);
select tests.clear_auth();
select results_eq(
  format($f$ select quantity, status::text from public.order_items where id = %L $f$, :'i_served_staff'),
  $$ values (2, 'served') $$,
  'the served dish is untouched'
);
select is(
  pg_temp.audits('order_item.removed', :'i_served_staff') + pg_temp.audits('order_item.removed', :'i_cancelled'),
  0::bigint,
  'refused removals are not logged'
);

select tests.authenticate_as(:'a_manager');
select is(
  public.staff_remove_item(:'i_served_mgr', 1, 'Cold'),
  jsonb_build_object('order_item_id', :'i_served_mgr', 'status', 'served', 'quantity', 1),
  'a manager reduces a served dish, which stays served'
);
select tests.authenticate_as(:'a_owner');
select is(
  public.staff_remove_item(:'i_served_owner', 1, 'Complaint'),
  jsonb_build_object('order_item_id', :'i_served_owner', 'status', 'removed', 'quantity', 1),
  'an owner removes a served dish'
);
select tests.clear_auth();
select results_eq(
  format(
    $f$ select note, quantity, status::text, served_by, removed_by, removed_reason
        from public.order_items where id in (%L, %L) order by note $f$,
    :'i_served_mgr', :'i_served_owner'
  ),
  format(
    $f$ values ('served mgr', 1, 'served', %1$L::uuid, null::uuid, null::text),
               ('served owner', 1, 'removed', %1$L::uuid, %2$L::uuid, 'Complaint') $f$,
    :'a_waiter', :'a_owner'
  ),
  'managers and owners can reduce or remove served dishes'
);

-- With staff_can_remove_served_items on, the kitchen and waiters may too.
update public.restaurants set staff_can_remove_served_items = true where id = :'rest_a';
select tests.authenticate_as(:'a_kitchen');
select is(
  public.staff_remove_item(:'i_served_staff', 1, 'Complaint'),
  jsonb_build_object('order_item_id', :'i_served_staff', 'status', 'served', 'quantity', 1),
  'with the setting on, the kitchen reduces a served dish'
);
select tests.authenticate_as(:'a_waiter');
select is(
  public.staff_remove_item(:'i_served_staff', 1, 'Complaint') ->> 'status',
  'removed',
  'and a waiter removes the rest'
);
select tests.clear_auth();
select set_eq(
  format(
    $f$ select actor_role::text as role, before ->> 'quantity' as quantity_before,
               after ->> 'status' as status_after, after ->> 'quantity' as quantity_after
        from public.audit_logs where action = 'order_item.removed' and entity_id = %L $f$,
    :'i_served_staff'
  ),
  $$ values ('kitchen', '2', 'served', '1'), ('waiter', '1', 'removed', '1') $$,
  'both are logged against the staff member who made them'
);
update public.restaurants set staff_can_remove_served_items = false where id = :'rest_a';

-- ─── Waiting, rejected and removed rounds (table 6) ─────────────────────────
select tests.authenticate_as(:'a_waiter');
select is(
  public.staff_remove_item(:'i_p_remove', 2, 'Ordered twice') ->> 'status',
  'removed',
  'a dish of a round waiting for approval can be removed'
);
select tests.clear_auth();
select results_eq(
  format(
    $f$ select o.status::text, oi.note, oi.status::text
        from public.order_items oi join public.orders o on o.id = oi.order_id
        where oi.order_id = %L order by oi.note $f$,
    :'t6_r1'
  ),
  $$ values ('pending_approval', 'p keep', 'placed'), ('pending_approval', 'p remove', 'removed') $$,
  'the round keeps waiting with its other dish'
);

select tests.authenticate_as(:'a_manager');
select throws_ok(
  format($f$ select public.staff_remove_item(%L, 1, 'Complaint') $f$, :'i_rejected'),
  'P0001', 'ORDER_NOT_ACTIVE', 'a dish of a rejected round cannot be removed'
);

-- ─── Delete a whole round (table 13, then table 6) ──────────────────────────
select tests.authenticate_as(:'a_waiter');
select throws_ok(
  format($f$ select public.admin_remove_order(%L, 'Wrong table') $f$, :'t13_r1'),
  'P0001', 'FORBIDDEN', 'a waiter cannot delete a round'
);
select tests.authenticate_as(:'a_kitchen');
select throws_ok(
  format($f$ select public.admin_remove_order(%L, 'Wrong table') $f$, :'t13_r1'),
  'P0001', 'FORBIDDEN', 'nor can the kitchen'
);
select tests.authenticate_as(:'a_manager');
select throws_ok(
  format($f$ select public.admin_remove_order(%L, null) $f$, :'t13_r1'),
  'P0001', 'REASON_REQUIRED', 'deleting a round needs a reason'
);
select is(
  pg_temp.error_of(format($f$ select public.admin_remove_order(%L, %L) $f$, :'t13_r1', repeat('x', 201))),
  'INVALID_INPUT reason',
  'of at most 200 characters'
);
select tests.clear_auth();
select is(
  (select status::text from public.orders where id = :'t13_r1'),
  'accepted',
  'refused deletions leave the round as it was'
);

select tests.authenticate_as(:'a_manager');
select is(
  public.admin_remove_order(:'t13_r1', '  Wrong   table '),
  jsonb_build_object('order_id', :'t13_r1', 'status', 'removed', 'removed_items', 4),
  'a manager deletes a whole round; four of its dishes were still live'
);
select tests.clear_auth();
select results_eq(
  format(
    $f$ select status::text, removed_by, removed_at = now(), removed_reason
        from public.orders where id = %L $f$,
    :'t13_r1'
  ),
  format($f$ values ('removed', %L::uuid, true, 'Wrong table') $f$, :'a_manager'),
  'the round is marked removed with who, when and the tidied reason'
);
select results_eq(
  format(
    $f$ select note, status::text, removed_by, removed_at = now(), removed_reason, cancelled_at is not null
        from public.order_items where order_id = %L order by note $f$,
    :'t13_r1'
  ),
  format(
    $f$ values
      ('d cancelled', 'cancelled', null::uuid, null::boolean, null::text, true),
      ('d placed', 'removed', %1$L::uuid, true, 'Wrong table', false),
      ('d preparing', 'removed', %1$L::uuid, true, 'Wrong table', false),
      ('d ready', 'removed', %1$L::uuid, true, 'Wrong table', false),
      ('d removed', 'removed', %2$L::uuid, false, 'Spilled', false),
      ('d served', 'removed', %1$L::uuid, true, 'Wrong table', false) $f$,
    :'a_manager', :'a_owner'
  ),
  'every live dish is removed with the reason, served ones included; cancelled and removed dishes keep their story'
);
select results_eq(
  format(
    $f$ select o.status::text, oi.status::text
        from public.orders o join public.order_items oi on oi.order_id = o.id where o.id = %L $f$,
    :'t13_r2'
  ),
  $$ values ('accepted', 'placed') $$,
  'the table''s other round is untouched'
);
select results_eq(
  format(
    $f$ select actor_user_id, actor_role::text, entity_type, before ->> 'status',
               (before ->> 'round_number')::int, after, reason
        from public.audit_logs where action = 'order.removed' and entity_id = %L $f$,
    :'t13_r1'
  ),
  format(
    $f$ values (%L::uuid, 'manager', 'order', 'accepted', 1,
                '{"status": "removed", "removed_items": 4}'::jsonb, 'Wrong table') $f$,
    :'a_manager'
  ),
  'deleting the round is audit logged with the reason'
);
select set_eq(
  format(
    $f$ select oi.note, i ->> 'status' as status, (i ->> 'quantity')::int as quantity
        from public.audit_logs a
        cross join jsonb_array_elements(a.before -> 'items') i
        join public.order_items oi on oi.id = (i ->> 'id')::uuid
        where a.action = 'order.removed' and a.entity_id = %L $f$,
    :'t13_r1'
  ),
  $$ values ('d placed', 'placed', 2), ('d preparing', 'preparing', 1),
            ('d ready', 'ready', 1), ('d served', 'served', 1) $$,
  'the log keeps the dishes that were removed, as they were'
);

select tests.authenticate_as(:'a_owner');
select is(
  public.admin_remove_order(:'t6_r2', 'Duplicate order'),
  jsonb_build_object('order_id', :'t6_r2', 'status', 'removed', 'removed_items', 2),
  'an owner deletes a round still waiting for approval'
);
select tests.clear_auth();
select results_eq(
  format(
    $f$ select o.status::text, oi.note, oi.status::text, oi.removed_reason
        from public.orders o join public.order_items oi on oi.order_id = o.id
        where o.id = %L order by oi.note $f$,
    :'t6_r2'
  ),
  $$ values ('removed', 'w one', 'removed', 'Duplicate order'),
            ('removed', 'w two', 'removed', 'Duplicate order') $$,
  'the waiting round and its dishes are removed'
);

select tests.authenticate_as(:'a_manager');
select throws_ok(
  format($f$ select public.admin_remove_order(%L, 'Again') $f$, :'t6_r2'),
  'P0001', 'ORDER_NOT_ACTIVE', 'a removed round cannot be deleted again'
);
select throws_ok(
  format($f$ select public.admin_remove_order(%L, 'Prank') $f$, :'t6_r3'),
  'P0001', 'ORDER_NOT_ACTIVE', 'a rejected round cannot be deleted'
);
select throws_ok(
  format($f$ select public.staff_remove_item(%L, 1, 'Complaint') $f$, :'i_w_one'),
  'P0001', 'ORDER_NOT_ACTIVE', 'a dish of a removed round cannot be removed'
);
select throws_ok(
  format($f$ select public.admin_remove_order(%L, 'Wrong table') $f$, gen_random_uuid()),
  'P0001', 'NOT_FOUND', 'an unknown round is not found'
);
select is(
  public.admin_remove_order(:'t6_r4', 'Customer left'),
  jsonb_build_object('order_id', :'t6_r4', 'status', 'removed', 'removed_items', 0),
  'a waiting round the customer cancelled completely can still be deleted, with nothing left to remove'
);
select tests.clear_auth();
select results_eq(
  format(
    $f$ select o.status::text, oi.status::text, oi.removed_reason
        from public.orders o join public.order_items oi on oi.order_id = o.id where o.id = %L $f$,
    :'t6_r4'
  ),
  $$ values ('removed', 'cancelled', null::text) $$,
  'its cancelled dish stays cancelled'
);
select is(pg_temp.audits('order.removed', :'t6_r2'), 1::bigint, 'the refused repeat is not logged');
select results_eq(
  format($f$ select status::text, reject_reason from public.orders where id = %L $f$, :'t6_r3'),
  $$ values ('rejected', 'Prank order') $$,
  'the rejected round stays rejected'
);

-- ─── Close without a bill: waiters with nothing accepted (tables 8 and 7) ───
select tests.authenticate_as(:'a_kitchen');
select throws_ok(
  format($f$ select public.staff_close_session_unbilled(%L, 'Guests left') $f$, :'t8_session'),
  'P0001', 'FORBIDDEN', 'the kitchen cannot close a table'
);
select tests.authenticate_as(:'a_waiter');
select throws_ok(
  format($f$ select public.staff_close_session_unbilled(%L, '') $f$, :'t8_session'),
  'P0001', 'REASON_REQUIRED', 'closing a table needs a reason'
);
select is(
  pg_temp.error_of(
    format($f$ select public.staff_close_session_unbilled(%L, %L) $f$, :'t8_session', repeat('x', 201))
  ),
  'INVALID_INPUT reason',
  'of at most 200 characters'
);
select is(
  public.staff_close_session_unbilled(:'t8_session', 'Guests left before approval'),
  jsonb_build_object('session_id', :'t8_session', 'status', 'closed_unbilled', 'cancelled_items', 1),
  'a waiter closes a table whose only round is still waiting for approval'
);
select tests.clear_auth();
select results_eq(
  format(
    $f$ select status::text, closed_at = now(), closed_by, close_reason, billed_at
        from public.table_sessions where id = %L $f$,
    :'t8_session'
  ),
  format(
    $f$ values ('closed_unbilled', true, %L::uuid, 'Guests left before approval', null::timestamptz) $f$,
    :'a_waiter'
  ),
  'the session is closed without a bill, recording who, when and why'
);
select results_eq(
  format(
    $f$ select status::text, cancelled_at = now(), status_changed_by, status_changed_at = now()
        from public.order_items where order_id = %L $f$,
    :'t8_r1'
  ),
  format($f$ values ('cancelled', true, %L::uuid, true) $f$, :'a_waiter'),
  'the waiting dish is cancelled'
);

select tests.authenticate_as(:'a_waiter');
select is(
  public.staff_close_session_unbilled(:'t7_session', 'Prank table'),
  jsonb_build_object('session_id', :'t7_session', 'status', 'closed_unbilled', 'cancelled_items', 0),
  'a waiter closes a table whose only round was rejected'
);
select tests.clear_auth();
select results_eq(
  format(
    $f$ select actor_user_id, actor_role::text, entity_type, before, after, reason
        from public.audit_logs where action = 'session.closed_unbilled' and entity_id = %L $f$,
    :'t7_session'
  ),
  format(
    $f$ values (%L::uuid, 'waiter', 'table_session',
                '{"status": "open", "table": "7", "assigned_waiter_id": null}'::jsonb,
                '{"status": "closed_unbilled", "cancelled_items": 0}'::jsonb,
                'Prank table') $f$,
    :'a_waiter'
  ),
  'closing is audit logged'
);

-- ─── Close without a bill: accepted dishes need a manager (table 11) ────────
select tests.authenticate_as(:'a_waiter');
select throws_ok(
  format($f$ select public.staff_close_session_unbilled(%L, 'Guests left') $f$, :'t11_session'),
  'P0001', 'REQUIRES_MANAGER', 'a waiter cannot close a table with an accepted dish still placed'
);
select tests.clear_auth();
update public.order_items set status = 'preparing' where id = :'i_only';
select tests.authenticate_as(:'a_waiter');
select throws_ok(
  format($f$ select public.staff_close_session_unbilled(%L, 'Guests left') $f$, :'t11_session'),
  'P0001', 'REQUIRES_MANAGER', 'or being prepared'
);
select tests.clear_auth();
update public.order_items set status = 'ready' where id = :'i_only';
select tests.authenticate_as(:'a_waiter');
select throws_ok(
  format($f$ select public.staff_close_session_unbilled(%L, 'Guests left') $f$, :'t11_session'),
  'P0001', 'REQUIRES_MANAGER', 'or ready to serve'
);
select tests.clear_auth();
update public.order_items set status = 'served', served_at = now(), served_by = :'a_waiter' where id = :'i_only';
select tests.authenticate_as(:'a_waiter');
select throws_ok(
  format($f$ select public.staff_close_session_unbilled(%L, 'Guests left') $f$, :'t11_session'),
  'P0001', 'REQUIRES_MANAGER', 'or already served'
);
select tests.clear_auth();
select results_eq(
  format(
    $f$ select status::text, closed_at from public.table_sessions where id = %L $f$,
    :'t11_session'
  ),
  $$ values ('open', null::timestamptz) $$,
  'the table stays open'
);
select is(pg_temp.audits('session.closed_unbilled', :'t11_session'), 0::bigint, 'and nothing is logged');

select tests.authenticate_as(:'a_manager');
select is(
  public.staff_remove_item(:'i_only', 1, 'Complaint') ->> 'status',
  'removed',
  'a manager removes the served dish'
);
select tests.authenticate_as(:'a_waiter');
select is(
  public.staff_close_session_unbilled(:'t11_session', 'Complaint, no charge') ->> 'status',
  'closed_unbilled',
  'with nothing billable left in the accepted round, a waiter can close the table'
);

-- ─── Close without a bill: a manager closes a busy table (tables 9, 10) ─────
select tests.authenticate_as(:'a_manager');
select is(
  pg_temp.error_of(format($f$ select public.admin_assign_waiter(%L, %L) $f$, :'t10_session', :'w_ravi')),
  'WAITER_BUSY 9',
  'while table 9 is open, Ravi (limit 1) is busy'
);

select tests.authenticate_as(:'a_waiter');
select throws_ok(
  format($f$ select public.staff_close_session_unbilled(%L, 'Guests left') $f$, :'t9_session'),
  'P0001', 'REQUIRES_MANAGER', 'a waiter cannot close a table with accepted dishes'
);
select tests.authenticate_as(:'a_manager');
select is(
  public.staff_close_session_unbilled(:'t9_session', '  Guests   walked out '),
  jsonb_build_object('session_id', :'t9_session', 'status', 'closed_unbilled', 'cancelled_items', 3),
  'a manager closes a table with dishes in every state'
);
select tests.clear_auth();
select results_eq(
  format(
    $f$ select status::text, closed_at = now(), closed_by, close_reason, assigned_waiter_id
        from public.table_sessions where id = %L $f$,
    :'t9_session'
  ),
  format(
    $f$ values ('closed_unbilled', true, %L::uuid, 'Guests walked out', %L::uuid) $f$,
    :'a_manager', :'w_ravi'
  ),
  'the session is closed with the tidied reason and keeps Ravi as its waiter for history'
);
select results_eq(
  format(
    $f$ select note, status::text, cancelled_at = now(), status_changed_by
        from public.order_items where order_id = %L order by note $f$,
    :'t9_r1'
  ),
  format(
    $f$ values
      ('c cancelled', 'cancelled', false, null::uuid),
      ('c placed', 'cancelled', true, %1$L::uuid),
      ('c preparing', 'cancelled', true, %1$L::uuid),
      ('c ready', 'cancelled', true, %1$L::uuid),
      ('c removed', 'removed', null::boolean, null::uuid),
      ('c served', 'served', null::boolean, null::uuid) $f$,
    :'a_manager'
  ),
  'dishes still on their way are cancelled; served, cancelled and removed dishes stay as they were'
);
select is(
  (select count(*) from public.order_items where session_id = :'t14_session' and status in ('placed', 'served')),
  3::bigint,
  'dishes at other tables are untouched'
);
select results_eq(
  format(
    $f$ select waiter_id, unassigned_at = now(), unassign_reason::text
        from public.session_waiter_assignments where session_id = %L order by assigned_at $f$,
    :'t9_session'
  ),
  format(
    $f$ values (%L::uuid, false, 'reassigned'), (%L::uuid, true, 'closed_unbilled') $f$,
    :'w_anita', :'w_ravi'
  ),
  'Ravi''s assignment ends with reason closed_unbilled; the earlier one is untouched'
);
select results_eq(
  format(
    $f$ select actor_user_id, actor_role::text, entity_type, before, after, reason
        from public.audit_logs where action = 'session.closed_unbilled' and entity_id = %L $f$,
    :'t9_session'
  ),
  format(
    $f$ values (%L::uuid, 'manager', 'table_session',
                jsonb_build_object('status', 'open', 'table', '9', 'assigned_waiter_id', %L::uuid),
                '{"status": "closed_unbilled", "cancelled_items": 3}'::jsonb,
                'Guests walked out') $f$,
    :'a_manager', :'w_ravi'
  ),
  'closing is audit logged with the table, its waiter and the reason'
);

select tests.authenticate_as(:'a_manager');
select throws_ok(
  format($f$ select public.staff_close_session_unbilled(%L, 'Again') $f$, :'t9_session'),
  'P0001', 'SESSION_NOT_OPEN', 'a closed table cannot be closed again'
);
select throws_ok(
  format($f$ select public.staff_remove_item(%L, 1, 'Late complaint') $f$, :'i_c_served'),
  'P0001', 'SESSION_NOT_OPEN', 'a closed table''s dishes cannot be removed'
);
select throws_ok(
  format($f$ select public.admin_remove_order(%L, 'Wrong table') $f$, :'t9_r1'),
  'P0001', 'SESSION_NOT_OPEN', 'nor its rounds deleted'
);
select throws_ok(
  format($f$ select public.staff_close_session_unbilled(%L, 'Guests left') $f$, gen_random_uuid()),
  'P0001', 'NOT_FOUND', 'an unknown session is not found'
);
select tests.clear_auth();
select is(pg_temp.audits('session.closed_unbilled', :'t9_session'), 1::bigint, 'the refused repeat is not logged');

select tests.authenticate_as(:'a_manager');
select is(
  public.admin_assign_waiter(:'t10_session', :'w_ravi') ->> 'changed',
  'true',
  'Ravi is free again: assigning him to table 10 needs no confirmation'
);

select tests.clear_auth();
select pg_temp.customer_order(
  'P4180A0000TABLE9', 'p4180-t9-after-close', tests.line(:'simple')
) as t9_next \gset
select results_eq(
  format(
    $f$ select s.id <> %L::uuid, s.status::text, o.round_number, s.assigned_waiter_id
        from public.orders o join public.table_sessions s on s.id = o.session_id where o.id = %L $f$,
    :'t9_session', :'t9_next'
  ),
  $$ values (true, 'open', 1, null::uuid) $$,
  'the next customer at table 9 starts a new, unassigned session at round 1'
);
select is(
  (select status::text from public.table_sessions where id = :'t9_session'),
  'closed_unbilled',
  'the closed session stays closed'
);

-- ─── After billing (table 12) ───────────────────────────────────────────────
select tests.authenticate_as(:'a_manager');
select throws_ok(
  format($f$ select public.staff_remove_item(%L, 1, 'Complaint') $f$, :'i_billed'),
  'P0001', 'SESSION_NOT_OPEN', 'a billed dish cannot be removed'
);
select throws_ok(
  format($f$ select public.admin_remove_order(%L, 'Wrong table') $f$, :'t12_r1'),
  'P0001', 'SESSION_NOT_OPEN', 'a billed round cannot be deleted'
);
select throws_ok(
  format($f$ select public.staff_close_session_unbilled(%L, 'Guests left') $f$, :'t12_session'),
  'P0001', 'SESSION_NOT_OPEN', 'a billed table cannot be closed without a bill'
);
select tests.clear_auth();
select results_eq(
  format(
    $f$ select s.status::text, o.status::text, oi.status::text, oi.quantity
        from public.order_items oi
        join public.orders o on o.id = oi.order_id
        join public.table_sessions s on s.id = oi.session_id
        where oi.id = %L $f$,
    :'i_billed'
  ),
  $$ values ('billed', 'accepted', 'served', 2) $$,
  'nothing changes after billing'
);

-- ─── Another restaurant's rounds ────────────────────────────────────────────
select tests.authenticate_as(:'a_owner');
select throws_ok(
  format($f$ select public.staff_remove_item(%L, 1, 'Not ours') $f$, :'i_other'),
  'P0001', 'NOT_FOUND', 'another restaurant''s dish cannot be removed'
);
select throws_ok(
  format($f$ select public.admin_remove_order(%L, 'Not ours') $f$, :'b_r1'),
  'P0001', 'NOT_FOUND', 'another restaurant''s round cannot be deleted'
);
select throws_ok(
  format($f$ select public.staff_close_session_unbilled(%L, 'Not ours') $f$, :'b_session'),
  'P0001', 'NOT_FOUND', 'another restaurant''s table cannot be closed'
);
select tests.clear_auth();
select results_eq(
  format(
    $f$ select s.status::text, o.status::text, oi.status::text
        from public.order_items oi
        join public.orders o on o.id = oi.order_id
        join public.table_sessions s on s.id = oi.session_id
        where oi.id = %L $f$,
    :'i_other'
  ),
  $$ values ('open', 'pending_approval', 'placed') $$,
  'and it stays as it was'
);

-- ─── Read-only restaurants keep service going (spec §10.6, table 14) ────────
select tests.suspend(:'rest_a');
select is(
  (select state from public.restaurant_access(:'rest_a')), 'read_only',
  'restaurant A is now read-only'
);

select tests.authenticate_as(:'a_kitchen');
select is(
  public.staff_remove_item(:'i_ro_partial', 1, 'Out of paneer'),
  jsonb_build_object('order_item_id', :'i_ro_partial', 'status', 'placed', 'quantity', 1),
  'the kitchen can still reduce a dish while read-only'
);
select tests.authenticate_as(:'a_manager');
select is(
  public.staff_remove_item(:'i_ro_served', 1, 'Complaint') ->> 'status',
  'removed',
  'a manager can still remove a served dish'
);
select is(
  public.admin_remove_order(:'t14_r2', 'Wrong table') ->> 'status',
  'removed',
  'and delete a round'
);
select tests.authenticate_as(:'a_waiter');
select throws_ok(
  format($f$ select public.staff_close_session_unbilled(%L, 'Closing early') $f$, :'t14_session'),
  'P0001', 'REQUIRES_MANAGER', 'while read-only a waiter still needs a manager to close a table with dishes'
);
select tests.authenticate_as(:'a_owner');
select is(
  public.staff_close_session_unbilled(:'t14_session', 'Closing early'),
  jsonb_build_object('session_id', :'t14_session', 'status', 'closed_unbilled', 'cancelled_items', 1),
  'an owner closes the table while read-only'
);

select tests.clear_auth();
select results_eq(
  format(
    $f$ select oi.note, oi.quantity, oi.status::text, o.status::text
        from public.order_items oi join public.orders o on o.id = oi.order_id
        where oi.session_id = %L order by oi.note $f$,
    :'t14_session'
  ),
  $$ values ('ro partial', 1, 'cancelled', 'accepted'),
            ('ro round', 1, 'removed', 'removed'),
            ('ro served', 1, 'removed', 'accepted') $$,
  'the changes made while read-only are saved'
);
select results_eq(
  format(
    $f$ select status::text, closed_by, close_reason from public.table_sessions where id = %L $f$,
    :'t14_session'
  ),
  format($f$ values ('closed_unbilled', %L::uuid, 'Closing early') $f$, :'a_owner'),
  'and the table is closed'
);

select * from finish();

rollback;
