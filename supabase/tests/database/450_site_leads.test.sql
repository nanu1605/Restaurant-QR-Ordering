-- "Book a demo" leads from the website (spec §24 W2, docs/DECISIONS.md W-6):
-- only the server writes them, only platform admins read them, and one
-- network or phone number can't flood the list.
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

select tests.create_platform_admin('leads@platform.test') as admin \gset
select tests.create_restaurant('leads-rest') as rest \gset
select tests.add_member(:'rest', 'owner', 'leads_owner') as owner \gset

\set ip '''aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'''

-- ─── Grants ─────────────────────────────────────────────────────────────────
select ok(
  not has_function_privilege('anon', 'public.site_create_lead(jsonb, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.site_create_lead(jsonb, text)', 'execute')
    and has_function_privilege('service_role', 'public.site_create_lead(jsonb, text)', 'execute'),
  'only the server writes leads'
);

-- ─── Writing ────────────────────────────────────────────────────────────────
select tests.as_service_role();

select lives_ok(
  format($$select public.site_create_lead(
    '{"name": "  Asha   Rao ", "restaurant_name": "Spice Route", "city": "Pune",
      "phone": "9876543210", "email": " Asha@Example.COM ", "plan_code": "growth",
      "message": "  Ten tables.\nOpen till late.  "}', %L)$$, :ip),
  'a complete lead is stored'
);
select results_eq(
  $$select name, restaurant_name, city, phone, email, plan_code, message
    from public.site_leads where phone = '9876543210'$$,
  $$values ('Asha Rao', 'Spice Route', 'Pune', '9876543210', 'asha@example.com', 'growth',
            E'Ten tables.\nOpen till late.')$$,
  'names are tidied, the email lower-cased, the message keeps its lines'
);

select lives_ok(
  $$select public.site_create_lead('{"name": "Ravi", "restaurant_name": "Chai Point", "city": "Agra",
      "phone": "9000000001", "plan_code": "platinum", "message": "   "}')$$,
  'email, message and the network are optional'
);
select results_eq(
  $$select email, plan_code, message, ip_hash from public.site_leads where phone = '9000000001'$$,
  $$values (null::text, null::text, null::text, null::text)$$,
  'an unknown plan and a blank message are dropped'
);

-- Where the lead came from (docs/DECISIONS.md W-13).
select lives_ok(
  $$select public.site_create_lead('{"name": "Meena", "restaurant_name": "Dosa Corner",
      "city": "Chennai", "phone": "9000000003", "source": {"utm_source": " google ",
      "utm_medium": "cpc", "referrer": "google.com", "gclid": "x1", "utm_campaign": 7}}')$$,
  'a lead can say where it came from'
);
select is(
  (select source from public.site_leads where phone = '9000000003'),
  '{"utm_source": "google", "utm_medium": "cpc", "referrer": "google.com"}'::jsonb,
  'only the known campaign tags and the referrer are kept, tidied'
);
select lives_ok(
  $$select public.site_create_lead('{"name": "Meena", "restaurant_name": "Dosa Corner",
      "city": "Chennai", "phone": "9000000004", "source": {"utm_source": "   ", "x": "y"}}')$$,
  'a lead with nothing usable in its source'
);
select results_eq(
  $$select source from public.site_leads where phone in ('9876543210', '9000000004')$$,
  $$values (null::jsonb), (null::jsonb)$$,
  'has no source, like a lead without one'
);

select throws_ok(
  $$select public.site_create_lead('{"name": "Ravi", "restaurant_name": "Chai Point", "city": "Agra",
      "phone": "+91 90000 00002"}')$$,
  'P0001', 'INVALID_INPUT', 'the phone must be ten digits'
);
select throws_ok(
  $$select public.site_create_lead('{"name": "", "restaurant_name": "Chai Point", "city": "Agra",
      "phone": "9000000002"}')$$,
  'P0001', 'INVALID_INPUT', 'a name is required'
);
select throws_ok(
  $$select public.site_create_lead('{"name": "Ravi", "restaurant_name": "Chai Point", "city": "Agra",
      "phone": "9000000002", "email": "not-an-email"}')$$,
  'P0001', 'INVALID_INPUT', 'a malformed email is refused'
);
select throws_ok(
  format($$select public.site_create_lead('{"name": "Ravi", "restaurant_name": "Chai Point",
      "city": "Agra", "phone": "9000000002", "message": %s}')$$, to_json(repeat('x', 1001))),
  'P0001', 'INVALID_INPUT', 'a message over 1000 characters is refused'
);
select throws_ok(
  $$select public.site_create_lead('{"name": "Ravi", "restaurant_name": "Chai Point", "city": "Agra",
      "phone": "9000000002", "budget": "high"}')$$,
  'P0001', 'INVALID_INPUT', 'unknown fields are refused'
);
select throws_ok(
  $$select public.site_create_lead('[]')$$,
  'P0001', 'INVALID_INPUT', 'the lead must be an object'
);

-- ─── Rate limits ────────────────────────────────────────────────────────────
-- One network: the first lead above plus four more, then refused.
select is(
  (select count(public.site_create_lead(
     format('{"name": "N", "restaurant_name": "R", "city": "C", "phone": "91111111%s"}', n)::jsonb,
     :ip)) from generate_series(10, 13) as n),
  4::bigint, 'four more leads from one network'
);
select throws_ok(
  format($$select public.site_create_lead('{"name": "N", "restaurant_name": "R", "city": "C",
      "phone": "9111111199"}', %L)$$, :ip),
  'P0001', 'RATE_LIMITED', 'a sixth lead in an hour from one network is refused'
);
update public.site_leads set created_at = now() - interval '61 minutes' where ip_hash = :ip;
select lives_ok(
  format($$select public.site_create_lead('{"name": "N", "restaurant_name": "R", "city": "C",
      "phone": "9111111199"}', %L)$$, :ip),
  'the network can send again after an hour'
);

-- One phone: three a day from anywhere.
select is(
  (select count(public.site_create_lead('{"name": "P", "restaurant_name": "R", "city": "C", "phone": "9222222222"}'))
   from generate_series(1, 3)),
  3::bigint, 'three leads for one phone'
);
select throws_ok(
  $$select public.site_create_lead('{"name": "P", "restaurant_name": "R", "city": "C", "phone": "9222222222"}')$$,
  'P0001', 'RATE_LIMITED', 'a fourth lead in a day for one phone is refused'
);

-- ─── Reading ────────────────────────────────────────────────────────────────
select tests.clear_auth();
select tests.authenticate_as_platform_admin(:'admin');
select ok(
  (select count(*) from public.site_leads) >= 10,
  'platform admins read every lead'
);
select throws_ok(
  $$insert into public.site_leads (name, restaurant_name, city, phone) values ('X', 'Y', 'Z', '9333333333')$$,
  '42501', null,
  'platform admins cannot write leads directly'
);

select tests.authenticate_as_platform_admin(:'admin', 'aal1');
select is((select count(*) from public.site_leads), 0::bigint, 'password only: no leads');

select tests.authenticate_as(:'owner');
select is((select count(*) from public.site_leads), 0::bigint, 'restaurant owners see no leads');

select tests.as_anon();
select throws_ok($$select * from public.site_leads$$, '42501', null, 'visitors cannot read leads');
select throws_ok(
  $$select public.site_create_lead('{"name": "N", "restaurant_name": "R", "city": "C", "phone": "9444444444"}')$$,
  '42501', null, 'visitors cannot call the function directly'
);

select tests.clear_auth();
select * from finish();
rollback;
