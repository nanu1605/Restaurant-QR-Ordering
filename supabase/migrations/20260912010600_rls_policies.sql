-- Row-level security helpers, policies and table privileges (spec §9.1).
--
-- Model:
--   * anon: no table privileges at all (customers go through server actions).
--   * authenticated: reads rows of restaurants they are an active member of.
--     Writes are allowed directly only on menu_* and (column-limited)
--     dining_tables; everything else changes through business functions.
--   * service_role bypasses RLS (server-only admin client).

-- ─── Helpers ────────────────────────────────────────────────────────────────
create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.platform_admins pa where pa.user_id = (select auth.uid())
  );
$$;

-- Role of the signed-in user in a restaurant, or null if not an active member.
create or replace function public.member_role(p_restaurant_id uuid)
returns public.member_role
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
  from public.restaurant_members m
  where m.restaurant_id = p_restaurant_id
    and m.user_id = (select auth.uid())
    and m.is_active;
$$;

create or replace function public.has_role(p_restaurant_id uuid, p_roles public.member_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.member_role(p_restaurant_id) = any (p_roles), false);
$$;

-- Restaurants where the signed-in user is an active member (optionally with one
-- of p_roles). Policies wrap it in (select …) so it runs once per statement.
create or replace function private.my_restaurant_ids(p_roles public.member_role[] default null)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.restaurant_id
  from public.restaurant_members m
  where m.user_id = (select auth.uid())
    and m.is_active
    and (p_roles is null or m.role = any (p_roles));
$$;

revoke execute on function public.is_platform_admin() from public, anon;
revoke execute on function public.member_role(uuid) from public, anon;
revoke execute on function public.has_role(uuid, public.member_role[]) from public, anon;
revoke execute on function private.my_restaurant_ids(public.member_role[]) from public, anon;
grant execute on function public.is_platform_admin() to authenticated, service_role;
grant execute on function public.member_role(uuid) to authenticated, service_role;
grant execute on function public.has_role(uuid, public.member_role[]) to authenticated, service_role;
grant execute on function private.my_restaurant_ids(public.member_role[]) to authenticated, service_role;

-- ─── Table privileges ───────────────────────────────────────────────────────
-- Belt and braces on top of the default-privilege changes in the core migration.
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke truncate, references, trigger on all tables in schema public from authenticated;

-- Tables that only business functions or the server may write.
revoke insert, update, delete on
  public.platform_admins,
  public.platform_settings,
  public.restaurants,
  public.restaurant_members,
  public.waiters,
  public.table_sessions,
  public.session_waiter_assignments,
  public.orders,
  public.order_items,
  public.invoice_counters,
  public.bills,
  public.bill_payments,
  public.audit_logs,
  public.restaurant_subscriptions,
  public.subscription_payments,
  public.webhook_events
from authenticated;

-- Invoice counters are internal to bill generation.
revoke select on public.invoice_counters from authenticated;

-- Tables are created through admin_create_tables (max_tables, server-side QR
-- token). Managers may rename, reorder and (de)activate them directly.
revoke insert, update, delete on public.dining_tables from authenticated;
grant update (label, sort_order, is_active) on public.dining_tables to authenticated;

-- Plans are never deleted (subscriptions reference them).
revoke delete on public.plans from authenticated;

-- ─── Enable RLS everywhere ──────────────────────────────────────────────────
alter table public.platform_admins enable row level security;
alter table public.platform_settings enable row level security;
alter table public.restaurants enable row level security;
alter table public.restaurant_members enable row level security;
alter table public.waiters enable row level security;
alter table public.dining_tables enable row level security;
alter table public.menu_categories enable row level security;
alter table public.menu_items enable row level security;
alter table public.menu_item_variants enable row level security;
alter table public.table_sessions enable row level security;
alter table public.session_waiter_assignments enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.invoice_counters enable row level security;
alter table public.bills enable row level security;
alter table public.bill_payments enable row level security;
alter table public.audit_logs enable row level security;
alter table public.plans enable row level security;
alter table public.restaurant_subscriptions enable row level security;
alter table public.subscription_payments enable row level security;
alter table public.webhook_events enable row level security;

-- ─── Platform ───────────────────────────────────────────────────────────────
create policy "platform admins read platform admins" on public.platform_admins
  for select to authenticated using ((select public.is_platform_admin()));

create policy "platform admins read platform settings" on public.platform_settings
  for select to authenticated using ((select public.is_platform_admin()));

create policy "platform admins read webhook events" on public.webhook_events
  for select to authenticated using ((select public.is_platform_admin()));

-- ─── Restaurants and members ────────────────────────────────────────────────
create policy "members and platform admins read restaurants" on public.restaurants
  for select to authenticated
  using (
    id in (select private.my_restaurant_ids())
    or (select public.is_platform_admin())
  );

create policy "members read their restaurant's members" on public.restaurant_members
  for select to authenticated
  using (restaurant_id in (select private.my_restaurant_ids()));

create policy "members read waiter profiles" on public.waiters
  for select to authenticated
  using (restaurant_id in (select private.my_restaurant_ids()));

-- ─── Tables and menu ────────────────────────────────────────────────────────
create policy "members read dining tables" on public.dining_tables
  for select to authenticated
  using (restaurant_id in (select private.my_restaurant_ids()));

create policy "managers update dining tables" on public.dining_tables
  for update to authenticated
  using (restaurant_id in (select private.my_restaurant_ids('{owner,manager}')))
  with check (restaurant_id in (select private.my_restaurant_ids('{owner,manager}')));

create policy "members read menu categories" on public.menu_categories
  for select to authenticated
  using (restaurant_id in (select private.my_restaurant_ids()));
create policy "managers insert menu categories" on public.menu_categories
  for insert to authenticated
  with check (restaurant_id in (select private.my_restaurant_ids('{owner,manager}')));
create policy "managers update menu categories" on public.menu_categories
  for update to authenticated
  using (restaurant_id in (select private.my_restaurant_ids('{owner,manager}')))
  with check (restaurant_id in (select private.my_restaurant_ids('{owner,manager}')));
create policy "managers delete menu categories" on public.menu_categories
  for delete to authenticated
  using (restaurant_id in (select private.my_restaurant_ids('{owner,manager}')));

create policy "members read menu items" on public.menu_items
  for select to authenticated
  using (restaurant_id in (select private.my_restaurant_ids()));
create policy "managers insert menu items" on public.menu_items
  for insert to authenticated
  with check (restaurant_id in (select private.my_restaurant_ids('{owner,manager}')));
create policy "managers update menu items" on public.menu_items
  for update to authenticated
  using (restaurant_id in (select private.my_restaurant_ids('{owner,manager}')))
  with check (restaurant_id in (select private.my_restaurant_ids('{owner,manager}')));
create policy "managers delete menu items" on public.menu_items
  for delete to authenticated
  using (restaurant_id in (select private.my_restaurant_ids('{owner,manager}')));

create policy "members read menu item variants" on public.menu_item_variants
  for select to authenticated
  using (restaurant_id in (select private.my_restaurant_ids()));
create policy "managers insert menu item variants" on public.menu_item_variants
  for insert to authenticated
  with check (restaurant_id in (select private.my_restaurant_ids('{owner,manager}')));
create policy "managers update menu item variants" on public.menu_item_variants
  for update to authenticated
  using (restaurant_id in (select private.my_restaurant_ids('{owner,manager}')))
  with check (restaurant_id in (select private.my_restaurant_ids('{owner,manager}')));
create policy "managers delete menu item variants" on public.menu_item_variants
  for delete to authenticated
  using (restaurant_id in (select private.my_restaurant_ids('{owner,manager}')));

-- ─── Sessions, orders, billing (read-only for members) ─────────────────────
create policy "members read table sessions" on public.table_sessions
  for select to authenticated
  using (restaurant_id in (select private.my_restaurant_ids()));

create policy "members read waiter assignments" on public.session_waiter_assignments
  for select to authenticated
  using (restaurant_id in (select private.my_restaurant_ids()));

create policy "members read orders" on public.orders
  for select to authenticated
  using (restaurant_id in (select private.my_restaurant_ids()));

create policy "members read order items" on public.order_items
  for select to authenticated
  using (restaurant_id in (select private.my_restaurant_ids()));

create policy "members read bills" on public.bills
  for select to authenticated
  using (restaurant_id in (select private.my_restaurant_ids()));

create policy "members read bill payments" on public.bill_payments
  for select to authenticated
  using (restaurant_id in (select private.my_restaurant_ids()));

-- invoice_counters: RLS on, no policies — internal to bill generation.

-- ─── Audit log ──────────────────────────────────────────────────────────────
create policy "managers and platform admins read audit logs" on public.audit_logs
  for select to authenticated
  using (
    restaurant_id in (select private.my_restaurant_ids('{owner,manager}'))
    or (select public.is_platform_admin())
  );

-- ─── Plans and subscriptions ────────────────────────────────────────────────
create policy "authenticated users read plans" on public.plans
  for select to authenticated using (true);
create policy "platform admins insert plans" on public.plans
  for insert to authenticated with check ((select public.is_platform_admin()));
create policy "platform admins update plans" on public.plans
  for update to authenticated
  using ((select public.is_platform_admin()))
  with check ((select public.is_platform_admin()));

create policy "owners and platform admins read subscriptions" on public.restaurant_subscriptions
  for select to authenticated
  using (
    restaurant_id in (select private.my_restaurant_ids('{owner}'))
    or (select public.is_platform_admin())
  );

create policy "owners and platform admins read subscription payments"
  on public.subscription_payments
  for select to authenticated
  using (
    restaurant_id in (select private.my_restaurant_ids('{owner}'))
    or (select public.is_platform_admin())
  );

-- ─── Realtime (spec §8.11; service_requests joins in Phase 9) ──────────────
alter publication supabase_realtime add table
  public.orders,
  public.order_items,
  public.table_sessions,
  public.bills,
  public.menu_items,
  public.waiters;
