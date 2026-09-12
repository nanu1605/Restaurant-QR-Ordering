-- Invoice counters, bills, bill payments (spec §8.6) and the audit log (§8.8).

create table public.invoice_counters (
  restaurant_id uuid not null references public.restaurants (id),
  financial_year text not null check (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
  last_seq int not null default 0 check (last_seq >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (restaurant_id, financial_year)
);

create table public.bills (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id),
  session_id uuid not null,
  invoice_number text not null,
  financial_year text not null check (financial_year ~ '^[0-9]{4}-[0-9]{2}$'),
  invoice_seq int not null check (invoice_seq > 0),
  document_type public.document_type not null,
  table_label_snapshot text not null,
  waiter_id uuid,
  waiter_name_snapshot text,
  line_items jsonb not null check (jsonb_typeof(line_items) = 'array'),
  restaurant_snapshot jsonb not null check (jsonb_typeof(restaurant_snapshot) = 'object'),
  gst_mode public.gst_mode not null,
  gst_rate_bps int not null check (gst_rate_bps between 0 and 2800),
  prices_include_tax boolean not null,
  subtotal_paise bigint not null check (subtotal_paise >= 0),
  discount_type public.discount_type not null default 'none',
  -- Paise for flat discounts, basis points for percent.
  discount_value bigint not null default 0 check (discount_value >= 0),
  discount_paise bigint not null default 0 check (discount_paise >= 0),
  discount_reason text check (length(discount_reason) <= 200),
  service_charge_bps int not null default 0 check (service_charge_bps between 0 and 10000),
  service_charge_paise bigint not null default 0 check (service_charge_paise >= 0),
  taxable_paise bigint not null check (taxable_paise >= 0),
  cgst_paise bigint not null default 0 check (cgst_paise >= 0),
  sgst_paise bigint not null default 0 check (sgst_paise >= 0),
  total_tax_paise bigint not null default 0 check (total_tax_paise >= 0),
  -- Signed: nearest-rupee rounding can go either way.
  round_off_paise bigint not null default 0,
  grand_total_paise bigint not null check (grand_total_paise >= 0),
  payment_status public.payment_status not null default 'unpaid',
  status public.bill_status not null default 'active',
  generated_by uuid,
  generated_at timestamptz not null default now(),
  paid_at timestamptz,
  void_reason text check (length(void_reason) <= 200),
  voided_by uuid,
  voided_at timestamptz,
  print_count int not null default 0 check (print_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (restaurant_id, id),
  unique (restaurant_id, invoice_number),
  unique (restaurant_id, financial_year, invoice_seq),
  foreign key (restaurant_id, session_id) references public.table_sessions (restaurant_id, id),
  foreign key (restaurant_id, waiter_id) references public.waiters (restaurant_id, id),
  constraint bills_discount_reason_required check (discount_paise = 0 or discount_reason is not null),
  constraint bills_tax_split check (total_tax_paise = cgst_paise + sgst_paise),
  constraint bills_void_fields check ((status = 'void') = (voided_at is not null)),
  constraint bills_paid_fields check ((payment_status = 'paid') = (paid_at is not null))
);

-- One non-void bill per session; a voided bill keeps its number.
create unique index bills_one_active_per_session on public.bills (session_id) where status <> 'void';
create index bills_restaurant_generated_idx on public.bills (restaurant_id, generated_at);
create index bills_restaurant_waiter_generated_idx
  on public.bills (restaurant_id, waiter_id, generated_at);

create table public.bill_payments (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id),
  bill_id uuid not null,
  mode public.payment_mode not null,
  amount_paise bigint not null check (amount_paise >= 0),
  reference text check (length(reference) <= 100),
  recorded_by uuid,
  is_void boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (restaurant_id, bill_id) references public.bills (restaurant_id, id)
);

create index bill_payments_bill_idx on public.bill_payments (restaurant_id, bill_id);

-- Append-only; written by business functions through private.write_audit().
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  -- Null for platform-level events.
  restaurant_id uuid references public.restaurants (id),
  actor_type public.actor_type not null,
  actor_user_id uuid,
  actor_role public.member_role,
  actor_label text not null,
  action text not null check (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  entity_type text,
  entity_id uuid,
  before jsonb,
  after jsonb,
  reason text,
  created_at timestamptz not null default now()
);

create index audit_logs_restaurant_created_idx on public.audit_logs (restaurant_id, created_at desc);
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);

create trigger set_updated_at before update on public.invoice_counters
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.bills
  for each row execute function private.set_updated_at();
create trigger set_updated_at before update on public.bill_payments
  for each row execute function private.set_updated_at();
