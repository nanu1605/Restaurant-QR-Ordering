-- Restartable jobs: the minute job's first question (docs/DECISIONS.md VPS-25, VPS-29).
--
-- /api/cron/jobs asks which kinds of job have work waiting before it starts any, so an idle
-- minute is this one read, of nearly empty indexes and the small announcements table, and writes
-- nothing.

-- Each kind by its own test: the data exports (VPS-26), the Hindi names (VPS-27) and the
-- announcement emails (VPS-28).
create function public.jobs_waiting()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'data_exports', private.export_jobs_waiting(),
    'hindi_names', private.hindi_names_waiting(),
    'announcement_emails', private.announcement_emails_waiting()
  );
$$;

-- ─── Grants ─────────────────────────────────────────────────────────────────
revoke execute on function public.jobs_waiting() from public, anon, authenticated;
grant execute on function public.jobs_waiting() to service_role;
