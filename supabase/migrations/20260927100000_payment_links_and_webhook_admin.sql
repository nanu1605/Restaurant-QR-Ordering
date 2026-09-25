-- Phase 8 Stop B, super-admin side (spec §13.4, §14.5, docs/DECISIONS.md P8-11):
-- the setup fee setting, an audit row for each payment link MenuMesh sends,
-- reprocessing a webhook that failed, and the Razorpay state on the
-- restaurant page.

alter table public.platform_settings
  add column setup_fee_paise bigint not null default 149900
    check (setup_fee_paise between 100 and 100000000);

-- One restaurant for super-admin, now with what Razorpay autopay is doing.
create or replace function public.platform_get_restaurant(p_restaurant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.current_platform_admin();
  v_restaurant public.restaurants;
  v_owners jsonb;
  v_subscription jsonb;
  v_payments jsonb;
  v_access jsonb;
  v_usage jsonb;
begin
  select * into v_restaurant from public.restaurants r where r.id = p_restaurant_id;
  if not found then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'member_id', m.id,
    'display_name', m.display_name,
    'username', m.username,
    'is_active', m.is_active,
    'email', u.email,
    'email_is_real', u.email is not null
      and split_part(u.email, '@', 2) not like v_restaurant.slug || '.staff.%',
    'last_sign_in_at', u.last_sign_in_at
  ) order by m.created_at), '[]'::jsonb)
  into v_owners
  from public.restaurant_members m
  left join auth.users u on u.id = m.user_id
  where m.restaurant_id = p_restaurant_id and m.role = 'owner';

  select jsonb_build_object(
    'plan_id', p.id,
    'plan_code', p.code,
    'plan_name', p.name,
    'billing_cycle', s.billing_cycle,
    'status', s.status,
    'source', s.source,
    'trial_ends_at', s.trial_ends_at,
    'current_period_start', s.current_period_start,
    'current_period_end', s.current_period_end,
    'grace_until', s.grace_until,
    'cancel_at_period_end', s.cancel_at_period_end,
    'razorpay_subscription_id', s.razorpay_subscription_id,
    'razorpay_status', s.razorpay_status,
    'next_plan_name', np.name,
    'next_billing_cycle', s.next_billing_cycle
  )
  into v_subscription
  from public.restaurant_subscriptions s
  join public.plans p on p.id = s.plan_id
  left join public.plans np on np.id = s.next_plan_id
  where s.restaurant_id = p_restaurant_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'payment_id', sp.id,
    'source', sp.source,
    'amount_paise', sp.amount_paise,
    'manual_mode', sp.manual_mode,
    'period_start', sp.period_start,
    'period_end', sp.period_end,
    'notes', sp.notes,
    'created_at', sp.created_at
  ) order by sp.created_at desc), '[]'::jsonb)
  into v_payments
  from public.subscription_payments sp
  where sp.restaurant_id = p_restaurant_id;

  select jsonb_build_object(
    'state', a.state, 'reason', a.reason, 'restriction_at', a.restriction_at, 'warning', a.warning
  )
  into v_access
  from public.restaurant_access(p_restaurant_id) as a;

  select jsonb_build_object(
    'tables_active', (
      select count(*) from public.dining_tables t
      where t.restaurant_id = p_restaurant_id and t.is_active
    ),
    'staff_logins', (
      select count(*) from public.restaurant_members m
      where m.restaurant_id = p_restaurant_id and m.is_active and m.role <> 'owner'
    ),
    'waiters', (
      select count(*) from public.waiters w
      where w.restaurant_id = p_restaurant_id and w.is_active
    ),
    'orders_7d', (
      select count(*) from public.orders o
      where o.restaurant_id = p_restaurant_id and o.created_at >= now() - interval '7 days'
    ),
    'orders_30d', (
      select count(*) from public.orders o
      where o.restaurant_id = p_restaurant_id and o.created_at >= now() - interval '30 days'
    ),
    'last_order_at', (
      select max(o.created_at) from public.orders o where o.restaurant_id = p_restaurant_id
    ),
    'bills', (
      select count(*) from public.bills b
      where b.restaurant_id = p_restaurant_id and b.status = 'active'
    ),
    'bills_30d', (
      select count(*) from public.bills b
      where b.restaurant_id = p_restaurant_id and b.status = 'active'
        and b.generated_at >= now() - interval '30 days'
    )
  )
  into v_usage;

  return jsonb_build_object(
    'restaurant', jsonb_build_object(
      'id', v_restaurant.id,
      'name', v_restaurant.name,
      'slug', v_restaurant.slug,
      'legal_name', v_restaurant.legal_name,
      'address_line', v_restaurant.address_line,
      'city', v_restaurant.city,
      'state', v_restaurant.state,
      'pincode', v_restaurant.pincode,
      'phone', v_restaurant.phone,
      'email', v_restaurant.email,
      'gstin', v_restaurant.gstin,
      'gst_mode', v_restaurant.gst_mode,
      'timezone', v_restaurant.timezone,
      'status', v_restaurant.status,
      'suspended_reason', v_restaurant.suspended_reason,
      'created_at', v_restaurant.created_at
    ),
    'owners', v_owners,
    'subscription', v_subscription,
    'payments', v_payments,
    'access', v_access,
    'usage', v_usage
  );
end;
$$;

-- Audits a Razorpay Payment Link the server has just created for a restaurant
-- (the link itself lives in Razorpay; its payment arrives as payment_link.paid).
create or replace function public.platform_audit_payment_link(p_restaurant_id uuid, p_link jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.current_platform_admin();
  v_subscription_id uuid;
  v_id text;
  v_url text;
  v_amount bigint;
  v_purpose text;
  v_months int;
begin
  if jsonb_typeof(p_link) is distinct from 'object' then
    perform private.fail('INVALID_INPUT', 'link');
  end if;
  perform private.assert_keys(p_link, array['id', 'short_url', 'amount_paise', 'purpose', 'months']);
  v_id := private.json_text(p_link, 'id');
  if v_id is null or v_id !~ '^plink_[A-Za-z0-9]{1,40}$' then
    perform private.fail('INVALID_INPUT', 'id');
  end if;
  v_url := private.json_text(p_link, 'short_url');
  if v_url is null or v_url !~ '^https://' or length(v_url) > 200 then
    perform private.fail('INVALID_INPUT', 'short_url');
  end if;
  v_amount := private.json_int(p_link, 'amount_paise');
  if v_amount not between 100 and 100000000 then
    perform private.fail('INVALID_INPUT', 'amount_paise');
  end if;
  v_purpose := private.json_text(p_link, 'purpose');
  if v_purpose is null or v_purpose not in ('subscription', 'setup_fee') then
    perform private.fail('INVALID_INPUT', 'purpose');
  end if;
  if v_purpose = 'subscription' then
    v_months := private.json_int(p_link, 'months');
    if v_months not between 1 and 24 then
      perform private.fail('INVALID_INPUT', 'months');
    end if;
  elsif p_link ? 'months' and jsonb_typeof(p_link -> 'months') <> 'null' then
    perform private.fail('INVALID_INPUT', 'months');
  end if;

  if not exists (select 1 from public.restaurants r where r.id = p_restaurant_id) then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;
  select s.id into v_subscription_id
  from public.restaurant_subscriptions s where s.restaurant_id = p_restaurant_id;

  perform private.audit_platform(
    v_admin, p_restaurant_id, 'subscription.payment_link_sent', 'restaurant_subscription',
    v_subscription_id, null,
    jsonb_build_object(
      'payment_link_id', v_id, 'short_url', v_url, 'amount_paise', v_amount,
      'purpose', v_purpose, 'months', v_months
    )
  );
end;
$$;

-- Runs a stored webhook again after it failed (say, a subscription that
-- wasn't attached yet). Only failed events: one already applied must never
-- apply twice. Returns {result, error}; a second failure is kept on the event.
create or replace function public.platform_reprocess_webhook(p_event_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.current_platform_admin();
  v_event public.webhook_events;
  v_restaurant_id uuid;
  v_result text;
  v_error text;
  v_message text;
  v_detail text;
begin
  select * into v_event from public.webhook_events e where e.id = p_event_id for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  if v_event.processing_error is null then
    perform private.fail('WEBHOOK_NOT_FAILED');
  end if;

  begin
    v_result := private.apply_razorpay_event(
      v_event.payload,
      coalesce(private.json_unix(v_event.payload, 'created_at'), v_event.received_at)
    );
    update public.webhook_events
      set processed_at = now(), processing_error = null
      where id = v_event.id;
  exception when others then
    get stacked diagnostics v_message = message_text, v_detail = pg_exception_detail;
    v_error := left(v_message || coalesce(nullif(' (' || v_detail || ')', ' ()'), ''), 500);
    update public.webhook_events set processing_error = v_error where id = v_event.id;
    v_result := 'failed';
  end;

  -- The restaurant it was about, when that is known now.
  select s.restaurant_id into v_restaurant_id
  from public.restaurant_subscriptions s
  where s.razorpay_subscription_id = v_event.payload #>> '{payload,subscription,entity,id}';
  if v_restaurant_id is null then
    select r.id into v_restaurant_id
    from public.restaurants r
    where r.id::text in (
      v_event.payload #>> '{payload,subscription,entity,notes,restaurant_id}',
      v_event.payload #>> '{payload,payment_link,entity,notes,restaurant_id}'
    )
    limit 1;
  end if;

  perform private.audit_platform(
    v_admin, v_restaurant_id, 'webhook.reprocessed', 'webhook_event', v_event.id,
    jsonb_build_object('event_type', v_event.event_type, 'processing_error', v_event.processing_error),
    jsonb_build_object('result', v_result, 'processing_error', v_error)
  );
  return jsonb_build_object('result', v_result, 'error', v_error);
end;
$$;

revoke execute on function public.platform_audit_payment_link(uuid, jsonb) from public, anon;
revoke execute on function public.platform_reprocess_webhook(uuid) from public, anon;
grant execute on function public.platform_audit_payment_link(uuid, jsonb) to authenticated;
grant execute on function public.platform_reprocess_webhook(uuid) to authenticated;
