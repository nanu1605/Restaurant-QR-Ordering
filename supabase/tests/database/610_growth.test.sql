-- The leads pipeline, unfinished signups, the funnel, upgrade opportunities
-- and "Found us" edited by the team (docs/SUPER_ADMIN_PLAN.md 13d;
-- docs/DECISIONS.md SA-53 to SA-60). Restaurants here are named sa610-*,
-- mobiles are 98100 006xx.
begin;
select no_plan();

select tests.create_platform_admin('platform610@admin.test') as admin \gset
select tests.create_platform_admin('platform610b@admin.test') as admin_b \gset
select tests.create_restaurant('sa610-home') as home \gset
select tests.add_member(:'home', 'owner', 'sa610_owner') as owner \gset

-- ─── A demo request from the website ────────────────────────────────────────
select tests.as_service_role();
select public.site_create_lead(jsonb_build_object(
  'name', 'Asha', 'restaurant_name', 'Sa610 Website Cafe', 'city', 'Indore',
  'phone', '9810000601'
)) as web_lead \gset
select tests.clear_auth();
select is(
  (select row(channel, stage, assignee_id, restaurant_id, created_by)::text
   from public.site_leads where id = :'web_lead'),
  '(website_lead,new,,,)',
  'a website lead: a demo request, new, no one on it'
);

-- ─── Added by hand ──────────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_create_lead(jsonb_build_object(
  'name', ' Ravi  Kumar ', 'restaurant_name', 'Sa610 Field Dhaba', 'city', 'Bhopal',
  'phone', '+91 98100 00602', 'email', ' Ravi@Example.TEST ', 'channel', 'field_visit',
  'stage', 'contacted', 'message', 'Met at the market.', 'assignee', :'admin_b'
)) as field_lead \gset
select is(
  (select row(name, phone, email, channel, stage, assignee_id = :'admin_b', created_by = :'admin',
     message)::text
   from public.site_leads where id = :'field_lead'),
  '("Ravi Kumar",9810000602,ravi@example.test,field_visit,contacted,t,t,"Met at the market.")',
  'tidied, the mobile''s 10 digits, the channel, stage and assignee chosen, who added it'
);
select tests.clear_auth();
update public.site_leads set created_at = now() - interval '1 day' where id = :'field_lead';
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_create_lead(jsonb_build_object(
  'name', 'Meena', 'restaurant_name', 'Sa610 Call Cafe', 'city', 'Pune',
  'phone', '9810000603', 'channel', 'phone'
)) as call_lead \gset
select is((select stage from public.site_leads where id = :'call_lead'), 'new', 'new by default');

select throws_ok(
  format('select public.platform_create_lead(%L)', jsonb_build_object(
    'name', 'X', 'restaurant_name', 'X', 'city', 'X', 'phone', '9810000699',
    'channel', 'website_lead')),
  'P0001', 'INVALID_INPUT', 'demo requests come from the website only'
);
select throws_ok(
  format('select public.platform_create_lead(%L)', jsonb_build_object(
    'name', 'X', 'restaurant_name', 'X', 'city', 'X', 'phone', '9810000699',
    'channel', 'referral', 'stage', 'trial')),
  'P0001', 'INVALID_INPUT', 'new or contacted only'
);
select throws_ok(
  format('select public.platform_create_lead(%L)', jsonb_build_object(
    'name', 'X', 'restaurant_name', 'X', 'city', 'X', 'phone', '98100', 'channel', 'referral')),
  'P0001', 'INVALID_INPUT', 'a whole mobile'
);
select throws_ok(
  format('select public.platform_create_lead(%L)', jsonb_build_object(
    'name', repeat('x', 81), 'restaurant_name', 'X', 'city', 'X', 'phone', '9810000699',
    'channel', 'referral')),
  'P0001', 'INVALID_INPUT', 'names fit'
);
select throws_ok(
  format('select public.platform_create_lead(%L)', jsonb_build_object(
    'name', 'X', 'restaurant_name', 'X', 'city', 'X', 'phone', '9810000699',
    'channel', 'referral', 'assignee', gen_random_uuid())),
  'P0001', 'ADMIN_NOT_FOUND', 'the assignee is on the team'
);
select throws_ok(
  $$select public.platform_create_lead('{"name": "X", "colour": "red"}')$$,
  'P0001', 'INVALID_INPUT', 'no other fields'
);

-- ─── Working a lead ─────────────────────────────────────────────────────────
select public.platform_update_lead(:'call_lead', '{"stage": "contacted"}');
select throws_ok(
  format('select public.platform_update_lead(%L, %L)', :'call_lead', '{"stage": "lost"}'),
  'P0001', 'INVALID_INPUT', 'lost needs a reason'
);
select throws_ok(
  format('select public.platform_update_lead(%L, %L)', :'call_lead',
    '{"stage": "lost", "lost_reason": "weather"}'),
  'P0001', 'INVALID_INPUT', 'one of the reasons'
);
select public.platform_update_lead(:'call_lead', '{"stage": "lost", "lost_reason": "price"}');
select is((select row(stage, lost_reason)::text from public.site_leads where id = :'call_lead'),
  '(lost,price)', 'lost, and why');
select public.platform_update_lead(:'call_lead', '{"stage": "lost", "lost_reason": "no_response"}');
select is((select lost_reason from public.site_leads where id = :'call_lead'), 'no_response',
  'another reason');
select public.platform_update_lead(:'call_lead', '{"stage": "demo_scheduled"}');
select is((select row(stage, lost_reason)::text from public.site_leads where id = :'call_lead'),
  '(demo_scheduled,)', 'back in the pipeline, the reason goes');

select public.platform_update_lead(:'call_lead', jsonb_build_object(
  'assignee', :'admin', 'follow_up_at', '2030-01-02T10:30:00+05:30',
  'demo_at', '2030-01-03T16:00+05:30'));
select is(
  (select row(assignee_id = :'admin', follow_up_at, demo_at)::text
   from public.site_leads where id = :'call_lead'),
  (select row(true, '2030-01-02 05:00:00+00'::timestamptz, '2030-01-03 10:30:00+00'::timestamptz)::text),
  'an assignee, and times with their offset'
);
select throws_ok(
  format('select public.platform_update_lead(%L, %L)', :'call_lead',
    '{"follow_up_at": "2030-01-02T10:30"}'),
  'P0001', 'INVALID_INPUT', 'a time needs its offset'
);
select throws_ok(
  format('select public.platform_update_lead(%L, %L)', :'call_lead',
    '{"follow_up_at": "2030-13-02T10:30:00Z"}'),
  'P0001', 'INVALID_INPUT', 'a real time'
);
select throws_ok(
  format('select public.platform_update_lead(%L, %L)', :'call_lead',
    '{"demo_at": "2099-01-01T10:00:00Z"}'),
  'P0001', 'INVALID_INPUT', 'not years ahead'
);
select throws_ok(
  format('select public.platform_update_lead(%L, %L)', :'call_lead',
    jsonb_build_object('assignee', gen_random_uuid())),
  'P0001', 'ADMIN_NOT_FOUND', 'the assignee is on the team'
);
select throws_ok(
  format('select public.platform_update_lead(%L, %L)', gen_random_uuid(), '{"stage": "won"}'),
  'P0001', 'NOT_FOUND', 'no such lead'
);

select count(*) as events_before from public.lead_events where lead_id = :'call_lead' \gset
select public.platform_update_lead(:'call_lead', jsonb_build_object(
  'stage', 'demo_scheduled', 'assignee', :'admin', 'follow_up_at', '2030-01-02T05:00:00Z'));
select is((select count(*) from public.lead_events where lead_id = :'call_lead'),
  :'events_before'::bigint, 'nothing changed, nothing written');
select public.platform_update_lead(:'call_lead', '{"follow_up_at": null}');
select is((select follow_up_at from public.site_leads where id = :'call_lead'), null,
  'the follow-up cleared');

select is(
  array(select kind || ':' || coalesce(from_value, '-') || '>' || coalesce(to_value, '-')
        from public.lead_events
        where lead_id = :'call_lead' and kind = 'stage' order by created_at),
  array['stage:new>contacted', 'stage:contacted>lost:price', 'stage:lost:price>lost:no_response',
    'stage:lost:no_response>demo_scheduled'],
  'each stage change in order, a lost one with its reason'
);
select is(
  (select bool_and(actor_id = :'admin' and not automatic) from public.lead_events
   where lead_id = :'call_lead'),
  true, 'by the admin, by hand'
);

-- Notes.
select ok(public.platform_add_lead_note(:'call_lead', '  Call after 4 pm.  ') is not null,
  'a note');
select is(
  (select body from public.lead_events where lead_id = :'call_lead' and kind = 'note'),
  'Call after 4 pm.', 'trimmed'
);
select throws_ok(format('select public.platform_add_lead_note(%L, %L)', :'call_lead', ' '),
  'P0001', 'INVALID_INPUT', 'not empty');
select throws_ok(format('select public.platform_add_lead_note(%L, %L)', gen_random_uuid(), 'Hi'),
  'P0001', 'NOT_FOUND', 'no such lead');

-- ─── Linking by hand ────────────────────────────────────────────────────────
select public.platform_update_lead(:'field_lead', '{"restaurant_code": "SA610-HOME"}');
select is(
  (select row(restaurant_id = :'home', stage)::text from public.site_leads where id = :'field_lead'),
  '(t,trial)', 'linked by its code; it moves on to Trial'
);
select is(
  array(select kind || ':' || automatic::text from public.lead_events
        where lead_id = :'field_lead' order by created_at),
  array['restaurant:false', 'stage:false'], 'the link and the move, by the admin'
);
select throws_ok(
  format('select public.platform_update_lead(%L, %L)', :'field_lead',
    '{"restaurant_code": "sa610-nowhere"}'),
  'P0001', 'RESTAURANT_NOT_FOUND', 'a restaurant that exists'
);
select public.platform_update_lead(:'field_lead', '{"restaurant_code": null}');
select is(
  (select row(restaurant_id, stage)::text from public.site_leads where id = :'field_lead'),
  '(,trial)', 'unlinked; the stage stays'
);

-- One lead.
select public.platform_get_lead(:'call_lead') as got \gset
select is((:'got'::jsonb) ->> 'message', null, 'no message: added by hand without one');
select is((:'got'::jsonb) ->> 'created_by', 'platform610@admin.test', 'who added it');
select is((:'got'::jsonb) ->> 'assignee', 'platform610@admin.test', 'who is on it');
select is(
  (select array_agg(e ->> 'kind' order by n)
   from jsonb_array_elements((:'got'::jsonb) -> 'events') with ordinality as x(e, n)),
  array['stage', 'stage', 'stage', 'stage', 'assignee', 'follow_up', 'demo', 'follow_up', 'note'],
  'the history, oldest first'
);
select is(
  (select e ->> 'to_label' from jsonb_array_elements((:'got'::jsonb) -> 'events') as e
   where e ->> 'kind' = 'assignee'),
  'platform610@admin.test', 'assignees by email'
);
select throws_ok(format('select public.platform_get_lead(%L)', gen_random_uuid()),
  'P0001', 'NOT_FOUND', 'no such lead');
select tests.clear_auth();

-- ─── Matches by mobile ──────────────────────────────────────────────────────
update public.restaurants set phone = '+91 98100 00602' where id = :'home';
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_create_lead(jsonb_build_object(
  'name', 'Ravi again', 'restaurant_name', 'Sa610 Field Dhaba', 'city', 'Bhopal',
  'phone', '9810000602', 'channel', 'referral'
)) as again \gset
select public.platform_get_lead(:'again') as got \gset
select is(
  (select array_agg(r ->> 'slug') from jsonb_array_elements((:'got'::jsonb) -> 'matches' -> 'restaurants') r),
  array['sa610-home'], 'the restaurant with this mobile'
);
select is(
  (select array_agg(l ->> 'id') from jsonb_array_elements((:'got'::jsonb) -> 'matches' -> 'leads') l),
  array[:'field_lead'], 'the other lead with it, not this one'
);
select is(
  public.platform_lead_matches('098100 00602') -> 'leads' -> 0 ->> 'id', :'again',
  'before adding: newest lead first, any way the mobile is written'
);
select is(public.platform_lead_matches('12'),
  '{"leads": [], "restaurants": []}'::jsonb, 'no mobile, no matches');
select is((select restaurant_id from public.site_leads where id = :'again'), null,
  'a lead added for a restaurant that exists is not linked by itself');
select tests.clear_auth();

-- ─── Linked and won automatically ───────────────────────────────────────────
-- A demo request, a lost lead and a won lead with one mobile, then the
-- restaurant signs up.
select tests.create_user('self610@example.test') as self_owner \gset
insert into public.site_leads (name, restaurant_name, city, phone, created_at)
values ('Sa610 First', 'Sa610 Auto Cafe', 'Indore', '9810000610', now() - interval '3 days')
returning id as auto_web \gset
insert into public.site_leads (name, restaurant_name, city, phone, channel, stage, lost_reason,
  created_at)
values ('Sa610 Lost', 'Sa610 Auto Cafe', 'Indore', '9810000610', 'phone', 'lost', 'no_response',
  now() - interval '2 days')
returning id as auto_lost \gset
insert into public.site_leads (name, restaurant_name, city, phone, channel, stage, created_at)
values ('Sa610 Won', 'Sa610 Auto Cafe', 'Indore', '9810000610', 'referral', 'won',
  now() - interval '1 day')
returning id as auto_won \gset
insert into public.site_leads (name, restaurant_name, city, phone)
values ('Sa610 Other', 'Sa610 Other Cafe', 'Indore', '9810000611')
returning id as other_lead \gset

select tests.as_service_role();
select public.site_signup_create_restaurant(jsonb_build_object(
  'name', 'Sa610 Auto Cafe', 'slug', 'sa610-auto', 'phone', '+91 98100 00610',
  'fssai_license', '29999999999610', 'storefront_photo_path', 'signups/' || gen_random_uuid() || '.jpg',
  'owner', jsonb_build_object('user_id', :'self_owner', 'display_name', 'Asha', 'username', 'owner')
)) ->> 'restaurant_id' as auto \gset
select tests.clear_auth();

select is(
  array(select row(name, restaurant_id = :'auto', stage, lost_reason)::text
        from public.site_leads where phone = '9810000610' order by created_at, id),
  array['("Sa610 First",t,trial,)', '("Sa610 Lost",t,trial,)', '("Sa610 Won",t,won,)'],
  'every lead with the mobile linked; on to Trial, a lost one too; a won one stays won'
);
select is((select restaurant_id from public.site_leads where id = :'other_lead'), null,
  'another mobile''s lead untouched');
select is(
  (select array_agg(kind order by created_at) from public.lead_events
   where lead_id = :'auto_web' and automatic and actor_id is null),
  array['restaurant', 'stage'], 'done automatically'
);
select is((select acquisition_channel from public.restaurants where id = :'auto'), 'website_lead',
  'found us: the first lead''s way, a demo request');

-- A setup fee wins nothing; the first subscription payment wins them.
insert into public.subscription_payments (restaurant_id, source, amount_paise, manual_mode, purpose,
  notes)
values (:'auto', 'manual', 58882, 'upi', 'setup_fee', 'Setup fee');
select is((select stage from public.site_leads where id = :'auto_web'), 'trial',
  'a setup fee is not a win');
insert into public.subscription_payments (restaurant_id, source, amount_paise, manual_mode)
values (:'auto', 'manual', 106082, 'upi');
select is(
  array(select stage from public.site_leads where phone = '9810000610' order by created_at, id),
  array['won', 'won', 'won'], 'the first subscription payment wins them'
);
select is(
  (select count(*)::int from public.lead_events
   where lead_id = :'auto_web' and kind = 'stage' and to_value = 'won' and automatic),
  1, 'once, automatically'
);

-- Linking by hand to a restaurant that has paid: straight to Won.
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_update_lead(:'other_lead', '{"restaurant_code": "sa610-auto"}');
select is((select stage from public.site_leads where id = :'other_lead'), 'won',
  'linked to a paying restaurant: won');
select tests.clear_auth();

-- A field visit first, a website demo request later: the field visit found them.
select tests.create_user('self610b@example.test') as self_b \gset
insert into public.site_leads (name, restaurant_name, city, phone, channel, created_at)
values ('Sa610 Visit', 'Sa610 Visit Cafe', 'Indore', '9810000612', 'field_visit',
  now() - interval '5 days');
insert into public.site_leads (name, restaurant_name, city, phone)
values ('Sa610 Visit web', 'Sa610 Visit Cafe', 'Indore', '9810000612');
select tests.as_service_role();
select public.site_signup_create_restaurant(jsonb_build_object(
  'name', 'Sa610 Visit Cafe', 'slug', 'sa610-visit', 'phone', '9810000612',
  'fssai_license', '29999999999612', 'storefront_photo_path', 'signups/' || gen_random_uuid() || '.jpg',
  'owner', jsonb_build_object('user_id', :'self_b', 'display_name', 'B', 'username', 'owner')
)) ->> 'restaurant_id' as visit \gset
select tests.clear_auth();
select is((select acquisition_channel from public.restaurants where id = :'visit'), 'field_visit',
  'found us: the earliest lead''s channel');

-- ─── The list and the board ─────────────────────────────────────────────────
-- Only this file's leads: the q filter keeps the rest of the database out.
select tests.authenticate_as_platform_admin(:'admin');
create function pg_temp.names(p jsonb) returns text[] language sql as $$
  select coalesce(array_agg(r ->> 'name' order by n), '{}')
  from jsonb_array_elements(p -> 'rows') with ordinality as x(r, n);
$$;
select public.platform_update_lead(:'web_lead', '{"follow_up_at": "2021-01-01T00:00:00Z"}');
select public.platform_update_lead(:'call_lead', '{"follow_up_at": "2030-01-02T10:30:00+05:30"}');

select public.platform_list_leads('{"q": "sa610"}') as list \gset
select is((:'list'::jsonb) -> 'counts',
  '{"all": 10, "new": 2, "won": 4, "lost": 0, "open": 6, "trial": 3, "contacted": 0,
    "demo_done": 0, "demo_scheduled": 1}'::jsonb,
  'counts by stage, with the other filters');
select is((:'list'::jsonb) ->> 'total', '6', 'open by default: New to Trial');
select is((pg_temp.names(:'list'))[1:2], array['Asha', 'Meena'],
  'follow-ups first, the earliest first');
select is(
  pg_temp.names(public.platform_list_leads('{"q": "sa610", "due": "overdue"}')),
  array['Asha'], 'follow-ups overdue'
);
select is(
  pg_temp.names(public.platform_list_leads('{"q": "sa610", "due": "today"}')),
  array['Asha'], 'follow-ups due by the end of today, India time'
);
select is(
  (select array_agg(x order by x) from unnest(pg_temp.names(
    public.platform_list_leads('{"q": "sa610", "stage": "won"}'))) x),
  array['Sa610 First', 'Sa610 Lost', 'Sa610 Other', 'Sa610 Won'], 'one stage'
);
select is(public.platform_list_leads('{"q": "sa610", "stage": "all"}') ->> 'total', '10',
  'every stage');
select is(
  (select array_agg(distinct r ->> 'more')
   from jsonb_array_elements(public.platform_list_leads('{"q": "sa610", "stage": "all"}') -> 'rows') r),
  array['false'], 'no long messages: nothing more, with or without one');
select is(
  pg_temp.names(public.platform_list_leads('{"q": "sa610", "assignee": "me"}')),
  array['Meena'], 'mine'
);
select is(
  public.platform_list_leads(jsonb_build_object('q', 'sa610', 'assignee', :'admin_b')) ->> 'total',
  '1', 'one team member''s'
);
select is(
  public.platform_list_leads('{"q": "sa610", "stage": "all", "assignee": "none"}') ->> 'total',
  '8', 'no one''s'
);
select is(
  public.platform_list_leads('{"q": "sa610", "channel": "field_visit"}') ->> 'total', '2',
  'by channel'
);
select is(pg_temp.names(public.platform_list_leads('{"q": "100 00603"}')), array['Meena'],
  'by part of the mobile');
select is(
  (select array_agg(x order by x) from unnest(pg_temp.names(
    public.platform_list_leads('{"q": "bhopal", "stage": "all"}'))) x),
  array['Ravi again', 'Ravi Kumar'], 'by city');
select is(
  (select array_agg(distinct r ->> 'stage' order by r ->> 'stage')
   from jsonb_array_elements(public.platform_list_leads('{"q": "sa610", "board": true}') -> 'rows') r),
  array['demo_scheduled', 'new', 'trial'], 'the board: open stages only'
);
select ok(
  jsonb_array_length(public.platform_list_leads('{"board": true}') -> 'rows') <= 5 * 30,
  'the board: up to 30 a stage');
select is(public.platform_list_leads('{"q": "sa610", "page": 2}') -> 'rows', '[]'::jsonb,
  'past the last page: nothing');
select throws_ok($$select public.platform_list_leads('{"stage": "maybe"}')$$,
  'P0001', 'INVALID_INPUT', 'a known stage');
select throws_ok(format('select public.platform_list_leads(%L)', jsonb_build_object('q', repeat('x', 81))),
  'P0001', 'INVALID_INPUT', 'a short search');
select throws_ok($$select public.platform_list_leads('{"sort": "name"}')$$,
  'P0001', 'INVALID_INPUT', 'no other filters');
select tests.clear_auth();

-- ─── A second outlet, a second payment ─────────────────────────────────────
-- A team-onboarded restaurant with the same mobile takes only the lead that
-- came in since; the others stay with the first.
insert into public.site_leads (name, restaurant_name, city, phone)
values ('Sa610 Later', 'Sa610 Auto Cafe 2', 'Indore', '9810000610') returning id as later \gset
select tests.create_user('outlet610@example.test') as outlet_owner \gset
select tests.as_service_role();
select public.platform_create_restaurant(jsonb_build_object(
  'name', 'Sa610 Auto Cafe 2', 'slug', 'sa610-outlet', 'phone', '+91 98100 00610',
  'actor_user_id', :'admin', 'acquisition_channel', 'referral',
  'owner', jsonb_build_object('user_id', :'outlet_owner', 'display_name', 'Asha', 'username', 'owner')
)) ->> 'restaurant_id' as outlet \gset
select tests.clear_auth();
select is(
  array(select row(name, restaurant_id = :'outlet', stage)::text
        from public.site_leads where phone = '9810000610' order by created_at, id),
  array['("Sa610 First",f,won)', '("Sa610 Lost",f,won)', '("Sa610 Won",f,won)',
    '("Sa610 Later",t,trial)'],
  'the onboarded outlet takes the new lead, not the ones already linked'
);
select is(
  (select count(*)::int from public.lead_events where lead_id = :'auto_web' and kind = 'restaurant'),
  1, 'linked once'
);

-- The team moves a won lead back; the next payment leaves it there.
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_update_lead(:'auto_web', '{"stage": "demo_done"}');
select tests.clear_auth();
insert into public.subscription_payments (restaurant_id, source, amount_paise, manual_mode)
values (:'auto', 'manual', 106082, 'upi');
select is((select stage from public.site_leads where id = :'auto_web'), 'demo_done',
  'only the first subscription payment wins a lead');

-- ─── Needs attention: not contacted in 24 hours ─────────────────────────────
-- This file's leads only: every other new lead is contacted for the test.
update public.site_leads set stage = 'contacted'
where stage = 'new' and restaurant_name not like 'Sa610%';
update public.site_leads set created_at = now() - interval '23 hours' where id = :'web_lead';
insert into public.site_leads (name, restaurant_name, city, phone, created_at)
values ('Sa610 Waiting', 'Sa610 Waiting Cafe', 'Indore', '9810000630', now() - interval '25 hours');
insert into public.site_leads (name, restaurant_name, city, phone, stage, created_at)
values ('Sa610 Called', 'Sa610 Called Cafe', 'Indore', '9810000631', 'contacted',
  now() - interval '25 hours');
select private.attention(:'admin', true, true, true, 50) as att \gset
select is(
  (select array_agg(i -> 'data' ->> 'name' order by n)
   from jsonb_array_elements((:'att'::jsonb) -> 'groups') g,
     jsonb_array_elements(g -> 'items') with ordinality as x(i, n)
   where g ->> 'group' = 'new_leads'),
  array['Sa610 Waiting'],
  'new and more than 24 hours old; not one 23 hours old or one contacted'
);
select is(
  (select count(*) from jsonb_array_elements(private.attention(:'admin', true, false, true) -> 'groups') g
   where g ->> 'group' = 'new_leads'), 0::bigint, 'only for growth.manage'
);

-- ─── Unfinished signups ─────────────────────────────────────────────────────
insert into public.site_signups (email, details, code_hash, created_at) values
  ('a@sa610.test', '{"ownerName": "A", "phone": "9810000640", "restaurantName": "A Cafe", "city": "Indore", "planCode": "starter", "cycle": "monthly"}',
    repeat('0', 64), now() - interval '2 hours'),
  ('locked@sa610.test', '{"phone": "9810000641"}', repeat('0', 64), now() - interval '1 hour'),
  ('done@sa610.test', '{"phone": "9810000642"}', repeat('0', 64), now() - interval '3 days'),
  ('twice@sa610.test', '{"phone": "9810000643"}', repeat('0', 64), now() - interval '2 days'),
  ('twice@sa610.test', '{"phone": "9810000643"}', repeat('0', 64), now() - interval '30 minutes'),
  ('has-restaurant@sa610.test', '{"phone": "9810000610"}', repeat('0', 64), now() - interval '1 hour'),
  ('self610@example.test', '{"phone": "9810000644"}', repeat('0', 64), now() - interval '1 hour');
update public.site_signups set tries = 5 where email = 'locked@sa610.test';
insert into public.site_signups (email, details, code_hash, verified_at)
values ('done@sa610.test', '{"phone": "9810000642"}', repeat('0', 64), now());
update public.site_signups set sends = 2, expires_at = now() - interval '1 minute'
where email = 'twice@sa610.test' and created_at > now() - interval '1 hour';
insert into public.site_leads (name, restaurant_name, city, phone)
values ('Sa610 Signup lead', 'A Cafe', 'Indore', '9810000640') returning id as signup_lead \gset

select tests.authenticate_as_platform_admin(:'admin');
select public.platform_unfinished_signups() as unf \gset
create temp table unf as
select r from jsonb_array_elements((:'unf'::jsonb) -> 'rows') r where r ->> 'email' like '%sa610%';
select is(
  (select array_agg((r ->> 'email') || ':' || (r ->> 'step') order by r ->> 'email') from unf),
  array['a@sa610.test:code_sent', 'locked@sa610.test:locked', 'twice@sa610.test:expired'],
  'the latest per email and its step; not a finished one, one whose mobile has a restaurant, or one with a login'
);
select is(
  (select row(r ->> 'owner_name', r ->> 'phone', r ->> 'restaurant_name', r ->> 'city',
     r ->> 'plan_code', r ->> 'lead_id', (r ->> 'deleted_at')::timestamptz - (r ->> 'created_at')::timestamptz)::text
   from unf where r ->> 'email' = 'a@sa610.test'),
  format('(A,9810000640,"A Cafe",Indore,starter,%s,"7 days")', :'signup_lead'),
  'contact as collected, the lead with its mobile, and when the row goes'
);
select tests.clear_auth();

-- ─── Funnel ─────────────────────────────────────────────────────────────────
-- February 2020, India time: no other data is that old.
select tests.create_restaurant('sa610-f-sig') as f_sig \gset
select tests.create_restaurant('sa610-f-team') as f_team \gset
select tests.create_restaurant('sa610-f-unknown') as f_unknown \gset
select tests.create_restaurant('sa610-f-out') as f_out \gset
update public.restaurants set created_at = '2020-02-10 12:00+05:30', acquisition_channel = 'website',
  signup_source = '{"utm_source": "google"}' where id = :'f_sig';
update public.restaurants set created_at = '2020-02-15 10:00+05:30', acquisition_channel = 'field_visit'
where id = :'f_team';
update public.restaurants set created_at = '2020-02-29 23:00+05:30' where id = :'f_unknown';
update public.restaurants set created_at = '2020-03-01 00:30+05:30', acquisition_channel = 'website'
where id = :'f_out';
insert into public.trial_claims (kind, value, restaurant_id) values ('phone', '9810000650', :'f_sig');
-- An accepted order and a subscription payment; then paying monthly.
select tests.create_full_fixture(:'f_sig');
update public.restaurant_subscriptions
set status = 'active', source = 'manual', billing_cycle = 'monthly', trial_ends_at = null,
  current_period_start = now(), current_period_end = now() + interval '30 days'
where restaurant_id = :'f_sig';
insert into public.site_leads (name, restaurant_name, city, phone, source, created_at) values
  ('Sa610 Feb web', 'X', 'Indore', '9810000651', '{"referrer": "news.example"}', '2020-02-05 09:00+05:30'),
  ('Sa610 Jan web', 'X', 'Indore', '9810000652', null, '2020-01-31 23:59+05:30');
insert into public.site_leads (name, restaurant_name, city, phone, channel, created_at)
values ('Sa610 Feb visit', 'X', 'Indore', '9810000653', 'field_visit', '2020-02-06 09:00+05:30');
insert into public.metrics_platform_daily (day, signups_started)
select d::date, case d::date when '2020-02-10' then 3 when '2020-02-20' then 2 else 0 end
from generate_series('2020-02-03'::date, '2020-02-29'::date, interval '1 day') d
on conflict (day) do update set signups_started = excluded.signups_started;

select private.monthly_paise(p, 'monthly') as growth_monthly from public.plans p where p.code = 'growth' \gset
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_funnel('2020-02-01', '2020-02-29') as fun \gset
select is(
  (select row(f ->> 'demo_requests', f ->> 'signups_started', f ->> 'signups_counted_from')::text
   from (select :'fun'::jsonb as f) x),
  '(1,5,2020-02-03)',
  'demo requests from the website in the range; signups started from the snapshots, which start on the 3rd'
);
select is((:'fun'::jsonb) -> 'cohort',
  '[{"kind": "signup", "created": 1, "first_order": 1, "first_payment": 1},
    {"kind": "team", "created": 2, "first_order": 0, "first_payment": 0}]'::jsonb,
  'restaurants created in the range, India time, and how far they got');
select is(
  (select jsonb_object_agg(c ->> 'channel', jsonb_build_array(
     (c ->> 'leads')::int, (c ->> 'restaurants')::int, (c ->> 'paying')::int, (c ->> 'mrr_paise')::bigint))
   from jsonb_array_elements((:'fun'::jsonb) -> 'channels') c
   where (c ->> 'leads')::int + (c ->> 'restaurants')::int > 0),
  jsonb_build_object(
    'website', jsonb_build_array(0, 1, 1, :'growth_monthly'::bigint),
    'website_lead', jsonb_build_array(1, 0, 0, 0),
    'field_visit', jsonb_build_array(1, 1, 0, 0),
    'unknown', jsonb_build_array(0, 1, 0, 0)),
  'by channel: leads, restaurants, paying and their MRR'
);
select is(
  (select sum((c ->> 'restaurants')::int) from jsonb_array_elements((:'fun'::jsonb) -> 'channels') c),
  (select sum((k ->> 'created')::int) from jsonb_array_elements((:'fun'::jsonb) -> 'cohort') k),
  'channel totals reconcile with the restaurants created'
);
select is(
  (select jsonb_agg(s order by s ->> 'signups') from jsonb_array_elements((:'fun'::jsonb) -> 'sources') s),
  '[{"utm_source": null, "referrer": "news.example", "demo_requests": 1, "signups": 0, "paying": 0},
    {"utm_source": "google", "referrer": null, "demo_requests": 0, "signups": 1, "paying": 1}]'::jsonb,
  'website arrivals by source: utm source, else the referring site'
);
select is((:'fun'::jsonb) -> 'other_sources', 'null'::jsonb, 'no long tail');
select is(public.platform_funnel('2020-02-03', '2020-02-29') ->> 'signups_counted_from', null,
  'all counted: no note');
-- The last 7 India days come from site_signups until a snapshot has the day,
-- one email once a day; a snapshot wins.
select tests.clear_auth();
delete from public.site_signups;
delete from public.metrics_platform_daily
where day >= (now() at time zone 'Asia/Kolkata')::date - 8;
select (now() at time zone 'Asia/Kolkata')::date as today \gset
insert into public.site_signups (email, details, code_hash, created_at) values
  ('live1@sa610.test', '{}', repeat('0', 64), (:'today'::date + time '00:10') at time zone 'Asia/Kolkata'),
  ('live1@sa610.test', '{}', repeat('0', 64), (:'today'::date + time '01:00') at time zone 'Asia/Kolkata'),
  ('live2@sa610.test', '{}', repeat('0', 64), (:'today'::date - 6 + time '00:05') at time zone 'Asia/Kolkata'),
  ('live3@sa610.test', '{}', repeat('0', 64), (:'today'::date - 7 + time '23:50') at time zone 'Asia/Kolkata'),
  ('live4@sa610.test', '{}', repeat('0', 64), (:'today'::date - 3 + time '12:00') at time zone 'Asia/Kolkata');
insert into public.metrics_platform_daily (day, signups_started) values (:'today'::date - 3, 4);
select tests.authenticate_as_platform_admin(:'admin');
select is(
  (select row(f ->> 'signups_started', f ->> 'signups_counted_from')::text
   from (select public.platform_funnel(:'today'::date - 6, :'today') as f) x),
  '(6,)', 'the last 7 days, live where no snapshot has the day: 1 + 1 + the snapshot''s 4'
);
select is(
  (select row(f ->> 'signups_started', f ->> 'signups_counted_from')::text
   from (select public.platform_funnel(:'today'::date - 7, :'today') as f) x),
  format('(6,%s)', :'today'::date - 6), 'the day before is lost: counted from 6 days ago'
);
select throws_ok($$select public.platform_funnel('2020-02-10', '2020-02-01')$$,
  'P0001', 'INVALID_INPUT', 'the end after the start');
select throws_ok($$select public.platform_funnel('2020-01-01', '2021-01-03')$$,
  'P0001', 'INVALID_INPUT', 'a year at most');
select tests.clear_auth();

-- ─── Upgrade opportunities ──────────────────────────────────────────────────
-- Only this file's restaurants on Starter.
update public.restaurant_subscriptions
set plan_id = (select id from public.plans where code = 'growth')
where plan_id = (select id from public.plans where code = 'starter');
select tests.create_restaurant('sa610-u-hits') as u_hits \gset
select tests.create_restaurant('sa610-u-full') as u_full \gset
select tests.create_restaurant('sa610-u-busy') as u_busy \gset
select tests.create_restaurant('sa610-u-quiet') as u_quiet \gset
select tests.create_restaurant('sa610-u-gone') as u_gone \gset
select tests.create_restaurant('sa610-u-growth') as u_growth \gset
select tests.set_plan(r, 'starter')
from unnest(array[:'u_hits', :'u_full', :'u_busy', :'u_quiet', :'u_gone']::uuid[]) r;
insert into public.plan_limit_events (restaurant_id, kind, feature, created_at) values
  (:'u_hits', 'tables', null, now() - interval '1 day'),
  (:'u_hits', 'tables', null, now() - interval '2 days'),
  (:'u_hits', 'feature', 'kitchen_view', now() - interval '3 days'),
  (:'u_hits', 'staff', null, now() - interval '40 days'),
  (:'u_gone', 'tables', null, now()),
  (:'u_growth', 'staff', null, now());
select tests.suspend(:'u_gone');
insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
select :'u_full', 'T' || n, 'SA610FULLTABLE' || lpad(n::text, 2, '0'), n from generate_series(1, 8) n;
insert into public.metrics_usage_daily (restaurant_id, business_day, orders)
-- Stored days, counted back from its business date: the last two come live from orders.
select :'u_busy', private.business_date(now(), r.timezone, r.business_day_start_hour) - n, 60
from public.restaurants r, generate_series(2, 11) n where r.id = :'u_busy';
insert into public.metrics_usage_daily (restaurant_id, business_day, orders)
select :'u_quiet', private.business_date(now(), r.timezone, r.business_day_start_hour) - 3, 599
from public.restaurants r where r.id = :'u_quiet';

select tests.authenticate_as_platform_admin(:'admin');
select public.platform_upgrade_opportunities() as up \gset
select is((:'up'::jsonb) ->> 'busy_orders', '600', 'busy: 600 orders in 30 days');
select is(
  (select array_agg(r ->> 'slug' order by n)
   from jsonb_array_elements((:'up'::jsonb) -> 'rows') with ordinality as x(r, n)),
  array['sa610-u-hits', 'sa610-u-busy', 'sa610-u-full'],
  'limit hits, busy, at the table limit; not quiet, suspended or on Growth; most hits first'
);
select is(
  (select r -> 'hits' from jsonb_array_elements((:'up'::jsonb) -> 'rows') r
   where r ->> 'slug' = 'sa610-u-hits'),
  '[{"kind": "tables", "feature": null, "count": 2}, {"kind": "feature", "feature": "kitchen_view", "count": 1}]'::jsonb,
  'hits in the last 30 days by kind'
);
select is(
  (select row(r ->> 'tables', r ->> 'max_tables', r ->> 'orders')::text
   from jsonb_array_elements((:'up'::jsonb) -> 'rows') r where r ->> 'slug' = 'sa610-u-full'),
  '(8,8,0)', 'tables against the limit'
);
select is(
  (select r ->> 'orders' from jsonb_array_elements((:'up'::jsonb) -> 'rows') r
   where r ->> 'slug' = 'sa610-u-busy'),
  '600', 'orders in the last 30 business days'
);
select tests.clear_auth();

-- ─── Found us ───────────────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_set_acquisition_channel(:'home', 'referral');
select public.platform_set_acquisition_channel(:'home', ' referral ');
select is((select acquisition_channel from public.restaurants where id = :'home'), 'referral',
  'set by the team');
select is(
  (select array_agg(row(before, after)::text) from public.audit_logs
   where restaurant_id = :'home' and action = 'restaurant.channel_changed'),
  array['("{""acquisition_channel"": null}","{""acquisition_channel"": ""referral""}")'],
  'audited once, before and after'
);
select public.platform_set_acquisition_channel(:'home', null);
select is((select acquisition_channel from public.restaurants where id = :'home'), null,
  'back to not known');
select throws_ok(format('select public.platform_set_acquisition_channel(%L, %L)', :'home', 'tv'),
  'P0001', 'INVALID_INPUT', 'a known channel');
select throws_ok(format('select public.platform_set_acquisition_channel(%L, %L)', gen_random_uuid(), 'other'),
  'P0001', 'RESTAURANT_NOT_FOUND', 'a restaurant that exists');
select tests.clear_auth();

-- ─── Who may ────────────────────────────────────────────────────────────────
select tests.authenticate_as(:'owner');
select throws_ok($$select public.platform_list_leads('{}')$$, 'P0001', 'FORBIDDEN', 'not an owner');
select throws_ok(format('select public.platform_get_lead(%L)', :'web_lead'), 'P0001', 'FORBIDDEN',
  'not an owner');
select throws_ok($$select public.platform_create_lead('{}')$$, 'P0001', 'FORBIDDEN', 'not an owner');
select throws_ok(format('select public.platform_update_lead(%L, %L)', :'web_lead', '{}'), 'P0001',
  'FORBIDDEN', 'not an owner');
select throws_ok(format('select public.platform_add_lead_note(%L, %L)', :'web_lead', 'Hi'), 'P0001',
  'FORBIDDEN', 'not an owner');
select throws_ok($$select public.platform_lead_matches('9810000601')$$, 'P0001', 'FORBIDDEN',
  'not an owner');
select throws_ok('select public.platform_unfinished_signups()', 'P0001', 'FORBIDDEN', 'not an owner');
select throws_ok($$select public.platform_funnel('2020-02-01', '2020-02-29')$$, 'P0001', 'FORBIDDEN',
  'not an owner');
select throws_ok('select public.platform_upgrade_opportunities()', 'P0001', 'FORBIDDEN',
  'not an owner');
select throws_ok(format('select public.platform_set_acquisition_channel(%L, %L)', :'home', 'other'),
  'P0001', 'FORBIDDEN', 'not an owner');
select is((select count(*) from public.lead_events), 0::bigint, 'an owner reads no lead history');
select is((select count(*) from public.site_leads), 0::bigint, 'or leads');
select tests.clear_auth();
select tests.authenticate_as_platform_admin(:'admin', 'aal1');
select throws_ok($$select public.platform_list_leads('{}')$$, 'P0001', 'MFA_REQUIRED',
  'two-step sign-in first');
select throws_ok(format('select public.platform_update_lead(%L, %L)', :'web_lead', '{}'), 'P0001',
  'MFA_REQUIRED', 'two-step sign-in first');
select is((select count(*) from public.lead_events), 0::bigint, 'no history without it');
select tests.clear_auth();
select tests.authenticate_as_platform_admin(:'admin');
select ok((select count(*) from public.lead_events where lead_id = :'call_lead') > 0,
  'the team reads the history');
select tests.clear_auth();
select tests.as_anon();
select throws_ok($$select public.platform_list_leads('{}')$$, '42501', null, 'not anon');
select throws_ok($$select public.platform_funnel('2020-02-01', '2020-02-29')$$, '42501', null,
  'not anon');
select throws_ok('select count(*) from public.lead_events', '42501', null, 'not anon');
select tests.clear_auth();

select * from finish();
rollback;
