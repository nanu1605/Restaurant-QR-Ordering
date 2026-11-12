#!/bin/sh
# shellcheck disable=SC3040 # BusyBox ash, this image's sh, has pipefail
# MenuMesh's nightly backup (docs/DECISIONS.md VPS-40), run by the image's crond at 20:30 UTC (02:00
# IST) in the backup service. Each part streams through age, to the owner's key in
# BACKUP_AGE_RECIPIENT, into the bucket (the rclone remote "backups", from RCLONE_CONFIG_BACKUPS_*),
# so nothing is written in the container, decrypted or not. Under daily/ in BACKUP_BUCKET:
#
#   globals-<stamp>.sql.age    the roles, with their passwords (pg_dumpall --globals-only)
#   <db>-<stamp>.dump.age      each database in full, owners and grants included (pg_dump -Fc)
#   storage-<stamp>.tar.age    the Storage volume, with the xattrs that hold each file's type
#   manifest-<stamp>.txt.age   row counts, the newest migration and the files, which a restore
#                              compares; uploaded after the parts above, so a manifest means a
#                              whole night
#   config-<stamp>.tar.age     the host's newest settings archive, already encrypted by the host
#
# The month's first whole night (UTC) is also copied to monthly/; daily copies go after 30 days and
# monthly ones after 366. A missing or stale settings archive fails the run once everything else is
# safe. A failure goes to Telegram (notify.sh alert); a full success prints one line and pings
# HEARTBEAT_URL. Nothing printed holds a value.
set -eu -o pipefail

stamp=$(date -u +%Y-%m-%dT%H%MZ)
reason='the settings of the job'
finish() {
  status=$?
  if [ "$status" -ne 0 ]; then
    message="[menumesh] backup failed (exit $status) at $stamp: $reason"
    echo "$message" >&2
    notify.sh alert "$message"
  fi
}
trap finish EXIT
fail() {
  reason=$1
  exit 1
}

for name in PGHOST PGUSER PGPASSWORD BACKUP_AGE_RECIPIENT BACKUP_BUCKET RCLONE_CONFIG_BACKUPS_TYPE; do
  eval "set -- \"\${$name-}\""
  [ -n "$1" ] || fail "$name is not set"
done
remote="backups:$BACKUP_BUCKET"
day="$remote/daily"
# rclone says only what went wrong (not, for one, that a long stream uploads in 5 MiB parts).
export RCLONE_LOG_LEVEL=ERROR

# Below everything else on the shared server's CPU and disk; the children inherit both.
renice -n 10 -p $$ >/dev/null 2>&1 || true
ionice -c 3 -p $$ >/dev/null 2>&1 || true

age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" </dev/null >/dev/null 2>&1 ||
  fail 'BACKUP_AGE_RECIPIENT is not an age public key'
reason='reaching the bucket'
rclone lsf --dirs-only "$remote/" >/dev/null

# Uploads stdin, encrypted to the owner's key, as daily/<name>.
put() {
  age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" | rclone rcat "$day/$1"
}

reason='the list of databases'
dbs=$(psql -X -At -v ON_ERROR_STOP=1 -d postgres -c \
  'select datname from pg_database where datallowconn and not datistemplate order by datname')
[ -n "$dbs" ] || fail 'no database to back up'
for db in $dbs; do
  case $db in *[!a-z0-9_]*) fail "the database name $db is not lower-case letters, digits and _" ;; esac
done

reason='the roles'
pg_dumpall --globals-only | put "globals-$stamp.sql.age"
for db in $dbs; do
  reason="the dump of $db"
  pg_dump --format=custom --dbname="$db" | put "$db-$stamp.dump.age"
done

# What a restore compares (counts.sql): exact row counts of the app's, Auth's and Storage's
# tables, the newest migration, and the Storage files, counted before the archive below, which so
# holds at least the files the dumped rows name.
reason='the manifest'
manifest="menumesh backup $stamp"
for db in $dbs; do
  counts=$(psql -X -At -v ON_ERROR_STOP=1 -d "$db" -f /usr/local/share/menumesh/counts.sql |
    awk -v db="$db" '{ $1 = $1 " " db; print }')
  manifest="$manifest
database $db
$counts"
done
files=$(find /storage -type f | wc -l)
bytes=$(find /storage -type f -exec stat -c %s {} + | awk '{ n += $1 } END { printf "%.0f", n }')
manifest="$manifest
storage files $((files))
storage bytes $bytes"

# GNU tar keeps Storage's xattrs (user.supabase.content-type and the like), without which a
# restored file would be served as application/octet-stream. Exit 1 means a file changed while it
# was read (an upload at that moment): the archive holds it as it was read.
storage_tar() {
  rc=0
  tar --create --file=- --directory=/storage --numeric-owner --xattrs --xattrs-include='user.*' . ||
    rc=$?
  if [ "$rc" -eq 1 ]; then
    echo 'backup: a Storage file changed while it was archived' >&2
    return 0
  fi
  return "$rc"
}
reason='the Storage archive'
storage_tar | put "storage-$stamp.tar.age"

reason='the manifest'
printf '%s\n' "$manifest" | put "manifest-$stamp.txt.age"

# The host's settings archive (app-config-archive, 20:20 UTC): the newest name sorts last. One more
# than two hours old means the host's timer stopped; it isn't copied, and the run fails at the end.
archive=
for file in /config-out/config-*.tar.age; do
  [ -e "$file" ] && archive=$file
done
archive_problem=
if [ -z "$archive" ]; then
  archive_problem='no settings archive in /config-out'
elif [ -n "$(find "$archive" -mmin +120)" ]; then
  archive_problem="the settings archive ${archive##*/} is more than 2 hours old"
elif [ "$(wc -c <"$archive")" -le 1024 ]; then
  archive_problem="the settings archive ${archive##*/} is too small"
else
  reason='the copy of the settings archive'
  rclone copyto "$archive" "$day/config-$stamp.tar.age"
fi

# Every part of tonight is in the bucket, and none is empty: age's file of empty input is about 200
# bytes. A dump of even an empty database is a few KB and a tar at least 10 KB, so those must pass
# 1 KB; the roles and the manifest, short texts, must pass 256 bytes.
reason='the check of the uploads'
listing=$(rclone lsf --files-only --format sp --separator ' ' --include "*-$stamp.*" "$day/")
expected="globals-$stamp.sql.age:256 storage-$stamp.tar.age:1024 manifest-$stamp.txt.age:256"
for db in $dbs; do expected="$expected $db-$stamp.dump.age:1024"; done
[ -n "$archive_problem" ] || expected="$expected config-$stamp.tar.age:1024"
for part in $expected; do
  name=${part%:*}
  size=$(printf '%s\n' "$listing" | awk -v name="$name" '$2 == name { print $1 }')
  [ -n "$size" ] || fail "$name is not in the bucket"
  [ "$size" -gt "${part##*:}" ] || fail "$name is only $size bytes"
done

# The month's first whole night (UTC) is also kept in monthly/: tonight's, unless monthly/ holds a
# manifest of this month already, so a 1st that failed leaves the copy to the next good night. Its
# manifest goes last there too: a manifest in monthly/ means a whole night, and a copy cut short is
# made again by the next one.
reason='the monthly copy'
month=${stamp%-??T*}
kept=
if [ -z "$(rclone lsf --files-only --include "manifest-$month-*" "$remote/monthly/")" ]; then
  for part in $expected; do
    name=${part%:*}
    case $name in manifest-*) ;; *) rclone copyto "$day/$name" "$remote/monthly/$name" ;; esac
  done
  rclone copyto "$day/manifest-$stamp.txt.age" "$remote/monthly/manifest-$stamp.txt.age"
  kept=", kept in monthly/ as the month's copy"
fi
# 30 daily and 12 monthly copies. Only the bucket can keep a stolen token from deleting them sooner,
# and nothing here sets that up: the owner picks, with the bucket (docs/RUNBOOK.md, First install),
# lock rules scoped to each prefix, or versioning with a token that can't delete versions or change
# the bucket's settings. No object gets a retention date of its own at upload yet.
reason='the removal of old copies'
rclone delete --min-age 30d "$day/"
rclone delete --min-age 366d "$remote/monthly/"

[ -z "$archive_problem" ] || fail "$archive_problem"

summary=$(printf '%s\n' "$listing" | awk '{ n++; total += $1 } END { printf "%d parts, %.0f bytes", n, total }')
echo "backup $stamp: $summary$kept"
# Last, so that a ping means every step above worked.
notify.sh beat
