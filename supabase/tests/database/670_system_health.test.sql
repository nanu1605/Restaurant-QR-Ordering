-- System health (docs/SUPER_ADMIN_PLAN.md 14d, docs/DECISIONS.md SA-86+):
-- missing scheduled runs, the email log and Resend's reports, sizes against
-- the plan limits, the month's menu imports, and what reaches Home.
begin;
select no_plan();

-- ─── Fixtures ───────────────────────────────────────────────────────────────
select tests.create_platform_admin('sa670-admin@example.test') as admin \gset
select tests.create_platform_admin('sa670-support@example.test') as support \gset
select tests.create_platform_admin('sa670-finance@example.test') as finance \gset
update public.platform_admins set role = 'support' where user_id = :'support';
update public.platform_admins set role = 'finance' where user_id = :'finance';
select tests.create_restaurant('sa670-cafe') as cafe \gset
-- A dev database's own rows go, inside this test only.
delete from public.cron_runs;
delete from public.email_log;
delete from public.webhook_events;
update public.platform_settings set db_limit_mb = null, storage_limit_mb = null where id = 1;

-- Everything Home would list (no admin, no limit).
create function pg_temp.attention() returns jsonb language sql as $$
  select private.attention(null, true, true, true, 10000);
$$;
create function pg_temp.keys(p_group text) returns text[] language sql as $$
  select coalesce(array_agg(i ->> 'key' order by i ->> 'key'), '{}')
  from jsonb_array_elements(pg_temp.attention() -> 'groups') as g
  cross join jsonb_array_elements(g -> 'items') as i
  where g ->> 'group' = p_group;
$$;
create function pg_temp.item(p_key text) returns jsonb language sql as $$
  select i -> 'data'
  from jsonb_array_elements(pg_temp.attention() -> 'groups') as g
  cross join jsonb_array_elements(g -> 'items') as i
  where i ->> 'key' = p_key;
$$;
create function pg_temp.system(p_user uuid) returns jsonb language plpgsql as $$
declare
  v jsonb;
begin
  perform tests.authenticate_as_platform_admin(p_user);
  v := public.platform_system();
  perform tests.clear_auth();
  return v;
end;
$$;

-- ─── Scheduled jobs ─────────────────────────────────────────────────────────
insert into public.cron_runs (job, step, started_at, finished_at, ok, detail) values
  -- daily: last night's run, a failed step, one that didn't log, one long gone.
  ('daily', 'a', now() - interval '25 hours', now() - interval '25 hours', false, 'was broken'),
  ('daily', 'a', now() - interval '1 hour', now() - interval '1 hour' + interval '2 seconds', true, '{}'),
  ('daily', 'b', now() - interval '1 hour' + interval '1 second', now() - interval '1 hour' + interval '3 seconds', false, 'boom'),
  ('daily', 'c', now() - interval '25 hours', now() - interval '25 hours', true, '{}'),
  ('daily', 'gone', now() - interval '31 days', now() - interval '31 days', true, '{}'),
  -- daily: a step that hung every night for 10 days is still missing.
  ('daily', 'hung', now() - interval '10 days', now() - interval '10 days', true, '{}'),
  -- digest: nothing for 27 hours.
  ('digest', 'digest', now() - interval '27 hours', now() - interval '27 hours', true, '{}'),
  -- fresh: running now, so a step not logged yet isn't judged.
  ('fresh', 'x', now() - interval '5 minutes', now() - interval '5 minutes', true, '{}'),
  ('fresh', 'y', now() - interval '25 hours', now() - interval '25 hours', true, '{}'),
  -- old: stopped a month ago, long noticed.
  ('old', 'z', now() - interval '31 days', now() - interval '31 days', false, 'boom');

select is(
  (select array_agg(c.job || '=' || c.missing order by c.job) from private.cron_status() c
   where c.step is null),
  array['daily=false', 'digest=true', 'fresh=false'],
  'a job with no run for 26 hours missed one (not one a month gone)'
);
select is(
  (select array_agg(c.job || ':' || c.step || '=' || c.ok || '/' || c.missing order by c.job, c.step)
   from private.cron_status() c where c.step is not null),
  array['daily:a=true/false', 'daily:b=false/false', 'daily:c=true/true', 'daily:hung=true/true',
    'digest:digest=true/false', 'fresh:x=true/false', 'fresh:y=true/false'],
  'each step''s latest run; one missing from its job''s latest run, judged after 10 minutes'
);
select is(pg_temp.keys('cron'), array['cron:daily:b', 'cron:daily:c', 'cron:daily:hung', 'cron:digest'],
  'Home: the failed step, the step that didn''t finish and the missed job');
select is(pg_temp.item('cron:digest') - 'started_at',
  '{"job": "digest", "step": null, "detail": null, "missing": true}'::jsonb,
  'a missed job is the job, not a step');
select is(pg_temp.item('cron:daily:c') ->> 'missing', 'true', 'a step that didn''t finish says so');

select pg_temp.system(:'admin') as sys \gset
select is(
  (select j - 'last_at' from jsonb_array_elements((:'sys'::jsonb) -> 'jobs') as j
   where j ->> 'job' = 'daily'),
  '{"job": "daily", "missing": false, "ms": 3000, "steps": 4, "failed": 1, "missing_steps": 2}'::jsonb,
  'System: the job''s latest run, how long it took, its steps'
);
select is(
  (select array_agg(f ->> 'step' order by f ->> 'started_at' desc)
   from jsonb_array_elements((:'sys'::jsonb) -> 'failures') as f),
  array['b', 'a'],
  'and the week''s failures, newest first'
);
select is(
  (select s ->> 'ms' from jsonb_array_elements((:'sys'::jsonb) -> 'steps') as s
   where s ->> 'job' = 'daily' and s ->> 'step' = 'b'),
  '2000', 'each step''s time'
);

-- ─── Webhooks ───────────────────────────────────────────────────────────────
insert into public.webhook_events (provider, event_id, event_type, payload, processing_error, received_at)
values
  ('razorpay', 'evt_sa670_new', 'sa670.test', '{}', 'Could not apply it', now()),
  ('razorpay', 'evt_sa670_old', 'sa670.test', '{}', 'Could not apply it', now() - interval '2 days'),
  ('razorpay', 'evt_sa670_ok', 'sa670.test', '{}', null, now());
select is(pg_temp.system(:'admin') -> 'webhooks', '{"failed_24h": 1, "failed_open": 2}'::jsonb,
  'webhooks: failed in 24 hours, and all still failed');

-- ─── Email log ──────────────────────────────────────────────────────────────
select repeat('a', 64) as hash_a, repeat('b', 64) as hash_b \gset
select throws_ok(
  $$insert into public.email_log (kind, recipient_hashes, status)
    values ('signup', array['someone@example.test'], 'sent')$$,
  '23514', null, 'never a plain address'
);
select throws_ok(
  format($$insert into public.email_log (kind, recipient_hashes, status) values ('Sign up', array[%L], 'sent')$$,
    :'hash_a'),
  '23514', null, 'a kind is the key''s lower-case first part'
);
insert into public.email_log (kind, recipient_hashes, status, provider_id, http_status, error, created_at)
values
  ('reminder', array[:'hash_a'], 'sent', 're_1', null, null, now() - interval '2 minutes'),
  ('reminder', array[:'hash_a'], 'failed', null, 422, 'Resend answered 422: bad', now() - interval '1 minute'),
  ('digest', array[:'hash_b', :'hash_a'], 'duplicate', null, 409, null, now()),
  ('signup', array[:'hash_b'], 'sent', 're_2', null, null, now()),
  ('welcome', array[:'hash_b'], 'sent', 're_3', null, null, now() - interval '30 hours'),
  ('lead', array[:'hash_b'], 'sent', 're_4', null, null, now() - interval '31 days');

select tests.authenticate_as_platform_admin(:'admin');
select throws_ok('select count(*) from public.email_log', '42501', null,
  'the team reads the log only through the functions');
select throws_ok('select public.email_log_cleanup()', '42501', null, 'cleanup is the cron''s');
select throws_ok($$select public.email_log_record_event('re_1', 'email.bounced')$$, '42501', null,
  'and reports are the webhook''s');
select tests.clear_auth();

select is(public.email_log_record_event('re_1', 'email.bounced'), 1, 'a bounce marks the email');
select is(public.email_log_record_event('re_1', 'email.failed'), 0, 'a lesser report doesn''t undo it');
select is(public.email_log_record_event('re_1', 'email.complained'), 1, 'a spam report outranks it');
select is(public.email_log_record_event('re_2', 'email.delivered'), 0, 'other events are ignored');
select is(public.email_log_record_event('re_unknown', 'email.bounced'), 0, 'and unknown emails');
select is(public.email_log_record_event('re_3', 'email.suppressed'), 1,
  'not sent to an address that bounced before: a bounce');
select ok((select updated_at = now() from public.email_log where provider_id = 're_1'),
  'and when it was reported');

select is(
  (select jsonb_agg(k order by k ->> 'kind') from jsonb_array_elements(
     pg_temp.system(:'admin') -> 'email' -> 'kinds') as k),
  '[{"kind": "digest", "sent": 0, "duplicate": 1, "failed": 0, "bounced": 0, "complained": 0},
    {"kind": "reminder", "sent": 0, "duplicate": 0, "failed": 1, "bounced": 0, "complained": 1},
    {"kind": "signup", "sent": 1, "duplicate": 0, "failed": 0, "bounced": 0, "complained": 0},
    {"kind": "welcome", "sent": 0, "duplicate": 0, "failed": 0, "bounced": 1, "complained": 0}]'::jsonb,
  'System: the last day by kind, as Home counts it'
);
select is(
  (select array_agg(r ->> 'kind') from jsonb_array_elements(pg_temp.system(:'admin') -> 'email' -> 'recent') as r),
  array['signup', 'digest', 'reminder', 'reminder', 'welcome', 'lead'],
  'and the latest sends, newest first'
);
select is(
  (select r - 'id' - 'created_at' - 'updated_at' from jsonb_array_elements(
     pg_temp.system(:'admin') -> 'email' -> 'recent') as r where r ->> 'kind' = 'digest'),
  '{"kind": "digest", "status": "duplicate", "recipients": 2, "provider_id": null,
    "http_status": 409, "error": null}'::jsonb,
  'a send says how many it went to, never who'
);

select is(pg_temp.keys('email'), array['email:reminder', 'email:welcome'],
  'Home: kinds with failures or reports in the last day (a bounce reported late too)');
select is(pg_temp.item('email:reminder') - 'last_at',
  '{"kind": "reminder", "failed": 1, "bounced": 0, "complained": 1}'::jsonb,
  'with what went wrong');

-- One address's emails: by its hash, Support too.
select tests.authenticate_as_platform_admin(:'support');
select is(
  (select array_agg(r ->> 'status') from jsonb_array_elements(public.platform_email_sends(:'hash_a')) as r),
  array['duplicate', 'failed', 'complained'],
  'the emails to one address, newest first'
);
select is(public.platform_email_sends(repeat('c', 64)), '[]'::jsonb, 'none to another');
select throws_ok($$select public.platform_email_sends('someone@example.test')$$, 'P0001', 'INVALID_INPUT',
  'a hash, never the address');
select ok(public.platform_system() ? 'jobs', 'Support sees System');
select tests.clear_auth();
select tests.authenticate_as_platform_admin(:'finance');
select throws_ok('select public.platform_system()', 'P0001', 'FORBIDDEN', 'Finance doesn''t');
select throws_ok(format('select public.platform_email_sends(%L)', :'hash_a'), 'P0001', 'FORBIDDEN',
  'nor its email lookup');
select tests.clear_auth();
select tests.as_anon();
select throws_ok('select public.platform_system()', '42501', null, 'nor anyone signed out');
select tests.clear_auth();

select is(public.email_log_cleanup(), 1, 'the nightly cleanup deletes rows past 30 days');
select is((select count(*)::int from public.email_log), 5, 'and keeps the rest');

-- ─── Plan limits and space ──────────────────────────────────────────────────
select is(pg_temp.keys('capacity'), '{}'::text[], 'no limits entered, no warning');
select ok((pg_temp.system(:'admin') -> 'sizes' ->> 'database_bytes')::bigint > 0, 'the database''s size');
select ok(
  jsonb_typeof(pg_temp.system(:'admin') -> 'sizes' -> 'buckets') = 'array'
    and (pg_temp.system(:'admin') -> 'sizes' -> 'db_limit_mb') = 'null'::jsonb,
  'storage by bucket, and no limit yet'
);

select tests.authenticate_as_platform_admin(:'admin');
select throws_ok($$select public.platform_update_settings('{"db_limit_mb": 0}')$$, 'P0001', 'INVALID_INPUT',
  'a limit is 1 MB or more');
select throws_ok($$select public.platform_update_settings('{"storage_limit_mb": "8 GB"}')$$, 'P0001',
  'INVALID_INPUT', 'in whole MB');
select is(
  public.platform_update_settings('{"db_limit_mb": 1, "storage_limit_mb": 10000000}')
    -> 'db_limit_mb',
  '1'::jsonb, 'limits are saved'
);
select is(
  (select after from public.audit_logs where action = 'platform_settings.updated'
     and created_at = now() and actor_user_id = :'admin'),
  '{"db_limit_mb": 1, "storage_limit_mb": 10000000}'::jsonb,
  'and audited'
);
select tests.clear_auth();
select is(pg_temp.keys('capacity'), array['capacity:database'],
  'Home: a database past 80% of its limit (not storage, far below its)');
select is((pg_temp.item('capacity:database') ->> 'limit_bytes')::numeric, 1048576::numeric,
  'with its limit in bytes');
select tests.authenticate_as_platform_admin(:'admin');
select is(
  public.platform_update_settings('{"db_limit_mb": null}') -> 'db_limit_mb', 'null'::jsonb,
  'null clears a limit'
);
select tests.clear_auth();
select is(pg_temp.keys('capacity'), '{}'::text[], 'and its warning');

-- ─── Menu imports ───────────────────────────────────────────────────────────
select pg_temp.system(:'admin') -> 'menu_imports' as imports_before \gset
insert into public.menu_imports (restaurant_id, source, status, page_count, cost_paise, completed_at)
values
  (:'cafe', 'photo', 'imported', 1, 1500, now()),
  (:'cafe', 'csv', 'imported', 0, 0, now()),
  (:'cafe', 'photo', 'processing', 1, 300, null);
insert into public.menu_imports (restaurant_id, source, status, page_count, cost_paise, error, completed_at)
values (:'cafe', 'photo', 'failed', 1, null, 'Nothing could be read', now())
returning id as failed_import \gset
insert into public.menu_imports (restaurant_id, source, status, page_count, completed_at)
values (:'cafe', 'photo', 'failed', 1, now() - interval '3 days');
select pg_temp.system(:'admin') -> 'menu_imports' as imports_after \gset
select is(
  (select jsonb_object_agg(k, (:'imports_after'::jsonb ->> k)::bigint - (:'imports_before'::jsonb ->> k)::bigint)
   from unnest(array['imports', 'photo', 'csv', 'imported', 'failed', 'open', 'cost_paise', 'cost_unknown']) as k),
  '{"imports": 5, "photo": 4, "csv": 1, "imported": 2, "failed": 2, "open": 1,
    "cost_paise": 1800, "cost_unknown": 1}'::jsonb,
  'this month''s imports: by source and outcome, the known cost and how many aren''t known'
);
select ok(
  'menu_imports:' || :'failed_import' = any (pg_temp.keys('menu_imports'))
    and (select count(*) from unnest(pg_temp.keys('menu_imports')) as k
         where k in (select 'menu_imports:' || id from public.menu_imports
                     where restaurant_id = :'cafe')) = 1,
  'Home: an import that failed in the last two days (not one from before)'
);
select is(pg_temp.item('menu_imports:' || :'failed_import') - 'completed_at' - 'import_id',
  jsonb_build_object('restaurant_id', :'cafe', 'name', (select name from public.restaurants where id = :'cafe'),
    'source', 'photo', 'error', 'Nothing could be read'),
  'with the restaurant and why');

-- ─── Snoozes ────────────────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select ok(public.platform_snooze('email:reminder', 1) > now(), 'an email kind can be snoozed');
select ok(public.platform_snooze('capacity:database', 3) > now(), 'and space');
select ok(public.platform_snooze('menu_imports:' || :'failed_import', 7) > now(), 'and a menu import');
select ok(public.platform_snooze('cron:digest', 1) > now(), 'and a missed job');
select tests.clear_auth();

select * from finish();
rollback;
