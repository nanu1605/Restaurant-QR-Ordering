-- pgTAP helpers used by supabase/tests (spec §18). Loaded as a seed file, so they
-- exist in local and CI databases only — never in staging or production.
--
-- Usage inside a test (each test file runs in its own transaction):
--   select tests.create_restaurant('alpha') as rest_a \gset
--   select tests.add_member(:'rest_a', 'manager', 'a_manager') as a_manager \gset
--   select tests.authenticate_as(:'a_manager');   -- now queries run under RLS
--   select tests.clear_auth();                    -- back to postgres

create schema if not exists tests;
grant usage on schema tests to anon, authenticated, service_role;

-- ─── Users and roles ────────────────────────────────────────────────────────
create or replace function tests.create_user(p_email text)
returns uuid
language plpgsql
as $$
declare
  v_id uuid := gen_random_uuid();
begin
  insert into auth.users (
    instance_id, id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change
  )
  values (
    '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', p_email,
    '{}', '{}', now(), now(), '', '', '', ''
  );
  return v_id;
end;
$$;

-- Act as a signed-in user: RLS applies and auth.uid() returns p_user_id.
create or replace function tests.authenticate_as(p_user_id uuid)
returns void
language plpgsql
as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', p_user_id, 'role', 'authenticated')::text,
    true
  );
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
end;
$$;

-- A platform admin (spec §8.1).
create or replace function tests.create_platform_admin(p_email text)
returns uuid
language plpgsql
as $$
declare
  v_id uuid := tests.create_user(p_email);
begin
  insert into public.platform_admins (user_id) values (v_id);
  return v_id;
end;
$$;

-- Act as a platform admin. Platform access needs an aal2 session (password
-- + TOTP, docs/DECISIONS.md P7-1); pass 'aal1' for a password-only session.
create or replace function tests.authenticate_as_platform_admin(
  p_user_id uuid,
  p_aal text default 'aal2'
)
returns void
language plpgsql
as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', p_user_id, 'role', 'authenticated', 'aal', p_aal)::text,
    true
  );
  perform set_config('request.jwt.claim.sub', p_user_id::text, true);
end;
$$;

create or replace function tests.as_anon()
returns void
language plpgsql
as $$
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role": "anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
end;
$$;

-- The server-side admin client: no user, bypasses RLS.
create or replace function tests.as_service_role()
returns void
language plpgsql
as $$
begin
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role": "service_role"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
end;
$$;

-- Back to the session user (postgres).
create or replace function tests.clear_auth()
returns void
language plpgsql
as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claim.sub', '', true);
end;
$$;

-- ─── Tenants ────────────────────────────────────────────────────────────────
-- Restaurant on a 14-day Growth trial. Slug doubles as the display name.
create or replace function tests.create_restaurant(p_slug text)
returns uuid
language plpgsql
as $$
declare
  v_id uuid;
begin
  insert into public.restaurants (name, slug) values (initcap(p_slug), p_slug) returning id into v_id;
  insert into public.restaurant_subscriptions (restaurant_id, plan_id, status, trial_ends_at)
  select v_id, p.id, 'trialing', now() + interval '14 days' from public.plans p where p.code = 'growth';
  return v_id;
end;
$$;

-- Switches the restaurant's (trial) subscription to another plan.
create or replace function tests.set_plan(p_restaurant_id uuid, p_plan_code text)
returns void
language sql
as $$
  update public.restaurant_subscriptions
    set plan_id = (select id from public.plans where code = p_plan_code)
    where restaurant_id = p_restaurant_id;
$$;

-- Makes the restaurant read-only (spec §10.6) by suspending it.
create or replace function tests.suspend(p_restaurant_id uuid)
returns void
language sql
as $$
  update public.restaurants
    set status = 'suspended', suspended_reason = 'Test suspension'
    where id = p_restaurant_id;
$$;

-- Creates a login (<username>@<slug>.test) and an active membership. Returns the user id.
create or replace function tests.add_member(
  p_restaurant_id uuid,
  p_role public.member_role,
  p_username text
)
returns uuid
language plpgsql
as $$
declare
  v_user_id uuid;
  v_slug text;
begin
  select slug into v_slug from public.restaurants where id = p_restaurant_id;
  v_user_id := tests.create_user(p_username || '@' || v_slug || '.test');
  insert into public.restaurant_members (restaurant_id, user_id, role, display_name, username)
  values (p_restaurant_id, v_user_id, p_role, initcap(p_username), p_username);
  return v_user_id;
end;
$$;

-- One row in every tenant table, so isolation tests have something to hide.
create or replace function tests.create_full_fixture(p_restaurant_id uuid)
returns void
language plpgsql
as $$
declare
  v_table uuid;
  v_category uuid;
  v_item uuid;
  v_variant uuid;
  v_waiter uuid;
  v_session uuid;
  v_order uuid;
  v_bill uuid;
begin
  insert into public.dining_tables (restaurant_id, label, qr_token)
  values (p_restaurant_id, 'T1', private.random_base62(16))
  returning id into v_table;

  insert into public.menu_categories (restaurant_id, name)
  values (p_restaurant_id, 'Starters')
  returning id into v_category;

  insert into public.menu_items (restaurant_id, category_id, name, price_paise, food_type)
  values (p_restaurant_id, v_category, 'Paneer Tikka', 28000, 'veg')
  returning id into v_item;

  insert into public.menu_item_variants (restaurant_id, menu_item_id, name, price_paise)
  values (p_restaurant_id, v_item, 'Full', 32000)
  returning id into v_variant;

  insert into public.waiters (restaurant_id, full_name)
  values (p_restaurant_id, 'Fixture Waiter')
  returning id into v_waiter;

  insert into public.table_sessions (restaurant_id, dining_table_id, table_label_snapshot, assigned_waiter_id)
  values (p_restaurant_id, v_table, 'T1', v_waiter)
  returning id into v_session;

  insert into public.session_waiter_assignments (restaurant_id, session_id, waiter_id)
  values (p_restaurant_id, v_session, v_waiter);

  insert into public.orders (restaurant_id, session_id, round_number, status, placed_via, idempotency_key)
  values (p_restaurant_id, v_session, 1, 'accepted', 'staff', 'fixture-' || gen_random_uuid())
  returning id into v_order;

  insert into public.order_items (
    restaurant_id, order_id, session_id, menu_item_id, variant_id,
    item_name_snapshot, variant_name_snapshot, food_type_snapshot, unit_price_paise, quantity
  )
  values (
    p_restaurant_id, v_order, v_session, v_item, v_variant,
    'Paneer Tikka', 'Full', 'veg', 32000, 1
  );

  insert into public.invoice_counters (restaurant_id, financial_year, last_seq)
  values (p_restaurant_id, '2026-27', 1);

  insert into public.bills (
    restaurant_id, session_id, invoice_number, financial_year, invoice_seq, document_type,
    table_label_snapshot, line_items, restaurant_snapshot, gst_mode, gst_rate_bps,
    prices_include_tax, subtotal_paise, taxable_paise, grand_total_paise
  )
  values (
    p_restaurant_id, v_session, 'INV/2026-27/00001', '2026-27', 1, 'bill',
    'T1', '[]', '{}', 'none', 0, false, 32000, 32000, 32000
  )
  returning id into v_bill;

  insert into public.bill_payments (restaurant_id, bill_id, mode, amount_paise)
  values (p_restaurant_id, v_bill, 'cash', 32000);

  insert into public.audit_logs (restaurant_id, actor_type, actor_label, action)
  values (p_restaurant_id, 'system', 'System', 'fixture.created');

  insert into public.subscription_payments (restaurant_id, source, amount_paise, manual_mode)
  values (p_restaurant_id, 'manual', 89900, 'upi');
end;
$$;

-- A table with the given QR token and a small menu for customer ordering tests.
-- Returns the ids: table, simple (Paneer Tikka ₹280), variant_item (Butter
-- Chicken: half ₹280, full ₹480, an inactive family option), unavailable
-- (Malai Kofta, out of stock), hidden_item, in_hidden_category, and the
-- category ids (starters, hidden_category, empty_category).
create or replace function tests.create_ordering_fixture(p_restaurant_id uuid, p_qr_token text)
returns jsonb
language plpgsql
as $$
declare
  v_table uuid;
  v_starters uuid;
  v_hidden_category uuid;
  v_empty_category uuid;
  v_simple uuid;
  v_variant_item uuid;
  v_half uuid;
  v_full uuid;
  v_family uuid;
  v_unavailable uuid;
  v_hidden_item uuid;
  v_in_hidden_category uuid;
begin
  insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
  values (p_restaurant_id, '5', p_qr_token, 1)
  returning id into v_table;

  insert into public.menu_categories (restaurant_id, name, sort_order)
  values (p_restaurant_id, 'Starters', 1) returning id into v_starters;
  insert into public.menu_categories (restaurant_id, name, sort_order, is_active)
  values (p_restaurant_id, 'Soups', 2, false) returning id into v_hidden_category;
  insert into public.menu_categories (restaurant_id, name, sort_order)
  values (p_restaurant_id, 'Accompaniments', 3) returning id into v_empty_category;

  insert into public.menu_items (restaurant_id, category_id, name, food_type, price_paise, sort_order)
  values (p_restaurant_id, v_starters, 'Paneer Tikka', 'veg', 28000, 1)
  returning id into v_simple;
  insert into public.menu_items (restaurant_id, category_id, name, food_type, price_paise, sort_order)
  values (p_restaurant_id, v_starters, 'Butter Chicken', 'non_veg', 28000, 2)
  returning id into v_variant_item;
  insert into public.menu_item_variants (restaurant_id, menu_item_id, name, price_paise, sort_order)
  values (p_restaurant_id, v_variant_item, 'Half', 28000, 1) returning id into v_half;
  insert into public.menu_item_variants (restaurant_id, menu_item_id, name, price_paise, sort_order)
  values (p_restaurant_id, v_variant_item, 'Full', 48000, 2) returning id into v_full;
  insert into public.menu_item_variants
    (restaurant_id, menu_item_id, name, price_paise, sort_order, is_active)
  values (p_restaurant_id, v_variant_item, 'Family', 90000, 3, false) returning id into v_family;
  insert into public.menu_items
    (restaurant_id, category_id, name, food_type, price_paise, sort_order, is_available)
  values (p_restaurant_id, v_starters, 'Malai Kofta', 'veg', 29000, 3, false)
  returning id into v_unavailable;
  insert into public.menu_items
    (restaurant_id, category_id, name, food_type, price_paise, sort_order, is_active)
  values (p_restaurant_id, v_starters, 'Old Dish', 'veg', 10000, 4, false)
  returning id into v_hidden_item;
  insert into public.menu_items (restaurant_id, category_id, name, food_type, price_paise)
  values (p_restaurant_id, v_hidden_category, 'Tomato Soup', 'veg', 12000)
  returning id into v_in_hidden_category;

  return jsonb_build_object(
    'table', v_table,
    'starters', v_starters,
    'hidden_category', v_hidden_category,
    'empty_category', v_empty_category,
    'simple', v_simple,
    'variant_item', v_variant_item,
    'half', v_half,
    'full', v_full,
    'family', v_family,
    'unavailable', v_unavailable,
    'hidden_item', v_hidden_item,
    'in_hidden_category', v_in_hidden_category
  );
end;
$$;

-- One order line as customer_place_order expects it.
create or replace function tests.line(
  p_menu_item_id uuid,
  p_quantity int default 1,
  p_variant_id uuid default null,
  p_note text default null
)
returns jsonb
language sql
immutable
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'menu_item_id', p_menu_item_id,
    'variant_id', p_variant_id,
    'quantity', p_quantity,
    'note', p_note
  ));
$$;

-- Member id (restaurant_members.id) for a user.
create or replace function tests.member_id(p_user_id uuid)
returns uuid
language sql
stable
as $$
  select id from public.restaurant_members where user_id = p_user_id limit 1;
$$;

-- A waiter profile, on duty unless p_on_duty is false, optionally linked to the
-- login of p_user_id. Returns the waiter id.
create or replace function tests.add_waiter(
  p_restaurant_id uuid,
  p_name text,
  p_user_id uuid default null,
  p_on_duty boolean default true
)
returns uuid
language sql
as $$
  insert into public.waiters (restaurant_id, full_name, member_id, on_duty)
  values (
    p_restaurant_id,
    p_name,
    case when p_user_id is null then null else tests.member_id(p_user_id) end,
    p_on_duty
  )
  returning id;
$$;

-- Marks a session billed (status and billed_at only) until Phase 5 has
-- admin_generate_bill.
create or replace function tests.bill_session(p_session_id uuid)
returns void
language sql
as $$
  update public.table_sessions set status = 'billed', billed_at = now() where id = p_session_id;
$$;

-- ─── Assertions ─────────────────────────────────────────────────────────────
-- Rows affected by a statement, for checks where RLS filters silently instead
-- of raising (e.g. an UPDATE the policy does not match).
create or replace function tests.row_count(p_sql text)
returns bigint
language plpgsql
as $$
declare
  v_count bigint;
begin
  execute p_sql;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Run as the user under test: rows of p_other_restaurant must be invisible and
-- impossible to update or delete. "Permission denied" counts as blocked.
create or replace function tests.rls_isolation(p_table regclass, p_other_restaurant uuid)
returns setof text
language plpgsql
as $$
declare
  v_column text := case when p_table = 'public.restaurants'::regclass then 'id' else 'restaurant_id' end;
  v_count bigint;
begin
  begin
    execute format('select count(*) from %s where %I = $1', p_table, v_column)
      into v_count using p_other_restaurant;
  exception when insufficient_privilege then
    v_count := 0;
  end;
  return next is(v_count, 0::bigint, format('%s: other tenant rows are invisible', p_table));

  begin
    execute format('update %s set %I = %I where %I = $1', p_table, v_column, v_column, v_column)
      using p_other_restaurant;
    get diagnostics v_count = row_count;
  exception when insufficient_privilege then
    v_count := 0;
  end;
  return next is(v_count, 0::bigint, format('%s: other tenant rows cannot be updated', p_table));

  begin
    execute format('delete from %s where %I = $1', p_table, v_column) using p_other_restaurant;
    get diagnostics v_count = row_count;
  exception when insufficient_privilege then
    v_count := 0;
  end;
  return next is(v_count, 0::bigint, format('%s: other tenant rows cannot be deleted', p_table));
end;
$$;

grant execute on all functions in schema tests to anon, authenticated, service_role;
