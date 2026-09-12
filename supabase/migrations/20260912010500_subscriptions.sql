-- Plans, restaurant subscriptions, subscription payments and webhook events (spec §8.9).

create table public.plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z_]{2,30}$'),
  name text not null check (length(btrim(name)) between 1 and 40),
  price_monthly_paise bigint not null check (price_monthly_paise >= 0),
  price_yearly_paise bigint not null check (price_yearly_paise >= 0),
  razorpay_plan_id_monthly text,
  razorpay_plan_id_yearly text,
  -- Null = unlimited.
  max_tables int check (max_tables > 0),
  max_staff int check (max_staff > 0),
  features jsonb not null default '{}' check (jsonb_typeof(features) = 'object'),
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Default plans (§8.12, §14.1–14.2). Needed in every environment, so they live
-- in a migration; prices and limits stay editable from the super-admin panel.
insert into public.plans
  (code, name, price_monthly_paise, price_yearly_paise, max_tables, max_staff, features, sort_order)
values
  ('starter', 'Starter', 39900, 399000, 8, 3,
   '{"kds": false, "discounts": false, "split_payments": false, "upi_qr_on_bill": false,
     "advanced_reports": false, "waiter_reports": false, "csv_export": false,
     "remove_branding": false}', 1),
  ('growth', 'Growth', 89900, 899000, null, 15,
   '{"kds": true, "discounts": true, "split_payments": true, "upi_qr_on_bill": true,
     "advanced_reports": true, "waiter_reports": true, "csv_export": true,
     "remove_branding": false}', 2),
  ('pro', 'Pro', 179900, 1799000, null, null,
   '{"kds": true, "discounts": true, "split_payments": true, "upi_qr_on_bill": true,
     "advanced_reports": true, "waiter_reports": true, "csv_export": true,
     "remove_branding": true}', 3)
on conflict (code) do nothing;

create table public.restaurant_subscriptions (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null unique references public.restaurants (id),
  -- During a trial: the plan being trialled.
  plan_id uuid not null references public.plans (id),
  billing_cycle public.billing_cycle,
  status public.subscription_status not null,
  source public.subscription_source,
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  -- Set when a renewal fails.
  grace_until timestamptz,
  cancel_at_period_end boolean not null default false,
  razorpay_subscription_id text unique,
  razorpay_customer_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint restaurant_subscriptions_trial_end_required
    check (status <> 'trialing' or trial_ends_at is not null)
);

create index restaurant_subscriptions_plan_idx on public.restaurant_subscriptions (plan_id);

create table public.subscription_payments (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id),
  source public.subscription_payment_source not null,
  amount_paise bigint not null check (amount_paise > 0),
  razorpay_payment_id text unique,
  manual_mode public.manual_payment_mode,
  period_start timestamptz,
  period_end timestamptz,
  notes text check (length(notes) <= 500),
  recorded_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint subscription_payments_manual_mode_required
    check (source <> 'manual' or manual_mode is not null),
  constraint subscription_payments_period_order
    check (period_start is null or period_end is null or period_end > period_start)
);

create index subscription_payments_restaurant_created_idx
  on public.subscription_payments (restaurant_id, created_at desc);

create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('razorpay')),
  event_id text not null,
  event_type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, event_id)
);

create trigger set_updated_at before update on public.plans
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.restaurant_subscriptions
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.subscription_payments
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.webhook_events
  for each row execute function private.set_updated_at();
