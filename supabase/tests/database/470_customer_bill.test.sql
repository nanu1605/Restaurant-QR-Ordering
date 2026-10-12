-- Guests see their bill on the orders page (spec §9.2, §9.3 customer_get_session, §13.1
-- Orders page; docs/DECISIONS.md P11-1…P11-3).
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ─── Fixtures ───────────────────────────────────────────────────────────────
select tests.create_restaurant('p11a-bill') as rest_a \gset
select tests.add_member(:'rest_a', 'manager', 'a_manager') as a_manager \gset
select tests.add_waiter(:'rest_a', 'Ravi') as w_ravi \gset
select tests.create_ordering_fixture(:'rest_a', 'P11A00000TABLE05') as fx \gset
select :'fx'::jsonb ->> 'simple' as simple \gset
update public.restaurants
set reopen_window_minutes = 30, show_upi_qr_on_bill = true, upi_vpa = 'p11a@okicici'
where id = :'rest_a';

\set d1 '11111111-1111-4111-8111-111111111111'
\set d2 '22222222-2222-4222-8222-222222222222'
\set d3 '33333333-3333-4333-8333-333333333333'

-- The phone's view of the table.
create function pg_temp.view_of(p_device text)
returns jsonb
language sql
as $$
  select public.customer_get_session('P11A00000TABLE05', p_device);
$$;

-- Accepts and serves what is still waiting at the table, so it can be billed.
create function pg_temp.serve_all()
returns void
language sql
as $$
  update public.orders set status = 'accepted' where status = 'pending_approval' and session_id in (
    select id from public.table_sessions where dining_table_id = (
      select id from public.dining_tables where qr_token = 'P11A00000TABLE05'
    ) and status = 'open'
  );
  update public.order_items set status = 'served' where status = 'placed' and session_id in (
    select id from public.table_sessions where dining_table_id = (
      select id from public.dining_tables where qr_token = 'P11A00000TABLE05'
    ) and status = 'open'
  );
$$;

-- Phone 1 orders. Phone 2, the next party's, orders into the still-open session and staff
-- reject it. Phone 3 only looks.
select tests.as_service_role();
select public.customer_place_order(
  'P11A00000TABLE05', :'d1', 'bill-order-1', jsonb_build_array(tests.line(:'simple', 2))
);
select public.customer_place_order(
  'P11A00000TABLE05', :'d2', 'bill-order-d2', jsonb_build_array(tests.line(:'simple'))
) as r_d2 \gset
select is(pg_temp.view_of(:'d1') -> 'bill', 'null'::jsonb, 'no bill while the table is open');

select tests.clear_auth();
update public.orders set status = 'rejected', reject_reason = 'Not this table'
  where id = (:'r_d2'::jsonb ->> 'order_id')::uuid;
update public.order_items set status = 'cancelled'
  where order_id = (:'r_d2'::jsonb ->> 'order_id')::uuid;
select pg_temp.serve_all();
select isnt(
  (select private.bill_print_settings(r) -> 'upi' from public.restaurants r where r.id = :'rest_a'),
  'null'::jsonb,
  'the printed bill has a UPI QR'
);
select id as s1 from public.table_sessions where restaurant_id = :'rest_a' and status = 'open' \gset
-- now() is fixed inside this test's transaction; space the sessions out as real time would.
update public.table_sessions set opened_at = now() - interval '3 hours' where id = :'s1';

select tests.authenticate_as(:'a_manager');
select public.admin_assign_waiter(:'s1', :'w_ravi');
select public.admin_generate_bill(:'s1', 'percent', 1000, 'Regular guest', false) ->> 'bill_id' as bill1 \gset
select public.admin_increment_print_count(:'bill1');
select invoice_number as inv1 from public.bills where id = :'bill1' \gset

-- ─── The phone that ordered sees the customer copy ──────────────────────────
select tests.as_service_role();
select pg_temp.view_of(:'d1') as v1 \gset
select is(:'v1'::jsonb -> 'bill' -> 'bill' ->> 'invoice_number', :'inv1', 'the phone that ordered gets its bill');
select is(:'v1'::jsonb -> 'bill' -> 'bill' ->> 'payment_status', 'unpaid', 'not paid yet');
select is(
  (:'v1'::jsonb -> 'bill' -> 'bill' ->> 'discount_paise')::bigint > 0, true,
  'the discount is on it'
);
select ok(
  (:'v1'::jsonb -> 'bill' -> 'bill' -> 'id') = 'null'::jsonb
    and (:'v1'::jsonb -> 'bill' -> 'bill' -> 'generated_by_name') = 'null'::jsonb
    and (:'v1'::jsonb -> 'bill' -> 'bill' -> 'discount_reason') = 'null'::jsonb
    and (:'v1'::jsonb -> 'bill' -> 'bill' ->> 'print_count')::int = 0
    and not (:'v1'::jsonb -> 'bill' -> 'bill') ? 'session_id',
  'no bill id, who generated it, discount reason or print count reach the guest'
);
select is(
  (select print_count from public.bills where id = :'bill1'), 1, 'the bill was printed once'
);
select is(:'v1'::jsonb -> 'bill' -> 'print' -> 'upi', 'null'::jsonb, 'no UPI QR on the guest''s screen');
select pg_temp.view_of(:'d2') as v_d2 \gset
select is(:'v_d2'::jsonb -> 'bill', 'null'::jsonb, 'a phone whose order was rejected gets no bill');
select is(
  (:'v_d2'::jsonb ->> 'last_session_billed')::boolean, true,
  'it only learns the session was billed'
);
select is(pg_temp.view_of(:'d3') -> 'bill', 'null'::jsonb, 'a phone that never ordered gets no bill');
select is(pg_temp.view_of(null) -> 'bill', 'null'::jsonb, 'nor does a request without a phone');

-- The next party sits down and orders: their phone sees its own round, not the bill.
select public.customer_place_order(
  'P11A00000TABLE05', :'d3', 'bill-order-d3', jsonb_build_array(tests.line(:'simple'))
);
select pg_temp.view_of(:'d3') as v_d3 \gset
select is(:'v_d3'::jsonb -> 'bill', 'null'::jsonb, 'the next party gets no bill');
select is(
  jsonb_array_length(:'v_d3'::jsonb -> 'session' -> 'rounds'), 1, 'only their own round shows'
);
select is(
  pg_temp.view_of(:'d1') -> 'bill' -> 'bill' ->> 'invoice_number', :'inv1',
  'the previous party''s phone still has its bill'
);

-- ─── Paid, and after the hour ───────────────────────────────────────────────
select tests.authenticate_as(:'a_manager');
select public.admin_record_payment(
  :'bill1', jsonb_build_array(jsonb_build_object(
    'mode', 'cash',
    'amount_paise', (select grand_total_paise from public.bills where id = :'bill1')
  ))
);
select tests.as_service_role();
select is(pg_temp.view_of(:'d1') -> 'bill' -> 'bill' ->> 'payment_status', 'paid', 'the bill shows paid');

select tests.clear_auth();
update public.table_sessions set billed_at = now() - interval '61 minutes' where id = :'s1';
select tests.as_service_role();
select is(pg_temp.view_of(:'d1') -> 'bill', 'null'::jsonb, 'the bill goes after an hour');
select tests.clear_auth();
update public.table_sessions set billed_at = now() where id = :'s1';

-- ─── Voided ─────────────────────────────────────────────────────────────────
select tests.authenticate_as(:'a_manager');
select public.admin_void_bill(:'bill1', 'Wrong dishes', false);
select tests.as_service_role();
select pg_temp.view_of(:'d1') as v2 \gset
select is(:'v2'::jsonb -> 'bill', 'null'::jsonb, 'a voided bill is not shown');
select is((:'v2'::jsonb ->> 'last_session_billed')::boolean, true, 'the bill message still shows');

-- A void that reopens the table shows the rounds again, without a bill.
select public.customer_place_order(
  'P11A00000TABLE05', :'d1', 'bill-order-2', jsonb_build_array(tests.line(:'simple'))
);
select tests.clear_auth();
select pg_temp.serve_all();
select id as s2 from public.table_sessions where restaurant_id = :'rest_a' and status = 'open' \gset
update public.table_sessions set opened_at = now() - interval '2 hours' where id = :'s2';
select tests.authenticate_as(:'a_manager');
select public.admin_assign_waiter(:'s2', :'w_ravi');
select public.admin_generate_bill(:'s2', 'none', 0, null, false) ->> 'bill_id' as bill2 \gset
select tests.as_service_role();
select isnt(pg_temp.view_of(:'d1') -> 'bill', 'null'::jsonb, 'the next bill shows');

select tests.authenticate_as(:'a_manager');
select public.admin_void_bill(:'bill2', 'Guests ordered dessert', true);
select tests.as_service_role();
select pg_temp.view_of(:'d1') as v3 \gset
select is(:'v3'::jsonb -> 'bill', 'null'::jsonb, 'a void that reopens the table hides the bill');
select isnt(:'v3'::jsonb -> 'session', 'null'::jsonb, 'and the rounds show again');

-- ─── The phone orders again ─────────────────────────────────────────────────
select tests.authenticate_as(:'a_manager');
select public.admin_generate_bill(:'s2', 'none', 0, null, false);
select tests.as_service_role();
select isnt(pg_temp.view_of(:'d1') -> 'bill', 'null'::jsonb, 'billed again');
select public.customer_place_order(
  'P11A00000TABLE05', :'d1', 'bill-order-3', jsonb_build_array(tests.line(:'simple'))
);
select is(pg_temp.view_of(:'d1') -> 'bill', 'null'::jsonb, 'a new order hides the previous party''s bill');

select * from finish();

rollback;
