-- Table sessions, waiter assignments, orders (rounds) and order items (spec §8.5).
-- All writes happen through business functions (spec §9.3), never directly.

create table public.table_sessions (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id),
  dining_table_id uuid not null,
  table_label_snapshot text not null,
  status public.session_status not null default 'open',
  is_approved boolean not null default false,
  approved_by uuid,
  approved_at timestamptz,
  assigned_waiter_id uuid,
  assigned_at timestamptz,
  assigned_by uuid,
  opened_at timestamptz not null default now(),
  billed_at timestamptz,
  closed_at timestamptz,
  closed_by uuid,
  close_reason text check (length(close_reason) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (restaurant_id, id),
  foreign key (restaurant_id, dining_table_id) references public.dining_tables (restaurant_id, id),
  foreign key (restaurant_id, assigned_waiter_id) references public.waiters (restaurant_id, id),
  constraint table_sessions_billed_at_matches_status check ((status = 'billed') = (billed_at is not null)),
  constraint table_sessions_closed_at_matches_status
    check ((status = 'closed_unbilled') = (closed_at is not null))
);

-- Exactly one open session per table.
create unique index table_sessions_one_open_per_table
  on public.table_sessions (dining_table_id) where status = 'open';
create index table_sessions_restaurant_status_idx on public.table_sessions (restaurant_id, status);
create index table_sessions_restaurant_billed_at_idx on public.table_sessions (restaurant_id, billed_at);
create index table_sessions_open_waiter_idx
  on public.table_sessions (assigned_waiter_id) where status = 'open';

create table public.session_waiter_assignments (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id),
  session_id uuid not null,
  waiter_id uuid not null,
  assigned_at timestamptz not null default now(),
  assigned_by uuid,
  unassigned_at timestamptz,
  unassign_reason public.unassign_reason,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (restaurant_id, session_id) references public.table_sessions (restaurant_id, id),
  foreign key (restaurant_id, waiter_id) references public.waiters (restaurant_id, id),
  constraint session_waiter_assignments_reason_matches_end
    check ((unassigned_at is null) = (unassign_reason is null))
);

-- At most one current assignment per session.
create unique index session_waiter_assignments_current_key
  on public.session_waiter_assignments (session_id) where unassigned_at is null;
create index session_waiter_assignments_waiter_idx
  on public.session_waiter_assignments (restaurant_id, waiter_id, assigned_at);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id),
  session_id uuid not null,
  round_number int not null check (round_number > 0),
  status public.order_status not null,
  placed_via public.order_placed_via not null,
  placed_by_user_id uuid,
  client_device_id text check (length(client_device_id) <= 64),
  idempotency_key text not null check (length(idempotency_key) between 8 and 100),
  customer_note text check (length(customer_note) <= 200),
  decided_by uuid,
  decided_at timestamptz,
  reject_reason text check (length(reject_reason) <= 200),
  removed_by uuid,
  removed_at timestamptz,
  removed_reason text check (length(removed_reason) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (restaurant_id, id),
  -- Lets order_items prove they sit in the same session as their order.
  unique (restaurant_id, session_id, id),
  unique (restaurant_id, idempotency_key),
  unique (session_id, round_number),
  foreign key (restaurant_id, session_id) references public.table_sessions (restaurant_id, id)
);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id),
  order_id uuid not null,
  -- Denormalised for fast per-session queries; the FK below keeps it honest.
  session_id uuid not null,
  menu_item_id uuid not null,
  variant_id uuid,
  item_name_snapshot text not null,
  variant_name_snapshot text,
  food_type_snapshot public.food_type not null,
  -- Snapshot from the DB at order time, never from the client.
  unit_price_paise bigint not null check (unit_price_paise >= 0),
  quantity int not null check (quantity between 1 and 20),
  note text check (length(note) <= 120),
  status public.order_item_status not null default 'placed',
  status_changed_at timestamptz not null default now(),
  status_changed_by uuid,
  served_at timestamptz,
  served_by uuid,
  cancelled_at timestamptz,
  removed_at timestamptz,
  removed_by uuid,
  removed_reason text check (length(removed_reason) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (restaurant_id, id),
  foreign key (restaurant_id, session_id, order_id)
    references public.orders (restaurant_id, session_id, id),
  foreign key (restaurant_id, menu_item_id) references public.menu_items (restaurant_id, id),
  foreign key (restaurant_id, menu_item_id, variant_id)
    references public.menu_item_variants (restaurant_id, menu_item_id, id),
  constraint order_items_variant_snapshot check ((variant_id is null) = (variant_name_snapshot is null))
);

create index order_items_session_idx on public.order_items (session_id);
create index order_items_order_idx on public.order_items (restaurant_id, session_id, order_id);
create index order_items_menu_item_idx on public.order_items (restaurant_id, menu_item_id);
-- Live kitchen/board queries only look at unfinished items.
create index order_items_active_status_idx
  on public.order_items (restaurant_id, status) where status in ('placed', 'preparing', 'ready');

create trigger set_updated_at before update on public.table_sessions
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.session_waiter_assignments
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.orders
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.order_items
  for each row execute function private.set_updated_at();
