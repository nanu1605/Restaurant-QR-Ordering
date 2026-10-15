-- Offers, custom prices, overrides and beta flags (docs/SUPER_ADMIN_PLAN.md
-- 14b, docs/DECISIONS.md SA-77+): offer rules and prices, a custom price for a
-- restaurant paying by hand, an offer through the owner's autopay to its last
-- discounted charge and back to the list price, and overrides.
begin;
select no_plan();

-- ─── Fixtures ───────────────────────────────────────────────────────────────
select tests.create_platform_admin('sa650-admin@example.test') as admin \gset
select tests.create_platform_admin('sa650-finance@example.test') as finance \gset
update public.platform_admins set role = 'finance' where user_id = :'finance';
select tests.create_restaurant('sa650-manual') as manual \gset
select tests.create_restaurant('sa650-auto') as auto \gset
select tests.create_restaurant('sa650-limits') as limits \gset
select tests.create_restaurant('sa650-other') as other \gset
update public.restaurants set email = 'sa650-auto@example.test' where id = :'auto';
select tests.set_plan(:'limits', 'starter');
select tests.add_member(:'limits', 'owner', 'sa650owner') as owner \gset

-- ─── Offers ─────────────────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select is(
  public.platform_save_offer('{"code": " launch20 ", "discount_kind": "percent",
    "discount_value": 20, "duration_cycles": 3, "max_redemptions": 2, "plan_codes": ["growth"],
    "cycles": ["monthly"]}') ->> 'code',
  'LAUNCH20',
  'an offer: its code in capitals'
);
select public.platform_save_offer('{"code": "FLAT100", "discount_kind": "flat", "discount_value": 10000, "new_only": true}');
select public.platform_save_offer('{"code": "ONEONLY", "discount_kind": "percent", "discount_value": 10, "max_redemptions": 1}');
select public.platform_save_offer('{"code": "OLDDEAL", "discount_kind": "percent",
  "discount_value": 10, "valid_from": "2020-01-01T00:00:00Z", "valid_until": "2020-02-01T00:00:00Z"}');
select throws_ok($$select public.platform_save_offer('{"code": "LAUNCH20", "discount_kind": "percent", "discount_value": 5}')$$,
  'P0001', 'OFFER_CODE_TAKEN', 'codes are unique');
select throws_ok($$select public.platform_save_offer('{"code": "HALF", "discount_kind": "percent", "discount_value": 100}')$$,
  'P0001', 'INVALID_INPUT', 'a percentage below 100');
select throws_ok($$select public.platform_save_offer('{"code": "ODD", "discount_kind": "flat", "discount_value": 15050}')$$,
  'P0001', 'INVALID_INPUT', 'a flat discount in whole rupees');
select throws_ok($$select public.platform_save_offer('{"code": "NOPLAN", "discount_kind": "flat", "discount_value": 100, "plan_codes": ["gold"]}')$$,
  'P0001', 'INVALID_INPUT', 'only plans that exist');
select id as launch20 from public.offers where code = 'LAUNCH20' \gset
select public.platform_save_offer('{"description": "Launch month", "max_redemptions": 3}', :'launch20');
select throws_ok(format($$select public.platform_save_offer('{"discount_value": 50}', %L)$$, :'launch20'),
  'P0001', 'INVALID_INPUT', 'its terms don''t change');
select tests.clear_auth();
select is(
  (select array[before::text, after::text] from public.audit_logs
   where action = 'offer.updated' and entity_id = :'launch20'),
  array['{"code": "LAUNCH20", "description": null, "max_redemptions": 2}',
    '{"description": "Launch month", "max_redemptions": 3}'],
  'audited, only what changed'
);

-- ─── Prices ─────────────────────────────────────────────────────────────────
select is(
  array[
    private.offer_price_paise(o, g, 'monthly'),
    private.offer_price_paise(o, g, 'yearly'),
    private.offer_price_paise(o, s, 'monthly'),
    private.offer_price_paise(f, g, 'yearly'),
    private.offer_price_paise(f, s, 'monthly')
  ],
  array[71900, null, null, 889000, 29900]::bigint[],
  'whole rupees: 20% off ₹899 is ₹719; only its plans and cycles; ₹100 off each charge, yearly too'
)
from public.offers o, public.offers f, public.plans g, public.plans s
where o.code = 'LAUNCH20' and f.code = 'FLAT100' and g.code = 'growth' and s.code = 'starter';

-- ─── A trial: no cycle yet, so the price applies at once ─────────────────────
select tests.create_restaurant('sa650-trial') as trial \gset
select tests.authenticate_as_platform_admin(:'finance');
select is(
  public.platform_set_deal(:'trial', '{"plan_code": "growth", "billing_cycle": "monthly",
    "price_paise": 75000, "reason": "Pilot price"}') ->> 'applied_now',
  'true',
  'a trial takes the price now, for when it pays'
);
select tests.clear_auth();

-- ─── A custom price for a restaurant paying by hand ─────────────────────────
select tests.authenticate_as_platform_admin(:'finance');
select public.platform_record_manual_payment(:'manual', jsonb_build_object(
  'amount_paise', 106082, 'mode', 'upi', 'billing_cycle', 'monthly',
  'period_start', current_date, 'period_end', current_date + 29));
select is(
  public.platform_set_deal(:'manual', '{"plan_code": "growth", "billing_cycle": "monthly",
    "price_paise": 70000, "reason": "A chain of three, agreed in person"}') ->> 'applied_now',
  'true',
  'not on autopay: the price applies at once'
);
select throws_ok(format($$select public.platform_set_deal(%L, '{"plan_code": "growth",
  "billing_cycle": "monthly", "price_paise": 89900, "reason": "x"}')$$, :'manual'),
  'P0001', 'INVALID_INPUT', 'a price below the list price');
select throws_ok(format($$select public.platform_set_deal(%L, '{"plan_code": "growth",
  "billing_cycle": "monthly", "price_paise": 70000}')$$, :'manual'),
  'P0001', 'INVALID_INPUT', 'a custom price needs a reason');
select public.platform_record_manual_payment(:'manual', jsonb_build_object(
  'amount_paise', 82600, 'mode', 'upi', 'billing_cycle', 'monthly',
  'period_start', current_date + 30, 'period_end', current_date + 59));
select tests.clear_auth();
select is(
  (select array[s.effective_monthly_paise, (s.deal_id is not null)::int]
   from public.restaurant_subscriptions s where s.restaurant_id = :'manual'),
  array[70000, 1]::bigint[],
  'its price a month'
);
select is(
  (select m.mrr_paise from private.mrr_days(current_date) m
   where m.restaurant_id = :'manual' order by m.day desc limit 1),
  70000::bigint,
  'MRR counts the deal''s price'
);
select is(
  (select array[p.list_price_paise, p.discount_paise, p.base_paise] from public.subscription_payments p
   where p.restaurant_id = :'manual' and p.amount_paise = 82600),
  array[89900, 19900, 70000]::bigint[],
  'a payment at the deal''s price records the list price and the discount'
);
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_change_plan(:'manual', 'starter');
select tests.clear_auth();
select is(
  (select array[(s.deal_id is null)::text, coalesce(s.effective_monthly_paise::text, '-'),
     (select (d.ended_at is not null)::text from public.subscription_deals d
      where d.restaurant_id = :'manual' order by d.created_at desc limit 1)]
   from public.restaurant_subscriptions s where s.restaurant_id = :'manual'),
  array['true', '-', 'true'],
  'another plan: back to the list price, the deal ended'
);

-- ─── An offer at the owner's checkout, to its last discounted charge ────────
select tests.as_service_role();
select is(
  public.subscription_offer_preview(:'auto', 'launch20') - 'description',
  '{"code": "LAUNCH20", "cycles": 3, "prices": [{"plan_code": "growth", "billing_cycle": "monthly", "price_paise": 71900}]}'::jsonb,
  'the owner sees the offer''s prices'
);
select public.subscription_checkout_deal(:'auto', 'growth', 'monthly', 'launch20') as checkout \gset
select is(
  (:'checkout'::jsonb) - 'deal_id',
  '{"price_paise": 71900, "list_price_paise": 89900, "cycles": 3, "razorpay_plan_id": null}'::jsonb,
  'a deal for the checkout, without a Razorpay plan yet'
);
select (:'checkout'::jsonb) ->> 'deal_id' as deal \gset
select public.subscription_deal_plan(:'deal', 'plan_Sa650Launch');
select is(
  public.subscription_checkout_deal(:'auto', 'growth', 'monthly', 'LAUNCH20') ->> 'razorpay_plan_id',
  'plan_Sa650Launch',
  'trying again keeps the deal and its plan'
);
select throws_ok(format($$select public.subscription_checkout_deal(%L, 'starter', 'monthly', 'launch20')$$, :'auto'),
  'P0001', 'OFFER_NOT_FOR_PLAN', 'not for another plan');
select throws_ok(format($$select public.subscription_checkout_deal(%L, 'growth', 'monthly', 'nope')$$, :'auto'),
  'P0001', 'OFFER_NOT_FOUND', 'an unknown code');
select throws_ok(format($$select public.subscription_checkout_deal(%L, 'growth', 'monthly', 'olddeal')$$, :'auto'),
  'P0001', 'OFFER_EXPIRED', 'an offer past its end');
select throws_ok(format($$select public.subscription_checkout_deal(%L, 'growth', 'monthly', 'flat100')$$, :'manual'),
  'P0001', 'OFFER_NEW_ONLY', 'new restaurants only: never paid a subscription');
select lives_ok(format($$select public.subscription_checkout_deal(%L, 'growth', 'monthly', 'oneonly')$$, :'other'),
  'a checkout holds a place');
select throws_ok(format($$select public.subscription_checkout_deal(%L, 'growth', 'monthly', 'oneonly')$$, :'limits'),
  'P0001', 'OFFER_USED_UP', 'so the last place is taken');

select throws_ok(format($$select public.razorpay_save_subscription(%L, jsonb_build_object(
  'id', 'sub_Sa650a', 'status', 'created', 'plan_id', 'plan_Other',
  'notes', jsonb_build_object('restaurant_id', %L, 'plan_code', 'growth', 'billing_cycle', 'monthly',
    'deal_id', %L)))$$, :'auto', :'auto', :'deal'),
  'P0001', 'INVALID_INPUT', 'Razorpay must charge the deal''s plan');
select public.razorpay_save_subscription(:'auto', jsonb_build_object(
  'id', 'sub_Sa650a', 'status', 'authenticated', 'plan_id', 'plan_Sa650Launch',
  'notes', jsonb_build_object('restaurant_id', :'auto', 'plan_code', 'growth', 'billing_cycle', 'monthly',
    'deal_id', :'deal')));
select is(
  (select s.next_deal_id::text from public.restaurant_subscriptions s where s.restaurant_id = :'auto'),
  :'deal',
  'set up: the deal waits for the first charge'
);
select public.razorpay_record_webhook('sa650_1', jsonb_build_object(
  'event', 'subscription.charged',
  'created_at', extract(epoch from now())::bigint,
  'payload', jsonb_build_object(
    'subscription', jsonb_build_object('entity', jsonb_build_object(
      'id', 'sub_Sa650a', 'status', 'active',
      'current_start', extract(epoch from now())::bigint,
      'current_end', extract(epoch from now() + interval '25 days')::bigint)),
    'payment', jsonb_build_object('entity', jsonb_build_object('id', 'pay_Sa650a', 'amount', 84842)))));
select is(
  (select array[s.deal_id::text, s.effective_monthly_paise::text, coalesce(s.next_deal_id::text, '-'),
     (select (d.used_at is not null)::text from public.subscription_deals d where d.id = s.deal_id)]
   from public.restaurant_subscriptions s where s.restaurant_id = :'auto'),
  array[:'deal', '71900', '-', 'true'],
  'charged: the deal is the price, and used'
);
select is(
  (select array[p.list_price_paise, p.discount_paise] from public.subscription_payments p
   where p.razorpay_payment_id = 'pay_Sa650a'),
  array[89900, 18000]::bigint[],
  'the charge records its discount'
);
select throws_ok(format($$select public.subscription_checkout_deal(%L, 'growth', 'monthly', 'launch20')$$, :'auto'),
  'P0001', 'OFFER_ALREADY_USED', 'an offer is used once per restaurant');
select is(
  public.subscription_offer_preview(:'auto') ->> 'current_price_paise',
  '71900',
  'the owner''s page shows the price it pays'
);

-- The last discounted charge: the autopay finishes and runs to its period end.
select public.razorpay_record_webhook('sa650_2', jsonb_build_object(
  'event', 'subscription.completed',
  'created_at', extract(epoch from now())::bigint + 60,
  'payload', jsonb_build_object(
    'subscription', jsonb_build_object('entity', jsonb_build_object(
      'id', 'sub_Sa650a', 'status', 'completed',
      'current_start', extract(epoch from now())::bigint,
      'current_end', extract(epoch from now() + interval '25 days')::bigint)))));
select is(
  (select array[s.status::text, s.cancel_at_period_end::text, coalesce(s.deal_id::text, '-'),
     (select (d.ended_at is not null)::text from public.subscription_deals d where d.id = :'deal')]
   from public.restaurant_subscriptions s where s.restaurant_id = :'auto'),
  array['active', 'true', '-', 'true'],
  'completed: Paid until the period ends, the owner''s code spent'
);
select tests.clear_auth();
select is(
  (select d.due_paise from private.dues_rows('sa650-auto') d where d.restaurant_id = :'auto'),
  106082::bigint,
  'what''s due next is the list price'
);
select tests.as_service_role();
select is(
  (select r.kind from public.subscription_reminders_due(now() + interval '20 days') r
   where r.restaurant_id = :'auto'),
  'autopay_ends_7d',
  'the owner is reminded a week before'
);
select is(
  (select a.warning from public.restaurant_access(:'auto', now() + interval '21 days') a),
  'subscription_ends_soon',
  'and warned in the panel'
);
select public.razorpay_save_subscription(:'auto', jsonb_build_object(
  'id', 'sub_Sa650x', 'status', 'created', 'plan_id', 'plan_GrowthList',
  'notes', jsonb_build_object('restaurant_id', :'auto', 'plan_code', 'growth', 'billing_cycle', 'monthly')));
select is(
  (select r.kind from public.subscription_reminders_due(now() + interval '20 days') r
   where r.restaurant_id = :'auto'),
  'autopay_ends_7d',
  'a checkout started and left doesn''t stop the reminders'
);

-- Autopay again, at the list price.
select public.razorpay_save_subscription(:'auto', jsonb_build_object(
  'id', 'sub_Sa650b', 'status', 'authenticated', 'plan_id', 'plan_GrowthList',
  'notes', jsonb_build_object('restaurant_id', :'auto', 'plan_code', 'growth', 'billing_cycle', 'monthly')));
select public.razorpay_record_webhook('sa650_3', jsonb_build_object(
  'event', 'subscription.charged',
  'created_at', extract(epoch from now())::bigint + 120,
  'payload', jsonb_build_object(
    'subscription', jsonb_build_object('entity', jsonb_build_object(
      'id', 'sub_Sa650b', 'status', 'active',
      'current_start', extract(epoch from now() + interval '25 days')::bigint,
      'current_end', extract(epoch from now() + interval '55 days')::bigint)),
    'payment', jsonb_build_object('entity', jsonb_build_object('id', 'pay_Sa650b', 'amount', 106082)))));
select is(
  (select array[coalesce(s.deal_id::text, '-'), coalesce(s.effective_monthly_paise::text, '-'),
     s.cancel_at_period_end::text]
   from public.restaurant_subscriptions s where s.restaurant_id = :'auto'),
  array['-', '-', 'false'],
  'the next autopay is at the list price'
);
select tests.clear_auth();

-- The team's price stands; on autopay it waits for the next one.
select tests.authenticate_as_platform_admin(:'finance');
select is(
  public.platform_set_deal(:'auto', '{"plan_code": "growth", "billing_cycle": "yearly",
    "price_paise": 800000, "reason": "Yearly for a reference customer"}') ->> 'applied_now',
  'false',
  'on autopay: from the next autopay'
);
select tests.clear_auth();
select tests.as_service_role();
select is(
  public.subscription_offer_preview(:'auto') -> 'deal' ->> 'price_paise',
  '800000',
  'the owner sees the team''s price'
);
select throws_ok(format($$select public.subscription_offer_preview(%L, 'launch20')$$, :'auto'),
  'P0001', 'DEAL_SET_BY_TEAM', 'and no code replaces it');
select is(
  public.subscription_checkout_deal(:'auto', 'growth', 'yearly') ->> 'price_paise',
  '800000',
  'its checkout uses it'
);
select is(public.subscription_checkout_deal(:'auto', 'growth', 'monthly'), null,
  'another cycle is the list price');
select tests.clear_auth();

select tests.authenticate_as_platform_admin(:'admin');
select is(
  (select (o ->> 'used')::int from jsonb_array_elements(public.platform_list_offers()) as o
   where o ->> 'code' = 'LAUNCH20'),
  1,
  'the offers list counts its use'
);
select tests.clear_auth();

-- ─── Overrides and beta flags ───────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_set_override(:'limits', '{"kind": "feature", "feature": "kds", "reason": "Pilot"}');
select public.platform_set_override(:'limits',
  '{"kind": "feature", "feature": "beta_waitlist", "reason": "Waitlist pilot"}');
select public.platform_set_override(:'limits', '{"kind": "max_tables", "value": 10, "reason": "Rooftop"}');
select public.platform_set_override(:'limits', '{"kind": "max_staff", "value": null, "reason": "Big team"}');
select throws_ok(format($$select public.platform_set_override(%L,
  '{"kind": "max_tables", "value": 12, "expires_at": "2020-01-01T00:00:00Z", "reason": "x"}')$$, :'limits'),
  'P0001', 'INVALID_INPUT', 'an expiry in the future');
select throws_ok(format($$select public.platform_set_override(%L,
  '{"kind": "feature", "feature": "kds", "value": 3, "reason": "x"}')$$, :'limits'),
  'P0001', 'INVALID_INPUT', 'a feature has no value');
select throws_ok(format($$select public.platform_set_override(%L, '{"kind": "max_tables", "value": 12}')$$, :'limits'),
  'P0001', 'INVALID_INPUT', 'a reason');
select tests.clear_auth();
select is(
  (select array[(features ->> 'kds'), (features ->> 'beta_waitlist'), max_tables::text,
     coalesce(max_staff::text, 'unlimited')]
   from public.restaurant_plan(:'limits')),
  array['true', 'true', '10', 'unlimited'],
  'Starter with KDS, a beta flag, 10 tables and any number of staff'
);
select ok(private.has_feature(:'limits', 'kds'), 'the feature is on');

select tests.authenticate_as(:'owner');
select lives_ok($$select public.admin_create_tables(array['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])$$,
  'ten tables with the override');
select throws_ok($$select public.admin_create_tables(array['11'])$$,
  'P0001', 'PLAN_LIMIT_TABLES', 'not eleven');
select is((select count(*)::int from public.audit_logs where entity_type = 'restaurant_override'), 0,
  'the owner doesn''t see the team''s overrides');
select tests.clear_auth();

-- An expired override restores the plan's limit (plan 14b acceptance).
update public.restaurant_overrides set expires_at = now() - interval '1 minute'
where restaurant_id = :'limits' and kind = 'max_tables';
select is((select max_tables from private.plan_limits(:'limits')), 8, 'expired: the plan''s 8 tables');
select tests.authenticate_as(:'owner');
select id as table_one from public.dining_tables where restaurant_id = :'limits' and label = '1' \gset
select lives_ok(format($$select public.admin_update_table(%L, '{"is_active": false}')$$, :'table_one'),
  'tables above it stay');
select throws_ok(format($$select public.admin_update_table(%L, '{"is_active": true}')$$, :'table_one'),
  'P0001', 'PLAN_LIMIT_TABLES', 'but none past it');
select tests.clear_auth();

select tests.authenticate_as_platform_admin(:'admin');
select public.platform_remove_override(o.id) from public.restaurant_overrides o
where o.restaurant_id = :'limits' and o.feature = 'kds';
select tests.clear_auth();
select ok(not private.has_feature(:'limits', 'kds'), 'removed: Starter has no KDS');
select is(
  (select count(*)::int from public.audit_logs
   where restaurant_id = :'limits' and action in ('restaurant.override_set', 'restaurant.override_removed')),
  5,
  'each change audited'
);

-- ─── A team price for three charges, across a cancel, a halt and new autopays ─
create function pg_temp.rzp(
  p_sub text, p_status text, p_at int, p_end_days int,
  p_pay text default null, p_amount int default null
)
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'event', 'subscription.' || case p_status when 'active' then 'charged' else p_status end,
    'created_at', extract(epoch from now())::bigint + p_at,
    'payload', jsonb_build_object(
      'subscription', jsonb_build_object('entity', jsonb_build_object(
        'id', p_sub, 'status', p_status,
        'current_start', extract(epoch from now())::bigint,
        'current_end', extract(epoch from now() + make_interval(days => p_end_days))::bigint))
    ) || case when p_pay is null then '{}'::jsonb else jsonb_build_object(
      'payment', jsonb_build_object('entity', jsonb_build_object('id', p_pay, 'amount', p_amount)))
    end
  )
$$;
create function pg_temp.autopay(p_restaurant uuid, p_sub text, p_deal uuid)
returns jsonb
language sql
as $$
  select public.razorpay_save_subscription(p_restaurant, jsonb_build_object(
    'id', p_sub, 'status', 'authenticated', 'plan_id', 'plan_Sa650Team',
    'notes', jsonb_build_object('restaurant_id', p_restaurant, 'plan_code', 'growth',
      'billing_cycle', 'monthly', 'deal_id', p_deal)))
$$;

select tests.create_restaurant('sa650-team') as team \gset
select tests.authenticate_as_platform_admin(:'finance');
select public.platform_set_deal(:'team', '{"plan_code": "growth", "billing_cycle": "monthly",
  "price_paise": 60000, "cycles": 3, "reason": "Three months to try"}');
select tests.clear_auth();
select tests.as_service_role();
select public.subscription_checkout_deal(:'team', 'growth', 'monthly') ->> 'deal_id' as team_deal \gset
select public.subscription_deal_plan(:'team_deal', 'plan_Sa650Team');
select pg_temp.autopay(:'team', 'sub_Sa650t1', :'team_deal');
select public.razorpay_record_webhook('sa650_t1', pg_temp.rzp('sub_Sa650t1', 'active', 10, 20, 'pay_Sa650t1', 70800));
select public.razorpay_record_webhook('sa650_t2', pg_temp.rzp('sub_Sa650t1', 'cancelled', 20, 20));
select is(
  (select array[s.deal_id::text, s.status::text] from public.restaurant_subscriptions s
   where s.restaurant_id = :'team'),
  array[:'team_deal', 'cancelled'],
  'its autopay cancelled: the team''s price stays for the next'
);
select is(public.subscription_checkout_deal(:'team', 'growth', 'monthly') ->> 'cycles', '2',
  'subscribing again: the two charges left, not three');

-- The second autopay charges, then fails: setting up a third keeps the price.
select pg_temp.autopay(:'team', 'sub_Sa650t2', :'team_deal');
select public.razorpay_record_webhook('sa650_t3', pg_temp.rzp('sub_Sa650t2', 'active', 30, 25, 'pay_Sa650t2', 70800));
select tests.clear_auth();
select tests.authenticate_as_platform_admin(:'finance');
select throws_ok(format($$select public.platform_set_deal(%L, '{"end": true}')$$, :'team'),
  'P0001', 'DEAL_IN_AUTOPAY', 'a price a running autopay charges can''t be ended here');
select tests.clear_auth();
select tests.as_service_role();
select public.razorpay_record_webhook('sa650_t4', pg_temp.rzp('sub_Sa650t2', 'halted', 40, 25));
select public.razorpay_record_webhook('sa650_t5', pg_temp.rzp('sub_Sa650t2', 'cancelled', 50, 25));
select is(public.subscription_checkout_deal(:'team', 'growth', 'monthly') ->> 'cycles', '1',
  'a halted autopay replaced: the price and its last charge stay');

-- The third: Razorpay completes it before its charge arrives.
select pg_temp.autopay(:'team', 'sub_Sa650t3', :'team_deal');
select public.razorpay_record_webhook('sa650_t6', pg_temp.rzp('sub_Sa650t3', 'completed', 60, 40));
select public.razorpay_record_webhook('sa650_t7', pg_temp.rzp('sub_Sa650t3', 'active', 61, 40, 'pay_Sa650t3', 70800));
select is(
  (select array[coalesce(s.deal_id::text, '-'), coalesce(s.effective_monthly_paise::text, '-'),
     (s.current_period_end > now() + interval '39 days')::text,
     (select (d.ended_at is not null)::text from public.subscription_deals d where d.id = :'team_deal')]
   from public.restaurant_subscriptions s where s.restaurant_id = :'team'),
  array['-', '-', 'true', 'true'],
  'its third charge, after ''completed'': the period is paid, the price used up, the list price next'
);
select is(public.subscription_checkout_deal(:'team', 'growth', 'monthly'), null,
  'and the next autopay is at the list price');
select tests.clear_auth();

-- ─── A payment for three months is three charges ────────────────────────────
select tests.authenticate_as_platform_admin(:'finance');
select public.platform_record_manual_payment(:'trial', jsonb_build_object(
  'amount_paise', 265500, 'mode', 'upi', 'billing_cycle', 'monthly',
  'period_start', current_date, 'period_end', current_date + 89));
select tests.clear_auth();
select is(
  (select array[p.list_price_paise, p.discount_paise] from public.subscription_payments p
   where p.restaurant_id = :'trial'),
  array[269700, 44700]::bigint[],
  'three months at the deal''s price: three times the list price and the discount'
);

-- ─── Holding a place, and an abandoned checkout ─────────────────────────────
-- The other restaurant's checkout with ONEONLY is two days old but its autopay
-- waits for a first charge: it still holds the only place.
update public.subscription_deals d set created_at = now() - interval '2 days'
from public.offers o where o.id = d.offer_id and o.code = 'ONEONLY';
update public.restaurant_subscriptions s set next_deal_id = d.id
from public.subscription_deals d join public.offers o on o.id = d.offer_id
where o.code = 'ONEONLY' and s.restaurant_id = :'other';
select tests.as_service_role();
select throws_ok(format($$select public.subscription_checkout_deal(%L, 'growth', 'monthly', 'oneonly')$$, :'limits'),
  'P0001', 'OFFER_USED_UP', 'an autopay waiting for its first charge holds its place');
select tests.clear_auth();
update public.restaurant_subscriptions set next_deal_id = null where restaurant_id = :'other';
select tests.as_service_role();
select is(public.subscription_checkout_deal(:'other', 'growth', 'monthly'), null,
  'a checkout without the code: the list price');
select tests.clear_auth();
select ok(
  (select bool_and(d.ended_at is not null) from public.subscription_deals d
   join public.offers o on o.id = d.offer_id where o.code = 'ONEONLY'),
  'and the code it left behind ends'
);

-- ─── Deal prices stay out of the table for the team ─────────────────────────
select tests.authenticate_as_platform_admin(:'finance');
select throws_ok($$select effective_monthly_paise from public.restaurant_subscriptions limit 1$$,
  '42501', null, 'the price a month is read through the platform functions');
select tests.clear_auth();

-- ─── Who reads deals ────────────────────────────────────────────────────────
select tests.create_platform_admin('sa650-sales@example.test') as sales \gset
update public.platform_admins set role = 'sales' where user_id = :'sales';
select tests.authenticate_as_platform_admin(:'sales');
select is((select count(*)::int from public.subscription_deals where restaurant_id = :'auto'), 0,
  'Sales reads no prices');
select is(public.platform_get_restaurant(:'auto') -> 'open_deal' -> 'price_paise', 'null'::jsonb,
  'nor the restaurant''s deal price');
select tests.authenticate_as_platform_admin(:'finance');
select ok((select count(*) from public.subscription_deals where restaurant_id = :'auto') > 0,
  'Finance does');
select tests.clear_auth();

select * from finish();
rollback;
