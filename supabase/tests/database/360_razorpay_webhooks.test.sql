-- Razorpay webhooks (spec §14.4, docs/DECISIONS.md P8-3 … P8-5): stored once,
-- every subscription event's state change, ordering, replaced subscriptions
-- and payment links.
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- A subscription.* webhook payload. Times are 'YYYY-MM-DD HH24:MI' India time.
create function pg_temp.sub_event(
  p_event text,
  p_sub_id text,
  p_status text,
  p_created text,
  p_restaurant uuid default null,
  p_start text default null,
  p_end text default null,
  p_payment_id text default null,
  p_amount bigint default null
)
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'entity', 'event',
    'event', p_event,
    'created_at', extract(epoch from (p_created || '+05:30')::timestamptz)::bigint,
    'payload', jsonb_build_object(
      'subscription', jsonb_build_object('entity', jsonb_strip_nulls(jsonb_build_object(
        'id', p_sub_id,
        'status', p_status,
        'customer_id', 'cust_Test1',
        'current_start', extract(epoch from (p_start || '+05:30')::timestamptz)::bigint,
        'current_end', extract(epoch from (p_end || '+05:30')::timestamptz)::bigint,
        'notes', case when p_restaurant is not null
          then jsonb_build_object('restaurant_id', p_restaurant, 'plan_code', 'starter', 'billing_cycle', 'monthly')
        end
      )))
    ) || case when p_payment_id is not null then jsonb_build_object(
      'payment', jsonb_build_object('entity', jsonb_build_object(
        'id', p_payment_id, 'amount', p_amount, 'status', 'captured'
      ))
    ) else '{}'::jsonb end
  );
$$;

-- A payment_link.paid payload.
create function pg_temp.link_event(p_restaurant uuid, p_notes jsonb, p_payment_id text, p_amount bigint)
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'entity', 'event',
    'event', 'payment_link.paid',
    'created_at', extract(epoch from '2026-10-01 10:00+05:30'::timestamptz)::bigint,
    'payload', jsonb_build_object(
      'payment_link', jsonb_build_object('entity', jsonb_build_object(
        'id', 'plink_Test1', 'amount', p_amount, 'amount_paid', p_amount, 'status', 'paid',
        'notes', jsonb_build_object('restaurant_id', p_restaurant) || p_notes
      )),
      'payment', jsonb_build_object('entity', jsonb_build_object(
        'id', p_payment_id, 'amount', p_amount, 'status', 'captured'
      ))
    )
  );
$$;

-- Attaches a Razorpay subscription (as the server does after creating one).
create function pg_temp.attach(p_restaurant uuid, p_sub_id text, p_status text default 'created')
returns jsonb
language sql
as $$
  select public.razorpay_save_subscription(
    p_restaurant,
    jsonb_build_object(
      'id', p_sub_id, 'status', p_status,
      'notes', jsonb_build_object('restaurant_id', p_restaurant, 'plan_code', 'starter', 'billing_cycle', 'monthly')
    )
  );
$$;

create function pg_temp.sub(p_restaurant uuid)
returns public.restaurant_subscriptions
language sql
as $$ select * from public.restaurant_subscriptions where restaurant_id = p_restaurant $$;

select tests.create_restaurant('rzp-main') as rest \gset
select tests.create_restaurant('rzp-other') as rest2 \gset
select tests.create_restaurant('rzp-trial') as rest3 \gset
select tests.create_restaurant('rzp-halt') as rest4 \gset
select tests.create_restaurant('rzp-link') as rest5 \gset

-- ─── Grants ─────────────────────────────────────────────────────────────────
select ok(
  not has_function_privilege('authenticated', 'public.razorpay_record_webhook(text, jsonb)', 'execute')
  and not has_function_privilege('anon', 'public.razorpay_record_webhook(text, jsonb)', 'execute')
  and has_function_privilege('service_role', 'public.razorpay_record_webhook(text, jsonb)', 'execute'),
  'webhooks are stored by the server only'
);
select ok(
  not has_function_privilege('authenticated', 'public.razorpay_save_subscription(uuid, jsonb, uuid, boolean)', 'execute')
  and has_function_privilege('service_role', 'public.razorpay_save_subscription(uuid, jsonb, uuid, boolean)', 'execute'),
  'owners cannot feed Razorpay data themselves'
);

select tests.as_service_role();

-- ─── Attach ─────────────────────────────────────────────────────────────────
select pg_temp.attach(:'rest', 'sub_Main1');
select is(
  (select (s.razorpay_subscription_id, s.razorpay_status, s.status::text, s.next_billing_cycle::text)::text
   from public.restaurant_subscriptions s where s.restaurant_id = :'rest'),
  '(sub_Main1,created,trialing,monthly)',
  'attach stores the subscription and what it will charge; the trial carries on'
);
select is(
  (select p.code from public.plans p where p.id = (pg_temp.sub(:'rest')).plan_id),
  'growth',
  'the trial keeps its plan until the first charge'
);

-- ─── Authenticated, duplicates ──────────────────────────────────────────────
select is(
  public.razorpay_record_webhook('evt_1', pg_temp.sub_event('subscription.authenticated', 'sub_Main1', 'authenticated', '2026-10-01 10:00')),
  'applied',
  'authenticated is applied'
);
select is(
  public.razorpay_record_webhook('evt_1', pg_temp.sub_event('subscription.authenticated', 'sub_Main1', 'authenticated', '2026-10-01 10:00')),
  'duplicate',
  'the same event id again is a duplicate'
);
select is(
  (select count(*)::int from public.webhook_events where event_id = 'evt_1'),
  1,
  'a duplicate is stored once'
);
select is(
  (select (s.status::text, s.razorpay_status, s.razorpay_customer_id)::text from public.restaurant_subscriptions s where s.restaurant_id = :'rest'),
  '(trialing,authenticated,cust_Test1)',
  'authenticated keeps the trial and notes the mandate'
);

-- ─── Activated ──────────────────────────────────────────────────────────────
select public.razorpay_record_webhook(
  'evt_2',
  pg_temp.sub_event('subscription.activated', 'sub_Main1', 'active', '2026-10-10 15:00', null,
                    '2026-10-10 15:00', '2026-11-10 15:00')
);
select is(
  (select (s.status::text, s.source::text, s.billing_cycle::text, s.next_plan_id is null,
           s.current_period_start, s.current_period_end)::text
   from public.restaurant_subscriptions s where s.restaurant_id = :'rest'),
  (select ('active', 'razorpay', 'monthly', true,
           '2026-10-10 15:00+05:30'::timestamptz, '2026-11-10 15:00+05:30'::timestamptz)::text),
  'activated: active on Razorpay, with the period from the entity'
);
select is(
  (select p.code from public.plans p where p.id = (pg_temp.sub(:'rest')).plan_id),
  'starter',
  'the chosen plan applies once it is active'
);

-- ─── Charged ────────────────────────────────────────────────────────────────
select is(
  public.razorpay_record_webhook(
    'evt_3',
    pg_temp.sub_event('subscription.charged', 'sub_Main1', 'active', '2026-10-10 15:01', null,
                      '2026-10-10 15:00', '2026-11-10 15:00', 'pay_One1', 39900)
  ),
  'applied',
  'charged is applied'
);
select is(
  (select (p.source::text, p.amount_paise, p.period_start, p.period_end)::text
   from public.subscription_payments p where p.razorpay_payment_id = 'pay_One1'),
  (select ('razorpay', 39900, '2026-10-10 15:00+05:30'::timestamptz, '2026-11-10 15:00+05:30'::timestamptz)::text),
  'charged records the payment with its period'
);
select public.razorpay_record_webhook(
  'evt_3_again',
  pg_temp.sub_event('subscription.charged', 'sub_Main1', 'active', '2026-10-10 15:01', null,
                    '2026-10-10 15:00', '2026-11-10 15:00', 'pay_One1', 39900)
);
select is(
  (select count(*)::int from public.subscription_payments where razorpay_payment_id = 'pay_One1'),
  1,
  'a payment redelivered under another event id is recorded once'
);
select is(
  (select count(*)::int from public.audit_logs
   where restaurant_id = :'rest' and action = 'subscription.payment_received'),
  1,
  'one audit row per payment'
);

-- ─── Pending and halted: grace counts from the event ────────────────────────
select public.razorpay_record_webhook(
  'evt_4', pg_temp.sub_event('subscription.pending', 'sub_Main1', 'pending', '2026-11-10 15:05')
);
select is(
  (select (s.status::text, s.grace_until)::text from public.restaurant_subscriptions s where s.restaurant_id = :'rest'),
  (select ('past_due', '2026-11-17 15:05+05:30'::timestamptz)::text),
  'pending: past due, grace of grace_days from the event'
);
select public.razorpay_record_webhook(
  'evt_5', pg_temp.sub_event('subscription.halted', 'sub_Main1', 'halted', '2026-11-14 15:05')
);
select is(
  (select (s.status::text, s.grace_until)::text from public.restaurant_subscriptions s where s.restaurant_id = :'rest'),
  (select ('halted', '2026-11-17 15:05+05:30'::timestamptz)::text),
  'halted keeps the grace already running'
);

-- ─── Out of order ───────────────────────────────────────────────────────────
select is(
  public.razorpay_record_webhook(
    'evt_old', pg_temp.sub_event('subscription.activated', 'sub_Main1', 'active', '2026-11-12 09:00', null,
                                 '2026-10-10 15:00', '2026-11-10 15:00')
  ),
  'stale',
  'an event older than the last one applied is stale'
);
select is(
  (pg_temp.sub(:'rest')).status::text,
  'halted',
  'a stale event does not change the status'
);
select public.razorpay_record_webhook(
  'evt_old_charge',
  pg_temp.sub_event('subscription.charged', 'sub_Main1', 'active', '2026-11-12 09:01', null,
                    '2026-11-10 15:00', '2026-12-10 15:00', 'pay_Late1', 39900)
);
select is(
  (select count(*)::int from public.subscription_payments where razorpay_payment_id = 'pay_Late1'),
  1,
  'a stale charge still records its payment'
);

-- ─── Charged again: back to active, grace and cancel cleared ────────────────
update public.restaurant_subscriptions set cancel_at_period_end = true where restaurant_id = :'rest';
select public.razorpay_record_webhook(
  'evt_6',
  pg_temp.sub_event('subscription.charged', 'sub_Main1', 'active', '2026-11-15 10:00', null,
                    '2026-11-10 15:00', '2026-12-10 15:00', 'pay_Two1', 39900)
);
select is(
  (select (s.status::text, s.grace_until, s.cancel_at_period_end, s.current_period_end)::text
   from public.restaurant_subscriptions s where s.restaurant_id = :'rest'),
  (select ('active', null::timestamptz, false, '2026-12-10 15:00+05:30'::timestamptz)::text),
  'charged: active, grace cleared, renews, period extended'
);

-- ─── Cancel at period end, then cancelled ───────────────────────────────────
select public.razorpay_save_subscription(
  :'rest',
  jsonb_build_object('id', 'sub_Main1', 'status', 'active',
    'notes', jsonb_build_object('restaurant_id', :'rest', 'plan_code', 'starter', 'billing_cycle', 'monthly')),
  null,
  true
);
select is((pg_temp.sub(:'rest')).cancel_at_period_end, true, 'cancel at period end is saved');
select is((pg_temp.sub(:'rest')).status::text, 'active', 'still active until the period ends');
select public.razorpay_record_webhook(
  'evt_7', pg_temp.sub_event('subscription.cancelled', 'sub_Main1', 'cancelled', '2026-12-10 15:00')
);
select is(
  (select (s.status::text, s.razorpay_status, s.current_period_end)::text
   from public.restaurant_subscriptions s where s.restaurant_id = :'rest'),
  (select ('cancelled', 'cancelled', '2026-12-10 15:00+05:30'::timestamptz)::text),
  'cancelled ends a Razorpay subscription, keeping the paid period'
);
select is(
  (select count(*)::int from public.audit_logs
   where restaurant_id = :'rest' and action = 'subscription.razorpay_updated' and actor_label = 'Razorpay'),
  -- created, authenticated, activated, pending, halted, charged, cancelled
  7,
  'each state change is audited as Razorpay'
);

-- ─── Unknown subscription ───────────────────────────────────────────────────
select is(
  public.razorpay_record_webhook(
    'evt_unknown', pg_temp.sub_event('subscription.charged', 'sub_Nobody1', 'active', '2026-10-01 10:00')
  ),
  'failed',
  'an event for an unknown subscription fails'
);
select is(
  (select (processed_at is null, processing_error like 'RESTAURANT_NOT_FOUND%')::text
   from public.webhook_events where event_id = 'evt_unknown'),
  '(t,t)',
  'the error is kept on the stored event'
);
select is(
  public.razorpay_record_webhook('evt_ignored', '{"event": "payment.captured", "payload": {}}'),
  'ignored',
  'events MenuMesh does not use are ignored'
);
select isnt(
  (select processed_at from public.webhook_events where event_id = 'evt_ignored'),
  null,
  'an ignored event is marked processed'
);

-- ─── A replaced subscription ────────────────────────────────────────────────
select pg_temp.attach(:'rest2', 'sub_OldB1');
select pg_temp.attach(:'rest2', 'sub_NewC1');
select is(
  public.razorpay_record_webhook(
    'evt_old_sub',
    pg_temp.sub_event('subscription.charged', 'sub_OldB1', 'active', '2026-10-02 10:00', :'rest2',
                      '2026-10-02 10:00', '2026-11-02 10:00', 'pay_OldB1', 39900)
  ),
  'not_current',
  'an event for a replaced subscription is found through its notes'
);
select is(
  (select (s.status::text, s.razorpay_subscription_id)::text from public.restaurant_subscriptions s where s.restaurant_id = :'rest2'),
  '(trialing,sub_NewC1)',
  'it does not change the status'
);
select is(
  (select count(*)::int from public.subscription_payments where razorpay_payment_id = 'pay_OldB1'),
  1,
  'but its payment is recorded'
);

-- ─── Razorpay never cuts a trial or grace short ─────────────────────────────
select pg_temp.attach(:'rest3', 'sub_Trial1', 'authenticated');
select public.razorpay_record_webhook(
  'evt_trial_cancel', pg_temp.sub_event('subscription.cancelled', 'sub_Trial1', 'cancelled', '2026-10-03 10:00')
);
select is(
  (select (s.status::text, s.razorpay_status, s.next_plan_id is null)::text
   from public.restaurant_subscriptions s where s.restaurant_id = :'rest3'),
  '(trialing,cancelled,t)',
  'cancelling a trial mandate keeps the trial'
);

select pg_temp.attach(:'rest4', 'sub_Halt1', 'active');
select public.razorpay_record_webhook(
  'evt_h1', pg_temp.sub_event('subscription.halted', 'sub_Halt1', 'halted', '2026-10-04 10:00')
);
select public.razorpay_record_webhook(
  'evt_h2', pg_temp.sub_event('subscription.cancelled', 'sub_Halt1', 'cancelled', '2026-10-05 10:00')
);
select is(
  (select (s.status::text, s.grace_until)::text from public.restaurant_subscriptions s where s.restaurant_id = :'rest4'),
  (select ('halted', '2026-10-11 10:00+05:30'::timestamptz)::text),
  'cancelling a halted subscription keeps the grace'
);

-- ─── Payment links ──────────────────────────────────────────────────────────
update public.restaurant_subscriptions
  set trial_ends_at = '2026-10-10 15:00+05:30'
  where restaurant_id = :'rest5';

select is(
  public.razorpay_record_webhook(
    'evt_link1', pg_temp.link_event(:'rest5', '{"purpose": "subscription", "months": "1"}', 'pay_Link1', 89900)
  ),
  'applied',
  'a paid subscription link is applied'
);
select is(
  (select (s.status::text, s.source::text, s.billing_cycle::text, s.current_period_start, s.current_period_end)::text
   from public.restaurant_subscriptions s where s.restaurant_id = :'rest5'),
  (select ('active', 'manual', 'monthly',
           '2026-10-10 04:00+05:30'::timestamptz, '2026-11-10 04:00+05:30'::timestamptz)::text),
  'it pays from the first business day after the trial, for the months in its notes'
);
select is(
  (select (p.source::text, p.notes)::text from public.subscription_payments p where p.razorpay_payment_id = 'pay_Link1'),
  '(payment_link,"Payment link, 1 month")',
  'the payment is recorded as a payment link'
);
select is(
  public.razorpay_record_webhook(
    'evt_link1_again', pg_temp.link_event(:'rest5', '{"purpose": "subscription", "months": "1"}', 'pay_Link1', 89900)
  ),
  'duplicate_payment',
  'a payment already recorded is not applied twice'
);
select is(
  (pg_temp.sub(:'rest5')).current_period_end,
  '2026-11-10 04:00+05:30'::timestamptz,
  'so the period is extended once'
);
select public.razorpay_record_webhook(
  'evt_link2', pg_temp.link_event(:'rest5', '{"purpose": "subscription", "months": 3}', 'pay_Link2', 269700)
);
select is(
  (pg_temp.sub(:'rest5')).current_period_end,
  '2027-02-10 04:00+05:30'::timestamptz,
  'a second link carries on from the paid period'
);
select public.razorpay_record_webhook(
  'evt_fee', pg_temp.link_event(:'rest5', '{"purpose": "setup_fee"}', 'pay_Fee1', 149900)
);
select is(
  (select (p.notes, p.period_start is null, s.current_period_end)::text
   from public.subscription_payments p
   join public.restaurant_subscriptions s on s.restaurant_id = p.restaurant_id
   where p.razorpay_payment_id = 'pay_Fee1'),
  (select ('Setup fee', true, '2027-02-10 04:00+05:30'::timestamptz)::text),
  'a setup fee is recorded without changing access'
);
select is(
  public.razorpay_record_webhook(
    'evt_bad_months', pg_temp.link_event(:'rest5', '{"purpose": "subscription", "months": "0"}', 'pay_Bad1', 100)
  ),
  'failed',
  'zero months is refused'
);
select is(
  public.razorpay_record_webhook(
    'evt_bad_purpose', pg_temp.link_event(:'rest5', '{"purpose": "tip"}', 'pay_Bad2', 100)
  ),
  'failed',
  'an unknown purpose is refused'
);
select is(
  public.razorpay_record_webhook(
    'evt_bad_rest',
    pg_temp.link_event(gen_random_uuid(), '{"purpose": "setup_fee"}', 'pay_Bad3', 100)
  ),
  'failed',
  'an unknown restaurant is refused'
);
select is(
  (select count(*)::int from public.subscription_payments where razorpay_payment_id like 'pay_Bad%'),
  0,
  'refused links record nothing'
);

select * from finish();
rollback;
