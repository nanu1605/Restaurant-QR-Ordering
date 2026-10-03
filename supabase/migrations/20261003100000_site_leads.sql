-- "Book a demo" requests from the public website (spec §24 W2,
-- docs/DECISIONS.md W-6). The website's server action writes them through
-- site_create_lead() after a Cloudflare Turnstile check; platform admins read
-- them in /super/leads. Visitors never touch the table.
--
-- Errors: INVALID_INPUT (a field is missing, too long or malformed),
-- RATE_LIMITED (5 an hour from one network, 3 a day for one phone number).

create table public.site_leads (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 80),
  restaurant_name text not null check (length(restaurant_name) between 1 and 120),
  city text not null check (length(city) between 1 and 60),
  -- Ten digits, without +91 or a leading 0.
  phone text not null check (phone ~ '^[0-9]{10}$'),
  email text check (length(email) between 3 and 254 and email ~ '^[^@\s]+@[^@\s]+$'),
  -- The plan the visitor came from on /pricing, if it still exists.
  plan_code text,
  message text check (length(message) between 1 and 1000),
  -- HMAC of the visitor's IP address, for the rate limit only.
  ip_hash text check (ip_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

create index site_leads_created_idx on public.site_leads (created_at desc);
create index site_leads_ip_created_idx on public.site_leads (ip_hash, created_at)
  where ip_hash is not null;
create index site_leads_phone_created_idx on public.site_leads (phone, created_at);

alter table public.site_leads enable row level security;
revoke all on public.site_leads from anon, authenticated;
grant select on public.site_leads to authenticated;
create policy "platform admins read site leads" on public.site_leads
  for select to authenticated using ((select public.is_platform_admin()));

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
    array['name', 'restaurant_name', 'city', 'phone', 'email', 'plan_code', 'message']
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

  insert into public.site_leads (name, restaurant_name, city, phone, email, plan_code, message, ip_hash)
  values (
    private.tidy_text(private.json_text(v_lead, 'name')),
    private.tidy_text(private.json_text(v_lead, 'restaurant_name')),
    private.tidy_text(private.json_text(v_lead, 'city')),
    v_phone,
    private.tidy_text(lower(private.json_text(v_lead, 'email'))),
    (select p.code from public.plans p where p.code = private.json_text(v_lead, 'plan_code')),
    nullif(btrim(private.json_text(v_lead, 'message')), ''),
    p_ip_hash
  )
  returning id into v_id;
  return v_id;
exception
  when check_violation or not_null_violation then
    perform private.fail('INVALID_INPUT');
end;
$$;

revoke execute on function public.site_create_lead(jsonb, text) from public, anon, authenticated;
grant execute on function public.site_create_lead(jsonb, text) to service_role;
