-- Table service (spec §8.7, §9.3; docs/DECISIONS.md P9-1…P9-3): customers call
-- a waiter or ask for the bill, staff acknowledge and finish requests, the
-- board carries them, ending a session finishes them, and staff move a table's
-- guests to a free table.
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ─── Fixtures ───────────────────────────────────────────────────────────────
select tests.create_restaurant('p9-410-a') as rest_a \gset
select tests.create_restaurant('p9-410-b') as rest_b \gset
select tests.add_member(:'rest_a', 'manager', 'a_manager') as a_manager \gset
select tests.add_member(:'rest_a', 'waiter', 'a_waiter') as a_waiter \gset
select tests.add_member(:'rest_a', 'kitchen', 'a_kitchen') as a_kitchen \gset

select tests.create_ordering_fixture(:'rest_a', 'P9410A0000TABLE5') as fx \gset
select tests.create_ordering_fixture(:'rest_b', 'P9410B0000TABLE5') as fx_b \gset
select
  :'fx'::jsonb ->> 'table' as t5,
  :'fx'::jsonb ->> 'simple' as simple,
  :'fx_b'::jsonb ->> 'table' as b_t5
\gset

insert into public.dining_tables (restaurant_id, label, qr_token, sort_order, is_active)
values
  (:'rest_a', '6', 'P9410A0000TABLE6', 6, true),
  (:'rest_a', '7', 'P9410A0000TABLE7', 7, false),
  (:'rest_a', '8', 'P9410A0000TABLE8', 8, true),
  (:'rest_a', '9', 'P9410A0000TABLE9', 9, true);
select id as t6 from public.dining_tables where qr_token = 'P9410A0000TABLE6' \gset
select id as t7 from public.dining_tables where qr_token = 'P9410A0000TABLE7' \gset
select id as t8 from public.dining_tables where qr_token = 'P9410A0000TABLE8' \gset
select id as t9 from public.dining_tables where qr_token = 'P9410A0000TABLE9' \gset

create function pg_temp.ask(p_token text, p_type text)
returns jsonb
language sql
as $$
  select public.customer_create_service_request(p_token, gen_random_uuid()::text, p_type);
$$;

-- ─── Calling a waiter before ordering ───────────────────────────────────────
select tests.as_service_role();
select pg_temp.ask('P9410A0000TABLE5', 'call_waiter') ->> 'id' as call1 \gset
select is(
  (select (status::text, session_id is null, client_device_id is not null)::text
   from public.service_requests where id = :'call1'),
  '(open,t,t)',
  'a call works before the first order, with no session'
);
select is(
  pg_temp.ask('P9410A0000TABLE5', 'call_waiter') ->> 'id',
  :'call1',
  'a second tap from another phone returns the same call'
);
select throws_ok(
  $$select pg_temp.ask('P9410A0000TABLE5', 'request_bill')$$,
  'P0001', 'NOTHING_TO_BILL',
  'no bill before anything is ordered'
);
select throws_ok(
  $$select pg_temp.ask('P9410A0000NOPE00', 'call_waiter')$$,
  'P0001', 'TABLE_NOT_FOUND',
  'an unknown QR code'
);
select throws_ok(
  $$select pg_temp.ask('P9410A0000TABLE7', 'call_waiter')$$,
  'P0001', 'TABLE_NOT_FOUND',
  'a switched-off table'
);
select throws_ok(
  $$select pg_temp.ask('P9410A0000TABLE5', 'dessert')$$,
  'P0001', 'INVALID_INPUT',
  'only calls and bill requests'
);
select throws_ok(
  $$select public.customer_create_service_request('P9410A0000TABLE5', 'not-a-device', 'call_waiter')$$,
  'P0001', 'INVALID_INPUT',
  'the device id is checked'
);

-- ─── Asking for the bill ────────────────────────────────────────────────────
select (public.customer_place_order(
  'P9410A0000TABLE5', gen_random_uuid()::text, 'p9-410-order-1',
  jsonb_build_array(tests.line(:'simple'))
) ->> 'order_id') as order1 \gset
select throws_ok(
  $$select pg_temp.ask('P9410A0000TABLE5', 'request_bill')$$,
  'P0001', 'NOTHING_TO_BILL',
  'an order waiting for approval is not billable yet'
);
select session_id as s5 from public.orders where id = :'order1' \gset

select tests.authenticate_as(:'a_waiter');
select public.staff_approve_order(:'order1');
select tests.clear_auth();
select tests.as_service_role();
select pg_temp.ask('P9410A0000TABLE5', 'request_bill') ->> 'id' as bill1 \gset
select is(
  (select (type::text, status::text, session_id::text)::text from public.service_requests where id = :'bill1'),
  format('(request_bill,open,%s)', :'s5'),
  'once accepted, the bill request is linked to the session'
);

-- Read-only (here: suspended) restaurants still take calls.
select tests.clear_auth();
select tests.suspend(:'rest_b');
select tests.as_service_role();
select ok(
  pg_temp.ask('P9410B0000TABLE5', 'call_waiter') ->> 'id' is not null,
  'a call works while the restaurant is read-only'
);
select tests.clear_auth();
select id as b_call from public.service_requests where dining_table_id = :'b_t5' \gset

-- ─── Staff acknowledge and finish ───────────────────────────────────────────
select tests.authenticate_as(:'a_kitchen');
select throws_ok(
  format('select public.staff_update_service_request(%L, %L)', :'call1', 'acknowledged'),
  'P0001', 'FORBIDDEN',
  'the kitchen does not handle requests'
);
select is(
  public.staff_get_board() -> 'requests',
  '[]'::jsonb,
  'the kitchen board has no requests'
);

select tests.authenticate_as(:'a_waiter');
select is(
  (select jsonb_agg(r ->> 'type' order by r ->> 'type')
   from jsonb_array_elements(public.staff_get_board() -> 'requests') r
   where r ->> 'table_id' = :'t5'),
  '["call_waiter", "request_bill"]'::jsonb,
  'the floor board lists the table''s active requests'
);
select is(
  public.staff_update_service_request(:'call1', 'acknowledged') ->> 'changed',
  'true',
  'a waiter acknowledges the call'
);
select is(
  public.staff_update_service_request(:'call1', 'acknowledged') ->> 'changed',
  'false',
  'a second tablet acknowledging changes nothing'
);
select is(
  public.staff_update_service_request(:'call1', 'resolved') ->> 'status',
  'resolved',
  'Done finishes it'
);
select is(
  public.staff_update_service_request(:'call1', 'acknowledged') ->> 'status',
  'resolved',
  'a finished request never goes back'
);
select throws_ok(
  format('select public.staff_update_service_request(%L, %L)', :'bill1', 'open'),
  'P0001', 'INVALID_INPUT',
  'only acknowledged or resolved'
);
select throws_ok(
  format('select public.staff_update_service_request(%L, %L)', :'b_call', 'resolved'),
  'P0001', 'NOT_FOUND',
  'another restaurant''s request is not found'
);
select tests.clear_auth();
select is(
  (select (acknowledged_by = :'a_waiter'::uuid, acknowledged_at is not null,
           resolved_by = :'a_waiter'::uuid, resolved_at is not null)::text
   from public.service_requests where id = :'call1'),
  '(t,t,t,t)',
  'who acknowledged and finished it is kept'
);

select tests.as_service_role();
select isnt(
  pg_temp.ask('P9410A0000TABLE5', 'call_waiter') ->> 'id',
  :'call1',
  'after Done, a new call is a new request'
);

-- ─── Rate limit ─────────────────────────────────────────────────────────────
select tests.clear_auth();
do $$
begin
  for i in 1..10 loop
    perform pg_temp.ask('P9410A0000TABLE6', 'call_waiter');
    update public.service_requests set status = 'resolved', resolved_at = now()
    where dining_table_id = (select id from public.dining_tables where qr_token = 'P9410A0000TABLE6')
      and status <> 'resolved';
  end loop;
end;
$$;
select tests.as_service_role();
select throws_ok(
  $$select pg_temp.ask('P9410A0000TABLE6', 'call_waiter')$$,
  'P0001', 'RATE_LIMITED',
  'at most 10 requests per table per hour'
);
select tests.clear_auth();

-- ─── Moving a table ─────────────────────────────────────────────────────────
-- Table 8 already has a call of its own (someone scanned it); table 9 has guests.
select tests.as_service_role();
select pg_temp.ask('P9410A0000TABLE8', 'call_waiter') ->> 'id' as call8 \gset
select tests.clear_auth();
insert into public.table_sessions (restaurant_id, dining_table_id, table_label_snapshot, is_approved)
values (:'rest_a', :'t9', '9', true)
returning id as s9 \gset
select id as call5 from public.service_requests
where dining_table_id = :'t5' and type = 'call_waiter' and status = 'open' \gset

select tests.authenticate_as(:'a_kitchen');
select throws_ok(
  format('select public.staff_move_session(%L, %L)', :'s5', :'t8'),
  'P0001', 'FORBIDDEN',
  'the kitchen does not move tables'
);
select tests.authenticate_as(:'a_waiter');
select throws_ok(
  format('select public.staff_move_session(%L, %L)', :'s5', :'t9'),
  'P0001', 'TABLE_BUSY',
  'the new table must be free'
);
select throws_ok(
  format('select public.staff_move_session(%L, %L)', :'s5', :'t5'),
  'P0001', 'TABLE_BUSY',
  'not to the same table'
);
select throws_ok(
  format('select public.staff_move_session(%L, %L)', :'s5', :'t7'),
  'P0001', 'NOT_FOUND',
  'not to a switched-off table'
);
select throws_ok(
  format('select public.staff_move_session(%L, %L)', :'s5', :'b_t5'),
  'P0001', 'NOT_FOUND',
  'not to another restaurant''s table'
);

select is(
  public.staff_move_session(:'s5', :'t8') ->> 'table',
  '8',
  'a waiter moves the guests to table 8'
);
select tests.clear_auth();
select is(
  (select (dining_table_id::text, table_label_snapshot, status::text)::text
   from public.table_sessions where id = :'s5'),
  format('(%s,8,open)', :'t8'),
  'the session and its label follow'
);
select is(
  (select (dining_table_id::text, status::text)::text from public.service_requests where id = :'bill1'),
  format('(%s,open)', :'t8'),
  'the bill request follows the guests'
);
select is(
  (select (dining_table_id::text, status::text)::text from public.service_requests where id = :'call5'),
  format('(%s,resolved)', :'t5'),
  'a call the new table already has is finished, not doubled'
);
select is(
  (select status::text from public.service_requests where id = :'call8'),
  'open',
  'the new table keeps its own call'
);
select is(
  (select (actor_type::text, before ->> 'table', after ->> 'table')::text
   from public.audit_logs where action = 'session.moved' and entity_id = :'s5'),
  '(staff,5,8)',
  'the move is audited'
);

-- The old table is free: its next order starts a new session.
select tests.as_service_role();
select (public.customer_place_order(
  'P9410A0000TABLE5', gen_random_uuid()::text, 'p9-410-order-2',
  jsonb_build_array(tests.line(:'simple'))
) ->> 'order_id') as order2 \gset
select tests.clear_auth();
select isnt(
  (select session_id::text from public.orders where id = :'order2'),
  :'s5',
  'the old table starts a new session'
);

-- ─── Ending a session finishes its table's requests ─────────────────────────
select tests.authenticate_as(:'a_manager');
select public.staff_close_session_unbilled(:'s5', 'Guests left');
select tests.clear_auth();
select is(
  (select count(*)::int from public.service_requests where dining_table_id = :'t8' and status <> 'resolved'),
  0,
  'closing without a bill finishes every request at the table'
);

select tests.authenticate_as(:'a_waiter');
select public.staff_move_session(:'s9', :'t8');
select tests.clear_auth();
select tests.as_service_role();
select pg_temp.ask('P9410A0000TABLE8', 'call_waiter');
select tests.clear_auth();
select private.end_assignment(:'s9', 'billed');
select is(
  (select count(*)::int from public.service_requests where dining_table_id = :'t8' and status <> 'resolved'),
  0,
  'billing finishes them too'
);
select tests.authenticate_as(:'a_waiter');
select throws_ok(
  format('select public.staff_move_session(%L, %L)', :'s5', :'t6'),
  'P0001', 'SESSION_NOT_OPEN',
  'a closed session can''t move'
);
select tests.clear_auth();

-- ─── Switching a table off finishes its calls ───────────────────────────────
select tests.as_service_role();
select pg_temp.ask('P9410A0000TABLE9', 'call_waiter') ->> 'id' as call6 \gset
select tests.clear_auth();
select tests.authenticate_as(:'a_manager');
select public.admin_update_table(:'t9', '{"is_active": false}');
select tests.clear_auth();
select is(
  (select (status::text, resolved_by = :'a_manager'::uuid)::text from public.service_requests where id = :'call6'),
  '(resolved,t)',
  'a table switched off leaves the board, so its call is finished, not left waiting unseen'
);

-- ─── Grants ─────────────────────────────────────────────────────────────────
select ok(
  not has_function_privilege('anon', 'public.customer_create_service_request(text, text, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.customer_create_service_request(text, text, text)', 'execute'),
  'only the server calls the customer function'
);
select ok(
  not has_function_privilege('anon', 'public.staff_move_session(uuid, uuid)', 'execute')
    and not has_function_privilege('anon', 'public.staff_update_service_request(uuid, text)', 'execute'),
  'anon calls no staff function'
);

select * from finish();
rollback;
