-- Payment links start on the first day not yet paid for, the same day super-admin's
-- manual payment form suggests (docs/DECISIONS.md P8-5). Before, a link paid during a
-- trial also paid for the trial's last day, and one paid after a Razorpay period that
-- ended between midnight and the business-day start paid for that period's last day.

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
