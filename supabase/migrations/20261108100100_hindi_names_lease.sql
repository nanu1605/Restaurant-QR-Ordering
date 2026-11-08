-- Restartable jobs: the automatic Hindi names (docs/DECISIONS.md VPS-27).
--
-- A fill leases the names it works on for five minutes, instead of stamping them as tried when it
-- takes them, and settles each batch the moment it answers: the names it found are stored and
-- name_hi_auto_tried_at is stamped. A fill that is cut off settles nothing, so its names are leased
-- again once the lease runs out, not left for twelve hours. A name the model can't write is still
-- tried again after twelve hours (HN-8). Only name_hi_auto is ever written: an owner's own Hindi
-- name stays theirs (HN-5). The previous build's claim stays one release for the deploy overlap,
-- and now leaves leased names alone.

-- ─── Columns and indexes ────────────────────────────────────────────────────
-- Null: not leased. No default, so the tables aren't rewritten.
alter table public.menu_items add column name_hi_auto_lease_until timestamptz;
alter table public.menu_categories add column name_hi_auto_lease_until timestamptz;

-- What has no Hindi name of either kind, so that looking for it is a look at a nearly empty index.
create index menu_items_hindi_missing_idx
  on public.menu_items (restaurant_id, name_hi_auto_tried_at, created_at)
  where name_hi is null and name_hi_auto is null;
create index menu_categories_hindi_missing_idx
  on public.menu_categories (restaurant_id, name_hi_auto_tried_at, created_at)
  where name_hi is null and name_hi_auto is null;

-- A renamed dish or category starts again: no automatic name, never tried, not leased. A fill
-- still working on the old name finds the name changed and stores nothing.
create or replace function private.clear_auto_hindi_name()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.name_hi_auto := null;
  new.name_hi_auto_tried_at := null;
  new.name_hi_auto_lease_until := null;
  return new;
end;
$$;

-- A name waits for a fill: no Hindi name of either kind, not tried in the last 12 hours, not
-- leased. The same test as menu_hindi_names_lease, written out so that the indexes above serve it.
create function private.hindi_names_waiting()
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.menu_categories c
    where c.name_hi is null and c.name_hi_auto is null
      and (c.name_hi_auto_tried_at is null or c.name_hi_auto_tried_at < now() - interval '12 hours')
      and (c.name_hi_auto_lease_until is null or c.name_hi_auto_lease_until < now())
  ) or exists (
    select 1 from public.menu_items i
    where i.name_hi is null and i.name_hi_auto is null
      and (i.name_hi_auto_tried_at is null or i.name_hi_auto_tried_at < now() - interval '12 hours')
      and (i.name_hi_auto_lease_until is null or i.name_hi_auto_lease_until < now())
  );
$$;

-- ─── Fill (service role: after menu edits, the daily cron and the minute job) ───

-- Leases up to p_limit names (1 to 500) for p_lease_seconds (60 to 900) and returns them: names
-- that wait for a fill (private.hindi_names_waiting), never tried first, then oldest, categories
-- before dishes. They are one restaurant's, so a name written as an instruction can't steer
-- another restaurant's (HN-6): p_restaurant_id, or else the restaurant of the first name waiting.
-- Rows another call holds are passed over, so overlapping fills get different names; when that
-- leaves nothing of the restaurant chosen, another is chosen, up to 3 times. Touches only the
-- lease: a name counts as tried when its batch is settled.
create function public.menu_hindi_names_lease(
  p_restaurant_id uuid default null,
  p_limit int default 100,
  p_lease_seconds int default 300
)
returns table (restaurant_id uuid, kind text, id uuid, name text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_limit int := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_until timestamptz :=
    now() + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 300), 60), 900));
  v_restaurant uuid;
  v_passed_over uuid[] := '{}';
  v_taken int;
  v_more int;
begin
  for v_try in 1..3 loop
    v_restaurant := p_restaurant_id;
    if v_restaurant is null then
      select m.restaurant_id into v_restaurant
      from (
        select c.restaurant_id, c.name_hi_auto_tried_at as tried_at, c.created_at, c.id
        from public.menu_categories c
        where c.name_hi is null and c.name_hi_auto is null
          and (c.name_hi_auto_tried_at is null
            or c.name_hi_auto_tried_at < now() - interval '12 hours')
          and (c.name_hi_auto_lease_until is null or c.name_hi_auto_lease_until < now())
          and c.restaurant_id <> all (v_passed_over)
        union all
        select i.restaurant_id, i.name_hi_auto_tried_at, i.created_at, i.id
        from public.menu_items i
        where i.name_hi is null and i.name_hi_auto is null
          and (i.name_hi_auto_tried_at is null
            or i.name_hi_auto_tried_at < now() - interval '12 hours')
          and (i.name_hi_auto_lease_until is null or i.name_hi_auto_lease_until < now())
          and i.restaurant_id <> all (v_passed_over)
      ) m
      order by m.tried_at asc nulls first, m.created_at, m.id
      limit 1;
      if v_restaurant is null then
        return;
      end if;
    end if;

    return query
    with picked as (
      select c.id
      from public.menu_categories c
      where c.restaurant_id = v_restaurant and c.name_hi is null and c.name_hi_auto is null
        and (c.name_hi_auto_tried_at is null
          or c.name_hi_auto_tried_at < now() - interval '12 hours')
        and (c.name_hi_auto_lease_until is null or c.name_hi_auto_lease_until < now())
      order by c.name_hi_auto_tried_at asc nulls first, c.created_at, c.id
      limit v_limit
      for update skip locked
    ),
    leased as (
      update public.menu_categories c
        set name_hi_auto_lease_until = v_until
      from picked p
      where c.id = p.id
      returning c.restaurant_id, c.id, c.name
    )
    select l.restaurant_id, 'category'::text, l.id, l.name from leased l;
    get diagnostics v_taken = row_count;

    if v_taken < v_limit then
      return query
      with picked as (
        select i.id
        from public.menu_items i
        where i.restaurant_id = v_restaurant and i.name_hi is null and i.name_hi_auto is null
          and (i.name_hi_auto_tried_at is null
            or i.name_hi_auto_tried_at < now() - interval '12 hours')
          and (i.name_hi_auto_lease_until is null or i.name_hi_auto_lease_until < now())
        order by i.name_hi_auto_tried_at asc nulls first, i.created_at, i.id
        limit v_limit - v_taken
        for update skip locked
      ),
      leased as (
        update public.menu_items i
          set name_hi_auto_lease_until = v_until
        from picked p
        where i.id = p.id
        returning i.restaurant_id, i.id, i.name
      )
      select l.restaurant_id, 'item'::text, l.id, l.name from leased l;
      get diagnostics v_more = row_count;
      v_taken := v_taken + v_more;
    end if;

    -- A restaurant that was asked for is the only one to try.
    if v_taken > 0 or p_restaurant_id is not null then
      return;
    end if;
    v_passed_over := v_passed_over || v_restaurant;
  end loop;
end;
$$;

-- p_names: [{ kind: 'item'|'category', id, name, name_hi }], the names of a batch that has
-- answered, name_hi left out for a name the model didn't write. Each is settled only while the row
-- still has that name and no automatic name, so a rename during the conversion drops the stale
-- result and a repeat changes nothing. The automatic name is stored when it is there and fits;
-- the name counts as tried either way, and is no longer leased. name_hi, the owner's, is never
-- written: guests get coalesce(name_hi, name_hi_auto). Returns how many names were stored.
create function public.menu_hindi_names_settle(p_names jsonb)
returns int
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_categories int;
  v_items int;
begin
  if jsonb_typeof(p_names) is distinct from 'array' then
    perform private.fail('INVALID_INPUT', 'names');
  end if;

  with settled as (
    update public.menu_categories c
      set name_hi_auto = case
            when length(btrim(g.name_hi)) between 1 and 60 then btrim(g.name_hi)
          end,
        name_hi_auto_tried_at = now(),
        name_hi_auto_lease_until = null
    from jsonb_to_recordset(p_names) as g(kind text, id uuid, name text, name_hi text)
    where g.kind = 'category' and c.id = g.id and c.name = g.name and c.name_hi_auto is null
    returning c.name_hi_auto
  )
  select count(s.name_hi_auto) into v_categories from settled s;

  with settled as (
    update public.menu_items i
      set name_hi_auto = case
            when length(btrim(g.name_hi)) between 1 and 80 then btrim(g.name_hi)
          end,
        name_hi_auto_tried_at = now(),
        name_hi_auto_lease_until = null
    from jsonb_to_recordset(p_names) as g(kind text, id uuid, name text, name_hi text)
    where g.kind = 'item' and i.id = g.id and i.name = g.name and i.name_hi_auto is null
    returning i.name_hi_auto
  )
  select count(s.name_hi_auto) into v_items from settled s;

  return v_categories + v_items;
end;
$$;

-- The previous build's claim (20261002110000), for the deploy overlap: it stamps what it takes, as
-- it did, and now passes over names that are leased. Dropped next release, with
-- menu_set_hindi_names, which stays as it is.
create or replace function public.menu_hindi_names_claim(
  p_restaurant_id uuid default null,
  p_limit int default 300
)
returns table (restaurant_id uuid, kind text, id uuid, name text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  with picked as (
    select m.restaurant_id, m.kind, m.id, m.name
    from (
      select c.restaurant_id, 'category'::text as kind, c.id, c.name,
             c.name_hi_auto_tried_at as tried_at, c.created_at
      from public.menu_categories c
      where c.name_hi is null and c.name_hi_auto is null
        and (c.name_hi_auto_lease_until is null or c.name_hi_auto_lease_until < now())
        and (p_restaurant_id is null or c.restaurant_id = p_restaurant_id)
      union all
      select i.restaurant_id, 'item', i.id, i.name, i.name_hi_auto_tried_at, i.created_at
      from public.menu_items i
      where i.name_hi is null and i.name_hi_auto is null
        and (i.name_hi_auto_lease_until is null or i.name_hi_auto_lease_until < now())
        and (p_restaurant_id is null or i.restaurant_id = p_restaurant_id)
    ) m
    where m.tried_at is null or m.tried_at < now() - interval '12 hours'
    order by m.tried_at asc nulls first, m.created_at, m.id
    limit least(greatest(coalesce(p_limit, 300), 1), 1000)
  ),
  stamped_categories as (
    update public.menu_categories c
      set name_hi_auto_tried_at = now()
    from picked p
    where p.kind = 'category' and c.id = p.id
  ),
  stamped_items as (
    update public.menu_items i
      set name_hi_auto_tried_at = now()
    from picked p
    where p.kind = 'item' and i.id = p.id
  )
  select p.restaurant_id, p.kind, p.id, p.name from picked p;
end;
$$;

-- ─── Grants ─────────────────────────────────────────────────────────────────
revoke execute on function private.hindi_names_waiting() from public, anon, authenticated;

revoke execute on function public.menu_hindi_names_lease(uuid, int, int)
  from public, anon, authenticated;
revoke execute on function public.menu_hindi_names_settle(jsonb) from public, anon, authenticated;
grant execute on function public.menu_hindi_names_lease(uuid, int, int) to service_role;
grant execute on function public.menu_hindi_names_settle(jsonb) to service_role;
