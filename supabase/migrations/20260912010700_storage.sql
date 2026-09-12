-- Storage buckets for menu images and restaurant logos (spec §9.1).
-- Public read; managers/owners write only inside their own "<restaurant_id>/" folder.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('menu-images', 'menu-images', true, 1048576, array['image/webp', 'image/jpeg', 'image/png']),
  ('logos', 'logos', true, 1048576, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

create policy "managers read their restaurant images" on storage.objects
  for select to authenticated
  using (
    bucket_id in ('menu-images', 'logos')
    and (storage.foldername(name))[1] in (
      select r::text from private.my_restaurant_ids('{owner,manager}') as r
    )
  );

create policy "managers upload their restaurant images" on storage.objects
  for insert to authenticated
  with check (
    bucket_id in ('menu-images', 'logos')
    and (storage.foldername(name))[1] in (
      select r::text from private.my_restaurant_ids('{owner,manager}') as r
    )
  );

create policy "managers replace their restaurant images" on storage.objects
  for update to authenticated
  using (
    bucket_id in ('menu-images', 'logos')
    and (storage.foldername(name))[1] in (
      select r::text from private.my_restaurant_ids('{owner,manager}') as r
    )
  )
  with check (
    bucket_id in ('menu-images', 'logos')
    and (storage.foldername(name))[1] in (
      select r::text from private.my_restaurant_ids('{owner,manager}') as r
    )
  );

create policy "managers delete their restaurant images" on storage.objects
  for delete to authenticated
  using (
    bucket_id in ('menu-images', 'logos')
    and (storage.foldername(name))[1] in (
      select r::text from private.my_restaurant_ids('{owner,manager}') as r
    )
  );
