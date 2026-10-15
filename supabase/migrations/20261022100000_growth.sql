-- Super-admin redesign, stop 13d (docs/SUPER_ADMIN_PLAN.md 13d, §5.14;
-- docs/DECISIONS.md SA-53 to SA-60): the leads pipeline, unfinished signups,
-- the funnel with channels and website sources, upgrade opportunities, and
-- "Found us" edited by the team.

-- ─── Leads ──────────────────────────────────────────────────────────────────
-- site_leads holds every lead: demo requests from the website and the ones
-- the team adds by hand (SA-53). Only the team reads it; only the functions
-- below and site_create_lead write it.
alter table public.site_leads
  add column channel text not null default 'website_lead'
    check (channel in ('website_lead', 'field_visit', 'referral', 'phone', 'whatsapp', 'social', 'other')),
  add column stage text not null default 'new'
    check (stage in ('new', 'contacted', 'demo_scheduled', 'demo_done', 'trial', 'won', 'lost')),
  add column lost_reason text
    check (lost_reason in ('price', 'not_interested', 'other_system', 'no_response', 'closed_down', 'other')),
  add column assignee_id uuid references public.platform_admins (user_id) on delete set null,
  add column follow_up_at timestamptz,
  add column demo_at timestamptz,
  add column restaurant_id uuid references public.restaurants (id) on delete set null,
  add column created_by uuid references auth.users (id) on delete set null,
  add column updated_at timestamptz not null default now(),
  add constraint site_leads_lost_needs_reason check ((stage = 'lost') = (lost_reason is not null));

-- Needs attention reads the new ones no one has contacted.
create index site_leads_new_idx on public.site_leads (created_at) where stage = 'new';
create index site_leads_restaurant_idx on public.site_leads (restaurant_id)
  where restaurant_id is not null;
create index site_leads_assignee_idx on public.site_leads (assignee_id)
  where assignee_id is not null;

-- What happened to a lead: stage, assignee, follow-up, demo and restaurant
-- changes (from and to), and the team's notes. Automatic ones are the moves
-- a signup, an onboarding or a first payment makes (SA-54).
create table public.lead_events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.site_leads (id) on delete cascade,
  kind text not null
    check (kind in ('stage', 'assignee', 'follow_up', 'demo', 'restaurant', 'note')),
  actor_id uuid references auth.users (id) on delete set null,
  automatic boolean not null default false,
  from_value text,
  to_value text,
  body text check (length(body) between 1 and 2000),
  -- The clock, not the transaction's start: changes saved together keep their order.
  created_at timestamptz not null default clock_timestamp(),
  check ((kind = 'note') = (body is not null))
);
create index lead_events_lead_idx on public.lead_events (lead_id, created_at);

alter table public.lead_events enable row level security;
revoke all on public.lead_events from anon, authenticated;
grant select on public.lead_events to authenticated;
create policy "platform admins read lead events" on public.lead_events
  for select to authenticated using ((select public.is_platform_admin()));

-- ─── Helpers ────────────────────────────────────────────────────────────────
-- A time with its offset ('2026-10-16T15:30:00+05:30'), or null.
create function private.json_time(p_obj jsonb, p_key text)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  v_text text := private.json_text(p_obj, p_key);
  v_time timestamptz;
begin
  if v_text is null then
    return null;
  end if;
  if v_text !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$' then
    perform private.fail('INVALID_INPUT', p_key);
  end if;
  begin
    v_time := v_text::timestamptz;
  exception when others then
    perform private.fail('INVALID_INPUT', p_key);
  end;
  if v_time < '2020-01-01'::timestamptz or v_time > now() + interval '5 years' then
    perform private.fail('INVALID_INPUT', p_key);
  end if;
  return v_time;
end;
$$;

-- Where a lead linked to this restaurant stands: won once it has paid for a
-- subscription, a trial before that.
create function private.lead_stage_for(p_restaurant_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when exists (
    select 1 from public.subscription_payments p
    where p.restaurant_id = p_restaurant_id and p.purpose = 'subscription'
  ) then 'won' else 'trial' end;
$$;

-- Links a lead to a restaurant and moves it on to Trial or Won; a won lead
-- stays won. No actor: done automatically (SA-54).
create function private.attach_lead(p_lead public.site_leads, p_restaurant_id uuid, p_actor uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_stage text := case when p_lead.stage = 'won' then 'won'
    else private.lead_stage_for(p_restaurant_id) end;
begin
  update public.site_leads l
  set restaurant_id = p_restaurant_id, stage = v_stage, lost_reason = null, updated_at = now()
  where l.id = p_lead.id;
  insert into public.lead_events (lead_id, kind, actor_id, automatic, from_value, to_value)
  values (p_lead.id, 'restaurant', p_actor, p_actor is null,
    p_lead.restaurant_id::text, p_restaurant_id::text);
  if v_stage <> p_lead.stage then
    insert into public.lead_events (lead_id, kind, actor_id, automatic, from_value, to_value)
    values (p_lead.id, 'stage', p_actor, p_actor is null, p_lead.stage, v_stage);
  end if;
end;
$$;

-- A new restaurant, by signup or onboarding, takes the leads with its mobile.
create function private.link_restaurant_leads()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lead public.site_leads;
begin
  for v_lead in
    select * from public.site_leads l
    where l.phone = private.phone10(new.phone) and l.restaurant_id is null
    order by l.created_at, l.id
    for update
  loop
    perform private.attach_lead(v_lead, new.id, null);
  end loop;
  return null;
end;
$$;

create trigger link_restaurant_leads
  after insert on public.restaurants
  for each row execute function private.link_restaurant_leads();

-- A first subscription payment wins the restaurant's leads.
create function private.win_restaurant_leads()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.purpose = 'subscription' then
    with won as (
      select l.id, l.stage from public.site_leads l
      where l.restaurant_id = new.restaurant_id and l.stage <> 'won'
      for update
    ),
    moved as (
      update public.site_leads l
      set stage = 'won', lost_reason = null, updated_at = now()
      from won w
      where l.id = w.id
      returning l.id
    )
    insert into public.lead_events (lead_id, kind, automatic, from_value, to_value)
    select w.id, 'stage', true, w.stage, 'won'
    from won w
    join moved m on m.id = w.id;
  end if;
  return null;
end;
$$;

create trigger win_restaurant_leads
  after insert on public.subscription_payments
  for each row execute function private.win_restaurant_leads();

-- Leads that already became restaurants: linked now, oldest restaurant first.
do $$
declare
  v_lead public.site_leads;
  v_restaurant uuid;
begin
  for v_lead in select * from public.site_leads l order by l.created_at, l.id loop
    select r.id into v_restaurant
    from public.restaurants r
    where private.phone10(r.phone) = v_lead.phone
    order by r.created_at, r.id
    limit 1;
    if found then
      perform private.attach_lead(v_lead, v_restaurant, null);
    end if;
  end loop;
end;
$$;

-- Restaurants and other leads with this mobile: the duplicate warning.
create function private.lead_matches(p_phone text, p_lead_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'restaurants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'name', r.name, 'slug', r.slug, 'city', r.city
      ) order by r.created_at, r.id)
      from (
        select r.* from public.restaurants r
        where p_phone is not null and private.phone10(r.phone) = p_phone
        order by r.created_at, r.id
        limit 10
      ) r
    ), '[]'::jsonb),
    'leads', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id, 'name', l.name, 'restaurant_name', l.restaurant_name, 'city', l.city,
        'stage', l.stage, 'created_at', l.created_at
      ) order by l.created_at desc, l.id)
      from (
        select l.* from public.site_leads l
        where p_phone is not null and l.phone = p_phone and l.id is distinct from p_lead_id
        order by l.created_at desc, l.id
        limit 10
      ) l
    ), '[]'::jsonb)
  );
$$;

-- One lead as the pages show it; the message cut to 160 characters in lists.
create function private.lead_json(p_lead public.site_leads, p_full boolean)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_lead.id,
    'name', p_lead.name,
    'restaurant_name', p_lead.restaurant_name,
    'city', p_lead.city,
    'phone', p_lead.phone,
    'email', p_lead.email,
    'plan_code', p_lead.plan_code,
    'message', case when p_full then p_lead.message else left(p_lead.message, 160) end,
    'more', not p_full and coalesce(length(p_lead.message), 0) > 160,
    'source', p_lead.source,
    'channel', p_lead.channel,
    'stage', p_lead.stage,
    'lost_reason', p_lead.lost_reason,
    'assignee_id', p_lead.assignee_id,
    'assignee', (select u.email from auth.users u where u.id = p_lead.assignee_id),
    'follow_up_at', p_lead.follow_up_at,
    'demo_at', p_lead.demo_at,
    'restaurant_id', p_lead.restaurant_id,
    'restaurant', (select r.name from public.restaurants r where r.id = p_lead.restaurant_id),
    'created_by', (select u.email from auth.users u where u.id = p_lead.created_by),
    'created_at', p_lead.created_at,
    'updated_at', p_lead.updated_at
  );
$$;

-- ─── Leads pipeline (SA-55) ─────────────────────────────────────────────────
-- Leads by stage ('open' is New to Trial), assignee, channel, follow-up due
-- and text, 50 a page; or, for the board, up to 30 in each open stage.
-- Follow-ups due first, then the newest.
create function public.platform_list_leads(p_filters jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('growth.manage');
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_open text[] := array['new', 'contacted', 'demo_scheduled', 'demo_done', 'trial'];
  v_stage text;
  v_assignee text;
  v_assignee_id uuid;
  v_channel text;
  v_due text;
  v_q text;
  v_like text;
  v_digits text;
  v_page int;
  v_board boolean;
  v_page_size int := 50;
  v_tomorrow timestamptz :=
    ((now() at time zone 'Asia/Kolkata')::date + 1)::timestamp at time zone 'Asia/Kolkata';
begin
  perform private.assert_keys(v_filters,
    array['stage', 'assignee', 'channel', 'due', 'q', 'page', 'board']);
  v_stage := coalesce(private.json_text(v_filters, 'stage'), 'open');
  v_assignee := private.json_text(v_filters, 'assignee');
  if v_assignee = 'me' then
    v_assignee_id := v_admin.user_id;
  elsif v_assignee is not null and v_assignee <> 'none' then
    v_assignee_id := private.json_uuid(v_filters, 'assignee');
  end if;
  v_channel := private.json_text(v_filters, 'channel');
  v_due := private.json_text(v_filters, 'due');
  v_q := private.tidy_text(private.json_text(v_filters, 'q'));
  v_board := coalesce(jsonb_typeof(v_filters -> 'board'), 'null') <> 'null'
    and private.json_bool(v_filters, 'board');
  v_page := case
    when coalesce(jsonb_typeof(v_filters -> 'page'), 'null') = 'null' then 1
    else private.json_int(v_filters, 'page')
  end;

  if v_stage not in ('open', 'all', 'new', 'contacted', 'demo_scheduled', 'demo_done', 'trial',
    'won', 'lost') then
    perform private.fail('INVALID_INPUT', 'stage');
  end if;
  if v_channel is not null and v_channel not in ('website_lead', 'field_visit', 'referral',
    'phone', 'whatsapp', 'social', 'other') then
    perform private.fail('INVALID_INPUT', 'channel');
  end if;
  if v_due is not null and v_due not in ('overdue', 'today') then
    perform private.fail('INVALID_INPUT', 'due');
  end if;
  if length(v_q) > 80 then
    perform private.fail('INVALID_INPUT', 'q');
  end if;
  if v_page < 1 or v_page > 10000 then
    perform private.fail('INVALID_INPUT', 'page');
  end if;
  if v_q is not null then
    v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    if v_q ~ '^[0-9 +().-]+$' then
      v_digits := regexp_replace(v_q, '\D', '', 'g');
      v_digits := case when length(v_digits) < 3 then null else right(v_digits, 10) end;
    end if;
  end if;

  return (
    with found as (
      select l as lead
      from public.site_leads l
      where (v_assignee is null
          or (v_assignee = 'none' and l.assignee_id is null)
          or l.assignee_id = v_assignee_id)
        and (v_channel is null or l.channel = v_channel)
        and (v_due is null or (l.stage = any(v_open) and l.follow_up_at < case v_due
          when 'overdue' then now() else v_tomorrow end))
        and (v_q is null
          or l.name ilike v_like or l.restaurant_name ilike v_like or l.city ilike v_like
          or (v_digits is not null and l.phone like '%' || v_digits || '%'))
    ),
    ordered as (
      select f.lead, row_number() over (
        partition by case when v_board then (f.lead).stage end
        order by ((f.lead).follow_up_at is null), (f.lead).follow_up_at,
          (f.lead).created_at desc, (f.lead).id
      ) as n
      from found f
      where case
        when v_board or v_stage = 'open' then (f.lead).stage = any(v_open)
        when v_stage = 'all' then true
        else (f.lead).stage = v_stage
      end
    )
    select jsonb_build_object(
      'page', v_page,
      'page_size', v_page_size,
      'total', (select count(*) from ordered),
      'counts', (
        select jsonb_build_object(
          'open', count(*) filter (where (f.lead).stage = any(v_open)),
          'all', count(*),
          'new', count(*) filter (where (f.lead).stage = 'new'),
          'contacted', count(*) filter (where (f.lead).stage = 'contacted'),
          'demo_scheduled', count(*) filter (where (f.lead).stage = 'demo_scheduled'),
          'demo_done', count(*) filter (where (f.lead).stage = 'demo_done'),
          'trial', count(*) filter (where (f.lead).stage = 'trial'),
          'won', count(*) filter (where (f.lead).stage = 'won'),
          'lost', count(*) filter (where (f.lead).stage = 'lost')
        )
        from found f
      ),
      -- The board: up to 30 in each open stage. The table: one page.
      'rows', coalesce((
        select jsonb_agg(private.lead_json(o.lead, false)
          order by case when v_board then (o.lead).stage end, o.n)
        from ordered o
        where case when v_board then o.n <= 30
          else o.n > (v_page - 1) * v_page_size and o.n <= v_page * v_page_size end
      ), '[]'::jsonb)
    )
  );
end;
$$;

-- One lead: its details, linked restaurant, matches by mobile, and history.
create function public.platform_get_lead(p_lead_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('growth.manage');
  v_lead public.site_leads;
begin
  select * into v_lead from public.site_leads l where l.id = p_lead_id;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  return private.lead_json(v_lead, true) || jsonb_build_object(
    'restaurant', (
      select jsonb_build_object(
        'id', r.id, 'name', r.name, 'slug', r.slug, 'city', r.city,
        'state', private.subscription_state(r.status::text, a.state, s.status::text, s.source::text)
      )
      from public.restaurants r
      left join public.restaurant_subscriptions s on s.restaurant_id = r.id
      cross join lateral public.restaurant_access(r.id) a
      where r.id = v_lead.restaurant_id
    ),
    'matches', private.lead_matches(v_lead.phone, v_lead.id),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id,
        'kind', e.kind,
        'actor', u.email,
        'automatic', e.automatic,
        'from', e.from_value,
        'to', e.to_value,
        'from_label', case e.kind
          when 'restaurant' then (select r.name from public.restaurants r where r.id::text = e.from_value)
          when 'assignee' then (select a.email from auth.users a where a.id::text = e.from_value)
        end,
        'to_label', case e.kind
          when 'restaurant' then (select r.name from public.restaurants r where r.id::text = e.to_value)
          when 'assignee' then (select a.email from auth.users a where a.id::text = e.to_value)
        end,
        'body', e.body,
        'at', e.created_at
      ) order by e.created_at, e.id)
      from public.lead_events e
      left join auth.users u on u.id = e.actor_id
      where e.lead_id = v_lead.id
    ), '[]'::jsonb)
  );
end;
$$;

-- A lead the team adds by hand: a field visit, call, referral or message.
-- New, or Contacted when the conversation already happened.
create function public.platform_create_lead(p_lead jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('growth.manage');
  v_lead jsonb := coalesce(p_lead, '{}'::jsonb);
  v_phone text;
  v_channel text;
  v_stage text;
  v_assignee uuid;
  v_id uuid;
begin
  perform private.assert_keys(v_lead,
    array['name', 'restaurant_name', 'city', 'phone', 'email', 'channel', 'stage', 'message',
      'assignee']);
  v_phone := private.phone10(private.json_text(v_lead, 'phone'));
  v_channel := private.json_text(v_lead, 'channel');
  v_stage := coalesce(private.json_text(v_lead, 'stage'), 'new');
  if coalesce(jsonb_typeof(v_lead -> 'assignee'), 'null') <> 'null' then
    v_assignee := private.json_uuid(v_lead, 'assignee');
  end if;

  if v_phone is null or length(regexp_replace(private.json_text(v_lead, 'phone'), '\D', '', 'g')) > 12 then
    perform private.fail('INVALID_INPUT', 'phone');
  end if;
  if v_channel is null or v_channel not in ('field_visit', 'referral', 'phone', 'whatsapp',
    'social', 'other') then
    perform private.fail('INVALID_INPUT', 'channel');
  end if;
  if v_stage not in ('new', 'contacted') then
    perform private.fail('INVALID_INPUT', 'stage');
  end if;
  if v_assignee is not null
    and not exists (select 1 from public.platform_admins a where a.user_id = v_assignee) then
    perform private.fail('ADMIN_NOT_FOUND');
  end if;

  insert into public.site_leads (name, restaurant_name, city, phone, email, message, channel,
    stage, assignee_id, created_by)
  values (
    private.tidy_text(private.json_text(v_lead, 'name')),
    private.tidy_text(private.json_text(v_lead, 'restaurant_name')),
    private.tidy_text(private.json_text(v_lead, 'city')),
    v_phone,
    nullif(lower(btrim(private.json_text(v_lead, 'email'))), ''),
    nullif(btrim(private.json_text(v_lead, 'message')), ''),
    v_channel,
    v_stage,
    v_assignee,
    v_admin.user_id
  )
  returning id into v_id;
  return v_id;
exception
  when check_violation or not_null_violation then
    perform private.fail('INVALID_INPUT');
end;
$$;

-- Stage (Lost needs a reason), assignee, follow-up, demo, and the restaurant
-- by its code (null unlinks). Each change is in the lead's history.
create function public.platform_update_lead(p_lead_id uuid, p_patch jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('growth.manage');
  v_patch jsonb := coalesce(p_patch, '{}'::jsonb);
  v_lead public.site_leads;
  v_stage text;
  v_reason text;
  v_assignee uuid;
  v_follow_up timestamptz;
  v_demo timestamptz;
  v_code text;
  v_restaurant uuid;
begin
  perform private.assert_keys(v_patch,
    array['stage', 'lost_reason', 'assignee', 'follow_up_at', 'demo_at', 'restaurant_code']);
  select * into v_lead from public.site_leads l where l.id = p_lead_id for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;

  v_stage := coalesce(private.json_text(v_patch, 'stage'), v_lead.stage);
  v_reason := case when v_patch ? 'lost_reason' then private.json_text(v_patch, 'lost_reason')
    else v_lead.lost_reason end;
  v_assignee := v_lead.assignee_id;
  if v_patch ? 'assignee' then
    v_assignee := case when jsonb_typeof(v_patch -> 'assignee') = 'null' then null
      else private.json_uuid(v_patch, 'assignee') end;
  end if;
  v_follow_up := case when v_patch ? 'follow_up_at' then private.json_time(v_patch, 'follow_up_at')
    else v_lead.follow_up_at end;
  v_demo := case when v_patch ? 'demo_at' then private.json_time(v_patch, 'demo_at')
    else v_lead.demo_at end;
  v_restaurant := v_lead.restaurant_id;
  if v_patch ? 'restaurant_code' then
    v_code := lower(private.tidy_text(private.json_text(v_patch, 'restaurant_code')));
    v_restaurant := null;
    if v_code is not null then
      select r.id into v_restaurant from public.restaurants r where r.slug = v_code;
      if not found then
        perform private.fail('RESTAURANT_NOT_FOUND');
      end if;
    end if;
  end if;

  if v_stage not in ('new', 'contacted', 'demo_scheduled', 'demo_done', 'trial', 'won', 'lost') then
    perform private.fail('INVALID_INPUT', 'stage');
  end if;
  if v_stage = 'lost' then
    if v_reason is null or v_reason not in ('price', 'not_interested', 'other_system',
      'no_response', 'closed_down', 'other') then
      perform private.fail('INVALID_INPUT', 'lost_reason');
    end if;
  else
    v_reason := null;
  end if;
  if v_assignee is distinct from v_lead.assignee_id and v_assignee is not null
    and not exists (select 1 from public.platform_admins a where a.user_id = v_assignee) then
    perform private.fail('ADMIN_NOT_FOUND');
  end if;

  insert into public.lead_events (lead_id, kind, actor_id, from_value, to_value)
  select v_lead.id, c.kind, v_admin.user_id, c.before, c.after
  from (values
    ('stage', v_lead.stage, v_stage),
    ('assignee', v_lead.assignee_id::text, v_assignee::text),
    ('follow_up', v_lead.follow_up_at::text, v_follow_up::text),
    ('demo', v_lead.demo_at::text, v_demo::text)
  ) as c(kind, before, after)
  where c.before is distinct from c.after;

  update public.site_leads l
  set stage = v_stage,
    lost_reason = v_reason,
    assignee_id = v_assignee,
    follow_up_at = v_follow_up,
    demo_at = v_demo,
    updated_at = now()
  where l.id = v_lead.id
    and (l.stage, l.lost_reason, l.assignee_id, l.follow_up_at, l.demo_at)
      is distinct from (v_stage, v_reason, v_assignee, v_follow_up, v_demo)
  returning * into v_lead;
  if not found then
    select * into v_lead from public.site_leads l where l.id = p_lead_id;
  end if;

  if v_restaurant is distinct from v_lead.restaurant_id then
    if v_restaurant is null then
      insert into public.lead_events (lead_id, kind, actor_id, from_value)
      values (v_lead.id, 'restaurant', v_admin.user_id, v_lead.restaurant_id::text);
      update public.site_leads l set restaurant_id = null, updated_at = now() where l.id = v_lead.id;
    else
      perform private.attach_lead(v_lead, v_restaurant, v_admin.user_id);
    end if;
  end if;
end;
$$;

-- A note on a lead: the team's only.
create function public.platform_add_lead_note(p_lead_id uuid, p_body text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('growth.manage');
  v_body text := nullif(btrim(coalesce(p_body, '')), '');
  v_id uuid;
begin
  if v_body is null or length(v_body) > 2000 then
    perform private.fail('INVALID_INPUT', 'body');
  end if;
  perform 1 from public.site_leads l where l.id = p_lead_id for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  insert into public.lead_events (lead_id, kind, actor_id, body)
  values (p_lead_id, 'note', v_admin.user_id, v_body)
  returning id into v_id;
  update public.site_leads l set updated_at = now() where l.id = p_lead_id;
  return v_id;
end;
$$;

-- Restaurants and leads with this mobile, before a lead is added by hand.
create function public.platform_lead_matches(p_phone text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('growth.manage');
begin
  return private.lead_matches(private.phone10(p_phone), null);
end;
$$;

-- ─── Unfinished signups (SA-57) ─────────────────────────────────────────────
-- Signups started in the last 7 days (rows are deleted after that) that never
-- became a restaurant: the latest per email, leaving out an email that has a
-- login and a mobile that has a restaurant. Newest first, up to 200.
create function public.platform_unfinished_signups()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('growth.manage');
begin
  return (
    with latest as (
      select distinct on (s.email) s.*
      from public.site_signups s
      where not exists (
        select 1 from public.site_signups f where f.email = s.email and f.verified_at is not null
      )
      order by s.email, s.created_at desc, s.id
    ),
    unfinished as (
      select s.*, private.phone10(s.details ->> 'phone') as phone
      from latest s
      where not exists (select 1 from auth.users u where u.email = s.email)
        and not exists (
          select 1 from public.restaurants r
          where private.phone10(r.phone) = private.phone10(s.details ->> 'phone')
        )
    )
    select jsonb_build_object(
      'total', (select count(*) from unfinished),
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', u.id,
          'email', u.email,
          'owner_name', u.details ->> 'ownerName',
          'phone', u.phone,
          'restaurant_name', u.details ->> 'restaurantName',
          'city', u.details ->> 'city',
          'plan_code', u.details ->> 'planCode',
          'cycle', u.details ->> 'cycle',
          'step', case
            when u.tries >= 5 then 'locked'
            when u.expires_at <= now() then 'expired'
            when u.tries > 0 then 'wrong_code'
            when u.sends > 1 then 'resent'
            else 'code_sent'
          end,
          'lead_id', (
            select l.id from public.site_leads l
            where l.phone = u.phone
            order by l.created_at desc, l.id
            limit 1
          ),
          'created_at', u.created_at,
          'deleted_at', u.created_at + interval '7 days'
        ) order by u.created_at desc, u.id)
        from (select * from unfinished order by created_at desc, id limit 200) u
      ), '[]'::jsonb)
    )
  );
end;
$$;

-- ─── Funnel (SA-58, SA-59) ──────────────────────────────────────────────────
-- For India dates from and to: demo requests and signups started, the
-- restaurants created (by signup or by the team), and of those, how many took
-- a first order and a first payment; the same restaurants by channel and the
-- website arrivals by source. Signups started come from the nightly snapshot,
-- or from site_signups for the 7 days it keeps.
create function public.platform_funnel(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('growth.manage');
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_start timestamptz;
  v_end timestamptz;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    perform private.fail('INVALID_INPUT', 'range');
  end if;
  v_start := p_from::timestamp at time zone 'Asia/Kolkata';
  v_end := (p_to + 1)::timestamp at time zone 'Asia/Kolkata';

  return (
    with days as (
      select d::date as day
      from generate_series(p_from, least(p_to, v_today), interval '1 day') d
    ),
    started as (
      select d.day, coalesce(m.signups_started, case when d.day >= v_today - 6 then (
        select count(distinct s.email)::int from public.site_signups s
        where s.created_at >= d.day::timestamp at time zone 'Asia/Kolkata'
          and s.created_at < (d.day + 1)::timestamp at time zone 'Asia/Kolkata'
      ) end) as n
      from days d
      left join public.metrics_platform_daily m on m.day = d.day
    ),
    cohort as (
      select
        r.id,
        coalesce(r.acquisition_channel, 'unknown') as channel,
        r.signup_source,
        exists (select 1 from public.trial_claims c where c.restaurant_id = r.id) as signup,
        exists (
          select 1 from public.orders o where o.restaurant_id = r.id and o.status = 'accepted'
        ) as ordered,
        exists (
          select 1 from public.subscription_payments p
          where p.restaurant_id = r.id and p.purpose = 'subscription'
        ) as paid_once,
        st.state,
        private.restaurant_mrr_paise(st.state, pl, s.billing_cycle) as mrr
      from public.restaurants r
      left join public.restaurant_subscriptions s on s.restaurant_id = r.id
      left join public.plans pl on pl.id = s.plan_id
      cross join lateral public.restaurant_access(r.id) a
      cross join lateral (
        select private.subscription_state(r.status::text, a.state, s.status::text, s.source::text) as state
      ) st
      where r.created_at >= v_start and r.created_at < v_end
    ),
    leads as (
      select l.channel, l.source
      from public.site_leads l
      where l.created_at >= v_start and l.created_at < v_end
    ),
    channels as (
      select c.channel, c.n
      from unnest(array['website', 'website_lead', 'field_visit', 'referral', 'phone', 'whatsapp',
        'social', 'other', 'unknown']) with ordinality as c(channel, n)
    ),
    arrivals as (
      select l.source, 1 as demo_requests, 0 as signups, 0 as paying
      from leads l
      where l.channel = 'website_lead'
      union all
      select c.signup_source, 0, 1, (c.state = 'paid')::int
      from cohort c
      where c.signup
    ),
    sources as (
      select
        coalesce(a.source ->> 'utm_source', '') as utm_source,
        case when a.source ->> 'utm_source' is null then coalesce(a.source ->> 'referrer', '')
          else '' end as referrer,
        sum(a.demo_requests)::int as demo_requests,
        sum(a.signups)::int as signups,
        sum(a.paying)::int as paying
      from arrivals a
      group by 1, 2
    ),
    ranked as (
      select s.*, row_number() over (
        order by s.demo_requests + s.signups desc, s.utm_source, s.referrer
      ) as n
      from sources s
    )
    select jsonb_build_object(
      'from', p_from,
      'to', p_to,
      'demo_requests', (select count(*) from leads l where l.channel = 'website_lead'),
      'signups_started', (select sum(s.n) from started s),
      'signups_counted_from', (
        select min(s.day) from started s where s.n is not null
          and exists (select 1 from started u where u.n is null)
      ),
      'cohort', (
        select jsonb_agg(jsonb_build_object(
          'kind', k.kind,
          'created', (select count(*) from cohort c where c.signup = k.signup),
          'first_order', (select count(*) from cohort c where c.signup = k.signup and c.ordered),
          'first_payment', (select count(*) from cohort c where c.signup = k.signup and c.paid_once)
        ) order by k.n)
        from (values ('signup', true, 1), ('team', false, 2)) as k(kind, signup, n)
      ),
      'channels', (
        select jsonb_agg(jsonb_build_object(
          'channel', ch.channel,
          'leads', (select count(*) from leads l where l.channel = ch.channel),
          'restaurants', (select count(*) from cohort c where c.channel = ch.channel),
          'paying', (select count(*) from cohort c where c.channel = ch.channel and c.state = 'paid'),
          'mrr_paise', (select coalesce(sum(c.mrr), 0) from cohort c where c.channel = ch.channel)
        ) order by ch.n)
        from channels ch
      ),
      'sources', coalesce((
        select jsonb_agg(jsonb_build_object(
          'utm_source', nullif(r.utm_source, ''),
          'referrer', nullif(r.referrer, ''),
          'demo_requests', r.demo_requests,
          'signups', r.signups,
          'paying', r.paying
        ) order by r.n)
        from ranked r
        where r.n <= 20
      ), '[]'::jsonb),
      'other_sources', (
        select jsonb_build_object(
          'count', count(*),
          'demo_requests', sum(r.demo_requests),
          'signups', sum(r.signups),
          'paying', sum(r.paying)
        )
        from ranked r
        where r.n > 20
        having count(*) > 0
      )
    )
  );
end;
$$;

-- ─── Upgrade opportunities (SA-60) ──────────────────────────────────────────
-- Starter restaurants still using MenuMesh (trial, paid or payment failed)
-- that hit a plan limit in the last 30 days, are at their table or staff
-- limit, or took 600 or more orders in the last 30 business days. Most limit
-- hits first, then the busiest; up to 100.
create function public.platform_upgrade_opportunities()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('growth.manage');
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  -- ponytail: a fixed bar for "busy"; a platform setting if the team wants to tune it.
  v_busy int := 600;
begin
  return (
    with starter as (
      select r.id, r.name, r.slug, r.city, r.phone, pl.max_tables, pl.max_staff, st.state
      from public.restaurants r
      join public.restaurant_subscriptions s on s.restaurant_id = r.id
      join public.plans pl on pl.id = s.plan_id and pl.code = 'starter'
      cross join lateral public.restaurant_access(r.id) a
      cross join lateral (
        select private.subscription_state(r.status::text, a.state, s.status::text, s.source::text) as state
      ) st
      where st.state in ('trial', 'paid', 'payment_failed')
    ),
    usage as (
      select u.restaurant_id, sum(u.orders)::int as orders
      from private.platform_usage(v_today - 29, v_today) u
      where u.restaurant_id in (select s.id from starter s)
      group by u.restaurant_id
    ),
    facts as (
      select
        s.*,
        (select count(*) from public.dining_tables d
          where d.restaurant_id = s.id and d.is_active)::int as tables,
        (select count(*) from public.restaurant_members m
          where m.restaurant_id = s.id and m.is_active and m.role <> 'owner')::int as staff,
        coalesce(u.orders, 0) as orders,
        (select count(*) from public.plan_limit_events e
          where e.restaurant_id = s.id and e.created_at >= now() - interval '30 days')::int as hit_count,
        (select coalesce(jsonb_agg(jsonb_build_object(
            'kind', h.kind, 'feature', h.feature, 'count', h.n
          ) order by h.n desc, h.kind, h.feature), '[]'::jsonb)
          from (
            select e.kind, e.feature, count(*)::int as n
            from public.plan_limit_events e
            where e.restaurant_id = s.id and e.created_at >= now() - interval '30 days'
            group by e.kind, e.feature
          ) h) as hits
      from starter s
      left join usage u on u.restaurant_id = s.id
    ),
    chosen as (
      select f.*
      from facts f
      where f.hit_count > 0 or f.tables >= f.max_tables or f.staff >= f.max_staff
        or f.orders >= v_busy
      order by f.hit_count desc, f.orders desc, f.name, f.id
      limit 100
    )
    select jsonb_build_object(
      'busy_orders', v_busy,
      'rows', coalesce(jsonb_agg(jsonb_build_object(
        'restaurant_id', c.id,
        'name', c.name,
        'slug', c.slug,
        'city', c.city,
        'phone', c.phone,
        'state', c.state,
        'tables', c.tables,
        'max_tables', c.max_tables,
        'staff', c.staff,
        'max_staff', c.max_staff,
        'orders', c.orders,
        'hits', c.hits
      ) order by c.hit_count desc, c.orders desc, c.name, c.id), '[]'::jsonb)
    )
    from chosen c
  );
end;
$$;

-- ─── Found us, edited by the team (SA-59) ───────────────────────────────────
create function public.platform_set_acquisition_channel(p_restaurant_id uuid, p_channel text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.manage');
  v_channel text := nullif(btrim(coalesce(p_channel, '')), '');
  v_before text;
begin
  if v_channel is not null and v_channel not in ('website', 'website_lead', 'field_visit',
    'referral', 'phone', 'whatsapp', 'social', 'other') then
    perform private.fail('INVALID_INPUT', 'channel');
  end if;
  select r.acquisition_channel into v_before
  from public.restaurants r where r.id = p_restaurant_id for update;
  if not found then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;
  if v_before is not distinct from v_channel then
    return;
  end if;
  update public.restaurants r set acquisition_channel = v_channel where r.id = p_restaurant_id;
  perform private.audit_platform(v_admin, p_restaurant_id, 'restaurant.channel_changed',
    'restaurant', p_restaurant_id,
    jsonb_build_object('acquisition_channel', v_before),
    jsonb_build_object('acquisition_channel', v_channel));
end;
$$;

-- ─── Changed definitions ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION private.attention(p_admin uuid, p_money boolean, p_growth boolean, p_system boolean, p_limit integer DEFAULT 5)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with dues as (
    select d.* from private.dues_rows() d where p_money
  ),
  items as (
    select 'payment_failed' as grp, d.restaurant_id::text as id,
      extract(epoch from coalesce(d.grace_until, d.current_period_end)) as ord,
      to_jsonb(d) - 'bucket' - 'access_state' || jsonb_build_object(
        'state', private.subscription_state('active', d.access_state, d.status::text, d.source::text),
        'last_reminder_kind', null, 'last_reminder_at', null
      ) as data
    from dues d where d.bucket = 'payment_failed'
    union all
    select 'trial_ending', d.restaurant_id::text, extract(epoch from d.trial_ends_at),
      to_jsonb(d) - 'bucket' - 'access_state' || jsonb_build_object(
        'state', private.subscription_state('active', d.access_state, d.status::text, d.source::text),
        'last_reminder_kind', null, 'last_reminder_at', null
      )
    from dues d where d.bucket = 'trial_ending'
    union all
    -- Manual and payment-link restaurants never renew on their own.
    select 'needs_payment', d.restaurant_id::text, extract(epoch from d.current_period_end),
      to_jsonb(d) - 'bucket' - 'access_state' || jsonb_build_object(
        'state', private.subscription_state('active', d.access_state, d.status::text, d.source::text),
        'last_reminder_kind', null, 'last_reminder_at', null
      )
    from dues d
    where d.bucket = 'renewal_due' and d.renewal_kind = 'needs_payment'
      and d.current_period_end <= now() + interval '7 days'
    union all
    -- Leads no one has contacted 24 hours after they came in, oldest first (SA-56).
    select 'new_leads', l.id::text, extract(epoch from l.created_at),
      jsonb_build_object(
        'lead_id', l.id, 'name', l.name, 'restaurant_name', l.restaurant_name,
        'city', l.city, 'phone', l.phone, 'created_at', l.created_at
      )
    from public.site_leads l
    where p_growth and l.stage = 'new' and l.created_at <= now() - interval '24 hours'
    union all
    -- Quiet restaurants that still have full access: a lapsed or suspended one
    -- is quiet for a reason Dues or the team already knows.
    select h.health, h.id::text, 0,
      jsonb_build_object(
        'restaurant_id', h.id, 'name', h.name, 'slug', h.slug, 'city', h.city,
        'phone', h.phone, 'health', h.health
      )
    from (
      select r.id, r.name, r.slug, r.city, r.phone,
        private.restaurant_health(r.id, r.created_at) as health
      from public.restaurants r
      where r.status = 'active'
    ) as h
    cross join lateral public.restaurant_access(h.id) as a
    where h.health in ('inactive', 'slowing') and a.state = 'full'
    union all
    select 'stuck_onboarding', o.id::text, extract(epoch from (o.ob ->> 'since')::timestamptz),
      jsonb_build_object(
        'restaurant_id', o.id, 'name', o.name, 'slug', o.slug, 'city', o.city,
        'phone', o.phone, 'next', o.ob ->> 'next', 'since', o.ob -> 'since'
      )
    from (
      select r.id, r.name, r.slug, r.city, r.phone, x.onboarding as ob
      from private.restaurants_onboarding(array(
        select r.id from public.restaurants r
        where r.status = 'active' and r.created_at >= now() - interval '60 days'
      )) as x
      join public.restaurants r on r.id = x.restaurant_id
      where (x.onboarding ->> 'stuck')::boolean and x.onboarding ->> 'next' <> 'paid'
      offset 0 -- access only for the stuck ones
    ) as o
    cross join lateral public.restaurant_access(o.id) as a
    where a.state = 'full'
    union all
    select 'support_open', q.id::text, extract(epoch from q.created_at),
      jsonb_build_object(
        'request_id', q.id, 'restaurant_id', q.restaurant_id, 'name', r.name,
        'topic', q.topic, 'status', q.status, 'created_at', q.created_at
      )
    from public.support_requests q
    join public.restaurants r on r.id = q.restaurant_id
    where q.status in ('open', 'in_progress') and q.created_at < now() - interval '24 hours'
      -- The digest (no admin) lists them all.
      and (p_admin is null or private.has_platform_permission('restaurants.support'))
    union all
    -- Signups of the last week that look like another restaurant (P11-13).
    select 'duplicates', r.id::text, -extract(epoch from r.created_at),
      jsonb_build_object(
        'restaurant_id', r.id, 'name', r.name, 'slug', r.slug, 'city', r.city,
        'created_at', r.created_at, 'matches', lk.matches
      )
    from public.restaurants r
    cross join lateral (select private.restaurant_lookalikes(r.id) as matches) as lk
    where r.created_at >= now() - interval '7 days' and r.status = 'active'
      and exists (select 1 from public.trial_claims c where c.restaurant_id = r.id)
      and jsonb_array_length(lk.matches) > 0
    union all
    select 'webhooks', w.id::text, -extract(epoch from w.received_at),
      jsonb_build_object(
        'id', w.id, 'event_type', w.event_type, 'received_at', w.received_at,
        'error', w.processing_error
      )
    from public.webhook_events w
    where p_system and w.processing_error is not null
    union all
    -- Each scheduled step's latest run of the last two days, when it failed.
    select 'cron', c.job || ':' || c.step, -extract(epoch from c.started_at),
      jsonb_build_object(
        'job', c.job, 'step', c.step, 'started_at', c.started_at, 'detail', c.detail
      )
    from (
      select distinct on (x.job, x.step) x.*
      from public.cron_runs x
      where x.started_at >= now() - interval '2 days'
      order by x.job, x.step, x.started_at desc
    ) as c
    where p_system and not c.ok
  ),
  open_items as (
    select i.*, i.grp || ':' || i.id as key,
      row_number() over (partition by i.grp order by i.ord, i.data ->> 'name', i.id) as n,
      count(*) over (partition by i.grp) as total
    from items i
    where p_admin is null or not exists (
      select 1 from public.platform_snoozes z
      where z.admin_id = p_admin and z.item_key = i.grp || ':' || i.id and z.until > now()
    )
  ),
  groups as (
    select o.grp, max(o.total) as total,
      jsonb_agg(jsonb_build_object('key', o.key, 'data', o.data) order by o.n)
        filter (where o.n <= p_limit) as items
    from open_items o
    group by o.grp
  )
  select jsonb_build_object(
    'total', coalesce((select sum(g.total) from groups g), 0),
    'inactive_days', (select s.health_inactive_days from public.platform_settings s where s.id = 1),
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object('group', g.grp, 'count', g.total, 'items', g.items)
        order by array_position(array['payment_failed', 'trial_ending', 'needs_payment',
          'new_leads', 'support_open', 'stuck_onboarding', 'inactive', 'slowing', 'duplicates',
          'webhooks', 'cron'], g.grp))
      from groups g
    ), '[]'::jsonb)
  );
$function$;

CREATE OR REPLACE FUNCTION public.site_signup_create_restaurant(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_fssai text := nullif(btrim(p_payload ->> 'fssai_license'), '');
  v_gstin text := nullif(upper(btrim(p_payload ->> 'gstin')), '');
  v_phone text := private.phone10(p_payload ->> 'phone');
  v_photo text := nullif(btrim(p_payload ->> 'storefront_photo_path'), '');
  v_result jsonb;
  v_restaurant_id uuid;
begin
  if v_fssai is null or v_phone is null or v_photo is null then
    perform private.fail('INVALID_INPUT', 'self_signup');
  end if;

  -- One self-signup at a time, so two can't both pass the check below.
  -- ponytail: one lock for every signup; per-value locks if signups ever queue on it.
  perform pg_advisory_xact_lock(hashtextextended('site_signup:trial_claims', 0));
  if public.site_signup_identity_taken(v_fssai, v_phone, v_gstin) then
    perform private.fail('RESTAURANT_EXISTS');
  end if;

  -- Found on the website, or the way the first lead with this mobile came:
  -- a demo request, or a field visit the team added (SA-12, SA-54).
  v_result := public.platform_create_restaurant(p_payload || jsonb_build_object(
    'acquisition_channel',
    coalesce((
      select l.channel from public.site_leads l
      where l.phone = v_phone
      order by l.created_at, l.id
      limit 1
    ), 'website')
  ));
  v_restaurant_id := (v_result ->> 'restaurant_id')::uuid;
  update public.restaurants r
  set fssai_license = v_fssai, gstin = v_gstin, storefront_photo_path = v_photo
  where r.id = v_restaurant_id;
  insert into public.trial_claims (kind, value, restaurant_id)
  select c.kind, c.value, v_restaurant_id
  from (values ('fssai', v_fssai), ('phone', v_phone), ('gstin', v_gstin)) c (kind, value)
  where c.value is not null;
  return v_result;
exception
  when check_violation then
    perform private.fail('INVALID_INPUT');
end;
$function$;

-- ─── Grants ─────────────────────────────────────────────────────────────────
revoke execute on function private.json_time(jsonb, text) from public, anon, authenticated;
revoke execute on function private.lead_stage_for(uuid) from public, anon, authenticated;
revoke execute on function private.attach_lead(public.site_leads, uuid, uuid) from public, anon, authenticated;
revoke execute on function private.link_restaurant_leads() from public, anon, authenticated;
revoke execute on function private.win_restaurant_leads() from public, anon, authenticated;
revoke execute on function private.lead_matches(text, uuid) from public, anon, authenticated;
revoke execute on function private.lead_json(public.site_leads, boolean) from public, anon, authenticated;
revoke execute on function public.platform_list_leads(jsonb) from public, anon;
revoke execute on function public.platform_get_lead(uuid) from public, anon;
revoke execute on function public.platform_create_lead(jsonb) from public, anon;
revoke execute on function public.platform_update_lead(uuid, jsonb) from public, anon;
revoke execute on function public.platform_add_lead_note(uuid, text) from public, anon;
revoke execute on function public.platform_lead_matches(text) from public, anon;
revoke execute on function public.platform_unfinished_signups() from public, anon;
revoke execute on function public.platform_funnel(date, date) from public, anon;
revoke execute on function public.platform_upgrade_opportunities() from public, anon;
revoke execute on function public.platform_set_acquisition_channel(uuid, text) from public, anon;
grant execute on function public.platform_list_leads(jsonb) to authenticated;
grant execute on function public.platform_get_lead(uuid) to authenticated;
grant execute on function public.platform_create_lead(jsonb) to authenticated;
grant execute on function public.platform_update_lead(uuid, jsonb) to authenticated;
grant execute on function public.platform_add_lead_note(uuid, text) to authenticated;
grant execute on function public.platform_lead_matches(text) to authenticated;
grant execute on function public.platform_unfinished_signups() to authenticated;
grant execute on function public.platform_funnel(date, date) to authenticated;
grant execute on function public.platform_upgrade_opportunities() to authenticated;
grant execute on function public.platform_set_acquisition_channel(uuid, text) to authenticated;
