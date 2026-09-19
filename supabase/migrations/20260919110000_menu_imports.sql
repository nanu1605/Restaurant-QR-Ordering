-- Menu import from photos and CSV (spec §8.4, §20A; docs/DECISIONS.md P7-12 to P7-20).
-- The browser uploads page photos to the private menu-imports bucket, the
-- server reads them one page at a time, the owner reviews the draft, and one
-- transaction writes the menu. Nothing reaches the menu before the commit.

create type public.menu_import_source as enum ('photo', 'csv');
create type public.menu_import_status as enum (
  'uploaded', 'processing', 'review', 'imported', 'failed', 'discarded'
);

create table public.menu_imports (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id),
  source public.menu_import_source not null,
  status public.menu_import_status not null,
  -- One JPEG per page in the menu-imports bucket: <restaurant_id>/<import_id>/page-<n>.jpg
  file_paths text[] not null default '{}',
  page_count int not null check (page_count between 0 and 10),
  -- Per page: { index, status: pending|done|failed, error, notes, provider, model,
  -- input_tokens, output_tokens, cost_paise, result }.
  pages jsonb not null default '[]' check (jsonb_typeof(pages) = 'array'),
  model text,
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  -- Null once any page's cost is unknown (a provider without a price).
  cost_paise bigint default 0 check (cost_paise >= 0),
  -- Model output as received, keyed by page number.
  raw_result jsonb,
  draft jsonb check (draft is null or jsonb_typeof(draft) = 'object'),
  error text check (length(error) <= 500),
  imported_counts jsonb,
  -- Set when the daily cleanup has deleted the page photos.
  files_removed_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index menu_imports_restaurant_created_idx
  on public.menu_imports (restaurant_id, created_at desc);
create index menu_imports_cleanup_idx
  on public.menu_imports (created_at) where files_removed_at is null;

create trigger set_updated_at before update on public.menu_imports
  for each row execute function private.set_updated_at();

alter table public.menu_imports enable row level security;
revoke insert, update, delete on public.menu_imports from authenticated;

create policy "owners, managers and platform admins read menu imports" on public.menu_imports
  for select to authenticated
  using (
    restaurant_id in (select private.my_restaurant_ids('{owner,manager}'))
    or (select public.is_platform_admin())
  );

-- Page photos: private. The server hands out signed upload URLs after the
-- permission check and reads the files with the service role, so signed-in
-- users get no storage policy at all.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('menu-imports', 'menu-imports', false, 2097152, array['image/jpeg'])
on conflict (id) do nothing;

-- ─── Who may import ─────────────────────────────────────────────────────────
create type private.import_actor as (
  restaurant_id uuid,
  user_id uuid,
  actor_type public.actor_type,
  role public.member_role,
  label text
);

-- The restaurant's owner or manager, or a platform admin (aal2) for any
-- restaurant. Everyone else gets FORBIDDEN.
create or replace function private.menu_import_actor(p_restaurant_id uuid)
returns private.import_actor
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor private.import_actor;
  v_admin private.platform_admin_context;
begin
  select m.restaurant_id, m.user_id, 'staff'::public.actor_type, m.role, m.display_name
    into v_actor
    from public.restaurant_members m
    where m.user_id = (select auth.uid())
      and m.restaurant_id = p_restaurant_id
      and m.is_active
      and m.role in ('owner', 'manager');
  if found then
    return v_actor;
  end if;

  v_admin := private.current_platform_admin();
  if not exists (select 1 from public.restaurants r where r.id = p_restaurant_id) then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;
  return row(
    p_restaurant_id, v_admin.user_id, 'platform_admin', null, 'Platform admin'
  )::private.import_actor;
end;
$$;

-- The import, locked, after checking the caller may work on it.
create or replace function private.lock_menu_import(p_import_id uuid)
returns public.menu_imports
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_import public.menu_imports;
begin
  select * into v_import from public.menu_imports i where i.id = p_import_id for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  perform private.menu_import_actor(v_import.restaurant_id);
  return v_import;
end;
$$;

revoke execute on function private.menu_import_actor(uuid) from public, anon, authenticated;
revoke execute on function private.lock_menu_import(uuid) from public, anon, authenticated;

-- ─── Create ─────────────────────────────────────────────────────────────────
-- A photo import gets one storage path per page; a CSV import starts in
-- processing and gets its draft straight away. At most 5 photo imports per
-- restaurant in 24 hours (they cost money; CSV does not).
create or replace function public.menu_import_create(
  p_restaurant_id uuid,
  p_source text,
  p_page_count int
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor private.import_actor := private.menu_import_actor(p_restaurant_id);
  v_id uuid := gen_random_uuid();
  v_pages int;
  v_paths text[] := '{}';
begin
  perform private.assert_full_access(p_restaurant_id);

  if p_source = 'photo' then
    if p_page_count is null or p_page_count not between 1 and 10 then
      perform private.fail('INVALID_INPUT', 'page_count');
    end if;
    v_pages := p_page_count;

    -- Serialise concurrent creates so the daily count holds. Only imports
    -- that reached the reader count: the limit is there to cap what the
    -- reader costs, and an import whose photos were never read costs nothing.
    perform 1 from public.restaurants r where r.id = p_restaurant_id for update;
    if (
      select count(*) from public.menu_imports i
      where i.restaurant_id = p_restaurant_id
        and i.source = 'photo'
        and i.created_at > now() - interval '24 hours'
        and exists (
          select 1 from jsonb_array_elements(i.pages) as p where p ->> 'status' <> 'pending'
        )
    ) >= 5 then
      perform private.fail('IMPORT_LIMIT_REACHED');
    end if;

    v_paths := array(
      select p_restaurant_id::text || '/' || v_id::text || '/page-' || g || '.jpg'
      from generate_series(1, v_pages) as g
    );
  elsif p_source = 'csv' then
    v_pages := 0;
  else
    perform private.fail('INVALID_INPUT', 'source');
  end if;

  insert into public.menu_imports (
    id, restaurant_id, source, status, file_paths, page_count, pages, created_by
  )
  values (
    v_id,
    p_restaurant_id,
    p_source::public.menu_import_source,
    case when p_source = 'photo' then 'uploaded' else 'processing' end::public.menu_import_status,
    v_paths,
    v_pages,
    (
      select coalesce(
        jsonb_agg(jsonb_build_object('index', g, 'status', 'pending') order by g), '[]'::jsonb
      )
      from generate_series(1, v_pages) as g
    ),
    v_actor.user_id
  );

  return jsonb_build_object('import_id', v_id, 'file_paths', to_jsonb(v_paths));
end;
$$;

-- ─── Read one page ──────────────────────────────────────────────────────────
-- Claims a page so two browser tabs (or a reload) don't pay to read the same
-- one twice. A claim lapses after 3 minutes, longer than a page can take, so a
-- read that never came back can be tried again. Returns false when the page is
-- done or someone else is reading it. Service role only: the server reads the
-- page, and the tokens and cost it records must not come from the browser.
create or replace function public.menu_import_claim_page(p_import_id uuid, p_index int)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_import public.menu_imports;
  v_page jsonb;
begin
  select * into v_import from public.menu_imports i where i.id = p_import_id for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  if v_import.source <> 'photo' or v_import.status not in ('uploaded', 'processing') then
    return false;
  end if;
  if p_index is null or p_index not between 1 and v_import.page_count then
    perform private.fail('INVALID_INPUT', 'index');
  end if;

  v_page := v_import.pages -> (p_index - 1);
  if v_page ->> 'status' = 'done'
     or (
       v_page ->> 'status' = 'reading'
       and (v_page ->> 'claimed_at')::timestamptz > now() - interval '3 minutes'
     ) then
    return false;
  end if;

  update public.menu_imports i
    set status = 'processing',
        pages = jsonb_set(
          i.pages,
          array[(p_index - 1)::text],
          v_page || jsonb_build_object('status', 'reading', 'claimed_at', now())
        )
    where i.id = p_import_id;
  return true;
end;
$$;

-- p_page: { index (1-based), status: done|failed, error?, notes?, provider?, model?,
-- input_tokens?, output_tokens?, cost_paise?, result?, raw? }. Tokens and cost
-- add up across retries, including a read of a page someone else finished
-- first: every call is paid for, so every call is counted. The first result
-- read is the one kept. Service role only (see the claim above).
create or replace function public.menu_import_record_page(p_import_id uuid, p_page jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_import public.menu_imports;
  v_done boolean;
  v_old jsonb;
  v_index int;
  v_status text;
  v_error text;
  v_notes text;
  v_provider text;
  v_model text;
  v_in bigint := 0;
  v_out bigint := 0;
  v_cost bigint;
  v_entry jsonb;
  v_pages jsonb;
begin
  select * into v_import from public.menu_imports i where i.id = p_import_id for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  if v_import.source <> 'photo' or v_import.status not in ('uploaded', 'processing') then
    perform private.fail('IMPORT_NOT_OPEN');
  end if;
  perform private.assert_keys(p_page, array[
    'index', 'status', 'error', 'notes', 'provider', 'model', 'input_tokens', 'output_tokens',
    'cost_paise', 'result', 'raw'
  ]);
  if octet_length(p_page::text) > 1000000 then
    perform private.fail('INVALID_INPUT', 'size');
  end if;

  v_index := private.json_int(p_page, 'index');
  if v_index not between 1 and v_import.page_count then
    perform private.fail('INVALID_INPUT', 'index');
  end if;
  v_old := v_import.pages -> (v_index - 1);
  v_done := v_old ->> 'status' = 'done';

  v_status := private.json_text(p_page, 'status');
  if v_status is null or v_status not in ('done', 'failed') then
    perform private.fail('INVALID_INPUT', 'status');
  end if;
  if v_status = 'done' and jsonb_typeof(p_page -> 'result') is distinct from 'object' then
    perform private.fail('INVALID_INPUT', 'result');
  end if;

  v_error := left(private.json_text(p_page, 'error'), 500);
  v_notes := left(private.json_text(p_page, 'notes'), 500);
  v_provider := left(private.json_text(p_page, 'provider'), 40);
  v_model := left(private.json_text(p_page, 'model'), 100);
  if p_page ? 'input_tokens' then
    v_in := private.json_int(p_page, 'input_tokens');
  end if;
  if p_page ? 'output_tokens' then
    v_out := private.json_int(p_page, 'output_tokens');
  end if;
  if jsonb_typeof(p_page -> 'cost_paise') = 'number' then
    v_cost := private.json_int(p_page, 'cost_paise');
  end if;
  if v_in < 0 or v_out < 0 or v_cost < 0 then
    perform private.fail('INVALID_INPUT', 'usage');
  end if;

  -- A page another reader finished first keeps its result; only the usage adds up.
  v_entry := jsonb_build_object(
    'index', v_index,
    'status', case when v_done then 'done' else v_status end,
    'error', case when v_done then v_old ->> 'error' else v_error end,
    'notes', case when v_done then v_old ->> 'notes' else v_notes end,
    'provider', case when v_done then v_old ->> 'provider' else v_provider end,
    'model', case when v_done then v_old ->> 'model' else v_model end,
    'input_tokens', v_in + coalesce((v_old ->> 'input_tokens')::bigint, 0),
    'output_tokens', v_out + coalesce((v_old ->> 'output_tokens')::bigint, 0),
    'cost_paise', case
      when v_cost is null or (v_old ? 'cost_paise' and v_old ->> 'cost_paise' is null) then null
      else v_cost + coalesce((v_old ->> 'cost_paise')::bigint, 0)
    end,
    'result', case when v_done then v_old -> 'result' when v_status = 'done' then p_page -> 'result' end
  );
  v_pages := jsonb_set(v_import.pages, array[(v_index - 1)::text], v_entry);

  update public.menu_imports i
    set status = 'processing',
        pages = v_pages,
        model = coalesce(v_model, i.model),
        input_tokens = i.input_tokens + v_in,
        output_tokens = i.output_tokens + v_out,
        -- Unknown once any call's cost is unknown.
        cost_paise = case
          when v_cost is null and (v_in > 0 or v_out > 0 or v_status = 'done') then null
          else i.cost_paise + coalesce(v_cost, 0)
        end,
        raw_result = case
          when p_page ? 'raw' and not v_done then
            coalesce(i.raw_result, '{}'::jsonb) || jsonb_build_object(v_index::text, p_page -> 'raw')
          else i.raw_result
        end
    where i.id = p_import_id;

  return jsonb_build_object(
    'total', v_import.page_count,
    'done', (select count(*) from jsonb_array_elements(v_pages) p where p ->> 'status' = 'done'),
    'failed', (select count(*) from jsonb_array_elements(v_pages) p where p ->> 'status' = 'failed')
  );
end;
$$;

-- ─── Draft ──────────────────────────────────────────────────────────────────
-- p_status 'review': store the draft (after reading, after a CSV, or "Save
-- draft and finish later"). p_status 'failed': nothing could be read; p_error
-- says why.
create or replace function public.menu_import_set_draft(
  p_import_id uuid,
  p_status text,
  p_draft jsonb default null,
  p_error text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_import public.menu_imports := private.lock_menu_import(p_import_id);
  v_error text := private.tidy_text(p_error);
begin
  if p_status = 'review' then
    if v_import.status not in ('uploaded', 'processing', 'review') then
      perform private.fail('IMPORT_NOT_OPEN');
    end if;
    if jsonb_typeof(p_draft) is distinct from 'object'
       or jsonb_typeof(p_draft -> 'categories') is distinct from 'array' then
      perform private.fail('INVALID_INPUT', 'draft');
    end if;
    if octet_length(p_draft::text) > 2000000 then
      perform private.fail('INVALID_INPUT', 'size');
    end if;
    update public.menu_imports i
      set status = 'review', draft = p_draft, error = null
      where i.id = p_import_id;
  elsif p_status = 'failed' then
    if v_import.status not in ('uploaded', 'processing') then
      perform private.fail('IMPORT_NOT_OPEN');
    end if;
    if v_error is null or length(v_error) > 500 then
      perform private.fail('INVALID_INPUT', 'error');
    end if;
    update public.menu_imports i
      set status = 'failed', error = v_error, completed_at = now()
      where i.id = p_import_id;
  else
    perform private.fail('INVALID_INPUT', 'status');
  end if;
end;
$$;

-- ─── Commit ─────────────────────────────────────────────────────────────────
-- One transaction (spec §20A.5). p_draft is the reviewed draft:
-- { categories: [{ name, skip?, show_hidden?, items: [{ name, description?, food_type,
--   price_paise?, variants: [{ name, price_paise }], action: import|skip|update_price,
--   existing_item_id? }] }] } (other keys are the review screen's and are kept).
-- Categories match existing ones ignoring case and spacing, hidden ones included;
-- a matched hidden category stays hidden unless show_hidden. New categories and
-- items go to the end. update_price sets the price of an existing dish, or the
-- prices of its options with the same names. food_type 'unknown' becomes veg
-- only with p_confirm_food_types (the owner confirmed the rows). Committing an
-- import again changes nothing and returns its counts with already_imported.
create or replace function public.menu_import_commit(
  p_import_id uuid,
  p_draft jsonb,
  p_confirm_food_types boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_import public.menu_imports := private.lock_menu_import(p_import_id);
  v_actor private.import_actor := private.menu_import_actor(v_import.restaurant_id);
  v_restaurant uuid := v_import.restaurant_id;
  v_cat jsonb;
  v_item jsonb;
  v_variant jsonb;
  v_action text;
  v_cat_name text;
  v_cat_id uuid;
  v_cat_active boolean;
  v_cat_new boolean;
  v_name text;
  v_description text;
  v_food_type text;
  v_price bigint;
  v_variants jsonb;
  v_vname text;
  v_vprice bigint;
  v_vnames text[];
  v_vprices bigint[];
  v_item_id uuid;
  v_ord bigint;
  v_categories_created int := 0;
  v_categories_shown int := 0;
  v_items_created int := 0;
  v_items_updated int := 0;
  v_items_skipped int := 0;
  v_counts jsonb;
begin
  if v_import.status = 'imported' then
    return coalesce(v_import.imported_counts, '{}'::jsonb)
      || jsonb_build_object('already_imported', true);
  end if;
  if v_import.status <> 'review' then
    perform private.fail('IMPORT_NOT_OPEN');
  end if;
  perform private.assert_full_access(v_restaurant);

  -- Shape first, so a malformed draft fails with INVALID_INPUT, not a cast error.
  if jsonb_typeof(p_draft) is distinct from 'object'
     or jsonb_typeof(p_draft -> 'categories') is distinct from 'array'
     or jsonb_array_length(p_draft -> 'categories') > 200
     or octet_length(p_draft::text) > 2000000 then
    perform private.fail('INVALID_INPUT', 'draft');
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_draft -> 'categories') as c
    where jsonb_typeof(c) <> 'object' or jsonb_typeof(c -> 'items') is distinct from 'array'
  ) or exists (
    select 1
    from jsonb_array_elements(p_draft -> 'categories') as c,
      jsonb_array_elements(c -> 'items') as i
    where jsonb_typeof(i) <> 'object'
      or (i ->> 'action') is null
      or (i ->> 'action') not in ('import', 'skip', 'update_price')
      or jsonb_typeof(coalesce(i -> 'variants', '[]'::jsonb)) <> 'array'
  ) then
    perform private.fail('INVALID_INPUT', 'draft');
  end if;

  if (
    select count(*)
    from jsonb_array_elements(p_draft -> 'categories') as c,
      jsonb_array_elements(c -> 'items') as i
    where c -> 'skip' is distinct from 'true'::jsonb and i ->> 'action' <> 'skip'
  ) > 500 then
    perform private.fail('IMPORT_TOO_LARGE');
  end if;

  if not coalesce(p_confirm_food_types, false) and exists (
    select 1
    from jsonb_array_elements(p_draft -> 'categories') as c,
      jsonb_array_elements(c -> 'items') as i
    where c -> 'skip' is distinct from 'true'::jsonb
      and i ->> 'action' = 'import'
      and coalesce(i ->> 'food_type', 'unknown') = 'unknown'
  ) then
    perform private.fail('FOOD_TYPE_UNCONFIRMED');
  end if;

  for v_cat in select value from jsonb_array_elements(p_draft -> 'categories') loop
    if v_cat -> 'skip' = 'true'::jsonb then
      v_items_skipped := v_items_skipped + jsonb_array_length(v_cat -> 'items');
      continue;
    end if;

    v_cat_id := null;
    v_cat_new := exists (
      select 1 from jsonb_array_elements(v_cat -> 'items') as i where i ->> 'action' = 'import'
    );
    -- A category is looked up for new dishes, and to show it again when the
    -- owner asked for that (even if the rows only update prices).
    if v_cat_new or v_cat -> 'show_hidden' = 'true'::jsonb then
      v_cat_name := private.tidy_text(private.json_text(v_cat, 'name'));
      if v_cat_name is null or length(v_cat_name) > 60 then
        perform private.fail('INVALID_CATEGORY_NAME', v_cat_name);
      end if;

      select c.id, c.is_active into v_cat_id, v_cat_active
        from public.menu_categories c
        where c.restaurant_id = v_restaurant
          and private.normalize_name(c.name) = private.normalize_name(v_cat_name)
        for update;
      if v_cat_id is null and not v_cat_new then
        -- Nothing new to put in it: no category is created.
        null;
      elsif v_cat_id is null then
        insert into public.menu_categories (restaurant_id, name, sort_order, source)
        values (
          v_restaurant,
          v_cat_name,
          (select coalesce(max(c.sort_order), 0) + 1
             from public.menu_categories c where c.restaurant_id = v_restaurant),
          'import'
        )
        returning id into v_cat_id;
        v_categories_created := v_categories_created + 1;
      elsif not v_cat_active and v_cat -> 'show_hidden' = 'true'::jsonb then
        update public.menu_categories c set is_active = true where c.id = v_cat_id;
        v_categories_shown := v_categories_shown + 1;
      end if;
    end if;

    for v_item in select value from jsonb_array_elements(v_cat -> 'items') loop
      v_action := v_item ->> 'action';
      if v_action = 'skip' then
        v_items_skipped := v_items_skipped + 1;
        continue;
      end if;

      -- Fields and options, checked like admin_save_menu_item.
      v_name := private.tidy_text(private.json_text(v_item, 'name'));
      if v_name is null or length(v_name) > 80 then
        perform private.fail('INVALID_ITEM_NAME', v_name);
      end if;
      v_variants := coalesce(v_item -> 'variants', '[]'::jsonb);
      if jsonb_array_length(v_variants) > 20 then
        perform private.fail('INVALID_INPUT', 'variants');
      end if;
      v_vnames := '{}';
      v_vprices := '{}';
      for v_variant in select value from jsonb_array_elements(v_variants) loop
        if jsonb_typeof(v_variant) <> 'object' then
          perform private.fail('INVALID_INPUT', 'variants');
        end if;
        v_vname := private.tidy_text(private.json_text(v_variant, 'name'));
        if v_vname is null or length(v_vname) > 40 then
          perform private.fail('INVALID_VARIANT_NAME', v_name);
        end if;
        if private.normalize_name(v_vname) = any (v_vnames) then
          perform private.fail('VARIANT_NAME_DUPLICATE', v_name);
        end if;
        v_vprice := private.json_int(v_variant, 'price_paise');
        perform private.assert_price(v_vprice, v_name);
        v_vnames := v_vnames || private.normalize_name(v_vname);
        v_vprices := v_vprices || v_vprice;
      end loop;
      if cardinality(v_vprices) > 0 then
        select min(x) into v_price from unnest(v_vprices) as x;
      else
        if jsonb_typeof(v_item -> 'price_paise') is distinct from 'number' then
          perform private.fail('INVALID_PRICE', v_name);
        end if;
        v_price := private.json_int(v_item, 'price_paise');
        perform private.assert_price(v_price, v_name);
      end if;

      if v_action = 'update_price' then
        v_item_id := private.json_uuid(v_item, 'existing_item_id');
        perform 1 from public.menu_items i
          where i.id = v_item_id and i.restaurant_id = v_restaurant and i.is_active
          for update;
        if not found then
          perform private.fail('NOT_FOUND', 'existing_item_id');
        end if;

        -- A price update only makes sense when the row and the dish have the
        -- same shape: one price, or the same option names.
        if exists (
          select 1 from public.menu_item_variants mv
          where mv.menu_item_id = v_item_id and mv.is_active
        ) then
          if cardinality(v_vnames) = 0 then
            perform private.fail('ITEM_HAS_VARIANTS', v_name);
          end if;
          if exists (
            select 1 from unnest(v_vnames) as n
            where not exists (
              select 1 from public.menu_item_variants mv
              where mv.menu_item_id = v_item_id
                and mv.is_active
                and private.normalize_name(mv.name) = n
            )
          ) then
            perform private.fail('VARIANTS_DIFFER', v_name);
          end if;

          -- Options keep their names; each one gets the new price.
          for v_variant in select value from jsonb_array_elements(v_variants) loop
            update public.menu_item_variants mv
              set price_paise = (v_variant ->> 'price_paise')::bigint
              where mv.menu_item_id = v_item_id
                and mv.is_active
                and private.normalize_name(mv.name) = private.normalize_name(v_variant ->> 'name');
          end loop;
          update public.menu_items i
            set price_paise = (
              select min(mv.price_paise) from public.menu_item_variants mv
              where mv.menu_item_id = v_item_id and mv.is_active
            )
            where i.id = v_item_id;
        else
          if cardinality(v_vnames) > 0 then
            perform private.fail('VARIANTS_DIFFER', v_name);
          end if;
          update public.menu_items i set price_paise = v_price where i.id = v_item_id;
        end if;
        v_items_updated := v_items_updated + 1;
        continue;
      end if;

      -- A new dish.
      v_description := nullif(btrim(private.json_text(v_item, 'description')), '');
      if length(v_description) > 300 then
        perform private.fail('INVALID_INPUT', 'description');
      end if;
      v_food_type := coalesce(private.json_text(v_item, 'food_type'), 'unknown');
      if v_food_type = 'unknown' then
        v_food_type := 'veg';
      elsif v_food_type not in ('veg', 'non_veg', 'egg') then
        perform private.fail('INVALID_INPUT', 'food_type');
      end if;

      insert into public.menu_items (
        restaurant_id, category_id, name, description, price_paise, food_type, sort_order
      )
      values (
        v_restaurant, v_cat_id, v_name, v_description, v_price,
        v_food_type::public.food_type,
        (select coalesce(max(i.sort_order), 0) + 1 from public.menu_items i
          where i.restaurant_id = v_restaurant and i.category_id = v_cat_id)
      )
      returning id into v_item_id;

      for v_variant, v_ord in
        select value, ordinality from jsonb_array_elements(v_variants) with ordinality
      loop
        insert into public.menu_item_variants (
          restaurant_id, menu_item_id, name, price_paise, sort_order
        )
        values (
          v_restaurant, v_item_id, private.tidy_text(v_variant ->> 'name'),
          (v_variant ->> 'price_paise')::bigint, v_ord
        );
      end loop;
      v_items_created := v_items_created + 1;
    end loop;
  end loop;

  v_counts := jsonb_build_object(
    'categories_created', v_categories_created,
    'categories_shown', v_categories_shown,
    'items_created', v_items_created,
    'items_updated', v_items_updated,
    'items_skipped', v_items_skipped
  );

  update public.menu_imports i
    set status = 'imported', draft = p_draft, imported_counts = v_counts, completed_at = now()
    where i.id = p_import_id;

  perform private.write_audit(
    v_restaurant, v_actor.actor_type, v_actor.user_id, v_actor.role, v_actor.label,
    'menu.imported', 'menu_import', p_import_id, null,
    v_counts || jsonb_build_object('source', v_import.source), null
  );
  return v_counts;
end;
$$;

-- ─── Discard ────────────────────────────────────────────────────────────────
create or replace function public.menu_import_discard(p_import_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_import public.menu_imports := private.lock_menu_import(p_import_id);
begin
  if v_import.status = 'imported' then
    perform private.fail('IMPORT_NOT_OPEN');
  end if;
  if v_import.status <> 'discarded' then
    update public.menu_imports i
      set status = 'discarded', completed_at = now()
      where i.id = p_import_id;
  end if;
end;
$$;

-- ─── Cleanup (daily cron, service role) ─────────────────────────────────────
-- Imports whose page photos can go: finished (imported, failed, discarded)
-- more than 7 days ago, or started more than 30 days ago and never finished.
create or replace function public.menu_import_files_to_remove(p_limit int default 200)
returns table (import_id uuid, file_paths text[])
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, i.file_paths
  from public.menu_imports i
  where i.files_removed_at is null
    and cardinality(i.file_paths) > 0
    and (
      (i.status in ('imported', 'failed', 'discarded') and i.completed_at < now() - interval '7 days')
      or i.created_at < now() - interval '30 days'
    )
  order by i.created_at
  limit least(greatest(coalesce(p_limit, 200), 1), 1000);
$$;

create or replace function public.menu_import_mark_files_removed(p_import_ids uuid[])
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  update public.menu_imports i
    set files_removed_at = now()
    where i.id = any (p_import_ids) and i.files_removed_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.menu_import_create(uuid, text, int) from public, anon;
revoke execute on function public.menu_import_claim_page(uuid, int)
  from public, anon, authenticated;
revoke execute on function public.menu_import_record_page(uuid, jsonb)
  from public, anon, authenticated;
revoke execute on function public.menu_import_set_draft(uuid, text, jsonb, text) from public, anon;
revoke execute on function public.menu_import_commit(uuid, jsonb, boolean) from public, anon;
revoke execute on function public.menu_import_discard(uuid) from public, anon;
revoke execute on function public.menu_import_files_to_remove(int) from public, anon, authenticated;
revoke execute on function public.menu_import_mark_files_removed(uuid[])
  from public, anon, authenticated;
grant execute on function public.menu_import_create(uuid, text, int) to authenticated;
grant execute on function public.menu_import_claim_page(uuid, int) to service_role;
grant execute on function public.menu_import_record_page(uuid, jsonb) to service_role;
grant execute on function public.menu_import_set_draft(uuid, text, jsonb, text) to authenticated;
grant execute on function public.menu_import_commit(uuid, jsonb, boolean) to authenticated;
grant execute on function public.menu_import_discard(uuid) to authenticated;
grant execute on function public.menu_import_files_to_remove(int) to service_role;
grant execute on function public.menu_import_mark_files_removed(uuid[]) to service_role;
