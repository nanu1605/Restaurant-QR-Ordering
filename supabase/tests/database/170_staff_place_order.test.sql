-- Staff orders from the worker panel (spec §9.3 staff_place_order, §10.1 sessions,
-- §10.2 staff orders approve the session, §10.6 read-only, §10.7 auto-assign,
-- §10.8 adding dishes, §8.8 audit; docs/DECISIONS.md P4-13, P4-14, P4-15).
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ─── Fixtures ───────────────────────────────────────────────────────────────
-- Alpha is the main restaurant, Bravo another tenant, Charlie goes read-only.
select tests.create_restaurant('p4-170-alpha') as rest_a \gset
select tests.create_restaurant('p4-170-bravo') as rest_b \gset
select tests.create_restaurant('p4-170-charlie') as rest_c \gset

select tests.create_ordering_fixture(:'rest_a', 'P4170A0000TABLE5') as fx \gset
select tests.create_ordering_fixture(:'rest_b', 'P4170B0000TABLE5') as fx_b \gset
select tests.create_ordering_fixture(:'rest_c', 'P4170C0000TABLE5') as fx_c \gset

select
  :'fx'::jsonb ->> 'table' as table5,
  :'fx'::jsonb ->> 'simple' as simple,
  :'fx'::jsonb ->> 'variant_item' as variant_item,
  :'fx'::jsonb ->> 'half' as half,
  :'fx'::jsonb ->> 'full' as full,
  :'fx'::jsonb ->> 'family' as family,
  :'fx'::jsonb ->> 'unavailable' as unavailable,
  :'fx'::jsonb ->> 'hidden_item' as hidden_item,
  :'fx'::jsonb ->> 'in_hidden_category' as in_hidden_category,
  :'fx_b'::jsonb ->> 'table' as b_table5,
  :'fx_b'::jsonb ->> 'simple' as b_simple,
  :'fx_c'::jsonb ->> 'table' as c_table5,
  :'fx_c'::jsonb ->> 'simple' as c_simple
\gset

insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
  values (:'rest_a', '6', 'P4170A0000TABLE6', 6) returning id as table6 \gset
insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
  values (:'rest_a', '7', 'P4170A0000TABLE7', 7) returning id as table7 \gset
insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
  values (:'rest_a', '8', 'P4170A0000TABLE8', 8) returning id as table8 \gset
insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
  values (:'rest_a', '9', 'P4170A0000TABLE9', 9) returning id as table9 \gset
insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
  values (:'rest_a', '10', 'P4170A000TABLE10', 10) returning id as table10 \gset
-- Table 11 is switched off.
insert into public.dining_tables (restaurant_id, label, qr_token, sort_order, is_active)
  values (:'rest_a', '11', 'P4170A000TABLE11', 11, false) returning id as table11 \gset
insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
  values (:'rest_c', '6', 'P4170C0000TABLE6', 6) returning id as c_table6 \gset

-- Logins: every role, three linked waiter profiles (Suresh off duty), a waiter
-- login with no profile, a deactivated login and a user with no membership.
select tests.add_member(:'rest_a', 'owner', 'owner') as owner \gset
select tests.add_member(:'rest_a', 'manager', 'mgr') as mgr \gset
select tests.add_member(:'rest_a', 'kitchen', 'kitchen') as kitchen \gset
select tests.add_member(:'rest_a', 'waiter', 'ravi') as ravi \gset
select tests.add_member(:'rest_a', 'waiter', 'anita') as anita \gset
select tests.add_member(:'rest_a', 'waiter', 'suresh') as suresh \gset
select tests.add_member(:'rest_a', 'waiter', 'nolink') as nolink \gset
select tests.add_member(:'rest_a', 'waiter', 'gone') as gone \gset
update public.restaurant_members set is_active = false where user_id = :'gone';
select tests.add_member(:'rest_b', 'manager', 'b_mgr') as b_mgr \gset
select tests.add_member(:'rest_c', 'manager', 'c_mgr') as c_mgr \gset
select tests.create_user('outsider@p4-170.test') as outsider \gset

select tests.add_waiter(:'rest_a', 'Ravi', :'ravi') as w_ravi \gset
select tests.add_waiter(:'rest_a', 'Anita', :'anita') as w_anita \gset
select tests.add_waiter(:'rest_a', 'Suresh', :'suresh', false) as w_suresh \gset

select jsonb_build_array(tests.line(:'simple'))::text as one_dish \gset
\set unknown_dish '00000000-0000-4000-8000-000000000170'
\set unknown_table '00000000-0000-4000-8000-000000000171'

-- The error code plus DETAIL of a failed staff order, or 'no error'.
create function pg_temp.staff_order_error(
  p_table uuid, p_items jsonb, p_key text, p_note text default null
)
returns text
language plpgsql
as $$
declare
  v_detail text;
begin
  perform public.staff_place_order(p_table, p_items, p_key, p_note);
  return 'no error';
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  return sqlerrm || coalesce(' ' || nullif(v_detail, ''), '');
end;
$$;

-- ─── Who may call it ────────────────────────────────────────────────────────
select ok(
  has_function_privilege('authenticated', 'public.staff_place_order(uuid, jsonb, text, text)', 'execute')
    and not has_function_privilege('anon', 'public.staff_place_order(uuid, jsonb, text, text)', 'execute'),
  'signed-in staff can call staff_place_order, anonymous visitors cannot'
);

select tests.authenticate_as(:'outsider');
select throws_ok(
  format($f$ select public.staff_place_order(%L, %L::jsonb, 'outsider-1') $f$, :'table5', :'one_dish'),
  'P0001', 'FORBIDDEN',
  'a signed-in user who is not a member cannot place orders'
);
select tests.authenticate_as(:'gone');
select throws_ok(
  format($f$ select public.staff_place_order(%L, %L::jsonb, 'deactivated-1') $f$, :'table5', :'one_dish'),
  'P0001', 'FORBIDDEN',
  'a deactivated login cannot place orders'
);

-- ─── A free table: the order opens an approved session ──────────────────────
select tests.authenticate_as(:'mgr');
select public.staff_place_order(
  :'table5',
  jsonb_build_array(
    tests.line(:'simple', 2, null, '  less   spicy  '),
    tests.line(:'variant_item', 1, :'full')
  ),
  'p4170-order-1',
  '  birthday   party  '
) as r1 \gset

select is(:'r1'::jsonb ->> 'status', 'accepted', 'a staff order is accepted straight away');
select is((:'r1'::jsonb ->> 'round_number')::int, 1, 'the first order at a free table is round 1');
select is((:'r1'::jsonb ->> 'replayed')::boolean, false, 'a new order is not a replay');
select is(
  :'r1'::jsonb -> 'assigned_waiter_id', 'null'::jsonb,
  'a manager without a waiter profile is not assigned to the table'
);

select tests.clear_auth();
select :'r1'::jsonb ->> 'session_id' as session5 \gset

select results_eq(
  format(
    $f$ select id, status::text, is_approved, approved_by, approved_at is not null,
               table_label_snapshot, assigned_waiter_id
        from public.table_sessions where dining_table_id = %L $f$,
    :'table5'
  ),
  format($f$ values (%L::uuid, 'open', true, %L::uuid, true, '5', null::uuid) $f$, :'session5', :'mgr'),
  'a free table gets one new session, approved by the staff member and unassigned'
);
select results_eq(
  format(
    $f$ select session_id, round_number, status::text, placed_via::text, placed_by_user_id,
               client_device_id, idempotency_key, customer_note
        from public.orders where id = %L $f$,
    :'r1'::jsonb ->> 'order_id'
  ),
  format(
    $f$ values (%L::uuid, 1, 'accepted', 'staff', %L::uuid, null::text, 'p4170-order-1', 'birthday party') $f$,
    :'session5', :'mgr'
  ),
  'the round is placed via staff by the caller, with the tidied note in customer_note'
);
select results_eq(
  format(
    $f$ select session_id, menu_item_id, variant_id, item_name_snapshot, variant_name_snapshot,
               food_type_snapshot::text, unit_price_paise, quantity, note, status::text
        from public.order_items where order_id = %L order by item_name_snapshot $f$,
    :'r1'::jsonb ->> 'order_id'
  ),
  format(
    $f$ values
      (%1$L::uuid, %2$L::uuid, %3$L::uuid, 'Butter Chicken', 'Full', 'non_veg', 48000::bigint, 1,
       null::text, 'placed'),
      (%1$L::uuid, %4$L::uuid, null::uuid, 'Paneer Tikka', null::text, 'veg', 28000::bigint, 2,
       'less spicy', 'placed') $f$,
    :'session5', :'variant_item', :'full', :'simple'
  ),
  'dishes are snapshotted with database prices (the Full option''s price for Butter Chicken)'
);
select is(
  (select count(*) from public.session_waiter_assignments where session_id = :'session5'),
  0::bigint,
  'no assignment history is started'
);
select is(
  (select count(*) from public.audit_logs where restaurant_id = :'rest_a'),
  0::bigint,
  'placing an order is not audit logged (docs/DECISIONS.md P4-14)'
);

-- ─── Later orders join the open session ─────────────────────────────────────
update public.menu_items set price_paise = 30000 where id = :'simple';

select tests.authenticate_as(:'kitchen');
select public.staff_place_order(:'table5', :'one_dish'::jsonb, 'p4170-order-2', '   ') as r2 \gset
select is((:'r2'::jsonb ->> 'round_number')::int, 2, 'the kitchen can add dishes, as round 2');
select is(:'r2'::jsonb ->> 'session_id', :'session5', 'in the table''s open session');
select is(:'r2'::jsonb ->> 'status', 'accepted', 'and the round is accepted');

select tests.authenticate_as(:'owner');
select public.staff_place_order(:'table5', :'one_dish'::jsonb, 'p4170-order-3') as r3 \gset
select is((:'r3'::jsonb ->> 'round_number')::int, 3, 'the owner adds round 3');
select is(:'r3'::jsonb ->> 'session_id', :'session5', 'in the same session');

select tests.clear_auth();
select is(
  (select count(*) from public.table_sessions where dining_table_id = :'table5'),
  1::bigint,
  'the table still has a single session'
);
select results_eq(
  format(
    $f$ select round_number, placed_by_user_id, customer_note
        from public.orders where session_id = %L order by round_number $f$,
    :'session5'
  ),
  format(
    $f$ values (1, %L::uuid, 'birthday party'), (2, %L::uuid, null::text), (3, %L::uuid, null::text) $f$,
    :'mgr', :'kitchen', :'owner'
  ),
  'each round records who placed it, and a blank note is stored as null'
);
select is(
  (select approved_by from public.table_sessions where id = :'session5'),
  :'mgr'::uuid,
  'an approved session keeps who approved it'
);
select is(
  (select unit_price_paise from public.order_items where order_id = (:'r2'::jsonb ->> 'order_id')::uuid),
  30000::bigint,
  'a later round takes the current price'
);
select is(
  (select unit_price_paise from public.order_items
    where order_id = (:'r1'::jsonb ->> 'order_id')::uuid and variant_id is null),
  28000::bigint,
  'earlier rounds keep the price they were placed at'
);

-- ─── A session waiting for approval ─────────────────────────────────────────
select public.customer_place_order(
  'P4170A0000TABLE6', gen_random_uuid()::text, 'p4170-customer-1', :'one_dish'::jsonb
) as c1 \gset
select is(:'c1'::jsonb ->> 'status', 'pending_approval', 'the customer''s first order waits for approval');

select tests.authenticate_as(:'nolink');
select public.staff_place_order(:'table6', :'one_dish'::jsonb, 'p4170-order-4') as r4 \gset
select is(:'r4'::jsonb ->> 'status', 'accepted', 'a waiter''s order at a table waiting for approval is accepted');
select is((:'r4'::jsonb ->> 'round_number')::int, 2, 'as the next round of the waiting session');

select tests.clear_auth();
select results_eq(
  format(
    $f$ select s.id, s.is_approved, s.approved_by, s.approved_at is not null
        from public.table_sessions s where s.dining_table_id = %L $f$,
    :'table6'
  ),
  format(
    $f$ select session_id, true, %L::uuid, true from public.orders where id = %L $f$,
    :'nolink', :'c1'::jsonb ->> 'order_id'
  ),
  'the staff order joins the customer''s session and approves it, recording who did'
);
select is(
  (:'r4'::jsonb ->> 'session_id')::uuid,
  (select session_id from public.orders where id = (:'c1'::jsonb ->> 'order_id')::uuid),
  'and returns that session'
);
select results_eq(
  format($f$ select status::text, decided_by from public.orders where id = %L $f$, :'c1'::jsonb ->> 'order_id'),
  $$ values ('pending_approval', null::uuid) $$,
  'the customer''s waiting order still waits for staff to decide'
);
select is(
  public.customer_place_order(
    'P4170A0000TABLE6', gen_random_uuid()::text, 'p4170-customer-2', :'one_dish'::jsonb
  ) ->> 'status',
  'accepted',
  'later customer orders at that table are accepted straight away'
);

-- ─── Idempotency ────────────────────────────────────────────────────────────
update public.menu_items set is_available = false where id = :'simple';

select tests.authenticate_as(:'mgr');
select is(
  public.staff_place_order(:'table5', :'one_dish'::jsonb, 'p4170-order-1'),
  jsonb_set(:'r1'::jsonb, '{replayed}', 'true'),
  'resending the same key returns the original round, even after the dish went out of stock'
);
select tests.clear_auth();
select is(
  (select count(*) from public.orders where session_id = :'session5'),
  3::bigint,
  'a replay adds no round'
);
select is(
  (select count(*) from public.order_items where session_id = :'session5'),
  4::bigint,
  'and no dishes'
);

select tests.authenticate_as(:'kitchen');
select is(
  pg_temp.staff_order_error(:'table5', :'one_dish'::jsonb, 'p4170-order-1'),
  'INVALID_INPUT idempotency_key',
  'another staff member cannot reuse the key'
);
select tests.authenticate_as(:'mgr');
select is(
  pg_temp.staff_order_error(:'table7', :'one_dish'::jsonb, 'p4170-order-1'),
  'INVALID_INPUT idempotency_key',
  'the key cannot be reused at another table'
);
select is(
  pg_temp.staff_order_error(:'table6', :'one_dish'::jsonb, 'p4170-customer-1'),
  'INVALID_INPUT idempotency_key',
  'a customer order''s key cannot be used by staff, even at its own table'
);
select is(
  pg_temp.staff_order_error(:'table7', :'one_dish'::jsonb, 'short'),
  'INVALID_INPUT idempotency_key',
  'a key under 8 characters is rejected'
);
select is(
  pg_temp.staff_order_error(:'table7', :'one_dish'::jsonb, repeat('k', 101)),
  'INVALID_INPUT idempotency_key',
  'a key over 100 characters is rejected'
);
select is(
  pg_temp.staff_order_error(:'table7', :'one_dish'::jsonb, 'bad key!'),
  'INVALID_INPUT idempotency_key',
  'a key with spaces or symbols is rejected'
);
select is(
  pg_temp.staff_order_error(:'table7', :'one_dish'::jsonb, null),
  'INVALID_INPUT idempotency_key',
  'a key is required'
);

select tests.authenticate_as(:'b_mgr');
select is(
  public.staff_place_order(:'b_table5', jsonb_build_array(tests.line(:'b_simple')), 'p4170-order-1')
    ->> 'replayed',
  'false',
  'keys are per restaurant: another restaurant can use the same key'
);

select tests.clear_auth();
update public.menu_items set is_available = true where id = :'simple';

-- ─── Dishes that can't be ordered ───────────────────────────────────────────
-- All at free table 7, which must stay free.
select tests.authenticate_as(:'mgr');
select is(
  pg_temp.staff_order_error(:'table7', jsonb_build_array(tests.line(:'unavailable')), 'p4170-unavail-1'),
  'ITEM_UNAVAILABLE ' || :'unavailable',
  'an out-of-stock dish is refused and named'
);
select is(
  pg_temp.staff_order_error(:'table7', jsonb_build_array(tests.line(:'hidden_item')), 'p4170-unavail-2'),
  'ITEM_UNAVAILABLE ' || :'hidden_item',
  'a hidden dish is refused'
);
select is(
  pg_temp.staff_order_error(
    :'table7', jsonb_build_array(tests.line(:'in_hidden_category')), 'p4170-unavail-3'
  ),
  'ITEM_UNAVAILABLE ' || :'in_hidden_category',
  'a dish in a hidden category is refused'
);
select is(
  pg_temp.staff_order_error(:'table7', jsonb_build_array(tests.line(:'b_simple')), 'p4170-unavail-4'),
  'ITEM_UNAVAILABLE ' || :'b_simple',
  'another restaurant''s dish is refused like any unknown dish'
);
select is(
  pg_temp.staff_order_error(:'table7', jsonb_build_array(tests.line(:'unknown_dish')), 'p4170-unavail-5'),
  'ITEM_UNAVAILABLE ' || :'unknown_dish',
  'an unknown dish is refused'
);
select is(
  pg_temp.staff_order_error(:'table7', jsonb_build_array(tests.line(:'variant_item')), 'p4170-unavail-6'),
  'ITEM_UNAVAILABLE ' || :'variant_item',
  'a dish with options needs one'
);
select is(
  pg_temp.staff_order_error(
    :'table7', jsonb_build_array(tests.line(:'variant_item', 1, :'family')), 'p4170-unavail-7'
  ),
  'ITEM_UNAVAILABLE ' || :'variant_item',
  'a removed option is refused'
);
select is(
  pg_temp.staff_order_error(:'table7', jsonb_build_array(tests.line(:'simple', 1, :'half')), 'p4170-unavail-8'),
  'ITEM_UNAVAILABLE ' || :'simple',
  'an option belonging to another dish is refused'
);
select is(
  pg_temp.staff_order_error(
    :'table7',
    jsonb_build_array(
      tests.line(:'simple'), tests.line(:'unavailable'), tests.line(:'hidden_item'),
      tests.line(:'variant_item')
    ),
    'p4170-unavail-9'
  ),
  'ITEM_UNAVAILABLE ' || (
    select string_agg(id::text, ',' order by id::text)
    from unnest(array[:'unavailable', :'hidden_item', :'variant_item']::uuid[]) as id
  ),
  'every dish that can''t be ordered is named, and nothing is ordered'
);

-- ─── Payload bounds ─────────────────────────────────────────────────────────
select is(
  pg_temp.staff_order_error(:'table7', '[]'::jsonb, 'p4170-bad-1'),
  'INVALID_INPUT items', 'an empty order is rejected'
);
select is(
  pg_temp.staff_order_error(:'table7', '{}'::jsonb, 'p4170-bad-2'),
  'INVALID_INPUT items', 'items must be an array'
);
select is(
  pg_temp.staff_order_error(:'table7', null, 'p4170-bad-3'),
  'INVALID_INPUT items', 'items are required'
);
select is(
  pg_temp.staff_order_error(
    :'table7', (select jsonb_agg(tests.line(:'simple')) from generate_series(1, 31)), 'p4170-bad-4'
  ),
  'INVALID_INPUT items', 'at most 30 lines per order'
);
select is(
  pg_temp.staff_order_error(:'table7', jsonb_build_array(tests.line(:'simple', 0)), 'p4170-bad-5'),
  'INVALID_INPUT quantity', 'quantity starts at 1'
);
select is(
  pg_temp.staff_order_error(:'table7', jsonb_build_array(tests.line(:'simple', 21)), 'p4170-bad-6'),
  'INVALID_INPUT quantity', 'quantity stops at 20'
);
select is(
  pg_temp.staff_order_error(
    :'table7', jsonb_build_array(jsonb_build_object('menu_item_id', :'simple', 'quantity', 1.5)), 'p4170-bad-7'
  ),
  'INVALID_INPUT quantity', 'quantity is a whole number'
);
select is(
  pg_temp.staff_order_error(
    :'table7', jsonb_build_array(jsonb_build_object('menu_item_id', :'simple')), 'p4170-bad-8'
  ),
  'INVALID_INPUT quantity', 'quantity is required'
);
select is(
  pg_temp.staff_order_error(
    :'table7', jsonb_build_array(tests.line(:'simple', 1, null, repeat('x', 121))), 'p4170-bad-9'
  ),
  'INVALID_INPUT note', 'a dish note is at most 120 characters'
);
select is(
  pg_temp.staff_order_error(:'table7', :'one_dish'::jsonb, 'p4170-bad-10', repeat('x', 201)),
  'INVALID_INPUT note', 'the order note is at most 200 characters'
);
select is(
  pg_temp.staff_order_error(
    :'table7', jsonb_build_array(tests.line(:'simple') || '{"unit_price_paise": 1}'), 'p4170-bad-11'
  ),
  'INVALID_INPUT unit_price_paise', 'a price sent by the client is rejected, not used'
);
select is(
  pg_temp.staff_order_error(
    :'table7', jsonb_build_array(jsonb_build_object('menu_item_id', 'dish-1', 'quantity', 1)), 'p4170-bad-12'
  ),
  'INVALID_INPUT menu_item_id', 'the dish id must be a uuid'
);
select is(
  pg_temp.staff_order_error(
    :'table7', jsonb_build_array(tests.line(:'simple') || '{"variant_id": 42}'), 'p4170-bad-13'
  ),
  'INVALID_INPUT variant_id', 'the option id must be a uuid'
);
select throws_ok(
  format($f$ select public.staff_place_order(%L, '["not a line"]'::jsonb, 'p4170-bad-14') $f$, :'table7'),
  'P0001', 'INVALID_INPUT',
  'every line must be an object'
);

select tests.clear_auth();
select is(
  (select count(*) from public.table_sessions where dining_table_id = :'table7'),
  0::bigint,
  'none of the refused orders opened a session'
);

select tests.authenticate_as(:'mgr');
select public.staff_place_order(
  :'table5',
  (select jsonb_agg(tests.line(:'simple', 20, null, repeat('n', 120))) from generate_series(1, 30)),
  'p4170-largest',
  '  ' || repeat('y', 200) || '  '
) as r_largest \gset
select tests.clear_auth();
select results_eq(
  format(
    $f$ select count(*), sum(quantity), max(length(note)),
               (select length(customer_note) from public.orders where id = %1$L)
        from public.order_items where order_id = %1$L $f$,
    :'r_largest'::jsonb ->> 'order_id'
  ),
  $$ values (30::bigint, 600::bigint, 120, 200) $$,
  'the largest order is accepted: 30 lines of 20, a 120-character dish note, a 200-character note'
);

-- ─── Tables that can't take orders ──────────────────────────────────────────
select tests.authenticate_as(:'mgr');
select is(
  pg_temp.staff_order_error(:'b_table5', :'one_dish'::jsonb, 'p4170-table-1'),
  'NOT_FOUND', 'another restaurant''s table is not found'
);
select is(
  pg_temp.staff_order_error(:'b_table5', :'one_dish'::jsonb, 'p4170-order-1'),
  'NOT_FOUND', 'another restaurant''s round cannot be fetched by replaying its key at its table'
);
select is(
  pg_temp.staff_order_error(:'table11', :'one_dish'::jsonb, 'p4170-table-2'),
  'NOT_FOUND', 'a switched-off table is not found'
);
select is(
  pg_temp.staff_order_error(:'unknown_table', :'one_dish'::jsonb, 'p4170-table-3'),
  'NOT_FOUND', 'an unknown table is not found'
);
select is(
  pg_temp.staff_order_error(null, :'one_dish'::jsonb, 'p4170-table-4'),
  'NOT_FOUND', 'a table is required'
);
select tests.clear_auth();
select is(
  (select count(*) from public.table_sessions where dining_table_id = :'table11'),
  0::bigint,
  'the switched-off table gets no session'
);
select is(
  (select count(*) from public.orders where restaurant_id = :'rest_b'),
  1::bigint,
  'the other restaurant gets no orders'
);

-- ─── Read-only restaurants ──────────────────────────────────────────────────
select tests.authenticate_as(:'c_mgr');
select public.staff_place_order(
  :'c_table5', jsonb_build_array(tests.line(:'c_simple')), 'p4170-readonly-1'
) as c_r1 \gset
select tests.clear_auth();
select tests.suspend(:'rest_c');

select tests.authenticate_as(:'c_mgr');
select is(
  pg_temp.staff_order_error(:'c_table6', jsonb_build_array(tests.line(:'c_simple')), 'p4170-readonly-2'),
  'ORDERING_UNAVAILABLE', 'a read-only restaurant takes no staff order for a free table'
);
select is(
  pg_temp.staff_order_error(:'c_table5', jsonb_build_array(tests.line(:'c_simple')), 'p4170-readonly-3'),
  'ORDERING_UNAVAILABLE', 'nor new dishes for an open table'
);
select is(
  public.staff_place_order(:'c_table5', jsonb_build_array(tests.line(:'c_simple')), 'p4170-readonly-1'),
  jsonb_set(:'c_r1'::jsonb, '{replayed}', 'true'),
  'a retry of an order placed before the restaurant went read-only still returns it'
);
select tests.clear_auth();
select is(
  (select count(*) from public.table_sessions where dining_table_id = :'c_table6'),
  0::bigint,
  'no session is opened while read-only'
);
select is(
  (select count(*) from public.orders where restaurant_id = :'rest_c'),
  1::bigint,
  'and no round is added'
);

-- ─── Auto-assign (spec §10.7) ───────────────────────────────────────────────
-- Max tables per waiter is 1 (the default) until raised below.
select tests.authenticate_as(:'ravi');
select public.staff_place_order(:'table8', :'one_dish'::jsonb, 'p4170-ravi-1') as a1 \gset
select is(
  :'a1'::jsonb ->> 'assigned_waiter_id', :'w_ravi',
  'a waiter whose profile is on duty and free is assigned to the free table they order for'
);
select tests.clear_auth();
select :'a1'::jsonb ->> 'session_id' as session8 \gset
select results_eq(
  format(
    $f$ select assigned_waiter_id, assigned_by, assigned_at is not null
        from public.table_sessions where id = %L $f$,
    :'session8'
  ),
  format($f$ values (%L::uuid, %L::uuid, true) $f$, :'w_ravi', :'ravi'),
  'the session records the waiter, who assigned them and when'
);
select results_eq(
  format(
    $f$ select waiter_id, assigned_by, unassigned_at
        from public.session_waiter_assignments where session_id = %L $f$,
    :'session8'
  ),
  format($f$ values (%L::uuid, %L::uuid, null::timestamptz) $f$, :'w_ravi', :'ravi'),
  'an assignment history row is started, assigned by the caller'
);
select results_eq(
  format(
    $f$ select actor_type::text, actor_user_id, entity_type, after ->> 'waiter_id', after ->> 'table',
               (after ->> 'auto')::boolean
        from public.audit_logs where action = 'waiter.assigned' and entity_id = %L $f$,
    :'session8'
  ),
  format($f$ values ('staff', %L::uuid, 'table_session', %L, '8', true) $f$, :'ravi', :'w_ravi'),
  'the assignment is audit logged as waiter.assigned with auto = true'
);

select tests.authenticate_as(:'ravi');
select public.staff_place_order(:'table8', :'one_dish'::jsonb, 'p4170-ravi-2') as a2 \gset
select is((:'a2'::jsonb ->> 'round_number')::int, 2, 'the waiter''s second order at the table is round 2');
select is(:'a2'::jsonb ->> 'assigned_waiter_id', :'w_ravi', 'and the table keeps the same waiter');
select tests.clear_auth();
select is(
  (select count(*) from public.session_waiter_assignments where session_id = :'session8'),
  1::bigint,
  'without starting another assignment'
);
select is(
  (select count(*) from public.audit_logs where action = 'waiter.assigned' and entity_id = :'session8'),
  1::bigint,
  'or logging another one'
);

-- Busy: Ravi already handles table 8.
select tests.authenticate_as(:'ravi');
select public.staff_place_order(:'table9', :'one_dish'::jsonb, 'p4170-ravi-3') as a3 \gset
select is(:'a3'::jsonb ->> 'status', 'accepted', 'a busy waiter can still order for another table');
select is(
  :'a3'::jsonb -> 'assigned_waiter_id', 'null'::jsonb,
  'but a waiter at max_tables_per_waiter is not assigned to it'
);
select tests.clear_auth();
select :'a3'::jsonb ->> 'session_id' as session9 \gset
select is(
  (select assigned_waiter_id from public.table_sessions where id = :'session9'),
  null,
  'the table stays unassigned'
);
select is(
  (select count(*) from public.session_waiter_assignments where session_id = :'session9'),
  0::bigint,
  'with no assignment history'
);

-- Already assigned: Anita is free but table 8 is Ravi's.
select tests.authenticate_as(:'anita');
select public.staff_place_order(:'table8', :'one_dish'::jsonb, 'p4170-anita-1') as a4 \gset
select is(
  :'a4'::jsonb ->> 'assigned_waiter_id', :'w_ravi',
  'an order from another free waiter leaves the table with its waiter'
);
select tests.clear_auth();
select is(
  (select count(*) from public.session_waiter_assignments where waiter_id = :'w_anita'),
  0::bigint,
  'and the other waiter is not assigned'
);
select is(
  (select assigned_waiter_id from public.table_sessions where id = :'session8'),
  :'w_ravi'::uuid,
  'the session still names the first waiter'
);

-- Off duty.
select tests.authenticate_as(:'suresh');
select public.staff_place_order(:'table10', :'one_dish'::jsonb, 'p4170-suresh-1') as a5 \gset
select is(:'a5'::jsonb -> 'assigned_waiter_id', 'null'::jsonb, 'an off-duty waiter is not auto-assigned');
select tests.clear_auth();
select is(
  (select count(*) from public.table_sessions
    where dining_table_id = :'table10' and assigned_waiter_id is null),
  1::bigint,
  'the table stays unassigned'
);
select is(
  (select count(*) from public.session_waiter_assignments where waiter_id = :'w_suresh'),
  0::bigint,
  'with no assignment history for the off-duty waiter'
);

-- No linked profile (the waiter login from the approval section).
select is(:'r4'::jsonb -> 'assigned_waiter_id', 'null'::jsonb, 'a waiter login without a profile is not auto-assigned');
select is(
  (select count(*) from public.table_sessions where dining_table_id = :'table6' and assigned_waiter_id is null),
  1::bigint,
  'and that table stays unassigned'
);

-- A limit of 2: Ravi's next order at unassigned table 9 picks it up.
update public.restaurants set max_tables_per_waiter = 2 where id = :'rest_a';
select tests.authenticate_as(:'ravi');
select public.staff_place_order(:'table9', :'one_dish'::jsonb, 'p4170-ravi-4') as a6 \gset
select is(
  :'a6'::jsonb ->> 'assigned_waiter_id', :'w_ravi',
  'under a higher limit, the waiter is assigned an open unassigned table on their next order there'
);
select tests.clear_auth();
select results_eq(
  format(
    $f$ select s.assigned_waiter_id, (select count(*) from public.session_waiter_assignments a
                                       where a.session_id = s.id)
        from public.table_sessions s where s.id = %L $f$,
    :'session9'
  ),
  format($f$ values (%L::uuid, 1::bigint) $f$, :'w_ravi'),
  'the session and its history name the waiter'
);
select is(
  (select (after ->> 'auto')::boolean from public.audit_logs
    where action = 'waiter.assigned' and entity_id = :'session9'),
  true,
  'and the assignment is audit logged as automatic'
);

-- Billed tables don't count: Ravi now has only table 9 open.
select tests.bill_session(:'session8');
select tests.authenticate_as(:'ravi');
select public.staff_place_order(:'table8', :'one_dish'::jsonb, 'p4170-ravi-5') as a7 \gset
select isnt(:'a7'::jsonb ->> 'session_id', :'session8', 'after the bill, an order at the table opens a new session');
select is((:'a7'::jsonb ->> 'round_number')::int, 1, 'starting again at round 1');
select is(
  :'a7'::jsonb ->> 'assigned_waiter_id', :'w_ravi',
  'a billed table no longer counts towards the waiter''s limit'
);

select * from finish();

rollback;
