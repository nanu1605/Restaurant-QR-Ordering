# syntax=docker/dockerfile:1.27.1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e

# MenuMesh's backup image (docs/DECISIONS.md VPS-40, VPS-43): the nightly job, the WAL shipper, the
# restores and the point-in-time recovery, run by the backup, restore-test, recover, pitr-test and
# recover-pitr services of deploy/vps/compose.yml. The last two replay the WAL with this image's own
# Postgres. CI builds it from this folder alone as ghcr.io/nanu1605/menumesh:backup-<sha>, labelled
# org.opencontainers.image.version with that tag, which app-deploy checks:
#
#   docker build --tag menumesh-backup:<tag> --label org.opencontainers.image.version=<tag> \
#     --build-arg REVISION=<sha> deploy/vps/backup
#
# The frontend is pinned as in the web image's Dockerfile. Postgres's own Alpine image, for its
# client tools: 17, at least the server's 17.6, pinned by digest and at least 14 days old, the
# shared server's rule. 17.10 on Alpine 3.24 was pushed on 2026-07-08; 17.11 (pushed 2026-11-06)
# passes the rule on 2026-11-20. Bump the tag and the digest together, here and in the migrate
# image.
FROM postgres:17.10-alpine3.24@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193

ARG REVISION=
LABEL org.opencontainers.image.title=menumesh-backup \
      org.opencontainers.image.description='MenuMesh nightly backups, WAL shipping and restores: age-encrypted, signed, to an S3 bucket' \
      org.opencontainers.image.source=https://github.com/nanu1605/Restaurant-QR-Ordering \
      org.opencontainers.image.revision=${REVISION}

# age encrypts, rclone speaks S3, curl sends the alert and the heartbeat, GNU tar keeps the Storage
# files' xattrs, where Storage keeps each file's content type (BusyBox's tar drops them), and
# openssl's pkeyutl signs and checks with the backup's Ed25519 key (seal.sh). zstd, gosu and flock
# come with the base image. Alpine pins these by its release.
RUN apk add --no-cache age curl openssl rclone tar

# rclone takes its one remote, "backups", from RCLONE_CONFIG_BACKUPS_* only, and writes no file.
ENV RCLONE_CONFIG=/dev/null
# 20:30 UTC is 02:00 IST; the container's clock is UTC. Every minute, wal-ship.sh moves db's
# archived WAL to the bucket as db's postgres, uid 100 and gid 101, who owns the WAL spool: gosu
# drops root's two capabilities with it. crond passes its environment, which compose sets, to each
# job (gosu keeps it), and prints a job's output with its own, which goes to the journal; at log
# level 9 it says nothing of the jobs it starts. The folder is made here, because COPY --chmod
# would give a folder it makes the file's mode, and root without capabilities could then not enter
# it.
RUN printf '30 20 * * * /usr/local/bin/backup.sh\n* * * * * gosu 100:101 /usr/local/bin/wal-ship.sh\n' >/etc/crontabs/root \
 && mkdir -p /usr/local/share/menumesh
COPY --chmod=755 backup.sh restore.sh notify.sh wal-ship.sh wal-health.sh pitr.sh wal-fetch.sh /usr/local/bin/
COPY --chmod=644 counts.sql seal.sh /usr/local/share/menumesh/

# Not the image's entrypoint, which would start Postgres: only crond, in the foreground, quiet.
ENTRYPOINT []
CMD ["crond", "-f", "-L", "/dev/stderr", "-l", "9"]
