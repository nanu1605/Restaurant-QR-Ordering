-- Customer order placement (spec §9.3 customer_place_order, §9.4 rate limits,
-- §10.1 sessions, §10.2 first-order approval).
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

select tests.create_restaurant('alpha') as rest_a \gset
select tests.create_restaurant('bravo') as rest_b \gset
select tests.create_restaurant('open') as rest_o \gset
update public.restaurants set require_first_order_approval = false where id = :'rest_o';

select tests.create_ordering_fixture(:'rest_a', 'ALPHA0000TABLE05') as fx \gset
select tests.create_ordering_fixture(:'rest_b', 'BRAVO0000TABLE05') as fx_b \gset
select tests.create_ordering_fixture(:'rest_o', 'OPENX0000TABLE05') as fx_o \gset

select
  :'fx'::jsonb ->> 'simple' as simple,
  :'fx'::jsonb ->> 'variant_item' as variant_item,
  :'fx'::jsonb ->> 'half' as half,
  :'fx'::jsonb ->> 'full' as full,
  :'fx'::jsonb ->> 'family' as family,
  :'fx'::jsonb ->> 'unavailable' as unavailable,
  :'fx'::jsonb ->> 'hidden_item' as hidden_item,
  :'fx'::jsonb ->> 'in_hidden_category' as in_hidden_category,
  :'fx_b'::jsonb ->> 'simple' as b_simple,
  :'fx_o'::jsonb ->> 'simple' as o_simple
\gset

insert into public.dining_tables (restaurant_id, label, qr_token)
values (:'rest_a', '6', 'ALPHA0000TABLE06'), (:'rest_a', '7', 'ALPHA0000TABLE07'),
       (:'rest_o', '6', 'OPENX0000TABLE06');
-- Table 8 is switched off; table 9's QR code has been regenerated (old token …09).
insert into public.dining_tables (restaurant_id, label, qr_token, is_active)
values (:'rest_a', '8', 'ALPHA0000TABLE08', false), (:'rest_a', '9', 'ALPHA0000TABLE19', true);

\set d1 '11111111-1111-4111-8111-111111111111'
\set d2 '22222222-2222-4222-8222-222222222222'
\set d3 '33333333-3333-4333-8333-333333333333'
\set d4 '44444444-4444-4444-8444-444444444444'
\set d5 '55555555-5555-4555-8555-555555555555'
\set d6 '66666666-6666-4666-8666-666666666666'

-- The error code plus DETAIL of a failed order, or 'no error'.
create function pg_temp.order_error(
  p_token text, p_device text, p_key text, p_items jsonb, p_note text default null
)
returns text
language plpgsql
as $$
declare
  v_detail text;
begin
  perform public.customer_place_order(p_token, p_device, p_key, p_items, p_note);
  return 'no error';
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  return sqlerrm || coalesce(' ' || nullif(v_detail, ''), '');
end;
$$;

-- p_count one-dish orders, each from a new device.
create function pg_temp.place_many(p_token text, p_item uuid, p_key_prefix text, p_count int)
returns void
language plpgsql
as $$
begin
  for i in 1..p_count loop
    perform public.customer_place_order(
      p_token, gen_random_uuid()::text, p_key_prefix || '-' || i, jsonb_build_array(tests.line(p_item))
    );
  end loop;
end;
$$;

-- ─── Who may call it ────────────────────────────────────────────────────────
select ok(
  has_function_privilege(
    'service_role', 'public.customer_place_order(text, text, text, jsonb, text, text)', 'execute'
  )
    and not has_function_privilege(
      'authenticated', 'public.customer_place_order(text, text, text, jsonb, text, text)', 'execute'
    ),
  'only the server can place customer orders'
);

-- ─── First order opens a session ────────────────────────────────────────────
select tests.as_service_role();
select public.customer_place_order(
  'ALPHA0000TABLE05', :'d1', 'alpha-order-1',
  jsonb_build_array(
    tests.line(:'simple', 2, null, '  less   spicy  '),
    tests.line(:'variant_item', 1, :'full')
  ),
  '  birthday  '
) as r1 \gset

select is(:'r1'::jsonb ->> 'status', 'pending_approval', 'the first order waits for staff approval');
select is((:'r1'::jsonb ->> 'round_number')::int, 1, 'the first order is round 1');
select is((:'r1'::jsonb ->> 'replayed')::boolean, false, 'a new order is not a replay');

select tests.clear_auth();
select results_eq(
  format(
    $f$ select status::text, is_approved, table_label_snapshot
        from public.table_sessions where restaurant_id = %L $f$,
    :'rest_a'
  ),
  $$ values ('open', false, '5') $$,
  'the first order opens an unapproved session with the table label'
);
select results_eq(
  format(
    $f$ select placed_via::text, client_device_id, customer_note, idempotency_key
        from public.orders where id = %L $f$,
    :'r1'::jsonb ->> 'order_id'
  ),
  format($f$ values ('customer', %L, 'birthday', 'alpha-order-1') $f$, :'d1'),
  'the order records the device, the tidied note and the key'
);
select results_eq(
  format(
    $f$ select item_name_snapshot, variant_name_snapshot, food_type_snapshot::text,
               unit_price_paise, quantity, note, status::text
        from public.order_items where order_id = %L order by item_name_snapshot $f$,
    :'r1'::jsonb ->> 'order_id'
  ),
  $$ values
    ('Butter Chicken', 'Full', 'non_veg', 48000::bigint, 1, null::text, 'placed'),
    ('Paneer Tikka', null::text, 'veg', 28000::bigint, 2, 'less spicy', 'placed') $$,
  'dishes are snapshotted from the menu (name, option, food type, price)'
);

-- ─── Later orders join the session ──────────────────────────────────────────
update public.menu_items set price_paise = 30000 where id = :'simple';

select tests.as_service_role();
select public.customer_place_order(
  'ALPHA0000TABLE05', :'d2', 'alpha-order-2', jsonb_build_array(tests.line(:'simple'))
) as r2 \gset
select is((:'r2'::jsonb ->> 'round_number')::int, 2, 'a second device adds round 2');
select is(
  :'r2'::jsonb ->> 'status', 'pending_approval',
  'orders stay pending while the session is unapproved'
);

select tests.clear_auth();
select is(
  (select count(*) from public.table_sessions where restaurant_id = :'rest_a' and status = 'open'),
  1::bigint,
  'the second device joins the open session'
);
select is(
  (select unit_price_paise from public.order_items where order_id = (:'r2'::jsonb ->> 'order_id')::uuid),
  30000::bigint,
  'a new order takes the current price'
);
select is(
  (select unit_price_paise from public.order_items
    where order_id = (:'r1'::jsonb ->> 'order_id')::uuid and variant_id is null),
  28000::bigint,
  'earlier orders keep the price they were placed at'
);

-- Staff approve the session (Phase 4 does this through staff_approve_order).
update public.table_sessions set is_approved = true, approved_at = now()
  where restaurant_id = :'rest_a' and status = 'open';

select tests.as_service_role();
select is(
  public.customer_place_order(
    'ALPHA0000TABLE05', :'d1', 'alpha-order-3', jsonb_build_array(tests.line(:'simple'))
  ) ->> 'status',
  'accepted',
  'once the session is approved, later orders are accepted straight away'
);

-- ─── Idempotency ────────────────────────────────────────────────────────────
select tests.clear_auth();
update public.menu_items set is_available = false where id = :'simple';
select tests.as_service_role();

select is(
  public.customer_place_order(
    'ALPHA0000TABLE05', :'d1', 'alpha-order-1', jsonb_build_array(tests.line(:'simple'))
  ),
  jsonb_set(:'r1'::jsonb, '{replayed}', 'true'),
  'resending the same key returns the original order, even after the menu changed'
);
select is(
  (select count(*) from public.orders where restaurant_id = :'rest_a'),
  3::bigint,
  'a replay creates no new order'
);
select is(
  pg_temp.order_error(
    'ALPHA0000TABLE05', :'d2', 'alpha-order-1', jsonb_build_array(tests.line(:'variant_item', 1, :'half'))
  ),
  'INVALID_INPUT idempotency_key',
  'another device cannot reuse the key'
);
select is(
  pg_temp.order_error(
    'ALPHA0000TABLE06', :'d1', 'alpha-order-1', jsonb_build_array(tests.line(:'variant_item', 1, :'half'))
  ),
  'INVALID_INPUT idempotency_key',
  'the key cannot be reused at another table'
);

select tests.clear_auth();
update public.menu_items set is_available = true where id = :'simple';
select tests.as_service_role();

-- ─── Input checks ───────────────────────────────────────────────────────────
select is(
  pg_temp.order_error('ALPHA0000TABLE05', :'d1', 'bad-input-1', '[]'::jsonb),
  'INVALID_INPUT items', 'an empty order is rejected'
);
select is(
  pg_temp.order_error('ALPHA0000TABLE05', :'d1', 'bad-input-2', '{}'::jsonb),
  'INVALID_INPUT items', 'items must be an array'
);
select is(
  pg_temp.order_error(
    'ALPHA0000TABLE05', :'d1', 'bad-input-3',
    (select jsonb_agg(tests.line(:'simple')) from generate_series(1, 31))
  ),
  'INVALID_INPUT items', 'at most 30 lines per order'
);
select is(
  pg_temp.order_error('ALPHA0000TABLE05', :'d1', 'bad-input-4', jsonb_build_array(tests.line(:'simple', 0))),
  'INVALID_INPUT quantity', 'quantity starts at 1'
);
select is(
  pg_temp.order_error('ALPHA0000TABLE05', :'d1', 'bad-input-5', jsonb_build_array(tests.line(:'simple', 21))),
  'INVALID_INPUT quantity', 'quantity stops at 20'
);
select is(
  pg_temp.order_error(
    'ALPHA0000TABLE05', :'d1', 'bad-input-6',
    jsonb_build_array(jsonb_build_object('menu_item_id', :'simple', 'quantity', 1.5))
  ),
  'INVALID_INPUT quantity', 'quantity is a whole number'
);
select is(
  pg_temp.order_error(
    'ALPHA0000TABLE05', :'d1', 'bad-input-7',
    jsonb_build_array(tests.line(:'simple', 1, null, repeat('x', 121)))
  ),
  'INVALID_INPUT note', 'a dish note is at most 120 characters'
);
select is(
  pg_temp.order_error(
    'ALPHA0000TABLE05', :'d1', 'bad-input-8', jsonb_build_array(tests.line(:'simple')), repeat('x', 201)
  ),
  'INVALID_INPUT note', 'the order note is at most 200 characters'
);
select is(
  pg_temp.order_error(
    'ALPHA0000TABLE05', :'d1', 'bad-input-9',
    jsonb_build_array(tests.line(:'simple') || '{"unit_price_paise": 1}')
  ),
  'INVALID_INPUT unit_price_paise', 'a price sent by the client is rejected, not used'
);
select is(
  pg_temp.order_error('ALPHA0000TABLE05', 'not-a-device', 'bad-input-10', jsonb_build_array(tests.line(:'simple'))),
  'INVALID_INPUT device_id', 'the device id must be a uuid'
);
select is(
  pg_temp.order_error('ALPHA0000TABLE05', :'d1', 'short', jsonb_build_array(tests.line(:'simple'))),
  'INVALID_INPUT idempotency_key', 'the idempotency key must be 8–100 safe characters'
);
select is(
  pg_temp.order_error('ZZZZZ0000TABLE05', :'d1', 'bad-input-11', jsonb_build_array(tests.line(:'simple'))),
  'TABLE_NOT_FOUND', 'an unknown table token is rejected'
);
select is(
  pg_temp.order_error('ALPHA0000TABLE08', :'d1', 'table-off-1', jsonb_build_array(tests.line(:'simple'))),
  'TABLE_NOT_FOUND', 'a switched-off table takes no orders'
);
select is(
  pg_temp.order_error('ALPHA0000TABLE09', :'d1', 'table-old-qr', jsonb_build_array(tests.line(:'simple'))),
  'TABLE_NOT_FOUND', 'the old QR token of a regenerated table takes no orders'
);
select is(
  (select count(*) from public.table_sessions s join public.dining_tables t on t.id = s.dining_table_id
    where t.qr_token in ('ALPHA0000TABLE08', 'ALPHA0000TABLE19')),
  0::bigint,
  'and neither opens a session'
);

-- ─── Dishes that can't be ordered ───────────────────────────────────────────
select is(
  pg_temp.order_error('ALPHA0000TABLE05', :'d1', 'unavail-1', jsonb_build_array(tests.line(:'unavailable'))),
  'ITEM_UNAVAILABLE ' || :'unavailable', 'an out-of-stock dish is rejected and named'
);
select is(
  pg_temp.order_error('ALPHA0000TABLE05', :'d1', 'unavail-2', jsonb_build_array(tests.line(:'hidden_item'))),
  'ITEM_UNAVAILABLE ' || :'hidden_item', 'a hidden dish is rejected'
);
select is(
  pg_temp.order_error(
    'ALPHA0000TABLE05', :'d1', 'unavail-3', jsonb_build_array(tests.line(:'in_hidden_category'))
  ),
  'ITEM_UNAVAILABLE ' || :'in_hidden_category', 'a dish in a hidden category is rejected'
);
select is(
  pg_temp.order_error('ALPHA0000TABLE05', :'d1', 'unavail-4', jsonb_build_array(tests.line(:'b_simple'))),
  'ITEM_UNAVAILABLE ' || :'b_simple', 'another restaurant''s dish is rejected like any unknown dish'
);
select is(
  pg_temp.order_error('ALPHA0000TABLE05', :'d1', 'unavail-5', jsonb_build_array(tests.line(:'variant_item'))),
  'ITEM_UNAVAILABLE ' || :'variant_item', 'a dish with options needs one'
);
select is(
  pg_temp.order_error(
    'ALPHA0000TABLE05', :'d1', 'unavail-6', jsonb_build_array(tests.line(:'variant_item', 1, :'family'))
  ),
  'ITEM_UNAVAILABLE ' || :'variant_item', 'a removed option is rejected'
);
select is(
  pg_temp.order_error(
    'ALPHA0000TABLE05', :'d1', 'unavail-7', jsonb_build_array(tests.line(:'simple', 1, :'half'))
  ),
  'ITEM_UNAVAILABLE ' || :'simple', 'an option belonging to another dish is rejected'
);
select is(
  pg_temp.order_error(
    'ALPHA0000TABLE05', :'d1', 'unavail-8',
    jsonb_build_array(tests.line(:'simple'), tests.line(:'unavailable'), tests.line(:'hidden_item'))
  ),
  'ITEM_UNAVAILABLE ' || (
    select string_agg(id::text, ',' order by id::text)
    from unnest(array[:'unavailable', :'hidden_item']::uuid[]) as id
  ),
  'every unavailable dish is named, and nothing is ordered'
);

-- ─── Approval switched off ──────────────────────────────────────────────────
select public.customer_place_order(
  'OPENX0000TABLE05', :'d1', 'open-order-1', jsonb_build_array(tests.line(:'o_simple'))
) as o1 \gset
select is(:'o1'::jsonb ->> 'status', 'accepted', 'without first-order approval, orders are accepted');
select tests.clear_auth();
select is(
  (select is_approved from public.table_sessions where restaurant_id = :'rest_o' and status = 'open'),
  true,
  'and the session starts approved'
);
select tests.as_service_role();

-- ─── Rate limits ────────────────────────────────────────────────────────────
-- Per device: 5 a minute, across restaurants (d1 has already ordered 3 times).
select is(
  pg_temp.order_error('OPENX0000TABLE05', :'d1', 'minute-d1', jsonb_build_array(tests.line(:'o_simple'))),
  'no error', 'a 4th order from the same phone is fine'
);
select lives_ok(
  format(
    $f$ select public.customer_place_order('OPENX0000TABLE05', %L, 'minute-' || g, %L::jsonb)
        from generate_series(1, 5) g $f$,
    :'d3', jsonb_build_array(tests.line(:'o_simple'))
  ),
  'a device can place 5 orders in a minute'
);
select is(
  pg_temp.order_error('OPENX0000TABLE05', :'d3', 'minute-6', jsonb_build_array(tests.line(:'o_simple'))),
  'RATE_LIMITED', 'the 6th order within a minute is refused'
);
select is(
  pg_temp.order_error('OPENX0000TABLE05', :'d1', 'minute-d1-2', jsonb_build_array(tests.line(:'o_simple'))),
  'no error', 'the 5th order from another phone is still fine'
);
select is(
  pg_temp.order_error('ALPHA0000TABLE05', :'d1', 'minute-d1-3', jsonb_build_array(tests.line(:'simple'))),
  'RATE_LIMITED', 'the limit follows the phone across restaurants (2 orders here, 3 there)'
);

-- Per device: 30 an hour.
select tests.clear_auth();
insert into public.orders (
  restaurant_id, session_id, round_number, status, placed_via, client_device_id, idempotency_key, created_at
)
select :'rest_o', s.id, 1000 + g, 'accepted', 'customer', :'d4', 'history-' || g,
       now() - interval '30 minutes'
from public.table_sessions s, generate_series(1, 29) g
where s.restaurant_id = :'rest_o' and s.status = 'open';
select tests.as_service_role();
select is(
  pg_temp.order_error('OPENX0000TABLE05', :'d4', 'hourly-order-1', jsonb_build_array(tests.line(:'o_simple'))),
  'no error', 'the 30th order within an hour is still accepted'
);
select is(
  pg_temp.order_error('OPENX0000TABLE05', :'d4', 'hourly-order-2', jsonb_build_array(tests.line(:'o_simple'))),
  'RATE_LIMITED', 'the 31st order within an hour is refused'
);

-- Per table: 10 every 10 minutes, whatever the device.
select pg_temp.place_many('OPENX0000TABLE06', :'o_simple', 'table-six', 10);
select is(
  pg_temp.order_error('OPENX0000TABLE06', :'d5', 'table-six-11', jsonb_build_array(tests.line(:'o_simple'))),
  'RATE_LIMITED', 'the 11th order at one table within 10 minutes is refused'
);

-- Per table: 3 orders waiting for approval at once.
select public.customer_place_order(
  'ALPHA0000TABLE07', :'d5', 'pending-1', jsonb_build_array(tests.line(:'simple'))
) as p1 \gset
select pg_temp.place_many('ALPHA0000TABLE07', :'simple', 'pending-more', 2);
select is(
  pg_temp.order_error('ALPHA0000TABLE07', :'d6', 'pending-4', jsonb_build_array(tests.line(:'simple'))),
  'RATE_LIMITED', 'a 4th order waiting for approval is refused'
);
select lives_ok(
  format(
    $f$ select public.customer_cancel_item('ALPHA0000TABLE07', %L, oi.id)
        from public.order_items oi where oi.order_id = %L $f$,
    :'d5', :'p1'::jsonb ->> 'order_id'
  ),
  'the customer cancels every dish of one waiting order'
);
select is(
  pg_temp.order_error('ALPHA0000TABLE07', :'d6', 'pending-5', jsonb_build_array(tests.line(:'simple'))),
  'no error', 'a waiting order with nothing left in it no longer counts'
);

-- ─── Approval switched off mid-session ──────────────────────────────────────
-- Table 7's session is still unapproved and holds 3 waiting orders.
select is(
  pg_temp.order_error('ALPHA0000TABLE07', :'d2', 'before-switch', jsonb_build_array(tests.line(:'simple'))),
  'RATE_LIMITED', 'with approval on, the table is full of waiting orders'
);
select tests.clear_auth();
update public.restaurants set require_first_order_approval = false where id = :'rest_a';
select tests.as_service_role();
select is(
  public.customer_place_order(
    'ALPHA0000TABLE07', :'d2', 'after-switch-1', jsonb_build_array(tests.line(:'simple'))
  ) ->> 'status',
  'accepted',
  'once approval is switched off, the next order is accepted despite the waiting ones'
);
select tests.clear_auth();
select results_eq(
  $$ select s.is_approved, s.approved_at is not null
     from public.table_sessions s join public.dining_tables t on t.id = s.dining_table_id
     where t.qr_token = 'ALPHA0000TABLE07' and s.status = 'open' $$,
  $$ values (true, true) $$,
  'and the waiting session counts as approved from then on'
);
select is(
  (select count(*) from public.orders o
     join public.table_sessions s on s.id = o.session_id
     join public.dining_tables t on t.id = s.dining_table_id
   where t.qr_token = 'ALPHA0000TABLE07' and o.status = 'pending_approval'),
  4::bigint,
  'rounds already waiting stay with staff to decide'
);
select tests.as_service_role();

-- ─── Read-only restaurants ──────────────────────────────────────────────────
select tests.clear_auth();
select tests.suspend(:'rest_b');
select tests.as_service_role();
select is(
  pg_temp.order_error('BRAVO0000TABLE05', :'d1', 'read-only-1', jsonb_build_array(tests.line(:'b_simple'))),
  'ORDERING_UNAVAILABLE', 'a read-only restaurant takes no online orders'
);
select tests.clear_auth();
select is(
  (select count(*) from public.table_sessions where restaurant_id = :'rest_b'),
  0::bigint,
  'and no session is opened'
);

select * from finish();

rollback;
