-- Core building blocks: private schema, privilege defaults, shared helpers and enums.

-- ─── Private schema ─────────────────────────────────────────────────────────
-- Internal helpers live here. PostgREST does not expose this schema; roles get
-- USAGE only so RLS policies can call the helpers granted to them.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

-- ─── Privilege defaults (spec §9.1: anon gets no table access) ─────────────
-- Supabase grants everything on new public objects to anon/authenticated by
-- default. Tables created from here on are not granted to anon at all, and
-- authenticated never gets TRUNCATE/REFERENCES/TRIGGER (not covered by RLS).
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public
  revoke truncate, references, trigger on tables from authenticated;
-- Functions: per-schema default privileges cannot remove PostgreSQL's global
-- EXECUTE-to-PUBLIC default, so every migration revokes EXECUTE explicitly
-- right after creating a function and grants it only to the roles that need it.
-- supabase/tests/database/010_schema_guards.test.sql enforces this.

-- ─── Shared helpers ─────────────────────────────────────────────────────────
create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Used in CHECK constraints, so declared immutable; the tz database only
-- changes on server upgrades.
create or replace function private.is_valid_timezone(p_tz text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  perform now() at time zone p_tz;
  return true;
exception
  when others then
    return false;
end;
$$;

revoke execute on function private.is_valid_timezone(text) from public, anon;
grant execute on function private.is_valid_timezone(text) to authenticated, service_role;

-- Unbiased random base62 string (rejection sampling), e.g. 16 chars ≈ 95 bits
-- for table QR tokens.
create or replace function private.random_base62(p_length int)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  result text := '';
  buf bytea;
  b int;
begin
  if p_length is null or p_length < 1 then
    raise exception 'random_base62: length must be positive';
  end if;
  while length(result) < p_length loop
    buf := extensions.gen_random_bytes(32);
    for i in 0..31 loop
      b := get_byte(buf, i);
      -- 248 = 62 * 4: accept only bytes that map uniformly onto the alphabet.
      if b < 248 then
        result := result || substr(alphabet, (b % 62) + 1, 1);
        exit when length(result) = p_length;
      end if;
    end loop;
  end loop;
  return result;
end;
$$;

revoke execute on function private.set_updated_at() from public, anon, authenticated;
revoke execute on function private.random_base62(int) from public, anon, authenticated;

-- ─── Enums ──────────────────────────────────────────────────────────────────
create type public.gst_mode as enum ('none', 'regular', 'composition');
create type public.paper_width as enum ('58mm', '80mm');
create type public.restaurant_status as enum ('active', 'suspended');
create type public.member_role as enum ('owner', 'manager', 'waiter', 'kitchen');
create type public.category_source as enum ('default', 'manual', 'import');
create type public.food_type as enum ('veg', 'non_veg', 'egg');
create type public.session_status as enum ('open', 'billed', 'closed_unbilled');
create type public.unassign_reason as enum ('reassigned', 'billed', 'closed_unbilled', 'manual');
create type public.order_status as enum ('pending_approval', 'accepted', 'rejected', 'removed');
create type public.order_placed_via as enum ('customer', 'staff');
create type public.order_item_status as enum (
  'placed', 'preparing', 'ready', 'served', 'cancelled', 'removed'
);
create type public.document_type as enum ('tax_invoice', 'bill_of_supply', 'bill');
create type public.discount_type as enum ('none', 'flat', 'percent');
create type public.payment_status as enum ('unpaid', 'paid');
create type public.bill_status as enum ('active', 'void');
create type public.payment_mode as enum ('cash', 'upi', 'card', 'other');
create type public.actor_type as enum ('staff', 'customer', 'system', 'platform_admin');
create type public.billing_cycle as enum ('monthly', 'yearly');
create type public.subscription_status as enum (
  'trialing', 'active', 'past_due', 'halted', 'cancelled', 'expired'
);
create type public.subscription_source as enum ('razorpay', 'manual');
create type public.subscription_payment_source as enum ('razorpay', 'manual', 'payment_link');
create type public.manual_payment_mode as enum ('bank_transfer', 'cash', 'upi', 'cheque');
