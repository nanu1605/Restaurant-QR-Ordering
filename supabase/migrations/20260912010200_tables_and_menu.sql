-- Dining tables with QR tokens and the menu (spec §8.3–8.4).
-- menu_imports is created in Phase 7 (docs/DECISIONS.md D6).

create table public.dining_tables (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id),
  label text not null check (length(btrim(label)) between 1 and 30),
  sort_order int not null default 0,
  -- 16-char random base62 (≈95 bits). QR encodes ${APP_URL}/t/${qr_token}.
  qr_token text not null unique check (qr_token ~ '^[A-Za-z0-9]{16}$'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (restaurant_id, id)
);

create index dining_tables_restaurant_sort_idx on public.dining_tables (restaurant_id, sort_order);
-- Labels are unique among a restaurant's active tables.
create unique index dining_tables_active_label_key
  on public.dining_tables (restaurant_id, lower(btrim(label))) where is_active;

create table public.menu_categories (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id),
  name text not null check (length(btrim(name)) between 1 and 60),
  sort_order int not null default 0,
  is_active boolean not null default true,
  source public.category_source not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (restaurant_id, id)
);

create index menu_categories_restaurant_sort_idx
  on public.menu_categories (restaurant_id, sort_order);
-- Case- and spacing-insensitive names, so imports and suggested sets can match.
create unique index menu_categories_name_key
  on public.menu_categories (restaurant_id, lower(regexp_replace(btrim(name), '\s+', ' ', 'g')));

create table public.menu_items (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id),
  category_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 80),
  description text check (length(description) <= 300),
  -- Used when the item has no active variants.
  price_paise bigint not null default 0 check (price_paise >= 0),
  food_type public.food_type not null,
  image_path text,
  is_available boolean not null default true,
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (restaurant_id, id),
  foreign key (restaurant_id, category_id) references public.menu_categories (restaurant_id, id)
);

create index menu_items_category_sort_idx
  on public.menu_items (restaurant_id, category_id, sort_order);

create table public.menu_item_variants (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id),
  menu_item_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 40),
  price_paise bigint not null check (price_paise >= 0),
  sort_order int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (restaurant_id, id),
  -- Lets order_items prove a variant belongs to the ordered item.
  unique (restaurant_id, menu_item_id, id),
  foreign key (restaurant_id, menu_item_id)
    references public.menu_items (restaurant_id, id) on delete cascade
);

create index menu_item_variants_item_sort_idx
  on public.menu_item_variants (restaurant_id, menu_item_id, sort_order);

create trigger set_updated_at before update on public.dining_tables
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.menu_categories
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.menu_items
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.menu_item_variants
  for each row execute function private.set_updated_at();
