#!/bin/sh
# The migrate image's runner (docs/DECISIONS.md VPS-39): applies the migrations the image holds in
# /migrations (supabase/migrations) to the database the libpq variables name (PGHOST, PGUSER,
# PGPASSWORD, ...), and keeps supabase_migrations.schema_migrations as the supabase CLI does: its
# table, made with its statements, and one row per applied file with the file's version and name.
# So hosted staging's history, which the CLI wrote, carries on, and `supabase migration list` reads
# either database. The rows' statements column stays empty: only `supabase migration fetch` reads
# it, and the files are in the repository.
#
# app-deploy runs it as a one-off (run --rm --no-deps -T) before it switches a web image, for at
# most 600 s, and switches nothing unless it exits 0:
#
#   0  applied, or nothing to apply
#   1  a migration failed: it is rolled back and not recorded; the files before it stay applied
#   2  refused: the database has a version this image lacks (an older image after a newer one), or
#      a file is older than the newest applied version (out of order, as the CLI refuses too)
#   3  no connection to the database
#
# One session applies every file, each in a transaction with its history row, under an advisory
# lock. Prints one line per applied file and a summary; psql's errors are terse (no DETAIL, which
# can quote a row's values) and nothing prints a value.
set -eu

if [ "$#" -ne 0 ]; then
  echo 'usage: menumesh-migrate (settings from PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE)' >&2
  exit 2
fi
dir=/migrations
# The files are UTF-8 (the Hindi menu words), whatever the locale; and a host that never answers
# fails in seconds, not minutes.
export PGCLIENTENCODING=UTF8 PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-10}"
# The runner's own advisory lock: one migrate at a time per database.
lock=7203190436219104

run_psql() {
  psql -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=terse "$@"
}
# psql exits 2 when it couldn't connect, or lost the connection.
psql_failed() {
  if [ "$1" -eq 2 ]; then
    echo 'migrate: no connection to the database, or it was lost' >&2
    exit 3
  fi
  echo "migrate: $2" >&2
  exit 1
}

# The image's files, as the CLI reads them: <version>_<name>.sql, the version all digits. One name
# per line; the loop splits on line breaks only and never globs.
files=$(
  cd "$dir"
  for file in *.sql; do
    if [ -e "$file" ]; then printf '%s\n' "$file"; fi
  done | LC_ALL=C sort
)
local_list=
set -f
saved_ifs=$IFS
IFS='
'
for file in $files; do
  version=${file%%_*}
  name=${file#*_}
  name=${name%.sql}
  case $file in [0-9]*_*.sql) ;; *) version=x ;; esac
  case $version in
    *[!0-9]*)
      echo "migrate: skipping $file: not <version>_<name>.sql"
      continue
      ;;
  esac
  # Only names that need no quoting in SQL or in a list.
  case $name in
    '' | *[!A-Za-z0-9_.-]*)
      echo "migrate: refused: $file has a name other than letters, digits, '.', '_' and '-'" >&2
      exit 2
      ;;
  esac
  local_list="$local_list$version $name $file
"
done
IFS=$saved_ifs
set +f
duplicate=$(printf '%s' "$local_list" | awk '{ print $1 }' | uniq -d | head -n 1)
if [ -n "$duplicate" ]; then
  echo "migrate: refused: two files have the version $duplicate" >&2
  exit 2
fi

# The versions applied so far; none when the CLI's table doesn't exist yet.
rc=0
applied=$(
  run_psql -At <<'SQL'
select to_regclass('supabase_migrations.schema_migrations') is not null as has_history \gset
\if :has_history
select coalesce(string_agg(version, ' ' order by version collate "C"), '')
  from supabase_migrations.schema_migrations;
\else
select '';
\endif
SQL
) || rc=$?
[ "$rc" -eq 0 ] || psql_failed "$rc" "couldn't read the migration history"

# Sorts the image's files against the history: versions the image lacks, files older than the newest
# applied version, and the files to apply, in order.
plan=$(
  {
    for version in $applied; do echo "applied $version"; done
    printf '%s' "$local_list" | awk 'NF == 3 { print "local " $0 }'
  } | LC_ALL=C awk '
    $1 == "applied" { done[$2] = 1; if (($2 "") > (newest "")) newest = $2; next }
    $1 == "local" { known[$2] = 1; version[++n] = $2; name[n] = $3; file[n] = $4 }
    END {
      for (v in done) if (!(v in known)) print "unknown " v
      for (i = 1; i <= n; i++) {
        if (version[i] in done) continue
        print ((version[i] "") < (newest "") ? "early " : "pending ") version[i] " " name[i] " " file[i]
      }
      print "newest " (newest == "" ? "none" : newest)
    }' | LC_ALL=C sort -k1,1 -s
)
newest=$(printf '%s\n' "$plan" | awk '$1 == "newest" { print $2 }')
unknown=$(printf '%s\n' "$plan" | awk '$1 == "unknown" { print $2 }' | LC_ALL=C sort | tr '\n' ' ')
early=$(printf '%s\n' "$plan" | awk '$1 == "early" { print $4 }' | tr '\n' ' ')
if [ -n "$unknown" ]; then
  echo "migrate: refused: the database has versions this image lacks: ${unknown% }" >&2
  echo 'migrate: an older migrate image after a newer one? Deploy the newer one again.' >&2
fi
if [ -n "$early" ]; then
  echo "migrate: refused: older than the newest applied version ($newest): ${early% }" >&2
  echo 'migrate: give these files a version after it, as the CLI asks without --include-all.' >&2
fi
[ -z "$unknown$early" ] || exit 2

pending=$(printf '%s\n' "$plan" | awk '$1 == "pending" { print $2, $3, $4 }')
if [ -z "$pending" ]; then
  echo "migrate: nothing to apply, at $newest"
  exit 0
fi

# One session: the lock, the CLI's own table (its statements, as the CLI runs them), a check that no
# other run changed the history meanwhile, then each file in a transaction with its row. At the
# first error ON_ERROR_STOP ends the session, and the open transaction rolls back.
count=$(printf '%s\n' "$pending" | awk 'END { print NR }')
last=$(printf '%s\n' "$pending" | awk 'END { print $1 }')
rc=0
{
  printf '%s\n' '\o /dev/null' \
    'set client_min_messages = warning;' \
    "set lock_timeout = '2min';" \
    "select pg_advisory_lock($lock);" \
    'reset lock_timeout;' \
    'CREATE SCHEMA IF NOT EXISTS supabase_migrations;' \
    'CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY);' \
    'ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS statements text[];' \
    'ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS name text;' \
    "select coalesce(string_agg(version, ' ' order by version collate \"C\"), '') <> '$applied' as changed" \
    '  from supabase_migrations.schema_migrations \gset' \
    '\if :changed' \
    "do \$\$ begin raise exception 'migrate: the history changed while this run waited: run it again'; end \$\$;" \
    '\endif'
  printf '%s\n' "$pending" | while read -r version name file; do
    printf '%s\n' 'begin;' \
      "\\i $dir/$file" \
      "insert into supabase_migrations.schema_migrations (version, name) values ('$version', '$name');" \
      'commit;' \
      "\\echo migrate: applied $file"
  done
} | run_psql || rc=$?
[ "$rc" -eq 0 ] ||
  psql_failed "$rc" 'stopped at the error above: the file it was in is rolled back and not recorded, and the files before it stay applied'
echo "migrate: applied $count, now at $last"
