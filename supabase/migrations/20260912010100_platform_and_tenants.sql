-- Platform tables, restaurants (tenants), their members and waiter profiles (spec §8.1–8.2).

-- ─── Platform ───────────────────────────────────────────────────────────────
create table public.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table public.platform_settings (
  id int primary key default 1 check (id = 1),
  trial_days int not null default 14 check (trial_days between 1 and 365),
  grace_days int not null default 7 check (grace_days between 0 and 90),
  support_phone text,
  support_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.platform_settings (id) values (1);

-- ─── Restaurants ────────────────────────────────────────────────────────────
create table public.restaurants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  -- Also used as the restaurant code at staff login and in synthetic staff
  -- emails, so it must be a valid DNS label.
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$'),
  legal_name text check (length(legal_name) <= 160),
  address_line text check (length(address_line) <= 300),
  city text check (length(city) <= 80),
  state text check (length(state) <= 80),
  pincode text check (pincode ~ '^[1-9][0-9]{5}$'),
  phone text check (length(phone) <= 20),
  email text check (length(email) <= 254),
  logo_path text,
  accent_color text not null default '#3B4BA8' check (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  gstin text check (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  fssai_license text check (fssai_license ~ '^[0-9]{14}$'),
  gst_mode public.gst_mode not null default 'none',
  gst_rate_bps int not null default 500 check (gst_rate_bps between 0 and 2800),
  prices_include_tax boolean not null default false,
  service_charge_enabled boolean not null default false,
  service_charge_bps int not null default 0 check (service_charge_bps between 0 and 10000),
  invoice_prefix text not null default 'INV' check (invoice_prefix ~ '^[A-Za-z0-9-]{1,10}$'),
  bill_footer_text text check (length(bill_footer_text) <= 200),
  paper_width public.paper_width not null default '80mm',
  show_upi_qr_on_bill boolean not null default false,
  upi_vpa text check (upi_vpa ~ '^[A-Za-z0-9._-]{2,256}@[A-Za-z0-9.-]{2,64}$'),
  upi_payee_name text check (length(upi_payee_name) <= 80),
  require_first_order_approval boolean not null default true,
  customer_cancel_window_seconds int not null default 120
    check (customer_cancel_window_seconds between 0 and 600),
  max_tables_per_waiter int not null default 1 check (max_tables_per_waiter between 1 and 20),
  staff_can_remove_served_items boolean not null default false,
  print_waiter_on_bill boolean not null default true,
  reopen_window_minutes int not null default 30 check (reopen_window_minutes between 0 and 120),
  business_day_start_hour int not null default 4 check (business_day_start_hour between 0 and 23),
  timezone text not null default 'Asia/Kolkata' check (private.is_valid_timezone(timezone)),
  status public.restaurant_status not null default 'active',
  suspended_reason text check (length(suspended_reason) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint restaurants_suspended_reason_required
    check (status = 'active' or suspended_reason is not null)
);

-- ─── Members (login accounts) ───────────────────────────────────────────────
create table public.restaurant_members (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id),
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.member_role not null,
  display_name text not null check (length(btrim(display_name)) between 1 and 80),
  username text not null check (username ~ '^[a-z0-9_]{3,30}$'),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (restaurant_id, id),
  unique (restaurant_id, user_id),
  unique (restaurant_id, username)
);

-- RLS helpers look memberships up by the signed-in user.
create index restaurant_members_user_id_idx on public.restaurant_members (user_id);

-- ─── Waiter profiles (no login needed) ──────────────────────────────────────
create table public.waiters (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id),
  full_name text not null check (length(btrim(full_name)) between 1 and 80),
  phone text check (phone ~ '^[6-9][0-9]{9}$'),
  employee_code text check (length(btrim(employee_code)) between 1 and 30),
  joined_on date,
  notes text check (length(notes) <= 300),
  member_id uuid,
  on_duty boolean not null default true,
  is_active boolean not null default true,
  deleted_at timestamptz,
  deleted_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (restaurant_id, id),
  foreign key (restaurant_id, member_id)
    references public.restaurant_members (restaurant_id, id) on delete set null (member_id)
);

create index waiters_restaurant_id_idx on public.waiters (restaurant_id);
create unique index waiters_employee_code_key
  on public.waiters (restaurant_id, employee_code) where employee_code is not null;
create unique index waiters_member_id_key on public.waiters (member_id) where member_id is not null;

-- ─── updated_at triggers ────────────────────────────────────────────────────
create trigger set_updated_at before update on public.platform_settings
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.restaurants
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.restaurant_members
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.waiters
  for each row execute function private.set_updated_at();
