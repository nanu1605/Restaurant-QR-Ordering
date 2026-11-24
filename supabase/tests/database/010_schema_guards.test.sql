-- Structural guards: every future migration must keep these true.
begin;

create extension if not exists pgtap with schema extensions;

select no_plan();

-- ─── RLS and privileges ─────────────────────────────────────────────────────
select is_empty(
  $$
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
  $$,
  'RLS is enabled on every public table'
);

select is_empty(
  $$
    select table_name || ':' || privilege_type
    from information_schema.role_table_grants
    where grantee = 'anon' and table_schema = 'public'
  $$,
  'anon has no privileges on any public table'
);

select is_empty(
  $$
    select table_name || ':' || privilege_type
    from information_schema.role_table_grants
    where grantee = 'authenticated'
      and table_schema = 'public'
      and privilege_type in ('TRUNCATE', 'REFERENCES', 'TRIGGER')
  $$,
  'authenticated never gets TRUNCATE, REFERENCES or TRIGGER'
);

-- No table accepts direct writes: menu and tables change through business
-- functions (P2-3), and plans through platform_update_plan (P7-10).
select is_empty(
  $$
    select table_name || ':' || privilege_type
    from information_schema.role_table_grants
    where grantee = 'authenticated'
      and table_schema = 'public'
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
  $$,
  'no table accepts direct writes from authenticated users'
);

select is_empty(
  $$
    select table_name || '.' || column_name
    from information_schema.column_privileges
    where grantee = 'authenticated'
      and table_schema = 'public'
      and privilege_type in ('INSERT', 'UPDATE')
  $$,
  'no column-level write grants remain'
);

select is_empty(
  $$
    select n.nspname || '.' || p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and has_function_privilege('anon', p.oid, 'execute')
  $$,
  'anon cannot execute any public or private function'
);

-- Every function callable by signed-in users must be listed here on purpose.
select set_eq(
  $$
    select n.nspname || '.' || p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and has_function_privilege('authenticated', p.oid, 'execute')
  $$,
  $$
    values
      ('public.is_platform_admin'),
      ('public.platform_admin_status'),
      ('public.member_role'),
      ('public.has_role'),
      ('public.restaurant_access'),
      ('public.restaurant_plan'),
      ('private.my_restaurant_ids'),
      ('private.is_valid_timezone'),
      -- Phase 2: menu and tables
      ('public.admin_create_category'),
      ('public.admin_update_category'),
      ('public.admin_delete_category'),
      ('public.admin_add_categories'),
      ('public.admin_reorder'),
      ('public.admin_save_menu_item'),
      ('public.admin_update_menu_item'),
      ('public.staff_set_item_availability'),
      ('public.admin_create_tables'),
      ('public.admin_update_table'),
      ('public.admin_regenerate_qr'),
      -- Phase 2: staff, waiters, settings (admin_create_staff is service_role only)
      ('public.admin_list_staff'),
      ('public.admin_update_staff'),
      ('public.admin_deactivate_staff'),
      ('public.admin_reactivate_staff'),
      ('public.admin_reset_staff_password'),
      ('public.admin_upsert_waiter'),
      ('public.admin_set_waiter_on_duty'),
      ('public.admin_delete_waiter'),
      ('public.admin_waiters_overview'),
      ('public.admin_update_settings'),
      -- Phase 4: live board, orders, removals, assignment
      ('public.staff_get_board'),
      ('public.staff_approve_order'),
      ('public.staff_reject_order'),
      ('public.staff_update_item_status'),
      ('public.staff_mark_order_served'),
      ('public.staff_revert_item_status'),
      ('public.staff_place_order'),
      ('public.staff_remove_item'),
      ('public.admin_remove_order'),
      ('public.staff_close_session_unbilled'),
      ('public.admin_assign_waiter'),
      ('public.admin_unassign_waiter'),
      -- Phase 5: billing, payments, total orders
      ('public.admin_billing_sessions'),
      ('public.admin_preview_bill'),
      ('public.admin_generate_bill'),
      ('public.admin_sample_bill'),
      ('public.admin_get_bill'),
      ('public.admin_record_payment'),
      ('public.admin_void_bill'),
      ('public.admin_increment_print_count'),
      ('public.admin_total_orders'),

      -- Phase 6: dashboard and reports
      ('public.admin_report_sales'),
      ('public.admin_report_items'),
      ('public.admin_report_tables'),
      ('public.admin_report_waiters'),
      ('public.admin_report_activity'),
      -- Phase 7: super-admin panel
      ('public.platform_overview'),
      ('public.platform_list_restaurants'),
      ('public.platform_list_subscriptions'),
      ('public.platform_get_restaurant'),
      ('public.platform_restaurant_lookalikes'),
      ('public.platform_set_restaurant_status'),
      ('public.platform_extend_trial'),
      ('public.platform_change_plan'),
      ('public.platform_record_manual_payment'),
      ('public.platform_reset_owner_password'),
      ('public.platform_support_view'),
      ('public.platform_update_plan'),
      ('public.platform_list_audit'),
      -- Phase 8: Razorpay tools
      ('public.platform_audit_payment_link'),
      ('public.platform_reprocess_webhook'),
      -- Phase 9: table service
      ('public.staff_update_service_request'),
      ('public.staff_move_session'),
      -- Phase 9: menu add-ons
      ('public.admin_save_addon_group'),
      ('public.admin_delete_addon_group'),
      ('public.staff_set_addon_availability'),
      -- Phase 7: menu import
      ('public.menu_import_create'),
      ('public.menu_import_set_draft'),
      ('public.menu_import_commit'),
      ('public.menu_import_discard'),
      -- Phase 11: the worker panel's language
      ('public.member_set_ui_lang'),
      -- Phase 12: platform settings, payments and tracking
      ('public.platform_update_settings'),
      ('public.platform_record_setup_fee'),
      ('public.platform_list_payments'),
      ('public.platform_list_dues'),
      ('public.platform_save_view'),
      ('public.platform_delete_view'),
      ('public.platform_search'),
      -- the restaurants phone index runs it for whoever writes a phone
      ('private.phone10'),
      ('public.member_record_plan_limit'),
      ('public.admin_record_qr_use'),
      ('public.admin_record_cancel_reason'),
      -- Home (12e)
      ('public.platform_home'),
      ('public.platform_needs_attention'),
      ('public.platform_snooze'),
      ('public.platform_activity'),
      ('public.platform_alerts'),
      ('public.platform_mark_alerts_seen'),
      -- Restaurant page (13a)
      ('public.platform_restaurant_overview'),
      ('public.platform_restaurant_billing'),
      ('public.platform_restaurant_usage'),
      ('public.platform_list_notes'),
      ('public.platform_add_note'),
      ('public.platform_edit_note'),
      ('public.platform_pin_note'),
      ('public.platform_create_tag'),
      ('public.platform_delete_tag'),
      ('public.platform_set_restaurant_tags'),
      ('public.platform_team'),
      ('public.platform_set_account_manager'),
      -- Onboarding and support (13b)
      ('public.admin_onboarding'),
      ('public.admin_start_screenshot_upload'),
      ('public.admin_create_support_request'),
      ('public.admin_list_support_requests'),
      ('public.platform_list_support_requests'),
      ('public.platform_get_support_request'),
      ('public.platform_update_support_request'),
      ('public.platform_add_support_note'),
      -- Support sessions (13c)
      ('public.admin_allow_support_access'),
      ('public.admin_end_support_access'),
      ('public.platform_start_support_session'),
      ('public.platform_onboarding_support_session'),
      ('public.platform_end_support_session'),
      -- Growth (13d)
      ('public.platform_list_leads'),
      ('public.platform_get_lead'),
      ('public.platform_create_lead'),
      ('public.platform_update_lead'),
      ('public.platform_add_lead_note'),
      ('public.platform_lead_matches'),
      ('public.platform_unfinished_signups'),
      ('public.platform_funnel'),
      ('public.platform_upgrade_opportunities'),
      ('public.platform_set_acquisition_channel'),
      -- Usage (13e)
      ('public.platform_usage_report'),
      -- Revenue (13f)
      ('public.platform_revenue_report'),
      ('public.platform_revenue_movements'),
      -- Team and roles (13g)
      ('public.platform_can'),
      ('public.platform_my_access'),
      ('public.platform_list_team'),
      ('public.platform_invite_member'),
      ('public.platform_renew_invite'),
      ('public.platform_update_member'),
      ('public.platform_list_offers'),
      ('public.platform_save_offer'),
      ('public.platform_set_deal'),
      ('public.platform_set_override'),
      ('public.platform_remove_override'),
      -- Announcements and standees (14c)
      ('public.platform_list_announcements'),
      ('public.platform_save_announcement'),
      ('public.member_announcements'),
      ('public.member_dismiss_announcement'),
      ('public.platform_save_standees'),
      ('public.platform_get_standees'),
      ('public.platform_list_standees'),
      -- System health (14d)
      ('public.platform_system'),
      ('public.platform_email_sends'),
      -- Close account (14e)
      ('public.platform_close_restaurant'),
      ('public.platform_reopen_restaurant'),
      ('public.platform_closure'),
      ('public.admin_request_data_export'),
      ('public.admin_data_export'),
      ('public.platform_request_data_export'),
      ('public.platform_data_export')
  $$,
  'authenticated can execute only the allowlisted functions'
);

-- Customers never call the database themselves: the server does, as service_role.
select set_eq(
  $$
    select p.proname::text
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'customer\_%'
      and has_function_privilege('service_role', p.oid, 'execute')
  $$,
  $$
    values ('customer_get_table'), ('customer_place_order'), ('customer_get_session'),
           ('customer_cancel_item'), ('customer_create_service_request')
  $$,
  'the customer functions are executable by the server (service role)'
);

select set_eq(
  $$
    select n.nspname || '.' || p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prosecdef
      and not exists (
        select 1 from unnest(p.proconfig) as c where c like 'search_path=%'
      )
  $$,
  $$ select null::text where false $$,
  'every security definer function pins its search_path'
);

-- ─── Tenant tables ──────────────────────────────────────────────────────────
select col_not_null('public', t, 'restaurant_id', t || '.restaurant_id is not null')
from unnest(array[
  'restaurant_members', 'waiters', 'dining_tables', 'menu_categories', 'menu_items',
  'menu_item_variants', 'table_sessions', 'session_waiter_assignments', 'orders',
  'order_items', 'invoice_counters', 'bills', 'bill_payments',
  'restaurant_subscriptions', 'subscription_payments', 'menu_imports', 'subscription_reminders',
  'service_requests', 'menu_addon_groups', 'menu_addons', 'menu_item_addon_groups',
  'restaurant_tags', 'restaurant_notes', 'restaurant_account_managers', 'support_requests',
  'support_request_events', 'support_screenshot_uploads', 'support_sessions', 'standees',
  'announcement_emails', 'announcement_email_failures'
]) as t;

select is_empty(
  $$
    select t
    from unnest(array[
      'restaurant_members', 'waiters', 'dining_tables', 'menu_categories', 'menu_items',
      'menu_item_variants', 'table_sessions', 'session_waiter_assignments', 'orders',
      'order_items', 'invoice_counters', 'bills', 'bill_payments', 'audit_logs',
      'restaurant_subscriptions', 'subscription_payments', 'menu_imports', 'subscription_reminders',
      'service_requests', 'menu_addon_groups', 'menu_addons', 'menu_item_addon_groups',
      'restaurant_tags', 'restaurant_notes', 'restaurant_account_managers', 'support_requests',
      'support_request_events', 'support_screenshot_uploads', 'support_sessions', 'standees',
      'announcement_emails', 'announcement_email_failures'
    ]) as t
    where not exists (
      select 1
      from pg_index i
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
      where i.indrelid = ('public.' || t)::regclass and a.attname = 'restaurant_id'
    )
  $$,
  'every tenant table has an index leading with restaurant_id'
);

-- ─── Realtime ───────────────────────────────────────────────────────────────
select set_eq(
  $$
    select tablename::text from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
  $$,
  $$
    values ('orders'), ('order_items'), ('table_sessions'), ('bills'), ('menu_items'), ('waiters'),
           ('service_requests')
  $$,
  'realtime publishes exactly the live-board tables (spec §8.11)'
);

-- ─── Integrity constraints ──────────────────────────────────────────────────
select tests.create_restaurant('guards') as rest \gset
select tests.create_full_fixture(:'rest');

select throws_ok(
  format(
    $f$
      insert into public.table_sessions (restaurant_id, dining_table_id, table_label_snapshot)
      select %L, id, label from public.dining_tables where restaurant_id = %L
    $f$,
    :'rest', :'rest'
  ),
  '23505',
  null,
  'a table cannot have two open sessions'
);

select tests.create_restaurant('other') as other_rest \gset
select tests.create_full_fixture(:'other_rest');

select throws_ok(
  format(
    $f$
      insert into public.menu_items (restaurant_id, category_id, name, price_paise, food_type)
      select %L, id, 'Cross', 100, 'veg' from public.menu_categories where restaurant_id = %L
    $f$,
    :'rest', :'other_rest'
  ),
  '23503',
  null,
  'an item cannot point at another restaurant''s category'
);

select * from finish();

rollback;
