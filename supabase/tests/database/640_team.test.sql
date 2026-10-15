-- Team and roles (docs/SUPER_ADMIN_PLAN.md §3 and 13g, docs/DECISIONS.md SA-70+):
-- every permission-checked function against every role, what each role reads,
-- inviting and joining, changing and turning off members, and the digest.
begin;
select no_plan();

-- ─── Fixtures ───────────────────────────────────────────────────────────────
select tests.create_platform_admin('sa640-admin@example.test') as admin \gset
select tests.create_platform_admin('sa640-finance@example.test') as finance \gset
select tests.create_platform_admin('sa640-sales@example.test') as sales \gset
select tests.create_platform_admin('sa640-support@example.test') as support \gset
update public.platform_admins set role = 'finance' where user_id = :'finance';
update public.platform_admins set role = 'sales' where user_id = :'sales';
update public.platform_admins set role = 'support' where user_id = :'support';

select tests.create_restaurant('sa640-rest') as rest \gset
insert into public.subscription_payments (
  restaurant_id, source, manual_mode, amount_paise, razorpay_payment_id, period_start,
  period_end, created_at
) values (:'rest', 'manual', 'upi', 105082, 'pay_SA640search', now(), now() + interval '30 days', now());
insert into public.site_leads (name, restaurant_name, city, phone, channel, stage)
values ('Sa640 lead', 'Sa640 Cafe', 'Indore', '9640640640', 'phone', 'new');
insert into public.metrics_platform_daily (day, signups_started) values ('2001-01-01', 1)
on conflict (day) do nothing;

-- ─── Roles ──────────────────────────────────────────────────────────────────
select is(
  array[
    array_length(private.role_permissions('admin'), 1),
    array_length(private.role_permissions('finance'), 1),
    array_length(private.role_permissions('sales'), 1),
    array_length(private.role_permissions('support'), 1)
  ],
  array[12, 4, 4, 4],
  'Admin holds all twelve permissions; the others four each'
);
select is(
  private.role_permissions('finance') || private.role_permissions('sales')
    || private.role_permissions('support'),
  array['restaurants.view', 'money.view', 'money.record', 'audit.view',
    'restaurants.view', 'restaurants.manage', 'growth.manage', 'insights.view',
    'restaurants.view', 'restaurants.support', 'insights.view', 'system.view'],
  'Finance, Sales and Support as plan §3 gives them'
);

select to_jsonb(private.role_permissions('finance')) as finance_permissions \gset
select to_jsonb(private.role_permissions('sales')) as sales_permissions \gset
select tests.authenticate_as_platform_admin(:'finance');
select is(
  public.platform_my_access(),
  jsonb_build_object('status', 'ok', 'role', 'finance', 'display_name', null,
    'permissions', :'finance_permissions'::jsonb),
  'a member reads their role and permissions'
);
select tests.authenticate_as_platform_admin(:'finance', 'aal1');
select is(public.platform_my_access() -> 'permissions', '[]'::jsonb,
  'without the second factor, no permissions');
select tests.clear_auth();

-- ─── Every permission-checked function, every role ──────────────────────────
-- Each public function that checks a permission, called with harmless
-- arguments: a role without the permission gets FORBIDDEN, a role with it
-- gets past the check (to a result or another error).
create function tests.forbidden(p_sql text) returns boolean
language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return sqlerrm = 'FORBIDDEN';
end;
$$;

create temp table sa640_calls on commit drop as
select
  p.proname as name,
  (regexp_match(p.prosrc, 'require_platform_permission\(''([a-z.]+)''\)'))[1] as permission,
  format('select public.%I(%s)', p.proname, coalesce((
    select string_agg(case format_type(t, null)
        when 'uuid' then 'gen_random_uuid()'
        when 'text' then '''x'''
        when 'jsonb' then '''{}''::jsonb'
        when 'date' then '''2020-03-01''::date'
        when 'integer' then '1'
        when 'bigint' then '1'
        when 'boolean' then 'false'
        when 'timestamp with time zone' then 'now()'
        when 'text[]' then '''{}''::text[]'
        when 'uuid[]' then '''{}''::uuid[]'
        else 'null'
      end, ', ' order by ord)
    from unnest(p.proargtypes::oid[]) with ordinality as a(t, ord)
  ), '')) as call
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosrc like '%require_platform_permission(''%';
-- Menu imports by the team check through a private helper.
insert into sa640_calls values
  ('menu_import_create', 'restaurants.support',
   'select public.menu_import_create(gen_random_uuid(), ''x'', 1)');
grant select on sa640_calls to authenticated;

select ok((select count(*) from sa640_calls) >= 60, 'the matrix covers every checked function');

-- Who should be refused what, worked out before acting as each role.
create temp table sa640_matrix on commit drop as
select r.role, r.user_id, c.name, c.call,
  not (c.permission = any (private.role_permissions(r.role))) as refused
from sa640_calls c
cross join (values
  ('admin', :'admin'::uuid), ('finance', :'finance'::uuid),
  ('sales', :'sales'::uuid), ('support', :'support'::uuid)
) as r(role, user_id);
grant select on sa640_matrix to authenticated;
create temp table sa640_wrong (role text, name text) on commit drop;
grant insert on sa640_wrong to authenticated;
do $$
declare
  m record;
begin
  for m in select * from sa640_matrix order by role, name loop
    perform tests.authenticate_as_platform_admin(m.user_id);
    if tests.forbidden(m.call) is distinct from m.refused then
      insert into sa640_wrong values (m.role, m.name);
    end if;
    perform tests.clear_auth();
  end loop;
end;
$$;
select is(
  (select array_agg(role || ': ' || name order by role, name) from sa640_wrong),
  null,
  'each role is refused exactly the functions its permissions don''t cover'
);
select is(
  (select array_agg(n.nspname || '.' || p.proname order by p.proname)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'private') and p.prosrc like '%current_platform_admin()%'),
  array['public.platform_end_support_session', 'private.require_platform_permission'],
  'only ending one''s own support session still lets any member in'
);

-- ─── What each role reads ───────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'sales');
select is(
  array[
    jsonb_array_length(public.platform_search('pay_SA640search') -> 'payments'),
    jsonb_array_length(public.platform_search('Sa640 lead') -> 'leads'),
    (select count(*)::int from public.subscription_payments where restaurant_id = :'rest'),
    (select count(*)::int from public.site_leads where name = 'Sa640 lead')
  ],
  array[0, 1, 0, 1],
  'Sales finds and reads leads, never payments'
);
select is(public.platform_home() -> 'mrr_paise', 'null'::jsonb, 'Sales sees no MRR on Home');
select is(
  (select count(*)::int from public.metrics_platform_daily where day = '2001-01-01'), 1,
  'Sales reads the funnel''s daily numbers'
);
select throws_ok(
  format($$select public.platform_create_lead(jsonb_build_object(
    'name', 'Sa640 two', 'restaurant_name', 'Sa640 Two', 'city', 'Indore', 'phone', '9640640641',
    'channel', 'phone', 'assignee', %L))$$, :'finance'),
  'P0001', 'ADMIN_NOT_FOUND', 'a lead goes only to a member who sees leads'
);
set local role postgres;
select ok(not ('menu_import' = any (private.activity_kinds(null))),
  'no menu imports in the activity without support');
select tests.authenticate_as_platform_admin(:'finance');
select is(
  array[
    jsonb_array_length(public.platform_search('pay_SA640search') -> 'payments'),
    jsonb_array_length(public.platform_search('Sa640 lead') -> 'leads'),
    (select count(*)::int from public.subscription_payments where restaurant_id = :'rest'),
    (select count(*)::int from public.site_leads where name = 'Sa640 lead')
  ],
  array[1, 0, 1, 0],
  'Finance finds and reads payments, never leads'
);
select tests.authenticate_as_platform_admin(:'support');
select is(
  array[
    (select count(*)::int from public.subscription_payments where restaurant_id = :'rest'),
    (select count(*)::int from public.metrics_subscription_daily where restaurant_id = :'rest'),
    (select count(*)::int from public.metrics_platform_daily where day = '2001-01-01'),
    (select count(*)::int from public.restaurants where id = :'rest')
  ],
  array[0, 0, 0, 1],
  'Support reads restaurants but no money and no funnel'
);
select tests.clear_auth();

-- ─── Inviting and joining ───────────────────────────────────────────────────
select tests.create_user('sa640-new@example.test') as newbie \gset
select tests.add_member(:'rest', 'owner', 'sa640owner') as owner_user \gset

select tests.authenticate_as_platform_admin(:'admin');
select public.platform_invite_member(:'newbie', '  Neha  ', 'sales', repeat('a', 64)) as invited \gset
select throws_ok(
  format($$select public.platform_invite_member(%L, 'Owner', 'sales', repeat('b', 64))$$, :'owner_user'),
  'P0001', 'EMAIL_TAKEN', 'a restaurant''s login can''t join the team');
select throws_ok(
  format($$select public.platform_invite_member(%L, 'Again', 'sales', repeat('c', 64))$$, :'newbie'),
  'P0001', 'EMAIL_TAKEN', 'nor someone already on it');
select throws_ok(
  format($$select public.platform_invite_member(%L, 'X', 'owner', repeat('d', 64))$$, :'owner_user'),
  'P0001', 'INVALID_INPUT', 'only the four roles');
select tests.clear_auth();

select is(
  (select array[a.role, a.display_name, a.invited_by::text, (a.joined_at is null)::text,
     a.digest::text, (a.invite_expires_at > now() + interval '6 days')::text]
   from public.platform_admins a where a.user_id = :'newbie'),
  array['sales', 'Neha', :'admin', 'true', 'false', 'true'],
  'invited: a Sales member, not joined, no digest, the link good for 7 days'
);
select is(
  (select after from public.audit_logs where action = 'platform_admin.invited' and entity_id = :'newbie'),
  jsonb_build_object('email', 'sa640-new@example.test', 'display_name', 'Neha', 'role', 'sales'),
  'the invite is audited'
);
select tests.authenticate_as_platform_admin(:'newbie');
select is(public.platform_my_access(), null, 'before joining, no access');
select tests.clear_auth();

select tests.as_service_role();
select is(
  public.platform_invite_lookup(repeat('a', 64)) - 'user_id',
  '{"email": "sa640-new@example.test", "display_name": "Neha", "role": "sales", "expired": false}'::jsonb,
  'the join page finds the invite by its hash'
);
select is(public.platform_invite_lookup(repeat('9', 64)), null, 'and nothing for a wrong one');
select is(public.platform_invite_accept(repeat('a', 64)) ->> 'user_id', :'newbie', 'joined');
select throws_ok($$select public.platform_invite_accept(repeat('a', 64))$$,
  'P0001', 'INVITE_INVALID', 'the link works once');
select tests.clear_auth();
select is(
  (select array[(a.joined_at is not null)::text, coalesce(a.invite_token_hash, '-')]
   from public.platform_admins a where a.user_id = :'newbie'),
  array['true', '-'],
  'joined, the link spent'
);
select tests.authenticate_as_platform_admin(:'newbie');
select is(public.platform_my_access() ->> 'role', 'sales', 'a joined member has their role');
select tests.clear_auth();

-- A renewed link replaces the old; an expired one doesn't work.
select tests.create_user('sa640-late@example.test') as late \gset
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_invite_member(:'late', 'Late', 'support', repeat('e', 64));
select is(public.platform_renew_invite(:'late', repeat('f', 64)) ->> 'display_name', 'Late',
  'a new link for a member who hasn''t joined');
select throws_ok(format($$select public.platform_renew_invite(%L, repeat('1', 64))$$, :'newbie'),
  'P0001', 'TEAM_MEMBER_NOT_FOUND', 'but not for one who has');
-- Turned off, an unused link stops working; back on, the login is let in.
select public.platform_renew_invite(:'late', repeat('3', 64));
select public.platform_update_member(:'late', '{"disabled": true}');
select public.platform_update_member(:'late', '{"disabled": false}');
select tests.clear_auth();
select is(
  (select array[coalesce(a.invite_token_hash, '-'), (u.banned_until is null)::text]
   from public.platform_admins a join auth.users u on u.id = a.user_id
   where a.user_id = :'late'),
  array['-', 'true'],
  'turned off and back on: the link is gone, the login let in'
);
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_renew_invite(:'late', repeat('f', 64));
select tests.clear_auth();
update public.platform_admins set invite_expires_at = now() - interval '1 minute'
where user_id = :'late';
select tests.as_service_role();
select is(public.platform_invite_lookup(repeat('e', 64)), null, 'the old link is gone');
select is(public.platform_invite_lookup(repeat('f', 64)) ->> 'expired', 'true', 'the new one expired');
select throws_ok($$select public.platform_invite_accept(repeat('f', 64))$$,
  'P0001', 'INVITE_INVALID', 'and can''t be used');
select tests.clear_auth();

-- ─── Changing members ───────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select is(
  public.platform_update_member(:'newbie', '{"role": "finance", "display_name": "Neha S"}'),
  jsonb_build_object('user_id', :'newbie', 'disabled', false),
  'a new role and name'
);
select is(
  (select array[before::text, after::text] from public.audit_logs
   where action = 'platform_admin.updated' and entity_id = :'newbie'),
  array['{"role": "sales", "display_name": "Neha"}', '{"role": "finance", "display_name": "Neha S"}'],
  'audited, only what changed'
);
select tests.clear_auth();
insert into auth.sessions (id, user_id, created_at, updated_at, aal)
values (gen_random_uuid(), :'newbie', now(), now(), 'aal2');
select tests.authenticate_as_platform_admin(:'admin');
select is(
  public.platform_update_member(:'newbie', '{"disabled": true}') ->> 'disabled', 'true',
  'turned off'
);
select tests.clear_auth();
select is(
  array[
    (select u.banned_until > now() + interval '99 years' from auth.users u where u.id = :'newbie'),
    (select count(*) = 0 from auth.sessions s where s.user_id = :'newbie')
  ],
  array[true, true],
  'their login is blocked and its sessions are gone'
);
select tests.authenticate_as_platform_admin(:'admin');
select throws_ok(format($$select public.platform_update_member(%L, '{"disabled": true}')$$, :'admin'),
  'P0001', 'TEAM_SELF', 'nobody turns themselves off');
select throws_ok(format($$select public.platform_update_member(%L, '{"colour": "red"}')$$, :'newbie'),
  'P0001', 'INVALID_INPUT', 'only the known changes');
select tests.clear_auth();

select tests.authenticate_as_platform_admin(:'newbie');
select is(
  array[public.platform_admin_status(), public.is_platform_admin()::text],
  array['none', 'false'],
  'a member turned off has no access, at once'
);
select tests.clear_auth();

-- The last active Admin stays an Admin.
update public.platform_admins set role = 'finance'
where user_id <> :'admin' and role = 'admin';
select tests.authenticate_as_platform_admin(:'admin');
select throws_ok(format($$select public.platform_update_member(%L, '{"role": "finance"}')$$, :'admin'),
  'P0001', 'LAST_ADMIN', 'the only Admin can''t step down');
select lives_ok(format($$select public.platform_update_member(%L, '{"role": "admin"}')$$, :'finance'),
  'with another Admin');
select lives_ok(format($$select public.platform_update_member(%L, '{"role": "support"}')$$, :'admin'),
  'they can');
select tests.clear_auth();

-- ─── Support sessions end with the role ─────────────────────────────────────
insert into public.support_sessions (restaurant_id, consent, ends_at, user_id, staff_name, started_at)
values (:'rest', 'owner', now() + interval '1 hour', :'support', 'Sa640 Support', now());
update public.platform_admins set role = 'sales' where user_id = :'support';
select is(
  (select ended_at is not null from public.support_sessions where user_id = :'support'),
  true,
  'moved to a role without support: the open session ends'
);

-- ─── The digest ─────────────────────────────────────────────────────────────
select tests.as_service_role();
select public.platform_digest() -> 'recipients' as recipients \gset
select tests.clear_auth();
select is(
  array[
    :'recipients'::jsonb ? 'sa640-admin@example.test',
    :'recipients'::jsonb ? 'sa640-finance@example.test',
    :'recipients'::jsonb ? 'sa640-sales@example.test',
    :'recipients'::jsonb ? 'sa640-new@example.test'
  ],
  array[false, true, false, false],
  'opted-in members whose role sees money: the Admin moved to Support, Sales and the one turned off don''t'
);
update public.platform_admins set digest = false where user_id = :'finance';
select tests.as_service_role();
select ok(not (public.platform_digest() -> 'recipients' ? 'sa640-finance@example.test'),
  'a member who turned it off doesn''t');
select tests.clear_auth();

-- ─── The team list ──────────────────────────────────────────────────────────
update public.platform_admins set role = 'admin' where user_id = :'admin';
select tests.authenticate_as_platform_admin(:'admin');
select is(
  (select array[m ->> 'role', m ->> 'invited_by', (m ->> 'joined_at' is null)::text, m ->> 'is_you']
   from jsonb_array_elements(public.platform_list_team()) as m
   where m ->> 'email' = 'sa640-late@example.test'),
  array['support', 'sa640-admin@example.test', 'true', 'false'],
  'the invited member, who invited them, not joined'
);
select is(
  (select array_agg(m ->> 'email' order by m ->> 'email')
   from jsonb_array_elements(public.platform_team()) as m
   where m ->> 'email' like 'sa640-%'),
  array['sa640-admin@example.test', 'sa640-finance@example.test', 'sa640-sales@example.test',
    'sa640-support@example.test'],
  'to choose from: active members only'
);
select is(
  (select m -> 'permissions' from jsonb_array_elements(public.platform_team()) as m
   where m ->> 'email' = 'sa640-sales@example.test'),
  :'sales_permissions'::jsonb,
  'each with what their role opens'
);
select is(
  (public.platform_list_audit(jsonb_build_object('actor', :'admin')) ->> 'total')::int,
  (select count(*)::int from public.audit_logs where actor_user_id = :'admin'),
  'the audit log of one member'
);
select tests.clear_auth();

-- ─── A member turned off gets no reset code ─────────────────────────────────
insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
values (gen_random_uuid(), :'newbie', 'phone', 'totp', 'verified', now(), now());
select tests.as_service_role();
select is(
  public.auth_password_reset_start('sa640-new@example.test', repeat('2', 64)) ->> 'send',
  'false',
  'no reset for a member who is turned off'
);
select tests.clear_auth();

-- ─── Who may ────────────────────────────────────────────────────────────────
select tests.as_anon();
select throws_ok($$select public.platform_list_team()$$, '42501', null, 'anon may not');
select tests.clear_auth();
select tests.authenticate_as(:'owner_user');
select throws_ok($$select public.platform_invite_lookup('x')$$, '42501', null,
  'the join functions are the server''s');
select is(public.platform_can('restaurants.view'), false, 'a restaurant owner can''t');
select tests.clear_auth();
select ok(
  not has_function_privilege('authenticated', 'private.role_permissions(text)', 'execute')
    and not has_function_privilege('authenticated', 'private.active_admin(uuid)', 'execute'),
  'the helpers are private'
);

select * from finish();
rollback;
