#!/bin/sh
# shellcheck disable=SC3040 # BusyBox ash, this image's sh, has pipefail
# MenuMesh's restores from the nightly backup's bucket (docs/DECISIONS.md VPS-40):
#
#   restore.sh --test   the monthly restore test (the restore-test service): restores a night into
#                       restore-db's bare cluster in memory, compares it with the night's manifest,
#                       lists the Storage archive and the settings archive, and changes nothing else
#   restore.sh --into   disaster recovery (the recover service): restores a night into recover-db's
#                       bare cluster on the real, empty volumes, and the Storage files into /storage
#
# The night is RESTORE_STAMP, as in the object names, or else the newest with a manifest, which the
# backup uploads after every other part. The owner's age key is AGE_IDENTITY_FILE, on a ramfs
# mounted read-only. Each part streams from the bucket through age into psql, pg_restore or tar, so
# nothing decrypted is written but the restored data itself. With RESTORE_EXACT=1 (the local
# rehearsal) every count must match; on the server, writes during the backup can move a count, so
# differences are listed and only a missing table, a table restored empty, or no Storage files where
# there were some fail the test.
set -eu -o pipefail

mode=${1-}
case $mode in
  --test | --into) ;;
  *)
    echo 'usage: restore.sh --test | --into' >&2
    exit 2
    ;;
esac
die() {
  echo "restore: $*" >&2
  exit 1
}
for name in PGHOST PGUSER PGPASSWORD BACKUP_BUCKET AGE_IDENTITY_FILE; do
  eval "set -- \"\${$name-}\""
  [ -n "$1" ] || die "$name is not set"
done
[ -r "$AGE_IDENTITY_FILE" ] ||
  die "no age key at $AGE_IDENTITY_FILE: mount the owner's key on a ramfs (-v /run/age:/run/age:ro)"
case $PGUSER in '' | *[!a-z0-9_]*) die 'PGUSER must be a plain role name' ;; esac
exact=${RESTORE_EXACT:-0}
day="backups:$BACKUP_BUCKET/daily"
export RCLONE_LOG_LEVEL=ERROR

# A part of the night, decrypted, on stdout.
fetch() {
  rclone cat "$day/$1" | age --decrypt --identity "$AGE_IDENTITY_FILE"
}
sql() {
  psql -X -q -At -v ON_ERROR_STOP=1 "$@"
}
# One "<kind> <db> <name>... <value>" line per table and the migration, as the backup counted.
counts() {
  sql -d "$1" -f /usr/local/share/menumesh/counts.sql | awk -v db="$1" '{ $1 = $1 " " db; print }'
}
# Lists what differs between the manifest's lines and the restored ones; fails on what can't be a
# night's later writes, or on any difference with RESTORE_EXACT=1.
compare() {
  printf '%s\n#restored\n%s\n' "$1" "$2" | awk -v exact="$exact" '
    $0 == "#restored" { restored = 1; next }
    NF < 2 { next }
    {
      key = $1
      for (i = 2; i < NF; i++) key = key " " $i
      if (restored) have[key] = $NF
      else { want[key] = $NF; order[++n] = key }
    }
    END {
      bad = 0
      for (i = 1; i <= n; i++) {
        key = order[i]
        if (!(key in have)) { print "  missing: " key; bad = 1; continue }
        if (have[key] == want[key]) continue
        print "  " key ": " want[key] " in the manifest, " have[key] " restored"
        if (exact || (key ~ /^(table|storage) / && have[key] + 0 == 0 && want[key] + 0 > 0)) bad = 1
      }
      for (key in have) if (!(key in want)) { print "  not in the manifest: " key; if (exact) bad = 1 }
      exit bad
    }'
}

names=$(rclone lsf --files-only "$day/")
stamp=${RESTORE_STAMP-}
if [ -z "$stamp" ]; then
  stamp=$(printf '%s\n' "$names" | sed -n 's/^manifest-\(.*\)\.txt\.age$/\1/p' | sort | tail -n 1)
  [ -n "$stamp" ] || die "no night with a manifest in daily/ of the bucket"
fi
case $stamp in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9][0-9][0-9]Z) ;;
  *) die 'RESTORE_STAMP must be a stamp as in the object names, like 2026-11-11T2030Z' ;;
esac
present() { printf '%s\n' "$names" | grep -qxF "$1"; }
for part in "manifest-$stamp.txt.age" "globals-$stamp.sql.age" "storage-$stamp.tar.age"; do
  present "$part" || die "$part is not in daily/"
done

manifest=$(fetch "manifest-$stamp.txt.age")
dbs=$(printf '%s\n' "$manifest" | awk '$1 == "database" { print $2 }')
[ -n "$dbs" ] || die "the manifest of $stamp names no database"
for db in $dbs; do
  case $db in *[!a-z0-9_]*) die "the manifest names a database that is not plain: $db" ;; esac
  present "$db-$stamp.dump.age" || die "$db-$stamp.dump.age is not in daily/"
done

# Only into a bare cluster (bare-postgres.sh): no roles but its superuser, no databases but
# initdb's. A live cluster, or a half-done earlier run, is refused before anything changes.
roles=$(sql -d template1 -c "select count(*) from pg_roles where rolname !~ '^pg_' and rolname <> current_user")
databases=$(sql -d template1 -c "select count(*) from pg_database where datname not in ('template0', 'template1', 'postgres')")
if [ "$roles" -ne 0 ] || [ "$databases" -ne 0 ]; then
  die "$PGHOST is not a bare cluster: it has roles or databases already. Restore only into a new restore-db or recover-db"
fi
if [ "$mode" = --into ] && [ -n "$(ls -A /storage)" ]; then
  die '/storage is not empty: recover only into a new storage-data volume'
fi
echo "restore: the night of $stamp into $PGHOST"

# The roles, with their passwords, but the cluster's own superuser as bare-postgres.sh made it: its
# password stays the one this job connects with.
echo 'restore: roles'
fetch "globals-$stamp.sql.age" |
  sed -e "/^CREATE ROLE $PGUSER;\$/d" -e "/^ALTER ROLE $PGUSER WITH /d" |
  sql -d template1 >/dev/null

# Each database whole, as the backup dumped it: created from template0 with its own locale and
# settings, owners and grants included. initdb's empty postgres goes first.
for db in $dbs; do
  echo "restore: database $db"
  sql -d template1 -c "drop database if exists \"$db\""
  fetch "$db-$stamp.dump.age" | pg_restore --create --exit-on-error --dbname=template1
done

failed=0
for db in $dbs; do
  restored=$(counts "$db")
  wanted=$(printf '%s\n' "$manifest" | awk -v db="$db" '($1 == "table" || $1 == "migration") && $2 == db')
  tables=$(printf '%s\n' "$restored" | grep -c '^table ' || true)
  if differences=$(compare "$wanted" "$restored"); then
    echo "restore: $db has its $tables tables as the manifest counted them${differences:+, but for:}"
  else
    echo "restore: $db differs from the manifest:"
    failed=1
  fi
  [ -z "$differences" ] || printf '%s\n' "$differences"
done

# The Storage files: extracted for a recovery, only listed for a test.
if [ "$mode" = --into ]; then
  echo 'restore: Storage files into /storage'
  fetch "storage-$stamp.tar.age" |
    tar --extract --file=- --directory=/storage --no-same-owner --xattrs --xattrs-include='user.*'
  files=$(find /storage -type f | wc -l)
  bytes=$(find /storage -type f -exec stat -c %s {} + | awk '{ n += $1 } END { printf "%.0f", n }')
  storage="storage files $((files))
storage bytes $bytes"
else
  storage=$(fetch "storage-$stamp.tar.age" | tar --list --verbose --file=- |
    awk '/^-/ { n++; total += $3 } END { printf "storage files %d\nstorage bytes %.0f\n", n, total }')
fi
wanted=$(printf '%s\n' "$manifest" | awk '$1 == "storage"')
if differences=$(compare "$wanted" "$storage"); then
  echo "restore: Storage holds $(printf '%s\n' "$storage" | awk '$2 == "files" { print $3 }') files as the manifest counted${differences:+, but for:}"
else
  echo 'restore: Storage differs from the manifest:'
  failed=1
fi
[ -z "$differences" ] || printf '%s\n' "$differences"

if [ "$mode" = --test ]; then
  # The settings archive holds every secret of the server: only the names of its files are shown.
  present "config-$stamp.tar.age" || die "the night of $stamp has no settings archive (config-$stamp.tar.age)"
  files=$(fetch "config-$stamp.tar.age" | tar --list --file=-)
  [ -n "$files" ] || die "the settings archive of $stamp is empty"
  echo "restore: the settings archive holds $(printf '%s\n' "$files" | tr '\n' ' ')"
fi

[ "$failed" -eq 0 ] || die "the restore of $stamp does not match its manifest"
if [ "$mode" = --test ]; then
  echo 'restore test passed'
else
  echo "recovery of $stamp done: stop recover-db, then start db, auth, rest, realtime, storage and api-gw (docs/RUNBOOK.md)"
fi
