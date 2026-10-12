-- The customer orders page and self-cancellation (spec §9.3 customer_get_session,
-- customer_cancel_item; §10.3; §13.1 Orders page).
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

select tests.create_restaurant('alpha') as rest_a \gset
select tests.create_ordering_fixture(:'rest_a', 'ALPHA0000TABLE05') as fx \gset
select
  :'fx'::jsonb ->> 'simple' as simple,
  :'fx'::jsonb ->> 'variant_item' as variant_item,
  :'fx'::jsonb ->> 'full' as full
\gset
insert into public.dining_tables (restaurant_id, label, qr_token)
values (:'rest_a', '6', 'ALPHA0000TABLE06');

\set d1 '11111111-1111-4111-8111-111111111111'
\set d2 '22222222-2222-4222-8222-222222222222'
\set d3 '33333333-3333-4333-8333-333333333333'

-- The error code of a failed cancellation, or 'no error'.
create function pg_temp.cancel_error(p_token text, p_device text, p_item uuid)
returns text
language plpgsql
as $$
begin
  perform public.customer_cancel_item(p_token, p_device, p_item);
  return 'no error';
exception when others then
  return sqlerrm;
end;
$$;

select ok(
  has_function_privilege('service_role', 'public.customer_get_session(text, text)', 'execute')
    and has_function_privilege('service_role', 'public.customer_cancel_item(text, text, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.customer_get_session(text, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.customer_cancel_item(text, text, uuid)', 'execute'),
  'only the server can read sessions and cancel dishes for customers'
);

-- ─── Two phones at one table ────────────────────────────────────────────────
select tests.as_service_role();
select public.customer_place_order(
  'ALPHA0000TABLE05', :'d1', 'session-order-1',
  jsonb_build_array(tests.line(:'simple', 2), tests.line(:'variant_item', 1, :'full'))
) as r1 \gset
select public.customer_place_order(
  'ALPHA0000TABLE05', :'d2', 'session-order-2', jsonb_build_array(tests.line(:'simple'))
) as r2 \gset

select tests.clear_auth();
select id as i_simple from public.order_items
  where order_id = (:'r1'::jsonb ->> 'order_id')::uuid and variant_id is null \gset
select id as i_full from public.order_items
  where order_id = (:'r1'::jsonb ->> 'order_id')::uuid and variant_id is not null \gset
select id as i_other from public.order_items where order_id = (:'r2'::jsonb ->> 'order_id')::uuid \gset
select tests.as_service_role();

select public.customer_get_session('ALPHA0000TABLE05', :'d1') as s1 \gset
select results_eq(
  format(
    $f$ select (r ->> 'round_number')::int, (r ->> 'is_mine')::boolean, r ->> 'status'
        from jsonb_array_elements(%L::jsonb -> 'session' -> 'rounds') r $f$,
    :'s1'
  ),
  $$ values (1, true, 'pending_approval'), (2, false, 'pending_approval') $$,
  'every round at the table is listed, marked as this phone''s or not'
);
select is(
  (
    select count(*)
    from jsonb_array_elements(:'s1'::jsonb -> 'session' -> 'rounds' -> 0 -> 'items') i
    where (i ->> 'cancellable_until')::timestamptz
      = (:'s1'::jsonb -> 'session' -> 'rounds' -> 0 ->> 'placed_at')::timestamptz + interval '120 seconds'
  ),
  2::bigint,
  'this phone''s dishes can be cancelled until 2 minutes after ordering'
);
select is(
  :'s1'::jsonb -> 'session' -> 'rounds' -> 1 -> 'items' -> 0 -> 'cancellable_until',
  'null'::jsonb,
  'another phone''s dishes cannot be cancelled from here'
);
select is(
  :'s1'::jsonb - 'session' - 'now',
  '{"timezone": "Asia/Kolkata", "cancel_window_seconds": 120, "access_state": "full",
    "last_session_billed": false, "bill": null}'::jsonb,
  'settings for the page come along'
);
select is(
  :'s1'::jsonb -> 'session' -> 'rounds' -> 0 -> 'items' -> 0 ->> 'variant',
  'Full',
  'dishes show their option'
);
select ok(position(:'rest_a' in :'s1') = 0, 'the restaurant id is not exposed');

select is(
  (
    select count(*)
    from jsonb_array_elements(
      public.customer_get_session('ALPHA0000TABLE05', null) -> 'session' -> 'rounds'
    ) r
    where (r ->> 'is_mine')::boolean
  ),
  0::bigint,
  'without a device cookie nothing is marked as this phone''s'
);
select is(
  public.customer_get_session('ALPHA0000TABLE06', :'d1') -> 'session',
  'null'::jsonb,
  'another table''s orders are not visible'
);

-- ─── Cancelling ─────────────────────────────────────────────────────────────
select is(
  pg_temp.cancel_error('ALPHA0000TABLE05', :'d2', :'i_simple'),
  'NOT_YOUR_ITEM', 'a phone cannot cancel another phone''s dish'
);
select is(
  pg_temp.cancel_error('ALPHA0000TABLE06', :'d1', :'i_simple'),
  'NOT_FOUND', 'a dish cannot be cancelled through another table''s QR code'
);
select is(
  pg_temp.cancel_error('ALPHA0000TABLE05', :'d1', gen_random_uuid()),
  'NOT_FOUND', 'an unknown dish is not found'
);
select is(
  public.customer_cancel_item('ALPHA0000TABLE05', :'d1', :'i_simple'),
  jsonb_build_object('order_item_id', :'i_simple', 'status', 'cancelled'),
  'a phone cancels its own dish within the window'
);

select tests.clear_auth();
select results_eq(
  format(
    $f$ select status::text, cancelled_at is not null from public.order_items where id = %L $f$,
    :'i_simple'
  ),
  $$ values ('cancelled', true) $$,
  'the dish is marked cancelled'
);
select results_eq(
  format(
    $f$ select actor_type::text, actor_label, before, after
        from public.audit_logs where action = 'order_item.cancelled' and entity_id = %L $f$,
    :'i_simple'
  ),
  $$ values ('customer', 'Customer (device …1111)',
             '{"status": "placed"}'::jsonb, '{"status": "cancelled"}'::jsonb) $$,
  'the cancellation is audit logged against the device'
);
select tests.as_service_role();

select is(
  pg_temp.cancel_error('ALPHA0000TABLE05', :'d1', :'i_simple'),
  'ITEM_NOT_CANCELLABLE', 'a cancelled dish cannot be cancelled again'
);

select tests.clear_auth();
update public.order_items set status = 'preparing' where id = :'i_full';
select tests.as_service_role();
select is(
  pg_temp.cancel_error('ALPHA0000TABLE05', :'d1', :'i_full'),
  'ITEM_NOT_CANCELLABLE', 'a dish the kitchen has started cannot be cancelled'
);

select tests.clear_auth();
update public.order_items set status = 'placed' where id = :'i_full';
update public.orders set created_at = now() - interval '121 seconds'
  where id = (:'r1'::jsonb ->> 'order_id')::uuid;
select tests.as_service_role();
select is(
  pg_temp.cancel_error('ALPHA0000TABLE05', :'d1', :'i_full'),
  'CANCEL_WINDOW_EXPIRED', 'after the window the dish can no longer be cancelled'
);
select is(
  public.customer_get_session('ALPHA0000TABLE05', :'d1') -> 'session' -> 'rounds' -> 0 -> 'items' -> 0
    -> 'cancellable_until',
  'null'::jsonb,
  'and the page stops offering it'
);

select tests.clear_auth();
update public.orders set created_at = now() where id = (:'r1'::jsonb ->> 'order_id')::uuid;
update public.restaurants set customer_cancel_window_seconds = 0 where id = :'rest_a';
select tests.as_service_role();
select is(
  pg_temp.cancel_error('ALPHA0000TABLE05', :'d1', :'i_full'),
  'CANCEL_WINDOW_EXPIRED', 'a cancel window of 0 turns customer cancellation off'
);
select is(
  public.customer_get_session('ALPHA0000TABLE05', :'d1') -> 'session' -> 'rounds' -> 0 -> 'items' -> 0
    -> 'cancellable_until',
  'null'::jsonb,
  'and nothing is offered for cancelling'
);

select tests.clear_auth();
update public.restaurants set customer_cancel_window_seconds = 120 where id = :'rest_a';
select tests.suspend(:'rest_a');
select tests.as_service_role();
select is(
  pg_temp.cancel_error('ALPHA0000TABLE05', :'d1', :'i_full'),
  'no error', 'customers can still cancel while the restaurant is read-only'
);
select is(
  public.customer_get_session('ALPHA0000TABLE05', :'d1') ->> 'access_state',
  'read_only',
  'the page learns the restaurant is read-only'
);
select tests.clear_auth();
update public.restaurants set status = 'active', suspended_reason = null where id = :'rest_a';

-- ─── Rejected and removed ───────────────────────────────────────────────────
update public.orders set status = 'rejected', reject_reason = 'Nobody at this table'
  where id = (:'r2'::jsonb ->> 'order_id')::uuid;
update public.order_items set status = 'cancelled' where id = :'i_other';
update public.order_items set status = 'removed', removed_reason = 'Complaint'
  where id = :'i_simple';
select tests.as_service_role();
select public.customer_get_session('ALPHA0000TABLE05', :'d1') as s2 \gset
select is(
  :'s2'::jsonb -> 'session' -> 'rounds' -> 1 ->> 'reject_reason',
  'Nobody at this table',
  'a rejected order shows the reason'
);
select is(
  :'s2'::jsonb -> 'session' -> 'rounds' -> 0 -> 'items' -> 1 ->> 'removed_reason',
  'Complaint',
  'a removed dish shows the reason'
);

-- ─── After the bill ─────────────────────────────────────────────────────────
select tests.clear_auth();
update public.table_sessions set status = 'billed', billed_at = now()
  where restaurant_id = :'rest_a' and status = 'open';
select tests.as_service_role();

select public.customer_get_session('ALPHA0000TABLE05', :'d1') as s3 \gset
select is(:'s3'::jsonb -> 'session', 'null'::jsonb, 'a billed session is no longer shown');
select is(
  (:'s3'::jsonb ->> 'last_session_billed')::boolean, true,
  'the phone learns its bill was generated'
);
select is(
  (public.customer_get_session('ALPHA0000TABLE05', :'d2') ->> 'last_session_billed')::boolean, true,
  'every phone that ordered in that session learns it'
);
select is(
  (public.customer_get_session('ALPHA0000TABLE05', :'d3') ->> 'last_session_billed')::boolean, false,
  'a phone that never ordered there does not'
);
select is(
  pg_temp.cancel_error('ALPHA0000TABLE05', :'d1', :'i_full'),
  'NOT_FOUND', 'dishes from a billed session cannot be cancelled'
);

select tests.clear_auth();
update public.table_sessions set billed_at = now() - interval '61 minutes'
  where restaurant_id = :'rest_a' and status = 'billed';
select tests.as_service_role();
select is(
  (public.customer_get_session('ALPHA0000TABLE05', :'d1') ->> 'last_session_billed')::boolean, false,
  'the bill message stops after an hour'
);

select public.customer_place_order(
  'ALPHA0000TABLE05', :'d1', 'session-order-3', jsonb_build_array(tests.line(:'simple'))
) as r3 \gset
select is((:'r3'::jsonb ->> 'round_number')::int, 1, 'the next order starts a fresh session at round 1');
select public.customer_get_session('ALPHA0000TABLE05', :'d1') as s4 \gset
select is(
  jsonb_array_length(:'s4'::jsonb -> 'session' -> 'rounds'),
  1,
  'orders from the previous session are not shown'
);
select is(
  (:'s4'::jsonb ->> 'last_session_billed')::boolean, false,
  'the phone''s latest session is the open one'
);

select * from finish();

rollback;
