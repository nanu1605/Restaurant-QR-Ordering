-- The MenuMesh orange is the default accent (docs/DECISIONS.md B-1).
begin;

create extension if not exists pgtap with schema extensions;

select plan(2);

select col_default_is(
  'public', 'restaurants', 'accent_color', '#FF6606',
  'new restaurants start on the MenuMesh orange'
);

select tests.create_restaurant('accent-rest') as rest \gset
select is(
  (select accent_color from public.restaurants where id = :'rest'),
  '#FF6606',
  'a created restaurant gets it'
);

select * from finish();
rollback;
