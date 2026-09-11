-- Lightweight database round trip used by /api/health.
-- Callable only with the secret (service role) key.

create or replace function public.health_check()
returns text
language sql
stable
set search_path = ''
as $$
  select 'ok'::text;
$$;

revoke execute on function public.health_check() from public, anon, authenticated;
grant execute on function public.health_check() to service_role;
