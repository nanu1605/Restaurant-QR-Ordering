-- Billing list, bill preview, bill generation and the sample bill (spec §9.3
-- admin_preview_bill / admin_generate_bill, §10.1 the table is free again,
-- §10.5 billing rules, §10.6 read-only keeps billing, §10.7 the waiter is free
-- again and billing needs a waiter, §11.2 invoice numbers, §8.8 audit;
-- docs/DECISIONS.md P5-2…P5-6, P5-9, P5-10).
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ─── Fixtures ───────────────────────────────────────────────────────────────
select tests.create_restaurant('p5-220-a') as rest_a \gset
select tests.create_restaurant('p5-220-b') as rest_b \gset
select tests.create_restaurant('p5-220-c') as rest_c \gset
select tests.add_member(:'rest_a', 'owner', 'a_owner') as a_owner \gset
select tests.add_member(:'rest_a', 'manager', 'a_manager') as a_manager \gset
select tests.add_member(:'rest_a', 'waiter', 'a_waiter') as a_waiter \gset
select tests.add_member(:'rest_a', 'kitchen', 'a_kitchen') as a_kitchen \gset
select tests.add_member(:'rest_c', 'manager', 'c_manager') as c_manager \gset
select tests.add_waiter(:'rest_a', 'Ravi', :'a_waiter') as w_ravi \gset
select tests.add_waiter(:'rest_a', 'Anita') as w_anita \gset

select tests.create_ordering_fixture(:'rest_a', 'P5220A0000TABLE5') as fx \gset
select tests.create_ordering_fixture(:'rest_b', 'P5220B0000TABLE5') as fx_b \gset
select tests.create_ordering_fixture(:'rest_c', 'P5220C0000TABLE5') as fx_c \gset
select
  :'fx'::jsonb ->> 'table' as table5,
  :'fx'::jsonb ->> 'simple' as paneer,
  :'fx_b'::jsonb ->> 'table' as b_table5,
  :'fx_b'::jsonb ->> 'simple' as b_paneer,
  :'fx_c'::jsonb ->> 'table' as c_table5,
  :'fx_c'::jsonb ->> 'simple' as c_paneer
\gset

insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
values
  (:'rest_a', '6', 'P5220A0000TABLE6', 6),
  (:'rest_a', '7', 'P5220A0000TABLE7', 7),
  (:'rest_a', '8', 'P5220A0000TABLE8', 8),
  (:'rest_a', '9', 'P5220A0000TABLE9', 9);
select
  (select id from public.dining_tables where qr_token = 'P5220A0000TABLE6') as table6,
  (select id from public.dining_tables where qr_token = 'P5220A0000TABLE7') as table7,
  (select id from public.dining_tables where qr_token = 'P5220A0000TABLE8') as table8,
  (select id from public.dining_tables where qr_token = 'P5220A0000TABLE9') as table9
\gset

update public.restaurants
set legal_name = 'Spice Route Foods Pvt Ltd', address_line = '12 MG Road', city = 'Pune',
    gstin = '27ABCDE1234F1Z5', gst_mode = 'regular', gst_rate_bps = 500,
    prices_include_tax = false, service_charge_enabled = true, service_charge_bps = 500,
    bill_footer_text = 'Thank you, visit again'
where id = :'rest_a';

-- An open session at a table, approved an hour ago. Returns its id.
create function pg_temp.open_session(p_table uuid)
returns uuid
language sql
as $$
  insert into public.table_sessions (
    restaurant_id, dining_table_id, table_label_snapshot, is_approved, approved_at, opened_at
  )
  select t.restaurant_id, t.id, t.label, true, now() - interval '1 hour', now() - interval '1 hour'
  from public.dining_tables t
  where t.id = p_table
  returning id;
$$;

-- A round of one dish line in a session. Returns the order id.
create function pg_temp.round(
  p_session uuid,
  p_order_status public.order_status,
  p_quantity int,
  p_item_status public.order_item_status,
  p_price bigint default 28000
)
returns uuid
language plpgsql
as $$
declare
  v_session public.table_sessions;
  v_order uuid;
begin
  select * into v_session from public.table_sessions where id = p_session;
  insert into public.orders (restaurant_id, session_id, round_number, status, placed_via, idempotency_key)
  values (
    v_session.restaurant_id, p_session,
    (select coalesce(max(round_number), 0) + 1 from public.orders where session_id = p_session),
    p_order_status, 'staff', gen_random_uuid()::text
  )
  returning id into v_order;
  insert into public.order_items (
    restaurant_id, order_id, session_id, menu_item_id, item_name_snapshot, food_type_snapshot,
    unit_price_paise, quantity, status
  )
  select v_session.restaurant_id, v_order, p_session, i.id, i.name, i.food_type, p_price,
         p_quantity, p_item_status
  from public.menu_items i
  where i.restaurant_id = v_session.restaurant_id and i.name = 'Paneer Tikka';
  return v_order;
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

-- Table 5: Paneer Tikka ×2 served + ×1 ready (₹840), a removed dish, a
-- rejected round. Table 6: a waiting round. Table 7: a pending round the
-- customer cancelled entirely, plus ₹280 served. Table 8: only a rejected
-- round. Table 9: billed later by the "prefix" check.
select pg_temp.open_session(:'table5') as s5 \gset
select pg_temp.round(:'s5', 'accepted', 2, 'served');
select pg_temp.round(:'s5', 'accepted', 1, 'ready');
select pg_temp.round(:'s5', 'accepted', 1, 'removed');
select pg_temp.round(:'s5', 'rejected', 3, 'cancelled');

select pg_temp.open_session(:'table6') as s6 \gset
select pg_temp.round(:'s6', 'accepted', 1, 'served');
select pg_temp.round(:'s6', 'pending_approval', 1, 'placed');

select pg_temp.open_session(:'table7') as s7 \gset
select pg_temp.round(:'s7', 'pending_approval', 1, 'cancelled');
select pg_temp.round(:'s7', 'accepted', 1, 'served');

select pg_temp.open_session(:'table8') as s8 \gset
select pg_temp.round(:'s8', 'rejected', 1, 'cancelled');

select pg_temp.open_session(:'table9') as s9 \gset
select pg_temp.round(:'s9', 'accepted', 1, 'served');

select pg_temp.open_session(:'b_table5') as sb \gset
select pg_temp.round(:'sb', 'accepted', 1, 'served');

-- A billed and a closed session in A never show up for billing.
insert into public.table_sessions (restaurant_id, dining_table_id, table_label_snapshot, status, billed_at)
values (:'rest_a', :'table8', '8', 'billed', now() - interval '1 day');
insert into public.table_sessions (
  restaurant_id, dining_table_id, table_label_snapshot, status, closed_at, close_reason
)
values (:'rest_a', :'table8', '8', 'closed_unbilled', now() - interval '1 day', 'Walked out')
returning id as closed_session \gset

-- ─── Roles ──────────────────────────────────────────────────────────────────
select tests.authenticate_as(:'a_waiter');
select throws_ok($$ select public.admin_billing_sessions() $$, 'P0001', 'FORBIDDEN', 'waiters cannot list tables to bill');
select throws_ok(
  format($f$ select public.admin_preview_bill(%L, 'none', 0, false) $f$, :'s5'),
  'P0001', 'FORBIDDEN', 'waiters cannot preview bills'
);
select throws_ok(
  format($f$ select public.admin_generate_bill(%L, 'none', 0, null, false) $f$, :'s5'),
  'P0001', 'FORBIDDEN', 'waiters cannot generate bills'
);
select throws_ok($$ select public.admin_sample_bill() $$, 'P0001', 'FORBIDDEN', 'waiters cannot print sample bills');
select tests.authenticate_as(:'a_kitchen');
select throws_ok(
  format($f$ select public.admin_generate_bill(%L, 'none', 0, null, false) $f$, :'s5'),
  'P0001', 'FORBIDDEN', 'kitchen cannot generate bills'
);

-- ─── Tables to bill ─────────────────────────────────────────────────────────
select tests.authenticate_as(:'a_manager');
select is(
  (select jsonb_agg(
     jsonb_build_array(s ->> 'table_label', s -> 'items', s -> 'subtotal_paise', s -> 'unserved', s -> 'waiting')
     order by s ->> 'table_label')
   from jsonb_array_elements(public.admin_billing_sessions() -> 'sessions') as s),
  '[["5", 3, 84000, 1, 0], ["6", 1, 28000, 0, 1], ["7", 1, 28000, 0, 0], ["8", 0, 0, 0, 0], ["9", 1, 28000, 0, 0]]'::jsonb,
  'open sessions of this restaurant only, with billable dishes, running subtotal, unserved and waiting counts'
);

-- ─── Preview ────────────────────────────────────────────────────────────────
select public.admin_preview_bill(:'s5', 'percent', 1000, true) as preview5 \gset
select is(
  jsonb_build_array(
    :'preview5'::jsonb -> 'document_type',
    :'preview5'::jsonb -> 'lines' -> 0 -> 'qty',
    :'preview5'::jsonb -> 'totals' -> 'discount_paise',
    :'preview5'::jsonb -> 'totals' -> 'service_charge_paise',
    :'preview5'::jsonb -> 'totals' -> 'total_tax_paise',
    :'preview5'::jsonb -> 'totals' -> 'grand_total_paise',
    :'preview5'::jsonb -> 'waiter_required',
    :'preview5'::jsonb -> 'waiting_count',
    :'preview5'::jsonb -> 'unserved',
    :'preview5'::jsonb -> 'session' -> 'table_label'
  ),
  '["tax_invoice", 3, 8400, 3780, 3969, 83300, true, 0, [{"name": "Paneer Tikka", "status": "ready", "variant": null, "quantity": 1}], "5"]'::jsonb,
  'the preview prices the merged lines with discount, service charge and tax, and reports blockers'
);

select is(
  public.admin_preview_bill(:'s6', 'none', 0, false) -> 'waiting_count', '1'::jsonb,
  'the preview counts waiting rounds'
);
select is(
  public.admin_preview_bill(:'s7', 'none', 0, false) -> 'waiting_count', '0'::jsonb,
  'a waiting round the customer cancelled entirely is not waiting'
);
select throws_ok(
  format($f$ select public.admin_preview_bill(%L, 'none', 0, false) $f$, :'closed_session'),
  'P0001', 'SESSION_NOT_OPEN', 'a closed session has nothing to preview'
);
select throws_ok(
  format($f$ select public.admin_preview_bill(%L, 'none', 0, false) $f$, :'sb'),
  'P0001', 'NOT_FOUND', 'another restaurant''s session is not found'
);

-- ─── Generation blockers ────────────────────────────────────────────────────
select is(
  pg_temp.error_of(format($f$ select public.admin_generate_bill(%L, 'none', 0, null, false) $f$, :'s6')),
  'ORDERS_WAITING 1', 'a waiting round blocks the bill'
);
select is(
  pg_temp.error_of(format($f$ select public.admin_generate_bill(%L, 'none', 0, null, false) $f$, :'s8')),
  'NOTHING_TO_BILL', 'a table with nothing billable has no bill'
);
select is(
  pg_temp.error_of(format($f$ select public.admin_generate_bill(%L, 'none', 0, null, false) $f$, :'s5')),
  'WAITER_REQUIRED', 'with waiter profiles, a table needs a waiter before billing'
);

select public.admin_assign_waiter(:'s5', :'w_ravi');
select public.admin_assign_waiter(:'s7', :'w_anita');
select public.admin_assign_waiter(:'s9', :'w_anita', true);

select is(
  pg_temp.error_of(format($f$ select public.admin_generate_bill(%L, 'percent', 1000, '  ', true) $f$, :'s5')),
  'REASON_REQUIRED', 'a discount needs a reason'
);
select is(
  pg_temp.error_of(format($f$ select public.admin_generate_bill(%L, 'percent', 10001, 'Too much', true) $f$, :'s5')),
  'INVALID_INPUT discount_value', 'a discount above 100% is refused'
);
select is(
  pg_temp.error_of(format($f$ select public.admin_generate_bill(%L, 'none', 0, null, false) $f$, :'sb')),
  'NOT_FOUND', 'another restaurant''s session cannot be billed'
);

-- ─── Generate ───────────────────────────────────────────────────────────────
select tests.clear_auth();
insert into public.invoice_counters (restaurant_id, financial_year, last_seq)
values (:'rest_a', '2000-01', 41);
select private.financial_year(now(), 'Asia/Kolkata') as fy \gset

select tests.authenticate_as(:'a_manager');
select public.admin_generate_bill(:'s5', 'percent', 1000, ' Regular  guest ', true) as bill5 \gset
select (:'bill5'::jsonb ->> 'bill_id') as bill5_id \gset

select is(
  :'bill5'::jsonb - 'bill_id',
  jsonb_build_object('invoice_number', 'INV/' || :'fy' || '/00001', 'grand_total_paise', 83300),
  'the first bill of the financial year is number 00001 and returns its total'
);

select tests.clear_auth();
select results_eq(
  format(
    $f$ select session_id, invoice_seq, financial_year, document_type::text, table_label_snapshot,
               waiter_id, waiter_name_snapshot, jsonb_array_length(line_items),
               restaurant_snapshot ->> 'legal_name', restaurant_snapshot ->> 'gstin',
               restaurant_snapshot ->> 'footer', gst_mode::text, gst_rate_bps, prices_include_tax,
               subtotal_paise, discount_type::text, discount_value, discount_paise, discount_reason,
               service_charge_bps, service_charge_paise, taxable_paise, cgst_paise, sgst_paise,
               total_tax_paise, round_off_paise, grand_total_paise, payment_status::text,
               status::text, generated_by, print_count
        from public.bills where id = %L $f$,
    :'bill5_id'
  ),
  format(
    $f$ values (%L::uuid, 1, %L, 'tax_invoice', '5', %L::uuid, 'Ravi', 1,
               'Spice Route Foods Pvt Ltd', '27ABCDE1234F1Z5', 'Thank you, visit again', 'regular',
               500, false, 84000::bigint, 'percent', 1000::bigint, 8400::bigint, 'Regular guest',
               500, 3780::bigint, 79380::bigint, 1984::bigint, 1985::bigint, 3969::bigint,
               -49::bigint, 83300::bigint, 'unpaid', 'active', %L::uuid, 0) $f$,
    :'s5', :'fy', :'w_ravi', :'a_manager'
  ),
  'the bill stores lines, snapshots of the restaurant, waiter and tax settings, and the totals'
);

select results_eq(
  format(
    $f$ select s.status::text, s.billed_at is not null,
               (select unassign_reason::text from public.session_waiter_assignments a where a.session_id = s.id),
               s.assigned_waiter_id
        from public.table_sessions s where s.id = %L $f$,
    :'s5'
  ),
  format($f$ values ('billed', true, 'billed', %L::uuid) $f$, :'w_ravi'),
  'the session is billed and the waiter''s assignment ends, keeping the waiter as history'
);

select is(
  (select jsonb_agg(jsonb_build_array(action, reason, after -> 'invoice_number') order by action)
   from public.audit_logs where entity_id = :'bill5_id'),
  jsonb_build_array(
    jsonb_build_array('bill.generated', null, 'INV/' || :'fy' || '/00001'),
    jsonb_build_array('discount.applied', 'Regular guest', null)
  ),
  'generation and the discount are audited'
);

select is(
  (select last_seq from public.invoice_counters where restaurant_id = :'rest_a' and financial_year = '2000-01'),
  41, 'each financial year keeps its own counter'
);

-- The table is free: a new session can open there (one open session per table).
select pg_temp.open_session(:'table5') as next_session \gset
select isnt(:'next_session'::uuid, :'s5'::uuid, 'the billed table takes its next guests in a new session');

-- Ravi (limit 1) is free again.
select tests.authenticate_as(:'a_manager');
select lives_ok(
  format($f$ select public.admin_assign_waiter(%L, %L) $f$, :'next_session', :'w_ravi'),
  'the billed table''s waiter can take another table'
);

-- A second generate on the billed session points at the bill.
select is(
  pg_temp.error_of(format($f$ select public.admin_generate_bill(%L, 'none', 0, null, false) $f$, :'s5')),
  'ALREADY_BILLED ' || :'bill5_id', 'generating twice returns the existing bill id'
);
select is(
  pg_temp.error_of(format($f$ select public.admin_preview_bill(%L, 'none', 0, false) $f$, :'s5')),
  'ALREADY_BILLED ' || :'bill5_id', 'previewing a billed session points at its bill'
);

-- ─── Numbering, prefix, waiting rule, service charge setting ────────────────
select tests.clear_auth();
update public.restaurants set service_charge_enabled = false where id = :'rest_a';
select tests.authenticate_as(:'a_manager');
select public.admin_generate_bill(:'s7', 'none', 0, null, true) as bill7 \gset
select is(
  jsonb_build_array(:'bill7'::jsonb -> 'invoice_number', :'bill7'::jsonb -> 'grand_total_paise'),
  jsonb_build_array('INV/' || :'fy' || '/00002', 29400),
  'the next bill is 00002; a fully cancelled waiting round doesn''t block; service charge switched off in settings is not added'
);

select tests.clear_auth();
update public.restaurants set invoice_prefix = 'SR-B' where id = :'rest_a';
update public.invoice_counters set last_seq = 99999
  where restaurant_id = :'rest_a' and financial_year = :'fy';
select tests.authenticate_as(:'a_manager');
select is(
  public.admin_generate_bill(:'s9', 'none', 0, null, false) ->> 'invoice_number',
  'SR-B/' || :'fy' || '/100000',
  'a new prefix applies to new bills, and a sixth digit is kept'
);

-- ─── Plans, read-only, restaurants without waiter profiles ──────────────────
select tests.clear_auth();
select tests.set_plan(:'rest_c', 'starter');
select tests.suspend(:'rest_c');
select pg_temp.open_session(:'c_table5') as sc \gset
select pg_temp.round(:'sc', 'accepted', 1, 'served');

select tests.authenticate_as(:'c_manager');
select is(
  pg_temp.error_of(format($f$ select public.admin_generate_bill(%L, 'flat', 5000, 'Friend', false) $f$, :'sc')),
  'FEATURE_NOT_IN_PLAN discounts', 'discounts need a plan with the discounts feature'
);
select is(
  (select jsonb_build_array(b -> 'invoice_number', b -> 'grand_total_paise')
   from public.admin_generate_bill(:'sc', 'none', 0, null, false) as b),
  jsonb_build_array('INV/' || :'fy' || '/00001', 28000),
  'a read-only restaurant without waiter profiles still bills its open table; numbering is per restaurant'
);
select tests.clear_auth();
select is(
  (select waiter_id from public.bills where session_id = :'sc'), null,
  'a bill without an assigned waiter stores no waiter'
);

-- ─── Sample bill ────────────────────────────────────────────────────────────
update public.restaurants
set show_upi_qr_on_bill = true, upi_vpa = 'spiceroute@okicici', upi_payee_name = null,
    service_charge_enabled = true, paper_width = '58mm'
where id = :'rest_a';
select tests.authenticate_as(:'a_owner');
select public.admin_sample_bill() as sample \gset
select is(
  jsonb_build_array(
    :'sample'::jsonb -> 'bill' -> 'is_sample',
    :'sample'::jsonb -> 'bill' -> 'invoice_number',
    jsonb_array_length(:'sample'::jsonb -> 'bill' -> 'lines'),
    :'sample'::jsonb -> 'bill' -> 'subtotal_paise',
    :'sample'::jsonb -> 'bill' -> 'service_charge_paise',
    :'sample'::jsonb -> 'bill' -> 'grand_total_paise',
    :'sample'::jsonb -> 'bill' -> 'restaurant' -> 'legal_name',
    :'sample'::jsonb -> 'print' -> 'paper_width',
    :'sample'::jsonb -> 'print' -> 'upi',
    :'sample'::jsonb -> 'print' -> 'show_branding'
  ),
  jsonb_build_array(
    true, 'SR-B/' || :'fy' || '/00000', 3, 70000, 3500, 77200, 'Spice Route Foods Pvt Ltd', '58mm',
    jsonb_build_object('vpa', 'spiceroute@okicici', 'payee_name', 'P5-220-A'), true
  ),
  'the sample bill prices the §11.1 dishes with the saved settings and today''s print options'
);
select tests.clear_auth();
select is(
  (select count(*) from public.bills where restaurant_id = :'rest_a'), 3::bigint,
  'the sample bill saves nothing'
);

select tests.set_plan(:'rest_a', 'starter');
select tests.authenticate_as(:'a_owner');
select is(
  public.admin_sample_bill() -> 'print' -> 'upi', 'null'::jsonb,
  'without the UPI QR feature, bills print without the QR even if the setting is on'
);

select * from finish();
rollback;
