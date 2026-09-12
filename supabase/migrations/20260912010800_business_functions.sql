-- Business-day helpers, restaurant access state (spec §10.6), staff login lookup,
-- the audit writer and restaurant onboarding.
--
-- Error convention (spec §9.3): raise exception using errcode = 'P0001',
-- message = '<CODE>'; the UI maps codes to human messages.

-- ─── Business day ───────────────────────────────────────────────────────────
-- Start of the business day containing p_at, in the restaurant's timezone.
-- With a 04:00 start, 01:30 belongs to the previous day.
create or replace function private.business_day_start(p_at timestamptz, p_tz text, p_start_hour int)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select case
    when (p_at at time zone p_tz)::time >= make_time(p_start_hour, 0, 0)
      then ((p_at at time zone p_tz)::date + make_time(p_start_hour, 0, 0)) at time zone p_tz
    else (((p_at at time zone p_tz)::date - 1) + make_time(p_start_hour, 0, 0)) at time zone p_tz
  end;
$$;

-- First business-day start at or after p_at.
create or replace function private.next_business_day_start(
  p_at timestamptz,
  p_tz text,
  p_start_hour int
)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select case
    when ((l.local_date + make_time(p_start_hour, 0, 0)) at time zone p_tz) >= p_at
      then (l.local_date + make_time(p_start_hour, 0, 0)) at time zone p_tz
    else ((l.local_date + 1) + make_time(p_start_hour, 0, 0)) at time zone p_tz
  end
  from (select (p_at at time zone p_tz)::date as local_date) as l;
$$;

revoke execute on function private.business_day_start(timestamptz, text, int)
  from public, anon, authenticated;
revoke execute on function private.next_business_day_start(timestamptz, text, int)
  from public, anon, authenticated;

-- ─── Audit ──────────────────────────────────────────────────────────────────
create or replace function private.write_audit(
  p_restaurant_id uuid,
  p_actor_type public.actor_type,
  p_actor_user_id uuid,
  p_actor_role public.member_role,
  p_actor_label text,
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_before jsonb default null,
  p_after jsonb default null,
  p_reason text default null
)
returns uuid
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.audit_logs (
    restaurant_id, actor_type, actor_user_id, actor_role, actor_label,
    action, entity_type, entity_id, before, after, reason
  )
  values (
    p_restaurant_id, p_actor_type, p_actor_user_id, p_actor_role, p_actor_label,
    p_action, p_entity_type, p_entity_id, p_before, p_after, p_reason
  )
  returning id;
$$;

revoke execute on function private.write_audit(
  uuid, public.actor_type, uuid, public.member_role, text, text, text, uuid, jsonb, jsonb, text
) from public, anon, authenticated;

-- ─── Restaurant access state (spec §10.6) ───────────────────────────────────
-- state: 'full' | 'read_only'
-- reason (read_only): suspended | no_subscription | trial_ended |
--                     subscription_lapsed | payment_failed | subscription_ended
-- warning (full): trial_ends_soon | subscription_ends_soon | payment_failed
-- p_at exists so tests can evaluate the rules at fixed instants.
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

  -- 1. When does access lapse?
  case v_sub.status
    when 'trialing' then
      v_lapse := v_sub.trial_ends_at;
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

revoke execute on function public.restaurant_access(uuid, timestamptz) from public, anon;
grant execute on function public.restaurant_access(uuid, timestamptz) to authenticated, service_role;

-- ─── Staff login lookup ─────────────────────────────────────────────────────
-- Staff sign in with restaurant code (slug) + username. The server resolves the
-- stored auth email here, then signs in with it, so the synthetic email domain
-- can change without breaking existing accounts. Active members only.
create or replace function public.auth_staff_login_email(p_slug text, p_username text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select u.email::text
  from public.restaurants r
  join public.restaurant_members m on m.restaurant_id = r.id
  join auth.users u on u.id = m.user_id
  where r.slug = lower(btrim(p_slug))
    and m.username = lower(btrim(p_username))
    and m.is_active
  limit 1;
$$;

revoke execute on function public.auth_staff_login_email(text, text) from public, anon, authenticated;
grant execute on function public.auth_staff_login_email(text, text) to service_role;

-- ─── Onboarding ─────────────────────────────────────────────────────────────
-- Creates a restaurant, its owner membership and a trial subscription in one
-- transaction. The owner's auth user is created first by the server (Admin API).
--
-- p_payload:
--   name, slug (required); legal_name, address_line, city, state, pincode,
--   phone, email, timezone, gst_mode, gst_rate_bps, prices_include_tax (optional)
--   owner: { user_id, display_name, username } (required)
--   plan_code (default 'growth'), trial_days (default platform_settings.trial_days)
--   actor_user_id: platform admin performing the action (null = system/script)
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
  v_trial_days int;
  v_plan_id uuid;
  v_restaurant public.restaurants%rowtype;
  v_member_id uuid;
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

  select id into v_plan_id from public.plans where code = v_plan_code and is_active;
  if v_plan_id is null then
    raise exception using errcode = 'P0001', message = 'PLAN_NOT_FOUND';
  end if;

  select coalesce((p_payload ->> 'trial_days')::int, ps.trial_days)
    into v_trial_days
    from public.platform_settings ps where ps.id = 1;

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
      'owner_member_id', v_member_id
    )
  );

  return jsonb_build_object('restaurant_id', v_restaurant.id, 'owner_member_id', v_member_id);
end;
$$;

revoke execute on function public.platform_create_restaurant(jsonb) from public, anon, authenticated;
grant execute on function public.platform_create_restaurant(jsonb) to service_role;
