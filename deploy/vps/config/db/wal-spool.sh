#!/bin/sh
# db's entrypoint (deploy/vps/compose.yml; docs/DECISIONS.md VPS-43): the WAL spool, then the
# image's own entrypoint.
#
#   wal-spool.sh <the image's command>
#
# db archives each finished WAL file into /wal-spool, the wal-spool volume (archive_library
# basic_archive), where the backup service's wal-ship.sh, as the same uid and gid, moves it to the
# bucket. A volume Docker makes is root's and 0755; this makes it postgres's own and 0700, so
# only the database's postgres and the shipper can read the WAL in it, and Postgres can write it.
# Then, as root still, it hands its arguments to the image's docker-entrypoint.sh, which fixes the
# data directory's owner, drops to postgres and runs them, as without this file. Nothing here
# reads or prints a value.
set -eu

spool=/wal-spool
if [ "$(id -u)" != 0 ]; then
  echo 'wal-spool: run it as root, the image user: it hands /wal-spool to postgres' >&2
  exit 1
fi
# A missing mount is a missing directory here: db stops before Postgres archives into the
# container's own layer.
if [ ! -d "$spool" ]; then
  echo "wal-spool: $spool is not there: mount the wal-spool volume on it" >&2
  exit 1
fi
chown postgres:postgres "$spool"
chmod 0700 "$spool"
exec docker-entrypoint.sh "$@"
