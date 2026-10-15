-- Usage analytics (docs/SUPER_ADMIN_PLAN.md 13e, docs/DECISIONS.md SA-61 to
-- SA-64): one definition of a day's usage, the Usage page's report, features
-- in use and the guest's menu language.
begin;
select no_plan();

select tests.create_user('sa620-admin@example.test') as admin_user \gset
select tests.create_platform_admin('sa620-platform@example.test') as admin \gset

-- ─── Guests' orders record the menu's language ──────────────────────────────
select tests.create_restaurant('sa620-order') as order_rest \gset
select tests.create_ordering_fixture(:'order_rest', 'SA620ORDER000TBL') as order_fixture \gset
update public.restaurants set require_first_order_approval = false where id = :'order_rest';
select tests.as_service_role();
select public.customer_place_order('SA620ORDER000TBL', gen_random_uuid()::text, 'sa620-hindi-1',
  jsonb_build_array(tests.line((:'order_fixture'::jsonb ->> 'simple')::uuid)), null, 'hi');
select public.customer_place_order('SA620ORDER000TBL', gen_random_uuid()::text, 'sa620-english',
  jsonb_build_array(tests.line((:'order_fixture'::jsonb ->> 'simple')::uuid)), null, 'en');
select public.customer_place_order('SA620ORDER000TBL', gen_random_uuid()::text, 'sa620-french',
  jsonb_build_array(tests.line((:'order_fixture'::jsonb ->> 'simple')::uuid)), null, 'fr');
select public.customer_place_order('SA620ORDER000TBL', gen_random_uuid()::text, 'sa620-unsaid',
  jsonb_build_array(tests.line((:'order_fixture'::jsonb ->> 'simple')::uuid)));
select tests.clear_auth();
select is(
  array(select coalesce(guest_lang, '-') from public.orders
        where restaurant_id = :'order_rest' order by idempotency_key),
  array['en', '-', 'hi', '-'],
  'an order keeps the menu''s language; anything else, or nothing, is not known'
);

-- ─── Fixtures: three restaurants in early 2020, a time of their own ─────────
select tests.create_restaurant('sa620-a') as rest_a \gset
select tests.create_restaurant('sa620-b') as rest_b \gset
select tests.create_restaurant('sa620-c') as rest_c \gset
update public.restaurants set
  created_at = '2020-01-01 10:00+05:30', timezone = 'Asia/Kolkata', business_day_start_hour = 4,
  city = case slug when 'sa620-a' then 'Indore' when 'sa620-b' then ' indore ' else 'Pune' end,
  state = case slug when 'sa620-a' then 'Madhya Pradesh' when 'sa620-b' then '  '
    else 'Maharashtra' end
where slug in ('sa620-a', 'sa620-b', 'sa620-c');
select tests.set_plan(:'rest_b', 'starter');
-- A and B pay; C is on its trial.
update public.restaurant_subscriptions set status = 'active', source = 'manual'
where restaurant_id in (:'rest_a', :'rest_b');

insert into public.dining_tables (restaurant_id, label, qr_token, sort_order) values
  (:'rest_a', '1', 'SA620A0000TABLE1', 1),
  (:'rest_b', '1', 'SA620B0000TABLE1', 1),
  (:'rest_c', '1', 'SA620C0000TABLE1', 1);
select
  (select id from public.dining_tables where qr_token = 'SA620A0000TABLE1') as table_a,
  (select id from public.dining_tables where qr_token = 'SA620B0000TABLE1') as table_b,
  (select id from public.dining_tables where qr_token = 'SA620C0000TABLE1') as table_c
\gset
insert into public.menu_categories (restaurant_id, name, sort_order)
select id, 'Starters', 1 from public.restaurants where slug in ('sa620-a', 'sa620-b', 'sa620-c');
insert into public.menu_items (restaurant_id, category_id, name, food_type, price_paise, sort_order)
select c.restaurant_id, c.id, 'Paneer Tikka', 'veg', 28000, 1
from public.menu_categories c
join public.restaurants r on r.id = c.restaurant_id
where r.slug in ('sa620-a', 'sa620-b', 'sa620-c');

-- A billed session with one bill, seated p_minutes before it (as 530).
create function pg_temp.sale(
  p_table uuid, p_generated_at timestamptz, p_seq int, p_total bigint, p_discount bigint,
  p_tax bigint, p_payments jsonb default '[]', p_minutes int default 75
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
    restaurant_id, dining_table_id, table_label_snapshot, status, is_approved, opened_at, billed_at
  )
  values (
    v_table.restaurant_id, v_table.id, v_table.label, 'billed', true,
    p_generated_at - make_interval(mins => p_minutes), p_generated_at
  )
  returning id into v_session;
  insert into public.bills (
    restaurant_id, session_id, invoice_number, financial_year, invoice_seq, document_type,
    table_label_snapshot, line_items, restaurant_snapshot, gst_mode, gst_rate_bps,
    prices_include_tax, subtotal_paise, discount_type, discount_value, discount_paise,
    discount_reason, service_charge_bps, service_charge_paise, taxable_paise, cgst_paise,
    sgst_paise, total_tax_paise, round_off_paise, grand_total_paise, payment_status, status,
    generated_at
  )
  values (
    v_table.restaurant_id, v_session, 'INV/2019-20/' || lpad(p_seq::text, 5, '0'), '2019-20',
    p_seq, 'tax_invoice', v_table.label, '[]'::jsonb, '{}'::jsonb, 'regular', 500, false,
    p_total - p_tax + p_discount, 'flat', p_discount, p_discount,
    case when p_discount > 0 then 'Regular' end, 0, 0, p_total - p_tax,
    p_tax / 2, p_tax - p_tax / 2, p_tax, 0, p_total, 'unpaid', 'active', p_generated_at
  )
  returning id into v_bill;
  insert into public.bill_payments (restaurant_id, bill_id, mode, amount_paise)
  select v_table.restaurant_id, v_bill, (p ->> 'mode')::public.payment_mode,
         (p ->> 'amount')::bigint
  from jsonb_array_elements(p_payments) as p;
  return v_session;
end;
$$;

-- A round of orders: p_qty of the dish per item status, from the menu in p_lang.
create function pg_temp.round(
  p_session uuid, p_round int, p_at timestamptz, p_via public.order_placed_via,
  p_status public.order_status default 'accepted', p_items jsonb default '{}',
  p_lang text default null
)
returns uuid
language plpgsql
as $$
declare
  v_order uuid;
  v_dish uuid := (select id from public.menu_items where name = 'Paneer Tikka' and restaurant_id =
    (select restaurant_id from public.table_sessions where id = p_session));
  v_line record;
begin
  insert into public.orders (
    restaurant_id, session_id, round_number, status, placed_via, idempotency_key, created_at,
    guest_lang
  )
  select s.restaurant_id, s.id, p_round, p_status, p_via, 'sa620-' || gen_random_uuid(), p_at,
    p_lang
  from public.table_sessions s where s.id = p_session
  returning id into v_order;
  for v_line in select key, value::int as qty from jsonb_each_text(p_items) loop
    insert into public.order_items (
      restaurant_id, order_id, session_id, menu_item_id, item_name_snapshot,
      food_type_snapshot, unit_price_paise, quantity, status
    )
    select s.restaurant_id, v_order, s.id, v_dish, 'Paneer Tikka', 'veg', 28000, v_line.qty,
           v_line.key::public.order_item_status
    from public.table_sessions s where s.id = p_session;
  end loop;
  return v_order;
end;
$$;

-- A, Monday 10 February: a discounted bill paid in two payments for a table a
-- waiter had; a round from the Hindi menu with an add-on, a staff round and a
-- rejected Hindi round. Tuesday 11th: a card bill.
select pg_temp.sale(:'table_a', '2020-02-10 12:00+05:30', 1, 50000, 5000, 2000,
  '[{"mode": "cash", "amount": 20000}, {"mode": "upi", "amount": 30000}]') as s1 \gset
select tests.add_waiter(:'rest_a', 'Ravi') as waiter_a \gset
update public.bills set waiter_id = :'waiter_a' where session_id = :'s1';
select pg_temp.round(:'s1', 1, '2020-02-10 11:30+05:30', 'customer', 'accepted', '{"served": 2}', 'hi')
  as hindi_order \gset
update public.order_items
set addons_snapshot = '[{"id": "x", "group": "Extras", "name": "Cheese", "price_paise": 3000}]'
where order_id = :'hindi_order';
select pg_temp.round(:'s1', 2, '2020-02-10 11:45+05:30', 'staff', 'accepted', '{"served": 1}');
select pg_temp.round(:'s1', 3, '2020-02-10 11:50+05:30', 'customer', 'rejected', '{"placed": 1}', 'hi');
insert into public.service_requests (restaurant_id, dining_table_id, type, created_at)
values (:'rest_a', :'table_a', 'call_waiter', '2020-02-10 13:00+05:30');
select pg_temp.sale(:'table_a', '2020-02-11 20:00+05:30', 2, 30000, 0, 1000,
  '[{"mode": "card", "amount": 30000}]') as s2 \gset
select pg_temp.round(:'s2', 1, '2020-02-11 19:30+05:30', 'customer', 'accepted', '{"served": 1}');
-- B, Wednesday 12th: a cash bill after 45 minutes, three dishes by staff.
select pg_temp.sale(:'table_b', '2020-02-12 13:00+05:30', 1, 20000, 0, 0,
  '[{"mode": "cash", "amount": 20000}]', 45) as s3 \gset
select pg_temp.round(:'s3', 1, '2020-02-12 12:15+05:30', 'staff', 'accepted', '{"served": 3}');
-- C, only in January.
select pg_temp.sale(:'table_c', '2020-01-20 13:00+05:30', 1, 10000, 0, 0) as s4 \gset
select pg_temp.round(:'s4', 1, '2020-01-20 12:30+05:30', 'customer', 'accepted', '{"served": 1}');

-- A's setup now: a kitchen login, a login in Hindi, UPI QR on bills, and a
-- menu imported from photos by its owner; B has the same but on Starter, a
-- kitchen login that left and an import the team ran.
select tests.add_member(:'rest_a', 'kitchen', 'a_kitchen') as a_kitchen \gset
select tests.add_member(:'rest_a', 'manager', 'a_manager') as a_manager \gset
update public.restaurant_members set ui_lang = 'hi' where user_id = :'a_manager';
select tests.add_member(:'rest_b', 'kitchen', 'b_kitchen') as b_kitchen \gset
update public.restaurant_members set is_active = false where user_id = :'b_kitchen';
update public.restaurants set show_upi_qr_on_bill = true, upi_vpa = 'cafe@upi'
where id in (:'rest_a', :'rest_b');
insert into public.menu_imports (restaurant_id, source, status, page_count, created_by, completed_at)
values
  (:'rest_a', 'photo', 'imported', 1, :'a_manager', '2020-02-15 11:00+05:30'),
  (:'rest_b', 'photo', 'imported', 1, :'admin', '2020-02-15 11:00+05:30');

-- ─── One definition: what the rebuild stores is what the rows say ───────────
select is(private.metrics_usage_rebuild('2020-01-01', '2020-02-29', :'rest_a'), 2, 'A: two days');
select private.metrics_usage_rebuild('2020-01-01', '2020-02-29', :'rest_b');
select private.metrics_usage_rebuild('2020-01-01', '2020-02-29', :'rest_c');
select is(
  array(select row(m.*)::text from public.metrics_usage_daily m
        where m.restaurant_id in (:'rest_a', :'rest_b', :'rest_c')
        order by m.restaurant_id, m.business_day),
  array(select row(r.*)::text from (
    select * from private.metrics_usage_rows('2020-01-01', '2020-02-29', :'rest_a')
    union all select * from private.metrics_usage_rows('2020-01-01', '2020-02-29', :'rest_b')
    union all select * from private.metrics_usage_rows('2020-01-01', '2020-02-29', :'rest_c')
  ) as r order by r.restaurant_id, r.business_day),
  'stored days are exactly the rows'
);
select is(
  (select row(orders, waiter_bills, split_bills, addon_orders, hindi_orders)::text
   from public.metrics_usage_daily where restaurant_id = :'rest_a' and business_day = '2020-02-10'),
  '(2,1,1,1,1)',
  'A''s Monday: a waiter''s bill, a split bill, an order with an add-on, a Hindi order; the rejected one left out'
);
select is(
  (select row(waiter_bills, split_bills, addon_orders, hindi_orders)::text
   from public.metrics_usage_daily where restaurant_id = :'rest_a' and business_day = '2020-02-11'),
  '(0,0,0,0)',
  'A''s Tuesday: none of them'
);

-- ─── The report, for February with January before it ────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_usage_report('2020-02-01', '2020-02-29', true) as feb \gset
select tests.clear_auth();

select is(
  (:'feb'::jsonb -> 'totals') - 'collected',
  jsonb_build_object(
    'restaurants', 3, 'active', 2, 'orders', 4, 'customer_orders', 2, 'staff_orders', 2,
    'items', 7, 'bills', 3, 'gmv_paise', 100000, 'discount_paise', 5000,
    'table_minutes', 65, 'service_requests', 1
  ),
  'totals: rejected orders out, items of billed orders, table time weighted by bills (75, 75, 45)'
);
select is(
  :'feb'::jsonb #> '{totals,collected}',
  '{"cash": 40000, "upi": 30000, "card": 30000, "other": 0}'::jsonb,
  'collected by mode'
);
select is(
  (:'feb'::jsonb -> 'totals') - 'collected' - 'restaurants' - 'discount_paise' - 'table_minutes'
    - 'service_requests',
  (select jsonb_build_object(
     'active', count(distinct restaurant_id) filter (where orders > 0),
     'orders', sum(orders), 'customer_orders', sum(customer_orders),
     'staff_orders', sum(staff_orders), 'items', sum(items), 'bills', sum(bills),
     'gmv_paise', sum(gmv_paise))
   from public.metrics_usage_daily where business_day between '2020-02-01' and '2020-02-29'),
  'totals are the sum of the stored days'
);
select is(
  :'feb'::jsonb -> 'previous',
  '{"active": 1, "orders": 1, "customer_orders": 1, "staff_orders": 0, "items": 1, "bills": 1, "gmv_paise": 10000}'::jsonb,
  'the 29 days before: C in January'
);
select is(
  array[:'feb'::jsonb ->> 'previous_from', :'feb'::jsonb ->> 'previous_to'],
  array['2020-01-03', '2020-01-31'],
  'as many days, just before'
);
select is(
  :'feb'::jsonb -> 'days',
  '[{"day": "2020-02-10", "gmv_paise": 50000, "orders": 2},
    {"day": "2020-02-11", "gmv_paise": 30000, "orders": 1},
    {"day": "2020-02-12", "gmv_paise": 20000, "orders": 1}]'::jsonb,
  'GMV and orders by business day'
);
select is(
  :'feb'::jsonb -> 'hours',
  '[{"weekday": 1, "hour": 11, "orders": 2}, {"weekday": 2, "hour": 19, "orders": 1},
    {"weekday": 3, "hour": 12, "orders": 1}]'::jsonb,
  'orders by weekday and hour'
);

-- Places and plans: blanks trimmed, letters case-folded, no state as unknown.
select is(
  (select jsonb_agg(jsonb_build_object('name', lower(g ->> 'name'), 'restaurants', g -> 'restaurants',
     'active', g -> 'active', 'orders', g -> 'orders', 'gmv_paise', g -> 'gmv_paise'))
   from jsonb_array_elements(:'feb'::jsonb -> 'by_city') as g),
  '[{"name": "indore", "restaurants": 2, "active": 2, "orders": 4, "gmv_paise": 100000},
    {"name": "pune", "restaurants": 1, "active": 0, "orders": 0, "gmv_paise": 0}]'::jsonb,
  'by city: Indore and " indore " together, Pune with nothing'
);
select is(
  (select jsonb_agg(jsonb_build_array(g ->> 'name', g -> 'restaurants', g -> 'gmv_paise'))
   from jsonb_array_elements(:'feb'::jsonb -> 'by_state') as g),
  '[["Madhya Pradesh", 1, 80000], [null, 1, 20000], ["Maharashtra", 1, 0]]'::jsonb,
  'by state: a blank state is not given'
);
select is(
  (select jsonb_agg(jsonb_build_array(g ->> 'code', g -> 'restaurants', g -> 'active', g -> 'gmv_paise'))
   from jsonb_array_elements(:'feb'::jsonb -> 'by_plan') as g),
  '[["growth", 2, 1, 80000], ["starter", 1, 1, 20000]]'::jsonb,
  'by plan, as now'
);

-- Top and bottom.
select is(
  (select array_agg(t ->> 'name' order by o)
   from jsonb_array_elements(:'feb'::jsonb -> 'top_gmv') with ordinality as x(t, o)),
  array[(select name from public.restaurants where id = :'rest_a'),
        (select name from public.restaurants where id = :'rest_b')],
  'top by GMV'
);
select is(
  (select array_agg(t ->> 'id' order by o)
   from jsonb_array_elements(:'feb'::jsonb -> 'bottom_orders') with ordinality as x(t, o)),
  array[:'rest_b', :'rest_a'],
  'bottom by orders, of restaurants with an order; C had none'
);

-- Features in use among active Paid restaurants: A and B.
select is(
  :'feb'::jsonb #> '{features,restaurants}',
  '2'::jsonb,
  'two Paid restaurants had an order'
);
select is(
  :'feb'::jsonb #> '{features,used}',
  '{"kitchen_view": 1, "waiter_assignment": 1, "upi_qr_on_bill": 1, "hindi_staff": 1,
    "hindi_menu": 1, "addons": 1, "service_requests": 1, "discounts": 1, "split_payments": 1,
    "menu_photo_import": 1}'::jsonb,
  'A uses each; B''s kitchen login left, Starter has no UPI QR, and the team ran its import'
);
select is(
  private.restaurant_features(:'rest_a', '2020-02-16', '2020-02-29', '{}'),
  '{"kitchen_view": true, "waiter_assignment": false, "upi_qr_on_bill": true,
    "hindi_staff": true, "hindi_menu": false, "addons": false, "service_requests": false,
    "discounts": false, "split_payments": false, "menu_photo_import": false}'::jsonb,
  'after the import: only what is set up now'
);
update public.restaurant_subscriptions set status = 'past_due', source = 'razorpay'
where restaurant_id = :'rest_b';
select tests.authenticate_as_platform_admin(:'admin');
select is(
  public.platform_usage_report('2020-02-01', '2020-02-29') #> '{features,restaurants}',
  '1'::jsonb,
  'payment failed is not Paid'
);
select is(
  public.platform_usage_report('2020-02-01', '2020-02-29') -> 'previous',
  'null'::jsonb,
  'no previous period unless asked'
);
select tests.clear_auth();

-- A restaurant opened at 1 am belongs to the business day before: counted for
-- 29 February, like its orders.
update public.restaurants set created_at = '2020-03-01 01:00+05:30' where id = :'rest_c';
select tests.authenticate_as_platform_admin(:'admin');
select is(
  public.platform_usage_report('2020-02-01', '2020-02-29') #> '{totals,restaurants}',
  '3'::jsonb,
  'a restaurant counts from its first business day'
);
select tests.clear_auth();
update public.restaurants set created_at = '2020-03-01 04:30+05:30' where id = :'rest_c';
select tests.authenticate_as_platform_admin(:'admin');
select is(
  public.platform_usage_report('2020-02-01', '2020-02-29') #> '{totals,restaurants}',
  '2'::jsonb,
  'and not before it'
);
select tests.clear_auth();

-- ─── Live days ──────────────────────────────────────────────────────────────
-- Each restaurant's last finished day and today are counted as they happen;
-- days before are stored. Measured as what one restaurant's activity adds.
select tests.create_restaurant('sa620-live') as live \gset
select tests.add_member(:'live', 'manager', 'live_manager') as live_manager \gset
update public.restaurants set timezone = 'Asia/Kolkata', business_day_start_hour = 4 where id = :'live';
insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
values (:'live', '1', 'SA620LIVE00TABLE', 1);
select id as table_live from public.dining_tables where qr_token = 'SA620LIVE00TABLE' \gset
insert into public.menu_categories (restaurant_id, name, sort_order) values (:'live', 'Starters', 1);
insert into public.menu_items (restaurant_id, category_id, name, food_type, price_paise, sort_order)
select :'live', c.id, 'Paneer Tikka', 'veg', 28000, 1
from public.menu_categories c where c.restaurant_id = :'live';
select private.business_date(now(), 'Asia/Kolkata', 4) as bd \gset
select b.starts_at + interval '2 hours' as last_at
from private.business_day_bounds(:'bd'::date - 1, :'bd'::date - 1, 'Asia/Kolkata', 4) as b \gset

select tests.authenticate_as_platform_admin(:'admin');
select public.platform_usage_report(:'bd'::date - 2, :'bd') as before \gset
select tests.clear_auth();

-- Stored days: the day before the last finished one counts; a stored copy of
-- the last finished day doesn't (it is counted live).
insert into public.metrics_usage_daily (restaurant_id, business_day, orders, gmv_paise, bills, split_bills, hourly_orders)
values
  (:'live', :'bd'::date - 2, 7, 7000, 1, 1, array_fill(0, array[24])),
  (:'live', :'bd'::date - 1, 99, 99000, 9, 0, array_fill(0, array[24])),
  (:'live', :'bd'::date - 40, 5, 5000, 1, 0, array_fill(0, array[24]));
update public.metrics_usage_daily set addon_orders = 1
where restaurant_id = :'live' and business_day = :'bd'::date - 40;
-- Live: a discounted bill on the last finished day, a split bill now.
select pg_temp.sale(:'table_live', :'last_at', 900, 21000, 1000, 1000,
  '[{"mode": "upi", "amount": 21000}]') as s_last \gset
select pg_temp.round(:'s_last', 1, :'last_at'::timestamptz - interval '30 minutes', 'customer', 'accepted', '{"served": 2}');
select pg_temp.sale(:'table_live', now(), 901, 32000, 0, 1500,
  '[{"mode": "cash", "amount": 12000}, {"mode": "card", "amount": 20000}]', 40) as s_now \gset
select pg_temp.round(:'s_now', 1, now() - interval '20 minutes', 'staff', 'accepted', '{"ready": 1}');

select tests.authenticate_as_platform_admin(:'admin');
select public.platform_usage_report(:'bd'::date - 2, :'bd') as after \gset
select tests.clear_auth();
select is(
  array[
    (:'after'::jsonb #>> '{totals,orders}')::int - (:'before'::jsonb #>> '{totals,orders}')::int,
    (:'after'::jsonb #>> '{totals,bills}')::int - (:'before'::jsonb #>> '{totals,bills}')::int,
    (:'after'::jsonb #>> '{totals,gmv_paise}')::int - (:'before'::jsonb #>> '{totals,gmv_paise}')::int,
    (:'after'::jsonb #>> '{totals,items}')::int - (:'before'::jsonb #>> '{totals,items}')::int,
    (:'after'::jsonb #>> '{totals,discount_paise}')::int - (:'before'::jsonb #>> '{totals,discount_paise}')::int,
    (:'after'::jsonb #>> '{totals,collected,card}')::int - (:'before'::jsonb #>> '{totals,collected,card}')::int
  ],
  array[7 + 1 + 1, 1 + 1 + 1, 7000 + 21000 + 32000, 2 + 1, 1000, 20000],
  'stored to two days ago, then the last finished day and today live; the stored copy of yesterday is ignored'
);
select is(
  (select count(*)::int from private.metrics_usage_rows(:'bd'::date - 2, :'bd', :'live', true)),
  2,
  'live rows: the last finished day and today only'
);

-- A restaurant's live day matches its own reports.
select tests.authenticate_as(:'live_manager');
select public.admin_report_sales('{}') -> 'summary' as live_sales \gset
select public.admin_report_items('{}') as live_items \gset
select public.admin_report_tables('{}') -> 'overall' as live_tables \gset
select tests.clear_auth();
select is(
  (select jsonb_build_object(
     'bills', bills, 'total_paise', gmv_paise, 'discount_paise', discount_paise,
     'tax_paise', tax_paise, 'items', items, 'minutes', avg_session_minutes,
     'collected', jsonb_build_object('cash', paid_cash_paise, 'upi', paid_upi_paise,
                                     'card', paid_card_paise, 'other', paid_other_paise))
   from private.metrics_usage_rows(:'bd', :'bd', :'live', true)),
  jsonb_build_object(
    'bills', :'live_sales'::jsonb -> 'bills', 'total_paise', :'live_sales'::jsonb -> 'total_paise',
    'discount_paise', :'live_sales'::jsonb -> 'discount_paise',
    'tax_paise', :'live_sales'::jsonb -> 'tax_paise',
    'items', (select sum((i ->> 'qty')::int) from jsonb_array_elements(:'live_items'::jsonb -> 'items') as i),
    'minutes', :'live_tables'::jsonb -> 'minutes',
    'collected', :'live_sales'::jsonb -> 'collected'),
  'today counted live matches the restaurant''s sales, items and tables reports'
);

-- Its Usage tab: features in its last 30 finished days.
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_restaurant_usage(:'live') as tab \gset
select tests.clear_auth();
select is(
  array[:'tab'::jsonb ->> 'features_from', :'tab'::jsonb ->> 'features_to'],
  array[(:'bd'::date - 30)::text, (:'bd'::date - 1)::text],
  'the last 30 finished business days'
);
select is(
  (select array_agg(e.key order by e.key) from jsonb_each(:'tab'::jsonb -> 'features') as e
   where e.value = 'true'::jsonb),
  array['discounts', 'split_payments'],
  'a stored split bill and yesterday''s live discount; today''s split and the add-on 40 days ago left out'
);

-- ─── Who may, and the dates ─────────────────────────────────────────────────
select tests.authenticate_as(:'admin_user');
select throws_ok($$select public.platform_usage_report('2020-02-01', '2020-02-29')$$,
  'P0001', 'FORBIDDEN', 'not a platform admin');
select tests.authenticate_as_platform_admin(:'admin', 'aal1');
select throws_ok($$select public.platform_usage_report('2020-02-01', '2020-02-29')$$,
  'P0001', 'MFA_REQUIRED', 'needs the second factor');
select tests.authenticate_as_platform_admin(:'admin');
select throws_ok($$select public.platform_usage_report('2020-02-10', '2020-02-01')$$,
  'P0001', 'INVALID_INPUT', 'the end before the start');
select throws_ok($$select public.platform_usage_report('2019-01-01', '2020-01-03')$$,
  'P0001', 'INVALID_INPUT', 'more than the pages'' 366 days');
select lives_ok($$select public.platform_usage_report('2019-01-01', '2020-01-02', true)$$,
  'the longest range a page sends, compared with the one before');
select tests.as_anon();
select throws_ok($$select public.platform_usage_report('2020-02-01', '2020-02-29')$$,
  '42501', null, 'anon may not');
select tests.clear_auth();
select ok(
  not has_function_privilege('authenticated', 'private.metrics_usage_rows(date, date, uuid, boolean)', 'execute')
    and not has_function_privilege('authenticated', 'private.restaurant_features(uuid, date, date, jsonb)', 'execute'),
  'the helpers are private'
);

select * from finish();
rollback;
