-- The manifest's counts (docs/DECISIONS.md VPS-40): one line per table of the app's, Auth's and
-- Storage's schemas, "table <schema>.<table> <rows>", and "migration <newest version>". backup.sh
-- writes them for each database after its dump; restore.sh counts the restored database with the
-- same file and compares, and pitr.sh counts a replayed cluster with it (VPS-43). Run with psql -X
-- -At -v ON_ERROR_STOP=1. Nothing here compares text by the database's collation, which pitr.sh's
-- Postgres, with another ICU, must not do: the names sort as name does, by bytes, and the newest
-- version is found by bytes too, the same for the digits it holds.
select format('select %L || '' '' || count(*) from %I.%I',
              'table ' || format('%I.%I', schemaname, tablename), schemaname, tablename)
  from pg_tables
 where schemaname in ('public', 'private', 'auth', 'storage', 'supabase_migrations')
 order by schemaname, tablename
\gexec
select to_regclass('supabase_migrations.schema_migrations') is not null as has_history \gset
\if :has_history
select 'migration ' || coalesce(max(version collate "C"), 'none') from supabase_migrations.schema_migrations;
\else
select 'migration none';
\endif
