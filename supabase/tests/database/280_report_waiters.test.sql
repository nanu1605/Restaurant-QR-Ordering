-- Waiter report (spec §19 Phase 6): tables attended count for the waiter the
-- table was assigned to at billing, so a reassigned table counts once, for
-- whoever billed it. Deleted waiters keep their numbers; Starter cannot open
-- the report (docs/DECISIONS.md P6-7, P6-9).
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ─── Fixtures ───────────────────────────────────────────────────────────────
select tests.create_restaurant('p6-280-a') as rest_a \gset
select tests.create_restaurant('p6-280-c') as rest_c \gset
select tests.set_plan(:'rest_c', 'starter');
select tests.add_member(:'rest_a', 'manager', 'a_manager') as a_manager \gset
select tests.add_member(:'rest_a', 'waiter', 'a_waiter') as a_waiter \gset
select tests.add_member(:'rest_c', 'owner', 'c_owner') as c_owner \gset
select tests.add_waiter(:'rest_a', 'Ravi') as w_ravi \gset
select tests.add_waiter(:'rest_a', 'Suresh') as w_suresh \gset
select tests.add_waiter(:'rest_a', 'Anita') as w_anita \gset
select tests.add_waiter(:'rest_a', 'Deepak', null, false) as w_deepak \gset

update public.restaurants set timezone = 'Asia/Kolkata', business_day_start_hour = 4
where id in (:'rest_a', :'rest_c');

insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
values
  (:'rest_a', '5', 'P6280A0000TABLE5', 5),
  (:'rest_a', '6', 'P6280A0000TABLE6', 6),
  (:'rest_a', '7', 'P6280A0000TABLE7', 7);
select
  (select id from public.dining_tables where qr_token = 'P6280A0000TABLE5') as table5,
  (select id from public.dining_tables where qr_token = 'P6280A0000TABLE6') as table6,
  (select id from public.dining_tables where qr_token = 'P6280A0000TABLE7') as table7
\gset

insert into public.menu_categories (restaurant_id, name, sort_order)
values (:'rest_a', 'Starters', 1);
insert into public.menu_items (restaurant_id, category_id, name, food_type, price_paise)
select :'rest_a', c.id, 'Paneer Tikka', 'veg', 28000
from public.menu_categories c where c.restaurant_id = :'rest_a' and c.name = 'Starters';
select (select id from public.menu_items where restaurant_id = :'rest_a' and name = 'Paneer Tikka') as paneer \gset

-- A billed table with p_rounds accepted rounds of p_items dishes each, billed
-- by p_waiter after p_minutes.
create function pg_temp.served(
  p_table uuid,
  p_waiter uuid,
  p_generated_at timestamptz,
  p_seq int,
  p_total bigint,
  p_minutes int,
  p_rounds int,
  p_items int,
  p_menu_item uuid,
  p_status public.bill_status default 'active'
)
returns uuid
language plpgsql
as $$
declare
  v_table public.dining_tables;
  v_session uuid;
  v_order uuid;
begin
  select * into v_table from public.dining_tables where id = p_table;
  insert into public.table_sessions (
    restaurant_id, dining_table_id, table_label_snapshot, status, is_approved, opened_at,
    billed_at, assigned_waiter_id
  )
  values (
    v_table.restaurant_id, v_table.id, v_table.label, 'billed', true,
    p_generated_at - make_interval(mins => p_minutes), p_generated_at, p_waiter
  )
  returning id into v_session;

  for i in 1 .. p_rounds loop
    insert into public.orders (
      restaurant_id, session_id, round_number, status, placed_via, idempotency_key
    )
    values (
      v_table.restaurant_id, v_session, i, 'accepted', 'customer', gen_random_uuid()::text
    )
    returning id into v_order;

    insert into public.order_items (
      restaurant_id, order_id, session_id, menu_item_id, item_name_snapshot, food_type_snapshot,
      unit_price_paise, quantity, status
    )
    select v_table.restaurant_id, v_order, v_session, p_menu_item, 'Paneer Tikka', 'veg', 28000,
           p_items, 'served';
  end loop;

  -- A round that was rejected, and a cancelled dish: neither is billed.
  insert into public.orders (
    restaurant_id, session_id, round_number, status, placed_via, idempotency_key
  )
  values (
    v_table.restaurant_id, v_session, p_rounds + 1, 'rejected', 'customer', gen_random_uuid()::text
  )
  returning id into v_order;
  insert into public.order_items (
    restaurant_id, order_id, session_id, menu_item_id, item_name_snapshot, food_type_snapshot,
    unit_price_paise, quantity, status
  )
  values (
    v_table.restaurant_id, v_order, v_session, p_menu_item, 'Paneer Tikka', 'veg', 28000, 9, 'cancelled'
  );

  insert into public.bills (
    restaurant_id, session_id, invoice_number, financial_year, invoice_seq, document_type,
    table_label_snapshot, waiter_id, waiter_name_snapshot, line_items, restaurant_snapshot,
    gst_mode, gst_rate_bps, prices_include_tax, subtotal_paise, discount_type, discount_value,
    discount_paise, taxable_paise, total_tax_paise, grand_total_paise, payment_status, status,
    generated_at, void_reason, voided_at
  )
  values (
    v_table.restaurant_id, v_session, 'INV/2026-27/' || lpad(p_seq::text, 5, '0'), '2026-27',
    p_seq, 'tax_invoice', v_table.label, p_waiter,
    (select full_name from public.waiters where id = p_waiter), '[]'::jsonb, '{}'::jsonb,
    'none', 0, false, p_total, 'none', 0, 0, p_total, 0, p_total, 'unpaid', p_status,
    p_generated_at,
    case when p_status = 'void' then 'Wrong table' end,
    case when p_status = 'void' then p_generated_at + interval '10 minutes' end
  );
  return v_session;
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

-- 10 September: Suresh billed table 5 (Ravi started it and handed it over) and
-- table 6; Anita, since deleted, billed table 5 again. Ravi's only bill that
-- day was voided, and his other one is on the 9th.
select pg_temp.served(:'table5', :'w_suresh', '2026-09-10 13:00+05:30', 1, 50000, 75, 2, 2, :'paneer') as s_hand \gset
select pg_temp.served(:'table6', :'w_suresh', '2026-09-10 21:00+05:30', 2, 30000, 45, 1, 1, :'paneer');
select pg_temp.served(:'table5', :'w_anita', '2026-09-10 22:30+05:30', 3, 20000, 75, 1, 1, :'paneer');
select pg_temp.served(:'table6', :'w_ravi', '2026-09-10 15:00+05:30', 4, 90000, 60, 1, 1, :'paneer', 'void');
select pg_temp.served(:'table5', :'w_ravi', '2026-09-09 20:00+05:30', 5, 10000, 60, 1, 1, :'paneer');

-- Table 5 was Ravi's before he handed it to Suresh.
insert into public.session_waiter_assignments (
  restaurant_id, session_id, waiter_id, assigned_at, unassigned_at, unassign_reason
)
values (
  :'rest_a', :'s_hand', :'w_ravi', '2026-09-10 12:00+05:30', '2026-09-10 12:30+05:30', 'reassigned'
);
insert into public.session_waiter_assignments (
  restaurant_id, session_id, waiter_id, assigned_at, unassigned_at, unassign_reason
)
values (
  :'rest_a', :'s_hand', :'w_suresh', '2026-09-10 12:30+05:30', '2026-09-10 13:00+05:30', 'billed'
);

-- Ravi is serving a table right now.
insert into public.table_sessions (
  restaurant_id, dining_table_id, table_label_snapshot, status, is_approved, opened_at,
  assigned_waiter_id
)
values (:'rest_a', :'table7', '7', 'open', true, now() - interval '20 minutes', :'w_ravi');

-- Anita has since been deleted.
update public.waiters set is_active = false, deleted_at = now() where id = :'w_anita';

-- ─── Roles and plan ─────────────────────────────────────────────────────────
select tests.authenticate_as(:'a_waiter');
select throws_ok($$ select public.admin_report_waiters('{}') $$, 'P0001', 'FORBIDDEN', 'waiters cannot open the waiter report');

select tests.authenticate_as(:'c_owner');
select is(
  pg_temp.error_of($$ select public.admin_report_waiters('{}') $$),
  'FEATURE_NOT_IN_PLAN waiter_reports',
  'Starter cannot open the waiter report'
);

-- ─── The report ─────────────────────────────────────────────────────────────
select tests.authenticate_as(:'a_manager');
select public.admin_report_waiters('{"from": "2026-09-10"}') as report \gset

select is(
  :'report'::jsonb -> 'waiters',
  format($json$
    [
      {"waiter_id": "%1$s", "name": "Suresh", "is_active": true, "on_duty": true, "tables": 2,
       "sales_paise": 80000, "minutes": 60, "rounds": 3, "items": 5, "open_tables": 0},
      {"waiter_id": "%2$s", "name": "Anita", "is_active": false, "on_duty": true, "tables": 1,
       "sales_paise": 20000, "minutes": 75, "rounds": 1, "items": 1, "open_tables": 0},
      {"waiter_id": "%3$s", "name": "Deepak", "is_active": true, "on_duty": false, "tables": 0,
       "sales_paise": 0, "minutes": 0, "rounds": 0, "items": 0, "open_tables": 0},
      {"waiter_id": "%4$s", "name": "Ravi", "is_active": true, "on_duty": true, "tables": 0,
       "sales_paise": 0, "minutes": 0, "rounds": 0, "items": 0, "open_tables": 1}
    ]
  $json$, :'w_suresh', :'w_anita', :'w_deepak', :'w_ravi')::jsonb,
  'a reassigned table counts for the waiter who billed it; a voided bill counts for nobody; deleted waiters keep their tables and open tables are counted now'
);

select is(
  (
    select jsonb_agg(d order by (d ->> 'tables')::int desc)
    from jsonb_array_elements(:'report'::jsonb -> 'days') as d
  ),
  format($json$
    [
      {"date": "2026-09-10", "waiter_id": "%1$s", "tables": 2},
      {"date": "2026-09-10", "waiter_id": "%2$s", "tables": 1}
    ]
  $json$, :'w_suresh', :'w_anita')::jsonb,
  'the chart gets tables per waiter per business day'
);

select is(
  (
    select jsonb_agg(w -> 'tables')
    from jsonb_array_elements(
      public.admin_report_waiters('{"from": "2026-09-09", "to": "2026-09-10"}') -> 'waiters'
    ) as w
    where w ->> 'name' = 'Ravi'
  ),
  '[1]'::jsonb,
  'a wider range picks up the earlier business day'
);

select is(
  jsonb_array_length(public.admin_report_waiters('{"from": "2026-09-08"}') -> 'days'),
  0,
  'a day without bills has no chart rows'
);

select * from finish();
rollback;
