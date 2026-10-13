-- One free trial per restaurant, and the storefront photo (spec §8.2, §24 W3;
-- docs/DECISIONS.md P11-10 to P11-14): a self-signup is refused when its
-- licence, mobile or GSTIN already has a restaurant or a trial, however the
-- mobile is typed and whatever Settings says now; the platform admin's own
-- onboarding isn't; lookalikes are for the platform admin only; the photos'
-- bucket is private and unused photos are cleaned up.
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

\set fssai_chain '''20000000000001'''
\set fssai_self '''20000000000002'''
\set gstin_chain '''27ABCDE1234F1Z5'''
\set photo '''signups/00000000-0000-4000-8000-000000000001.jpg'''

select tests.create_restaurant('chain-one') as chain \gset
update public.restaurants
set fssai_license = :fssai_chain, gstin = :gstin_chain, phone = '+91 70000 00001'
where id = :'chain';
select tests.create_user('self-one@identity.test') as self_one \gset
select tests.create_user('self-two@identity.test') as self_two \gset
select tests.create_user('wizard@identity.test') as wizard_owner \gset
select tests.create_platform_admin('admin@identity.test') as admin \gset

-- ─── Grants ─────────────────────────────────────────────────────────────────
select ok(
  has_function_privilege('service_role', 'public.site_signup_identity_taken(text, text, text)', 'execute')
    and has_function_privilege('service_role', 'public.site_signup_create_restaurant(jsonb)', 'execute')
    and has_function_privilege('service_role', 'public.storefront_photos_to_remove(int)', 'execute'),
  'the server checks identities, creates self-signups and finds unused photos'
);
select ok(
  not has_function_privilege('anon', 'public.site_signup_identity_taken(text, text, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.site_signup_identity_taken(text, text, text)', 'execute')
    and not has_function_privilege('anon', 'public.site_signup_create_restaurant(jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.site_signup_create_restaurant(jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.storefront_photos_to_remove(int)', 'execute')
    and not has_function_privilege('anon', 'public.platform_restaurant_lookalikes(uuid[])', 'execute'),
  'nobody else can, and visitors can''t look for lookalikes'
);
select tests.authenticate_as(:'self_one');
select throws_ok($$select * from public.trial_claims$$, '42501', null, 'signed-in users cannot read trial claims');
select tests.clear_auth();

-- ─── Mobiles ────────────────────────────────────────────────────────────────
select is(
  array[private.phone10('+91 98765-43210'), private.phone10('09876543210'), private.phone10('9876543210')],
  array['9876543210', '9876543210', '9876543210'],
  'a mobile is its last ten digits, however it was typed'
);
select is(private.phone10('12345'), null, 'too few digits is no mobile');

-- ─── Already has an account ─────────────────────────────────────────────────
select tests.as_service_role();
select ok(public.site_signup_identity_taken(:fssai_chain, '9000000009'), 'the same licence is taken');
select ok(public.site_signup_identity_taken('20000000000099', '07000000001'), 'so is the same mobile, typed differently');
select ok(
  public.site_signup_identity_taken('20000000000099', '9000000009', lower(:gstin_chain)),
  'and the same GSTIN, in any case'
);
select ok(
  not public.site_signup_identity_taken('20000000000099', '9000000009', null),
  'new values are free, and a missing GSTIN matches nothing'
);

-- ─── Self-signups ───────────────────────────────────────────────────────────
create temporary table payloads (name text primary key, payload jsonb) on commit drop;
grant all on payloads to service_role;
insert into payloads values
  ('one', jsonb_build_object(
    'name', 'Self One', 'slug', 'self-one', 'city', 'Indore', 'address_line', '12 MG Road',
    'pincode', '452001', 'phone', '+91 71111 11111', 'fssai_license', :fssai_self,
    'storefront_photo_path', :photo,
    'owner', jsonb_build_object('user_id', :'self_one', 'display_name', 'Asha', 'username', 'owner')
  ));

select throws_ok(
  $$select public.site_signup_create_restaurant((select payload - 'storefront_photo_path' from payloads where name = 'one'))$$,
  'P0001', 'INVALID_INPUT', 'a self-signup needs its photo'
);
select throws_ok(
  $$select public.site_signup_create_restaurant((select payload - 'fssai_license' from payloads where name = 'one'))$$,
  'P0001', 'INVALID_INPUT', 'and its licence'
);
select throws_ok(
  $$select public.site_signup_create_restaurant((select payload || '{"storefront_photo_path": "../x.jpg"}' from payloads where name = 'one'))$$,
  'P0001', 'INVALID_INPUT', 'a photo outside the signups folder is refused'
);

select public.site_signup_create_restaurant((select payload from payloads where name = 'one')) as created \gset
select results_eq(
  format(
    $$select fssai_license, gstin, storefront_photo_path, address_line, pincode from public.restaurants where id = %L$$,
    (:'created'::jsonb) ->> 'restaurant_id'
  ),
  format($$values (%L, null::text, %L, '12 MG Road', '452001')$$, :fssai_self, :photo),
  'the restaurant keeps its licence, address and photo'
);
select results_eq(
  format($$select kind, value from public.trial_claims where restaurant_id = %L order by kind$$,
    (:'created'::jsonb) ->> 'restaurant_id'),
  format($$values ('fssai', %L), ('phone', '7111111111')$$, :fssai_self),
  'and its trial is claimed for the licence and the mobile'
);
select is(
  (select actor_type::text from public.audit_logs
   where restaurant_id = ((:'created'::jsonb) ->> 'restaurant_id')::uuid and action = 'restaurant.created'),
  'system',
  'the website made it, not a platform admin'
);

update payloads set payload = payload || jsonb_build_object(
  'slug', 'self-two', 'phone', '9000000009',
  'owner', jsonb_build_object('user_id', :'self_two', 'display_name', 'Ravi', 'username', 'owner')
) where name = 'one';
select throws_ok(
  $$select public.site_signup_create_restaurant((select payload from payloads where name = 'one'))$$,
  'P0001', 'RESTAURANT_EXISTS', 'a second trial with the same licence is refused'
);
select throws_ok(
  $$select public.site_signup_create_restaurant((select payload || '{"fssai_license": "20000000000003", "phone": "07111111111"}' from payloads where name = 'one'))$$,
  'P0001', 'RESTAURANT_EXISTS', 'so is one with the same mobile, typed differently'
);
select throws_ok(
  format(
    $$select public.site_signup_create_restaurant((select payload || %L from payloads where name = 'one'))$$,
    jsonb_build_object('fssai_license', '20000000000003', 'gstin', :gstin_chain)
  ),
  'P0001', 'RESTAURANT_EXISTS', 'and one with the GSTIN of a restaurant the platform onboarded'
);

-- Settings can change the licence; the claim stays.
select tests.clear_auth();
update public.restaurants set fssai_license = '20000000000077', phone = null
where id = ((:'created'::jsonb) ->> 'restaurant_id')::uuid;
select tests.as_service_role();
select throws_ok(
  $$select public.site_signup_create_restaurant((select payload from payloads where name = 'one'))$$,
  'P0001', 'RESTAURANT_EXISTS', 'editing Settings doesn''t free a licence for another trial'
);
select ok(
  public.site_signup_identity_taken(:fssai_self, '9000000009'),
  'the claim still counts at the first step'
);
select throws_ok(
  format($$insert into public.trial_claims (kind, value, restaurant_id) values ('fssai', %L, %L)$$,
    :fssai_self, :'chain'),
  '23505', null, 'a licence can be claimed once'
);

select lives_ok(
  $$select public.site_signup_create_restaurant((select payload || '{"fssai_license": "20000000000004"}' from payloads where name = 'one'))$$,
  'a different restaurant still gets its trial'
);

-- The platform admin's own onboarding is never refused: branches can share a GSTIN or mobile.
select lives_ok(
  format(
    $$select public.platform_create_restaurant(%L)$$,
    jsonb_build_object('name', 'Chain Two', 'slug', 'chain-two', 'phone', '+91 70000 00001',
      'owner', jsonb_build_object('user_id', :'wizard_owner', 'display_name', 'Meera', 'username', 'owner'))
  ),
  'the platform admin can onboard a branch with the same mobile'
);
select is(
  (select count(*)::int from public.trial_claims c join public.restaurants r on r.id = c.restaurant_id
   where r.slug = 'chain-two'),
  0,
  'and that claims no trial'
);

-- ─── Lookalikes ─────────────────────────────────────────────────────────────
select tests.clear_auth();
select tests.create_restaurant('look-a') as look_a \gset
select tests.create_restaurant('look-b') as look_b \gset
select tests.create_restaurant('look-c') as look_c \gset
select tests.create_restaurant('look-d') as look_d \gset
update public.restaurants set name = 'Zubeida Biryani House', address_line = 'Shop 4, Khajrana Main Road',
  pincode = '452016', fssai_license = '20000000000010' where id = :'look_a';
update public.restaurants set name = 'Zubeida Biryani House ', pincode = '452017' where id = :'look_b';
update public.restaurants set name = 'Quite Different Cafe', pincode = '452016' where id = :'look_c';
update public.restaurants set name = 'Another Place', address_line = 'Shop 4 Khajrana Main Road',
  fssai_license = '20000000000010' where id = :'look_d';

select tests.authenticate_as_platform_admin(:'admin');
select public.platform_restaurant_lookalikes(array[:'look_a'::uuid]) -> :'look_a' as looks \gset
select results_eq(
  format(
    $$select r ->> 'slug', r -> 'reasons' from jsonb_array_elements(%L::jsonb) r
      where r ->> 'slug' in ('look-b', 'look-c', 'look-d')$$,
    :'looks'
  ),
  $$values ('look-d', '["fssai", "address"]'::jsonb), ('look-b', '["name"]'::jsonb), ('look-c', '["pincode"]'::jsonb)$$,
  'lookalikes come with their reasons, strongest first'
);
select ok(
  jsonb_array_length(:'looks'::jsonb) <= 10,
  'at most ten'
);
select is(
  public.platform_restaurant_lookalikes(array[]::uuid[]),
  '{}'::jsonb,
  'no restaurants, no lookalikes'
);
select throws_ok(
  $$select public.platform_restaurant_lookalikes(array_fill(gen_random_uuid(), array[101]))$$,
  'P0001', 'INVALID_INPUT', 'a hundred restaurants at a time'
);
select tests.authenticate_as_platform_admin(:'admin', 'aal1');
select throws_ok(
  format($$select public.platform_restaurant_lookalikes(array[%L::uuid])$$, :'look_a'),
  'P0001', 'MFA_REQUIRED', 'the platform admin needs the second factor'
);
select tests.authenticate_as(:'self_one');
select throws_ok(
  format($$select public.platform_restaurant_lookalikes(array[%L::uuid])$$, :'look_a'),
  'P0001', 'FORBIDDEN', 'an owner can''t see them'
);
select tests.clear_auth();

-- ─── Photos ─────────────────────────────────────────────────────────────────
select results_eq(
  $$select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'storefront-photos'$$,
  $$values (false, 2097152::bigint, array['image/jpeg'])$$,
  'the photos'' bucket is private and takes JPEGs of up to 2 MB'
);
select is_empty(
  $$select 1 from pg_policies where schemaname = 'storage'
    and (qual like '%storefront-photos%' or with_check like '%storefront-photos%')$$,
  'no storage policy opens it: only the server reads and writes'
);

insert into storage.objects (bucket_id, name, created_at) values
  ('storefront-photos', 'signups/00000000-0000-4000-8000-0000000000a1.jpg', now() - interval '8 days'),
  ('storefront-photos', :photo, now() - interval '8 days'),
  ('storefront-photos', 'signups/00000000-0000-4000-8000-0000000000a2.jpg', now() - interval '1 day');
select tests.as_service_role();
select results_eq(
  $$select p from public.storefront_photos_to_remove() p
    where starts_with(p, 'signups/00000000-0000-4000-8000-0000000000')$$,
  $$values ('signups/00000000-0000-4000-8000-0000000000a1.jpg')$$,
  'a week-old photo no restaurant uses is cleaned up; a used or recent one isn''t'
);

select * from finish();
rollback;
