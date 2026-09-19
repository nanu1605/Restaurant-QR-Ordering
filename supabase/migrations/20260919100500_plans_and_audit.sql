-- Plans editor and the platform audit log (spec §13.4, docs/DECISIONS.md
-- P7-10, P7-11).

-- Plans change only through platform_update_plan, so every change is audited
-- (§8.8 "all platform admin actions"). Direct writes are no longer allowed.
drop policy "platform admins insert plans" on public.plans;
drop policy "platform admins update plans" on public.plans;
revoke insert, update on public.plans from authenticated;

-- Edits a plan. Patch keys: name, price_monthly_paise, price_yearly_paise,
-- max_tables and max_staff (null = unlimited), features (known keys with
-- true/false; merged into the plan's), razorpay_plan_id_monthly,
-- razorpay_plan_id_yearly, is_active, sort_order. Lower limits never
-- deactivate existing tables or staff (§14.2); an inactive plan is kept by the
-- restaurants on it but can't be chosen.
create or replace function public.platform_update_plan(p_plan_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.current_platform_admin();
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
  for v_key in select jsonb_object_keys(v_patch) loop
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
$$;

-- The platform audit log, newest first, 50 per page. Filters: restaurant_id,
-- actor_type, action (a prefix such as "bill." or "restaurant.suspended"),
-- from/to (dates, India time), page. Rows name the restaurant and, for people,
-- the login email of the actor.
create or replace function public.platform_list_audit(p_filters jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
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
        'reason', pg.reason
      ) order by pg.created_at desc, pg.id)
      from page pg
      left join public.restaurants r on r.id = pg.restaurant_id
      left join auth.users u on u.id = pg.actor_user_id
    ), '[]'::jsonb)
  into v_total, v_rows;

  return jsonb_build_object('page', v_page, 'page_size', v_page_size, 'total', v_total, 'rows', v_rows);
end;
$$;

revoke execute on function public.platform_update_plan(uuid, jsonb) from public, anon;
revoke execute on function public.platform_list_audit(jsonb) from public, anon;
grant execute on function public.platform_update_plan(uuid, jsonb) to authenticated;
grant execute on function public.platform_list_audit(jsonb) to authenticated;
