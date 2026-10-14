-- Super-admin redesign, stop 12b (docs/SUPER_ADMIN_PLAN.md §4.2; docs/DECISIONS.md
-- SA-8): what each payment to MenuMesh was for, and its GST. Amounts stay what
-- the restaurant paid, GST included; the split is worked out from them.

-- The GST rate on MenuMesh's fees, in basis points. src/features/subscriptions/gst.ts
-- has the same number (FEE_GST_BPS); a test checks both.
create function private.fee_gst_bps()
returns int
language sql
immutable
set search_path = ''
as $$
  select 1800;
$$;

revoke execute on function private.fee_gst_bps() from public, anon, authenticated;

alter table public.subscription_payments
  add column purpose text not null default 'subscription'
    check (purpose in ('subscription', 'setup_fee')),
  add column gst_bps int not null default private.fee_gst_bps()
    check (gst_bps between 0 and 10000),
  add column base_paise bigint generated always as (
    round(amount_paise * 10000.0 / (10000 + gst_bps))::bigint
  ) stored,
  add column gst_paise bigint generated always as (
    amount_paise - round(amount_paise * 10000.0 / (10000 + gst_bps))::bigint
  ) stored,
  -- Setup fees only: the usual fee and the discount on it, before GST.
  add column list_price_paise bigint check (list_price_paise > 0),
  add column discount_paise bigint check (discount_paise >= 0),
  add constraint subscription_payments_discount_check check (discount_paise <= list_price_paise);

-- Only a setup fee is paid without a period (payment links since P8-11).
update public.subscription_payments set purpose = 'setup_fee' where period_start is null;

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
  v_list_price bigint;
  v_discount bigint;
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
  -- A setup fee link carries the usual fee and the discount in force when it
  -- was sent (as strings), so launch-offer use can be counted (SA-8).
  if v_purpose = 'setup_fee' then
    if coalesce(v_notes ->> 'list_price_paise', '') ~ '^[0-9]{1,9}$' then
      v_list_price := nullif((v_notes ->> 'list_price_paise')::bigint, 0);
    end if;
    if v_list_price is not null and coalesce(v_notes ->> 'discount_paise', '') ~ '^[0-9]{1,9}$' then
      v_discount := least((v_notes ->> 'discount_paise')::bigint, v_list_price);
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
    restaurant_id, source, purpose, list_price_paise, discount_paise,
    amount_paise, razorpay_payment_id, period_start, period_end, notes
  )
  values (
    v_restaurant_id, 'payment_link', v_purpose, v_list_price, v_discount,
    v_amount, v_payment_id, v_starts_at, v_ends_at,
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

-- A setup fee paid outside Razorpay (cash, UPI, bank transfer, cheque). Unlike a
-- subscription payment it covers no period and changes no subscription. The
-- server passes the fee and discount in force (SA-8).
create or replace function public.platform_record_setup_fee(
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
  v_amount bigint;
  v_mode text;
  v_notes text;
  v_list_price bigint;
  v_discount bigint;
  v_payment_id uuid;
begin
  perform private.assert_keys(
    v_payment, array['amount_paise', 'mode', 'notes', 'list_price_paise', 'discount_paise']
  );
  v_amount := private.json_int(v_payment, 'amount_paise');
  if v_amount < 1 or v_amount > 100000000 then
    perform private.fail('INVALID_INPUT', 'amount_paise');
  end if;
  v_mode := private.json_text(v_payment, 'mode');
  if v_mode is null or v_mode not in ('bank_transfer', 'cash', 'upi', 'cheque') then
    perform private.fail('INVALID_INPUT', 'mode');
  end if;
  v_notes := private.tidy_text(private.json_text(v_payment, 'notes'));
  if v_notes is not null and length(v_notes) > 500 then
    perform private.fail('INVALID_INPUT', 'notes');
  end if;
  if coalesce(jsonb_typeof(v_payment -> 'list_price_paise'), 'null') <> 'null' then
    v_list_price := private.json_int(v_payment, 'list_price_paise');
    v_discount := coalesce(private.json_int(v_payment, 'discount_paise'), 0);
    if v_list_price not between 1 and 100000000 or v_discount not between 0 and v_list_price then
      perform private.fail('INVALID_INPUT', 'list_price_paise');
    end if;
  end if;
  if not exists (select 1 from public.restaurants r where r.id = p_restaurant_id) then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;

  insert into public.subscription_payments (
    restaurant_id, source, purpose, amount_paise, manual_mode, list_price_paise, discount_paise,
    notes, recorded_by
  )
  values (
    p_restaurant_id, 'manual', 'setup_fee', v_amount, v_mode::public.manual_payment_mode,
    v_list_price, v_discount, v_notes, v_admin.user_id
  )
  returning id into v_payment_id;

  perform private.audit_platform(
    v_admin, p_restaurant_id, 'subscription.payment_recorded', 'subscription_payment', v_payment_id,
    null,
    jsonb_build_object(
      'purpose', 'setup_fee', 'amount_paise', v_amount, 'mode', v_mode,
      'list_price_paise', v_list_price, 'discount_paise', v_discount
    ),
    v_notes
  );
  return jsonb_build_object('payment_id', v_payment_id);
end;
$$;

revoke execute on function public.platform_record_setup_fee(uuid, jsonb) from public, anon;
grant execute on function public.platform_record_setup_fee(uuid, jsonb) to authenticated;
