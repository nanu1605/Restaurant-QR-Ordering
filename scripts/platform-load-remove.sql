-- Removes the local load data (scripts/platform-load.sql): the load-*
-- restaurants with everything made for them, and the load leads. Run by
-- `pnpm seed:platform-load` before loading again, or alone with
-- `pnpm seed:platform-load:remove`; both query the local stack only.
do $$
begin
  create temp table load_ids on commit drop as
  select id from public.restaurants where slug like 'load-%';

  delete from public.orders where restaurant_id in (select id from load_ids);
  delete from public.table_sessions where restaurant_id in (select id from load_ids);
  delete from public.dining_tables where restaurant_id in (select id from load_ids);
  delete from public.subscription_payments where restaurant_id in (select id from load_ids);
  delete from public.subscription_reminders where restaurant_id in (select id from load_ids);
  delete from public.restaurant_subscriptions where restaurant_id in (select id from load_ids);
  delete from public.metrics_usage_daily where restaurant_id in (select id from load_ids);
  delete from public.metrics_subscription_daily where restaurant_id in (select id from load_ids);
  delete from public.audit_logs where restaurant_id in (select id from load_ids);
  delete from public.restaurants where id in (select id from load_ids);
  delete from public.site_leads where name like 'Load lead %';
  -- Notes and the tags on restaurants went with them.
  delete from public.platform_tags where name like 'Load %';
end
$$;
