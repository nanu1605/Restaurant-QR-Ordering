-- Stop 14c: announcements and the standee tracker
-- (docs/SUPER_ADMIN_PLAN.md 14c, docs/DECISIONS.md SA-82+).
--
-- An announcement's email goes when it starts: at once if it already has,
-- otherwise by the daily run on its first day. One standee record per
-- restaurant, and its cost is money (owner's choices, 2026-10-15).

-- ─── Announcements ──────────────────────────────────────────────────────────
create table public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 120),
  body text not null check (char_length(body) between 1 and 500),
  -- For Hindi logins in the worker panel; both or neither.
  title_hi text check (char_length(title_hi) between 1 and 120),
  body_hi text check (char_length(body_hi) between 1 and 500),
  panels text[] not null
    check (cardinality(panels) between 1 and 2 and panels <@ array['admin', 'worker']),
  -- Restaurants on these plans, in these cities, or these restaurants; none
  -- of them: everyone.
  plan_ids uuid[] check (cardinality(plan_ids) > 0),
  cities text[] check (cardinality(cities) > 0),
  restaurant_ids uuid[] check (cardinality(restaurant_ids) > 0),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  ended_at timestamptz,
  dismissible boolean not null default true,
  -- Owners are emailed once it starts.
  email boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((title_hi is null) = (body_hi is null)),
  check (num_nonnulls(plan_ids, cities, restaurant_ids) <= 1),
  check (ends_at is null or ends_at > starts_at)
);

-- Who hid which announcement: a login (a support session: the team member).
create table public.announcement_dismissals (
  announcement_id uuid not null references public.announcements (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  dismissed_at timestamptz not null default now(),
  primary key (announcement_id, user_id)
);

-- Which restaurants' owners were emailed, so each is once.
create table public.announcement_emails (
  announcement_id uuid not null references public.announcements (id) on delete cascade,
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  sent_at timestamptz not null default now(),
  primary key (announcement_id, restaurant_id)
);
create index announcement_emails_restaurant_idx on public.announcement_emails (restaurant_id);

-- ─── Standees ───────────────────────────────────────────────────────────────
-- One record per restaurant (owner's choice): its status is the last step
-- with a date. A reprint edits it.
create table public.standees (
  restaurant_id uuid primary key references public.restaurants (id) on delete cascade,
  quantity int not null check (quantity between 1 and 500),
  printed_on date,
  dispatched_on date,
  delivered_on date,
  installed_on date,
  status text not null generated always as (
    case
      when installed_on is not null then 'installed'
      when delivered_on is not null then 'delivered'
      when dispatched_on is not null then 'dispatched'
      when printed_on is not null then 'printed'
      else 'to_print'
    end
  ) stored,
  vendor text check (char_length(vendor) between 1 and 120),
  -- What MenuMesh paid for them: money (money.view to see, money.record to set).
  cost_paise bigint check (cost_paise between 0 and 100000000),
  notes text check (char_length(notes) between 1 and 1000),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Read and written through the functions below only.
alter table public.announcements enable row level security;
alter table public.announcement_dismissals enable row level security;
alter table public.announcement_emails enable row level security;
alter table public.standees enable row level security;
revoke all on public.announcements, public.announcement_dismissals, public.announcement_emails,
  public.standees from anon, authenticated;

-- ─── Audit: standees are the team's ─────────────────────────────────────────
alter policy "managers and platform admins read audit logs" on public.audit_logs
  using (
    (restaurant_id in (select private.my_restaurant_ids('{owner,manager}'::public.member_role[]))
      and coalesce(entity_type, '') <> all (
        array['restaurant_note', 'restaurant_tags', 'account_manager', 'subscription_deal',
          'restaurant_override', 'standee']))
    or (select public.platform_can('audit.view'))
  );

-- ─── Audience ───────────────────────────────────────────────────────────────
-- Whether a restaurant is in an announcement's audience: its plan (the one
-- it trials or pays), its city (any case), or chosen by name.
create function private.in_audience(p_announcement public.announcements, p_restaurant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    (p_announcement.plan_ids is null or exists (
      select 1 from public.restaurant_subscriptions s
      where s.restaurant_id = p_restaurant_id and s.plan_id = any (p_announcement.plan_ids)
    ))
    and (p_announcement.cities is null or exists (
      select 1 from public.restaurants r
      where r.id = p_restaurant_id
        and lower(btrim(r.city)) in (select lower(c) from unnest(p_announcement.cities) as c)
    ))
    and (p_announcement.restaurant_ids is null or p_restaurant_id = any (p_announcement.restaurant_ids));
$$;

-- Showing now: started, not past its end, not ended early.
create function private.announcement_live(p_announcement public.announcements, p_at timestamptz)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_announcement.ended_at is null and p_announcement.starts_at <= p_at
    and (p_announcement.ends_at is null or p_announcement.ends_at > p_at);
$$;

-- Its email is due on its first day (India) and until it ends: the daily
-- run (03:00) sends one starting later that day before it shows (SA-83).
create function private.announcement_email_due(p_announcement public.announcements, p_at timestamptz)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_announcement.email and p_announcement.ended_at is null
    and p_announcement.starts_at
      < (((p_at at time zone 'Asia/Kolkata')::date + 1)::timestamp at time zone 'Asia/Kolkata')
    and (p_announcement.ends_at is null or p_announcement.ends_at > p_at);
$$;

-- ─── Announcements (Settings, settings.manage) ──────────────────────────────
create function public.platform_list_announcements()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('settings.manage');
begin
  return jsonb_build_object('announcements', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id,
      'title', a.title,
      'body', a.body,
      'title_hi', a.title_hi,
      'body_hi', a.body_hi,
      'panels', to_jsonb(a.panels),
      'plan_codes', (
        select jsonb_agg(p.code order by p.sort_order) from public.plans p where p.id = any (a.plan_ids)
      ),
      'cities', to_jsonb(a.cities),
      'restaurants', (
        select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name) order by r.name)
        from public.restaurants r where r.id = any (a.restaurant_ids)
      ),
      'starts_at', a.starts_at,
      'ends_at', a.ends_at,
      'ended_at', a.ended_at,
      'dismissible', a.dismissible,
      'email', a.email,
      -- ponytail: counted per restaurant, so only while it runs.
      'audience', case when a.ended_at is null and (a.ends_at is null or a.ends_at > now()) then (
        select count(*) from public.restaurants r
        where r.status = 'active' and private.in_audience(a, r.id)
      ) end,
      'dismissed', (select count(*) from public.announcement_dismissals d where d.announcement_id = a.id),
      'emailed', (select count(*) from public.announcement_emails e where e.announcement_id = a.id),
      'created_by', u.email,
      'created_at', a.created_at
    ) order by a.ended_at is not null, a.starts_at desc, a.created_at desc)
    from public.announcements a
    left join auth.users u on u.id = a.created_by
  ), '[]'::jsonb),
  'cities', coalesce((
    select jsonb_agg(c.city order by c.city) from (
      select distinct btrim(r.city) as city from public.restaurants r
      where nullif(btrim(r.city), '') is not null
    ) as c
  ), '[]'::jsonb));
end;
$$;

-- A new announcement, a change to one, or ending it early ({"ended": true}).
-- The audience is replaced whole when any part of it is sent.
create function public.platform_save_announcement(
  p_announcement jsonb,
  p_announcement_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('settings.manage');
  v_patch jsonb := coalesce(p_announcement, '{}'::jsonb);
  v_old public.announcements;
  v_new public.announcements;
  v_codes text[];
  v_ids uuid[];
  v_key text;
  v_before jsonb := '{}'::jsonb;
  v_after jsonb := '{}'::jsonb;
begin
  perform private.assert_keys(v_patch, array['title', 'body', 'title_hi', 'body_hi', 'panels',
    'plan_codes', 'cities', 'restaurant_ids', 'starts_at', 'ends_at', 'dismissible', 'email',
    'ended']);
  if p_announcement_id is null then
    if v_patch ? 'ended' then
      perform private.fail('INVALID_INPUT', 'ended');
    end if;
    v_new.starts_at := date_trunc('minute', now());
    v_new.dismissible := true;
    v_new.email := false;
  else
    select * into v_old from public.announcements a where a.id = p_announcement_id for update;
    if v_old.id is null then
      perform private.fail('NOT_FOUND');
    end if;
    if v_old.ended_at is not null then
      perform private.fail('ANNOUNCEMENT_ENDED');
    end if;
    v_new := v_old;
  end if;

  if p_announcement_id is null or v_patch ? 'title' then
    v_new.title := private.tidy_text(private.json_text(v_patch, 'title'));
    if v_new.title is null or char_length(v_new.title) > 120 then
      perform private.fail('INVALID_INPUT', 'title');
    end if;
  end if;
  -- Text keeps its line breaks.
  if p_announcement_id is null or v_patch ? 'body' then
    v_new.body := nullif(btrim(private.json_text(v_patch, 'body')), '');
    if v_new.body is null or char_length(v_new.body) > 500 then
      perform private.fail('INVALID_INPUT', 'body');
    end if;
  end if;
  if v_patch ? 'title_hi' or v_patch ? 'body_hi' then
    v_new.title_hi := private.tidy_text(private.json_text(v_patch, 'title_hi'));
    v_new.body_hi := nullif(btrim(private.json_text(v_patch, 'body_hi')), '');
    if (v_new.title_hi is null) <> (v_new.body_hi is null)
       or char_length(v_new.title_hi) > 120 or char_length(v_new.body_hi) > 500 then
      perform private.fail('INVALID_INPUT', 'title_hi');
    end if;
  end if;
  if p_announcement_id is null or v_patch ? 'panels' then
    if jsonb_typeof(v_patch -> 'panels') is distinct from 'array' then
      perform private.fail('INVALID_INPUT', 'panels');
    end if;
    select array_agg(distinct x order by x) into v_new.panels
    from jsonb_array_elements_text(v_patch -> 'panels') as x;
    if coalesce(cardinality(v_new.panels), 0) = 0
       or not v_new.panels <@ array['admin', 'worker'] then
      perform private.fail('INVALID_INPUT', 'panels');
    end if;
  end if;

  if v_patch ?| array['plan_codes', 'cities', 'restaurant_ids'] then
    v_new.plan_ids := null;
    v_new.cities := null;
    v_new.restaurant_ids := null;
    if coalesce(jsonb_typeof(v_patch -> 'plan_codes'), 'null') <> 'null' then
      if jsonb_typeof(v_patch -> 'plan_codes') <> 'array' then
        perform private.fail('INVALID_INPUT', 'plan_codes');
      end if;
      select array_agg(x) into v_codes from jsonb_array_elements_text(v_patch -> 'plan_codes') as x;
      select array_agg(p.id) into v_new.plan_ids from public.plans p where p.code = any (v_codes);
      if coalesce(cardinality(v_codes), 0) = 0
         or coalesce(cardinality(v_new.plan_ids), 0) <> cardinality(array(select distinct unnest(v_codes))) then
        perform private.fail('INVALID_INPUT', 'plan_codes');
      end if;
    end if;
    if coalesce(jsonb_typeof(v_patch -> 'cities'), 'null') <> 'null' then
      if jsonb_typeof(v_patch -> 'cities') <> 'array' then
        perform private.fail('INVALID_INPUT', 'cities');
      end if;
      select array_agg(distinct btrim(x)) into v_new.cities
      from jsonb_array_elements_text(v_patch -> 'cities') as x
      where btrim(x) <> '';
      if coalesce(cardinality(v_new.cities), 0) = 0
         or exists (select 1 from unnest(v_new.cities) as c where char_length(c) > 80) then
        perform private.fail('INVALID_INPUT', 'cities');
      end if;
    end if;
    if coalesce(jsonb_typeof(v_patch -> 'restaurant_ids'), 'null') <> 'null' then
      if jsonb_typeof(v_patch -> 'restaurant_ids') <> 'array'
         or exists (
           select 1 from jsonb_array_elements_text(v_patch -> 'restaurant_ids') as x
           where x !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         ) then
        perform private.fail('INVALID_INPUT', 'restaurant_ids');
      end if;
      select array_agg(distinct x::uuid) into v_ids
      from jsonb_array_elements_text(v_patch -> 'restaurant_ids') as x;
      select array_agg(r.id order by r.id) into v_new.restaurant_ids
      from public.restaurants r where r.id = any (v_ids);
      if coalesce(cardinality(v_ids), 0) = 0
         or coalesce(cardinality(v_new.restaurant_ids), 0) <> cardinality(v_ids) then
        perform private.fail('INVALID_INPUT', 'restaurant_ids');
      end if;
    end if;
    if num_nonnulls(v_new.plan_ids, v_new.cities, v_new.restaurant_ids) > 1 then
      perform private.fail('INVALID_INPUT', 'audience');
    end if;
  end if;

  if v_patch ? 'starts_at' then
    v_new.starts_at := coalesce(private.json_time(v_patch, 'starts_at'), date_trunc('minute', now()));
  end if;
  if v_patch ? 'ends_at' then
    v_new.ends_at := private.json_time(v_patch, 'ends_at');
  end if;
  if v_new.ends_at <= v_new.starts_at then
    perform private.fail('INVALID_INPUT', 'ends_at');
  end if;
  if v_patch ? 'dismissible' then
    v_new.dismissible := coalesce(private.json_bool(v_patch, 'dismissible'), true);
  end if;
  if v_patch ? 'email' then
    v_new.email := coalesce(private.json_bool(v_patch, 'email'), false);
  end if;
  if v_patch ? 'ended' then
    if jsonb_typeof(v_patch -> 'ended') <> 'boolean' or not (v_patch ->> 'ended')::boolean then
      perform private.fail('INVALID_INPUT', 'ended');
    end if;
    v_new.ended_at := now();
  end if;

  if p_announcement_id is null then
    insert into public.announcements (title, body, title_hi, body_hi, panels, plan_ids, cities,
      restaurant_ids, starts_at, ends_at, dismissible, email, created_by)
    values (v_new.title, v_new.body, v_new.title_hi, v_new.body_hi, v_new.panels, v_new.plan_ids,
      v_new.cities, v_new.restaurant_ids, v_new.starts_at, v_new.ends_at, v_new.dismissible,
      v_new.email, v_admin.user_id)
    returning * into v_new;
    perform private.audit_platform(v_admin, null, 'announcement.created', 'announcement', v_new.id,
      null, jsonb_strip_nulls(jsonb_build_object('title', v_new.title, 'title_hi', v_new.title_hi,
        'panels', v_new.panels, 'plan_ids', v_new.plan_ids, 'cities', v_new.cities,
        'restaurant_ids', v_new.restaurant_ids, 'starts_at', v_new.starts_at,
        'ends_at', v_new.ends_at, 'dismissible', v_new.dismissible, 'email', v_new.email)));
  else
    update public.announcements a set
      title = v_new.title,
      body = v_new.body,
      title_hi = v_new.title_hi,
      body_hi = v_new.body_hi,
      panels = v_new.panels,
      plan_ids = v_new.plan_ids,
      cities = v_new.cities,
      restaurant_ids = v_new.restaurant_ids,
      starts_at = v_new.starts_at,
      ends_at = v_new.ends_at,
      ended_at = v_new.ended_at,
      dismissible = v_new.dismissible,
      email = v_new.email,
      updated_at = now()
    where a.id = p_announcement_id;
    foreach v_key in array array['title', 'body', 'title_hi', 'body_hi', 'panels', 'plan_ids',
      'cities', 'restaurant_ids', 'starts_at', 'ends_at', 'dismissible', 'email'] loop
      if to_jsonb(v_old) -> v_key is distinct from to_jsonb(v_new) -> v_key then
        v_before := v_before || jsonb_build_object(v_key, to_jsonb(v_old) -> v_key);
        v_after := v_after || jsonb_build_object(v_key, to_jsonb(v_new) -> v_key);
      end if;
    end loop;
    if v_before <> '{}'::jsonb then
      perform private.audit_platform(v_admin, null, 'announcement.updated', 'announcement',
        v_new.id, v_before, v_after);
    end if;
    if v_new.ended_at is not null then
      perform private.audit_platform(v_admin, null, 'announcement.ended', 'announcement',
        v_new.id, null, jsonb_build_object('title', v_new.title));
    end if;
  end if;
  return jsonb_build_object('id', v_new.id,
    'email_due', private.announcement_email_due(v_new, now()));
end;
$$;

-- ─── Banners (the restaurant's panels) ──────────────────────────────────────
-- The announcements a login sees now in a panel of its restaurant, newest
-- first: none for anyone else. The admin panel is the owner's and manager's.
create function public.member_announcements(p_restaurant_id uuid, p_panel text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id, 'title', x.title, 'body', x.body, 'title_hi', x.title_hi,
      'body_hi', x.body_hi, 'dismissible', x.dismissible
    ) order by x.starts_at desc, x.id), '[]'::jsonb)
  from (
    select a.*
    from public.announcements a
    where p_panel = any (a.panels)
      and p_restaurant_id in (
        select private.my_restaurant_ids(
          case when p_panel = 'admin' then '{owner,manager}'::public.member_role[] end)
      )
      and private.announcement_live(a, now())
      and private.in_audience(a, p_restaurant_id)
      and (not a.dismissible or not exists (
        select 1 from public.announcement_dismissals d
        where d.announcement_id = a.id and d.user_id = (select auth.uid())
      ))
    order by a.starts_at desc, a.id
    -- ponytail: three at most; a fourth waits until one ends or is hidden.
    limit 3
  ) as x;
$$;

-- Hides one for this login, in both panels; works while access is restricted.
create function public.member_dismiss_announcement(p_announcement_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.announcements a
    where a.id = p_announcement_id and a.dismissible and private.announcement_live(a, now())
      and exists (
        select 1 from private.my_restaurant_ids() as m(restaurant_id)
        where private.in_audience(a, m.restaurant_id)
      )
  ) then
    perform private.fail('NOT_FOUND');
  end if;
  insert into public.announcement_dismissals (announcement_id, user_id)
  values (p_announcement_id, (select auth.uid()))
  on conflict do nothing;
end;
$$;

-- ─── Emails (service role: the daily run, and saving one) ───────────────────
-- Each restaurant in a due email announcement's audience whose owners
-- weren't emailed yet, with their addresses: active owners' own logins and
-- the restaurant's email, as for reminders.
create function public.announcement_emails_due(p_at timestamptz default now())
returns table (announcement_id uuid, restaurant_id uuid, title text, body text, recipients text[])
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, r.id, a.title, a.body, rcpt.emails
  from public.announcements a
  join public.restaurants r on r.status = 'active' and private.in_audience(a, r.id)
  cross join lateral (
    select array_agg(distinct lower(e.email) order by lower(e.email)) as emails
    from (
      select u.email
      from public.restaurant_members m
      join auth.users u on u.id = m.user_id
      where m.restaurant_id = r.id and m.role = 'owner' and m.is_active
        and split_part(u.email, '@', 2) not like r.slug || '.staff.%'
      union all
      select r.email
    ) as e
    where nullif(btrim(e.email), '') is not null
  ) as rcpt
  where private.announcement_email_due(a, p_at)
    and rcpt.emails is not null
    and not exists (
      select 1 from public.announcement_emails s
      where s.announcement_id = a.id and s.restaurant_id = r.id
    )
  order by a.starts_at, a.id, r.name, r.id;
$$;

create function public.announcement_email_sent(p_announcement_id uuid, p_restaurant_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.announcement_emails (announcement_id, restaurant_id)
  values (p_announcement_id, p_restaurant_id)
  on conflict do nothing;
$$;

-- ─── Standees (restaurants.manage; cost money.record) ───────────────────────
-- The restaurant's record, made on first save (as many as its active tables
-- unless given). A step's date sets it and later steps' dates can't be
-- earlier; clearing a date takes the status back. Cost is money (Admin,
-- Finance); the rest is managing the restaurant (Admin, Sales).
create function public.platform_save_standees(p_restaurant_id uuid, p_standees jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_patch jsonb := coalesce(p_standees, '{}'::jsonb);
  v_admin private.platform_admin_context;
  v_old public.standees;
  v_new public.standees;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_dates date[];
  v_key text;
  v_before jsonb := '{}'::jsonb;
  v_after jsonb := '{}'::jsonb;
begin
  if v_patch - 'cost_paise' <> '{}'::jsonb or not v_patch ? 'cost_paise' then
    v_admin := private.require_platform_permission('restaurants.manage');
  end if;
  if v_patch ? 'cost_paise' then
    v_admin := private.require_platform_permission('money.record');
  end if;
  perform private.assert_keys(v_patch, array['quantity', 'printed_on', 'dispatched_on',
    'delivered_on', 'installed_on', 'vendor', 'notes', 'cost_paise', 'expected_status']);
  if not exists (select 1 from public.restaurants r where r.id = p_restaurant_id) then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;

  select * into v_old from public.standees s where s.restaurant_id = p_restaurant_id for update;
  -- The status the page showed, for one-click steps.
  if v_patch ? 'expected_status'
     and coalesce(v_old.status, 'not_started') is distinct from v_patch ->> 'expected_status' then
    perform private.fail('STANDEE_CHANGED');
  end if;
  v_patch := v_patch - 'expected_status';
  if v_old.restaurant_id is null then
    -- Making the record is managing the restaurant, with a cost or not.
    v_admin := private.require_platform_permission('restaurants.manage');
    v_new.restaurant_id := p_restaurant_id;
    v_new.quantity := greatest(1, (
      select count(*) from public.dining_tables t
      where t.restaurant_id = p_restaurant_id and t.is_active
    ))::int;
  else
    v_new := v_old;
  end if;

  if v_patch ? 'quantity' then
    v_new.quantity := private.json_int(v_patch, 'quantity');
    if v_new.quantity is null or v_new.quantity not between 1 and 500 then
      perform private.fail('INVALID_INPUT', 'quantity');
    end if;
  end if;
  if v_patch ? 'printed_on' then
    v_new.printed_on := private.json_date(v_patch, 'printed_on');
  end if;
  if v_patch ? 'dispatched_on' then
    v_new.dispatched_on := private.json_date(v_patch, 'dispatched_on');
  end if;
  if v_patch ? 'delivered_on' then
    v_new.delivered_on := private.json_date(v_patch, 'delivered_on');
  end if;
  if v_patch ? 'installed_on' then
    v_new.installed_on := private.json_date(v_patch, 'installed_on');
  end if;
  -- Not ahead of today (India), and each step on or after the ones before it.
  v_dates := array[v_new.printed_on, v_new.dispatched_on, v_new.delivered_on, v_new.installed_on];
  for i in 1..4 loop
    if v_dates[i] > v_today or exists (
      select 1 from generate_series(1, i - 1) as j where v_dates[j] > v_dates[i]
    ) then
      perform private.fail('INVALID_INPUT',
        (array['printed_on', 'dispatched_on', 'delivered_on', 'installed_on'])[i]);
    end if;
  end loop;
  if v_patch ? 'vendor' then
    v_new.vendor := private.tidy_text(private.json_text(v_patch, 'vendor'));
    if char_length(v_new.vendor) > 120 then
      perform private.fail('INVALID_INPUT', 'vendor');
    end if;
  end if;
  if v_patch ? 'notes' then
    v_new.notes := nullif(btrim(private.json_text(v_patch, 'notes')), '');
    if char_length(v_new.notes) > 1000 then
      perform private.fail('INVALID_INPUT', 'notes');
    end if;
  end if;
  if v_patch ? 'cost_paise' then
    v_new.cost_paise := case when jsonb_typeof(v_patch -> 'cost_paise') <> 'null'
      then private.json_int(v_patch, 'cost_paise') end;
    if v_new.cost_paise not between 0 and 100000000 then
      perform private.fail('INVALID_INPUT', 'cost_paise');
    end if;
  end if;

  if v_old.restaurant_id is null then
    insert into public.standees (restaurant_id, quantity, printed_on, dispatched_on, delivered_on,
      installed_on, vendor, cost_paise, notes, created_by)
    values (p_restaurant_id, v_new.quantity, v_new.printed_on, v_new.dispatched_on,
      v_new.delivered_on, v_new.installed_on, v_new.vendor, v_new.cost_paise, v_new.notes,
      v_admin.user_id)
    returning * into v_new;
    perform private.audit_platform(v_admin, p_restaurant_id, 'standee.created', 'standee',
      p_restaurant_id, null, jsonb_strip_nulls(jsonb_build_object('status', v_new.status,
        'quantity', v_new.quantity, 'printed_on', v_new.printed_on,
        'dispatched_on', v_new.dispatched_on, 'delivered_on', v_new.delivered_on,
        'installed_on', v_new.installed_on, 'vendor', v_new.vendor,
        'cost_paise', v_new.cost_paise, 'notes', v_new.notes)));
  else
    update public.standees s set
      quantity = v_new.quantity,
      printed_on = v_new.printed_on,
      dispatched_on = v_new.dispatched_on,
      delivered_on = v_new.delivered_on,
      installed_on = v_new.installed_on,
      vendor = v_new.vendor,
      cost_paise = v_new.cost_paise,
      notes = v_new.notes,
      updated_at = now()
    where s.restaurant_id = p_restaurant_id
    returning * into v_new;
    foreach v_key in array array['status', 'quantity', 'printed_on', 'dispatched_on',
      'delivered_on', 'installed_on', 'vendor', 'cost_paise', 'notes'] loop
      if to_jsonb(v_old) -> v_key is distinct from to_jsonb(v_new) -> v_key then
        v_before := v_before || jsonb_build_object(v_key, to_jsonb(v_old) -> v_key);
        v_after := v_after || jsonb_build_object(v_key, to_jsonb(v_new) -> v_key);
      end if;
    end loop;
    if v_before <> '{}'::jsonb then
      perform private.audit_platform(v_admin, p_restaurant_id, 'standee.updated', 'standee',
        p_restaurant_id, v_before, v_after);
    end if;
  end if;
  return jsonb_build_object('status', v_new.status);
end;
$$;

-- One restaurant's standees, active tables and setup fee, for its page.
create function public.platform_get_standees(p_restaurant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.view');
  v_money boolean := private.has_platform_permission('money.view');
begin
  if not exists (select 1 from public.restaurants r where r.id = p_restaurant_id) then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;
  return jsonb_build_object(
    'standees', (
      select jsonb_build_object(
        'quantity', s.quantity,
        'status', s.status,
        'printed_on', s.printed_on,
        'dispatched_on', s.dispatched_on,
        'delivered_on', s.delivered_on,
        'installed_on', s.installed_on,
        'vendor', s.vendor,
        'cost_paise', case when v_money then s.cost_paise end,
        'notes', s.notes,
        'updated_at', s.updated_at
      )
      from public.standees s where s.restaurant_id = p_restaurant_id
    ),
    'tables_active', (
      select count(*) from public.dining_tables t
      where t.restaurant_id = p_restaurant_id and t.is_active
    ),
    'setup_fee', (
      select jsonb_build_object(
        'paid_at', min(p.created_at),
        'amount_paise', case when v_money then sum(p.amount_paise) end
      )
      from public.subscription_payments p
      where p.restaurant_id = p_restaurant_id and p.purpose = 'setup_fee'
      having count(*) > 0
    )
  );
end;
$$;

-- The tracker: restaurants with standees, and those whose setup fee is paid
-- with none yet ('not_started'). Tabs: open (all but installed), not_started
-- and each status; the longest waiting first.
create function public.platform_list_standees(p_status text default 'open', p_page int default 1)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.view');
  v_money boolean := private.has_platform_permission('money.view');
  v_status text := coalesce(p_status, 'open');
  v_page int := greatest(coalesce(p_page, 1), 1);
  v_size constant int := 50;
begin
  if v_status not in ('open', 'not_started', 'to_print', 'printed', 'dispatched', 'delivered',
    'installed') then
    perform private.fail('INVALID_INPUT', 'status');
  end if;
  return (
    with fee as (
      select p.restaurant_id, min(p.created_at) as paid_at
      from public.subscription_payments p
      where p.purpose = 'setup_fee'
      group by p.restaurant_id
    ),
    tracked as (
      select
        r.id, r.name, r.slug, r.city,
        coalesce(s.status, 'not_started') as status,
        coalesce(s.quantity, (
          select count(*) from public.dining_tables t where t.restaurant_id = r.id and t.is_active
        )::int) as quantity,
        s.printed_on, s.dispatched_on, s.delivered_on, s.installed_on, s.vendor, s.cost_paise,
        fee.paid_at as setup_fee_paid_at,
        -- When it reached its status: a step's day, or the fee paid.
        coalesce(
          s.installed_on::timestamp at time zone 'Asia/Kolkata',
          s.delivered_on::timestamp at time zone 'Asia/Kolkata',
          s.dispatched_on::timestamp at time zone 'Asia/Kolkata',
          s.printed_on::timestamp at time zone 'Asia/Kolkata',
          s.created_at,
          fee.paid_at
        ) as since
      from public.restaurants r
      left join public.standees s on s.restaurant_id = r.id
      left join fee on fee.restaurant_id = r.id
      where s.restaurant_id is not null or (fee.restaurant_id is not null and r.status = 'active')
    ),
    picked as (
      select * from tracked x
      where case v_status
        when 'open' then x.status <> 'installed'
        else x.status = v_status
      end
    )
    select jsonb_build_object(
      'page', v_page,
      'page_size', v_size,
      'total', (select count(*) from picked),
      'counts', (
        select jsonb_build_object(
          'open', count(*) filter (where x.status <> 'installed'),
          'not_started', count(*) filter (where x.status = 'not_started'),
          'to_print', count(*) filter (where x.status = 'to_print'),
          'printed', count(*) filter (where x.status = 'printed'),
          'dispatched', count(*) filter (where x.status = 'dispatched'),
          'delivered', count(*) filter (where x.status = 'delivered'),
          'installed', count(*) filter (where x.status = 'installed')
        )
        from tracked x
      ),
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
          'restaurant_id', x.id,
          'name', x.name,
          'slug', x.slug,
          'city', x.city,
          'status', x.status,
          'quantity', x.quantity,
          'printed_on', x.printed_on,
          'dispatched_on', x.dispatched_on,
          'delivered_on', x.delivered_on,
          'installed_on', x.installed_on,
          'vendor', x.vendor,
          'cost_paise', case when v_money then x.cost_paise end,
          'setup_fee_paid_at', x.setup_fee_paid_at,
          'since', x.since
        ) order by x.since, x.name, x.id)
        from (
          select * from picked order by since, name, id
          offset (v_page - 1) * v_size limit v_size
        ) as x
      ), '[]'::jsonb)
    )
  );
end;
$$;

-- ─── Redefined from their live definitions (docs/DECISIONS.md SA-82+) ───────

-- private.restaurants_onboarding: a delivered standee completes the QR step.
CREATE OR REPLACE FUNCTION private.restaurants_onboarding(p_restaurant_ids uuid[])
 RETURNS TABLE(restaurant_id uuid, onboarding jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with t as (
    select
      r.id,
      r.created_at,
      -- At least 5 dishes on the menu: done when the fifth was added.
      (select i.created_at from public.menu_items i
        where i.restaurant_id = r.id and i.is_active
        order by i.created_at, i.id offset 4 limit 1) as menu,
      (select min(d.created_at) from public.dining_tables d
        where d.restaurant_id = r.id and d.is_active) as tables,
      (select min(l.created_at) from public.audit_logs l
        where l.restaurant_id = r.id
          and l.action in ('table.qr_downloaded', 'table.qr_sheet_printed')) as qr_used,
      -- Standees delivered (or installed), from that day in India (SA-84).
      (select least(s.delivered_on, s.installed_on)::timestamp at time zone 'Asia/Kolkata'
        from public.standees s where s.restaurant_id = r.id) as standee,
      least(
        (select min(m.created_at) from public.restaurant_members m
          where m.restaurant_id = r.id and m.is_active and m.role <> 'owner'),
        (select min(w.created_at) from public.waiters w
          where w.restaurant_id = r.id and w.is_active and w.deleted_at is null)
      ) as team,
      (select min(o.created_at) from public.orders o
        where o.restaurant_id = r.id and o.placed_via = 'customer'
          and o.status = 'accepted') as first_order,
      (select min(b.generated_at) from public.bills b where b.restaurant_id = r.id) as first_bill,
      -- The first subscription payment, or autopay on now: since Razorpay
      -- first said so.
      least(
        (select min(p.created_at) from public.subscription_payments p
          where p.restaurant_id = r.id and p.purpose = 'subscription'),
        (select coalesce((
            select min(l.created_at) from public.audit_logs l
            where l.restaurant_id = r.id and l.action = 'subscription.razorpay_updated'
              and l.after ->> 'razorpay_status' in ('authenticated', 'active')
          ), s.updated_at)
        from public.restaurant_subscriptions s
        where s.restaurant_id = r.id and s.razorpay_status in ('authenticated', 'active')
          and not s.cancel_at_period_end)
      ) as paid
    from public.restaurants r
    where r.id = any(p_restaurant_ids)
  ),
  steps as (
    select t.id, x.key, x.n, x.done_at, t.created_at
    from t
    cross join lateral (values
      ('menu', 1, t.menu),
      ('tables', 2, t.tables),
      -- A QR order shows the codes are out: QR use is only recorded since 12b.
      ('qr', 3, least(t.qr_used, t.first_order, t.standee)),
      ('team', 4, t.team),
      ('first_order', 5, t.first_order),
      ('first_bill', 6, t.first_bill),
      ('paid', 7, t.paid)
    ) as x(key, n, done_at)
  )
  select s.id, jsonb_build_object(
    'steps', jsonb_agg(jsonb_build_object('key', s.key, 'done_at', s.done_at) order by s.n),
    'done', count(s.done_at),
    'next', (array_agg(s.key order by s.n) filter (where s.done_at is null))[1],
    'since', greatest(max(s.done_at), max(s.created_at)),
    'stuck', bool_or(s.done_at is null)
      and greatest(max(s.done_at), max(s.created_at)) < now() - interval '3 days'
  )
  from steps s
  group by s.id;
$function$;

-- ─── Grants ─────────────────────────────────────────────────────────────────
revoke execute on function private.in_audience(public.announcements, uuid) from public, anon, authenticated;
revoke execute on function private.announcement_live(public.announcements, timestamptz)
  from public, anon, authenticated;
revoke execute on function private.announcement_email_due(public.announcements, timestamptz)
  from public, anon, authenticated;
revoke execute on function public.platform_list_announcements() from public, anon;
grant execute on function public.platform_list_announcements() to authenticated;
revoke execute on function public.platform_save_announcement(jsonb, uuid) from public, anon;
grant execute on function public.platform_save_announcement(jsonb, uuid) to authenticated;
revoke execute on function public.member_announcements(uuid, text) from public, anon;
grant execute on function public.member_announcements(uuid, text) to authenticated;
revoke execute on function public.member_dismiss_announcement(uuid) from public, anon;
grant execute on function public.member_dismiss_announcement(uuid) to authenticated;
revoke execute on function public.announcement_emails_due(timestamptz) from public, anon, authenticated;
grant execute on function public.announcement_emails_due(timestamptz) to service_role;
revoke execute on function public.announcement_email_sent(uuid, uuid) from public, anon, authenticated;
grant execute on function public.announcement_email_sent(uuid, uuid) to service_role;
revoke execute on function public.platform_save_standees(uuid, jsonb) from public, anon;
grant execute on function public.platform_save_standees(uuid, jsonb) to authenticated;
revoke execute on function public.platform_get_standees(uuid) from public, anon;
grant execute on function public.platform_get_standees(uuid) to authenticated;
revoke execute on function public.platform_list_standees(text, int) from public, anon;
grant execute on function public.platform_list_standees(text, int) to authenticated;
