-- Stop 14d: system health (docs/SUPER_ADMIN_PLAN.md 14d, docs/DECISIONS.md SA-86+).
--
-- A send log for every email, scheduled jobs that didn't run, database and
-- storage size against the plan's limits, and the month's menu imports, on
-- /super/system. Failed emails, a full database or storage, and failed menu
-- imports also go to Needs attention (owner's choices, 2026-10-16).

-- ─── Email log ──────────────────────────────────────────────────────────────
-- One row per email sent through Resend (src/lib/email/resend.ts), kept 30
-- days. No subjects, bodies or addresses: only keyed hashes of the addresses.
create table public.email_log (
  id bigint generated always as identity primary key,
  -- The idempotency key's first part: signup, password-reset, reminder, ...
  kind text not null check (kind ~ '^[a-z-]{1,40}$'),
  recipient_hashes text[] not null check (
    cardinality(recipient_hashes) between 1 and 100
    and array_to_string(recipient_hashes, ',') ~ '^[0-9a-f]{64}(,[0-9a-f]{64})*$'
  ),
  -- duplicate: Resend had already sent one with that key (the digest's rerun).
  status text not null check (status in ('sent', 'failed', 'duplicate', 'bounced', 'complained')),
  -- Resend's id for the email; a repeated key gets the same one.
  provider_id text check (length(provider_id) <= 100),
  http_status int,
  error text check (length(error) <= 500),
  created_at timestamptz not null default now(),
  -- When Resend last reported on it (its webhook).
  updated_at timestamptz
);
create index email_log_created_idx on public.email_log (created_at desc);
create index email_log_provider_idx on public.email_log (provider_id) where provider_id is not null;
-- Written by the service role, read through the functions below.
alter table public.email_log enable row level security;
revoke all on public.email_log from anon, authenticated;

-- Rows older than 30 days, by the daily cron. Returns how many were deleted.
create function public.email_log_cleanup()
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with gone as (
    delete from public.email_log l where l.created_at < now() - interval '30 days' returning 1
  )
  select count(*)::integer from gone;
$$;

-- Resend's webhook (src/app/api/webhooks/resend/route.ts): a bounce, a
-- complaint or a later failure for one of our emails. A complaint outranks a
-- bounce, which outranks a failure; other events and unknown ids are ignored.
-- Returns how many rows changed.
create function public.email_log_record_event(p_provider_id text, p_type text)
returns integer
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_rank text[] := array['sent', 'duplicate', 'failed', 'bounced', 'complained'];
  v_status text := case p_type
    when 'email.failed' then 'failed'
    when 'email.bounced' then 'bounced'
    -- Not sent: the address bounced or complained before.
    when 'email.suppressed' then 'bounced'
    when 'email.complained' then 'complained'
  end;
  v_count integer;
begin
  if v_status is null or p_provider_id is null then
    return 0;
  end if;
  update public.email_log l
    set status = v_status, updated_at = now()
    where l.provider_id = p_provider_id
      and array_position(v_rank, l.status) < array_position(v_rank, v_status);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ─── Plan limits (Platform settings) ────────────────────────────────────────
-- From the Supabase plan, in MB; null until entered.
alter table public.platform_settings
  add column db_limit_mb int check (db_limit_mb between 1 and 10000000),
  add column storage_limit_mb int check (storage_limit_mb between 1 and 10000000);

-- ─── Scheduled jobs ─────────────────────────────────────────────────────────
-- Each job (step null) and each of its steps of the last 30 days: the
-- latest row, and whether it is missing (SA-86). Every job runs daily, so one
-- with no row for 26 hours missed a run. A step missed its job's latest run
-- when its row is 12 hours older than the job's latest (killed by the time
-- limit, or a crash), judged once that run has had 10 minutes to finish.
-- ponytail: a renamed or removed step reads as missing for 30 days; delete
-- its cron_runs rows in the migration that renames it.
create function private.cron_status()
returns table (
  job text, step text, started_at timestamptz, finished_at timestamptz, ok boolean,
  detail text, missing boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with latest as (
    select distinct on (x.job, x.step) x.job, x.step, x.started_at, x.finished_at, x.ok, x.detail
    from public.cron_runs x
    -- A job that stopped a month ago has been noticed.
    where x.started_at >= now() - interval '30 days'
    order by x.job, x.step, x.started_at desc
  ),
  jobs as (
    select l.job, max(l.started_at) as last_at from latest l group by l.job
  )
  select j.job, null, j.last_at, null, null, null, j.last_at < now() - interval '26 hours'
  from jobs j
  union all
  select l.job, l.step, l.started_at, l.finished_at, l.ok, l.detail,
    l.started_at < j.last_at - interval '12 hours' and j.last_at < now() - interval '10 minutes'
  from latest l
  join jobs j on j.job = l.job;
$$;

-- ─── The System page (system.view) ──────────────────────────────────────────
create function public.platform_system()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('system.view');
  -- This month in India.
  v_month timestamptz := date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
begin
  return (
    with cron as (
      select c.*, (extract(epoch from c.finished_at - c.started_at) * 1000)::int as ms
      from private.cron_status() c
    ),
    imports as (
      select m.* from public.menu_imports m where m.created_at >= v_month
    )
    select jsonb_build_object(
      'jobs', coalesce((
        select jsonb_agg(jsonb_build_object(
          'job', j.job, 'last_at', j.started_at, 'missing', j.missing,
          'ms', r.ms, 'steps', s.steps, 'failed', s.failed, 'missing_steps', s.missing
        ) order by j.job)
        from cron j
        -- The latest run: its steps all start within its 300-second limit, so
        -- the job's rows from 5 minutes before its last (not a rerun's).
        cross join lateral (
          select (extract(epoch from max(x.finished_at) - min(x.started_at)) * 1000)::int as ms
          from public.cron_runs x
          where x.job = j.job and x.started_at >= j.started_at - interval '5 minutes'
        ) as r
        cross join lateral (
          select count(*)::int as steps,
            count(*) filter (where not c.ok)::int as failed,
            count(*) filter (where c.missing)::int as missing
          from cron c
          where c.job = j.job and c.step is not null
        ) as s
        where j.step is null
      ), '[]'::jsonb),
      'steps', coalesce((
        select jsonb_agg(jsonb_build_object(
          'job', c.job, 'step', c.step, 'started_at', c.started_at, 'ms', c.ms, 'ok', c.ok,
          'detail', c.detail, 'missing', c.missing
        ) order by c.job, c.step)
        from cron c
        where c.step is not null
      ), '[]'::jsonb),
      'failures', coalesce((
        select jsonb_agg(jsonb_build_object(
          'job', f.job, 'step', f.step, 'started_at', f.started_at, 'detail', f.detail
        ) order by f.started_at desc, f.id desc)
        from (
          select x.* from public.cron_runs x
          where not x.ok and x.started_at >= now() - interval '7 days'
          order by x.started_at desc, x.id desc
          limit 10
        ) as f
      ), '[]'::jsonb),
      'webhooks', (
        select jsonb_build_object(
          'failed_24h', count(*) filter (where w.received_at >= now() - interval '24 hours'),
          'failed_open', count(*)
        )
        from public.webhook_events w
        where w.processing_error is not null
      ),
      'email', jsonb_build_object(
        'kinds', coalesce((
          select jsonb_agg(jsonb_build_object(
            'kind', k.kind, 'sent', k.sent, 'duplicate', k.duplicate, 'failed', k.failed,
            'bounced', k.bounced, 'complained', k.complained
          ) order by k.kind)
          from (
            select l.kind,
              count(*) filter (where l.status = 'sent')::int as sent,
              count(*) filter (where l.status = 'duplicate')::int as duplicate,
              count(*) filter (where l.status = 'failed')::int as failed,
              count(*) filter (where l.status = 'bounced')::int as bounced,
              count(*) filter (where l.status = 'complained')::int as complained
            from public.email_log l
            -- As Home's: a send of the last two days reported on in the last day.
            where l.created_at >= now() - interval '2 days'
              and coalesce(l.updated_at, l.created_at) >= now() - interval '24 hours'
            group by l.kind
          ) as k
        ), '[]'::jsonb),
        'recent', private.email_rows(null)
      ),
      'sizes', (
        select jsonb_build_object(
          -- An estimate: Supabase counts the disk, with its logs and free space.
          'database_bytes', pg_database_size(current_database()),
          'db_limit_mb', s.db_limit_mb,
          'storage_limit_mb', s.storage_limit_mb,
          -- ponytail: sums every object; snapshot it nightly past ~100k objects.
          'buckets', coalesce((
            select jsonb_agg(jsonb_build_object(
              'bucket', b.bucket_id, 'objects', b.objects, 'bytes', b.bytes
            ) order by b.bytes desc, b.bucket_id)
            from (
              select o.bucket_id, count(*)::int as objects,
                coalesce(sum((o.metadata ->> 'size')::bigint), 0) as bytes
              from storage.objects o
              group by o.bucket_id
            ) as b
          ), '[]'::jsonb)
        )
        from public.platform_settings s
        where s.id = 1
      ),
      'menu_imports', (
        select jsonb_build_object(
          'since', v_month,
          'imports', count(*),
          'photo', count(*) filter (where i.source = 'photo'),
          'csv', count(*) filter (where i.source = 'csv'),
          'imported', count(*) filter (where i.status = 'imported'),
          'failed', count(*) filter (where i.status = 'failed'),
          'discarded', count(*) filter (where i.status = 'discarded'),
          'open', count(*) filter (where i.status in ('uploaded', 'processing', 'review')),
          -- The known costs, and how many imports have a call of unknown cost.
          'cost_paise', coalesce(sum(i.cost_paise), 0),
          'cost_unknown', count(*) filter (where i.cost_paise is null)
        )
        from imports i
      )
    )
  );
end;
$$;

-- The latest 20 emails, all or to one address's hash.
create function private.email_rows(p_recipient_hash text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', l.id, 'kind', l.kind, 'status', l.status, 'recipients', cardinality(l.recipient_hashes),
    'provider_id', l.provider_id, 'http_status', l.http_status, 'error', l.error,
    'created_at', l.created_at, 'updated_at', l.updated_at
  ) order by l.created_at desc, l.id desc), '[]'::jsonb)
  from (
    select * from public.email_log x
    -- ponytail: scans the month's rows; a GIN index on the hashes if it grows.
    where p_recipient_hash is null or x.recipient_hashes @> array[p_recipient_hash]
    order by x.created_at desc, x.id desc
    limit 20
  ) as l;
$$;

-- The emails to one address: the server hashes what was typed (SA-87).
create function public.platform_email_sends(p_recipient_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('system.view');
begin
  if p_recipient_hash is null or p_recipient_hash !~ '^[0-9a-f]{64}$' then
    perform private.fail('INVALID_INPUT', 'recipient');
  end if;
  return private.email_rows(p_recipient_hash);
end;
$$;

-- ─── Redefined from their live definitions (docs/DECISIONS.md SA-86+) ───────
-- private.attention: missing scheduled runs join the cron group; failed menu
-- imports, failed emails and a nearly full database or storage are new groups.
CREATE OR REPLACE FUNCTION private.attention(p_admin uuid, p_money boolean, p_growth boolean, p_system boolean, p_limit integer DEFAULT 5)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with dues as (
    select d.* from private.dues_rows() d where p_money
  ),
  items as (
    select 'payment_failed' as grp, d.restaurant_id::text as id,
      extract(epoch from coalesce(d.grace_until, d.current_period_end)) as ord,
      to_jsonb(d) - 'bucket' - 'access_state' || jsonb_build_object(
        'state', private.subscription_state('active', d.access_state, d.status::text, d.source::text),
        'last_reminder_kind', null, 'last_reminder_at', null
      ) as data
    from dues d where d.bucket = 'payment_failed'
    union all
    select 'trial_ending', d.restaurant_id::text, extract(epoch from d.trial_ends_at),
      to_jsonb(d) - 'bucket' - 'access_state' || jsonb_build_object(
        'state', private.subscription_state('active', d.access_state, d.status::text, d.source::text),
        'last_reminder_kind', null, 'last_reminder_at', null
      )
    from dues d where d.bucket = 'trial_ending'
    union all
    -- Manual and payment-link restaurants never renew on their own.
    select 'needs_payment', d.restaurant_id::text, extract(epoch from d.current_period_end),
      to_jsonb(d) - 'bucket' - 'access_state' || jsonb_build_object(
        'state', private.subscription_state('active', d.access_state, d.status::text, d.source::text),
        'last_reminder_kind', null, 'last_reminder_at', null
      )
    from dues d
    where d.bucket = 'renewal_due' and d.renewal_kind = 'needs_payment'
      and d.current_period_end <= now() + interval '7 days'
    union all
    -- Leads no one has contacted 24 hours after they came in, oldest first (SA-56).
    select 'new_leads', l.id::text, extract(epoch from l.created_at),
      jsonb_build_object(
        'lead_id', l.id, 'name', l.name, 'restaurant_name', l.restaurant_name,
        'city', l.city, 'phone', l.phone, 'created_at', l.created_at
      )
    from public.site_leads l
    where p_growth and l.stage = 'new' and l.created_at <= now() - interval '24 hours'
    union all
    -- Quiet restaurants that still have full access: a lapsed or suspended one
    -- is quiet for a reason Dues or the team already knows.
    select h.health, h.id::text, 0,
      jsonb_build_object(
        'restaurant_id', h.id, 'name', h.name, 'slug', h.slug, 'city', h.city,
        'phone', h.phone, 'health', h.health
      )
    from (
      select r.id, r.name, r.slug, r.city, r.phone,
        private.restaurant_health(r.id, r.created_at) as health
      from public.restaurants r
      where r.status = 'active'
    ) as h
    cross join lateral private.restaurant_access(h.id) as a
    where h.health in ('inactive', 'slowing') and a.state = 'full'
    union all
    select 'stuck_onboarding', o.id::text, extract(epoch from (o.ob ->> 'since')::timestamptz),
      jsonb_build_object(
        'restaurant_id', o.id, 'name', o.name, 'slug', o.slug, 'city', o.city,
        'phone', o.phone, 'next', o.ob ->> 'next', 'since', o.ob -> 'since'
      )
    from (
      select r.id, r.name, r.slug, r.city, r.phone, x.onboarding as ob
      from private.restaurants_onboarding(array(
        select r.id from public.restaurants r
        where r.status = 'active' and r.created_at >= now() - interval '60 days'
      )) as x
      join public.restaurants r on r.id = x.restaurant_id
      where (x.onboarding ->> 'stuck')::boolean and x.onboarding ->> 'next' <> 'paid'
      offset 0 -- access only for the stuck ones
    ) as o
    cross join lateral private.restaurant_access(o.id) as a
    where a.state = 'full'
    union all
    select 'support_open', q.id::text, extract(epoch from q.created_at),
      jsonb_build_object(
        'request_id', q.id, 'restaurant_id', q.restaurant_id, 'name', r.name,
        'topic', q.topic, 'status', q.status, 'created_at', q.created_at
      )
    from public.support_requests q
    join public.restaurants r on r.id = q.restaurant_id
    where q.status in ('open', 'in_progress') and q.created_at < now() - interval '24 hours'
      -- The digest (no admin) lists them all.
      and (p_admin is null or private.has_platform_permission('restaurants.support'))
    union all
    -- Signups of the last week that look like another restaurant (P11-13).
    select 'duplicates', r.id::text, -extract(epoch from r.created_at),
      jsonb_build_object(
        'restaurant_id', r.id, 'name', r.name, 'slug', r.slug, 'city', r.city,
        'created_at', r.created_at, 'matches', lk.matches
      )
    from public.restaurants r
    cross join lateral (
      select private.restaurant_lookalikes(r.id) as matches
      offset 0 -- once a signup, not again for the item
    ) as lk
    where r.created_at >= now() - interval '7 days' and r.status = 'active'
      and exists (select 1 from public.trial_claims c where c.restaurant_id = r.id)
      and jsonb_array_length(lk.matches) > 0
    union all
    -- Menu imports that failed in the last two days: the restaurant may need a hand (SA-91).
    select 'menu_imports', m.id::text, -extract(epoch from m.completed_at),
      jsonb_build_object(
        'import_id', m.id, 'restaurant_id', m.restaurant_id, 'name', r.name,
        'source', m.source, 'error', m.error, 'completed_at', m.completed_at
      )
    from public.menu_imports m
    join public.restaurants r on r.id = m.restaurant_id
    where p_system and m.status = 'failed' and m.completed_at >= now() - interval '2 days'
    union all
    select 'webhooks', w.id::text, -extract(epoch from w.received_at),
      jsonb_build_object(
        'id', w.id, 'event_type', w.event_type, 'received_at', w.received_at,
        'error', w.processing_error
      )
    from public.webhook_events w
    where p_system and w.processing_error is not null
    union all
    -- Each scheduled step whose latest run failed or didn't finish, and each
    -- job that missed a run (SA-86).
    select 'cron', c.job || coalesce(':' || c.step, ''), -extract(epoch from c.started_at),
      jsonb_build_object(
        'job', c.job, 'step', c.step, 'started_at', c.started_at, 'detail', c.detail,
        'missing', c.missing
      )
    from private.cron_status() c
    where p_system and (c.missing or not c.ok)
    union all
    -- Emails of the last day that failed, bounced or were marked as spam, by kind (SA-87).
    select 'email', l.kind, -extract(epoch from max(coalesce(l.updated_at, l.created_at))),
      jsonb_build_object(
        'kind', l.kind,
        'failed', count(*) filter (where l.status = 'failed'),
        'bounced', count(*) filter (where l.status = 'bounced'),
        'complained', count(*) filter (where l.status = 'complained'),
        'last_at', max(coalesce(l.updated_at, l.created_at))
      )
    from public.email_log l
    where p_system and l.created_at >= now() - interval '2 days'
      and coalesce(l.updated_at, l.created_at) >= now() - interval '24 hours'
      and l.status in ('failed', 'bounced', 'complained')
    group by l.kind
    union all
    -- The database or storage at 80% of the plan's limit, once entered (SA-90).
    select 'capacity', c.what, -c.used / c.limit_bytes,
      jsonb_build_object('what', c.what, 'used_bytes', c.used, 'limit_bytes', c.limit_bytes)
    from public.platform_settings s
    cross join lateral (values
      ('database',
        case when s.db_limit_mb is not null then pg_database_size(current_database()) end,
        s.db_limit_mb * 1048576.0),
      ('storage',
        case when s.storage_limit_mb is not null then (
          select coalesce(sum((o.metadata ->> 'size')::bigint), 0) from storage.objects o
        ) end,
        s.storage_limit_mb * 1048576.0)
    ) as c(what, used, limit_bytes)
    where p_system and s.id = 1 and c.used >= c.limit_bytes * 0.8
  ),
  open_items as (
    select i.*, i.grp || ':' || i.id as key,
      row_number() over (partition by i.grp order by i.ord, i.data ->> 'name', i.id) as n,
      count(*) over (partition by i.grp) as total
    from items i
    where p_admin is null or not exists (
      select 1 from public.platform_snoozes z
      where z.admin_id = p_admin and z.item_key = i.grp || ':' || i.id and z.until > now()
    )
  ),
  groups as (
    select o.grp, max(o.total) as total,
      jsonb_agg(jsonb_build_object('key', o.key, 'data', o.data) order by o.n)
        filter (where o.n <= p_limit) as items
    from open_items o
    group by o.grp
  )
  select jsonb_build_object(
    'total', coalesce((select sum(g.total) from groups g), 0),
    'inactive_days', (select s.health_inactive_days from public.platform_settings s where s.id = 1),
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object('group', g.grp, 'count', g.total, 'items', g.items)
        order by array_position(array['payment_failed', 'trial_ending', 'needs_payment',
          'new_leads', 'support_open', 'stuck_onboarding', 'inactive', 'slowing', 'duplicates',
          'menu_imports', 'webhooks', 'cron', 'email', 'capacity'], g.grp))
      from groups g
    ), '[]'::jsonb)
  );
$function$;

-- public.platform_snooze: the new groups' items.
CREATE OR REPLACE FUNCTION public.platform_snooze(p_key text, p_days integer)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.view');
  v_until timestamptz;
begin
  if p_days is null or p_days not in (1, 3, 7) then
    perform private.fail('INVALID_INPUT', 'days');
  end if;
  if p_key is null or p_key !~ ('^(payment_failed|trial_ending|needs_payment|new_leads|inactive'
      || '|slowing|duplicates|webhooks|cron|stuck_onboarding|support_open|menu_imports|email'
      || '|capacity):[A-Za-z0-9 _.:-]{1,100}$') then
    perform private.fail('INVALID_INPUT', 'key');
  end if;
  delete from public.platform_snoozes z where z.admin_id = v_admin.user_id and z.until <= now();
  insert into public.platform_snoozes (admin_id, item_key, until)
  values (v_admin.user_id, p_key, now() + make_interval(days => p_days))
  on conflict (admin_id, item_key) do update set until = excluded.until, created_at = now()
  returning until into v_until;
  return v_until;
end;
$function$;

-- public.platform_update_settings: the plan limits (null clears one).
CREATE OR REPLACE FUNCTION public.platform_update_settings(p_patch jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('settings.manage');
  v_patch jsonb := coalesce(p_patch, '{}'::jsonb);
  v_old public.platform_settings;
  v_new public.platform_settings;
  v_key text;
  v_before jsonb := '{}'::jsonb;
  v_after jsonb := '{}'::jsonb;
begin
  perform private.assert_keys(v_patch, array[
    'trial_days', 'grace_days', 'setup_fee_paise', 'setup_fee_discount_paise',
    'setup_fee_discount_ends_at', 'support_phone', 'support_email', 'health_setup_days',
    'health_inactive_days', 'health_slowing_percent', 'health_slowing_min_orders',
    'db_limit_mb', 'storage_limit_mb'
  ]);

  select * into v_old from public.platform_settings s where s.id = 1 for update;
  v_new := v_old;

  if v_patch ? 'trial_days' then
    v_new.trial_days := private.json_int(v_patch, 'trial_days');
    if v_new.trial_days not between 1 and 365 then
      perform private.fail('INVALID_INPUT', 'trial_days');
    end if;
  end if;
  if v_patch ? 'grace_days' then
    v_new.grace_days := private.json_int(v_patch, 'grace_days');
    if v_new.grace_days not between 0 and 90 then
      perform private.fail('INVALID_INPUT', 'grace_days');
    end if;
  end if;
  if v_patch ? 'setup_fee_paise' then
    v_new.setup_fee_paise := private.json_int(v_patch, 'setup_fee_paise');
    if v_new.setup_fee_paise not between 100 and 100000000 then
      perform private.fail('INVALID_INPUT', 'setup_fee_paise');
    end if;
  end if;
  if v_patch ? 'setup_fee_discount_paise' then
    v_new.setup_fee_discount_paise := private.json_int(v_patch, 'setup_fee_discount_paise');
  end if;
  -- On the merged row, so lowering only the fee can't leave the discount above it.
  if v_new.setup_fee_discount_paise < 0 or v_new.setup_fee_discount_paise >= v_new.setup_fee_paise then
    perform private.fail('INVALID_INPUT', 'setup_fee_discount_paise');
  end if;
  if v_patch ? 'setup_fee_discount_ends_at' then
    -- A past time is allowed: it ends the offer now (SA-5).
    begin
      v_new.setup_fee_discount_ends_at := private.json_text(v_patch, 'setup_fee_discount_ends_at')::timestamptz;
    exception when data_exception then
      perform private.fail('INVALID_INPUT', 'setup_fee_discount_ends_at');
    end;
    -- Not 'infinity' or a far-off year, which the screen could not show.
    if v_new.setup_fee_discount_ends_at not between '2000-01-01T00:00:00Z' and '2100-01-01T00:00:00Z' then
      perform private.fail('INVALID_INPUT', 'setup_fee_discount_ends_at');
    end if;
  end if;
  if v_patch ? 'support_phone' then
    v_new.support_phone := private.tidy_text(private.json_text(v_patch, 'support_phone'));
    if length(v_new.support_phone) > 20 then
      perform private.fail('INVALID_INPUT', 'support_phone');
    end if;
  end if;
  if v_patch ? 'support_email' then
    v_new.support_email := private.tidy_text(private.json_text(v_patch, 'support_email'));
    if length(v_new.support_email) > 254 or v_new.support_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      perform private.fail('INVALID_INPUT', 'support_email');
    end if;
  end if;

  if v_patch ? 'health_setup_days' then
    v_new.health_setup_days := private.json_int(v_patch, 'health_setup_days');
    if v_new.health_setup_days not between 1 and 90 then
      perform private.fail('INVALID_INPUT', 'health_setup_days');
    end if;
  end if;
  if v_patch ? 'health_inactive_days' then
    v_new.health_inactive_days := private.json_int(v_patch, 'health_inactive_days');
    if v_new.health_inactive_days not between 1 and 60 then
      perform private.fail('INVALID_INPUT', 'health_inactive_days');
    end if;
  end if;
  if v_patch ? 'health_slowing_percent' then
    v_new.health_slowing_percent := private.json_int(v_patch, 'health_slowing_percent');
    if v_new.health_slowing_percent not between 1 and 99 then
      perform private.fail('INVALID_INPUT', 'health_slowing_percent');
    end if;
  end if;
  if v_patch ? 'health_slowing_min_orders' then
    v_new.health_slowing_min_orders := private.json_int(v_patch, 'health_slowing_min_orders');
    if v_new.health_slowing_min_orders not between 1 and 10000 then
      perform private.fail('INVALID_INPUT', 'health_slowing_min_orders');
    end if;
  end if;

  -- Plan limits in MB: null clears one.
  if v_patch ? 'db_limit_mb' then
    v_new.db_limit_mb := case when jsonb_typeof(v_patch -> 'db_limit_mb') <> 'null'
      then private.json_int(v_patch, 'db_limit_mb') end;
    if v_new.db_limit_mb not between 1 and 10000000 then
      perform private.fail('INVALID_INPUT', 'db_limit_mb');
    end if;
  end if;
  if v_patch ? 'storage_limit_mb' then
    v_new.storage_limit_mb := case when jsonb_typeof(v_patch -> 'storage_limit_mb') <> 'null'
      then private.json_int(v_patch, 'storage_limit_mb') end;
    if v_new.storage_limit_mb not between 1 and 10000000 then
      perform private.fail('INVALID_INPUT', 'storage_limit_mb');
    end if;
  end if;

  update public.platform_settings s
    set trial_days = v_new.trial_days,
        grace_days = v_new.grace_days,
        setup_fee_paise = v_new.setup_fee_paise,
        setup_fee_discount_paise = v_new.setup_fee_discount_paise,
        setup_fee_discount_ends_at = v_new.setup_fee_discount_ends_at,
        support_phone = v_new.support_phone,
        support_email = v_new.support_email,
        health_setup_days = v_new.health_setup_days,
        health_inactive_days = v_new.health_inactive_days,
        health_slowing_percent = v_new.health_slowing_percent,
        health_slowing_min_orders = v_new.health_slowing_min_orders,
        db_limit_mb = v_new.db_limit_mb,
        storage_limit_mb = v_new.storage_limit_mb
    where s.id = 1
    returning * into v_new;

  -- Audit only what changed.
  for v_key in select jsonb_object_keys(v_patch) loop
    if (to_jsonb(v_old) -> v_key) is distinct from (to_jsonb(v_new) -> v_key) then
      v_before := v_before || jsonb_build_object(v_key, to_jsonb(v_old) -> v_key);
      v_after := v_after || jsonb_build_object(v_key, to_jsonb(v_new) -> v_key);
    end if;
  end loop;
  if v_after <> '{}'::jsonb then
    perform private.audit_platform(
      v_admin, null, 'platform_settings.updated', 'platform_settings', null, v_before, v_after
    );
  end if;

  return to_jsonb(v_new) - 'id' - 'created_at' - 'updated_at';
end;
$function$;

-- ─── Grants ─────────────────────────────────────────────────────────────────
revoke execute on function private.cron_status() from public, anon, authenticated;
revoke execute on function private.email_rows(text) from public, anon, authenticated;
revoke execute on function public.email_log_cleanup() from public, anon, authenticated;
grant execute on function public.email_log_cleanup() to service_role;
revoke execute on function public.email_log_record_event(text, text) from public, anon, authenticated;
grant execute on function public.email_log_record_event(text, text) to service_role;
revoke execute on function public.platform_system() from public, anon;
grant execute on function public.platform_system() to authenticated;
revoke execute on function public.platform_email_sends(text) from public, anon;
grant execute on function public.platform_email_sends(text) to authenticated;
