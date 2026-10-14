-- What each payment to MenuMesh was for, and its GST (docs/SUPER_ADMIN_PLAN.md
-- §4.2; docs/DECISIONS.md SA-8).
begin;
select no_plan();

select tests.create_platform_admin('platform@admin.test') as admin \gset
select tests.create_restaurant('sa-520-a') as rest \gset
select tests.add_member(:'rest', 'owner', 'a_owner') as a_owner \gset

select is(private.fee_gst_bps(), 1800, 'GST on MenuMesh fees is 18% (FEE_GST_BPS in gst.ts)');
select ok(
  not has_function_privilege('authenticated', 'private.fee_gst_bps()', 'execute'),
  'the rate is not callable from the API'
);

-- ─── A setup fee paid in cash ───────────────────────────────────────────────
select row(current_period_end, status)::text as sub_before
from public.restaurant_subscriptions where restaurant_id = :'rest' \gset
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_record_setup_fee(:'rest', '{
  "amount_paise": 58882, "mode": "cash", "notes": "Collected at the visit",
  "list_price_paise": 99900, "discount_paise": 50000
}') ->> 'payment_id' as fee_id \gset
select tests.clear_auth();
select is(
  (select row(source, purpose, base_paise, gst_paise, list_price_paise, discount_paise,
              period_start, manual_mode)::text
   from public.subscription_payments where id = :'fee_id'),
  row('manual', 'setup_fee', 49900::bigint, 8982::bigint, 99900::bigint, 50000::bigint,
      null::timestamptz, 'cash')::text,
  'a setup fee: its own purpose, the GST split out, the fee and discount kept, no period'
);
select is(
  (select row(current_period_end, status)::text from public.restaurant_subscriptions where restaurant_id = :'rest'),
  :'sub_before',
  'a setup fee changes no subscription'
);
select is(
  (select after ->> 'purpose' from public.audit_logs
   where action = 'subscription.payment_recorded' and entity_id = :'fee_id'),
  'setup_fee',
  'and is audited as one'
);

select tests.authenticate_as_platform_admin(:'admin');
select throws_ok(
  format($f$select public.platform_record_setup_fee(%L, '{"amount_paise": 58882, "mode": "card"}')$f$, :'rest'),
  'P0001', 'INVALID_INPUT', 'manual modes only'
);
select throws_ok(
  format($f$select public.platform_record_setup_fee(%L, '{"amount_paise": 58882, "mode": "upi",
    "list_price_paise": 99900, "discount_paise": 99901}')$f$, :'rest'),
  'P0001', 'INVALID_INPUT', 'the discount is at most the fee'
);
select throws_ok(
  format($f$select public.platform_record_setup_fee(%L, '{"amount_paise": 0, "mode": "upi"}')$f$, :'rest'),
  'P0001', 'INVALID_INPUT', 'an amount is needed'
);
select throws_ok(
  format($f$select public.platform_record_setup_fee(%L, '{"amount_paise": 58882, "mode": "upi"}')$f$, gen_random_uuid()),
  'P0001', 'RESTAURANT_NOT_FOUND', 'an unknown restaurant'
);
select tests.authenticate_as(:'a_owner');
select throws_ok(
  format($f$select public.platform_record_setup_fee(%L, '{"amount_paise": 58882, "mode": "upi"}')$f$, :'rest'),
  'P0001', 'FORBIDDEN', 'only platform admins record payments'
);

-- ─── A subscription paid by bank transfer ───────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_record_manual_payment(:'rest', jsonb_build_object(
  'amount_paise', 106082, 'mode', 'bank_transfer', 'billing_cycle', 'monthly',
  'period_start', current_date, 'period_end', current_date + 29, 'notes', null
)) ->> 'payment_id' as sub_id \gset
select tests.clear_auth();
select is(
  (select row(purpose, base_paise, gst_paise, list_price_paise)::text
   from public.subscription_payments where id = :'sub_id'),
  row('subscription', 89900::bigint, 16182::bigint, null::bigint)::text,
  'Growth for a month: ₹899 plus ₹161.82 GST'
);

-- ─── Payment links ──────────────────────────────────────────────────────────
select tests.as_service_role();
select public.razorpay_record_webhook('evt_SA520a', jsonb_build_object(
  'event', 'payment_link.paid',
  'created_at', extract(epoch from now())::bigint,
  'payload', jsonb_build_object(
    'payment_link', jsonb_build_object('entity', jsonb_build_object(
      'id', 'plink_SA520a', 'amount', 58882,
      'notes', jsonb_build_object('restaurant_id', :'rest', 'purpose', 'setup_fee',
        'list_price_paise', '99900', 'discount_paise', '50000')
    )),
    'payment', jsonb_build_object('entity', jsonb_build_object('id', 'pay_SA520a', 'amount', 58882))
  )
));
select public.razorpay_record_webhook('evt_SA520b', jsonb_build_object(
  'event', 'payment_link.paid',
  'created_at', extract(epoch from now())::bigint,
  'payload', jsonb_build_object(
    'payment_link', jsonb_build_object('entity', jsonb_build_object(
      'id', 'plink_SA520b', 'amount', 106082,
      'notes', jsonb_build_object('restaurant_id', :'rest', 'purpose', 'subscription', 'months', '1',
        'list_price_paise', '99900')
    )),
    'payment', jsonb_build_object('entity', jsonb_build_object('id', 'pay_SA520b', 'amount', 106082))
  )
));
select public.razorpay_record_webhook('evt_SA520c', jsonb_build_object(
  'event', 'payment_link.paid',
  'created_at', extract(epoch from now())::bigint,
  'payload', jsonb_build_object(
    'payment_link', jsonb_build_object('entity', jsonb_build_object(
      'id', 'plink_SA520c', 'amount', 117882,
      'notes', jsonb_build_object('restaurant_id', :'rest', 'purpose', 'setup_fee')
    )),
    'payment', jsonb_build_object('entity', jsonb_build_object('id', 'pay_SA520c', 'amount', 117882))
  )
));
select tests.clear_auth();
select is(
  (select row(purpose, list_price_paise, discount_paise, base_paise, gst_paise)::text
   from public.subscription_payments where razorpay_payment_id = 'pay_SA520a'),
  row('setup_fee', 99900::bigint, 50000::bigint, 49900::bigint, 8982::bigint)::text,
  'a setup fee link keeps the fee and the discount from its notes'
);
select is(
  (select row(purpose, list_price_paise, discount_paise)::text
   from public.subscription_payments where razorpay_payment_id = 'pay_SA520b'),
  row('subscription', null::bigint, null::bigint)::text,
  'a subscription link has neither'
);
select is(
  (select row(purpose, list_price_paise, discount_paise)::text
   from public.subscription_payments where razorpay_payment_id = 'pay_SA520c'),
  row('setup_fee', null::bigint, null::bigint)::text,
  'an older setup fee link without them still counts as a setup fee'
);

select is(
  (select count(*) from public.subscription_payments where base_paise + gst_paise <> amount_paise),
  0::bigint,
  'every payment: amount + GST = what was paid'
);
select is(
  (select count(*) from public.subscription_payments where period_start is null and purpose <> 'setup_fee'),
  0::bigint,
  'only setup fees are paid without a period'
);

select * from finish();
rollback;
