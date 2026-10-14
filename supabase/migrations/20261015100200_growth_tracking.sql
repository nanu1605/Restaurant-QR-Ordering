-- Super-admin redesign, stop 12b (docs/SUPER_ADMIN_PLAN.md §4.3; docs/DECISIONS.md
-- SA-12 to SA-15): start collecting what the Growth and Usage pages will need.

-- ─── Acquisition channel ────────────────────────────────────────────────────
-- How a restaurant found MenuMesh. Set by signup (website, or website_lead
-- when a demo request has its mobile) and by the onboarding wizard; null is
-- unknown.
alter table public.restaurants
  add column acquisition_channel text check (acquisition_channel in ('website', 'website_lead', 'field_visit', 'referral', 'phone', 'whatsapp', 'social', 'other'));

-- Restaurants made through signup have trial claims (P11-11).
update public.restaurants r
set acquisition_channel = case
  when exists (select 1 from public.site_leads l where l.phone = private.phone10(r.phone))
    then 'website_lead'
  else 'website'
end
where exists (select 1 from public.trial_claims c where c.restaurant_id = r.id);

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
  v_channel text := nullif(btrim(p_payload ->> 'acquisition_channel'), '');
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

  if v_channel is not null and v_channel not in ('website', 'website_lead', 'field_visit', 'referral', 'phone', 'whatsapp', 'social', 'other') then
    perform private.fail('INVALID_INPUT', 'acquisition_channel');
  end if;

  if not private.is_valid_timezone(coalesce(p_payload ->> 'timezone', 'Asia/Kolkata')) then
    raise exception using errcode = 'P0001', message = 'INVALID_TIMEZONE';
  end if;

  insert into public.restaurants (
    name, slug, legal_name, address_line, city, state, pincode, phone, email,
    timezone, gst_mode, gst_rate_bps, prices_include_tax, acquisition_channel
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
    coalesce((p_payload ->> 'prices_include_tax')::boolean, false),
    v_channel
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
      'default_categories', v_category_count,
      'acquisition_channel', v_channel
    )
  );

  return jsonb_build_object('restaurant_id', v_restaurant.id, 'owner_member_id', v_member_id);
end;
$$;

create or replace function public.site_signup_create_restaurant(p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_fssai text := nullif(btrim(p_payload ->> 'fssai_license'), '');
  v_gstin text := nullif(upper(btrim(p_payload ->> 'gstin')), '');
  v_phone text := private.phone10(p_payload ->> 'phone');
  v_photo text := nullif(btrim(p_payload ->> 'storefront_photo_path'), '');
  v_result jsonb;
  v_restaurant_id uuid;
begin
  if v_fssai is null or v_phone is null or v_photo is null then
    perform private.fail('INVALID_INPUT', 'self_signup');
  end if;

  -- One self-signup at a time, so two can't both pass the check below.
  -- ponytail: one lock for every signup; per-value locks if signups ever queue on it.
  perform pg_advisory_xact_lock(hashtextextended('site_signup:trial_claims', 0));
  if public.site_signup_identity_taken(v_fssai, v_phone, v_gstin) then
    perform private.fail('RESTAURANT_EXISTS');
  end if;

  -- Found on the website; through a demo request first when a lead has this
  -- mobile (SA-12).
  v_result := public.platform_create_restaurant(p_payload || jsonb_build_object(
    'acquisition_channel',
    case when exists (select 1 from public.site_leads l where l.phone = v_phone)
      then 'website_lead' else 'website' end
  ));
  v_restaurant_id := (v_result ->> 'restaurant_id')::uuid;
  update public.restaurants r
  set fssai_license = v_fssai, gstin = v_gstin, storefront_photo_path = v_photo
  where r.id = v_restaurant_id;
  insert into public.trial_claims (kind, value, restaurant_id)
  select c.kind, c.value, v_restaurant_id
  from (values ('fssai', v_fssai), ('phone', v_phone), ('gstin', v_gstin)) c (kind, value)
  where c.value is not null;
  return v_result;
exception
  when check_violation then
    perform private.fail('INVALID_INPUT');
end;
$$;

-- ─── Plan-limit hits ────────────────────────────────────────────────────────
-- A restaurant refused because of its plan: tables, staff logins or a feature
-- (SA-13). Recorded by the server action that got the refusal; the refusing
-- function's own transaction rolls back, so it can't record it.
create table public.plan_limit_events (
  id bigint generated always as identity primary key,
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  kind text not null check (kind in ('tables', 'staff', 'feature')),
  feature text check (feature ~ '^[a-z_]{1,40}$'),
  user_id uuid,
  created_at timestamptz not null default now()
);
create index plan_limit_events_restaurant_created_idx
  on public.plan_limit_events (restaurant_id, created_at);
alter table public.plan_limit_events enable row level security;
revoke all on public.plan_limit_events from anon, authenticated;
grant select on public.plan_limit_events to authenticated;
create policy "platform admins read plan limit events" on public.plan_limit_events
  for select to authenticated using ((select public.is_platform_admin()));

-- p_code: the refusal (PLAN_LIMIT_TABLES, PLAN_LIMIT_STAFF, FEATURE_NOT_IN_PLAN);
-- p_detail: its detail (the feature, for FEATURE_NOT_IN_PLAN).
create function public.member_record_plan_limit(p_code text, p_detail text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member();
  v_kind text := case p_code
    when 'PLAN_LIMIT_TABLES' then 'tables'
    when 'PLAN_LIMIT_STAFF' then 'staff'
    when 'FEATURE_NOT_IN_PLAN' then 'feature'
  end;
begin
  if v_kind is null or (v_kind = 'feature' and coalesce(p_detail, '') !~ '^[a-z_]{1,40}$') then
    perform private.fail('INVALID_INPUT', 'code');
  end if;
  insert into public.plan_limit_events (restaurant_id, kind, feature, user_id)
  values (
    v_ctx.restaurant_id, v_kind, case when v_kind = 'feature' then p_detail end, v_ctx.user_id
  );
end;
$$;

-- ─── QR codes ───────────────────────────────────────────────────────────────
-- A table's QR code downloaded, or the cards sheet printed (SA-14). Works while
-- read-only: the codes still work then.
create function public.admin_record_qr_use(p_action text, p_table_ids uuid[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_labels text[];
begin
  if p_action is null or p_action not in ('downloaded', 'sheet_printed')
     or coalesce(cardinality(p_table_ids), 0) not between 1 and 500
     or (p_action = 'downloaded' and cardinality(p_table_ids) <> 1) then
    perform private.fail('INVALID_INPUT');
  end if;
  select array_agg(d.label order by d.label) into v_labels
  from public.dining_tables d
  where d.restaurant_id = v_ctx.restaurant_id and d.id = any (p_table_ids);
  if v_labels is null then
    perform private.fail('NOT_FOUND');
  end if;

  if p_action = 'downloaded' then
    perform private.audit_as(
      v_ctx, 'table.qr_downloaded', 'dining_table', p_table_ids[1],
      null, jsonb_build_object('label', v_labels[1])
    );
  else
    perform private.audit_as(
      v_ctx, 'table.qr_sheet_printed', 'dining_table', null,
      null, jsonb_build_object('tables', cardinality(v_labels), 'labels', to_jsonb(v_labels))
    );
  end if;
end;
$$;

-- ─── Cancellation reason ────────────────────────────────────────────────────
-- Why the owner turned autopay off (SA-15). The latest answer is kept on the
-- subscription; each one is in the audit log.
alter table public.restaurant_subscriptions
  add column cancel_reason text check (
    cancel_reason in ('too_expensive', 'not_using', 'missing_feature', 'closing', 'switching', 'other')
  ),
  add column cancel_reason_detail text check (length(cancel_reason_detail) <= 300);

create function public.admin_record_cancel_reason(p_reason text, p_detail text default null)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner}');
  v_detail text := private.tidy_text(p_detail);
  v_subscription_id uuid;
begin
  if p_reason is null
     or p_reason not in ('too_expensive', 'not_using', 'missing_feature', 'closing', 'switching', 'other') then
    perform private.fail('INVALID_INPUT', 'reason');
  end if;
  if (p_reason = 'other' and v_detail is null) or length(v_detail) > 300 then
    perform private.fail('INVALID_INPUT', 'detail');
  end if;
  update public.restaurant_subscriptions s
    set cancel_reason = p_reason, cancel_reason_detail = v_detail
    where s.restaurant_id = v_ctx.restaurant_id
    returning s.id into v_subscription_id;
  if v_subscription_id is null then
    perform private.fail('SUBSCRIPTION_NOT_FOUND');
  end if;
  perform private.audit_as(
    v_ctx, 'subscription.cancel_reason', 'restaurant_subscription', v_subscription_id,
    null, jsonb_build_object('reason', p_reason, 'detail', v_detail)
  );
end;
$$;

revoke execute on function public.member_record_plan_limit(text, text) from public, anon;
revoke execute on function public.admin_record_qr_use(text, uuid[]) from public, anon;
revoke execute on function public.admin_record_cancel_reason(text, text) from public, anon;
grant execute on function public.member_record_plan_limit(text, text) to authenticated;
grant execute on function public.admin_record_qr_use(text, uuid[]) to authenticated;
grant execute on function public.admin_record_cancel_reason(text, text) to authenticated;
