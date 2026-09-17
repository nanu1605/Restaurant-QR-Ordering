-- Worker panel approval and dish status (spec §9.3 staff_approve_order,
-- staff_reject_order, staff_update_item_status, staff_mark_order_served,
-- staff_revert_item_status; §10.2 first-order approval; §10.3 dish status;
-- §10.6 read-only keeps service going; §8.8 audit).
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ─── Fixtures ───────────────────────────────────────────────────────────────
-- Restaurant A: one login per role and tables 5–10, one story per table.
-- Restaurant B: a waiting order whose ids must stay out of A's reach.
select tests.create_restaurant('p4-160-a') as rest_a \gset
select tests.create_restaurant('p4-160-b') as rest_b \gset
select tests.add_member(:'rest_a', 'owner', 'a_owner') as a_owner \gset
select tests.add_member(:'rest_a', 'manager', 'a_manager') as a_manager \gset
select tests.add_member(:'rest_a', 'waiter', 'a_waiter') as a_waiter \gset
select tests.add_member(:'rest_a', 'kitchen', 'a_kitchen') as a_kitchen \gset
select tests.create_user('outsider@p4-160-a.test') as outsider \gset

select tests.create_ordering_fixture(:'rest_a', 'P4160A0000TABLE5') as fx \gset
select tests.create_ordering_fixture(:'rest_b', 'P4160B0000TABLE5') as fx_b \gset
select
  :'fx'::jsonb ->> 'simple' as simple,
  :'fx'::jsonb ->> 'variant_item' as variant_item,
  :'fx'::jsonb ->> 'half' as half,
  :'fx_b'::jsonb ->> 'simple' as b_simple
\gset

insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
values
  (:'rest_a', '6', 'P4160A0000TABLE6', 2),
  (:'rest_a', '7', 'P4160A0000TABLE7', 3),
  (:'rest_a', '8', 'P4160A0000TABLE8', 4),
  (:'rest_a', '9', 'P4160A0000TABLE9', 5),
  (:'rest_a', '10', 'P4160A000TABLE10', 6);

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

-- Table 5: two rounds waiting for approval.
select pg_temp.customer_order('P4160A0000TABLE5', 'p4160-t5-round-1', tests.line(:'simple')) as t5_r1 \gset
select pg_temp.customer_order('P4160A0000TABLE5', 'p4160-t5-round-2', tests.line(:'simple')) as t5_r2 \gset
select session_id as t5_session from public.orders where id = :'t5_r1' \gset

-- Table 6: a waiting round with two live dishes, one the customer already
-- cancelled and one staff already removed.
select pg_temp.customer_order(
  'P4160A0000TABLE6', 'p4160-t6-round-1',
  tests.line(:'simple', 2, null, 'tikka'),
  tests.line(:'variant_item', 1, :'half', 'half'),
  tests.line(:'simple', 1, null, 'gone'),
  tests.line(:'simple', 1, null, 'struck')
) as t6_r1 \gset
select session_id as t6_session from public.orders where id = :'t6_r1' \gset
update public.order_items set status = 'cancelled', cancelled_at = now() - interval '10 minutes'
  where order_id = :'t6_r1' and note = 'gone';
update public.order_items
  set status = 'removed', removed_at = now() - interval '5 minutes', removed_by = :'a_manager',
      removed_reason = 'Out of paneer'
  where order_id = :'t6_r1' and note = 'struck';

-- Table 7: an approved session, so its rounds are accepted. One round each
-- for moving dishes, mark all served, reverting, a removed round, and two
-- for the read-only checks.
select id as table7 from public.dining_tables where qr_token = 'P4160A0000TABLE7' \gset
insert into public.table_sessions (restaurant_id, dining_table_id, table_label_snapshot, is_approved, approved_at)
values (:'rest_a', :'table7', '7', true, now())
returning id as t7_session \gset

select pg_temp.customer_order(
  'P4160A0000TABLE7', 'p4160-t7-status',
  tests.line(:'simple', 1, null, 'forward'),
  tests.line(:'simple', 1, null, 'skip'),
  tests.line(:'simple', 1, null, 'any role'),
  tests.line(:'simple', 1, null, 'cancelled'),
  tests.line(:'simple', 1, null, 'removed')
) as t7_status \gset
select pg_temp.customer_order(
  'P4160A0000TABLE7', 'p4160-t7-serve-all',
  tests.line(:'simple', 1, null, 'm placed'),
  tests.line(:'simple', 1, null, 'm preparing'),
  tests.line(:'simple', 1, null, 'm ready'),
  tests.line(:'simple', 1, null, 'm served'),
  tests.line(:'simple', 1, null, 'm cancelled'),
  tests.line(:'simple', 1, null, 'm removed')
) as t7_serve \gset
select pg_temp.customer_order(
  'P4160A0000TABLE7', 'p4160-t7-revert',
  tests.line(:'simple', 1, null, 'r chain'),
  tests.line(:'simple', 1, null, 'r placed'),
  tests.line(:'simple', 1, null, 'r cancelled'),
  tests.line(:'simple', 1, null, 'r removed')
) as t7_revert \gset
select pg_temp.customer_order(
  'P4160A0000TABLE7', 'p4160-t7-removed', tests.line(:'simple', 1, null, 'x removed')
) as t7_removed \gset
select pg_temp.customer_order(
  'P4160A0000TABLE7', 'p4160-t7-ro-dishes',
  tests.line(:'simple', 1, null, 'ro move'),
  tests.line(:'simple', 1, null, 'ro revert')
) as t7_ro \gset
select pg_temp.customer_order(
  'P4160A0000TABLE7', 'p4160-t7-ro-serve', tests.line(:'simple', 1, null, 'ro serve')
) as t7_ro_serve \gset

update public.order_items set status = 'cancelled', cancelled_at = now() - interval '10 minutes'
  where session_id = :'t7_session' and note in ('cancelled', 'm cancelled', 'r cancelled');
update public.order_items
  set status = 'removed', removed_at = now() - interval '5 minutes', removed_by = :'a_manager',
      removed_reason = 'Spilled'
  where session_id = :'t7_session' and note in ('removed', 'm removed', 'r removed', 'x removed');
update public.order_items set status = 'preparing' where session_id = :'t7_session' and note = 'm preparing';
update public.order_items set status = 'ready' where session_id = :'t7_session' and note = 'm ready';
update public.order_items
  set status = 'served', served_at = now() - interval '30 minutes', served_by = :'a_manager'
  where session_id = :'t7_session' and note in ('m served', 'r chain', 'ro revert');
update public.orders
  set status = 'removed', removed_at = now(), removed_by = :'a_manager', removed_reason = 'Wrong table'
  where id = :'t7_removed';

-- Table 8: a billed session holding an accepted round and a waiting one.
select pg_temp.customer_order(
  'P4160A0000TABLE8', 'p4160-t8-round-1',
  tests.line(:'simple', 1, null, 'b placed'),
  tests.line(:'simple', 1, null, 'b preparing')
) as t8_r1 \gset
select pg_temp.customer_order(
  'P4160A0000TABLE8', 'p4160-t8-round-2', tests.line(:'simple', 1, null, 'b waiting')
) as t8_r2 \gset
select session_id as t8_session from public.orders where id = :'t8_r1' \gset
update public.orders set status = 'accepted', decided_at = now() where id = :'t8_r1';
update public.order_items set status = 'preparing' where order_id = :'t8_r1' and note = 'b preparing';
select tests.bill_session(:'t8_session');

-- Table 9: two waiting rounds, decided at the end while read-only.
select pg_temp.customer_order(
  'P4160A0000TABLE9', 'p4160-t9-round-1', tests.line(:'simple', 1, null, 'w dish')
) as t9_r1 \gset
select pg_temp.customer_order('P4160A0000TABLE9', 'p4160-t9-round-2', tests.line(:'simple')) as t9_r2 \gset

-- Table 10: a waiting round in a session closed without a bill.
select pg_temp.customer_order('P4160A000TABLE10', 'p4160-t10-round-1', tests.line(:'simple')) as t10_r1 \gset
update public.table_sessions set status = 'closed_unbilled', closed_at = now(), close_reason = 'Guests left'
  where id = (select session_id from public.orders where id = :'t10_r1');

-- Restaurant B: one waiting order.
select pg_temp.customer_order(
  'P4160B0000TABLE5', 'p4160-b-round-1', tests.line(:'b_simple', 1, null, 'other')
) as b_r1 \gset

-- Every dish of A last changed an hour ago, so "changed now, by whom" shows.
update public.order_items set status_changed_at = now() - interval '1 hour' where restaurant_id = :'rest_a';

select
  pg_temp.dish(:'t6_r1', 'tikka') as i_tikka,
  pg_temp.dish(:'t7_status', 'forward') as i_forward,
  pg_temp.dish(:'t7_status', 'skip') as i_skip,
  pg_temp.dish(:'t7_status', 'any role') as i_any,
  pg_temp.dish(:'t7_status', 'cancelled') as i_cancelled,
  pg_temp.dish(:'t7_status', 'removed') as i_removed,
  pg_temp.dish(:'t7_revert', 'r chain') as i_chain,
  pg_temp.dish(:'t7_revert', 'r placed') as i_r_placed,
  pg_temp.dish(:'t7_revert', 'r cancelled') as i_r_cancelled,
  pg_temp.dish(:'t7_revert', 'r removed') as i_r_removed,
  pg_temp.dish(:'t7_removed', 'x removed') as i_x_removed,
  pg_temp.dish(:'t7_ro', 'ro move') as i_ro_move,
  pg_temp.dish(:'t7_ro', 'ro revert') as i_ro_revert,
  pg_temp.dish(:'t8_r1', 'b placed') as i_b_placed,
  pg_temp.dish(:'t8_r1', 'b preparing') as i_b_preparing,
  pg_temp.dish(:'t9_r1', 'w dish') as i_waiting,
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
      'public.staff_approve_order(uuid)',
      'public.staff_reject_order(uuid, text)',
      'public.staff_update_item_status(uuid, public.order_item_status)',
      'public.staff_mark_order_served(uuid)',
      'public.staff_revert_item_status(uuid, public.order_item_status)'
    ]) as f
  ),
  'signed-in staff can call these functions, anonymous visitors cannot'
);

select tests.authenticate_as(:'a_kitchen');
select throws_ok(
  format($f$ select public.staff_approve_order(%L) $f$, :'t5_r1'),
  'P0001', 'FORBIDDEN', 'the kitchen cannot approve orders'
);
select throws_ok(
  format($f$ select public.staff_reject_order(%L, 'Prank') $f$, :'t5_r1'),
  'P0001', 'FORBIDDEN', 'the kitchen cannot reject orders'
);
select throws_ok(
  format($f$ select public.staff_revert_item_status(%L, 'served') $f$, :'i_chain'),
  'P0001', 'FORBIDDEN', 'the kitchen cannot revert a dish'
);

select tests.authenticate_as(:'a_waiter');
select throws_ok(
  format($f$ select public.staff_revert_item_status(%L, 'served') $f$, :'i_chain'),
  'P0001', 'FORBIDDEN', 'a waiter cannot revert a dish'
);

select tests.authenticate_as(:'outsider');
select throws_ok(
  format($f$ select public.staff_update_item_status(%L, 'preparing') $f$, :'i_forward'),
  'P0001', 'FORBIDDEN', 'a login without a membership cannot move dishes'
);
select throws_ok(
  format($f$ select public.staff_mark_order_served(%L) $f$, :'t7_serve'),
  'P0001', 'FORBIDDEN', 'a login without a membership cannot mark rounds served'
);

-- ─── Approve (table 5) ──────────────────────────────────────────────────────
select tests.authenticate_as(:'a_waiter');
select is(
  public.staff_approve_order(:'t5_r1'),
  jsonb_build_object('order_id', :'t5_r1', 'status', 'accepted', 'changed', true),
  'a waiter approves a waiting order'
);

select tests.clear_auth();
select results_eq(
  format(
    $f$ select status::text, decided_by, decided_at = now() from public.orders where id = %L $f$,
    :'t5_r1'
  ),
  format($f$ values ('accepted', %L::uuid, true) $f$, :'a_waiter'),
  'the order is accepted, recording who decided and when'
);
select results_eq(
  format(
    $f$ select is_approved, approved_by, approved_at = now() from public.table_sessions where id = %L $f$,
    :'t5_session'
  ),
  format($f$ values (true, %L::uuid, true) $f$, :'a_waiter'),
  'and the table''s session is approved by that waiter'
);
select results_eq(
  format(
    $f$ select actor_user_id, actor_role::text, entity_type, before, after
        from public.audit_logs where action = 'order.approved' and entity_id = %L $f$,
    :'t5_r1'
  ),
  format(
    $f$ values (%L::uuid, 'waiter', 'order',
                '{"status": "pending_approval"}'::jsonb,
                '{"status": "accepted", "round_number": 1}'::jsonb) $f$,
    :'a_waiter'
  ),
  'the approval is audit logged'
);
select is(
  (select status::text from public.order_items where order_id = :'t5_r1'),
  'placed',
  'its dish is now waiting for the kitchen'
);
select is(
  (select status::text from public.orders where id = :'t5_r2'),
  'pending_approval',
  'a round that was already waiting still needs its own decision'
);

select tests.authenticate_as(:'a_manager');
select is(
  public.staff_approve_order(:'t5_r1'),
  jsonb_build_object('order_id', :'t5_r1', 'status', 'accepted', 'changed', false),
  'approving an accepted order again changes nothing'
);
select is(
  public.staff_approve_order(:'t5_r2') ->> 'changed',
  'true',
  'a manager approves the other waiting round'
);

select tests.clear_auth();
select is(pg_temp.audits('order.approved', :'t5_r1'), 1::bigint, 'the repeat is not logged again');
select is(
  (select decided_by from public.orders where id = :'t5_r1'), :'a_waiter'::uuid,
  'and keeps who approved the order'
);
select is(
  (select approved_by from public.table_sessions where id = :'t5_session'), :'a_waiter'::uuid,
  'the session keeps its first approver'
);

select pg_temp.customer_order('P4160A0000TABLE5', 'p4160-t5-round-3', tests.line(:'simple')) as t5_r3 \gset
select is(
  (select status::text from public.orders where id = :'t5_r3'),
  'accepted',
  'the table''s next order is accepted straight away'
);

select tests.authenticate_as(:'a_waiter');
select throws_ok(
  format($f$ select public.staff_approve_order(%L) $f$, :'t7_removed'),
  'P0001', 'ORDER_NOT_PENDING', 'a removed round cannot be approved'
);
select throws_ok(
  format($f$ select public.staff_approve_order(%L) $f$, :'t10_r1'),
  'P0001', 'SESSION_NOT_OPEN', 'a round at a table closed without a bill cannot be approved'
);
select throws_ok(
  format($f$ select public.staff_approve_order(%L) $f$, gen_random_uuid()),
  'P0001', 'NOT_FOUND', 'an unknown order is not found'
);

-- ─── Reject (table 6) ───────────────────────────────────────────────────────
select throws_ok(
  format($f$ select public.staff_reject_order(%L, null) $f$, :'t6_r1'),
  'P0001', 'REASON_REQUIRED', 'rejecting needs a reason'
);
select throws_ok(
  format($f$ select public.staff_reject_order(%L, '   ') $f$, :'t6_r1'),
  'P0001', 'REASON_REQUIRED', 'a blank reason is no reason'
);
select is(
  pg_temp.error_of(format($f$ select public.staff_reject_order(%L, %L) $f$, :'t6_r1', repeat('x', 201))),
  'INVALID_INPUT reason',
  'a reason is at most 200 characters'
);
select is(
  public.staff_reject_order(:'t6_r1', '  Nobody   at the table '),
  jsonb_build_object('order_id', :'t6_r1', 'status', 'rejected', 'changed', true),
  'a waiter rejects a waiting order with a reason'
);

select tests.clear_auth();
select results_eq(
  format(
    $f$ select status::text, reject_reason, decided_by, decided_at = now()
        from public.orders where id = %L $f$,
    :'t6_r1'
  ),
  format($f$ values ('rejected', 'Nobody at the table', %L::uuid, true) $f$, :'a_waiter'),
  'the order is rejected with the tidied reason, who decided and when'
);
select results_eq(
  format(
    $f$ select note, status::text, cancelled_at = now(), status_changed_by, status_changed_at = now()
        from public.order_items where order_id = %L order by note $f$,
    :'t6_r1'
  ),
  format(
    $f$ values
      ('gone', 'cancelled', false, null::uuid, false),
      ('half', 'cancelled', true, %1$L::uuid, true),
      ('struck', 'removed', null::boolean, null::uuid, false),
      ('tikka', 'cancelled', true, %1$L::uuid, true) $f$,
    :'a_waiter'
  ),
  'its placed dishes are cancelled; dishes already cancelled or removed are left alone'
);
select results_eq(
  format(
    $f$ select is_approved, approved_by, approved_at from public.table_sessions where id = %L $f$,
    :'t6_session'
  ),
  $$ values (false, null::uuid, null::timestamptz) $$,
  'the session stays unapproved'
);
select results_eq(
  format(
    $f$ select actor_user_id, actor_role::text, before, after, reason
        from public.audit_logs where action = 'order.rejected' and entity_id = %L $f$,
    :'t6_r1'
  ),
  format(
    $f$ values (%L::uuid, 'waiter', '{"status": "pending_approval"}'::jsonb,
                '{"status": "rejected", "round_number": 1, "cancelled_items": 2}'::jsonb,
                'Nobody at the table') $f$,
    :'a_waiter'
  ),
  'the rejection is audit logged with the reason'
);

select tests.authenticate_as(:'a_manager');
select is(
  public.staff_reject_order(:'t6_r1', 'Changed my mind'),
  jsonb_build_object('order_id', :'t6_r1', 'status', 'rejected', 'changed', false),
  'rejecting a rejected order again changes nothing'
);
select throws_ok(
  format($f$ select public.staff_approve_order(%L) $f$, :'t6_r1'),
  'P0001', 'ORDER_NOT_PENDING', 'a rejected order cannot be approved'
);
select throws_ok(
  format($f$ select public.staff_reject_order(%L, 'Too late') $f$, :'t5_r1'),
  'P0001', 'ORDER_NOT_PENDING', 'an accepted order cannot be rejected'
);
select throws_ok(
  format($f$ select public.staff_reject_order(%L, 'Too late') $f$, :'t7_removed'),
  'P0001', 'ORDER_NOT_PENDING', 'a removed round cannot be rejected'
);

select tests.clear_auth();
select results_eq(
  format($f$ select reject_reason, decided_by from public.orders where id = %L $f$, :'t6_r1'),
  format($f$ values ('Nobody at the table', %L::uuid) $f$, :'a_waiter'),
  'the repeat keeps the first reason and decider'
);
select is(pg_temp.audits('order.rejected', :'t6_r1'), 1::bigint, 'and is not logged again');

-- The table's next order waits again; managers and owners decide too.
select pg_temp.customer_order('P4160A0000TABLE6', 'p4160-t6-round-2', tests.line(:'simple')) as t6_r2 \gset
select pg_temp.customer_order('P4160A0000TABLE6', 'p4160-t6-round-3', tests.line(:'simple')) as t6_r3 \gset
select pg_temp.customer_order('P4160A0000TABLE6', 'p4160-t6-round-4', tests.line(:'simple')) as t6_r4 \gset
select is(
  (select status::text from public.orders where id = :'t6_r2'),
  'pending_approval',
  'after a rejection the table''s next order waits for approval again'
);

select tests.authenticate_as(:'a_manager');
select is(
  public.staff_reject_order(:'t6_r2', 'Prank order') ->> 'changed', 'true',
  'a manager can reject'
);
select tests.authenticate_as(:'a_owner');
select is(
  public.staff_reject_order(:'t6_r3', '   ' || repeat('y', 200) || '   ') ->> 'changed', 'true',
  'an owner can reject, with a reason of exactly 200 characters once tidied'
);
select is(public.staff_approve_order(:'t6_r4') ->> 'changed', 'true', 'an owner can approve');

select tests.clear_auth();
select is(
  (select length(reject_reason) from public.orders where id = :'t6_r3'), 200,
  'the 200-character reason is kept in full'
);
select results_eq(
  format($f$ select is_approved, approved_by from public.table_sessions where id = %L $f$, :'t6_session'),
  format($f$ values (true, %L::uuid) $f$, :'a_owner'),
  'approving after a rejection approves the session'
);

-- ─── Dish status (table 7) ──────────────────────────────────────────────────
select tests.authenticate_as(:'a_kitchen');
select is(
  public.staff_update_item_status(:'i_forward', 'preparing'),
  jsonb_build_object('order_item_id', :'i_forward', 'status', 'preparing', 'changed', true),
  'the kitchen starts a dish'
);
select tests.clear_auth();
select results_eq(
  format(
    $f$ select status::text, status_changed_by, status_changed_at = now(), served_at, served_by
        from public.order_items where id = %L $f$,
    :'i_forward'
  ),
  format($f$ values ('preparing', %L::uuid, true, null::timestamptz, null::uuid) $f$, :'a_kitchen'),
  'the move records who made it and when'
);

select tests.authenticate_as(:'a_waiter');
select is(
  public.staff_update_item_status(:'i_forward', 'preparing'),
  jsonb_build_object('order_item_id', :'i_forward', 'status', 'preparing', 'changed', false),
  'asking for the status a dish already has changes nothing'
);
select tests.clear_auth();
select is(
  (select status_changed_by from public.order_items where id = :'i_forward'), :'a_kitchen'::uuid,
  'and the second tap is not recorded'
);

select tests.authenticate_as(:'a_waiter');
select is(
  public.staff_update_item_status(:'i_forward', 'ready') ->> 'status', 'ready',
  'a waiter moves it on to ready'
);
select is(
  pg_temp.error_of(format($f$ select public.staff_update_item_status(%L, 'preparing') $f$, :'i_forward')),
  'INVALID_STATUS_CHANGE ready',
  'a dish cannot move backwards (the detail is its current status)'
);
select is(
  public.staff_update_item_status(:'i_forward', 'served'),
  jsonb_build_object('order_item_id', :'i_forward', 'status', 'served', 'changed', true),
  'a waiter serves it'
);
select tests.clear_auth();
select results_eq(
  format(
    $f$ select status::text, served_by, served_at = now(), status_changed_by
        from public.order_items where id = %L $f$,
    :'i_forward'
  ),
  format($f$ values ('served', %1$L::uuid, true, %1$L::uuid) $f$, :'a_waiter'),
  'serving records who served it and when'
);

select tests.authenticate_as(:'a_waiter');
select is(
  public.staff_update_item_status(:'i_forward', 'served') ->> 'changed', 'false',
  'serving a served dish again changes nothing'
);
select is(
  pg_temp.error_of(format($f$ select public.staff_update_item_status(%L, 'ready') $f$, :'i_forward')),
  'INVALID_STATUS_CHANGE served',
  'a served dish cannot go back to ready'
);

select tests.authenticate_as(:'a_kitchen');
select is(
  public.staff_update_item_status(:'i_skip', 'served') ->> 'changed', 'true',
  'the kitchen can skip straight from placed to served (drinks)'
);
select tests.clear_auth();
select results_eq(
  format($f$ select status::text, served_by, served_at = now() from public.order_items where id = %L $f$, :'i_skip'),
  format($f$ values ('served', %L::uuid, true) $f$, :'a_kitchen'),
  'and is recorded as having served it'
);

select tests.authenticate_as(:'a_manager');
select is(
  public.staff_update_item_status(:'i_any', 'ready') ->> 'status', 'ready',
  'a manager can move dishes, skipping preparing'
);
select tests.authenticate_as(:'a_owner');
select is(
  public.staff_update_item_status(:'i_any', 'served') ->> 'status', 'served',
  'an owner can move dishes'
);

select tests.authenticate_as(:'a_kitchen');
select is(
  pg_temp.error_of(format($f$ select public.staff_update_item_status(%L, 'placed') $f$, :'i_r_placed')),
  'INVALID_INPUT status',
  'placed is not a status to move to, even for a placed dish'
);
select is(
  pg_temp.error_of(format($f$ select public.staff_update_item_status(%L, 'cancelled') $f$, :'i_r_placed')),
  'INVALID_INPUT status',
  'dishes are not cancelled through a status change'
);
select is(
  pg_temp.error_of(format($f$ select public.staff_update_item_status(%L, 'removed') $f$, :'i_r_placed')),
  'INVALID_INPUT status',
  'dishes are not removed through a status change'
);
select is(
  pg_temp.error_of(format($f$ select public.staff_update_item_status(%L, null) $f$, :'i_r_placed')),
  'INVALID_INPUT status',
  'a status is required'
);

select throws_ok(
  format($f$ select public.staff_update_item_status(%L, 'preparing') $f$, :'i_cancelled'),
  'P0001', 'ITEM_NOT_ACTIVE', 'a cancelled dish cannot move'
);
select throws_ok(
  format($f$ select public.staff_update_item_status(%L, 'served') $f$, :'i_removed'),
  'P0001', 'ITEM_NOT_ACTIVE', 'a removed dish cannot move'
);
select throws_ok(
  format($f$ select public.staff_update_item_status(%L, 'preparing') $f$, :'i_waiting'),
  'P0001', 'ORDER_NOT_ACCEPTED', 'a dish of an order waiting for approval cannot move'
);
select throws_ok(
  format($f$ select public.staff_update_item_status(%L, 'preparing') $f$, :'i_tikka'),
  'P0001', 'ORDER_NOT_ACCEPTED', 'a dish of a rejected order cannot move'
);
select throws_ok(
  format($f$ select public.staff_update_item_status(%L, 'preparing') $f$, :'i_x_removed'),
  'P0001', 'ORDER_NOT_ACCEPTED', 'a dish of a removed round cannot move'
);
select throws_ok(
  format($f$ select public.staff_update_item_status(%L, 'preparing') $f$, gen_random_uuid()),
  'P0001', 'NOT_FOUND', 'an unknown dish is not found'
);

select tests.clear_auth();
select results_eq(
  format(
    $f$ select note, status::text from public.order_items
        where order_id = %L and note in ('cancelled', 'removed') order by note $f$,
    :'t7_status'
  ),
  $$ values ('cancelled', 'cancelled'), ('removed', 'removed') $$,
  'refused moves leave the dishes as they were'
);
select is(
  (select status::text from public.order_items where id = :'i_waiting'),
  'placed',
  'including the waiting order''s dish'
);
select is(
  (select count(*) from public.audit_logs where entity_id in (:'i_forward', :'i_skip', :'i_any')),
  0::bigint,
  'moving dishes forward is not audit logged'
);

-- ─── Mark a round served (table 7) ──────────────────────────────────────────
select tests.authenticate_as(:'a_waiter');
select is(
  public.staff_mark_order_served(:'t7_serve'),
  jsonb_build_object('order_id', :'t7_serve', 'served', 3),
  'mark all served serves the placed, preparing and ready dishes'
);
select tests.clear_auth();
select results_eq(
  format(
    $f$ select note, status::text, served_by, served_at = now(), status_changed_by, status_changed_at = now()
        from public.order_items where order_id = %L order by note $f$,
    :'t7_serve'
  ),
  format(
    $f$ values
      ('m cancelled', 'cancelled', null::uuid, null::boolean, null::uuid, false),
      ('m placed', 'served', %1$L::uuid, true, %1$L::uuid, true),
      ('m preparing', 'served', %1$L::uuid, true, %1$L::uuid, true),
      ('m ready', 'served', %1$L::uuid, true, %1$L::uuid, true),
      ('m removed', 'removed', null::uuid, null::boolean, null::uuid, false),
      ('m served', 'served', %2$L::uuid, false, null::uuid, false) $f$,
    :'a_waiter', :'a_manager'
  ),
  'each is recorded as served by the caller; served, cancelled and removed dishes are left alone'
);

select tests.authenticate_as(:'a_kitchen');
select is(
  public.staff_mark_order_served(:'t7_serve'),
  jsonb_build_object('order_id', :'t7_serve', 'served', 0),
  'the kitchen can mark a round served too; a second time serves nothing'
);
select throws_ok(
  format($f$ select public.staff_mark_order_served(%L) $f$, :'t9_r1'),
  'P0001', 'ORDER_NOT_ACCEPTED', 'a round waiting for approval cannot be marked served'
);
select throws_ok(
  format($f$ select public.staff_mark_order_served(%L) $f$, :'t6_r1'),
  'P0001', 'ORDER_NOT_ACCEPTED', 'a rejected round cannot be marked served'
);
select throws_ok(
  format($f$ select public.staff_mark_order_served(%L) $f$, :'t7_removed'),
  'P0001', 'ORDER_NOT_ACCEPTED', 'a removed round cannot be marked served'
);
select throws_ok(
  format($f$ select public.staff_mark_order_served(%L) $f$, gen_random_uuid()),
  'P0001', 'NOT_FOUND', 'an unknown round is not found'
);

select tests.clear_auth();
select is(
  (select status::text from public.order_items where id = :'i_waiting'),
  'placed',
  'the waiting round''s dish is not served'
);

-- ─── Revert a step (table 7) ────────────────────────────────────────────────
select tests.authenticate_as(:'a_manager');
select is(
  public.staff_revert_item_status(:'i_chain', 'served'),
  jsonb_build_object('order_item_id', :'i_chain', 'status', 'ready', 'changed', true),
  'a manager takes a served dish back to ready'
);
select tests.clear_auth();
select results_eq(
  format(
    $f$ select status::text, served_at, served_by, status_changed_by, status_changed_at = now()
        from public.order_items where id = %L $f$,
    :'i_chain'
  ),
  format($f$ values ('ready', null::timestamptz, null::uuid, %L::uuid, true) $f$, :'a_manager'),
  'leaving served clears who served it and records the change'
);

select tests.authenticate_as(:'a_owner');
select is(
  public.staff_revert_item_status(:'i_chain', 'ready') ->> 'status', 'preparing',
  'an owner takes it back from ready to preparing'
);
select tests.authenticate_as(:'a_manager');
select is(
  public.staff_revert_item_status(:'i_chain', 'preparing') ->> 'status', 'placed',
  'and from preparing to placed'
);
select is(
  public.staff_revert_item_status(:'i_chain', 'preparing'),
  jsonb_build_object('order_item_id', :'i_chain', 'status', 'placed', 'changed', false),
  'a second tap on the same revert changes nothing (the dish already moved back)'
);
select is(
  pg_temp.error_of(format($f$ select public.staff_revert_item_status(%L, 'placed') $f$, :'i_chain')),
  'INVALID_STATUS_CHANGE placed',
  'a placed dish cannot go further back (the detail is its status)'
);
select throws_ok(
  format($f$ select public.staff_revert_item_status(%L, 'served') $f$, :'i_r_cancelled'),
  'P0001', 'ITEM_NOT_ACTIVE', 'a cancelled dish cannot be reverted'
);
select throws_ok(
  format($f$ select public.staff_revert_item_status(%L, 'served') $f$, :'i_r_removed'),
  'P0001', 'ITEM_NOT_ACTIVE', 'a removed dish cannot be reverted'
);
select throws_ok(
  format($f$ select public.staff_revert_item_status(%L, 'placed') $f$, :'i_waiting'),
  'P0001', 'ORDER_NOT_ACCEPTED', 'a dish of an order waiting for approval cannot be reverted'
);
select throws_ok(
  format($f$ select public.staff_revert_item_status(%L, 'served') $f$, gen_random_uuid()),
  'P0001', 'NOT_FOUND', 'an unknown dish is not found'
);

select tests.clear_auth();
select set_eq(
  format(
    $f$ select actor_user_id, actor_role::text, before, after, reason
        from public.audit_logs where action = 'order_item.status_reverted' and entity_id = %L $f$,
    :'i_chain'
  ),
  format(
    $f$ values
      (%1$L::uuid, 'manager', '{"status": "served"}'::jsonb, '{"status": "ready"}'::jsonb, null::text),
      (%2$L::uuid, 'owner', '{"status": "ready"}'::jsonb, '{"status": "preparing"}'::jsonb, null::text),
      (%1$L::uuid, 'manager', '{"status": "preparing"}'::jsonb, '{"status": "placed"}'::jsonb, null::text) $f$,
    :'a_manager', :'a_owner'
  ),
  'every step back is audit logged with before and after'
);
select is(
  pg_temp.audits('order_item.status_reverted', :'i_r_cancelled')
    + pg_temp.audits('order_item.status_reverted', :'i_r_removed'),
  0::bigint,
  'refused reverts are not logged'
);

select tests.authenticate_as(:'a_kitchen');
select is(
  public.staff_update_item_status(:'i_chain', 'preparing') ->> 'changed', 'true',
  'after a revert the kitchen can move the dish forward again'
);

-- ─── After billing (table 8) ────────────────────────────────────────────────
select tests.authenticate_as(:'a_manager');
select throws_ok(
  format($f$ select public.staff_approve_order(%L) $f$, :'t8_r2'),
  'P0001', 'SESSION_NOT_OPEN', 'a waiting round of a billed table cannot be approved'
);
select throws_ok(
  format($f$ select public.staff_reject_order(%L, 'Too late') $f$, :'t8_r2'),
  'P0001', 'SESSION_NOT_OPEN', 'or rejected'
);
select throws_ok(
  format($f$ select public.staff_update_item_status(%L, 'served') $f$, :'i_b_placed'),
  'P0001', 'SESSION_NOT_OPEN', 'a billed dish cannot move'
);
select throws_ok(
  format($f$ select public.staff_mark_order_served(%L) $f$, :'t8_r1'),
  'P0001', 'SESSION_NOT_OPEN', 'a billed round cannot be marked served'
);
select throws_ok(
  format($f$ select public.staff_revert_item_status(%L, 'preparing') $f$, :'i_b_preparing'),
  'P0001', 'SESSION_NOT_OPEN', 'a billed dish cannot be reverted'
);

select tests.clear_auth();
select results_eq(
  format(
    $f$ select o.status::text, oi.note, oi.status::text
        from public.order_items oi join public.orders o on o.id = oi.order_id
        where oi.session_id = %L order by oi.note $f$,
    :'t8_session'
  ),
  $$ values
    ('accepted', 'b placed', 'placed'),
    ('accepted', 'b preparing', 'preparing'),
    ('pending_approval', 'b waiting', 'placed') $$,
  'nothing changes after billing'
);

-- ─── Another restaurant's orders ────────────────────────────────────────────
select tests.authenticate_as(:'a_owner');
select throws_ok(
  format($f$ select public.staff_approve_order(%L) $f$, :'b_r1'),
  'P0001', 'NOT_FOUND', 'another restaurant''s order cannot be approved'
);
select throws_ok(
  format($f$ select public.staff_reject_order(%L, 'Not ours') $f$, :'b_r1'),
  'P0001', 'NOT_FOUND', 'or rejected'
);
select throws_ok(
  format($f$ select public.staff_update_item_status(%L, 'preparing') $f$, :'i_other'),
  'P0001', 'NOT_FOUND', 'another restaurant''s dish cannot be moved'
);
select throws_ok(
  format($f$ select public.staff_mark_order_served(%L) $f$, :'b_r1'),
  'P0001', 'NOT_FOUND', 'another restaurant''s round cannot be marked served'
);
select throws_ok(
  format($f$ select public.staff_revert_item_status(%L, 'preparing') $f$, :'i_other'),
  'P0001', 'NOT_FOUND', 'another restaurant''s dish cannot be reverted'
);

select tests.clear_auth();
select results_eq(
  format(
    $f$ select o.status::text, oi.status::text
        from public.orders o join public.order_items oi on oi.order_id = o.id where o.id = %L $f$,
    :'b_r1'
  ),
  $$ values ('pending_approval', 'placed') $$,
  'and it stays as it was'
);

-- ─── Read-only restaurants keep service going (spec §10.6) ──────────────────
select tests.suspend(:'rest_a');
select is(
  (select state from public.restaurant_access(:'rest_a')), 'read_only',
  'restaurant A is now read-only'
);

select tests.authenticate_as(:'a_waiter');
select is(
  public.staff_approve_order(:'t9_r1') ->> 'changed', 'true',
  'waiters can still approve orders while read-only'
);
select is(
  public.staff_reject_order(:'t9_r2', 'Duplicate order') ->> 'changed', 'true',
  'and reject them'
);
select is(
  public.staff_mark_order_served(:'t7_ro_serve') ->> 'served', '1',
  'and mark rounds served'
);
select tests.authenticate_as(:'a_kitchen');
select is(
  public.staff_update_item_status(:'i_ro_move', 'preparing') ->> 'changed', 'true',
  'the kitchen can still move dishes'
);
select tests.authenticate_as(:'a_manager');
select is(
  public.staff_revert_item_status(:'i_ro_revert', 'served') ->> 'status', 'ready',
  'managers can still revert a step'
);

select tests.clear_auth();
select results_eq(
  format(
    $f$ select (select status::text from public.orders where id = %L),
               (select status::text from public.orders where id = %L),
               (select is_approved from public.table_sessions s
                  join public.orders o on o.session_id = s.id where o.id = %L) $f$,
    :'t9_r1', :'t9_r2', :'t9_r1'
  ),
  $$ values ('accepted', 'rejected', true) $$,
  'the decisions made while read-only are saved'
);

select * from finish();

rollback;
