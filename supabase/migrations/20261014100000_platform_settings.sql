-- Super-admin redesign, stop 12a (docs/SUPER_ADMIN_PLAN.md; docs/DECISIONS.md
-- SA-2, SA-4, SA-5): the platform permission check and the Platform settings
-- screen, so ending the launch offer no longer needs SQL.

-- When the setup fee discount stops applying (the day after the offer's last
-- IST day). Null: it runs until the discount is set to 0.
alter table public.platform_settings add column setup_fee_discount_ends_at timestamptz;

-- One check for every platform function and page (plan §3). Until team roles
-- (13g) every platform admin holds every permission; an unknown name is a bug.
create function private.require_platform_permission(p_permission text)
returns private.platform_admin_context
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_permission is null or not p_permission = any (array[
    'restaurants.view', 'restaurants.manage', 'restaurants.support', 'restaurants.close',
    'money.view', 'money.record', 'growth.manage', 'insights.view',
    'settings.manage', 'team.manage', 'system.view', 'audit.view'
  ]) then
    raise exception 'unknown platform permission: %', p_permission;
  end if;
  return private.current_platform_admin();
end;
$$;

create function public.platform_update_settings(p_patch jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('settings.manage');
  v_patch jsonb := coalesce(p_patch, '{}'::jsonb);
  v_old public.platform_settings;
  v_new public.platform_settings;
  v_key text;
  v_before jsonb := '{}'::jsonb;
  v_after jsonb := '{}'::jsonb;
begin
  perform private.assert_keys(v_patch, array[
    'trial_days', 'grace_days', 'setup_fee_paise', 'setup_fee_discount_paise',
    'setup_fee_discount_ends_at', 'support_phone', 'support_email'
  ]);

  select * into v_old from public.platform_settings s where s.id = 1 for update;
  v_new := v_old;

  if v_patch ? 'trial_days' then
    v_new.trial_days := private.json_int(v_patch, 'trial_days');
    if v_new.trial_days not between 1 and 365 then
      perform private.fail('INVALID_INPUT', 'trial_days');
    end if;
  end if;
  if v_patch ? 'grace_days' then
    v_new.grace_days := private.json_int(v_patch, 'grace_days');
    if v_new.grace_days not between 0 and 90 then
      perform private.fail('INVALID_INPUT', 'grace_days');
    end if;
  end if;
  if v_patch ? 'setup_fee_paise' then
    v_new.setup_fee_paise := private.json_int(v_patch, 'setup_fee_paise');
    if v_new.setup_fee_paise not between 100 and 100000000 then
      perform private.fail('INVALID_INPUT', 'setup_fee_paise');
    end if;
  end if;
  if v_patch ? 'setup_fee_discount_paise' then
    v_new.setup_fee_discount_paise := private.json_int(v_patch, 'setup_fee_discount_paise');
  end if;
  -- On the merged row, so lowering only the fee can't leave the discount above it.
  if v_new.setup_fee_discount_paise < 0 or v_new.setup_fee_discount_paise >= v_new.setup_fee_paise then
    perform private.fail('INVALID_INPUT', 'setup_fee_discount_paise');
  end if;
  if v_patch ? 'setup_fee_discount_ends_at' then
    -- A past time is allowed: it ends the offer now (SA-5).
    begin
      v_new.setup_fee_discount_ends_at := private.json_text(v_patch, 'setup_fee_discount_ends_at')::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow then
      perform private.fail('INVALID_INPUT', 'setup_fee_discount_ends_at');
    end;
  end if;
  if v_patch ? 'support_phone' then
    v_new.support_phone := private.tidy_text(private.json_text(v_patch, 'support_phone'));
    if length(v_new.support_phone) > 20 then
      perform private.fail('INVALID_INPUT', 'support_phone');
    end if;
  end if;
  if v_patch ? 'support_email' then
    v_new.support_email := private.tidy_text(private.json_text(v_patch, 'support_email'));
    if length(v_new.support_email) > 254 or v_new.support_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      perform private.fail('INVALID_INPUT', 'support_email');
    end if;
  end if;

  update public.platform_settings s
    set trial_days = v_new.trial_days,
        grace_days = v_new.grace_days,
        setup_fee_paise = v_new.setup_fee_paise,
        setup_fee_discount_paise = v_new.setup_fee_discount_paise,
        setup_fee_discount_ends_at = v_new.setup_fee_discount_ends_at,
        support_phone = v_new.support_phone,
        support_email = v_new.support_email
    where s.id = 1
    returning * into v_new;

  -- Audit only what changed.
  for v_key in select jsonb_object_keys(v_patch) loop
    if (to_jsonb(v_old) -> v_key) is distinct from (to_jsonb(v_new) -> v_key) then
      v_before := v_before || jsonb_build_object(v_key, to_jsonb(v_old) -> v_key);
      v_after := v_after || jsonb_build_object(v_key, to_jsonb(v_new) -> v_key);
    end if;
  end loop;
  if v_after <> '{}'::jsonb then
    perform private.audit_platform(
      v_admin, null, 'platform_settings.updated', 'platform_settings', null, v_before, v_after
    );
  end if;

  return to_jsonb(v_new) - 'id' - 'created_at' - 'updated_at';
end;
$$;

revoke execute on function private.require_platform_permission(text) from public, anon, authenticated;
revoke execute on function public.platform_update_settings(jsonb) from public, anon;
grant execute on function public.platform_update_settings(jsonb) to authenticated;
