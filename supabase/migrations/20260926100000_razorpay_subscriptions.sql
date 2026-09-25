-- Razorpay subscriptions (spec §14.3, §14.4, docs/DECISIONS.md P8-2 … P8-8):
-- the subscription state machine driven by Razorpay's subscription entity,
-- the webhook store and the server-side save used after checkout, cancel and
-- sync. Everything that accepts Razorpay data is service_role only: owners
-- can call PostgREST, and must never be able to claim a paid subscription.

alter table public.restaurant_subscriptions
  -- Razorpay's own state for razorpay_subscription_id, as last seen.
  add column razorpay_status text check (razorpay_status in (
    'created', 'authenticated', 'active', 'pending', 'halted', 'cancelled', 'completed',
    'expired', 'paused'
  )),
  -- Time of the newest Razorpay event applied; older events arriving late
  -- no longer change the status (payments are still recorded).
  add column razorpay_event_at timestamptz,
  -- The plan and cycle the Razorpay subscription charges for. They become
  -- plan_id / billing_cycle only once it is paid, so a trial keeps its plan.
  add column next_plan_id uuid references public.plans (id),
  add column next_billing_cycle public.billing_cycle;

create index restaurant_subscriptions_next_plan_idx
  on public.restaurant_subscriptions (next_plan_id);

-- A Unix timestamp from a Razorpay entity, or null when absent.
create or replace function private.json_unix(p_obj jsonb, p_key text)
returns timestamptz
language plpgsql
immutable
set search_path = ''
as $$
begin
  if jsonb_typeof(p_obj -> p_key) is null or jsonb_typeof(p_obj -> p_key) = 'null' then
    return null;
  end if;
  if jsonb_typeof(p_obj -> p_key) <> 'number' or (p_obj ->> p_key) !~ '^[0-9]{1,12}$' then
    perform private.fail('INVALID_INPUT', p_key);
  end if;
  return to_timestamp((p_obj ->> p_key)::bigint);
end;
$$;

-- Applies a Razorpay subscription entity to the restaurant's subscription
-- (P8-3). p_payment is the payment of a subscription.charged event, null
-- otherwise. Only the current razorpay_subscription_id changes the status;
-- payments are recorded whichever subscription they came from. Returns
-- 'applied', 'stale' (older than the last event applied) or 'not_current'.
create or replace function private.apply_razorpay_subscription(
  p_restaurant_id uuid,
  p_entity jsonb,
  p_payment jsonb,
  p_event_at timestamptz
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id text;
  v_status text;
  v_start timestamptz;
  v_end timestamptz;
  v_customer text;
  v_sub public.restaurant_subscriptions;
  v_after public.restaurant_subscriptions;
  v_grace_days int;
  v_payment_id text;
  v_amount bigint;
  v_payment_row uuid;
begin
  if jsonb_typeof(p_entity) is distinct from 'object' then
    perform private.fail('INVALID_INPUT', 'subscription');
  end if;
  v_id := private.json_text(p_entity, 'id');
  v_status := private.json_text(p_entity, 'status');
  if v_id is null or v_id !~ '^sub_[A-Za-z0-9]{1,40}$' then
    perform private.fail('INVALID_INPUT', 'subscription.id');
  end if;
  if v_status is null or v_status not in (
    'created', 'authenticated', 'active', 'pending', 'halted', 'cancelled', 'completed',
    'expired', 'paused'
  ) then
    perform private.fail('INVALID_INPUT', 'subscription.status');
  end if;
  v_start := private.json_unix(p_entity, 'current_start');
  v_end := private.json_unix(p_entity, 'current_end');
  v_customer := private.json_text(p_entity, 'customer_id');

  select * into v_sub
  from public.restaurant_subscriptions s
  where s.restaurant_id = p_restaurant_id
  for update;
  if not found then
    perform private.fail('SUBSCRIPTION_NOT_FOUND');
  end if;

  -- Money is recorded whatever happens to the status.
  if p_payment is not null then
    if jsonb_typeof(p_payment) is distinct from 'object' then
      perform private.fail('INVALID_INPUT', 'payment');
    end if;
    v_payment_id := private.json_text(p_payment, 'id');
    if v_payment_id is null or v_payment_id !~ '^pay_[A-Za-z0-9]{1,40}$' then
      perform private.fail('INVALID_INPUT', 'payment.id');
    end if;
    v_amount := private.json_int(p_payment, 'amount');
    if v_amount < 1 or v_amount > 100000000 then
      perform private.fail('INVALID_INPUT', 'payment.amount');
    end if;
    insert into public.subscription_payments (
      restaurant_id, source, amount_paise, razorpay_payment_id, period_start, period_end
    )
    values (
      p_restaurant_id, 'razorpay', v_amount, v_payment_id,
      v_start, case when v_end > v_start then v_end end
    )
    on conflict (razorpay_payment_id) do nothing
    returning id into v_payment_row;
    if v_payment_row is not null then
      perform private.write_audit(
        p_restaurant_id, 'system', null, null, 'Razorpay',
        'subscription.payment_received', 'subscription_payment', v_payment_row, null,
        jsonb_build_object(
          'amount_paise', v_amount, 'razorpay_payment_id', v_payment_id,
          'razorpay_subscription_id', v_id, 'period_start', v_start, 'period_end', v_end
        )
      );
    end if;
  end if;

  if v_sub.razorpay_subscription_id is distinct from v_id then
    return 'not_current';
  end if;
  if p_event_at < v_sub.razorpay_event_at then
    return 'stale';
  end if;

  select ps.grace_days into v_grace_days from public.platform_settings ps where ps.id = 1;

  update public.restaurant_subscriptions s
    set razorpay_status = v_status,
        razorpay_event_at = greatest(s.razorpay_event_at, p_event_at),
        razorpay_customer_id = coalesce(v_customer, s.razorpay_customer_id)
    where s.id = v_sub.id;

  case v_status
    when 'active' then
      update public.restaurant_subscriptions s
        set status = 'active',
            source = 'razorpay',
            plan_id = coalesce(s.next_plan_id, s.plan_id),
            billing_cycle = coalesce(s.next_billing_cycle, s.billing_cycle),
            next_plan_id = null,
            next_billing_cycle = null,
            current_period_start = case
              when v_end is not null and (s.current_period_end is null or v_end > s.current_period_end)
                then coalesce(v_start, s.current_period_start)
              else s.current_period_start
            end,
            current_period_end = greatest(s.current_period_end, v_end),
            grace_until = null,
            -- Only the current subscription charges, so a charge means it renews.
            cancel_at_period_end = case when p_payment is not null then false else s.cancel_at_period_end end
        where s.id = v_sub.id;
    when 'pending' then
      update public.restaurant_subscriptions s
        set status = 'past_due',
            grace_until = coalesce(s.grace_until, p_event_at + make_interval(days => coalesce(v_grace_days, 7)))
        where s.id = v_sub.id;
    when 'halted' then
      update public.restaurant_subscriptions s
        set status = 'halted',
            grace_until = coalesce(s.grace_until, p_event_at + make_interval(days => coalesce(v_grace_days, 7)))
        where s.id = v_sub.id;
    when 'cancelled', 'completed', 'expired' then
      -- Razorpay only ends what Razorpay started: cancelling a trial's mandate
      -- or a halted subscription never cuts a trial or grace short.
      update public.restaurant_subscriptions s
        set status = case
              when s.status = 'active' and s.source = 'razorpay' and v_status = 'cancelled' then 'cancelled'
              when s.status = 'active' and s.source = 'razorpay' and v_status = 'completed' then 'expired'
              else s.status
            end,
            next_plan_id = null,
            next_billing_cycle = null
        where s.id = v_sub.id;
    else
      -- created, authenticated, paused: nothing beyond razorpay_status.
      null;
  end case;

  select * into v_after from public.restaurant_subscriptions s where s.id = v_sub.id;
  if (v_sub.status, v_sub.plan_id, v_sub.current_period_end, v_sub.grace_until,
      v_sub.cancel_at_period_end, v_sub.razorpay_status)
     is distinct from
     (v_after.status, v_after.plan_id, v_after.current_period_end, v_after.grace_until,
      v_after.cancel_at_period_end, v_after.razorpay_status)
  then
    perform private.write_audit(
      p_restaurant_id, 'system', null, null, 'Razorpay',
      'subscription.razorpay_updated', 'restaurant_subscription', v_sub.id,
      jsonb_build_object(
        'status', v_sub.status, 'plan_id', v_sub.plan_id,
        'current_period_end', v_sub.current_period_end, 'grace_until', v_sub.grace_until,
        'cancel_at_period_end', v_sub.cancel_at_period_end, 'razorpay_status', v_sub.razorpay_status
      ),
      jsonb_build_object(
        'status', v_after.status, 'plan_id', v_after.plan_id,
        'current_period_end', v_after.current_period_end, 'grace_until', v_after.grace_until,
        'cancel_at_period_end', v_after.cancel_at_period_end,
        'razorpay_status', v_after.razorpay_status, 'razorpay_subscription_id', v_id
      )
    );
  end if;
  return 'applied';
end;
$$;

-- A payment_link.paid event (§14.5, P8-5). Notes: restaurant_id, purpose
-- ('subscription' or 'setup_fee') and months (1–24, subscription only). A
-- subscription link extends access from the first business day not yet paid
-- for; a setup fee is only recorded. A payment already recorded changes nothing.
create or replace function private.apply_razorpay_payment_link(
  p_link jsonb,
  p_payment jsonb,
  p_event_at timestamptz
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_notes jsonb;
  v_restaurant public.restaurants;
  v_sub public.restaurant_subscriptions;
  v_restaurant_id uuid;
  v_purpose text;
  v_months int;
  v_payment_id text;
  v_amount bigint;
  v_link_id text;
  v_covered timestamptz;
  v_from date;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_payment_row uuid;
begin
  if jsonb_typeof(p_link) is distinct from 'object' or jsonb_typeof(p_payment) is distinct from 'object' then
    perform private.fail('INVALID_INPUT', 'payment_link');
  end if;
  v_notes := coalesce(p_link -> 'notes', '{}'::jsonb);
  if jsonb_typeof(v_notes) <> 'object' then
    perform private.fail('INVALID_INPUT', 'notes');
  end if;
  v_restaurant_id := private.json_uuid(v_notes, 'restaurant_id');
  v_purpose := private.json_text(v_notes, 'purpose');
  if v_purpose is null or v_purpose not in ('subscription', 'setup_fee') then
    perform private.fail('INVALID_INPUT', 'notes.purpose');
  end if;
  if v_purpose = 'subscription' then
    -- Razorpay notes are strings; accept a number too.
    if coalesce(v_notes ->> 'months', '') !~ '^[0-9]{1,2}$' then
      perform private.fail('INVALID_INPUT', 'notes.months');
    end if;
    v_months := (v_notes ->> 'months')::int;
    if v_months not between 1 and 24 then
      perform private.fail('INVALID_INPUT', 'notes.months');
    end if;
  end if;
  v_link_id := private.json_text(p_link, 'id');
  v_payment_id := private.json_text(p_payment, 'id');
  if v_payment_id is null or v_payment_id !~ '^pay_[A-Za-z0-9]{1,40}$' then
    perform private.fail('INVALID_INPUT', 'payment.id');
  end if;
  v_amount := private.json_int(p_payment, 'amount');
  if v_amount < 1 or v_amount > 100000000 then
    perform private.fail('INVALID_INPUT', 'payment.amount');
  end if;

  select * into v_restaurant from public.restaurants r where r.id = v_restaurant_id;
  if not found then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;
  select * into v_sub
  from public.restaurant_subscriptions s
  where s.restaurant_id = v_restaurant_id
  for update;
  if not found then
    perform private.fail('SUBSCRIPTION_NOT_FOUND');
  end if;

  if v_purpose = 'subscription' then
    -- Paid up to: the trial's end, else the paid period's end.
    v_covered := case
      when v_sub.status = 'trialing' then v_sub.trial_ends_at
      else v_sub.current_period_end
    end;
    v_from := private.business_date(
      greatest(coalesce(v_covered, p_event_at), p_event_at),
      v_restaurant.timezone, v_restaurant.business_day_start_hour
    );
    select b.starts_at, b.ends_at
    into v_starts_at, v_ends_at
    from private.business_day_bounds(
      v_from, (v_from + make_interval(months => v_months))::date - 1,
      v_restaurant.timezone, v_restaurant.business_day_start_hour
    ) as b;
  end if;

  insert into public.subscription_payments (
    restaurant_id, source, amount_paise, razorpay_payment_id, period_start, period_end, notes
  )
  values (
    v_restaurant_id, 'payment_link', v_amount, v_payment_id, v_starts_at, v_ends_at,
    case v_purpose
      when 'setup_fee' then 'Setup fee'
      else format('Payment link, %s %s', v_months, case when v_months = 1 then 'month' else 'months' end)
    end
  )
  on conflict (razorpay_payment_id) do nothing
  returning id into v_payment_row;
  if v_payment_row is null then
    return 'duplicate_payment';
  end if;

  if v_purpose = 'subscription' then
    update public.restaurant_subscriptions s
      set status = 'active',
          source = 'manual',
          billing_cycle = case when v_months % 12 = 0 then 'yearly' else 'monthly' end::public.billing_cycle,
          current_period_start = case
            when s.current_period_end is null or v_ends_at > s.current_period_end then v_starts_at
            else s.current_period_start
          end,
          current_period_end = greatest(s.current_period_end, v_ends_at),
          grace_until = null,
          cancel_at_period_end = false
      where s.id = v_sub.id;
  end if;

  perform private.write_audit(
    v_restaurant_id, 'system', null, null, 'Razorpay',
    'subscription.payment_received', 'subscription_payment', v_payment_row, null,
    jsonb_build_object(
      'amount_paise', v_amount, 'razorpay_payment_id', v_payment_id, 'payment_link_id', v_link_id,
      'purpose', v_purpose, 'months', v_months, 'period_start', v_starts_at, 'period_end', v_ends_at
    )
  );
  return 'applied';
end;
$$;

-- Routes a stored webhook event (§14.4). The restaurant comes from the
-- subscription id, else from notes.restaurant_id set when it was created.
-- Returns what happened, or 'ignored' for events MenuMesh doesn't use.
create or replace function private.apply_razorpay_event(p_payload jsonb, p_event_at timestamptz)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_type text := p_payload ->> 'event';
  v_entity jsonb;
  v_restaurant_id uuid;
  v_note text;
begin
  if v_type in (
    'subscription.authenticated', 'subscription.activated', 'subscription.charged',
    'subscription.completed', 'subscription.updated', 'subscription.pending',
    'subscription.halted', 'subscription.cancelled', 'subscription.paused',
    'subscription.resumed'
  ) then
    v_entity := p_payload #> '{payload,subscription,entity}';
    if jsonb_typeof(v_entity) is distinct from 'object' then
      perform private.fail('INVALID_INPUT', 'payload.subscription');
    end if;
    select s.restaurant_id into v_restaurant_id
    from public.restaurant_subscriptions s
    where s.razorpay_subscription_id = v_entity ->> 'id';
    if v_restaurant_id is null then
      v_note := v_entity #>> '{notes,restaurant_id}';
      if v_note ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        select r.id into v_restaurant_id from public.restaurants r where r.id = v_note::uuid;
      end if;
    end if;
    if v_restaurant_id is null then
      perform private.fail('RESTAURANT_NOT_FOUND');
    end if;
    return private.apply_razorpay_subscription(
      v_restaurant_id,
      v_entity,
      -- Only a charge pays for a period; the authentication payment is refunded.
      case when v_type = 'subscription.charged' then p_payload #> '{payload,payment,entity}' end,
      p_event_at
    );
  elsif v_type = 'payment_link.paid' then
    return private.apply_razorpay_payment_link(
      p_payload #> '{payload,payment_link,entity}',
      p_payload #> '{payload,payment,entity}',
      p_event_at
    );
  end if;
  return 'ignored';
end;
$$;

-- Stores a verified webhook (the route checks the signature first) and
-- processes it. A repeated event id changes nothing. A processing error is
-- kept on the event for the super-admin webhooks page; the event itself stays
-- stored, so Razorpay gets a 200 and doesn't retry forever.
-- Returns 'duplicate', 'failed', 'ignored', 'applied', 'stale',
-- 'not_current' or 'duplicate_payment'.
create or replace function public.razorpay_record_webhook(p_event_id text, p_payload jsonb)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_type text;
  v_event_at timestamptz;
  v_result text;
  v_message text;
  v_detail text;
begin
  if p_event_id is null or length(p_event_id) not between 1 and 200 then
    perform private.fail('INVALID_INPUT', 'event_id');
  end if;
  if jsonb_typeof(p_payload) is distinct from 'object' then
    perform private.fail('INVALID_INPUT', 'payload');
  end if;
  v_type := coalesce(left(p_payload ->> 'event', 100), 'unknown');

  insert into public.webhook_events (provider, event_id, event_type, payload)
  values ('razorpay', p_event_id, v_type, p_payload)
  on conflict (provider, event_id) do nothing
  returning id into v_id;
  if v_id is null then
    return 'duplicate';
  end if;

  begin
    v_event_at := coalesce(private.json_unix(p_payload, 'created_at'), now());
    v_result := private.apply_razorpay_event(p_payload, v_event_at);
    update public.webhook_events set processed_at = now() where id = v_id;
    return v_result;
  exception when others then
    get stacked diagnostics v_message = message_text, v_detail = pg_exception_detail;
    update public.webhook_events
      set processing_error = left(v_message || coalesce(nullif(' (' || v_detail || ')', ' ()'), ''), 500)
      where id = v_id;
    return 'failed';
  end;
end;
$$;

-- Saves a Razorpay subscription fetched or created by the server (P8-6):
-- attaches a new one after checkout starts, marks a cancel at period end,
-- and applies the fetched state (checkout confirm, sync, dev simulator).
-- The server checks who is asking; p_actor_user_id is who to audit (an
-- owner of the restaurant or a platform admin; null for the simulator).
create or replace function public.razorpay_save_subscription(
  p_restaurant_id uuid,
  p_entity jsonb,
  p_actor_user_id uuid default null,
  p_cancel_scheduled boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_restaurant public.restaurants;
  v_sub public.restaurant_subscriptions;
  v_id text;
  v_notes jsonb;
  v_plan public.plans;
  v_cycle text;
  v_actor_type public.actor_type := 'system';
  v_actor_role public.member_role;
  v_actor_label text := 'Razorpay';
  v_result text;
begin
  if jsonb_typeof(p_entity) is distinct from 'object' then
    perform private.fail('INVALID_INPUT', 'subscription');
  end if;
  v_id := private.json_text(p_entity, 'id');
  if v_id is null or v_id !~ '^sub_[A-Za-z0-9]{1,40}$' then
    perform private.fail('INVALID_INPUT', 'subscription.id');
  end if;
  v_notes := coalesce(p_entity -> 'notes', '{}'::jsonb);
  if jsonb_typeof(v_notes) <> 'object'
     or (v_notes ->> 'restaurant_id') is distinct from p_restaurant_id::text then
    perform private.fail('INVALID_INPUT', 'notes.restaurant_id');
  end if;

  if p_actor_user_id is not null then
    if exists (select 1 from public.platform_admins a where a.user_id = p_actor_user_id) then
      v_actor_type := 'platform_admin';
      v_actor_label := 'Platform admin';
    else
      select 'staff', m.role, m.display_name
      into v_actor_type, v_actor_role, v_actor_label
      from public.restaurant_members m
      where m.user_id = p_actor_user_id and m.restaurant_id = p_restaurant_id
        and m.is_active and m.role = 'owner';
      if v_actor_role is null then
        perform private.fail('FORBIDDEN');
      end if;
    end if;
  end if;

  select * into v_restaurant from public.restaurants r where r.id = p_restaurant_id;
  if not found then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;
  select * into v_sub
  from public.restaurant_subscriptions s
  where s.restaurant_id = p_restaurant_id
  for update;
  if not found then
    perform private.fail('SUBSCRIPTION_NOT_FOUND');
  end if;

  if v_sub.razorpay_subscription_id is distinct from v_id then
    -- A new Razorpay subscription for this restaurant.
    if v_restaurant.status = 'suspended' then
      perform private.fail('RESTAURANT_SUSPENDED');
    end if;
    if v_sub.razorpay_status in ('authenticated', 'active') and not v_sub.cancel_at_period_end then
      perform private.fail('RAZORPAY_SUBSCRIPTION_LIVE');
    end if;
    select * into v_plan from public.plans p where p.code = v_notes ->> 'plan_code';
    if not found then
      perform private.fail('PLAN_NOT_FOUND');
    end if;
    if not v_plan.is_active then
      perform private.fail('PLAN_INACTIVE');
    end if;
    v_cycle := v_notes ->> 'billing_cycle';
    if v_cycle is null or v_cycle not in ('monthly', 'yearly') then
      perform private.fail('INVALID_INPUT', 'notes.billing_cycle');
    end if;

    update public.restaurant_subscriptions s
      set razorpay_subscription_id = v_id,
          razorpay_status = null,
          razorpay_event_at = null,
          next_plan_id = v_plan.id,
          next_billing_cycle = v_cycle::public.billing_cycle,
          -- The new subscription carries on after the current period.
          cancel_at_period_end = false
      where s.id = v_sub.id;
    perform private.write_audit(
      p_restaurant_id, v_actor_type, p_actor_user_id, v_actor_role, v_actor_label,
      'subscription.autopay_started', 'restaurant_subscription', v_sub.id,
      jsonb_build_object('razorpay_subscription_id', v_sub.razorpay_subscription_id),
      jsonb_build_object(
        'razorpay_subscription_id', v_id, 'plan_code', v_plan.code, 'billing_cycle', v_cycle
      )
    );
  end if;

  if p_cancel_scheduled and not v_sub.cancel_at_period_end then
    update public.restaurant_subscriptions s set cancel_at_period_end = true where s.id = v_sub.id;
    perform private.write_audit(
      p_restaurant_id, v_actor_type, p_actor_user_id, v_actor_role, v_actor_label,
      'subscription.cancel_scheduled', 'restaurant_subscription', v_sub.id,
      jsonb_build_object('cancel_at_period_end', false),
      jsonb_build_object('cancel_at_period_end', true, 'razorpay_subscription_id', v_id)
    );
  end if;

  v_result := private.apply_razorpay_subscription(p_restaurant_id, p_entity, null, now());

  select * into v_sub from public.restaurant_subscriptions s where s.id = v_sub.id;
  return jsonb_build_object(
    'result', v_result,
    'status', v_sub.status,
    'razorpay_status', v_sub.razorpay_status,
    'cancel_at_period_end', v_sub.cancel_at_period_end,
    'current_period_end', v_sub.current_period_end
  );
end;
$$;

-- ─── restaurant_access: autopay set up during a trial (P8-8) ────────────────
-- Same rules as before, plus: while trialing with a Razorpay mandate set up
-- (razorpay_status 'authenticated'), the first charge is due at the trial's
-- end, so access lapses 2 days later (the active buffer) and there is no
-- "trial ends soon" warning.
create or replace function public.restaurant_access(
  p_restaurant_id uuid,
  p_at timestamptz default now()
)
returns table (state text, reason text, restriction_at timestamptz, warning text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_restaurant public.restaurants%rowtype;
  v_sub public.restaurant_subscriptions%rowtype;
  v_lapse timestamptz;
  v_reason text;
  v_restriction timestamptz;
  v_warning text;
  v_autopay_trial boolean;
begin
  -- Service role (no signed-in user), platform admins and members only.
  if (select auth.uid()) is not null
     and not public.is_platform_admin()
     and public.member_role(p_restaurant_id) is null then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;

  select * into v_restaurant from public.restaurants where id = p_restaurant_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'RESTAURANT_NOT_FOUND';
  end if;

  if v_restaurant.status = 'suspended' then
    return query select 'read_only'::text, 'suspended'::text, null::timestamptz, null::text;
    return;
  end if;

  select * into v_sub from public.restaurant_subscriptions where restaurant_id = p_restaurant_id;
  if not found then
    return query select 'read_only'::text, 'no_subscription'::text, null::timestamptz, null::text;
    return;
  end if;

  v_autopay_trial := v_sub.status = 'trialing' and v_sub.razorpay_status = 'authenticated';

  -- 1. When does access lapse?
  case v_sub.status
    when 'trialing' then
      v_lapse := case
        when v_autopay_trial then v_sub.trial_ends_at + interval '2 days'
        else v_sub.trial_ends_at
      end;
      v_reason := 'trial_ended';
    when 'active' then
      -- Buffer for delayed renewal webhooks.
      v_lapse := v_sub.current_period_end + interval '2 days';
      v_reason := 'subscription_lapsed';
    when 'past_due', 'halted' then
      v_lapse := coalesce(v_sub.grace_until, v_sub.current_period_end + interval '2 days');
      v_reason := 'payment_failed';
    else -- cancelled, expired
      v_lapse := coalesce(v_sub.current_period_end, v_sub.trial_ends_at);
      v_reason := 'subscription_ended';
  end case;

  if v_lapse is null then
    if v_sub.status in ('cancelled', 'expired') then
      return query select 'read_only'::text, v_reason, null::timestamptz, null::text;
    else
      -- e.g. an active subscription without a period end: nothing to enforce.
      return query select 'full'::text, null::text, null::timestamptz, null::text;
    end if;
    return;
  end if;

  -- 2. Never lock a restaurant mid-service: restrict from the next business-day start.
  v_restriction := private.next_business_day_start(
    v_lapse, v_restaurant.timezone, v_restaurant.business_day_start_hour
  );

  if p_at < v_restriction then
    v_warning := case
      when v_sub.status in ('past_due', 'halted') then 'payment_failed'
      when v_restriction - p_at > interval '3 days' then null
      -- Autopay is set up: the first charge renews it.
      when v_autopay_trial then null
      when v_sub.status = 'trialing' then 'trial_ends_soon'
      -- Auto-renewing subscriptions only warn when they are set to end.
      when v_sub.status = 'active' and not v_sub.cancel_at_period_end then null
      else 'subscription_ends_soon'
    end;
    return query select 'full'::text, null::text, v_restriction, v_warning;
  else
    return query select 'read_only'::text, v_reason, v_restriction, null::text;
  end if;
end;
$$;

revoke execute on function private.json_unix(jsonb, text) from public, anon, authenticated;
revoke execute on function private.apply_razorpay_subscription(uuid, jsonb, jsonb, timestamptz)
  from public, anon, authenticated;
revoke execute on function private.apply_razorpay_payment_link(jsonb, jsonb, timestamptz)
  from public, anon, authenticated;
revoke execute on function private.apply_razorpay_event(jsonb, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.razorpay_record_webhook(text, jsonb) from public, anon, authenticated;
grant execute on function public.razorpay_record_webhook(text, jsonb) to service_role;
revoke execute on function public.razorpay_save_subscription(uuid, jsonb, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.razorpay_save_subscription(uuid, jsonb, uuid, boolean) to service_role;
