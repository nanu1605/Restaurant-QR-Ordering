-- Where a demo request or a self-serve signup came from (docs/DECISIONS.md W-13): the
-- campaign tags of the link the visitor landed on and the site that sent them. Kept with
-- the lead, and on the restaurant once a signup finishes (signups are purged after 7 days).

-- Only the known keys, as short tidy strings; null when nothing is left.
create or replace function private.site_source(p_source jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select nullif(
    coalesce(
      (select jsonb_object_agg(e.key, left(private.tidy_text(e.value #>> '{}'), 100))
       from jsonb_each(case when jsonb_typeof(p_source) = 'object' then p_source end) as e
       where e.key in ('utm_source', 'utm_medium', 'utm_campaign', 'referrer')
         and jsonb_typeof(e.value) = 'string'
         and private.tidy_text(e.value #>> '{}') is not null),
      '{}'::jsonb
    ),
    '{}'::jsonb
  );
$$;

revoke execute on function private.site_source(jsonb) from public, anon, authenticated;

alter table public.site_leads
  add column source jsonb check (source is null or jsonb_typeof(source) = 'object');

alter table public.restaurants
  add column signup_source jsonb check (signup_source is null or jsonb_typeof(signup_source) = 'object');

create or replace function public.site_create_lead(p_lead jsonb, p_ip_hash text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_lead jsonb := coalesce(p_lead, '{}'::jsonb);
  v_phone text;
  v_id uuid;
begin
  perform private.assert_keys(
    v_lead,
    array['name', 'restaurant_name', 'city', 'phone', 'email', 'plan_code', 'message', 'source']
  );
  v_phone := private.json_text(v_lead, 'phone');

  -- One request at a time per phone and per network, so concurrent requests
  -- can't all pass the counts below (always phone first, then network).
  perform pg_advisory_xact_lock(hashtextextended('site_lead:phone:' || coalesce(v_phone, ''), 0));
  if p_ip_hash is not null then
    perform pg_advisory_xact_lock(hashtextextended('site_lead:ip:' || p_ip_hash, 0));
  end if;

  if p_ip_hash is not null
     and (select count(*) from public.site_leads l
          where l.ip_hash = p_ip_hash and l.created_at > now() - interval '1 hour') >= 5 then
    perform private.fail('RATE_LIMITED');
  end if;
  if (select count(*) from public.site_leads l
      where l.phone = v_phone and l.created_at > now() - interval '1 day') >= 3 then
    perform private.fail('RATE_LIMITED');
  end if;

  insert into public.site_leads (
    name, restaurant_name, city, phone, email, plan_code, message, ip_hash, source
  )
  values (
    private.tidy_text(private.json_text(v_lead, 'name')),
    private.tidy_text(private.json_text(v_lead, 'restaurant_name')),
    private.tidy_text(private.json_text(v_lead, 'city')),
    v_phone,
    private.tidy_text(lower(private.json_text(v_lead, 'email'))),
    (select p.code from public.plans p where p.code = private.json_text(v_lead, 'plan_code')),
    nullif(btrim(private.json_text(v_lead, 'message')), ''),
    p_ip_hash,
    private.site_source(v_lead -> 'source')
  )
  returning id into v_id;
  return v_id;
exception
  when check_violation or not_null_violation then
    perform private.fail('INVALID_INPUT');
end;
$$;

-- Marks a signup finished once its restaurant exists (its code then stops working) and
-- keeps where the signup came from on that restaurant. The restaurant is optional while builds
-- from before this migration may still finish signups (7 days; RUNBOOK "Database migrations").
drop function public.site_signup_finish(uuid);
create function public.site_signup_finish(p_id uuid, p_restaurant_id uuid default null)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.restaurants r
  set signup_source = private.site_source(s.details -> 'source')
  from public.site_signups s
  where s.id = p_id and s.verified_at is null and r.id = p_restaurant_id;
  update public.site_signups s set verified_at = now() where s.id = p_id and s.verified_at is null;
$$;

revoke execute on function public.site_signup_finish(uuid, uuid) from public, anon, authenticated;
grant execute on function public.site_signup_finish(uuid, uuid) to service_role;
