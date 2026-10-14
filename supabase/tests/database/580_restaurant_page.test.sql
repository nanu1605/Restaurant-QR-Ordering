-- A restaurant's page: its facts, the Overview, Billing and Usage tabs, notes,
-- tags, the account manager, notes in the activity stream and the list's new
-- filters (docs/SUPER_ADMIN_PLAN.md 13a; docs/DECISIONS.md SA-33 to SA-40).
-- Restaurants here are named sa580-*.
begin;
select no_plan();

select tests.create_platform_admin('platform580@admin.test') as admin \gset
select tests.create_platform_admin('platform580b@admin.test') as admin_b \gset
select tests.create_user('plain580@user.test') as plain \gset

select tests.create_restaurant('sa580-main') as main \gset
select tests.create_restaurant('sa580-other') as other \gset
select tests.add_member(:'main', 'owner', 'sa580_owner') as owner \gset
select tests.create_full_fixture(:'main');
select tests.set_plan(:'main', 'starter');

-- ─── Tables ─────────────────────────────────────────────────────────────────
select has_column('public', 'restaurants', 'account_manager_user_id', 'restaurants have an account manager');
select has_table('public', 'platform_tags', 'tags');
select has_table('public', 'restaurant_tags', 'tags on restaurants');
select has_table('public', 'restaurant_notes', 'notes');
select ok((select relrowsecurity from pg_class where oid = 'public.restaurant_notes'::regclass),
  'notes have row level security');

-- ─── The restaurant ─────────────────────────────────────────────────────────
update public.restaurant_subscriptions set cancel_reason = 'too_expensive',
  cancel_reason_detail = 'Wants a discount' where restaurant_id = :'main';
update public.restaurants set acquisition_channel = 'field_visit' where id = :'main';

select tests.authenticate_as_platform_admin(:'admin');
select public.platform_get_restaurant(:'main') as r \gset
select tests.clear_auth();

select is((:'r'::jsonb) ->> 'state', 'trial', 'the state, as the list has it');
select is((:'r'::jsonb) ->> 'health',
  private.restaurant_health(:'main', (select created_at from public.restaurants where id = :'main')),
  'the health, as the list has it');
select is(((:'r'::jsonb) ->> 'last_active')::timestamptz, private.restaurant_last_active(:'main'),
  'last active');
select is((:'r'::jsonb) -> 'tags', '[]'::jsonb, 'no tags yet');
select ok((:'r'::jsonb) -> 'account_manager' = 'null'::jsonb, 'no account manager yet');
select is((:'r'::jsonb) -> 'restaurant' ->> 'acquisition_channel', 'field_visit', 'how it found us');
select is(
  ((:'r'::jsonb) -> 'subscription') - array['plan_id', 'plan_code', 'plan_name', 'billing_cycle',
    'status', 'source', 'trial_ends_at', 'current_period_start', 'current_period_end',
    'grace_until', 'cancel_at_period_end', 'razorpay_subscription_id', 'razorpay_status',
    'next_plan_name', 'next_billing_cycle'],
  jsonb_build_object('cancel_reason', 'too_expensive', 'cancel_reason_detail', 'Wants a discount',
    'max_tables', (select max_tables from public.plans where code = 'starter'),
    'max_staff', (select max_staff from public.plans where code = 'starter')),
  'why it cancelled, and the plan''s limits'
);
select is((:'r'::jsonb) -> 'money', 'true'::jsonb, 'money is shown');
select is(
  (select e - 'payment_id' - 'created_at' from jsonb_array_elements((:'r'::jsonb) -> 'payments') as e),
  (select jsonb_build_object(
     'source', 'manual', 'purpose', p.purpose, 'amount_paise', 89900,
     'base_paise', p.base_paise, 'gst_paise', p.gst_paise, 'manual_mode', 'upi',
     'plan_name', pl.name, 'billing_cycle', p.billing_cycle, 'razorpay_payment_id', null,
     'recorded_by', null, 'period_start', p.period_start, 'period_end', p.period_end,
     'notes', p.notes)
   from public.subscription_payments p left join public.plans pl on pl.id = p.plan_id
   where p.restaurant_id = :'main'),
  'a payment with its GST split, plan and who recorded it'
);

-- ─── Overview ───────────────────────────────────────────────────────────────
select private.business_date(now(), 'Asia/Kolkata', 4) - 1 as last \gset
select b.starts_at + interval '1 hour' as last_at
from private.business_day_bounds(:'last'::date, :'last'::date, 'Asia/Kolkata', 4) as b \gset
-- A stored day inside 30, one inside 90 only, one older; the last finished day
-- is counted live whatever was stored for it.
insert into public.metrics_usage_daily (
  restaurant_id, business_day, orders, customer_orders, staff_orders, bills, gmv_paise
) values
  (:'main', :'last'::date - 5, 7, 5, 2, 3, 9000),
  (:'main', :'last'::date - 40, 4, 4, 0, 2, 5000),
  (:'main', :'last'::date - 95, 50, 50, 0, 50, 500000),
  (:'main', :'last'::date, 99, 99, 0, 99, 999900);
insert into public.dining_tables (restaurant_id, label, qr_token, sort_order)
values (:'main', 'L1', 'SA580LIVE0000001', 50);
insert into public.table_sessions (
  restaurant_id, dining_table_id, table_label_snapshot, status, is_approved, opened_at
)
select :'main', t.id, 'L1', 'open', true, :'last_at'::timestamptz
from public.dining_tables t where t.qr_token = 'SA580LIVE0000001';
insert into public.orders (restaurant_id, session_id, round_number, status, placed_via, idempotency_key, created_at)
select :'main', s.id, n, 'accepted', (case when n = 1 then 'customer' else 'staff' end)::public.order_placed_via,
  'sa580-live-' || n, :'last_at'::timestamptz
from public.table_sessions s, generate_series(1, 2) as n
where s.restaurant_id = :'main' and s.table_label_snapshot = 'L1';

select tests.authenticate_as_platform_admin(:'admin');
select public.platform_restaurant_overview(:'main') as ov \gset
select tests.clear_auth();

select is((:'ov'::jsonb) ->> 'last_day', :'last', 'up to the last finished business day');
select is(jsonb_array_length((:'ov'::jsonb) -> 'days'), 90, '90 days');
select is((:'ov'::jsonb) -> 'days' -> 0 ->> 'day', (:'last'::date - 89)::text, 'from 89 days before');
select is(
  (select e from jsonb_array_elements((:'ov'::jsonb) -> 'days') as e
   where e ->> 'day' = (:'last'::date - 40)::text),
  jsonb_build_object('day', :'last'::date - 40, 'orders', 4, 'gmv_paise', 5000),
  'a stored day'
);
select is(
  (select e from jsonb_array_elements((:'ov'::jsonb) -> 'days') as e
   where e ->> 'day' = :'last'),
  jsonb_build_object('day', :'last'::date, 'orders', 2, 'gmv_paise', 0),
  'the last finished day, live'
);
select is((:'ov'::jsonb) -> 'last_30',
  jsonb_build_object('orders', 9, 'customer_orders', 6, 'staff_orders', 3, 'bills', 3,
    'gmv_paise', 9000),
  'the last 30 days: stored and live, nothing older'
);
select is(
  (select array_agg(distinct u.restaurant_id::text)
   from private.platform_usage(:'last'::date - 5, :'last'::date, :'main') as u),
  array[:'main'],
  'usage for one restaurant only'
);

-- ─── Billing ────────────────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_change_plan(:'main', 'growth');
select tests.clear_auth();
update public.restaurant_subscriptions set status = 'past_due', source = 'manual',
  billing_cycle = 'monthly', grace_until = now() + interval '4 days', trial_ends_at = null,
  current_period_end = now() - interval '1 day'
  where restaurant_id = :'main';
insert into public.audit_logs (restaurant_id, actor_type, actor_user_id, actor_label, action,
  entity_type, after, created_at) values
  (:'main', 'platform_admin', :'admin', 'Platform admin', 'subscription.payment_link_sent',
   'restaurant_subscription', '{"payment_link_id": "plink_SA580a", "short_url": "https://rzp.io/a",
   "amount_paise": 106082, "purpose": "subscription", "months": 1}', now() - interval '3 days'),
  (:'main', 'platform_admin', :'admin', 'Platform admin', 'subscription.payment_link_sent',
   'restaurant_subscription', '{"payment_link_id": "plink_SA580b", "short_url": "https://rzp.io/b",
   "amount_paise": 58882, "purpose": "setup_fee", "months": null}', now() - interval '2 days'),
  (:'main', 'system', null, 'Razorpay', 'subscription.payment_received', 'subscription_payment',
   '{"payment_link_id": "plink_SA580a"}', now() - interval '1 day');

select tests.authenticate_as_platform_admin(:'admin');
select public.platform_restaurant_billing(:'main') as bl \gset
select tests.clear_auth();

select is((:'bl'::jsonb) -> 'dues' ->> 'bucket', 'payment_failed', 'its Dues bucket');
select is(((:'bl'::jsonb) -> 'dues' ->> 'due_paise')::bigint,
  (select d.due_paise from private.dues_rows() d where d.restaurant_id = :'main'),
  'what it owes, as the Dues page has it');
select is(
  (select jsonb_agg(e -> 'kind') from jsonb_array_elements((:'bl'::jsonb) -> 'reminders') as e),
  '["payment_failed"]'::jsonb, 'reminders emailed'
);
select is(
  (select jsonb_agg(jsonb_build_object('url', e ->> 'short_url', 'paid', e ->> 'paid_at' is not null,
     'amount', e -> 'amount_paise', 'actor', e ->> 'actor'))
   from jsonb_array_elements((:'bl'::jsonb) -> 'links') as e),
  jsonb_build_array(
    jsonb_build_object('url', 'https://rzp.io/b', 'paid', false, 'amount', 58882,
      'actor', 'platform580@admin.test'),
    jsonb_build_object('url', 'https://rzp.io/a', 'paid', true, 'amount', 106082,
      'actor', 'platform580@admin.test')
  ),
  'payment links, newest first, and whether each was paid'
);
select is(
  (select jsonb_agg(e ->> 'action') from jsonb_array_elements((:'bl'::jsonb) -> 'history') as e),
  '["subscription.plan_changed"]'::jsonb,
  'the subscription''s history (payments and links have their own lists)'
);
select is((:'bl'::jsonb) -> 'history' -> 0 -> 'after' ->> 'plan_code', 'growth', 'with what changed');

select tests.authenticate_as_platform_admin(:'admin');
select (public.platform_restaurant_billing(:'other') -> 'dues') as other_dues \gset
select tests.clear_auth();
select is(:'other_dues'::jsonb, 'null'::jsonb, 'nothing due on a fresh trial');

-- ─── Usage ──────────────────────────────────────────────────────────────────
select private.business_date(now(), 'Asia/Kolkata', 4) - 2 as stored_to \gset
insert into public.metrics_usage_daily (restaurant_id, business_day, orders, hourly_orders)
values
  (:'main', :'stored_to'::date - 10, 3,
    array_fill(0, array[19]) || array[3] || array_fill(0, array[4])),
  (:'main', :'stored_to'::date - 100, 8,
    array_fill(0, array[12]) || array[8] || array_fill(0, array[11]));
insert into public.plan_limit_events (restaurant_id, kind, feature, created_at) values
  (:'main', 'tables', null, now() - interval '2 days'),
  (:'main', 'tables', null, now() - interval '1 day'),
  (:'main', 'feature', 'kitchen_display', now() - interval '5 days'),
  (:'main', 'staff', null, now() - interval '120 days');

select tests.authenticate_as_platform_admin(:'admin');
select public.platform_restaurant_usage(:'main') as us \gset
select tests.clear_auth();

select is((:'us'::jsonb) ->> 'to', :'stored_to', 'stored days only');
select is((:'us'::jsonb) ->> 'from', (:'stored_to'::date - 83)::text, 'twelve weeks of them');
select is((:'us'::jsonb) -> 'hours',
  jsonb_build_array(jsonb_build_object(
    'weekday', extract(isodow from :'stored_to'::date - 10)::int, 'hour', 19, 'orders', 3)),
  'orders by the business day''s weekday and the clock hour; older days left out'
);
select is(
  (select jsonb_agg(jsonb_build_object('kind', e ->> 'kind', 'feature', e ->> 'feature',
     'count', e -> 'count'))
   from jsonb_array_elements((:'us'::jsonb) -> 'limit_hits') as e),
  jsonb_build_array(
    jsonb_build_object('kind', 'tables', 'feature', null, 'count', 2),
    jsonb_build_object('kind', 'feature', 'feature', 'kitchen_display', 'count', 1)
  ),
  'plan limits it ran into in 90 days, latest first'
);

-- ─── Notes ──────────────────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_add_note(:'main', '  Prefers calls after 4 pm  ') as note_a \gset
-- One transaction has one now(): this note was written a minute earlier.
select tests.clear_auth();
update public.restaurant_notes set created_at = now() - interval '1 minute' where id = :'note_a';
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_add_note(:'main', 'Owner is travelling', true) as note_b \gset
select throws_ok(format('select public.platform_add_note(%L, %L)', :'main', '   '),
  'P0001', 'INVALID_INPUT', 'a note says something');
select throws_ok(format('select public.platform_add_note(%L, %L)', :'main', repeat('x', 2001)),
  'P0001', 'INVALID_INPUT', 'up to 2,000 characters');
select throws_ok(format('select public.platform_add_note(%L, %L)', gen_random_uuid(), 'x'),
  'P0001', 'RESTAURANT_NOT_FOUND', 'on a restaurant that exists');
select lives_ok(format('select public.platform_edit_note(%L, %L)', :'note_a', 'Prefers calls after 5 pm'),
  'the author edits their note');
select lives_ok(format('select public.platform_edit_note(%L, %L)', :'note_a', 'Prefers calls after 5 pm'),
  'saving it unchanged is fine');
select lives_ok(format('select public.platform_pin_note(%L, true)', :'note_a'), 'pinned');
select lives_ok(format('select public.platform_pin_note(%L, true)', :'note_a'), 'pinned again: nothing to do');
select public.platform_list_notes(:'main') as notes \gset
select tests.authenticate_as_platform_admin(:'admin_b');
select throws_ok(format('select public.platform_edit_note(%L, %L)', :'note_a', 'Mine now'),
  'P0001', 'NOTE_LOCKED', 'only by its author');
select lives_ok(format('select public.platform_pin_note(%L, false)', :'note_b'), 'anyone pins or unpins');
select public.platform_list_notes(:'main') as notes_b \gset
select throws_ok(format('select public.platform_pin_note(%L, true)', gen_random_uuid()),
  'P0001', 'NOT_FOUND', 'a note that exists');
select tests.clear_auth();

select is(
  (select jsonb_agg(jsonb_build_object('body', e ->> 'body', 'pinned', e -> 'pinned',
     'author', e ->> 'author', 'editable', e ->> 'editable_until' is not null,
     'edited', e ->> 'edited_at' is not null))
   from jsonb_array_elements(:'notes'::jsonb) as e),
  jsonb_build_array(
    jsonb_build_object('body', 'Owner is travelling', 'pinned', true,
      'author', 'platform580@admin.test', 'editable', true, 'edited', false),
    jsonb_build_object('body', 'Prefers calls after 5 pm', 'pinned', true,
      'author', 'platform580@admin.test', 'editable', true, 'edited', true)
  ),
  'pinned notes first, newest first, trimmed; editable by their author for now'
);
select is(
  (select jsonb_agg(e -> 'editable_until') from jsonb_array_elements(:'notes_b'::jsonb) as e),
  '[null, null]'::jsonb,
  'nobody else can edit them'
);
select is(
  (select array_agg(a.action order by a.created_at, a.action) from public.audit_logs a
   where a.entity_type = 'restaurant_note' and a.restaurant_id = :'main'),
  array['restaurant.note_added', 'restaurant.note_added', 'restaurant.note_edited',
    'restaurant.note_pinned', 'restaurant.note_unpinned'],
  'every change audited, and only changes'
);
select is(
  (select jsonb_build_object('before', a.before, 'after', a.after) from public.audit_logs a
   where a.action = 'restaurant.note_edited' and a.entity_id = :'note_a'),
  jsonb_build_object('before', jsonb_build_object('body', 'Prefers calls after 4 pm'),
    'after', jsonb_build_object('body', 'Prefers calls after 5 pm')),
  'an edit keeps the text before and after'
);
update public.restaurant_notes set created_at = now() - interval '16 minutes' where id = :'note_a';
select tests.authenticate_as_platform_admin(:'admin');
select throws_ok(format('select public.platform_edit_note(%L, %L)', :'note_a', 'Too late'),
  'P0001', 'NOTE_LOCKED', 'within 15 minutes of writing it');
select tests.clear_auth();

-- ─── Tags ───────────────────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_create_tag(' Pilot ', 'orange') as tag_pilot \gset
select public.platform_create_tag('Indore', 'teal') as tag_indore \gset
select throws_ok($$select public.platform_create_tag('pilot', 'green')$$,
  'P0001', 'TAG_EXISTS', 'one tag per name, whatever its case');
select throws_ok($$select public.platform_create_tag('VIP', 'purple')$$,
  'P0001', 'INVALID_INPUT', 'a colour from the set');
select throws_ok(format('select public.platform_create_tag(%L, %L)', repeat('x', 31), 'red'),
  'P0001', 'INVALID_INPUT', 'a short name');
select public.platform_set_restaurant_tags(:'main', array[:'tag_pilot', :'tag_indore']::uuid[]);
select public.platform_set_restaurant_tags(:'main', array[:'tag_pilot', :'tag_indore']::uuid[]);
select public.platform_set_restaurant_tags(:'other', array[:'tag_indore']::uuid[]);
select throws_ok(format('select public.platform_set_restaurant_tags(%L, array[%L]::uuid[])',
  :'main', gen_random_uuid()), 'P0001', 'NOT_FOUND', 'tags that exist');
select (public.platform_get_restaurant(:'main') -> 'tags') as main_tags \gset
select tests.clear_auth();

select is(:'main_tags'::jsonb,
  jsonb_build_array(
    jsonb_build_object('id', :'tag_indore', 'name', 'Indore', 'colour', 'teal'),
    jsonb_build_object('id', :'tag_pilot', 'name', 'Pilot', 'colour', 'orange')
  ),
  'its tags, by name'
);
select is(
  (select jsonb_agg(jsonb_build_object('before', a.before, 'after', a.after))
   from public.audit_logs a where a.action = 'restaurant.tags_changed' and a.restaurant_id = :'main'),
  jsonb_build_array(jsonb_build_object('before', '{"tags": []}'::jsonb,
    'after', '{"tags": ["Indore", "Pilot"]}'::jsonb)),
  'a change of tags is audited by name; setting the same ones is not'
);

-- ─── Account manager ────────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_set_account_manager(:'main', :'admin');
select public.platform_set_account_manager(:'main', :'admin');
select throws_ok(format('select public.platform_set_account_manager(%L, %L)', :'main', :'plain'),
  'P0001', 'ADMIN_NOT_FOUND', 'a member of the MenuMesh team');
select (public.platform_get_restaurant(:'main') -> 'account_manager') as manager \gset
select public.platform_team() as team \gset
select tests.clear_auth();
select is(:'manager'::jsonb, jsonb_build_object('user_id', :'admin', 'email', 'platform580@admin.test'),
  'the account manager');
select is(
  (select count(*)::int from public.audit_logs a
   where a.action = 'restaurant.account_manager_changed' and a.restaurant_id = :'main'),
  1, 'audited once');
select ok(:'team'::jsonb @> jsonb_build_array(
    jsonb_build_object('user_id', :'admin', 'email', 'platform580@admin.test'),
    jsonb_build_object('user_id', :'admin_b', 'email', 'platform580b@admin.test')),
  'the team to choose from');

-- ─── The list ───────────────────────────────────────────────────────────────
create function pg_temp.names(p_filters jsonb)
returns text[] language sql as $$
  select coalesce(array_agg(e ->> 'slug' order by e ->> 'slug'), '{}')
  from jsonb_array_elements(public.platform_list_restaurants(p_filters) -> 'rows') as e
  where e ->> 'slug' like 'sa580-%';
$$;
select tests.authenticate_as_platform_admin(:'admin');
select is(pg_temp.names(jsonb_build_object('tag', :'tag_pilot')), array['sa580-main'], 'by tag');
select is(pg_temp.names(jsonb_build_object('tag', :'tag_indore')), array['sa580-main', 'sa580-other'],
  'every restaurant with the tag');
select is(pg_temp.names('{"manager": "me"}'), array['sa580-main'], 'my restaurants');
select is(pg_temp.names(jsonb_build_object('manager', :'admin')), array['sa580-main'],
  'a team member''s restaurants');
select is(pg_temp.names('{"manager": "none"}'), array['sa580-other'], 'no account manager');
select throws_ok($$select public.platform_list_restaurants('{"manager": "someone"}')$$,
  'P0001', 'INVALID_INPUT', 'me, none or a team member');
select is(
  (select jsonb_build_object('tags', e -> 'tags', 'manager', e -> 'account_manager')
   from jsonb_array_elements(public.platform_list_restaurants('{"q": "sa580-main"}') -> 'rows') as e),
  jsonb_build_object('tags', :'main_tags'::jsonb, 'manager', '"platform580@admin.test"'::jsonb),
  'each row has its tags and account manager'
);
select tests.authenticate_as_platform_admin(:'admin_b');
select is(pg_temp.names('{"manager": "me"}'), '{}'::text[], 'my restaurants are mine');
select tests.clear_auth();

-- ─── Activity: notes ────────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_activity(:'main', null, null, 100) as act \gset
select public.platform_activity(:'main', array['note']) as act_notes \gset
select public.platform_activity(:'main', array['team'], null, 100) as act_team \gset
select tests.clear_auth();

select ok(
  (select count(distinct e ->> 'kind') from jsonb_array_elements((:'act'::jsonb) -> 'items') as e) >= 5,
  'the timeline merges five kinds or more'
);
select is(
  (select jsonb_agg((e -> 'data') - 'note_id') from jsonb_array_elements((:'act_notes'::jsonb) -> 'items') as e),
  '[{"body": "Owner is travelling", "pinned": false}, {"body": "Prefers calls after 5 pm", "pinned": true}]'::jsonb,
  'notes, newest first'
);
select is(
  (select e ->> 'actor' from jsonb_array_elements((:'act_notes'::jsonb) -> 'items') as e limit 1),
  'platform580@admin.test', 'by their author'
);
select is(
  (select array_agg(distinct e -> 'data' ->> 'action' order by e -> 'data' ->> 'action')
   from jsonb_array_elements((:'act_team'::jsonb) -> 'items') as e),
  array['restaurant.account_manager_changed', 'restaurant.tags_changed',
    'subscription.payment_link_sent', 'subscription.plan_changed'],
  'note changes aren''t team items; tags and the account manager are'
);

-- ─── Deleting a tag ─────────────────────────────────────────────────────────
select tests.authenticate_as_platform_admin(:'admin');
select public.platform_delete_tag(:'tag_indore');
select throws_ok(format('select public.platform_delete_tag(%L)', :'tag_indore'),
  'P0001', 'NOT_FOUND', 'once');
select tests.clear_auth();
select is((select count(*)::int from public.restaurant_tags where tag_id = :'tag_indore'), 0,
  'off every restaurant');
select is(
  (select a.before from public.audit_logs a where a.action = 'platform_tag.deleted'
   and a.entity_id = :'tag_indore'),
  '{"name": "Indore", "colour": "teal", "restaurants": 2}'::jsonb,
  'audited, with how many restaurants had it'
);

-- ─── What the restaurant sees ───────────────────────────────────────────────
-- Notes, tags and the account manager are the team's: the restaurant's owner
-- reads none of them, nor their audit rows, but still its other audit rows.
select tests.authenticate_as(:'owner');
select is((select count(*)::int from public.restaurant_notes), 0, 'no notes');
select is((select count(*)::int from public.restaurant_tags), 0, 'no tags on it');
select is((select count(*)::int from public.platform_tags), 0, 'no tags at all');
select is(
  (select count(*)::int from public.audit_logs
   where entity_type in ('restaurant_note', 'restaurant_tags', 'account_manager')),
  0, 'none of their audit rows'
);
select ok(
  (select count(*) from public.audit_logs where action = 'subscription.plan_changed') = 1,
  'its other audit rows, as before'
);
select tests.clear_auth();

-- ─── Who may ────────────────────────────────────────────────────────────────
select tests.authenticate_as(:'owner');
select throws_ok(format('select public.platform_get_restaurant(%L)', :'main'),
  'P0001', 'FORBIDDEN', 'not a restaurant owner');
select throws_ok(format('select public.platform_restaurant_overview(%L)', :'main'),
  'P0001', 'FORBIDDEN', 'overview');
select throws_ok(format('select public.platform_restaurant_billing(%L)', :'main'),
  'P0001', 'FORBIDDEN', 'billing');
select throws_ok(format('select public.platform_restaurant_usage(%L)', :'main'),
  'P0001', 'FORBIDDEN', 'usage');
select throws_ok(format('select public.platform_list_notes(%L)', :'main'),
  'P0001', 'FORBIDDEN', 'notes');
select throws_ok(format('select public.platform_add_note(%L, %L)', :'main', 'x'),
  'P0001', 'FORBIDDEN', 'writing notes');
select throws_ok($$select public.platform_create_tag('x', 'red')$$, 'P0001', 'FORBIDDEN', 'tags');
select throws_ok(format('select public.platform_set_account_manager(%L, null)', :'main'),
  'P0001', 'FORBIDDEN', 'account manager');
select throws_ok($$select public.platform_team()$$, 'P0001', 'FORBIDDEN', 'the team');
select tests.authenticate_as_platform_admin(:'admin', 'aal1');
select throws_ok(format('select public.platform_restaurant_overview(%L)', :'main'),
  'P0001', 'MFA_REQUIRED', 'needs the second factor');
select throws_ok(format('select public.platform_add_note(%L, %L)', :'main', 'x'),
  'P0001', 'MFA_REQUIRED', 'notes too');
select throws_ok(format('select public.platform_set_restaurant_tags(%L, null)', :'main'),
  'P0001', 'MFA_REQUIRED', 'tags too');
select tests.as_anon();
select throws_ok(format('select public.platform_restaurant_billing(%L)', :'main'),
  '42501', null, 'never anonymous');
select throws_ok(format('select public.platform_edit_note(%L, %L)', :'note_a', 'x'),
  '42501', null, 'notes neither');
select tests.clear_auth();

select * from finish();
rollback;
