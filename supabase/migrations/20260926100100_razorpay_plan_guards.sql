-- Plans and plan changes stay in step with Razorpay (docs/DECISIONS.md P8-9,
-- P8-10). While a restaurant pays through a healthy Razorpay mandate, the plan
-- and trial it was set up for can't be changed here; a price change clears
-- the plan's Razorpay id, since Razorpay plans can't be edited.

-- True while a Razorpay mandate is set up and will keep charging.
create or replace function private.razorpay_managed(p_subscription public.restaurant_subscriptions)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_subscription.razorpay_status in ('authenticated', 'active'), false)
    and not p_subscription.cancel_at_period_end;
$$;

revoke execute on function private.razorpay_managed(public.restaurant_subscriptions)
  from public, anon, authenticated;

create or replace function public.platform_extend_trial(p_restaurant_id uuid, p_days int)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.current_platform_admin();
  v_subscription public.restaurant_subscriptions;
  v_ends_at timestamptz;
begin
  if p_days is null or p_days not between 1 and 90 then
    perform private.fail('INVALID_INPUT', 'days');
  end if;

  select * into v_subscription
  from public.restaurant_subscriptions s
  where s.restaurant_id = p_restaurant_id
  for update;
  if not found then
    perform private.fail('SUBSCRIPTION_NOT_FOUND');
  end if;
  if v_subscription.status <> 'trialing' then
    perform private.fail('NOT_TRIALING');
  end if;
  -- Razorpay charges at the trial end it was set up with (P8-9).
  if private.razorpay_managed(v_subscription) then
    perform private.fail('RAZORPAY_MANAGED');
  end if;

  v_ends_at := greatest(v_subscription.trial_ends_at, now()) + make_interval(days => p_days);
  update public.restaurant_subscriptions
    set trial_ends_at = v_ends_at
    where id = v_subscription.id;

  perform private.audit_platform(
    v_admin, p_restaurant_id, 'subscription.trial_extended', 'restaurant_subscription',
    v_subscription.id,
    jsonb_build_object('trial_ends_at', v_subscription.trial_ends_at),
    jsonb_build_object('trial_ends_at', v_ends_at, 'days', p_days)
  );
  return jsonb_build_object('trial_ends_at', v_ends_at);
end;
$$;

create or replace function public.platform_change_plan(p_restaurant_id uuid, p_plan_code text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.current_platform_admin();
  v_plan public.plans;
  v_subscription public.restaurant_subscriptions;
  v_old_code text;
begin
  select * into v_plan from public.plans p where p.code = p_plan_code;
  if not found then
    perform private.fail('PLAN_NOT_FOUND');
  end if;
  if not v_plan.is_active then
    perform private.fail('PLAN_INACTIVE');
  end if;

  select * into v_subscription
  from public.restaurant_subscriptions s
  where s.restaurant_id = p_restaurant_id
  for update;
  if not found then
    perform private.fail('SUBSCRIPTION_NOT_FOUND');
  end if;
  -- Razorpay keeps charging the plan it was set up with (P8-9): cancel at
  -- period end first, then the owner subscribes to the new plan.
  if v_subscription.plan_id <> v_plan.id and private.razorpay_managed(v_subscription) then
    perform private.fail('RAZORPAY_MANAGED');
  end if;

  if v_subscription.plan_id <> v_plan.id then
    select p.code into v_old_code from public.plans p where p.id = v_subscription.plan_id;
    update public.restaurant_subscriptions set plan_id = v_plan.id where id = v_subscription.id;
    perform private.audit_platform(
      v_admin, p_restaurant_id, 'subscription.plan_changed', 'restaurant_subscription',
      v_subscription.id,
      jsonb_build_object('plan_code', v_old_code),
      jsonb_build_object('plan_code', v_plan.code)
    );
  end if;
  return jsonb_build_object('plan_code', v_plan.code, 'plan_name', v_plan.name);
end;
$$;

create or replace function public.platform_update_plan(p_plan_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.current_platform_admin();
  v_patch jsonb := coalesce(p_patch, '{}'::jsonb);
  v_plan public.plans;
  v_updated public.plans;
  v_key text;
  v_before jsonb := '{}'::jsonb;
  v_after jsonb := '{}'::jsonb;
  v_known_features constant text[] := array[
    'kds', 'discounts', 'split_payments', 'upi_qr_on_bill', 'advanced_reports',
    'waiter_reports', 'csv_export', 'remove_branding'
  ];
begin
  perform private.assert_keys(v_patch, array[
    'name', 'price_monthly_paise', 'price_yearly_paise', 'max_tables', 'max_staff', 'features',
    'razorpay_plan_id_monthly', 'razorpay_plan_id_yearly', 'is_active', 'sort_order'
  ]);

  select * into v_plan from public.plans p where p.id = p_plan_id for update;
  if not found then
    perform private.fail('PLAN_NOT_FOUND');
  end if;
  v_updated := v_plan;

  if v_patch ? 'name' then
    v_updated.name := private.tidy_text(private.json_text(v_patch, 'name'));
    if v_updated.name is null or length(v_updated.name) > 40 then
      perform private.fail('INVALID_INPUT', 'name');
    end if;
  end if;
  if v_patch ? 'price_monthly_paise' then
    v_updated.price_monthly_paise := private.json_int(v_patch, 'price_monthly_paise');
    if v_updated.price_monthly_paise not between 0 and 100000000 then
      perform private.fail('INVALID_INPUT', 'price_monthly_paise');
    end if;
  end if;
  if v_patch ? 'price_yearly_paise' then
    v_updated.price_yearly_paise := private.json_int(v_patch, 'price_yearly_paise');
    if v_updated.price_yearly_paise not between 0 and 100000000 then
      perform private.fail('INVALID_INPUT', 'price_yearly_paise');
    end if;
  end if;
  foreach v_key in array array['max_tables', 'max_staff'] loop
    if v_patch ? v_key and jsonb_typeof(v_patch -> v_key) <> 'null' then
      if private.json_int(v_patch, v_key) not between 1 and 10000 then
        perform private.fail('INVALID_INPUT', v_key);
      end if;
    end if;
  end loop;
  if v_patch ? 'max_tables' then
    v_updated.max_tables := (v_patch ->> 'max_tables')::int;
  end if;
  if v_patch ? 'max_staff' then
    v_updated.max_staff := (v_patch ->> 'max_staff')::int;
  end if;
  if v_patch ? 'features' then
    if jsonb_typeof(v_patch -> 'features') <> 'object' then
      perform private.fail('INVALID_INPUT', 'features');
    end if;
    for v_key in select jsonb_object_keys(v_patch -> 'features') loop
      if not v_key = any (v_known_features)
        or jsonb_typeof(v_patch -> 'features' -> v_key) <> 'boolean'
      then
        perform private.fail('INVALID_INPUT', 'features');
      end if;
    end loop;
    v_updated.features := v_plan.features || (v_patch -> 'features');
  end if;
  foreach v_key in array array['razorpay_plan_id_monthly', 'razorpay_plan_id_yearly'] loop
    if v_patch ? v_key then
      if coalesce(nullif(btrim(private.json_text(v_patch, v_key)), ''), 'plan_x') !~ '^[A-Za-z0-9_]{1,60}$' then
        perform private.fail('INVALID_INPUT', v_key);
      end if;
    end if;
  end loop;
  if v_patch ? 'razorpay_plan_id_monthly' then
    v_updated.razorpay_plan_id_monthly := nullif(btrim(v_patch ->> 'razorpay_plan_id_monthly'), '');
  end if;
  if v_patch ? 'razorpay_plan_id_yearly' then
    v_updated.razorpay_plan_id_yearly := nullif(btrim(v_patch ->> 'razorpay_plan_id_yearly'), '');
  end if;
  if v_patch ? 'is_active' then
    v_updated.is_active := private.json_bool(v_patch, 'is_active');
  end if;
  if v_patch ? 'sort_order' then
    v_updated.sort_order := private.json_int(v_patch, 'sort_order');
    if v_updated.sort_order not between 0 and 1000 then
      perform private.fail('INVALID_INPUT', 'sort_order');
    end if;
  end if;

  -- A Razorpay plan's amount can't change (P8-10): a new price needs a new
  -- Razorpay plan, unless a different id comes with it.
  if v_updated.price_monthly_paise <> v_plan.price_monthly_paise
     and v_updated.razorpay_plan_id_monthly is not distinct from v_plan.razorpay_plan_id_monthly then
    v_updated.razorpay_plan_id_monthly := null;
  end if;
  if v_updated.price_yearly_paise <> v_plan.price_yearly_paise
     and v_updated.razorpay_plan_id_yearly is not distinct from v_plan.razorpay_plan_id_yearly then
    v_updated.razorpay_plan_id_yearly := null;
  end if;

  update public.plans p
    set name = v_updated.name,
        price_monthly_paise = v_updated.price_monthly_paise,
        price_yearly_paise = v_updated.price_yearly_paise,
        max_tables = v_updated.max_tables,
        max_staff = v_updated.max_staff,
        features = v_updated.features,
        razorpay_plan_id_monthly = v_updated.razorpay_plan_id_monthly,
        razorpay_plan_id_yearly = v_updated.razorpay_plan_id_yearly,
        is_active = v_updated.is_active,
        sort_order = v_updated.sort_order
    where p.id = p_plan_id
    returning * into v_updated;

  -- Audit only what changed.
  for v_key in
    select jsonb_object_keys(v_patch)
    union select unnest(array['razorpay_plan_id_monthly', 'razorpay_plan_id_yearly'])
  loop
    if (to_jsonb(v_plan) -> v_key) is distinct from (to_jsonb(v_updated) -> v_key) then
      v_before := v_before || jsonb_build_object(v_key, to_jsonb(v_plan) -> v_key);
      v_after := v_after || jsonb_build_object(v_key, to_jsonb(v_updated) -> v_key);
    end if;
  end loop;
  if v_after <> '{}'::jsonb then
    perform private.audit_platform(
      v_admin, null, 'plan.updated', 'plan', p_plan_id,
      v_before || jsonb_build_object('code', v_plan.code),
      v_after
    );
  end if;

  return to_jsonb(v_updated) - 'created_at' - 'updated_at';
end;
$$;
