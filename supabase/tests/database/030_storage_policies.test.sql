-- Storage write policies: managers/owners only, inside their own restaurant folder (spec §9.1).
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

select tests.create_restaurant('alpha') as rest_a \gset
select tests.create_restaurant('bravo') as rest_b \gset
select tests.add_member(:'rest_a', 'manager', 'a_manager') as a_manager \gset
select tests.add_member(:'rest_a', 'waiter', 'a_waiter') as a_waiter \gset

select results_eq(
  $$ select id, public from storage.buckets where id in ('menu-images', 'logos') order by id $$,
  $$ values ('logos'::text, true), ('menu-images'::text, true) $$,
  'menu-images and logos buckets exist and are public-read'
);

select tests.authenticate_as(:'a_manager');

select lives_ok(
  format(
    $f$insert into storage.objects (bucket_id, name) values ('menu-images', %L)$f$,
    :'rest_a' || '/item.webp'
  ),
  'manager uploads a menu image into their folder'
);
select lives_ok(
  format(
    $f$insert into storage.objects (bucket_id, name) values ('logos', %L)$f$,
    :'rest_a' || '/logo.webp'
  ),
  'manager uploads a logo into their folder'
);
select throws_ok(
  format(
    $f$insert into storage.objects (bucket_id, name) values ('menu-images', %L)$f$,
    :'rest_b' || '/item.webp'
  ),
  '42501',
  null,
  'manager cannot upload into another restaurant''s folder'
);
select throws_ok(
  $$ insert into storage.objects (bucket_id, name) values ('menu-images', 'loose.webp') $$,
  '42501',
  null,
  'manager cannot upload to the bucket root'
);

select tests.authenticate_as(:'a_waiter');
select throws_ok(
  format(
    $f$insert into storage.objects (bucket_id, name) values ('menu-images', %L)$f$,
    :'rest_a' || '/waiter.webp'
  ),
  '42501',
  null,
  'waiter cannot upload menu images'
);
select tests.clear_auth();

-- Storage blocks direct SQL deletes (storage.protect_delete), so the delete
-- policy is exercised through the Storage API in E2E; here we pin its shape.
select policy_cmd_is(
  'storage', 'objects', 'managers delete their restaurant images', 'delete',
  'delete policy exists for restaurant images'
);
select policy_roles_are(
  'storage', 'objects', 'managers delete their restaurant images', array['authenticated'],
  'delete policy applies to signed-in users only'
);

-- Menu import photos (docs/DECISIONS.md P7-14): private, and signed-in users
-- get no policy at all; the server signs uploads and reads the files.
select is(
  (select public from storage.buckets where id = 'menu-imports'),
  false,
  'the menu-imports bucket is private'
);
select is(
  (select allowed_mime_types from storage.buckets where id = 'menu-imports'),
  array['image/jpeg'],
  'the menu-imports bucket takes JPEG pages only'
);
select is_empty(
  $$
    select policyname from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and (qual like '%menu-imports%' or with_check like '%menu-imports%')
  $$,
  'no storage policy mentions the menu-imports bucket'
);
select tests.authenticate_as(:'a_manager');
select throws_ok(
  format(
    $f$insert into storage.objects (bucket_id, name) values ('menu-imports', %L)$f$,
    :'rest_a' || '/import/page-1.jpg'
  ),
  '42501',
  null,
  'a manager cannot upload import pages directly'
);
select is(
  (select count(*) from storage.objects where bucket_id = 'menu-imports'),
  0::bigint,
  'signed-in users cannot list import pages'
);
select tests.clear_auth();

select * from finish();

rollback;
