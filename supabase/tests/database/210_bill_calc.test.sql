-- Bill maths (spec §11, §11.1 worked examples, §11.2 financial year) and the
-- lines a session bills (§10.5; docs/DECISIONS.md P5-1…P5-3, P5-17).
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ─── §11.1 worked examples ──────────────────────────────────────────────────
-- Paneer Tikka ₹280 × 1, Butter Naan ₹60 × 3, Dal Makhani ₹240 × 1 = 70000.
create function pg_temp.totals(
  p_discount_type public.discount_type,
  p_discount_value bigint,
  p_apply_sc boolean,
  p_sc_bps int,
  p_gst_mode public.gst_mode,
  p_inclusive boolean
)
returns jsonb
language sql
as $$
  select private.calc_bill_totals(
    70000, p_discount_type, p_discount_value, p_apply_sc, p_sc_bps, p_gst_mode, 500, p_inclusive
  );
$$;

select is(
  pg_temp.totals('percent', 1000, false, 0, 'regular', false),
  jsonb_build_object(
    'subtotal_paise', 70000, 'discount_paise', 7000, 'service_charge_paise', 0,
    'taxable_paise', 63000, 'cgst_paise', 1575, 'sgst_paise', 1575, 'total_tax_paise', 3150,
    'pre_round_paise', 66150, 'round_off_paise', 50, 'grand_total_paise', 66200
  ),
  'case A: regular 5% exclusive with 10% discount'
);

select is(
  pg_temp.totals('percent', 1000, false, 0, 'regular', true),
  jsonb_build_object(
    'subtotal_paise', 70000, 'discount_paise', 7000, 'service_charge_paise', 0,
    'taxable_paise', 60000, 'cgst_paise', 1500, 'sgst_paise', 1500, 'total_tax_paise', 3000,
    'pre_round_paise', 63000, 'round_off_paise', 0, 'grand_total_paise', 63000
  ),
  'case B: regular 5% inclusive with 10% discount'
);

select is(
  pg_temp.totals('percent', 1000, false, 0, 'composition', false),
  jsonb_build_object(
    'subtotal_paise', 70000, 'discount_paise', 7000, 'service_charge_paise', 0,
    'taxable_paise', 63000, 'cgst_paise', 0, 'sgst_paise', 0, 'total_tax_paise', 0,
    'pre_round_paise', 63000, 'round_off_paise', 0, 'grand_total_paise', 63000
  ),
  'case C: composition charges no tax'
);

select is(
  pg_temp.totals('percent', 1000, true, 500, 'regular', false),
  jsonb_build_object(
    'subtotal_paise', 70000, 'discount_paise', 7000, 'service_charge_paise', 3150,
    'taxable_paise', 66150, 'cgst_paise', 1654, 'sgst_paise', 1654, 'total_tax_paise', 3308,
    'pre_round_paise', 69458, 'round_off_paise', 42, 'grand_total_paise', 69500
  ),
  'case D: service charge is part of the taxable value'
);

select is(
  pg_temp.totals('none', 0, false, 0, 'none', false),
  jsonb_build_object(
    'subtotal_paise', 70000, 'discount_paise', 0, 'service_charge_paise', 0,
    'taxable_paise', 70000, 'cgst_paise', 0, 'sgst_paise', 0, 'total_tax_paise', 0,
    'pre_round_paise', 70000, 'round_off_paise', 0, 'grand_total_paise', 70000
  ),
  'case E: no tax, no discount'
);

select is(
  pg_temp.totals('flat', 100000, false, 0, 'regular', false),
  jsonb_build_object(
    'subtotal_paise', 70000, 'discount_paise', 70000, 'service_charge_paise', 0,
    'taxable_paise', 0, 'cgst_paise', 0, 'sgst_paise', 0, 'total_tax_paise', 0,
    'pre_round_paise', 0, 'round_off_paise', 0, 'grand_total_paise', 0
  ),
  'case F: a flat discount above the subtotal is capped'
);

-- ─── Edges ──────────────────────────────────────────────────────────────────
-- 66140 × 5% = 3307 → CGST 1653, SGST 1654.
select is(
  (select jsonb_build_array(t -> 'total_tax_paise', t -> 'cgst_paise', t -> 'sgst_paise')
   from private.calc_bill_totals(66140, 'none', 0, false, 0, 'regular', 500, false) as t),
  '[3307, 1653, 1654]'::jsonb,
  'an odd tax splits with the extra paisa on SGST'
);

select is(
  private.calc_bill_totals(70000, 'percent', 10000, true, 1000, 'regular', 500, false)
    -> 'grand_total_paise',
  '0'::jsonb,
  'a 100% discount leaves nothing to charge, service charge included'
);

select is(
  private.calc_bill_totals(0, 'none', 0, false, 0, 'regular', 500, false) -> 'grand_total_paise',
  '0'::jsonb,
  'an empty subtotal totals zero'
);

select is(
  (select jsonb_build_array(t -> 'pre_round_paise', t -> 'round_off_paise', t -> 'grand_total_paise')
   from private.calc_bill_totals(66149, 'none', 0, false, 0, 'none', 0, false) as t),
  '[66149, -49, 66100]'::jsonb,
  'rounding down gives a negative round off'
);

select is(
  private.calc_bill_totals(66150, 'none', 0, false, 0, 'none', 0, false) -> 'grand_total_paise',
  '66200'::jsonb,
  'fifty paise rounds up'
);

select is(
  private.calc_bill_totals(70000, 'none', 0, false, 500, 'none', 0, false)
    -> 'service_charge_paise',
  '0'::jsonb,
  'service charge only applies when asked for'
);

select throws_ok(
  $$ select private.calc_bill_totals(70000, 'percent', 10001, false, 0, 'none', 0, false) $$,
  'P0001', 'INVALID_INPUT', 'a percent discount above 100% is refused'
);
select throws_ok(
  $$ select private.calc_bill_totals(70000, 'flat', -1, false, 0, 'none', 0, false) $$,
  'P0001', 'INVALID_INPUT', 'a negative discount is refused'
);
select throws_ok(
  $$ select private.calc_bill_totals(-1, 'none', 0, false, 0, 'none', 0, false) $$,
  'P0001', 'INVALID_INPUT', 'a negative subtotal is refused'
);

-- ─── Financial year (§11.2) ─────────────────────────────────────────────────
select is(
  private.financial_year('2027-03-31 23:59:59+05:30', 'Asia/Kolkata'), '2026-27',
  '31 March 11:59 pm belongs to the year that started in April'
);
select is(
  private.financial_year('2027-04-01 00:00:00+05:30', 'Asia/Kolkata'), '2027-28',
  '1 April starts the next financial year'
);
select is(
  private.financial_year('2027-03-31 19:00:00+00', 'Asia/Kolkata'), '2027-28',
  'the restaurant timezone decides, not UTC'
);
select is(
  private.financial_year('2099-12-31 12:00:00+05:30', 'Asia/Kolkata'), '2099-00',
  'the century rolls over'
);

-- ─── Lines and pricing ──────────────────────────────────────────────────────
select tests.create_restaurant('p5-210-a') as rest_a \gset
select tests.create_ordering_fixture(:'rest_a', 'P5210A0000TABLE5') as fx \gset
select
  :'fx'::jsonb ->> 'table' as table_5,
  :'fx'::jsonb ->> 'simple' as paneer,
  :'fx'::jsonb ->> 'variant_item' as butter_chicken,
  :'fx'::jsonb ->> 'half' as half,
  :'fx'::jsonb ->> 'full' as full
\gset

insert into public.table_sessions (restaurant_id, dining_table_id, table_label_snapshot, is_approved)
values (:'rest_a', :'table_5', '5', true)
returning id as session \gset

-- Round 1 accepted, round 2 accepted later, round 3 waiting, round 4 rejected,
-- round 5 removed.
insert into public.orders (restaurant_id, session_id, round_number, status, placed_via, idempotency_key)
values
  (:'rest_a', :'session', 1, 'accepted', 'staff', 'p5-210-r1'),
  (:'rest_a', :'session', 2, 'accepted', 'staff', 'p5-210-r2'),
  (:'rest_a', :'session', 3, 'pending_approval', 'customer', 'p5-210-r3'),
  (:'rest_a', :'session', 4, 'rejected', 'customer', 'p5-210-r4'),
  (:'rest_a', :'session', 5, 'removed', 'staff', 'p5-210-r5');

create function pg_temp.round_id(p_round int)
returns uuid
language sql
as $$
  select id from public.orders where idempotency_key = 'p5-210-r' || p_round;
$$;

insert into public.order_items (
  restaurant_id, order_id, session_id, menu_item_id, variant_id, item_name_snapshot,
  variant_name_snapshot, food_type_snapshot, unit_price_paise, quantity, status, created_at
)
values
  -- Round 1: Butter Chicken (Full) first, then Paneer Tikka ×2, a cancelled
  -- Paneer Tikka and a removed Half.
  (:'rest_a', pg_temp.round_id(1), :'session', :'butter_chicken', :'full', 'Butter Chicken', 'Full', 'non_veg', 48000, 1, 'served', now() - interval '30 minutes'),
  (:'rest_a', pg_temp.round_id(1), :'session', :'paneer', null, 'Paneer Tikka', null, 'veg', 28000, 2, 'ready', now() - interval '29 minutes'),
  (:'rest_a', pg_temp.round_id(1), :'session', :'paneer', null, 'Paneer Tikka', null, 'veg', 28000, 1, 'cancelled', now() - interval '29 minutes'),
  (:'rest_a', pg_temp.round_id(1), :'session', :'butter_chicken', :'half', 'Butter Chicken', 'Half', 'non_veg', 28000, 1, 'removed', now() - interval '29 minutes'),
  -- Round 2: another Paneer Tikka (merges), one at an older price (its own
  -- line) and a Half (its own line, first ordered here).
  (:'rest_a', pg_temp.round_id(2), :'session', :'paneer', null, 'Paneer Tikka', null, 'veg', 28000, 1, 'placed', now() - interval '10 minutes'),
  (:'rest_a', pg_temp.round_id(2), :'session', :'paneer', null, 'Paneer Tikka', null, 'veg', 26000, 1, 'preparing', now() - interval '10 minutes'),
  (:'rest_a', pg_temp.round_id(2), :'session', :'butter_chicken', :'half', 'Butter Chicken', 'Half', 'non_veg', 28000, 1, 'served', now() - interval '9 minutes'),
  -- Rounds 3–5 bill nothing.
  (:'rest_a', pg_temp.round_id(3), :'session', :'paneer', null, 'Paneer Tikka', null, 'veg', 28000, 5, 'placed', now()),
  (:'rest_a', pg_temp.round_id(4), :'session', :'paneer', null, 'Paneer Tikka', null, 'veg', 28000, 5, 'cancelled', now()),
  (:'rest_a', pg_temp.round_id(5), :'session', :'paneer', null, 'Paneer Tikka', null, 'veg', 28000, 5, 'removed', now());

select is(
  private.bill_lines(:'rest_a', :'session'),
  jsonb_build_array(
    jsonb_build_object('name', 'Butter Chicken', 'variant', 'Full', 'qty', 1, 'unit_price_paise', 48000, 'line_total_paise', 48000, 'food_type', 'non_veg'),
    jsonb_build_object('name', 'Paneer Tikka', 'variant', null, 'qty', 3, 'unit_price_paise', 28000, 'line_total_paise', 84000, 'food_type', 'veg'),
    jsonb_build_object('name', 'Paneer Tikka', 'variant', null, 'qty', 1, 'unit_price_paise', 26000, 'line_total_paise', 26000, 'food_type', 'veg'),
    jsonb_build_object('name', 'Butter Chicken', 'variant', 'Half', 'qty', 1, 'unit_price_paise', 28000, 'line_total_paise', 28000, 'food_type', 'non_veg')
  ),
  'lines merge the same dish and price, in the order first ordered, and leave out void dishes and rounds'
);

select is(
  private.bill_lines(:'rest_a', gen_random_uuid()), '[]'::jsonb,
  'a session with nothing to bill has no lines'
);

update public.restaurants
set gst_mode = 'regular', gst_rate_bps = 500, prices_include_tax = false,
    service_charge_enabled = false, service_charge_bps = 500
where id = :'rest_a';

select is(
  (select jsonb_build_array(
     p -> 'document_type', p -> 'apply_service_charge', p -> 'service_charge_bps',
     p -> 'discount_value', p -> 'totals' -> 'subtotal_paise', p -> 'totals' -> 'grand_total_paise'
   )
   from private.bill_pricing(
     (select r from public.restaurants r where r.id = :'rest_a'),
     private.bill_lines(:'rest_a', :'session'), 'none', 500, true
   ) as p),
  '["tax_invoice", false, 0, 0, 186000, 195300]'::jsonb,
  'pricing ignores a ticked service charge that settings switch off, and a stray value without a discount'
);

update public.restaurants set service_charge_enabled = true, gst_mode = 'composition' where id = :'rest_a';

select is(
  (select jsonb_build_array(p -> 'document_type', p -> 'service_charge_bps', p -> 'totals' -> 'service_charge_paise')
   from private.bill_pricing(
     (select r from public.restaurants r where r.id = :'rest_a'),
     private.bill_lines(:'rest_a', :'session'), 'none', 0, true
   ) as p),
  '["bill_of_supply", 500, 9300]'::jsonb,
  'composition makes a bill of supply, and an enabled service charge applies'
);

update public.restaurants set gst_mode = 'none' where id = :'rest_a';
select is(
  private.bill_pricing(
    (select r from public.restaurants r where r.id = :'rest_a'), '[]'::jsonb, 'none', 0, false
  ) ->> 'document_type',
  'bill',
  'no GST makes a plain bill'
);

select tests.set_plan(:'rest_a', 'starter');
select throws_ok(
  format(
    $$ select private.bill_pricing((select r from public.restaurants r where r.id = %L), '[]'::jsonb, 'percent', 1000, false) $$,
    :'rest_a'
  ),
  'P0001', 'FEATURE_NOT_IN_PLAN', 'discounts need a plan with the discounts feature'
);
select lives_ok(
  format(
    $$ select private.bill_pricing((select r from public.restaurants r where r.id = %L), '[]'::jsonb, 'none', 0, false) $$,
    :'rest_a'
  ),
  'bills without a discount work on any plan'
);

select * from finish();
rollback;
