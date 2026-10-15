-- Stop 13g: team and roles (docs/SUPER_ADMIN_PLAN.md §3 and 13g, docs/DECISIONS.md SA-70+).
-- Each team member has a role, private.role_permissions gives its permissions
-- (plan §3), and private.require_platform_permission checks them, so every
-- platform function enforces the role. Members are invited by email, can be
-- turned off, and get the daily digest by choice.

-- ─── Members ────────────────────────────────────────────────────────────────
-- Everyone already on the team is an Admin who has joined. An invited member
-- has no joined_at until they set a password through the invite.
alter table public.platform_admins
  add column role text not null default 'admin'
    check (role in ('admin', 'finance', 'sales', 'support')),
  add column display_name text check (char_length(display_name) between 1 and 80),
  add column invited_by uuid references auth.users (id) on delete set null,
  add column invited_at timestamptz,
  add column joined_at timestamptz default now(),
  add column disabled_at timestamptz,
  add column digest boolean not null default true,
  add column invite_token_hash text unique check (invite_token_hash ~ '^[0-9a-f]{64}$'),
  add column invite_expires_at timestamptz;
update public.platform_admins set joined_at = created_at;

-- Who did what, for a member's activity on the audit log.
create index audit_logs_actor_created_idx
  on public.audit_logs (actor_user_id, created_at desc)
  where actor_user_id is not null;

-- ─── Roles ──────────────────────────────────────────────────────────────────
-- Plan §3. src/features/platform/team.ts mirrors it for labels; the panel asks
-- the database which permissions the signed-in member holds.
create function private.role_permissions(p_role text)
returns text[]
language sql
immutable
set search_path = ''
as $$
  select case p_role
    when 'admin' then array[
      'restaurants.view', 'restaurants.manage', 'restaurants.support', 'restaurants.close',
      'money.view', 'money.record', 'growth.manage', 'insights.view', 'settings.manage',
      'team.manage', 'system.view', 'audit.view']
    when 'finance' then array['restaurants.view', 'money.view', 'money.record', 'audit.view']
    when 'sales' then array['restaurants.view', 'restaurants.manage', 'growth.manage', 'insights.view']
    when 'support' then array[
      'restaurants.view', 'restaurants.support', 'insights.view', 'system.view']
    else array[]::text[]
  end
$$;

-- A member who has joined and isn't turned off.
create function private.active_admin(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.platform_admins a
    where a.user_id = p_user_id and a.joined_at is not null and a.disabled_at is null
  )
$$;

-- An active member whose role holds the permission: who may be given work in its area.
create function private.member_can(p_user_id uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.platform_admins a
    where a.user_id = p_user_id and a.joined_at is not null and a.disabled_at is null
      and p_permission = any (private.role_permissions(a.role))
  )
$$;

create or replace function public.platform_admin_status()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not private.active_admin((select auth.uid())) then 'none'
    when coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2' then 'ok'
    else 'mfa_required'
  end;
$$;

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2'
    and private.active_admin((select auth.uid()));
$$;

-- The member's role must hold the permission (plan §3), else FORBIDDEN.
create or replace function private.require_platform_permission(p_permission text)
returns private.platform_admin_context
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context;
begin
  if p_permission is null or not (p_permission = any(private.role_permissions('admin'))) then
    raise exception 'unknown platform permission: %', p_permission;
  end if;
  v_admin := private.current_platform_admin();
  if not exists (
    select 1 from public.platform_admins a
    where a.user_id = v_admin.user_id and p_permission = any(private.role_permissions(a.role))
  ) then
    perform private.fail('FORBIDDEN');
  end if;
  return v_admin;
end;
$$;

-- For row level security: whether the signed-in member may (false for anyone else).
create function public.platform_can(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.has_platform_permission(p_permission);
$$;

-- What the panel shows the signed-in member: their role, name and permissions.
create function public.platform_my_access()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_status text := public.platform_admin_status();
begin
  return (
    select jsonb_build_object(
      'status', v_status,
      'role', a.role,
      'display_name', a.display_name,
      'permissions', case when v_status = 'ok'
        then to_jsonb(private.role_permissions(a.role)) else '[]'::jsonb end
    )
    from public.platform_admins a
    where a.user_id = (select auth.uid()) and v_status <> 'none'
  );
end;
$$;

-- ─── Row level security by permission ───────────────────────────────────────
-- Every role holds restaurants.view, so tables any member may read keep
-- is_platform_admin(); these need their own permission.
alter policy "managers and platform admins read audit logs" on public.audit_logs
  using (
    (restaurant_id in (select private.my_restaurant_ids('{owner,manager}'::public.member_role[]))
      and coalesce(entity_type, '') <> all (
        array['restaurant_note', 'restaurant_tags', 'account_manager']))
    or (select public.platform_can('audit.view'))
  );
alter policy "platform admins read cron runs" on public.cron_runs
  using ((select public.platform_can('system.view')));
alter policy "platform admins read webhook events" on public.webhook_events
  using ((select public.platform_can('system.view')));
alter policy "platform admins read lead events" on public.lead_events
  using ((select public.platform_can('growth.manage')));
alter policy "platform admins read site leads" on public.site_leads
  using ((select public.platform_can('growth.manage')));
-- Signups, leads and visitors by day: the funnel's numbers.
alter policy "platform admins read platform snapshots" on public.metrics_platform_daily
  using ((select public.platform_can('growth.manage')));
alter policy "owners, managers and platform admins read menu imports" on public.menu_imports
  using (
    restaurant_id in (select private.my_restaurant_ids('{owner,manager}'::public.member_role[]))
    or (select public.platform_can('restaurants.support'))
  );
alter policy "platform admins read support requests" on public.support_requests
  using ((select public.platform_can('restaurants.support')));
alter policy "platform admins read support request events" on public.support_request_events
  using ((select public.platform_can('restaurants.support')));
alter policy "platform admins read subscription snapshots" on public.metrics_subscription_daily
  using ((select public.platform_can('money.view')));
alter policy "owners and platform admins read subscription payments" on public.subscription_payments
  using (
    restaurant_id in (select private.my_restaurant_ids('{owner}'::public.member_role[]))
    or (select public.platform_can('money.view'))
  );

-- ─── Support sessions end with the role ─────────────────────────────────────
-- Turned off, or moved to a role without restaurants.support: open sessions end.
create trigger end_support_sessions_on_change
  after update of role, disabled_at on public.platform_admins
  for each row
  when (new.disabled_at is not null
    or not ('restaurants.support' = any (private.role_permissions(new.role))))
  execute function private.end_support_sessions_of_removed_admin();

-- ─── Every platform function checks its permission (plan §3) ────────────────
-- The functions that still let any member in, now each on its permission;
-- members chosen as assignees must be active with the area's permission, and
-- account managers active; search
-- shows payments and leads only to roles that see them; the digest goes to
-- members who chose it and whose role sees money (owner's choice,
-- 2026-10-15). Bodies are unchanged otherwise.

-- public.platform_restaurant_lookalikes
CREATE OR REPLACE FUNCTION public.platform_restaurant_lookalikes(p_restaurant_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.view');
begin
  if coalesce(cardinality(p_restaurant_ids), 0) > 100 then
    perform private.fail('INVALID_INPUT', 'restaurant_ids');
  end if;
  return coalesce(
    (select jsonb_object_agg(r.id, private.restaurant_lookalikes(r.id))
     from public.restaurants r
     where r.id = any (p_restaurant_ids)),
    '{}'::jsonb
  );
end;
$function$;

-- public.platform_support_view
CREATE OR REPLACE FUNCTION public.platform_support_view(p_restaurant_id uuid, p_section text, p_filters jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.view');
  v_restaurant public.restaurants;
  v_data jsonb;
begin
  if p_section is null or p_section not in ('menu', 'tables', 'board', 'total_orders') then
    perform private.fail('INVALID_INPUT', 'section');
  end if;
  if p_section <> 'total_orders' and coalesce(p_filters, '{}'::jsonb) <> '{}'::jsonb then
    perform private.fail('INVALID_INPUT', 'filters');
  end if;

  select * into v_restaurant from public.restaurants r where r.id = p_restaurant_id;
  if not found then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;

  v_data := case p_section
    when 'menu' then private.support_menu_json(p_restaurant_id)
    when 'tables' then private.support_tables_json(p_restaurant_id)
    when 'board' then private.board_json(p_restaurant_id, 'manager', null)
    else private.total_orders_json(p_restaurant_id, p_filters)
  end;

  if not exists (
    select 1 from public.audit_logs a
    where a.restaurant_id = p_restaurant_id
      and a.created_at > now() - interval '10 minutes'
      and a.action = 'support.viewed'
      and a.actor_user_id = v_admin.user_id
      and a.after ->> 'section' = p_section
  ) then
    perform private.audit_platform(
      v_admin, p_restaurant_id, 'support.viewed', 'restaurant', p_restaurant_id,
      null, jsonb_build_object('section', p_section)
    );
  end if;

  return jsonb_build_object(
    'restaurant', jsonb_build_object(
      'id', v_restaurant.id,
      'name', v_restaurant.name,
      'slug', v_restaurant.slug,
      'timezone', v_restaurant.timezone,
      'status', v_restaurant.status
    ),
    'section', p_section,
    'data', v_data
  );
end;
$function$;

-- public.platform_overview
CREATE OR REPLACE FUNCTION public.platform_overview()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('money.view');
  v_counts jsonb;
  v_mrr bigint;
  v_orders bigint;
  v_trials jsonb;
begin
  -- One state per restaurant and its MRR, by the shared rules (SA-7). The JSON
  -- keys stay as the overview page reads them: trialing = Trial, active =
  -- Paid, past_due = Payment failed.
  with states as (
    select st.state, private.restaurant_mrr_paise(st.state, p, s.billing_cycle) as mrr
    from public.restaurants r
    left join public.restaurant_subscriptions s on s.restaurant_id = r.id
    left join public.plans p on p.id = s.plan_id
    cross join lateral public.restaurant_access(r.id) as a
    cross join lateral (
      select private.subscription_state(r.status::text, a.state, s.status::text, s.source::text) as state
    ) as st
  )
  select
    jsonb_build_object(
      'total', count(*),
      'trialing', count(*) filter (where state = 'trial'),
      'active', count(*) filter (where state = 'paid'),
      'past_due', count(*) filter (where state = 'payment_failed'),
      'read_only', count(*) filter (where state = 'read_only'),
      'suspended', count(*) filter (where state = 'suspended')
    ),
    coalesce(sum(mrr), 0)
  into v_counts, v_mrr
  from states;

  select count(*) into v_orders
  from public.orders o
  where o.created_at >= now() - interval '24 hours';

  select coalesce(jsonb_agg(jsonb_build_object(
    'restaurant_id', r.id,
    'name', r.name,
    'slug', r.slug,
    'plan_name', p.name,
    'trial_ends_at', s.trial_ends_at
  ) order by s.trial_ends_at, r.name), '[]'::jsonb)
  into v_trials
  from public.restaurant_subscriptions s
  join public.restaurants r on r.id = s.restaurant_id
  join public.plans p on p.id = s.plan_id
  where s.status = 'trialing'
    and s.trial_ends_at >= now() and s.trial_ends_at < now() + interval '7 days';

  return jsonb_build_object(
    'restaurants', v_counts,
    'mrr_paise', v_mrr,
    'orders_24h', v_orders,
    'trials_ending', v_trials,
    'history_starts_on', (select min(m.day) from public.metrics_subscription_daily m)
  );
end;
$function$;

-- public.platform_list_subscriptions
CREATE OR REPLACE FUNCTION public.platform_list_subscriptions(p_filters jsonb)
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
    'suspended', 'read_only', 'trial', 'payment_failed', 'paid', 'cancelled'
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
    cross join lateral public.restaurant_access(r.id) as a
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

-- public.platform_set_restaurant_status
CREATE OR REPLACE FUNCTION public.platform_set_restaurant_status(p_restaurant_id uuid, p_status text, p_reason text)
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

-- public.platform_extend_trial
CREATE OR REPLACE FUNCTION public.platform_extend_trial(p_restaurant_id uuid, p_days integer)
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

-- public.platform_change_plan
CREATE OR REPLACE FUNCTION public.platform_change_plan(p_restaurant_id uuid, p_plan_code text)
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

-- public.platform_reset_owner_password
CREATE OR REPLACE FUNCTION public.platform_reset_owner_password(p_member_id uuid)
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
  perform private.audit_platform(
    v_admin, v_member.restaurant_id, 'staff.password_reset', 'restaurant_member', v_member.id
  );
  return v_member.user_id;
end;
$function$;

-- public.platform_record_manual_payment
CREATE OR REPLACE FUNCTION public.platform_record_manual_payment(p_restaurant_id uuid, p_payment jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('money.record');
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
$function$;

-- public.platform_record_setup_fee
CREATE OR REPLACE FUNCTION public.platform_record_setup_fee(p_restaurant_id uuid, p_payment jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('money.record');
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
$function$;

-- public.platform_audit_payment_link
CREATE OR REPLACE FUNCTION public.platform_audit_payment_link(p_restaurant_id uuid, p_link jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('money.record');
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
$function$;

-- public.platform_update_plan
CREATE OR REPLACE FUNCTION public.platform_update_plan(p_plan_id uuid, p_patch jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('settings.manage');
  v_patch jsonb := coalesce(p_patch, '{}'::jsonb);
  v_plan public.plans;
  v_updated public.plans;
  v_key text;
  v_before jsonb := '{}'::jsonb;
  v_after jsonb := '{}'::jsonb;
  v_known_features constant text[] := array[
    'kds', 'discounts', 'split_payments', 'upi_qr_on_bill', 'advanced_reports',
    'waiter_reports', 'csv_export', 'remove_branding'
  ];
begin
  perform private.assert_keys(v_patch, array[
    'name', 'price_monthly_paise', 'price_yearly_paise', 'max_tables', 'max_staff', 'features',
    'razorpay_plan_id_monthly', 'razorpay_plan_id_yearly', 'is_active', 'sort_order'
  ]);

  select * into v_plan from public.plans p where p.id = p_plan_id for update;
  if not found then
    perform private.fail('PLAN_NOT_FOUND');
  end if;
  v_updated := v_plan;

  if v_patch ? 'name' then
    v_updated.name := private.tidy_text(private.json_text(v_patch, 'name'));
    if v_updated.name is null or length(v_updated.name) > 40 then
      perform private.fail('INVALID_INPUT', 'name');
    end if;
  end if;
  if v_patch ? 'price_monthly_paise' then
    v_updated.price_monthly_paise := private.json_int(v_patch, 'price_monthly_paise');
    if v_updated.price_monthly_paise not between 0 and 100000000 then
      perform private.fail('INVALID_INPUT', 'price_monthly_paise');
    end if;
  end if;
  if v_patch ? 'price_yearly_paise' then
    v_updated.price_yearly_paise := private.json_int(v_patch, 'price_yearly_paise');
    if v_updated.price_yearly_paise not between 0 and 100000000 then
      perform private.fail('INVALID_INPUT', 'price_yearly_paise');
    end if;
  end if;
  foreach v_key in array array['max_tables', 'max_staff'] loop
    if v_patch ? v_key and jsonb_typeof(v_patch -> v_key) <> 'null' then
      if private.json_int(v_patch, v_key) not between 1 and 10000 then
        perform private.fail('INVALID_INPUT', v_key);
      end if;
    end if;
  end loop;
  if v_patch ? 'max_tables' then
    v_updated.max_tables := (v_patch ->> 'max_tables')::int;
  end if;
  if v_patch ? 'max_staff' then
    v_updated.max_staff := (v_patch ->> 'max_staff')::int;
  end if;
  if v_patch ? 'features' then
    if jsonb_typeof(v_patch -> 'features') <> 'object' then
      perform private.fail('INVALID_INPUT', 'features');
    end if;
    for v_key in select jsonb_object_keys(v_patch -> 'features') loop
      if not v_key = any (v_known_features)
        or jsonb_typeof(v_patch -> 'features' -> v_key) <> 'boolean'
      then
        perform private.fail('INVALID_INPUT', 'features');
      end if;
    end loop;
    v_updated.features := v_plan.features || (v_patch -> 'features');
  end if;
  foreach v_key in array array['razorpay_plan_id_monthly', 'razorpay_plan_id_yearly'] loop
    if v_patch ? v_key then
      if coalesce(nullif(btrim(private.json_text(v_patch, v_key)), ''), 'plan_x') !~ '^[A-Za-z0-9_]{1,60}$' then
        perform private.fail('INVALID_INPUT', v_key);
      end if;
    end if;
  end loop;
  if v_patch ? 'razorpay_plan_id_monthly' then
    v_updated.razorpay_plan_id_monthly := nullif(btrim(v_patch ->> 'razorpay_plan_id_monthly'), '');
  end if;
  if v_patch ? 'razorpay_plan_id_yearly' then
    v_updated.razorpay_plan_id_yearly := nullif(btrim(v_patch ->> 'razorpay_plan_id_yearly'), '');
  end if;
  if v_patch ? 'is_active' then
    v_updated.is_active := private.json_bool(v_patch, 'is_active');
  end if;
  if v_patch ? 'sort_order' then
    v_updated.sort_order := private.json_int(v_patch, 'sort_order');
    if v_updated.sort_order not between 0 and 1000 then
      perform private.fail('INVALID_INPUT', 'sort_order');
    end if;
  end if;

  -- A Razorpay plan's amount can't change (P8-10): a new price needs a new
  -- Razorpay plan, unless a different id comes with it.
  if v_updated.price_monthly_paise <> v_plan.price_monthly_paise
     and v_updated.razorpay_plan_id_monthly is not distinct from v_plan.razorpay_plan_id_monthly then
    v_updated.razorpay_plan_id_monthly := null;
  end if;
  if v_updated.price_yearly_paise <> v_plan.price_yearly_paise
     and v_updated.razorpay_plan_id_yearly is not distinct from v_plan.razorpay_plan_id_yearly then
    v_updated.razorpay_plan_id_yearly := null;
  end if;

  update public.plans p
    set name = v_updated.name,
        price_monthly_paise = v_updated.price_monthly_paise,
        price_yearly_paise = v_updated.price_yearly_paise,
        max_tables = v_updated.max_tables,
        max_staff = v_updated.max_staff,
        features = v_updated.features,
        razorpay_plan_id_monthly = v_updated.razorpay_plan_id_monthly,
        razorpay_plan_id_yearly = v_updated.razorpay_plan_id_yearly,
        is_active = v_updated.is_active,
        sort_order = v_updated.sort_order
    where p.id = p_plan_id
    returning * into v_updated;

  -- Audit only what changed.
  for v_key in
    select jsonb_object_keys(v_patch)
    union select unnest(array['razorpay_plan_id_monthly', 'razorpay_plan_id_yearly'])
  loop
    if (to_jsonb(v_plan) -> v_key) is distinct from (to_jsonb(v_updated) -> v_key) then
      v_before := v_before || jsonb_build_object(v_key, to_jsonb(v_plan) -> v_key);
      v_after := v_after || jsonb_build_object(v_key, to_jsonb(v_updated) -> v_key);
    end if;
  end loop;
  if v_after <> '{}'::jsonb then
    perform private.audit_platform(
      v_admin, null, 'plan.updated', 'plan', p_plan_id,
      v_before || jsonb_build_object('code', v_plan.code),
      v_after
    );
  end if;

  return to_jsonb(v_updated) - 'created_at' - 'updated_at';
end;
$function$;

-- public.platform_reprocess_webhook
CREATE OR REPLACE FUNCTION public.platform_reprocess_webhook(p_event_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('settings.manage');
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
$function$;

-- private.menu_import_actor
CREATE OR REPLACE FUNCTION private.menu_import_actor(p_restaurant_id uuid)
 RETURNS private.import_actor
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor private.import_actor;
  v_session_id uuid;
  v_admin private.platform_admin_context;
begin
  select m.restaurant_id, m.user_id, 'staff'::public.actor_type, m.role, m.display_name
    into v_actor
    from public.restaurant_members m
    where m.user_id = (select auth.uid())
      and m.restaurant_id = p_restaurant_id
      and m.is_active
      and m.role in ('owner', 'manager');
  if found then
    return v_actor;
  end if;

  select s.id into v_session_id
    from private.support_session_for((select auth.uid())) as s
    where s.restaurant_id = p_restaurant_id
      and not exists (
        select 1 from public.restaurant_members m
        where m.user_id = (select auth.uid()) and m.is_active
      );
  if v_session_id is not null then
    return row(
      p_restaurant_id, (select auth.uid()), 'platform_admin', null, 'MenuMesh support', v_session_id
    )::private.import_actor;
  end if;

  v_admin := private.require_platform_permission('restaurants.support');
  if not exists (select 1 from public.restaurants r where r.id = p_restaurant_id) then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;
  return row(
    p_restaurant_id, v_admin.user_id, 'platform_admin', null, 'Platform admin', null
  )::private.import_actor;
end;
$function$;

-- public.platform_list_audit
CREATE OR REPLACE FUNCTION public.platform_list_audit(p_filters jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('audit.view');
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_restaurant_id uuid;
  v_actor_type text;
  v_actor uuid;
  v_action text;
  v_from date;
  v_to date;
  v_page int := 1;
  v_page_size constant int := 50;
  v_total bigint;
  v_rows jsonb;
begin
  perform private.assert_keys(
    v_filters, array['restaurant_id', 'actor_type', 'actor', 'action', 'from', 'to', 'page']
  );
  if coalesce(jsonb_typeof(v_filters -> 'restaurant_id'), 'null') <> 'null' then
    v_restaurant_id := private.json_uuid(v_filters, 'restaurant_id');
  end if;
  v_actor_type := private.json_text(v_filters, 'actor_type');
  if coalesce(jsonb_typeof(v_filters -> 'actor'), 'null') <> 'null' then
    v_actor := private.json_uuid(v_filters, 'actor');
  end if;
  if v_actor_type is not null
    and v_actor_type not in ('staff', 'customer', 'system', 'platform_admin')
  then
    perform private.fail('INVALID_INPUT', 'actor_type');
  end if;
  v_action := nullif(btrim(coalesce(private.json_text(v_filters, 'action'), '')), '');
  if v_action is not null and v_action !~ '^[a-z_.]{1,60}$' then
    perform private.fail('INVALID_INPUT', 'action');
  end if;
  v_from := private.json_date(v_filters, 'from');
  v_to := private.json_date(v_filters, 'to');
  if v_from is not null and v_to is not null and v_to < v_from then
    perform private.fail('INVALID_INPUT', 'to');
  end if;
  if coalesce(jsonb_typeof(v_filters -> 'page'), 'null') <> 'null' then
    v_page := private.json_int(v_filters, 'page');
    if v_page not between 1 and 10000 then
      perform private.fail('INVALID_INPUT', 'page');
    end if;
  end if;

  with matching as (
    select a.*
    from public.audit_logs a
    where (v_restaurant_id is null or a.restaurant_id = v_restaurant_id)
      and (v_actor_type is null or a.actor_type::text = v_actor_type)
      and (v_actor is null or a.actor_user_id = v_actor)
      and (v_action is null or left(a.action, length(v_action)) = v_action)
      and (v_from is null
        or a.created_at >= (v_from::timestamp at time zone 'Asia/Kolkata'))
      and (v_to is null
        or a.created_at < ((v_to + 1)::timestamp at time zone 'Asia/Kolkata'))
  ),
  page as (
    select m.*
    from matching m
    order by m.created_at desc, m.id
    limit v_page_size offset (v_page - 1) * v_page_size
  )
  select
    (select count(*) from matching),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', pg.id,
        'created_at', pg.created_at,
        'restaurant_id', pg.restaurant_id,
        'restaurant_name', r.name,
        'restaurant_slug', r.slug,
        'actor_type', pg.actor_type,
        'actor_label', pg.actor_label,
        'actor_role', pg.actor_role,
        'actor_email', u.email,
        'actor_name', pa.display_name,
        'action', pg.action,
        'entity_type', pg.entity_type,
        'entity_id', pg.entity_id,
        'before', pg.before,
        'after', pg.after,
        'reason', pg.reason,
        'support_session_id', pg.support_session_id
      ) order by pg.created_at desc, pg.id)
      from page pg
      left join public.restaurants r on r.id = pg.restaurant_id
      left join auth.users u on u.id = pg.actor_user_id
      left join public.platform_admins pa on pa.user_id = pg.actor_user_id
    ), '[]'::jsonb)
  into v_total, v_rows;

  return jsonb_build_object('page', v_page, 'page_size', v_page_size, 'total', v_total, 'rows', v_rows);
end;
$function$;

-- public.platform_search
CREATE OR REPLACE FUNCTION public.platform_search(p_q text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.view');
  v_q text := btrim(coalesce(p_q, ''));
  v_escaped text;
  v_like text;
  v_digits text;
  v_restaurants jsonb;
  v_payments jsonb;
  v_leads jsonb;
  v_money boolean := private.has_platform_permission('money.view');
  v_growth boolean := private.has_platform_permission('growth.manage');
begin
  if length(v_q) < 2 or length(v_q) > 80 then
    return jsonb_build_object('restaurants', '[]'::jsonb, 'payments', '[]'::jsonb,
      'leads', '[]'::jsonb);
  end if;
  -- Typed text, not a pattern: % and _ match themselves.
  v_escaped := replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_');
  v_like := '%' || v_escaped || '%';
  v_digits := case
    when v_q ~ '^[0-9 +().-]+$' then nullif(regexp_replace(v_q, '\D', '', 'g'), '')
  end;
  -- Typed with +91 or a leading 0: the 10-digit number.
  if length(v_digits) > 10 then
    v_digits := right(v_digits, 10);
  end if;
  if length(v_digits) < 3 then
    v_digits := null;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'restaurant_id', x.id, 'name', x.name, 'slug', x.slug, 'city', x.city, 'match', x.match
    ) order by x.rank, x.score desc, x.name), '[]'::jsonb)
  into v_restaurants
  from (
    select r.id, r.name, r.slug, r.city,
      case
        when r.name ilike v_like then null
        when r.slug ilike v_like then 'Code ' || r.slug
        when r.city ilike v_like then null
        when v_digits is not null and regexp_replace(r.phone, '\D', '', 'g') like '%' || v_digits || '%'
          then 'Phone ' || r.phone
        when r.gstin ilike v_like then 'GSTIN ' || r.gstin
        when v_digits is not null and r.fssai_license like '%' || v_digits || '%'
          then 'FSSAI ' || r.fssai_license
        else 'Owner ' || (
          select u.email from public.restaurant_members m
          join auth.users u on u.id = m.user_id
          where m.restaurant_id = r.id and m.role = 'owner' and u.email ilike v_like
          limit 1)
      end as match,
      case when lower(r.name) = lower(v_q) or lower(r.slug) = lower(v_q) then 0
        when r.name ilike v_escaped || '%' then 1 else 2 end as rank,
      extensions.similarity(r.name, v_q) as score
    from public.restaurants r
    where r.name ilike v_like or r.slug ilike v_like or r.city ilike v_like
      or r.gstin ilike v_like
      or (v_digits is not null and (regexp_replace(r.phone, '\D', '', 'g') like '%' || v_digits || '%'
        or r.fssai_license like '%' || v_digits || '%'))
      or exists (
        select 1 from public.restaurant_members m
        join auth.users u on u.id = m.user_id
        where m.restaurant_id = r.id and m.role = 'owner' and u.email ilike v_like
      )
    order by rank, score desc, r.name
    limit 8
  ) as x;

  select coalesce(jsonb_agg(jsonb_build_object(
      'restaurant_id', x.restaurant_id, 'name', x.name, 'kind', x.kind, 'ref', x.ref
    )), '[]'::jsonb)
  into v_payments
  from (
    select * from (
      select sp.restaurant_id, r.name, 'payment' as kind, sp.razorpay_payment_id as ref
      from public.subscription_payments sp
      join public.restaurants r on r.id = sp.restaurant_id
      where v_money and length(v_q) >= 4 and sp.razorpay_payment_id ilike v_like
      union all
      select s.restaurant_id, r.name, 'subscription', s.razorpay_subscription_id
      from public.restaurant_subscriptions s
      join public.restaurants r on r.id = s.restaurant_id
      where v_money and length(v_q) >= 4 and s.razorpay_subscription_id ilike v_like
    ) as y
    order by y.ref
    limit 5
  ) as x;

  select coalesce(jsonb_agg(jsonb_build_object(
      'lead_id', x.id, 'name', x.name, 'restaurant_name', x.restaurant_name, 'phone', x.phone,
      'created_at', x.created_at
    ) order by x.created_at desc), '[]'::jsonb)
  into v_leads
  from (
    select l.id, l.name, l.restaurant_name, l.phone, l.created_at
    from public.site_leads l
    where v_growth and (l.name ilike v_like or l.restaurant_name ilike v_like
      or (v_digits is not null and l.phone like '%' || v_digits || '%'))
    order by l.created_at desc
    limit 5
  ) as x;

  return jsonb_build_object('restaurants', v_restaurants, 'payments', v_payments,
    'leads', v_leads);
end;
$function$;

-- public.platform_create_lead
CREATE OR REPLACE FUNCTION public.platform_create_lead(p_lead jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('growth.manage');
  v_lead jsonb := coalesce(p_lead, '{}'::jsonb);
  v_phone text;
  v_channel text;
  v_stage text;
  v_assignee uuid;
  v_id uuid;
begin
  perform private.assert_keys(v_lead,
    array['name', 'restaurant_name', 'city', 'phone', 'email', 'channel', 'stage', 'message',
      'assignee']);
  v_phone := private.phone10(private.json_text(v_lead, 'phone'));
  v_channel := private.json_text(v_lead, 'channel');
  v_stage := coalesce(private.json_text(v_lead, 'stage'), 'new');
  if coalesce(jsonb_typeof(v_lead -> 'assignee'), 'null') <> 'null' then
    v_assignee := private.json_uuid(v_lead, 'assignee');
  end if;

  if v_phone is null or length(regexp_replace(private.json_text(v_lead, 'phone'), '\D', '', 'g')) > 12 then
    perform private.fail('INVALID_INPUT', 'phone');
  end if;
  if v_channel is null or v_channel not in ('field_visit', 'referral', 'phone', 'whatsapp',
    'social', 'other') then
    perform private.fail('INVALID_INPUT', 'channel');
  end if;
  if v_stage not in ('new', 'contacted') then
    perform private.fail('INVALID_INPUT', 'stage');
  end if;
  if v_assignee is not null
    and not private.member_can(v_assignee, 'growth.manage') then
    perform private.fail('ADMIN_NOT_FOUND');
  end if;

  insert into public.site_leads (name, restaurant_name, city, phone, email, message, channel,
    stage, assignee_id, created_by)
  values (
    private.tidy_text(private.json_text(v_lead, 'name')),
    private.tidy_text(private.json_text(v_lead, 'restaurant_name')),
    private.tidy_text(private.json_text(v_lead, 'city')),
    v_phone,
    nullif(lower(btrim(private.json_text(v_lead, 'email'))), ''),
    nullif(btrim(private.json_text(v_lead, 'message')), ''),
    v_channel,
    v_stage,
    v_assignee,
    v_admin.user_id
  )
  returning id into v_id;
  return v_id;
exception
  when check_violation or not_null_violation then
    perform private.fail('INVALID_INPUT');
end;
$function$;

-- public.platform_update_lead
CREATE OR REPLACE FUNCTION public.platform_update_lead(p_lead_id uuid, p_patch jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('growth.manage');
  v_patch jsonb := coalesce(p_patch, '{}'::jsonb);
  v_lead public.site_leads;
  v_stage text;
  v_reason text;
  v_assignee uuid;
  v_follow_up timestamptz;
  v_demo timestamptz;
  v_code text;
  v_restaurant uuid;
begin
  perform private.assert_keys(v_patch,
    array['stage', 'lost_reason', 'assignee', 'follow_up_at', 'demo_at', 'restaurant_code']);
  select * into v_lead from public.site_leads l where l.id = p_lead_id for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;

  v_stage := coalesce(private.json_text(v_patch, 'stage'), v_lead.stage);
  v_reason := case when v_patch ? 'lost_reason' then private.json_text(v_patch, 'lost_reason')
    else v_lead.lost_reason end;
  v_assignee := v_lead.assignee_id;
  if v_patch ? 'assignee' then
    v_assignee := case when jsonb_typeof(v_patch -> 'assignee') = 'null' then null
      else private.json_uuid(v_patch, 'assignee') end;
  end if;
  v_follow_up := case when v_patch ? 'follow_up_at' then private.json_time(v_patch, 'follow_up_at')
    else v_lead.follow_up_at end;
  v_demo := case when v_patch ? 'demo_at' then private.json_time(v_patch, 'demo_at')
    else v_lead.demo_at end;
  v_restaurant := v_lead.restaurant_id;
  if v_patch ? 'restaurant_code' then
    v_code := lower(private.tidy_text(private.json_text(v_patch, 'restaurant_code')));
    v_restaurant := null;
    if v_code is not null then
      select r.id into v_restaurant from public.restaurants r where r.slug = v_code;
      if not found then
        perform private.fail('RESTAURANT_NOT_FOUND');
      end if;
    end if;
  end if;

  if v_stage not in ('new', 'contacted', 'demo_scheduled', 'demo_done', 'trial', 'won', 'lost') then
    perform private.fail('INVALID_INPUT', 'stage');
  end if;
  if v_stage = 'lost' then
    if v_reason is null or v_reason not in ('price', 'not_interested', 'other_system',
      'no_response', 'closed_down', 'other') then
      perform private.fail('INVALID_INPUT', 'lost_reason');
    end if;
  else
    v_reason := null;
  end if;
  if v_assignee is distinct from v_lead.assignee_id and v_assignee is not null
    and not private.member_can(v_assignee, 'growth.manage') then
    perform private.fail('ADMIN_NOT_FOUND');
  end if;

  insert into public.lead_events (lead_id, kind, actor_id, from_value, to_value)
  select v_lead.id, c.kind, v_admin.user_id, c.before, c.after
  from (values
    ('stage', private.lead_stage_value(v_lead.stage, v_lead.lost_reason),
      private.lead_stage_value(v_stage, v_reason)),
    ('assignee', v_lead.assignee_id::text, v_assignee::text),
    ('follow_up', v_lead.follow_up_at::text, v_follow_up::text),
    ('demo', v_lead.demo_at::text, v_demo::text)
  ) as c(kind, before, after)
  where c.before is distinct from c.after;

  update public.site_leads l
  set stage = v_stage,
    lost_reason = v_reason,
    assignee_id = v_assignee,
    follow_up_at = v_follow_up,
    demo_at = v_demo,
    updated_at = now()
  where l.id = v_lead.id
    and (l.stage, l.lost_reason, l.assignee_id, l.follow_up_at, l.demo_at)
      is distinct from (v_stage, v_reason, v_assignee, v_follow_up, v_demo)
  returning * into v_lead;
  if not found then
    select * into v_lead from public.site_leads l where l.id = p_lead_id;
  end if;

  if v_restaurant is distinct from v_lead.restaurant_id then
    if v_restaurant is null then
      insert into public.lead_events (lead_id, kind, actor_id, from_value)
      values (v_lead.id, 'restaurant', v_admin.user_id, v_lead.restaurant_id::text);
      update public.site_leads l set restaurant_id = null, updated_at = now() where l.id = v_lead.id;
    else
      perform private.attach_lead(v_lead, v_restaurant, v_admin.user_id);
    end if;
  end if;
end;
$function$;

-- public.platform_update_support_request
CREATE OR REPLACE FUNCTION public.platform_update_support_request(p_request_id uuid, p_patch jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.support');
  v_patch jsonb := coalesce(p_patch, '{}'::jsonb);
  v_request public.support_requests;
  v_status text;
  v_priority text;
  v_assignee uuid;
begin
  perform private.assert_keys(v_patch, array['status', 'priority', 'assignee']);
  select * into v_request from public.support_requests q where q.id = p_request_id for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  v_status := coalesce(private.json_text(v_patch, 'status'), v_request.status);
  v_priority := coalesce(private.json_text(v_patch, 'priority'), v_request.priority);
  v_assignee := v_request.assignee_id;
  if v_patch ? 'assignee' then
    v_assignee := case when jsonb_typeof(v_patch -> 'assignee') = 'null' then null
      else private.json_uuid(v_patch, 'assignee') end;
  end if;

  if v_status not in ('open', 'in_progress', 'waiting', 'resolved') then
    perform private.fail('INVALID_INPUT', 'status');
  end if;
  if v_priority not in ('low', 'normal', 'high') then
    perform private.fail('INVALID_INPUT', 'priority');
  end if;
  if v_assignee is distinct from v_request.assignee_id and v_assignee is not null
    and not private.member_can(v_assignee, 'restaurants.support') then
    perform private.fail('ADMIN_NOT_FOUND');
  end if;

  insert into public.support_request_events (request_id, restaurant_id, kind, actor_id, from_value, to_value)
  select v_request.id, v_request.restaurant_id, c.kind, v_admin.user_id, c.before, c.after
  from (values
    ('status', v_request.status, v_status),
    ('priority', v_request.priority, v_priority),
    ('assignee', v_request.assignee_id::text, v_assignee::text)
  ) as c(kind, before, after)
  where c.before is distinct from c.after;
  if not found then
    return;
  end if;

  update public.support_requests q
  set status = v_status,
    priority = v_priority,
    assignee_id = v_assignee,
    resolved_at = case
      when v_status <> 'resolved' then null
      when q.status = 'resolved' then q.resolved_at
      else now()
    end,
    updated_at = now()
  where q.id = v_request.id;
end;
$function$;

-- public.platform_set_account_manager
CREATE OR REPLACE FUNCTION public.platform_set_account_manager(p_restaurant_id uuid, p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.manage');
  v_before uuid;
begin
  perform 1 from public.restaurants r where r.id = p_restaurant_id for update;
  if not found then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;
  select am.user_id into v_before
  from public.restaurant_account_managers am where am.restaurant_id = p_restaurant_id;
  if p_user_id is not null
    and not private.active_admin(p_user_id) then
    perform private.fail('ADMIN_NOT_FOUND');
  end if;
  if v_before is not distinct from p_user_id then
    return;
  end if;
  if p_user_id is null then
    delete from public.restaurant_account_managers where restaurant_id = p_restaurant_id;
  else
    insert into public.restaurant_account_managers (restaurant_id, user_id)
    values (p_restaurant_id, p_user_id)
    on conflict (restaurant_id) do update set user_id = excluded.user_id, created_at = now();
  end if;
  perform private.audit_platform(
    v_admin, p_restaurant_id, 'restaurant.account_manager_changed', 'account_manager',
    p_restaurant_id,
    jsonb_build_object('email', (select u.email from auth.users u where u.id = v_before)),
    jsonb_build_object('email', (select u.email from auth.users u where u.id = p_user_id))
  );
end;
$function$;

-- public.platform_team
CREATE OR REPLACE FUNCTION public.platform_team()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  perform private.require_platform_permission('restaurants.view');
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', a.user_id, 'email', u.email,
        'display_name', a.display_name,
        'permissions', to_jsonb(private.role_permissions(a.role)))
      order by lower(coalesce(a.display_name, u.email)))
    from public.platform_admins a
    join auth.users u on u.id = a.user_id
    where a.joined_at is not null and a.disabled_at is null
  ), '[]'::jsonb);
end;
$function$;

-- private.support_session_for
CREATE OR REPLACE FUNCTION private.support_session_for(p_user_id uuid)
 RETURNS SETOF support_sessions
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select s.*
  from public.support_sessions s
  where s.user_id = p_user_id
    and s.ended_at is null
    and s.started_at is not null
    and s.ends_at > now()
    and private.member_can(p_user_id, 'restaurants.support')
    and (
      (select auth.uid()) is null
      or ((select auth.uid()) = p_user_id
          and coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2')
    );
$function$;

-- public.platform_digest
CREATE OR REPLACE FUNCTION public.platform_digest(p_day date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_day date := coalesce(p_day, (now() at time zone 'Asia/Kolkata')::date - 1);
  v_from timestamptz := v_day::timestamp at time zone 'Asia/Kolkata';
  v_to timestamptz := (v_day + 1)::timestamp at time zone 'Asia/Kolkata';
  v_states jsonb;
  v_attention jsonb;
begin
  -- The state at the end of the day, from that night's snapshot, or now.
  select jsonb_build_object(
    'mrr_paise', coalesce(sum(m.mrr_paise), 0),
    'paid', count(*) filter (where m.state = 'paid'),
    'trial', count(*) filter (where m.state = 'trial'),
    'payment_failed', count(*) filter (where m.state = 'payment_failed')
  )
  into v_states
  from public.metrics_subscription_daily m
  where m.day = v_day
  having count(*) > 0;

  if v_states is null then
    select jsonb_build_object(
      'mrr_paise', coalesce(sum(private.restaurant_mrr_paise(st.state, p, s.billing_cycle)), 0),
      'paid', count(*) filter (where st.state = 'paid'),
      'trial', count(*) filter (where st.state = 'trial'),
      'payment_failed', count(*) filter (where st.state = 'payment_failed')
    )
    into v_states
    from public.restaurants r
    left join public.restaurant_subscriptions s on s.restaurant_id = r.id
    left join public.plans p on p.id = s.plan_id
    cross join lateral public.restaurant_access(r.id) as a
    cross join lateral (
      select private.subscription_state(r.status::text, a.state, s.status::text, s.source::text) as state
    ) as st;
  end if;

  v_attention := private.attention(null, true, true, true);

  return jsonb_build_object(
    'day', v_day,
    'states', v_states,
    'collected', (
      select jsonb_build_object(
        'base_paise', coalesce(sum(p.base_paise), 0),
        'gst_paise', coalesce(sum(p.gst_paise), 0),
        'count', count(*)
      )
      from public.subscription_payments p
      where p.created_at >= v_from and p.created_at < v_to
    ),
    'signups', (
      select count(*) from public.restaurants r
      where r.created_at >= v_from and r.created_at < v_to
        and exists (select 1 from public.trial_claims c where c.restaurant_id = r.id)
    ),
    'onboarded', (
      select count(*) from public.restaurants r
      where r.created_at >= v_from and r.created_at < v_to
        and not exists (select 1 from public.trial_claims c where c.restaurant_id = r.id)
    ),
    'leads', (
      select count(*) from public.site_leads l where l.created_at >= v_from and l.created_at < v_to
    ),
    'usage', (
      select jsonb_build_object(
        'gmv_paise', coalesce(sum(u.gmv_paise), 0),
        'orders', coalesce(sum(u.orders), 0)
      )
      from private.platform_usage(v_day, v_day) u
    ),
    'attention', jsonb_build_object(
      'total', v_attention -> 'total',
      'inactive_days', v_attention -> 'inactive_days',
      'groups', coalesce((
        select jsonb_agg(jsonb_build_object('group', g ->> 'group', 'count', g -> 'count'))
        from jsonb_array_elements(v_attention -> 'groups') as g
      ), '[]'::jsonb)
    ),
    'recipients', coalesce((
      select jsonb_agg(u.email order by u.email)
      from public.platform_admins a
      join auth.users u on u.id = a.user_id
      where u.email is not null and a.digest
        and a.joined_at is not null and a.disabled_at is null
        and 'money.view' = any (private.role_permissions(a.role))
    ), '[]'::jsonb)
  );
end;
$function$;

-- private.activity_kinds
CREATE OR REPLACE FUNCTION private.activity_kinds(p_kinds text[])
 RETURNS text[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_all constant text[] := array['signup', 'onboarded', 'payment', 'payment_failed', 'lapsed',
    'reminder', 'lead', 'menu_import', 'team', 'note', 'support'];
  v_kinds text[] := coalesce(p_kinds, v_all);
begin
  if not v_kinds <@ v_all then
    perform private.fail('INVALID_INPUT', 'kinds');
  end if;
  if not private.has_platform_permission('money.view') then
    v_kinds := array_remove(array_remove(v_kinds, 'payment'), 'payment_failed');
  end if;
  if not private.has_platform_permission('growth.manage') then
    v_kinds := array_remove(v_kinds, 'lead');
  end if;
  if not private.has_platform_permission('restaurants.support') then
    v_kinds := array_remove(array_remove(v_kinds, 'support'), 'menu_import');
  end if;
  if not private.has_platform_permission('audit.view') then
    v_kinds := array_remove(v_kinds, 'team');
  end if;
  return v_kinds;
end;
$function$;

-- public.auth_password_reset_start
CREATE OR REPLACE FUNCTION public.auth_password_reset_start(p_email text, p_code_hash text, p_ip_hash text DEFAULT NULL::text)
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

-- ─── The team ───────────────────────────────────────────────────────────────
-- Everyone, for the Team page: active members first, then invited, then off.
create function public.platform_list_team()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_platform_permission('team.manage');
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'user_id', a.user_id,
      'email', u.email,
      'display_name', a.display_name,
      'role', a.role,
      'invited_by', coalesce(ib.display_name, ibu.email),
      'invited_at', a.invited_at,
      'joined_at', a.joined_at,
      'disabled_at', a.disabled_at,
      'invite_expires_at', a.invite_expires_at,
      'second_factor', exists (
        select 1 from auth.mfa_factors f
        where f.user_id = a.user_id and f.factor_type = 'totp' and f.status = 'verified'
      ),
      'last_sign_in_at', u.last_sign_in_at,
      'digest', a.digest,
      'is_you', a.user_id = (select auth.uid())
    ) order by
      (a.disabled_at is not null), (a.joined_at is null),
      lower(coalesce(a.display_name, u.email)))
    from public.platform_admins a
    join auth.users u on u.id = a.user_id
    left join public.platform_admins ib on ib.user_id = a.invited_by
    left join auth.users ibu on ibu.id = a.invited_by
  ), '[]'::jsonb);
end;
$$;

-- Adds an invited member. The panel has just made their login (no password)
-- and keeps the invite link; only its hash is stored, for 7 days.
create function public.platform_invite_member(
  p_user_id uuid,
  p_display_name text,
  p_role text,
  p_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('team.manage');
  v_name text := btrim(coalesce(p_display_name, ''));
  v_email text;
  v_expires timestamptz := now() + interval '7 days';
begin
  if char_length(v_name) not between 1 and 80 then
    perform private.fail('INVALID_INPUT', 'display_name');
  end if;
  if p_role is null or p_role not in ('admin', 'finance', 'sales', 'support') then
    perform private.fail('INVALID_INPUT', 'role');
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    perform private.fail('INVALID_INPUT', 'token');
  end if;
  select u.email into v_email from auth.users u where u.id = p_user_id;
  if v_email is null then
    perform private.fail('INVALID_INPUT', 'user');
  end if;
  -- A team login is only that: never a restaurant's too.
  if exists (select 1 from public.platform_admins a where a.user_id = p_user_id)
    or exists (select 1 from public.restaurant_members m where m.user_id = p_user_id)
  then
    perform private.fail('EMAIL_TAKEN');
  end if;

  insert into public.platform_admins (
    user_id, role, display_name, invited_by, invited_at, joined_at, digest,
    invite_token_hash, invite_expires_at
  ) values (
    p_user_id, p_role, v_name, v_admin.user_id, now(), null,
    'money.view' = any(private.role_permissions(p_role)), p_token_hash, v_expires
  );
  perform private.audit_platform(v_admin, null, 'platform_admin.invited', 'platform_admin',
    p_user_id, null, jsonb_build_object('email', v_email, 'display_name', v_name, 'role', p_role));
  return jsonb_build_object('user_id', p_user_id, 'email', v_email, 'expires_at', v_expires);
end;
$$;

-- A new invite link for a member who hasn't joined; the old one stops working.
create function public.platform_renew_invite(p_user_id uuid, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('team.manage');
  v_expires timestamptz := now() + interval '7 days';
  v_user uuid;
  v_name text;
  v_role text;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    perform private.fail('INVALID_INPUT', 'token');
  end if;
  update public.platform_admins a
    set invite_token_hash = p_token_hash, invite_expires_at = v_expires
    where a.user_id = p_user_id and a.joined_at is null and a.disabled_at is null
    returning a.user_id, a.display_name, a.role into v_user, v_name, v_role;
  if v_user is null then
    perform private.fail('TEAM_MEMBER_NOT_FOUND');
  end if;
  perform private.audit_platform(v_admin, null, 'platform_admin.invite_renewed', 'platform_admin',
    p_user_id);
  return jsonb_build_object(
    'user_id', p_user_id,
    'email', (select u.email from auth.users u where u.id = p_user_id),
    'display_name', v_name,
    'role', v_role,
    'expires_at', v_expires
  );
end;
$$;

-- Role, name, the digest, and turning a member off or back on. The last
-- active Admin can't be moved or turned off, and nobody turns themselves off.
-- Turned off, their login is blocked, its sessions end and an unused invite
-- link stops working; turned back on, the login is let in again.
create function public.platform_update_member(p_user_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context;
  v_patch jsonb := coalesce(p_patch, '{}'::jsonb);
  v_old public.platform_admins;
  v_new public.platform_admins;
  v_before jsonb := '{}'::jsonb;
  v_after jsonb := '{}'::jsonb;
  v_key text;
begin
  -- One change to the team at a time, so two Admins can't each remove the other.
  perform pg_advisory_xact_lock(hashtextextended('platform_team', 0));
  v_admin := private.require_platform_permission('team.manage');
  perform private.assert_keys(v_patch, array['role', 'display_name', 'digest', 'disabled']);
  select * into v_old from public.platform_admins a where a.user_id = p_user_id for update;
  if v_old.user_id is null then
    perform private.fail('TEAM_MEMBER_NOT_FOUND');
  end if;
  v_new := v_old;

  if v_patch ? 'role' then
    v_new.role := private.json_text(v_patch, 'role');
    if v_new.role is null or v_new.role not in ('admin', 'finance', 'sales', 'support') then
      perform private.fail('INVALID_INPUT', 'role');
    end if;
  end if;
  if v_patch ? 'display_name' then
    v_new.display_name := btrim(coalesce(private.json_text(v_patch, 'display_name'), ''));
    if char_length(v_new.display_name) not between 1 and 80 then
      perform private.fail('INVALID_INPUT', 'display_name');
    end if;
  end if;
  if v_patch ? 'digest' then
    if jsonb_typeof(v_patch -> 'digest') <> 'boolean' then
      perform private.fail('INVALID_INPUT', 'digest');
    end if;
    v_new.digest := (v_patch ->> 'digest')::boolean;
  end if;
  if v_patch ? 'disabled' then
    if jsonb_typeof(v_patch -> 'disabled') <> 'boolean' then
      perform private.fail('INVALID_INPUT', 'disabled');
    end if;
    v_new.disabled_at := case
      when not (v_patch ->> 'disabled')::boolean then null
      else coalesce(v_old.disabled_at, now())
    end;
    if v_new.disabled_at is not null and p_user_id = v_admin.user_id then
      perform private.fail('TEAM_SELF');
    end if;
  end if;

  -- An active Admin stays while they're the only one.
  if v_old.role = 'admin' and v_old.joined_at is not null and v_old.disabled_at is null
    and (v_new.role <> 'admin' or v_new.disabled_at is not null)
    and not exists (
      select 1 from public.platform_admins a
      where a.user_id <> p_user_id and a.role = 'admin'
        and a.joined_at is not null and a.disabled_at is null
    )
  then
    perform private.fail('LAST_ADMIN');
  end if;

  if v_new.disabled_at is not null then
    v_new.invite_token_hash := null;
    v_new.invite_expires_at := null;
  end if;
  update public.platform_admins a set
    role = v_new.role,
    display_name = v_new.display_name,
    digest = v_new.digest,
    disabled_at = v_new.disabled_at,
    invite_token_hash = v_new.invite_token_hash,
    invite_expires_at = v_new.invite_expires_at
  where a.user_id = p_user_id;

  -- The login, in the same transaction: banned_until is what Supabase Auth's
  -- ban sets (100 years, as ban_duration '876000h'); deleting the sessions
  -- ends their refresh tokens.
  if v_old.disabled_at is null and v_new.disabled_at is not null then
    update auth.users u set banned_until = now() + interval '100 years' where u.id = p_user_id;
    delete from auth.sessions s where s.user_id = p_user_id;
  elsif v_old.disabled_at is not null and v_new.disabled_at is null then
    update auth.users u set banned_until = null where u.id = p_user_id;
  end if;

  foreach v_key in array array['role', 'display_name', 'digest'] loop
    if to_jsonb(v_old) -> v_key is distinct from to_jsonb(v_new) -> v_key then
      v_before := v_before || jsonb_build_object(v_key, to_jsonb(v_old) -> v_key);
      v_after := v_after || jsonb_build_object(v_key, to_jsonb(v_new) -> v_key);
    end if;
  end loop;
  if v_before <> '{}'::jsonb then
    perform private.audit_platform(v_admin, null, 'platform_admin.updated', 'platform_admin',
      p_user_id, v_before, v_after);
  end if;
  if (v_old.disabled_at is null) <> (v_new.disabled_at is null) then
    perform private.audit_platform(v_admin, null,
      case when v_new.disabled_at is null then 'platform_admin.enabled'
        else 'platform_admin.disabled' end,
      'platform_admin', p_user_id);
  end if;

  return jsonb_build_object('user_id', p_user_id, 'disabled', v_new.disabled_at is not null);
end;
$$;

-- ─── Joining (service role: the join page) ──────────────────────────────────
create function public.platform_invite_lookup(p_token_hash text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'user_id', a.user_id,
    'email', u.email,
    'display_name', a.display_name,
    'role', a.role,
    'expired', a.invite_expires_at <= now()
  )
  from public.platform_admins a
  join auth.users u on u.id = a.user_id
  where a.invite_token_hash = p_token_hash
    and a.joined_at is null
    and a.disabled_at is null;
$$;

-- The member has set their password: they've joined, and the link is spent.
create function public.platform_invite_accept(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.platform_admins;
begin
  update public.platform_admins a
    set joined_at = now(), invite_token_hash = null, invite_expires_at = null
    where a.invite_token_hash = p_token_hash
      and a.joined_at is null
      and a.disabled_at is null
      and a.invite_expires_at > now()
    returning a.* into v_member;
  if v_member.user_id is null then
    perform private.fail('INVITE_INVALID');
  end if;
  perform private.write_audit(null, 'platform_admin', v_member.user_id, null,
    coalesce(v_member.display_name, 'Platform admin'), 'platform_admin.joined', 'platform_admin',
    v_member.user_id, null, jsonb_build_object('role', v_member.role), null);
  return jsonb_build_object('user_id', v_member.user_id);
end;
$$;

-- ─── Grants ─────────────────────────────────────────────────────────────────
revoke execute on function private.role_permissions(text) from public, anon, authenticated;
revoke execute on function private.active_admin(uuid) from public, anon, authenticated;
revoke execute on function private.member_can(uuid, text) from public, anon, authenticated;
revoke execute on function public.platform_can(text) from public, anon;
grant execute on function public.platform_can(text) to authenticated;
revoke execute on function public.platform_my_access() from public, anon;
grant execute on function public.platform_my_access() to authenticated;
revoke execute on function public.platform_list_team() from public, anon;
grant execute on function public.platform_list_team() to authenticated;
revoke execute on function public.platform_invite_member(uuid, text, text, text) from public, anon;
grant execute on function public.platform_invite_member(uuid, text, text, text) to authenticated;
revoke execute on function public.platform_renew_invite(uuid, text) from public, anon;
grant execute on function public.platform_renew_invite(uuid, text) to authenticated;
revoke execute on function public.platform_update_member(uuid, jsonb) from public, anon;
grant execute on function public.platform_update_member(uuid, jsonb) to authenticated;
revoke execute on function public.platform_invite_lookup(text) from public, anon, authenticated;
grant execute on function public.platform_invite_lookup(text) to service_role;
revoke execute on function public.platform_invite_accept(text) from public, anon, authenticated;
grant execute on function public.platform_invite_accept(text) to service_role;
