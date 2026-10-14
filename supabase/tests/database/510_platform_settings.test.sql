-- Platform settings screen and the permission check (docs/SUPER_ADMIN_PLAN.md
-- 12a; docs/DECISIONS.md SA-2, SA-4, SA-5).
begin;
select no_plan();

select tests.create_platform_admin('platform@admin.test') as admin \gset
select tests.create_restaurant('alpha') as rest_a \gset
select tests.add_member(:'rest_a', 'owner', 'a_owner') as a_owner \gset
select tests.create_user('nobody@example.test') as nobody \gset

select has_column('public', 'platform_settings', 'setup_fee_discount_ends_at', 'the offer can have an end');
select col_is_null('public', 'platform_settings', 'setup_fee_discount_ends_at', 'no end by default');

-- Known starting point, whatever earlier runs or the e2e screen left behind.
update public.platform_settings
set trial_days = 14, grace_days = 7, setup_fee_paise = 99900, setup_fee_discount_paise = 50000,
    setup_fee_discount_ends_at = null, support_phone = null, support_email = 'help@old.test'
where id = 1;

-- ─── Updating ───────────────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_update_settings('{
  "trial_days": 21, "grace_days": 5, "setup_fee_paise": 149900,
  "setup_fee_discount_paise": 0, "setup_fee_discount_ends_at": "2026-12-31T18:30:00Z",
  "support_phone": " +91 98765  43210 ", "support_email": "help@menumesh.test"
}') as updated \gset
select is(
  -- The health thresholds (stop 12d) are 560's.
  :'updated'::jsonb - array['health_setup_days', 'health_inactive_days', 'health_slowing_percent', 'health_slowing_min_orders'],
  '{"trial_days": 21, "grace_days": 5, "setup_fee_paise": 149900, "setup_fee_discount_paise": 0,
    "setup_fee_discount_ends_at": "2026-12-31T18:30:00+00:00", "support_phone": "+91 98765 43210",
    "support_email": "help@menumesh.test"}'::jsonb,
  'every setting changes; text is tidied'
);
select is(
  (select row(restaurant_id, actor_type, actor_user_id, entity_type, before, after)::text
   from public.audit_logs where action = 'platform_settings.updated' and created_at = now()),
  row(
    null::uuid, 'platform_admin', :'admin'::uuid, 'platform_settings',
    '{"trial_days": 14, "grace_days": 7, "setup_fee_paise": 99900, "setup_fee_discount_paise": 50000,
      "setup_fee_discount_ends_at": null, "support_phone": null, "support_email": "help@old.test"}'::jsonb,
    '{"trial_days": 21, "grace_days": 5, "setup_fee_paise": 149900, "setup_fee_discount_paise": 0,
      "setup_fee_discount_ends_at": "2026-12-31T18:30:00+00:00", "support_phone": "+91 98765 43210",
      "support_email": "help@menumesh.test"}'::jsonb
  )::text,
  'one platform-level audit row with before and after'
);

select public.platform_update_settings('{"trial_days": 21, "grace_days": 6}');
select is(
  (select row(before, after)::text from public.audit_logs
   where action = 'platform_settings.updated' and created_at = now()
     and not after ? 'support_email'),
  row('{"grace_days": 5}'::jsonb, '{"grace_days": 6}'::jsonb)::text,
  'the audit row holds only what changed'
);
select is(
  (select count(*) from public.audit_logs where action = 'platform_settings.updated' and created_at = now()),
  2::bigint, 'two saves that changed something'
);
select public.platform_update_settings('{"trial_days": 21}');
select is(
  (select count(*) from public.audit_logs where action = 'platform_settings.updated' and created_at = now()),
  2::bigint, 'nothing changed, nothing audited'
);
select is(
  public.platform_update_settings('{"support_phone": " ", "support_email": null, "setup_fee_discount_ends_at": null}')
    - array['trial_days', 'grace_days', 'setup_fee_paise', 'setup_fee_discount_paise']
    - array['health_setup_days', 'health_inactive_days', 'health_slowing_percent', 'health_slowing_min_orders'],
  '{"support_phone": null, "support_email": null, "setup_fee_discount_ends_at": null}'::jsonb,
  'blank or null clears the contacts and the end'
);
select is(
  public.platform_update_settings('{"setup_fee_discount_paise": 50000, "setup_fee_discount_ends_at": "2020-01-01T00:00:00Z"}')
    ->> 'setup_fee_discount_ends_at',
  '2020-01-01T00:00:00+00:00',
  'a past end is allowed: it ends the offer now'
);

-- ─── Refused values ─────────────────────────────────────────────────────────
select throws_ok($$ select public.platform_update_settings('{"trial_days": 0}') $$,
  'P0001', 'INVALID_INPUT', 'trial days at least 1');
select throws_ok($$ select public.platform_update_settings('{"trial_days": 366}') $$,
  'P0001', 'INVALID_INPUT', 'trial days at most 365');
select throws_ok($$ select public.platform_update_settings('{"grace_days": -1}') $$,
  'P0001', 'INVALID_INPUT', 'grace days at least 0');
select throws_ok($$ select public.platform_update_settings('{"grace_days": 91}') $$,
  'P0001', 'INVALID_INPUT', 'grace days at most 90');
select throws_ok($$ select public.platform_update_settings('{"grace_days": "7"}') $$,
  'P0001', 'INVALID_INPUT', 'numbers are JSON numbers');
select throws_ok($$ select public.platform_update_settings('{"setup_fee_paise": 99, "setup_fee_discount_paise": 0}') $$,
  'P0001', 'INVALID_INPUT', 'the fee is at least ₹1');
select throws_ok($$ select public.platform_update_settings('{"setup_fee_paise": 100000001}') $$,
  'P0001', 'INVALID_INPUT', 'the fee is at most ₹10,00,000');
select throws_ok($$ select public.platform_update_settings('{"setup_fee_discount_paise": 149900}') $$,
  'P0001', 'INVALID_INPUT', 'the discount stays below the fee');
select throws_ok($$ select public.platform_update_settings('{"setup_fee_discount_paise": -1}') $$,
  'P0001', 'INVALID_INPUT', 'no negative discount');
select throws_ok($$ select public.platform_update_settings('{"setup_fee_paise": 50000}') $$,
  'P0001', 'INVALID_INPUT', 'lowering only the fee cannot leave the discount above it');
select throws_ok($$ select public.platform_update_settings('{"setup_fee_discount_ends_at": "next week"}') $$,
  'P0001', 'INVALID_INPUT', 'the end is a real time');
select throws_ok($$ select public.platform_update_settings('{"setup_fee_discount_ends_at": "2026-01-01 10:00 Foo/Bar"}') $$,
  'P0001', 'INVALID_INPUT', 'an unknown time zone is refused');
select throws_ok($$ select public.platform_update_settings('{"setup_fee_discount_ends_at": "2026-01-01T10:00:00+99:00"}') $$,
  'P0001', 'INVALID_INPUT', 'an impossible offset is refused');
select throws_ok($$ select public.platform_update_settings('{"setup_fee_discount_ends_at": "infinity"}') $$,
  'P0001', 'INVALID_INPUT', 'the end is a real day, not infinity');
select throws_ok($$ select public.platform_update_settings('{"setup_fee_discount_ends_at": "99999-01-01"}') $$,
  'P0001', 'INVALID_INPUT', 'the end is not centuries away');
select throws_ok($$ select public.platform_update_settings('{"support_email": "not-an-email"}') $$,
  'P0001', 'INVALID_INPUT', 'the email looks like one');
select throws_ok($$ select public.platform_update_settings('{"support_phone": "123456789012345678901"}') $$,
  'P0001', 'INVALID_INPUT', 'the phone is at most 20 characters');
select throws_ok($$ select public.platform_update_settings('{"id": 2}') $$,
  'P0001', 'INVALID_INPUT', 'unknown keys are refused');
select throws_ok($$ select public.platform_update_settings('[]') $$,
  'P0001', 'INVALID_INPUT', 'the patch is an object');
select throws_ok(
  $$ update public.platform_settings set trial_days = 30 $$, '42501', null,
  'no direct writes, even for platform admins'
);

-- ─── Who can call it ────────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin', 'aal1');
select throws_ok($$ select public.platform_update_settings('{}') $$,
  'P0001', 'MFA_REQUIRED', 'a platform admin needs the second factor');
select tests.authenticate_as(:'a_owner');
select throws_ok($$ select public.platform_update_settings('{}') $$,
  'P0001', 'FORBIDDEN', 'an owner cannot');
select tests.authenticate_as(:'nobody');
select throws_ok($$ select public.platform_update_settings('{}') $$,
  'P0001', 'FORBIDDEN', 'a plain user cannot');
select tests.clear_auth();
set local role anon;
select throws_ok($$ select public.platform_update_settings('{}') $$,
  '42501', null, 'anon cannot');
reset role;

-- ─── The permission check ───────────────────────────────────────────────────
-- Called as postgres with an admin's claims: it is not executable by API roles.
select tests.authenticate_as_platform_admin(:'admin');
select set_config('role', 'none', true);
select is(
  (private.require_platform_permission('settings.manage')).user_id, :'admin'::uuid,
  'every platform admin holds every permission until roles (13g)'
);
select throws_ok($$ select private.require_platform_permission('settings.mange') $$,
  'P0001', 'unknown platform permission: settings.mange', 'a misspelt permission is a bug');
select tests.authenticate_as_platform_admin(:'admin', 'aal1');
select set_config('role', 'none', true);
select throws_ok($$ select private.require_platform_permission('settings.manage') $$,
  'P0001', 'MFA_REQUIRED', 'the second-factor rule still applies');
select tests.authenticate_as_platform_admin(:'admin');
select throws_ok($$ select private.require_platform_permission('settings.manage') $$,
  '42501', null, 'API roles cannot call the check directly');

select tests.clear_auth();
select * from finish();
rollback;
