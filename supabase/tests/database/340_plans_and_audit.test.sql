-- Plans editor and platform audit log (spec §13.4, docs/DECISIONS.md P7-10,
-- P7-11).
begin;
select no_plan();

select tests.create_platform_admin('platform@admin.test') as admin \gset
select tests.create_restaurant('alpha') as rest_a \gset
select tests.create_restaurant('beta') as rest_b \gset
select tests.add_member(:'rest_a', 'owner', 'a_owner') as a_owner \gset
select id as starter from public.plans where code = 'starter' \gset
select id as pro from public.plans where code = 'pro' \gset

-- ─── Plans editor ───────────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_update_plan(:'starter', '{
  "price_monthly_paise": 44900, "max_tables": 10, "features": {"csv_export": true},
  "razorpay_plan_id_monthly": "plan_Starter123"
}') as updated \gset
select is((:'updated'::jsonb ->> 'price_monthly_paise')::bigint, 44900::bigint, 'price changed');
select is((:'updated'::jsonb ->> 'max_tables')::int, 10, 'table limit changed');
select is(
  :'updated'::jsonb -> 'features',
  '{"kds": false, "discounts": false, "split_payments": false, "upi_qr_on_bill": false,
    "advanced_reports": false, "waiter_reports": false, "csv_export": true,
    "remove_branding": false}'::jsonb,
  'features merged: only csv_export changed'
);
select is(
  (select max_tables from public.restaurant_plan(:'rest_a')), null,
  'a Growth trial keeps its own limits'
);
select is(
  (select row(before, after)::text from public.audit_logs
   where action = 'plan.updated' and entity_id = :'starter'),
  row(
    '{"code": "starter", "max_tables": 8, "price_monthly_paise": 39900,
      "razorpay_plan_id_monthly": null,
      "features": {"kds": false, "discounts": false, "split_payments": false,
        "upi_qr_on_bill": false, "advanced_reports": false, "waiter_reports": false,
        "csv_export": false, "remove_branding": false}}'::jsonb,
    '{"max_tables": 10, "price_monthly_paise": 44900, "razorpay_plan_id_monthly": "plan_Starter123",
      "features": {"kds": false, "discounts": false, "split_payments": false,
        "upi_qr_on_bill": false, "advanced_reports": false, "waiter_reports": false,
        "csv_export": true, "remove_branding": false}}'::jsonb
  )::text,
  'the audit row holds only what changed'
);
select is(
  (select restaurant_id from public.audit_logs where action = 'plan.updated'), null::uuid,
  'a platform-level event (no restaurant)'
);

select is(
  (public.platform_update_plan(:'pro', '{"max_staff": null, "max_tables": null}') ->> 'max_staff'),
  null, 'null means unlimited'
);
select is(
  (select count(*) from public.audit_logs where action = 'plan.updated' and entity_id = :'pro'),
  0::bigint, 'nothing changed, nothing audited'
);
select is(
  public.platform_update_plan(:'pro', '{"razorpay_plan_id_yearly": " "}') ->> 'razorpay_plan_id_yearly',
  null, 'a blank Razorpay id clears it'
);

select throws_ok(
  format($f$select public.platform_update_plan(%L, '{"features": {"free_lunch": true}}')$f$, :'pro'),
  'P0001', 'INVALID_INPUT', 'unknown features are refused'
);
select throws_ok(
  format($f$select public.platform_update_plan(%L, '{"features": {"kds": "yes"}}')$f$, :'pro'),
  'P0001', 'INVALID_INPUT', 'features are true or false'
);
select throws_ok(
  format($f$select public.platform_update_plan(%L, '{"price_yearly_paise": -1}')$f$, :'pro'),
  'P0001', 'INVALID_INPUT', 'no negative prices'
);
select throws_ok(
  format($f$select public.platform_update_plan(%L, '{"max_tables": 0}')$f$, :'pro'),
  'P0001', 'INVALID_INPUT', 'limits are at least 1'
);
select throws_ok(
  format($f$select public.platform_update_plan(%L, '{"razorpay_plan_id_monthly": "plan 1; drop"}')$f$, :'pro'),
  'P0001', 'INVALID_INPUT', 'Razorpay ids are plain ids'
);
select throws_ok(
  format($f$select public.platform_update_plan(%L, '{"code": "gold"}')$f$, :'pro'),
  'P0001', 'INVALID_INPUT', 'the code cannot change'
);
select throws_ok(
  format($f$select public.platform_update_plan(%L, '{}')$f$, gen_random_uuid()),
  'P0001', 'PLAN_NOT_FOUND', 'unknown plan'
);
select throws_ok(
  $$ update public.plans set price_monthly_paise = 1 $$, '42501', null,
  'no direct writes, even for platform admins'
);

-- ─── Platform audit log ─────────────────────────────────────────────────────
select public.platform_set_restaurant_status(:'rest_b', 'suspended', 'Checking documents');
select tests.clear_auth();
insert into public.audit_logs (restaurant_id, actor_type, actor_user_id, actor_role, actor_label, action, created_at)
values
  (:'rest_a', 'staff', :'a_owner', 'owner', 'A Owner', 'bill.voided', '2026-09-01 12:00+05:30'),
  (:'rest_a', 'staff', :'a_owner', 'owner', 'A Owner', 'discount.applied', '2026-09-02 12:00+05:30'),
  (:'rest_a', 'customer', null, null, 'Customer (device …abcd)', 'order_item.cancelled', '2026-09-03 12:00+05:30');
insert into public.audit_logs (restaurant_id, actor_type, actor_label, action, created_at)
select :'rest_a', 'system', 'System', 'fixture.paging', '2026-08-01 10:00+05:30'::timestamptz + make_interval(mins => n)
from generate_series(1, 55) as n;
select tests.authenticate_as_platform_admin(:'admin');

select public.platform_list_audit('{"restaurant_id": null, "action": "restaurant.suspended"}') as suspended \gset
select is(
  (select jsonb_build_object(
     'restaurant', r ->> 'restaurant_slug', 'actor', r ->> 'actor_label', 'email', r ->> 'actor_email',
     'reason', r ->> 'reason')
   from jsonb_array_elements(:'suspended'::jsonb -> 'rows') as r
   where r ->> 'restaurant_slug' = 'beta'),
  '{"restaurant": "beta", "actor": "Platform admin", "email": "platform@admin.test", "reason": "Checking documents"}'::jsonb,
  'rows name the restaurant and the admin''s email'
);
select is(
  (select jsonb_agg(r ->> 'action' order by r ->> 'created_at' desc) from jsonb_array_elements(
    public.platform_list_audit(jsonb_build_object(
      'restaurant_id', :'rest_a', 'from', '2026-09-01', 'to', '2026-09-02')) -> 'rows') as r),
  '["discount.applied", "bill.voided"]'::jsonb,
  'restaurant and date range (India time, end date included), newest first'
);
select is(
  (select jsonb_agg(r ->> 'action') from jsonb_array_elements(
    public.platform_list_audit(jsonb_build_object(
      'restaurant_id', :'rest_a', 'actor_type', 'customer')) -> 'rows') as r),
  '["order_item.cancelled"]'::jsonb,
  'actor type filter'
);
select is(
  (select jsonb_agg(r ->> 'action' order by r ->> 'action') from jsonb_array_elements(
    public.platform_list_audit(jsonb_build_object('restaurant_id', :'rest_a', 'action', 'bill.')) -> 'rows') as r),
  '["bill.voided"]'::jsonb,
  'action prefix filter'
);
select is(
  (public.platform_list_audit(jsonb_build_object('restaurant_id', :'rest_a', 'action', 'fixture.paging', 'page', 2)) ->> 'total')::int,
  55, 'total counts every match'
);
select is(
  jsonb_array_length(public.platform_list_audit(jsonb_build_object(
    'restaurant_id', :'rest_a', 'action', 'fixture.paging', 'page', 2)) -> 'rows'),
  5, 'page 2 has the rest'
);
select ok(
  exists (
    select 1 from jsonb_array_elements(
      public.platform_list_audit('{"action": "plan.updated"}') -> 'rows') as r
    where r ->> 'restaurant_id' is null
  ),
  'platform-level events are listed'
);
select throws_ok(
  $$ select public.platform_list_audit('{"action": "DROP TABLE"}') $$,
  'P0001', 'INVALID_INPUT', 'action filter is a plain prefix'
);
select throws_ok(
  $$ select public.platform_list_audit('{"actor_type": "robot"}') $$,
  'P0001', 'INVALID_INPUT', 'unknown actor type'
);

-- ─── Who may ────────────────────────────────────────────────────────────────
select tests.authenticate_as(:'a_owner');
select throws_ok(
  format($f$select public.platform_update_plan(%L, '{"price_monthly_paise": 0}')$f$, :'starter'),
  'P0001', 'FORBIDDEN', 'owners cannot edit plans'
);
select throws_ok(
  $$ select public.platform_list_audit('{}') $$, 'P0001', 'FORBIDDEN', 'owners cannot read the platform log'
);
select tests.authenticate_as_platform_admin(:'admin', 'aal1');
select throws_ok(
  $$ select public.platform_list_audit('{}') $$, 'P0001', 'MFA_REQUIRED', 'password only: refused'
);

select tests.clear_auth();
select * from finish();
rollback;
