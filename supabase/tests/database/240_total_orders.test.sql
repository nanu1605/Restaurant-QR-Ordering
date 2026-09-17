-- Total orders (spec §13.3): summary strip, filters, business-day ranges
-- (§17 Time: 3:59 am belongs to the previous business day), void bills,
-- tables closed without a bill, paging (docs/DECISIONS.md P5-12).
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ─── Fixtures ───────────────────────────────────────────────────────────────
select tests.create_restaurant('p5-240-a') as rest_a \gset
select tests.create_restaurant('p5-240-b') as rest_b \gset
select tests.add_member(:'rest_a', 'manager', 'a_manager') as a_manager \gset
select tests.add_member(:'rest_a', 'waiter', 'a_waiter') as a_waiter \gset
select tests.add_waiter(:'rest_a', 'Ravi') as w_ravi \gset
select tests.add_waiter(:'rest_a', 'Anita') as w_anita \gset
select tests.add_waiter(:'rest_b', 'Bobby') as w_bobby \gset

insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
values
  (:'rest_a', '5', 'P5240A0000TABLE5', 5),
  (:'rest_a', '6', 'P5240A0000TABLE6', 6),
  (:'rest_b', '5', 'P5240B0000TABLE5', 5);
select
  (select id from public.dining_tables where qr_token = 'P5240A0000TABLE5') as table5,
  (select id from public.dining_tables where qr_token = 'P5240A0000TABLE6') as table6,
  (select id from public.dining_tables where qr_token = 'P5240B0000TABLE5') as b_table5
\gset

update public.restaurants set timezone = 'Asia/Kolkata', business_day_start_hour = 4
where id in (:'rest_a', :'rest_b');

-- A billed session with one bill. Times are Indian Standard Time. Returns the bill id.
create function pg_temp.bill(
  p_table uuid,
  p_waiter uuid,
  p_generated_at timestamptz,
  p_seq int,
  p_subtotal bigint,
  p_discount bigint,
  p_tax bigint,
  p_qty int,
  p_status public.bill_status default 'active',
  p_paid boolean default false
)
returns uuid
language plpgsql
as $$
declare
  v_table public.dining_tables;
  v_session uuid;
  v_bill uuid;
begin
  select * into v_table from public.dining_tables where id = p_table;
  insert into public.table_sessions (
    restaurant_id, dining_table_id, table_label_snapshot, status, is_approved,
    opened_at, billed_at, assigned_waiter_id
  )
  values (
    v_table.restaurant_id, v_table.id, v_table.label, 'billed', true,
    p_generated_at - interval '75 minutes', p_generated_at, p_waiter
  )
  returning id into v_session;
  insert into public.orders (restaurant_id, session_id, round_number, status, placed_via, idempotency_key)
  values
    (v_table.restaurant_id, v_session, 1, 'accepted', 'staff', gen_random_uuid()::text),
    (v_table.restaurant_id, v_session, 2, 'accepted', 'staff', gen_random_uuid()::text),
    (v_table.restaurant_id, v_session, 3, 'rejected', 'customer', gen_random_uuid()::text);

  insert into public.bills (
    restaurant_id, session_id, invoice_number, financial_year, invoice_seq, document_type,
    table_label_snapshot, waiter_id, waiter_name_snapshot, line_items, restaurant_snapshot,
    gst_mode, gst_rate_bps, prices_include_tax, subtotal_paise, discount_type, discount_value,
    discount_paise, discount_reason, taxable_paise, cgst_paise, sgst_paise, total_tax_paise,
    grand_total_paise, payment_status, status, generated_by, generated_at, paid_at,
    void_reason, voided_at
  )
  values (
    v_table.restaurant_id, v_session, 'INV/2026-27/' || lpad(p_seq::text, 5, '0'), '2026-27', p_seq,
    'tax_invoice', v_table.label, p_waiter, (select full_name from public.waiters where id = p_waiter),
    jsonb_build_array(
      jsonb_build_object('name', 'Paneer Tikka', 'variant', null, 'qty', p_qty, 'unit_price_paise', 1, 'line_total_paise', 1, 'food_type', 'veg'),
      jsonb_build_object('name', 'Butter Naan', 'variant', null, 'qty', 1, 'unit_price_paise', 1, 'line_total_paise', 1, 'food_type', 'veg')
    ),
    '{}'::jsonb, 'regular', 500, false, p_subtotal, 'flat', p_discount, p_discount,
    case when p_discount > 0 then 'Regular' end,
    p_subtotal - p_discount, p_tax / 2, p_tax - p_tax / 2, p_tax,
    p_subtotal - p_discount + p_tax,
    case when p_paid then 'paid' else 'unpaid' end::public.payment_status, p_status,
    (select user_id from public.restaurant_members where restaurant_id = v_table.restaurant_id and role = 'manager' limit 1),
    p_generated_at,
    case when p_paid then p_generated_at + interval '5 minutes' end,
    case when p_status = 'void' then 'Wrong table' end,
    case when p_status = 'void' then p_generated_at + interval '10 minutes' end
  )
  returning id into v_bill;

  if p_paid then
    insert into public.bill_payments (restaurant_id, bill_id, mode, amount_paise, is_void)
    select v_table.restaurant_id, v_bill,
           case when p_status = 'void' then 'upi' else 'cash' end::public.payment_mode,
           p_subtotal - p_discount + p_tax, p_status = 'void';
  end if;
  return v_bill;
end;
$$;

create function pg_temp.orders(p_filters jsonb)
returns jsonb
language sql
as $$
  select public.admin_total_orders(p_filters);
$$;

create function pg_temp.invoices(p_filters jsonb)
returns jsonb
language sql
as $$
  select coalesce(jsonb_agg(r -> 'invoice_number'), '[]'::jsonb)
  from jsonb_array_elements(public.admin_total_orders(p_filters) -> 'rows') as r;
$$;

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

-- Business day 10 September: bills 1 (noon, paid cash), 2 (3:59 am on the
-- 11th, unpaid) and 4 (8 pm, paid by UPI then voided). Bill 3 opens the 11th
-- at 4:00 am; bill 5 is on the 9th. Restaurant B has a bill on the 10th too.
select pg_temp.bill(:'table5', :'w_ravi', '2026-09-10 12:00+05:30', 1, 50000, 5000, 2250, 3, 'active', true) as bill1 \gset
select pg_temp.bill(:'table6', :'w_anita', '2026-09-11 03:59+05:30', 2, 30000, 0, 1500, 2) as bill2 \gset
select pg_temp.bill(:'table5', :'w_ravi', '2026-09-11 04:00+05:30', 3, 20000, 0, 1000, 1, 'active', true) as bill3 \gset
select pg_temp.bill(:'table5', :'w_ravi', '2026-09-10 20:00+05:30', 4, 40000, 0, 2000, 4, 'void', true) as bill4 \gset
select pg_temp.bill(:'table6', :'w_anita', '2026-09-09 23:00+05:30', 5, 10000, 0, 500, 1) as bill5 \gset
select pg_temp.bill(:'b_table5', :'w_bobby', '2026-09-10 13:00+05:30', 1, 99900, 0, 0, 9, 'active', true);

insert into public.table_sessions (
  restaurant_id, dining_table_id, table_label_snapshot, status, opened_at, closed_at, closed_by,
  close_reason, assigned_waiter_id
)
values
  (:'rest_a', :'table6', '6', 'closed_unbilled', '2026-09-10 14:00+05:30', '2026-09-10 15:00+05:30', :'a_manager', 'Walked out', :'w_anita'),
  (:'rest_a', :'table5', '5', 'closed_unbilled', '2026-09-11 05:00+05:30', '2026-09-11 05:30+05:30', :'a_manager', 'Prank', null),
  (:'rest_b', :'b_table5', '5', 'closed_unbilled', '2026-09-10 14:00+05:30', '2026-09-10 15:00+05:30', null, 'Other', null);

-- ─── Roles ──────────────────────────────────────────────────────────────────
select tests.authenticate_as(:'a_waiter');
select throws_ok($$ select public.admin_total_orders('{}') $$, 'P0001', 'FORBIDDEN', 'waiters cannot see total orders');

-- ─── One business day ───────────────────────────────────────────────────────
select tests.authenticate_as(:'a_manager');
select pg_temp.orders('{"from": "2026-09-10", "to": "2026-09-10"}') as day \gset

select is(
  :'day'::jsonb -> 'summary',
  jsonb_build_object(
    'bills', 2, 'orders', 4, 'items', 7, 'gross_paise', 80000, 'discount_paise', 5000,
    'tax_paise', 3750, 'total_paise', 78750, 'collected_paise', 47250, 'unpaid_bills', 1,
    'void_bills', 1, 'closed_unbilled', 1
  ),
  'the summary counts active bills of the business day (3:59 am the next morning included), never void ones'
);
select is(
  pg_temp.invoices('{"from": "2026-09-10", "to": "2026-09-10"}'),
  '["INV/2026-27/00002", "INV/2026-27/00004", "INV/2026-27/00001"]'::jsonb,
  'bills are listed newest first, void ones included by default'
);
select is(
  (select jsonb_build_array(r -> 'status', r -> 'payment_status', r -> 'table_label', r -> 'waiter_name',
                            r -> 'minutes', r -> 'items', r -> 'grand_total_paise', r -> 'modes', r -> 'generated_by_name')
   from jsonb_array_elements(:'day'::jsonb -> 'rows') as r
   where r ->> 'invoice_number' = 'INV/2026-27/00004'),
  '["void", "paid", "5", "Ravi", 75, 5, 42000, ["upi"], "A_manager"]'::jsonb,
  'a row has the table, waiter, duration, items, total, payment modes and who billed it'
);
select is(
  jsonb_build_array(:'day'::jsonb -> 'from', :'day'::jsonb -> 'to', :'day'::jsonb -> 'total', :'day'::jsonb -> 'page_size'),
  '["2026-09-10", "2026-09-10", 3, 50]'::jsonb,
  'the resolved range, row count and page size come back'
);
select is(
  (select jsonb_agg(t -> 'label') from jsonb_array_elements(:'day'::jsonb -> 'tables') as t),
  '["5", "6"]'::jsonb,
  'only this restaurant''s tables are offered as filters'
);

-- ─── Filters ────────────────────────────────────────────────────────────────
select is(
  pg_temp.invoices('{"from": "2026-09-10", "show_void": false}'),
  '["INV/2026-27/00002", "INV/2026-27/00001"]'::jsonb,
  'void bills can be hidden (and "to" defaults to "from")'
);
select is(
  pg_temp.invoices('{"from": "2026-09-10", "payment_status": "unpaid"}'),
  '["INV/2026-27/00002"]'::jsonb,
  'filter by payment status'
);
select is(
  (select jsonb_build_array(o -> 'summary' -> 'bills', o -> 'total')
   from pg_temp.orders('{"from": "2026-09-10", "payment_mode": "upi"}') as o),
  '[0, 1]'::jsonb,
  'filter by payment mode: the voided UPI bill is listed but not counted'
);
select is(
  pg_temp.invoices('{"from": "2026-09-10", "payment_mode": "cash"}'),
  '["INV/2026-27/00001"]'::jsonb,
  'filter by cash'
);
select is(
  pg_temp.invoices(format('{"from": "2026-09-10", "table_id": "%s"}', :'table6')::jsonb),
  '["INV/2026-27/00002"]'::jsonb,
  'filter by table'
);
select is(
  pg_temp.invoices(format('{"from": "2026-09-10", "waiter_id": "%s", "show_void": false}', :'w_ravi')::jsonb),
  '["INV/2026-27/00001"]'::jsonb,
  'filter by waiter'
);
select is(
  pg_temp.invoices('{"from": "2026-09-09", "to": "2026-09-11", "invoice": " inv/2026-27/0000 "}'),
  '["INV/2026-27/00003", "INV/2026-27/00002", "INV/2026-27/00004", "INV/2026-27/00001", "INV/2026-27/00005"]'::jsonb,
  'search by part of the invoice number, ignoring case, across three business days'
);
select is(
  pg_temp.invoices('{"from": "2026-09-09", "to": "2026-09-11", "invoice": "0002"}'),
  '["INV/2026-27/00002"]'::jsonb,
  'a short search narrows to one bill'
);
select is(
  pg_temp.invoices('{"from": "2026-09-09", "to": "2026-09-11", "invoice": "%"}'),
  '[]'::jsonb,
  'search text is matched literally'
);
select is(
  pg_temp.invoices('{"from": "2026-09-11"}'),
  '["INV/2026-27/00003"]'::jsonb,
  'the next business day starts at 4:00 am'
);

-- ─── Closed without bill, paging ────────────────────────────────────────────
select is(
  (select jsonb_build_array(o -> 'view', o -> 'total', o -> 'rows' -> 0 -> 'table_label', o -> 'rows' -> 0 -> 'waiter_name',
                            o -> 'rows' -> 0 -> 'reason', o -> 'rows' -> 0 -> 'closed_by_name')
   from pg_temp.orders('{"from": "2026-09-10", "view": "closed_unbilled"}') as o),
  '["closed_unbilled", 1, "6", "Anita", "Walked out", "A_manager"]'::jsonb,
  'tables closed without a bill are listed in their own view'
);
select is(
  (select jsonb_build_array(o -> 'page', o -> 'total', o -> 'rows')
   from pg_temp.orders('{"from": "2026-09-10", "page": 2}') as o),
  '[2, 3, []]'::jsonb,
  'pages past the end are empty'
);

-- ─── Defaults and bad filters ───────────────────────────────────────────────
select is(
  (select jsonb_build_array(o -> 'from' = o -> 'today', o -> 'to' = o -> 'today', o -> 'view')
   from pg_temp.orders('{}') as o),
  '[true, true, "bills"]'::jsonb,
  'without dates the range is today''s business day'
);
select tests.clear_auth();
select (private.business_day_start(now(), 'Asia/Kolkata', 4) at time zone 'Asia/Kolkata')::date as today \gset
select tests.authenticate_as(:'a_manager');
select is(
  pg_temp.orders(null) ->> 'today', :'today',
  'today is the current business day in the restaurant timezone'
);
select is(pg_temp.error_of($$ select public.admin_total_orders('{"from": "2026-09-10", "to": "2026-09-09"}') $$), 'INVALID_INPUT to', 'the range cannot end before it starts');
select is(pg_temp.error_of($$ select public.admin_total_orders('{"from": "2025-01-01", "to": "2026-09-09"}') $$), 'INVALID_INPUT to', 'the range is at most a year');
select is(pg_temp.error_of($$ select public.admin_total_orders('{"from": "2026-02-30"}') $$), 'INVALID_INPUT from', 'dates must exist');
select is(pg_temp.error_of($$ select public.admin_total_orders('{"from": "10/09/2026"}') $$), 'INVALID_INPUT from', 'dates are YYYY-MM-DD');
select is(pg_temp.error_of($$ select public.admin_total_orders('{"view": "all"}') $$), 'INVALID_INPUT view', 'unknown views are refused');
select is(pg_temp.error_of($$ select public.admin_total_orders('{"page": 0}') $$), 'INVALID_INPUT page', 'pages start at 1');
select is(pg_temp.error_of($$ select public.admin_total_orders('{"payment_mode": "cheque"}') $$), 'INVALID_INPUT payment_mode', 'unknown payment modes are refused');
select is(pg_temp.error_of($$ select public.admin_total_orders('{"sort": "total"}') $$), 'INVALID_INPUT sort', 'unknown filters are refused');

select * from finish();
rollback;
