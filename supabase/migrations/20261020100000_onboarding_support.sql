-- Super-admin redesign, stop 13b (docs/SUPER_ADMIN_PLAN.md 13b; docs/DECISIONS.md
-- SA-41 to SA-45): the onboarding checklist, shared by both panels; Get help in
-- the admin panel; the support inbox; and both in Needs attention, the activity
-- stream and the live alerts.

-- ─── Onboarding checklist ───────────────────────────────────────────────────
-- A restaurant's seven setup steps (plan §5.13, SA-41), each with when it was
-- done (null while it isn't), the next step, and whether it is stuck: a step
-- is still to do and none was done in 3 days (counting from its creation
-- before the first). A step undone later (dishes or tables turned off) is to
-- do again. Read by the restaurant page, the list, Needs attention and, for
-- its own restaurant, the owner's first-steps card.
create function private.restaurant_onboarding(p_restaurant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with t as (
    select
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
    where r.id = p_restaurant_id
  ),
  steps as (
    select x.key, x.n, x.done_at, t.created_at
    from t
    cross join lateral (values
      ('menu', 1, t.menu),
      ('tables', 2, t.tables),
      -- A QR order shows the codes are out: QR use is only recorded since 12b.
      ('qr', 3, least(t.qr_used, t.first_order)),
      ('team', 4, t.team),
      ('first_order', 5, t.first_order),
      ('first_bill', 6, t.first_bill),
      ('paid', 7, t.paid)
    ) as x(key, n, done_at)
  )
  select jsonb_build_object(
    'steps', jsonb_agg(jsonb_build_object('key', s.key, 'done_at', s.done_at) order by s.n),
    'done', count(s.done_at),
    'next', (array_agg(s.key order by s.n) filter (where s.done_at is null))[1],
    'since', greatest(max(s.done_at), max(s.created_at)),
    'stuck', bool_or(s.done_at is null)
      and greatest(max(s.done_at), max(s.created_at)) < now() - interval '3 days'
  )
  from steps s
  having count(*) > 0;
$$;

revoke execute on function private.restaurant_onboarding(uuid) from public, anon, authenticated;

-- The owner's first-steps card reads its own restaurant's steps.
create function public.admin_onboarding()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner}');
begin
  return private.restaurant_onboarding(v_ctx.restaurant_id);
end;
$$;

revoke execute on function public.admin_onboarding() from public, anon;
grant execute on function public.admin_onboarding() to authenticated;

-- ─── Support requests ───────────────────────────────────────────────────────
-- Get help in the admin panel (SA-42) and the support inbox (SA-43). Only the
-- team reads the tables; a restaurant reads its own requests, without the
-- team's priority, assignee and notes, through admin_list_support_requests.
create table public.support_requests (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  created_by uuid references auth.users (id) on delete set null,
  created_by_name text not null check (length(created_by_name) between 1 and 120),
  created_by_role public.member_role not null,
  topic text not null
    check (topic in ('billing', 'menu', 'printing', 'orders_tables', 'staff', 'other')),
  message text not null check (length(message) between 1 and 2000),
  screenshot_path text check (length(screenshot_path) <= 200),
  contact_method text not null check (contact_method in ('call', 'whatsapp', 'email')),
  contact text not null check (length(contact) between 3 and 254),
  context jsonb not null default '{}'::jsonb check (jsonb_typeof(context) = 'object'),
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'waiting', 'resolved')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  assignee_id uuid references public.platform_admins (user_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz,
  check ((status = 'resolved') = (resolved_at is not null))
);
create index support_requests_restaurant_idx
  on public.support_requests (restaurant_id, created_at desc);
create index support_requests_open_idx
  on public.support_requests (created_at) where status <> 'resolved';
create index support_requests_assignee_idx
  on public.support_requests (assignee_id) where assignee_id is not null;

-- What happened to a request: status, priority and assignee changes (from and
-- to), and the team's internal notes (never shown to the restaurant).
create table public.support_request_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.support_requests (id) on delete cascade,
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  kind text not null check (kind in ('status', 'priority', 'assignee', 'note')),
  actor_id uuid references auth.users (id) on delete set null,
  from_value text,
  to_value text,
  body text check (length(body) between 1 and 2000),
  -- The clock, not the transaction's start: changes saved together keep their order.
  created_at timestamptz not null default clock_timestamp(),
  check ((kind = 'note') = (body is not null))
);
create index support_request_events_restaurant_idx
  on public.support_request_events (restaurant_id);
create index support_request_events_request_idx
  on public.support_request_events (request_id, created_at);

alter table public.support_requests enable row level security;
alter table public.support_request_events enable row level security;
revoke all on public.support_requests, public.support_request_events from anon, authenticated;
grant select on public.support_requests, public.support_request_events to authenticated;
create policy "platform admins read support requests" on public.support_requests
  for select to authenticated using ((select public.is_platform_admin()));
create policy "platform admins read support request events" on public.support_request_events
  for select to authenticated using ((select public.is_platform_admin()));

-- Screenshots: private, like menu-imports. The server signs each upload after
-- checking the caller, the team sees a signed link, and no one gets a storage
-- policy.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('support-screenshots', 'support-screenshots', false, 5242880,
  array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

-- A request from the restaurant's owner or a manager, even while it is
-- read-only: billing questions come then. 10 an hour per restaurant.
create function public.admin_create_support_request(p_request jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
  v_request jsonb := coalesce(p_request, '{}'::jsonb);
  v_context jsonb;
  v_topic text;
  v_message text;
  v_method text;
  v_contact text;
  v_path text;
  v_id uuid;
begin
  perform private.assert_keys(v_request,
    array['topic', 'message', 'contact_method', 'contact', 'screenshot_path', 'context']);
  v_topic := private.json_text(v_request, 'topic');
  v_message := nullif(btrim(coalesce(private.json_text(v_request, 'message'), '')), '');
  v_method := private.json_text(v_request, 'contact_method');
  v_contact := nullif(btrim(coalesce(private.json_text(v_request, 'contact'), '')), '');
  v_path := private.json_text(v_request, 'screenshot_path');
  v_context := coalesce(v_request -> 'context', '{}'::jsonb);

  if v_topic is null
    or v_topic not in ('billing', 'menu', 'printing', 'orders_tables', 'staff', 'other') then
    perform private.fail('INVALID_INPUT', 'topic');
  end if;
  if v_message is null or length(v_message) > 2000 then
    perform private.fail('INVALID_INPUT', 'message');
  end if;
  if v_method is null or v_method not in ('call', 'whatsapp', 'email') then
    perform private.fail('INVALID_INPUT', 'contact_method');
  end if;
  if v_contact is null
    or (v_method = 'email' and (length(v_contact) > 254 or v_contact !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'))
    or (v_method <> 'email' and v_contact !~ '^[0-9]{10}$') then
    perform private.fail('INVALID_INPUT', 'contact');
  end if;
  -- Uploaded first, to this restaurant's folder, through a link the server signed.
  if v_path is not null and (
    v_path !~ ('^' || v_ctx.restaurant_id || '/[0-9a-f-]{36}\.(png|jpg|webp)$')
    or not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'support-screenshots' and o.name = v_path
    )
  ) then
    perform private.fail('INVALID_INPUT', 'screenshot_path');
  end if;
  -- Read by the server, not typed: the page, the app's version, the browser.
  if jsonb_typeof(v_context) <> 'object' then
    perform private.fail('INVALID_INPUT', 'context');
  end if;
  perform private.assert_keys(v_context, array['page', 'app_version', 'browser']);
  v_context := jsonb_strip_nulls(jsonb_build_object(
    'page', left(private.json_text(v_context, 'page'), 200),
    'app_version', left(private.json_text(v_context, 'app_version'), 40),
    'browser', left(private.json_text(v_context, 'browser'), 300)
  ));

  -- One at a time per restaurant, so concurrent requests can't all pass the count.
  perform pg_advisory_xact_lock(hashtextextended('support_request:' || v_ctx.restaurant_id, 0));
  if (
    select count(*) from public.support_requests q
    where q.restaurant_id = v_ctx.restaurant_id and q.created_at > now() - interval '1 hour'
  ) >= 10 then
    perform private.fail('RATE_LIMITED');
  end if;

  insert into public.support_requests (
    restaurant_id, created_by, created_by_name, created_by_role, topic, message,
    screenshot_path, contact_method, contact, context
  )
  values (
    v_ctx.restaurant_id, v_ctx.user_id, v_ctx.display_name, v_ctx.role, v_topic, v_message,
    v_path, v_method, v_contact, v_context
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- The restaurant's requests, newest first (50), each with its status changes.
create function public.admin_list_support_requests()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ctx private.member_context := private.current_member('{owner,manager}');
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', q.id,
      'topic', q.topic,
      'message', q.message,
      'has_screenshot', q.screenshot_path is not null,
      'contact_method', q.contact_method,
      'contact', q.contact,
      'created_by_name', q.created_by_name,
      'status', q.status,
      'created_at', q.created_at,
      'resolved_at', q.resolved_at,
      'history', coalesce((
        select jsonb_agg(jsonb_build_object('at', e.created_at, 'status', e.to_value)
          order by e.created_at, e.id)
        from public.support_request_events e
        where e.request_id = q.id and e.kind = 'status'
      ), '[]'::jsonb)
    ) order by q.created_at desc, q.id desc)
    from (
      select * from public.support_requests x
      where x.restaurant_id = v_ctx.restaurant_id
      order by x.created_at desc, x.id desc
      limit 50
    ) as q
  ), '[]'::jsonb);
end;
$$;

-- The inbox (SA-43): requests by status (active = all but resolved), assignee
-- ('me', 'none' or a team member), priority, topic and restaurant. Open work
-- is highest priority first, then oldest; resolved, newest resolved first.
create function public.platform_list_support_requests(p_filters jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.support');
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_status text;
  v_assignee text;
  v_assignee_id uuid;
  v_priority text;
  v_topic text;
  v_restaurant uuid;
  v_page int;
  v_page_size int := 50;
  v_total bigint;
  v_rows jsonb;
  v_counts jsonb;
begin
  perform private.assert_keys(v_filters,
    array['status', 'assignee', 'priority', 'topic', 'restaurant', 'page']);
  v_status := coalesce(private.json_text(v_filters, 'status'), 'active');
  v_assignee := private.json_text(v_filters, 'assignee');
  if v_assignee = 'me' then
    v_assignee_id := v_admin.user_id;
  elsif v_assignee is not null and v_assignee <> 'none' then
    v_assignee_id := private.json_uuid(v_filters, 'assignee');
  end if;
  v_priority := private.json_text(v_filters, 'priority');
  v_topic := private.json_text(v_filters, 'topic');
  if coalesce(jsonb_typeof(v_filters -> 'restaurant'), 'null') <> 'null' then
    v_restaurant := private.json_uuid(v_filters, 'restaurant');
  end if;
  v_page := case
    when coalesce(jsonb_typeof(v_filters -> 'page'), 'null') = 'null' then 1
    else private.json_int(v_filters, 'page')
  end;

  if v_status not in ('active', 'open', 'in_progress', 'waiting', 'resolved') then
    perform private.fail('INVALID_INPUT', 'status');
  end if;
  if v_priority is not null and v_priority not in ('low', 'normal', 'high') then
    perform private.fail('INVALID_INPUT', 'priority');
  end if;
  if v_topic is not null
    and v_topic not in ('billing', 'menu', 'printing', 'orders_tables', 'staff', 'other') then
    perform private.fail('INVALID_INPUT', 'topic');
  end if;
  if v_page < 1 or v_page > 10000 then
    perform private.fail('INVALID_INPUT', 'page');
  end if;

  with filtered as (
    select q.*
    from public.support_requests q
    where (v_assignee is null
        or (v_assignee = 'none' and q.assignee_id is null)
        or q.assignee_id = v_assignee_id)
      and (v_priority is null or q.priority = v_priority)
      and (v_topic is null or q.topic = v_topic)
      and (v_restaurant is null or q.restaurant_id = v_restaurant)
  ),
  matching as (
    select f.* from filtered f
    where case v_status
      when 'active' then f.status <> 'resolved'
      else f.status = v_status
    end
  ),
  page as (
    select m.*
    from matching m
    order by
      case when v_status = 'resolved' then m.resolved_at end desc,
      array_position(array['high', 'normal', 'low'], m.priority),
      m.created_at,
      m.id
    limit v_page_size offset (v_page - 1) * v_page_size
  )
  select
    (select count(*) from matching),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id,
        'restaurant_id', p.restaurant_id,
        'restaurant_name', r.name,
        'slug', r.slug,
        'topic', p.topic,
        'message', left(p.message, 160),
        'more', length(p.message) > 160,
        'created_by_name', p.created_by_name,
        'status', p.status,
        'priority', p.priority,
        'assignee', u.email,
        'created_at', p.created_at,
        'updated_at', p.updated_at,
        'resolved_at', p.resolved_at
      ) order by
        case when v_status = 'resolved' then p.resolved_at end desc,
        array_position(array['high', 'normal', 'low'], p.priority),
        p.created_at,
        p.id)
      from page p
      join public.restaurants r on r.id = p.restaurant_id
      left join auth.users u on u.id = p.assignee_id
    ), '[]'::jsonb),
    (
      select jsonb_build_object(
        'active', count(*) filter (where f.status <> 'resolved'),
        'open', count(*) filter (where f.status = 'open'),
        'in_progress', count(*) filter (where f.status = 'in_progress'),
        'waiting', count(*) filter (where f.status = 'waiting'),
        'resolved', count(*) filter (where f.status = 'resolved')
      )
      from filtered f
    )
  into v_total, v_rows, v_counts;

  return jsonb_build_object(
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'counts', v_counts,
    'rows', v_rows
  );
end;
$$;

-- One request with its restaurant, who asked and its events (notes included).
create function public.platform_get_support_request(p_request_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.require_platform_permission('restaurants.support');
  select jsonb_build_object(
    'id', q.id,
    'restaurant_id', q.restaurant_id,
    'restaurant_name', r.name,
    'slug', r.slug,
    'city', r.city,
    'restaurant_phone', r.phone,
    'topic', q.topic,
    'message', q.message,
    'screenshot_path', q.screenshot_path,
    'contact_method', q.contact_method,
    'contact', q.contact,
    'context', q.context,
    'created_by_name', q.created_by_name,
    'created_by_role', q.created_by_role,
    'created_by_email', (select u.email from auth.users u where u.id = q.created_by),
    'status', q.status,
    'priority', q.priority,
    'assignee_id', q.assignee_id,
    'assignee', (select u.email from auth.users u where u.id = q.assignee_id),
    'created_at', q.created_at,
    'updated_at', q.updated_at,
    'resolved_at', q.resolved_at,
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id,
        'kind', e.kind,
        'at', e.created_at,
        'actor', u.email,
        -- An assignee is a user id, shown as their email.
        'from', case when e.kind = 'assignee'
          then (select x.email from auth.users x where x.id::text = e.from_value)
          else e.from_value end,
        'to', case when e.kind = 'assignee'
          then (select x.email from auth.users x where x.id::text = e.to_value)
          else e.to_value end,
        'body', e.body
      ) order by e.created_at, e.id)
      from public.support_request_events e
      left join auth.users u on u.id = e.actor_id
      where e.request_id = q.id
    ), '[]'::jsonb)
  )
  into v_result
  from public.support_requests q
  join public.restaurants r on r.id = q.restaurant_id
  where q.id = p_request_id;
  if v_result is null then
    perform private.fail('NOT_FOUND');
  end if;
  return v_result;
end;
$$;

-- Changes any of status, priority and assignee (a team member's user id, or
-- null for no one); each change is an event. Unchanged values are no-ops.
create function public.platform_update_support_request(p_request_id uuid, p_patch jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.support');
  v_patch jsonb := coalesce(p_patch, '{}'::jsonb);
  v_request public.support_requests;
  v_status text;
  v_priority text;
  v_assignee uuid;
begin
  perform private.assert_keys(v_patch, array['status', 'priority', 'assignee']);
  select * into v_request from public.support_requests q where q.id = p_request_id for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  v_status := coalesce(private.json_text(v_patch, 'status'), v_request.status);
  v_priority := coalesce(private.json_text(v_patch, 'priority'), v_request.priority);
  v_assignee := v_request.assignee_id;
  if v_patch ? 'assignee' then
    v_assignee := case when jsonb_typeof(v_patch -> 'assignee') = 'null' then null
      else private.json_uuid(v_patch, 'assignee') end;
  end if;

  if v_status not in ('open', 'in_progress', 'waiting', 'resolved') then
    perform private.fail('INVALID_INPUT', 'status');
  end if;
  if v_priority not in ('low', 'normal', 'high') then
    perform private.fail('INVALID_INPUT', 'priority');
  end if;
  if v_assignee is distinct from v_request.assignee_id and v_assignee is not null
    and not exists (select 1 from public.platform_admins a where a.user_id = v_assignee) then
    perform private.fail('ADMIN_NOT_FOUND');
  end if;

  insert into public.support_request_events (request_id, restaurant_id, kind, actor_id, from_value, to_value)
  select v_request.id, v_request.restaurant_id, c.kind, v_admin.user_id, c.before, c.after
  from (values
    ('status', v_request.status, v_status),
    ('priority', v_request.priority, v_priority),
    ('assignee', v_request.assignee_id::text, v_assignee::text)
  ) as c(kind, before, after)
  where c.before is distinct from c.after;
  if not found then
    return;
  end if;

  update public.support_requests q
  set status = v_status,
    priority = v_priority,
    assignee_id = v_assignee,
    resolved_at = case
      when v_status <> 'resolved' then null
      when q.status = 'resolved' then q.resolved_at
      else now()
    end,
    updated_at = now()
  where q.id = v_request.id;
end;
$$;

-- An internal note: the team's only, never shown to the restaurant.
create function public.platform_add_support_note(p_request_id uuid, p_body text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.support');
  v_body text := nullif(btrim(coalesce(p_body, '')), '');
  v_restaurant uuid;
  v_id uuid;
begin
  if v_body is null or length(v_body) > 2000 then
    perform private.fail('INVALID_INPUT', 'body');
  end if;
  select q.restaurant_id into v_restaurant
  from public.support_requests q where q.id = p_request_id for update;
  if not found then
    perform private.fail('NOT_FOUND');
  end if;
  insert into public.support_request_events (request_id, restaurant_id, kind, actor_id, body)
  values (p_request_id, v_restaurant, 'note', v_admin.user_id, v_body)
  returning id into v_id;
  update public.support_requests set updated_at = now() where id = p_request_id;
  return v_id;
end;
$$;

-- Screenshots older than a day that no request uses: the form was left
-- before sending. Removed by the daily cron.
create function public.support_screenshots_to_remove(p_limit int default 200)
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select o.name
  from storage.objects o
  where o.bucket_id = 'support-screenshots'
    and o.created_at < now() - interval '1 day'
    and not exists (select 1 from public.support_requests q where q.screenshot_path = o.name)
  order by o.created_at
  limit least(greatest(coalesce(p_limit, 200), 1), 1000);
$$;

revoke execute on function public.admin_create_support_request(jsonb) from public, anon;
revoke execute on function public.admin_list_support_requests() from public, anon;
revoke execute on function public.platform_list_support_requests(jsonb) from public, anon;
revoke execute on function public.platform_get_support_request(uuid) from public, anon;
revoke execute on function public.platform_update_support_request(uuid, jsonb) from public, anon;
revoke execute on function public.platform_add_support_note(uuid, text) from public, anon;
revoke execute on function public.support_screenshots_to_remove(int)
  from public, anon, authenticated;
grant execute on function public.admin_create_support_request(jsonb) to authenticated;
grant execute on function public.admin_list_support_requests() to authenticated;
grant execute on function public.platform_list_support_requests(jsonb) to authenticated;
grant execute on function public.platform_get_support_request(uuid) to authenticated;
grant execute on function public.platform_update_support_request(uuid, jsonb) to authenticated;
grant execute on function public.platform_add_support_note(uuid, text) to authenticated;
grant execute on function public.support_screenshots_to_remove(int) to service_role;

-- ─── Restaurant page and list: onboarding ───────────────────────────────────
-- The Overview shows the checklist (SA-41).

create or replace function public.platform_restaurant_overview(p_restaurant_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_last date;
  v_result jsonb;
begin
  perform private.require_platform_permission('restaurants.view');
  select private.business_date(now(), r.timezone, r.business_day_start_hour) - 1
  into v_last
  from public.restaurants r where r.id = p_restaurant_id;
  if not found then
    perform private.fail('RESTAURANT_NOT_FOUND');
  end if;

  with u as (
    select * from private.platform_usage(v_last - 89, v_last, p_restaurant_id)
  )
  select jsonb_build_object(
    'last_day', v_last,
    'days', (
      select jsonb_agg(jsonb_build_object(
        'day', g.day::date,
        'orders', coalesce(u.orders, 0),
        'gmv_paise', coalesce(u.gmv_paise, 0)
      ) order by g.day)
      from generate_series(v_last - 89, v_last, interval '1 day') as g(day)
      left join u on u.business_day = g.day::date
    ),
    'last_30', (
      select jsonb_build_object(
        'orders', coalesce(sum(u.orders), 0),
        'customer_orders', coalesce(sum(u.customer_orders), 0),
        'staff_orders', coalesce(sum(u.staff_orders), 0),
        'bills', coalesce(sum(u.bills), 0),
        'gmv_paise', coalesce(sum(u.gmv_paise), 0)
      )
      from u where u.business_day > v_last - 30
    ),
    'onboarding', private.restaurant_onboarding(p_restaurant_id)
  )
  into v_result;
  return v_result;
end;
$$;


-- The list filters by onboarding (open: a step still to do; stuck; done) and
-- each row says where its onboarding stands (SA-41).

create or replace function public.platform_list_restaurants(p_filters jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_q text;
  v_state text;
  v_plan text;
  v_health text;
  v_city text;
  v_region text;
  v_channel text;
  v_tag uuid;
  v_manager text;
  v_manager_id uuid;
  v_onboarding text;
  v_from date;
  v_to date;
  v_paid_from date;
  v_paid_to date;
  v_sort text;
  v_dir text;
  v_page int;
  v_page_size int := 50;
  v_total bigint;
  v_rows jsonb;
  v_cities jsonb;
  v_regions jsonb;
  v_money boolean;
begin
  perform private.require_platform_permission('restaurants.view');
  v_money := private.has_platform_permission('money.view');
  perform private.assert_keys(v_filters, array[
    'q', 'state', 'plan', 'health', 'city', 'region', 'channel', 'from', 'to', 'paid_from',
    'paid_to', 'sort', 'dir', 'page', 'export', 'tag', 'manager', 'onboarding'
  ]);
  v_q := nullif(btrim(coalesce(private.json_text(v_filters, 'q'), '')), '');
  v_state := private.json_text(v_filters, 'state');
  v_plan := private.json_text(v_filters, 'plan');
  v_health := private.json_text(v_filters, 'health');
  v_city := nullif(btrim(coalesce(private.json_text(v_filters, 'city'), '')), '');
  v_region := nullif(btrim(coalesce(private.json_text(v_filters, 'region'), '')), '');
  v_channel := private.json_text(v_filters, 'channel');
  if coalesce(jsonb_typeof(v_filters -> 'tag'), 'null') <> 'null' then
    v_tag := private.json_uuid(v_filters, 'tag');
  end if;
  -- An account manager: 'me', 'none' (no one) or a team member's user id.
  v_manager := private.json_text(v_filters, 'manager');
  if v_manager = 'me' then
    v_manager_id := auth.uid();
  elsif v_manager is not null and v_manager <> 'none' then
    v_manager_id := private.json_uuid(v_filters, 'manager');
  end if;
  v_onboarding := private.json_text(v_filters, 'onboarding');
  v_from := private.json_date(v_filters, 'from');
  v_to := private.json_date(v_filters, 'to');
  v_paid_from := private.json_date(v_filters, 'paid_from');
  v_paid_to := private.json_date(v_filters, 'paid_to');
  v_sort := coalesce(private.json_text(v_filters, 'sort'), 'created');
  v_dir := coalesce(private.json_text(v_filters, 'dir'),
    case when v_sort = 'name' then 'asc' else 'desc' end);
  v_page := case
    when coalesce(jsonb_typeof(v_filters -> 'page'), 'null') = 'null' then 1
    else private.json_int(v_filters, 'page')
  end;

  if length(v_q) > 80 then
    perform private.fail('INVALID_INPUT', 'q');
  end if;
  if v_state is not null and v_state not in (
    'suspended', 'read_only', 'trial', 'payment_failed', 'paid', 'cancelled'
  ) then
    perform private.fail('INVALID_INPUT', 'state');
  end if;
  if v_health is not null and v_health not in (
    'setting_up', 'never_started', 'inactive', 'slowing', 'active'
  ) then
    perform private.fail('INVALID_INPUT', 'health');
  end if;
  if v_channel is not null and v_channel not in (
    'website', 'website_lead', 'field_visit', 'referral', 'phone', 'whatsapp', 'social', 'other',
    'unknown'
  ) then
    perform private.fail('INVALID_INPUT', 'channel');
  end if;
  if v_onboarding is not null and v_onboarding not in ('open', 'stuck', 'done') then
    perform private.fail('INVALID_INPUT', 'onboarding');
  end if;
  if v_sort not in ('created', 'name', 'last_active', 'paid_till', 'gmv') then
    perform private.fail('INVALID_INPUT', 'sort');
  end if;
  if v_dir not in ('asc', 'desc') then
    perform private.fail('INVALID_INPUT', 'dir');
  end if;
  if v_page < 1 or v_page > 10000 then
    perform private.fail('INVALID_INPUT', 'page');
  end if;
  if v_from is not null and v_to is not null and v_to < v_from then
    perform private.fail('INVALID_INPUT', 'to');
  end if;
  if v_paid_from is not null and v_paid_to is not null and v_paid_to < v_paid_from then
    perform private.fail('INVALID_INPUT', 'paid_to');
  end if;
  if v_filters ? 'export' and private.json_bool(v_filters, 'export') then
    v_page := 1;
    v_page_size := 10000;
  end if;

  with base as (
    select
      r.id, r.name, r.slug, r.city, r.state as region, r.phone, r.status, r.created_at,
      r.acquisition_channel, r.timezone, r.business_day_start_hour,
      am.user_id as account_manager_user_id,
      p.code as plan_code, p.name as plan_name,
      s.status as subscription_status, s.billing_cycle, s.source, s.trial_ends_at,
      s.current_period_end,
      case when s.status = 'trialing' then s.trial_ends_at else s.current_period_end end
        as paid_till,
      -- Sorted by the day shown: a paid period's last day is the day before it ends.
      case when s.status = 'trialing' then s.trial_ends_at
        else s.current_period_end - interval '1 day' end as paid_last,
      s.cancel_at_period_end,
      case when v_state is not null then (
        select private.subscription_state(r.status::text, a.state, s.status::text, s.source::text)
        from public.restaurant_access(r.id) as a
      ) end as state
    from public.restaurants r
    left join public.restaurant_subscriptions s on s.restaurant_id = r.id
    left join public.plans p on p.id = s.plan_id
    left join public.restaurant_account_managers am on am.restaurant_id = r.id
    where (v_q is null
        or r.name ilike '%' || v_q || '%'
        or r.slug ilike '%' || v_q || '%'
        or r.city ilike '%' || v_q || '%')
      and (v_plan is null or p.code = v_plan)
      and (v_city is null or lower(r.city) = lower(v_city))
      and (v_region is null or lower(r.state) = lower(v_region))
      and (v_channel is null or coalesce(r.acquisition_channel, 'unknown') = v_channel)
      and (v_tag is null or exists (
        select 1 from public.restaurant_tags rt where rt.restaurant_id = r.id and rt.tag_id = v_tag
      ))
      and (v_manager is null
        or (v_manager = 'none' and am.user_id is null)
        or am.user_id = v_manager_id)
      and (v_from is null or r.created_at >= v_from::timestamp at time zone 'Asia/Kolkata')
      and (v_to is null or r.created_at < (v_to + 1)::timestamp at time zone 'Asia/Kolkata')
      -- A paid period ends at the start of the day after its last day, so its
      -- last day is a day earlier (the list shows that day too).
      and (v_paid_from is null
        or (case when s.status = 'trialing' then s.trial_ends_at
            else s.current_period_end - interval '1 day' end)
          >= v_paid_from::timestamp at time zone 'Asia/Kolkata')
      and (v_paid_to is null
        or (case when s.status = 'trialing' then s.trial_ends_at
            else s.current_period_end - interval '1 day' end)
          < (v_paid_to + 1)::timestamp at time zone 'Asia/Kolkata')
  ),
  -- Materialized: the onboarding is read three times below, worked out once.
  scored as materialized (
    select
      b.*,
      case when v_health is not null then private.restaurant_health(b.id, b.created_at) end
        as health,
      case when v_sort = 'last_active' then private.restaurant_last_active(b.id) end
        as last_active,
      case when v_sort = 'gmv' then (
        select u.gmv_30d_paise
        from private.restaurant_recent_usage(b.id, b.timezone, b.business_day_start_hour) as u
      ) end as gmv_30d,
      case when v_onboarding is not null then private.restaurant_onboarding(b.id) end
        as onboarding
    from base b
    where v_state is null or b.state = v_state
  ),
  matching as (
    select sc.* from scored sc
    where (v_health is null or sc.health = v_health)
      and (v_onboarding is null
        or (v_onboarding = 'open' and sc.onboarding ->> 'next' is not null)
        or (v_onboarding = 'stuck' and (sc.onboarding ->> 'stuck')::boolean)
        or (v_onboarding = 'done' and sc.onboarding ->> 'next' is null))
  ),
  page as (
    select m.*
    from matching m
    order by
      case when v_sort = 'name' and v_dir = 'asc' then lower(m.name) end asc,
      case when v_sort = 'name' and v_dir = 'desc' then lower(m.name) end desc,
      case when v_sort = 'last_active' and v_dir = 'asc' then m.last_active end asc nulls first,
      case when v_sort = 'last_active' and v_dir = 'desc' then m.last_active end desc nulls last,
      case when v_sort = 'paid_till' and v_dir = 'asc' then m.paid_last end asc nulls last,
      case when v_sort = 'paid_till' and v_dir = 'desc' then m.paid_last end desc nulls last,
      case when v_sort = 'gmv' and v_dir = 'asc' then m.gmv_30d end asc,
      case when v_sort = 'gmv' and v_dir = 'desc' then m.gmv_30d end desc,
      case when v_sort = 'created' and v_dir = 'asc' then m.created_at end asc,
      m.created_at desc,
      m.id
    limit v_page_size offset (v_page - 1) * v_page_size
  ),
  rows as (
    select
      pg.*,
      private.subscription_state(pg.status::text, a.state, pg.subscription_status::text,
        pg.source::text) as row_state,
      a.state as access_state,
      u.orders_7d,
      u.gmv_30d_paise as recent_gmv
    from page pg
    cross join lateral public.restaurant_access(pg.id) as a
    cross join lateral private.restaurant_recent_usage(
      pg.id, pg.timezone, pg.business_day_start_hour
    ) as u
  )
  select
    (select count(*) from matching),
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'restaurant_id', x.id,
        'name', x.name,
        'slug', x.slug,
        'city', x.city,
        'region', x.region,
        'phone', x.phone,
        'status', x.status,
        'created_at', x.created_at,
        'acquisition_channel', x.acquisition_channel,
        'plan_code', x.plan_code,
        'plan_name', x.plan_name,
        'billing_cycle', x.billing_cycle,
        'subscription_status', x.subscription_status,
        'state', x.row_state,
        'access_state', x.access_state,
        'paid_till', x.paid_till,
        'ending', coalesce(x.cancel_at_period_end, false),
        'health', coalesce(x.health, private.restaurant_health(x.id, x.created_at)),
        'last_active', coalesce(x.last_active, private.restaurant_last_active(x.id)),
        'gmv_30d_paise', coalesce(x.gmv_30d, x.recent_gmv),
        'orders_7d', to_jsonb(x.orders_7d),
        'onboarding', coalesce(x.onboarding, private.restaurant_onboarding(x.id)) - 'steps',
        'tags', coalesce((
          select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'colour', t.colour)
            order by lower(t.name))
          from public.restaurant_tags rt
          join public.platform_tags t on t.id = rt.tag_id
          where rt.restaurant_id = x.id
        ), '[]'::jsonb),
        'account_manager', (
          select u.email from auth.users u where u.id = x.account_manager_user_id
        ),
        'paid', case when v_money then (
          select jsonb_build_object(
            'subscription_paise', coalesce(sum(sp.base_paise) filter (where sp.purpose = 'subscription'), 0),
            'setup_fee_paise', coalesce(sum(sp.base_paise) filter (where sp.purpose = 'setup_fee'), 0),
            'gst_paise', coalesce(sum(sp.gst_paise), 0)
          )
          from public.subscription_payments sp
          where sp.restaurant_id = x.id
        ) end
      ) order by
        case when v_sort = 'name' and v_dir = 'asc' then lower(x.name) end asc,
        case when v_sort = 'name' and v_dir = 'desc' then lower(x.name) end desc,
        case when v_sort = 'last_active' and v_dir = 'asc' then x.last_active end asc nulls first,
        case when v_sort = 'last_active' and v_dir = 'desc' then x.last_active end desc nulls last,
        case when v_sort = 'paid_till' and v_dir = 'asc' then x.paid_last end asc nulls last,
        case when v_sort = 'paid_till' and v_dir = 'desc' then x.paid_last end desc nulls last,
        case when v_sort = 'gmv' and v_dir = 'asc' then x.gmv_30d end asc,
        case when v_sort = 'gmv' and v_dir = 'desc' then x.gmv_30d end desc,
        case when v_sort = 'created' and v_dir = 'asc' then x.created_at end asc,
        x.created_at desc,
        x.id)
      from rows x
    ), '[]'::jsonb)
  into v_total, v_rows;

  select
    coalesce((select jsonb_agg(c.city order by c.city) from (
      select distinct r.city from public.restaurants r where nullif(btrim(r.city), '') is not null
    ) as c), '[]'::jsonb),
    coalesce((select jsonb_agg(c.state order by c.state) from (
      select distinct r.state from public.restaurants r where nullif(btrim(r.state), '') is not null
    ) as c), '[]'::jsonb)
  into v_cities, v_regions;

  return jsonb_build_object(
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'rows', v_rows,
    'cities', v_cities,
    'regions', v_regions
  );
end;
$$;


-- ─── Activity: support requests ─────────────────────────────────────────────
-- A new request is an item (and so a live alert) for whoever works the inbox.

create or replace function private.activity(
  p_restaurant_id uuid,
  p_kinds text[],
  p_before_at timestamptz,
  p_before_key text,
  p_limit int,
  p_money boolean
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with params as (
    select
      coalesce(p_before_at, 'infinity'::timestamptz) as before_at,
      coalesce(p_before_key, '') as before_key,
      -- The newest snapshot day a lapse below the cursor can be on.
      coalesce((p_before_at at time zone 'Asia/Kolkata')::date,
        (now() at time zone 'Asia/Kolkata')::date) as lapse_to
  ),
  items as (
    (select k.kind, r.created_at as at, 'restaurant:' || r.id as key, r.id as restaurant_id,
      null::uuid as actor_id,
      jsonb_build_object('city', r.city, 'channel', r.acquisition_channel) as data
    from public.restaurants r
    cross join params pr
    cross join lateral (
      select case when exists (select 1 from public.trial_claims c where c.restaurant_id = r.id)
        then 'signup' else 'onboarded' end as kind
    ) as k
    where k.kind = any(p_kinds)
      and (p_restaurant_id is null or r.id = p_restaurant_id)
      and r.created_at <= pr.before_at
      and (r.created_at, 'restaurant:' || r.id) < (pr.before_at, pr.before_key)
    order by r.created_at desc, 'restaurant:' || r.id desc
    limit p_limit)
    union all
    (select 'payment', p.created_at, 'payment:' || p.id, p.restaurant_id, p.recorded_by,
      jsonb_build_object(
        'purpose', p.purpose,
        'method', case p.source
          when 'razorpay' then 'autopay'
          when 'payment_link' then 'payment_link'
          else p.manual_mode::text
        end,
        'base_paise', case when p_money then p.base_paise end,
        'gst_paise', case when p_money then p.gst_paise end
      )
    from public.subscription_payments p, params pr
    where 'payment' = any(p_kinds)
      and (p_restaurant_id is null or p.restaurant_id = p_restaurant_id)
      and p.created_at <= pr.before_at
      and (p.created_at, 'payment:' || p.id) < (pr.before_at, pr.before_key)
    order by p.created_at desc, 'payment:' || p.id desc
    limit p_limit)
    union all
    -- A Razorpay charge that failed: the webhook moved the subscription into
    -- retrying.
    (select 'payment_failed', a.created_at, 'audit:' || a.id, a.restaurant_id, null::uuid,
      jsonb_build_object('grace_until', a.after -> 'grace_until')
    from public.audit_logs a, params pr
    where 'payment_failed' = any(p_kinds)
      and a.action = 'subscription.razorpay_updated'
      and a.after ->> 'status' in ('past_due', 'halted')
      and coalesce(a.before ->> 'status', '') not in ('past_due', 'halted')
      and (p_restaurant_id is null or a.restaurant_id = p_restaurant_id)
      and a.created_at <= pr.before_at
      and (a.created_at, 'audit:' || a.id) < (pr.before_at, pr.before_key)
    order by a.created_at desc, 'audit:' || a.id desc
    limit p_limit)
    union all
    -- Became read-only for not paying, by the night's snapshot: at the end of
    -- that India day. Read-only days are walked newest first
    -- (metrics_subscription_daily_read_only_idx), each checked against the day
    -- before.
    (select 'lapsed', (m.day + 1)::timestamp at time zone 'Asia/Kolkata',
      'lapsed:' || m.restaurant_id || ':' || m.day, m.restaurant_id, null::uuid,
      jsonb_build_object('day', m.day, 'was', p.state)
    from public.metrics_subscription_daily m
    join public.metrics_subscription_daily p
      on p.restaurant_id = m.restaurant_id and p.day = m.day - 1
    cross join params pr
    where 'lapsed' = any(p_kinds)
      and m.state = 'read_only' and p.state <> 'read_only'
      and m.day <= pr.lapse_to
      and (p_restaurant_id is null or m.restaurant_id = p_restaurant_id)
      and ((m.day + 1)::timestamp at time zone 'Asia/Kolkata', 'lapsed:' || m.restaurant_id || ':' || m.day)
        < (pr.before_at, pr.before_key)
    order by m.day desc, m.restaurant_id desc
    limit p_limit)
    union all
    (select 'reminder', sr.sent_at, 'reminder:' || sr.id, sr.restaurant_id, null::uuid,
      jsonb_build_object('reminder', sr.kind)
    from public.subscription_reminders sr, params pr
    where 'reminder' = any(p_kinds)
      and (p_restaurant_id is null or sr.restaurant_id = p_restaurant_id)
      and sr.sent_at <= pr.before_at
      and (sr.sent_at, 'reminder:' || sr.id) < (pr.before_at, pr.before_key)
    order by sr.sent_at desc, 'reminder:' || sr.id desc
    limit p_limit)
    union all
    (select 'lead', l.created_at, 'lead:' || l.id, null::uuid, null::uuid,
      jsonb_build_object(
        'lead_id', l.id, 'name', l.name, 'restaurant_name', l.restaurant_name, 'city', l.city
      )
    from public.site_leads l, params pr
    where 'lead' = any(p_kinds) and p_restaurant_id is null
      and l.created_at <= pr.before_at
      and (l.created_at, 'lead:' || l.id) < (pr.before_at, pr.before_key)
    order by l.created_at desc, 'lead:' || l.id desc
    limit p_limit)
    union all
    (select 'menu_import', mi.completed_at, 'import:' || mi.id, mi.restaurant_id, mi.created_by,
      jsonb_build_object(
        'import_id', mi.id, 'status', mi.status, 'source', mi.source,
        'counts', mi.imported_counts
      )
    from public.menu_imports mi, params pr
    where 'menu_import' = any(p_kinds)
      and mi.status in ('imported', 'failed') and mi.completed_at is not null
      and (p_restaurant_id is null or mi.restaurant_id = p_restaurant_id)
      and mi.completed_at <= pr.before_at
      and (mi.completed_at, 'import:' || mi.id) < (pr.before_at, pr.before_key)
    order by mi.completed_at desc, 'import:' || mi.id desc
    limit p_limit)
    union all
    -- What the team did, less what the other kinds already show.
    (select 'team', a.created_at, 'audit:' || a.id, a.restaurant_id, a.actor_user_id,
      jsonb_build_object('action', a.action, 'reason', a.reason)
    from public.audit_logs a, params pr
    where 'team' = any(p_kinds)
      and a.actor_type = 'platform_admin'
      and a.action not in ('subscription.payment_recorded', 'restaurant.created', 'menu.imported')
      and coalesce(a.entity_type, '') <> 'restaurant_note'
      and (p_restaurant_id is null or a.restaurant_id = p_restaurant_id)
      and a.created_at <= pr.before_at
      and (a.created_at, 'audit:' || a.id) < (pr.before_at, pr.before_key)
    order by a.created_at desc, 'audit:' || a.id desc
    limit p_limit)
    union all
    -- The team's notes on a restaurant (SA-38): a note is itself the item,
    -- so its audit rows aren't team items too.
    (select 'note', n.created_at, 'note:' || n.id, n.restaurant_id, n.author_id,
      jsonb_build_object('note_id', n.id, 'body', left(n.body, 200), 'more', length(n.body) > 200,
        'pinned', n.pinned)
    from public.restaurant_notes n, params pr
    where 'note' = any(p_kinds)
      and (p_restaurant_id is null or n.restaurant_id = p_restaurant_id)
      and n.created_at <= pr.before_at
      and (n.created_at, 'note:' || n.id) < (pr.before_at, pr.before_key)
    order by n.created_at desc, 'note:' || n.id desc
    limit p_limit)
    union all
    (select 'support', q.created_at, 'support:' || q.id, q.restaurant_id, q.created_by,
      jsonb_build_object('request_id', q.id, 'topic', q.topic, 'message', left(q.message, 200),
        'more', length(q.message) > 200, 'name', q.created_by_name)
    from public.support_requests q, params pr
    where 'support' = any(p_kinds)
      and (p_restaurant_id is null or q.restaurant_id = p_restaurant_id)
      and q.created_at <= pr.before_at
      and (q.created_at, 'support:' || q.id) < (pr.before_at, pr.before_key)
    order by q.created_at desc, 'support:' || q.id desc
    limit p_limit)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'key', t.key,
    'kind', t.kind,
    'at', t.at,
    'restaurant_id', t.restaurant_id,
    'restaurant_name', r.name,
    'actor', u.email,
    'data', t.data
  ) order by t.at desc, t.key desc), '[]'::jsonb)
  from (select * from items i order by i.at desc, i.key desc limit p_limit) as t
  left join public.restaurants r on r.id = t.restaurant_id
  left join auth.users u on u.id = t.actor_id;
$$;

create or replace function private.activity_kinds(p_kinds text[])
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_all constant text[] := array['signup', 'onboarded', 'payment', 'payment_failed', 'lapsed',
    'reminder', 'lead', 'menu_import', 'team', 'note', 'support'];
  v_kinds text[] := coalesce(p_kinds, v_all);
begin
  if not v_kinds <@ v_all then
    perform private.fail('INVALID_INPUT', 'kinds');
  end if;
  if not private.has_platform_permission('money.view') then
    v_kinds := array_remove(array_remove(v_kinds, 'payment'), 'payment_failed');
  end if;
  if not private.has_platform_permission('growth.manage') then
    v_kinds := array_remove(v_kinds, 'lead');
  end if;
  if not private.has_platform_permission('restaurants.support') then
    v_kinds := array_remove(v_kinds, 'support');
  end if;
  if not private.has_platform_permission('audit.view') then
    v_kinds := array_remove(v_kinds, 'team');
  end if;
  return v_kinds;
end;
$$;

create or replace function public.platform_alerts()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.view');
  v_money boolean := private.has_platform_permission('money.view');
  v_seen timestamptz;
  v_items jsonb;
begin
  select coalesce(a.alerts_seen_at, a.created_at) into v_seen
  from public.platform_admins a
  where a.user_id = v_admin.user_id;

  -- Signups only: restaurants the team made are no news to it.
  v_items := private.activity(
    null,
    private.activity_kinds(array['signup', 'payment', 'payment_failed', 'lead', 'support']),
    null, null, 50, v_money
  );
  return jsonb_build_object(
    'seen_at', v_seen,
    'unread', (
      select count(*) from jsonb_array_elements(v_items) as e where (e ->> 'at')::timestamptz > v_seen
    ),
    'items', coalesce((
      select jsonb_agg(e order by n) from jsonb_array_elements(v_items) with ordinality as x(e, n)
      where n <= 10
    ), '[]'::jsonb),
    'attention', private.attention(
      v_admin.user_id, v_money,
      private.has_platform_permission('growth.manage'),
      private.has_platform_permission('system.view')
    ) -> 'total'
  );
end;
$$;


-- ─── Needs attention: stuck onboarding, waiting support requests ────────────
-- Restaurants of the last 60 days, with full access, stuck before paying
-- (paying is Dues' and the trial's business); requests open or in progress
-- for more than a day, for whoever works the inbox (SA-44).

create or replace function private.attention(
  p_admin uuid,
  p_money boolean,
  p_growth boolean,
  p_system boolean,
  p_limit int default 5
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
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
    -- ponytail: leads received in the last day until leads get a status (13d).
    select 'new_leads', l.id::text, -extract(epoch from l.created_at),
      jsonb_build_object(
        'lead_id', l.id, 'name', l.name, 'restaurant_name', l.restaurant_name,
        'city', l.city, 'phone', l.phone, 'created_at', l.created_at
      )
    from public.site_leads l
    where p_growth and l.created_at >= now() - interval '24 hours'
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
      select x.* from (
        select r.id, r.name, r.slug, r.city, r.phone, private.restaurant_onboarding(r.id) as ob
        from public.restaurants r
        where r.status = 'active' and r.created_at >= now() - interval '60 days'
        offset 0 -- once a restaurant, not once a mention
      ) as x
      where (x.ob ->> 'stuck')::boolean and x.ob ->> 'next' <> 'paid'
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
$$;

create or replace function public.platform_snooze(p_key text, p_days int)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin private.platform_admin_context := private.require_platform_permission('restaurants.view');
  v_until timestamptz;
begin
  if p_days is null or p_days not in (1, 3, 7) then
    perform private.fail('INVALID_INPUT', 'days');
  end if;
  if p_key is null or p_key !~ ('^(payment_failed|trial_ending|needs_payment|new_leads|inactive'
      || '|slowing|duplicates|webhooks|cron|stuck_onboarding|support_open)'
      || ':[A-Za-z0-9 _.:-]{1,100}$') then
    perform private.fail('INVALID_INPUT', 'key');
  end if;
  delete from public.platform_snoozes z where z.admin_id = v_admin.user_id and z.until <= now();
  insert into public.platform_snoozes (admin_id, item_key, until)
  values (v_admin.user_id, p_key, now() + make_interval(days => p_days))
  on conflict (admin_id, item_key) do update set until = excluded.until, created_at = now()
  returning until into v_until;
  return v_until;
end;
$$;
