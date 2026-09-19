-- Read-only support view (spec §13.4, docs/DECISIONS.md P7-6): the same data
-- the restaurant's own screens show, audited, without QR tokens.
begin;
select no_plan();

select tests.create_platform_admin('platform@admin.test') as admin \gset
select tests.create_restaurant('alpha') as rest_a \gset
select tests.create_restaurant('beta') as rest_b \gset
select tests.add_member(:'rest_a', 'owner', 'a_owner') as a_owner \gset
update public.restaurants set require_first_order_approval = false where id = :'rest_a';
select tests.create_ordering_fixture(:'rest_a', 'ALPHA0000TABLE05') as fx \gset

-- A table eating and a billed one, so the board and Total orders have rows.
select tests.as_service_role();
select public.customer_place_order(
  'ALPHA0000TABLE05', gen_random_uuid()::text, 'support-view-1',
  jsonb_build_array(tests.line((:'fx'::jsonb ->> 'simple')::uuid, 2))
) ->> 'order_id' as order_1 \gset
select tests.clear_auth();
select session_id as session_1 from public.orders where id = :'order_1' \gset
select tests.authenticate_as(:'a_owner');
select public.admin_generate_bill(:'session_1', 'none', 0, null, false);
select tests.clear_auth();
select tests.as_service_role();
select public.customer_place_order(
  'ALPHA0000TABLE05', gen_random_uuid()::text, 'support-view-2',
  jsonb_build_array(tests.line((:'fx'::jsonb ->> 'simple')::uuid))
);
select tests.clear_auth();

-- What the owner sees.
select tests.authenticate_as(:'a_owner');
select public.staff_get_board() as owner_board \gset
select public.admin_total_orders('{}') as owner_orders \gset

-- ─── Same data as the restaurant's screens ──────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_support_view(:'rest_a', 'board') as board \gset
select is(
  (:'board'::jsonb -> 'data') - 'role',
  :'owner_board'::jsonb - 'role',
  'the board matches the owner''s, apart from the viewer''s role'
);
select is(:'board'::jsonb #>> '{data,role}', 'manager', 'seen as a manager would');
select is(
  jsonb_array_length(:'board'::jsonb #> '{data,tables,0,session,rounds}'), 1,
  'the open table and its round'
);
select is(
  public.platform_support_view(:'rest_a', 'total_orders') -> 'data',
  :'owner_orders'::jsonb,
  'Total orders matches the owner''s'
);
select is(
  public.platform_support_view(:'rest_a', 'total_orders', '{"view": "closed_unbilled"}') #>> '{data,view}',
  'closed_unbilled', 'Total orders filters pass through'
);
select is(
  :'board'::jsonb -> 'restaurant' ->> 'slug', 'alpha', 'the restaurant is named'
);

select public.platform_support_view(:'rest_a', 'menu') as menu \gset
select is(
  (select jsonb_agg(c ->> 'name') from jsonb_array_elements(:'menu'::jsonb #> '{data,categories}') as c),
  '["Starters", "Soups", "Accompaniments"]'::jsonb,
  'menu categories in order, the hidden one included'
);
select is(
  (select jsonb_agg(i ->> 'name') from jsonb_array_elements(:'menu'::jsonb #> '{data,categories,0,items}') as i),
  '["Paneer Tikka", "Butter Chicken", "Malai Kofta", "Old Dish"]'::jsonb,
  'dishes in order, hidden ones included'
);
select is(
  (select i -> 'variants' from jsonb_array_elements(:'menu'::jsonb #> '{data,categories,0,items}') as i
   where i ->> 'name' = 'Butter Chicken'),
  '[{"name": "Half", "price_paise": 28000}, {"name": "Full", "price_paise": 48000}]'::jsonb,
  'active options only'
);

select public.platform_support_view(:'rest_a', 'tables') as tables \gset
select is(
  :'tables'::jsonb #>> '{data,tables,0,label}', '5', 'tables'
);
select ok(
  (:'tables'::jsonb #>> '{data,tables,0,opened_at}') is not null, 'an occupied table shows when it opened'
);
select ok(
  position('ALPHA0000TABLE05' in :'tables'::text || :'board'::text || :'menu'::text) = 0,
  'no QR token is ever returned'
);

-- ─── Audit ──────────────────────────────────────────────────────────────────
select public.platform_support_view(:'rest_a', 'board');
select public.platform_support_view(:'rest_a', 'board');
select is(
  (select jsonb_agg(after ->> 'section' order by after ->> 'section') from public.audit_logs
   where restaurant_id = :'rest_a' and action = 'support.viewed'),
  '["board", "menu", "tables", "total_orders"]'::jsonb,
  'one audit row per section in 10 minutes, however often the board refreshes'
);
select is(
  (select actor_type::text || '/' || actor_label from public.audit_logs
   where restaurant_id = :'rest_a' and action = 'support.viewed' and after ->> 'section' = 'menu'),
  'platform_admin/Platform admin',
  'audited as the platform admin'
);
select tests.authenticate_as(:'a_owner');
select is(
  (select count(*) from public.audit_logs where restaurant_id = :'rest_a' and action = 'support.viewed'),
  4::bigint, 'the owner can see that support looked'
);

-- ─── Refused ────────────────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select throws_ok(
  format($f$select public.platform_support_view(%L, 'staff')$f$, :'rest_a'),
  'P0001', 'INVALID_INPUT', 'unknown section'
);
select throws_ok(
  format($f$select public.platform_support_view(%L, 'menu', '{"page": 2}')$f$, :'rest_a'),
  'P0001', 'INVALID_INPUT', 'filters belong to Total orders only'
);
select throws_ok(
  format($f$select public.platform_support_view(%L, 'menu')$f$, gen_random_uuid()),
  'P0001', 'RESTAURANT_NOT_FOUND', 'unknown restaurant'
);
select tests.authenticate_as_platform_admin(:'admin', 'aal1');
select throws_ok(
  format($f$select public.platform_support_view(%L, 'menu')$f$, :'rest_a'),
  'P0001', 'MFA_REQUIRED', 'password only: refused'
);
select tests.authenticate_as(:'a_owner');
select throws_ok(
  format($f$select public.platform_support_view(%L, 'menu')$f$, :'rest_b'),
  'P0001', 'FORBIDDEN', 'an owner cannot look at another restaurant'
);

select tests.clear_auth();
select * from finish();
rollback;
