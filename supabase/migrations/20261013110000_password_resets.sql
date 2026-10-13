-- "Forgot password" on the login page (spec §9.5, docs/DECISIONS.md P11-6 to
-- P11-9). /login/forgot stores a hashed 6-digit code for the email typed
-- there. The server emails the code only when the email belongs to an account
-- with a real address: owners who gave one, and platform admins. Staff
-- logins' made-up addresses never get mail. The code and a new password then
-- set the password through the Admin API. Every request writes a row, account
-- or not, so neither the answers nor the limits tell whether an email has an
-- account. Service role only: visitors never touch the table.
--
-- Errors: INVALID_INPUT (malformed email or hash), RATE_LIMITED (3 requests an
-- hour for one email, 10 a day from one network).

create table public.password_resets (
  id uuid primary key default gen_random_uuid(),
  email text not null check (length(email) between 3 and 254 and email ~ '^[^@\s]+@[^@\s]+$'),
  -- The account the code is for; null when no account with a real address uses the email.
  user_id uuid references auth.users (id) on delete cascade,
  -- HMAC of the code, never the code itself.
  code_hash text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  -- HMAC of the visitor's IP address, for the rate limit only.
  ip_hash text check (ip_hash ~ '^[0-9a-f]{64}$'),
  tries smallint not null default 0,
  expires_at timestamptz not null default now() + interval '15 minutes',
  -- Set once the new password is saved; the code then stops working.
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index password_resets_created_idx on public.password_resets (created_at);
create index password_resets_email_created_idx on public.password_resets (email, created_at);
create index password_resets_ip_created_idx on public.password_resets (ip_hash, created_at)
  where ip_hash is not null;
create index password_resets_user_idx on public.password_resets (user_id) where user_id is not null;

alter table public.password_resets enable row level security;
revoke all on public.password_resets from anon, authenticated;

-- Requests are kept a day, as long as the network limit needs them. Run by the
-- daily cron, and by every new request. Returns how many were deleted.
create or replace function public.password_resets_cleanup()
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with gone as (
    delete from public.password_resets r where r.created_at < now() - interval '1 day' returning 1
  )
  select count(*)::integer from gone;
$$;

-- Stores a request and its code. Returns {id, send}: send is true only when
-- the email belongs to an account with a real address, and only the server
-- sees it.
create or replace function public.auth_password_reset_start(
  p_email text,
  p_code_hash text,
  p_ip_hash text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_user uuid;
  v_id uuid;
begin
  -- One request at a time per email and per network, so concurrent requests
  -- can't all pass the counts below (always email first, then network).
  perform pg_advisory_xact_lock(hashtextextended('password_reset:email:' || v_email, 0));
  if p_ip_hash is not null then
    perform pg_advisory_xact_lock(hashtextextended('password_reset:ip:' || p_ip_hash, 0));
  end if;

  perform public.password_resets_cleanup();

  if (select count(*) from public.password_resets r
      where r.email = v_email and r.created_at > now() - interval '1 hour') >= 3 then
    perform private.fail('RATE_LIMITED');
  end if;
  if p_ip_hash is not null
     and (select count(*) from public.password_resets r
          where r.ip_hash = p_ip_hash and r.created_at > now() - interval '1 day') >= 10 then
    perform private.fail('RATE_LIMITED');
  end if;

  -- Staff logins have made-up addresses (username@<code>.staff.<domain>):
  -- their owner or manager resets them instead.
  select u.id into v_user
  from auth.users u
  where lower(u.email) = v_email
    and split_part(u.email, '@', 2) not like '%.staff.%'
    and u.deleted_at is null
    and not u.is_anonymous;

  insert into public.password_resets (email, user_id, code_hash, ip_hash)
  values (v_email, v_user, p_code_hash, p_ip_hash)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'send', v_user is not null);
exception
  when check_violation or not_null_violation then
    perform private.fail('INVALID_INPUT');
end;
$$;

-- Checks a code. Never raises for a wrong code, so the try counts:
-- {status: ok, user_id, email} for the right code (until the password is
-- saved); wrong (with tries_left), expired, locked (5 wrong tries) or gone
-- (unknown or used). A request without an account never matches, so it
-- answers like any wrong code. The right code isn't used up here, so a
-- password the Admin API refuses can be tried again.
create or replace function public.auth_password_reset_verify(p_id uuid, p_code_hash text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_reset public.password_resets;
  v_email text;
begin
  select * into v_reset from public.password_resets r where r.id = p_id for update;
  if not found or v_reset.used_at is not null then
    return jsonb_build_object('status', 'gone');
  end if;
  if v_reset.tries >= 5 then
    return jsonb_build_object('status', 'locked');
  end if;
  if v_reset.expires_at <= now() then
    return jsonb_build_object('status', 'expired');
  end if;

  if v_reset.user_id is null or v_reset.code_hash is distinct from p_code_hash then
    update public.password_resets r set tries = r.tries + 1 where r.id = p_id;
    if v_reset.tries + 1 >= 5 then
      return jsonb_build_object('status', 'locked');
    end if;
    return jsonb_build_object('status', 'wrong', 'tries_left', 4 - v_reset.tries);
  end if;

  select u.email into v_email from auth.users u where u.id = v_reset.user_id;
  return jsonb_build_object('status', 'ok', 'user_id', v_reset.user_id, 'email', v_email);
end;
$$;

-- Marks a request used once the new password is saved, and records it in the
-- audit log of each restaurant the account works in (and the platform's, for a
-- platform admin). A second call does nothing.
create or replace function public.auth_password_reset_finish(p_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  update public.password_resets r
  set used_at = now()
  where r.id = p_id and r.used_at is null and r.user_id is not null
  returning r.user_id into v_user;
  if v_user is null then
    return;
  end if;

  perform private.write_audit(
    m.restaurant_id, 'staff', v_user, m.role, m.display_name,
    'staff.password_reset', 'restaurant_member', m.id, null, null, 'Reset with an emailed code'
  )
  from public.restaurant_members m
  where m.user_id = v_user and m.is_active;

  if exists (select 1 from public.platform_admins a where a.user_id = v_user) then
    perform private.write_audit(
      null, 'platform_admin', v_user, null, 'Platform admin',
      'platform_admin.password_reset', 'platform_admin', v_user, null, null,
      'Reset with an emailed code'
    );
  end if;
end;
$$;

revoke execute on function public.password_resets_cleanup() from public, anon, authenticated;
revoke execute on function public.auth_password_reset_start(text, text, text) from public, anon, authenticated;
revoke execute on function public.auth_password_reset_verify(uuid, text) from public, anon, authenticated;
revoke execute on function public.auth_password_reset_finish(uuid) from public, anon, authenticated;
grant execute on function public.password_resets_cleanup() to service_role;
grant execute on function public.auth_password_reset_start(text, text, text) to service_role;
grant execute on function public.auth_password_reset_verify(uuid, text) to service_role;
grant execute on function public.auth_password_reset_finish(uuid) to service_role;
