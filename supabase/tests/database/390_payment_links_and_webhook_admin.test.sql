-- Super-admin's Razorpay tools (docs/DECISIONS.md P8-11): the setup fee
-- setting, auditing payment links, reprocessing failed webhooks, and the
-- Razorpay state on the restaurant page.
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

select tests.create_platform_admin('rzp-tools@admin.test') as admin \gset
select tests.create_restaurant('rzp-tools') as rest \gset
select tests.add_member(:'rest', 'owner', 'tools_owner') as owner \gset

-- ─── Setup fee setting ──────────────────────────────────────────────────────
select is(
  (select setup_fee_paise from public.platform_settings where id = 1),
  149900::bigint,
  'the setup fee defaults to ₹1,499'
);
select throws_ok(
  $$update public.platform_settings set setup_fee_paise = 50 where id = 1$$,
  '23514', null,
  'the setup fee is at least ₹1'
);

-- ─── Payment link audit ─────────────────────────────────────────────────────
create function pg_temp.link(p_purpose text, p_months int default null, p_amount bigint default 149900)
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'id', 'plink_Tools1', 'short_url', 'https://rzp.io/l/plink_Tools1',
    'amount_paise', p_amount, 'purpose', p_purpose, 'months', p_months
  );
$$;

select tests.authenticate_as_platform_admin(:'admin', 'aal1');
select throws_ok(
  format('select public.platform_audit_payment_link(%L, %L::jsonb)', :'rest', pg_temp.link('setup_fee')),
  'P0001', 'MFA_REQUIRED', 'a password alone sends no links'
);
select tests.authenticate_as(:'owner');
select throws_ok(
  format('select public.platform_audit_payment_link(%L, %L::jsonb)', :'rest', pg_temp.link('setup_fee')),
  'P0001', 'FORBIDDEN', 'owners cannot log links'
);

select tests.authenticate_as_platform_admin(:'admin');
select lives_ok(
  format('select public.platform_audit_payment_link(%L, %L::jsonb)', :'rest', pg_temp.link('subscription', 3, 269700)),
  'a subscription link is logged'
);
select is(
  (select (a.actor_type::text, a.action, a.after ->> 'purpose', (a.after ->> 'months')::int, (a.after ->> 'amount_paise')::bigint)::text
   from public.audit_logs a where a.restaurant_id = :'rest' and a.action = 'subscription.payment_link_sent'),
  '(platform_admin,subscription.payment_link_sent,subscription,3,269700)',
  'as the platform admin, with purpose, months and amount'
);
select throws_ok(
  format('select public.platform_audit_payment_link(%L, %L::jsonb)', :'rest', pg_temp.link('subscription')),
  'P0001', 'INVALID_INPUT', 'a subscription link needs months'
);
select throws_ok(
  format('select public.platform_audit_payment_link(%L, %L::jsonb)', :'rest', pg_temp.link('setup_fee', 2)),
  'P0001', 'INVALID_INPUT', 'a setup fee has no months'
);
select throws_ok(
  format('select public.platform_audit_payment_link(%L, %L::jsonb)', :'rest', pg_temp.link('tip')),
  'P0001', 'INVALID_INPUT', 'only subscriptions and setup fees'
);
select throws_ok(
  format('select public.platform_audit_payment_link(%L, %L::jsonb)', :'rest', pg_temp.link('setup_fee', null, 50)),
  'P0001', 'INVALID_INPUT', 'at least ₹1'
);
select throws_ok(
  format('select public.platform_audit_payment_link(%L, %L::jsonb)', :'rest',
         pg_temp.link('setup_fee') || '{"short_url": "javascript:alert(1)"}'),
  'P0001', 'INVALID_INPUT', 'only https links'
);
select throws_ok(
  format('select public.platform_audit_payment_link(%L, %L::jsonb)', gen_random_uuid(), pg_temp.link('setup_fee')),
  'P0001', 'RESTAURANT_NOT_FOUND', 'the restaurant must exist'
);

-- ─── Reprocessing webhooks ──────────────────────────────────────────────────
select tests.clear_auth();
select tests.as_service_role();
-- A charge for a subscription nobody has attached yet fails, and is kept.
select is(
  public.razorpay_record_webhook('evt_Tools1', jsonb_build_object(
    'event', 'subscription.charged',
    'created_at', extract(epoch from now())::bigint,
    'payload', jsonb_build_object(
      'subscription', jsonb_build_object('entity', jsonb_build_object(
        'id', 'sub_Tools1', 'status', 'active',
        'current_start', extract(epoch from now())::bigint,
        'current_end', extract(epoch from now() + interval '1 month')::bigint
      )),
      'payment', jsonb_build_object('entity', jsonb_build_object(
        'id', 'pay_Tools1', 'amount', 89900, 'status', 'captured'
      ))
    )
  )),
  'failed',
  'an event for an unknown subscription fails'
);
select id as failed_event from public.webhook_events where event_id = 'evt_Tools1' \gset
select public.razorpay_record_webhook('evt_Tools2', '{"event": "order.paid", "payload": {}}');
select id as done_event from public.webhook_events where event_id = 'evt_Tools2' \gset

select tests.clear_auth();
select tests.authenticate_as_platform_admin(:'admin', 'aal1');
select throws_ok(
  format('select public.platform_reprocess_webhook(%L)', :'failed_event'),
  'P0001', 'MFA_REQUIRED', 'a password alone reprocesses nothing'
);
select tests.authenticate_as(:'owner');
select throws_ok(
  format('select public.platform_reprocess_webhook(%L)', :'failed_event'),
  'P0001', 'FORBIDDEN', 'owners cannot reprocess'
);
select tests.authenticate_as_platform_admin(:'admin');
select throws_ok(
  format('select public.platform_reprocess_webhook(%L)', :'done_event'),
  'P0001', 'WEBHOOK_NOT_FAILED', 'an event that went through is never applied twice'
);
select throws_ok(
  format('select public.platform_reprocess_webhook(%L)', gen_random_uuid()),
  'P0001', 'NOT_FOUND', 'the event must exist'
);

-- Still unknown: it fails again and keeps the error.
select is(
  public.platform_reprocess_webhook(:'failed_event') ->> 'result',
  'failed',
  'still failing'
);
select is(
  (select (processed_at is null and processing_error like 'RESTAURANT_NOT_FOUND%')
   from public.webhook_events where id = :'failed_event'),
  true,
  'the new error is kept'
);

-- Once the subscription is attached, it applies.
select tests.clear_auth();
select tests.as_service_role();
select public.razorpay_save_subscription(:'rest', jsonb_build_object(
  'id', 'sub_Tools1', 'status', 'created',
  'notes', jsonb_build_object('restaurant_id', :'rest', 'plan_code', 'growth', 'billing_cycle', 'monthly')
));
select tests.clear_auth();
select tests.authenticate_as_platform_admin(:'admin');
select is(
  public.platform_reprocess_webhook(:'failed_event'),
  '{"error": null, "result": "applied"}'::jsonb,
  'reprocessed after the subscription is attached'
);
select tests.clear_auth();
select is(
  (select (e.processed_at is not null, e.processing_error, s.status::text, s.source::text)::text
   from public.webhook_events e, public.restaurant_subscriptions s
   where e.id = :'failed_event' and s.restaurant_id = :'rest'),
  '(t,,active,razorpay)',
  'the event is processed and the restaurant is paid'
);
select is(
  (select count(*)::int from public.subscription_payments where razorpay_payment_id = 'pay_Tools1'),
  1,
  'with its payment'
);
select is(
  (select (a.restaurant_id::text, a.before ->> 'event_type', a.after ->> 'result')::text
   from public.audit_logs a
   where a.action = 'webhook.reprocessed' and a.entity_id = :'failed_event'
     and a.after ->> 'result' = 'applied'),
  format('(%s,subscription.charged,applied)', :'rest'),
  'reprocessing is audited against the restaurant'
);
select tests.authenticate_as_platform_admin(:'admin');
select throws_ok(
  format('select public.platform_reprocess_webhook(%L)', :'failed_event'),
  'P0001', 'WEBHOOK_NOT_FAILED', 'and it cannot be applied again'
);

-- ─── Paying another way while autopay is set to end ─────────────────────────
-- Razorpay still ends the mandate, so the app keeps saying it ends.
select tests.clear_auth();
update public.restaurant_subscriptions set cancel_at_period_end = true where restaurant_id = :'rest';
select tests.as_service_role();
select is(
  public.razorpay_record_webhook('evt_Tools3', jsonb_build_object(
    'event', 'payment_link.paid',
    'created_at', extract(epoch from now())::bigint,
    'payload', jsonb_build_object(
      'payment_link', jsonb_build_object('entity', jsonb_build_object(
        'id', 'plink_Tools3', 'amount', 89900,
        'notes', jsonb_build_object('restaurant_id', :'rest', 'purpose', 'subscription', 'months', '1')
      )),
      'payment', jsonb_build_object('entity', jsonb_build_object('id', 'pay_Tools3', 'amount', 89900))
    )
  )),
  'applied',
  'a subscription link is paid while autopay is set to end'
);
select tests.clear_auth();
select is(
  (select (s.cancel_at_period_end, private.razorpay_managed(s))::text
   from public.restaurant_subscriptions s where s.restaurant_id = :'rest'),
  '(t,f)',
  'autopay still ends; it is not reported as renewing'
);
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_record_manual_payment(:'rest', jsonb_build_object(
  'amount_paise', 89900, 'mode', 'upi', 'billing_cycle', 'monthly',
  'period_start', (now() + interval '60 days')::date, 'period_end', (now() + interval '89 days')::date,
  'notes', null
));
select tests.clear_auth();
select is(
  (select cancel_at_period_end from public.restaurant_subscriptions where restaurant_id = :'rest'),
  true,
  'nor after a manual payment'
);

-- ─── The restaurant page shows Razorpay's state ─────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select is(
  (select (d #>> '{subscription,razorpay_status}', d #>> '{subscription,razorpay_subscription_id}')::text
   from public.platform_get_restaurant(:'rest') as d),
  '(active,sub_Tools1)',
  'the restaurant page gets the Razorpay status'
);

-- ─── Grants ─────────────────────────────────────────────────────────────────
select tests.clear_auth();
select ok(
  not has_function_privilege('anon', 'public.platform_audit_payment_link(uuid, jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.platform_reprocess_webhook(uuid)', 'execute'),
  'anon calls neither'
);

select * from finish();
rollback;
