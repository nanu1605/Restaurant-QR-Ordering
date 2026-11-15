#!/bin/sh
# shellcheck disable=SC3040 # BusyBox ash, this image's sh, has pipefail
# The restore_command of pitr.sh's replay (docs/DECISIONS.md VPS-43), run by the replaying Postgres
# as the image's postgres (uid 70):
#
#   wal-fetch.sh <folder> <age key> <walfile> <destination>    (restore_command's %f and %p)
#
# pitr.sh downloaded the WAL files the replay may need into <folder>, still encrypted, each kept only
# when the signature in its name was the backup's, and copied the owner's age key to <age key> on a
# tmpfs. This decrypts and decompresses the one Postgres asks for into <destination>, so the replay
# never holds more than that one WAL file decrypted. A file the folder lacks ends with exit 1, as
# Postgres expects when the archive lacks one: the end of the WAL, or a timeline that doesn't exist.
# A file it has but can't decrypt or decompress stops the replay instead (exit 126, which Postgres
# takes as fatal), so a broken file never passes for the end of the WAL. Nothing printed holds a
# value: the one line of a failure goes to Postgres's log, which pitr.sh reads.
set -eu -o pipefail

folder=${1-}
key=${2-}
name=${3-}
destination=${4-}
# Only a WAL segment's or a timeline history file's name, as Postgres asks for them.
printf '%s\n' "$name" | grep -qE '^([0-9A-F]{24}|[0-9A-F]{8}\.history)$' || exit 1
[ -f "$folder/$name.zst.age" ] || exit 1
partial=$destination.wal-fetch
if age --decrypt --identity "$key" <"$folder/$name.zst.age" | zstd -dcq >"$partial" &&
  mv -f "$partial" "$destination"; then
  exit 0
fi
rm -f "$partial"
echo "wal-fetch: $name could not be decrypted and decompressed, so the replay stops before it" >&2
exit 126
