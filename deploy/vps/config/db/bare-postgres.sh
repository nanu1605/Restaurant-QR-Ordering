#!/bin/sh
# Entrypoint of restore-db and recover-db (deploy/vps/compose.yml; docs/DECISIONS.md VPS-40): a bare
# Postgres cluster in the same image as db, without Supabase's init, so that a full backup restores
# onto it without colliding with the image's own schemas, roles and extensions.
#
#   bare-postgres.sh [--throwaway]
#
# As root: an empty data directory gets initdb as postgres, with supabase_admin as its superuser
# (password POSTGRES_PASSWORD) and the image's own initdb arguments (its locale), as db's first start
# had; a directory holding a cluster that was shut down cleanly is started as it is, so restore.sh
# can refuse it by name; anything else is refused here, a cluster another server runs on too. Then
# postgres runs with the image's settings file and its custom directory (supautils' settings and
# extension scripts), so the same libraries are preloaded and every extension a backup holds is
# made as on db. --throwaway (restore-db, data in memory) also turns off fsync and full-page
# writes. Never prints the password.
set -eu

throwaway=
case ${1-} in
  --throwaway) throwaway=1 ;;
  '') ;;
  *)
    echo 'usage: bare-postgres.sh [--throwaway]' >&2
    exit 2
    ;;
esac

data=${PGDATA:-/var/lib/postgresql/data}
custom=/etc/postgresql-custom
if [ "$(id -u)" != 0 ]; then
  echo 'bare-postgres: run it as root, the image user: it hands the data directory to postgres' >&2
  exit 1
fi
if [ -z "${POSTGRES_PASSWORD:-}" ]; then
  echo 'bare-postgres: POSTGRES_PASSWORD is empty' >&2
  exit 1
fi
# The settings file includes supautils.conf and the rest of the custom directory: the image's own
# (restore-db), or their copies in db-config (recover-db). Without them a restore would make the
# extensions without supautils' scripts, unlike db: refused before anything is made.
if [ ! -s "$custom/supautils.conf" ]; then
  echo "bare-postgres: $custom has no supautils.conf: mount the image's own directory, or a volume Docker filled from it" >&2
  exit 1
fi

mkdir -p "$data" /var/run/postgresql
chown postgres:postgres /var/run/postgresql
if [ -s "$data/PG_VERSION" ]; then
  # Postgres's own lock (postmaster.pid) can't see a server in another container, so a second
  # one would start on the same files, db's among them. Only a cluster shut down cleanly is
  # started, and nothing in it is touched before this check.
  state=$(pg_controldata "$data" 2>/dev/null | sed -n 's/^Database cluster state: *//p')
  if [ "$state" != 'shut down' ]; then
    echo "bare-postgres: $data holds a cluster that was not shut down cleanly (${state:-unreadable}): db or another server may be running on it. Stop it first, and recover only into new volumes" >&2
    exit 1
  fi
  echo "bare-postgres: $data holds a cluster already, shut down cleanly; starting it as it is"
elif [ -n "$(ls -A "$data")" ]; then
  echo "bare-postgres: $data is not empty and holds no cluster: refusing to touch it" >&2
  exit 1
else
  chown postgres:postgres "$data"
  chmod 0700 "$data"
  # The password reaches initdb through a pipe made by postgres's own shell, never an argument.
  # POSTGRES_INITDB_ARGS is the image's (the locale), split into its arguments on purpose. The
  # cluster's own pg_hba.conf goes unused (the image's settings name theirs); its methods are given
  # only so that initdb doesn't warn about them.
  # shellcheck disable=SC2016 # expanded by the inner shell
  gosu postgres sh -c '
    printf "%s\n" "$POSTGRES_PASSWORD" |
      initdb --username=supabase_admin --pwfile=/dev/stdin --auth-local=trust \
        --auth-host=scram-sha-256 $POSTGRES_INITDB_ARGS -D "$1" >/dev/null
  ' bare-postgres "$data"
  echo "bare-postgres: made a bare cluster in $data"
fi

# The image's settings file: its preloaded libraries, its pg_hba.conf (passwords from other
# containers). Logged: warnings and errors, on one line each, without statements or their values;
# the image's own settings would log every DDL statement of the restore. pg_cron's launcher sits
# in postgres, as on db (conf.d/pg_cron.conf): CREATE EXTENSION pg_cron refuses any database but
# cron.database_name. It launches no job here, so a restored one runs only once db starts, and
# restore.sh drops initdb's postgres WITH (FORCE) under it. pg_net's worker waits in template1,
# so a restored request queue is never sent from here.
set -- \
  -c config_file=/etc/postgresql/postgresql.conf \
  -c listen_addresses='*' \
  -c log_statement=none \
  -c log_min_messages=warning \
  -c log_min_error_statement=panic \
  -c log_error_verbosity=terse \
  -c log_checkpoints=off \
  -c auto_explain.log_min_duration=-1 \
  -c pgaudit.log=none \
  -c cron.database_name=postgres \
  -c cron.launch_active_jobs=off \
  -c pg_net.database_name=template1 \
  -c maintenance_work_mem=256MB
if [ -n "$throwaway" ]; then
  # In memory and thrown away: no crash safety needed, and the write-ahead log is kept small.
  set -- "$@" -c fsync=off -c full_page_writes=off -c synchronous_commit=off -c max_wal_size=256MB
fi
exec gosu postgres postgres "$@"
