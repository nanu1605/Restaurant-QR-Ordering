-- Activity logs (spec §19 Phase 6, §10.8): voids and discounts, removed
-- dishes (partial removals included) and deleted orders, with who did it,
-- their role and why. The rows come from real removals, bills and voids
-- (docs/DECISIONS.md P6-8, P6-9).
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ─── Fixtures ───────────────────────────────────────────────────────────────
select tests.create_restaurant('p6-290-a') as rest_a \gset
select tests.create_restaurant('p6-290-c') as rest_c \gset
select tests.set_plan(:'rest_c', 'starter');
select tests.add_member(:'rest_a', 'manager', 'a_manager') as a_manager \gset
select tests.add_member(:'rest_a', 'waiter', 'a_waiter') as a_waiter \gset
select tests.add_member(:'rest_c', 'owner', 'c_owner') as c_owner \gset
select tests.add_waiter(:'rest_a', 'Ravi', :'a_waiter') as w_ravi \gset

select tests.create_ordering_fixture(:'rest_a', 'P6290A0000TABLE5') as fx \gset
select :'fx'::jsonb ->> 'table' as table5 \gset

insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
values (:'rest_a', '6', 'P6290A0000TABLE6', 6), (:'rest_a', '7', 'P6290A0000TABLE7', 7);
select
  (select id from public.dining_tables where qr_token = 'P6290A0000TABLE6') as table6,
  (select id from public.dining_tables where qr_token = 'P6290A0000TABLE7') as table7
\gset

update public.restaurants
set gst_mode = 'none', staff_can_remove_served_items = true
where id = :'rest_a';

create function pg_temp.open_session(p_table uuid)
returns uuid
language sql
as $$
  insert into public.table_sessions (
    restaurant_id, dining_table_id, table_label_snapshot, is_approved, approved_at,
    assigned_waiter_id
  )
  select t.restaurant_id, t.id, t.label, true, now() - interval '1 hour',
         (select w.id from public.waiters w where w.restaurant_id = t.restaurant_id limit 1)
  from public.dining_tables t
  where t.id = p_table
  returning id;
$$;

-- A served round of Paneer Tikka; returns the dish row's id.
create function pg_temp.served_round(p_session uuid, p_quantity int)
returns uuid
language plpgsql
as $$
declare
  v_session public.table_sessions;
  v_order uuid;
  v_item uuid;
begin
  select * into v_session from public.table_sessions where id = p_session;
  insert into public.orders (
    restaurant_id, session_id, round_number, status, placed_via, idempotency_key
  )
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
  select v_session.restaurant_id, v_order, p_session, i.id, i.name, i.food_type, 28000,
         p_quantity, 'served'
  from public.menu_items i
  where i.restaurant_id = v_session.restaurant_id and i.name = 'Paneer Tikka'
  returning id into v_item;
  return v_item;
end;
$$;

create function pg_temp.order_of(p_item uuid)
returns uuid
language sql
as $$
  select order_id from public.order_items where id = p_item;
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

create function pg_temp.activity(p_filters jsonb)
returns jsonb
language sql
as $$
  select public.admin_report_activity(p_filters);
$$;

select pg_temp.open_session(:'table5') as s5 \gset
select pg_temp.served_round(:'s5', 4) as item5 \gset
select pg_temp.open_session(:'table6') as s6 \gset
select pg_temp.served_round(:'s6', 2) as item6 \gset
select pg_temp.open_session(:'table7') as s7 \gset
select pg_temp.served_round(:'s7', 1) as item7 \gset
select pg_temp.served_round(:'s7', 3) as item7b \gset

-- ─── Real activity ──────────────────────────────────────────────────────────
select tests.authenticate_as(:'a_manager');

-- Table 5: one of four dishes sent back, then billed with a discount.
select public.staff_remove_item(:'item5', 1, 'Guest changed their mind');
select public.admin_generate_bill(:'s5', 'percent', 1000, 'Regular guest', false) ->> 'bill_id' as bill5 \gset
select (public.admin_get_bill(:'bill5'::uuid) -> 'bill' ->> 'invoice_number') as invoice5 \gset

-- Table 6: billed, then voided without reopening.
select public.admin_generate_bill(:'s6', 'none', 0, null, false) ->> 'bill_id' as bill6 \gset
select public.admin_void_bill(:'bill6'::uuid, 'Wrong table', false);

-- Table 7: the whole second round deleted, and a served dish removed.
select public.admin_remove_order(pg_temp.order_of(:'item7b'), 'Kitchen ran out');
select public.staff_remove_item(:'item7', 1, 'Spilled');

-- ─── Voids and discounts ────────────────────────────────────────────────────
select pg_temp.activity('{"kind": "voids_discounts"}') as voids \gset

select is(
  (:'voids'::jsonb) -> 'total',
  '2'::jsonb,
  'the void and the discount are both listed'
);
select is(
  (
    select jsonb_agg(
      r - 'at' - 'bill_id' - 'total_paise' order by r ->> 'kind'
    )
    from jsonb_array_elements((:'voids'::jsonb) -> 'rows') as r
  ),
  format($json$
    [
      {"kind": "discount", "invoice_number": "%1$s", "table_label": "5", "bill_status": "active",
       "amount_paise": 8400, "discount_type": "percent", "discount_value": 1000,
       "reopened": null, "actor_name": "A_manager", "actor_role": "manager",
       "reason": "Regular guest"},
      {"kind": "void", "invoice_number": "%2$s", "table_label": "6", "bill_status": "void",
       "amount_paise": 56000, "discount_type": null, "discount_value": null, "reopened": false,
       "actor_name": "A_manager", "actor_role": "manager", "reason": "Wrong table"}
    ]
  $json$, :'invoice5', 'INV/2026-27/00002')::jsonb,
  'each row carries the invoice, the amount, who did it, their role and why'
);

-- ─── Removed dishes ─────────────────────────────────────────────────────────
select is(
  (
    select jsonb_agg(r - 'at' order by r ->> 'table_label')
    from jsonb_array_elements(pg_temp.activity('{"kind": "removed_items"}') -> 'rows') as r
  ),
  '[{"name": "Paneer Tikka", "variant": null, "quantity": 1, "was_served": true,
     "value_paise": 28000, "table_label": "5", "round_number": 1,
     "actor_name": "A_manager", "actor_role": "manager", "reason": "Guest changed their mind"},
    {"name": "Paneer Tikka", "variant": null, "quantity": 1, "was_served": true,
     "value_paise": 28000, "table_label": "7", "round_number": 1,
     "actor_name": "A_manager", "actor_role": "manager", "reason": "Spilled"}]'::jsonb,
  'a partial removal shows the quantity taken off and what it was worth'
);

-- ─── Deleted orders ─────────────────────────────────────────────────────────
select pg_temp.activity('{"kind": "deleted_orders"}') -> 'rows' -> 0 as deleted \gset
select is(
  (:'deleted'::jsonb) - 'at' - 'items',
  '{"round_number": 2, "table_label": "7", "quantity": 3, "value_paise": 84000,
    "actor_name": "A_manager", "actor_role": "manager", "reason": "Kitchen ran out"}'::jsonb,
  'a deleted round shows its dishes, their value and the reason'
);
select is(
  jsonb_array_length((:'deleted'::jsonb) -> 'items'),
  1,
  'the deleted round lists its dishes'
);

-- ─── Paging, range and plan ─────────────────────────────────────────────────
select is(
  pg_temp.activity('{"kind": "voids_discounts", "page": 2}') -> 'rows',
  '[]'::jsonb,
  'the second page of two rows is empty'
);
select is(
  pg_temp.activity('{"kind": "voids_discounts", "export": true}') -> 'page_size',
  '1000000'::jsonb,
  'an export is not paged'
);
select is(
  jsonb_array_length(
    pg_temp.activity('{"kind": "removed_items", "from": "2026-09-10", "to": "2026-09-10"}') -> 'rows'
  ),
  0,
  'another business day has no removals'
);
select is(
  pg_temp.error_of($$ select public.admin_report_activity('{"kind": "everything"}') $$),
  'INVALID_INPUT kind',
  'an unknown kind is refused'
);

select tests.authenticate_as(:'a_waiter');
select throws_ok(
  $$ select public.admin_report_activity('{"kind": "removed_items"}') $$,
  'P0001', 'FORBIDDEN',
  'waiters cannot read the activity log'
);

select tests.authenticate_as(:'c_owner');
select is(
  pg_temp.error_of($$ select public.admin_report_activity('{}') $$),
  'FEATURE_NOT_IN_PLAN advanced_reports',
  'Starter cannot read the activity log'
);

select * from finish();
rollback;
