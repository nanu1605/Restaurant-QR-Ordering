-- Super-admin redesign, stop 14e (docs/SUPER_ADMIN_PLAN.md 14e; docs/DECISIONS.md
-- SA-93 to SA-100): a restaurant's data export, closing its account with a
-- 30-day hold, and removing personal data after the hold while bills, payments
-- and the rest of its financial records stay.

-- ─── One state for a closed restaurant ──────────────────────────────────────
create or replace function private.subscription_state(
  p_restaurant_status text,
  p_access_state text,
  p_status text,
  p_source text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_restaurant_status = 'closed' then 'closed'
    when p_restaurant_status = 'suspended' then 'suspended'
    when p_access_state = 'read_only' then 'read_only'
    when p_status = 'trialing' then 'trial'
    when p_status in ('past_due', 'halted') then 'payment_failed'
    when p_status = 'active' and p_source is not null then 'paid'
    else 'cancelled'
  end;
$$;

alter table public.metrics_subscription_daily
  drop constraint metrics_subscription_daily_state_check,
  add constraint metrics_subscription_daily_state_check check (
    state in ('closed', 'suspended', 'read_only', 'trial', 'payment_failed', 'paid', 'cancelled')
  );

-- ─── Closures ───────────────────────────────────────────────────────────────
-- One row while a restaurant is closed; Reopen deletes it (the audit log keeps
-- the history). After the hold the row stays, with removed_at, for good.
create table public.restaurant_closures (
  restaurant_id uuid primary key references public.restaurants (id),
  closed_at timestamptz not null default now(),
  closed_by uuid references auth.users (id) on delete set null,
  removal_due_at timestamptz not null,
  removed_at timestamptz,
  -- What Reopen puts back: its status and reason, and the logins that were on.
  prior_status public.restaurant_status not null,
  prior_reason text,
  member_ids uuid[] not null
);
create index restaurant_closures_due_idx on public.restaurant_closures (removal_due_at)
  where removed_at is null;

alter table public.restaurant_closures enable row level security;
revoke all on public.restaurant_closures from anon, authenticated;

-- ─── Exports ────────────────────────────────────────────────────────────────
-- The file is restaurant-exports/<restaurant_id>/<id>.zip: private, no storage
-- policies, handed out by a signed link only (SA-93).
create table public.restaurant_exports (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id),
  requested_by uuid references auth.users (id) on delete set null,
  status text not null default 'building' check (status in ('building', 'ready', 'failed')),
  size_bytes bigint check (size_bytes >= 0),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  expires_at timestamptz,
  check ((status = 'ready') = (expires_at is not null))
);
create index restaurant_exports_restaurant_idx on public.restaurant_exports
  (restaurant_id, created_at desc);
create index restaurant_exports_created_idx on public.restaurant_exports (created_at);

alter table public.restaurant_exports enable row level security;
revoke all on public.restaurant_exports from anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('restaurant-exports', 'restaurant-exports', false, 52428800, array['application/zip'])
on conflict (id) do nothing;

-- ─── Helpers ────────────────────────────────────────────────────────────────
-- What a closed restaurant's page no longer offers, refused for a tab left open
-- (SA-94).
create function private.refuse_closed(p_restaurant_id uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.restaurants r where r.id = p_restaurant_id and r.status = 'closed'
  ) then
    perform private.fail('RESTAURANT_CLOSED');
  end if;
end;
$$;

-- A Razorpay event without its payer's details: email, phone, UPI id and card (SA-97).
create function private.webhook_without_payer(p_payload jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select p_payload
    #- '{payload,payment,entity,email}'
    #- '{payload,payment,entity,contact}'
    #- '{payload,payment,entity,vpa}'
    #- '{payload,payment,entity,upi}'
    #- '{payload,payment,entity,card}'
    #- '{payload,payment_link,entity,customer}';
$$;

-- The restaurant a Razorpay event is about, from the notes we gave Razorpay.
create function private.webhook_restaurant_ids(p_payload jsonb)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    p_payload #>> '{payload,payment,entity,notes,restaurant_id}',
    p_payload #>> '{payload,subscription,entity,notes,restaurant_id}',
    p_payload #>> '{payload,payment_link,entity,notes,restaurant_id}'
  ];
$$;

revoke execute on function private.refuse_closed(uuid) from public, anon, authenticated;
revoke execute on function private.webhook_without_payer(jsonb) from public, anon, authenticated;
revoke execute on function private.webhook_restaurant_ids(jsonb) from public, anon, authenticated;


-- ─── Every copy of the status check ─────────────────────────────────────────
-- Closed is read-only with its own reason, before any subscription logic.

create or replace function private.restaurant_access(p_restaurant_id uuid, p_at timestamp with time zone DEFAULT now())
 RETURNS TABLE(state text, reason text, restriction_at timestamp with time zone, warning text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_restaurant public.restaurants%rowtype;
  v_sub public.restaurant_subscriptions%rowtype;
  v_lapse timestamptz;
  v_reason text;
  v_restriction timestamptz;
  v_warning text;
  v_autopay_trial boolean;
begin
  select * into v_restaurant from public.restaurants where id = p_restaurant_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'RESTAURANT_NOT_FOUND';
  end if;

  if v_restaurant.status in ('suspended', 'closed') then
    return query select 'read_only'::text, v_restaurant.status::text, null::timestamptz, null::text;
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
      when v_restriction - p_at > case when v_sub.autopay_finished_at is not null
        then interval '7 days' else interval '3 days' end then null
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
$function$;


-- A closed restaurant's QR codes stop working, the same as a switched-off one
-- (SA-96). Every customer function but the two below comes through here.

create or replace function private.customer_table(p_qr_token text)
returns public.dining_tables
language plpgsql
stable
set search_path = ''
as $$
declare
  v_table public.dining_tables;
begin
  if p_qr_token is null or p_qr_token !~ '^[A-Za-z0-9]{16}$' then
    perform private.fail('TABLE_NOT_FOUND');
  end if;
  select t.* into v_table
    from public.dining_tables t
    join public.restaurants r on r.id = t.restaurant_id
    where t.qr_token = p_qr_token and t.is_active and r.status <> 'closed';
  if not found then
    perform private.fail('TABLE_NOT_FOUND');
  end if;
  return v_table;
end;
$$;

create or replace function public.customer_create_service_request(
  p_qr_token text,
  p_device_id text,
  p_type text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_device text := private.customer_device(p_device_id);
  v_type public.service_request_type;
  v_table public.dining_tables;
  v_session_id uuid;
  v_request public.service_requests;
begin
  if p_type is null or p_type not in ('call_waiter', 'request_bill') then
    perform private.fail('INVALID_INPUT', 'type');
  end if;
  v_type := p_type::public.service_request_type;
  if p_qr_token is null or p_qr_token !~ '^[A-Za-z0-9]{16}$' then
    perform private.fail('TABLE_NOT_FOUND');
  end if;

  -- The table lock serialises taps from every phone at the table, and a
  -- session opening or closing meanwhile.
  select * into v_table
  from public.dining_tables t
  where t.qr_token = p_qr_token and t.is_active
    and exists (
      select 1 from public.restaurants r where r.id = t.restaurant_id and r.status <> 'closed'
    )
  for update;
  if not found then
    perform private.fail('TABLE_NOT_FOUND');
  end if;

  select s.id into v_session_id
  from public.table_sessions s
  where s.dining_table_id = v_table.id and s.status = 'open';

  if v_type = 'request_bill' and not exists (
    select 1 from public.orders o
    where o.restaurant_id = v_table.restaurant_id
      and o.session_id = v_session_id
      and o.status = 'accepted'
  ) then
    perform private.fail('NOTHING_TO_BILL');
  end if;

  select * into v_request
  from public.service_requests r
  where r.dining_table_id = v_table.id and r.type = v_type and r.status <> 'resolved';
  if not found then
    if (select count(*) from public.service_requests r
        where r.restaurant_id = v_table.restaurant_id
          and r.dining_table_id = v_table.id
          and r.created_at > now() - interval '1 hour') >= 10 then
      perform private.fail('RATE_LIMITED');
    end if;
    insert into public.service_requests (
      restaurant_id, dining_table_id, session_id, type, client_device_id
    )
    values (v_table.restaurant_id, v_table.id, v_session_id, v_type, v_device)
    returning * into v_request;
  end if;

  return jsonb_build_object('id', v_request.id, 'type', v_request.type, 'status', v_request.status);
end;
$$;


-- Suspend and unsuspend can't touch a closed restaurant: Reopen does that.

create or replace function public.platform_set_restaurant_status(p_restaurant_id uuid, p_status text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.manage');
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
  if v_restaurant.status = 'closed' then
    perform private.fail('RESTAURANT_CLOSED');
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
$function$;


-- No reset code for a login that is switched off (SA-95).

create or replace function public.auth_password_reset_start(p_email text, p_code_hash text, p_ip_hash text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_user uuid;
  v_id uuid;
begin
  -- One request at a time per email and per network, so concurrent requests
  -- can't all pass the counts below (always email first, then network).
  perform pg_advisory_xact_lock(hashtextextended('password_reset:email:' || v_email, 0));
  if p_ip_hash is not null then
    perform pg_advisory_xact_lock(hashtextextended('password_reset:ip:' || p_ip_hash, 0));
  end if;

  perform public.password_resets_cleanup();

  if (select count(*) from public.password_resets r
      where r.email = v_email and r.created_at > now() - interval '1 hour') >= 3 then
    perform private.fail('RATE_LIMITED');
  end if;
  if p_ip_hash is not null
     and (select count(*) from public.password_resets r
          where r.ip_hash = p_ip_hash and r.created_at > now() - interval '1 day') >= 10 then
    perform private.fail('RATE_LIMITED');
  end if;

  -- Staff logins have made-up addresses (username@<code>.staff.<domain>):
  -- their owner or manager resets them instead. Any domain with ".staff." in
  -- it is left out, which errs on the side of sending nothing. A platform
  -- admin without a verified authenticator is left out too: /super/mfa would
  -- let whoever set the new password enrol their own (P11-8).
  select u.id into v_user
  from auth.users u
  where lower(u.email) = v_email
    and split_part(u.email, '@', 2) not like '%.staff.%'
    and u.deleted_at is null
    and not u.is_anonymous
    and (u.banned_until is null or u.banned_until <= now())
    and (
      not exists (select 1 from public.platform_admins a where a.user_id = u.id)
      or exists (
        select 1 from auth.mfa_factors f
        where f.user_id = u.id and f.factor_type = 'totp' and f.status = 'verified'
      )
    )
    and not exists (
      select 1 from public.platform_admins a where a.user_id = u.id and a.disabled_at is not null
    );

  insert into public.password_resets (email, user_id, code_hash, ip_hash)
  values (v_email, v_user, p_code_hash, p_ip_hash)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'send', v_user is not null);
exception
  when check_violation or not_null_violation then
    perform private.fail('INVALID_INPUT');
end;
$function$;


-- ─── The lists know the new state ───────────────────────────────────────────

create or replace function public.platform_list_restaurants(p_filters jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_q text;
  v_state text;
  v_plan text;
  v_health text;
  v_city text;
  v_region text;
  v_channel text;
  v_tag uuid;
  v_manager text;
  v_manager_id uuid;
  v_onboarding text;
  v_from date;
  v_to date;
  v_paid_from date;
  v_paid_to date;
  v_sort text;
  v_dir text;
  v_page int;
  v_page_size int := 50;
  v_total bigint;
  v_rows jsonb;
  v_cities jsonb;
  v_regions jsonb;
  v_money boolean;
begin
  perform private.require_platform_permission('restaurants.view');
  v_money := private.has_platform_permission('money.view');
  perform private.assert_keys(v_filters, array[
    'q', 'state', 'plan', 'health', 'city', 'region', 'channel', 'from', 'to', 'paid_from',
    'paid_to', 'sort', 'dir', 'page', 'export', 'tag', 'manager', 'onboarding'
  ]);
  v_q := nullif(btrim(coalesce(private.json_text(v_filters, 'q'), '')), '');
  v_state := private.json_text(v_filters, 'state');
  v_plan := private.json_text(v_filters, 'plan');
  v_health := private.json_text(v_filters, 'health');
  v_city := nullif(btrim(coalesce(private.json_text(v_filters, 'city'), '')), '');
  v_region := nullif(btrim(coalesce(private.json_text(v_filters, 'region'), '')), '');
  v_channel := private.json_text(v_filters, 'channel');
  if coalesce(jsonb_typeof(v_filters -> 'tag'), 'null') <> 'null' then
    v_tag := private.json_uuid(v_filters, 'tag');
  end if;
  -- An account manager: 'me', 'none' (no one) or a team member's user id.
  v_manager := private.json_text(v_filters, 'manager');
  if v_manager = 'me' then
    v_manager_id := auth.uid();
  elsif v_manager is not null and v_manager <> 'none' then
    v_manager_id := private.json_uuid(v_filters, 'manager');
  end if;
  v_onboarding := private.json_text(v_filters, 'onboarding');
  v_from := private.json_date(v_filters, 'from');
  v_to := private.json_date(v_filters, 'to');
  v_paid_from := private.json_date(v_filters, 'paid_from');
  v_paid_to := private.json_date(v_filters, 'paid_to');
  v_sort := coalesce(private.json_text(v_filters, 'sort'), 'created');
  v_dir := coalesce(private.json_text(v_filters, 'dir'),
    case when v_sort = 'name' then 'asc' else 'desc' end);
  v_page := case
    when coalesce(jsonb_typeof(v_filters -> 'page'), 'null') = 'null' then 1
    else private.json_int(v_filters, 'page')
  end;

  if length(v_q) > 80 then
    perform private.fail('INVALID_INPUT', 'q');
  end if;
  if v_state is not null and v_state not in (
    'closed', 'suspended', 'read_only', 'trial', 'payment_failed', 'paid', 'cancelled'
  ) then
    perform private.fail('INVALID_INPUT', 'state');
  end if;
  if v_health is not null and v_health not in (
    'setting_up', 'never_started', 'inactive', 'slowing', 'active'
  ) then
    perform private.fail('INVALID_INPUT', 'health');
  end if;
  if v_channel is not null and v_channel not in (
    'website', 'website_lead', 'field_visit', 'referral', 'phone', 'whatsapp', 'social', 'other',
    'unknown'
  ) then
    perform private.fail('INVALID_INPUT', 'channel');
  end if;
  if v_onboarding is not null and v_onboarding not in ('open', 'stuck', 'done') then
    perform private.fail('INVALID_INPUT', 'onboarding');
  end if;
  if v_sort not in ('created', 'name', 'last_active', 'paid_till', 'gmv') then
    perform private.fail('INVALID_INPUT', 'sort');
  end if;
  if v_dir not in ('asc', 'desc') then
    perform private.fail('INVALID_INPUT', 'dir');
  end if;
  if v_page < 1 or v_page > 10000 then
    perform private.fail('INVALID_INPUT', 'page');
  end if;
  if v_from is not null and v_to is not null and v_to < v_from then
    perform private.fail('INVALID_INPUT', 'to');
  end if;
  if v_paid_from is not null and v_paid_to is not null and v_paid_to < v_paid_from then
    perform private.fail('INVALID_INPUT', 'paid_to');
  end if;
  if v_filters ? 'export' and private.json_bool(v_filters, 'export') then
    v_page := 1;
    v_page_size := 10000;
  end if;

  with base as (
    select
      r.id, r.name, r.slug, r.city, r.state as region, r.phone, r.status, r.created_at,
      r.acquisition_channel, r.timezone, r.business_day_start_hour,
      am.user_id as account_manager_user_id,
      p.code as plan_code, p.name as plan_name,
      s.status as subscription_status, s.billing_cycle, s.source, s.trial_ends_at,
      s.current_period_end,
      case when s.status = 'trialing' then s.trial_ends_at else s.current_period_end end
        as paid_till,
      -- Sorted by the day shown: a paid period's last day is the day before it ends.
      case when s.status = 'trialing' then s.trial_ends_at
        else s.current_period_end - interval '1 day' end as paid_last,
      s.cancel_at_period_end,
      case when v_state is not null then (
        select private.subscription_state(r.status::text, a.state, s.status::text, s.source::text)
        from private.restaurant_access(r.id) as a
      ) end as state
    from public.restaurants r
    left join public.restaurant_subscriptions s on s.restaurant_id = r.id
    left join public.plans p on p.id = s.plan_id
    left join public.restaurant_account_managers am on am.restaurant_id = r.id
    where (v_q is null
        or r.name ilike '%' || v_q || '%'
        or r.slug ilike '%' || v_q || '%'
        or r.city ilike '%' || v_q || '%')
      and (v_plan is null or p.code = v_plan)
      and (v_city is null or lower(r.city) = lower(v_city))
      and (v_region is null or lower(r.state) = lower(v_region))
      and (v_channel is null or coalesce(r.acquisition_channel, 'unknown') = v_channel)
      and (v_tag is null or exists (
        select 1 from public.restaurant_tags rt where rt.restaurant_id = r.id and rt.tag_id = v_tag
      ))
      and (v_manager is null
        or (v_manager = 'none' and am.user_id is null)
        or am.user_id = v_manager_id)
      and (v_from is null or r.created_at >= v_from::timestamp at time zone 'Asia/Kolkata')
      and (v_to is null or r.created_at < (v_to + 1)::timestamp at time zone 'Asia/Kolkata')
      -- A paid period ends at the start of the day after its last day, so its
      -- last day is a day earlier (the list shows that day too).
      and (v_paid_from is null
        or (case when s.status = 'trialing' then s.trial_ends_at
            else s.current_period_end - interval '1 day' end)
          >= v_paid_from::timestamp at time zone 'Asia/Kolkata')
      and (v_paid_to is null
        or (case when s.status = 'trialing' then s.trial_ends_at
            else s.current_period_end - interval '1 day' end)
          < (v_paid_to + 1)::timestamp at time zone 'Asia/Kolkata')
  ),
  -- Materialized: the onboarding is read three times below, worked out once.
  scored as materialized (
    select
      b.*,
      case when v_health is not null then private.restaurant_health(b.id, b.created_at) end
        as health,
      case when v_sort = 'last_active' then private.restaurant_last_active(b.id) end
        as last_active,
      case when v_sort = 'gmv' then (
        select u.gmv_30d_paise
        from private.restaurant_recent_usage(b.id, b.timezone, b.business_day_start_hour) as u
      ) end as gmv_30d,
      ob.onboarding
    from base b
    -- Only when filtering by it: the page's rows get theirs below.
    left join private.restaurants_onboarding(
      case when v_onboarding is not null then array(select x.id from base x) end
    ) as ob on ob.restaurant_id = b.id
    where v_state is null or b.state = v_state
  ),
  matching as (
    select sc.* from scored sc
    where (v_health is null or sc.health = v_health)
      and (v_onboarding is null
        or (v_onboarding = 'open' and sc.onboarding ->> 'next' is not null)
        or (v_onboarding = 'stuck' and (sc.onboarding ->> 'stuck')::boolean)
        or (v_onboarding = 'done' and sc.onboarding ->> 'next' is null))
  ),
  page as (
    select m.*
    from matching m
    order by
      case when v_sort = 'name' and v_dir = 'asc' then lower(m.name) end asc,
      case when v_sort = 'name' and v_dir = 'desc' then lower(m.name) end desc,
      case when v_sort = 'last_active' and v_dir = 'asc' then m.last_active end asc nulls first,
      case when v_sort = 'last_active' and v_dir = 'desc' then m.last_active end desc nulls last,
      case when v_sort = 'paid_till' and v_dir = 'asc' then m.paid_last end asc nulls last,
      case when v_sort = 'paid_till' and v_dir = 'desc' then m.paid_last end desc nulls last,
      case when v_sort = 'gmv' and v_dir = 'asc' then m.gmv_30d end asc,
      case when v_sort = 'gmv' and v_dir = 'desc' then m.gmv_30d end desc,
      case when v_sort = 'created' and v_dir = 'asc' then m.created_at end asc,
      m.created_at desc,
      m.id
    limit v_page_size offset (v_page - 1) * v_page_size
  ),
  rows as (
    select
      pg.*,
      private.subscription_state(pg.status::text, a.state, pg.subscription_status::text,
        pg.source::text) as row_state,
      a.state as access_state,
      u.orders_7d,
      u.gmv_30d_paise as recent_gmv,
      coalesce(pg.onboarding, pob.onboarding) as row_onboarding
    from page pg
    cross join lateral private.restaurant_access(pg.id) as a
    cross join lateral private.restaurant_recent_usage(
      pg.id, pg.timezone, pg.business_day_start_hour
    ) as u
    -- The page's rows at once (a CSV is up to 10,000 of them).
    left join private.restaurants_onboarding(array(select p.id from page p)) as pob
      on pob.restaurant_id = pg.id
  )
  select
    (select count(*) from matching),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'restaurant_id', x.id,
        'name', x.name,
        'slug', x.slug,
        'city', x.city,
        'region', x.region,
        'phone', x.phone,
        'status', x.status,
        'created_at', x.created_at,
        'acquisition_channel', x.acquisition_channel,
        'plan_code', x.plan_code,
        'plan_name', x.plan_name,
        'billing_cycle', x.billing_cycle,
        'subscription_status', x.subscription_status,
        'state', x.row_state,
        'access_state', x.access_state,
        'paid_till', x.paid_till,
        'ending', coalesce(x.cancel_at_period_end, false),
        'health', coalesce(x.health, private.restaurant_health(x.id, x.created_at)),
        'last_active', coalesce(x.last_active, private.restaurant_last_active(x.id)),
        'gmv_30d_paise', coalesce(x.gmv_30d, x.recent_gmv),
        'orders_7d', to_jsonb(x.orders_7d),
        'onboarding', x.row_onboarding - 'steps',
        'tags', coalesce((
          select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'colour', t.colour)
            order by lower(t.name))
          from public.restaurant_tags rt
          join public.platform_tags t on t.id = rt.tag_id
          where rt.restaurant_id = x.id
        ), '[]'::jsonb),
        'account_manager', (
          select u.email from auth.users u where u.id = x.account_manager_user_id
        ),
        'paid', case when v_money then (
          select jsonb_build_object(
            'subscription_paise', coalesce(sum(sp.base_paise) filter (where sp.purpose = 'subscription'), 0),
            'setup_fee_paise', coalesce(sum(sp.base_paise) filter (where sp.purpose = 'setup_fee'), 0),
            'gst_paise', coalesce(sum(sp.gst_paise), 0)
          )
          from public.subscription_payments sp
          where sp.restaurant_id = x.id
        ) end
      ) order by
        case when v_sort = 'name' and v_dir = 'asc' then lower(x.name) end asc,
        case when v_sort = 'name' and v_dir = 'desc' then lower(x.name) end desc,
        case when v_sort = 'last_active' and v_dir = 'asc' then x.last_active end asc nulls first,
        case when v_sort = 'last_active' and v_dir = 'desc' then x.last_active end desc nulls last,
        case when v_sort = 'paid_till' and v_dir = 'asc' then x.paid_last end asc nulls last,
        case when v_sort = 'paid_till' and v_dir = 'desc' then x.paid_last end desc nulls last,
        case when v_sort = 'gmv' and v_dir = 'asc' then x.gmv_30d end asc,
        case when v_sort = 'gmv' and v_dir = 'desc' then x.gmv_30d end desc,
        case when v_sort = 'created' and v_dir = 'asc' then x.created_at end asc,
        x.created_at desc,
        x.id)
      from rows x
    ), '[]'::jsonb)
  into v_total, v_rows;

  select
    coalesce((select jsonb_agg(c.city order by c.city) from (
      select distinct r.city from public.restaurants r where nullif(btrim(r.city), '') is not null
    ) as c), '[]'::jsonb),
    coalesce((select jsonb_agg(c.state order by c.state) from (
      select distinct r.state from public.restaurants r where nullif(btrim(r.state), '') is not null
    ) as c), '[]'::jsonb)
  into v_cities, v_regions;

  return jsonb_build_object(
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'rows', v_rows,
    'cities', v_cities,
    'regions', v_regions
  );
end;
$function$;

create or replace function public.platform_list_subscriptions(p_filters jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.view');
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_state text;
  v_page int;
  v_page_size constant int := 50;
  v_total bigint;
  v_rows jsonb;
begin
  perform private.assert_keys(v_filters, array['state', 'page']);
  v_state := private.json_text(v_filters, 'state');
  v_page := case
    when coalesce(jsonb_typeof(v_filters -> 'page'), 'null') = 'null' then 1
    else private.json_int(v_filters, 'page')
  end;
  if v_state is not null and v_state not in (
    'closed', 'suspended', 'read_only', 'trial', 'payment_failed', 'paid', 'cancelled'
  ) then
    perform private.fail('INVALID_INPUT', 'state');
  end if;
  if v_page < 1 or v_page > 10000 then
    perform private.fail('INVALID_INPUT', 'page');
  end if;

  with matching as (
    select
      r.id, r.name, r.slug, r.status as restaurant_status,
      p.name as plan_name, p.code as plan_code,
      s.billing_cycle, s.status, s.source, s.trial_ends_at, s.current_period_end,
      s.grace_until, s.cancel_at_period_end, a.state as access_state, st.state,
      st.state = 'paid' and private.renewal_kind(s) = 'ending' as ending,
      case when s.status = 'trialing' then s.trial_ends_at else s.current_period_end end as next_date
    from public.restaurant_subscriptions s
    join public.restaurants r on r.id = s.restaurant_id
    join public.plans p on p.id = s.plan_id
    cross join lateral private.restaurant_access(r.id) as a
    cross join lateral (
      select private.subscription_state(r.status::text, a.state, s.status::text, s.source::text)
        as state
    ) as st
    where v_state is null or st.state = v_state
  ),
  page as (
    select m.*
    from matching m
    order by m.state = 'payment_failed' desc, m.next_date nulls last, m.name, m.id
    limit v_page_size offset (v_page - 1) * v_page_size
  )
  select
    (select count(*) from matching),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'restaurant_id', pg.id,
        'name', pg.name,
        'slug', pg.slug,
        'restaurant_status', pg.restaurant_status,
        'plan_code', pg.plan_code,
        'plan_name', pg.plan_name,
        'billing_cycle', pg.billing_cycle,
        'status', pg.status,
        'source', pg.source,
        'trial_ends_at', pg.trial_ends_at,
        'current_period_end', pg.current_period_end,
        'grace_until', pg.grace_until,
        'cancel_at_period_end', pg.cancel_at_period_end,
        'access_state', pg.access_state,
        'state', pg.state,
        'ending', pg.ending
      ) order by pg.state = 'payment_failed' desc, pg.next_date nulls last, pg.name, pg.id)
      from page pg
    ), '[]'::jsonb)
  into v_total, v_rows;

  return jsonb_build_object('page', v_page, 'page_size', v_page_size, 'total', v_total, 'rows', v_rows);
end;
$function$;


-- A restaurant's billing history shows it closing, reopening and being cleared.

create or replace function public.platform_restaurant_billing(p_restaurant_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_money boolean;
  v_slug text;
  v_dues jsonb;
begin
  perform private.require_platform_permission('restaurants.view');
  v_money := private.has_platform_permission('money.view');
  select r.slug into v_slug from public.restaurants r where r.id = p_restaurant_id;
  if not found then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;

  -- The slug narrows dues_rows to (about) this restaurant before its access is
  -- worked out.
  select jsonb_build_object(
    'bucket', d.bucket,
    'renewal_kind', d.renewal_kind,
    'due_paise', case when v_money then d.due_paise end,
    'grace_until', d.grace_until,
    'trial_ends_at', d.trial_ends_at,
    'current_period_end', d.current_period_end,
    'restriction_at', d.restriction_at
  )
  into v_dues
  from private.dues_rows(v_slug) d
  where d.restaurant_id = p_restaurant_id;

  return jsonb_build_object(
    'dues', v_dues,
    'reminders', coalesce((
      select jsonb_agg(jsonb_build_object('kind', x.kind, 'sent_at', x.sent_at)
        order by x.sent_at desc)
      from (
        select sr.kind, sr.sent_at from public.subscription_reminders sr
        where sr.restaurant_id = p_restaurant_id
        order by sr.sent_at desc limit 50
      ) as x
    ), '[]'::jsonb),
    'links', coalesce((
      select jsonb_agg(jsonb_build_object(
        'at', x.created_at,
        'actor', x.actor,
        'purpose', x.after ->> 'purpose',
        'months', x.after -> 'months',
        'amount_paise', case when v_money then x.after -> 'amount_paise' end,
        'short_url', x.after ->> 'short_url',
        'paid_at', x.paid_at
      ) order by x.created_at desc)
      from (
        select a.created_at, a.after, u.email as actor, (
          select min(p.created_at) from public.audit_logs p
          where p.restaurant_id = p_restaurant_id
            and p.action = 'subscription.payment_received'
            and p.after ->> 'payment_link_id' = a.after ->> 'payment_link_id'
        ) as paid_at
        from public.audit_logs a
        left join auth.users u on u.id = a.actor_user_id
        where a.restaurant_id = p_restaurant_id and a.action = 'subscription.payment_link_sent'
        order by a.created_at desc limit 50
      ) as x
    ), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'at', x.created_at,
        'action', x.action,
        'actor', x.actor,
        'before', x.before,
        'after', case when v_money then x.after
          else x.after - 'price_paise' - 'list_price_paise' end,
        'reason', x.reason
      ) order by x.created_at desc)
      from (
        select a.created_at, a.action, a.before, a.after, a.reason,
          coalesce(u.email, a.actor_label) as actor
        from public.audit_logs a
        left join auth.users u on u.id = a.actor_user_id
        where a.restaurant_id = p_restaurant_id
          and a.action in (
            'subscription.plan_changed', 'subscription.trial_extended',
            'subscription.autopay_started', 'subscription.cancel_scheduled',
            'subscription.cancel_reason', 'subscription.razorpay_updated',
            'restaurant.suspended', 'restaurant.unsuspended',
            'restaurant.closed', 'restaurant.reopened', 'restaurant.personal_data_removed',
            'subscription.deal_set', 'subscription.deal_ended'
          )
        order by a.created_at desc limit 50
      ) as x
    ), '[]'::jsonb)
  );
end;
$function$;


-- A tab left open can't do what a closed restaurant's page no longer offers
-- (SA-94). Money that arrives can still be recorded.

create or replace function public.platform_extend_trial(p_restaurant_id uuid, p_days integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.manage');
  v_subscription public.restaurant_subscriptions;
  v_ends_at timestamptz;
begin
  perform private.refuse_closed(p_restaurant_id);
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
$function$;

create or replace function public.platform_change_plan(p_restaurant_id uuid, p_plan_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.manage');
  v_plan public.plans;
  v_subscription public.restaurant_subscriptions;
  v_old_code text;
begin
  perform private.refuse_closed(p_restaurant_id);
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
$function$;

create or replace function public.platform_reset_owner_password(p_member_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.support');
  v_member public.restaurant_members;
begin
  select * into v_member from public.restaurant_members m where m.id = p_member_id;
  if not found or v_member.role <> 'owner' then
    perform private.fail('MEMBER_NOT_FOUND');
  end if;
  perform private.refuse_closed(v_member.restaurant_id);
  perform private.audit_platform(
    v_admin, v_member.restaurant_id, 'staff.password_reset', 'restaurant_member', v_member.id
  );
  return v_member.user_id;
end;
$function$;

create or replace function public.platform_onboarding_support_session(
  p_restaurant_id uuid,
  p_staff_name text
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.support');
  v_name text := private.support_start_checks(v_admin, p_staff_name);
  v_session public.support_sessions%rowtype;
begin
  perform private.refuse_closed(p_restaurant_id);
  if not exists (
    select 1 from public.audit_logs l
    where l.restaurant_id = p_restaurant_id
      and l.action = 'restaurant.created'
      and l.actor_user_id = v_admin.user_id
      and l.created_at > now() - interval '1 hour'
  ) or exists (
    select 1 from public.support_sessions s where s.restaurant_id = p_restaurant_id
  ) then
    perform private.fail('NO_SUPPORT_ACCESS');
  end if;

  begin
    insert into public.support_sessions (
      restaurant_id, consent, granted_by, ends_at, user_id, staff_name, started_at
    )
    values (
      p_restaurant_id, 'onboarding', v_admin.user_id, now() + interval '24 hours',
      v_admin.user_id, v_name, now()
    )
    returning * into v_session;
  exception when unique_violation then
    perform private.fail('NO_SUPPORT_ACCESS');
  end;
  perform private.audit_platform(
    v_admin, p_restaurant_id, 'support_access.allowed', 'support_session', v_session.id, null,
    jsonb_build_object('consent', 'onboarding', 'hours', 24, 'ends_at', v_session.ends_at)
  );
  perform private.audit_platform(
    v_admin, p_restaurant_id, 'support_session.started', 'support_session', v_session.id, null,
    jsonb_build_object('staff_name', v_name, 'ends_at', v_session.ends_at)
  );
  return v_session.ends_at;
end;
$$;

create or replace function public.platform_set_deal(p_restaurant_id uuid, p_deal jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('money.record');
  v_input jsonb := coalesce(p_deal, '{}'::jsonb);
  v_sub public.restaurant_subscriptions;
  v_plan public.plans;
  v_cycle public.billing_cycle;
  v_offer public.offers;
  v_list bigint;
  v_price bigint;
  v_cycles int;
  v_reason text;
  v_refusal text;
  v_autopay boolean;
  v_fits boolean;
  v_ended int;
  v_ended_ids uuid[];
  v_still_charged boolean;
  v_deal public.subscription_deals;
begin
  perform private.refuse_closed(p_restaurant_id);
  perform private.assert_keys(v_input,
    array['plan_code', 'billing_cycle', 'offer_code', 'price_paise', 'cycles', 'reason', 'end']);
  select * into v_sub from public.restaurant_subscriptions s
  where s.restaurant_id = p_restaurant_id
  for update;
  if v_sub.id is null then
    if not exists (select 1 from public.restaurants r where r.id = p_restaurant_id) then
      perform private.fail('RESTAURANT_NOT_FOUND');
    end if;
    perform private.fail('SUBSCRIPTION_NOT_FOUND');
  end if;
  -- A mandate that will charge again keeps the price it was set up with.
  v_autopay := coalesce(v_sub.razorpay_status in ('authenticated', 'active', 'pending', 'halted'), false)
    and not v_sub.cancel_at_period_end;
  v_reason := private.tidy_text(private.json_text(v_input, 'reason'));
  if char_length(v_reason) > 500 then
    perform private.fail('INVALID_INPUT', 'reason');
  end if;

  if v_input ? 'end' then
    if v_input - 'reason' <> jsonb_build_object('end', true) then
      perform private.fail('INVALID_INPUT', 'end');
    end if;
    -- Back to the list price: the deal waiting and the one in use, except one
    -- a running autopay charges (cancel autopay first).
    with ended as (
      update public.subscription_deals d set ended_at = now()
      where d.restaurant_id = p_restaurant_id and d.ended_at is null
        and (d.used_at is null or d.id = v_sub.deal_id)
        and not (v_autopay and coalesce(d.id in (v_sub.deal_id, v_sub.next_deal_id), false))
      returning d.id
    )
    select count(*), array_agg(ended.id) into v_ended, v_ended_ids from ended;
    if v_ended = 0 then
      perform private.fail(case
        when v_autopay and coalesce(v_sub.deal_id, v_sub.next_deal_id) is not null
          then 'DEAL_IN_AUTOPAY' else 'DEAL_NOT_FOUND' end);
    end if;
    if not v_autopay and v_sub.deal_id is not null then
      update public.restaurant_subscriptions s set deal_id = null where s.id = v_sub.id;
    end if;
    -- Only the deal waiting ended: a running autopay keeps charging its price.
    v_still_charged := v_autopay and coalesce(v_sub.deal_id, v_sub.next_deal_id) is not null;
    perform private.audit_platform(v_admin, p_restaurant_id, 'subscription.deal_ended',
      'subscription_deal', v_ended_ids[1], null,
      jsonb_build_object('ended', v_ended, 'deal_ids', to_jsonb(v_ended_ids),
        'still_charged', v_still_charged), v_reason);
    return jsonb_build_object('ended', v_ended, 'still_charged', v_still_charged);
  end if;

  select * into v_plan from public.plans p where p.code = private.json_text(v_input, 'plan_code');
  if v_plan.id is null then
    perform private.fail('PLAN_NOT_FOUND');
  end if;
  if not v_plan.is_active then
    perform private.fail('PLAN_INACTIVE');
  end if;
  if private.json_text(v_input, 'billing_cycle') is null
     or private.json_text(v_input, 'billing_cycle') not in ('monthly', 'yearly') then
    perform private.fail('INVALID_INPUT', 'billing_cycle');
  end if;
  v_cycle := private.json_text(v_input, 'billing_cycle')::public.billing_cycle;
  v_list := private.cycle_price_paise(v_plan, v_cycle);
  if v_list < 100 then
    perform private.fail('INVALID_INPUT', 'plan_code');
  end if;

  if (v_input ? 'offer_code') = (v_input ? 'price_paise') then
    perform private.fail('INVALID_INPUT', 'offer_code');
  end if;
  if v_input ? 'offer_code' then
    if v_input ? 'cycles' then
      perform private.fail('INVALID_INPUT', 'cycles');
    end if;
    select * into v_offer from public.offers o
    where o.code = upper(btrim(coalesce(private.json_text(v_input, 'offer_code'), '')))
    for update;
    if v_offer.id is null then
      perform private.fail('OFFER_NOT_FOUND');
    end if;
    v_refusal := private.offer_refusal(v_offer, p_restaurant_id);
    if v_refusal is not null then
      perform private.fail(v_refusal);
    end if;
    v_price := private.offer_price_paise(v_offer, v_plan, v_cycle);
    if v_price is null then
      perform private.fail('OFFER_NOT_FOR_PLAN');
    end if;
    v_cycles := v_offer.duration_cycles;
  else
    v_price := private.json_int(v_input, 'price_paise');
    if v_price is null or v_price < 100 or v_price >= v_list or v_price % 100 <> 0 then
      perform private.fail('INVALID_INPUT', 'price_paise');
    end if;
    if v_reason is null then
      perform private.fail('INVALID_INPUT', 'reason');
    end if;
    if v_input ? 'cycles' and jsonb_typeof(v_input -> 'cycles') <> 'null' then
      v_cycles := private.json_int(v_input, 'cycles');
      if v_cycles not between 1 and 120 then
        perform private.fail('INVALID_INPUT', 'cycles');
      end if;
    end if;
  end if;

  -- Its plan, and its cycle or none yet (a trial).
  v_fits := v_sub.plan_id = v_plan.id and coalesce(v_sub.billing_cycle = v_cycle, true);
  -- It replaces the deal waiting, unless a set-up autopay will charge that one.
  if exists (
    select 1 from public.subscription_deals d
    where d.restaurant_id = p_restaurant_id and d.ended_at is null and d.used_at is null
      and v_autopay and d.id = v_sub.next_deal_id
  ) then
    perform private.fail('DEAL_IN_AUTOPAY');
  end if;
  update public.subscription_deals d set ended_at = now()
  where d.restaurant_id = p_restaurant_id and d.ended_at is null and d.used_at is null;
  insert into public.subscription_deals (restaurant_id, offer_id, plan_id, billing_cycle,
    list_price_paise, price_paise, cycles, reason, razorpay_plan_id, created_by)
  values (p_restaurant_id, v_offer.id, v_plan.id, v_cycle, v_list, v_price, v_cycles, v_reason,
    (select d.razorpay_plan_id from public.subscription_deals d
     where d.plan_id = v_plan.id and d.billing_cycle = v_cycle and d.price_paise = v_price
       and d.razorpay_plan_id is not null
     limit 1),
    v_admin.user_id)
  returning * into v_deal;
  -- Not on autopay: the price from now on; the deal it replaces ends.
  if not v_autopay and v_fits then
    update public.restaurant_subscriptions s set deal_id = v_deal.id where s.id = v_sub.id;
  end if;
  perform private.audit_platform(v_admin, p_restaurant_id, 'subscription.deal_set',
    'subscription_deal', v_deal.id, null,
    jsonb_build_object('offer_code', v_offer.code, 'plan_code', v_plan.code,
      'billing_cycle', v_cycle, 'list_price_paise', v_list, 'price_paise', v_price,
      'cycles', v_cycles, 'applied_now', not v_autopay and v_fits),
    v_reason);
  return private.deal_json(v_deal.id, true)
    || jsonb_build_object('applied_now', not v_autopay and v_fits);
end;
$$;

create or replace function public.platform_set_override(p_restaurant_id uuid, p_override jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.manage');
  v_input jsonb := coalesce(p_override, '{}'::jsonb);
  v_kind text;
  v_feature text;
  v_value int;
  v_expires timestamptz;
  v_reason text;
  v_old public.restaurant_overrides;
  v_row public.restaurant_overrides;
begin
  perform private.refuse_closed(p_restaurant_id);
  perform private.assert_keys(v_input, array['kind', 'feature', 'value', 'expires_at', 'reason']);
  if not exists (select 1 from public.restaurants r where r.id = p_restaurant_id) then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;
  v_kind := private.json_text(v_input, 'kind');
  if v_kind is null or v_kind not in ('feature', 'max_tables', 'max_staff') then
    perform private.fail('INVALID_INPUT', 'kind');
  end if;
  if v_kind = 'feature' then
    v_feature := private.json_text(v_input, 'feature');
    if v_feature is null or v_feature !~ '^[a-z_]{1,40}$' then
      perform private.fail('INVALID_INPUT', 'feature');
    end if;
    if v_input ? 'value' and jsonb_typeof(v_input -> 'value') <> 'null' then
      perform private.fail('INVALID_INPUT', 'value');
    end if;
  else
    if v_input ? 'feature' and jsonb_typeof(v_input -> 'feature') <> 'null' then
      perform private.fail('INVALID_INPUT', 'feature');
    end if;
    if v_input ? 'value' and jsonb_typeof(v_input -> 'value') <> 'null' then
      v_value := private.json_int(v_input, 'value');
      if v_value not between 1 and 10000 then
        perform private.fail('INVALID_INPUT', 'value');
      end if;
    end if;
  end if;
  v_expires := private.json_time(v_input, 'expires_at');
  if v_expires <= now() then
    perform private.fail('INVALID_INPUT', 'expires_at');
  end if;
  v_reason := private.tidy_text(private.json_text(v_input, 'reason'));
  if v_reason is null or char_length(v_reason) > 500 then
    perform private.fail('INVALID_INPUT', 'reason');
  end if;

  select * into v_old from public.restaurant_overrides o
  where o.restaurant_id = p_restaurant_id and o.kind = v_kind
    and coalesce(o.feature, '') = coalesce(v_feature, '')
  for update;
  insert into public.restaurant_overrides (restaurant_id, kind, feature, value, expires_at, reason,
    created_by)
  values (p_restaurant_id, v_kind, v_feature, v_value, v_expires, v_reason, v_admin.user_id)
  on conflict (restaurant_id, kind, (coalesce(feature, ''))) do update
    set value = excluded.value, expires_at = excluded.expires_at, reason = excluded.reason,
      created_by = excluded.created_by, updated_at = now()
  returning * into v_row;
  perform private.audit_platform(v_admin, p_restaurant_id, 'restaurant.override_set',
    'restaurant_override', v_row.id,
    case when v_old.id is not null then jsonb_build_object('value', v_old.value, 'expires_at', v_old.expires_at) end,
    jsonb_build_object('kind', v_kind, 'feature', v_feature, 'value', v_value, 'expires_at', v_expires),
    v_reason);
  return jsonb_build_object('id', v_row.id);
end;
$$;

create or replace function public.platform_save_standees(p_restaurant_id uuid, p_standees jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_patch jsonb := coalesce(p_standees, '{}'::jsonb);
  v_admin private.platform_admin_context;
  v_old public.standees;
  v_new public.standees;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_dates date[];
  v_key text;
  v_before jsonb := '{}'::jsonb;
  v_after jsonb := '{}'::jsonb;
begin
  if v_patch - 'cost_paise' <> '{}'::jsonb or not v_patch ? 'cost_paise' then
    v_admin := private.require_platform_permission('restaurants.manage');
  end if;
  if v_patch ? 'cost_paise' then
    v_admin := private.require_platform_permission('money.record');
  end if;
  perform private.assert_keys(v_patch, array['quantity', 'printed_on', 'dispatched_on',
    'delivered_on', 'installed_on', 'vendor', 'notes', 'cost_paise', 'expected_status']);
  if not exists (select 1 from public.restaurants r where r.id = p_restaurant_id) then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;
  perform private.refuse_closed(p_restaurant_id);

  select * into v_old from public.standees s where s.restaurant_id = p_restaurant_id for update;
  -- The status the page showed, for one-click steps.
  if v_patch ? 'expected_status'
     and coalesce(v_old.status, 'not_started') is distinct from v_patch ->> 'expected_status' then
    perform private.fail('STANDEE_CHANGED');
  end if;
  v_patch := v_patch - 'expected_status';
  if v_old.restaurant_id is null then
    -- Making the record is managing the restaurant, with a cost or not.
    v_admin := private.require_platform_permission('restaurants.manage');
    v_new.restaurant_id := p_restaurant_id;
    v_new.quantity := greatest(1, (
      select count(*) from public.dining_tables t
      where t.restaurant_id = p_restaurant_id and t.is_active
    ))::int;
  else
    v_new := v_old;
  end if;

  if v_patch ? 'quantity' then
    v_new.quantity := private.json_int(v_patch, 'quantity');
    if v_new.quantity is null or v_new.quantity not between 1 and 500 then
      perform private.fail('INVALID_INPUT', 'quantity');
    end if;
  end if;
  if v_patch ? 'printed_on' then
    v_new.printed_on := private.json_date(v_patch, 'printed_on');
  end if;
  if v_patch ? 'dispatched_on' then
    v_new.dispatched_on := private.json_date(v_patch, 'dispatched_on');
  end if;
  if v_patch ? 'delivered_on' then
    v_new.delivered_on := private.json_date(v_patch, 'delivered_on');
  end if;
  if v_patch ? 'installed_on' then
    v_new.installed_on := private.json_date(v_patch, 'installed_on');
  end if;
  -- Not ahead of today (India), and each step on or after the ones before it.
  v_dates := array[v_new.printed_on, v_new.dispatched_on, v_new.delivered_on, v_new.installed_on];
  for i in 1..4 loop
    if v_dates[i] > v_today or exists (
      select 1 from generate_series(1, i - 1) as j where v_dates[j] > v_dates[i]
    ) then
      perform private.fail('INVALID_INPUT',
        (array['printed_on', 'dispatched_on', 'delivered_on', 'installed_on'])[i]);
    end if;
  end loop;
  if v_patch ? 'vendor' then
    v_new.vendor := private.tidy_text(private.json_text(v_patch, 'vendor'));
    if char_length(v_new.vendor) > 120 then
      perform private.fail('INVALID_INPUT', 'vendor');
    end if;
  end if;
  if v_patch ? 'notes' then
    v_new.notes := nullif(btrim(private.json_text(v_patch, 'notes')), '');
    if char_length(v_new.notes) > 1000 then
      perform private.fail('INVALID_INPUT', 'notes');
    end if;
  end if;
  if v_patch ? 'cost_paise' then
    v_new.cost_paise := case when jsonb_typeof(v_patch -> 'cost_paise') <> 'null'
      then private.json_int(v_patch, 'cost_paise') end;
    if v_new.cost_paise not between 0 and 100000000 then
      perform private.fail('INVALID_INPUT', 'cost_paise');
    end if;
  end if;

  if v_old.restaurant_id is null then
    insert into public.standees (restaurant_id, quantity, printed_on, dispatched_on, delivered_on,
      installed_on, vendor, cost_paise, notes, created_by)
    values (p_restaurant_id, v_new.quantity, v_new.printed_on, v_new.dispatched_on,
      v_new.delivered_on, v_new.installed_on, v_new.vendor, v_new.cost_paise, v_new.notes,
      v_admin.user_id)
    returning * into v_new;
    perform private.audit_platform(v_admin, p_restaurant_id, 'standee.created', 'standee',
      p_restaurant_id, null, jsonb_strip_nulls(jsonb_build_object('status', v_new.status,
        'quantity', v_new.quantity, 'printed_on', v_new.printed_on,
        'dispatched_on', v_new.dispatched_on, 'delivered_on', v_new.delivered_on,
        'installed_on', v_new.installed_on, 'vendor', v_new.vendor,
        'cost_paise', v_new.cost_paise, 'notes', v_new.notes)));
  else
    update public.standees s set
      quantity = v_new.quantity,
      printed_on = v_new.printed_on,
      dispatched_on = v_new.dispatched_on,
      delivered_on = v_new.delivered_on,
      installed_on = v_new.installed_on,
      vendor = v_new.vendor,
      cost_paise = v_new.cost_paise,
      notes = v_new.notes,
      updated_at = now()
    where s.restaurant_id = p_restaurant_id
    returning * into v_new;
    foreach v_key in array array['status', 'quantity', 'printed_on', 'dispatched_on',
      'delivered_on', 'installed_on', 'vendor', 'cost_paise', 'notes'] loop
      if to_jsonb(v_old) -> v_key is distinct from to_jsonb(v_new) -> v_key then
        v_before := v_before || jsonb_build_object(v_key, to_jsonb(v_old) -> v_key);
        v_after := v_after || jsonb_build_object(v_key, to_jsonb(v_new) -> v_key);
      end if;
    end loop;
    if v_before <> '{}'::jsonb then
      perform private.audit_platform(v_admin, p_restaurant_id, 'standee.updated', 'standee',
        p_restaurant_id, v_before, v_after);
    end if;
  end if;
  return jsonb_build_object('status', v_new.status);
end;
$$;


-- Notes go with the removal, and one written after it would stay for good. During
-- the hold the team can still write down what the owner said.

create or replace function public.platform_add_note(
  p_restaurant_id uuid,
  p_body text,
  p_pinned boolean default false
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.manage');
  v_body text := private.note_body(p_body);
  v_id uuid;
begin
  if not exists (select 1 from public.restaurants r where r.id = p_restaurant_id) then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;
  if exists (
    select 1 from public.restaurant_closures c
    where c.restaurant_id = p_restaurant_id and c.removed_at is not null
  ) then
    perform private.fail('PERSONAL_DATA_REMOVED');
  end if;
  insert into public.restaurant_notes (restaurant_id, author_id, body, pinned)
  values (p_restaurant_id, v_admin.user_id, v_body, coalesce(p_pinned, false))
  returning id into v_id;
  perform private.audit_platform(
    v_admin, p_restaurant_id, 'restaurant.note_added', 'restaurant_note', v_id,
    null, jsonb_build_object('body', v_body, 'pinned', coalesce(p_pinned, false))
  );
  return v_id;
end;
$$;


-- A payment link can be paid after the removal: its event keeps no payer (SA-97).

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
  values ('razorpay', p_event_id, v_type, case
    when exists (
      select 1 from public.restaurant_closures c
      where c.removed_at is not null
        and c.restaurant_id::text = any (private.webhook_restaurant_ids(p_payload))
    ) then private.webhook_without_payer(p_payload)
    else p_payload
  end)
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


-- Removed leads all carry the same stand-in phone: they aren't duplicates.

create or replace function private.lead_matches(p_phone text, p_lead_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'restaurants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'name', r.name, 'slug', r.slug, 'city', r.city
      ) order by r.created_at, r.id)
      from (
        select r.* from public.restaurants r
        where p_phone is not null and private.phone10(r.phone) = p_phone
        order by r.created_at, r.id
        limit 10
      ) r
    ), '[]'::jsonb),
    'leads', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id, 'name', l.name, 'restaurant_name', l.restaurant_name, 'city', l.city,
        'stage', l.stage, 'created_at', l.created_at
      ) order by l.created_at desc, l.id)
      from (
        select l.* from public.site_leads l
        where p_phone is not null and p_phone <> '0000000000' and l.phone = p_phone
          and l.id is distinct from p_lead_id
        order by l.created_at desc, l.id
        limit 10
      ) l
    ), '[]'::jsonb)
  );
$$;


-- ─── The reports leave closed restaurants out ───────────────────────────────
-- "Of Y restaurants": one closed before these dates began isn't among them. One
-- closed during them is: it took orders in them.

create or replace function public.platform_usage_report(p_from date, p_to date, p_compare boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_start date;
  v_live public.metrics_usage_daily[];
  v_result jsonb;
  v_days jsonb;
  v_hours jsonb;
begin
  perform private.require_platform_permission('insights.view');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    perform private.fail('INVALID_INPUT', 'dates');
  end if;
  v_start := case when p_compare then p_from - (p_to - p_from + 1) else p_from end;
  v_live := array(select l from private.metrics_usage_rows(v_start, p_to, null, true) as l);

  -- Materialized: each restaurant's today once, not once per stored day.
  with r as materialized (
    select
      x.id, x.name,
      nullif(btrim(x.city), '') as city,
      nullif(btrim(x.state), '') as region,
      p.code as plan_code, p.name as plan_name,
      private.business_date(now(), x.timezone, x.business_day_start_hour) as today,
      -- By business date, like the days counted: one opened at 1 am belongs to the day before.
      private.business_date(x.created_at, x.timezone, x.business_day_start_hour) <= p_to
        and not exists (
          select 1 from public.restaurant_closures c
          where c.restaurant_id = x.id
            and private.business_date(c.closed_at, x.timezone, x.business_day_start_hour) < p_from
        ) as counted
    from public.restaurants x
    left join public.restaurant_subscriptions s on s.restaurant_id = x.id
    left join public.plans p on p.id = s.plan_id
  ),
  days as (
    select m.*
    from public.metrics_usage_daily m
    join r on r.id = m.restaurant_id
    where m.business_day between v_start and p_to and m.business_day <= r.today - 2
    union all
    select l.* from unnest(v_live) as l
  ),
  per as (
    select
      d.restaurant_id,
      coalesce(sum(d.orders) filter (where d.business_day >= p_from), 0) as orders,
      coalesce(sum(d.customer_orders) filter (where d.business_day >= p_from), 0) as customer_orders,
      coalesce(sum(d.staff_orders) filter (where d.business_day >= p_from), 0) as staff_orders,
      coalesce(sum(d.items) filter (where d.business_day >= p_from), 0) as items,
      coalesce(sum(d.bills) filter (where d.business_day >= p_from), 0) as bills,
      coalesce(sum(d.gmv_paise) filter (where d.business_day >= p_from), 0) as gmv_paise,
      coalesce(sum(d.discount_paise) filter (where d.business_day >= p_from), 0) as discount_paise,
      coalesce(sum(d.paid_cash_paise) filter (where d.business_day >= p_from), 0) as cash,
      coalesce(sum(d.paid_upi_paise) filter (where d.business_day >= p_from), 0) as upi,
      coalesce(sum(d.paid_card_paise) filter (where d.business_day >= p_from), 0) as card,
      coalesce(sum(d.paid_other_paise) filter (where d.business_day >= p_from), 0) as other,
      -- Table time: each day's average weighted by its bills (SA-62).
      coalesce(sum(d.avg_session_minutes * d.sessions_billed)
        filter (where d.business_day >= p_from), 0) as table_minutes,
      coalesce(sum(d.sessions_billed)
        filter (where d.business_day >= p_from and d.avg_session_minutes is not null), 0)
        as timed_bills,
      coalesce(sum(d.service_requests) filter (where d.business_day >= p_from), 0)
        as service_requests,
      coalesce(sum(d.waiter_bills) filter (where d.business_day >= p_from), 0) as waiter_bills,
      coalesce(sum(d.split_bills) filter (where d.business_day >= p_from), 0) as split_bills,
      coalesce(sum(d.addon_orders) filter (where d.business_day >= p_from), 0) as addon_orders,
      coalesce(sum(d.hindi_orders) filter (where d.business_day >= p_from), 0) as hindi_orders,
      coalesce(sum(d.orders) filter (where d.business_day < p_from), 0) as prev_orders,
      coalesce(sum(d.customer_orders) filter (where d.business_day < p_from), 0)
        as prev_customer_orders,
      coalesce(sum(d.staff_orders) filter (where d.business_day < p_from), 0) as prev_staff_orders,
      coalesce(sum(d.items) filter (where d.business_day < p_from), 0) as prev_items,
      coalesce(sum(d.bills) filter (where d.business_day < p_from), 0) as prev_bills,
      coalesce(sum(d.gmv_paise) filter (where d.business_day < p_from), 0) as prev_gmv_paise
    from days d
    group by d.restaurant_id
  ),
  listed as (
    select r.*, coalesce(p.orders, 0) as orders, coalesce(p.gmv_paise, 0) as gmv_paise
    from r
    left join per p on p.restaurant_id = r.id
    where r.counted
  ),
  ranked as (
    select p.restaurant_id as id, r.name, r.city, p.orders, p.gmv_paise
    from per p
    join r on r.id = p.restaurant_id
    where p.orders > 0 or p.gmv_paise > 0
  ),
  paid as (
    -- Active Paid restaurants: paid now and an accepted order in the dates.
    select private.restaurant_features(p.restaurant_id, p_from, p_to, jsonb_build_object(
      'waiter_bills', p.waiter_bills, 'split_bills', p.split_bills,
      'discount_paise', p.discount_paise, 'service_requests', p.service_requests,
      'addon_orders', p.addon_orders, 'hindi_orders', p.hindi_orders
    )) as used
    from per p
    join public.restaurants x on x.id = p.restaurant_id
    left join public.restaurant_subscriptions s on s.restaurant_id = x.id
    cross join lateral private.restaurant_access(x.id) as a
    where p.orders > 0
      and private.subscription_state(x.status::text, a.state, s.status::text, s.source::text) = 'paid'
  )
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'previous_from', case when p_compare then v_start end,
    'previous_to', case when p_compare then p_from - 1 end,
    'totals', (
      select jsonb_build_object(
        'restaurants', (select count(*) from r where r.counted),
        'active', count(*) filter (where p.orders > 0),
        'orders', coalesce(sum(p.orders), 0),
        'customer_orders', coalesce(sum(p.customer_orders), 0),
        'staff_orders', coalesce(sum(p.staff_orders), 0),
        'items', coalesce(sum(p.items), 0),
        'bills', coalesce(sum(p.bills), 0),
        'gmv_paise', coalesce(sum(p.gmv_paise), 0),
        'discount_paise', coalesce(sum(p.discount_paise), 0),
        'collected', jsonb_build_object(
          'cash', coalesce(sum(p.cash), 0), 'upi', coalesce(sum(p.upi), 0),
          'card', coalesce(sum(p.card), 0), 'other', coalesce(sum(p.other), 0)
        ),
        'table_minutes', case when sum(p.timed_bills) > 0
          then round(sum(p.table_minutes) / sum(p.timed_bills)) end,
        'service_requests', coalesce(sum(p.service_requests), 0)
      )
      from per p
    ),
    'previous', case when p_compare then (
      select jsonb_build_object(
        'active', count(*) filter (where p.prev_orders > 0),
        'orders', coalesce(sum(p.prev_orders), 0),
        'customer_orders', coalesce(sum(p.prev_customer_orders), 0),
        'staff_orders', coalesce(sum(p.prev_staff_orders), 0),
        'items', coalesce(sum(p.prev_items), 0),
        'bills', coalesce(sum(p.prev_bills), 0),
        'gmv_paise', coalesce(sum(p.prev_gmv_paise), 0)
      )
      from per p
    ) end,
    'by_city', (
      select coalesce(jsonb_agg(g order by g.gmv_paise desc, g.restaurants desc), '[]'::jsonb)
      from (
        select
          mode() within group (order by l.city) as name, count(*) as restaurants,
          count(*) filter (where l.orders > 0) as active,
          sum(l.orders) as orders, sum(l.gmv_paise) as gmv_paise
        from listed l
        group by lower(l.city)
      ) as g
    ),
    'by_state', (
      select coalesce(jsonb_agg(g order by g.gmv_paise desc, g.restaurants desc), '[]'::jsonb)
      from (
        select
          mode() within group (order by l.region) as name, count(*) as restaurants,
          count(*) filter (where l.orders > 0) as active,
          sum(l.orders) as orders, sum(l.gmv_paise) as gmv_paise
        from listed l
        group by lower(l.region)
      ) as g
    ),
    'by_plan', (
      select coalesce(jsonb_agg(g order by g.gmv_paise desc, g.restaurants desc), '[]'::jsonb)
      from (
        select
          l.plan_code as code, l.plan_name as name, count(*) as restaurants,
          count(*) filter (where l.orders > 0) as active,
          sum(l.orders) as orders, sum(l.gmv_paise) as gmv_paise
        from listed l
        group by l.plan_code, l.plan_name
      ) as g
    ),
    'top_gmv', (
      select coalesce(jsonb_agg(t order by t.gmv_paise desc, t.name, t.id), '[]'::jsonb)
      from (
        select * from ranked where gmv_paise > 0 order by gmv_paise desc, name, id limit 10
      ) as t
    ),
    'bottom_gmv', (
      select coalesce(jsonb_agg(t order by t.gmv_paise, t.name, t.id), '[]'::jsonb)
      from (
        select * from ranked where orders > 0 order by gmv_paise, name, id limit 10
      ) as t
    ),
    'top_orders', (
      select coalesce(jsonb_agg(t order by t.orders desc, t.name, t.id), '[]'::jsonb)
      from (
        select * from ranked where orders > 0 order by orders desc, name, id limit 10
      ) as t
    ),
    'bottom_orders', (
      select coalesce(jsonb_agg(t order by t.orders, t.name, t.id), '[]'::jsonb)
      from (
        select * from ranked where orders > 0 order by orders, name, id limit 10
      ) as t
    ),
    'features', jsonb_build_object(
      'restaurants', (select count(*) from paid),
      'used', (
        select coalesce(jsonb_object_agg(f.key, f.n), '{}'::jsonb)
        from (
          select e.key, count(*) filter (where e.value = 'true'::jsonb) as n
          from paid
          cross join lateral jsonb_each(paid.used) as e
          group by e.key
        ) as f
      )
    )
  )
  into v_result;

  -- GMV and orders by business day.
  select coalesce(jsonb_agg(jsonb_build_object(
    'day', x.day, 'gmv_paise', x.gmv_paise, 'orders', x.orders
  ) order by x.day), '[]'::jsonb)
  into v_days
  from (
    with stored as materialized (
      select x.id,
        private.business_date(now(), x.timezone, x.business_day_start_hour) - 2 as last_day
      from public.restaurants x
    )
    select d.business_day as day, sum(d.gmv_paise) as gmv_paise, sum(d.orders) as orders
    from (
      select m.business_day, m.gmv_paise, m.orders
      from public.metrics_usage_daily m
      join stored on stored.id = m.restaurant_id
      where m.business_day between p_from and p_to and m.business_day <= stored.last_day
      union all
      select l.business_day, l.gmv_paise, l.orders
      from unnest(v_live) as l
      where l.business_day >= p_from
    ) as d
    group by d.business_day
  ) as x;

  -- Accepted orders by the business day's weekday and the restaurant's clock
  -- hour (SA-62).
  select coalesce(jsonb_agg(jsonb_build_object(
    'weekday', x.weekday, 'hour', x.hour, 'orders', x.orders
  ) order by x.weekday, x.hour), '[]'::jsonb)
  into v_hours
  from (
    with stored as materialized (
      select x.id,
        private.business_date(now(), x.timezone, x.business_day_start_hour) - 2 as last_day
      from public.restaurants x
    )
    select extract(isodow from d.business_day)::int as weekday, (h.idx - 1)::int as hour,
      sum(h.n)::int as orders
    from (
      select m.business_day, m.hourly_orders
      from public.metrics_usage_daily m
      join stored on stored.id = m.restaurant_id
      where m.business_day between p_from and p_to and m.orders > 0
        and m.business_day <= stored.last_day
      union all
      select l.business_day, l.hourly_orders
      from unnest(v_live) as l
      where l.business_day >= p_from and l.orders > 0
    ) as d
    cross join lateral unnest(d.hourly_orders) with ordinality as h(n, idx)
    where h.n > 0
    group by 1, 2
  ) as x;

  return v_result || jsonb_build_object('days', v_days, 'hours', v_hours);
end;
$function$;

create or replace function public.platform_revenue_report(p_from date, p_to date, p_by text DEFAULT 'month'::text, p_compare boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_start date;
  v_hist date;
  v_result jsonb;
begin
  perform private.require_platform_permission('money.view');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    perform private.fail('INVALID_INPUT', 'dates');
  end if;
  if p_by is null or p_by not in ('day', 'week', 'month') then
    perform private.fail('INVALID_INPUT', 'by');
  end if;
  v_start := case when p_compare then p_from - (p_to - p_from + 1) else p_from end;
  select min(m.day) into v_hist from public.metrics_subscription_daily m;

  with d as materialized (
    select * from private.mrr_days(v_start - 1)
  ),
  -- MRR and Paid on each day with rows.
  nights as materialized (
    select d.day, sum(d.mrr_paise) as mrr, count(*) filter (where d.state = 'paid') as paid
    from d
    group by d.day
  ),
  moves as materialized (
    select d.day, d.restaurant_id, d.movement, d.mrr_paise - d.before_paise as change
    from d
    where d.movement is not null and d.day >= p_from - (p_to - p_from + 1) and d.day > v_hist
  ),
  -- Each change of state, with the state that followed it.
  changes as materialized (
    select c.day, c.state, lead(c.state) over (partition by c.restaurant_id order by c.day) as next_state
    from d as c
    where c.state is distinct from c.before_state
  ),
  paid_days as materialized (
    select
      (p.created_at at time zone 'Asia/Kolkata')::date as day,
      coalesce(sum(p.base_paise) filter (where p.purpose = 'subscription'), 0) as subscription,
      coalesce(sum(p.base_paise) filter (where p.purpose = 'setup_fee'), 0) as setup_fee,
      sum(p.gst_paise) as gst,
      count(*) as n
    from public.subscription_payments p
    where p.created_at >= v_start::timestamp at time zone 'Asia/Kolkata'
      and p.created_at < (p_to + 1)::timestamp at time zone 'Asia/Kolkata'
    group by 1
  ),
  -- Trial cohorts (plan §5.7): converted is a first subscription payment by the
  -- trial's end plus 30 days.
  cohort as materialized (
    select
      (r.created_at at time zone 'Asia/Kolkata')::date as day,
      r.created_at,
      fp.paid_at,
      coalesce(s.trial_ends_at, r.created_at) + interval '30 days' as deadline
    from public.restaurants r
    left join public.restaurant_subscriptions s on s.restaurant_id = r.id
    cross join lateral (
      select min(p.created_at) as paid_at
      from public.subscription_payments p
      where p.restaurant_id = r.id and p.purpose = 'subscription'
    ) as fp
    where r.created_at >= v_start::timestamp at time zone 'Asia/Kolkata'
      and r.created_at < (p_to + 1)::timestamp at time zone 'Asia/Kolkata'
  ),
  periods as (
    select 'now' as key, p_from as f, p_to as t
    union all
    select 'previous', v_start, p_from - 1 where p_compare
  ),
  bounds as (
    select
      pr.key, pr.f, pr.t,
      case when pr.key = 'now'
        then greatest((select max(n.day) from nights n where n.day < pr.f), v_hist)
        else (select max(n.day) from nights n where n.day < pr.f)
      end as open_day,
      (select max(n.day) from nights n where n.day <= pr.t) as end_day
    from periods pr
  ),
  totals as (
    select b.key, jsonb_build_object(
      'mrr_paise', te.mrr,
      'paid', te.paid,
      'opening_day', case when b.open_day <= b.t then b.open_day end,
      'opening_mrr_paise', case when b.open_day <= b.t then tob.mrr end,
      'opening_paid', case when b.open_day <= b.t then tob.paid end,
      'movements', mv.movements,
      'churned', lost.churned,
      'lost_paise', lost.paise,
      'collected', (
        select jsonb_build_object(
          'subscription_base_paise', coalesce(sum(x.subscription), 0),
          'setup_fee_base_paise', coalesce(sum(x.setup_fee), 0),
          'gst_paise', coalesce(sum(x.gst), 0),
          'count', coalesce(sum(x.n), 0))
        from paid_days x
        where x.day between b.f and b.t
      ),
      'conversion', (
        select jsonb_build_object(
          'created', count(*),
          'converted', count(*) filter (where c.paid_at <= c.deadline),
          'deciding', count(*) filter (where c.paid_at is null and now() < c.deadline),
          'average_days', round(avg(extract(epoch from c.paid_at - c.created_at) / 86400)
            filter (where c.paid_at <= c.deadline), 1))
        from cohort c
        where c.day between b.f and b.t
      ),
      'recovery', (
        select jsonb_build_object(
          'entered', count(*),
          'recovered', count(*) filter (where c.next_state = 'paid'),
          'still_failed', count(*) filter (where c.next_state is null))
        from changes c
        where c.state = 'payment_failed' and c.day between b.f and b.t and c.day > b.open_day
      )
    ) as body
    from bounds b
    left join nights te on te.day = b.end_day
    left join nights tob on tob.day = b.open_day
    cross join lateral (
      select jsonb_object_agg(k.kind, jsonb_build_object('count', k.n, 'paise', k.paise)) as movements
      from (
        select kinds.kind, count(m.day) as n, coalesce(sum(m.change), 0) as paise
        from unnest(array['new', 'reactivation', 'expansion', 'contraction', 'churn']) as kinds(kind)
        left join moves m
          on m.movement = kinds.kind and m.day between b.f and b.t and m.day > b.open_day
        group by kinds.kind
      ) as k
    ) as mv
    -- Of the restaurants Paid at the opening: those that churned, and the MRR
    -- they lost or gave up, never more than each one's opening MRR.
    cross join lateral (
      select
        count(*) filter (where x.churned) as churned,
        coalesce(sum(least(x.opening, x.lost)), 0) as paise
      from (
        select
          o.mrr_paise as opening,
          bool_or(m.movement = 'churn') as churned,
          coalesce(-sum(m.change) filter (where m.movement in ('churn', 'contraction')), 0) as lost
        from d as o
        join moves m
          on m.restaurant_id = o.restaurant_id and m.day between b.f and b.t and m.day > b.open_day
        where o.day = b.open_day and o.mrr_paise > 0
        group by o.restaurant_id, o.mrr_paise
      ) as x
    ) as lost
  ),
  buckets as (
    select private.revenue_bucket(g.day::date, p_from, p_by) as start, max(g.day::date) as finish
    from generate_series(p_from, p_to, interval '1 day') as g(day)
    group by 1
  ),
  series as (
    select jsonb_agg(jsonb_build_object(
      'start', b.start,
      'end', b.finish,
      'mrr_paise', te.mrr,
      'paid', te.paid,
      'movements', mv.movements,
      'subscription_base_paise', coalesce(pd.subscription, 0),
      'setup_fee_base_paise', coalesce(pd.setup_fee, 0),
      'gst_paise', coalesce(pd.gst, 0)
    ) order by b.start) as body
    from buckets b
    -- Bars after today have no MRR yet.
    left join lateral (
      select n.mrr, n.paid from nights n
      where n.day <= b.finish and b.start <= v_today
      order by n.day desc limit 1
    ) as te on true
    cross join lateral (
      select jsonb_object_agg(k.kind, jsonb_build_object('count', k.n, 'paise', k.paise)) as movements
      from (
        select kinds.kind, count(m.day) as n, coalesce(sum(m.change), 0) as paise
        from unnest(array['new', 'reactivation', 'expansion', 'contraction', 'churn']) as kinds(kind)
        left join moves m on m.movement = kinds.kind and m.day between b.start and b.finish
        group by kinds.kind
      ) as k
    ) as mv
    left join lateral (
      select sum(x.subscription) as subscription, sum(x.setup_fee) as setup_fee, sum(x.gst) as gst
      from paid_days x
      where x.day between b.start and b.finish
    ) as pd on true
  )
  select jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'by', p_by,
    'previous_from', case when p_compare then v_start end,
    'previous_to', case when p_compare then p_from - 1 end,
    'history_starts_on', v_hist,
    'totals', (select t.body from totals t where t.key = 'now'),
    'previous', (select t.body from totals t where t.key = 'previous'),
    'series', (select s.body from series s),
    'plan_mix', coalesce((
      select jsonb_agg(jsonb_build_object(
        'plan_code', x.code, 'plan_name', x.name, 'billing_cycle', x.cycle,
        'restaurants', x.n, 'mrr_paise', x.mrr) order by x.sort_order, x.cycle)
      from (
        select p.code, p.name, p.sort_order, coalesce(d.billing_cycle, 'monthly') as cycle,
          count(*) as n, sum(d.mrr_paise) as mrr
        from d
        join public.plans p on p.id = d.plan_id
        where d.state = 'paid' and d.day = (select b.end_day from bounds b where b.key = 'now')
        group by p.code, p.name, p.sort_order, coalesce(d.billing_cycle, 'monthly')
      ) as x
    ), '[]'::jsonb),
    'cohorts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'start', x.start, 'created', x.created, 'converted', x.converted,
        'deciding', x.deciding, 'average_days', x.average_days) order by x.start)
      from (
        select
          private.revenue_bucket(c.day, p_from, 'month') as start,
          count(*) as created,
          count(*) filter (where c.paid_at <= c.deadline) as converted,
          count(*) filter (where c.paid_at is null and now() < c.deadline) as deciding,
          round(avg(extract(epoch from c.paid_at - c.created_at) / 86400)
            filter (where c.paid_at <= c.deadline), 1) as average_days
        from cohort c
        where c.day >= p_from
        group by 1
      ) as x
    ), '[]'::jsonb),
    'reasons', coalesce((
      select jsonb_agg(jsonb_build_object('reason', x.reason, 'count', x.n)
        order by x.n desc, x.reason)
      from (
        select a.after ->> 'reason' as reason, count(*) as n
        from public.audit_logs a
        where a.action = 'subscription.cancel_reason'
          and a.created_at >= p_from::timestamp at time zone 'Asia/Kolkata'
          and a.created_at < (p_to + 1)::timestamp at time zone 'Asia/Kolkata'
        group by 1
      ) as x
    ), '[]'::jsonb),
    'launch_offer', (
      select jsonb_build_object(
        'setup_fees', count(*),
        'with_offer', count(*) filter (where p.list_price_paise is not null and p.discount_paise > 0),
        'discount_paise', coalesce(sum(p.discount_paise)
          filter (where p.list_price_paise is not null and p.discount_paise > 0), 0),
        'full_price', count(*) filter (
          where p.list_price_paise is not null and coalesce(p.discount_paise, 0) = 0),
        'not_recorded', count(*) filter (where p.list_price_paise is null))
      from public.subscription_payments p
      where p.purpose = 'setup_fee'
        and p.created_at >= p_from::timestamp at time zone 'Asia/Kolkata'
        and p.created_at < (p_to + 1)::timestamp at time zone 'Asia/Kolkata'
    ),
    'discounts', (
      select jsonb_build_object(
        'payments', count(*),
        'restaurants', count(distinct p.restaurant_id),
        'discount_paise', coalesce(sum(p.discount_paise), 0),
        'on_deal_now', (
          select count(*) from public.restaurant_subscriptions s
          join public.restaurants r on r.id = s.restaurant_id
          where s.deal_id is not null and s.status = 'active' and s.source is not null
            and r.status = 'active'
        ),
        'monthly_discount_now_paise', (
          select coalesce(sum(private.monthly_paise(pl, s.billing_cycle) - s.effective_monthly_paise), 0)
          from public.restaurant_subscriptions s
          join public.plans pl on pl.id = s.plan_id
          join public.restaurants r on r.id = s.restaurant_id
          where s.deal_id is not null and s.status = 'active' and s.source is not null
            and r.status = 'active'
        ))
      from public.subscription_payments p
      where p.purpose = 'subscription' and p.deal_id is not null and p.discount_paise > 0
        and p.created_at >= p_from::timestamp at time zone 'Asia/Kolkata'
        and p.created_at < (p_to + 1)::timestamp at time zone 'Asia/Kolkata'
    ),
    'expected', (
      select jsonb_build_object(
        'autopay_paise', coalesce(sum(x.due_paise) filter (where x.renewal_kind = 'autopay'), 0),
        'autopay_count', count(*) filter (where x.renewal_kind = 'autopay'),
        'needs_payment_paise', coalesce(sum(x.due_paise)
          filter (where x.renewal_kind = 'needs_payment'), 0),
        'needs_payment_count', count(*) filter (where x.renewal_kind = 'needs_payment'))
      from private.dues_rows() as x
      where x.bucket = 'renewal_due'
    )
  )
  into v_result;

  return v_result;
end;
$function$;

create or replace function public.platform_list_standees(p_status text default 'open', p_page int default 1)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.view');
  v_money boolean := private.has_platform_permission('money.view');
  v_status text := coalesce(p_status, 'open');
  v_page int := greatest(coalesce(p_page, 1), 1);
  v_size constant int := 50;
begin
  if v_status not in ('open', 'not_started', 'to_print', 'printed', 'dispatched', 'delivered',
    'installed') then
    perform private.fail('INVALID_INPUT', 'status');
  end if;
  return (
    with fee as (
      select p.restaurant_id, min(p.created_at) as paid_at
      from public.subscription_payments p
      where p.purpose = 'setup_fee'
      group by p.restaurant_id
    ),
    tracked as (
      select
        r.id, r.name, r.slug, r.city,
        coalesce(s.status, 'not_started') as status,
        coalesce(s.quantity, (
          select count(*) from public.dining_tables t where t.restaurant_id = r.id and t.is_active
        )::int) as quantity,
        s.printed_on, s.dispatched_on, s.delivered_on, s.installed_on, s.vendor, s.cost_paise,
        fee.paid_at as setup_fee_paid_at,
        -- When it reached its status: a step's day, or the fee paid.
        coalesce(
          s.installed_on::timestamp at time zone 'Asia/Kolkata',
          s.delivered_on::timestamp at time zone 'Asia/Kolkata',
          s.dispatched_on::timestamp at time zone 'Asia/Kolkata',
          s.printed_on::timestamp at time zone 'Asia/Kolkata',
          s.created_at,
          fee.paid_at
        ) as since
      from public.restaurants r
      left join public.standees s on s.restaurant_id = r.id
      left join fee on fee.restaurant_id = r.id
      where r.status <> 'closed'
        and (s.restaurant_id is not null or (fee.restaurant_id is not null and r.status = 'active'))
    ),
    picked as (
      select * from tracked x
      where case v_status
        when 'open' then x.status <> 'installed'
        else x.status = v_status
      end
    )
    select jsonb_build_object(
      'page', v_page,
      'page_size', v_size,
      'total', (select count(*) from picked),
      'counts', (
        select jsonb_build_object(
          'open', count(*) filter (where x.status <> 'installed'),
          'not_started', count(*) filter (where x.status = 'not_started'),
          'to_print', count(*) filter (where x.status = 'to_print'),
          'printed', count(*) filter (where x.status = 'printed'),
          'dispatched', count(*) filter (where x.status = 'dispatched'),
          'delivered', count(*) filter (where x.status = 'delivered'),
          'installed', count(*) filter (where x.status = 'installed')
        )
        from tracked x
      ),
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
          'restaurant_id', x.id,
          'name', x.name,
          'slug', x.slug,
          'city', x.city,
          'status', x.status,
          'quantity', x.quantity,
          'printed_on', x.printed_on,
          'dispatched_on', x.dispatched_on,
          'delivered_on', x.delivered_on,
          'installed_on', x.installed_on,
          'vendor', x.vendor,
          'cost_paise', case when v_money then x.cost_paise end,
          'setup_fee_paid_at', x.setup_fee_paid_at,
          'since', x.since
        ) order by x.since, x.name, x.id)
        from (
          select * from picked order by since, name, id
          offset (v_page - 1) * v_size limit v_size
        ) as x
      ), '[]'::jsonb)
    )
  );
end;
$$;


-- Late saves under another id can't hide the owner's new subscription (SA-94).
-- The team never starts one, so a save of theirs is an old one's (a sync or a
-- cancel that crossed the owner subscribing): refused. One that has ended never
-- takes over either. A new one is checked against the restaurant again under
-- the subscription's lock, which a close holds.

create or replace function public.razorpay_save_subscription(p_restaurant_id uuid, p_entity jsonb, p_actor_user_id uuid DEFAULT NULL::uuid, p_cancel_scheduled boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_deal public.subscription_deals;
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
    if v_actor_type = 'platform_admin' then
      perform private.fail('RAZORPAY_SUBSCRIPTION_CHANGED');
    end if;
    if private.json_text(p_entity, 'status') in ('cancelled', 'completed', 'expired') then
      return jsonb_build_object(
        'result', 'not_current',
        'status', v_sub.status,
        'razorpay_status', v_sub.razorpay_status,
        'cancel_at_period_end', v_sub.cancel_at_period_end,
        'current_period_end', v_sub.current_period_end
      );
    end if;
  end if;

  if v_sub.razorpay_subscription_id is distinct from v_id then
    -- A new Razorpay subscription for this restaurant.
    select * into v_restaurant from public.restaurants r where r.id = p_restaurant_id;
    if v_restaurant.status = 'closed' then
      perform private.fail('RESTAURANT_CLOSED');
    end if;
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
    if v_notes ? 'deal_id' then
      if coalesce(v_notes ->> 'deal_id', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        perform private.fail('INVALID_INPUT', 'notes.deal_id');
      end if;
      select * into v_deal from public.subscription_deals d
      where d.id = (v_notes ->> 'deal_id')::uuid
      for update;
      if v_deal.id is null or v_deal.restaurant_id <> p_restaurant_id
         or v_deal.ended_at is not null
         or v_deal.plan_id <> v_plan.id or v_deal.billing_cycle::text <> v_cycle
         or v_deal.razorpay_plan_id is distinct from private.json_text(p_entity, 'plan_id')
      then
        perform private.fail('INVALID_INPUT', 'notes.deal_id');
      end if;
    end if;

    update public.restaurant_subscriptions s
      set razorpay_subscription_id = v_id,
          razorpay_status = null,
          razorpay_event_at = null,
          next_plan_id = v_plan.id,
          next_billing_cycle = v_cycle::public.billing_cycle,
          next_deal_id = v_deal.id
      where s.id = v_sub.id;
    perform private.write_audit(
      p_restaurant_id, v_actor_type, p_actor_user_id, v_actor_role, v_actor_label,
      'subscription.autopay_started', 'restaurant_subscription', v_sub.id,
      jsonb_build_object('razorpay_subscription_id', v_sub.razorpay_subscription_id),
      jsonb_build_object(
        'razorpay_subscription_id', v_id, 'plan_code', v_plan.code, 'billing_cycle', v_cycle
      ) || case when v_deal.id is null then '{}'::jsonb else jsonb_build_object(
        'deal_id', v_deal.id, 'price_paise', v_deal.price_paise, 'cycles', v_deal.cycles
      ) end
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

  v_result := private.apply_razorpay_subscription(p_restaurant_id, p_entity, null, null);

  select * into v_sub from public.restaurant_subscriptions s where s.id = v_sub.id;
  return jsonb_build_object(
    'result', v_result,
    'status', v_sub.status,
    'razorpay_status', v_sub.razorpay_status,
    'cancel_at_period_end', v_sub.cancel_at_period_end,
    'current_period_end', v_sub.current_period_end
  );
end;
$function$;


-- A code sent before its login was closed or turned off can't set a password
-- any more: that login only ever hears "wrong email or password" (SA-95).

create or replace function public.auth_password_reset_verify(p_id uuid, p_code_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_reset public.password_resets;
  v_email_tries integer;
  v_email text;
begin
  -- One email's codes are checked one at a time, so tries can't race past the day's limit.
  -- The email's lock comes before the row's, in the same order as starting a request.
  select r.email into v_email from public.password_resets r where r.id = p_id;
  if not found then
    return jsonb_build_object('status', 'gone');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('password_reset:email:' || v_email, 0));
  select * into v_reset from public.password_resets r where r.id = p_id for update;
  if not found or v_reset.used_at is not null then
    return jsonb_build_object('status', 'gone');
  end if;
  select coalesce(sum(r.tries), 0) into v_email_tries
  from public.password_resets r
  where r.email = v_reset.email and r.created_at > now() - interval '1 day';
  if v_reset.tries >= 5 or v_email_tries >= 10 then
    return jsonb_build_object('status', 'locked');
  end if;
  if v_reset.expires_at <= now() then
    return jsonb_build_object('status', 'expired');
  end if;

  if v_reset.user_id is null or v_reset.code_hash is distinct from p_code_hash then
    update public.password_resets r set tries = r.tries + 1 where r.id = p_id;
    if v_reset.tries + 1 >= 5 or v_email_tries + 1 >= 10 then
      return jsonb_build_object('status', 'locked');
    end if;
    return jsonb_build_object(
      'status', 'wrong', 'tries_left', least(4 - v_reset.tries, 9 - v_email_tries)
    );
  end if;

  select u.email into v_email
  from auth.users u
  where u.id = v_reset.user_id and (u.banned_until is null or u.banned_until <= now());
  if not found then
    return jsonb_build_object('status', 'gone');
  end if;
  return jsonb_build_object('status', 'ok', 'user_id', v_reset.user_id, 'email', v_email);
end;
$$;

-- ─── Closing and reopening (restaurants.close) ──────────────────────────────
-- Logins that lead only to this restaurant: a person who also has another
-- restaurant or a team seat keeps their login, and loses only this membership.
create function private.users_only_in(p_restaurant_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct m.user_id
  from public.restaurant_members m
  where m.restaurant_id = p_restaurant_id
    and not exists (
      select 1 from public.restaurant_members other
      where other.user_id = m.user_id and other.restaurant_id <> p_restaurant_id
    )
    and not exists (select 1 from public.platform_admins a where a.user_id = m.user_id);
$$;

-- Confirmed by typing the restaurant's code. Turning the members off refuses
-- them at once, in every function and policy (their tokens last up to an
-- hour); the ban stops new tokens and deleting the sessions ends refresh
-- tokens, as for a team member (SA-74). Nothing here touches Razorpay: the
-- action has cancelled autopay first, and refuses here what can still charge (SA-94).
create function public.platform_close_restaurant(p_restaurant_id uuid, p_code text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.close');
  v_reason text := private.tidy_text(p_reason);
  v_restaurant public.restaurants;
  v_sub public.restaurant_subscriptions;
  v_members uuid[];
  v_recipients text[];
  -- To the end of the 30th day in India: the owner is told that date, and the
  -- nightly job runs the morning after it (SA-97).
  v_due timestamptz := (
    date_trunc('day', (now() + interval '30 days') at time zone 'Asia/Kolkata')
      + interval '1 day' - interval '1 second'
  ) at time zone 'Asia/Kolkata';
begin
  if v_reason is null then
    perform private.fail('REASON_REQUIRED');
  end if;
  if length(v_reason) > 300 then
    perform private.fail('INVALID_INPUT', 'reason');
  end if;

  -- Not `for update`: a save or webhook holding the subscription row takes key
  -- share locks here for its inserts, and would wait on this while this waits
  -- on it (P4-10).
  select * into v_restaurant from public.restaurants r
  where r.id = p_restaurant_id
  for no key update;
  if not found then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;
  if v_restaurant.status = 'closed' then
    perform private.fail('RESTAURANT_CLOSED');
  end if;
  if lower(btrim(coalesce(p_code, ''))) <> v_restaurant.slug then
    perform private.fail('CLOSE_CODE_MISMATCH');
  end if;
  -- Autopay set up after the action cancelled what it saw (the owner
  -- subscribing meanwhile) is refused under the subscription's lock, and the
  -- retry cancels it too. The same test as mandateCanCharge (SA-94).
  select * into v_sub from public.restaurant_subscriptions s
  where s.restaurant_id = p_restaurant_id
  for update;
  if v_sub.razorpay_subscription_id is not null and (
    v_sub.razorpay_status in ('created', 'pending', 'halted')
    or (v_sub.razorpay_status in ('authenticated', 'active') and not v_sub.cancel_at_period_end)
  ) then
    perform private.fail('AUTOPAY_CAN_CHARGE');
  end if;

  -- Who to tell, while the owners still count: as for reminders.
  select array_agg(distinct lower(e.email) order by lower(e.email))
    into v_recipients
    from (
      select u.email
      from public.restaurant_members m
      join auth.users u on u.id = m.user_id
      where m.restaurant_id = p_restaurant_id and m.role = 'owner' and m.is_active
        and split_part(u.email, '@', 2) not like v_restaurant.slug || '.staff.%'
      union all
      select v_restaurant.email
    ) as e
    where nullif(btrim(e.email), '') is not null;

  with switched_off as (
    update public.restaurant_members m
      set is_active = false
      where m.restaurant_id = p_restaurant_id and m.is_active
      returning m.id
  )
  select coalesce(array_agg(s.id), '{}') into v_members from switched_off s;

  update auth.users u
    set banned_until = now() + interval '100 years'
    where u.id in (select private.users_only_in(p_restaurant_id));
  delete from auth.sessions s where s.user_id in (select private.users_only_in(p_restaurant_id));

  update public.support_sessions s
    set ended_at = now()
    where s.restaurant_id = p_restaurant_id and s.ended_at is null;

  insert into public.restaurant_closures (
    restaurant_id, closed_by, removal_due_at, prior_status, prior_reason, member_ids
  ) values (
    p_restaurant_id, v_admin.user_id, v_due, v_restaurant.status, v_restaurant.suspended_reason,
    v_members
  );
  update public.restaurants r
    set status = 'closed', suspended_reason = v_reason
    where r.id = p_restaurant_id;

  perform private.audit_platform(
    v_admin, p_restaurant_id, 'restaurant.closed', 'restaurant', p_restaurant_id,
    jsonb_build_object('status', v_restaurant.status, 'suspended_reason', v_restaurant.suspended_reason),
    jsonb_build_object(
      'status', 'closed', 'removal_due_at', v_due, 'logins_off', cardinality(v_members)
    ),
    v_reason
  );

  return jsonb_build_object(
    'name', v_restaurant.name,
    'timezone', v_restaurant.timezone,
    'removal_due_at', v_due,
    'recipients', coalesce(to_jsonb(v_recipients), '[]'::jsonb)
  );
end;
$$;

-- Back as it was, until the personal data has gone. Autopay stays off: Razorpay
-- can't undo a cancel, so the owner sets it up again.
create function public.platform_reopen_restaurant(p_restaurant_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.close');
  v_closure public.restaurant_closures;
begin
  perform 1 from public.restaurants r where r.id = p_restaurant_id for update;
  if not found then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;
  select * into v_closure from public.restaurant_closures c where c.restaurant_id = p_restaurant_id;
  if not found then
    perform private.fail('RESTAURANT_NOT_CLOSED');
  end if;
  if v_closure.removed_at is not null then
    perform private.fail('PERSONAL_DATA_REMOVED');
  end if;

  update public.restaurant_members m set is_active = true where m.id = any (v_closure.member_ids);
  update auth.users u
    set banned_until = null
    where u.id in (select private.users_only_in(p_restaurant_id));
  update public.restaurants r
    set status = v_closure.prior_status, suspended_reason = v_closure.prior_reason
    where r.id = p_restaurant_id;
  delete from public.restaurant_closures c where c.restaurant_id = p_restaurant_id;

  perform private.audit_platform(
    v_admin, p_restaurant_id, 'restaurant.reopened', 'restaurant', p_restaurant_id,
    jsonb_build_object('status', 'closed', 'closed_at', v_closure.closed_at),
    jsonb_build_object('status', v_closure.prior_status)
  );
end;
$$;

-- What a restaurant's page says about its closing, or null.
create function public.platform_closure(p_restaurant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_permission('restaurants.view');
  return (
    select jsonb_build_object(
      'closed_at', c.closed_at,
      'closed_by', u.email,
      'reason', case when c.removed_at is null then r.suspended_reason end,
      'removal_due_at', c.removal_due_at,
      'removed_at', c.removed_at
    )
    from public.restaurant_closures c
    join public.restaurants r on r.id = c.restaurant_id
    left join auth.users u on u.id = c.closed_by
    where c.restaurant_id = p_restaurant_id
  );
end;
$$;

-- ─── Removing personal data (the daily cron) ────────────────────────────────
create function public.closed_restaurants_due(p_limit int default 50)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.restaurant_id
  from public.restaurant_closures c
  where c.removed_at is null and c.removal_due_at <= now()
  order by c.removal_due_at
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
$$;

-- One restaurant, in one transaction (SA-97). Stays: the restaurant's name,
-- code, legal name, GSTIN, licence and address, its menu and tables, orders,
-- bills byte for byte, payments and subscription. Goes: logins and member rows,
-- waiters' details, its phone, email and UPI, the storefront photo and support
-- screenshots (the daily sweeps delete a file once nothing points at it),
-- support requests, team notes, the linked lead's contact details, the trial's
-- phone claim, the reasons typed for closing and suspending, data exports, and
-- the copies of all these in the audit log and Razorpay events.
create function public.closed_restaurant_remove_personal_data(p_restaurant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_closure public.restaurant_closures;
  v_users uuid[];
  v_waiters int;
  -- What audit rows may hold (settings changes, staff, waiters, notes, the
  -- reason a subscription was cancelled). Kept: legal name, GSTIN, address.
  v_keys text[] := array[
    'display_name', 'username', 'full_name', 'waiter_name', 'phone', 'email', 'employee_code',
    'joined_on', 'notes', 'body', 'detail', 'upi_vpa', 'upi_payee_name', 'bill_footer_text',
    'member_id', 'suspended_reason'
  ];
begin
  -- As in the close: a late webhook's inserts don't wait on this (P4-10).
  perform 1 from public.restaurants r where r.id = p_restaurant_id for no key update;
  select * into v_closure from public.restaurant_closures c where c.restaurant_id = p_restaurant_id;
  if not found then
    perform private.fail('RESTAURANT_NOT_CLOSED');
  end if;
  if v_closure.removed_at is not null then
    return jsonb_build_object('removed', false);
  end if;
  if v_closure.removal_due_at > now() then
    perform private.fail('HOLD_NOT_OVER');
  end if;

  v_users := array(select private.users_only_in(p_restaurant_id));

  -- Waiters stay for old sessions and bills that point at them (no delete: the
  -- foreign keys hold), under a number.
  update public.waiters w
    set full_name = 'Waiter ' || n.position, phone = null, employee_code = null,
      joined_on = null, notes = null, member_id = null, on_duty = false, is_active = false
    from (
      select x.id, row_number() over (order by x.created_at, x.id) as position
      from public.waiters x where x.restaurant_id = p_restaurant_id
    ) as n
    where w.id = n.id;
  get diagnostics v_waiters = row_count;

  update public.audit_logs a
    set actor_label = 'Removed user'
    where a.restaurant_id = p_restaurant_id and a.actor_type = 'staff';
  update public.audit_logs a
    set before = a.before - v_keys, after = a.after - v_keys
    where a.restaurant_id = p_restaurant_id
      and a.action <> 'restaurant.account_manager_changed'
      and (a.before ?| v_keys or a.after ?| v_keys);
  update public.audit_logs a
    set reason = null
    where a.restaurant_id = p_restaurant_id
      and a.action in ('restaurant.closed', 'restaurant.suspended', 'restaurant.unsuspended');

  delete from public.support_requests q where q.restaurant_id = p_restaurant_id;
  delete from public.support_screenshot_uploads u where u.restaurant_id = p_restaurant_id;
  delete from public.restaurant_notes n where n.restaurant_id = p_restaurant_id;

  -- A lead stays in the funnel's counts without its person (SA-97).
  delete from public.lead_events e
    using public.site_leads l
    where e.lead_id = l.id and l.restaurant_id = p_restaurant_id and e.kind = 'note';
  update public.site_leads l
    set name = 'Removed', phone = '0000000000', email = null, message = null, ip_hash = null
    where l.restaurant_id = p_restaurant_id;

  -- GSTIN and licence claims still stop a second free trial.
  delete from public.trial_claims c where c.restaurant_id = p_restaurant_id and c.kind = 'phone';

  update public.restaurant_subscriptions s
    set cancel_reason_detail = null
    where s.restaurant_id = p_restaurant_id;
  update public.standees s set notes = null where s.restaurant_id = p_restaurant_id;

  -- A closed restaurant must have a reason (restaurants_suspended_reason_required).
  update public.restaurants r
    set phone = null, email = null, upi_vpa = null, upi_payee_name = null,
      show_upi_qr_on_bill = false, bill_footer_text = null, storefront_photo_path = null,
      suspended_reason = 'Account closed'
    where r.id = p_restaurant_id;

  update public.webhook_events e
    set payload = private.webhook_without_payer(e.payload)
    where p_restaurant_id::text = any (private.webhook_restaurant_ids(e.payload));

  -- A copy made before now stops working: no more links, and the cleanup step
  -- right after this one deletes its file (restaurant_exports_to_remove).
  delete from public.restaurant_exports e where e.restaurant_id = p_restaurant_id;

  delete from public.restaurant_members m where m.restaurant_id = p_restaurant_id;
  -- Their own actions, and what the service role did to them (traits).
  delete from auth.audit_log_entries e
    where e.payload ->> 'actor_id' = any (select u::text from unnest(v_users) as u)
      or e.payload -> 'traits' ->> 'user_id' = any (select u::text from unnest(v_users) as u);
  delete from auth.users u where u.id = any (v_users);

  update public.restaurant_closures c
    set removed_at = now(), member_ids = '{}', prior_reason = null
    where c.restaurant_id = p_restaurant_id;
  perform private.write_audit(
    p_restaurant_id, 'system', null, null, 'Nightly job',
    'restaurant.personal_data_removed', 'restaurant', p_restaurant_id, null,
    jsonb_build_object('logins', cardinality(v_users), 'waiters', v_waiters)
  );

  return jsonb_build_object('removed', true);
end;
$$;

-- ─── The data export ────────────────────────────────────────────────────────
-- A build dies quietly if its server does (nothing retries it): the page's
-- limit is 5 minutes, so one still building after 15 has failed.
create function private.start_export(p_restaurant_id uuid, p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('restaurant_export:' || p_restaurant_id, 0));
  update public.restaurant_exports e
    set status = 'failed', finished_at = now()
    where e.restaurant_id = p_restaurant_id and e.status = 'building'
      and e.created_at < now() - interval '15 minutes';
  if exists (
    select 1 from public.restaurant_exports e
    where e.restaurant_id = p_restaurant_id and e.status <> 'failed'
      and e.created_at > now() - interval '1 hour'
  ) then
    perform private.fail('EXPORT_TOO_SOON');
  end if;
  insert into public.restaurant_exports (restaurant_id, requested_by)
    values (p_restaurant_id, p_user_id)
    returning id into v_id;
  return v_id;
end;
$$;

-- The latest export of a restaurant, or null. Only the server sees the path.
create function private.latest_export(p_restaurant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'status', case
      when e.status = 'building' and e.created_at < now() - interval '15 minutes' then 'failed'
      else e.status
    end,
    'path', e.restaurant_id || '/' || e.id || '.zip',
    'size_bytes', e.size_bytes,
    'created_at', e.created_at,
    'expires_at', e.expires_at
  )
  from public.restaurant_exports e
  where e.restaurant_id = p_restaurant_id
  order by e.created_at desc
  limit 1;
$$;

-- The owner, in Settings. A support session acts as a manager, so never here.
create function public.admin_request_data_export()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner}');
  v_id uuid := private.start_export(v_ctx.restaurant_id, v_ctx.user_id);
begin
  perform private.audit_as(
    v_ctx, 'restaurant.data_exported', 'restaurant', v_ctx.restaurant_id, null,
    jsonb_build_object('export_id', v_id)
  );
  return v_id;
end;
$$;

create function public.admin_data_export()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner}');
begin
  return private.latest_export(v_ctx.restaurant_id);
end;
$$;

create function public.platform_request_data_export(p_restaurant_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.close');
  v_id uuid;
begin
  if not exists (select 1 from public.restaurants r where r.id = p_restaurant_id) then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;
  v_id := private.start_export(p_restaurant_id, v_admin.user_id);
  perform private.audit_platform(
    v_admin, p_restaurant_id, 'restaurant.data_exported', 'restaurant', p_restaurant_id, null,
    jsonb_build_object('export_id', v_id)
  );
  return v_id;
end;
$$;

create function public.platform_data_export(p_restaurant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_permission('restaurants.close');
  return private.latest_export(p_restaurant_id);
end;
$$;

-- The server's report on its build: a size when it worked, null when it didn't.
create function public.restaurant_export_finish(p_export_id uuid, p_size_bytes bigint default null)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.restaurant_exports e
    set status = case when p_size_bytes is null then 'failed' else 'ready' end,
      size_bytes = p_size_bytes,
      finished_at = now(),
      expires_at = case when p_size_bytes is null then null else now() + interval '24 hours' end
    where e.id = p_export_id and e.status = 'building';
$$;

-- For the daily cron: files past their link's 24 hours (a build takes minutes)
-- or made before their restaurant's personal data was removed, and rows old
-- enough that no page needs them.
create function public.restaurant_exports_to_remove(p_limit int default 200)
returns setof text
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.restaurant_exports e where e.created_at < now() - interval '2 days';
  return query
    select o.name
    from storage.objects o
    where o.bucket_id = 'restaurant-exports'
      and (
        o.created_at < now() - interval '25 hours'
        or o.created_at < (
          select c.removed_at from public.restaurant_closures c
          where c.restaurant_id::text = split_part(o.name, '/', 1)
        )
      )
    order by o.created_at
    limit least(greatest(coalesce(p_limit, 200), 1), 1000);
end;
$$;

-- ─── Grants ─────────────────────────────────────────────────────────────────
revoke execute on function private.users_only_in(uuid) from public, anon, authenticated;
revoke execute on function private.start_export(uuid, uuid) from public, anon, authenticated;
revoke execute on function private.latest_export(uuid) from public, anon, authenticated;

revoke execute on function public.platform_close_restaurant(uuid, text, text) from public, anon;
revoke execute on function public.platform_reopen_restaurant(uuid) from public, anon;
revoke execute on function public.platform_closure(uuid) from public, anon;
revoke execute on function public.admin_request_data_export() from public, anon;
revoke execute on function public.admin_data_export() from public, anon;
revoke execute on function public.platform_request_data_export(uuid) from public, anon;
revoke execute on function public.platform_data_export(uuid) from public, anon;
grant execute on function public.platform_close_restaurant(uuid, text, text) to authenticated;
grant execute on function public.platform_reopen_restaurant(uuid) to authenticated;
grant execute on function public.platform_closure(uuid) to authenticated;
grant execute on function public.admin_request_data_export() to authenticated;
grant execute on function public.admin_data_export() to authenticated;
grant execute on function public.platform_request_data_export(uuid) to authenticated;
grant execute on function public.platform_data_export(uuid) to authenticated;

revoke execute on function public.closed_restaurants_due(int) from public, anon, authenticated;
revoke execute on function public.closed_restaurant_remove_personal_data(uuid)
  from public, anon, authenticated;
revoke execute on function public.restaurant_export_finish(uuid, bigint)
  from public, anon, authenticated;
revoke execute on function public.restaurant_exports_to_remove(int)
  from public, anon, authenticated;
grant execute on function public.closed_restaurants_due(int) to service_role;
grant execute on function public.closed_restaurant_remove_personal_data(uuid) to service_role;
grant execute on function public.restaurant_export_finish(uuid, bigint) to service_role;
grant execute on function public.restaurant_exports_to_remove(int) to service_role;
