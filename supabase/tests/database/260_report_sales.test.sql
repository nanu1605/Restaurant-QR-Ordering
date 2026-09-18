-- Sales report (spec §19 Phase 6): summary, payment modes, day trend and
-- weekday × hour heatmap over business days (a 1:30 am bill belongs to the
-- previous business day), void bills left out, Starter limited to the summary
-- for today or yesterday, CSV exports gated (docs/DECISIONS.md P6-1…P6-5, P6-9).
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ─── Fixtures ───────────────────────────────────────────────────────────────
select tests.create_restaurant('p6-260-a') as rest_a \gset
select tests.create_restaurant('p6-260-b') as rest_b \gset
select tests.create_restaurant('p6-260-c') as rest_c \gset
select tests.set_plan(:'rest_c', 'starter');
select tests.add_member(:'rest_a', 'manager', 'a_manager') as a_manager \gset
select tests.add_member(:'rest_a', 'owner', 'a_owner') as a_owner \gset
select tests.add_member(:'rest_a', 'waiter', 'a_waiter') as a_waiter \gset
select tests.add_member(:'rest_a', 'kitchen', 'a_kitchen') as a_kitchen \gset
select tests.add_member(:'rest_b', 'manager', 'b_manager') as b_manager \gset
select tests.add_member(:'rest_c', 'owner', 'c_owner') as c_owner \gset

insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
values
  (:'rest_a', '5', 'P6260A0000TABLE5', 5),
  (:'rest_b', '5', 'P6260B0000TABLE5', 5),
  (:'rest_c', '1', 'P6260C0000TABLE1', 1);
select
  (select id from public.dining_tables where qr_token = 'P6260A0000TABLE5') as table_a,
  (select id from public.dining_tables where qr_token = 'P6260B0000TABLE5') as table_b,
  (select id from public.dining_tables where qr_token = 'P6260C0000TABLE1') as table_c
\gset

update public.restaurants set timezone = 'Asia/Kolkata', business_day_start_hour = 4
where id in (:'rest_a', :'rest_b', :'rest_c');

-- A billed session with one bill. Grand total = taxable + tax + round off
-- (true for tax-inclusive bills too). p_payments: [{"mode", "amount"}].
create function pg_temp.sale(
  p_table uuid,
  p_generated_at timestamptz,
  p_seq int,
  p_subtotal bigint,
  p_discount bigint,
  p_service_charge bigint,
  p_taxable bigint,
  p_tax bigint,
  p_round_off bigint,
  p_inclusive boolean default false,
  p_status public.bill_status default 'active',
  p_payments jsonb default '[]'
)
returns uuid
language plpgsql
as $$
declare
  v_table public.dining_tables;
  v_session uuid;
  v_bill uuid;
  v_paid boolean := jsonb_array_length(p_payments) > 0;
begin
  select * into v_table from public.dining_tables where id = p_table;
  insert into public.table_sessions (
    restaurant_id, dining_table_id, table_label_snapshot, status, is_approved, opened_at, billed_at
  )
  values (
    v_table.restaurant_id, v_table.id, v_table.label, 'billed', true,
    p_generated_at - interval '75 minutes', p_generated_at
  )
  returning id into v_session;

  insert into public.bills (
    restaurant_id, session_id, invoice_number, financial_year, invoice_seq, document_type,
    table_label_snapshot, line_items, restaurant_snapshot, gst_mode, gst_rate_bps,
    prices_include_tax, subtotal_paise, discount_type, discount_value, discount_paise,
    discount_reason, service_charge_bps, service_charge_paise, taxable_paise, cgst_paise,
    sgst_paise, total_tax_paise, round_off_paise, grand_total_paise, payment_status, status,
    generated_at, paid_at, void_reason, voided_at
  )
  values (
    v_table.restaurant_id, v_session, 'INV/2026-27/' || lpad(p_seq::text, 5, '0'), '2026-27',
    p_seq, 'tax_invoice', v_table.label, '[]'::jsonb, '{}'::jsonb, 'regular', 500, p_inclusive,
    p_subtotal, 'flat', p_discount, p_discount, case when p_discount > 0 then 'Regular' end,
    case when p_service_charge > 0 then 500 else 0 end, p_service_charge, p_taxable,
    p_tax / 2, p_tax - p_tax / 2, p_tax, p_round_off, p_taxable + p_tax + p_round_off,
    case when v_paid then 'paid' else 'unpaid' end::public.payment_status, p_status,
    p_generated_at,
    case when v_paid then p_generated_at + interval '5 minutes' end,
    case when p_status = 'void' then 'Wrong table' end,
    case when p_status = 'void' then p_generated_at + interval '10 minutes' end
  )
  returning id into v_bill;

  insert into public.bill_payments (restaurant_id, bill_id, mode, amount_paise, is_void)
  select v_table.restaurant_id, v_bill, (p ->> 'mode')::public.payment_mode,
         (p ->> 'amount')::bigint, p_status = 'void'
  from jsonb_array_elements(p_payments) as p;
  return v_bill;
end;
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

-- Business day Thursday 10 September:
--   1. 12:30 pm, 10% discount, GST on top, paid cash + UPI.
--   2. 1:30 am on the 11th (still the 10th's business day), service charge,
--      prices include GST, unpaid.
--   4. 8 pm, voided (its UPI payment voided too).
-- Business day 11 September: 3. 4:00 am, no GST, rounded down 50 paise, paid by card.
-- Business day 9 September: 5. 11 pm, paid "other".
-- Restaurant B has a bill on the 10th.
select pg_temp.sale(:'table_a', '2026-09-10 12:30+05:30', 1, 50000, 5000, 0, 45000, 2250, 0,
  false, 'active', '[{"mode": "cash", "amount": 20000}, {"mode": "upi", "amount": 27250}]');
select pg_temp.sale(:'table_a', '2026-09-11 01:30+05:30', 2, 30000, 0, 1500, 30000, 1500, 0, true);
select pg_temp.sale(:'table_a', '2026-09-11 04:00+05:30', 3, 20050, 0, 0, 20050, 0, -50,
  false, 'active', '[{"mode": "card", "amount": 20000}]');
select pg_temp.sale(:'table_a', '2026-09-10 20:00+05:30', 4, 40000, 0, 0, 40000, 2000, 0,
  false, 'void', '[{"mode": "upi", "amount": 42000}]');
select pg_temp.sale(:'table_a', '2026-09-09 23:00+05:30', 5, 10000, 0, 0, 10000, 500, 0,
  false, 'active', '[{"mode": "other", "amount": 10500}]');
select pg_temp.sale(:'table_b', '2026-09-10 13:00+05:30', 1, 99900, 0, 0, 99900, 0, 0);

-- ─── Roles ──────────────────────────────────────────────────────────────────
select tests.authenticate_as(:'a_waiter');
select throws_ok($$ select public.admin_report_sales('{}') $$, 'P0001', 'FORBIDDEN', 'waiters cannot see reports');
select tests.authenticate_as(:'a_kitchen');
select throws_ok($$ select public.admin_report_sales('{}') $$, 'P0001', 'FORBIDDEN', 'kitchen cannot see reports');

-- ─── One business day ───────────────────────────────────────────────────────
select tests.authenticate_as(:'a_manager');
select public.admin_report_sales('{"from": "2026-09-10", "to": "2026-09-10"}') as day10 \gset

select is(
  :'day10'::jsonb -> 'summary',
  jsonb_build_object(
    'bills', 2, 'gross_paise', 80000, 'discount_paise', 5000, 'service_charge_paise', 1500,
    'tax_paise', 3750, 'round_off_paise', 0, 'net_paise', 75000, 'total_paise', 78750,
    'average_paise', 39375, 'unpaid_bills', 1, 'unpaid_paise', 31500,
    'collected', jsonb_build_object('cash', 20000, 'upi', 27250, 'card', 0, 'other', 0)
  ),
  'the summary counts the business day''s active bills, the 1:30 am bill included and the void bill left out'
);
select is(
  (:'day10'::jsonb) - 'summary' - 'days' - 'hours' - 'today',
  '{"from": "2026-09-10", "to": "2026-09-10", "start_hour": 4, "basic": false}'::jsonb,
  'the range and business-day start come back'
);
select is(
  :'day10'::jsonb -> 'hours',
  '[{"weekday": 4, "hour": 1, "bills": 1, "total_paise": 31500},
    {"weekday": 4, "hour": 12, "bills": 1, "total_paise": 47250}]'::jsonb,
  'the heatmap puts the 1:30 am bill on Thursday (the business day) at 1 am'
);
select is(
  jsonb_array_length(:'day10'::jsonb -> 'days'),
  1,
  'one day row for one business day'
);

select is(
  public.admin_report_sales('{"from": "2026-09-11"}') -> 'summary' -> 'bills',
  '1'::jsonb,
  '4:00 am starts the next business day'
);
select is(
  public.admin_report_sales('{"from": "2026-09-11"}') -> 'summary' -> 'round_off_paise',
  '-50'::jsonb,
  'round off keeps its sign'
);

-- ─── Day trend ──────────────────────────────────────────────────────────────
select is(
  (
    select jsonb_agg(jsonb_build_object(
      'date', d ->> 'date', 'bills', d -> 'bills', 'total', d -> 'total_paise', 'collected', d -> 'collected'
    ))
    from jsonb_array_elements(
      public.admin_report_sales('{"from": "2026-09-08", "to": "2026-09-11"}') -> 'days'
    ) as d
  ),
  '[{"date": "2026-09-08", "bills": 0, "total": 0, "collected": {"cash": 0, "upi": 0, "card": 0, "other": 0}},
    {"date": "2026-09-09", "bills": 1, "total": 10500, "collected": {"cash": 0, "upi": 0, "card": 0, "other": 10500}},
    {"date": "2026-09-10", "bills": 2, "total": 78750, "collected": {"cash": 20000, "upi": 27250, "card": 0, "other": 0}},
    {"date": "2026-09-11", "bills": 1, "total": 20000, "collected": {"cash": 0, "upi": 0, "card": 20000, "other": 0}}]'::jsonb,
  'one row per business day, days without bills as zeros'
);
select is(
  public.admin_report_sales('{"from": "2026-09-08", "to": "2026-09-11"}') -> 'summary' -> 'total_paise',
  '109250'::jsonb,
  'the summary covers the whole range'
);
select is(
  jsonb_array_length(public.admin_report_sales('{"from": "2025-09-10", "to": "2026-09-11"}') -> 'days'),
  367,
  'a range of 366 days apart has 367 day rows'
);

-- ─── Input ──────────────────────────────────────────────────────────────────
select is(
  pg_temp.error_of($$ select public.admin_report_sales('{"from": "2026-02-30"}') $$),
  'INVALID_INPUT from',
  'impossible dates are refused'
);
select is(
  pg_temp.error_of($$ select public.admin_report_sales('{"from": "2026-09-10", "to": "2026-09-09"}') $$),
  'INVALID_INPUT to',
  'the end cannot be before the start'
);
select is(
  pg_temp.error_of($$ select public.admin_report_sales('{"from": "2025-09-10", "to": "2026-09-12"}') $$),
  'INVALID_INPUT to',
  'ranges longer than 366 days are refused'
);
select is(
  pg_temp.error_of($$ select public.admin_report_sales('{"page": 2}') $$),
  'INVALID_INPUT page',
  'unknown filters are refused'
);
select is(
  pg_temp.error_of($$ select public.admin_report_sales('{"export": "yes"}') $$),
  'INVALID_INPUT export',
  'export must be a boolean'
);
select is(
  public.admin_report_sales('{}') ->> 'from',
  public.admin_report_sales('{}') ->> 'today',
  'no dates means today'
);
select is(
  public.admin_report_sales('{"from": "2026-09-10", "export": true}') -> 'summary' -> 'bills',
  '2'::jsonb,
  'Growth can export'
);

-- ─── Tenancy and read-only ──────────────────────────────────────────────────
select tests.authenticate_as(:'b_manager');
select is(
  public.admin_report_sales('{"from": "2026-09-10"}') -> 'summary' -> 'total_paise',
  '99900'::jsonb,
  'another restaurant only sees its own bills'
);

select tests.clear_auth();
select tests.suspend(:'rest_a');
select tests.authenticate_as(:'a_owner');
select is(
  public.admin_report_sales('{"from": "2026-09-10"}') -> 'summary' -> 'bills',
  '2'::jsonb,
  'owners of a read-only restaurant can still read reports'
);

-- ─── Starter ────────────────────────────────────────────────────────────────
select tests.clear_auth();
select pg_temp.sale(:'table_c', now(), 1, 10000, 0, 0, 10000, 500, 0,
  false, 'active', '[{"mode": "cash", "amount": 10500}]');
select tests.authenticate_as(:'c_owner');

select public.admin_report_sales('{}') as starter_today \gset
select is(
  (:'starter_today'::jsonb) -> 'summary' -> 'total_paise',
  '10500'::jsonb,
  'Starter sees today''s summary'
);
select ok(
  (:'starter_today'::jsonb) -> 'basic' = 'true'
    and (:'starter_today'::jsonb) -> 'summary' -> 'collected' = 'null'
    and (:'starter_today'::jsonb) -> 'days' = 'null'
    and (:'starter_today'::jsonb) -> 'hours' = 'null',
  'Starter gets no payment modes, day trend or heatmap'
);
select is(
  public.admin_report_sales(
    jsonb_build_object('from', ((:'starter_today'::jsonb) ->> 'today')::date - 1)
  ) -> 'summary' -> 'bills',
  '0'::jsonb,
  'Starter can see yesterday'
);
select is(
  pg_temp.error_of(format(
    $$ select public.admin_report_sales('{"from": "%s", "to": "%s"}') $$,
    ((:'starter_today'::jsonb) ->> 'today')::date - 6, (:'starter_today'::jsonb) ->> 'today'
  )),
  'FEATURE_NOT_IN_PLAN advanced_reports',
  'Starter cannot see the last 7 days'
);
select is(
  pg_temp.error_of(format(
    $$ select public.admin_report_sales('{"from": "%s"}') $$,
    ((:'starter_today'::jsonb) ->> 'today')::date - 2
  )),
  'FEATURE_NOT_IN_PLAN advanced_reports',
  'Starter cannot see the day before yesterday'
);
select is(
  pg_temp.error_of($$ select public.admin_report_sales('{"export": true}') $$),
  'FEATURE_NOT_IN_PLAN csv_export',
  'Starter cannot export'
);

select * from finish();
rollback;
