-- Platform admins need a second factor (spec §9.5, docs/DECISIONS.md P1-1, P7-1).
-- is_platform_admin() now also requires an aal2 session (password + TOTP), so
-- every policy and function built on it refuses a platform admin who has only
-- entered a password. platform_admin_status() tells login and the /super
-- guard whether to ask for the code.

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2'
    and exists (
      select 1 from public.platform_admins pa where pa.user_id = (select auth.uid())
    );
$$;

-- none: not a platform admin; mfa_required: a platform admin whose session
-- has no second factor yet; ok: a platform admin at aal2.
create or replace function public.platform_admin_status()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when not exists (
      select 1 from public.platform_admins pa where pa.user_id = (select auth.uid())
    ) then 'none'
    when coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2' then 'ok'
    else 'mfa_required'
  end;
$$;

revoke execute on function public.platform_admin_status() from public, anon;
grant execute on function public.platform_admin_status() to authenticated;

-- The platform admin calling a platform function.
create type private.platform_admin_context as (
  user_id uuid,
  email text
);

create or replace function private.current_platform_admin()
returns private.platform_admin_context
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context;
begin
  case public.platform_admin_status()
    when 'none' then perform private.fail('FORBIDDEN');
    when 'mfa_required' then perform private.fail('MFA_REQUIRED');
    else null;
  end case;
  select u.id, u.email::text into v_admin from auth.users u where u.id = (select auth.uid());
  return v_admin;
end;
$$;

-- Audit rows for platform actions. Owners can read their restaurant's audit
-- log, so the label is neutral; the platform audit viewer shows the email.
create or replace function private.audit_platform(
  p_admin private.platform_admin_context,
  p_restaurant_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_before jsonb default null,
  p_after jsonb default null,
  p_reason text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.write_audit(
    p_restaurant_id, 'platform_admin', p_admin.user_id, null, 'Platform admin',
    p_action, p_entity_type, p_entity_id, p_before, p_after, p_reason
  );
end;
$$;

revoke execute on function private.current_platform_admin() from public, anon, authenticated;
revoke execute on function private.audit_platform(
  private.platform_admin_context, uuid, text, text, uuid, jsonb, jsonb, text
) from public, anon, authenticated;
