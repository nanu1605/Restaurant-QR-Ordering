-- One free trial per restaurant, and a photo of its front (spec §8.2, §24 W3;
-- docs/DECISIONS.md P11-10 to P11-14). The website's signup now asks for the
-- FSSAI licence, the address, a GSTIN when there is one, and a photo of the
-- restaurant's front.
--
-- - A self-signup is refused when its FSSAI licence, mobile or GSTIN belongs to
--   a restaurant already: on any restaurant now, or as claimed by an earlier
--   self-signup. Claims stay when an owner edits Settings, so a second trial
--   can't be had by changing them. The platform admin's own onboarding isn't
--   checked: branches of a chain can share a GSTIN or a mobile.
-- - Lookalikes (same pincode, a similar name or address, or the same licence,
--   mobile or GSTIN) are only shown to the platform admin, never refused.
-- - The photo is stored in a private bucket; only the platform admin sees it,
--   through a short-lived signed link. Photos of signups that never finished
--   are deleted after a week by the daily cron.
--
-- Errors: INVALID_INPUT (a self-signup without its licence, mobile or photo, or
-- a malformed value), RESTAURANT_EXISTS (the restaurant already has an account).

create extension if not exists pg_trgm with schema extensions;

alter table public.restaurants
  add column storefront_photo_path text
    check (storefront_photo_path ~ '^signups/[0-9a-f-]{36}\.jpg$');

-- The last ten digits of a mobile, however it was typed ("+91 98765-43210",
-- "09876543210"); null when there are fewer than ten.
create or replace function private.phone10(p_phone text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when length(d) >= 10 then right(d, 10) end
  from (select regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') as d) digits;
$$;

-- What each self-signup's trial was given for. The key settles races; a row
-- is never changed or removed when the restaurant's details change.
create table public.trial_claims (
  kind text not null check (kind in ('fssai', 'phone', 'gstin')),
  value text not null check (length(value) between 10 and 15),
  restaurant_id uuid not null references public.restaurants (id),
  created_at timestamptz not null default now(),
  primary key (kind, value)
);

create index trial_claims_restaurant_idx on public.trial_claims (restaurant_id);

alter table public.trial_claims enable row level security;
revoke all on public.trial_claims from anon, authenticated;

-- True when a restaurant already has this licence, mobile or GSTIN, now or as
-- claimed by a trial. A missing value never matches.
-- ponytail: scans restaurants with a regexp per row; an expression index on
-- private.phone10(phone) when restaurants run into the tens of thousands.
create or replace function public.site_signup_identity_taken(
  p_fssai text,
  p_phone text,
  p_gstin text default null
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.trial_claims c
    where (c.kind = 'fssai' and c.value = btrim(p_fssai))
       or (c.kind = 'phone' and c.value = private.phone10(p_phone))
       or (c.kind = 'gstin' and c.value = upper(btrim(p_gstin)))
  ) or exists (
    select 1 from public.restaurants r
    where r.fssai_license = btrim(p_fssai)
       or private.phone10(r.phone) = private.phone10(p_phone)
       or r.gstin = upper(btrim(p_gstin))
  );
$$;

-- A self-signup's restaurant: platform_create_restaurant's payload plus
-- fssai_license, gstin (optional) and storefront_photo_path. Refuses a
-- restaurant that already has an account, and records the trial's claims.
create or replace function public.site_signup_create_restaurant(p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_fssai text := nullif(btrim(p_payload ->> 'fssai_license'), '');
  v_gstin text := nullif(upper(btrim(p_payload ->> 'gstin')), '');
  v_phone text := private.phone10(p_payload ->> 'phone');
  v_photo text := nullif(btrim(p_payload ->> 'storefront_photo_path'), '');
  v_result jsonb;
  v_restaurant_id uuid;
begin
  if v_fssai is null or v_phone is null or v_photo is null then
    perform private.fail('INVALID_INPUT', 'self_signup');
  end if;

  -- One self-signup at a time, so two can't both pass the check below.
  -- ponytail: one lock for every signup; per-value locks if signups ever queue on it.
  perform pg_advisory_xact_lock(hashtextextended('site_signup:trial_claims', 0));
  if public.site_signup_identity_taken(v_fssai, v_phone, v_gstin) then
    perform private.fail('RESTAURANT_EXISTS');
  end if;

  v_result := public.platform_create_restaurant(p_payload);
  v_restaurant_id := (v_result ->> 'restaurant_id')::uuid;
  update public.restaurants r
  set fssai_license = v_fssai, gstin = v_gstin, storefront_photo_path = v_photo
  where r.id = v_restaurant_id;
  insert into public.trial_claims (kind, value, restaurant_id)
  select c.kind, c.value, v_restaurant_id
  from (values ('fssai', v_fssai), ('phone', v_phone), ('gstin', v_gstin)) c (kind, value)
  where c.value is not null;
  return v_result;
exception
  when check_violation then
    perform private.fail('INVALID_INPUT');
end;
$$;

-- ─── Storefront photos ──────────────────────────────────────────────────────
-- Private, like menu-imports: no storage policies; the server uploads with the
-- service role and the platform admin sees a signed link.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('storefront-photos', 'storefront-photos', false, 2097152, array['image/jpeg'])
on conflict (id) do nothing;

-- Photos older than a week that no restaurant uses: their signup never finished.
create or replace function public.storefront_photos_to_remove(p_limit int default 200)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select o.name
  from storage.objects o
  where o.bucket_id = 'storefront-photos'
    and o.created_at < now() - interval '7 days'
    and not exists (select 1 from public.restaurants r where r.storefront_photo_path = o.name)
  order by o.created_at
  limit least(greatest(coalesce(p_limit, 200), 1), 1000);
$$;

-- ─── Lookalikes, for the platform admin ─────────────────────────────────────
-- Up to ten other restaurants that may be the same one, each with its reasons:
-- fssai, gstin, phone (the same value), name, address (60% alike by
-- trigrams), pincode (the same). Strongest first.
-- ponytail: compares with every restaurant (about 12 µs a pair, so 50 rows of
-- the list take a second at 1,500 restaurants); trigram and expression indexes,
-- or flags kept on the row, once restaurants run into the thousands.
create or replace function private.restaurant_lookalikes(p_restaurant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select r.id, private.normalize_name(r.name) as name,
      private.normalize_name(r.address_line) as address, r.pincode, r.fssai_license, r.gstin,
      private.phone10(r.phone) as phone
    from public.restaurants r
    where r.id = p_restaurant_id
  ),
  matches as (
    select o.id, o.name, o.slug, o.city, o.created_at,
      array_remove(array[
        case when o.fssai_license = me.fssai_license then 'fssai' end,
        case when o.gstin = me.gstin then 'gstin' end,
        case when private.phone10(o.phone) = me.phone then 'phone' end,
        case when extensions.similarity(private.normalize_name(o.name), me.name) >= 0.6
          then 'name' end,
        case when extensions.similarity(private.normalize_name(o.address_line), me.address) >= 0.6
          then 'address' end,
        case when o.pincode = me.pincode then 'pincode' end
      ], null) as reasons
    from public.restaurants o
    cross join me
    where o.id <> me.id
  ),
  top as (
    select * from matches
    where cardinality(reasons) > 0
    order by cardinality(reasons) desc, created_at
    limit 10
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object('restaurant_id', t.id, 'name', t.name, 'slug', t.slug, 'city', t.city,
        'reasons', to_jsonb(t.reasons))
      order by cardinality(t.reasons) desc, t.created_at
    ),
    '[]'::jsonb
  )
  from top t;
$$;

-- {restaurant_id: lookalikes} for up to 100 restaurants (a list page, or one detail page).
create or replace function public.platform_restaurant_lookalikes(p_restaurant_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.current_platform_admin();
begin
  if coalesce(cardinality(p_restaurant_ids), 0) > 100 then
    perform private.fail('INVALID_INPUT', 'restaurant_ids');
  end if;
  return coalesce(
    (select jsonb_object_agg(r.id, private.restaurant_lookalikes(r.id))
     from public.restaurants r
     where r.id = any (p_restaurant_ids)),
    '{}'::jsonb
  );
end;
$$;

revoke execute on function private.phone10(text) from public, anon, authenticated;
revoke execute on function private.restaurant_lookalikes(uuid) from public, anon, authenticated;
revoke execute on function public.site_signup_identity_taken(text, text, text) from public, anon, authenticated;
revoke execute on function public.site_signup_create_restaurant(jsonb) from public, anon, authenticated;
revoke execute on function public.storefront_photos_to_remove(int) from public, anon, authenticated;
revoke execute on function public.platform_restaurant_lookalikes(uuid[]) from public, anon;
grant execute on function public.site_signup_identity_taken(text, text, text) to service_role;
grant execute on function public.site_signup_create_restaurant(jsonb) to service_role;
grant execute on function public.storefront_photos_to_remove(int) to service_role;
grant execute on function public.platform_restaurant_lookalikes(uuid[]) to authenticated;
