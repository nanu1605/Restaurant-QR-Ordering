-- Self-serve signups from the website (spec §24 W3, docs/DECISIONS.md W-9):
-- only the server starts and verifies them, one email or network can't flood
-- the table, and a code allows five wrong tries before it locks.
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

select tests.create_user('visitor@signups.test') as visitor \gset

\set ip '''aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'''
\set net '''cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'''

-- ─── Grants ─────────────────────────────────────────────────────────────────
select ok(
  has_function_privilege('service_role', 'public.site_signup_start(text, jsonb, text, text)', 'execute')
    and has_function_privilege('service_role', 'public.site_signup_verify(uuid, text)', 'execute'),
  'the server starts and verifies signups'
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
  (select verified_at is not null from public.site_signups where id = :'asha'),
  'the signup is marked verified'
);
select is(
  public.site_signup_verify(:'asha', repeat('a', 64)), '{"status": "gone"}'::jsonb,
  'a code works once'
);
select is(
  public.site_signup_verify(gen_random_uuid(), repeat('a', 64)), '{"status": "gone"}'::jsonb,
  'an unknown signup is gone'
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

select tests.clear_auth();
select * from finish();
rollback;
