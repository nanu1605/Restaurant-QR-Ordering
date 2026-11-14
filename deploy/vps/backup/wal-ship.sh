#!/bin/sh
# shellcheck disable=SC3040 # BusyBox ash, this image's sh, has pipefail
# MenuMesh's WAL shipper (docs/DECISIONS.md VPS-43), run every minute by the backup service's crond
# as db's postgres (uid 100, gid 101), who owns the WAL spool. db's archiver (archive_library
# basic_archive) copies each WAL file it finishes into /wal-spool, the wal-spool volume, synced and
# then renamed into place, at least once a minute while anything is written (archive_timeout). Each
# run takes the spool's files oldest first:
#
#   1. zstd -3 and age, to the owner's key in BACKUP_AGE_RECIPIENT, into /wal-spool/.ship/out/,
#      under a temporary name, synced and renamed; then the raw file goes. The outbox keeps the
#      same bytes for every retry, and small files while the bucket can't be reached.
#   2. Each outbox file goes up as wal/<cluster>/<log id>/<walfile>.<signature>.zst.age, a
#      timeline's history file as wal/<cluster>/history/<walfile>.<signature>.zst.age, where
#      <cluster> is db's system identifier and <signature> the base64url Ed25519 signature
#      (seal.sh) of "menumesh wal 1 <cluster> <walfile> <sha256 of the file>\n". rclone copyto
#      --checksum writes nothing when the same bytes are there already, as after an upload that
#      went through before a crash, so a bucket lock never refuses a retry. Then the outbox file
#      goes.
#
# The signature is the proof: age proves nothing about who encrypted a file, and whoever holds the
# bucket's token and the age public key can put one in. Only this service holds the signing key, a
# restore takes a WAL file only when the signature in its name checks out against its bytes, and
# nobody can know a name before its upload, so nobody can put an object under it first. The
# cluster in every name keeps two clusters' WAL apart, as after a recovery, whose new cluster names
# its first WAL files as the old one did. It comes from pg_control_system(), is kept in
# /wal-spool/.ship/system-identifier, and each segment's own header must name it: a changed
# identifier while files wait, or a segment of another cluster, stops the shipping with an alert,
# and nothing is mixed. While db can't be asked, only segments ship, under the kept identifier
# their headers name. A WAL file db archives again after a crash, once its first copy had gone up,
# goes up again under a name of its own: the same bytes inside, so a restore may take either.
#
# Health, each run: a WAL file waiting more than 10 minutes (in the spool or the outbox), or db's
# archiver failing for 10 minutes (pg_stat_archiver: db's log keeps nothing of a WAL file that
# waits), sends one alert (notify.sh) at most hourly, and one "resumed" line once it is over. What
# no wait mends alerts at once, as often: db not archiving at all, a spool this user can't write,
# a changed identifier while files wait or a segment of another cluster, a signing key that is not
# the public key's pair, a setting missing. While all is well, HEARTBEAT_WAL_URL is pinged every 5
# minutes with the cluster and the last WAL file sent, and the run prints nothing. Its own lines,
# with an alert and its end, are all it prints, and the failing tool's first lines with them;
# nothing printed holds a value.
set -eu -o pipefail

spool=/wal-spool
state=$spool/.ship
out=$state/out
# Where the record goes while the spool can't hold it (below).
spare=/tmp/wal-ship
umask 077
# Nothing from the spool is ever globbed.
set -f
export RCLONE_LOG_LEVEL=ERROR
started=$(date -u +%s)
# What stopped this run's shipping, in a few words, and the file with what the tool said.
problem=
detail=
# Set when what stopped it is nothing a wait mends, which alerts at once.
urgent=
# One more reason for the record, after any already there.
stopped() { problem="${problem:+$problem; }$1"; }
# The same, for what only the owner can mend.
halted() {
  stopped "$1"
  urgent=yes
}

work=
finish() {
  status=$?
  [ -z "$work" ] || rm -rf "$work"
  [ "$status" -eq 0 ] || echo "wal-ship: stopped by an error of its own (exit $status)" >&2
}
trap finish EXIT
work=$(mktemp -d /tmp/wal-ship.XXXXXX)

# The names basic_archive writes: segments, a segment's .partial (at a promotion), a timeline's
# .history and a base backup's .backup file; never its archtemp.* files, nor the dotfiles here.
WAL='([0-9A-F]{24}(\.partial|\.[0-9A-F]{8}\.backup)?|[0-9A-F]{8}\.history)'
# The WAL files of a folder whose names end so, in the order of their names, which is the order
# db wrote them: a timeline's segments in turn, its history file before its first segment. The
# glob sorts them and leaves the dotfiles out, and each name is matched whole, so an empty folder's
# pattern itself is never one.
walfiles() {
  suffix=$2
  set +f
  set -- "$1"/*
  set -f
  printf '%s\n' "$@" | sed 's|^.*/||' | grep -E "^${WAL}${suffix}\$" || true
}
spooled() { walfiles "$spool" ''; }
outbox() { walfiles "$out" '[.]zst[.]age'; }
# Whether a text is a number of 1 to 20 digits.
digits() {
  case ${1-} in '' | *[!0-9]*) return 1 ;; esac
  [ "${#1}" -le 20 ]
}
# A number kept in a file of the record, which db's postgres can write too: digits or nothing.
kept() {
  value=$(sed -n 1p "$1" 2>/dev/null || true)
  if digits "$value"; then printf '%s' "$value"; fi
}
# The time, in seconds since 1970, of the oldest file waiting (the outbox keeps each raw file's);
# nothing when none waits.
oldest() {
  { spooled | sed "s|^|$spool/|"; outbox | sed "s|^|$out/|"; } | xargs -r stat -c %Y 2>/dev/null |
    awk '/^[0-9]+$/ && (min == "" || $1 + 0 < min + 0) { min = $1 } END { print min }' || true
}
count() { echo $(($(spooled | wc -l) + $(outbox | wc -l))); }
# Whether this run has taken 4 minutes: the rest waits for the next one, so the health below and
# the heartbeat still come every few minutes while a long backlog drains.
late() { [ $(($(date -u +%s) - started)) -ge 240 ]; }

for name in PGHOST PGUSER PGPASSWORD BACKUP_AGE_RECIPIENT BACKUP_BUCKET RCLONE_CONFIG_BACKUPS_TYPE BACKUP_SIGNING_KEY BACKUP_SIGNING_PUBLIC_KEY; do
  eval "set -- \"\${$name-}\""
  [ -n "$1" ] || { halted "$name is not set"; break; }
done
# The signing helpers, which also keep BACKUP_SIGNING_KEY from every program this script runs.
# shellcheck source=/dev/null
. /usr/local/share/menumesh/seal.sh

# The alerts' and the heartbeat's record is kept in the spool, so it outlives the container. When
# the spool is not this user's to write (db makes it postgres's as it starts), the container's
# /tmp keeps it instead, and nothing ships.
book=$state
if ! mkdir -p "$out" 2>/dev/null || [ ! -w "$state" ] || [ ! -w "$spool" ]; then
  book=$spare
  mkdir -p "$book"
  halted "the WAL spool, /wal-spool, is not db's postgres's to write: db makes it so as it starts"
fi
exec 9>>"$book/lock"
# A run still going (a long backlog) keeps the spool to itself; this minute's run leaves it.
flock -n 9 || exit 0
find "$out" -maxdepth 1 -type f -name '.tmp.*' -exec rm -f {} + 2>/dev/null || true
# basic_archive's temporary copies outlive only a crash of db: a copy takes a second at most.
find "$spool" -maxdepth 1 -type f -name 'archtemp.*' -mmin +60 -exec rm -f {} + 2>/dev/null || true
before=$(oldest)

# db's cluster and its archiver: the identifier as pg_controldata prints it (unsigned), the times
# of the last WAL file archived and of the last failure, and whether it archives at all (what the
# spool holds still ships when it doesn't). A db that doesn't answer in 10 s counts as down for
# this run.
current=
archived=0
failed=0
idle=
if [ -z "$problem" ]; then
  if reading=$(PGCONNECT_TIMEOUT=10 PGOPTIONS='-c statement_timeout=10s' psql -X -At -v ON_ERROR_STOP=1 -F ' ' -d postgres -c "
      select case when c.system_identifier < 0
                  then (c.system_identifier::numeric + 18446744073709551616)::text
                  else c.system_identifier::text end,
             coalesce(extract(epoch from a.last_archived_time)::bigint, 0),
             coalesce(extract(epoch from a.last_failed_time)::bigint, 0),
             current_setting('archive_mode')
        from pg_control_system() c, pg_stat_archiver a" 2>"$work/psql"); then
    # shellcheck disable=SC2086 # four words, split on purpose
    set -- $reading
    if [ "$#" -eq 4 ] && digits "$1" && [ "$1" != 0 ] && digits "$2" && digits "$3"; then
      current=$1
      archived=$2
      failed=$3
      [ "$4" != off ] || idle=yes
    else
      stopped 'db answered with no system identifier'
    fi
  else
    detail=$work/psql
  fi
fi

# The identifier to ship under: db's, or the kept one while db can't be asked. A new one is taken
# only while nothing waits: files of the old cluster never go under the new one's name.
id=$(kept "$state/system-identifier")
held=
waiting=$(count)
if [ -z "$problem" ]; then
  if [ -z "$current" ]; then
    # db is down or restarting: segments name their cluster in their headers, the rest waits.
    held=yes
    [ -n "$id" ] || stopped 'db could not be asked for its system identifier, and none is kept'
  elif [ "$id" = "$current" ]; then
    :
  elif [ -z "$id" ] && [ -n "$(outbox | sed -n 1p)" ]; then
    halted 'the outbox holds WAL files, but no system identifier is kept with them: nothing ships (docs/RUNBOOK.md)'
  elif [ -n "$id" ] && [ "$waiting" -gt 0 ]; then
    halted "db's system identifier is now $current, not the $id kept, and $waiting WAL files wait: nothing ships, so two clusters' WAL never mix (docs/RUNBOOK.md: after a recovery, wal-spool is made new)"
  else
    printf '%s\n' "$current" >"$state/system-identifier.new"
    fsync "$state/system-identifier.new"
    mv -f "$state/system-identifier.new" "$state/system-identifier"
    id=$current
  fi
fi

# 1. The spool into the outbox.
if [ -z "$problem" ]; then
  for name in $(spooled); do
    if late; then break; fi
    src=$spool/$name
    [ -f "$src" ] || continue
    case $name in
      *.history | *.backup)
        [ -z "$held" ] || continue
        ;;
      *)
        # XLogLongPageHeaderData: the system identifier, 8 bytes at offset 24 of the first page.
        sysid=$(od -An -tu8 -j24 -N8 "$src" 2>/dev/null | tr -d ' \n' || true)
        if [ "$sysid" != "$id" ]; then
          halted "the WAL file $name names the cluster ${sysid:-(none)}, not $id: nothing more ships, so two clusters' WAL never mix (docs/RUNBOOK.md)"
          break
        fi
        ;;
    esac
    dest=$out/$name.zst.age
    if [ -e "$dest" ]; then
      # basic_archive copied it again, as after a crash of db, byte for byte: the outbox's stands.
      rm -f "$src"
      continue
    fi
    tmp=$out/.tmp.$name
    if ! { zstd -3 -q -c -- "$src" | age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" >"$tmp"; } 2>"$work/tool"; then
      stopped "$name could not be compressed and encrypted (zstd, age)"
      detail=$work/tool
      break
    fi
    if ! { touch -r "$src" "$tmp" && fsync "$tmp" && mv -f "$tmp" "$dest" && fsync "$out"; } 2>"$work/tool"; then
      stopped "$name could not be put in the outbox"
      detail=$work/tool
      break
    fi
    rm -f "$src"
  done
fi

# 2. The outbox into the bucket, each file signed, once the key is seen to be the pair of the
# public key the restores check. rclone looks up the one name it writes (--no-traverse) and gives
# up within minutes; the next minute's run tries again.
if [ -z "$problem" ] && [ -n "$(outbox | sed -n 1p)" ] && ! seal_self_check 2>"$work/tool"; then
  halted "BACKUP_SIGNING_KEY does not sign what BACKUP_SIGNING_PUBLIC_KEY's first key checks: nothing was uploaded"
  detail=$work/tool
fi
if [ -z "$problem" ]; then
  for file in $(outbox); do
    if late; then break; fi
    walfile=${file%.zst.age}
    sum=$(sha256sum "$out/$file" 2>/dev/null | cut -d ' ' -f 1 || true)
    case $sum in *[!0-9a-f]*) sum= ;; esac
    if [ "${#sum}" -ne 64 ]; then
      stopped "the outbox's $walfile could not be read"
      break
    fi
    printf 'menumesh wal 1 %s %s %s\n' "$id" "$walfile" "$sum" >"$work/message"
    if ! signature=$(seal_sign "$work/message" 2>"$work/tool"); then
      stopped "$walfile could not be signed (openssl)"
      detail=$work/tool
      break
    fi
    case $walfile in
      *.history) folder=history ;;
      *) folder=$(printf '%s' "$walfile" | cut -c 9-16) ;;
    esac
    if ! rclone copyto --checksum --no-traverse --retries 1 --low-level-retries 3 \
      --contimeout 30s --timeout 2m "$out/$file" \
      "backups:$BACKUP_BUCKET/wal/$id/$folder/$walfile.$signature.zst.age" 2>"$work/tool"; then
      stopped "the upload of $walfile to the bucket failed (rclone)"
      detail=$work/tool
      break
    fi
    rm -f "$out/$file"
    printf '%s\n' "$walfile" >"$state/last-sent"
  done
fi

# Health: the oldest file that waited, before this run or still, and db's archiver.
now=$(date -u +%s)
after=$(oldest)
waiting=$(count)
since=${before:-$after}
behind=
[ -z "$since" ] || [ $((now - since)) -le 600 ] || behind=$(((now - since) / 60))
stuck=
if [ -n "$current" ] && [ "$failed" -gt "$archived" ]; then
  first=$(kept "$book/archiver-failing")
  if [ -z "$first" ]; then
    first=$now
    printf '%s\n' "$now" >"$book/archiver-failing"
  fi
  [ $((now - first)) -lt 600 ] || stuck=$(((now - first) / 60))
elif [ -n "$current" ]; then
  rm -f "$book/archiver-failing"
fi

# What no wait mends, and a db that archives nothing, alert at once.
cluster=${id:-(unknown)}
if [ -n "$behind" ] || [ -n "$stuck" ] || [ -n "$idle" ] || [ -n "$urgent" ]; then
  last=$(kept "$book/alert-sent")
  if [ -z "$last" ] || [ $((now - last)) -ge 3600 ]; then
    reasons=
    [ -z "$behind" ] || reasons="the oldest WAL file waited $behind minutes, $waiting wait now"
    [ -z "$stuck" ] || reasons="${reasons:+$reasons; }db's archiver has failed for $stuck minutes (pg_stat_archiver)"
    [ -z "$idle" ] || reasons="${reasons:+$reasons; }db archives no WAL (archive_mode is off), so none reaches the spool"
    [ -z "$problem" ] || reasons="${reasons:+$reasons; }$problem"
    message="[menumesh] WAL is not reaching the bucket (cluster $cluster): $reasons"
    echo "wal-ship: $message" >&2
    # What the tool said, without a control character: three lines at most, cut at 200 bytes.
    if [ -n "$detail" ] && [ -s "$detail" ]; then
      LC_ALL=C tr -d '\000-\010\013-\037\177-\377' <"$detail" |
        sed -n '1,3s/^\(.\{0,200\}\).*/wal-ship: | \1/p' >&2 || true
    fi
    notify.sh alert "$message"
    printf '%s\n' "$now" >"$book/alert-sent"
    : >"$book/alerting"
  fi
elif { [ -e "$book/alerting" ] || [ -e "$spare/alerting" ]; } && [ -z "$problem" ] && [ -n "$current" ]; then
  message="[menumesh] WAL shipping resumed (cluster $cluster): no WAL file waits over 10 minutes, and db archives"
  echo "wal-ship: $message" >&2
  notify.sh alert "$message"
  rm -f "$book/alerting" "$spare/alerting"
fi

# The heartbeat, every 5 minutes while all is well: the cluster and the last WAL file sent, which
# the monitor's log keeps where the bucket's token can't reach.
if [ -z "$behind" ] && [ -z "$stuck" ] && [ -z "$idle" ] && [ -z "$problem" ] && [ -n "$current" ]; then
  last=$(kept "$book/beat")
  if [ -z "$last" ] || [ $((now - last)) -ge 290 ]; then
    printf '%s\n' "$now" >"$book/beat"
    last_sent=$(sed -n 1p "$state/last-sent" 2>/dev/null | grep -E "^${WAL}\$" || true)
    HEARTBEAT_URL=${HEARTBEAT_WAL_URL-} notify.sh beat "wal $cluster: last sent ${last_sent:-nothing yet}, $waiting waiting"
  fi
fi
