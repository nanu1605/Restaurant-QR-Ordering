-- Restartable jobs: the data export (docs/DECISIONS.md VPS-25, VPS-26).
--
-- A request queues its export. A claim takes the oldest queued one and builds it under a lease
-- that a heartbeat keeps alive; only the claim that holds a row can finish it. One export builds
-- at a time on the whole platform (review finding A2). A build cut off by a restart lets its lease
-- lapse, and the next claim queues it again; the third cut fails it. The previous build's
-- restaurant_export_finish stays one release for the deploy overlap, narrowed to rows no claim
-- has taken.

-- ─── Columns and checks ─────────────────────────────────────────────────────
alter table public.restaurant_exports
  -- Claims that were cut off: their lease ran out (export_claim_limit()).
  add column attempts int not null default 0 check (attempts between 0 and 10),
  -- The claim that holds the row: only it renews, completes, fails or releases it.
  add column claim_id uuid,
  add column lease_until timestamptz,
  -- Why it failed or went back to the queue. The server's, never returned to a page.
  add column last_error text check (char_length(last_error) <= 500),
  drop constraint restaurant_exports_status_check,
  add constraint restaurant_exports_status_check
    check (status in ('queued', 'building', 'ready', 'failed')),
  alter column status set default 'queued';

-- Rows the previous build left building hold no lease. Within the 15 minutes a build may take,
-- they go back to the queue (that build's own finish can still complete them); older, they have
-- failed. Before the lease check and the one-building index below, which they would break.
update public.restaurant_exports e
  set status = case when e.created_at > now() - interval '15 minutes' then 'queued' else 'failed' end,
    finished_at = case when e.created_at > now() - interval '15 minutes' then null else now() end
  where e.status = 'building';

alter table public.restaurant_exports
  add constraint restaurant_exports_lease_check check (
    (status = 'building') = (lease_until is not null)
    and (status <> 'building' or claim_id is not null)
  );

-- One build at a time on the whole platform, held by the table across processes and servers.
create unique index restaurant_exports_one_building on public.restaurant_exports ((true))
  where status = 'building';
-- What is waiting, so an idle check is one look at an empty index.
create index restaurant_exports_open_idx on public.restaurant_exports (created_at, id)
  where status in ('queued', 'building');

-- ─── Helpers ────────────────────────────────────────────────────────────────
-- An export cut off this many times has failed, so one that takes the server down with it
-- (out of memory) can't loop.
create function private.export_claim_limit()
returns int
language sql
immutable
set search_path = ''
as $$
  select 3;
$$;

-- An export waits for a build: queued, or building under a lease that ran out.
create function private.export_jobs_waiting()
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.restaurant_exports e
    where e.status = 'queued' or (e.status = 'building' and e.lease_until < now())
  );
$$;

-- ─── Requests and the page ──────────────────────────────────────────────────
-- A request queues its export. After the restaurant's lock it takes the claims' lock, so it never
-- changes rows while a claim does. One still queued or building 15 minutes after it was asked
-- for has failed: the page says so, and a new request may go.
create or replace function private.start_export(p_restaurant_id uuid, p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('restaurant_export:' || p_restaurant_id, 0));
  perform pg_advisory_xact_lock(hashtextextended('restaurant_export:claim', 0));
  update public.restaurant_exports e
    set status = 'failed', lease_until = null, finished_at = now(),
      last_error = 'not finished in 15 minutes'
    where e.restaurant_id = p_restaurant_id and e.status in ('queued', 'building')
      and e.created_at < now() - interval '15 minutes';
  if exists (
    select 1 from public.restaurant_exports e
    where e.restaurant_id = p_restaurant_id and e.status <> 'failed'
      and e.created_at > now() - interval '1 hour'
  ) then
    perform private.fail('EXPORT_TOO_SOON');
  end if;
  insert into public.restaurant_exports (restaurant_id, requested_by)
    values (p_restaurant_id, p_user_id)
    returning id into v_id;
  return v_id;
end;
$$;

-- The latest export of a restaurant, or null. Only the server sees the path. A queued export
-- reads as building: the page shows one state while it waits and while it builds.
create or replace function private.latest_export(p_restaurant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'status', case
      when e.status in ('queued', 'building') and e.created_at < now() - interval '15 minutes'
        then 'failed'
      when e.status = 'queued' then 'building'
      else e.status
    end,
    'path', e.restaurant_id || '/' || e.id || '.zip',
    'size_bytes', e.size_bytes,
    'created_at', e.created_at,
    'expires_at', e.expires_at
  )
  from public.restaurant_exports e
  where e.restaurant_id = p_restaurant_id
  order by e.created_at desc
  limit 1;
$$;

-- ─── Building (the server: src/features/closure/export-jobs.ts) ─────────────
-- The oldest queued export, now building under a new claim and a lease of p_lease_seconds;
-- {"busy": true} when exports wait but another build holds the one slot, so that the caller can
-- wait for it and claim again; or null when nothing waits. A lease that ran out is handled here
-- and only here: its build was cut off, so the row is queued again, or failed at the third cut.
create function public.restaurant_export_claim(p_lease_seconds int default 90)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.restaurant_exports;
begin
  -- An idle call takes no lock.
  if not private.export_jobs_waiting() then
    return null;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('restaurant_export:claim', 0));

  update public.restaurant_exports e
    set status = 'failed', lease_until = null, finished_at = now(),
      last_error = 'not finished in 15 minutes'
    where e.status in ('queued', 'building') and e.created_at < now() - interval '15 minutes';
  update public.restaurant_exports e
    set attempts = e.attempts + 1,
      status = case
        when e.attempts + 1 >= private.export_claim_limit() then 'failed' else 'queued'
      end,
      finished_at = case when e.attempts + 1 >= private.export_claim_limit() then now() end,
      lease_until = null,
      last_error = 'the build was cut off'
    where e.status = 'building' and e.lease_until < now();

  if exists (select 1 from public.restaurant_exports e where e.status = 'building') then
    if exists (select 1 from public.restaurant_exports e where e.status = 'queued') then
      return jsonb_build_object('busy', true);
    end if;
    return null;
  end if;
  select * into v_row
    from public.restaurant_exports e
    where e.status = 'queued'
    order by e.created_at, e.id
    limit 1
    for update skip locked;
  if not found then
    return null;
  end if;
  update public.restaurant_exports e
    set status = 'building', claim_id = gen_random_uuid(),
      lease_until = now()
        + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 90), 30), 600))
    where e.id = v_row.id
    returning * into v_row;
  return jsonb_build_object(
    'export_id', v_row.id, 'restaurant_id', v_row.restaurant_id, 'claim_id', v_row.claim_id
  );
end;
$$;

-- The build is alive: its lease runs on. False when the claim is gone (cut off, failed, or the
-- export removed), and the build stops.
create function public.restaurant_export_heartbeat(
  p_export_id uuid,
  p_claim_id uuid,
  p_lease_seconds int default 90
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.restaurant_exports e
    set lease_until = now()
      + make_interval(secs => least(greatest(coalesce(p_lease_seconds, 90), 30), 600))
    where e.id = p_export_id and e.claim_id = p_claim_id and e.status = 'building';
  return found;
end;
$$;

-- The claim's ZIP is in the bucket: ready for 24 hours. Also when its lease ran out but no claim
-- has taken the row since (it is queued): the file is good. False when the claim is gone, and
-- nothing changes.
create function public.restaurant_export_complete(
  p_export_id uuid,
  p_claim_id uuid,
  p_size_bytes bigint
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_size_bytes is null or p_size_bytes < 0 then
    perform private.fail('INVALID_INPUT', 'size');
  end if;
  update public.restaurant_exports e
    set status = 'ready', size_bytes = p_size_bytes, finished_at = now(),
      expires_at = now() + interval '24 hours', lease_until = null, last_error = null
    where e.id = p_export_id and e.claim_id = p_claim_id and e.status in ('building', 'queued');
  return found;
end;
$$;

-- The claim's build failed: the export has failed, as before, and the page offers another try.
create function public.restaurant_export_fail(p_export_id uuid, p_claim_id uuid, p_error text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.restaurant_exports e
    set status = 'failed', finished_at = now(), lease_until = null,
      last_error = left(p_error, 500)
    where e.id = p_export_id and e.claim_id = p_claim_id and e.status = 'building';
  return found;
end;
$$;

-- The server is stopping: the claim hands its export back to the queue. Not a cut, so it
-- doesn't count.
create function public.restaurant_export_release(p_export_id uuid, p_claim_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.restaurant_exports e
    set status = 'queued', lease_until = null
    where e.id = p_export_id and e.claim_id = p_claim_id and e.status = 'building';
  return found;
end;
$$;

-- The previous build's report on a build it started itself: a size when it worked, null when it
-- didn't. Only rows no claim has taken, so it never touches one this build holds. Dropped next
-- release.
create or replace function public.restaurant_export_finish(
  p_export_id uuid,
  p_size_bytes bigint default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.restaurant_exports e
    set status = case when p_size_bytes is null then 'failed' else 'ready' end,
      size_bytes = p_size_bytes,
      finished_at = now(),
      expires_at = case when p_size_bytes is null then null else now() + interval '24 hours' end
    where e.id = p_export_id and e.status = 'queued' and e.claim_id is null;
$$;

-- ─── Grants ─────────────────────────────────────────────────────────────────
revoke execute on function private.export_claim_limit() from public, anon, authenticated;
revoke execute on function private.export_jobs_waiting() from public, anon, authenticated;

revoke execute on function public.restaurant_export_claim(int) from public, anon, authenticated;
revoke execute on function public.restaurant_export_heartbeat(uuid, uuid, int)
  from public, anon, authenticated;
revoke execute on function public.restaurant_export_complete(uuid, uuid, bigint)
  from public, anon, authenticated;
revoke execute on function public.restaurant_export_fail(uuid, uuid, text)
  from public, anon, authenticated;
revoke execute on function public.restaurant_export_release(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.restaurant_export_claim(int) to service_role;
grant execute on function public.restaurant_export_heartbeat(uuid, uuid, int) to service_role;
grant execute on function public.restaurant_export_complete(uuid, uuid, bigint) to service_role;
grant execute on function public.restaurant_export_fail(uuid, uuid, text) to service_role;
grant execute on function public.restaurant_export_release(uuid, uuid) to service_role;
