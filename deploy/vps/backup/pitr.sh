#!/bin/sh
# shellcheck disable=SC3040 # BusyBox ash, this image's sh, has pipefail
# MenuMesh's point-in-time recovery from the backup's bucket (docs/DECISIONS.md VPS-43): a night's
# base backup, then the WAL that wal-ship.sh shipped after it, replayed to a point by the image's
# own Postgres 17:
#
#   pitr.sh --test   the monthly drill (the pitr-test service), after the restore test: replays into
#                    a data folder in memory, says where the replay stopped, counts the rows there
#                    beside the night's manifest, and changes nothing else
#   pitr.sh --into   disaster recovery (the recover-pitr service): replays into the real, empty
#                    db-data volume and stops the cluster cleanly there, for db to start on
#
# The point is PITR_TARGET: a time with its offset, such as 2026-11-15T14:30:00+05:30 or
# 2026-11-15T09:00:00Z, or latest, the end of the WAL in the bucket. A recovery takes only a point
# it is given; the drill, given none, replays to the latest. A point later than now is refused, and
# so is one more than 14 days back: the bucket keeps the WAL 15 days by its upload time (backup.sh),
# and the newest base before such a point can be a day older than it.
#
# The night is the newest of daily/, younger than 29 days and stamped no later than the point,
# whose seal (seal.sh) a key of BACKUP_SIGNING_PUBLIC_KEY signed and whose base backup ended before
# the point; the nights passed over are named, with why. Its base part is downloaded as the bucket
# holds it, still encrypted, into this container's own files, never more than a byte past the size
# the seal gives, held to that size and sha256, and only then decrypted and unpacked by the image's
# postgres (uid 70), who replays it. The WAL is wal-ship.sh's: wal/<cluster>/<log id>/
# <walfile>.<signature>.zst.age, and wal/<cluster>/history/ for the timelines' history files. Only
# the base's cluster is read, and of it only the history folder and each log id's folder in turn
# from the one the base starts in. Each listing is read as JSON, one object a line, and a line only
# when it is all a name wal-ship.sh writes: a name in the bucket can hold no quote or line break
# that passes for another. Each WAL file is downloaded the same way, no larger than a WAL file can
# be, and kept only when the signature in its name is the backup's, over the cluster, the WAL file
# and the sha256 of those very bytes: whatever else is under its name is passed over. The WAL
# files stay encrypted here; wal-fetch.sh, the replay's restore_command, decrypts each as the replay
# asks for it. They are taken up to the first one uploaded more than 30 minutes after the point
# (the shipper sends each within about 2), or all of them for latest. A WAL file the chain needs
# that is not in the bucket, or none of whose objects is the backup's, ends the chain there, said
# plainly, with whether the backup's WAL goes on after it; the drill then fails. The WAL of a
# later timeline without that timeline's history file is refused before the replay, which would
# follow an older timeline instead.
#
# The replay runs on the image's own Postgres 17, not on the database's image: restore_command needs
# age and zstd, which that image lacks. Replay rewrites pages and runs no SQL, so neither the
# database's libraries nor its ICU, which differs from this image's, takes part. The replayed
# cluster is only counted, never written to: no sort or comparison of text, in read-only sessions,
# and nothing of the night's runs there: no library is preloaded, no event trigger fires, none of
# the live cluster's own settings applies (what ALTER SYSTEM set there, in the base's
# postgresql.auto.conf, waits aside while the replay runs, and goes back for db after a recovery),
# it gets none of this script's environment, and the copy of the age key it replays with is gone
# before the first count. Everything printed goes through the filter restore.sh has too.
set -eu -o pipefail

# Everything the run prints, its own lines and those of rclone, age, tar, Postgres and psql, goes
# through one filter: tab and newline stay, every other control character and every byte past ASCII
# go. This shell stays the container's process 1 and writes into a FIFO that the filter reads; on
# exit it waits until the filter has passed everything on.
fifo=$(mktemp -u /tmp/pitr.XXXXXX)
mkfifo -m 600 "$fifo"
LC_ALL=C tr -d '\000-\010\013-\037\177-\377' <"$fifo" &
filter=$!
exec >"$fifo" 2>&1
rm -f "$fifo"

data=/var/lib/postgresql/data
# The copy of the owner's age key that wal-fetch.sh reads as postgres: on the service's tmpfs at
# /run/pitr, never on a disk, and removed once the replay ended.
key=/run/pitr/age-identity
keyed=
# The run's own files: the downloads, still encrypted, the replay's settings and its log.
work=
# The replaying postmaster, while it runs.
postmaster=
# Set once a recovery has begun to write to db-data.
writing=
# Stops the replay, fast: a clean shutdown, so a recovery leaves db-data consistent even then.
quit() {
  gosu postgres pg_ctl --pgdata="$data" --mode=fast --wait --timeout=300 stop >>"$work/replay.log" 2>&1 ||
    return 1
  postmaster=
}
forget_key() {
  [ -z "$keyed" ] || gosu postgres rm -f "$key" || return 1
  keyed=
}
finish() {
  status=$?
  [ -z "$postmaster" ] || quit || true
  forget_key || true
  if [ "$status" -ne 0 ] && [ -n "$writing" ]; then
    echo "pitr: the recovery stopped after it began to write to db-data: make db-data new (docs/RUNBOOK.md, Disaster recovery) before recovering again"
  fi
  [ -z "$work" ] || rm -rf "$work"
  exec >&- 2>&-
  wait "$filter" || true
  exit "$status"
}
trap finish EXIT
# As process 1 this shell would ignore a stop: these end it, and the replay with it.
trap 'exit 130' INT
trap 'exit 143' TERM
# Nothing from the bucket is ever globbed.
set -f
umask 077

mode=${1-}
case $mode in
  --test | --into) ;;
  *)
    echo 'usage: pitr.sh --test | --into' >&2
    exit 2
    ;;
esac
die() {
  echo "pitr: $*" >&2
  exit 1
}
# Stops after a command that failed, with a line naming what it was reading, and its exit status.
stop() {
  status=$?
  echo "pitr: $*" >&2
  exit "$status"
}
for name in BACKUP_BUCKET RCLONE_CONFIG_BACKUPS_TYPE AGE_IDENTITY_FILE BACKUP_SIGNING_PUBLIC_KEY; do
  eval "set -- \"\${$name-}\""
  [ -n "$1" ] || die "$name is not set"
done
[ "$(id -u)" = 0 ] || die 'run it as root, the image user: it hands the data folder to postgres'
[ -r "$AGE_IDENTITY_FILE" ] ||
  die "no age key at $AGE_IDENTITY_FILE: mount the owner's key on a ramfs (-v /run/age:/run/age:ro)"
[ -d /run/pitr ] || die 'no tmpfs at /run/pitr for the copy of the age key the replay reads'
# The seal's rules and the signature checks (seal_open, seal_part, seal_verify, seal_max).
# shellcheck source=/dev/null
. /usr/local/share/menumesh/seal.sh
seal_public_keys_ok ||
  die "BACKUP_SIGNING_PUBLIC_KEY is not one Ed25519 public key or several, as pnpm vps:secrets writes it (base64 SPKI DER, separated by single spaces)"
bucket="backups:$BACKUP_BUCKET"
export RCLONE_LOG_LEVEL=ERROR

# --- the point ---

target=${PITR_TARGET-}
if [ -z "$target" ]; then
  [ "$mode" = --test ] ||
    die "a recovery needs PITR_TARGET, the point to recover to: a time with its offset, like 2026-11-15T14:30:00+05:30, or latest (docs/RUNBOOK.md, Disaster recovery)"
  target=latest
fi
seconds=$(date -u +%s)
utc() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ; }
if [ "$target" = latest ]; then
  point=$seconds
  cutoff=
else
  case $target in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z)
      clock=${target%Z}
      offset=+00:00
      ;;
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9][+-][0-9][0-9]:[0-9][0-9])
      clock=${target%??????}
      offset=${target#"$clock"}
      ;;
    *) die "PITR_TARGET must be a time with its offset, like 2026-11-15T14:30:00+05:30 or 2026-11-15T09:00:00Z, or latest" ;;
  esac
  # The clock read as UTC and held to its own spelling (date takes 2026-02-30 for March 2nd), then
  # moved by the offset; zeros leading an hour or a minute would make them octal.
  if ! wall=$(date -u -d "$(echo "$clock" | tr T ' ')" +%s 2>/dev/null) ||
    [ "$(date -u -d "@$wall" +%Y-%m-%dT%H:%M:%S)" != "$clock" ]; then
    die "PITR_TARGET $target is not a time of the calendar"
  fi
  hours=${offset#?}
  hours=${hours%:*}
  hours=${hours#0}
  minutes=${offset##*:}
  minutes=${minutes#0}
  [ "$hours" -le 14 ] && [ "$minutes" -lt 60 ] || die "PITR_TARGET $target has no offset of a time zone"
  case $offset in
    -*) point=$((wall + (hours * 60 + minutes) * 60)) ;;
    *) point=$((wall - (hours * 60 + minutes) * 60)) ;;
  esac
  # The point as given, and in UTC when given otherwise.
  said_point=$target
  [ "$target" = "$(utc "$point")" ] || said_point="$target ($(utc "$point"))"
  [ "$point" -le "$seconds" ] ||
    die "PITR_TARGET $said_point is later than now ($(utc "$seconds")): name a point that has passed, or latest"
  [ "$point" -ge $((seconds - 14 * 86400)) ] ||
    die "PITR_TARGET $said_point is more than 14 days back: the bucket keeps the WAL 15 days by its upload time, so a point-in-time recovery reaches 14 days back at most; recover a night's own backup instead (docs/RUNBOOK.md, Disaster recovery)"
  # The WAL files go up to the first one uploaded later than this, in the listing's own spelling.
  cutoff=$(date -u -d "@$((point + 1800))" +%Y-%m-%dT%H:%M:%S)
fi
[ "$target" != latest ] || said_point='the latest WAL in the bucket'

# Only into an empty data folder: a recovery into a new db-data volume, refused before anything
# of the bucket is read.
listing=$(ls -A "$data") || stop "$data could not be read"
if [ -n "$listing" ]; then
  [ "$mode" = --test ] ||
    die "$data, the db-data volume, is not empty: recover only into a new db-data volume (docs/RUNBOOK.md, Disaster recovery)"
  die "$data is not empty"
fi

# --- the night ---

work=$(mktemp -d /tmp/pitr-run.XXXXXX)
# postgres reads the WAL files and the replay's settings from here, and nothing else.
chmod 0711 "$work"
: >"$work/replay.log"

# Which of the names on stdin daily/ holds, one a line, each looked for by its exact name.
held() {
  rclone lsf --files-only --no-traverse --files-from-raw - "$bucket/daily/"
}
# Whether this container's files have room for a download of <KiB> and 1 GiB to spare, on a disk
# the server shares: room <KiB> <what>.
room() {
  free=$(df -Pk "$work" | awk 'NR == 2 { print $4 }')
  [ "$free" -ge $(($1 + 1048576)) ] ||
    die "$2 needs $(($1 / 1024)) MiB in this container's files, 1 GiB to spare included, and $((free / 1024)) MiB are free"
}
# A part of the night as its seal gives it, into $work/<name>: looked for by its exact name, read
# by that name no further than a byte past the seal's size, and held to its size and sha256.
get() {
  want=$(seal_part "$1")
  [ -n "$want" ] || die "$1 is not in the seal of $night, so the backup did not write it: it is never read"
  room "$((${want#* } / 1024))" "$1"
  [ -n "$(echo "$1" | held)" ] || die "$1 is not in daily/, though the seal of $night lists it"
  rclone cat --no-traverse --head "$((${want#* } + 1))" "$bucket/daily/$1" >"$work/$1" ||
    stop "$1 in daily/ could not be read (see above)"
  got=$(($(wc -c <"$work/$1")))
  [ "$got" -eq "${want#* }" ] ||
    die "$1 in daily/ is not the part the backup sealed ($got bytes, not ${want#* }): someone else wrote to the bucket, and nothing was replayed"
  [ "$(sha256sum "$work/$1" | cut -d ' ' -f 1)" = "${want% *}" ] ||
    die "$1 in daily/ is not the part the backup sealed (its sha256 is not the seal's): someone else wrote to the bucket, and nothing was replayed"
}

# The nights to try, newest first: the ids of the seals in daily/ named as backup.sh names one,
# younger than 29 days and stamped no later than the point, which a night must be for its base to
# end before it. At most 32, so names someone else put there cost a few small reads at most.
point_stamp=$(date -u -d "@$point" +%Y-%m-%dT%H%MZ)
daily_lock=$(date -u -d "@$((seconds - 29 * 86400))" +%Y-%m-%dT%H%MZ)
rclone lsf --files-only --include 'seal-*.txt' "$bucket/daily/" |
  sed -n 's/^seal-\([0-9]\{4\}-[0-9][0-9]-[0-9][0-9]T[0-9]\{4\}Z-[0-9a-f]\{8\}\)\.txt$/\1/p' |
  LC_ALL=C awk -v point="$point_stamp" -v lock="$daily_lock" 'substr($0, 1, 16) > lock && substr($0, 1, 16) <= point' |
  LC_ALL=C sort -r | awk 'NR <= 32' >"$work/nights" ||
  stop 'daily/ of the bucket could not be listed (see above)'
# night_of <id>: whether that night's seal checks out (seal_open: its lines, signed by a key of
# BACKUP_SIGNING_PUBLIC_KEY) and gives a base backup that ended before the point; else why not.
night=
# shellcheck disable=SC2154 # seal_max, seal_problem and seal_base: seal.sh's, set by seal_open
night_of() {
  candidate=$1
  rclone cat --no-traverse --head "$((seal_max + 1))" "$bucket/daily/seal-$candidate.txt" >"$work/seal" ||
    stop "the seal of $candidate (seal-$candidate.txt in daily/) could not be read (see above)"
  if ! seal_open "$work/seal" "$candidate"; then
    why="its seal $seal_problem, so it is not the backup's"
    return 1
  fi
  if [ "$seal_base" = none ]; then
    why='its seal says its base backup failed ("base none")'
    return 1
  fi
  # shellcheck disable=SC2086 # three words, split on purpose
  set -- $seal_base
  ended=$(date -u -d "$(echo "$1" | sed 's/T/ /; s/Z$//')" +%s)
  if [ "$ended" -ge "$point" ]; then
    why="its base backup ended at $1, not before the point"
    return 1
  fi
  base_end=$1
  start=$2
  cluster=$3
  night=$candidate
}
passed=0
while read -r id; do
  if night_of "$id" </dev/null; then break; fi
  passed=$((passed + 1))
  [ "$passed" -gt 3 ] || echo "pitr: not taking the night of $id: $why"
done <"$work/nights"
[ "$passed" -le 3 ] || echo "pitr: not taking $((passed - 3)) more nights"
[ -n "$night" ] ||
  die "no night of daily/ younger than 29 days has a seal signed by the backup's key with a base backup that ended before $(utc "$point") (the newest $(wc -l <"$work/nights") seals tried)"
tli=$(echo "$start" | cut -c 1-8)
echo "pitr: to $said_point, from the night of $night: its base backup of the cluster $cluster ended at $base_end, from $start"

# For the drill, the night's manifest, read as restore.sh reads it: only the lines a backup writes.
if [ "$mode" = --test ]; then
  get "manifest-$night.txt.age"
  manifest=$(age --decrypt --identity "$AGE_IDENTITY_FILE" <"$work/manifest-$night.txt.age") ||
    stop "the manifest of $night (manifest-$night.txt.age in daily/) could not be read (see above)"
  problem=$(printf '%s\n' "$manifest" | LC_ALL=C awk -v night="$night" '
    /[^ -~]/ { print "line " NR " holds a control character or a byte past ASCII"; exit }
    NR == 1 {
      if ($0 != "menumesh backup " night) { print "its first line is not \"menumesh backup " night "\""; exit }
      next
    }
    $1 == "database" && NF == 2 && $2 ~ /^[a-z_][a-z0-9_]*$/ && length($2) < 64 && $2 !~ /^template[01]$/ { next }
    $1 == "table" && NF >= 4 && $NF ~ /^[0-9]+$/ { next }
    $1 == "migration" && NF == 3 && ($3 ~ /^[0-9]+$/ || $3 == "none") { next }
    $1 == "storage" && NF == 3 && ($2 == "files" || $2 == "bytes") && $3 ~ /^[0-9]+$/ { next }
    { print "line " NR " is not one a backup writes"; exit }')
  [ -z "$problem" ] || die "the manifest of $night is not a backup's: $problem"
  rm -f "$work/manifest-$night.txt.age"
fi

# --- the base, into the data folder ---

get "base-$night.tar.zst.age"
# From here on a recovery writes to db-data: one that stops leaves part of a cluster there.
[ "$mode" != --into ] || writing=yes
chmod 0700 "$data"
chown postgres:postgres "$data"
# pg_basebackup's tar holds only files and folders here: anything else is refused once unpacked,
# before it is read. GNU tar keeps every member under the folder.
age --decrypt --identity "$AGE_IDENTITY_FILE" <"$work/base-$night.tar.zst.age" | zstd -dcq |
  gosu postgres tar --extract --file=- --directory="$data" --no-same-owner ||
  stop "the base backup of $night (base-$night.tar.zst.age in daily/) could not be unpacked (see above)"
rm -f "$work/base-$night.tar.zst.age"
others=$(gosu postgres find "$data" ! -type f ! -type d | wc -l) || stop "$data could not be read"
[ "$others" -eq 0 ] ||
  die "the base backup of $night holds links or special files ($((others))), which pg_basebackup never writes here: nothing was replayed"
# What ALTER SYSTEM set on the live cluster is in the base's postgresql.auto.conf, which Postgres
# reads from the data folder whatever else it is told: commands to run at the recovery's end or
# after a restartpoint, a port, a recovery target. None of it has a say in the replay, which would
# run those commands as the user who holds the copy of the age key: the file waits beside itself
# under another name, an empty one in its place, and a recovery puts it back once the cluster has
# stopped, so that db starts with the settings it had.
auto=$data/postgresql.auto.conf
aside=
if gosu postgres test -e "$auto"; then
  gosu postgres mv -f "$auto" "$auto.pitr" || stop "the base backup's postgresql.auto.conf could not be set aside"
  aside=yes
fi
gosu postgres touch "$auto" || stop "$auto could not be made"
# The cluster, its WAL files' size and where its backup starts, as its own files give them.
control=$(LC_ALL=C gosu postgres pg_controldata "$data") || stop "the base backup of $night has no control file to read"
system=$(printf '%s\n' "$control" | sed -n 's/^Database system identifier: *\([0-9]\{1,20\}\)$/\1/p')
segment=$(printf '%s\n' "$control" | sed -n 's/^Bytes per WAL segment: *\([0-9]\{1,10\}\)$/\1/p')
[ "$system" = "$cluster" ] ||
  die "the base backup of $night is of the cluster ${system:-(none)}, not the $cluster its seal names"
case $segment in
  1048576 | 2097152 | 4194304 | 8388608 | 16777216 | 33554432 | 67108864 | 134217728 | 268435456 | 536870912 | 1073741824) ;;
  *) die "the base backup of $night names no WAL segment size" ;;
esac
label=$(gosu postgres sed -n 's/^START WAL LOCATION: .* (file \([0-9A-F]\{24\}\))$/\1/p' "$data/backup_label") ||
  stop "the base backup of $night has no backup_label to read"
[ "$label" = "$start" ] ||
  die "the base backup of $night starts in ${label:-no WAL file}, not the $start its seal names"
# The segments the base brought along in pg_wal (-X fetch), which the chain need not find in the
# bucket: their log id and segment, as 16 hex digits.
gosu postgres ls "$data/pg_wal" | { grep -E '^[0-9A-F]{24}$' || true; } | cut -c 9-24 >"$work/base-wal" ||
  stop "the base backup's pg_wal could not be read"
echo "pitr: the base backup of $night unpacked: $(($(gosu postgres du -sk "$data" | cut -f 1) / 1024)) MiB in $data, WAL segments of $((segment / 1048576)) MiB"

# --- the WAL ---

wal=$work/wal
mkdir -m 0755 "$wal"
# A log id holds this many segments; a WAL object is never larger than a segment through zstd and
# age, nor a history file than 1 MiB.
segs=$((0x100000000 / segment))
cap=$((segment + segment / 64 + 65536))
kept=0
kept_bytes=0
passed=0
# folder_of <folder> <names> <first>: the WAL objects of wal/<cluster>/<folder>/ named <names> (a
# regular expression) as "<position> <upload time> <past> <bytes> <walfile> <signature>", one a
# line, oldest position and then oldest upload first; <position> is the walfile but its timeline,
# <past> whether it went up later than the cutoff. Only names of the base's timeline or later and,
# in the first folder, from the base's start on. rclone lsjson prints one object a line, every
# name in JSON's quotes, and a line counts only when it is all one of those names.
folder_of() {
  status=0
  rclone lsjson --files-only --no-mimetype --use-server-modtime "$bucket/wal/$cluster/$1/" \
    >"$work/listing" || status=$?
  # 3: the folder is not there, as some remotes say of an empty one.
  [ "$status" -eq 0 ] || [ "$status" -eq 3 ] || stop "wal/$cluster/$1/ could not be listed (see above)"
  [ "$status" -eq 0 ] || : >"$work/listing"
  # The fields rclone may add after IsDir, such as a provider's storage class ("Tier"), are plain
  # values; a line with anything else is passed over, as is any name but the backup's. Positions
  # and times are compared as text: a hex position such as 00000000000000E5 reads as a number.
  LC_ALL=C awk -v names="$2" -v first="$3" -v tli="$tli" -v cutoff="$cutoff" -v top="$(printf '%08X' "$segs")" '
    BEGIN {
      line = "^[{]\"Path\":\"" names "\",\"Name\":\"" names "\",\"Size\":[0-9]{1,12},\"ModTime\":\"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z\",\"IsDir\":false(,\"[A-Za-z]+\":(\"[A-Za-z0-9_.-]*\"|[0-9]+|true|false))*[}],?$"
    }
    $0 ~ line {
      split($0, f, "\"")
      if (f[4] != f[8]) next
      size = f[11]
      gsub(/[^0-9]/, "", size)
      time = substr(f[14], 1, 19)
      split(f[4], part, ".")
      walfile = part[1]
      if (part[2] == "history") { walfile = walfile ".history"; signature = part[3]; position = walfile }
      else {
        signature = part[2]
        position = substr(walfile, 9, 16)
        if (substr(walfile, 1, 8) "" < tli "" || substr(walfile, 17, 8) "" >= top "" || position "" < first "") next
      }
      print position, time, (cutoff != "" && time "" > cutoff "") ? 1 : 0, size, walfile, signature
    }' "$work/listing" | LC_ALL=C sort -k1,1 -k2,2 >"$work/candidates"
  [ "$(wc -l <"$work/candidates")" -le 2048 ] ||
    die "wal/$cluster/$1/ holds more than 2048 WAL names, more than the backup writes there: someone else wrote to the bucket"
  room "$(awk '{ n += $4 } END { printf "%.0f", n / 1024 }' "$work/candidates")" "the WAL of wal/$cluster/$1/"
}
# take <folder> <walfile> <signature> <cap>: the object <walfile>.<signature>.zst.age of that folder,
# read by its name no further than a byte past <cap>, and kept as $wal/<walfile>.zst.age only when
# the signature in its name is the backup's, of "menumesh wal 1 <cluster> <walfile> <sha256 of its
# bytes>" as wal-ship.sh signs it; else passed over.
take() {
  rclone cat --no-traverse --head "$(($4 + 1))" "$bucket/wal/$cluster/$1/$2.$3.zst.age" >"$work/object" ||
    stop "wal/$cluster/$1/$2.$3.zst.age could not be read (see above)"
  got=$(($(wc -c <"$work/object")))
  if [ "$got" -gt 0 ] && [ "$got" -le "$4" ]; then
    printf 'menumesh wal 1 %s %s %s\n' "$cluster" "$2" "$(sha256sum "$work/object" | cut -d ' ' -f 1)" \
      >"$work/message"
    if seal_verify "$work/message" "$3"; then
      mv -f "$work/object" "$wal/$2.zst.age"
      chmod 0644 "$wal/$2.zst.age"
      kept=$((kept + 1))
      kept_bytes=$((kept_bytes + got))
      return 0
    fi
  fi
  rm -f "$work/object"
  passed=$((passed + 1))
  return 1
}

# The timelines' history files, each from the first of its objects that is the backup's.
folder_of history '[0-9A-F]{8}[.]history[.][A-Za-z0-9_-]{86}[.]zst[.]age' ''
while read -r _ _ _ _ walfile signature; do
  [ ! -e "$wal/$walfile.zst.age" ] || continue
  take history "$walfile" "$signature" 1048576 </dev/null || true
done <"$work/candidates"
histories=$kept

# The chain: every position from the base's start, in turn, needs a WAL file of the base's
# timeline or a later one that is the backup's, or one the base brought along; a position's
# objects are tried oldest upload first, and a file already kept is not tried again. The chain is
# whole once a position's WAL file went up later than the cutoff; else it ends at the first
# position it can't fill, and why is said.
position=$((0x$(echo "$start" | cut -c 9-16) * segs + 0x$(echo "$start" | cut -c 17-24)))
first=$(echo "$start" | cut -c 9-24)
folder=
end=
last=
while :; do
  log=$(printf '%08X' "$((position / segs))")
  at=$log$(printf '%08X' "$((position % segs))")
  if [ "$log" != "$folder" ]; then
    folder=$log
    folder_of "$folder" '[0-9A-F]{24}[.][A-Za-z0-9_-]{86}[.]zst[.]age' "$first"
  fi
  found=
  late=
  tried=0
  LC_ALL=C awk -v at="$at" '$1 "" == at ""' "$work/candidates" >"$work/here"
  while read -r _ _ past _ walfile signature; do
    [ ! -e "$wal/$walfile.zst.age" ] || continue
    tried=$((tried + 1))
    if take "$folder" "$walfile" "$signature" "$cap" </dev/null && [ -z "$found" ]; then
      found=$walfile
      late=$past
    fi
  done <"$work/here"
  if [ -z "$found" ]; then
    if grep -qx "$at" "$work/base-wal"; then
      last=$tli$at
      position=$((position + 1))
      continue
    fi
    if [ "$tried" -eq 0 ]; then end=missing; else end=refused; fi
    break
  fi
  last=$found
  [ "$late" != 1 ] || break
  position=$((position + 1))
done
echo "pitr: the WAL after it, from wal/$cluster/: $((kept - histories)) WAL files and $histories timeline histories checked and kept ($kept_bytes bytes), through $last; $passed objects passed over, not the backup's"

# Where the chain ended, if before the cutoff: whether the backup's WAL goes on after the position
# it couldn't fill, from up to 8 objects named past it, in its log id's folder or the next.
cut=
if [ -n "$end" ]; then
  gap=$tli$at
  if [ "$end" = missing ]; then
    why="$gap is not in the bucket (it keeps the WAL 15 days, or someone else removed it)"
  else
    why="none of the $tried objects in the bucket named $gap is the backup's (their signatures do not check out): someone else wrote to the bucket"
  fi
  refused=
  [ "$end" = missing ] || refused="; the $tried objects named $gap there are not the backup's, and were passed over"
  LC_ALL=C awk -v at="$at" '($1 "") > (at "")' "$work/candidates" >"$work/beyond"
  if [ ! -s "$work/beyond" ]; then
    folder_of "$(printf '%08X' "$((position / segs + 1))")" '[0-9A-F]{24}[.][A-Za-z0-9_-]{86}[.]zst[.]age' ''
    cp "$work/candidates" "$work/beyond"
    folder=$(printf '%08X' "$((position / segs + 1))")
  fi
  looked=0
  while read -r _ _ _ _ walfile signature && [ "$looked" -lt 8 ]; do
    looked=$((looked + 1))
    if take "$folder" "$walfile" "$signature" "$cap" </dev/null; then
      cut=$walfile
      break
    fi
  done <"$work/beyond"
  if [ -n "$cut" ]; then
    echo "pitr: the chain of WAL files is cut at $gap: $why. The backup's WAL goes on after it, from $cut, and the replay can't reach past the cut"
  elif [ "$target" = latest ]; then
    echo "pitr: the WAL in the bucket ends at $last$refused"
  else
    echo "pitr: the WAL in the bucket ends at $last, none of it uploaded more than 30 minutes past the point$refused"
  fi
fi

# Each later timeline the kept WAL files are of has its history file, the backup's, kept here or
# in the base. db archives a timeline's history file before its first WAL file and wal-ship.sh
# sends it first, so one missing is someone else's doing: without it the replay would follow an
# older timeline, and a recovery would number its own timeline as one already in the bucket.
gosu postgres ls "$data/pg_wal" | { grep -E '^[0-9A-F]{8}\.history$' || true; } >"$work/base-histories" ||
  stop "the base backup's pg_wal could not be read"
orphans=$({ ls "$wal"; sed 's/$/.zst.age/' "$work/base-histories"; } | LC_ALL=C awk -v tli="$tli" '
  /^[0-9A-F]{8}[.]history[.]zst[.]age$/ { known[substr($0, 1, 8)] = 1; next }
  /^[0-9A-F]{24}[.]zst[.]age$/ { if (substr($0, 1, 8) "" > tli "") seen[substr($0, 1, 8)] = 1 }
  END { for (t in seen) if (!(t in known)) print t }' | LC_ALL=C sort | tr '\n' ' ')
[ -z "$orphans" ] ||
  die "the backup's WAL of the timelines ${orphans% } is in the bucket, but not those timelines' history files: someone else removed them, and the replay would follow an older timeline, so nothing was replayed"

# --- the replay ---

# The replay's own settings, none of the cluster's: an empty settings file, the base's own
# postgresql.auto.conf set aside (above), local connections trusted, and on the command line what
# it needs, the port the drill's sessions use among them. Nothing is preloaded, no event trigger
# fires, and no command the cluster's settings could name runs (none at the recovery's end or
# after a restartpoint, and no SSL with its passphrase command), so none of the night's code runs.
# A drill keeps nothing of the WAL; a recovery keeps what it writes as WAL waiting to be archived
# (archive_mode on, nothing to archive it with), so db's basic_archive sends the new timeline's
# history file and segments to the spool once it starts.
: >"$work/postgresql.conf"
printf 'local all all trust\n' >"$work/pg_hba.conf"
: >"$work/pg_ident.conf"
chmod 0644 "$work/postgresql.conf" "$work/pg_hba.conf" "$work/pg_ident.conf"
set -- \
  -D "$data" \
  -c config_file="$work/postgresql.conf" \
  -c hba_file="$work/pg_hba.conf" \
  -c ident_file="$work/pg_ident.conf" \
  -c listen_addresses= \
  -c port=5432 \
  -c unix_socket_directories=/var/run/postgresql \
  -c ssl=off \
  -c shared_preload_libraries= \
  -c session_preload_libraries= \
  -c local_preload_libraries= \
  -c event_triggers=off \
  -c jit=off \
  -c hot_standby=off \
  -c autovacuum=off \
  -c max_connections=10 \
  -c max_parallel_workers_per_gather=0 \
  -c shared_buffers=128MB \
  -c restart_after_crash=off \
  -c logging_collector=off \
  -c log_destination=stderr \
  -c log_line_prefix= \
  -c log_timezone=UTC \
  -c timezone=UTC \
  -c log_checkpoints=off \
  -c wal_recycle=off \
  -c "restore_command=/usr/local/bin/wal-fetch.sh $wal $key %f %p" \
  -c recovery_end_command= \
  -c archive_cleanup_command= \
  -c recovery_target_timeline=latest \
  -c recovery_target_action=promote
if [ "$target" != latest ]; then
  set -- "$@" -c "recovery_target_time=$(date -u -d "@$point" '+%Y-%m-%d %H:%M:%S+00')"
fi
if [ "$mode" = --into ]; then
  set -- "$@" -c archive_mode=on -c archive_command= -c archive_library=
else
  set -- "$@" -c archive_mode=off -c fsync=off
fi
gosu postgres touch "$data/recovery.signal"
# The owner's key, for wal-fetch.sh alone: postgres's, on the tmpfs.
cat "$AGE_IDENTITY_FILE" >"$key" || stop "$AGE_IDENTITY_FILE could not be read"
chown postgres:postgres "$key" /run/pitr
keyed=yes
echo "pitr: replaying"
replayed=$(date -u +%s)
# Postgres with none of this script's environment (the bucket's token, among others).
env -i PATH=/usr/local/bin:/usr/bin:/bin LC_ALL=C gosu postgres postgres "$@" </dev/null >>"$work/replay.log" 2>&1 &
postmaster=$!
# Done once postmaster.pid says ready, which it says only once the replay ended and the cluster
# was promoted: hot_standby is off, so nothing connects before. Not done when the postmaster ends.
alive() {
  case $(sed -n 's/^[0-9]* (.*) \([A-Z]\) .*$/\1/p' "/proc/$postmaster/stat" 2>/dev/null) in
    '' | Z | X) return 1 ;;
  esac
}
ready=
waited=0
while [ "$waited" -lt 14400 ]; do
  case $(gosu postgres sed -n 8p "$data/postmaster.pid" 2>/dev/null || true) in
    ready*)
      ready=yes
      break
      ;;
  esac
  alive || break
  sleep 2
  waited=$((waited + 2))
  [ $((waited % 60)) -ne 0 ] ||
    echo "pitr: still replaying, $(grep -c '^LOG:  restored log file ' "$work/replay.log" || true) WAL files from the bucket so far"
done
forget_key
replay_lines() {
  grep -E '^LOG:  (starting point-in-time recovery|starting archive recovery|recovery stopping|redo done at|last completed transaction|selected new timeline ID|archive recovery complete)' \
    "$work/replay.log" | sed 's/^LOG:  /pitr: | /' || true
}
if [ -z "$ready" ]; then
  replay_lines
  grep -E '^((FATAL|PANIC|ERROR):  |wal-fetch: )' "$work/replay.log" | sed -n '1,5s/^/pitr: | /p' || true
  [ -n "$(alive && echo yes)" ] || postmaster=
  if grep -q 'recovery ended before configured recovery target was reached' "$work/replay.log"; then
    # Why the WAL it was given ended there: a cut, the end of the bucket's WAL, or the first WAL
    # file uploaded more than 30 minutes past the point, which can still hold WAL from before it
    # when the shipper was down then and sent it late.
    if [ -n "$cut" ]; then
      short="the chain of WAL files is cut at $gap"
    elif [ -n "$end" ]; then
      short="the WAL in the bucket ends at $last"
    else
      short="$last went up more than 30 minutes past the point, and no WAL after it is read: if the WAL shipper was down then, it sent the WAL of the point late"
    fi
    die "the replay reached the end of the WAL it was given before the first transaction past $said_point ($short): recover to an earlier point, or to latest"
  fi
  [ "$waited" -lt 14400 ] || die 'the replay did not end within 4 hours'
  die "the replay stopped before it ended (see above)"
fi
replay_lines
# The WAL files the replay asked for and got, each once: it reads some of them twice.
from_bucket=$(sed -n 's/^LOG:  restored log file "\([0-9A-F]\{8,24\}\(\.history\)\{0,1\}\)" from archive$/\1/p' "$work/replay.log" | sort -u | wc -l)
last_commit=$(sed -n 's/^LOG:  last completed transaction was at log time \([0-9-]\{10\} [0-9:]\{8\}\)[.0-9]*+00$/\1/p' "$work/replay.log" | tail -n 1)
last_at=
[ -z "$last_commit" ] || last_at="$(echo "$last_commit" | tr ' ' T)Z"
timeline=$(sed -n 's/^LOG:  selected new timeline ID: \([0-9]\{1,10\}\)$/\1/p' "$work/replay.log" | tail -n 1)
echo "pitr: the replay ended in $(($(date -u +%s) - replayed)) s, $((from_bucket)) WAL files read from the bucket, the cluster promoted to timeline ${timeline:-?}: $(($(gosu postgres du -sk "$data" | cut -f 1) / 1024)) MiB in $data"

if [ "$mode" = --test ]; then
  # The rows there, in sessions that write nothing, and beside them the night's manifest: what was
  # written after the night moves them, so they are only shown. Only databases of plain names.
  # psql's own lines wait in a file, shown if it fails: each session begins with Postgres's warning
  # that the databases' collation version is not this image's ICU, which nothing here uses.
  ro() {
    PGOPTIONS='-c default_transaction_read_only=on -c client_min_messages=error' \
      psql -X -q -At -v ON_ERROR_STOP=1 -h /var/run/postgresql -U supabase_admin "$@" 2>>"$work/psql.log"
  }
  unread() {
    grep -v -E '^(WARNING:  database "[a-z0-9_]+" has a collation version mismatch|DETAIL:  The database was created using collation version|HINT:  Rebuild all objects in this database)' \
      "$work/psql.log" | sed -n '1,5s/^/pitr: | /p' || true
    die "$1"
  }
  : >"$work/psql.log"
  dbs=$(ro -d postgres -c 'select datname from pg_database where datallowconn and not datistemplate order by datname') ||
    unread 'the replayed cluster could not be read'
  : >"$work/counts"
  for db in $dbs; do
    case $db in *[!a-z0-9_]*) continue ;; esac
    ro -d "$db" -f /usr/local/share/menumesh/counts.sql | awk -v db="$db" '{ $1 = $1 " " db; print }' \
      >>"$work/counts" || unread "the database $db of the replayed cluster could not be counted"
  done
  echo "pitr: the rows at the point, beside the night's manifest (the backup counted those as it ran; what was written after it moves them):"
  printf '%s\n#point\n' "$manifest" | cat - "$work/counts" | LC_ALL=C awk '
    $0 == "#point" { point = 1; next }
    $1 != "table" && $1 != "migration" { next }
    {
      key = $1
      for (i = 2; i < NF; i++) key = key " " $i
      if (point) { there[key] = $NF; if (!(key in night)) order[++n] = key }
      else if (!(key in night)) { night[key] = $NF; order[++n] = key }
    }
    END {
      for (i = 1; i <= n; i++) {
        key = order[i]
        printf "  %s: %s at the night, %s at the point\n", key, (key in night) ? night[key] : "none", (key in there) ? there[key] : "none"
      }
    }'
  quit || die 'the replayed cluster did not stop (see above)'
  [ -z "$cut" ] || die "the chain of WAL files is cut at $gap, with the backup's WAL after it: the drill fails"
  # Latest must reach about now: the shipper sends a WAL file within 2 minutes of db's archiving it,
  # which archive_timeout (60 s in compose.yml) makes at most a minute after a write.
  if [ "$target" = latest ]; then
    [ -n "$last_commit" ] || die "the replay to the latest WAL found no transaction at all: the WAL is not reaching the bucket"
    age_s=$((seconds - $(date -u -d "$last_commit" +%s)))
    [ "$age_s" -le $((2 * 60 + 600)) ] ||
      die "the last transaction the replay reached committed at $last_at, $((age_s / 60)) minutes before the drill began, more than 2 x archive_timeout + 10 minutes: the WAL is not reaching the bucket"
  fi
  echo "pitr test passed: the night of $night and the WAL after it, replayed to $said_point${last_at:+, its last transaction at $last_at}"
else
  quit || die 'the recovered cluster did not stop cleanly (see above)'
  state=$(LC_ALL=C gosu postgres pg_controldata "$data" | sed -n 's/^Database cluster state: *//p')
  [ "$state" = 'shut down' ] || die "the recovered cluster is not shut down cleanly (${state:-unreadable})"
  # The replay's settings were all on its command line, kept there by postmaster.opts alone. The
  # base's own postgresql.auto.conf goes back, so that db starts with the settings the live cluster
  # had.
  gosu postgres rm -f "$data/postmaster.opts"
  if [ -n "$aside" ]; then
    gosu postgres mv -f "$auto.pitr" "$auto" || stop "the base backup's postgresql.auto.conf could not be put back"
  else
    gosu postgres rm -f "$auto" || stop "$auto could not be removed"
  fi
  writing=
  echo "pitr: the cluster $cluster stopped cleanly in $data on timeline ${timeline:-?}${last_at:+, its last transaction at $last_at}${cut:+, the chain cut at $gap}"
  echo "point-in-time recovery to $said_point done: start db with a new wal-spool (its entrypoint gives the files to its own postgres, uid 100, and it archives the new timeline), then auth, rest, realtime, storage, api-gw, web, scheduler and backup (docs/RUNBOOK.md)"
fi
