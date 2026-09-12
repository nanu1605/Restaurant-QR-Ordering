-- Customer menu lookup by QR token (spec §9.3 customer_get_table, §13.1).
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

select tests.create_restaurant('alpha') as rest_a \gset
select tests.create_restaurant('bravo') as rest_b \gset
select tests.create_ordering_fixture(:'rest_a', 'ALPHA0000TABLE05') as fx \gset
select tests.create_ordering_fixture(:'rest_b', 'BRAVO0000TABLE05') as fx_b \gset

-- ─── Who may call it ────────────────────────────────────────────────────────
select ok(
  has_function_privilege('service_role', 'public.customer_get_table(text)', 'execute'),
  'the server (service role) can read a table''s menu'
);
select ok(
  not has_function_privilege('authenticated', 'public.customer_get_table(text)', 'execute')
    and not has_function_privilege('anon', 'public.customer_get_table(text)', 'execute'),
  'signed-in users and anon cannot call customer functions directly'
);

-- ─── Menu contents ──────────────────────────────────────────────────────────
select tests.as_service_role();
select public.customer_get_table('ALPHA0000TABLE05') as menu \gset

select is(:'menu'::jsonb -> 'table' ->> 'label', '5', 'the table label is returned');
select is(:'menu'::jsonb -> 'restaurant' ->> 'name', 'Alpha', 'the restaurant name is returned');
select is(:'menu'::jsonb ->> 'access_state', 'full', 'a trialling restaurant can take orders');
select is(
  :'menu'::jsonb -> 'ordering',
  '{"require_first_order_approval": true, "cancel_window_seconds": 120}'::jsonb,
  'ordering settings are returned'
);
select is(:'menu'::jsonb -> 'session', 'null'::jsonb, 'no session summary while the table is free');

select results_eq(
  format($f$ select c ->> 'name' from jsonb_array_elements(%L::jsonb -> 'menu') c $f$, :'menu'),
  $$ values ('Starters') $$,
  'hidden and empty categories are left out'
);
select results_eq(
  format(
    $f$ select i ->> 'name', (i ->> 'is_available')::boolean
        from jsonb_array_elements(%L::jsonb -> 'menu' -> 0 -> 'items') i $f$,
    :'menu'
  ),
  $$ values ('Paneer Tikka', true), ('Butter Chicken', true), ('Malai Kofta', false) $$,
  'hidden dishes are left out; out-of-stock dishes are listed as unavailable, in menu order'
);
select results_eq(
  format(
    $f$ select v ->> 'name', (v ->> 'price_paise')::bigint
        from jsonb_array_elements(%L::jsonb -> 'menu' -> 0 -> 'items' -> 1 -> 'variants') v $f$,
    :'menu'
  ),
  $$ values ('Half', 28000::bigint), ('Full', 48000::bigint) $$,
  'only active options are listed, in order, with their prices'
);
select is(
  :'menu'::jsonb -> 'menu' -> 0 -> 'items' -> 0 -> 'variants',
  '[]'::jsonb,
  'a dish without options has an empty option list'
);
select ok(
  position(:'rest_a' in :'menu') = 0,
  'the restaurant id is not exposed to customers'
);

-- ─── Tokens that don't work ─────────────────────────────────────────────────
select throws_ok(
  $$ select public.customer_get_table('not-a-token') $$,
  'P0001', 'TABLE_NOT_FOUND',
  'a malformed token is rejected'
);
select throws_ok(
  $$ select public.customer_get_table('ZZZZZ0000TABLE05') $$,
  'P0001', 'TABLE_NOT_FOUND',
  'an unknown token is rejected'
);

select tests.clear_auth();
update public.dining_tables set is_active = false where qr_token = 'BRAVO0000TABLE05';
select tests.as_service_role();
select throws_ok(
  $$ select public.customer_get_table('BRAVO0000TABLE05') $$,
  'P0001', 'TABLE_NOT_FOUND',
  'a switched-off table no longer opens the menu'
);

select tests.clear_auth();
update public.dining_tables set is_active = true, qr_token = 'BRAVO0000TABLE99'
  where qr_token = 'BRAVO0000TABLE05';
select tests.as_service_role();
select throws_ok(
  $$ select public.customer_get_table('BRAVO0000TABLE05') $$,
  'P0001', 'TABLE_NOT_FOUND',
  'the old token stops working once the QR code is regenerated'
);
select lives_ok(
  $$ select public.customer_get_table('BRAVO0000TABLE99') $$,
  'the new token works'
);

-- ─── Read-only restaurants ──────────────────────────────────────────────────
select tests.clear_auth();
select tests.suspend(:'rest_b');
select tests.as_service_role();
select public.customer_get_table('BRAVO0000TABLE99') as menu_b \gset
select is(:'menu_b'::jsonb ->> 'access_state', 'read_only', 'a suspended restaurant is read-only');
select is(
  jsonb_array_length(:'menu_b'::jsonb -> 'menu'),
  1,
  'the menu can still be viewed while read-only'
);

-- ─── Session summary ────────────────────────────────────────────────────────
select public.customer_place_order(
  'ALPHA0000TABLE05', '11111111-1111-4111-8111-111111111111', 'summary-key-1',
  jsonb_build_array(tests.line((:'fx'::jsonb ->> 'simple')::uuid))
);
select is(
  public.customer_get_table('ALPHA0000TABLE05') -> 'session',
  '{"order_count": 1}'::jsonb,
  'an open session is summarised with its order count'
);

select * from finish();

rollback;
