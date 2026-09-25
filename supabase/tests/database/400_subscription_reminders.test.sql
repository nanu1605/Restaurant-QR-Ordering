-- Subscription reminder emails (spec §14.6, docs/DECISIONS.md P8-12): which are
-- due when, who gets them, and each one once.
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- All times are relative to one moment: 1 Oct 2026, 10:00 India time.
\set at '''2026-10-01 10:00+05:30'''

select tests.create_restaurant('rem-trial3') as trial3 \gset
select tests.create_restaurant('rem-trial1') as trial1 \gset
select tests.create_restaurant('rem-autopay') as autopay \gset
select tests.create_restaurant('rem-failed') as failed \gset
select tests.create_restaurant('rem-paused') as paused \gset
select tests.create_restaurant('rem-old') as old \gset
select tests.create_restaurant('rem-susp') as susp \gset
select tests.create_restaurant('rem-noemail') as noemail \gset

-- Recipients: a real owner login, the restaurant's email (the same address in
-- capitals), an inactive owner and a synthetic staff login.
select tests.add_member(:'trial3', 'owner', 'boss') as boss \gset
select tests.add_member(:'trial3', 'owner', 'gone') as gone \gset
update public.restaurant_members set is_active = false where user_id = :'gone';
select tests.create_user('owner2@rem-trial3.staff.tableorder.test') as synthetic \gset
insert into public.restaurant_members (restaurant_id, user_id, role, display_name, username)
values (:'trial3', :'synthetic', 'owner', 'Second', 'owner2');
update public.restaurants set email = 'BOSS@rem-trial3.test' where id = :'trial3';

select tests.create_user('owner@rem-noemail.staff.tableorder.test') as noemail_owner \gset
insert into public.restaurant_members (restaurant_id, user_id, role, display_name, username)
values (:'noemail', :'noemail_owner', 'owner', 'Owner', 'owner');

update public.restaurants set email = 'hello@' || slug || '.test'
where id in (:'trial1', :'autopay', :'failed', :'paused', :'old', :'susp');

-- Trials ending in 2½ days and in 12 hours; one with autopay set up.
update public.restaurant_subscriptions set trial_ends_at = :at::timestamptz + interval '60 hours'
where restaurant_id in (:'trial3', :'autopay', :'susp', :'noemail');
update public.restaurant_subscriptions set trial_ends_at = :at::timestamptz + interval '12 hours'
where restaurant_id = :'trial1';
update public.restaurant_subscriptions set razorpay_subscription_id = 'sub_Rem1', razorpay_status = 'authenticated'
where restaurant_id = :'autopay';
select tests.suspend(:'susp');
-- A payment failed; grace runs 3 more days.
update public.restaurant_subscriptions
  set status = 'past_due', source = 'razorpay', billing_cycle = 'monthly',
      current_period_start = :at::timestamptz - interval '31 days',
      current_period_end = :at::timestamptz - interval '1 day',
      grace_until = :at::timestamptz + interval '3 days'
where restaurant_id = :'failed';
-- Trials that ended: one paused yesterday at 04:00, one long ago.
update public.restaurant_subscriptions set trial_ends_at = '2026-09-29 22:00+05:30'
where restaurant_id = :'paused';
update public.restaurant_subscriptions set trial_ends_at = :at::timestamptz - interval '10 days'
where restaurant_id = :'old';

create function pg_temp.due(p_at timestamptz)
returns table (slug text, kind text, due_key date, recipients text[])
language sql
as $$
  select r.slug, d.kind, d.due_key, d.recipients
  from public.subscription_reminders_due(p_at) d
  join public.restaurants r on r.id = d.restaurant_id
  where r.slug like 'rem-%'
  order by r.slug, d.kind;
$$;

-- ─── A cron run a little late still sends the last-day reminder ─────────────
-- The trial ends 25 hours after this run; the next run may come 24h 30m later.
select tests.create_restaurant('rem-late') as late \gset
update public.restaurants set email = 'hello@rem-late.test' where id = :'late';
update public.restaurant_subscriptions set trial_ends_at = :at::timestamptz + interval '25 hours'
where restaurant_id = :'late';
select results_eq(
  format($f$select kind from pg_temp.due(%L) where slug = 'rem-late'$f$, :at),
  $$ values ('trial_ends_1d') $$,
  'a trial ending 25 hours after a run is reminded on its last day'
);
select tests.suspend(:'late');

-- ─── What is due ────────────────────────────────────────────────────────────
select results_eq(
  format($f$select slug, kind, due_key from pg_temp.due(%L)$f$, :at),
  $$ values
    ('rem-failed', 'payment_failed', '2026-10-01'::date),
    ('rem-paused', 'access_restricted', '2026-09-30'::date),
    ('rem-trial1', 'trial_ends_1d', '2026-10-01'::date),
    ('rem-trial3', 'trial_ends_3d', '2026-10-03'::date)
  $$,
  'trials ending in 3 days and 1 day, a failed payment, a pause from yesterday; not autopay, suspended, old pauses or restaurants without an email'
);
select is(
  (select recipients from pg_temp.due(:at) where slug = 'rem-trial3'),
  array['boss@rem-trial3.test'],
  'active owners with a real email and the restaurant email, once; no synthetic or inactive logins'
);

-- ─── Once each ──────────────────────────────────────────────────────────────
select is(public.subscription_reminder_sent(:'trial3', 'trial_ends_3d', '2026-10-03'), true, 'logged');
select is(public.subscription_reminder_sent(:'trial3', 'trial_ends_3d', '2026-10-03'), false, 'logged once');
select public.subscription_reminder_sent(:'failed', 'payment_failed', '2026-10-01');
select public.subscription_reminder_sent(:'paused', 'access_restricted', '2026-09-30');
select public.subscription_reminder_sent(:'trial1', 'trial_ends_1d', '2026-10-01');

select is_empty(
  format($f$select * from pg_temp.due(%L)$f$, :at),
  'nothing is sent twice'
);

-- A day later: the 3-day reminder isn't repeated and the old pause isn't
-- either; the failed payment is reminded again, and the trial that ended
-- last night is paused.
select results_eq(
  format($f$select slug, kind, due_key from pg_temp.due(%L::timestamptz + interval '1 day')$f$, :at),
  $$ values
    ('rem-failed', 'payment_failed', '2026-10-02'::date),
    ('rem-trial1', 'access_restricted', '2026-10-02'::date)
  $$,
  'a day later: the failed payment again, and a trial just ended'
);
select public.subscription_reminder_sent(:'failed', 'payment_failed', '2026-10-02');
select public.subscription_reminder_sent(:'trial1', 'access_restricted', '2026-10-02');
select results_eq(
  format($f$select slug, kind from pg_temp.due(%L::timestamptz + interval '2 days')$f$, :at),
  $$ values ('rem-failed', 'payment_failed'), ('rem-trial3', 'trial_ends_1d') $$,
  'the trial''s last day, and the failed payment'
);
-- Grace over (read-only from 5 Oct): paused, and no more failed-payment emails.
select results_eq(
  format($f$select slug, kind, due_key from pg_temp.due(%L::timestamptz + interval '4 days 2 hours')$f$, :at),
  $$ values
    ('rem-failed', 'access_restricted', '2026-10-05'::date),
    ('rem-trial3', 'access_restricted', '2026-10-04'::date)
  $$,
  'after grace, ordering paused'
);

-- A trial that is extended gets its reminders again, for the new end.
update public.restaurant_subscriptions set trial_ends_at = trial_ends_at + interval '7 days'
where restaurant_id = :'trial3';
select results_eq(
  format($f$select slug, kind, due_key from pg_temp.due(%L::timestamptz + interval '7 days') where slug = 'rem-trial3'$f$, :at),
  $$ values ('rem-trial3', 'trial_ends_3d', '2026-10-10'::date) $$,
  'an extended trial is reminded for its new end'
);

-- ─── Grants ─────────────────────────────────────────────────────────────────
select ok(
  not has_function_privilege('authenticated', 'public.subscription_reminders_due(timestamptz)', 'execute')
    and not has_function_privilege('authenticated', 'public.subscription_reminder_sent(uuid, text, date)', 'execute')
    and has_function_privilege('service_role', 'public.subscription_reminders_due(timestamptz)', 'execute')
    and has_function_privilege('service_role', 'public.subscription_reminder_sent(uuid, text, date)', 'execute'),
  'only the server lists and logs reminders'
);
select tests.authenticate_as(:'boss');
select throws_ok(
  $$select * from public.subscription_reminders$$,
  '42501', null,
  'owners cannot read the reminder log'
);

select * from finish();
rollback;
