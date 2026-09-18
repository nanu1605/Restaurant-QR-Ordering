-- Item, category and table reports (spec §19 Phase 6): dishes merged across
-- rounds, removed, cancelled, rejected and waiting dishes left out, void
-- bills excluded, current names and categories, table turnover
-- (docs/DECISIONS.md P6-3, P6-6, P6-9).
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ─── Fixtures ───────────────────────────────────────────────────────────────
select tests.create_restaurant('p6-270-a') as rest_a \gset
select tests.create_restaurant('p6-270-c') as rest_c \gset
select tests.set_plan(:'rest_c', 'starter');
select tests.add_member(:'rest_a', 'manager', 'a_manager') as a_manager \gset
select tests.add_member(:'rest_a', 'waiter', 'a_waiter') as a_waiter \gset
select tests.add_member(:'rest_c', 'owner', 'c_owner') as c_owner \gset

update public.restaurants set timezone = 'Asia/Kolkata', business_day_start_hour = 4
where id in (:'rest_a', :'rest_c');

insert into public.dining_tables (restaurant_id, label, qr_token, sort_order, is_active)
values
  (:'rest_a', '5', 'P6270A0000TABLE5', 5, true),
  (:'rest_a', '6', 'P6270A0000TABLE6', 6, true),
  (:'rest_a', '7', 'P6270A0000TABLE7', 7, true),
  (:'rest_a', '8', 'P6270A0000TABLE8', 8, false);
select
  (select id from public.dining_tables where qr_token = 'P6270A0000TABLE5') as table5,
  (select id from public.dining_tables where qr_token = 'P6270A0000TABLE6') as table6
\gset

insert into public.menu_categories (restaurant_id, name, sort_order)
values (:'rest_a', 'Starters', 1), (:'rest_a', 'Mains', 2), (:'rest_a', 'Soups', 3);
select
  (select id from public.menu_categories where restaurant_id = :'rest_a' and name = 'Starters') as starters,
  (select id from public.menu_categories where restaurant_id = :'rest_a' and name = 'Mains') as mains,
  (select id from public.menu_categories where restaurant_id = :'rest_a' and name = 'Soups') as soups
\gset

insert into public.menu_items (restaurant_id, category_id, name, food_type, price_paise, sort_order)
values
  (:'rest_a', :'starters', 'Paneer Tikka', 'veg', 28000, 1),
  (:'rest_a', :'starters', 'Butter Chicken', 'non_veg', 28000, 2),
  (:'rest_a', :'soups', 'Tomato Soup', 'veg', 12000, 3);
select
  (select id from public.menu_items where restaurant_id = :'rest_a' and name = 'Paneer Tikka') as paneer,
  (select id from public.menu_items where restaurant_id = :'rest_a' and name = 'Butter Chicken') as chicken,
  (select id from public.menu_items where restaurant_id = :'rest_a' and name = 'Tomato Soup') as soup
\gset

insert into public.menu_item_variants (restaurant_id, menu_item_id, name, price_paise, sort_order)
values (:'rest_a', :'chicken', 'Half', 28000, 1), (:'rest_a', :'chicken', 'Full', 48000, 2);
select
  (select id from public.menu_item_variants where menu_item_id = :'chicken' and name = 'Half') as half,
  (select id from public.menu_item_variants where menu_item_id = :'chicken' and name = 'Full') as full
\gset

-- A billed table visit. p_rounds: [{"status", "items": [{"item", "variant",
-- "qty", "price", "state", "name"}]}]. The bill's total is the billable value.
create function pg_temp.visit(
  p_table uuid,
  p_generated_at timestamptz,
  p_seq int,
  p_rounds jsonb,
  p_status public.bill_status default 'active'
)
returns uuid
language plpgsql
as $$
declare
  v_table public.dining_tables;
  v_session uuid;
  v_order uuid;
  v_round jsonb;
  v_item jsonb;
  v_round_number int := 0;
  v_total bigint := 0;
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

  for v_round in select * from jsonb_array_elements(p_rounds) loop
    v_round_number := v_round_number + 1;
    insert into public.orders (
      restaurant_id, session_id, round_number, status, placed_via, idempotency_key
    )
    values (
      v_table.restaurant_id, v_session, v_round_number,
      (v_round ->> 'status')::public.order_status, 'customer', gen_random_uuid()::text
    )
    returning id into v_order;

    for v_item in select * from jsonb_array_elements(v_round -> 'items') loop
      insert into public.order_items (
        restaurant_id, order_id, session_id, menu_item_id, variant_id, item_name_snapshot,
        variant_name_snapshot, food_type_snapshot, unit_price_paise, quantity, status
      )
      select
        v_table.restaurant_id, v_order, v_session, (v_item ->> 'item')::uuid,
        (v_item ->> 'variant')::uuid,
        coalesce(v_item ->> 'name', m.name),
        (select x.name from public.menu_item_variants x where x.id = (v_item ->> 'variant')::uuid),
        m.food_type, (v_item ->> 'price')::bigint, (v_item ->> 'qty')::int,
        coalesce(v_item ->> 'state', 'served')::public.order_item_status
      from public.menu_items m where m.id = (v_item ->> 'item')::uuid;

      if (v_round ->> 'status') = 'accepted'
        and coalesce(v_item ->> 'state', 'served') in ('placed', 'preparing', 'ready', 'served')
      then
        v_total := v_total + (v_item ->> 'price')::bigint * (v_item ->> 'qty')::int;
      end if;
    end loop;
  end loop;

  insert into public.bills (
    restaurant_id, session_id, invoice_number, financial_year, invoice_seq, document_type,
    table_label_snapshot, line_items, restaurant_snapshot, gst_mode, gst_rate_bps,
    prices_include_tax, subtotal_paise, discount_type, discount_value, discount_paise,
    taxable_paise, total_tax_paise, grand_total_paise, payment_status, status, generated_at,
    void_reason, voided_at
  )
  values (
    v_table.restaurant_id, v_session, 'INV/2026-27/' || lpad(p_seq::text, 5, '0'), '2026-27',
    p_seq, 'tax_invoice', v_table.label, '[]'::jsonb, '{}'::jsonb, 'none', 0, false,
    v_total, 'none', 0, 0, v_total, 0, v_total, 'unpaid', p_status, p_generated_at,
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

-- Table 5 on 10 September: Butter Chicken Half over two rounds (the second
-- round kept the old name), a Paneer Tikka still placed, a cancelled Paneer, a
-- rejected round and a round still waiting for approval.
select pg_temp.visit(:'table5', '2026-09-10 12:00+05:30', 1, format($json$
  [
    {"status": "accepted", "items": [
      {"item": "%1$s", "variant": "%2$s", "qty": 2, "price": 28000},
      {"item": "%3$s", "qty": 1, "price": 28000, "state": "placed"}
    ]},
    {"status": "accepted", "items": [
      {"item": "%1$s", "variant": "%2$s", "qty": 1, "price": 28000, "name": "Butter Chicken (old)"},
      {"item": "%3$s", "qty": 1, "price": 28000, "state": "cancelled"}
    ]},
    {"status": "rejected", "items": [{"item": "%3$s", "qty": 5, "price": 28000, "state": "cancelled"}]},
    {"status": "pending_approval", "items": [{"item": "%3$s", "qty": 2, "price": 28000, "state": "placed"}]}
  ]
$json$, :'chicken', :'half', :'paneer')::jsonb);

-- Table 6 on 10 September: a Full portion and a removed soup.
select pg_temp.visit(:'table6', '2026-09-10 20:00+05:30', 2, format($json$
  [
    {"status": "accepted", "items": [
      {"item": "%1$s", "variant": "%2$s", "qty": 1, "price": 48000},
      {"item": "%3$s", "qty": 2, "price": 12000, "state": "removed"}
    ]}
  ]
$json$, :'chicken', :'full', :'soup')::jsonb);

-- A voided bill on 10 September, and a table on the 9th.
select pg_temp.visit(:'table5', '2026-09-10 22:00+05:30', 3, format($json$
  [{"status": "accepted", "items": [{"item": "%1$s", "qty": 10, "price": 28000}]}]
$json$, :'paneer')::jsonb, 'void');
select pg_temp.visit(:'table6', '2026-09-09 21:00+05:30', 4, format($json$
  [{"status": "accepted", "items": [{"item": "%1$s", "qty": 1, "price": 12000}]}]
$json$, :'soup')::jsonb);

-- The dish is renamed and moved to another category after being billed.
update public.menu_items set name = 'Butter Chicken Special', category_id = :'mains'
where id = :'chicken';

-- ─── Roles and plan ─────────────────────────────────────────────────────────
select tests.authenticate_as(:'a_waiter');
select throws_ok($$ select public.admin_report_items('{}') $$, 'P0001', 'FORBIDDEN', 'waiters cannot see the item report');
select throws_ok($$ select public.admin_report_tables('{}') $$, 'P0001', 'FORBIDDEN', 'waiters cannot see the table report');

select tests.authenticate_as(:'c_owner');
select is(
  pg_temp.error_of($$ select public.admin_report_items('{}') $$),
  'FEATURE_NOT_IN_PLAN advanced_reports',
  'Starter cannot open the item report, not even for today'
);
select is(
  pg_temp.error_of($$ select public.admin_report_tables('{}') $$),
  'FEATURE_NOT_IN_PLAN advanced_reports',
  'Starter cannot open the table report'
);

-- ─── Items ──────────────────────────────────────────────────────────────────
select tests.authenticate_as(:'a_manager');
select public.admin_report_items('{"from": "2026-09-10"}') as items \gset

select is(
  :'items'::jsonb -> 'items',
  format($json$
    [
      {"menu_item_id": "%1$s", "variant_id": "%2$s", "name": "Butter Chicken Special",
       "variant": "Half", "food_type": "non_veg", "category": "Mains", "qty": 3,
       "revenue_paise": 84000},
      {"menu_item_id": "%1$s", "variant_id": "%3$s", "name": "Butter Chicken Special",
       "variant": "Full", "food_type": "non_veg", "category": "Mains", "qty": 1,
       "revenue_paise": 48000},
      {"menu_item_id": "%4$s", "variant_id": null, "name": "Paneer Tikka", "variant": null,
       "food_type": "veg", "category": "Starters", "qty": 1, "revenue_paise": 28000}
    ]
  $json$, :'chicken', :'half', :'full', :'paneer')::jsonb,
  'dishes merge across rounds under their current name, by revenue; removed, cancelled, rejected, waiting and voided dishes are left out'
);

select is(
  :'items'::jsonb -> 'categories',
  format($json$
    [
      {"category_id": "%1$s", "name": "Mains", "qty": 4, "revenue_paise": 132000, "dishes": 1},
      {"category_id": "%2$s", "name": "Starters", "qty": 1, "revenue_paise": 28000, "dishes": 1}
    ]
  $json$, :'mains', :'starters')::jsonb,
  'categories follow the dish''s current category'
);

select is(
  public.admin_report_items('{"from": "2026-09-09"}') -> 'items' -> 0 -> 'name',
  '"Tomato Soup"'::jsonb,
  'another business day has its own dishes'
);
select is(
  public.admin_report_items('{"from": "2026-09-08"}') -> 'items',
  '[]'::jsonb,
  'a day without bills has no dishes'
);

-- ─── Tables ─────────────────────────────────────────────────────────────────
select public.admin_report_tables('{"from": "2026-09-10"}') as turnover \gset

select is(
  (
    select jsonb_agg(t - 'table_id')
    from jsonb_array_elements(:'turnover'::jsonb -> 'tables') as t
  ),
  '[{"label": "5", "is_active": true, "sessions": 1, "minutes": 75, "total_paise": 112000, "average_paise": 112000},
    {"label": "6", "is_active": true, "sessions": 1, "minutes": 75, "total_paise": 48000, "average_paise": 48000},
    {"label": "7", "is_active": true, "sessions": 0, "minutes": 0, "total_paise": 0, "average_paise": 0}]'::jsonb,
  'tables are listed busiest first, with quiet tables at zero and the voided bill left out'
);

select is(
  :'turnover'::jsonb -> 'overall',
  '{"sessions": 2, "minutes": 75, "total_paise": 160000, "tables": 3, "per_table": 0.67}'::jsonb,
  'turnover counts the sessions per active table'
);

select * from finish();
rollback;
