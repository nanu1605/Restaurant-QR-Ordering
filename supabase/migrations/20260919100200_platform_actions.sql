-- Platform actions (spec §9.3, §13.4, §14.5, docs/DECISIONS.md P7-4): suspend
-- and unsuspend, extend a trial, change plan, record a manual payment and
-- reset an owner's password. Platform admins only (aal2); every action writes
-- an audit row.

-- Suspend (reason required) or bring back a restaurant. Suspension makes it
-- read-only through restaurant_access (§10.6): customers can't order, but
-- open tables can still be billed.
create or replace function public.platform_set_restaurant_status(
  p_restaurant_id uuid,
  p_status text,
  p_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.current_platform_admin();
  v_restaurant public.restaurants;
  v_reason text := private.tidy_text(p_reason);
begin
  if p_status is null or p_status not in ('active', 'suspended') then
    perform private.fail('INVALID_INPUT', 'status');
  end if;
  if v_reason is not null and length(v_reason) > 300 then
    perform private.fail('INVALID_INPUT', 'reason');
  end if;

  select * into v_restaurant from public.restaurants r where r.id = p_restaurant_id for update;
  if not found then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;

  if p_status = 'suspended' then
    if v_reason is null then
      perform private.fail('REASON_REQUIRED');
    end if;
    update public.restaurants
      set status = 'suspended', suspended_reason = v_reason
      where id = p_restaurant_id;
    perform private.audit_platform(
      v_admin, p_restaurant_id, 'restaurant.suspended', 'restaurant', p_restaurant_id,
      jsonb_build_object('status', v_restaurant.status, 'suspended_reason', v_restaurant.suspended_reason),
      jsonb_build_object('status', 'suspended', 'suspended_reason', v_reason),
      v_reason
    );
  elsif v_restaurant.status = 'suspended' then
    update public.restaurants
      set status = 'active', suspended_reason = null
      where id = p_restaurant_id;
    perform private.audit_platform(
      v_admin, p_restaurant_id, 'restaurant.unsuspended', 'restaurant', p_restaurant_id,
      jsonb_build_object('status', 'suspended', 'suspended_reason', v_restaurant.suspended_reason),
      jsonb_build_object('status', 'active'),
      v_reason
    );
  end if;

  return (
    select jsonb_build_object('status', r.status, 'suspended_reason', r.suspended_reason)
    from public.restaurants r where r.id = p_restaurant_id
  );
end;
$$;

-- Adds days to a running or ended trial: from its end, or from now if it has
-- already ended. Paid and cancelled subscriptions aren't trials.
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

-- Moves a restaurant to another active plan, keeping the status and dates.
-- Lower limits never deactivate existing tables or staff (§14.2).
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

-- A payment received outside Razorpay (§14.5): bank transfer, cash, UPI or
-- cheque. Keys: amount_paise, mode, billing_cycle, period_start, period_end
-- (business dates, end inclusive), notes. The subscription becomes active and
-- manual; its period moves to the payment's end when that is later, so a
-- payment for an earlier period never shortens access.
create or replace function public.platform_record_manual_payment(
  p_restaurant_id uuid,
  p_payment jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.current_platform_admin();
  v_payment jsonb := coalesce(p_payment, '{}'::jsonb);
  v_restaurant public.restaurants;
  v_subscription public.restaurant_subscriptions;
  v_amount bigint;
  v_mode text;
  v_cycle text;
  v_from date;
  v_to date;
  v_notes text;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_payment_id uuid;
begin
  perform private.assert_keys(
    v_payment, array['amount_paise', 'mode', 'billing_cycle', 'period_start', 'period_end', 'notes']
  );
  v_amount := private.json_int(v_payment, 'amount_paise');
  if v_amount < 1 or v_amount > 100000000 then
    perform private.fail('INVALID_INPUT', 'amount_paise');
  end if;
  v_mode := private.json_text(v_payment, 'mode');
  if v_mode is null or v_mode not in ('bank_transfer', 'cash', 'upi', 'cheque') then
    perform private.fail('INVALID_INPUT', 'mode');
  end if;
  v_cycle := private.json_text(v_payment, 'billing_cycle');
  if v_cycle is null or v_cycle not in ('monthly', 'yearly') then
    perform private.fail('INVALID_INPUT', 'billing_cycle');
  end if;
  v_from := private.json_date(v_payment, 'period_start');
  v_to := private.json_date(v_payment, 'period_end');
  if v_from is null or v_to is null or v_to < v_from or v_to - v_from > 1096 then
    perform private.fail('INVALID_PERIOD');
  end if;
  v_notes := private.tidy_text(private.json_text(v_payment, 'notes'));
  if v_notes is not null and length(v_notes) > 500 then
    perform private.fail('INVALID_INPUT', 'notes');
  end if;

  select * into v_restaurant from public.restaurants r where r.id = p_restaurant_id;
  if not found then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;
  select * into v_subscription
  from public.restaurant_subscriptions s
  where s.restaurant_id = p_restaurant_id
  for update;
  if not found then
    perform private.fail('SUBSCRIPTION_NOT_FOUND');
  end if;

  select b.starts_at, b.ends_at
  into v_starts_at, v_ends_at
  from private.business_day_bounds(
    v_from, v_to, v_restaurant.timezone, v_restaurant.business_day_start_hour
  ) as b;

  insert into public.subscription_payments (
    restaurant_id, source, amount_paise, manual_mode, period_start, period_end, notes, recorded_by
  )
  values (
    p_restaurant_id, 'manual', v_amount, v_mode::public.manual_payment_mode,
    v_starts_at, v_ends_at, v_notes, v_admin.user_id
  )
  returning id into v_payment_id;

  update public.restaurant_subscriptions s
    set status = 'active',
        source = 'manual',
        billing_cycle = v_cycle::public.billing_cycle,
        current_period_start = case
          when s.current_period_end is null or v_ends_at > s.current_period_end then v_starts_at
          else s.current_period_start
        end,
        current_period_end = greatest(s.current_period_end, v_ends_at),
        grace_until = null,
        cancel_at_period_end = false
    where s.id = v_subscription.id
    returning * into v_subscription;

  perform private.audit_platform(
    v_admin, p_restaurant_id, 'subscription.payment_recorded', 'subscription_payment', v_payment_id,
    null,
    jsonb_build_object(
      'amount_paise', v_amount,
      'mode', v_mode,
      'billing_cycle', v_cycle,
      'period_start', v_starts_at,
      'period_end', v_ends_at,
      'current_period_end', v_subscription.current_period_end
    ),
    v_notes
  );

  return jsonb_build_object(
    'payment_id', v_payment_id,
    'status', v_subscription.status,
    'current_period_end', v_subscription.current_period_end
  );
end;
$$;

-- Lets the platform admin set a new password for a restaurant owner: returns
-- the owner's auth user id, and the server sets the password through the
-- Admin API, as admin_reset_staff_password does for staff.
create or replace function public.platform_reset_owner_password(p_member_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.current_platform_admin();
  v_member public.restaurant_members;
begin
  select * into v_member from public.restaurant_members m where m.id = p_member_id;
  if not found or v_member.role <> 'owner' then
    perform private.fail('MEMBER_NOT_FOUND');
  end if;
  perform private.audit_platform(
    v_admin, v_member.restaurant_id, 'staff.password_reset', 'restaurant_member', v_member.id
  );
  return v_member.user_id;
end;
$$;

revoke execute on function public.platform_set_restaurant_status(uuid, text, text) from public, anon;
revoke execute on function public.platform_extend_trial(uuid, int) from public, anon;
revoke execute on function public.platform_change_plan(uuid, text) from public, anon;
revoke execute on function public.platform_record_manual_payment(uuid, jsonb) from public, anon;
revoke execute on function public.platform_reset_owner_password(uuid) from public, anon;
grant execute on function public.platform_set_restaurant_status(uuid, text, text) to authenticated;
grant execute on function public.platform_extend_trial(uuid, int) to authenticated;
grant execute on function public.platform_change_plan(uuid, text) to authenticated;
grant execute on function public.platform_record_manual_payment(uuid, jsonb) to authenticated;
grant execute on function public.platform_reset_owner_password(uuid) to authenticated;

-- Onboarding (P7-9): the wizard sends the trial length and tax defaults as
-- numbers and booleans; bad values are refused as INVALID_INPUT instead of
-- raw cast errors.
create or replace function public.platform_create_restaurant(p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_slug text := lower(btrim(p_payload ->> 'slug'));
  v_owner_user_id uuid := nullif(p_payload #>> '{owner,user_id}', '')::uuid;
  v_owner_username text := lower(btrim(p_payload #>> '{owner,username}'));
  v_owner_name text := btrim(p_payload #>> '{owner,display_name}');
  v_plan_code text := coalesce(nullif(p_payload ->> 'plan_code', ''), 'growth');
  v_actor uuid := nullif(p_payload ->> 'actor_user_id', '')::uuid;
  v_categories jsonb := coalesce(p_payload -> 'categories', '[]'::jsonb);
  v_trial_days int;
  v_plan_id uuid;
  v_restaurant public.restaurants%rowtype;
  v_member_id uuid;
  v_category_count int;
begin
  if coalesce(btrim(p_payload ->> 'name'), '') = '' or coalesce(v_slug, '') = '' then
    raise exception using errcode = 'P0001', message = 'NAME_AND_SLUG_REQUIRED';
  end if;
  if v_slug !~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$' then
    raise exception using errcode = 'P0001', message = 'INVALID_SLUG';
  end if;
  if exists (select 1 from public.restaurants where slug = v_slug) then
    raise exception using errcode = 'P0001', message = 'SLUG_TAKEN';
  end if;
  if v_owner_user_id is null or not exists (select 1 from auth.users where id = v_owner_user_id) then
    raise exception using errcode = 'P0001', message = 'OWNER_USER_NOT_FOUND';
  end if;
  if coalesce(v_owner_name, '') = '' or coalesce(v_owner_username, '') !~ '^[a-z0-9_]{3,30}$' then
    raise exception using errcode = 'P0001', message = 'INVALID_OWNER';
  end if;
  -- MVP: an account belongs to at most one restaurant (spec §3).
  if exists (select 1 from public.restaurant_members where user_id = v_owner_user_id) then
    raise exception using errcode = 'P0001', message = 'USER_ALREADY_MEMBER';
  end if;
  if jsonb_typeof(v_categories) <> 'array' or jsonb_array_length(v_categories) > 50 then
    raise exception using errcode = 'P0001', message = 'INVALID_CATEGORIES';
  end if;

  select id into v_plan_id from public.plans where code = v_plan_code and is_active;
  if v_plan_id is null then
    raise exception using errcode = 'P0001', message = 'PLAN_NOT_FOUND';
  end if;

  -- Trial length and GST rate come from the onboarding wizard as numbers.
  if coalesce(jsonb_typeof(p_payload -> 'trial_days'), 'null') = 'null' then
    select ps.trial_days into v_trial_days from public.platform_settings ps where ps.id = 1;
  else
    v_trial_days := private.json_int(p_payload, 'trial_days');
    if v_trial_days not between 1 and 365 then
      perform private.fail('INVALID_INPUT', 'trial_days');
    end if;
  end if;
  if coalesce(jsonb_typeof(p_payload -> 'gst_rate_bps'), 'null') <> 'null' then
    perform private.json_int(p_payload, 'gst_rate_bps');
  end if;
  if coalesce(jsonb_typeof(p_payload -> 'prices_include_tax'), 'null') <> 'null' then
    perform private.json_bool(p_payload, 'prices_include_tax');
  end if;
  if coalesce(nullif(p_payload ->> 'gst_mode', ''), 'none') not in ('none', 'regular', 'composition') then
    perform private.fail('INVALID_INPUT', 'gst_mode');
  end if;

  if not private.is_valid_timezone(coalesce(p_payload ->> 'timezone', 'Asia/Kolkata')) then
    raise exception using errcode = 'P0001', message = 'INVALID_TIMEZONE';
  end if;

  insert into public.restaurants (
    name, slug, legal_name, address_line, city, state, pincode, phone, email,
    timezone, gst_mode, gst_rate_bps, prices_include_tax
  )
  values (
    btrim(p_payload ->> 'name'),
    v_slug,
    nullif(btrim(p_payload ->> 'legal_name'), ''),
    nullif(btrim(p_payload ->> 'address_line'), ''),
    nullif(btrim(p_payload ->> 'city'), ''),
    nullif(btrim(p_payload ->> 'state'), ''),
    nullif(btrim(p_payload ->> 'pincode'), ''),
    nullif(btrim(p_payload ->> 'phone'), ''),
    nullif(btrim(p_payload ->> 'email'), ''),
    coalesce(nullif(p_payload ->> 'timezone', ''), 'Asia/Kolkata'),
    coalesce(nullif(p_payload ->> 'gst_mode', ''), 'none')::public.gst_mode,
    coalesce((p_payload ->> 'gst_rate_bps')::int, 500),
    coalesce((p_payload ->> 'prices_include_tax')::boolean, false)
  )
  returning * into v_restaurant;

  insert into public.restaurant_members (restaurant_id, user_id, role, display_name, username)
  values (v_restaurant.id, v_owner_user_id, 'owner', v_owner_name, v_owner_username)
  returning id into v_member_id;

  insert into public.restaurant_subscriptions (restaurant_id, plan_id, status, trial_ends_at)
  values (v_restaurant.id, v_plan_id, 'trialing', now() + make_interval(days => v_trial_days));

  -- Default categories in the given order; blank and repeated names are skipped.
  insert into public.menu_categories (restaurant_id, name, sort_order, source)
  select v_restaurant.id, c.name, row_number() over (order by c.ord), 'default'
  from (
    select distinct on (private.normalize_name(t.name)) private.tidy_text(t.name) as name, t.ord
    from jsonb_array_elements_text(v_categories) with ordinality as t(name, ord)
    where private.tidy_text(t.name) is not null
    order by private.normalize_name(t.name), t.ord
  ) as c;
  get diagnostics v_category_count = row_count;

  perform private.write_audit(
    v_restaurant.id,
    case when v_actor is null then 'system' else 'platform_admin' end::public.actor_type,
    v_actor,
    null,
    case when v_actor is null then 'System' else 'Platform admin' end,
    'restaurant.created',
    'restaurant',
    v_restaurant.id,
    null,
    jsonb_build_object(
      'name', v_restaurant.name,
      'slug', v_restaurant.slug,
      'plan_code', v_plan_code,
      'trial_days', v_trial_days,
      'owner_member_id', v_member_id,
      'default_categories', v_category_count
    )
  );

  return jsonb_build_object('restaurant_id', v_restaurant.id, 'owner_member_id', v_member_id);
end;
$$;

revoke execute on function public.platform_create_restaurant(jsonb) from public, anon, authenticated;
grant execute on function public.platform_create_restaurant(jsonb) to service_role;
