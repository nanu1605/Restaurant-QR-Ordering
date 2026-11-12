#!/bin/sh
# shellcheck disable=SC3040 # BusyBox ash, this image's sh, has pipefail
# MenuMesh's nightly backup (docs/DECISIONS.md VPS-40), run by the image's crond at 20:30 UTC (02:00
# IST) in the backup service. Each part streams through age, to the owner's key in
# BACKUP_AGE_RECIPIENT, into the bucket (the rclone remote "backups", from RCLONE_CONFIG_BACKUPS_*),
# so nothing is written in the container, decrypted or not. Under daily/ in BACKUP_BUCKET, every
# name ends in the night's id, <night>: its stamp and 8 random hex characters, such as
# 2026-11-13T2030Z-3f9c0a1b.
#
#   globals-<night>.sql.age    the roles, with their passwords (pg_dumpall --globals-only)
#   <db>-<night>.dump.age      each database in full, owners and grants included (pg_dump -Fc)
#   storage-<night>.tar.age    the Storage volume, with the xattrs that hold each file's type
#   manifest-<night>.txt.age   row counts, the newest migration and the files, which a restore
#                              compares; uploaded after the parts above, so a manifest means a
#                              whole night
#   config-<night>.tar.age     the host's newest settings archive, already encrypted by the host
#
# A whole night stamped the 1st (UTC) is also copied to monthly/, or the next whole night when the
# 1st's wasn't; daily copies go after 30 days and monthly ones after 366. A missing or stale
# settings archive fails the run once everything else is safe, and such a night is never the
# month's copy. A failure goes to Telegram (notify.sh alert); a full success prints one line and
# pings HEARTBEAT_URL. Nothing printed holds a value.
set -eu -o pipefail

stamp=$(date -u +%Y-%m-%dT%H%MZ)
night=$stamp
reason='the settings of the job'
finish() {
  status=$?
  if [ "$status" -ne 0 ]; then
    message="[menumesh] backup failed (exit $status) at $night: $reason"
    echo "$message" >&2
    notify.sh alert "$message"
  fi
}
trap finish EXIT
fail() {
  reason=$1
  exit 1
}

# The night's id, in every name it writes: nobody can know it before this run, so nobody can put
# an object under one of tonight's names ahead of it, where the bucket's locks would refuse the
# night's own uploads (review finding F1).
hex=$(od -An -tx1 -N4 /dev/urandom | tr -d ' \n')
case $hex in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) night=$stamp-$hex ;;
  *) fail "no random part for the night's names" ;;
esac

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
# "<bytes> <name>" for each of the names on stdin that a folder holds: held <folder>. rclone asks
# for each by its exact name (--no-traverse: one request each) and lists nothing, so names someone
# else put in the folder cost nothing here.
held() {
  rclone lsf --files-only --no-traverse --format sp --separator ' ' --files-from-raw - "$1/"
}

reason='the list of databases'
dbs=$(psql -X -At -v ON_ERROR_STOP=1 -d postgres -c \
  'select datname from pg_database where datallowconn and not datistemplate order by datname')
[ -n "$dbs" ] || fail 'no database to back up'
for db in $dbs; do
  case $db in *[!a-z0-9_]*) fail "the database name $db is not lower-case letters, digits and _" ;; esac
done

# Tonight's parts, each with the size it must pass: age's file of empty input is about 200 bytes.
# A dump of even an empty database is a few KB and a tar at least 10 KB, so those must pass 1 KB;
# the roles and the manifest, short texts, must pass 256 bytes. The settings archive joins them
# once it is checked (below).
expected="globals-$night.sql.age:256 storage-$night.tar.age:1024 manifest-$night.txt.age:256"
for db in $dbs; do expected="$expected $db-$night.dump.age:1024"; done

# None of tonight's names may be in either folder before the first upload: nobody could know them,
# so one that is there means someone else wrote to the bucket, and the night stops here.
reason="the check of tonight's names"
for folder in daily monthly; do
  there=$(for part in $expected "config-$night.tar.age:1024"; do echo "${part%:*}"; done |
    held "$remote/$folder" | awk '{ printf "%s%s", sep, $2; sep = " " }')
  [ -z "$there" ] ||
    fail "someone else wrote to the bucket: $folder/ holds $there before tonight's first upload"
done

reason='the roles'
pg_dumpall --globals-only | put "globals-$night.sql.age"
for db in $dbs; do
  reason="the dump of $db"
  pg_dump --format=custom --dbname="$db" | put "$db-$night.dump.age"
done

# What a restore compares (counts.sql): exact row counts of the app's, Auth's and Storage's
# tables, the newest migration, and the Storage files, counted before the archive below, which so
# holds at least the files the dumped rows name.
reason='the manifest'
manifest="menumesh backup $night"
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
storage_tar | put "storage-$night.tar.age"

reason='the manifest'
printf '%s\n' "$manifest" | put "manifest-$night.txt.age"

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
  rclone copyto "$archive" "$day/config-$night.tar.age"
fi

# Every part of tonight is in the bucket, and none is empty (the floors above).
reason='the check of the uploads'
[ -n "$archive_problem" ] || expected="$expected config-$night.tar.age:1024"
listing=$(for part in $expected; do echo "${part%:*}"; done | held "$day")
for part in $expected; do
  name=${part%:*}
  size=$(printf '%s\n' "$listing" | awk -v name="$name" '$2 == name { print $1 }')
  [ -n "$size" ] || fail "$name is not in the bucket"
  [ "$size" -gt "${part##*:}" ] || fail "$name is only $size bytes"
done

# The month's copy in monthly/: only a whole night, every upload above checked and its settings
# archive fresh, and one stamped the 1st (UTC) or, while monthly/ holds no whole copy of the month,
# the next whole night, so a 1st that failed leaves the copy to it. A whole copy is a manifest
# named as this script names one, with that night's roles, Storage archive, settings archive and a
# dump of each of tonight's databases, each past its floor: names someone else put in monthly/
# can't stop the 1st's copy, nor stand in for one unless they are a whole night's. The manifest
# goes last there too, so a copy cut short is no whole copy.
reason='the monthly copy'
month=${stamp%-??T*}
kept=
if [ -z "$archive_problem" ]; then
  case $stamp in
    ????-??-01T*) whole= ;;
    *)
      whole=$(rclone lsf --files-only --format sp --separator ' ' --include "*-$month-*" "$remote/monthly/" |
        DBS="$dbs" LC_ALL=C awk -v month="$month" '
          function big(name, floor) { return (name in size) && size[name] > floor }
          { size[substr($0, index($0, " ") + 1)] = $1 + 0 }
          END {
            n = split(ENVIRON["DBS"], db, "\n")
            for (name in size) {
              if (name !~ ("^manifest-" month "-[0-9][0-9]T[0-9][0-9][0-9][0-9]Z-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][.]txt[.]age$")) continue
              s = substr(name, 10, 25)
              ok = big(name, 256) && big("globals-" s ".sql.age", 256) &&
                big("storage-" s ".tar.age", 1024) && big("config-" s ".tar.age", 1024)
              for (i = 1; i <= n; i++) if (!big(db[i] "-" s ".dump.age", 1024)) ok = 0
              if (ok) { print s; exit }
            }
          }')
      ;;
  esac
  if [ -z "$whole" ]; then
    for part in $expected; do
      name=${part%:*}
      case $name in manifest-*) ;; *) rclone copyto "$day/$name" "$remote/monthly/$name" ;; esac
    done
    rclone copyto "$day/manifest-$night.txt.age" "$remote/monthly/manifest-$night.txt.age"
    kept=", kept in monthly/ as the month's copy"
  fi
fi
# 30 daily and 12 monthly copies. Only the bucket can keep a stolen token from deleting them sooner,
# and nothing here sets that up: the owner picks, with the bucket (docs/RUNBOOK.md, First install),
# lock rules scoped to each prefix, or versioning with a token that can't delete versions or change
# the bucket's settings. Only locks that refuse overwrites (prefix-scoped bucket locks, such as
# R2's) also keep what a restore reads: a retention date on each object (S3 Object Lock) keeps the
# old versions only, and a restore reads the current one. restore.sh reads a night only while the
# recommended locks hold it, from daily/ under 29 days and from monthly/ to 365, so from 29 days
# until this removal a night that is not the month's copy is kept but no longer restored. An
# object's age here is the bucket's own time of its upload (--use-server-modtime), never the
# modification time its uploader set, so an object someone else put in with an old one is tried
# only once its lock has ended, not every night (review finding F3).
reason='the removal of old copies'
rclone delete --use-server-modtime --min-age 30d "$day/"
rclone delete --use-server-modtime --min-age 366d "$remote/monthly/"

[ -z "$archive_problem" ] || fail "$archive_problem"

summary=$(printf '%s\n' "$listing" | awk '{ n++; total += $1 } END { printf "%d parts, %.0f bytes", n, total }')
echo "backup $night: $summary$kept"
# Last, so that a ping means every step above worked.
notify.sh beat
