-- Subscription reminder emails from the daily cron (spec §14.6, docs/DECISIONS.md
-- P8-12): the trial ends in 3 days / 1 day, a payment failed (daily during
-- grace), ordering is paused. Each reminder has a key (restaurant, kind, day)
-- and is logged once sent, so it goes out once and a missed run catches up.

create table public.subscription_reminders (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id),
  kind text not null
    check (kind in ('trial_ends_3d', 'trial_ends_1d', 'payment_failed', 'access_restricted')),
  -- The trial's last day, the grace day or the day ordering paused.
  due_key date not null,
  sent_at timestamptz not null default now(),
  unique (restaurant_id, kind, due_key)
);

-- Only the server (service role) reads and writes it.
alter table public.subscription_reminders enable row level security;
revoke all on public.subscription_reminders from anon, authenticated;

-- The reminders due at p_at and not sent yet, with who to email: the active
-- owners' own login emails (not synthetic staff addresses) and the
-- restaurant's email. Suspended restaurants get none (support talks to them),
-- nor do trials with autopay set up. "Ordering paused" is only sent within 2
-- days of the pause, so a first run never emails about old lapses.
create or replace function public.subscription_reminders_due(p_at timestamptz default now())
returns table (
  restaurant_id uuid,
  restaurant_name text,
  timezone text,
  kind text,
  due_key date,
  recipients text[],
  plan_name text,
  trial_ends_at timestamptz,
  restriction_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  with subs as (
    select
      r.id, r.name, r.slug, r.email, r.timezone,
      s.status, s.trial_ends_at, p.name as plan_name,
      private.razorpay_managed(s) as autopay,
      a.state, a.restriction_at
    from public.restaurants r
    join public.restaurant_subscriptions s on s.restaurant_id = r.id
    join public.plans p on p.id = s.plan_id
    cross join lateral public.restaurant_access(r.id, p_at) as a
    where r.status = 'active'
  ),
  due as (
    select subs.*, 'trial_ends_3d'::text as kind, (subs.trial_ends_at at time zone subs.timezone)::date as due_key
    from subs
    where subs.status = 'trialing' and not subs.autopay
      and subs.trial_ends_at > p_at + interval '1 day'
      and subs.trial_ends_at <= p_at + interval '3 days'
    union all
    select subs.*, 'trial_ends_1d', (subs.trial_ends_at at time zone subs.timezone)::date
    from subs
    where subs.status = 'trialing' and not subs.autopay
      and subs.trial_ends_at > p_at
      and subs.trial_ends_at <= p_at + interval '1 day'
    union all
    select subs.*, 'payment_failed', (p_at at time zone subs.timezone)::date
    from subs
    where subs.status in ('past_due', 'halted') and subs.state = 'full'
    union all
    select subs.*, 'access_restricted', (subs.restriction_at at time zone subs.timezone)::date
    from subs
    where subs.state = 'read_only'
      and subs.restriction_at <= p_at
      and subs.restriction_at > p_at - interval '2 days'
  )
  select
    due.id, due.name, due.timezone, due.kind, due.due_key, rcpt.emails,
    due.plan_name, due.trial_ends_at, due.restriction_at
  from due
  cross join lateral (
    select array_agg(distinct lower(e.email) order by lower(e.email)) as emails
    from (
      select u.email
      from public.restaurant_members m
      join auth.users u on u.id = m.user_id
      where m.restaurant_id = due.id and m.role = 'owner' and m.is_active
        and split_part(u.email, '@', 2) not like due.slug || '.staff.%'
      union all
      select due.email
    ) as e
    where nullif(btrim(e.email), '') is not null
  ) as rcpt
  where rcpt.emails is not null
    and not exists (
      select 1 from public.subscription_reminders sr
      where sr.restaurant_id = due.id and sr.kind = due.kind and sr.due_key = due.due_key
    )
  order by due.name, due.kind;
$$;

-- Logs a reminder as sent. False when it was already logged.
create or replace function public.subscription_reminder_sent(
  p_restaurant_id uuid,
  p_kind text,
  p_due_key date
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.subscription_reminders (restaurant_id, kind, due_key)
  values (p_restaurant_id, p_kind, p_due_key)
  on conflict do nothing
  returning id into v_id;
  return v_id is not null;
end;
$$;

revoke execute on function public.subscription_reminders_due(timestamptz) from public, anon, authenticated;
revoke execute on function public.subscription_reminder_sent(uuid, text, date)
  from public, anon, authenticated;
grant execute on function public.subscription_reminders_due(timestamptz) to service_role;
grant execute on function public.subscription_reminder_sent(uuid, text, date) to service_role;
