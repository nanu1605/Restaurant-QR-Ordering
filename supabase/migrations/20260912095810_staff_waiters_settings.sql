-- Staff logins, waiter profiles and restaurant settings (spec §9.3, §13.3).
--
-- Role hierarchy: the owner manages managers, waiters and kitchen staff; a
-- manager manages waiters and kitchen staff. Nobody changes their own account
-- here (except resetting their own password) and the owner is never managed.
-- max_staff counts active logins other than the owner (docs/DECISIONS.md P2-2).

-- ─── Helpers ────────────────────────────────────────────────────────────────
create or replace function private.can_manage_role(
  p_actor public.member_role,
  p_target public.member_role
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case p_actor
    when 'owner' then p_target in ('manager', 'waiter', 'kitchen')
    when 'manager' then p_target in ('waiter', 'kitchen')
    else false
  end;
$$;

-- A member of the caller's restaurant whom the caller may manage (locked).
create or replace function private.managed_member(p_ctx private.member_context, p_member_id uuid)
returns public.restaurant_members
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_member public.restaurant_members%rowtype;
begin
  select * into v_member from public.restaurant_members m
    where m.id = p_member_id and m.restaurant_id = p_ctx.restaurant_id
    for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  if v_member.id = p_ctx.member_id then
    perform private.fail('CANNOT_CHANGE_SELF');
  end if;
  if not private.can_manage_role(p_ctx.role, v_member.role) then
    perform private.fail('ROLE_NOT_ALLOWED');
  end if;
  return v_member;
end;
$$;

-- Room for one more active staff login under the plan (locks the restaurant).
create or replace function private.assert_staff_capacity(p_restaurant_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_max_tables int;
  v_max_staff int;
  v_count int;
begin
  perform 1 from public.restaurants r where r.id = p_restaurant_id for update;
  select l.max_tables, l.max_staff into v_max_tables, v_max_staff
    from private.plan_limits(p_restaurant_id) as l;
  select count(*) into v_count
    from public.restaurant_members m
    where m.restaurant_id = p_restaurant_id and m.is_active and m.role <> 'owner';
  if v_max_staff is not null and v_count + 1 > v_max_staff then
    perform private.fail('PLAN_LIMIT_STAFF', v_max_staff::text);
  end if;
end;
$$;

create or replace function private.parse_staff_role(p_value text)
returns public.member_role
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_value is null or p_value not in ('manager', 'waiter', 'kitchen') then
    perform private.fail('INVALID_INPUT', 'role');
  end if;
  return p_value::public.member_role;
end;
$$;

revoke execute on function private.can_manage_role(public.member_role, public.member_role)
  from public, anon, authenticated;
revoke execute on function private.managed_member(private.member_context, uuid)
  from public, anon, authenticated;
revoke execute on function private.assert_staff_capacity(uuid) from public, anon, authenticated;
revoke execute on function private.parse_staff_role(text) from public, anon, authenticated;

-- ─── Staff logins ───────────────────────────────────────────────────────────
create or replace function public.admin_list_staff()
returns table (
  member_id uuid,
  display_name text,
  username text,
  role public.member_role,
  is_active boolean,
  last_sign_in_at timestamptz,
  created_at timestamptz,
  waiter_id uuid,
  waiter_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
begin
  return query
    select m.id, m.display_name, m.username, m.role, m.is_active, u.last_sign_in_at, m.created_at,
           w.id, w.full_name
    from public.restaurant_members m
    join auth.users u on u.id = m.user_id
    left join public.waiters w on w.member_id = m.id and w.is_active
    where m.restaurant_id = v_ctx.restaurant_id
    order by m.is_active desc,
             array_position(array['owner', 'manager', 'waiter', 'kitchen'], m.role::text),
             m.display_name;
end;
$$;

-- Called by the server after it created the auth user with the Admin API
-- (docs/DECISIONS.md P2-5); p_actor_user_id comes from the verified session.
-- p_payload: { user_id, display_name, username, role }
create or replace function public.admin_create_staff(p_actor_user_id uuid, p_payload jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.member_context_for(p_actor_user_id, '{owner,manager}');
  v_user_id uuid;
  v_name text;
  v_username text;
  v_role public.member_role;
  v_id uuid;
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  perform private.assert_keys(p_payload, array['user_id', 'display_name', 'username', 'role']);

  v_user_id := private.json_uuid(p_payload, 'user_id');
  v_name := private.tidy_text(private.json_text(p_payload, 'display_name'));
  if v_name is null or length(v_name) > 80 then
    perform private.fail('INVALID_DISPLAY_NAME');
  end if;
  v_username := lower(btrim(private.json_text(p_payload, 'username')));
  if v_username is null or v_username !~ '^[a-z0-9_]{3,30}$' then
    perform private.fail('INVALID_USERNAME');
  end if;
  v_role := private.parse_staff_role(private.json_text(p_payload, 'role'));
  if not private.can_manage_role(v_ctx.role, v_role) then
    perform private.fail('ROLE_NOT_ALLOWED');
  end if;

  if not exists (select 1 from auth.users u where u.id = v_user_id) then
    perform private.fail('USER_NOT_FOUND');
  end if;
  if exists (select 1 from public.restaurant_members m where m.user_id = v_user_id) then
    perform private.fail('USER_ALREADY_MEMBER');
  end if;
  if exists (
    select 1 from public.restaurant_members m
    where m.restaurant_id = v_ctx.restaurant_id and m.username = v_username
  ) then
    perform private.fail('USERNAME_TAKEN', v_username);
  end if;

  perform private.assert_staff_capacity(v_ctx.restaurant_id);

  insert into public.restaurant_members (restaurant_id, user_id, role, display_name, username)
  values (v_ctx.restaurant_id, v_user_id, v_role, v_name, v_username)
  returning id into v_id;

  perform private.audit_as(
    v_ctx, 'staff.created', 'restaurant_member', v_id, null,
    jsonb_build_object('display_name', v_name, 'username', v_username, 'role', v_role)
  );
  return v_id;
end;
$$;

-- p_patch: { display_name?, role? }. A login moved off the waiter role is
-- unlinked from its waiter profile.
create or replace function public.admin_update_staff(p_member_id uuid, p_patch jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_member public.restaurant_members%rowtype;
  v_name text;
  v_role public.member_role;
  v_before jsonb := '{}';
  v_after jsonb := '{}';
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  perform private.assert_keys(p_patch, array['display_name', 'role']);
  v_member := private.managed_member(v_ctx, p_member_id);

  v_name := v_member.display_name;
  if p_patch ? 'display_name' then
    v_name := private.tidy_text(private.json_text(p_patch, 'display_name'));
    if v_name is null or length(v_name) > 80 then
      perform private.fail('INVALID_DISPLAY_NAME');
    end if;
  end if;
  v_role := v_member.role;
  if p_patch ? 'role' then
    v_role := private.parse_staff_role(private.json_text(p_patch, 'role'));
    if not private.can_manage_role(v_ctx.role, v_role) then
      perform private.fail('ROLE_NOT_ALLOWED');
    end if;
  end if;

  if v_name is distinct from v_member.display_name then
    v_before := v_before || jsonb_build_object('display_name', v_member.display_name);
    v_after := v_after || jsonb_build_object('display_name', v_name);
  end if;
  if v_role is distinct from v_member.role then
    v_before := v_before || jsonb_build_object('role', v_member.role);
    v_after := v_after || jsonb_build_object('role', v_role);
  end if;
  if v_after = '{}' then
    return;
  end if;

  update public.restaurant_members m
    set display_name = v_name, role = v_role
    where m.id = v_member.id;

  if v_member.role = 'waiter' and v_role <> 'waiter' then
    update public.waiters w set member_id = null where w.member_id = v_member.id;
  end if;

  perform private.audit_as(
    v_ctx,
    case when v_after ? 'role' then 'staff.role_changed' else 'staff.updated' end,
    'restaurant_member', v_member.id, v_before, v_after
  );
end;
$$;

-- Allowed while read-only, so a restaurant can always lock out a login.
create or replace function public.admin_deactivate_staff(p_member_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_member public.restaurant_members%rowtype;
begin
  v_member := private.managed_member(v_ctx, p_member_id);
  if not v_member.is_active then
    return;
  end if;
  update public.restaurant_members m set is_active = false where m.id = v_member.id;
  perform private.audit_as(
    v_ctx, 'staff.deactivated', 'restaurant_member', v_member.id,
    jsonb_build_object('is_active', true), jsonb_build_object('is_active', false)
  );
end;
$$;

create or replace function public.admin_reactivate_staff(p_member_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_member public.restaurant_members%rowtype;
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  v_member := private.managed_member(v_ctx, p_member_id);
  if v_member.is_active then
    return;
  end if;
  perform private.assert_staff_capacity(v_ctx.restaurant_id);
  update public.restaurant_members m set is_active = true where m.id = v_member.id;
  perform private.audit_as(
    v_ctx, 'staff.reactivated', 'restaurant_member', v_member.id,
    jsonb_build_object('is_active', false), jsonb_build_object('is_active', true)
  );
end;
$$;

-- Authorises a password reset and logs it; returns the auth user id the
-- server then updates with the Admin API. Your own password is allowed too.
create or replace function public.admin_reset_staff_password(p_member_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_member public.restaurant_members%rowtype;
begin
  if p_member_id = v_ctx.member_id then
    select * into v_member from public.restaurant_members m where m.id = p_member_id;
  else
    v_member := private.managed_member(v_ctx, p_member_id);
  end if;

  perform private.audit_as(v_ctx, 'staff.password_reset', 'restaurant_member', v_member.id);
  return v_member.user_id;
end;
$$;

-- ─── Waiter profiles ────────────────────────────────────────────────────────
-- p_waiter: { id?, full_name, phone?, employee_code?, joined_on?, notes?, member_id? }
-- Every field is replaced (missing = empty). member_id links an active login
-- with the waiter role that isn't linked to another waiter.
create or replace function public.admin_upsert_waiter(p_waiter jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_existing public.waiters%rowtype;
  v_id uuid;
  v_name text;
  v_phone text;
  v_code text;
  v_joined date;
  v_notes text;
  v_member_id uuid;
  v_before jsonb;
  v_after jsonb;
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  perform private.assert_keys(p_waiter, array[
    'id', 'full_name', 'phone', 'employee_code', 'joined_on', 'notes', 'member_id'
  ]);

  if jsonb_typeof(p_waiter -> 'id') = 'string' then
    v_id := private.json_uuid(p_waiter, 'id');
    select * into v_existing from public.waiters w
      where w.id = v_id and w.restaurant_id = v_ctx.restaurant_id and w.is_active
      for update;
    if not found then
      perform private.fail('NOT_FOUND');
    end if;
  end if;

  v_name := private.tidy_text(private.json_text(p_waiter, 'full_name'));
  if v_name is null or length(v_name) > 80 then
    perform private.fail('INVALID_WAITER_NAME');
  end if;

  v_phone := nullif(regexp_replace(coalesce(private.json_text(p_waiter, 'phone'), ''), '[\s-]', '', 'g'), '');
  if v_phone is not null and v_phone !~ '^[6-9][0-9]{9}$' then
    perform private.fail('INVALID_PHONE');
  end if;

  v_code := private.tidy_text(private.json_text(p_waiter, 'employee_code'));
  if length(v_code) > 30 then
    perform private.fail('INVALID_INPUT', 'employee_code');
  end if;

  if private.json_text(p_waiter, 'joined_on') is not null then
    if (p_waiter ->> 'joined_on') !~ '^\d{4}-\d{2}-\d{2}$' then
      perform private.fail('INVALID_INPUT', 'joined_on');
    end if;
    begin
      v_joined := (p_waiter ->> 'joined_on')::date;
    exception when others then
      perform private.fail('INVALID_INPUT', 'joined_on');
    end;
  end if;

  v_notes := nullif(btrim(private.json_text(p_waiter, 'notes')), '');
  if length(v_notes) > 300 then
    perform private.fail('INVALID_INPUT', 'notes');
  end if;

  if jsonb_typeof(p_waiter -> 'member_id') = 'string' then
    v_member_id := private.json_uuid(p_waiter, 'member_id');
    if not exists (
      select 1 from public.restaurant_members m
      where m.id = v_member_id
        and m.restaurant_id = v_ctx.restaurant_id
        and m.is_active
        and m.role = 'waiter'
    ) then
      perform private.fail('LOGIN_NOT_WAITER');
    end if;
    if exists (
      select 1 from public.waiters w
      where w.member_id = v_member_id and w.id is distinct from v_id
    ) then
      perform private.fail('LOGIN_ALREADY_LINKED');
    end if;
  end if;

  begin
    if v_id is null then
      insert into public.waiters (
        restaurant_id, full_name, phone, employee_code, joined_on, notes, member_id
      )
      values (v_ctx.restaurant_id, v_name, v_phone, v_code, v_joined, v_notes, v_member_id)
      returning id into v_id;
    else
      update public.waiters w
        set full_name = v_name, phone = v_phone, employee_code = v_code,
            joined_on = v_joined, notes = v_notes, member_id = v_member_id
        where w.id = v_id;
    end if;
  exception when unique_violation then
    perform private.fail('WAITER_CODE_TAKEN', v_code);
  end;

  v_after := jsonb_build_object(
    'full_name', v_name, 'phone', v_phone, 'employee_code', v_code,
    'joined_on', v_joined, 'notes', v_notes, 'member_id', v_member_id
  );
  if v_existing.id is null then
    perform private.audit_as(v_ctx, 'waiter.created', 'waiter', v_id, null, v_after);
  else
    v_before := jsonb_build_object(
      'full_name', v_existing.full_name, 'phone', v_existing.phone,
      'employee_code', v_existing.employee_code, 'joined_on', v_existing.joined_on,
      'notes', v_existing.notes, 'member_id', v_existing.member_id
    );
    if v_before is distinct from v_after then
      perform private.audit_as(v_ctx, 'waiter.updated', 'waiter', v_id, v_before, v_after);
    end if;
  end if;
  return v_id;
end;
$$;

-- Allowed while read-only (shift changes during service).
create or replace function public.admin_set_waiter_on_duty(p_waiter_id uuid, p_on_duty boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_current boolean;
begin
  if p_on_duty is null then
    perform private.fail('INVALID_INPUT', 'on_duty');
  end if;
  select w.on_duty into v_current from public.waiters w
    where w.id = p_waiter_id and w.restaurant_id = v_ctx.restaurant_id and w.is_active
    for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  if v_current = p_on_duty then
    return;
  end if;

  update public.waiters w set on_duty = p_on_duty where w.id = p_waiter_id;
  perform private.audit_as(
    v_ctx, 'waiter.on_duty_changed', 'waiter', p_waiter_id,
    jsonb_build_object('on_duty', v_current), jsonb_build_object('on_duty', p_on_duty)
  );
end;
$$;

-- Soft delete; past bills and reports keep the name. Blocked while the waiter
-- has open tables. The linked login (if any) is unlinked so it can be reused.
create or replace function public.admin_delete_waiter(p_waiter_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_waiter public.waiters%rowtype;
  v_open text;
begin
  perform private.assert_full_access(v_ctx.restaurant_id);
  select * into v_waiter from public.waiters w
    where w.id = p_waiter_id and w.restaurant_id = v_ctx.restaurant_id and w.is_active
    for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;

  select string_agg(d.label, ', ' order by d.sort_order) into v_open
    from public.table_sessions s
    join public.dining_tables d on d.id = s.dining_table_id
    where s.restaurant_id = v_ctx.restaurant_id
      and s.assigned_waiter_id = p_waiter_id
      and s.status = 'open';
  if v_open is not null then
    perform private.fail('WAITER_HAS_OPEN_TABLES', v_open);
  end if;

  update public.waiters w
    set is_active = false, on_duty = false, member_id = null,
        deleted_at = now(), deleted_by = v_ctx.user_id
    where w.id = p_waiter_id;

  perform private.audit_as(
    v_ctx, 'waiter.deleted', 'waiter', p_waiter_id,
    jsonb_build_object('full_name', v_waiter.full_name, 'member_id', v_waiter.member_id), null
  );
end;
$$;

-- Waiters section list: status (open tables), linked login and tables
-- attended during the current business day.
create or replace function public.admin_waiters_overview()
returns table (
  waiter_id uuid,
  full_name text,
  phone text,
  employee_code text,
  joined_on date,
  notes text,
  on_duty boolean,
  member_id uuid,
  member_username text,
  member_active boolean,
  open_tables text[],
  tables_today int
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_day_start timestamptz;
begin
  select private.business_day_start(now(), r.timezone, r.business_day_start_hour)
    into v_day_start
    from public.restaurants r where r.id = v_ctx.restaurant_id;

  return query
    select w.id, w.full_name, w.phone, w.employee_code, w.joined_on, w.notes, w.on_duty,
           w.member_id, m.username, m.is_active,
           coalesce((
             select array_agg(d.label order by d.sort_order)
             from public.table_sessions s
             join public.dining_tables d on d.id = s.dining_table_id
             where s.restaurant_id = v_ctx.restaurant_id
               and s.assigned_waiter_id = w.id
               and s.status = 'open'
           ), '{}'),
           (
             select count(distinct a.session_id)::int
             from public.session_waiter_assignments a
             where a.restaurant_id = v_ctx.restaurant_id
               and a.waiter_id = w.id
               and coalesce(a.unassigned_at, now()) >= v_day_start
           )
    from public.waiters w
    left join public.restaurant_members m on m.id = w.member_id
    where w.restaurant_id = v_ctx.restaurant_id and w.is_active
    order by w.full_name;
end;
$$;

-- ─── Settings ───────────────────────────────────────────────────────────────
-- Postgres regexes allow at most 255 repetitions; the original {2,256}
-- rejected every VPA at runtime.
alter table public.restaurants drop constraint restaurants_upi_vpa_check;
alter table public.restaurants add constraint restaurants_upi_vpa_check
  check (upi_vpa ~ '^[A-Za-z0-9._-]{2,255}@[A-Za-z0-9.-]{2,64}$');

-- Whitelisted restaurant settings (spec §13.3 Settings tabs). Any change is
-- audit logged with before/after values of the keys that changed.
create or replace function public.admin_update_settings(p_patch jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
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

  if v_after is not null then
    perform private.audit_as(
      v_ctx, 'settings.updated', 'restaurant', v_ctx.restaurant_id, v_before, v_after
    );
  end if;
end;
$$;

-- ─── Privileges ─────────────────────────────────────────────────────────────
revoke execute on function public.admin_list_staff() from public, anon;
revoke execute on function public.admin_create_staff(uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.admin_update_staff(uuid, jsonb) from public, anon;
revoke execute on function public.admin_deactivate_staff(uuid) from public, anon;
revoke execute on function public.admin_reactivate_staff(uuid) from public, anon;
revoke execute on function public.admin_reset_staff_password(uuid) from public, anon;
revoke execute on function public.admin_upsert_waiter(jsonb) from public, anon;
revoke execute on function public.admin_set_waiter_on_duty(uuid, boolean) from public, anon;
revoke execute on function public.admin_delete_waiter(uuid) from public, anon;
revoke execute on function public.admin_waiters_overview() from public, anon;
revoke execute on function public.admin_update_settings(jsonb) from public, anon;

grant execute on function public.admin_list_staff() to authenticated;
grant execute on function public.admin_create_staff(uuid, jsonb) to service_role;
grant execute on function public.admin_update_staff(uuid, jsonb) to authenticated;
grant execute on function public.admin_deactivate_staff(uuid) to authenticated;
grant execute on function public.admin_reactivate_staff(uuid) to authenticated;
grant execute on function public.admin_reset_staff_password(uuid) to authenticated;
grant execute on function public.admin_upsert_waiter(jsonb) to authenticated;
grant execute on function public.admin_set_waiter_on_duty(uuid, boolean) to authenticated;
grant execute on function public.admin_delete_waiter(uuid) to authenticated;
grant execute on function public.admin_waiters_overview() to authenticated;
grant execute on function public.admin_update_settings(jsonb) to authenticated;
