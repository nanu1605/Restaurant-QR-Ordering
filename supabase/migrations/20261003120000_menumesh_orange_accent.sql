-- The MenuMesh orange becomes the default accent (docs/DECISIONS.md B-1).
-- New restaurants start with it; restaurants still on the old indigo default
-- (never changed in Settings, which saves the colour lowercased) move with it.
-- Restaurants that picked their own colour keep it.

alter table public.restaurants alter column accent_color set default '#FF6606';

update public.restaurants
set accent_color = '#FF6606'
where lower(accent_color) = '#3b4ba8';
