-- Daily snapshots and the shared subscription rules (docs/SUPER_ADMIN_PLAN.md
-- §4.1, §4.4, §5.1, §5.2, §5.10; docs/DECISIONS.md SA-7, SA-9 to SA-11).
begin;
select no_plan();

-- ─── Subscription state (plan §5.1), first match wins ───────────────────────
select is(
  array[
    private.subscription_state('suspended', 'read_only', 'active', 'manual'),
    private.subscription_state('active', 'read_only', 'active', 'manual'),
    private.subscription_state('active', 'full', 'trialing', null),
    private.subscription_state('active', 'full', 'past_due', 'razorpay'),
    private.subscription_state('active', 'full', 'halted', 'razorpay'),
    private.subscription_state('active', 'full', 'active', 'manual'),
    private.subscription_state('active', 'full', 'active', null),
    private.subscription_state('active', 'full', 'cancelled', 'razorpay'),
    private.subscription_state('active', 'full', null, null)
  ],
  array['suspended', 'read_only', 'trial', 'payment_failed', 'payment_failed', 'paid',
        'cancelled', 'cancelled', 'cancelled'],
  'suspended, read-only, trial, payment failed, paid, else cancelled'
);
select
  (select p from public.plans p where code = 'growth') as growth
\gset
select is(
  array[
    private.restaurant_mrr_paise('paid', :'growth'::public.plans, 'monthly'),
    private.restaurant_mrr_paise('paid', :'growth'::public.plans, 'yearly'),
    private.restaurant_mrr_paise('trial', :'growth'::public.plans, 'monthly'),
    private.restaurant_mrr_paise('payment_failed', :'growth'::public.plans, 'monthly')
  ],
  array[
    (:'growth'::public.plans).price_monthly_paise,
    round((:'growth'::public.plans).price_yearly_paise / 12.0)::bigint,
    0::bigint, 0::bigint
  ],
  'MRR: the monthly price, or yearly ÷ 12, only while Paid'
);

-- ─── Usage, counted like the restaurant's own reports ───────────────────────
select tests.create_restaurant('sa-530-a') as rest_a \gset
select tests.add_member(:'rest_a', 'manager', 'a_manager') as a_manager \gset
insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
values (:'rest_a', '5', 'SA530A0000TABLE5', 5);
select id as table_a from public.dining_tables where qr_token = 'SA530A0000TABLE5' \gset
update public.restaurants set timezone = 'Asia/Kolkata', business_day_start_hour = 4
where id = :'rest_a';

-- A billed session with one bill (as 260_report_sales); returns the session.
create function pg_temp.sale(
  p_table uuid, p_generated_at timestamptz, p_seq int, p_total bigint, p_discount bigint,
  p_tax bigint, p_status public.bill_status default 'active', p_payments jsonb default '[]'
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
    p_generated_at - interval '75 minutes', p_generated_at
  )
  returning id into v_session;
  insert into public.bills (
    restaurant_id, session_id, invoice_number, financial_year, invoice_seq, document_type,
    table_label_snapshot, line_items, restaurant_snapshot, gst_mode, gst_rate_bps,
    prices_include_tax, subtotal_paise, discount_type, discount_value, discount_paise,
    discount_reason, service_charge_bps, service_charge_paise, taxable_paise, cgst_paise,
    sgst_paise, total_tax_paise, round_off_paise, grand_total_paise, payment_status, status,
    generated_at, void_reason, voided_at
  )
  values (
    v_table.restaurant_id, v_session, 'INV/2026-27/' || lpad(p_seq::text, 5, '0'), '2026-27',
    p_seq, 'tax_invoice', v_table.label, '[]'::jsonb, '{}'::jsonb, 'regular', 500, false,
    p_total - p_tax + p_discount, 'flat', p_discount, p_discount,
    case when p_discount > 0 then 'Regular' end, 0, 0, p_total - p_tax,
    p_tax / 2, p_tax - p_tax / 2, p_tax, 0, p_total, 'unpaid', p_status, p_generated_at,
    case when p_status = 'void' then 'Wrong table' end,
    case when p_status = 'void' then p_generated_at + interval '10 minutes' end
  )
  returning id into v_bill;
  insert into public.bill_payments (restaurant_id, bill_id, mode, amount_paise, is_void)
  select v_table.restaurant_id, v_bill, (p ->> 'mode')::public.payment_mode,
         (p ->> 'amount')::bigint, p_status = 'void'
  from jsonb_array_elements(p_payments) as p;
  return v_session;
end;
$$;

insert into public.menu_categories (restaurant_id, name, sort_order) values (:'rest_a', 'Starters', 1);
insert into public.menu_items (restaurant_id, category_id, name, food_type, price_paise, sort_order)
select :'rest_a', c.id, 'Paneer Tikka', 'veg', 28000, 1
from public.menu_categories c where c.restaurant_id = :'rest_a';
select id as paneer from public.menu_items where restaurant_id = :'rest_a' \gset

-- A round of orders with one line of p_qty of the dish per item status.
create function pg_temp.round(
  p_session uuid, p_round int, p_at timestamptz, p_via public.order_placed_via,
  p_status public.order_status default 'accepted',
  p_items jsonb default '{}'
)
returns void
language plpgsql
as $$
declare
  v_order uuid;
  v_dish uuid := (select id from public.menu_items where name = 'Paneer Tikka' and restaurant_id =
    (select restaurant_id from public.table_sessions where id = p_session));
  v_line record;
begin
  insert into public.orders (
    restaurant_id, session_id, round_number, status, placed_via, idempotency_key, created_at
  )
  select s.restaurant_id, s.id, p_round, p_status, p_via, 'sa530-' || gen_random_uuid(), p_at
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
end;
$$;

-- Business day 2026-09-10 (4 am to 4 am): two active bills, the second at
-- 1:30 am the next morning, and a void one.
select pg_temp.sale(:'table_a', '2026-09-10 12:00+05:30', 1, 47250, 5000, 2250, 'active',
  '[{"mode": "cash", "amount": 20000}, {"mode": "upi", "amount": 27250}]') as s1 \gset
select pg_temp.sale(:'table_a', '2026-09-11 01:30+05:30', 2, 31500, 0, 1500, 'active',
  '[{"mode": "card", "amount": 31500}]') as s2 \gset
select pg_temp.sale(:'table_a', '2026-09-10 15:00+05:30', 3, 9999, 0, 0, 'void',
  '[{"mode": "cash", "amount": 9999}]') as s3 \gset
select pg_temp.round(:'s1', 1, '2026-09-10 12:05+05:30', 'customer', 'accepted', '{"served": 2, "cancelled": 1}');
select pg_temp.round(:'s1', 2, '2026-09-10 12:40+05:30', 'staff', 'accepted', '{"placed": 1}');
select pg_temp.round(:'s1', 3, '2026-09-10 12:45+05:30', 'customer', 'rejected', '{"placed": 4}');
select pg_temp.round(:'s2', 1, '2026-09-11 00:50+05:30', 'customer', 'accepted', '{"ready": 3}');
insert into public.service_requests (restaurant_id, dining_table_id, type, created_at)
values (:'rest_a', :'table_a', 'call_waiter', '2026-09-10 13:00+05:30');

select is(private.metrics_usage_rebuild('2026-09-09', '2026-09-11', :'rest_a'), 1, 'one business day had activity');
select is(private.metrics_usage_rebuild('2026-09-09', '2026-09-11', :'rest_a'), 1, 'recounting replaces it');

select tests.authenticate_as(:'a_manager');
select public.admin_report_sales('{"from": "2026-09-10", "to": "2026-09-10"}') -> 'summary' as report \gset
select public.admin_report_items('{"from": "2026-09-10", "to": "2026-09-10"}') as items_report \gset
select public.admin_report_tables('{"from": "2026-09-10", "to": "2026-09-10"}') -> 'overall' as tables_report \gset
select tests.clear_auth();
select is(
  (select jsonb_build_object(
     'bills', bills, 'total_paise', gmv_paise, 'discount_paise', discount_paise, 'tax_paise', tax_paise,
     'collected', jsonb_build_object('cash', paid_cash_paise, 'upi', paid_upi_paise,
                                     'card', paid_card_paise, 'other', paid_other_paise))
   from public.metrics_usage_daily where restaurant_id = :'rest_a' and business_day = '2026-09-10'),
  jsonb_build_object(
    'bills', :'report'::jsonb -> 'bills', 'total_paise', :'report'::jsonb -> 'total_paise',
    'discount_paise', :'report'::jsonb -> 'discount_paise', 'tax_paise', :'report'::jsonb -> 'tax_paise',
    'collected', :'report'::jsonb -> 'collected'),
  'bills, sales, discount, tax and payments match the sales report for the day'
);
select is(
  (select row(items, sessions_billed, avg_session_minutes)::text
   from public.metrics_usage_daily where restaurant_id = :'rest_a' and business_day = '2026-09-10'),
  row(
    (select sum((i ->> 'qty')::int) from jsonb_array_elements(:'items_report'::jsonb -> 'items') as i),
    (:'tables_report'::jsonb ->> 'sessions')::int,
    (:'tables_report'::jsonb ->> 'minutes')::int
  )::text,
  'items and table time match the items and tables reports'
);
select is(
  (select items from public.metrics_usage_daily where restaurant_id = :'rest_a' and business_day = '2026-09-10'),
  6,
  'items of accepted rounds, cancelled lines and the rejected round left out'
);
select is(
  (select row(bills, gmv_paise, orders, customer_orders, staff_orders, service_requests,
              sessions_billed, avg_session_minutes)::text
   from public.metrics_usage_daily where restaurant_id = :'rest_a' and business_day = '2026-09-10'),
  row(2, 78750::bigint, 3, 2, 1, 1, 2, 75)::text,
  'the void bill and the rejected order are left out; the 1 am bill and order count for the day'
);
select is(
  (select array[hourly_orders[1], hourly_orders[13], hourly_orders[14]]
   from public.metrics_usage_daily where restaurant_id = :'rest_a' and business_day = '2026-09-10'),
  array[1, 2, 0],
  'orders by the hour they were placed: one at 0:50, two at 12'
);

-- The current business day is still open, so it is not stored.
select pg_temp.sale(:'table_a', now(), 4, 1000, 0, 0) as s_now \gset
select private.metrics_usage_rebuild(current_date - 30, current_date + 1, :'rest_a');
select is(
  (select count(*) from public.metrics_usage_daily
   where restaurant_id = :'rest_a'
     and business_day >= private.business_date(now(), 'Asia/Kolkata', 4)),
  0::bigint,
  'today is never stored'
);

-- ─── Subscription and platform snapshots ────────────────────────────────────
-- A day of its own, so other restaurants in the database don't count.
select tests.create_restaurant('sa-530-paid') as rest_paid \gset
select tests.create_restaurant('sa-530-signup') as rest_signup \gset
update public.restaurants set created_at = '2020-01-05 10:00+05:30' where id in (:'rest_paid', :'rest_signup');
update public.restaurant_subscriptions
set status = 'active', source = 'manual', billing_cycle = 'yearly',
    current_period_start = now() - interval '1 day', current_period_end = now() + interval '300 days'
where restaurant_id = :'rest_paid';
insert into public.trial_claims (kind, value, restaurant_id) values ('fssai', '29999999999530', :'rest_signup');
insert into public.site_leads (name, restaurant_name, city, phone, created_at)
values ('Lead', 'Lead Cafe', 'Indore', '9000000530', '2020-01-05 09:00+05:30');
insert into public.site_signups (email, details, code_hash, created_at)
values ('one@example.test', '{}', repeat('a', 64), '2020-01-05 11:00+05:30'),
       ('One@example.test', '{}', repeat('b', 64), '2020-01-05 11:20+05:30');

select tests.as_service_role();
select public.platform_metrics_snapshot('2020-01-05') ->> 'subscriptions' as first_run \gset
select is(
  (select array_agg(row(restaurant_id = :'rest_paid', state, mrr_paise)::text order by state)
   from public.metrics_subscription_daily where day = '2020-01-05'),
  array[
    row(true, 'paid', round((:'growth'::public.plans).price_yearly_paise / 12.0)::bigint)::text,
    row(false, 'trial', 0::bigint)::text
  ],
  'each restaurant that existed that day, with its state and MRR'
);
select is(:'first_run'::int, 2, 'two rows stored');
select is(
  public.platform_metrics_snapshot('2020-01-05') ->> 'subscriptions', '0',
  'running it again for the day stores nothing more'
);
select is(
  (select row(signups_started, signups_completed, restaurants_onboarded, leads_created,
              website_visitors)::text
   from public.metrics_platform_daily where day = '2020-01-05'),
  row(1, 1, 1, 1, null::int)::text,
  'signups started (by email, so a restart counts once) and completed, restaurants onboarded by the team, leads'
);
select throws_ok(
  $$ select public.platform_metrics_backfill_usage('2024-01-01', '2026-01-01') $$,
  'P0001', 'INVALID_INPUT', 'backfill runs in ranges of up to 400 days'
);
select tests.clear_auth();

-- ─── Who can read and run them ──────────────────────────────────────────────
select ok(
  not has_function_privilege('authenticated', 'public.platform_metrics_snapshot(date)', 'execute')
    and not has_function_privilege('authenticated', 'public.platform_metrics_backfill_usage(date, date)', 'execute')
    and has_function_privilege('service_role', 'public.platform_metrics_snapshot(date)', 'execute'),
  'only the server runs the snapshot and the backfill'
);
select tests.create_platform_admin('platform@admin.test') as admin \gset
select tests.authenticate_as_platform_admin(:'admin');
select ok((select count(*) from public.metrics_subscription_daily where day = '2020-01-05') = 2,
  'platform admins read the snapshots');
select is(
  (public.platform_overview() ->> 'history_starts_on')::date,
  (select min(day) from public.metrics_subscription_daily),
  'the overview says when MRR history starts'
);
select tests.authenticate_as(:'a_manager');
select is((select count(*) from public.metrics_usage_daily), 0::bigint, 'restaurants don''t see them');
select throws_ok(
  $$ insert into public.cron_runs (job, step, started_at, finished_at, ok) values ('x', 'y', now(), now(), true) $$,
  '42501', null, 'nor write them'
);
select tests.clear_auth();

select * from finish();
rollback;
