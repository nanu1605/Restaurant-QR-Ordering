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
# The night is RESTORE_STAMP: its id, as the backup's journal line prints it and every name of the
# night ends, its stamp and 8 random hex characters (2026-11-13T2030Z-3f9c0a1b); else the newest
# night of daily/ with a manifest, which the backup uploads after every other part, younger than 29
# days and never one stamped later than now. The folder a night is read from hangs on its age alone,
# from its stamp and this clock, never on what the bucket holds: anyone holding the bucket's token
# can add objects under new names, so a folder chosen from what is there can be steered. The
# bucket's prefix locks (docs/RUNBOOK.md, First install) keep each object as the backup wrote it 29
# days in daily/ and 365 in monthly/. So a night younger than 29 days is read from daily/ only,
# which keeps every night that long; one from 29 to 365 days old from monthly/ only, which keeps
# each month's copy; an older one from neither. Nothing falls back to the other folder, and no
# manifest is compared across them. Each part is looked for and read by its exact name, one request
# each, and no folder's listing is held here, as a token holder can fill a folder with names. The
# owner's age key is AGE_IDENTITY_FILE, on a ramfs mounted read-only. Each part streams from the
# bucket through age into psql, pg_restore or tar, so nothing decrypted is written but the restored
# data itself. With RESTORE_EXACT=1 (the local rehearsal) every count must match; on the server,
# writes during the backup can move a count, so differences are listed and only a missing table, a
# table restored empty, or no Storage files where there were some fail the test.
#
# age proves nothing about who encrypted a part: whoever holds the bucket's token and the public key
# can plant a night. So nothing decrypted runs here as code. The roles go through psql's restricted
# mode, which runs their SQL and no psql command; the manifest must hold only the lines a backup
# writes, so its database names are plain before they reach SQL; and the Storage archive may hold
# only files and folders, checked before anything is restored. Everything the run prints loses its
# control characters but tab and newline (below), and the line a success ends with names the night,
# after anything a night's text could add. A planted night's SQL runs only in restore-db or
# recover-db, on the internal restore network, which hold no key and no token.
set -eu -o pipefail

# Everything the run prints, its own lines and those of psql, pg_restore, tar, age and rclone, goes
# through one filter, so that no text from a night can move the cursor or rewrite a line: tab and
# newline stay, every other control character and every byte past ASCII go. This shell stays the
# container's process 1 and writes into a FIFO that the filter reads, so its exit status, and how
# a terminal's Ctrl-C or a signal to the container stops it, are as they were without the filter.
# On exit it waits until the filter has passed everything on.
fifo=$(mktemp -u /tmp/restore.XXXXXX)
mkfifo -m 600 "$fifo"
LC_ALL=C tr -d '\000-\010\013-\037\177-\377' <"$fifo" &
filter=$!
exec >"$fifo" 2>&1
rm -f "$fifo"
# Set once a recovery has begun to write to the new volumes (below).
writing=
finish() {
  status=$?
  if [ "$status" -ne 0 ] && [ -n "$writing" ]; then
    echo "restore: the recovery of $night stopped after it began to write: make db-data, db-config and storage-data new (docs/RUNBOOK.md, Disaster recovery) before recovering a night"
  fi
  exec >&- 2>&-
  wait "$filter" || true
  exit "$status"
}
trap finish EXIT
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
export RCLONE_LOG_LEVEL=ERROR

# A part of the night, decrypted, on stdout, from the night's folder (below). --no-traverse: rclone
# reads the object by its name, without listing the folder first.
fetch() {
  rclone cat --no-traverse "$bucket/$folder/$1" | age --decrypt --identity "$AGE_IDENTITY_FILE"
}
# Which of the names on stdin the night's folder holds, one a line. rclone asks for each by its
# exact name (--no-traverse: one request each) and lists nothing, so names someone else put in the
# folder cost nothing here (review finding F2).
held() {
  rclone lsf --files-only --no-traverse --files-from-raw - "$bucket/$folder/"
}
# Stops after a command that failed, with a line naming what it was reading, and its exit status.
stop() {
  status=$?
  echo "restore: $*" >&2
  exit "$status"
}
sql() {
  psql -X -q -At -v ON_ERROR_STOP=1 "$@"
}
# Whether a list of names, one a line, holds a name: listed <names> <name>. A match in the shell:
# piped into grep -q under pipefail, a list could fail when grep stopped reading at the match.
nl='
'
listed() {
  case "$nl$1$nl" in *"$nl$2$nl"*) return 0 ;; esac
  return 1
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

night=${RESTORE_STAMP-}

# A night's age against the lines 29 and 365 days back, to the minute, from this clock: a night
# stamped later than a line is younger than its days. Stamps sort as they are written, and every
# part goes up after its night's stamp, so its folder's lock holds it at least that long.
seconds=$(date -u +%s)
now=$(date -u -d "@$seconds" +%Y-%m-%dT%H%MZ)
daily_lock=$(date -u -d "@$((seconds - 29 * 86400))" +%Y-%m-%dT%H%MZ)
monthly_lock=$(date -u -d "@$((seconds - 365 * 86400))" +%Y-%m-%dT%H%MZ)
if [ -z "$night" ]; then
  # The night when none is named: the newest id of a manifest in daily/ as backup.sh
  # names one, younger than 29 days and stamped no later than now (a planted
  # 9999-12-31T2359Z-... would always sort last), which a few lines name as not taken. Only those
  # ids pass the pipe and only the newest is kept, so other names in daily/ cost this shell
  # nothing; rclone still lists the folder, which naming the night avoids.
  night=$(rclone lsf --files-only --include 'manifest-*.txt.age' "$bucket/daily/" |
    sed -n 's/^manifest-\([0-9]\{4\}-[0-9][0-9]-[0-9][0-9]T[0-9]\{4\}Z-[0-9a-f]\{8\}\)\.txt\.age$/\1/p' |
    LC_ALL=C awk -v now="$now" -v lock="$daily_lock" '
      BEGIN { newest = "" }
      substr($0, 1, 16) > now {
        if (++later <= 3) print "restore: not taking the night of " $0 ", stamped later than now (" now ")" > "/dev/stderr"
        next
      }
      substr($0, 1, 16) > lock && $0 > newest { newest = $0 }
      END {
        if (later > 3) print "restore: not taking " later - 3 " more nights stamped later than now" > "/dev/stderr"
        print newest
      }')
  [ -n "$night" ] ||
    die "no night of the last 29 days with a manifest in daily/ of the bucket (one of monthly/ needs RESTORE_STAMP)"
fi
case $night in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9][0-9][0-9]Z-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) die "RESTORE_STAMP must be a night's id as the backup's journal line prints it, like 2026-11-11T2030Z-0f3c9a1b" ;;
esac
# The night's stamp, which gives its age; then its one folder, from that age alone: whatever the
# other folder holds under its name is never looked for or read.
stamp=${night%-*}
under() { [ "$(awk -v stamp="$stamp" -v line="$1" 'BEGIN { print (stamp > line) }')" = 1 ]; }
if under "$daily_lock"; then
  folder=daily
elif under "$monthly_lock"; then
  folder=monthly
else
  die "the night of $night is 365 days old or more, so no folder is read for it: monthly/ keeps the month's copy under its lock 365 days, and past that anyone holding the bucket's token could have replaced its parts"
fi
names=$(printf '%s\n' "manifest-$night.txt.age" "globals-$night.sql.age" "storage-$night.tar.age" "config-$night.tar.age" | held)
if ! listed "$names" "manifest-$night.txt.age"; then
  [ "$folder" = monthly ] ||
    die "the night of $night is younger than 29 days, so only daily/ is read for it: daily/ keeps every night of the last 29 days under its lock; this one has no manifest there, so no backup finished it (the backup's journal names the nights that did)"
  die "the night of $night is 29 days old or more, so only monthly/ is read for it: only the month's copy is kept past 29 days; the backup's journal line says 'kept in monthly/' for that night, and this one has no manifest there"
fi
for part in "globals-$night.sql.age" "storage-$night.tar.age"; do
  listed "$names" "$part" || die "$part is not in $folder/"
done

manifest=$(fetch "manifest-$night.txt.age") ||
  stop "the manifest of $night (manifest-$night.txt.age in $folder/) could not be read (see above)"
# Only the lines backup.sh writes, in printable ASCII: the night's id first, then plain database
# names (they reach SQL and psql's arguments), and counts.
problem=$(printf '%s\n' "$manifest" | LC_ALL=C awk -v night="$night" '
  /[^ -~]/ { print "line " NR " holds a control character or a byte past ASCII"; exit }
  NR == 1 {
    if ($0 != "menumesh backup " night) { print "its first line is not \"menumesh backup " night "\""; exit }
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
[ -z "$problem" ] || die "the manifest of $night is not a backup's: $problem"
dbs=$(printf '%s\n' "$manifest" | awk '$1 == "database" { print $2 }')
[ -n "$dbs" ] || die "the manifest of $night names no database"
dumps=$(for db in $dbs; do echo "$db-$night.dump.age"; done | held)
for db in $dbs; do
  listed "$dumps" "$db-$night.dump.age" || die "$db-$night.dump.age is not in $folder/"
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
echo "restore: the night of $night, from $folder/, into $PGHOST"

# Storage writes only files and folders. A link or a special file would be served, once the stack
# runs on the volume, from the storage container's own files (its environment, for one), so every
# member of the archive is checked before anything is restored; the test counts the files from the
# same listing. GNU tar escapes the control characters of a name: one line per member.
listing=$(fetch "storage-$night.tar.age" | tar --list --verbose --numeric-owner --file=- |
  LC_ALL=C awk '
    /^-/ { files++; bytes += $3; next }
    /^d/ { next }
    { others++ }
    END { printf "storage files %d\nstorage bytes %.0f\nothers %d\n", files, bytes, others }') ||
  die "the Storage archive of $night (storage-$night.tar.age in $folder/) could not be listed (see above)"
others=$(printf '%s\n' "$listing" | awk '$1 == "others" { print $2 }')
[ "$others" -eq 0 ] ||
  die "the Storage archive of $night holds links or special files ($others), which Storage never writes: nothing was restored"

# From here on a recovery writes to the new volumes: one that stops leaves part of a night there.
[ "$mode" != --into ] || writing=yes

# The roles, with their passwords, but the cluster's own superuser as bare-postgres.sh made it: its
# password stays the one this job connects with. psql reads them in its restricted mode, under a
# key the file can't know (16 random bytes), so the file runs SQL only: a \! or any other psql
# command stops the restore. pg_dumpall's own \restrict and \unrestrict lines are left out.
echo 'restore: roles'
key=$(od -An -tx1 -N16 /dev/urandom | tr -d ' \n')
[ "${#key}" -eq 32 ] || die "no random key for psql's restricted mode"
if ! {
  printf '%srestrict %s\n' "\\" "$key"
  fetch "globals-$night.sql.age" |
    sed -e '/^\\restrict /d' -e '/^\\unrestrict /d' \
      -e "/^CREATE ROLE $PGUSER;\$/d" -e "/^ALTER ROLE $PGUSER WITH /d"
} | sql -d template1 >/dev/null; then
  die "the roles of $night (globals-$night.sql.age in $folder/) did not restore (see above)"
fi

# Each database whole, as the backup dumped it: created from template0 with its own locale and
# settings, owners and grants included. initdb's empty postgres goes first, with pg_cron's
# launcher (bare-postgres.sh) still connected to it.
for db in $dbs; do
  echo "restore: database $db"
  sql -d template1 -c "drop database if exists \"$db\" with (force)"
  fetch "$db-$night.dump.age" | pg_restore --create --exit-on-error --dbname=template1 ||
    stop "the database $db of $night ($db-$night.dump.age in $folder/) did not restore (see above)"
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

# The Storage files: extracted for a recovery, and checked again as they landed; for a test, the
# listing's count. GNU tar keeps every member under /storage (no absolute names, no .., no writing
# through a link).
if [ "$mode" = --into ]; then
  echo 'restore: Storage files into /storage'
  fetch "storage-$night.tar.age" |
    tar --extract --file=- --directory=/storage --no-same-owner --xattrs --xattrs-include='user.*' ||
    stop "the Storage files of $night (storage-$night.tar.age in $folder/) did not restore (see above)"
  others=$(find /storage ! -type f ! -type d | wc -l)
  [ "$others" -eq 0 ] ||
    die "the Storage archive of $night held links or special files when extracted ($((others))), which Storage never writes"
  files=$(find /storage -type f | wc -l)
  bytes=$(find /storage -type f -exec stat -c %s {} + | awk '{ n += $1 } END { printf "%.0f", n }')
  storage="storage files $((files))
storage bytes $bytes"
else
  storage=$(printf '%s\n' "$listing" | awk '$1 == "storage"')
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
  listed "$names" "config-$night.tar.age" ||
    die "the night of $night has no settings archive (config-$night.tar.age)"
  files=$(fetch "config-$night.tar.age" | tar --list --file=-) ||
    stop "the settings archive of $night (config-$night.tar.age in $folder/) could not be listed (see above)"
  [ -n "$files" ] || die "the settings archive of $night is empty"
  echo "restore: the settings archive holds $(printf '%s\n' "$files" | tr '\n' ' ')"
fi

[ "$failed" -eq 0 ] || die "the restore of $night does not match its manifest"
# The last line names the night: whatever a night's text added above, nothing of it comes after.
if [ "$mode" = --test ]; then
  echo "restore test passed: the night of $night, from $folder/"
else
  echo "recovery of $night done: stop recover-db, then start db, auth, rest, realtime, storage, api-gw and backup (docs/RUNBOOK.md)"
fi
