-- Restartable jobs: announcement emails (docs/DECISIONS.md VPS-25, VPS-28).
--
-- A run sends what is due in rounds, each listed fresh, so a run cut off leaves the rest due for
-- the next one. A pair (announcement, restaurant) whose email Resend refuses is set aside for 20
-- hours rather than tried by every run; sending it later records it as before and clears that.
-- The minute job takes an announcement once it has started, or once one of its emails went (the
-- owner's answer, 2026-11-08): a restaurant that joins a running announcement's audience is
-- emailed within a minute, and the first day's emails of one starting later that day stay the
-- daily run's, at 03:00. announcement_emails_due stays as it is, for the previous build.

-- ─── Refused emails ─────────────────────────────────────────────────────────
-- Pairs Resend refused (400 or 422: an address it won't take), with its answer, which never holds
-- an address (src/lib/email/resend.ts scrubs them).
create table public.announcement_email_failures (
  announcement_id uuid not null references public.announcements (id) on delete cascade,
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  failed_at timestamptz not null default now(),
  tries int not null default 1 check (tries > 0),
  error text check (char_length(error) <= 300),
  primary key (announcement_id, restaurant_id)
);
create index announcement_email_failures_restaurant_idx
  on public.announcement_email_failures (restaurant_id);

-- Written through the functions below only.
alter table public.announcement_email_failures enable row level security;
revoke all on public.announcement_email_failures from anon, authenticated;

-- ─── The runs (service role: src/features/announcements/email.ts) ───────────
-- Up to p_limit (1 to 500) of the emails due at p_at, in announcement_emails_due's order and to
-- its addresses, without the pairs refused in the 20 hours before p_at. A save and the daily run
-- take every due announcement, as before; the minute job (p_minute_job) only one that has
-- started, or one with an email already sent. The pairs not sent and not set aside are found
-- first (of a list, only its restaurants), and only they are tested for the audience and given
-- addresses: once an announcement's emails went, the minute job reads its sent pairs, not every
-- owner's logins. The steps hold ids, the order's keys and what the addresses need, and the texts
-- join only the emails returned: an announcement copied for each restaurant not yet emailed went
-- to temporary files every minute (review finding S1).
create function public.announcement_emails_next(
  p_at timestamptz default now(),
  p_limit int default 50,
  p_minute_job boolean default false
)
returns table (announcement_id uuid, restaurant_id uuid, title text, body text, recipients text[])
language sql
stable
security definer
set search_path = ''
as $$
  with unsent as materialized (
    select a.id as announcement_id, r.id as restaurant_id
    from public.announcements a
    join public.restaurants r on r.status = 'active'
      and (a.restaurant_ids is null or r.id = any (a.restaurant_ids))
    where private.announcement_email_due(a, p_at)
      and (p_minute_job is not true or a.starts_at <= p_at
        or exists (select 1 from public.announcement_emails s where s.announcement_id = a.id))
      and not exists (
        select 1 from public.announcement_emails s
        where s.announcement_id = a.id and s.restaurant_id = r.id
      )
      and not exists (
        select 1 from public.announcement_email_failures f
        where f.announcement_id = a.id and f.restaurant_id = r.id
          and f.failed_at > p_at - interval '20 hours'
      )
  ), audience as materialized (
    select a.id as announcement_id, a.starts_at, r.id as restaurant_id, r.name, r.slug, r.email
    from unsent p
    join public.announcements a on a.id = p.announcement_id
    join public.restaurants r on r.id = p.restaurant_id
    where private.in_audience(a, r.id)
  )
  select q.announcement_id, q.restaurant_id, a.title, a.body, rcpt.emails
  from audience q
  join public.announcements a on a.id = q.announcement_id
  cross join lateral (
    select array_agg(distinct lower(e.email) order by lower(e.email)) as emails
    from (
      select u.email
      from public.restaurant_members m
      join auth.users u on u.id = m.user_id
      where m.restaurant_id = q.restaurant_id and m.role = 'owner' and m.is_active
        and split_part(u.email, '@', 2) not like q.slug || '.staff.%'
      union all
      select q.email
    ) as e
    where nullif(btrim(e.email), '') is not null
  ) as rcpt
  where rcpt.emails is not null
  order by q.starts_at, q.announcement_id, q.name, q.restaurant_id
  limit least(greatest(coalesce(p_limit, 50), 1), 500);
$$;

-- Resend refused the pair's email: set aside for 20 hours, then tried again. p_error is cut to
-- 300 characters.
create function public.announcement_email_failed(
  p_announcement_id uuid,
  p_restaurant_id uuid,
  p_error text
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.announcement_email_failures as f (announcement_id, restaurant_id, error)
  values (p_announcement_id, p_restaurant_id, left(p_error, 300))
  on conflict (announcement_id, restaurant_id) do update
    set tries = f.tries + 1, failed_at = now(), error = excluded.error;
$$;

-- The pair's email went, or Resend already had it: recorded once, and no longer set aside.
create or replace function public.announcement_email_sent(p_announcement_id uuid, p_restaurant_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.announcement_emails (announcement_id, restaurant_id)
  values (p_announcement_id, p_restaurant_id)
  on conflict do nothing;
  delete from public.announcement_email_failures f
  where f.announcement_id = p_announcement_id and f.restaurant_id = p_restaurant_id;
$$;

-- An email waits for the minute job: what announcement_emails_next gives it now. It is asked only
-- once an email announcement is due (its first test of one), so that until then an idle minute
-- reads the announcements and nothing else.
create function private.announcement_emails_waiting()
returns boolean
language sql
stable
set search_path = ''
as $$
  select case
    when exists (
      select 1 from public.announcements a where private.announcement_email_due(a, now())
    ) then exists (select 1 from public.announcement_emails_next(now(), 1, true))
    else false
  end;
$$;

-- ─── Grants ─────────────────────────────────────────────────────────────────
revoke execute on function private.announcement_emails_waiting() from public, anon, authenticated;

revoke execute on function public.announcement_emails_next(timestamptz, int, boolean)
  from public, anon, authenticated;
revoke execute on function public.announcement_email_failed(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.announcement_emails_next(timestamptz, int, boolean) to service_role;
grant execute on function public.announcement_email_failed(uuid, uuid, text) to service_role;
