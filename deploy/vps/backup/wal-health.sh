#!/bin/sh
# The backup service's healthcheck (deploy/vps/compose.yml; docs/DECISIONS.md VPS-133), which Docker
# runs every minute as the container's root and keeps, with the one line it prints, in the
# container's Health.Log, never in its log. Unhealthy when crond is not running, when db's postgres
# can't list the WAL spool, or once WAL stops going up: a WAL file db's archiver wrote has waited
# over 20 minutes in the spool or in the shipper's outbox, nothing has gone up for 10 (wal-ship.sh
# rewrites its last-sent after each upload, so a drain stays healthy), and this container has seen
# it so for 10 minutes more. Those 10 minutes are timed by a mark in the container's /tmp, a tmpfs:
# a new container has none, so its first probe passes whatever waits, and app-deploy, which rolls a
# deploy back unless the new container turns healthy within 120 s, never rolls back a fix deployed
# into a backlog. A new container started into a backlog it can't ship turns unhealthy about 12
# minutes after its start, long after app-deploy is done.
#
# A one-off of the service, such as the night by hand (`app-compose menumesh run --rm --no-deps -T
# backup /usr/local/bin/backup.sh`), gets this healthcheck too, but runs its own command and no
# crond: it passes, as process 1's command line (docker-init's, then the command's, under init:
# true) names no crond. The service's own container runs crond as that command and ends when crond
# does.
#
# Root here holds no capability but SETUID and SETGID, so it reads only what root owns or everyone
# may read, and the spool is db's postgres's 0700 (db's wal-spool.sh): the spool and the shipper's
# own folder in /tmp are read as the image's crontab runs wal-ship.sh, as uid 100 and gid 101,
# through gosu. Only the names db's archiver writes count, at the top of the spool and of the
# outbox: never the shipper's record in /wal-spool/.ship (its lock, its kept identifier and its
# last alert age for good), nor basic_archive's archtemp.* copies or the outbox's .tmp.* files.
# backup.sh takes no lock of wal-ship.sh's and is a crontab line of its own, so the night never
# holds the shipper back.
set -u

spool=/wal-spool
out=$spool/.ship/out
mark=/tmp/wal-health.stuck
# The shipper, as the image's crontab runs wal-ship.sh.
as_shipper() { gosu 100:101 "$@"; }

# Process 1's command line, its arguments split by spaces: empty when it can't be read, which must
# not pass for a one-off.
cmdline=$(tr '\0' ' ' 2>/dev/null </proc/1/cmdline)
case " $cmdline " in
*' crond '* | *'/crond '*) ;;
'  ')
  echo "wal-health: process 1's command line can't be read, so this container can't be told from a one-off"
  exit 1
  ;;
*)
  echo 'wal-health: a one-off of backup, whose process 1 runs no crond: nothing to watch'
  exit 0
  ;;
esac
if ! pidof crond >/dev/null; then
  echo 'wal-health: crond is not running, so neither wal-ship.sh nor backup.sh runs'
  exit 1
fi
# Before db's first start the spool is the empty folder Docker made, root's 0755, which anyone may
# list; db makes it postgres's 0700 as it starts.
if [ -e "$spool" ] && ! { as_shipper test -r "$spool" && as_shipper test -x "$spool"; }; then
  echo "wal-health: db's postgres (uid 100, gid 101), as whom wal-ship.sh runs, can't list $spool, so nothing in it can be seen or shipped"
  exit 1
fi

now=$(date +%s)
# The time, in seconds since 1970, of the oldest WAL file waiting: basic_archive's copy in the
# spool, the raw file's in the outbox (wal-ship.sh keeps it); nothing when none waits.
oldest=$(as_shipper find "$spool" "$out" -maxdepth 1 -type f -name '[0-9A-F]*' -exec stat -c %Y {} + 2>/dev/null |
  awk '/^[0-9]+$/ && (min == "" || $1 + 0 < min + 0) { min = $1 } END { print min }')
# When WAL last went up: wal-ship.sh rewrites last-sent after each upload, in the spool or, while
# the spool takes no write, in its folder in /tmp.
sent=$(as_shipper stat -c %Y "$spool/.ship/last-sent" /tmp/wal-ship/last-sent 2>/dev/null |
  awk '/^[0-9]+$/ && (max == "" || $1 + 0 > max + 0) { max = $1 } END { print max }')

if [ -z "$oldest" ] || [ $((now - oldest)) -le 1200 ]; then
  rm -f "$mark"
  echo 'wal-health: no WAL file has waited over 20 minutes'
  exit 0
fi
stuck="the oldest WAL file has waited $(((now - oldest) / 60)) minutes"
if [ -n "$sent" ] && [ $((now - sent)) -lt 600 ]; then
  rm -f "$mark"
  echo "wal-health: $stuck, and WAL went up in the last 10: it drains"
  exit 0
fi
stuck="$stuck and none went up in the last 10"

# Seen so since the mark, which the first probe to see it makes.
seen=$(stat -c %Y "$mark" 2>/dev/null)
if [ -z "$seen" ]; then
  if touch "$mark" 2>/dev/null; then
    echo "wal-health: $stuck: first seen now, unhealthy once seen so for 10 minutes"
    exit 0
  fi
  echo "wal-health: $stuck, and $mark can't be made to time it"
  exit 1
fi
if [ $((now - seen)) -lt 600 ]; then
  echo "wal-health: $stuck, for $(((now - seen) / 60)) minutes now: unhealthy at 10"
  exit 0
fi
echo "wal-health: $stuck, for $(((now - seen) / 60)) minutes now: WAL is not reaching the bucket (wal-ship.sh's alert says why)"
exit 1
