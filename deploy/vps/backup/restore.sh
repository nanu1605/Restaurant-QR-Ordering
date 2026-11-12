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
# The night is RESTORE_STAMP, as in the object names; else the newest night of daily/ with a
# manifest, which the backup uploads after every other part, of the last 31 days and never one
# stamped later than now. daily/ keeps a night 30 days and monthly/ each month's first whole night a
# year. A night more than 31 days old is read from monthly/ only: once the backup has removed its
# own copy from daily/, anyone holding the bucket's token can put another there under its name. A
# younger night is read from daily/, or from monthly/ once daily/ no longer holds it, and when both
# hold it their manifests must be the same. The owner's age key is AGE_IDENTITY_FILE, on a ramfs
# mounted read-only. Each part streams from the bucket through age into psql, pg_restore or tar, so
# nothing decrypted is written but the restored data itself. With RESTORE_EXACT=1 (the local
# rehearsal) every count must match; on the server, writes during the backup can move a count, so
# differences are listed and only a missing table, a table restored empty, or no Storage files
# where there were some fail the test.
#
# age proves nothing about who encrypted a part: whoever holds the bucket's token and the public key
# can plant a night. So nothing decrypted runs here as code. The roles go through psql's restricted
# mode, which runs their SQL and no psql command; the manifest must hold only the lines a backup
# writes, so its database names are plain before they reach SQL; a recovery refuses Storage links
# and special files; and what this prints from a night loses its control characters. A planted
# night's SQL runs only in restore-db or recover-db, on the internal restore network, which hold
# no key and no token.
set -eu -o pipefail
# Nothing from a night is ever globbed.
set -f

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
bucket="backups:$BACKUP_BUCKET"
# The night's folder: daily, or monthly (below).
folder=daily
export RCLONE_LOG_LEVEL=ERROR

# A part of the night, decrypted, on stdout: from the night's folder, or from the one named second.
fetch() {
  rclone cat "$bucket/${2:-$folder}/$1" | age --decrypt --identity "$AGE_IDENTITY_FILE"
}
sql() {
  psql -X -q -At -v ON_ERROR_STOP=1 "$@"
}
# Whether a folder's listing names an object: listed <listing> <name>. A match in the shell: piped
# into grep -q under pipefail, a listing could fail when grep stopped reading at the match.
nl='
'
listed() {
  case "$nl$1$nl" in *"$nl$2$nl"*) return 0 ;; esac
  return 1
}
# Text from a night, fit for a terminal: control characters and bytes past ASCII left out.
printable() {
  LC_ALL=C tr -d '\000-\010\013-\037\177-\377'
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

# Stamps sort as they are written. backup.sh removes a daily copy at the first night's run past its
# 30 days, so a night counts as monthly/'s alone one day later: older than 31 days.
seconds=$(date -u +%s)
now=$(date -u -d "@$seconds" +%Y-%m-%dT%H%MZ)
oldest=$(date -u -d "@$((seconds - 31 * 86400))" +%Y-%m-%dT%H%MZ)
daily=$(rclone lsf --files-only "$bucket/daily/")
monthly=$(rclone lsf --files-only "$bucket/monthly/")
stamp=${RESTORE_STAMP-}
if [ -z "$stamp" ]; then
  # The newest stamp as backup.sh writes them, of the last 31 days and none later than now: a
  # planted 9999-12-31 would always sort last.
  stamps=$(printf '%s\n' "$daily" |
    sed -n 's/^manifest-\([0-9]\{4\}-[0-9][0-9]-[0-9][0-9]T[0-9]\{4\}Z\)\.txt\.age$/\1/p' | sort)
  for later in $(printf '%s\n' "$stamps" | awk -v now="$now" '$0 > now'); do
    echo "restore: not taking the night of $later, stamped later than now ($now)"
  done
  stamp=$(printf '%s\n' "$stamps" |
    awk -v now="$now" -v oldest="$oldest" '$0 != "" && $0 <= now && $0 >= oldest' | tail -n 1)
  [ -n "$stamp" ] ||
    die "no night of the last 31 days with a manifest in daily/ of the bucket (one of monthly/ needs RESTORE_STAMP)"
fi
case $stamp in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9][0-9][0-9]Z) ;;
  *) die 'RESTORE_STAMP must be a stamp as in the object names, like 2026-11-11T2030Z' ;;
esac
# A night more than 31 days old comes from monthly/ only, whatever daily/ holds under its name; a
# younger one from daily/, or from monthly/ once daily/ no longer holds it.
if [ "$(awk -v stamp="$stamp" -v oldest="$oldest" 'BEGIN { print (stamp < oldest) }')" = 1 ]; then
  if listed "$daily" "manifest-$stamp.txt.age"; then
    echo "restore: not reading the copy of $stamp in daily/: daily/ keeps a night 30 days, and this one is more than 31 days old"
  fi
  folder=monthly
  listed "$monthly" "manifest-$stamp.txt.age" ||
    die "the night of $stamp has no manifest in monthly/, the only folder read for a night more than 31 days old"
elif ! listed "$daily" "manifest-$stamp.txt.age"; then
  folder=monthly
  listed "$monthly" "manifest-$stamp.txt.age" ||
    die "the night of $stamp has no manifest in daily/ or monthly/"
fi
if [ "$folder" = daily ]; then names=$daily; else names=$monthly; fi
for part in "manifest-$stamp.txt.age" "globals-$stamp.sql.age" "storage-$stamp.tar.age"; do
  listed "$names" "$part" || die "$part is not in $folder/"
done

manifest=$(fetch "manifest-$stamp.txt.age")
# The month's copy is the same night in both folders, which backup.sh copies unchanged: two
# different manifests mean that one of them was put there by someone else.
if [ "$folder" = daily ] && listed "$monthly" "manifest-$stamp.txt.age"; then
  copy=$(fetch "manifest-$stamp.txt.age" monthly)
  [ "$copy" = "$manifest" ] ||
    die "the manifests of $stamp in daily/ and monthly/ differ, though backup.sh copies a night unchanged: one of them is not the backup's"
fi
# Only the lines backup.sh writes, in printable ASCII: the night's stamp first, then plain database
# names (they reach SQL and psql's arguments), and counts.
problem=$(printf '%s\n' "$manifest" | LC_ALL=C awk -v stamp="$stamp" '
  /[^ -~]/ { print "line " NR " holds a control character or a byte past ASCII"; exit }
  NR == 1 {
    if ($0 != "menumesh backup " stamp) { print "its first line is not \"menumesh backup " stamp "\""; exit }
    next
  }
  $1 == "database" && NF == 2 && $2 ~ /^[a-z_][a-z0-9_]*$/ && length($2) < 64 && $2 !~ /^template[01]$/ {
    if (seen[$2]++) { print "it names the database " $2 " twice"; exit }
    next
  }
  $1 == "table" && NF >= 4 && $NF ~ /^[0-9]+$/ { next }
  $1 == "migration" && NF == 3 && ($3 ~ /^[0-9]+$/ || $3 == "none") { next }
  $1 == "storage" && NF == 3 && ($2 == "files" || $2 == "bytes") && $3 ~ /^[0-9]+$/ { next }
  { print "line " NR " is not one a backup writes"; exit }')
[ -z "$problem" ] || die "the manifest of $stamp is not a backup's: $problem"
dbs=$(printf '%s\n' "$manifest" | awk '$1 == "database" { print $2 }')
[ -n "$dbs" ] || die "the manifest of $stamp names no database"
for db in $dbs; do
  listed "$names" "$db-$stamp.dump.age" || die "$db-$stamp.dump.age is not in $folder/"
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
echo "restore: the night of $stamp, from $folder/, into $PGHOST"

# The roles, with their passwords, but the cluster's own superuser as bare-postgres.sh made it: its
# password stays the one this job connects with. psql reads them in its restricted mode, under a
# key the file can't know (16 random bytes), so the file runs SQL only: a \! or any other psql
# command stops the restore. pg_dumpall's own \restrict and \unrestrict lines are left out.
echo 'restore: roles'
key=$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')
[ "${#key}" -eq 32 ] || die "no random key for psql's restricted mode"
if ! {
  printf '%srestrict %s\n' "\\" "$key"
  fetch "globals-$stamp.sql.age" |
    sed -e '/^\\restrict /d' -e '/^\\unrestrict /d' \
      -e "/^CREATE ROLE $PGUSER;\$/d" -e "/^ALTER ROLE $PGUSER WITH /d"
} | sql -d template1 >/dev/null; then
  die "the roles of $stamp did not restore (psql says why above): a backup's roles file holds SQL and no psql command"
fi

# Each database whole, as the backup dumped it: created from template0 with its own locale and
# settings, owners and grants included. initdb's empty postgres goes first, with pg_cron's
# launcher (bare-postgres.sh) still connected to it.
for db in $dbs; do
  echo "restore: database $db"
  sql -d template1 -c "drop database if exists \"$db\" with (force)"
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
  [ -z "$differences" ] || printf '%s\n' "$differences" | printable
done

# The Storage files: extracted for a recovery, only listed for a test. GNU tar keeps every member
# under /storage (no absolute names, no .., no writing through a link).
if [ "$mode" = --into ]; then
  echo 'restore: Storage files into /storage'
  fetch "storage-$stamp.tar.age" |
    tar --extract --file=- --directory=/storage --no-same-owner --xattrs --xattrs-include='user.*'
  # Storage writes only files and folders. A link would be served, once the stack runs on the
  # volume, from the storage container's own files (its environment, for one).
  others=$(find /storage ! -type f ! -type d | wc -l)
  [ "$others" -eq 0 ] ||
    die "the Storage archive of $stamp holds links or special files ($((others))), which Storage never writes: make storage-data new and recover another night"
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
[ -z "$differences" ] || printf '%s\n' "$differences" | printable

if [ "$mode" = --test ]; then
  # The settings archive holds every secret of the server: only the names of its files are shown.
  listed "$names" "config-$stamp.tar.age" ||
    die "the night of $stamp has no settings archive (config-$stamp.tar.age)"
  files=$(fetch "config-$stamp.tar.age" | tar --list --file=- | printable)
  [ -n "$files" ] || die "the settings archive of $stamp is empty"
  echo "restore: the settings archive holds $(printf '%s\n' "$files" | tr '\n' ' ')"
fi

[ "$failed" -eq 0 ] || die "the restore of $stamp does not match its manifest"
if [ "$mode" = --test ]; then
  echo 'restore test passed'
else
  echo "recovery of $stamp done: stop recover-db, then start db, auth, rest, realtime, storage, api-gw and backup (docs/RUNBOOK.md)"
fi
