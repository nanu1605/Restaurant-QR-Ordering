-- Live board for the worker panel and admin Live orders (spec §9.3 function
-- table, §10.1 sessions, §10.2 kitchen never sees waiting or rejected rounds,
-- §10.6 read-only, §10.7 waiters, §10.8 removals, §12 one read per refresh;
-- docs/DECISIONS.md P3-5, P4-3, P4-4, P4-5).
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ─── Fixtures ───────────────────────────────────────────────────────────────
-- Alpha: first-order approval on, one table per story, a login per role.
-- Bravo: another tenant whose table, session and waiter must stay hidden.
-- Empty: a restaurant with nothing set up yet.
select tests.create_restaurant('p4-150-alpha') as rest_a \gset
select tests.create_restaurant('p4-150-bravo') as rest_b \gset
select tests.create_restaurant('p4-150-empty') as rest_e \gset
update public.restaurants
  set timezone = 'Asia/Dubai', max_tables_per_waiter = 2, staff_can_remove_served_items = true
  where id = :'rest_a';

select tests.create_ordering_fixture(:'rest_a', 'P4150ALPHATBL005') as fx \gset
select tests.create_ordering_fixture(:'rest_b', 'P4150BRAVOTBL005') as fx_b \gset
select
  :'fx'::jsonb ->> 'table' as table5,
  :'fx'::jsonb ->> 'simple' as simple,
  :'fx'::jsonb ->> 'variant_item' as variant_item,
  :'fx'::jsonb ->> 'half' as half,
  :'fx'::jsonb ->> 'full' as full,
  :'fx_b'::jsonb ->> 'table' as b_table,
  :'fx_b'::jsonb ->> 'simple' as b_simple
\gset

-- Table 5 (sort 1) comes from the fixture. Table 3 sorts first; B2 and A2
-- share a sort order (B2 inserted first); 8 and 7 are switched off later;
-- 9 is off from the start and never used.
insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
  values (:'rest_a', '3', 'P4150ALPHATBL003', 0) returning id as table3 \gset
insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
  values (:'rest_a', 'B2', 'P4150ALPHATBL0B2', 2) returning id as table_b2 \gset
insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
  values (:'rest_a', 'A2', 'P4150ALPHATBL0A2', 2) returning id as table_a2 \gset
insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
  values (:'rest_a', '8', 'P4150ALPHATBL008', 4) returning id as table8 \gset
insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
  values (:'rest_a', '7', 'P4150ALPHATBL007', 5) returning id as table7 \gset
insert into public.dining_tables (restaurant_id, label, qr_token, sort_order, is_active)
  values (:'rest_a', '9', 'P4150ALPHATBL009', 3, false) returning id as table9 \gset

-- Logins: every role; Ravi and Anita linked to waiter profiles (Anita off
-- duty), Gopal's profile deleted, a waiter with no profile, a deactivated
-- login and a user with no membership at all.
select tests.add_member(:'rest_a', 'owner', 'owner') as owner \gset
select tests.add_member(:'rest_a', 'manager', 'meera') as meera \gset
select tests.add_member(:'rest_a', 'kitchen', 'kitchen') as kitchen \gset
select tests.add_member(:'rest_a', 'waiter', 'ravi') as ravi \gset
select tests.add_member(:'rest_a', 'waiter', 'anita') as anita \gset
select tests.add_member(:'rest_a', 'waiter', 'gopal') as gopal \gset
select tests.add_member(:'rest_a', 'waiter', 'nolink') as nolink \gset
select tests.add_member(:'rest_a', 'waiter', 'former') as former \gset
update public.restaurant_members set is_active = false where user_id = :'former';
select tests.add_member(:'rest_b', 'manager', 'b_manager') as b_manager \gset
select tests.add_member(:'rest_e', 'owner', 'e_owner') as e_owner \gset
select tests.create_user('outsider@p4-150.test') as outsider \gset

select tests.add_waiter(:'rest_a', 'Ravi', :'ravi') as w_ravi \gset
select tests.add_waiter(:'rest_a', 'Anita', :'anita', false) as w_anita \gset
select tests.add_waiter(:'rest_a', 'Gopal', :'gopal') as w_gopal \gset
update public.waiters set is_active = false, on_duty = false, deleted_at = now()
  where id = :'w_gopal';
select tests.add_waiter(:'rest_b', 'Bruno') as w_bruno \gset

\set phone '15015015-0150-4150-8150-150150150150'

-- ─── Helpers ────────────────────────────────────────────────────────────────
-- A customer order placed as the server. Returns the order id.
create function pg_temp.customer_order(
  p_token text, p_key text, p_device text, variadic p_lines jsonb[]
)
returns uuid
language sql
as $$
  select (
    public.customer_place_order(p_token, p_device, p_key, to_jsonb(p_lines)) ->> 'order_id'
  )::uuid;
$$;

-- Boards fetched as each caller, and ways to look inside them.
create temp table boards (who text primary key, board jsonb not null);

create function pg_temp.board(p_who text)
returns jsonb
language sql
as $$
  select b.board from pg_temp.boards b where b.who = p_who;
$$;

-- The table with this label on a board (null when it isn't listed).
create function pg_temp.board_table(p_board jsonb, p_label text)
returns jsonb
language sql
as $$
  select t from jsonb_array_elements(p_board -> 'tables') t where t ->> 'label' = p_label;
$$;

-- One round of a table's open session on a board.
create function pg_temp.board_round(p_board jsonb, p_label text, p_round int)
returns jsonb
language sql
as $$
  select r
  from jsonb_array_elements(pg_temp.board_table(p_board, p_label) -> 'session' -> 'rounds') r
  where (r ->> 'round_number')::int = p_round;
$$;

-- Keys of a JSON object, sorted and comma-separated.
create function pg_temp.keys_of(p_object jsonb)
returns text
language sql
as $$
  select string_agg(k, ',' order by k) from jsonb_object_keys(p_object) k;
$$;

-- Every round on a board, in board order.
create function pg_temp.rounds_of(p_board jsonb)
returns table (label text, round_number int, status text, is_waiting boolean)
language sql
as $$
  select t ->> 'label', (r ->> 'round_number')::int, r ->> 'status', (r ->> 'is_waiting')::boolean
  from jsonb_array_elements(p_board -> 'tables') with ordinality as tt(t, tn)
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(t -> 'session') = 'object' then t -> 'session' -> 'rounds' else '[]' end
  ) with ordinality as rr(r, rn)
  order by tt.tn, rr.rn;
$$;

-- ─── Table stories ──────────────────────────────────────────────────────────
-- Table 5, unapproved: round 1 waits (with a note); round 2's only dish is
-- cancelled by the customer; round 3 keeps one of its two dishes; round 4 has
-- every dish cancelled; round 5 is rejected by a waiter.
select public.customer_place_order(
  'P4150ALPHATBL005', gen_random_uuid()::text, 't5-round-1',
  jsonb_build_array(
    tests.line(:'simple', 2, null, 'less spicy'),
    tests.line(:'variant_item', 1, :'half')
  ),
  '  Birthday   table '
) ->> 'order_id' as t5_r1 \gset
select pg_temp.customer_order('P4150ALPHATBL005', 't5-round-2', :'phone', tests.line(:'simple'))
  as t5_r2 \gset
select public.customer_cancel_item('P4150ALPHATBL005', :'phone', id)
  from public.order_items where order_id = :'t5_r2';
select pg_temp.customer_order(
  'P4150ALPHATBL005', 't5-round-3', gen_random_uuid()::text,
  tests.line(:'simple'), tests.line(:'variant_item', 1, :'full')
) as t5_r3 \gset
update public.order_items set status = 'cancelled', cancelled_at = now()
  where order_id = :'t5_r3' and variant_id is null;
select pg_temp.customer_order(
  'P4150ALPHATBL005', 't5-round-4', gen_random_uuid()::text,
  tests.line(:'simple'), tests.line(:'variant_item', 1, :'half')
) as t5_r4 \gset
update public.order_items set status = 'cancelled', cancelled_at = now()
  where order_id = :'t5_r4';
select pg_temp.customer_order(
  'P4150ALPHATBL005', 't5-round-5', gen_random_uuid()::text, tests.line(:'simple')
) as t5_r5 \gset
select session_id as s5 from public.orders where id = :'t5_r1' \gset

-- Table A2: round 1 was placed 10 minutes ago and is approved now.
select pg_temp.customer_order(
  'P4150ALPHATBL0A2', 'a2-round-1', gen_random_uuid()::text, tests.line(:'simple')
) as a2_r1 \gset
update public.orders set created_at = now() - interval '10 minutes' where id = :'a2_r1';
select session_id as s_a2 from public.orders where id = :'a2_r1' \gset

select tests.authenticate_as(:'ravi');
select public.staff_approve_order(:'a2_r1');
select public.staff_reject_order(:'t5_r5', 'Nobody at the table');
select tests.clear_auth();

-- Round 2 was accepted on arrival 5 minutes ago. Its Paneer Tikka line is
-- backdated so the time added decides the order before the name does.
select pg_temp.customer_order(
  'P4150ALPHATBL0A2', 'a2-round-2', gen_random_uuid()::text,
  tests.line(:'simple', 2, null, 'less spicy'),
  tests.line(:'variant_item', 1, :'full'),
  tests.line(:'variant_item', 1, :'half')
) as a2_r2 \gset
update public.orders set created_at = now() - interval '5 minutes' where id = :'a2_r2';
update public.order_items set created_at = now() - interval '5 minutes'
  where order_id = :'a2_r2' and variant_id is null;
select id as a2_paneer from public.order_items where order_id = :'a2_r2' and variant_id is null \gset
select id as a2_full from public.order_items where order_id = :'a2_r2' and variant_id = :'full' \gset
select id as a2_half from public.order_items where order_id = :'a2_r2' and variant_id = :'half' \gset

-- Round 3 is a staff order the manager deletes; then she assigns Ravi. Ravi
-- removes a dish from round 2 and the kitchen gets another one ready.
select tests.authenticate_as(:'meera');
select public.staff_place_order(:'table_a2', jsonb_build_array(tests.line(:'simple')), 'a2-round-3')
  ->> 'order_id' as a2_r3 \gset
select public.admin_remove_order(:'a2_r3', 'Entered twice');
select public.admin_assign_waiter(:'s_a2', :'w_ravi');
select tests.authenticate_as(:'ravi');
select public.staff_remove_item(:'a2_half', 1, 'Guest changed mind');
select tests.authenticate_as(:'kitchen');
select public.staff_update_item_status(:'a2_full', 'ready');
select tests.clear_auth();

-- Table B2's last session was billed, so it is free again. Table 8 is
-- switched off while its guests are still there; table 7 is closed without
-- a bill and then switched off.
select pg_temp.customer_order(
  'P4150ALPHATBL0B2', 'b2-round-1', gen_random_uuid()::text, tests.line(:'simple')
) as b2_r1 \gset
select tests.bill_session(session_id) from public.orders where id = :'b2_r1';
select pg_temp.customer_order(
  'P4150ALPHATBL008', 't8-round-1', gen_random_uuid()::text, tests.line(:'simple')
) as t8_r1 \gset
select session_id as s8 from public.orders where id = :'t8_r1' \gset
update public.dining_tables set is_active = false where id = :'table8';
select pg_temp.customer_order(
  'P4150ALPHATBL007', 't7-round-1', gen_random_uuid()::text, tests.line(:'simple')
) as t7_r1 \gset
update public.table_sessions set status = 'closed_unbilled', closed_at = now()
  where id = (select session_id from public.orders where id = :'t7_r1');
update public.dining_tables set is_active = false where id = :'table7';

-- Bravo: an open table with a waiting order.
select pg_temp.customer_order(
  'P4150BRAVOTBL005', 'bravo-round-1', gen_random_uuid()::text, tests.line(:'b_simple')
) as b_order \gset
select session_id as b_session from public.orders where id = :'b_order' \gset

-- ─── Boards, as each caller ─────────────────────────────────────────────────
select tests.authenticate_as(:'owner');
select public.staff_get_board() as owner_board \gset
select tests.authenticate_as(:'meera');
select public.staff_get_board() as manager_board \gset
select tests.authenticate_as(:'ravi');
select public.staff_get_board() as waiter_board \gset
select tests.authenticate_as(:'kitchen');
select public.staff_get_board() as kitchen_board \gset
select tests.authenticate_as(:'anita');
select public.staff_get_board() as off_duty_board \gset
select tests.authenticate_as(:'gopal');
select public.staff_get_board() as deleted_profile_board \gset
select tests.authenticate_as(:'nolink');
select public.staff_get_board() as unlinked_board \gset
select tests.authenticate_as(:'b_manager');
select public.staff_get_board() as bravo_board \gset
select tests.authenticate_as(:'e_owner');
select public.staff_get_board() as empty_board \gset
select tests.clear_auth();

insert into pg_temp.boards (who, board) values
  ('owner', :'owner_board'),
  ('manager', :'manager_board'),
  ('waiter', :'waiter_board'),
  ('kitchen', :'kitchen_board'),
  ('off_duty', :'off_duty_board'),
  ('deleted_profile', :'deleted_profile_board'),
  ('unlinked', :'unlinked_board'),
  ('bravo', :'bravo_board'),
  ('empty', :'empty_board');

-- ─── Who may call it ────────────────────────────────────────────────────────
select ok(
  has_function_privilege('authenticated', 'public.staff_get_board()', 'execute')
    and not has_function_privilege('anon', 'public.staff_get_board()', 'execute'),
  'staff logins can call it, anonymous visitors cannot'
);
select tests.as_anon();
select throws_ok(
  $$ select public.staff_get_board() $$,
  '42501', null,
  'an anonymous call is refused'
);
select tests.authenticate_as(:'outsider');
select throws_ok(
  $$ select public.staff_get_board() $$,
  'P0001', 'FORBIDDEN',
  'a user with no membership is refused'
);
select tests.authenticate_as(:'former');
select throws_ok(
  $$ select public.staff_get_board() $$,
  'P0001', 'FORBIDDEN',
  'a deactivated login is refused'
);
select tests.clear_auth();

-- ─── Shape ──────────────────────────────────────────────────────────────────
select is(
  pg_temp.keys_of(pg_temp.board('waiter')),
  'access_state,my_waiter_id,now,requests,role,settings,tables,timezone,waiters',
  'the board has now, timezone, role, my_waiter_id, access_state, settings, tables, waiters and requests'
);
select is(
  (pg_temp.board('waiter') ->> 'now')::timestamptz, now(),
  'now is the database clock'
);
select is(pg_temp.board('waiter') ->> 'timezone', 'Asia/Dubai', 'timezone is the restaurant''s');
select is(
  pg_temp.board('bravo') ->> 'timezone', 'Asia/Kolkata',
  'each restaurant gets its own timezone'
);
select is(
  pg_temp.board('waiter') ->> 'access_state', 'full',
  'a restaurant in good standing has full access'
);
select is(
  pg_temp.board('waiter') -> 'settings',
  '{"require_first_order_approval": true, "max_tables_per_waiter": 2,
    "staff_can_remove_served_items": true}'::jsonb,
  'the settings the screens need come from the restaurant'
);
select results_eq(
  $$ select who, board ->> 'role' from pg_temp.boards
     where who in ('owner', 'manager', 'waiter', 'kitchen') order by who $$,
  $$ values ('kitchen', 'kitchen'), ('manager', 'manager'), ('owner', 'owner'), ('waiter', 'waiter') $$,
  'role is the caller''s own'
);
select is(
  pg_temp.keys_of(pg_temp.board_table(pg_temp.board('waiter'), '5')),
  'id,label,session,sort_order',
  'a table has id, label, sort_order and session'
);
select is(
  pg_temp.keys_of(pg_temp.board_table(pg_temp.board('waiter'), '5') -> 'session'),
  'assigned_waiter_id,id,is_approved,opened_at,rounds,waiting_count',
  'a session has id, opened_at, is_approved, assigned_waiter_id, waiting_count and rounds'
);
select is(
  pg_temp.keys_of(pg_temp.board_round(pg_temp.board('waiter'), 'A2', 2)),
  'accepted_at,created_at,customer_note,id,is_waiting,items,placed_via,reject_reason,'
    || 'removed_by_name,removed_reason,round_number,status',
  'a round has its number, status, origin, times, note, reasons, remover, waiting flag and dishes'
);
select is(
  pg_temp.keys_of(pg_temp.board_round(pg_temp.board('waiter'), 'A2', 2) -> 'items' -> 0),
  'food_type,id,name,note,quantity,removed_by_name,removed_reason,status,variant',
  'a dish has its name, option, food type, quantity, note, status and removal details'
);
select is(
  pg_temp.keys_of(pg_temp.board('waiter') -> 'waiters' -> 0),
  'id,name,on_duty',
  'a waiter has id, name and on_duty'
);
select is(
  (select count(*) from pg_temp.boards
    where strpos(board::text, 'price') > 0 or strpos(board::text, 'paise') > 0),
  0::bigint,
  'no board carries a price'
);

-- ─── Tables ─────────────────────────────────────────────────────────────────
select results_eq(
  $$ select t ->> 'id', t ->> 'label', (t ->> 'sort_order')::int, jsonb_typeof(t -> 'session')
     from jsonb_array_elements(pg_temp.board('waiter') -> 'tables') with ordinality as x(t, n)
     order by n $$,
  format(
    $f$ values (%L, '3', 0, 'null'), (%L, '5', 1, 'object'), (%L, 'A2', 2, 'object'),
               (%L, 'B2', 2, 'null'), (%L, '8', 4, 'object') $f$,
    :'table3', :'table5', :'table_a2', :'table_b2', :'table8'
  ),
  'tables come by sort order, then label; a free table has no session'
);
select is(
  pg_temp.board_table(pg_temp.board('waiter'), 'B2') -> 'session', 'null'::jsonb,
  'a table whose last session was billed is free'
);
select ok(
  pg_temp.board_table(pg_temp.board('waiter'), '9') is null,
  'a switched-off table with no open session is left out'
);
select ok(
  pg_temp.board_table(pg_temp.board('waiter'), '7') is null,
  'so is one whose session was closed without a bill'
);
select is(
  pg_temp.board_table(pg_temp.board('waiter'), '8') #>> '{session,id}', :'s8',
  'a table switched off mid-meal stays on the board with its open session'
);

-- ─── Sessions ───────────────────────────────────────────────────────────────
select results_eq(
  $$ select s ->> 'id', (s ->> 'opened_at')::timestamptz, (s ->> 'is_approved')::boolean,
            s ->> 'assigned_waiter_id', (s ->> 'waiting_count')::int
     from (select pg_temp.board_table(pg_temp.board('waiter'), '5') -> 'session' as s) x $$,
  format(
    $f$ select id::text, opened_at, false, null::text, 2 from public.table_sessions where id = %L $f$,
    :'s5'
  ),
  'table 5: unapproved and unassigned, with 2 rounds waiting (not the cancelled or rejected ones)'
);
select results_eq(
  $$ select s ->> 'id', (s ->> 'opened_at')::timestamptz, (s ->> 'is_approved')::boolean,
            s ->> 'assigned_waiter_id', (s ->> 'waiting_count')::int
     from (select pg_temp.board_table(pg_temp.board('waiter'), 'A2') -> 'session' as s) x $$,
  format(
    $f$ select id::text, opened_at, true, %L::text, 0 from public.table_sessions where id = %L $f$,
    :'w_ravi', :'s_a2'
  ),
  'table A2: approved, assigned to Ravi, nothing waiting'
);

-- ─── Rounds ─────────────────────────────────────────────────────────────────
select results_eq(
  $$ select * from pg_temp.rounds_of(pg_temp.board('waiter')) $$,
  $$ values
       ('5', 1, 'pending_approval', true),
       ('5', 2, 'pending_approval', false),
       ('5', 3, 'pending_approval', true),
       ('5', 4, 'pending_approval', false),
       ('5', 5, 'rejected', false),
       ('A2', 1, 'accepted', false),
       ('A2', 2, 'accepted', false),
       ('A2', 3, 'removed', false),
       ('8', 1, 'pending_approval', true) $$,
  'a waiter gets every round of every open session, in round order'
);
select is(
  (pg_temp.board_round(pg_temp.board('waiter'), '5', 2) ->> 'is_waiting')::boolean, false,
  'P3-5: a waiting round whose dish the customer cancelled needs no decision'
);
select is(
  (pg_temp.board_round(pg_temp.board('waiter'), '5', 4) ->> 'is_waiting')::boolean, false,
  'nor does one whose dishes were all cancelled'
);
select is(
  (pg_temp.board_round(pg_temp.board('waiter'), '5', 3) ->> 'is_waiting')::boolean, true,
  'a waiting round with one dish left still waits'
);
select results_eq(
  $$ select r ->> 'id', r ->> 'placed_via', (r ->> 'created_at')::timestamptz, r ->> 'accepted_at',
            r ->> 'customer_note', r ->> 'reject_reason', r ->> 'removed_reason', r ->> 'removed_by_name'
     from (select pg_temp.board_round(pg_temp.board('waiter'), '5', 1) as r) x $$,
  format(
    $f$ values (%L, 'customer', now(), null::text, 'Birthday table', null::text, null::text, null::text) $f$,
    :'t5_r1'
  ),
  'a waiting round: placed by a customer, not accepted yet, with its tidied note'
);
select results_eq(
  $$ select r ->> 'accepted_at', r ->> 'reject_reason'
     from (select pg_temp.board_round(pg_temp.board('waiter'), '5', 5) as r) x $$,
  $$ values (null::text, 'Nobody at the table') $$,
  'a rejected round shows the reason and was never accepted'
);
select results_eq(
  $$ select (r ->> 'round_number')::int, (r ->> 'created_at')::timestamptz,
            (r ->> 'accepted_at')::timestamptz
     from jsonb_array_elements(pg_temp.board_table(pg_temp.board('waiter'), 'A2') #> '{session,rounds}') r
     where r ->> 'status' = 'accepted'
     order by 1 $$,
  $$ values (1, now() - interval '10 minutes', now()),
            (2, now() - interval '5 minutes', now() - interval '5 minutes') $$,
  'accepted_at is when staff approved the round, or when it was placed if accepted on arrival'
);
select results_eq(
  $$ select r ->> 'placed_via', r ->> 'accepted_at', r ->> 'removed_reason', r ->> 'removed_by_name'
     from (select pg_temp.board_round(pg_temp.board('waiter'), 'A2', 3) as r) x $$,
  $$ values ('staff', null::text, 'Entered twice', 'Meera') $$,
  'a deleted round shows who removed it and why, and no longer counts as accepted'
);

-- ─── Dishes ─────────────────────────────────────────────────────────────────
select is(
  (select array_agg(i ->> 'name' order by n)
   from jsonb_array_elements(pg_temp.board_round(pg_temp.board('waiter'), '5', 1) -> 'items')
     with ordinality as x(i, n)),
  array['Butter Chicken', 'Paneer Tikka'],
  'dishes added together are listed by name'
);
select is(
  (select array_agg(i ->> 'id' order by n)
   from jsonb_array_elements(pg_temp.board_round(pg_temp.board('waiter'), 'A2', 2) -> 'items')
     with ordinality as x(i, n)),
  array[:'a2_paneer'] || array(
    select id::text from public.order_items
    where order_id = :'a2_r2' and variant_id is not null
    order by id
  ),
  'dishes are listed by when they were added, then by name, then by id'
);
select set_eq(
  $$ select i ->> 'id' as id, i ->> 'name' as name, i ->> 'variant' as variant,
            i ->> 'food_type' as food_type, (i ->> 'quantity')::int as quantity, i ->> 'note' as note,
            i ->> 'status' as status, i ->> 'removed_reason' as removed_reason,
            i ->> 'removed_by_name' as removed_by_name
     from jsonb_array_elements(pg_temp.board_round(pg_temp.board('waiter'), 'A2', 2) -> 'items') i $$,
  format(
    $f$ values
         (%L, 'Paneer Tikka', null::text, 'veg', 2, 'less spicy', 'placed', null::text, null::text),
         (%L, 'Butter Chicken', 'Full', 'non_veg', 1, null, 'ready', null, null),
         (%L, 'Butter Chicken', 'Half', 'non_veg', 1, null, 'removed', 'Guest changed mind', 'Ravi') $f$,
    :'a2_paneer', :'a2_full', :'a2_half'
  ),
  'each dish shows name, option, food type, quantity, note and status; a removed one shows why and who'
);
select results_eq(
  $$ select i ->> 'status', i ->> 'removed_reason', i ->> 'removed_by_name'
     from jsonb_array_elements(pg_temp.board_round(pg_temp.board('waiter'), 'A2', 3) -> 'items') i $$,
  $$ values ('removed', 'Entered twice', 'Meera') $$,
  'the dishes of a deleted round carry the manager''s reason and name'
);

-- ─── Kitchen ────────────────────────────────────────────────────────────────
select results_eq(
  $$ select * from pg_temp.rounds_of(pg_temp.board('kitchen')) $$,
  $$ values ('A2', 1, 'accepted', false), ('A2', 2, 'accepted', false) $$,
  'the kitchen gets accepted rounds only: never waiting, rejected or deleted ones (a round may be deleted while still waiting)'
);
select results_eq(
  $$ select t ->> 'label', t #> '{session,rounds}', (t #>> '{session,waiting_count}')::int
     from jsonb_array_elements(pg_temp.board('kitchen') -> 'tables') with ordinality as x(t, n)
     where t ->> 'label' in ('5', '8')
     order by n $$,
  $$ values ('5', '[]'::jsonb, 2), ('8', '[]'::jsonb, 1) $$,
  'but it still learns how many rounds are waiting at each table'
);
select results_eq(
  $$ select t ->> 'id', t #>> '{session,id}'
     from jsonb_array_elements(pg_temp.board('kitchen') -> 'tables') with ordinality as x(t, n)
     order by n $$,
  $$ select t ->> 'id', t #>> '{session,id}'
     from jsonb_array_elements(pg_temp.board('waiter') -> 'tables') with ordinality as x(t, n)
     order by n $$,
  'the kitchen sees the same tables and sessions as everyone else'
);
select is(
  (select count(*)
   from public.order_items oi
   join public.orders o on o.id = oi.order_id
   where o.restaurant_id = :'rest_a'
     and o.status in ('pending_approval', 'rejected')
     and (strpos(pg_temp.board('kitchen')::text, oi.id::text) > 0
          or strpos(pg_temp.board('kitchen')::text, o.id::text) > 0)),
  0::bigint,
  'no waiting or rejected round, nor any of its dishes, reaches the kitchen'
);
select ok(
  strpos(pg_temp.board('kitchen')::text, 'Birthday table') = 0
    and strpos(pg_temp.board('kitchen')::text, 'Nobody at the table') = 0,
  'nor their notes or reject reasons'
);

-- ─── Managers and owners ────────────────────────────────────────────────────
select is(
  pg_temp.board('manager') - 'role' - 'my_waiter_id',
  pg_temp.board('waiter') - 'role' - 'my_waiter_id',
  'a manager gets the same board as a waiter, every round included'
);
select is(
  pg_temp.board('owner') - 'role' - 'my_waiter_id',
  pg_temp.board('waiter') - 'role' - 'my_waiter_id',
  'and so does an owner'
);

-- ─── Waiters and my_waiter_id ───────────────────────────────────────────────
select set_eq(
  $$ select w ->> 'id' as id, w ->> 'name' as name, (w ->> 'on_duty')::boolean as on_duty
     from jsonb_array_elements(pg_temp.board('waiter') -> 'waiters') w $$,
  format($f$ values (%L, 'Anita', false), (%L, 'Ravi', true) $f$, :'w_anita', :'w_ravi'),
  'active waiter profiles are listed with their duty status; a deleted one is not'
);
select is(
  pg_temp.board('waiter') ->> 'my_waiter_id', :'w_ravi',
  'a linked waiter login gets its own profile id'
);
select is(
  pg_temp.board('off_duty') ->> 'my_waiter_id', :'w_anita',
  'even while off duty'
);
select is(
  pg_temp.board('deleted_profile') -> 'my_waiter_id', 'null'::jsonb,
  'a login whose profile was deleted gets none'
);
select is(
  pg_temp.board('unlinked') -> 'my_waiter_id', 'null'::jsonb,
  'a waiter login without a profile gets none'
);
select is(
  pg_temp.board('manager') -> 'my_waiter_id', 'null'::jsonb,
  'nor does a manager without one'
);

-- ─── Other restaurants ──────────────────────────────────────────────────────
select is(
  (select count(*) from pg_temp.boards
    where who <> 'bravo'
      and (strpos(board::text, :'b_table') > 0 or strpos(board::text, :'b_session') > 0
           or strpos(board::text, :'b_order') > 0 or strpos(board::text, :'w_bruno') > 0)),
  0::bigint,
  'another restaurant''s tables, sessions, rounds and waiters never appear'
);
select results_eq(
  $$ select t ->> 'id', t #>> '{session,id}' from jsonb_array_elements(pg_temp.board('bravo') -> 'tables') t $$,
  format($f$ values (%L, %L) $f$, :'b_table', :'b_session'),
  'Bravo''s manager sees only Bravo''s table'
);
select results_eq(
  $$ select w ->> 'id' from jsonb_array_elements(pg_temp.board('bravo') -> 'waiters') w $$,
  format($f$ values (%L) $f$, :'w_bruno'),
  'and only Bravo''s waiters'
);
select results_eq(
  $$ select board -> 'tables', board -> 'waiters' from pg_temp.boards where who = 'empty' $$,
  $$ values ('[]'::jsonb, '[]'::jsonb) $$,
  'a restaurant with no tables or waiters gets empty lists'
);

-- ─── Read-only ──────────────────────────────────────────────────────────────
select tests.suspend(:'rest_a');
select tests.authenticate_as(:'ravi');
select public.staff_get_board() as read_only_board \gset
select tests.clear_auth();

select is(
  :'read_only_board'::jsonb ->> 'access_state', 'read_only',
  'a suspended restaurant''s board says read-only'
);
select is(
  :'read_only_board'::jsonb - 'access_state',
  pg_temp.board('waiter') - 'access_state',
  'and everything else stays on it, so service carries on'
);

-- ─── Names outlast logins ───────────────────────────────────────────────────
update public.restaurant_members set is_active = false where user_id = :'meera';
select tests.authenticate_as(:'ravi');
select public.staff_get_board() as after_leaving_board \gset
select tests.clear_auth();

select results_eq(
  format(
    $f$ select r ->> 'removed_by_name', r #>> '{items,0,removed_by_name}'
        from (select pg_temp.board_round(%L::jsonb, 'A2', 3) as r) x $f$,
    :'after_leaving_board'
  ),
  $$ values ('Meera', 'Meera') $$,
  'a removal still names the manager after her login is deactivated'
);

select * from finish();

rollback;
