-- Bill detail, payments, voiding with and without reopening the table, and
-- print counts (spec §9.3, §10.1, §10.5, §10.6, §10.7 the waiter comes back
-- after a reopen, §11.2 numbers are never reused, §8.8 audit;
-- docs/DECISIONS.md P5-7, P5-8, P5-9, P5-15).
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ─── Fixtures ───────────────────────────────────────────────────────────────
select tests.create_restaurant('p5-230-a') as rest_a \gset
select tests.create_restaurant('p5-230-b') as rest_b \gset
select tests.add_member(:'rest_a', 'owner', 'a_owner') as a_owner \gset
select tests.add_member(:'rest_a', 'manager', 'a_manager') as a_manager \gset
select tests.add_member(:'rest_a', 'waiter', 'a_waiter') as a_waiter \gset
select tests.add_member(:'rest_b', 'manager', 'b_manager') as b_manager \gset
select tests.add_waiter(:'rest_a', 'Ravi', :'a_waiter') as w_ravi \gset
select tests.add_waiter(:'rest_a', 'Anita') as w_anita \gset

select tests.create_ordering_fixture(:'rest_a', 'P5230A0000TABLE5') as fx \gset
select tests.create_ordering_fixture(:'rest_b', 'P5230B0000TABLE5') as fx_b \gset
select :'fx'::jsonb ->> 'table' as table5, :'fx_b'::jsonb ->> 'table' as b_table5 \gset

insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
select :'rest_a', n::text, 'P5230A00000TAB' || lpad(n::text, 2, '0'), n
from generate_series(6, 11) as n;

create function pg_temp.table_id(p_label text)
returns uuid
language sql
as $$
  select id from public.dining_tables where qr_token like 'P5230A%' and label = p_label;
$$;

update public.restaurants
set gst_mode = 'regular', gst_rate_bps = 500, prices_include_tax = false, reopen_window_minutes = 30
where id = :'rest_a';

create function pg_temp.open_session(p_table uuid)
returns uuid
language sql
as $$
  insert into public.table_sessions (
    restaurant_id, dining_table_id, table_label_snapshot, is_approved, approved_at
  )
  select t.restaurant_id, t.id, t.label, true, now() - interval '1 hour'
  from public.dining_tables t
  where t.id = p_table
  returning id;
$$;

-- A served round of Paneer Tikka at p_price × p_quantity.
create function pg_temp.served_round(p_session uuid, p_quantity int, p_price bigint default 28000)
returns void
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
    'accepted', 'staff', gen_random_uuid()::text
  )
  returning id into v_order;
  insert into public.order_items (
    restaurant_id, order_id, session_id, menu_item_id, item_name_snapshot, food_type_snapshot,
    unit_price_paise, quantity, status
  )
  select v_session.restaurant_id, v_order, p_session, i.id, i.name, i.food_type, p_price, p_quantity, 'served'
  from public.menu_items i
  where i.restaurant_id = v_session.restaurant_id and i.name = 'Paneer Tikka';
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

create function pg_temp.pay(p_bill uuid, p_payments jsonb)
returns text
language sql
as $$
  select pg_temp.error_of(format('select public.admin_record_payment(%L, %L)', p_bill, p_payments));
$$;

-- Sessions: table 5 (Ravi, ₹560 → ₹588), table 6 (Ravi, ₹280 → ₹294),
-- table 7 (Anita, ₹280, billed with a 100% discount → ₹0), tables 8–10
-- (Anita, for the busy, window and table-busy cases), all billed now.
select pg_temp.open_session(:'table5') as s5 \gset
select pg_temp.served_round(:'s5', 2);
select pg_temp.open_session(pg_temp.table_id('6')) as s6 \gset
select pg_temp.served_round(:'s6', 1);
select pg_temp.open_session(pg_temp.table_id('7')) as s7 \gset
select pg_temp.served_round(:'s7', 1);
select pg_temp.open_session(pg_temp.table_id('8')) as s8 \gset
select pg_temp.served_round(:'s8', 1);
select pg_temp.open_session(pg_temp.table_id('9')) as s9 \gset
select pg_temp.served_round(:'s9', 1);
select pg_temp.open_session(pg_temp.table_id('10')) as s10 \gset
select pg_temp.served_round(:'s10', 1);
select pg_temp.open_session(:'b_table5') as sb \gset
select pg_temp.served_round(:'sb', 1);

select tests.authenticate_as(:'a_manager');
select public.admin_assign_waiter(:'s5', :'w_ravi');
select public.admin_generate_bill(:'s5', 'none', 0, null, false) ->> 'bill_id' as bill5 \gset
select public.admin_assign_waiter(:'s6', :'w_ravi');
select public.admin_generate_bill(:'s6', 'none', 0, null, false) ->> 'bill_id' as bill6 \gset
select public.admin_assign_waiter(:'s7', :'w_anita');
select public.admin_generate_bill(:'s7', 'percent', 10000, 'Owner''s guest', false) ->> 'bill_id' as bill7 \gset
select public.admin_assign_waiter(:'s8', :'w_anita');
select public.admin_generate_bill(:'s8', 'none', 0, null, false) ->> 'bill_id' as bill8 \gset
select public.admin_assign_waiter(:'s9', :'w_anita');
select public.admin_generate_bill(:'s9', 'none', 0, null, false) ->> 'bill_id' as bill9 \gset
select public.admin_assign_waiter(:'s10', :'w_anita');
select public.admin_generate_bill(:'s10', 'none', 0, null, false) ->> 'bill_id' as bill10 \gset
select tests.authenticate_as(:'b_manager');
select public.admin_generate_bill(:'sb', 'none', 0, null, false) ->> 'bill_id' as bill_b \gset

-- ─── Roles and tenants ──────────────────────────────────────────────────────
select tests.authenticate_as(:'a_waiter');
select throws_ok(format('select public.admin_get_bill(%L)', :'bill5'), 'P0001', 'FORBIDDEN', 'waiters cannot open bill details');
select is(pg_temp.pay(:'bill5', '[{"mode": "cash", "amount_paise": 58800}]'), 'FORBIDDEN', 'waiters cannot record payments');
select throws_ok(format('select public.admin_void_bill(%L, %L, false)', :'bill5', 'Mistake'), 'P0001', 'FORBIDDEN', 'waiters cannot void bills');
select throws_ok(format('select public.admin_increment_print_count(%L)', :'bill5'), 'P0001', 'FORBIDDEN', 'waiters cannot count prints');

select tests.authenticate_as(:'a_manager');
select throws_ok(format('select public.admin_get_bill(%L)', :'bill_b'), 'P0001', 'NOT_FOUND', 'another restaurant''s bill is not found');
select is(pg_temp.pay(:'bill_b', '[{"mode": "cash", "amount_paise": 28000}]'), 'NOT_FOUND', 'another restaurant''s bill cannot be paid');
select throws_ok(format('select public.admin_void_bill(%L, %L, false)', :'bill_b', 'Mistake'), 'P0001', 'NOT_FOUND', 'another restaurant''s bill cannot be voided');
select throws_ok(format('select public.admin_increment_print_count(%L)', :'bill_b'), 'P0001', 'NOT_FOUND', 'another restaurant''s bill cannot be counted');

-- ─── Payments ───────────────────────────────────────────────────────────────
select is(pg_temp.pay(:'bill5', '[{"mode": "cash", "amount_paise": 50000}]'), 'PAYMENT_MISMATCH 58800', 'payments must add up to the grand total');
select is(pg_temp.pay(:'bill5', '[{"mode": "cheque", "amount_paise": 58800}]'), 'INVALID_INPUT mode', 'unknown payment modes are refused');
select is(pg_temp.pay(:'bill5', '[{"mode": "cash", "amount_paise": 0}, {"mode": "upi", "amount_paise": 58800}]'), 'INVALID_INPUT amount_paise', 'a ₹0 row is refused on a bill with something to pay');
select is(pg_temp.pay(:'bill5', '[{"mode": "cash", "amount_paise": 58800, "tip": 100}]'), 'INVALID_INPUT tip', 'unknown payment fields are refused');
select is(pg_temp.pay(:'bill5', '[]'), 'INVALID_INPUT payments', 'at least one payment row is needed');
select is(
  pg_temp.pay(:'bill5', format('[{"mode": "cash", "amount_paise": 58800, "reference": "%s"}]', repeat('x', 101))::jsonb),
  'INVALID_INPUT reference', 'references are at most 100 characters'
);

select is(
  pg_temp.pay(:'bill5', '[{"mode": "cash", "amount_paise": 30000}, {"mode": "upi", "amount_paise": 28800, "reference": " UTR 1234 "}]'),
  'no error', 'a split payment that adds up is recorded'
);
select tests.clear_auth();
select results_eq(
  format(
    $f$ select b.payment_status::text, b.paid_at is not null,
               (select jsonb_agg(jsonb_build_array(p.mode, p.amount_paise, p.reference, p.is_void, p.recorded_by) order by p.amount_paise desc)
                from public.bill_payments p where p.bill_id = b.id),
               (select count(*) from public.audit_logs a where a.entity_id = b.id and a.action = 'payment.recorded')
        from public.bills b where b.id = %L $f$,
    :'bill5'
  ),
  format(
    $f$ values ('paid', true, jsonb_build_array(
                 jsonb_build_array('cash', 30000, null, false, %1$L::uuid),
                 jsonb_build_array('upi', 28800, 'UTR 1234', false, %1$L::uuid)), 1::bigint) $f$,
    :'a_manager'
  ),
  'the bill is paid, each row is stored with who recorded it, and the payment is audited'
);
select tests.authenticate_as(:'a_manager');
select is(pg_temp.pay(:'bill5', '[{"mode": "cash", "amount_paise": 58800}]'), 'BILL_ALREADY_PAID', 'a paid bill takes no second payment');

select is(pg_temp.pay(:'bill7', '[{"mode": "cash", "amount_paise": 0}]'), 'no error', 'a ₹0 bill is settled with a single ₹0 row');

select tests.clear_auth();
select tests.set_plan(:'rest_a', 'starter');
select tests.authenticate_as(:'a_manager');
select is(
  pg_temp.pay(:'bill8', '[{"mode": "cash", "amount_paise": 20000}, {"mode": "card", "amount_paise": 9400}]'),
  'FEATURE_NOT_IN_PLAN split_payments', 'split payments need a plan with the feature'
);
select is(pg_temp.pay(:'bill8', '[{"mode": "card", "amount_paise": 29400}]'), 'no error', 'a single payment works on any plan');
select is(
  public.admin_get_bill(:'bill8') -> 'features' -> 'split_payments', 'false'::jsonb,
  'bill detail says whether split payments are available'
);
select tests.clear_auth();
select tests.set_plan(:'rest_a', 'growth');

-- ─── Void without reopening ─────────────────────────────────────────────────
select tests.authenticate_as(:'a_manager');
select throws_ok(format('select public.admin_void_bill(%L, %L, false)', :'bill5', ' '), 'P0001', 'REASON_REQUIRED', 'voiding needs a reason');
select is(
  public.admin_void_bill(:'bill5', 'Wrong table', false),
  jsonb_build_object('bill_id', :'bill5'::uuid, 'status', 'void', 'changed', true, 'reopened', false, 'session_id', :'s5'::uuid, 'assigned_waiter_id', null),
  'a bill is voided'
);
select tests.clear_auth();
select results_eq(
  format(
    $f$ select b.status::text, b.void_reason, b.voided_by, b.voided_at is not null, b.payment_status::text,
               (select bool_and(p.is_void) from public.bill_payments p where p.bill_id = b.id),
               (select s.status::text from public.table_sessions s where s.id = b.session_id),
               (select a.reason from public.audit_logs a where a.entity_id = b.id and a.action = 'bill.voided')
        from public.bills b where b.id = %L $f$,
    :'bill5'
  ),
  format($f$ values ('void', 'Wrong table', %L::uuid, true, 'paid', true, 'billed', 'Wrong table') $f$, :'a_manager'),
  'the bill keeps its payment history with payments marked void, and the session stays billed'
);
select tests.authenticate_as(:'a_manager');
select is(
  public.admin_void_bill(:'bill5', 'Again', false) -> 'changed', 'false'::jsonb,
  'voiding a void bill changes nothing'
);
select is(pg_temp.pay(:'bill5', '[{"mode": "cash", "amount_paise": 58800}]'), 'BILL_VOID', 'a void bill takes no payment');
select is(
  public.admin_get_bill(:'bill5') -> 'reopen' -> 'blocker', '"void"'::jsonb,
  'a void bill cannot be reopened'
);

-- ─── Reopen restores the waiter; the number is never reused ────────────────
select is(
  (select jsonb_build_array(r -> 'reopen' -> 'allowed', r -> 'reopen' -> 'blocker', r -> 'bill' -> 'waiter_name', jsonb_array_length(r -> 'audit') >= 1)
   from public.admin_get_bill(:'bill6') as r),
  '[true, null, "Ravi", true]'::jsonb,
  'an active bill inside the window can be reopened'
);
select is(
  public.admin_void_bill(:'bill6', 'Guests ordered dessert', true),
  jsonb_build_object('bill_id', :'bill6'::uuid, 'status', 'void', 'changed', true, 'reopened', true, 'session_id', :'s6'::uuid, 'assigned_waiter_id', :'w_ravi'::uuid),
  'voiding with reopen opens the table again with its waiter'
);
select tests.clear_auth();
select results_eq(
  format(
    $f$ select s.status::text, s.billed_at, s.assigned_waiter_id,
               (select count(*) from public.session_waiter_assignments a where a.session_id = s.id and a.unassigned_at is null),
               (select jsonb_agg(a.action order by a.action) from public.audit_logs a
                where a.entity_id = s.id
                  and (a.action = 'session.reopened' or a.after ->> 'via' = 'reopen'))
        from public.table_sessions s where s.id = %1$L $f$,
    :'s6'
  ),
  format($f$ values ('open', null::timestamptz, %L::uuid, 1::bigint, '["session.reopened", "waiter.assigned"]'::jsonb) $f$, :'w_ravi'),
  'the session is open, unbilled, back with Ravi, and the reopen is audited'
);

select tests.authenticate_as(:'a_manager');
select public.admin_generate_bill(:'s6', 'none', 0, null, false) ->> 'bill_id' as bill6_again \gset
select tests.clear_auth();
select is(
  (select jsonb_agg(jsonb_build_array(status, invoice_seq) order by invoice_seq)
   from public.bills where session_id = :'s6'),
  (select jsonb_build_array(
     jsonb_build_array('void', (select invoice_seq from public.bills where id = :'bill6')),
     jsonb_build_array('active', (select max(invoice_seq) from public.bills where restaurant_id = :'rest_a'))
   )),
  'the regenerated bill gets a new number and the void one keeps its own'
);
select cmp_ok(
  (select invoice_seq from public.bills where id = :'bill6_again'), '>',
  (select invoice_seq from public.bills where id = :'bill10'),
  'the new number comes after every earlier bill'
);

-- An off-duty waiter isn't brought back.
update public.waiters set on_duty = false where id = :'w_ravi';
select tests.authenticate_as(:'a_manager');
select is(
  public.admin_void_bill(:'bill6_again', 'Split the bill differently', true) -> 'assigned_waiter_id', 'null'::jsonb,
  'an off-duty waiter is not restored'
);
select tests.clear_auth();
select is(
  (select assigned_waiter_id from public.table_sessions where id = :'s6'), null,
  'the reopened table is Unassigned'
);

-- A busy waiter isn't brought back: Anita (limit 1) takes table 11 first.
select pg_temp.open_session(pg_temp.table_id('11')) as s11 \gset
select tests.authenticate_as(:'a_manager');
select public.admin_assign_waiter(:'s11', :'w_anita');
select is(
  public.admin_void_bill(:'bill8', 'Wrong dishes', true) -> 'assigned_waiter_id', 'null'::jsonb,
  'a waiter at their table limit is not restored'
);

-- ─── Reopen refused ─────────────────────────────────────────────────────────
-- Table 10 has new guests.
select tests.clear_auth();
select pg_temp.open_session(pg_temp.table_id('10')) as s10_next \gset
select tests.authenticate_as(:'a_manager');
select is(
  public.admin_get_bill(:'bill10') -> 'reopen' -> 'blocker', '"table_busy"'::jsonb,
  'bill detail says the table has new guests'
);
select is(
  pg_temp.error_of(format('select public.admin_void_bill(%L, %L, true)', :'bill10', 'Add a dish')),
  'REOPEN_NOT_ALLOWED table_busy', 'a table with new guests cannot be reopened'
);
select tests.clear_auth();
select is(
  (select status::text from public.bills where id = :'bill10'), 'active',
  'a refused reopen voids nothing'
);

-- Table 9's bill is older than the window.
update public.bills set generated_at = now() - interval '31 minutes' where id = :'bill9';
select tests.authenticate_as(:'a_manager');
select is(
  pg_temp.error_of(format('select public.admin_void_bill(%L, %L, true)', :'bill9', 'Add a dish')),
  'REOPEN_NOT_ALLOWED window', 'the reopen window has passed'
);
select lives_ok(
  format('select public.admin_void_bill(%L, %L, false)', :'bill9', 'Entered twice'),
  'outside the window a bill can still be voided without reopening'
);

-- Table 7 was switched off after billing.
select tests.clear_auth();
update public.dining_tables set is_active = false where id = pg_temp.table_id('7');
select tests.authenticate_as(:'a_manager');
select is(
  public.admin_get_bill(:'bill7') -> 'reopen' -> 'blocker', '"table_inactive"'::jsonb,
  'bill detail says the table is switched off'
);
select is(
  pg_temp.error_of(format('select public.admin_void_bill(%L, %L, true)', :'bill7', 'Add a dish')),
  'REOPEN_NOT_ALLOWED table_inactive', 'a switched-off table cannot be reopened'
);
select tests.clear_auth();
update public.dining_tables set is_active = true where id = pg_temp.table_id('7');

-- No reopen window at all.
select tests.clear_auth();
update public.restaurants set reopen_window_minutes = 0 where id = :'rest_a';
select tests.authenticate_as(:'a_manager');
select is(
  (select jsonb_build_array(r -> 'reopen' -> 'allowed', r -> 'reopen' -> 'blocker', r -> 'reopen' -> 'until')
   from public.admin_get_bill(:'bill7') as r),
  '[false, "window", null]'::jsonb,
  'with the reopen window set to 0, tables are never reopened'
);

-- ─── Read-only, print count, detail shape ───────────────────────────────────
select tests.clear_auth();
select tests.suspend(:'rest_a');
select tests.authenticate_as(:'a_owner');
select is(
  pg_temp.pay(:'bill10', '[{"mode": "upi", "amount_paise": 29400}]'), 'no error',
  'a read-only restaurant still records payments'
);
select is(public.admin_increment_print_count(:'bill10') -> 'print_count', '1'::jsonb, 'printing counts once');
select is(public.admin_increment_print_count(:'bill10') -> 'print_count', '2'::jsonb, 'and again on a reprint');

select public.admin_get_bill(:'bill10') as detail \gset
select is(
  jsonb_build_array(
    :'detail'::jsonb -> 'bill' -> 'print_count',
    :'detail'::jsonb -> 'bill' -> 'payment_status',
    :'detail'::jsonb -> 'bill' -> 'generated_by_name',
    :'detail'::jsonb -> 'bill' -> 'waiter_name',
    :'detail'::jsonb -> 'payments' -> 0 -> 'recorded_by_name',
    :'detail'::jsonb -> 'session' -> 'status',
    (select jsonb_agg(a -> 'action') from jsonb_array_elements(:'detail'::jsonb -> 'audit') as a
     where a ->> 'action' in ('bill.generated', 'payment.recorded')),
    :'detail'::jsonb -> 'print' -> 'upi'
  ),
  '[2, "paid", "A_manager", "Anita", "A_owner", "billed", ["bill.generated", "payment.recorded"], null]'::jsonb,
  'bill detail has the document, payments with names, the audit trail and print options'
);

select * from finish();
rollback;
