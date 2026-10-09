-- Self-serve signups from the website (spec §24 W3, docs/DECISIONS.md W-9):
-- only the server starts, resends, verifies and finishes them, one email or
-- network can't flood the table, a code allows five wrong tries before it
-- locks, and a signup gets at most three codes.
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

select tests.create_user('visitor@signups.test') as visitor \gset
select tests.create_restaurant('signup-one') as rest_one \gset
select tests.create_restaurant('signup-two') as rest_two \gset

\set ip '''aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'''
\set net '''cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'''

-- ─── Grants ─────────────────────────────────────────────────────────────────
select ok(
  has_function_privilege('service_role', 'public.site_signup_start(text, jsonb, text, text)', 'execute')
    and has_function_privilege('service_role', 'public.site_signup_resend(uuid, text)', 'execute')
    and has_function_privilege('service_role', 'public.site_signup_verify(uuid, text)', 'execute')
    and has_function_privilege('service_role', 'public.site_signup_finish(uuid, uuid)', 'execute')
    and has_function_privilege('service_role', 'public.site_signups_cleanup()', 'execute'),
  'the server starts, resends, verifies, finishes and cleans up signups'
);
select ok(
  not has_function_privilege('anon', 'public.site_signup_resend(uuid, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.site_signup_resend(uuid, text)', 'execute')
    and not has_function_privilege('anon', 'public.site_signup_finish(uuid, uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.site_signup_finish(uuid, uuid)', 'execute')
    and not has_function_privilege('anon', 'public.site_signups_cleanup()', 'execute')
    and not has_function_privilege('authenticated', 'public.site_signups_cleanup()', 'execute'),
  'nobody else can resend, finish or clean up'
);

select tests.as_anon();
select throws_ok(
  $$select public.site_signup_start('a@example.com', '{}', repeat('a', 64))$$,
  '42501', null, 'visitors cannot start a signup directly'
);
select throws_ok(
  $$select public.site_signup_verify(gen_random_uuid(), repeat('a', 64))$$,
  '42501', null, 'visitors cannot verify a code directly'
);
select throws_ok($$select * from public.site_signups$$, '42501', null, 'visitors cannot read signups');

select tests.authenticate_as(:'visitor');
select throws_ok(
  $$select public.site_signup_start('a@example.com', '{}', repeat('a', 64))$$,
  '42501', null, 'signed-in users cannot start a signup directly'
);
select throws_ok(
  $$select public.site_signup_verify(gen_random_uuid(), repeat('a', 64))$$,
  '42501', null, 'signed-in users cannot verify a code directly'
);
select throws_ok($$select * from public.site_signups$$, '42501', null, 'signed-in users cannot read signups');
select tests.clear_auth();

-- ─── Starting ───────────────────────────────────────────────────────────────
select tests.as_service_role();

select public.site_signup_start(
  '  Asha@Example.COM ',
  '{"restaurant_name": "Spice Route", "city": "Pune", "plan_code": "growth"}',
  repeat('a', 64), :ip
) as asha \gset
select results_eq(
  format($$select email, details, ip_hash, tries, verified_at from public.site_signups where id = %L$$, :'asha'),
  format($$values ('asha@example.com',
    '{"restaurant_name": "Spice Route", "city": "Pune", "plan_code": "growth"}'::jsonb,
    %L, 0::smallint, null::timestamptz)$$, :ip),
  'the returned id is the stored signup: email lower-cased and trimmed, details kept'
);
select ok(
  (select expires_at between now() + interval '14 minutes' and now() + interval '16 minutes'
   from public.site_signups where id = :'asha'),
  'the code expires in 15 minutes'
);

select throws_ok(
  $$select public.site_signup_start('not-an-email', '{}', repeat('a', 64))$$,
  'P0001', 'INVALID_INPUT', 'a malformed email is refused'
);
select throws_ok(
  $$select public.site_signup_start('bad@example.com', '{}', repeat('a', 63))$$,
  'P0001', 'INVALID_INPUT', 'a code hash must be 64 characters'
);
select throws_ok(
  $$select public.site_signup_start('bad@example.com', '{}', repeat('z', 64))$$,
  'P0001', 'INVALID_INPUT', 'a code hash must be hex'
);
select throws_ok(
  $$select public.site_signup_start('bad@example.com', '[]', repeat('a', 64))$$,
  'P0001', 'INVALID_INPUT', 'the details must be an object'
);

-- ─── Rate limits ────────────────────────────────────────────────────────────
-- One email: three codes an hour, however it is typed.
select is(
  (select count(public.site_signup_start(e, '{}', repeat('a', 64)))
   from unnest(array['Ravi@Example.com', 'RAVI@EXAMPLE.COM', ' ravi@example.com ']) as e),
  3::bigint, 'three codes for one email'
);
select throws_ok(
  $$select public.site_signup_start('ravi@EXAMPLE.com', '{}', repeat('a', 64))$$,
  'P0001', 'RATE_LIMITED', 'a fourth code in an hour for one email is refused'
);
select tests.clear_auth();
update public.site_signups set created_at = now() - interval '61 minutes' where email = 'ravi@example.com';
select tests.as_service_role();
select lives_ok(
  $$select public.site_signup_start('ravi@example.com', '{}', repeat('a', 64))$$,
  'the email can ask again after an hour'
);

-- One network: ten signups a day, whatever the email.
select is(
  (select count(public.site_signup_start(format('net%s@example.com', n), '{}', repeat('a', 64), :net))
   from generate_series(1, 10) as n),
  10::bigint, 'ten signups from one network'
);
select throws_ok(
  format($$select public.site_signup_start('net11@example.com', '{}', repeat('a', 64), %L)$$, :net),
  'P0001', 'RATE_LIMITED', 'an eleventh signup in a day from one network is refused'
);
select tests.clear_auth();
update public.site_signups set created_at = now() - interval '25 hours' where ip_hash = :net;
select tests.as_service_role();
select lives_ok(
  format($$select public.site_signup_start('net11@example.com', '{}', repeat('a', 64), %L)$$, :net),
  'the network can sign up again after a day'
);

-- ─── Cleanup ────────────────────────────────────────────────────────────────
select public.site_signup_start('old@example.com', '{}', repeat('a', 64)) as old \gset
select public.site_signup_start('week@example.com', '{}', repeat('a', 64)) as week \gset
select tests.clear_auth();
update public.site_signups set created_at = now() - interval '7 days 1 minute' where id = :'old';
update public.site_signups set created_at = now() - interval '6 days' where id = :'week';
select tests.as_service_role();
select lives_ok(
  $$select public.site_signup_start('next@example.com', '{}', repeat('a', 64))$$,
  'the next signup comes in'
);
select results_eq(
  format($$select email from public.site_signups where id in (%L, %L)$$, :'old', :'week'),
  $$values ('week@example.com')$$,
  'signups older than a week are deleted, younger ones kept'
);
select tests.clear_auth();
update public.site_signups set created_at = now() - interval '8 days' where id = :'week';
select tests.as_service_role();
select is(public.site_signups_cleanup(), 1, 'the daily cleanup deletes them too, and says how many');
select is(public.site_signups_cleanup(), 0, 'and finds nothing left the second time');

-- ─── Verifying ──────────────────────────────────────────────────────────────
select is(
  public.site_signup_verify(:'asha', repeat('b', 64)),
  '{"status": "wrong", "tries_left": 4}'::jsonb,
  'a wrong code says how many tries are left'
);
select is(
  (select tries from public.site_signups where id = :'asha'), 1::smallint,
  'the wrong try is counted'
);
select is(
  public.site_signup_verify(:'asha', repeat('a', 64)),
  '{"status": "ok", "email": "asha@example.com",
    "details": {"restaurant_name": "Spice Route", "city": "Pune", "plan_code": "growth"}}'::jsonb,
  'the right code returns the email and details'
);
select ok(
  (select verified_at is null from public.site_signups where id = :'asha'),
  'the right code alone doesn''t use the signup up'
);
select is(
  public.site_signup_verify(:'asha', repeat('a', 64)) ->> 'status', 'ok',
  'so creating the restaurant can be tried again with it'
);
select lives_ok(format($$select public.site_signup_finish(%L, %L)$$, :'asha', :'rest_one'), 'the signup is finished');
select ok(
  (select verified_at is not null from public.site_signups where id = :'asha'),
  'a finished signup is marked verified'
);
select is(
  (select signup_source from public.restaurants where id = :'rest_one'), null::jsonb,
  'a signup without campaign tags leaves the restaurant without a source'
);
select is(
  public.site_signup_verify(:'asha', repeat('a', 64)), '{"status": "gone"}'::jsonb,
  'the code stops working once the signup is finished'
);
select lives_ok(
  format($$select public.site_signup_finish(%L, %L)$$, :'asha', :'rest_one'), 'finishing twice changes nothing'
);
select is(
  public.site_signup_verify(gen_random_uuid(), repeat('a', 64)), '{"status": "gone"}'::jsonb,
  'an unknown signup is gone'
);

-- ─── Where a signup came from (docs/DECISIONS.md W-13) ──────────────────────
select public.site_signup_start(
  'meera@example.com',
  '{"restaurantName": "Dosa Corner", "source": {"utm_source": " newsletter ",
    "utm_campaign": "launch", "gclid": "abc", "referrer": 7}}',
  repeat('d', 64)
) as meera \gset
select lives_ok(
  format($$select public.site_signup_finish(%L, %L)$$, :'meera', :'rest_two'),
  'a signup with campaign tags is finished'
);
select is(
  (select signup_source from public.restaurants where id = :'rest_two'),
  '{"utm_source": "newsletter", "utm_campaign": "launch"}'::jsonb,
  'its restaurant keeps the known tags, tidied'
);
select lives_ok(
  format($$select public.site_signup_finish(%L, %L)$$, :'meera', :'rest_one'),
  'finishing it again'
);
select is(
  (select signup_source from public.restaurants where id = :'rest_one'), null::jsonb,
  'doesn''t give the source to another restaurant'
);
select public.site_signup_start('old@example.com', '{"restaurantName": "Old Build"}', repeat('e', 64))
  as old_build \gset
select lives_ok(
  format($$select public.site_signup_finish(%L)$$, :'old_build'),
  'a build from before sources were kept can still finish a signup'
);
select ok(
  (select verified_at is not null from public.site_signups where id = :'old_build'),
  'and it is marked verified'
);

select public.site_signup_start('late@example.com', '{}', repeat('a', 64)) as late \gset
select tests.clear_auth();
update public.site_signups set expires_at = now() - interval '1 second' where id = :'late';
select tests.as_service_role();
select is(
  public.site_signup_verify(:'late', repeat('a', 64)), '{"status": "expired"}'::jsonb,
  'an expired code is refused, even the right one'
);

-- Five wrong tries lock the code for good.
select public.site_signup_start('lock@example.com', '{}', repeat('a', 64)) as lock \gset
select is(
  (select array_agg((public.site_signup_verify(:'lock', repeat('b', 64)) ->> 'tries_left')::int order by n)
   from generate_series(1, 4) as n),
  array[4, 3, 2, 1], 'each wrong try uses one up'
);
select is(
  public.site_signup_verify(:'lock', repeat('b', 64)), '{"status": "locked"}'::jsonb,
  'the fifth wrong try locks the code'
);
select is(
  public.site_signup_verify(:'lock', repeat('a', 64)), '{"status": "locked"}'::jsonb,
  'the right code no longer works once locked'
);

-- ─── New codes ──────────────────────────────────────────────────────────────
select is(
  public.site_signup_resend(:'lock', repeat('c', 64)), 'lock@example.com',
  'a new code for a locked signup goes to its email'
);
select results_eq(
  format($$select tries, sends from public.site_signups where id = %L$$, :'lock'),
  $$values (0::smallint, 2::smallint)$$,
  'the new code comes with fresh tries'
);
select is(
  public.site_signup_verify(:'lock', repeat('a', 64)) ->> 'status', 'wrong',
  'the old code stops working'
);
select is(
  public.site_signup_verify(:'lock', repeat('c', 64)) ->> 'status', 'ok', 'the new code works'
);
select lives_ok(
  format($$select public.site_signup_resend(%L, repeat('d', 64))$$, :'lock'), 'a third code'
);
select throws_ok(
  format($$select public.site_signup_resend(%L, repeat('e', 64))$$, :'lock'),
  'P0001', 'RATE_LIMITED', 'a fourth code for one signup is refused'
);

select tests.clear_auth();
update public.site_signups
set expires_at = now() + interval '15 minutes', created_at = now() - interval '61 minutes'
where id = :'late';
select tests.as_service_role();
select throws_ok(
  format($$select public.site_signup_resend(%L, repeat('c', 64))$$, :'late'),
  'P0001', 'NOT_FOUND', 'no new codes an hour after starting'
);
select throws_ok(
  format($$select public.site_signup_resend(%L, repeat('c', 64))$$, :'asha'),
  'P0001', 'NOT_FOUND', 'no new codes for a finished signup'
);
select throws_ok(
  $$select public.site_signup_resend(gen_random_uuid(), repeat('c', 64))$$,
  'P0001', 'NOT_FOUND', 'no new codes for an unknown signup'
);
select public.site_signup_start('fresh@example.com', '{}', repeat('a', 64)) as fresh \gset
select throws_ok(
  format($$select public.site_signup_resend(%L, 'not-a-hash')$$, :'fresh'),
  'P0001', 'INVALID_INPUT', 'a new code needs a proper hash'
);

select tests.clear_auth();
select * from finish();
rollback;
