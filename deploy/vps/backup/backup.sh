#!/bin/sh
# shellcheck disable=SC3040 # BusyBox ash, this image's sh, has pipefail
# MenuMesh's nightly backup (docs/DECISIONS.md VPS-40, VPS-43), run by the image's crond at 20:30 UTC
# (02:00 IST) in the backup service. Each part streams through age, to the owner's key in
# BACKUP_AGE_RECIPIENT, into the bucket (the rclone remote "backups", from RCLONE_CONFIG_BACKUPS_*),
# so no part is written in the container, decrypted or not: only its sha256 and size stay, for the
# seal. Under daily/ in BACKUP_BUCKET, every name ends in the night's id, <night>: its stamp and 8
# random hex characters, such as 2026-11-13T2030Z-3f9c0a1b.
#
#   globals-<night>.sql.age    the roles, with their passwords (pg_dumpall --globals-only)
#   <db>-<night>.dump.age      each database in full, owners and grants included (pg_dump -Fc)
#   storage-<night>.tar.age    the Storage volume, with the xattrs that hold each file's type
#   manifest-<night>.txt.age   row counts, the newest migration and the files, which a restore
#                              compares
#   base-<night>.tar.zst.age   the whole cluster, consistent alone (pg_basebackup, then zstd), from
#                              which a point-in-time recovery replays the WAL wal-ship.sh ships
#   config-<night>.tar.age     the host's newest settings archive, already encrypted by the host
#   seal-<night>.txt           the night's seal, in plain text (seal.sh): the sha256 and size of each
#                              part as it went up and where the base starts, signed with
#                              BACKUP_SIGNING_KEY; uploaded after every part, so a seal means a
#                              whole night, and a restore reads only the parts it lists
#
# A whole night stamped the 1st (UTC) is also copied to monthly/, or the next whole night when the
# 1st's wasn't, and the copy recorded there last, signed, as copy-<night>.txt (below); daily copies
# go after 30 days, monthly ones after 366 and the shipped WAL after 15. A missing or stale
# settings archive, or a base backup that failed, fails the run once everything else is safe: the
# seal lists what went up (and says "base none" without a base), and such a night is never the
# month's copy. A failure goes to Telegram (notify.sh alert); a full success ends in one line,
# `backup <night>: ...`, which names the month's copy, and pings HEARTBEAT_URL with it, so the
# monitor keeps each whole night's id where the bucket's token can't reach. Nothing printed holds a
# value.
set -eu -o pipefail

stamp=$(date -u +%Y-%m-%dT%H%MZ)
night=$stamp
reason='the settings of the job'
# The night's own small files (below): two FIFOs, each part's sha256 and size, and the seal.
work=
finish() {
  status=$?
  [ -z "$work" ] || rm -rf "$work"
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

for name in PGHOST PGUSER PGPASSWORD BACKUP_AGE_RECIPIENT BACKUP_BUCKET RCLONE_CONFIG_BACKUPS_TYPE BACKUP_SIGNING_KEY BACKUP_SIGNING_PUBLIC_KEY; do
  eval "set -- \"\${$name-}\""
  [ -n "$1" ] || fail "$name is not set"
done
# The signing helpers and the seal's rules, which also keep BACKUP_SIGNING_KEY from every program
# this job runs.
# shellcheck source=/dev/null
. /usr/local/share/menumesh/seal.sh
remote="backups:$BACKUP_BUCKET"
day="$remote/daily"
# rclone says only what went wrong (not, for one, that a long stream uploads in 5 MiB parts).
export RCLONE_LOG_LEVEL=ERROR

# Below everything else on the shared server's CPU and disk; the children inherit both.
renice -n 10 -p $$ >/dev/null 2>&1 || true
ionice -c 3 -p $$ >/dev/null 2>&1 || true

age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" </dev/null >/dev/null 2>&1 ||
  fail 'BACKUP_AGE_RECIPIENT is not an age public key'
# A night no restore takes is no backup: the seal needs the signing key to be the pair of the key
# the restores check, so a probe is signed and checked with the first public key before anything
# goes up. Each value is held to its shape first, the list before the private key, and one that is
# no key is named as the restores name it: a list that is no list of keys checks no probe, and its
# night was blamed on the private key (Stop C's re-review, finding U4).
reason='the signing key'
seal_public_keys_ok ||
  fail "BACKUP_SIGNING_PUBLIC_KEY is not one Ed25519 public key or several, as pnpm vps:secrets writes it (base64 SPKI DER, separated by single spaces), so no night could be sealed: nothing was uploaded"
seal_private_key_ok ||
  fail "BACKUP_SIGNING_KEY is not an Ed25519 private key, as pnpm vps:secrets writes it (base64 PKCS #8 DER), so no night could be sealed: nothing was uploaded"
seal_self_check ||
  fail "BACKUP_SIGNING_KEY does not sign what BACKUP_SIGNING_PUBLIC_KEY's first key checks, so no night could be sealed: nothing was uploaded"
reason='reaching the bucket'
rclone lsf --dirs-only "$remote/" >/dev/null

# Uploads stdin, encrypted to the owner's key, as daily/<name>, and keeps the sha256 and size of
# what went up for the seal: tee feeds two FIFOs as the stream passes (BusyBox ash has no process
# substitution). This shell holds each FIFO open while the readers start, so they never wait for a
# writer, and lets go once the upload ended: then they see the stream's end whatever became of tee.
put() {
  exec 7<>"$work/sum.fifo" 8<>"$work/size.fifo"
  sha256sum <"$work/sum.fifo" >"$work/sum" 7>&- 8>&- &
  summing=$!
  wc -c <"$work/size.fifo" >"$work/size" 7>&- 8>&- &
  counting=$!
  sent=0
  age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" | tee "$work/sum.fifo" "$work/size.fifo" |
    rclone rcat "$day/$1" || sent=$?
  exec 7>&- 8>&-
  wait "$summing" && wait "$counting" && [ "$sent" -eq 0 ] || return 1
  sealed "$1" "$(cut -d ' ' -f 1 <"$work/sum")" "$(tr -d ' ' <"$work/size")"
}
# Keeps a part's sha256 and size for the seal: sealed <name> <sha256> <bytes>.
sealed() {
  case $2 in '' | *[!0-9a-f]*) return 1 ;; esac
  case $3 in '' | 0 | *[!0-9]*) return 1 ;; esac
  [ "${#2}" -eq 64 ] || return 1
  printf '%s %s\n' "$2" "$3" >"$work/sealed/$1"
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
# the roles and the manifest, short texts, must pass 256 bytes. The base and the settings archive
# join them once each is made (below).
expected="globals-$night.sql.age:256 storage-$night.tar.age:1024 manifest-$night.txt.age:256"
for db in $dbs; do expected="$expected $db-$night.dump.age:1024"; done

# None of tonight's names may be in either folder before the first upload, the month's copy's
# record among them: nobody could know them, so one that is there means someone else wrote to the
# bucket, and the night stops here.
reason="the check of tonight's names"
for folder in daily monthly; do
  there=$(for part in $expected "base-$night.tar.zst.age:1024" "config-$night.tar.age:1024" "seal-$night.txt:0" "copy-$night.txt:0"; do echo "${part%:*}"; done |
    held "$remote/$folder" | awk '{ printf "%s%s", sep, $2; sep = " " }')
  [ -z "$there" ] ||
    fail "someone else wrote to the bucket: $folder/ holds $there before tonight's first upload"
done

reason='the work folder'
work=$(mktemp -d /tmp/backup.XXXXXX)
mkfifo -m 600 "$work/sum.fifo" "$work/size.fifo"
mkdir "$work/sealed"

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
# Its sha256 and size for the seal come from the file, which the host never writes again. It is
# checked and copied here, before the base, which may run for 2 hours: checked after it, a fresh
# archive could be more than 2 hours old by then, and a night whose base took long would fail
# (Stop C's review, finding D4).
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
  sealed "config-$night.tar.age" "$(sha256sum "$archive" | cut -d ' ' -f 1)" "$(($(wc -c <"$archive")))" ||
    fail "the settings archive ${archive##*/} could not be read"
  rclone copyto --no-check-dest "$archive" "$day/config-$night.tar.age"
  expected="$expected config-$night.tar.age:1024"
fi

# The base backup (VPS-43): the whole cluster as one tar with the WAL it needs to be consistent
# alone (-X fetch), so a monthly copy keeps it too, through zstd and age. The seal gives a time no
# earlier than its end (a second past pg_basebackup's), the WAL file it starts in, from which a
# point-in-time recovery replays what wal-ship.sh shipped, and the cluster's system identifier,
# unsigned, as wal-ship.sh names the cluster's folder. A base that fails, or that runs past 2 hours,
# stops none of the other parts: the night fails at the end, and its seal says "base none".
# pg_basebackup's own lines stay in a file, and go to the journal only when it fails.
#
# pg_basebackup -X fetch reads the WAL last, after the data, from db's pg_wal, and db removes a WAL
# file at its first checkpoint after the file was archived: checkpoint_timeout (5 minutes) after
# the base's own checkpoint began, which spread can take half of, or sooner once max_wal_size
# fills. A base that outlived that checkpoint would fail ("requested WAL segment ... has already
# been removed"). So a temporary physical slot, menumesh_base_<hex>, keeps the WAL from before the
# base's checkpoint until the base ends: a psql session of its own makes it, and holds it for as
# long as this shell keeps the session's input, a FIFO on fd 9, open. The slot goes with the
# session, whatever ends this job, and db's max_slot_wal_keep_size bounds what it can keep.
base_line='base none'
base_problem=
holder=
hold_wal() {
  slot=menumesh_base_$hex
  mkfifo -m 600 "$work/slot.fifo" || return 1
  PGCONNECT_TIMEOUT=10 psql -X -q -At -v ON_ERROR_STOP=1 -d postgres <"$work/slot.fifo" \
    >/dev/null 2>>"$work/base.log" &
  holder=$!
  exec 9<>"$work/slot.fifo"
  printf "select pg_create_physical_replication_slot('%s', true, true);\n" "$slot" >&9
  tries=0
  until [ "$(PGCONNECT_TIMEOUT=10 psql -X -At -d postgres -c "select count(*) from pg_replication_slots where slot_name = '$slot' and temporary and restart_lsn is not null" 2>>"$work/base.log")" = 1 ]; do
    tries=$((tries + 1))
    [ "$tries" -lt 30 ] && kill -0 "$holder" 2>/dev/null || return 1
    sleep 1
  done
}
# The end of the session's input ends the session, and the slot with it.
release_wal() {
  exec 9>&-
  [ -z "$holder" ] || wait "$holder" || true
  holder=
}
base() {
  taken=0
  take_base || taken=1
  release_wal
  return "$taken"
}
take_base() {
  if ! reading=$(psql -X -At -v ON_ERROR_STOP=1 -F ' ' -d postgres -c "
      select case when system_identifier < 0
                  then (system_identifier::numeric + 18446744073709551616)::text
                  else system_identifier::text end,
             (select setting from pg_settings where name = 'wal_segment_size')
        from pg_control_system()" 2>"$work/base.log"); then
    base_problem='db could not be asked for its system identifier'
    return 1
  fi
  # shellcheck disable=SC2086 # two words, split on purpose
  set -- $reading
  cluster=${1-}
  segment=${2-}
  case $cluster in '' | 0 | *[!0-9]*) cluster= ;; esac
  case $segment in
    1048576 | 2097152 | 4194304 | 8388608 | 16777216 | 33554432 | 67108864 | 134217728 | 268435456 | 536870912 | 1073741824) ;;
    *) segment= ;;
  esac
  if [ -z "$cluster" ] || [ -z "$segment" ] || [ "$#" -ne 2 ]; then
    base_problem='db answered with no system identifier or WAL segment size'
    return 1
  fi
  if ! hold_wal; then
    base_problem='db would not hold the WAL for the base backup in a replication slot (are all of max_replication_slots in use?)'
    return 1
  fi
  if ! { timeout 7200 pg_basebackup --pgdata=- --format=tar --wal-method=fetch --checkpoint=spread \
    --label="menumesh $night" --verbose 2>>"$work/base.log" && date -u +%s >"$work/base.end"; } |
    zstd -3 -q -c | put "base-$night.tar.zst.age"; then
    base_problem='the base backup failed or ran past 2 hours (pg_basebackup, zstd, age or rclone)'
    return 1
  fi
  start=$(sed -n 's|^pg_basebackup: write-ahead log start point: \([0-9A-F]\{1,8\}\)/\([0-9A-F]\{1,8\}\) on timeline \([1-9][0-9]\{0,8\}\)$|\1 \2 \3|p' "$work/base.log")
  # shellcheck disable=SC2086 # three words, split on purpose
  set -- $start
  if [ "$#" -ne 3 ]; then
    base_problem='pg_basebackup named no WAL start point'
    return 1
  fi
  ended=$(sed -n 1p "$work/base.end")
  case $ended in
    '' | *[!0-9]*)
      base_problem='the base backup has no end time'
      return 1
      ;;
  esac
  # The WAL file that holds the start point: the timeline, then the segment's number in two halves.
  walfile=$(printf '%08X%08X%08X' "$3" "$((0x$1))" "$((0x$2 / segment))")
  base_line="base $(date -u -d "@$((ended + 1))" +%Y-%m-%dT%H:%M:%SZ) $walfile $cluster"
}
reason='the base backup'
if base; then
  expected="$expected base-$night.tar.zst.age:1024"
else
  echo "backup: $base_problem" >&2
  # What pg_basebackup said but its progress lines, without a control character: three lines at
  # most, cut at 200 bytes.
  LC_ALL=C tr -d '\000-\010\013-\037\177-\377' <"$work/base.log" |
    grep -v -E '^pg_basebackup: (initiating base backup|checkpoint completed|write-ahead log |syncing data|base backup completed)' |
    sed -n '1,3s/^\(.\{0,200\}\).*/backup: | \1/p' >&2 || true
fi

# Every part of tonight is in the bucket, none is empty (the floors above), and each is as many
# bytes as went up.
reason='the check of the uploads'
listing=$(for part in $expected; do echo "${part%:*}"; done | held "$day")
for part in $expected; do
  name=${part%:*}
  size=$(printf '%s\n' "$listing" | awk -v name="$name" '$2 == name { print $1 }')
  [ -n "$size" ] || fail "$name is not in the bucket"
  [ "$size" -gt "${part##*:}" ] || fail "$name is only $size bytes"
  read -r sum sent <"$work/sealed/$name" || fail "no sha256 of $name was kept"
  [ "$size" -eq "$sent" ] || fail "$name is $size bytes in the bucket, not the $sent that went up"
done

# The seal, last: the night, its base, each part as it went up, and the signature of those lines,
# checked here as a restore checks it before it goes up.
reason='the seal'
{
  printf 'menumesh seal 1 %s\n%s\n' "$night" "$base_line"
  for part in $expected; do
    name=${part%:*}
    read -r sum sent <"$work/sealed/$name"
    printf 'part %s %s %s\n' "$sum" "$sent" "$name"
  done
} >"$work/seal.body"
signature=$(seal_sign "$work/seal.body") || fail 'the seal could not be signed (openssl)'
{
  cat "$work/seal.body"
  printf 'signature %s\n' "$signature"
} >"$work/seal"
# shellcheck disable=SC2154 # seal_problem: set by seal_open (seal.sh)
seal_open "$work/seal" "$night" || fail "the seal is not one a restore takes: it $seal_problem"
rclone copyto --no-check-dest "$work/seal" "$day/seal-$night.txt"
sealed_size=$(echo "seal-$night.txt" | held "$day" | awk '{ print $1 }')
[ "$sealed_size" = "$(($(wc -c <"$work/seal")))" ] || fail "seal-$night.txt is not in the bucket as it went up"

# The month's copy in monthly/: only a whole night, every upload above checked, its base made and
# its settings archive fresh, and one stamped the 1st (UTC) or, while monthly/ holds no whole copy
# of the month, the next whole night, so a 1st that failed leaves the copy to it. Its parts go
# first, then its seal, then, once both are checked there, its record, copy-<night>.txt, last:
#
#   menumesh copy 1 <night> <sha256 of the night's seal, every byte of it>
#   signature <base64url Ed25519 signature of the line above>
#
# signed with BACKUP_SIGNING_KEY, as the seal is. Only this script signs one, and only after its
# own copy is in monthly/, each part and the seal under its exact name at the size it went up and
# the seal byte for byte, so a record never vouches for objects the bucket doesn't hold. Its line
# begins as nothing else the backup signs does (a seal's "menumesh seal 1", the WAL's "menumesh
# wal 1", the self-check's probe), so no signature of one stands for another. A copy counts as
# whole only with its record (whole_copy, below): names someone else put in monthly/ can't stop the
# 1st's copy, nor stand in for a whole one, and a copy cut short before its record is copied again
# by the next whole night. The night that makes the copy says so in a line of its own as soon as
# the record is up, before the removal of old copies, which can fail; a later whole night names
# the copy it found in its own line. So the journal, and through the heartbeat the monitor's log,
# name the month's copy whatever fails after it (Stop C's re-review, finding B1).
#
# Each part is held to its size, not its bytes, which would cost the month's copy in downloads
# every night. Objects of the sizes a night's seal gives, put under that night's free names in
# monthly/ beside its real seal copied from daily/, after its own copy was cut short or by beating
# its own check after a 1st that failed, passed for its copy and stopped the month's later copies
# with no alert (Stop C's re-review, the rest of finding S2): they have no record, so the next
# whole night copies itself. Under locks that refuse overwrites, an object put under one of
# tonight's monthly/ names while the night runs (its id and sizes show in daily/'s listing from its
# first upload) refuses that night's copy or record, and the night fails with the alert, as does
# each later night so stopped. Under versioning, objects of the same sizes put over a recorded
# copy's parts still pass for them; a restore refuses them by their sha256.
#
# record_message <night> <seal>: the line a record of that night's copy signs, for the seal the
# file holds, on stdout.
record_message() {
  record_sum=$(sha256sum "$2" | cut -d ' ' -f 1) || return 1
  case $record_sum in '' | *[!0-9a-f]*) return 1 ;; esac
  [ "${#record_sum}" -eq 64 ] || return 1
  printf 'menumesh copy 1 %s %s\n' "$1" "$record_sum"
}
# whole_copy <night>: whether monthly/ holds that night whole: its seal, at most seal_max bytes, a
# backup's for that night with a base, a settings archive and a dump of each of tonight's
# databases; its record, looked up by its exact name before it is read (rclone cat of a name the
# folder doesn't hold reads every object under that name and a slash), no longer than 256 bytes,
# and byte for byte the line built here from that night and the very seal file checked above,
# "signature ", a signature of that line by any of BACKUP_SIGNING_PUBLIC_KEY's keys (as a seal's,
# so a rotation keeps the copies the old key recorded) and a newline: nothing of the record is
# taken but the signature, and that only to be checked; and every part the seal lists in monthly/
# at the size it gives, each looked up by its exact name (held). A listing of monthly/ quotes no
# name: an object named after a part, a space and more, at the part's size, passed for the part,
# and with the night's own seal copied there from daily/, stopped every later copy of the month
# (Stop C's review, finding S2).
# shellcheck disable=SC2154 # seal_max and seal_parts: seal.sh's
whole_copy() {
  rclone cat --no-traverse --head "$((seal_max + 1))" "$remote/monthly/seal-$1.txt" >"$work/candidate" &&
    seal_open "$work/candidate" "$1" &&
    record_message "$1" "$work/candidate" >"$work/candidate.message" &&
    echo "copy-$1.txt" | held "$remote/monthly" >"$work/candidate.recorded" &&
    LC_ALL=C awk -v name="copy-$1.txt" '
      NF == 2 && $2 == name && $1 ~ /^[1-9][0-9]*$/ && $1 + 0 <= 256 { found = 1 }
      END { exit found ? 0 : 1 }' "$work/candidate.recorded" &&
    rclone cat --no-traverse --head 257 "$remote/monthly/copy-$1.txt" >"$work/candidate.record" &&
    [ "$(($(wc -c <"$work/candidate.record")))" -le 256 ] &&
    record_signature=$(tail -c 87 "$work/candidate.record" | head -c 86) &&
    {
      cat "$work/candidate.message"
      printf 'signature %s\n' "$record_signature"
    } >"$work/candidate.built" &&
    cmp -s "$work/candidate.built" "$work/candidate.record" &&
    seal_verify "$work/candidate.message" "$record_signature" &&
    printf '%s\n' "$seal_parts" >"$work/candidate.parts" &&
    awk '{ print $3 }' "$work/candidate.parts" | held "$remote/monthly" >"$work/candidate.held" &&
    DBS="$dbs" LC_ALL=C awk -v night="$1" '
      FNR == NR { want[$3] = $2; next }
      NF == 2 && ($2 in want) && $1 == want[$2] { have[$2] = 1 }
      END {
        n = split("globals-" night ".sql.age storage-" night ".tar.age manifest-" night ".txt.age base-" night ".tar.zst.age config-" night ".tar.age", need, " ")
        k = split(ENVIRON["DBS"], db, "\n")
        for (i = 1; i <= k; i++) need[n + i] = db[i] "-" night ".dump.age"
        for (i = 1; i <= n + k; i++) if (!(need[i] in want)) exit 1
        for (name in want) if (!(name in have)) exit 1
      }' "$work/candidate.parts" "$work/candidate.held"
}
reason='the monthly copy'
# --no-check-dest on each copyto: rclone skips a same-size, same-mtime destination, so a look-alike planted first would stay.
month=${stamp%-??T*}
kept=
if [ -z "$archive_problem" ] && [ -z "$base_problem" ]; then
  case $stamp in
    ????-??-01T*) whole= ;;
    *)
      # The month's seals in monthly/: of them, at most 5 named as this script names one, oldest
      # first and no longer than a seal, are fetched and checked, so names planted there cost a
      # few small reads at most. Planted seals fail their signature and stop no copy; enough of
      # them, oldest, could make one copy more. The listing quotes no name, so a line of more than
      # a size and a name is no seal's.
      rclone lsf --files-only --format sp --separator ' ' --include "seal-$month-*" "$remote/monthly/" |
        LC_ALL=C awk -v month="$month" -v max="$seal_max" '
          NF == 2 && $1 + 0 <= max && $2 ~ ("^seal-" month "-[0-9][0-9]T[0-9][0-9][0-9][0-9]Z-[0-9a-f]{8}[.]txt$") { print substr($2, 6, 25) }' |
        sort -u | awk 'NR <= 5' >"$work/candidates"
      whole=
      while read -r candidate; do
        if whole_copy "$candidate" </dev/null; then
          whole=$candidate
          break
        fi
      done <"$work/candidates"
      ;;
  esac
  if [ -z "$whole" ]; then
    for part in $expected; do
      name=${part%:*}
      rclone copyto --no-check-dest "$day/$name" "$remote/monthly/$name"
    done
    rclone copyto --no-check-dest "$work/seal" "$remote/monthly/seal-$night.txt"
    # The copy as monthly/ holds it, before its record vouches for it: each part and the seal by its
    # exact name at the size it went up, then the seal byte for byte.
    reason="the check of the month's copy"
    copied=$({
      for part in $expected; do echo "${part%:*}"; done
      echo "seal-$night.txt"
    } | held "$remote/monthly")
    for part in $expected "seal-$night.txt:0"; do
      name=${part%:*}
      if [ "$name" = "seal-$night.txt" ]; then
        sent=$(($(wc -c <"$work/seal")))
      else
        read -r sum sent <"$work/sealed/$name"
      fi
      size=$(printf '%s\n' "$copied" | awk -v name="$name" 'NF == 2 && $2 == name { print $1 }')
      [ "$size" = "$sent" ] || fail "monthly/$name is not in the bucket as it went up"
    done
    rclone cat --no-traverse --head "$((seal_max + 1))" "$remote/monthly/seal-$night.txt" >"$work/copied"
    cmp -s "$work/copied" "$work/seal" || fail "monthly/seal-$night.txt is not the night's seal"
    # Its record, last, and confirmed by its name at its size. A record that fails leaves the copy
    # in monthly/, which a restore reads by its names, and the next whole night copies itself.
    reason="the record of the month's copy"
    record_message "$night" "$work/seal" >"$work/record.message" ||
      fail "no sha256 of seal-$night.txt for the record"
    signature=$(seal_sign "$work/record.message") || fail 'the record could not be signed (openssl)'
    {
      cat "$work/record.message"
      printf 'signature %s\n' "$signature"
    } >"$work/record"
    rclone copyto --no-check-dest "$work/record" "$remote/monthly/copy-$night.txt"
    recorded=$(echo "copy-$night.txt" | held "$remote/monthly" |
      awk -v name="copy-$night.txt" 'NF == 2 && $2 == name { print $1 }')
    [ "$recorded" = "$(($(wc -c <"$work/record")))" ] ||
      fail "monthly/copy-$night.txt is not in the bucket as it went up"
    echo "backup $night: kept in monthly/ as the month's copy"
    kept=", kept in monthly/ as the month's copy"
  else
    kept=", the month's copy is $whole"
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
# only once its lock has ended, not every night (review finding F3). The shipped WAL goes after 15
# days, a day past the 14 a point-in-time recovery reaches back, but for each cluster's timeline
# history files, small, which a recovery to any point reads. A copy's record goes with its copy.
reason='the removal of old copies'
rclone delete --use-server-modtime --min-age 30d "$day/"
rclone delete --use-server-modtime --min-age 366d "$remote/monthly/"
rclone delete --use-server-modtime --min-age 15d --exclude '/*/history/**' "$remote/wal/"

problems=$archive_problem
[ -z "$base_problem" ] || problems="${problems:+$problems; }$base_problem"
[ -z "$problems" ] || fail "$problems"

summary=$(printf '%s\n' "$listing" | awk '{ n++; total += $1 } END { printf "%d parts, %.0f bytes", n, total }')
line="backup $night: $summary$kept"
echo "$line"
# Last, so that a ping means every step above worked. It carries the line: with the server gone,
# the monitor's log still names each whole night's id and the month's copy (docs/RUNBOOK.md,
# Disaster recovery).
notify.sh beat "$line"
