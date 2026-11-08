-- Restartable data exports (docs/DECISIONS.md VPS-26): a request queues its export; a claim
-- builds the oldest one under a lease that a heartbeat renews, one build at a time on the whole
-- platform; only the claim that holds an export finishes it, and a cut-off build goes back to the
-- queue until its third cut.
begin;
select no_plan();

-- ─── Fixtures ───────────────────────────────────────────────────────────────
select tests.create_platform_admin('vps690-admin@example.test') as admin \gset
select tests.create_restaurant('vps690-first') as first_shop \gset
select tests.create_restaurant('vps690-second') as second_shop \gset
select tests.create_restaurant('vps690-third') as third_shop \gset
select tests.create_restaurant('vps690-later') as later_shop \gset
select tests.create_restaurant('vps690-stale') as stale_shop \gset
select tests.create_restaurant('vps690-gone') as gone_shop \gset
select tests.add_member(:'first_shop', 'owner', 'vps690owner') as owner \gset
select tests.add_member(:'gone_shop', 'owner', 'vps690goneowner') as gone_owner \gset

-- A local database's own exports, set aside until the rollback.
update public.restaurant_exports
  set status = 'failed', lease_until = null, finished_at = now()
  where status in ('queued', 'building');

create function pg_temp.export(p_id uuid) returns public.restaurant_exports
language sql as $$
  select * from public.restaurant_exports e where e.id = p_id;
$$;
-- An export of its own, without a request (and its hourly limit).
create function pg_temp.queue(p_restaurant_id uuid, p_age interval default '0 seconds')
returns uuid
language sql as $$
  insert into public.restaurant_exports (restaurant_id, created_at)
  values (p_restaurant_id, now() - p_age)
  returning id;
$$;
-- The lease runs out, as when the server building it dies.
create function pg_temp.lapse(p_id uuid) returns void
language sql as $$
  update public.restaurant_exports set lease_until = now() - interval '1 second' where id = p_id;
$$;

-- ─── Requests ───────────────────────────────────────────────────────────────
select tests.as_service_role();
select is(public.restaurant_export_claim(), null, 'nothing queued: no claim');
select tests.clear_auth();
select ok(not private.export_jobs_waiting(), 'and nothing waits');

select tests.authenticate_as(:'owner');
select public.admin_request_data_export() as first_export \gset
select is(public.admin_data_export() ->> 'status', 'building', 'a queued export reads as building');
select throws_ok('select public.admin_request_data_export()', 'P0001', 'EXPORT_TOO_SOON',
  'and counts for the hour, as before');
select tests.clear_auth();
select is((pg_temp.export(:'first_export')).status, 'queued', 'a request queues its export');
select is((pg_temp.export(:'first_export')).attempts, 0, 'never cut off');
select is((pg_temp.export(:'first_export')).claim_id, null, 'unclaimed');
select is((pg_temp.export(:'first_export')).lease_until, null, 'and not leased');
select ok(private.export_jobs_waiting(), 'it waits');

select tests.authenticate_as_platform_admin(:'admin');
select public.platform_request_data_export(:'second_shop') as second_export \gset
select tests.clear_auth();
-- now() is the transaction's: give them the order they were asked in.
update public.restaurant_exports set created_at = now() - interval '3 minutes' where id = :'first_export';
update public.restaurant_exports set created_at = now() - interval '2 minutes' where id = :'second_export';

-- ─── A claim ────────────────────────────────────────────────────────────────
select tests.as_service_role();
select public.restaurant_export_claim() as claim \gset
select is(:'claim'::jsonb ->> 'export_id', :'first_export', 'the first asked is built first');
select is(:'claim'::jsonb ->> 'restaurant_id', :'first_shop', 'with its restaurant');
select is(public.restaurant_export_claim(), null, 'one build at a time: no claim while it runs');
select :'claim'::jsonb ->> 'claim_id' as first_claim \gset
select is((pg_temp.export(:'first_export')).status, 'building', 'it builds');
select is((pg_temp.export(:'first_export')).claim_id::text, :'first_claim', 'under its claim');
select is((pg_temp.export(:'first_export')).lease_until, now() + interval '90 seconds',
  'leased for 90 seconds');
select is((pg_temp.export(:'first_export')).attempts, 0, 'a claim is not a cut');
select tests.authenticate_as(:'owner');
select is(public.admin_data_export() ->> 'status', 'building', 'the page says so');
select tests.clear_auth();

select throws_ok(
  format($$update public.restaurant_exports set status = 'building', claim_id = gen_random_uuid(),
    lease_until = now() + interval '1 minute' where id = %L$$, :'second_export'),
  '23505', null, 'the table holds one building export on the whole platform');
select throws_ok(
  format($$update public.restaurant_exports set status = 'building' where id = %L$$, :'second_export'),
  '23514', null, 'a building export has a lease');
select throws_ok(
  format($$update public.restaurant_exports set status = 'building', lease_until = now()
    where id = %L$$, :'second_export'),
  '23514', null, 'and a claim');
select throws_ok(
  format($$update public.restaurant_exports set lease_until = now() where id = %L$$, :'second_export'),
  '23514', null, 'and only a building one is leased');

-- ─── Heartbeat ──────────────────────────────────────────────────────────────
update public.restaurant_exports set lease_until = now() + interval '5 seconds' where id = :'first_export';
select tests.as_service_role();
select ok(public.restaurant_export_heartbeat(:'first_export', :'first_claim'), 'the build''s heartbeat');
select is((pg_temp.export(:'first_export')).lease_until, now() + interval '90 seconds',
  'renews its lease');
select ok(not public.restaurant_export_heartbeat(:'first_export', gen_random_uuid()),
  'another claim''s says the claim is gone');
select ok(not public.restaurant_export_heartbeat(:'second_export', gen_random_uuid()),
  'as for an export not building');
select ok(public.restaurant_export_heartbeat(:'first_export', :'first_claim', 5), 'a short lease');
select is((pg_temp.export(:'first_export')).lease_until, now() + interval '30 seconds',
  'is 30 seconds at least');
select ok(public.restaurant_export_heartbeat(:'first_export', :'first_claim', 100000), 'a long one');
select is((pg_temp.export(:'first_export')).lease_until, now() + interval '10 minutes',
  'and 10 minutes at most');

-- ─── Complete ───────────────────────────────────────────────────────────────
select ok(not public.restaurant_export_complete(:'first_export', gen_random_uuid(), 2048),
  'another claim can''t complete it');
select is((pg_temp.export(:'first_export')).status, 'building', 'nothing changes');
select throws_ok(format('select public.restaurant_export_complete(%L, %L, null)', :'first_export',
  :'first_claim'), 'P0001', 'INVALID_INPUT', 'it needs a size');
select throws_ok(format('select public.restaurant_export_complete(%L, %L, -1)', :'first_export',
  :'first_claim'), 'P0001', 'INVALID_INPUT', 'of zero or more');
select ok(public.restaurant_export_complete(:'first_export', :'first_claim', 2048),
  'its claim completes it');
select is((pg_temp.export(:'first_export')).status, 'ready', 'it is ready');
select is((pg_temp.export(:'first_export')).size_bytes, 2048::bigint, 'with its size');
select is((pg_temp.export(:'first_export')).expires_at, now() + interval '24 hours', 'for 24 hours');
select is((pg_temp.export(:'first_export')).lease_until, null, 'and no lease');
select ok(not public.restaurant_export_complete(:'first_export', :'first_claim', 2048), 'once');
select tests.authenticate_as(:'owner');
select is(public.admin_data_export() ->> 'status', 'ready', 'the page offers it');
select tests.clear_auth();

-- ─── A cut-off build ────────────────────────────────────────────────────────
select tests.as_service_role();
select public.restaurant_export_claim(5) as claim \gset
select is(:'claim'::jsonb ->> 'export_id', :'second_export', 'the next claim takes the next export');
select is((pg_temp.export(:'second_export')).lease_until, now() + interval '30 seconds',
  'a claim leases for 30 seconds at least');
select :'claim'::jsonb ->> 'claim_id' as second_claim \gset
-- Asked for before it, and its build is cut off.
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_request_data_export(:'third_shop') as third_export \gset
select tests.clear_auth();
update public.restaurant_exports set created_at = now() - interval '10 minutes' where id = :'third_export';
select pg_temp.lapse(:'second_export');
select ok(private.export_jobs_waiting(), 'a lapsed lease waits');

select tests.as_service_role();
select public.restaurant_export_claim() as claim \gset
select is(:'claim'::jsonb ->> 'export_id', :'third_export', 'the next claim builds the oldest');
select :'claim'::jsonb ->> 'claim_id' as third_claim \gset
select is((pg_temp.export(:'second_export')).status, 'queued', 'and queues the cut-off one again');
select is((pg_temp.export(:'second_export')).attempts, 1, 'counting the cut');
select is((pg_temp.export(:'second_export')).last_error, 'the build was cut off', 'with why');
select is((pg_temp.export(:'second_export')).lease_until, null, 'unleased');
select tests.authenticate_as_platform_admin(:'admin');
select is(public.platform_data_export(:'second_shop') ->> 'status', 'building',
  'the page still says it is being prepared');
select tests.as_service_role();
select ok(public.restaurant_export_complete(:'second_export', :'second_claim', 512),
  'its build finishing late still counts while no claim has taken it since');
select is((pg_temp.export(:'second_export')).status, 'ready', 'the file is good');

-- ─── Fail ───────────────────────────────────────────────────────────────────
select ok(not public.restaurant_export_fail(:'third_export', gen_random_uuid(), 'x'),
  'another claim can''t fail it');
select ok(public.restaurant_export_fail(:'third_export', :'third_claim', repeat('x', 600)),
  'its claim fails it');
select is((pg_temp.export(:'third_export')).status, 'failed', 'at once');
select is(char_length((pg_temp.export(:'third_export')).last_error), 500, 'the error cut to 500');
select is((pg_temp.export(:'third_export')).finished_at, now(), 'finished');
select is((pg_temp.export(:'third_export')).lease_until, null, 'unleased');
select ok(not public.restaurant_export_fail(:'third_export', :'third_claim', 'x'), 'once');
select tests.authenticate_as_platform_admin(:'admin');
select is(public.platform_data_export(:'third_shop') ->> 'status', 'failed',
  'the page offers another try');
select tests.clear_auth();

-- ─── Release ────────────────────────────────────────────────────────────────
select pg_temp.queue(:'later_shop', '5 minutes') as released \gset
select is((pg_temp.export(:'released')).status, 'queued', 'an export starts queued');
select tests.as_service_role();
select public.restaurant_export_claim() ->> 'claim_id' as release_claim \gset
select ok(not public.restaurant_export_release(:'released', gen_random_uuid()),
  'another claim can''t hand it back');
select ok(public.restaurant_export_release(:'released', :'release_claim'),
  'a stopping server hands it back');
select is((pg_temp.export(:'released')).status, 'queued', 'to the queue');
select is((pg_temp.export(:'released')).attempts, 0, 'not counted as a cut');
select is((pg_temp.export(:'released')).lease_until, null, 'unleased');
select ok(not public.restaurant_export_release(:'released', :'release_claim'), 'once');
select public.restaurant_export_claim() as claim \gset
select is(:'claim'::jsonb ->> 'export_id', :'released', 'the next claim builds it');
select isnt(:'claim'::jsonb ->> 'claim_id', :'release_claim', 'under a new claim');
select ok(not public.restaurant_export_heartbeat(:'released', :'release_claim'),
  'the old claim is gone');
select ok(public.restaurant_export_complete(:'released', (:'claim'::jsonb ->> 'claim_id')::uuid, 10),
  'and the new one completes it');

-- ─── The third cut ──────────────────────────────────────────────────────────
select tests.clear_auth();
select pg_temp.queue(:'later_shop') as cut \gset
select tests.as_service_role();
select public.restaurant_export_claim() ->> 'claim_id' as cut_claim \gset
select pg_temp.lapse(:'cut');
select is(public.restaurant_export_claim() ->> 'export_id', :'cut', 'a cut export is claimed again');
select is((pg_temp.export(:'cut')).attempts, 1, 'once cut');
select isnt((pg_temp.export(:'cut')).claim_id::text, :'cut_claim', 'under a new claim');
select ok(not public.restaurant_export_complete(:'cut', :'cut_claim', 10),
  'so the cut build can''t complete it');
select pg_temp.lapse(:'cut');
select is(public.restaurant_export_claim() ->> 'export_id', :'cut', 'and again');
select is((pg_temp.export(:'cut')).attempts, 2, 'twice cut');
select pg_temp.lapse(:'cut');
select is(public.restaurant_export_claim(), null, 'the third cut is not built again');
select is((pg_temp.export(:'cut')).status, 'failed', 'it has failed');
select is((pg_temp.export(:'cut')).attempts, 3, 'after three cuts');
select is((pg_temp.export(:'cut')).last_error, 'the build was cut off', 'with why');
select is((pg_temp.export(:'cut')).finished_at, now(), 'finished');
select tests.clear_auth();
select is(private.latest_export(:'later_shop') ->> 'status', 'failed', 'the page offers another try');

-- ─── 15 minutes ─────────────────────────────────────────────────────────────
select pg_temp.queue(:'stale_shop', '16 minutes') as stale \gset
select is(private.latest_export(:'stale_shop') ->> 'status', 'failed',
  'one queued for 15 minutes reads as failed');
select ok(private.export_jobs_waiting(), 'though it waits');
select tests.as_service_role();
select is(public.restaurant_export_claim(), null, 'a claim doesn''t build it');
select is((pg_temp.export(:'stale')).status, 'failed', 'it fails it');
select is((pg_temp.export(:'stale')).last_error, 'not finished in 15 minutes', 'with why');
select is((pg_temp.export(:'stale')).attempts, 0, 'not as a cut');

-- One building for 15 minutes, its lease still running.
select tests.clear_auth();
update public.restaurant_exports
  set status = 'building', claim_id = gen_random_uuid(), lease_until = now() + interval '1 minute',
    finished_at = null, last_error = null
  where id = :'stale';
select is(private.latest_export(:'stale_shop') ->> 'status', 'failed', 'one building as long reads as failed');
select ok(not private.export_jobs_waiting(), 'and doesn''t wait while leased');
select tests.as_service_role();
select is(public.restaurant_export_claim(), null, 'an idle claim leaves it');
select is((pg_temp.export(:'stale')).status, 'building', 'as it was');
select pg_temp.lapse(:'stale');
select is(public.restaurant_export_claim(), null, 'once its lease lapses, a claim');
select is((pg_temp.export(:'stale')).status, 'failed', 'fails it');
select is((pg_temp.export(:'stale')).last_error, 'not finished in 15 minutes', 'for its age');
select is((pg_temp.export(:'stale')).attempts, 0, 'not as a cut');

-- A request goes while the restaurant's last one is queued and stale.
select tests.clear_auth();
select pg_temp.queue(:'stale_shop', '16 minutes') as stale \gset
select tests.authenticate_as_platform_admin(:'admin');
select lives_ok(format('select public.platform_request_data_export(%L)', :'stale_shop'),
  'a request goes after 15 minutes');
select tests.clear_auth();
select is((pg_temp.export(:'stale')).status, 'failed', 'failing the stale one');
select is((pg_temp.export(:'stale')).last_error, 'not finished in 15 minutes', 'with why');
select is(private.latest_export(:'stale_shop') ->> 'status', 'building', 'the new one waits');
select tests.as_service_role();
select public.restaurant_export_claim() as claim \gset
select ok(public.restaurant_export_complete((:'claim'::jsonb ->> 'export_id')::uuid,
  (:'claim'::jsonb ->> 'claim_id')::uuid, 10), 'and is built');

-- ─── The previous build's finish ────────────────────────────────────────────
-- It builds the export it asked for itself, unclaimed (dropped next release).
select tests.clear_auth();
select pg_temp.queue(:'later_shop') as unclaimed \gset
select tests.as_service_role();
select public.restaurant_export_finish(:'unclaimed', 100);
select is((pg_temp.export(:'unclaimed')).status, 'ready', 'the old finish completes an unclaimed export');
select is((pg_temp.export(:'unclaimed')).expires_at, now() + interval '24 hours', 'for 24 hours');

select tests.clear_auth();
select pg_temp.queue(:'later_shop') as claimed \gset
select tests.as_service_role();
select public.restaurant_export_claim() ->> 'claim_id' as claimed_claim \gset
select public.restaurant_export_finish(:'claimed', 100);
select is((pg_temp.export(:'claimed')).status, 'building', 'but not a claimed one');
select ok(public.restaurant_export_release(:'claimed', :'claimed_claim'), 'handed back');
select public.restaurant_export_finish(:'claimed', 100);
select public.restaurant_export_finish(:'claimed');
select is((pg_temp.export(:'claimed')).status, 'queued', 'nor once a claim had it');
select public.restaurant_export_claim() as claim \gset
select ok(public.restaurant_export_complete(:'claimed', (:'claim'::jsonb ->> 'claim_id')::uuid, 10),
  'which the next claim builds');

-- ─── Only the server ────────────────────────────────────────────────────────
select tests.authenticate_as(:'owner');
select throws_ok('select public.restaurant_export_claim()', '42501', null, 'an owner can''t claim');
select throws_ok(format('select public.restaurant_export_heartbeat(%L, %L)', :'first_export',
  :'first_claim'), '42501', null, 'nor renew');
select throws_ok(format('select public.restaurant_export_complete(%L, %L, 1)', :'first_export',
  :'first_claim'), '42501', null, 'nor complete');
select throws_ok(format('select public.restaurant_export_fail(%L, %L, %L)', :'first_export',
  :'first_claim', 'x'), '42501', null, 'nor fail');
select throws_ok(format('select public.restaurant_export_release(%L, %L)', :'first_export',
  :'first_claim'), '42501', null, 'nor hand back');
select tests.as_anon();
select throws_ok('select public.restaurant_export_claim()', '42501', null, 'nor can anyone signed out');
select throws_ok(format('select public.restaurant_export_heartbeat(%L, %L)', :'first_export',
  :'first_claim'), '42501', null, 'renew');
select throws_ok(format('select public.restaurant_export_complete(%L, %L, 1)', :'first_export',
  :'first_claim'), '42501', null, 'complete');
select throws_ok(format('select public.restaurant_export_fail(%L, %L, %L)', :'first_export',
  :'first_claim', 'x'), '42501', null, 'fail');
select throws_ok(format('select public.restaurant_export_release(%L, %L)', :'first_export',
  :'first_claim'), '42501', null, 'or hand back');
select tests.clear_auth();

-- ─── Removal ────────────────────────────────────────────────────────────────
-- The removal after a closed account's hold deletes its exports, the building one too.
select pg_temp.queue(:'gone_shop') as gone \gset
select tests.as_service_role();
select public.restaurant_export_claim() ->> 'claim_id' as gone_claim \gset
select tests.clear_auth();
select pg_temp.queue(:'first_shop') as next_export \gset
select tests.as_service_role();
select is(public.restaurant_export_claim(), null, 'the slot is taken');
select tests.clear_auth();
update public.restaurants set status = 'closed', suspended_reason = 'Account closed' where id = :'gone_shop';
insert into public.restaurant_closures (restaurant_id, removal_due_at, prior_status, member_ids)
values (:'gone_shop', now() - interval '1 minute', 'active', array[:'gone_owner'::uuid]);
select tests.as_service_role();
select is(public.closed_restaurant_remove_personal_data(:'gone_shop') ->> 'removed', 'true',
  'a closed account''s hold ends');
select is((select count(*)::int from public.restaurant_exports where restaurant_id = :'gone_shop'),
  0, 'its exports go');
select ok(not public.restaurant_export_heartbeat(:'gone', :'gone_claim'), 'so its build stops');
select is(public.restaurant_export_claim() ->> 'export_id', :'next_export', 'and the slot is free');
select tests.clear_auth();

select * from finish();
rollback;
