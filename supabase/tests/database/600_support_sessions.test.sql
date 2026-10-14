-- Support sessions (docs/SUPER_ADMIN_PLAN.md 13c; docs/DECISIONS.md SA-46 to
-- SA-52): the owner's consent, a team member working as a manager inside it,
-- what a session can't do, the audit trail, and every way it ends.
-- Restaurants here are named sa600-*.
begin;
select no_plan();

select tests.create_platform_admin('team600@admin.test') as team \gset
select tests.create_platform_admin('team600b@admin.test') as team_b \gset
select tests.create_platform_admin('team600c@admin.test') as team_c \gset
select tests.create_platform_admin('member600@admin.test') as member_admin \gset
select tests.create_user('plain600@user.test') as plain \gset

select tests.create_restaurant('sa600-a') as rest_a \gset
select tests.create_restaurant('sa600-b') as rest_b \gset
select tests.add_member(:'rest_a', 'owner', 'sa600_owner') as owner \gset
select tests.add_member(:'rest_a', 'manager', 'sa600_manager') as manager \gset
select tests.add_member(:'rest_a', 'waiter', 'sa600_waiter') as waiter \gset
select tests.add_member(:'rest_b', 'owner', 'sa600_owner_b') as owner_b \gset
select tests.create_full_fixture(:'rest_a');
select tests.create_full_fixture(:'rest_b');
-- A team member who is also on a restaurant's staff.
insert into public.restaurant_members (restaurant_id, user_id, role, display_name, username)
values (:'rest_b', :'member_admin', 'manager', 'Both', 'sa600_both');

select m.id as waiter_member from public.restaurant_members m where m.user_id = :'waiter' \gset
select count(*) as staff_a from public.restaurant_members where restaurant_id = :'rest_a' \gset

-- ─── Consent: the owner's alone ─────────────────────────────────────────────
select tests.authenticate_as(:'manager');
select throws_ok($$ select public.admin_allow_support_access(1) $$, 'P0001', 'FORBIDDEN',
  'a manager cannot allow support access');

select tests.authenticate_as(:'owner');
select throws_ok($$ select public.admin_allow_support_access(2) $$, 'P0001', 'INVALID_INPUT',
  'only 1, 4 or 24 hours');
select is(public.admin_allow_support_access(4), now() + interval '4 hours', 'open for 4 hours');
select throws_ok($$ select public.admin_allow_support_access(1) $$, 'P0001', 'SUPPORT_ACCESS_OPEN',
  'one window at a time');
select is(
  (select count(*)::int from public.support_sessions where restaurant_id = :'rest_a'), 1,
  'the owner reads their restaurant''s window'
);
select is(
  (select l.after ->> 'hours' from public.audit_logs l
    where l.restaurant_id = :'rest_a' and l.action = 'support_access.allowed'),
  '4', 'allowing is audited, as the owner'
);
select id as window_a from public.support_sessions where restaurant_id = :'rest_a' \gset

select tests.authenticate_as(:'manager');
select is((select count(*)::int from public.support_sessions), 0, 'a manager does not see windows');
select tests.authenticate_as(:'owner_b');
select is((select count(*)::int from public.support_sessions), 0, 'nor another restaurant''s owner');

-- ─── No session yet: no way in ──────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'team');
select throws_ok($$ select * from public.admin_list_staff() $$, 'P0001', 'FORBIDDEN',
  'a window alone gives the team nothing');
select is((select count(*)::int from public.orders), 0, 'and no orders');

-- ─── Starting ───────────────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'team', 'aal1');
select throws_ok(format($$ select public.platform_start_support_session(%L, 'Priya') $$, :'rest_a'),
  'P0001', 'MFA_REQUIRED', 'starting needs the second factor');
select tests.authenticate_as(:'plain');
select throws_ok(format($$ select public.platform_start_support_session(%L, 'Priya') $$, :'rest_a'),
  'P0001', 'FORBIDDEN', 'and a team member');
select tests.authenticate_as_platform_admin(:'member_admin');
select throws_ok(format($$ select public.platform_start_support_session(%L, 'Priya') $$, :'rest_a'),
  'P0001', 'SUPPORT_HAS_MEMBERSHIP', 'not one with a restaurant login of their own');

select tests.authenticate_as_platform_admin(:'team');
select throws_ok(format($$ select public.platform_start_support_session(%L, '  ') $$, :'rest_a'),
  'P0001', 'INVALID_INPUT', 'a name the restaurant sees');
select throws_ok(format($$ select public.platform_start_support_session(%L, 'Priya') $$, :'rest_b'),
  'P0001', 'NO_SUPPORT_ACCESS', 'not without the owner''s window');
select is(public.platform_start_support_session(:'rest_a', ' Priya '), now() + interval '4 hours',
  'started: ends with the window');
select is(
  (select row(s.user_id, s.staff_name)::text from public.support_sessions s where s.id = :'window_a'),
  row(:'team'::uuid, 'Priya')::text, 'the window is the team member''s'
);
select is(
  (select l.actor_type::text || ' ' || l.actor_user_id from public.audit_logs l
    where l.action = 'support_session.started' and l.entity_id = :'window_a'),
  'platform_admin ' || :'team', 'starting is audited as the team member'
);
select throws_ok(format($$ select public.platform_start_support_session(%L, 'Priya') $$, :'rest_a'),
  'P0001', 'SUPPORT_SESSION_OPEN', 'one session per team member');

select tests.authenticate_as_platform_admin(:'team_b');
select throws_ok(format($$ select public.platform_start_support_session(%L, 'Ravi') $$, :'rest_a'),
  'P0001', 'SUPPORT_ACCESS_IN_USE', 'a window is used by one team member');

-- ─── In the session: a manager of that restaurant ───────────────────────────
select tests.authenticate_as_platform_admin(:'team');
select is((select count(*) from public.admin_list_staff()), :'staff_a'::bigint,
  'Staff lists the restaurant''s own logins, not the session');
select ok((select count(*) from public.orders where restaurant_id = :'rest_a') > 0,
  'reads the restaurant''s orders');
select is((select count(*)::int from public.orders where restaurant_id <> :'rest_a'), 0,
  'and no other restaurant''s');
select is((select count(*)::int from public.restaurant_members where user_id = :'team'), 0,
  'no membership row anywhere');
select is(public.member_role(:'rest_a'::uuid), 'manager'::public.member_role, 'a manager there');
select is(public.member_role(:'rest_b'::uuid), null, 'nothing elsewhere');

select lives_ok($$ select public.admin_create_category('Support specials') $$,
  'menu changes are allowed');
select is(
  (select row(l.actor_type, l.actor_user_id, l.actor_role, l.actor_label, l.support_session_id,
     l.after ->> 'name')::text
   from public.audit_logs l where l.action = 'menu_category.created' and l.restaurant_id = :'rest_a'),
  row('platform_admin'::public.actor_type, :'team'::uuid, null::public.member_role,
      'MenuMesh support', :'window_a'::uuid, 'Support specials')::text,
  'and audited as the team member, labelled for the restaurant, with the session'
);
select lives_ok($$ select public.admin_update_settings('{"name": "Sa600 Renamed", "bill_footer_text": "Thanks"}') $$,
  'the restaurant''s details and bill layout are allowed');
select lives_ok(
  format($$ select public.admin_update_settings(%L) $$,
    (select jsonb_build_object('gst_mode', r.gst_mode, 'upi_vpa', r.upi_vpa, 'phone', '9876500600')
       from public.restaurants r where r.id = :'rest_a')),
  'a whole tab saves when its money settings are unchanged'
);
select throws_ok(
  format($$ select public.admin_update_settings(%L) $$,
    (select jsonb_build_object('prices_include_tax', not r.prices_include_tax)
       from public.restaurants r where r.id = :'rest_a')),
  'P0001', 'SUPPORT_REFUSED', 'tax settings are refused');
select throws_ok($$ select public.admin_update_settings('{"upi_vpa": "someone@okaxis"}') $$,
  'P0001', 'SUPPORT_REFUSED', 'where customers pay is refused');
select throws_ok(
  format($$ select public.admin_update_settings(%L) $$,
    (select jsonb_build_object('staff_can_remove_served_items', not r.staff_can_remove_served_items)
       from public.restaurants r where r.id = :'rest_a')),
  'P0001', 'SUPPORT_REFUSED', 'settings that change bills are refused');

select throws_ok(sql, 'P0001', 'SUPPORT_REFUSED', 'refused: ' || label)
from (values
  ('generate a bill', format($$ select public.admin_generate_bill(%L, null, null, null, false, null) $$, gen_random_uuid())),
  ('record a payment', format($$ select public.admin_record_payment(%L, '[]') $$, gen_random_uuid())),
  ('void a bill', format($$ select public.admin_void_bill(%L, 'x', false) $$, gen_random_uuid())),
  ('reprint a bill', format($$ select public.admin_increment_print_count(%L) $$, gen_random_uuid())),
  ('approve an order', format($$ select public.staff_approve_order(%L) $$, gen_random_uuid())),
  ('reject an order', format($$ select public.staff_reject_order(%L, 'x') $$, gen_random_uuid())),
  ('change an item''s status', format($$ select public.staff_update_item_status(%L, 'preparing') $$, gen_random_uuid())),
  ('serve an order', format($$ select public.staff_mark_order_served(%L) $$, gen_random_uuid())),
  ('undo an item''s status', format($$ select public.staff_revert_item_status(%L, 'preparing') $$, gen_random_uuid())),
  ('place an order', format($$ select public.staff_place_order(%L, '[]', 'k600', null) $$, gen_random_uuid())),
  ('remove an item', format($$ select public.staff_remove_item(%L, 1, 'x') $$, gen_random_uuid())),
  ('remove an order', format($$ select public.admin_remove_order(%L, 'x') $$, gen_random_uuid())),
  ('close a table unbilled', format($$ select public.staff_close_session_unbilled(%L, 'x') $$, gen_random_uuid())),
  ('move a table', format($$ select public.staff_move_session(%L, %L) $$, gen_random_uuid(), gen_random_uuid())),
  ('answer a call', format($$ select public.staff_update_service_request(%L, 'resolved') $$, gen_random_uuid())),
  ('assign a waiter', format($$ select public.admin_assign_waiter(%L, %L, false) $$, gen_random_uuid(), gen_random_uuid())),
  ('unassign a waiter', format($$ select public.admin_unassign_waiter(%L) $$, gen_random_uuid())),
  ('upload a screenshot', $$ select public.admin_start_screenshot_upload('png') $$),
  ('ask MenuMesh for help', $$ select public.admin_create_support_request('{}') $$)
) as t(label, sql);

select throws_ok(format($$ select public.admin_reset_staff_password(%L) $$, :'window_a'),
  'P0001', 'NOT_FOUND', 'the session has no login of its own to reset');
select is(public.admin_reset_staff_password(:'waiter_member'), :'waiter'::uuid,
  'a waiter''s login can be reset');
select lives_ok($$ select public.member_record_plan_limit('PLAN_LIMIT_TABLES', null) $$,
  'a limit hit goes through');
select is((select count(*)::int from public.plan_limit_events where restaurant_id = :'rest_a'), 0,
  'but is not counted as the restaurant''s');
select throws_ok($$ select public.admin_allow_support_access(24) $$, 'P0001', 'FORBIDDEN',
  'a session cannot extend itself');

-- Staff logins are created by the server, as the service role, for the signed-in user.
select tests.clear_auth();
select tests.create_user('sa600_kitchen@sa600-a.test') as kitchen_user \gset
select tests.as_service_role();
select lives_ok(
  format($$ select public.admin_create_staff(%L, %L) $$, :'team', jsonb_build_object(
    'user_id', :'kitchen_user', 'display_name', 'Kitchen', 'username', 'sa600_kitchen', 'role', 'kitchen')),
  'a waiter or kitchen login can be created'
);
select tests.clear_auth();
select is(
  (select l.support_session_id from public.audit_logs l
    where l.action = 'staff.created' and l.restaurant_id = :'rest_a'),
  :'window_a'::uuid, 'and it is listed as the session''s'
);

-- Menu imports in a session carry it too.
select set_config('request.jwt.claims',
  json_build_object('sub', :'team', 'role', 'authenticated', 'aal', 'aal2')::text, true);
select is(
  (select row(a.actor_type, a.label, a.support_session_id)::text from private.menu_import_actor(:'rest_a') as a),
  row('platform_admin'::public.actor_type, 'MenuMesh support', :'window_a'::uuid)::text,
  'a menu import in the session is the session''s'
);
select is(
  (select a.support_session_id from private.menu_import_actor(:'rest_b') as a), null,
  'an import elsewhere is a plain platform-admin one'
);

-- The owner sees what was done.
select tests.authenticate_as(:'owner');
select ok(
  (select count(*) from public.audit_logs where support_session_id = :'window_a') >= 3,
  'the owner reads the session''s changes'
);
select tests.authenticate_as_platform_admin(:'team');
select ok(
  (public.platform_list_audit(jsonb_build_object('restaurant_id', :'rest_a')) -> 'rows' -> 0)
    ? 'support_session_id',
  'the team''s audit log shows the session'
);

-- ─── It ends on time ────────────────────────────────────────────────────────
select tests.clear_auth();
update public.support_sessions
  set created_at = now() - interval '5 hours', ends_at = now() - interval '1 hour'
  where id = :'window_a';
select tests.authenticate_as_platform_admin(:'team');
select throws_ok($$ select * from public.admin_list_staff() $$, 'P0001', 'FORBIDDEN',
  'past its end, no admin functions');
select is((select count(*)::int from public.orders), 0, 'and no rows');
select tests.clear_auth();
update public.support_sessions set created_at = now(), ends_at = now() + interval '4 hours'
  where id = :'window_a';

-- Only at the second factor.
select tests.authenticate_as_platform_admin(:'team', 'aal1');
select throws_ok($$ select * from public.admin_list_staff() $$, 'P0001', 'FORBIDDEN',
  'a password-only sign-in gets nothing');
select is((select count(*)::int from public.orders), 0, 'and reads nothing');

-- ─── Ending ─────────────────────────────────────────────────────────────────
-- The team member ends it, and with it the window.
select tests.authenticate_as_platform_admin(:'team');
select lives_ok($$ select public.platform_end_support_session() $$, 'the team member ends it');
select isnt((select ended_at from public.support_sessions where id = :'window_a'), null, 'ended');
select throws_ok($$ select * from public.admin_list_staff() $$, 'P0001', 'FORBIDDEN', 'access gone');
select throws_ok(format($$ select public.platform_start_support_session(%L, 'Priya') $$, :'rest_a'),
  'P0001', 'NO_SUPPORT_ACCESS', 'a new session needs a new window');

-- The owner ends it.
select tests.authenticate_as(:'owner');
select lives_ok($$ select public.admin_allow_support_access(1) $$, 'the owner allows again');
select tests.authenticate_as_platform_admin(:'team_b');
select lives_ok(format($$ select public.platform_start_support_session(%L, 'Ravi') $$, :'rest_a'),
  'another team member starts');
select tests.authenticate_as(:'owner');
select lives_ok($$ select public.admin_end_support_access() $$, 'the owner ends it');
select ok(
  exists (select 1 from public.audit_logs where restaurant_id = :'rest_a' and action = 'support_access.ended'),
  'ending is audited'
);
select tests.authenticate_as_platform_admin(:'team_b');
select throws_ok($$ select * from public.admin_list_staff() $$, 'P0001', 'FORBIDDEN',
  'the team member is out at once');

-- Leaving the team ends it.
select tests.authenticate_as(:'owner');
select lives_ok($$ select public.admin_allow_support_access(1) $$, 'allowed once more');
select tests.authenticate_as_platform_admin(:'team_b');
select lives_ok(format($$ select public.platform_start_support_session(%L, 'Ravi') $$, :'rest_a'),
  'started once more');
select tests.clear_auth();
delete from public.platform_admins where user_id = :'team_b';
select isnt(
  (select s.ended_at from public.support_sessions s where s.user_id = :'team_b' order by s.created_at desc limit 1),
  null, 'removed from the team, the session ends'
);
insert into public.platform_admins (user_id) values (:'team_b');
select tests.authenticate_as_platform_admin(:'team_b');
select throws_ok($$ select * from public.admin_list_staff() $$, 'P0001', 'FORBIDDEN',
  'and coming back does not reopen it');

-- ─── The daily cron tidies up ───────────────────────────────────────────────
select tests.clear_auth();
insert into public.support_sessions (restaurant_id, consent, granted_by, created_at, ends_at)
values (:'rest_b', 'owner', :'owner_b', now() - interval '2 hours', now() - interval '1 hour');
select tests.as_service_role();
select ok(public.support_sessions_close_expired() >= 1, 'expired windows are closed');
select tests.clear_auth();
select is(
  (select count(*)::int from public.support_sessions where ended_at is null and ends_at <= now()), 0,
  'none left open'
);
select tests.authenticate_as(:'owner');
select throws_ok($$ select public.support_sessions_close_expired() $$, '42501', null,
  'only the server runs it');

-- ─── Onboarding: consent given in person ────────────────────────────────────
select tests.clear_auth();
select tests.create_restaurant('sa600-new') as rest_new \gset
select tests.create_restaurant('sa600-old') as rest_old \gset
insert into public.audit_logs (restaurant_id, actor_type, actor_user_id, actor_label, action, created_at)
values
  (:'rest_new', 'platform_admin', :'team_c', 'Platform admin', 'restaurant.created', now()),
  (:'rest_old', 'platform_admin', :'team_c', 'Platform admin', 'restaurant.created', now() - interval '2 hours');

select tests.authenticate_as_platform_admin(:'team');
select throws_ok(format($$ select public.platform_onboarding_support_session(%L, 'Priya') $$, :'rest_new'),
  'P0001', 'NO_SUPPORT_ACCESS', 'only for a restaurant this team member created');
select tests.authenticate_as_platform_admin(:'team_c');
select throws_ok(format($$ select public.platform_onboarding_support_session(%L, 'Asha') $$, :'rest_old'),
  'P0001', 'NO_SUPPORT_ACCESS', 'within the hour');
select is(public.platform_onboarding_support_session(:'rest_new', 'Asha'), now() + interval '24 hours',
  'a 24-hour session starts at once');
select is(
  (select s.consent || ' ' || s.staff_name from public.support_sessions s where s.restaurant_id = :'rest_new'),
  'onboarding Asha', 'recorded as consent given during onboarding'
);
select ok(
  exists (select 1 from public.audit_logs l
    where l.restaurant_id = :'rest_new' and l.action = 'support_access.allowed'
      and l.after ->> 'consent' = 'onboarding'),
  'and audited as such'
);
select tests.authenticate_as_platform_admin(:'team_c');
select lives_ok($$ select public.platform_end_support_session() $$, 'ended');
select throws_ok(format($$ select public.platform_onboarding_support_session(%L, 'Asha') $$, :'rest_new'),
  'P0001', 'NO_SUPPORT_ACCESS', 'only the restaurant''s first window');

-- ─── Every write a session can reach is classified ──────────────────────────
-- A new function that resolves a member must refuse sessions or be listed here.
select is_empty(
  $$
    select p.proname::text
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.provolatile = 'v'
      and p.prosrc ~ '(current_member|member_context_for|menu_import_actor|lock_menu_import)\('
      and p.prosrc !~ 'refuse_in_support_session'
      and p.proname not in (
        -- Allowed in a session (SA-49)
        'admin_add_categories', 'admin_create_category', 'admin_update_category',
        'admin_delete_category', 'admin_reorder', 'admin_save_menu_item',
        'admin_update_menu_item', 'admin_save_addon_group', 'admin_delete_addon_group',
        'staff_set_item_availability', 'staff_set_addon_availability',
        'menu_import_create', 'menu_import_set_draft', 'menu_import_commit',
        'menu_import_discard', 'admin_create_tables', 'admin_update_table',
        'admin_regenerate_qr', 'admin_record_qr_use', 'admin_upsert_waiter',
        'admin_delete_waiter', 'admin_set_waiter_on_duty', 'admin_create_staff',
        'admin_update_staff', 'admin_deactivate_staff', 'admin_reactivate_staff',
        -- Allowed with a guard inside: money keys, no self reset, no limit row
        'admin_update_settings', 'admin_reset_staff_password', 'member_record_plan_limit',
        -- Updates the caller's own login row; a session has none
        'member_set_ui_lang',
        -- Owner only
        'admin_allow_support_access', 'admin_end_support_access', 'admin_record_cancel_reason'
      )
  $$,
  'every write a member can call refuses sessions or is allowed on purpose'
);

select * from finish();
rollback;
