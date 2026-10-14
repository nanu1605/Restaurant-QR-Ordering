-- Super-admin redesign, stop 13c (docs/SUPER_ADMIN_PLAN.md 13c; docs/DECISIONS.md
-- SA-46 to SA-52): support sessions. The restaurant owner allows MenuMesh
-- support in for 1, 4 or 24 hours; a team member then works in /admin as a
-- manager of that restaurant until the window ends. The session is not a
-- restaurant_members row: it acts as one only inside the access helpers below
-- (SA-46), so it never shows in Staff, never counts toward max_staff, can't
-- sign in with the restaurant code and can't have its password reset.

-- ─── Support sessions ───────────────────────────────────────────────────────
-- One row is one consent window, used by at most one team member (SA-47). It
-- is open while ended_at is null and now() < ends_at; in use once started.
create table public.support_sessions (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  -- 'owner': allowed in Settings. 'onboarding': the owner agreed in person
  -- while the team set the restaurant up (SA-51).
  consent text not null check (consent in ('owner', 'onboarding')),
  granted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  ends_at timestamptz not null check (ends_at > created_at),
  user_id uuid references auth.users (id) on delete set null,
  -- The name the restaurant sees, never the team member's email (SA-50).
  staff_name text check (length(staff_name) between 1 and 40),
  started_at timestamptz,
  ended_at timestamptz,
  check (num_nulls(started_at, staff_name) in (0, 2))
);
create unique index support_sessions_open_restaurant_idx
  on public.support_sessions (restaurant_id) where ended_at is null;
create unique index support_sessions_open_user_idx
  on public.support_sessions (user_id) where ended_at is null;
create index support_sessions_restaurant_idx
  on public.support_sessions (restaurant_id, created_at desc);
-- The daily cron closes the expired ones.
create index support_sessions_ends_idx on public.support_sessions (ends_at) where ended_at is null;

alter table public.support_sessions enable row level security;
revoke all on public.support_sessions from anon, authenticated;
grant select on public.support_sessions to authenticated;
create policy "owners and platform admins read support sessions" on public.support_sessions
  for select to authenticated
  using (
    restaurant_id in (select private.my_restaurant_ids('{owner}'))
    or (select public.is_platform_admin())
  );

-- Every row written in a session names it (SA-49).
alter table public.audit_logs
  add column support_session_id uuid references public.support_sessions (id) on delete set null;
create index audit_logs_support_session_idx
  on public.audit_logs (support_session_id, created_at) where support_session_id is not null;

-- ─── Who is acting ──────────────────────────────────────────────────────────
alter type private.member_context add attribute support_session_id uuid;
alter type private.import_actor add attribute support_session_id uuid;

-- The in-use session of a team member, if it is still theirs to use: unexpired,
-- not ended, they are still on the team, and it is them at the second factor.
-- With no signed-in user (the service role) the caller has already checked
-- that: only admin_create_staff passes a user id, after the page resolved the
-- session at aal2 (SA-48).
create function private.support_session_for(p_user_id uuid)
returns setof public.support_sessions
language sql
stable
security definer
set search_path = ''
as $$
  select s.*
  from public.support_sessions s
  where s.user_id = p_user_id
    and s.ended_at is null
    and s.started_at is not null
    and s.ends_at > now()
    and exists (select 1 from public.platform_admins a where a.user_id = p_user_id)
    and (
      (select auth.uid()) is null
      or ((select auth.uid()) = p_user_id
          and coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2')
    );
$$;
revoke execute on function private.support_session_for(uuid) from public, anon, authenticated;

-- A real membership wins over a support session; starting one is refused to
-- anyone who has a membership, so the two never mix (SA-48).
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

  if v_ctx.member_id is null then
    -- A session acts as a manager; member_id is the session's id, which no
    -- restaurant_members row has.
    select s.user_id, s.id, s.restaurant_id, 'manager', s.staff_name, s.id
      into v_ctx
      from private.support_session_for(p_user_id) as s;
  end if;

  if v_ctx.member_id is null or (p_roles is not null and not v_ctx.role = any (p_roles)) then
    raise exception using errcode = 'P0001', message = 'FORBIDDEN';
  end if;
  return v_ctx;
end;
$$;

-- RLS (21 table policies, storage, Realtime): a session reads what a manager
-- of its restaurant reads.
create or replace function private.my_restaurant_ids(p_roles public.member_role[] default null)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.restaurant_id
  from public.restaurant_members m
  where m.user_id = (select auth.uid())
    and m.is_active
    and (p_roles is null or m.role = any (p_roles))
  union all
  select s.restaurant_id
  from private.support_session_for((select auth.uid())) as s
  where (p_roles is null or 'manager' = any (p_roles))
    and not exists (
      select 1 from public.restaurant_members m
      where m.user_id = (select auth.uid()) and m.is_active
    );
$$;

create or replace function public.member_role(p_restaurant_id uuid)
returns public.member_role
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select m.role
      from public.restaurant_members m
      where m.restaurant_id = p_restaurant_id
        and m.user_id = (select auth.uid())
        and m.is_active),
    (select 'manager'::public.member_role
      from private.support_session_for((select auth.uid())) as s
      where s.restaurant_id = p_restaurant_id
        and not exists (
          select 1 from public.restaurant_members m
          where m.user_id = (select auth.uid()) and m.is_active
        ))
  );
$$;

-- Menu imports: the restaurant's owner or manager, a session in it, or any
-- platform admin (the /super import, as before).
create or replace function private.menu_import_actor(p_restaurant_id uuid)
returns private.import_actor
language plpgsql
stable
security definer
set search_path = ''
as $$
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

  v_admin := private.current_platform_admin();
  if not exists (select 1 from public.restaurants r where r.id = p_restaurant_id) then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;
  return row(
    p_restaurant_id, v_admin.user_id, 'platform_admin', null, 'Platform admin', null
  )::private.import_actor;
end;
$$;

-- ─── Audit ──────────────────────────────────────────────────────────────────
drop function private.write_audit(
  uuid, public.actor_type, uuid, public.member_role, text, text, text, uuid, jsonb, jsonb, text
);
create function private.write_audit(
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
  p_reason text default null,
  p_support_session_id uuid default null
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_logs (
    restaurant_id, actor_type, actor_user_id, actor_role, actor_label,
    action, entity_type, entity_id, before, after, reason, support_session_id
  )
  values (
    p_restaurant_id, p_actor_type, p_actor_user_id, p_actor_role, p_actor_label,
    p_action, p_entity_type, p_entity_id, p_before, p_after, p_reason, p_support_session_id
  )
  returning id;
$$;
revoke execute on function private.write_audit(
  uuid, public.actor_type, uuid, public.member_role, text, text, text, uuid, jsonb, jsonb, text, uuid
) from public, anon, authenticated;

-- In a session the row is the team member's, labelled for the restaurant as
-- MenuMesh support (their email shows only in /super), with the session.
create or replace function private.audit_as(
  p_ctx private.member_context,
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_before jsonb default null,
  p_after jsonb default null,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_ctx.support_session_id is not null then
    perform private.write_audit(
      p_ctx.restaurant_id, 'platform_admin', p_ctx.user_id, null, 'MenuMesh support',
      p_action, p_entity_type, p_entity_id, p_before, p_after, p_reason,
      p_ctx.support_session_id
    );
  else
    perform private.write_audit(
      p_ctx.restaurant_id, 'staff', p_ctx.user_id, p_ctx.role, p_ctx.display_name,
      p_action, p_entity_type, p_entity_id, p_before, p_after, p_reason
    );
  end if;
end;
$$;

-- Menu and table edits aren't audited for the restaurant's own staff; in a
-- session each call writes one row, so the owner sees every change (SA-49).
create function private.audit_support(
  p_ctx private.member_context,
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_after jsonb default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_ctx.support_session_id is not null then
    perform private.audit_as(p_ctx, p_action, p_entity_type, p_entity_id, null, p_after);
  end if;
end;
$$;
revoke execute on function private.audit_support(
  private.member_context, text, text, uuid, jsonb
) from public, anon, authenticated;

-- Bills, payments, live orders, Get help and the settings that move money are
-- the restaurant's own (SA-49).
create function private.refuse_in_support_session(p_ctx private.member_context)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_ctx.support_session_id is not null then
    perform private.fail('SUPPORT_REFUSED');
  end if;
end;
$$;
revoke execute on function private.refuse_in_support_session(private.member_context)
  from public, anon, authenticated;

-- ─── Consent ────────────────────────────────────────────────────────────────
-- The owner opens a window; one at a time.
create function public.admin_allow_support_access(p_hours int)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner}');
  v_id uuid;
  v_ends timestamptz;
begin
  if p_hours is null or p_hours not in (1, 4, 24) then
    perform private.fail('INVALID_INPUT', 'hours');
  end if;
  update public.support_sessions s
    set ended_at = s.ends_at
    where s.restaurant_id = v_ctx.restaurant_id and s.ended_at is null and s.ends_at <= now();
  begin
    insert into public.support_sessions (restaurant_id, consent, granted_by, ends_at)
    values (v_ctx.restaurant_id, 'owner', v_ctx.user_id, now() + make_interval(hours => p_hours))
    returning id, ends_at into v_id, v_ends;
  exception when unique_violation then
    perform private.fail('SUPPORT_ACCESS_OPEN');
  end;
  perform private.audit_as(
    v_ctx, 'support_access.allowed', 'support_session', v_id, null,
    jsonb_build_object('hours', p_hours, 'ends_at', v_ends)
  );
  return v_ends;
end;
$$;

-- The owner ends it, used or not. Nothing open: nothing to do.
create function public.admin_end_support_access()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner}');
  v_id uuid;
begin
  update public.support_sessions s
    set ended_at = least(now(), s.ends_at)
    where s.restaurant_id = v_ctx.restaurant_id and s.ended_at is null
    returning s.id into v_id;
  if v_id is not null then
    perform private.audit_as(v_ctx, 'support_access.ended', 'support_session', v_id);
  end if;
end;
$$;

-- Shared by both ways in: the name, no membership of one's own, and no other
-- session open (closing one's own that ran out).
create function private.support_start_checks(
  p_admin private.platform_admin_context,
  p_staff_name text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := private.tidy_text(p_staff_name);
begin
  if v_name is null or length(v_name) > 40 then
    perform private.fail('INVALID_INPUT', 'staff_name');
  end if;
  if exists (
    select 1 from public.restaurant_members m where m.user_id = p_admin.user_id and m.is_active
  ) then
    perform private.fail('SUPPORT_HAS_MEMBERSHIP');
  end if;
  update public.support_sessions s
    set ended_at = s.ends_at
    where s.user_id = p_admin.user_id and s.ended_at is null and s.ends_at <= now();
  if exists (
    select 1 from public.support_sessions s where s.user_id = p_admin.user_id and s.ended_at is null
  ) then
    perform private.fail('SUPPORT_SESSION_OPEN');
  end if;
  return v_name;
end;
$$;
revoke execute on function private.support_start_checks(private.platform_admin_context, text)
  from public, anon, authenticated;

-- A team member takes the restaurant's open window. The claim is one update,
-- so two can't take the same window.
create function public.platform_start_support_session(p_restaurant_id uuid, p_staff_name text)
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
  begin
    update public.support_sessions s
      set user_id = v_admin.user_id, staff_name = v_name, started_at = now()
      where s.restaurant_id = p_restaurant_id
        and s.ended_at is null
        and s.started_at is null
        and s.ends_at > now()
      returning s.* into v_session;
  exception when unique_violation then
    perform private.fail('SUPPORT_SESSION_OPEN');
  end;
  if v_session.id is null then
    if exists (
      select 1 from public.support_sessions s
      where s.restaurant_id = p_restaurant_id and s.ended_at is null and s.ends_at > now()
    ) then
      perform private.fail('SUPPORT_ACCESS_IN_USE');
    end if;
    perform private.fail('NO_SUPPORT_ACCESS');
  end if;
  perform private.audit_platform(
    v_admin, p_restaurant_id, 'support_session.started', 'support_session', v_session.id, null,
    jsonb_build_object('staff_name', v_name, 'ends_at', v_session.ends_at)
  );
  return v_session.ends_at;
end;
$$;

-- In person, while setting up a restaurant this team member has just created:
-- the owner's consent is recorded and the session starts, for 24 hours. Only
-- the first window of that restaurant, within the hour (SA-51).
create function public.platform_onboarding_support_session(
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

-- The team member ends their session, and with it the window.
create function public.platform_end_support_session()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.current_platform_admin();
  v_session public.support_sessions%rowtype;
begin
  update public.support_sessions s
    set ended_at = least(now(), s.ends_at)
    where s.user_id = v_admin.user_id and s.ended_at is null
    returning s.* into v_session;
  if v_session.id is not null then
    perform private.audit_platform(
      v_admin, v_session.restaurant_id, 'support_session.ended', 'support_session', v_session.id
    );
  end if;
end;
$$;

-- Someone leaving the team leaves their session too.
create function private.end_support_sessions_of_removed_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.support_sessions s
    set ended_at = least(now(), s.ends_at)
    where s.user_id = old.user_id and s.ended_at is null;
  return null;
end;
$$;
revoke execute on function private.end_support_sessions_of_removed_admin()
  from public, anon, authenticated;
create trigger end_support_sessions after delete on public.platform_admins
  for each row execute function private.end_support_sessions_of_removed_admin();

-- Daily cron: windows that ran out are closed (access already ended on time;
-- this only tidies them up).
create function public.support_sessions_close_expired()
returns int
language sql
security definer
set search_path = ''
as $$
  with closed as (
    update public.support_sessions s
      set ended_at = s.ends_at
      where s.ended_at is null and s.ends_at <= now()
      returning 1
  )
  select count(*)::int from closed;
$$;

revoke execute on function public.admin_allow_support_access(int) from public, anon;
revoke execute on function public.admin_end_support_access() from public, anon;
revoke execute on function public.platform_start_support_session(uuid, text) from public, anon;
revoke execute on function public.platform_onboarding_support_session(uuid, text)
  from public, anon;
revoke execute on function public.platform_end_support_session() from public, anon;
revoke execute on function public.support_sessions_close_expired()
  from public, anon, authenticated;
grant execute on function public.admin_allow_support_access(int) to authenticated;
grant execute on function public.admin_end_support_access() to authenticated;
grant execute on function public.platform_start_support_session(uuid, text) to authenticated;
grant execute on function public.platform_onboarding_support_session(uuid, text)
  to authenticated;
grant execute on function public.platform_end_support_session() to authenticated;
grant execute on function public.support_sessions_close_expired() to service_role;

-- ─── Existing functions, from their latest definitions ─────────────────────

-- Refused in a support session (SA-49).

CREATE OR REPLACE FUNCTION public.admin_generate_bill(p_session_id uuid, p_discount_type discount_type, p_discount_value bigint, p_discount_reason text, p_apply_service_charge boolean, p_expected_grand_total_paise bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_session public.table_sessions;
  v_restaurant public.restaurants;
  v_bill_id uuid;
  v_draft jsonb;
  v_totals jsonb;
  v_reason text;
  v_generated_at timestamptz := now();
  v_financial_year text;
  v_seq int;
  v_invoice_number text;
begin
  perform private.refuse_in_support_session(v_ctx);
  v_session := private.locked_session(v_ctx, p_session_id, true);
  if v_session.status <> 'open' then
    select b.id into v_bill_id
    from public.bills b
    where b.restaurant_id = v_session.restaurant_id and b.session_id = v_session.id
      and b.status = 'active';
    if v_bill_id is not null then
      perform private.fail('ALREADY_BILLED', v_bill_id::text);
    end if;
    perform private.fail('SESSION_NOT_OPEN');
  end if;

  -- Customer cancels lock the dish; hold them until the bill is written.
  perform 1
  from public.order_items oi
  where oi.restaurant_id = v_session.restaurant_id and oi.session_id = v_session.id
  for update;

  v_draft := private.bill_draft(v_session, p_discount_type, p_discount_value, p_apply_service_charge);
  if (v_draft ->> 'waiting_count')::int > 0 then
    perform private.fail('ORDERS_WAITING', v_draft ->> 'waiting_count');
  end if;
  if jsonb_array_length(v_draft -> 'lines') = 0 then
    perform private.fail('NOTHING_TO_BILL');
  end if;
  if (v_draft ->> 'waiter_required')::boolean then
    perform private.fail('WAITER_REQUIRED');
  end if;
  v_totals := v_draft -> 'totals';
  if p_expected_grand_total_paise is not null
    and (v_totals ->> 'grand_total_paise')::bigint <> p_expected_grand_total_paise
  then
    perform private.fail('BILL_CHANGED', v_totals ->> 'grand_total_paise');
  end if;
  if (v_totals ->> 'discount_paise')::bigint > 0 then
    v_reason := private.reason(p_discount_reason);
  end if;

  select * into v_restaurant from public.restaurants r where r.id = v_session.restaurant_id;
  v_financial_year := private.financial_year(v_generated_at, v_restaurant.timezone);
  insert into public.invoice_counters as c (restaurant_id, financial_year, last_seq)
  values (v_restaurant.id, v_financial_year, 1)
  on conflict (restaurant_id, financial_year) do update set last_seq = c.last_seq + 1
  returning c.last_seq into v_seq;
  -- lpad would cut a sixth digit off, so longer numbers are left as they are.
  v_invoice_number := v_restaurant.invoice_prefix || '/' || v_financial_year || '/'
    || case when v_seq < 100000 then lpad(v_seq::text, 5, '0') else v_seq::text end;

  insert into public.bills (
    restaurant_id, session_id, invoice_number, financial_year, invoice_seq, document_type,
    table_label_snapshot, waiter_id, waiter_name_snapshot, line_items, restaurant_snapshot,
    gst_mode, gst_rate_bps, prices_include_tax,
    subtotal_paise, discount_type, discount_value, discount_paise, discount_reason,
    service_charge_bps, service_charge_paise, taxable_paise, cgst_paise, sgst_paise,
    total_tax_paise, round_off_paise, grand_total_paise, generated_by, generated_at
  )
  values (
    v_restaurant.id, v_session.id, v_invoice_number, v_financial_year, v_seq,
    (v_draft ->> 'document_type')::public.document_type,
    v_session.table_label_snapshot,
    (v_draft -> 'waiter' ->> 'id')::uuid, v_draft -> 'waiter' ->> 'name',
    v_draft -> 'lines', private.restaurant_bill_snapshot(v_restaurant),
    -- The tax settings the totals were worked out with (not a second read).
    (v_draft -> 'settings' ->> 'gst_mode')::public.gst_mode,
    (v_draft -> 'settings' ->> 'gst_rate_bps')::int,
    (v_draft -> 'settings' ->> 'prices_include_tax')::boolean,
    (v_totals ->> 'subtotal_paise')::bigint,
    (v_draft ->> 'discount_type')::public.discount_type,
    (v_draft ->> 'discount_value')::bigint,
    (v_totals ->> 'discount_paise')::bigint,
    v_reason,
    (v_draft ->> 'service_charge_bps')::int,
    (v_totals ->> 'service_charge_paise')::bigint,
    (v_totals ->> 'taxable_paise')::bigint,
    (v_totals ->> 'cgst_paise')::bigint,
    (v_totals ->> 'sgst_paise')::bigint,
    (v_totals ->> 'total_tax_paise')::bigint,
    (v_totals ->> 'round_off_paise')::bigint,
    (v_totals ->> 'grand_total_paise')::bigint,
    v_ctx.user_id, v_generated_at
  )
  returning id into v_bill_id;

  update public.table_sessions
  set status = 'billed', billed_at = v_generated_at
  where id = v_session.id;
  -- The waiter is free again; assigned_waiter_id stays as history (P4-11).
  perform private.end_assignment(v_session.id, 'billed');

  perform private.audit_as(
    v_ctx, 'bill.generated', 'bill', v_bill_id, null,
    jsonb_build_object(
      'invoice_number', v_invoice_number,
      'session_id', v_session.id,
      'table', v_session.table_label_snapshot,
      'waiter_id', v_draft -> 'waiter' -> 'id',
      'subtotal_paise', v_totals -> 'subtotal_paise',
      'grand_total_paise', v_totals -> 'grand_total_paise'
    )
  );
  if v_reason is not null then
    perform private.audit_as(
      v_ctx, 'discount.applied', 'bill', v_bill_id, null,
      jsonb_build_object(
        'discount_type', v_draft -> 'discount_type',
        'discount_value', v_draft -> 'discount_value',
        'discount_paise', v_totals -> 'discount_paise'
      ),
      v_reason
    );
  end if;

  return jsonb_build_object(
    'bill_id', v_bill_id,
    'invoice_number', v_invoice_number,
    'grand_total_paise', (v_totals ->> 'grand_total_paise')::bigint
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_record_payment(p_bill_id uuid, p_payments jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_bill public.bills;
  v_row jsonb;
  v_mode text;
  v_amount bigint;
  v_reference text;
  v_rows jsonb := '[]'::jsonb;
  v_sum bigint := 0;
  v_count int;
  v_paid_at timestamptz := now();
begin
  perform private.refuse_in_support_session(v_ctx);
  select * into v_bill
  from public.bills b
  where b.id = p_bill_id and b.restaurant_id = v_ctx.restaurant_id
  for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  if v_bill.status = 'void' then
    perform private.fail('BILL_VOID');
  end if;
  if v_bill.payment_status = 'paid' then
    perform private.fail('BILL_ALREADY_PAID');
  end if;

  if jsonb_typeof(p_payments) is distinct from 'array' then
    perform private.fail('INVALID_INPUT', 'payments');
  end if;
  v_count := jsonb_array_length(p_payments);
  if v_count not between 1 and 10 then
    perform private.fail('INVALID_INPUT', 'payments');
  end if;
  if v_count > 1 and not private.has_feature(v_bill.restaurant_id, 'split_payments') then
    perform private.fail('FEATURE_NOT_IN_PLAN', 'split_payments');
  end if;

  for v_row in select value from jsonb_array_elements(p_payments) loop
    perform private.assert_keys(v_row, array['mode', 'amount_paise', 'reference']);
    v_mode := private.json_text(v_row, 'mode');
    if v_mode is null or v_mode not in ('cash', 'upi', 'card', 'other') then
      perform private.fail('INVALID_INPUT', 'mode');
    end if;
    v_amount := private.json_int(v_row, 'amount_paise');
    if v_amount < 0 or (v_amount = 0 and (v_bill.grand_total_paise > 0 or v_count > 1)) then
      perform private.fail('INVALID_INPUT', 'amount_paise');
    end if;
    v_reference := private.tidy_text(private.json_text(v_row, 'reference'));
    if length(v_reference) > 100 then
      perform private.fail('INVALID_INPUT', 'reference');
    end if;
    v_sum := v_sum + v_amount;
    v_rows := v_rows || jsonb_build_object(
      'mode', v_mode, 'amount_paise', v_amount, 'reference', v_reference
    );
  end loop;

  if v_sum <> v_bill.grand_total_paise then
    perform private.fail('PAYMENT_MISMATCH', v_bill.grand_total_paise::text);
  end if;

  insert into public.bill_payments (restaurant_id, bill_id, mode, amount_paise, reference, recorded_by, created_at)
  select v_bill.restaurant_id, v_bill.id, r.mode::public.payment_mode, r.amount_paise, r.reference,
         v_ctx.user_id, v_paid_at
  from jsonb_to_recordset(v_rows) as r(mode text, amount_paise bigint, reference text);

  update public.bills set payment_status = 'paid', paid_at = v_paid_at where id = v_bill.id;

  perform private.audit_as(
    v_ctx, 'payment.recorded', 'bill', v_bill.id,
    jsonb_build_object('payment_status', 'unpaid'),
    jsonb_build_object(
      'payment_status', 'paid',
      'invoice_number', v_bill.invoice_number,
      'grand_total_paise', v_bill.grand_total_paise,
      'payments', v_rows
    )
  );

  return jsonb_build_object('bill_id', v_bill.id, 'payment_status', 'paid', 'paid_at', v_paid_at);
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_void_bill(p_bill_id uuid, p_reason text, p_reopen boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_bill public.bills;
  v_session public.table_sessions;
  v_restaurant public.restaurants;
  v_reason text;
  v_blocker text;
  v_reopen boolean := coalesce(p_reopen, false);
  v_waiter public.waiters;
  v_restored boolean := false;
begin
  perform private.refuse_in_support_session(v_ctx);
  select * into v_bill
  from public.bills b
  where b.id = p_bill_id and b.restaurant_id = v_ctx.restaurant_id;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  v_session := private.locked_session(v_ctx, v_bill.session_id, true);
  select * into v_bill from public.bills b where b.id = p_bill_id for update;

  if v_bill.status = 'void' then
    return jsonb_build_object(
      'bill_id', v_bill.id, 'status', 'void', 'changed', false, 'reopened', false
    );
  end if;
  v_reason := private.reason(p_reason);

  select * into v_restaurant from public.restaurants r where r.id = v_bill.restaurant_id;
  if v_reopen then
    v_blocker := private.reopen_blocker(v_bill, v_session, v_restaurant.reopen_window_minutes);
    if v_blocker is not null then
      perform private.fail('REOPEN_NOT_ALLOWED', v_blocker);
    end if;
  end if;

  update public.bills
  set status = 'void', void_reason = v_reason, voided_by = v_ctx.user_id, voided_at = now()
  where id = v_bill.id;
  update public.bill_payments
  set is_void = true
  where restaurant_id = v_bill.restaurant_id and bill_id = v_bill.id;

  perform private.audit_as(
    v_ctx, 'bill.voided', 'bill', v_bill.id,
    jsonb_build_object(
      'status', v_bill.status,
      'payment_status', v_bill.payment_status,
      'invoice_number', v_bill.invoice_number,
      'grand_total_paise', v_bill.grand_total_paise
    ),
    jsonb_build_object('status', 'void', 'reopen', v_reopen),
    v_reason
  );

  if v_reopen then
    update public.table_sessions
    set status = 'open', billed_at = null,
        assigned_waiter_id = null, assigned_at = null, assigned_by = null
    where id = v_session.id;
    perform private.audit_as(
      v_ctx, 'session.reopened', 'table_session', v_session.id,
      jsonb_build_object('status', 'billed', 'invoice_number', v_bill.invoice_number),
      jsonb_build_object('status', 'open', 'table', v_session.table_label_snapshot),
      v_reason
    );

    if v_bill.waiter_id is not null then
      select * into v_waiter
      from public.waiters w
      where w.restaurant_id = v_bill.restaurant_id and w.id = v_bill.waiter_id
      for update;
      if v_waiter.is_active and v_waiter.on_duty
        and cardinality(private.waiter_open_tables(v_bill.restaurant_id, v_waiter.id, v_session.id))
          < v_restaurant.max_tables_per_waiter
      then
        perform private.start_assignment(v_ctx, v_session.id, v_waiter.id);
        v_restored := true;
        perform private.audit_as(
          v_ctx, 'waiter.assigned', 'table_session', v_session.id, null,
          jsonb_build_object(
            'waiter_id', v_waiter.id, 'waiter_name', v_waiter.full_name,
            'table', v_session.table_label_snapshot, 'via', 'reopen'
          )
        );
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'bill_id', v_bill.id,
    'status', 'void',
    'changed', true,
    'reopened', v_reopen,
    'session_id', v_session.id,
    'assigned_waiter_id', case when v_restored then v_waiter.id else null end
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_increment_print_count(p_bill_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_count int;
begin
  perform private.refuse_in_support_session(v_ctx);
  update public.bills
  set print_count = print_count + 1
  where id = p_bill_id and restaurant_id = v_ctx.restaurant_id
  returning print_count into v_count;
  if v_count is null then
    perform private.fail('NOT_FOUND');
  end if;
  return jsonb_build_object('bill_id', p_bill_id, 'print_count', v_count);
end;
$function$;

CREATE OR REPLACE FUNCTION public.staff_approve_order(p_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member('{owner,manager,waiter}');
  v_order public.orders;
  v_session public.table_sessions;
begin
  perform private.refuse_in_support_session(v_ctx);
  select * into v_order
  from public.orders o
  where o.id = p_order_id and o.restaurant_id = v_ctx.restaurant_id;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  v_session := private.locked_session(v_ctx, v_order.session_id);
  if v_session.status <> 'open' then
    perform private.fail('SESSION_NOT_OPEN');
  end if;
  select * into v_order from public.orders o where o.id = p_order_id for update;

  if v_order.status = 'accepted' then
    return jsonb_build_object('order_id', v_order.id, 'status', v_order.status, 'changed', false);
  end if;
  if v_order.status <> 'pending_approval' then
    perform private.fail('ORDER_NOT_PENDING');
  end if;

  update public.orders
  set status = 'accepted', decided_by = v_ctx.user_id, decided_at = now()
  where id = v_order.id;
  if not v_session.is_approved then
    update public.table_sessions
    set is_approved = true, approved_by = v_ctx.user_id, approved_at = now()
    where id = v_session.id;
  end if;

  perform private.audit_as(
    v_ctx, 'order.approved', 'order', v_order.id,
    jsonb_build_object('status', v_order.status),
    jsonb_build_object('status', 'accepted', 'round_number', v_order.round_number)
  );
  return jsonb_build_object('order_id', v_order.id, 'status', 'accepted', 'changed', true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.staff_reject_order(p_order_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member('{owner,manager,waiter}');
  v_reason text := private.reason(p_reason);
  v_order public.orders;
  v_session public.table_sessions;
  v_cancelled int;
begin
  perform private.refuse_in_support_session(v_ctx);
  select * into v_order
  from public.orders o
  where o.id = p_order_id and o.restaurant_id = v_ctx.restaurant_id;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  v_session := private.locked_session(v_ctx, v_order.session_id);
  if v_session.status <> 'open' then
    perform private.fail('SESSION_NOT_OPEN');
  end if;
  select * into v_order from public.orders o where o.id = p_order_id for update;

  if v_order.status = 'rejected' then
    return jsonb_build_object('order_id', v_order.id, 'status', v_order.status, 'changed', false);
  end if;
  if v_order.status <> 'pending_approval' then
    perform private.fail('ORDER_NOT_PENDING');
  end if;

  update public.orders
  set status = 'rejected', decided_by = v_ctx.user_id, decided_at = now(), reject_reason = v_reason
  where id = v_order.id;
  update public.order_items
  set status = 'cancelled', cancelled_at = now(),
      status_changed_at = now(), status_changed_by = v_ctx.user_id
  where restaurant_id = v_order.restaurant_id and session_id = v_order.session_id
    and order_id = v_order.id and status = 'placed';
  get diagnostics v_cancelled = row_count;

  perform private.audit_as(
    v_ctx, 'order.rejected', 'order', v_order.id,
    jsonb_build_object('status', v_order.status),
    jsonb_build_object(
      'status', 'rejected', 'round_number', v_order.round_number, 'cancelled_items', v_cancelled
    ),
    v_reason
  );
  return jsonb_build_object('order_id', v_order.id, 'status', 'rejected', 'changed', true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.staff_update_item_status(p_order_item_id uuid, p_status order_item_status)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member();
  v_item public.order_items;
  v_order public.orders;
  v_session public.table_sessions;
begin
  perform private.refuse_in_support_session(v_ctx);
  if p_status is null or p_status not in ('preparing', 'ready', 'served') then
    perform private.fail('INVALID_INPUT', 'status');
  end if;
  select * into v_item
  from public.order_items oi
  where oi.id = p_order_item_id and oi.restaurant_id = v_ctx.restaurant_id;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  v_session := private.locked_session(v_ctx, v_item.session_id);
  if v_session.status <> 'open' then
    perform private.fail('SESSION_NOT_OPEN');
  end if;
  select * into v_order from public.orders o where o.id = v_item.order_id;
  if v_order.status <> 'accepted' then
    perform private.fail('ORDER_NOT_ACCEPTED');
  end if;
  select * into v_item from public.order_items oi where oi.id = p_order_item_id for update;
  if v_item.status in ('cancelled', 'removed') then
    perform private.fail('ITEM_NOT_ACTIVE');
  end if;

  if private.item_step(p_status) = private.item_step(v_item.status) then
    return jsonb_build_object('order_item_id', v_item.id, 'status', v_item.status, 'changed', false);
  end if;
  if private.item_step(p_status) < private.item_step(v_item.status) then
    perform private.fail('INVALID_STATUS_CHANGE', v_item.status::text);
  end if;

  update public.order_items
  set status = p_status,
      status_changed_at = now(),
      status_changed_by = v_ctx.user_id,
      served_at = case when p_status = 'served' then now() else served_at end,
      served_by = case when p_status = 'served' then v_ctx.user_id else served_by end
  where id = v_item.id;
  return jsonb_build_object('order_item_id', v_item.id, 'status', p_status, 'changed', true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.staff_mark_order_served(p_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member();
  v_order public.orders;
  v_session public.table_sessions;
  v_served int;
begin
  perform private.refuse_in_support_session(v_ctx);
  select * into v_order
  from public.orders o
  where o.id = p_order_id and o.restaurant_id = v_ctx.restaurant_id;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  v_session := private.locked_session(v_ctx, v_order.session_id);
  if v_session.status <> 'open' then
    perform private.fail('SESSION_NOT_OPEN');
  end if;
  select * into v_order from public.orders o where o.id = p_order_id for update;
  if v_order.status <> 'accepted' then
    perform private.fail('ORDER_NOT_ACCEPTED');
  end if;

  perform 1 from public.order_items oi
  where oi.restaurant_id = v_order.restaurant_id and oi.session_id = v_order.session_id
    and oi.order_id = v_order.id and oi.status in ('placed', 'preparing', 'ready')
  order by oi.id
  for update;
  update public.order_items
  set status = 'served', served_at = now(), served_by = v_ctx.user_id,
      status_changed_at = now(), status_changed_by = v_ctx.user_id
  where restaurant_id = v_order.restaurant_id and session_id = v_order.session_id
    and order_id = v_order.id and status in ('placed', 'preparing', 'ready');
  get diagnostics v_served = row_count;

  return jsonb_build_object('order_id', v_order.id, 'served', v_served);
end;
$function$;

CREATE OR REPLACE FUNCTION public.staff_revert_item_status(p_order_item_id uuid, p_from_status order_item_status)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_item public.order_items;
  v_order public.orders;
  v_session public.table_sessions;
  v_previous public.order_item_status;
begin
  perform private.refuse_in_support_session(v_ctx);
  if p_from_status is null then
    perform private.fail('INVALID_INPUT', 'from_status');
  end if;
  select * into v_item
  from public.order_items oi
  where oi.id = p_order_item_id and oi.restaurant_id = v_ctx.restaurant_id;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  v_session := private.locked_session(v_ctx, v_item.session_id);
  if v_session.status <> 'open' then
    perform private.fail('SESSION_NOT_OPEN');
  end if;
  select * into v_order from public.orders o where o.id = v_item.order_id;
  if v_order.status <> 'accepted' then
    perform private.fail('ORDER_NOT_ACCEPTED');
  end if;
  select * into v_item from public.order_items oi where oi.id = p_order_item_id for update;
  if v_item.status in ('cancelled', 'removed') then
    perform private.fail('ITEM_NOT_ACTIVE');
  end if;
  -- Someone already moved it (a double tap, or another manager): nothing to do.
  if v_item.status <> p_from_status then
    return jsonb_build_object('order_item_id', v_item.id, 'status', v_item.status, 'changed', false);
  end if;
  if v_item.status = 'placed' then
    perform private.fail('INVALID_STATUS_CHANGE', v_item.status::text);
  end if;

  v_previous := case v_item.status
    when 'preparing' then 'placed'
    when 'ready' then 'preparing'
    else 'ready'
  end;
  update public.order_items
  set status = v_previous,
      status_changed_at = now(),
      status_changed_by = v_ctx.user_id,
      served_at = case when v_item.status = 'served' then null else served_at end,
      served_by = case when v_item.status = 'served' then null else served_by end
  where id = v_item.id;

  perform private.audit_as(
    v_ctx, 'order_item.status_reverted', 'order_item', v_item.id,
    jsonb_build_object('status', v_item.status),
    jsonb_build_object('status', v_previous)
  );
  return jsonb_build_object('order_item_id', v_item.id, 'status', v_previous, 'changed', true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.staff_place_order(p_dining_table_id uuid, p_items jsonb, p_idempotency_key text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member();
  v_note text := private.tidy_text(p_note);
  v_table public.dining_tables;
  v_restaurant public.restaurants;
  v_order public.orders;
  v_session public.table_sessions;
  v_waiter public.waiters;
  v_lines jsonb;
  v_assigned uuid;
begin
  perform private.refuse_in_support_session(v_ctx);
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{8,100}$' then
    perform private.fail('INVALID_INPUT', 'idempotency_key');
  end if;

  select * into v_table
  from public.dining_tables t
  where t.id = p_dining_table_id and t.restaurant_id = v_ctx.restaurant_id and t.is_active
  for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;

  -- A retried submit gets back its round; the key only replays for the same
  -- staff member at the same table (docs/DECISIONS.md P4-15).
  select * into v_order
  from public.orders o
  where o.restaurant_id = v_table.restaurant_id and o.idempotency_key = p_idempotency_key;
  if found then
    select * into v_session from public.table_sessions s where s.id = v_order.session_id;
    if v_order.placed_via <> 'staff'
       or v_order.placed_by_user_id is distinct from v_ctx.user_id
       or v_session.dining_table_id <> v_table.id then
      perform private.fail('INVALID_INPUT', 'idempotency_key');
    end if;
    return jsonb_build_object(
      'order_id', v_order.id,
      'session_id', v_order.session_id,
      'round_number', v_order.round_number,
      'status', v_order.status,
      'replayed', true,
      'assigned_waiter_id', v_session.assigned_waiter_id
    );
  end if;

  if (select a.state from public.restaurant_access(v_table.restaurant_id) a) is distinct from 'full' then
    perform private.fail('ORDERING_UNAVAILABLE');
  end if;
  select * into v_restaurant from public.restaurants r where r.id = v_table.restaurant_id;

  v_lines := private.parse_order_lines(p_items, v_note);
  perform private.assert_orderable(v_table.restaurant_id, v_lines);

  select * into v_session
  from public.table_sessions s
  where s.dining_table_id = v_table.id and s.status = 'open'
  for update;
  if not found then
    insert into public.table_sessions (
      restaurant_id, dining_table_id, table_label_snapshot, is_approved, approved_by, approved_at
    )
    values (v_table.restaurant_id, v_table.id, v_table.label, true, v_ctx.user_id, now())
    returning * into v_session;
  elsif not v_session.is_approved then
    -- Staff at the table vouch for it; rounds already waiting stay with staff.
    update public.table_sessions
    set is_approved = true, approved_by = v_ctx.user_id, approved_at = now()
    where id = v_session.id
    returning * into v_session;
  end if;

  begin
    insert into public.orders (
      restaurant_id, session_id, round_number, status, placed_via,
      placed_by_user_id, idempotency_key, customer_note
    )
    values (
      v_table.restaurant_id,
      v_session.id,
      (select coalesce(max(o.round_number), 0) + 1 from public.orders o where o.session_id = v_session.id),
      'accepted',
      'staff',
      v_ctx.user_id,
      p_idempotency_key,
      v_note
    )
    returning * into v_order;
  exception when unique_violation then
    perform private.fail('INVALID_INPUT', 'idempotency_key');
  end;

  perform private.insert_order_items(v_table.restaurant_id, v_order.id, v_session.id, v_lines);

  v_assigned := v_session.assigned_waiter_id;
  if v_assigned is null then
    select * into v_waiter
    from public.waiters w
    where w.restaurant_id = v_table.restaurant_id
      and w.member_id = v_ctx.member_id
      and w.is_active and w.on_duty
    for update;
    if found
       and cardinality(private.waiter_open_tables(v_table.restaurant_id, v_waiter.id, v_session.id))
         < v_restaurant.max_tables_per_waiter then
      perform private.start_assignment(v_ctx, v_session.id, v_waiter.id);
      v_assigned := v_waiter.id;
      perform private.audit_as(
        v_ctx, 'waiter.assigned', 'table_session', v_session.id,
        null,
        jsonb_build_object(
          'waiter_id', v_waiter.id, 'waiter_name', v_waiter.full_name,
          'table', v_table.label, 'auto', true
        )
      );
    end if;
  end if;

  return jsonb_build_object(
    'order_id', v_order.id,
    'session_id', v_session.id,
    'round_number', v_order.round_number,
    'status', v_order.status,
    'replayed', false,
    'assigned_waiter_id', v_assigned
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.staff_remove_item(p_order_item_id uuid, p_quantity integer, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member();
  v_reason text := private.reason(p_reason);
  v_item public.order_items;
  v_order public.orders;
  v_session public.table_sessions;
  v_staff_may_remove_served boolean;
  v_status public.order_item_status;
  v_quantity int;
begin
  perform private.refuse_in_support_session(v_ctx);
  if p_quantity is null or p_quantity < 1 then
    perform private.fail('INVALID_INPUT', 'quantity');
  end if;
  select * into v_item
  from public.order_items oi
  where oi.id = p_order_item_id and oi.restaurant_id = v_ctx.restaurant_id;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  v_session := private.locked_session(v_ctx, v_item.session_id);
  if v_session.status <> 'open' then
    perform private.fail('SESSION_NOT_OPEN');
  end if;
  select * into v_order from public.orders o where o.id = v_item.order_id;
  if v_order.status not in ('pending_approval', 'accepted') then
    perform private.fail('ORDER_NOT_ACTIVE');
  end if;
  select * into v_item from public.order_items oi where oi.id = p_order_item_id for update;
  if v_item.status in ('cancelled', 'removed') then
    perform private.fail('ITEM_NOT_ACTIVE');
  end if;
  if p_quantity > v_item.quantity then
    perform private.fail('INVALID_INPUT', 'quantity');
  end if;
  if v_item.status = 'served' and v_ctx.role not in ('owner', 'manager') then
    select r.staff_can_remove_served_items into v_staff_may_remove_served
    from public.restaurants r where r.id = v_ctx.restaurant_id;
    if not v_staff_may_remove_served then
      perform private.fail('REQUIRES_MANAGER');
    end if;
  end if;

  if p_quantity < v_item.quantity then
    v_status := v_item.status;
    v_quantity := v_item.quantity - p_quantity;
    update public.order_items set quantity = v_quantity where id = v_item.id;
  else
    v_status := 'removed';
    v_quantity := v_item.quantity;
    update public.order_items
    set status = 'removed', removed_at = now(), removed_by = v_ctx.user_id, removed_reason = v_reason,
        status_changed_at = now(), status_changed_by = v_ctx.user_id
    where id = v_item.id;
  end if;

  perform private.audit_as(
    v_ctx, 'order_item.removed', 'order_item', v_item.id,
    jsonb_build_object(
      'name', v_item.item_name_snapshot, 'variant', v_item.variant_name_snapshot,
      'status', v_item.status, 'quantity', v_item.quantity
    ),
    jsonb_build_object('status', v_status, 'quantity', v_quantity, 'removed_quantity', p_quantity),
    v_reason
  );
  return jsonb_build_object('order_item_id', v_item.id, 'status', v_status, 'quantity', v_quantity);
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_remove_order(p_order_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_reason text := private.reason(p_reason);
  v_order public.orders;
  v_session public.table_sessions;
  v_items jsonb;
  v_removed int;
begin
  perform private.refuse_in_support_session(v_ctx);
  select * into v_order
  from public.orders o
  where o.id = p_order_id and o.restaurant_id = v_ctx.restaurant_id;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  v_session := private.locked_session(v_ctx, v_order.session_id);
  if v_session.status <> 'open' then
    perform private.fail('SESSION_NOT_OPEN');
  end if;
  select * into v_order from public.orders o where o.id = p_order_id for update;
  if v_order.status not in ('pending_approval', 'accepted') then
    perform private.fail('ORDER_NOT_ACTIVE');
  end if;

  perform 1 from public.order_items oi
  where oi.restaurant_id = v_order.restaurant_id and oi.session_id = v_order.session_id
    and oi.order_id = v_order.id
  order by oi.id
  for update;
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id', oi.id, 'name', oi.item_name_snapshot, 'variant', oi.variant_name_snapshot,
             'quantity', oi.quantity, 'status', oi.status
           )
           order by oi.created_at, oi.item_name_snapshot, oi.id
         ), '[]'::jsonb)
  into v_items
  from public.order_items oi
  where oi.restaurant_id = v_order.restaurant_id and oi.session_id = v_order.session_id
    and oi.order_id = v_order.id and oi.status not in ('cancelled', 'removed');

  update public.order_items
  set status = 'removed', removed_at = now(), removed_by = v_ctx.user_id, removed_reason = v_reason,
      status_changed_at = now(), status_changed_by = v_ctx.user_id
  where restaurant_id = v_order.restaurant_id and session_id = v_order.session_id
    and order_id = v_order.id and status not in ('cancelled', 'removed');
  get diagnostics v_removed = row_count;
  update public.orders
  set status = 'removed', removed_by = v_ctx.user_id, removed_at = now(), removed_reason = v_reason
  where id = v_order.id;

  perform private.audit_as(
    v_ctx, 'order.removed', 'order', v_order.id,
    jsonb_build_object('status', v_order.status, 'round_number', v_order.round_number, 'items', v_items),
    jsonb_build_object('status', 'removed', 'removed_items', v_removed),
    v_reason
  );
  return jsonb_build_object('order_id', v_order.id, 'status', 'removed', 'removed_items', v_removed);
end;
$function$;

CREATE OR REPLACE FUNCTION public.staff_close_session_unbilled(p_session_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member('{owner,manager,waiter}');
  v_reason text := private.reason(p_reason);
  v_session public.table_sessions;
  v_cancelled int;
begin
  perform private.refuse_in_support_session(v_ctx);
  v_session := private.locked_session(v_ctx, p_session_id, true);
  if v_session.status <> 'open' then
    perform private.fail('SESSION_NOT_OPEN');
  end if;
  if v_ctx.role not in ('owner', 'manager') and exists (
    select 1
    from public.order_items oi
    join public.orders o on o.restaurant_id = oi.restaurant_id and o.id = oi.order_id
    where oi.restaurant_id = v_session.restaurant_id and oi.session_id = v_session.id
      and o.status = 'accepted'
      and oi.status in ('placed', 'preparing', 'ready', 'served')
  ) then
    perform private.fail('REQUIRES_MANAGER');
  end if;

  update public.order_items
  set status = 'cancelled', cancelled_at = now(),
      status_changed_at = now(), status_changed_by = v_ctx.user_id
  where restaurant_id = v_session.restaurant_id and session_id = v_session.id
    and status in ('placed', 'preparing', 'ready');
  get diagnostics v_cancelled = row_count;

  perform private.end_assignment(v_session.id, 'closed_unbilled');
  -- assigned_waiter_id stays as history; availability only counts open
  -- sessions (docs/DECISIONS.md P4-11).
  update public.table_sessions
  set status = 'closed_unbilled', closed_at = now(), closed_by = v_ctx.user_id, close_reason = v_reason
  where id = v_session.id;

  perform private.audit_as(
    v_ctx, 'session.closed_unbilled', 'table_session', v_session.id,
    jsonb_build_object(
      'status', v_session.status, 'table', v_session.table_label_snapshot,
      'assigned_waiter_id', v_session.assigned_waiter_id
    ),
    jsonb_build_object('status', 'closed_unbilled', 'cancelled_items', v_cancelled),
    v_reason
  );
  return jsonb_build_object(
    'session_id', v_session.id, 'status', 'closed_unbilled', 'cancelled_items', v_cancelled
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.staff_move_session(p_session_id uuid, p_target_table_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member('{owner,manager,waiter}');
  v_source uuid;
  v_target public.dining_tables;
  v_session public.table_sessions;
begin
  perform private.refuse_in_support_session(v_ctx);
  select s.dining_table_id into v_source
  from public.table_sessions s
  where s.id = p_session_id and s.restaurant_id = v_ctx.restaurant_id;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;

  perform 1
  from public.dining_tables t
  where t.restaurant_id = v_ctx.restaurant_id and t.id in (v_source, p_target_table_id)
  order by t.id
  for update;

  select * into v_target
  from public.dining_tables t
  where t.id = p_target_table_id and t.restaurant_id = v_ctx.restaurant_id and t.is_active;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;

  select * into v_session from public.table_sessions s where s.id = p_session_id for update;
  if v_session.status <> 'open' or v_session.dining_table_id <> v_source then
    perform private.fail('SESSION_NOT_OPEN');
  end if;
  if v_target.id = v_source or exists (
    select 1 from public.table_sessions s
    where s.dining_table_id = v_target.id and s.status = 'open'
  ) then
    perform private.fail('TABLE_BUSY', v_target.label);
  end if;

  update public.table_sessions
  set dining_table_id = v_target.id, table_label_snapshot = v_target.label
  where id = v_session.id;

  update public.service_requests r
  set status = 'resolved', resolved_at = now(), resolved_by = v_ctx.user_id
  where r.dining_table_id = v_source
    and r.status <> 'resolved'
    and exists (
      select 1 from public.service_requests t
      where t.dining_table_id = v_target.id and t.type = r.type and t.status <> 'resolved'
    );
  update public.service_requests r
  set dining_table_id = v_target.id
  where r.dining_table_id = v_source and r.status <> 'resolved';

  perform private.audit_as(
    v_ctx, 'session.moved', 'table_session', v_session.id,
    jsonb_build_object('table', v_session.table_label_snapshot, 'dining_table_id', v_source),
    jsonb_build_object('table', v_target.label, 'dining_table_id', v_target.id)
  );

  return jsonb_build_object('session_id', v_session.id, 'table_id', v_target.id, 'table', v_target.label);
end;
$function$;

CREATE OR REPLACE FUNCTION public.staff_update_service_request(p_request_id uuid, p_status text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member('{owner,manager,waiter}');
  v_status public.service_request_status;
  v_request public.service_requests;
begin
  perform private.refuse_in_support_session(v_ctx);
  if p_status is null or p_status not in ('acknowledged', 'resolved') then
    perform private.fail('INVALID_INPUT', 'status');
  end if;
  v_status := p_status::public.service_request_status;

  select * into v_request
  from public.service_requests r
  where r.id = p_request_id and r.restaurant_id = v_ctx.restaurant_id
  for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  if v_request.status = 'resolved' or v_request.status = v_status then
    return jsonb_build_object('id', v_request.id, 'status', v_request.status, 'changed', false);
  end if;

  update public.service_requests r
  set status = v_status,
      acknowledged_by = case when v_status = 'acknowledged' then v_ctx.user_id else r.acknowledged_by end,
      acknowledged_at = case when v_status = 'acknowledged' then now() else r.acknowledged_at end,
      resolved_by = case when v_status = 'resolved' then v_ctx.user_id end,
      resolved_at = case when v_status = 'resolved' then now() end
  where r.id = v_request.id
  returning * into v_request;

  return jsonb_build_object('id', v_request.id, 'status', v_request.status, 'changed', true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_assign_waiter(p_session_id uuid, p_waiter_id uuid, p_force boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_session public.table_sessions;
  v_waiter public.waiters;
  v_previous public.waiters;
  v_busy text[];
  v_max int;
  v_order public.orders;
  v_approved int := 0;
begin
  perform private.refuse_in_support_session(v_ctx);
  v_session := private.locked_session(v_ctx, p_session_id);
  if v_session.status <> 'open' then
    perform private.fail('SESSION_NOT_OPEN');
  end if;
  select * into v_waiter
  from public.waiters w
  where w.id = p_waiter_id and w.restaurant_id = v_ctx.restaurant_id
  for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  if not v_waiter.is_active or not v_waiter.on_duty then
    perform private.fail('WAITER_NOT_AVAILABLE', v_waiter.full_name);
  end if;
  if v_session.assigned_waiter_id = v_waiter.id then
    return jsonb_build_object(
      'session_id', v_session.id, 'waiter_id', v_waiter.id, 'changed', false, 'approved_orders', 0
    );
  end if;

  select r.max_tables_per_waiter into v_max from public.restaurants r where r.id = v_ctx.restaurant_id;
  v_busy := private.waiter_open_tables(v_ctx.restaurant_id, v_waiter.id, v_session.id);
  if cardinality(v_busy) >= v_max and not coalesce(p_force, false) then
    perform private.fail('WAITER_BUSY', array_to_string(v_busy, ', '));
  end if;

  if v_session.assigned_waiter_id is not null then
    select * into v_previous from public.waiters w where w.id = v_session.assigned_waiter_id;
    perform private.end_assignment(v_session.id, 'reassigned');
  end if;
  perform private.start_assignment(v_ctx, v_session.id, v_waiter.id);

  for v_order in
    select * from public.orders o
    where o.restaurant_id = v_session.restaurant_id and o.session_id = v_session.id
      and private.is_waiting(o)
    order by o.round_number
    for update
  loop
    update public.orders
    set status = 'accepted', decided_by = v_ctx.user_id, decided_at = now()
    where id = v_order.id;
    perform private.audit_as(
      v_ctx, 'order.approved', 'order', v_order.id,
      jsonb_build_object('status', v_order.status),
      jsonb_build_object('status', 'accepted', 'round_number', v_order.round_number, 'via', 'assignment')
    );
    v_approved := v_approved + 1;
  end loop;
  if v_approved > 0 and not v_session.is_approved then
    update public.table_sessions
    set is_approved = true, approved_by = v_ctx.user_id, approved_at = now()
    where id = v_session.id;
  end if;

  perform private.audit_as(
    v_ctx,
    case when v_previous.id is null then 'waiter.assigned' else 'waiter.reassigned' end,
    'table_session', v_session.id,
    case when v_previous.id is null then null
      else jsonb_build_object('waiter_id', v_previous.id, 'waiter_name', v_previous.full_name)
    end,
    jsonb_build_object(
      'waiter_id', v_waiter.id, 'waiter_name', v_waiter.full_name,
      'table', v_session.table_label_snapshot,
      'forced', cardinality(v_busy) >= v_max
    )
  );
  return jsonb_build_object(
    'session_id', v_session.id, 'waiter_id', v_waiter.id, 'changed', true,
    'approved_orders', v_approved
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_unassign_waiter(p_session_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_session public.table_sessions;
  v_waiter public.waiters;
begin
  perform private.refuse_in_support_session(v_ctx);
  v_session := private.locked_session(v_ctx, p_session_id);
  if v_session.status <> 'open' then
    perform private.fail('SESSION_NOT_OPEN');
  end if;
  if v_session.assigned_waiter_id is null then
    return jsonb_build_object('session_id', v_session.id, 'changed', false);
  end if;

  select * into v_waiter from public.waiters w where w.id = v_session.assigned_waiter_id;
  perform private.end_assignment(v_session.id, 'manual');
  update public.table_sessions
  set assigned_waiter_id = null, assigned_at = null, assigned_by = null
  where id = v_session.id;

  perform private.audit_as(
    v_ctx, 'waiter.unassigned', 'table_session', v_session.id,
    jsonb_build_object('waiter_id', v_waiter.id, 'waiter_name', v_waiter.full_name),
    jsonb_build_object('waiter_id', null, 'table', v_session.table_label_snapshot)
  );
  return jsonb_build_object('session_id', v_session.id, 'changed', true);
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_start_screenshot_upload(p_extension text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_path text;
begin
  perform private.refuse_in_support_session(v_ctx);
  if p_extension is null or p_extension not in ('png', 'jpg', 'webp') then
    perform private.fail('INVALID_INPUT', 'extension');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('support_screenshot:' || v_ctx.restaurant_id, 0));
  delete from public.support_screenshot_uploads u
  where u.restaurant_id = v_ctx.restaurant_id and u.created_at < now() - interval '1 day';
  if (
    select count(*) from public.support_screenshot_uploads u
    where u.restaurant_id = v_ctx.restaurant_id and u.created_at > now() - interval '1 hour'
  ) >= 20 then
    perform private.fail('RATE_LIMITED');
  end if;
  v_path := v_ctx.restaurant_id || '/' || gen_random_uuid() || '.' || p_extension;
  insert into public.support_screenshot_uploads (restaurant_id, path)
  values (v_ctx.restaurant_id, v_path);
  return v_path;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_create_support_request(p_request jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_request jsonb := coalesce(p_request, '{}'::jsonb);
  v_context jsonb;
  v_topic text;
  v_message text;
  v_method text;
  v_contact text;
  v_path text;
  v_id uuid;
begin
  perform private.refuse_in_support_session(v_ctx);
  perform private.assert_keys(v_request,
    array['topic', 'message', 'contact_method', 'contact', 'screenshot_path', 'context']);
  v_topic := private.json_text(v_request, 'topic');
  v_message := nullif(btrim(coalesce(private.json_text(v_request, 'message'), '')), '');
  v_method := private.json_text(v_request, 'contact_method');
  v_contact := nullif(btrim(coalesce(private.json_text(v_request, 'contact'), '')), '');
  v_path := private.json_text(v_request, 'screenshot_path');
  v_context := coalesce(v_request -> 'context', '{}'::jsonb);

  if v_topic is null
    or v_topic not in ('billing', 'menu', 'printing', 'orders_tables', 'staff', 'other') then
    perform private.fail('INVALID_INPUT', 'topic');
  end if;
  if v_message is null or length(v_message) > 2000 then
    perform private.fail('INVALID_INPUT', 'message');
  end if;
  if v_method is null or v_method not in ('call', 'whatsapp', 'email') then
    perform private.fail('INVALID_INPUT', 'contact_method');
  end if;
  if v_contact is null
    -- A plain address: nothing a mailto link would read as more of the email.
    or (v_method = 'email' and (length(v_contact) > 254
      or v_contact !~ '^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$'))
    or (v_method <> 'email' and v_contact !~ '^[0-9]{10}$') then
    perform private.fail('INVALID_INPUT', 'contact');
  end if;
  -- Uploaded first, to this restaurant's folder, through a link the server signed.
  if v_path is not null and (
    v_path !~ ('^' || v_ctx.restaurant_id || '/[0-9a-f-]{36}\.(png|jpg|webp)$')
    or not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'support-screenshots' and o.name = v_path
    )
  ) then
    perform private.fail('INVALID_INPUT', 'screenshot_path');
  end if;
  -- Read by the server, not typed: the page, the app's version, the browser.
  if jsonb_typeof(v_context) <> 'object' then
    perform private.fail('INVALID_INPUT', 'context');
  end if;
  perform private.assert_keys(v_context, array['page', 'app_version', 'browser']);
  v_context := jsonb_strip_nulls(jsonb_build_object(
    'page', left(private.json_text(v_context, 'page'), 200),
    'app_version', left(private.json_text(v_context, 'app_version'), 40),
    'browser', left(private.json_text(v_context, 'browser'), 300)
  ));

  -- One at a time per restaurant, so concurrent requests can't all pass the count.
  perform pg_advisory_xact_lock(hashtextextended('support_request:' || v_ctx.restaurant_id, 0));
  if (
    select count(*) from public.support_requests q
    where q.restaurant_id = v_ctx.restaurant_id and q.created_at > now() - interval '1 hour'
  ) >= 10 then
    perform private.fail('RATE_LIMITED');
  end if;

  insert into public.support_requests (
    restaurant_id, created_by, created_by_name, created_by_role, topic, message,
    screenshot_path, contact_method, contact, context
  )
  values (
    v_ctx.restaurant_id, v_ctx.user_id, v_ctx.display_name, v_ctx.role, v_topic, v_message,
    v_path, v_method, v_contact, v_context
  )
  returning id into v_id;
  return v_id;
end;
$function$;

-- Audited in a support session, one row per call (SA-49).

CREATE OR REPLACE FUNCTION public.admin_create_category(p_name text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_name text := private.tidy_text(p_name);
  v_id uuid;
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  if v_name is null or length(v_name) > 60 then
    perform private.fail('INVALID_CATEGORY_NAME');
  end if;

  begin
    insert into public.menu_categories (restaurant_id, name, sort_order, source)
    values (
      v_ctx.restaurant_id,
      v_name,
      (select coalesce(max(c.sort_order), 0) + 1
         from public.menu_categories c where c.restaurant_id = v_ctx.restaurant_id),
      'manual'
    )
    returning id into v_id;
  exception when unique_violation then
    perform private.fail('CATEGORY_NAME_TAKEN', v_name);
  end;
  perform private.audit_support(
    v_ctx, 'menu_category.created', 'menu_category', v_id,
    jsonb_build_object('name', v_name)
  );
  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_update_category(p_category_id uuid, p_patch jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_name text;
  v_name_hi text;
  v_active boolean;
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  perform private.assert_keys(p_patch, array['name', 'name_hi', 'is_active']);

  if p_patch ? 'name' then
    v_name := private.tidy_text(private.json_text(p_patch, 'name'));
    if v_name is null or length(v_name) > 60 then
      perform private.fail('INVALID_CATEGORY_NAME');
    end if;
  end if;
  v_name_hi := private.tidy_text(private.json_text(p_patch, 'name_hi'));
  if length(v_name_hi) > 60 then
    perform private.fail('INVALID_INPUT', 'name_hi');
  end if;
  if p_patch ? 'is_active' then
    v_active := private.json_bool(p_patch, 'is_active');
  end if;

  begin
    update public.menu_categories c
      set name = coalesce(v_name, c.name),
          name_hi = case when p_patch ? 'name_hi' then v_name_hi else c.name_hi end,
          is_active = coalesce(v_active, c.is_active)
      where c.id = p_category_id and c.restaurant_id = v_ctx.restaurant_id;
  exception when unique_violation then
    perform private.fail('CATEGORY_NAME_TAKEN', v_name);
  end;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  perform private.audit_support(
    v_ctx, 'menu_category.updated', 'menu_category', p_category_id,
    (select jsonb_build_object('name', c.name) from public.menu_categories c
      where c.id = p_category_id) || p_patch
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_delete_category(p_category_id uuid, p_move_to uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_base int;
  v_moved int := 0;
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  perform 1 from public.menu_categories c
    where c.id = p_category_id and c.restaurant_id = v_ctx.restaurant_id
    for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;

  if exists (
    select 1 from public.menu_items i
    where i.restaurant_id = v_ctx.restaurant_id and i.category_id = p_category_id
  ) then
    if p_move_to is null then
      perform private.fail('CATEGORY_NOT_EMPTY');
    end if;
    if p_move_to = p_category_id or not exists (
      select 1 from public.menu_categories c
      where c.id = p_move_to and c.restaurant_id = v_ctx.restaurant_id
    ) then
      perform private.fail('NOT_FOUND', 'move_to');
    end if;

    select coalesce(max(i.sort_order), 0) into v_base
      from public.menu_items i
      where i.restaurant_id = v_ctx.restaurant_id and i.category_id = p_move_to;

    update public.menu_items i
      set category_id = p_move_to, sort_order = v_base + s.rn
      from (
        select m.id, row_number() over (order by m.sort_order, m.created_at) as rn
        from public.menu_items m
        where m.restaurant_id = v_ctx.restaurant_id and m.category_id = p_category_id
      ) as s
      where i.id = s.id;
    get diagnostics v_moved = row_count;
  end if;

  perform private.audit_support(
    v_ctx, 'menu_category.deleted', 'menu_category', p_category_id,
    (select jsonb_build_object('name', c.name, 'items_moved', v_moved)
      from public.menu_categories c where c.id = p_category_id)
  );
  delete from public.menu_categories c where c.id = p_category_id;
  return v_moved;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_add_categories(p_names text[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_base int;
  v_added int;
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  if p_names is null or cardinality(p_names) > 50 then
    perform private.fail('INVALID_INPUT');
  end if;

  select coalesce(max(c.sort_order), 0) into v_base
    from public.menu_categories c where c.restaurant_id = v_ctx.restaurant_id;

  begin
    insert into public.menu_categories (restaurant_id, name, sort_order, source)
    select v_ctx.restaurant_id, n.name, v_base + row_number() over (order by n.ord), 'default'
    from (
      select distinct on (private.normalize_name(t.name)) private.tidy_text(t.name) as name, t.ord
      from unnest(p_names) with ordinality as t(name, ord)
      where private.tidy_text(t.name) is not null and length(private.tidy_text(t.name)) <= 60
      order by private.normalize_name(t.name), t.ord
    ) as n
    where not exists (
      select 1 from public.menu_categories c
      where c.restaurant_id = v_ctx.restaurant_id
        and private.normalize_name(c.name) = private.normalize_name(n.name)
    );
    get diagnostics v_added = row_count;
  exception when unique_violation then
    perform private.fail('CATEGORY_NAME_TAKEN');
  end;
  perform private.audit_support(
    v_ctx, 'menu_category.added', 'menu_category', null,
    jsonb_build_object('count', v_added)
  );
  return v_added;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_reorder(p_kind text, p_ids uuid[], p_category_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_n int := coalesce(cardinality(p_ids), 0);
  v_found int;
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  if v_n = 0 or v_n > 500 or (select count(distinct x) from unnest(p_ids) as x) <> v_n then
    perform private.fail('INVALID_INPUT');
  end if;

  case p_kind
    when 'categories' then
      select count(*) into v_found from public.menu_categories c
        where c.restaurant_id = v_ctx.restaurant_id and c.id = any (p_ids);
      if v_found <> v_n then
        perform private.fail('NOT_FOUND');
      end if;
      update public.menu_categories c
        set sort_order = o.ord
        from (
          select t.id, t.ord::int as ord from unnest(p_ids) with ordinality as t(id, ord)
          union all
          select r.id, (v_n + row_number() over (order by r.sort_order, r.created_at))::int
          from public.menu_categories r
          where r.restaurant_id = v_ctx.restaurant_id and r.id <> all (p_ids)
        ) as o
        where c.id = o.id and c.sort_order is distinct from o.ord;

    when 'items' then
      if p_category_id is null then
        perform private.fail('INVALID_INPUT', 'category_id');
      end if;
      select count(*) into v_found from public.menu_items i
        where i.restaurant_id = v_ctx.restaurant_id
          and i.category_id = p_category_id
          and i.id = any (p_ids);
      if v_found <> v_n then
        perform private.fail('NOT_FOUND');
      end if;
      update public.menu_items i
        set sort_order = o.ord
        from (
          select t.id, t.ord::int as ord from unnest(p_ids) with ordinality as t(id, ord)
          union all
          select r.id, (v_n + row_number() over (order by r.sort_order, r.created_at))::int
          from public.menu_items r
          where r.restaurant_id = v_ctx.restaurant_id
            and r.category_id = p_category_id
            and r.id <> all (p_ids)
        ) as o
        where i.id = o.id and i.sort_order is distinct from o.ord;

    when 'tables' then
      -- Table locks in id order, like staff_move_session, so the two never deadlock.
      perform 1 from public.dining_tables d
        where d.restaurant_id = v_ctx.restaurant_id
        order by d.id
        for update;
      select count(*) into v_found from public.dining_tables d
        where d.restaurant_id = v_ctx.restaurant_id and d.id = any (p_ids);
      if v_found <> v_n then
        perform private.fail('NOT_FOUND');
      end if;
      update public.dining_tables d
        set sort_order = o.ord
        from (
          select t.id, t.ord::int as ord from unnest(p_ids) with ordinality as t(id, ord)
          union all
          select r.id, (v_n + row_number() over (order by r.sort_order, r.created_at))::int
          from public.dining_tables r
          where r.restaurant_id = v_ctx.restaurant_id and r.id <> all (p_ids)
        ) as o
        where d.id = o.id and d.sort_order is distinct from o.ord;

    else
      perform private.fail('INVALID_INPUT', 'kind');
  end case;
  perform private.audit_support(
    v_ctx, 'menu.reordered', null, null,
    jsonb_build_object('kind', p_kind, 'count', v_n)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_save_menu_item(p_item jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_id uuid;
  v_existing public.menu_items%rowtype;
  v_is_new boolean;
  v_category_id uuid;
  v_name text;
  v_name_hi text;
  v_description text;
  v_food_type public.food_type;
  v_price bigint;
  v_available boolean := true;
  v_image text;
  v_variants jsonb;
  v_variant jsonb;
  v_ord bigint;
  v_variant_names text[] := '{}';
  v_variant_prices bigint[] := '{}';
  v_variant_ids uuid[] := '{}';
  v_keep_ids uuid[] := '{}';
  v_vname text;
  v_vprice bigint;
  v_vid uuid;
  v_group_ids uuid[];
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  perform private.assert_keys(p_item, array[
    'id', 'category_id', 'name', 'name_hi', 'description', 'food_type', 'price_paise',
    'is_available', 'image_path', 'variants', 'addon_group_ids'
  ]);

  -- Which item?
  if jsonb_typeof(p_item -> 'id') = 'string' then
    v_id := private.json_uuid(p_item, 'id');
    select * into v_existing from public.menu_items i where i.id = v_id for update;
    if found and v_existing.restaurant_id <> v_ctx.restaurant_id then
      perform private.fail('NOT_FOUND');
    end if;
    v_is_new := not found;
  else
    v_id := gen_random_uuid();
    v_is_new := true;
  end if;

  -- Fields.
  v_category_id := private.json_uuid(p_item, 'category_id');
  if not exists (
    select 1 from public.menu_categories c
    where c.id = v_category_id and c.restaurant_id = v_ctx.restaurant_id
  ) then
    perform private.fail('NOT_FOUND', 'category_id');
  end if;

  v_name := private.tidy_text(private.json_text(p_item, 'name'));
  if v_name is null or length(v_name) > 80 then
    perform private.fail('INVALID_ITEM_NAME');
  end if;

  v_name_hi := private.tidy_text(private.json_text(p_item, 'name_hi'));
  if length(v_name_hi) > 80 then
    perform private.fail('INVALID_INPUT', 'name_hi');
  end if;

  v_description := nullif(btrim(private.json_text(p_item, 'description')), '');
  if length(v_description) > 300 then
    perform private.fail('INVALID_INPUT', 'description');
  end if;

  if private.json_text(p_item, 'food_type') is null
     or not (p_item ->> 'food_type') = any (enum_range(null::public.food_type)::text[]) then
    perform private.fail('INVALID_INPUT', 'food_type');
  end if;
  v_food_type := (p_item ->> 'food_type')::public.food_type;

  if p_item ? 'is_available' then
    v_available := private.json_bool(p_item, 'is_available');
  end if;

  v_image := private.json_text(p_item, 'image_path');
  if v_image is not null
     and v_image !~ ('^' || v_ctx.restaurant_id::text || '/[A-Za-z0-9._-]{1,100}$') then
    perform private.fail('INVALID_IMAGE_PATH');
  end if;

  -- Variants (validated before anything is written).
  v_variants := coalesce(p_item -> 'variants', '[]'::jsonb);
  if jsonb_typeof(v_variants) <> 'array' or jsonb_array_length(v_variants) > 20 then
    perform private.fail('INVALID_INPUT', 'variants');
  end if;

  for v_variant in select value from jsonb_array_elements(v_variants) loop
    perform private.assert_keys(v_variant, array['id', 'name', 'price_paise']);
    v_vname := private.tidy_text(private.json_text(v_variant, 'name'));
    if v_vname is null or length(v_vname) > 40 then
      perform private.fail('INVALID_VARIANT_NAME');
    end if;
    if private.normalize_name(v_vname) = any (v_variant_names) then
      perform private.fail('VARIANT_NAME_DUPLICATE', v_vname);
    end if;
    v_vprice := private.json_int(v_variant, 'price_paise');
    perform private.assert_price(v_vprice, 'variants');
    v_variant_names := v_variant_names || private.normalize_name(v_vname);
    v_variant_prices := v_variant_prices || v_vprice;
    if jsonb_typeof(v_variant -> 'id') = 'string' then
      v_vid := private.json_uuid(v_variant, 'id');
      if v_is_new or not exists (
        select 1 from public.menu_item_variants mv
        where mv.id = v_vid and mv.menu_item_id = v_id and mv.restaurant_id = v_ctx.restaurant_id
      ) then
        perform private.fail('NOT_FOUND', 'variants');
      end if;
    end if;
  end loop;

  -- Add-on groups: only when given, so callers that don't know about them
  -- (quick edits, the menu import) leave the dish's groups as they are.
  if p_item ? 'addon_group_ids' then
    v_group_ids := private.json_uuid_array(p_item -> 'addon_group_ids', 'addon_group_ids', 10);
    if (select count(*) from public.menu_addon_groups g
        where g.restaurant_id = v_ctx.restaurant_id and g.id = any (v_group_ids))
       <> cardinality(v_group_ids) then
      perform private.fail('NOT_FOUND', 'addon_group_ids');
    end if;
  end if;

  if cardinality(v_variant_prices) > 0 then
    select min(x) into v_price from unnest(v_variant_prices) as x;
  else
    v_price := private.json_int(p_item, 'price_paise');
    perform private.assert_price(v_price, 'price_paise');
  end if;

  -- Write the item.
  if v_is_new then
    insert into public.menu_items (
      id, restaurant_id, category_id, name, name_hi, description, price_paise, food_type,
      image_path, is_available, sort_order
    )
    values (
      v_id, v_ctx.restaurant_id, v_category_id, v_name, v_name_hi, v_description, v_price,
      v_food_type, v_image, v_available,
      (select coalesce(max(i.sort_order), 0) + 1 from public.menu_items i
        where i.restaurant_id = v_ctx.restaurant_id and i.category_id = v_category_id)
    );
  else
    update public.menu_items i
      set category_id = v_category_id,
          name = v_name,
          name_hi = case when p_item ? 'name_hi' then v_name_hi else i.name_hi end,
          description = v_description,
          price_paise = v_price,
          food_type = v_food_type,
          image_path = v_image,
          is_available = v_available,
          sort_order = case
            when i.category_id = v_category_id then i.sort_order
            else (select coalesce(max(m.sort_order), 0) + 1 from public.menu_items m
                   where m.restaurant_id = v_ctx.restaurant_id and m.category_id = v_category_id)
          end
      where i.id = v_id;
  end if;

  -- Sync variants in the given order.
  for v_variant, v_ord in select value, ordinality from jsonb_array_elements(v_variants) with ordinality loop
    v_vname := private.tidy_text(v_variant ->> 'name');
    v_vprice := (v_variant ->> 'price_paise')::bigint;
    if jsonb_typeof(v_variant -> 'id') = 'string' then
      v_vid := (v_variant ->> 'id')::uuid;
      update public.menu_item_variants mv
        set name = v_vname, price_paise = v_vprice, sort_order = v_ord, is_active = true
        where mv.id = v_vid;
    else
      insert into public.menu_item_variants (restaurant_id, menu_item_id, name, price_paise, sort_order)
      values (v_ctx.restaurant_id, v_id, v_vname, v_vprice, v_ord)
      returning id into v_vid;
    end if;
    v_keep_ids := v_keep_ids || v_vid;
  end loop;

  update public.menu_item_variants mv
    set is_active = false
    where mv.restaurant_id = v_ctx.restaurant_id
      and mv.menu_item_id = v_id
      and mv.is_active
      and mv.id <> all (v_keep_ids);

  if v_group_ids is not null then
    delete from public.menu_item_addon_groups l
      where l.restaurant_id = v_ctx.restaurant_id
        and l.menu_item_id = v_id
        and l.group_id <> all (v_group_ids);
    insert into public.menu_item_addon_groups (restaurant_id, menu_item_id, group_id)
      select v_ctx.restaurant_id, v_id, g from unnest(v_group_ids) as g
      on conflict do nothing;
  end if;

  perform private.audit_support(
    v_ctx, case when v_is_new then 'menu_item.created' else 'menu_item.updated' end, 'menu_item', v_id,
    jsonb_build_object('name', v_name)
  );
  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_update_menu_item(p_item_id uuid, p_patch jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_price bigint;
  v_active boolean;
  v_image text;
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  perform private.assert_keys(p_patch, array['price_paise', 'is_active', 'image_path']);

  perform 1 from public.menu_items i
    where i.id = p_item_id and i.restaurant_id = v_ctx.restaurant_id
    for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;

  if p_patch ? 'price_paise' then
    v_price := private.json_int(p_patch, 'price_paise');
    perform private.assert_price(v_price, 'price_paise');
    if exists (
      select 1 from public.menu_item_variants mv
      where mv.menu_item_id = p_item_id and mv.is_active
    ) then
      perform private.fail('ITEM_HAS_VARIANTS');
    end if;
  end if;
  if p_patch ? 'is_active' then
    v_active := private.json_bool(p_patch, 'is_active');
  end if;
  if p_patch ? 'image_path' then
    v_image := private.json_text(p_patch, 'image_path');
    if v_image is not null
       and v_image !~ ('^' || v_ctx.restaurant_id::text || '/[A-Za-z0-9._-]{1,100}$') then
      perform private.fail('INVALID_IMAGE_PATH');
    end if;
  end if;

  update public.menu_items i
    set price_paise = coalesce(v_price, i.price_paise),
        is_active = coalesce(v_active, i.is_active),
        image_path = case when p_patch ? 'image_path' then v_image else i.image_path end
    where i.id = p_item_id;
  perform private.audit_support(
    v_ctx, 'menu_item.updated', 'menu_item', p_item_id,
    (select jsonb_build_object('name', i.name) from public.menu_items i
      where i.id = p_item_id) || p_patch
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_save_addon_group(p_group jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_id uuid;
  v_name text;
  v_min bigint;
  v_max bigint;
  v_addons jsonb;
  v_addon jsonb;
  v_ord bigint;
  v_names text[] := '{}';
  v_seen_ids uuid[] := '{}';
  v_keep_ids uuid[] := '{}';
  v_aname text;
  v_aprice bigint;
  v_aid uuid;
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  perform private.assert_keys(p_group, array['id', 'name', 'min_select', 'max_select', 'addons']);

  if jsonb_typeof(p_group -> 'id') = 'string' then
    v_id := private.json_uuid(p_group, 'id');
    perform 1 from public.menu_addon_groups g
      where g.id = v_id and g.restaurant_id = v_ctx.restaurant_id
      for update;
    if not found then
      perform private.fail('NOT_FOUND');
    end if;
  end if;

  v_name := private.tidy_text(private.json_text(p_group, 'name'));
  if v_name is null or length(v_name) > 60 then
    perform private.fail('INVALID_ADDON_GROUP_NAME');
  end if;

  v_addons := p_group -> 'addons';
  if jsonb_typeof(v_addons) is distinct from 'array' then
    perform private.fail('INVALID_INPUT', 'addons');
  end if;
  if jsonb_array_length(v_addons) not between 1 and 30 then
    perform private.fail('INVALID_INPUT', 'addons');
  end if;

  v_min := private.json_int(p_group, 'min_select');
  v_max := private.json_int(p_group, 'max_select');
  if v_max not between 1 and 20 then
    perform private.fail('INVALID_INPUT', 'max_select');
  end if;
  -- Customers must be able to make the required choices.
  if v_min not between 0 and least(v_max, jsonb_array_length(v_addons)) then
    perform private.fail('INVALID_INPUT', 'min_select');
  end if;

  -- Options (validated before anything is written).
  for v_addon in select value from jsonb_array_elements(v_addons) loop
    perform private.assert_keys(v_addon, array['id', 'name', 'price_paise', 'is_available']);
    v_aname := private.tidy_text(private.json_text(v_addon, 'name'));
    if v_aname is null or length(v_aname) > 40 then
      perform private.fail('INVALID_ADDON_NAME');
    end if;
    if private.normalize_name(v_aname) = any (v_names) then
      perform private.fail('ADDON_NAME_DUPLICATE', v_aname);
    end if;
    v_names := v_names || private.normalize_name(v_aname);
    perform private.assert_price(private.json_int(v_addon, 'price_paise'), 'addons');
    if v_addon ? 'is_available' then
      perform private.json_bool(v_addon, 'is_available');
    end if;
    if jsonb_typeof(v_addon -> 'id') = 'string' then
      v_aid := private.json_uuid(v_addon, 'id');
      -- Twice would save fewer options than the list (and min_select) counts.
      if v_aid = any (v_seen_ids) then
        perform private.fail('INVALID_INPUT', 'addons');
      end if;
      v_seen_ids := v_seen_ids || v_aid;
      if v_id is null or not exists (
        select 1 from public.menu_addons a
        where a.id = v_aid and a.group_id = v_id and a.restaurant_id = v_ctx.restaurant_id
      ) then
        perform private.fail('NOT_FOUND', 'addons');
      end if;
    end if;
  end loop;

  begin
    if v_id is null then
      insert into public.menu_addon_groups (restaurant_id, name, min_select, max_select)
      values (v_ctx.restaurant_id, v_name, v_min, v_max)
      returning id into v_id;
    else
      update public.menu_addon_groups g
        set name = v_name, min_select = v_min, max_select = v_max
        where g.id = v_id;
    end if;
  exception when unique_violation then
    perform private.fail('ADDON_GROUP_NAME_DUPLICATE', v_name);
  end;

  -- Sync options in the given order.
  for v_addon, v_ord in
    select value, ordinality from jsonb_array_elements(v_addons) with ordinality
  loop
    v_aname := private.tidy_text(v_addon ->> 'name');
    v_aprice := (v_addon ->> 'price_paise')::bigint;
    if jsonb_typeof(v_addon -> 'id') = 'string' then
      v_aid := (v_addon ->> 'id')::uuid;
      update public.menu_addons a
        set name = v_aname,
            price_paise = v_aprice,
            sort_order = v_ord,
            is_available = coalesce((v_addon ->> 'is_available')::boolean, a.is_available)
        where a.id = v_aid;
    else
      insert into public.menu_addons (restaurant_id, group_id, name, price_paise, is_available, sort_order)
      values (
        v_ctx.restaurant_id, v_id, v_aname, v_aprice,
        coalesce((v_addon ->> 'is_available')::boolean, true), v_ord
      )
      returning id into v_aid;
    end if;
    v_keep_ids := v_keep_ids || v_aid;
  end loop;

  delete from public.menu_addons a
    where a.restaurant_id = v_ctx.restaurant_id and a.group_id = v_id and a.id <> all (v_keep_ids);

  perform private.audit_support(
    v_ctx, 'addon_group.saved', 'menu_addon_group', v_id,
    jsonb_build_object('name', v_name)
  );
  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_delete_addon_group(p_group_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  perform private.audit_support(
    v_ctx, 'addon_group.deleted', 'menu_addon_group', p_group_id,
    (select jsonb_build_object('name', g.name) from public.menu_addon_groups g
      where g.id = p_group_id and g.restaurant_id = v_ctx.restaurant_id)
  );
  delete from public.menu_addon_groups g
    where g.id = p_group_id and g.restaurant_id = v_ctx.restaurant_id;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.staff_set_item_availability(p_item_id uuid, p_available boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member();
begin
  if p_available is null then
    perform private.fail('INVALID_INPUT', 'available');
  end if;
  update public.menu_items i
    set is_available = p_available
    where i.id = p_item_id and i.restaurant_id = v_ctx.restaurant_id;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  perform private.audit_support(
    v_ctx, 'menu_item.availability', 'menu_item', p_item_id,
    (select jsonb_build_object('name', i.name, 'is_available', p_available)
      from public.menu_items i where i.id = p_item_id)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.staff_set_addon_availability(p_addon_id uuid, p_available boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member();
begin
  if p_available is null then
    perform private.fail('INVALID_INPUT', 'available');
  end if;
  update public.menu_addons a
    set is_available = p_available
    where a.id = p_addon_id and a.restaurant_id = v_ctx.restaurant_id;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  perform private.audit_support(
    v_ctx, 'addon.availability', 'menu_addon', p_addon_id,
    (select jsonb_build_object('name', x.name, 'is_available', p_available)
      from public.menu_addons x where x.id = p_addon_id)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_create_tables(p_labels text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_n int := coalesce(cardinality(p_labels), 0);
  v_labels text[];
  v_taken text;
  v_max_tables int;
  v_max_staff int;
  v_active int;
  v_base int;
  v_result jsonb;
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  if v_n = 0 or v_n > 100 then
    perform private.fail('INVALID_INPUT', 'labels');
  end if;

  -- Serialise limit checks for this restaurant.
  perform 1 from public.restaurants r where r.id = v_ctx.restaurant_id for update;

  select array_agg(private.tidy_text(t.label) order by t.ord)
    into v_labels
    from unnest(p_labels) with ordinality as t(label, ord);
  if exists (select 1 from unnest(v_labels) as l where l is null or length(l) > 30) then
    perform private.fail('INVALID_TABLE_LABEL');
  end if;
  if (select count(distinct lower(l)) from unnest(v_labels) as l) <> v_n then
    perform private.fail('TABLE_LABEL_DUPLICATE');
  end if;

  select d.label into v_taken
    from public.dining_tables d
    where d.restaurant_id = v_ctx.restaurant_id
      and d.is_active
      and lower(btrim(d.label)) in (select lower(l) from unnest(v_labels) as l)
    order by d.sort_order
    limit 1;
  if v_taken is not null then
    perform private.fail('TABLE_LABEL_TAKEN', v_taken);
  end if;

  select l.max_tables, l.max_staff into v_max_tables, v_max_staff
    from private.plan_limits(v_ctx.restaurant_id) as l;
  select count(*) into v_active
    from public.dining_tables d
    where d.restaurant_id = v_ctx.restaurant_id and d.is_active;
  if v_max_tables is not null and v_active + v_n > v_max_tables then
    perform private.fail('PLAN_LIMIT_TABLES', v_max_tables::text);
  end if;

  select coalesce(max(d.sort_order), 0) into v_base
    from public.dining_tables d where d.restaurant_id = v_ctx.restaurant_id;

  with inserted as (
    insert into public.dining_tables (restaurant_id, label, sort_order, qr_token)
    select v_ctx.restaurant_id, t.label, v_base + t.ord::int, private.random_base62(16)
    from unnest(v_labels) with ordinality as t(label, ord)
    returning id, label, sort_order
  )
  select jsonb_agg(jsonb_build_object('id', i.id, 'label', i.label) order by i.sort_order)
    into v_result
    from inserted as i;

  perform private.audit_support(
    v_ctx, 'tables.created', 'dining_table', null,
    jsonb_build_object('labels', to_jsonb(v_labels))
  );
  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_update_table(p_table_id uuid, p_patch jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_table public.dining_tables%rowtype;
  v_label text;
  v_active boolean;
  v_max_tables int;
  v_max_staff int;
  v_count int;
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  perform private.assert_keys(p_patch, array['label', 'is_active']);
  perform 1 from public.restaurants r where r.id = v_ctx.restaurant_id for no key update;

  select * into v_table from public.dining_tables d
    where d.id = p_table_id and d.restaurant_id = v_ctx.restaurant_id
    for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;

  if p_patch ? 'label' then
    v_label := private.tidy_text(private.json_text(p_patch, 'label'));
    if v_label is null or length(v_label) > 30 then
      perform private.fail('INVALID_TABLE_LABEL');
    end if;
  end if;
  if p_patch ? 'is_active' then
    v_active := private.json_bool(p_patch, 'is_active');
  end if;

  if v_active is false and v_table.is_active and exists (
    select 1 from public.table_sessions s
    where s.dining_table_id = p_table_id and s.status = 'open'
  ) then
    perform private.fail('TABLE_HAS_OPEN_SESSION');
  end if;

  if v_active is true and not v_table.is_active then
    select l.max_tables, l.max_staff into v_max_tables, v_max_staff
      from private.plan_limits(v_ctx.restaurant_id) as l;
    select count(*) into v_count
      from public.dining_tables d
      where d.restaurant_id = v_ctx.restaurant_id and d.is_active;
    if v_max_tables is not null and v_count + 1 > v_max_tables then
      perform private.fail('PLAN_LIMIT_TABLES', v_max_tables::text);
    end if;
  end if;

  begin
    update public.dining_tables d
      set label = coalesce(v_label, d.label),
          is_active = coalesce(v_active, d.is_active)
      where d.id = p_table_id;
  exception when unique_violation then
    perform private.fail('TABLE_LABEL_TAKEN', coalesce(v_label, v_table.label));
  end;
  -- A switched-off table leaves the board: its calls are finished rather than
  -- left waiting unseen (P9-1).
  if v_active is false and v_table.is_active then
    update public.service_requests r
    set status = 'resolved', resolved_at = now(), resolved_by = v_ctx.user_id
    where r.dining_table_id = p_table_id and r.status <> 'resolved';
  end if;
  perform private.audit_support(
    v_ctx, 'table.updated', 'dining_table', p_table_id,
    jsonb_build_object('label', v_table.label) || p_patch
  );
end;
$function$;

-- Settings keys, password reset, limit hits, menu import and the audit log.

CREATE OR REPLACE FUNCTION public.admin_update_settings(p_patch jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_text_keys text[] := array[
    'name', 'legal_name', 'address_line', 'city', 'state', 'pincode', 'phone', 'email',
    'logo_path', 'accent_color', 'gstin', 'fssai_license', 'invoice_prefix',
    'bill_footer_text', 'upi_vpa', 'upi_payee_name'
  ];
  v_enum_keys text[] := array['gst_mode', 'paper_width'];
  v_int_keys text[] := array[
    'gst_rate_bps', 'service_charge_bps', 'customer_cancel_window_seconds',
    'max_tables_per_waiter', 'reopen_window_minutes', 'business_day_start_hour'
  ];
  v_bool_keys text[] := array[
    'prices_include_tax', 'service_charge_enabled', 'show_upi_qr_on_bill',
    'require_first_order_approval', 'staff_can_remove_served_items', 'print_waiter_on_bill'
  ];
  v_patch jsonb := '{}';
  v_key text;
  v_value text;
  v_old public.restaurants%rowtype;
  v_new public.restaurants%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_constraint text;
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  perform private.assert_keys(p_patch, v_text_keys || v_enum_keys || v_int_keys || v_bool_keys);

  -- Type-check and normalise every key.
  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key = any (v_text_keys) then
      v_value := nullif(btrim(private.json_text(p_patch, v_key)), '');
      v_value := case v_key
        when 'name' then private.tidy_text(v_value)
        when 'gstin' then upper(v_value)
        when 'upi_vpa' then lower(v_value)
        when 'accent_color' then lower(v_value)
        else v_value
      end;
      v_patch := v_patch || jsonb_build_object(v_key, v_value);
    elsif v_key = any (v_enum_keys) then
      if private.json_text(p_patch, v_key) is null then
        perform private.fail('INVALID_INPUT', v_key);
      end if;
      v_patch := v_patch || jsonb_build_object(v_key, p_patch -> v_key);
    elsif v_key = any (v_int_keys) then
      v_patch := v_patch || jsonb_build_object(v_key, private.json_int(p_patch, v_key));
    else
      v_patch := v_patch || jsonb_build_object(v_key, private.json_bool(p_patch, v_key));
    end if;
  end loop;

  select * into v_old from public.restaurants r where r.id = v_ctx.restaurant_id for update;
  begin
    v_new := jsonb_populate_record(v_old, v_patch);
  exception when invalid_text_representation or numeric_value_out_of_range then
    perform private.fail('INVALID_INPUT');
  end;

  -- Rules beyond the column checks.
  if v_new.name is null then
    perform private.fail('INVALID_INPUT', 'name');
  end if;
  if v_new.accent_color is null or v_new.invoice_prefix is null then
    perform private.fail('INVALID_INPUT', case when v_new.accent_color is null then 'accent_color' else 'invoice_prefix' end);
  end if;
  if v_new.email is not null and v_new.email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    perform private.fail('INVALID_INPUT', 'email');
  end if;
  if v_new.logo_path is not null
     and v_new.logo_path !~ ('^' || v_ctx.restaurant_id::text || '/[A-Za-z0-9._-]{1,100}$') then
    perform private.fail('INVALID_IMAGE_PATH');
  end if;
  if v_new.show_upi_qr_on_bill then
    if not v_old.show_upi_qr_on_bill and not private.has_feature(v_ctx.restaurant_id, 'upi_qr_on_bill') then
      perform private.fail('FEATURE_NOT_IN_PLAN', 'upi_qr_on_bill');
    end if;
    if v_new.upi_vpa is null then
      perform private.fail('UPI_VPA_REQUIRED');
    end if;
  end if;

  begin
    update public.restaurants r
      set name = v_new.name,
          legal_name = v_new.legal_name,
          address_line = v_new.address_line,
          city = v_new.city,
          state = v_new.state,
          pincode = v_new.pincode,
          phone = v_new.phone,
          email = v_new.email,
          logo_path = v_new.logo_path,
          accent_color = v_new.accent_color,
          gstin = v_new.gstin,
          fssai_license = v_new.fssai_license,
          gst_mode = v_new.gst_mode,
          gst_rate_bps = v_new.gst_rate_bps,
          prices_include_tax = v_new.prices_include_tax,
          service_charge_enabled = v_new.service_charge_enabled,
          service_charge_bps = v_new.service_charge_bps,
          invoice_prefix = v_new.invoice_prefix,
          bill_footer_text = v_new.bill_footer_text,
          paper_width = v_new.paper_width,
          show_upi_qr_on_bill = v_new.show_upi_qr_on_bill,
          upi_vpa = v_new.upi_vpa,
          upi_payee_name = v_new.upi_payee_name,
          require_first_order_approval = v_new.require_first_order_approval,
          customer_cancel_window_seconds = v_new.customer_cancel_window_seconds,
          max_tables_per_waiter = v_new.max_tables_per_waiter,
          staff_can_remove_served_items = v_new.staff_can_remove_served_items,
          print_waiter_on_bill = v_new.print_waiter_on_bill,
          reopen_window_minutes = v_new.reopen_window_minutes,
          business_day_start_hour = v_new.business_day_start_hour
      where r.id = v_ctx.restaurant_id;
  exception when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    perform private.fail('INVALID_INPUT', v_constraint);
  end;

  select jsonb_object_agg(k, to_jsonb(v_old) -> k), jsonb_object_agg(k, to_jsonb(v_new) -> k)
    into v_before, v_after
    from jsonb_object_keys(v_patch) as k
    where (to_jsonb(v_old) -> k) is distinct from (to_jsonb(v_new) -> k);

  -- In a support session, what moves money stays the owner's (SA-49).
  if v_ctx.support_session_id is not null then
    select k into v_key
      from jsonb_object_keys(coalesce(v_after, '{}')) as k
      where k = any (array[
        'gst_mode', 'gst_rate_bps', 'prices_include_tax', 'service_charge_enabled',
        'service_charge_bps', 'gstin', 'fssai_license', 'legal_name', 'invoice_prefix',
        'upi_vpa', 'upi_payee_name', 'show_upi_qr_on_bill', 'reopen_window_minutes',
        'staff_can_remove_served_items', 'business_day_start_hour'
      ])
      limit 1;
    if v_key is not null then
      perform private.fail('SUPPORT_REFUSED', v_key);
    end if;
  end if;

  if v_after is not null then
    perform private.audit_as(
      v_ctx, 'settings.updated', 'restaurant', v_ctx.restaurant_id, v_before, v_after
    );
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_reset_staff_password(p_member_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_member public.restaurant_members%rowtype;
begin
  -- A session's member id is the session's: never a login to reset.
  if p_member_id = v_ctx.member_id and v_ctx.support_session_id is null then
    select * into v_member from public.restaurant_members m where m.id = p_member_id;
  else
    v_member := private.managed_member(v_ctx, p_member_id);
  end if;

  perform private.audit_as(v_ctx, 'staff.password_reset', 'restaurant_member', v_member.id);
  return v_member.user_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.member_record_plan_limit(p_code text, p_detail text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_ctx private.member_context := private.current_member();
  v_kind text := case p_code
    when 'PLAN_LIMIT_TABLES' then 'tables'
    when 'PLAN_LIMIT_STAFF' then 'staff'
    when 'FEATURE_NOT_IN_PLAN' then 'feature'
  end;
begin
  -- A session's limit hits aren't the restaurant's (no 13d upgrade signal).
  if v_ctx.support_session_id is not null then
    return;
  end if;
  if v_kind is null or (v_kind = 'feature' and coalesce(p_detail, '') !~ '^[a-z_]{1,40}$') then
    perform private.fail('INVALID_INPUT', 'code');
  end if;
  insert into public.plan_limit_events (restaurant_id, kind, feature, user_id)
  values (
    v_ctx.restaurant_id, v_kind, case when v_kind = 'feature' then p_detail end, v_ctx.user_id
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.menu_import_commit(p_import_id uuid, p_draft jsonb, p_confirm_food_types boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_import public.menu_imports := private.lock_menu_import(p_import_id);
  v_actor private.import_actor := private.menu_import_actor(v_import.restaurant_id);
  v_restaurant uuid := v_import.restaurant_id;
  v_cat jsonb;
  v_item jsonb;
  v_variant jsonb;
  v_action text;
  v_cat_name text;
  v_cat_id uuid;
  v_cat_active boolean;
  v_cat_new boolean;
  v_name text;
  v_description text;
  v_food_type text;
  v_price bigint;
  v_variants jsonb;
  v_vname text;
  v_vprice bigint;
  v_vnames text[];
  v_vprices bigint[];
  v_item_id uuid;
  v_ord bigint;
  v_categories_created int := 0;
  v_categories_shown int := 0;
  v_items_created int := 0;
  v_items_updated int := 0;
  v_items_skipped int := 0;
  v_counts jsonb;
begin
  if v_import.status = 'imported' then
    return coalesce(v_import.imported_counts, '{}'::jsonb)
      || jsonb_build_object('already_imported', true);
  end if;
  if v_import.status <> 'review' then
    perform private.fail('IMPORT_NOT_OPEN');
  end if;
  perform private.assert_full_access(v_restaurant);

  -- Shape first, so a malformed draft fails with INVALID_INPUT, not a cast error.
  if jsonb_typeof(p_draft) is distinct from 'object'
     or jsonb_typeof(p_draft -> 'categories') is distinct from 'array'
     or jsonb_array_length(p_draft -> 'categories') > 200
     or octet_length(p_draft::text) > 2000000 then
    perform private.fail('INVALID_INPUT', 'draft');
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_draft -> 'categories') as c
    where jsonb_typeof(c) <> 'object' or jsonb_typeof(c -> 'items') is distinct from 'array'
  ) or exists (
    select 1
    from jsonb_array_elements(p_draft -> 'categories') as c,
      jsonb_array_elements(c -> 'items') as i
    where jsonb_typeof(i) <> 'object'
      or (i ->> 'action') is null
      or (i ->> 'action') not in ('import', 'skip', 'update_price')
      or jsonb_typeof(coalesce(i -> 'variants', '[]'::jsonb)) <> 'array'
  ) then
    perform private.fail('INVALID_INPUT', 'draft');
  end if;

  if (
    select count(*)
    from jsonb_array_elements(p_draft -> 'categories') as c,
      jsonb_array_elements(c -> 'items') as i
    where c -> 'skip' is distinct from 'true'::jsonb and i ->> 'action' <> 'skip'
  ) > 500 then
    perform private.fail('IMPORT_TOO_LARGE');
  end if;

  if not coalesce(p_confirm_food_types, false) and exists (
    select 1
    from jsonb_array_elements(p_draft -> 'categories') as c,
      jsonb_array_elements(c -> 'items') as i
    where c -> 'skip' is distinct from 'true'::jsonb
      and i ->> 'action' = 'import'
      and coalesce(i ->> 'food_type', 'unknown') = 'unknown'
  ) then
    perform private.fail('FOOD_TYPE_UNCONFIRMED');
  end if;

  for v_cat in select value from jsonb_array_elements(p_draft -> 'categories') loop
    if v_cat -> 'skip' = 'true'::jsonb then
      v_items_skipped := v_items_skipped + jsonb_array_length(v_cat -> 'items');
      continue;
    end if;

    v_cat_id := null;
    v_cat_new := exists (
      select 1 from jsonb_array_elements(v_cat -> 'items') as i where i ->> 'action' = 'import'
    );
    -- A category is looked up for new dishes, and to show it again when the
    -- owner asked for that (even if the rows only update prices).
    if v_cat_new or v_cat -> 'show_hidden' = 'true'::jsonb then
      v_cat_name := private.tidy_text(private.json_text(v_cat, 'name'));
      if v_cat_name is null or length(v_cat_name) > 60 then
        perform private.fail('INVALID_CATEGORY_NAME', v_cat_name);
      end if;

      select c.id, c.is_active into v_cat_id, v_cat_active
        from public.menu_categories c
        where c.restaurant_id = v_restaurant
          and private.normalize_name(c.name) = private.normalize_name(v_cat_name)
        for update;
      if v_cat_id is null and not v_cat_new then
        -- Nothing new to put in it: no category is created.
        null;
      elsif v_cat_id is null then
        insert into public.menu_categories (restaurant_id, name, sort_order, source)
        values (
          v_restaurant,
          v_cat_name,
          (select coalesce(max(c.sort_order), 0) + 1
             from public.menu_categories c where c.restaurant_id = v_restaurant),
          'import'
        )
        returning id into v_cat_id;
        v_categories_created := v_categories_created + 1;
      elsif not v_cat_active and v_cat -> 'show_hidden' = 'true'::jsonb then
        update public.menu_categories c set is_active = true where c.id = v_cat_id;
        v_categories_shown := v_categories_shown + 1;
      end if;
    end if;

    for v_item in select value from jsonb_array_elements(v_cat -> 'items') loop
      v_action := v_item ->> 'action';
      if v_action = 'skip' then
        v_items_skipped := v_items_skipped + 1;
        continue;
      end if;

      -- Fields and options, checked like admin_save_menu_item.
      v_name := private.tidy_text(private.json_text(v_item, 'name'));
      if v_name is null or length(v_name) > 80 then
        perform private.fail('INVALID_ITEM_NAME', v_name);
      end if;
      v_variants := coalesce(v_item -> 'variants', '[]'::jsonb);
      if jsonb_array_length(v_variants) > 20 then
        perform private.fail('INVALID_INPUT', 'variants');
      end if;
      v_vnames := '{}';
      v_vprices := '{}';
      for v_variant in select value from jsonb_array_elements(v_variants) loop
        if jsonb_typeof(v_variant) <> 'object' then
          perform private.fail('INVALID_INPUT', 'variants');
        end if;
        v_vname := private.tidy_text(private.json_text(v_variant, 'name'));
        if v_vname is null or length(v_vname) > 40 then
          perform private.fail('INVALID_VARIANT_NAME', v_name);
        end if;
        if private.normalize_name(v_vname) = any (v_vnames) then
          perform private.fail('VARIANT_NAME_DUPLICATE', v_name);
        end if;
        v_vprice := private.json_int(v_variant, 'price_paise');
        perform private.assert_price(v_vprice, v_name);
        v_vnames := v_vnames || private.normalize_name(v_vname);
        v_vprices := v_vprices || v_vprice;
      end loop;
      if cardinality(v_vprices) > 0 then
        select min(x) into v_price from unnest(v_vprices) as x;
      else
        if jsonb_typeof(v_item -> 'price_paise') is distinct from 'number' then
          perform private.fail('INVALID_PRICE', v_name);
        end if;
        v_price := private.json_int(v_item, 'price_paise');
        perform private.assert_price(v_price, v_name);
      end if;

      if v_action = 'update_price' then
        v_item_id := private.json_uuid(v_item, 'existing_item_id');
        perform 1 from public.menu_items i
          where i.id = v_item_id and i.restaurant_id = v_restaurant and i.is_active
          for update;
        if not found then
          perform private.fail('NOT_FOUND', 'existing_item_id');
        end if;

        -- A price update only makes sense when the row and the dish have the
        -- same shape: one price, or the same option names.
        if exists (
          select 1 from public.menu_item_variants mv
          where mv.menu_item_id = v_item_id and mv.is_active
        ) then
          if cardinality(v_vnames) = 0 then
            perform private.fail('ITEM_HAS_VARIANTS', v_name);
          end if;
          if exists (
            select 1 from unnest(v_vnames) as n
            where not exists (
              select 1 from public.menu_item_variants mv
              where mv.menu_item_id = v_item_id
                and mv.is_active
                and private.normalize_name(mv.name) = n
            )
          ) then
            perform private.fail('VARIANTS_DIFFER', v_name);
          end if;

          -- Options keep their names; each one gets the new price.
          for v_variant in select value from jsonb_array_elements(v_variants) loop
            update public.menu_item_variants mv
              set price_paise = (v_variant ->> 'price_paise')::bigint
              where mv.menu_item_id = v_item_id
                and mv.is_active
                and private.normalize_name(mv.name) = private.normalize_name(v_variant ->> 'name');
          end loop;
          update public.menu_items i
            set price_paise = (
              select min(mv.price_paise) from public.menu_item_variants mv
              where mv.menu_item_id = v_item_id and mv.is_active
            )
            where i.id = v_item_id;
        else
          if cardinality(v_vnames) > 0 then
            perform private.fail('VARIANTS_DIFFER', v_name);
          end if;
          update public.menu_items i set price_paise = v_price where i.id = v_item_id;
        end if;
        v_items_updated := v_items_updated + 1;
        continue;
      end if;

      -- A new dish.
      v_description := nullif(btrim(private.json_text(v_item, 'description')), '');
      if length(v_description) > 300 then
        perform private.fail('INVALID_INPUT', 'description');
      end if;
      v_food_type := coalesce(private.json_text(v_item, 'food_type'), 'unknown');
      if v_food_type = 'unknown' then
        v_food_type := 'veg';
      elsif v_food_type not in ('veg', 'non_veg', 'egg') then
        perform private.fail('INVALID_INPUT', 'food_type');
      end if;

      insert into public.menu_items (
        restaurant_id, category_id, name, description, price_paise, food_type, sort_order
      )
      values (
        v_restaurant, v_cat_id, v_name, v_description, v_price,
        v_food_type::public.food_type,
        (select coalesce(max(i.sort_order), 0) + 1 from public.menu_items i
          where i.restaurant_id = v_restaurant and i.category_id = v_cat_id)
      )
      returning id into v_item_id;

      for v_variant, v_ord in
        select value, ordinality from jsonb_array_elements(v_variants) with ordinality
      loop
        insert into public.menu_item_variants (
          restaurant_id, menu_item_id, name, price_paise, sort_order
        )
        values (
          v_restaurant, v_item_id, private.tidy_text(v_variant ->> 'name'),
          (v_variant ->> 'price_paise')::bigint, v_ord
        );
      end loop;
      v_items_created := v_items_created + 1;
    end loop;
  end loop;

  v_counts := jsonb_build_object(
    'categories_created', v_categories_created,
    'categories_shown', v_categories_shown,
    'items_created', v_items_created,
    'items_updated', v_items_updated,
    'items_skipped', v_items_skipped
  );

  update public.menu_imports i
    set status = 'imported', draft = p_draft, imported_counts = v_counts, completed_at = now()
    where i.id = p_import_id;

  perform private.write_audit(
    v_restaurant, v_actor.actor_type, v_actor.user_id, v_actor.role, v_actor.label,
    'menu.imported', 'menu_import', p_import_id, null,
    v_counts || jsonb_build_object('source', v_import.source), null,
    v_actor.support_session_id
  );
  return v_counts;
end;
$function$;

CREATE OR REPLACE FUNCTION public.platform_list_audit(p_filters jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin private.platform_admin_context := private.current_platform_admin();
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_restaurant_id uuid;
  v_actor_type text;
  v_action text;
  v_from date;
  v_to date;
  v_page int := 1;
  v_page_size constant int := 50;
  v_total bigint;
  v_rows jsonb;
begin
  perform private.assert_keys(
    v_filters, array['restaurant_id', 'actor_type', 'action', 'from', 'to', 'page']
  );
  if coalesce(jsonb_typeof(v_filters -> 'restaurant_id'), 'null') <> 'null' then
    v_restaurant_id := private.json_uuid(v_filters, 'restaurant_id');
  end if;
  v_actor_type := private.json_text(v_filters, 'actor_type');
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
    ), '[]'::jsonb)
  into v_total, v_rows;

  return jsonb_build_object('page', v_page, 'page_size', v_page_size, 'total', v_total, 'rows', v_rows);
end;
$function$;
