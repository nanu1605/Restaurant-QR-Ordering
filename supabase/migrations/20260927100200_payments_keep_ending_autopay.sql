-- A payment made another way while Razorpay autopay is set to end (cancelled at
-- period end) no longer clears that: Razorpay still ends the mandate, so the
-- app must keep saying autopay ends, not that it renews (docs/DECISIONS.md P8-9).

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
  v_lapse timestamptz;
  v_extended boolean;
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

  -- When access lapses now, as restaurant_access works it out. The payment
  -- changes the subscription only if it keeps the restaurant going for
  -- longer (as an active subscription, lapse = period end + 2 days): a
  -- payment for a period already covered, say arrears during grace or a
  -- month inside a long trial, is recorded and nothing else changes.
  v_lapse := case v_subscription.status
    when 'trialing' then v_subscription.trial_ends_at
    when 'active' then v_subscription.current_period_end + interval '2 days'
    when 'past_due' then coalesce(
      v_subscription.grace_until, v_subscription.current_period_end + interval '2 days'
    )
    when 'halted' then coalesce(
      v_subscription.grace_until, v_subscription.current_period_end + interval '2 days'
    )
    else coalesce(v_subscription.current_period_end, v_subscription.trial_ends_at)
  end;
  v_extended := v_ends_at + interval '2 days' > coalesce(v_lapse, '-infinity'::timestamptz);

  if v_extended then
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
          -- A Razorpay mandate set to end still ends (P8-9).
          cancel_at_period_end = s.cancel_at_period_end
            and s.razorpay_status in ('authenticated', 'active')
      where s.id = v_subscription.id
      returning * into v_subscription;
  end if;

  perform private.audit_platform(
    v_admin, p_restaurant_id, 'subscription.payment_recorded', 'subscription_payment', v_payment_id,
    null,
    jsonb_build_object(
      'amount_paise', v_amount,
      'mode', v_mode,
      'billing_cycle', v_cycle,
      'period_start', v_starts_at,
      'period_end', v_ends_at,
      'extended', v_extended,
      'current_period_end', v_subscription.current_period_end
    ),
    v_notes
  );

  return jsonb_build_object(
    'payment_id', v_payment_id,
    'extended', v_extended,
    'status', v_subscription.status,
    'current_period_end', v_subscription.current_period_end
  );
end;
$$;

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
    -- The first day not yet paid for, as super-admin's manual payment form
    -- works it out: the day after the trial's last business day, else the
    -- date the paid period ends on, but never before today. A Razorpay period
    -- can end at any time of day; the business day it ends in is already paid.
    v_covered := case
      when v_sub.status = 'trialing' then private.next_business_day_start(
        v_sub.trial_ends_at, v_restaurant.timezone, v_restaurant.business_day_start_hour
      )
      else v_sub.current_period_end
    end;
    v_from := greatest(
      (v_covered at time zone v_restaurant.timezone)::date,
      private.business_date(p_event_at, v_restaurant.timezone, v_restaurant.business_day_start_hour)
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
          -- A Razorpay mandate set to end still ends (P8-9).
          cancel_at_period_end = s.cancel_at_period_end
            and s.razorpay_status in ('authenticated', 'active')
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
