# syntax=docker/dockerfile:1.27.1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e

# MenuMesh's backup image (docs/DECISIONS.md VPS-40): the nightly job and the restores, run by the
# backup, restore-test and recover services of deploy/vps/compose.yml. CI builds it from this folder
# alone as ghcr.io/nanu1605/menumesh:backup-<sha>, labelled org.opencontainers.image.version with
# that tag, which app-deploy checks:
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
      org.opencontainers.image.description='MenuMesh nightly backups and restores: age-encrypted, to an S3 bucket' \
      org.opencontainers.image.source=https://github.com/nanu1605/Restaurant-QR-Ordering \
      org.opencontainers.image.revision=${REVISION}

# age encrypts, rclone speaks S3, curl sends the alert and the heartbeat, and GNU tar keeps the
# Storage files' xattrs, where Storage keeps each file's content type (BusyBox's tar drops them).
# Alpine pins these by its release.
RUN apk add --no-cache age curl rclone tar

# rclone takes its one remote, "backups", from RCLONE_CONFIG_BACKUPS_* only, and writes no file.
ENV RCLONE_CONFIG=/dev/null
# 20:30 UTC is 02:00 IST; the container's clock is UTC. crond passes its environment, which compose
# sets, to the job, and prints the job's output with its own, which goes to the journal. The
# folder is made here, because COPY --chmod would give a folder it makes the file's mode, and root
# without capabilities could then not enter it.
RUN printf '30 20 * * * /usr/local/bin/backup.sh\n' >/etc/crontabs/root \
 && mkdir -p /usr/local/share/menumesh
COPY --chmod=755 backup.sh restore.sh notify.sh /usr/local/bin/
COPY --chmod=644 counts.sql /usr/local/share/menumesh/

# Not the image's entrypoint, which would start Postgres: only crond, in the foreground, quiet.
ENTRYPOINT []
CMD ["crond", "-f", "-L", "/dev/stderr", "-l", "9"]
