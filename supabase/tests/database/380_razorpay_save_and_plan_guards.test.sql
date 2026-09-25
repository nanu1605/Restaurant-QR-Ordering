-- Saving Razorpay subscriptions from the server (docs/DECISIONS.md P8-6) and
-- keeping plans and plan changes in step with Razorpay (P8-9, P8-10).
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

select tests.create_platform_admin('rzp-platform@admin.test') as admin \gset
select tests.create_restaurant('rzp-save') as rest \gset
select tests.create_restaurant('rzp-else') as rest_b \gset
select tests.add_member(:'rest', 'owner', 'save_owner') as owner \gset
select tests.add_member(:'rest', 'manager', 'save_manager') as manager \gset
select tests.add_member(:'rest_b', 'owner', 'else_owner') as owner_b \gset

create function pg_temp.entity(
  p_restaurant uuid, p_id text, p_status text, p_plan text default 'starter', p_cycle text default 'yearly'
)
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'id', p_id, 'status', p_status,
    'notes', jsonb_build_object('restaurant_id', p_restaurant, 'plan_code', p_plan, 'billing_cycle', p_cycle)
  );
$$;

select tests.as_service_role();

-- ─── Input checks ───────────────────────────────────────────────────────────
select throws_ok(
  format($f$select public.razorpay_save_subscription(%L, %L::jsonb)$f$,
         :'rest', pg_temp.entity(:'rest_b', 'sub_Save1', 'created')),
  'P0001', 'INVALID_INPUT', 'the notes must name the same restaurant'
);
select throws_ok(
  format($f$select public.razorpay_save_subscription(%L, %L::jsonb)$f$,
         :'rest', pg_temp.entity(:'rest', 'plan_Wrong1', 'created')),
  'P0001', 'INVALID_INPUT', 'only subscription ids'
);
select throws_ok(
  format($f$select public.razorpay_save_subscription(%L, %L::jsonb)$f$,
         :'rest', pg_temp.entity(:'rest', 'sub_Save1', 'created', 'platinum')),
  'P0001', 'PLAN_NOT_FOUND', 'the plan must exist'
);
select throws_ok(
  format($f$select public.razorpay_save_subscription(%L, %L::jsonb, %L)$f$,
         :'rest', pg_temp.entity(:'rest', 'sub_Save1', 'created'), :'manager'),
  'P0001', 'FORBIDDEN', 'managers do not manage the subscription'
);
select throws_ok(
  format($f$select public.razorpay_save_subscription(%L, %L::jsonb, %L)$f$,
         :'rest', pg_temp.entity(:'rest', 'sub_Save1', 'created'), :'owner_b'),
  'P0001', 'FORBIDDEN', 'owners of another restaurant are refused'
);

-- ─── Attach as the owner ────────────────────────────────────────────────────
select is(
  public.razorpay_save_subscription(:'rest', pg_temp.entity(:'rest', 'sub_Save1', 'created'), :'owner') ->> 'razorpay_status',
  'created',
  'the owner starts a subscription'
);
select is(
  (select (a.actor_type::text, a.actor_role::text, a.after ->> 'plan_code', a.after ->> 'billing_cycle')::text
   from public.audit_logs a where a.restaurant_id = :'rest' and a.action = 'subscription.autopay_started'),
  '(staff,owner,starter,yearly)',
  'audited as the owner, with the plan and cycle'
);

-- An abandoned checkout can be replaced.
select public.razorpay_save_subscription(:'rest', pg_temp.entity(:'rest', 'sub_Save2', 'authenticated', 'growth', 'monthly'), :'owner');
select is(
  (select (s.razorpay_subscription_id, s.razorpay_status, p.code, s.next_billing_cycle::text)::text
   from public.restaurant_subscriptions s join public.plans p on p.id = s.next_plan_id
   where s.restaurant_id = :'rest'),
  '(sub_Save2,authenticated,growth,monthly)',
  'a checkout never finished is replaced'
);

-- A healthy mandate can't be replaced.
select throws_ok(
  format($f$select public.razorpay_save_subscription(%L, %L::jsonb, %L)$f$,
         :'rest', pg_temp.entity(:'rest', 'sub_Save3', 'created'), :'owner'),
  'P0001', 'RAZORPAY_SUBSCRIPTION_LIVE', 'autopay already set up: no second subscription'
);

-- ─── Plan changes and trial extensions while Razorpay charges ───────────────
select tests.clear_auth();
select tests.authenticate_as_platform_admin(:'admin');
select throws_ok(
  format($f$select public.platform_change_plan(%L, 'pro')$f$, :'rest'),
  'P0001', 'RAZORPAY_MANAGED', 'no plan change while Razorpay charges the old plan'
);
select is(
  public.platform_change_plan(:'rest', 'growth') ->> 'plan_code',
  'growth',
  'choosing the current plan is still fine'
);
select throws_ok(
  format($f$select public.platform_extend_trial(%L, 7)$f$, :'rest'),
  'P0001', 'RAZORPAY_MANAGED', 'no trial extension once autopay is set up for its end'
);
select tests.clear_auth();

-- ─── Cancel at period end, then subscribe again ─────────────────────────────
select tests.as_service_role();
select public.razorpay_save_subscription(:'rest', pg_temp.entity(:'rest', 'sub_Save2', 'authenticated', 'growth', 'monthly'), :'admin', true);
select is(
  (select (s.cancel_at_period_end, a.actor_type::text, a.actor_label)::text
   from public.restaurant_subscriptions s
   join public.audit_logs a on a.restaurant_id = s.restaurant_id and a.action = 'subscription.cancel_scheduled'
   where s.restaurant_id = :'rest'),
  '(t,platform_admin,"Platform admin")',
  'a platform admin schedules the cancel'
);
select tests.clear_auth();
select tests.authenticate_as_platform_admin(:'admin');
select is(
  public.platform_change_plan(:'rest', 'pro') ->> 'plan_code',
  'pro',
  'with the cancel scheduled, the plan can change'
);
select tests.clear_auth();
select tests.as_service_role();
select public.razorpay_save_subscription(:'rest', pg_temp.entity(:'rest', 'sub_Save4', 'created', 'pro', 'monthly'), :'owner');
select is(
  (select (s.razorpay_subscription_id, s.cancel_at_period_end)::text
   from public.restaurant_subscriptions s where s.restaurant_id = :'rest'),
  '(sub_Save4,t)',
  'a new subscription replaces the one set to end, which still ends until checkout is done'
);
select public.razorpay_save_subscription(:'rest', pg_temp.entity(:'rest', 'sub_Save4', 'authenticated', 'pro', 'monthly'), :'owner');
select is(
  (select cancel_at_period_end from public.restaurant_subscriptions where restaurant_id = :'rest'),
  false,
  'once it is authorised, the subscription carries on'
);

-- ─── Suspended restaurants can't start one ──────────────────────────────────
select tests.clear_auth();
select tests.suspend(:'rest_b');
select tests.as_service_role();
select throws_ok(
  format($f$select public.razorpay_save_subscription(%L, %L::jsonb, %L)$f$,
         :'rest_b', pg_temp.entity(:'rest_b', 'sub_Else1', 'created'), :'owner_b'),
  'P0001', 'RESTAURANT_SUSPENDED', 'a suspended restaurant is sent to support'
);

-- ─── Inactive plans ─────────────────────────────────────────────────────────
select tests.clear_auth();
update public.plans set is_active = false where code = 'starter';
update public.restaurants set status = 'active', suspended_reason = null where id = :'rest_b';
select tests.as_service_role();
select throws_ok(
  format($f$select public.razorpay_save_subscription(%L, %L::jsonb)$f$,
         :'rest_b', pg_temp.entity(:'rest_b', 'sub_Else2', 'created')),
  'P0001', 'PLAN_INACTIVE', 'an inactive plan cannot be subscribed to'
);
select tests.clear_auth();
update public.plans set is_active = true where code = 'starter';

-- ─── A price change clears the Razorpay plan id ─────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select id as starter from public.plans where code = 'starter' \gset
select public.platform_update_plan(
  :'starter', '{"razorpay_plan_id_monthly": "plan_Month1", "razorpay_plan_id_yearly": "plan_Year1"}'
);
select is(
  public.platform_update_plan(
    :'starter',
    '{"price_monthly_paise": 44900, "razorpay_plan_id_monthly": "plan_Month1", "razorpay_plan_id_yearly": "plan_Year1"}'
  ) ->> 'razorpay_plan_id_monthly',
  null,
  'a new monthly price clears the monthly Razorpay plan'
);
select is(
  (select razorpay_plan_id_yearly from public.plans where code = 'starter'),
  'plan_Year1',
  'the yearly plan is untouched'
);
select is(
  (select a.after ->> 'razorpay_plan_id_monthly' is null and a.before ->> 'razorpay_plan_id_monthly' = 'plan_Month1'
   from public.audit_logs a
   where a.action = 'plan.updated' and a.entity_id = :'starter' and a.after ? 'price_monthly_paise'),
  true,
  'the cleared id is in the audit row'
);
select is(
  public.platform_update_plan(
    :'starter', '{"price_yearly_paise": 449000, "razorpay_plan_id_yearly": "plan_Year2"}'
  ) ->> 'razorpay_plan_id_yearly',
  'plan_Year2',
  'a new price with a new Razorpay plan keeps the new id'
);

select * from finish();
rollback;
