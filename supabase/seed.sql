-- Local demo data (spec §8.12). Runs on `supabase start` / `supabase db reset`.
-- NEVER run against staging or production: it creates accounts with a known password.
--
-- Logins (password for all: Password123!)
--   Platform admin  super@local.test                       → /super
--   Owner           owner@local.test  or  demo / owner     → /admin
--   Manager         demo / manager                         → /admin
--   Waiter          demo / waiter1 (waiter profile Ravi)   → /staff
--   Kitchen         demo / kitchen1                        → /staff
-- Table QR tokens: DEMO0000TABLE001 … DEMO0000TABLE006  (/t/<token>)

-- Auth users are inserted directly so the seed needs no running app. The
-- token columns must be '' (not NULL) or GoTrue fails to load the user.
create function pg_temp.seed_user(p_id uuid, p_email text)
returns uuid
language plpgsql
as $$
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change
  )
  values (
    '00000000-0000-0000-0000-000000000000', p_id, 'authenticated', 'authenticated', p_email,
    extensions.crypt('Password123!', extensions.gen_salt('bf')), now(),
    '{"provider": "email", "providers": ["email"]}', '{}', now(), now(),
    '', '', '', ''
  );

  insert into auth.identities (
    user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
  )
  values (
    p_id, p_id::text,
    jsonb_build_object('sub', p_id::text, 'email', p_email, 'email_verified', true),
    'email', now(), now(), now()
  );

  return p_id;
end;
$$;

-- ─── Users ──────────────────────────────────────────────────────────────────
select pg_temp.seed_user('a0000000-0000-4000-8000-000000000001', 'super@local.test');
select pg_temp.seed_user('a0000000-0000-4000-8000-000000000002', 'owner@local.test');
select pg_temp.seed_user('a0000000-0000-4000-8000-000000000003', 'manager@demo.staff.tableorder.test');
select pg_temp.seed_user('a0000000-0000-4000-8000-000000000004', 'waiter1@demo.staff.tableorder.test');
select pg_temp.seed_user('a0000000-0000-4000-8000-000000000005', 'kitchen1@demo.staff.tableorder.test');

insert into public.platform_admins (user_id) values ('a0000000-0000-4000-8000-000000000001');

-- ─── Restaurant ─────────────────────────────────────────────────────────────
insert into public.restaurants (
  id, name, slug, legal_name, address_line, city, state, pincode, phone, email,
  gstin, fssai_license, gst_mode, gst_rate_bps, prices_include_tax,
  bill_footer_text, max_tables_per_waiter
)
values (
  'd0000000-0000-4000-8000-000000000001', 'Demo Kitchen', 'demo', 'Demo Kitchen Foods LLP',
  '12 MG Road, Palasia', 'Indore', 'Madhya Pradesh', '452001', '9876543210', 'hello@demo.test',
  '23AAACD1234E1Z5', '11425999000123', 'regular', 500, false,
  'Thank you, visit again!', 1
);

insert into public.restaurant_members (id, restaurant_id, user_id, role, display_name, username)
values
  ('b0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000001',
   'a0000000-0000-4000-8000-000000000002', 'owner', 'Asha Verma', 'owner'),
  ('b0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000001',
   'a0000000-0000-4000-8000-000000000003', 'manager', 'Manoj Singh', 'manager'),
  ('b0000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000001',
   'a0000000-0000-4000-8000-000000000004', 'waiter', 'Ravi Kumar', 'waiter1'),
  ('b0000000-0000-4000-8000-000000000005', 'd0000000-0000-4000-8000-000000000001',
   'a0000000-0000-4000-8000-000000000005', 'kitchen', 'Kavita Rao', 'kitchen1');

insert into public.waiters (restaurant_id, full_name, phone, employee_code, member_id)
values
  ('d0000000-0000-4000-8000-000000000001', 'Ravi Kumar', '9876500001', 'W001',
   'b0000000-0000-4000-8000-000000000004'),
  ('d0000000-0000-4000-8000-000000000001', 'Suresh Patel', '9876500002', 'W002', null),
  ('d0000000-0000-4000-8000-000000000001', 'Anita Das', '9876500003', 'W003', null);

insert into public.restaurant_subscriptions (restaurant_id, plan_id, status, trial_ends_at)
select 'd0000000-0000-4000-8000-000000000001', p.id, 'trialing', now() + interval '14 days'
from public.plans p where p.code = 'growth';

-- ─── Tables 1–6 (fixed QR tokens for tests) ─────────────────────────────────
insert into public.dining_tables (restaurant_id, label, sort_order, qr_token)
select 'd0000000-0000-4000-8000-000000000001', n::text, n, 'DEMO0000TABLE00' || n
from generate_series(1, 6) as n;

-- ─── Menu: north_indian default categories, three hidden ────────────────────
insert into public.menu_categories (restaurant_id, name, sort_order, is_active, source)
select 'd0000000-0000-4000-8000-000000000001', c.name, c.ord, c.name not in ('Soups', 'Salads', 'Combos & Thali'), 'default'
from unnest(array[
  'Starters', 'Soups', 'Salads', 'Tandoori & Kebabs', 'Main Course (Veg)',
  'Main Course (Non-veg)', 'Rice & Biryani', 'Breads', 'Combos & Thali',
  'Accompaniments', 'Desserts', 'Beverages'
]) with ordinality as c(name, ord);

-- Items: (category, name, description, price ₹, food type, available, sort).
-- Paneer Tikka, Butter Naan and Dal Makhani match the §11.1 billing examples.
insert into public.menu_items (
  restaurant_id, category_id, name, description, price_paise, food_type, is_available, sort_order
)
select
  'd0000000-0000-4000-8000-000000000001', c.id, i.name, i.description, i.price_rupees * 100,
  i.food_type::public.food_type, i.available, i.sort_order
from (values
  ('Starters', 'Paneer Tikka', 'Cottage cheese, capsicum and onion from the tandoor', 280, 'veg', true, 1),
  ('Starters', 'Chicken 65', 'Spicy fried chicken, curry leaves', 320, 'non_veg', true, 2),
  ('Starters', 'Egg Pakora', 'Boiled egg fritters with mint chutney', 160, 'egg', true, 3),
  ('Tandoori & Kebabs', 'Tandoori Chicken', 'Marinated overnight, charred in the tandoor', 260, 'non_veg', true, 1),
  ('Tandoori & Kebabs', 'Hara Bhara Kebab', 'Spinach and green pea patties', 220, 'veg', true, 2),
  ('Main Course (Veg)', 'Dal Makhani', 'Black lentils slow-cooked with butter and cream', 240, 'veg', true, 1),
  ('Main Course (Veg)', 'Paneer Butter Masala', 'Paneer in a rich tomato gravy', 300, 'veg', true, 2),
  ('Main Course (Veg)', 'Malai Kofta', 'Paneer dumplings in a cashew gravy', 290, 'veg', false, 3),
  ('Main Course (Non-veg)', 'Butter Chicken', 'Tandoori chicken in a buttery tomato gravy', 280, 'non_veg', true, 1),
  ('Main Course (Non-veg)', 'Egg Curry', 'Boiled eggs in onion-tomato masala', 200, 'egg', true, 2),
  ('Rice & Biryani', 'Jeera Rice', null, 160, 'veg', true, 1),
  ('Rice & Biryani', 'Chicken Biryani', 'Dum-cooked basmati with chicken and saffron', 340, 'non_veg', true, 2),
  ('Breads', 'Butter Naan', null, 60, 'veg', true, 1),
  ('Breads', 'Tandoori Roti', null, 30, 'veg', true, 2),
  ('Breads', 'Garlic Naan', null, 80, 'veg', true, 3),
  ('Desserts', 'Gulab Jamun', 'Two pieces, served warm', 90, 'veg', true, 1),
  ('Beverages', 'Masala Chaas', null, 60, 'veg', true, 1),
  ('Beverages', 'Sweet Lassi', null, 80, 'veg', true, 2)
) as i(category, name, description, price_rupees, food_type, available, sort_order)
join public.menu_categories c
  on c.restaurant_id = 'd0000000-0000-4000-8000-000000000001' and c.name = i.category;

-- Half/Full variants; the item price above is the Half price as a fallback.
insert into public.menu_item_variants (restaurant_id, menu_item_id, name, price_paise, sort_order)
select 'd0000000-0000-4000-8000-000000000001', m.id, v.name, v.price_rupees * 100, v.sort_order
from (values
  ('Tandoori Chicken', 'Half', 260, 1),
  ('Tandoori Chicken', 'Full', 480, 2),
  ('Butter Chicken', 'Half', 280, 1),
  ('Butter Chicken', 'Full', 480, 2)
) as v(item, name, price_rupees, sort_order)
join public.menu_items m
  on m.restaurant_id = 'd0000000-0000-4000-8000-000000000001' and m.name = v.item;
