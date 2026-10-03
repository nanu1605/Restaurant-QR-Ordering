-- Self-serve signups from the public website (spec §24 W3,
-- docs/DECISIONS.md W-9). /signup stores the visitor's details with a
-- hashed 6-digit code emailed to them; /signup/verify checks the code, then
-- the server creates the restaurant with onboardRestaurant() and marks the
-- signup finished. Service role only: visitors never touch the table, and
-- nobody else reads it.
--
-- Errors: INVALID_INPUT (malformed email, code hash or details),
-- RATE_LIMITED (3 signups an hour for one email, 10 a day from one network,
-- 3 codes per signup), NOT_FOUND (no open signup to send a new code for).

create table public.site_signups (
  id uuid primary key default gen_random_uuid(),
  email text not null check (length(email) between 3 and 254 and email ~ '^[^@\s]+@[^@\s]+$'),
  -- What the visitor typed on /signup; checked again when the restaurant is created.
  details jsonb not null check (jsonb_typeof(details) = 'object'),
  -- HMAC of the latest code, never the code itself.
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  -- HMAC of the visitor's IP address, for the rate limit only.
  ip_hash text check (ip_hash ~ '^[0-9a-f]{64}$'),
  tries smallint not null default 0,
  -- Codes sent for this signup, the first included.
  sends smallint not null default 1,
  expires_at timestamptz not null default now() + interval '15 minutes',
  -- Set once the restaurant exists.
  verified_at timestamptz,
  created_at timestamptz not null default now()
);

create index site_signups_created_idx on public.site_signups (created_at);
create index site_signups_email_created_idx on public.site_signups (email, created_at);
create index site_signups_ip_created_idx on public.site_signups (ip_hash, created_at)
  where ip_hash is not null;

alter table public.site_signups enable row level security;
revoke all on public.site_signups from anon, authenticated;

-- Signups hold personal details: none is kept longer than a week. Run by the
-- daily cron, and by every new signup. Returns how many were deleted.
create or replace function public.site_signups_cleanup()
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with gone as (
    delete from public.site_signups s where s.created_at < now() - interval '7 days' returning 1
  )
  select count(*)::integer from gone;
$$;

-- Stores a signup and its first code; returns its id.
create or replace function public.site_signup_start(
  p_email text,
  p_details jsonb,
  p_code_hash text,
  p_ip_hash text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_id uuid;
begin
  -- One signup at a time per email and per network, so concurrent requests
  -- can't all pass the counts below (always email first, then network).
  perform pg_advisory_xact_lock(hashtextextended('site_signup:email:' || v_email, 0));
  if p_ip_hash is not null then
    perform pg_advisory_xact_lock(hashtextextended('site_signup:ip:' || p_ip_hash, 0));
  end if;

  perform public.site_signups_cleanup();

  if (select count(*) from public.site_signups s
      where s.email = v_email and s.created_at > now() - interval '1 hour') >= 3 then
    perform private.fail('RATE_LIMITED');
  end if;
  if p_ip_hash is not null
     and (select count(*) from public.site_signups s
          where s.ip_hash = p_ip_hash and s.created_at > now() - interval '1 day') >= 10 then
    perform private.fail('RATE_LIMITED');
  end if;

  insert into public.site_signups (email, details, code_hash, ip_hash)
  values (v_email, p_details, p_code_hash, p_ip_hash)
  returning id into v_id;
  return v_id;
exception
  when check_violation or not_null_violation then
    perform private.fail('INVALID_INPUT');
end;
$$;

-- A new code for an open signup: replaces the old one, with fresh tries and
-- 15 minutes. At most 3 codes per signup, within an hour of starting it, so
-- one bot check can't keep sending email. Returns the address to send to.
create or replace function public.site_signup_resend(p_id uuid, p_code_hash text)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_signup public.site_signups;
begin
  select * into v_signup from public.site_signups s where s.id = p_id for update;
  if not found or v_signup.verified_at is not null
     or v_signup.created_at <= now() - interval '1 hour' then
    perform private.fail('NOT_FOUND');
  end if;
  if v_signup.sends >= 3 then
    perform private.fail('RATE_LIMITED');
  end if;

  update public.site_signups s
  set code_hash = p_code_hash,
      tries = 0,
      sends = s.sends + 1,
      expires_at = now() + interval '15 minutes'
  where s.id = p_id;
  return v_signup.email;
exception
  when check_violation then
    perform private.fail('INVALID_INPUT');
end;
$$;

-- Checks a code. Never raises for a wrong code, so the try counts:
-- {status: ok, email, details} for the right code (until the signup is
-- finished); wrong (with tries_left), expired, locked (5 wrong tries) or
-- gone (unknown or finished). The right code doesn't use the signup up, so
-- a failure while creating the restaurant can be tried again.
create or replace function public.site_signup_verify(p_id uuid, p_code_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_signup public.site_signups;
begin
  select * into v_signup from public.site_signups s where s.id = p_id for update;
  if not found or v_signup.verified_at is not null then
    return jsonb_build_object('status', 'gone');
  end if;
  if v_signup.tries >= 5 then
    return jsonb_build_object('status', 'locked');
  end if;
  if v_signup.expires_at <= now() then
    return jsonb_build_object('status', 'expired');
  end if;

  if v_signup.code_hash is distinct from p_code_hash then
    update public.site_signups s set tries = s.tries + 1 where s.id = p_id;
    if v_signup.tries + 1 >= 5 then
      return jsonb_build_object('status', 'locked');
    end if;
    return jsonb_build_object('status', 'wrong', 'tries_left', 4 - v_signup.tries);
  end if;

  return jsonb_build_object('status', 'ok', 'email', v_signup.email, 'details', v_signup.details);
end;
$$;

-- Marks a signup finished once its restaurant exists; its code then stops working.
create or replace function public.site_signup_finish(p_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.site_signups s set verified_at = now() where s.id = p_id and s.verified_at is null;
$$;

revoke execute on function public.site_signups_cleanup() from public, anon, authenticated;
revoke execute on function public.site_signup_start(text, jsonb, text, text) from public, anon, authenticated;
revoke execute on function public.site_signup_resend(uuid, text) from public, anon, authenticated;
revoke execute on function public.site_signup_verify(uuid, text) from public, anon, authenticated;
revoke execute on function public.site_signup_finish(uuid) from public, anon, authenticated;
grant execute on function public.site_signups_cleanup() to service_role;
grant execute on function public.site_signup_start(text, jsonb, text, text) to service_role;
grant execute on function public.site_signup_resend(uuid, text) to service_role;
grant execute on function public.site_signup_verify(uuid, text) to service_role;
grant execute on function public.site_signup_finish(uuid) to service_role;
