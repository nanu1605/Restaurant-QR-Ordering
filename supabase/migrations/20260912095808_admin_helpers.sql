-- Phase 2 helpers: caller context, access and plan checks, default categories
-- at onboarding, and moving menu/table writes behind admin_* functions.
--
-- Business functions never take a restaurant id from the client: they read the
-- caller's membership (MVP: one restaurant per account, spec §3) and treat ids
-- that belong to another restaurant as NOT_FOUND.

-- ─── Caller context ─────────────────────────────────────────────────────────
create type private.member_context as (
  user_id uuid,
  member_id uuid,
  restaurant_id uuid,
  role public.member_role,
  display_name text
);

-- Active membership of p_user_id, optionally restricted to p_roles.
-- Raises FORBIDDEN when there is none (or the role doesn't match).
create or replace function private.member_context_for(
  p_user_id uuid,
  p_roles public.member_role[] default null
)
returns private.member_context
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context;
begin
  select m.user_id, m.id, m.restaurant_id, m.role, m.display_name
    into v_ctx
    from public.restaurant_members m
    where m.user_id = p_user_id and m.is_active
    order by m.created_at
    limit 1;

  if v_ctx.member_id is null or (p_roles is not null and not v_ctx.role = any (p_roles)) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  return v_ctx;
end;
$$;

-- The signed-in user's membership.
create or replace function private.current_member(p_roles public.member_role[] default null)
returns private.member_context
language sql
stable
security definer
set search_path = ''
as $$
  select private.member_context_for((select auth.uid()), p_roles);
$$;

-- Setup changes need full access (spec §10.6, docs/DECISIONS.md P2-1).
create or replace function private.assert_full_access(p_restaurant_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select a.state from public.restaurant_access(p_restaurant_id) as a) is distinct from 'full' then
    raise exception using errcode = 'P0001', message = 'RESTAURANT_READ_ONLY';
  end if;
end;
$$;

-- Trimmed, single-spaced text (names, labels).
create or replace function private.tidy_text(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(regexp_replace(btrim(p_text), '\s+', ' ', 'g'), '');
$$;

-- Comparison key for names: matches the menu_categories_name_key index.
create or replace function private.normalize_name(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(regexp_replace(btrim(p_name), '\s+', ' ', 'g'));
$$;

revoke execute on function private.member_context_for(uuid, public.member_role[])
  from public, anon, authenticated;
revoke execute on function private.current_member(public.member_role[])
  from public, anon, authenticated;
revoke execute on function private.assert_full_access(uuid) from public, anon, authenticated;
revoke execute on function private.tidy_text(text) from public, anon, authenticated;
revoke execute on function private.normalize_name(text) from public, anon, authenticated;

-- ─── Plan limits and features (spec §14.2) ──────────────────────────────────
-- The restaurant's plan (the trialled plan during a trial). No row when the
-- restaurant has no subscription. Callable by members, platform admins and the
-- server; managers can't read subscriptions directly through RLS.
create or replace function public.restaurant_plan(p_restaurant_id uuid)
returns table (plan_code text, plan_name text, max_tables int, max_staff int, features jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null
     and not public.is_platform_admin()
     and public.member_role(p_restaurant_id) is null then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;

  return query
    select p.code, p.name, p.max_tables, p.max_staff, p.features
    from public.restaurant_subscriptions s
    join public.plans p on p.id = s.plan_id
    where s.restaurant_id = p_restaurant_id;
end;
$$;

revoke execute on function public.restaurant_plan(uuid) from public, anon;
grant execute on function public.restaurant_plan(uuid) to authenticated, service_role;

create or replace function private.has_feature(p_restaurant_id uuid, p_feature text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      select (p.features ->> p_feature)::boolean
      from public.restaurant_subscriptions s
      join public.plans p on p.id = s.plan_id
      where s.restaurant_id = p_restaurant_id
    ),
    false
  );
$$;

-- Plan limits (null = unlimited). Raises PLAN_NOT_FOUND without a subscription.
create or replace function private.plan_limits(
  p_restaurant_id uuid,
  out max_tables int,
  out max_staff int
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  select p.max_tables, p.max_staff
    into max_tables, max_staff
    from public.restaurant_subscriptions s
    join public.plans p on p.id = s.plan_id
    where s.restaurant_id = p_restaurant_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'PLAN_NOT_FOUND';
  end if;
end;
$$;

revoke execute on function private.has_feature(uuid, text) from public, anon, authenticated;
revoke execute on function private.plan_limits(uuid) from public, anon, authenticated;

-- ─── Menu and tables: functions only (docs/DECISIONS.md P2-3) ───────────────
drop policy "managers insert menu categories" on public.menu_categories;
drop policy "managers update menu categories" on public.menu_categories;
drop policy "managers delete menu categories" on public.menu_categories;
drop policy "managers insert menu items" on public.menu_items;
drop policy "managers update menu items" on public.menu_items;
drop policy "managers delete menu items" on public.menu_items;
drop policy "managers insert menu item variants" on public.menu_item_variants;
drop policy "managers update menu item variants" on public.menu_item_variants;
drop policy "managers delete menu item variants" on public.menu_item_variants;
drop policy "managers update dining tables" on public.dining_tables;

revoke insert, update, delete on
  public.menu_categories,
  public.menu_items,
  public.menu_item_variants
from authenticated;
revoke update (label, sort_order, is_active) on public.dining_tables from authenticated;

-- ─── Waiter codes can be reused once a waiter is deleted ────────────────────
drop index public.waiters_employee_code_key;
create unique index waiters_employee_code_key
  on public.waiters (restaurant_id, lower(employee_code))
  where employee_code is not null and is_active;

-- ─── Onboarding: default categories (spec §8.4) ─────────────────────────────
-- Same as before, plus an optional `categories` array of names (the cuisine
-- set chosen at onboarding; the sets live in src/features/menu/default-categories.ts).
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
