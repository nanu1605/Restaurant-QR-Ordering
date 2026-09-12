-- Restaurant settings (spec §13.3 Settings) and plan lookup (spec §14.2).
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

select tests.create_restaurant('alpha') as rest_a \gset
select tests.create_restaurant('bravo') as rest_b \gset
select tests.create_restaurant('small') as rest_s \gset
select tests.set_plan(:'rest_s', 'starter');
select tests.add_member(:'rest_a', 'manager', 'a_manager') as a_manager \gset
select tests.add_member(:'rest_a', 'waiter', 'a_waiter') as a_waiter \gset
select tests.add_member(:'rest_s', 'owner', 's_owner') as s_owner \gset

insert into public.restaurants (name, slug) values ('No Plan', 'no-plan') returning id as rest_none \gset
select tests.add_member(:'rest_none', 'owner', 'n_owner') as n_owner \gset

select tests.authenticate_as(:'a_manager');

-- ─── Saving ─────────────────────────────────────────────────────────────────
select lives_ok(
  $$
    select public.admin_update_settings('{
      "name": "  Alpha   Bistro ", "gst_mode": "regular", "gst_rate_bps": 500,
      "gstin": "23aaacd1234e1z5", "pincode": "452001", "email": "hello@alpha.test",
      "upi_vpa": "Alpha.Bistro@okicici", "upi_payee_name": "Alpha Bistro",
      "show_upi_qr_on_bill": true, "invoice_prefix": "AB", "paper_width": "58mm",
      "customer_cancel_window_seconds": 90, "business_day_start_hour": 5,
      "service_charge_enabled": true, "service_charge_bps": 1000, "bill_footer_text": "  "
    }')
  $$,
  'a manager saves settings across tabs'
);
select results_eq(
  format(
    $f$ select name, gst_mode::text, gstin, upi_vpa, show_upi_qr_on_bill, paper_width::text,
               customer_cancel_window_seconds, bill_footer_text
        from public.restaurants where id = %L $f$,
    :'rest_a'
  ),
  $$ values ('Alpha Bistro', 'regular', '23AAACD1234E1Z5', 'alpha.bistro@okicici', true, '58mm', 90, null::text) $$,
  'values are normalised: tidy name, uppercase GSTIN, lowercase VPA, blanks become empty'
);

select results_eq(
  $$ select before ->> 'gst_mode', after ->> 'gst_mode', after ->> 'gstin', before ? 'gst_rate_bps'
     from public.audit_logs where action = 'settings.updated' $$,
  $$ values ('none', 'regular', '23AAACD1234E1Z5', false) $$,
  'the audit entry records before/after of the keys that changed (unchanged ones left out)'
);
select lives_ok(
  $$ select public.admin_update_settings('{"gst_rate_bps": 500}') $$,
  'saving an unchanged value works'
);
select is(
  (select count(*) from public.audit_logs where action = 'settings.updated'),
  1::bigint,
  'an update that changes nothing writes no audit entry'
);

-- ─── Validation ─────────────────────────────────────────────────────────────
select throws_ok(
  $$ select public.admin_update_settings('{"status": "active"}') $$,
  'P0001', 'INVALID_INPUT', 'keys outside the whitelist are rejected'
);
select throws_ok(
  $$ select public.admin_update_settings('{"gst_rate_bps": "5"}') $$,
  'P0001', 'INVALID_INPUT', 'wrong types are rejected'
);
select throws_ok(
  $$ select public.admin_update_settings('{"gst_mode": "vat"}') $$,
  'P0001', 'INVALID_INPUT', 'unknown GST modes are rejected'
);
select throws_ok(
  $$ select public.admin_update_settings('{"gstin": "23AAACD1234E1Z"}') $$,
  'P0001', 'INVALID_INPUT', 'a malformed GSTIN is rejected'
);
select throws_ok(
  $$ select public.admin_update_settings('{"pincode": "012345"}') $$,
  'P0001', 'INVALID_INPUT', 'a malformed pincode is rejected'
);
select throws_ok(
  $$ select public.admin_update_settings('{"customer_cancel_window_seconds": 601}') $$,
  'P0001', 'INVALID_INPUT', 'the cancel window is 0–600 seconds'
);
select throws_ok(
  $$ select public.admin_update_settings('{"business_day_start_hour": 24}') $$,
  'P0001', 'INVALID_INPUT', 'the business day starts at 0–23'
);
select throws_ok(
  $$ select public.admin_update_settings('{"max_tables_per_waiter": 0}') $$,
  'P0001', 'INVALID_INPUT', 'max tables per waiter is 1–20'
);
select throws_ok(
  $$ select public.admin_update_settings('{"name": "   "}') $$,
  'P0001', 'INVALID_INPUT', 'the restaurant name is required'
);
select throws_ok(
  $$ select public.admin_update_settings('{"email": "not-an-email"}') $$,
  'P0001', 'INVALID_INPUT', 'a malformed email is rejected'
);
select throws_ok(
  $$ select public.admin_update_settings('{"upi_vpa": null}') $$,
  'P0001', 'UPI_VPA_REQUIRED', 'the UPI QR needs a VPA'
);
select throws_ok(
  format($f$ select public.admin_update_settings('{"logo_path": "%s/logo.webp"}') $f$, :'rest_b'),
  'P0001', 'INVALID_IMAGE_PATH', 'the logo must be in the restaurant''s own folder'
);
select lives_ok(
  format($f$ select public.admin_update_settings('{"logo_path": "%s/logo.webp"}') $f$, :'rest_a'),
  'a logo in the restaurant''s own folder is accepted'
);

-- ─── Plan features ──────────────────────────────────────────────────────────
select tests.authenticate_as(:'s_owner');
select throws_ok(
  $$ select public.admin_update_settings('{"upi_vpa": "small@upi", "show_upi_qr_on_bill": true}') $$,
  'P0001', 'FEATURE_NOT_IN_PLAN', 'the UPI QR on bills needs a plan with that feature'
);
select lives_ok(
  $$ select public.admin_update_settings('{"upi_vpa": "small@upi"}') $$,
  'the VPA itself can be saved on any plan'
);

select results_eq(
  format($f$ select plan_code, max_tables, max_staff from public.restaurant_plan(%L) $f$, :'rest_s'),
  $$ values ('starter', 8, 3) $$,
  'restaurant_plan returns the plan and its limits'
);
select is(
  (select (features ->> 'upi_qr_on_bill')::boolean from public.restaurant_plan(:'rest_s')),
  false,
  'and its feature flags'
);

select tests.authenticate_as(:'a_waiter');
select is(
  (select plan_code from public.restaurant_plan(:'rest_a')),
  'growth',
  'any member can read their restaurant''s plan (managers and waiters cannot read subscriptions)'
);
select throws_ok(
  format($f$ select * from public.restaurant_plan(%L) $f$, :'rest_b'),
  'P0001', 'FORBIDDEN',
  'another restaurant''s plan is off limits'
);
select throws_ok(
  $$ select public.admin_update_settings('{"name": "Waiter''s place"}') $$,
  'P0001', 'FORBIDDEN',
  'waiters cannot change settings'
);

select tests.authenticate_as(:'n_owner');
select is(
  (select count(*) from public.restaurant_plan(:'rest_none')),
  0::bigint,
  'a restaurant without a subscription has no plan'
);

-- ─── Read-only ──────────────────────────────────────────────────────────────
select tests.clear_auth();
select tests.suspend(:'rest_a');
select tests.authenticate_as(:'a_manager');
select throws_ok(
  $$ select public.admin_update_settings('{"bill_footer_text": "Closed"}') $$,
  'P0001', 'RESTAURANT_READ_ONLY',
  'read-only restaurants cannot change settings'
);

select * from finish();

rollback;
